/*
 * Mirror酱（MirrorChyan）更新分发接入。
 *
 * 只做三件事：查最新版本、拿带时效的下载地址、校验 sha256。安装仍交给已有的
 * updater.js —— 它已经把「小增量包优先 + 换线路重试 + 覆盖脚本」那段做稳了，
 * 这里再去实现一遍只会多一套要维护的覆盖逻辑。
 *
 * 官方接口（https://github.com/MirrorChyan/docs）：
 *   GET https://mirrorchyan.com/api/resources/{res_id}/latest
 *     current_version  当前版本，ZIP 增量更新用；请求完整包留空
 *     cdk              用户 CDK，没填就不传（仍能查版本）
 *     os / arch        按资源配置，不区分平台时不传
 *     channel          stable / beta / alpha
 *     user_agent       客户端标识，对应「签到源」统计
 * 响应：{ code: 0, msg, data: { version_name, release_note, url, sha256, filesize, update_type, ... } }
 *
 * 三条硬规矩（官方文档明确要求，也确实是坑）：
 *   1. 没填 CDK 也要查 —— 仍能拿到版本号，下载再回退到原有源。所以「没有 url」
 *      绝不等于「没有更新」，判断更新只看 version_name。
 *   2. CDK 走 query 参数，所以日志里不能出现完整 URL。这个模块对外只暴露
 *      redactUrl() 出来的壳，抓包记录由调用方保证不记 url。
 *   3. 没有任何 url / sha256 的响应都不能拿去安装。
 *
 * RID（res_id）由 Mirror酱 官方分配，不猜、不用仓库名代替。没配置就整体跳过，
 * 让 updater.js 按原来的内置源走。
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_HOST = 'mirrorchyan.com';
const API_PATH = '/api/resources';
/** 客户端标识：对应 Mirror酱 统计面板里的「签到源」。mirrorchyan_web 是保留值，不能用。 */
const USER_AGENT = 'hxl_launcher';
/** 查版本 8 秒足够；连不上就该让内置源接手，不能拖着启动。 */
const CHECK_TIMEOUT = 8000;

/* 错误码 → 给人看的话。官方 ErrorCode.md 的表，只挑客户端会碰到的。 */
const ERROR_TEXT = {
  1001: '请求参数不正确（这是启动器的问题，请反馈给作者）',
  7001: 'CDK 已过期，请更换或续费后再试',
  7002: 'CDK 不正确，请检查后重新填写',
  7003: 'CDK 今日下载次数已达上限，请明天再试',
  7004: '这个 CDK 不适用于本应用，请换成花筱灵启动器专用的 CDK',
  7005: 'CDK 已被封禁，请联系 Mirror酱 售后处理',
  8001: 'Mirror酱 上暂时没有这个平台的资源包',
  8002: '系统参数不正确（这是启动器的问题，请反馈给作者）',
  8003: '架构参数不正确（这是启动器的问题，请反馈给作者）',
  8004: '更新通道参数不正确（这是启动器的问题，请反馈给作者）',
  8009: '这是流程测试 CDK，不能用来实际下载，请换成正式 CDK',
};

/** CDK 打码：只留头尾各 4 个字符，中间的星号数量也照实反映长度差异会泄露长度，统一 4 个。 */
function maskCdk(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(4);
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

/**
 * 把可能带 cdk 的 URL 变成能安全写进日志的形态。
 *
 * cdk 是 query 参数，所以只要出现 cdk= 就要抹掉值；顺带把整条 query 里的
 * 其它参数也保留（排查 os/arch 配错时有用），只有 cdk 的值变成 ***。
 */
function redactUrl(url) {
  const text = String(url || '');
  if (!text) return '';
  return text.replace(/([?&]cdk=)[^&]*/gi, '$1***');
}

/** 给用户看的失败原因：优先官方 msg，其次我们的中文映射，最次原始 code。 */
function describeError(code, msg) {
  const text = String(msg || '').trim();
  const mapped = ERROR_TEXT[Number(code)];
  if (mapped) return text ? `${mapped}（${text}）` : mapped;
  if (text) return text;
  if (Number(code) < 0) return 'Mirror酱 服务端出了点问题，请稍后再试或换用其它更新源';
  return `Mirror酱 返回了未知错误（code ${code}）`;
}

/**
 * 最小 HTTPS GET：只要文本，不问 HTTP 库要代理能力。
 *
 * 走系统代理是 main.js 里 proxy-agent 的活，但这个模块自己发请求，所以这里
 * 显式支持一个 proxyUrl 参数——用户的启动器代理设置对更新链路应该是全程生效的，
 * 只给封面走代理、更新不走，用起来会很怪。
 */
function httpGetText(url, options = {}) {
  const timeout = Number(options.timeout) || CHECK_TIMEOUT;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const request = (target, redirects) => {
      if (redirects > 5) {
        done(reject, new Error('重定向次数过多'));
        return;
      }
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        done(reject, new Error('地址格式不对'));
        return;
      }
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : require('http');
      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: {
            // 这里的 User-Agent 是 HTTP 头，和 API 的 user_agent 参数不是一回事，
            // 但两边都标一下来源没坏处。
            'User-Agent': `${USER_AGENT}/1.0`,
            Accept: 'application/json',
          },
        },
        (res) => {
          const status = Number(res.statusCode) || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            request(new URL(res.headers.location, target).toString(), redirects + 1);
            return;
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            done(resolve, { status, body: Buffer.concat(chunks).toString('utf8') });
          });
        }
      );
      req.setTimeout(timeout, () => {
        req.destroy(new Error('连接 Mirror酱 超时'));
      });
      req.on('error', (error) => done(reject, error));
      req.end();
    };
    request(url, 0);
  });
}

/** os / arch 参数：官方规范值 windows / amd64，也接受别名。只在启动器确实区分平台时传。 */
function platformParams() {
  const platform = process.platform;
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : '';
  const archMap = { x64: 'amd64', ia32: '386', arm64: 'arm64', arm: 'arm' };
  const arch = archMap[process.arch] || '';
  return { os, arch };
}

/**
 * 查最新版本。
 *
 * options:
 *   rid            资源 ID（必填，没给就返回 { ok:false, skipped:true }）
 *   cdk            用户 CDK，可空
 *   currentVersion 本地版本，传了才有机会拿到增量包
 *   channel        stable / beta / alpha，默认 stable
 *   timeout        毫秒
 *
 * 返回统一结构，调用方不用去猜 json 形状：
 *   { ok, skipped?, code, msg, error?, latest, notes, url, sha256, size, updateType, updateAvailable, cdkExpiredAt }
 */
async function checkLatest(options = {}) {
  const rid = String(options.rid || '').trim();
  if (!rid) return { ok: false, skipped: true, error: '还没有配置 Mirror酱 资源 ID' };

  const params = new URLSearchParams();
  const current = String(options.currentVersion || '').trim();
  if (current) params.set('current_version', current);
  const cdk = String(options.cdk || '').trim();
  if (cdk) params.set('cdk', cdk);
  const platform = platformParams();
  // 「不区分系统/架构的资源配置」如果硬带 os/arch 会返回 404，所以这两个只能
  // 由调用方明确知道要带时才带。默认带上是因为我们的包本来就是 Windows x64 专用包。
  if (options.sendPlatform !== false) {
    if (platform.os) params.set('os', platform.os);
    if (platform.arch) params.set('arch', platform.arch);
  }
  const channel = String(options.channel || 'stable').trim() || 'stable';
  if (channel !== 'stable') params.set('channel', channel);
  params.set('user_agent', USER_AGENT);

  const url = `https://${API_HOST}${API_PATH}/${encodeURIComponent(rid)}/latest?${params.toString()}`;
  let response;
  try {
    response = await httpGetText(url, { timeout: options.timeout });
  } catch (error) {
    // 网络层的失败（超时、DNS、TLS）就是这个模块自己吞掉，交给调用方回退内置源。
    return {
      ok: false,
      code: 'NETWORK',
      error: `连不上 Mirror酱（${(error && error.message) || '网络错误'}）`,
      urlRef: redactUrl(url),
    };
  }

  let payload = null;
  try {
    payload = JSON.parse(response.body);
  } catch {
    return {
      ok: false,
      code: 'BAD_JSON',
      error: `Mirror酱 返回的不是 JSON（HTTP ${response.status}）`,
      urlRef: redactUrl(url),
    };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'BAD_JSON', error: 'Mirror酱 返回内容无效', urlRef: redactUrl(url) };
  }

  const code = Number(payload.code);
  if (code !== 0) {
    // 业务错误也把 HTTP 状态带上：8001 是 404，别的可能是 400/403，排查时要看。
    return {
      ok: false,
      code,
      msg: String(payload.msg || ''),
      httpStatus: response.status,
      error: describeError(code, payload.msg),
      urlRef: redactUrl(url),
    };
  }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const latest = String(data.version_name || '').trim();
  if (!latest) {
    return { ok: false, code: 'NO_VERSION', error: 'Mirror酱 没有返回版本号', urlRef: redactUrl(url) };
  }

  /*
   * 判断有没有更新只看版本号 —— 没填 CDK 时 url 一定不存在，但版本仍然有效。
   * 版本比较交给调用方（updater.compareVersions），这里不做字符串比大小。
   */
  return {
    ok: true,
    code: 0,
    latest,
    notes: String(data.release_note || ''),
    url: String(data.url || ''),
    sha256: String(data.sha256 || '').toLowerCase(),
    size: Number(data.filesize) || 0,
    updateType: String(data.update_type || ''),
    cdkExpiredAt: Number(data.cdk_expired_time) || 0,
    urlRef: redactUrl(url),
  };
}

/**
 * 下载到指定文件并校验 sha256。
 *
 * 为什么不让 updater 直接拿 url 去下：updater 的 downloadAndStage 里那套
 * 「多条线路测速 + 增量包优先」不认 Mirror酱 的临时地址（那个地址本身就带时效、
 * 也没有镜像前缀可换）。这里把文件下全、sha256 对上，再把它当本地文件交给
 * updater 的 stage 流程，两条链路各做各的擅长部分。
 */
function downloadToFile(url, targetPath, options = {}) {
  const expected = String(options.sha256 || '').toLowerCase();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const timeout = Number(options.timeout) || 30000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        fs.rmSync(targetPath, { force: true });
      } catch {
        /* 删不掉也不影响结论 */
      }
      reject(error);
    };
    const request = (target, redirects) => {
      if (redirects > 5) {
        fail(new Error('下载地址重定向次数过多'));
        return;
      }
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        fail(new Error('下载地址格式不对'));
        return;
      }
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : require('http');
      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: { 'User-Agent': `${USER_AGENT}/1.0` },
        },
        (res) => {
          const status = Number(res.statusCode) || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            request(new URL(res.headers.location, target).toString(), redirects + 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            fail(new Error(`下载失败（HTTP ${status}）`));
            return;
          }
          const total = Number(res.headers['content-length']) || Number(options.size) || 0;
          let received = 0;
          const hash = crypto.createHash('sha256');
          const out = fs.createWriteStream(targetPath);
          res.on('data', (chunk) => {
            received += chunk.length;
            hash.update(chunk);
            if (total > 0) onProgress({ received, total, percent: (received / total) * 100 });
          });
          res.on('error', (error) => fail(error));
          out.on('error', (error) => fail(error));
          out.on('finish', () => {
            if (settled) return;
            const actual = hash.digest('hex');
            if (expected && actual !== expected) {
              fail(new Error(`下载包校验不通过（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），已丢弃`));
              return;
            }
            settled = true;
            resolve({ path: targetPath, sha256: actual, size: received });
          });
          res.pipe(out);
        }
      );
      req.setTimeout(timeout, () => {
        req.destroy(new Error('下载超时'));
      });
      req.on('error', (error) => fail(error));
      req.end();
    };
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    } catch (error) {
      fail(error);
      return;
    }
    request(url, 0);
  });
}

module.exports = {
  USER_AGENT,
  checkLatest,
  downloadToFile,
  maskCdk,
  redactUrl,
  describeError,
};
