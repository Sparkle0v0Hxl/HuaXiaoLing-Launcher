'use strict';

/**
 * 启动器自更新。
 *
 * 设计目标：别的电脑上跑着旧版本时，也能自己发现新版本并一键升级，不需要人工发 ZIP。
 *
 * 版本信息来源是一个 JSON（下面叫 manifest），可以放在任意静态位置：
 *   - https://example.com/vela/latest.json
 *   - \\NAS\share\vela\latest.json   （局域网共享，不需要服务器）
 *   - D:\update\latest.json          （本地/移动硬盘）
 *
 * manifest 格式（`scripts/publish-portable.ps1` 会顺手生成一份，默认文件名 latest.json）：
 *   {
 *     "version": "2.0.1",
 *     "notes": "这一版改了什么",
 *     "url": "HuaXiaoLing-2.0.1-Portable.zip",   // 可写相对路径，相对 manifest 所在目录
 *     "sha256": "…",
 *     "size": 318437514,
 *     "mandatory": false
 *   }
 *
 * 完整流程：
 *   下载（带进度、断线重试）→ 校验 sha256 → 解压到临时目录
 *   → 校验包结构 → 备份被覆盖的文件 → 写覆盖脚本 → 退出
 *   → 脚本等进程退出、逐项备份并覆盖、重新拉起
 *   → 升级后 45 秒内连续起不来就自动还原备份和旧版自检脚本
 *
 * 覆盖范围刻意写死成白名单：程序本体（exe、dll、pak、locales…）和 resources/app。
 * data / downloads / netease-api / endfield-packs 一律不碰——那是账号、抽卡、
 * 歌单、游戏和渠道包，覆盖了就是数据事故。白名单比对用的是「ZIP 里有什么」，
 * 而不是相信 robocopy 的镜像语义，所以旧版本残留的 .bak / 临时文件也不会被误删。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { multiDownload } = require('./multi-download');

/*
 * 网络请求统一走 electron/http-fetch.js：那边优先用 Chromium 网络栈（net.fetch），
 * 证书走系统库、代理走系统设置，Steam++ 之类的加速器才生效；非 Electron 环境
 * （自测脚本）自动降级回 Node fetch。
 */
const { httpFetch, nodeRequest, segmentFetch } = require('./http-fetch');
/*
 * 清单签名校验。sha256 只能证明「文件没传坏」，证明不了「清单没被换」——
 * 两者走同一条通道，能改清单的人顺手就能把 sha256 一起改掉。签名用的是只有
 * 发包机才有的私钥，改任何受保护字段都会在这里被挡下。
 */
const minisign = require('./minisign');

const EXE_NAME = '花筱灵启动器.exe';
const DEFAULT_TIMEOUT = 15000;
/**
 * 读清单的超时要短得多。
 *
 * 清单只有几百字节，读不下来一定是这条源不通（raw.githubusercontent.com 在国内
 * 直接黑洞），没必要陪它耗 15 秒。以前是「一个源一个源挨着读」，第一条源死了就
 * 卡满超时，用户在「正在连接下载服务器…」上干等十几秒。
 */
const MANIFEST_TIMEOUT = 6000;
/** 已经拿到一份可用清单后，最多再等别的源这么久（等更高版本的那份）。 */
const MANIFEST_GRACE = 1800;
/** 下载断线时最多重试几次（不含第一次）。 */
const DOWNLOAD_RETRIES = 2;

/**
 * 单连接下载时「建连 + 拿到第一个字节」的上限。
 *
 * 这段计时只覆盖到响应头，一拿到响应就 clearTimeout，不影响后面读 body。
 * 原来是 60 秒：正常线路首包都在 1~3 秒内，60 秒拿到不首字节基本等于这条线不通了，
 * 用户在「正在下载」上白等一分钟才看到报错（而且报的是 ABORTED）。
 * 收到 20 秒，并且超时后立刻换线路，不在这条死路上原地重试。
 * 自测和排障可以设 HXL_UPDATE_CONNECT_TIMEOUT（毫秒，最低 1000）。
 */
const CONNECT_TIMEOUT = Math.max(1000, Number(process.env.HXL_UPDATE_CONNECT_TIMEOUT) || 20000);

/**
 * 分段下载的连接数。
 *
 * 直连 GitHub Release 时单条连接常被限到几十 KB/s（实测 53 KB/s），
 * 但总带宽并没有被限——开 16 条连接能到 10 MB/s 以上。所以并发是这里唯一
 * 有效的提速手段。GitHub 的 CDN 是 HTTP/2，多路复用不受浏览器「同域 6 连接」
 * 的限制。
 *
 * 2026-11 起不再走任何第三方加速镜像：免费镜像要么整片超时，要么实测只有
 * 一两百 KB/s，比限速后的直连还慢，还要先花几秒测速、赌一条随时会挂的线路。
 * 直连 + 多连接已经能到 6~10 MB/s，镜像这一层纯属负担，直接删掉。
 */
const DOWNLOAD_CONNECTIONS = 16;

/**
 * 平均速度低于这个值就重来一次（观察 15 秒后判定）。
 * 已经没有别的线路可换了，所以这不是「换线」，只是防止卡在一条极慢的连接上
 * 一路耗到超时——重开会重新挑连接，通常能躲开被限速的那几条。
 */
const MIN_DOWNLOAD_SPEED = 120 * 1024;

/** 覆盖时永远不碰的东西：用户数据、内置服务、游戏渠道包。 */
const PROTECTED_ROOT = new Set(['data', 'downloads']);
const PROTECTED_CHILD = new Set([
  'resources/netease-api',
  'resources/endfield-packs',
  'resources/app/node_modules',
]);

/* ---------------------------------------------------------------- */
/* 版本号                                                             */
/* ---------------------------------------------------------------- */

function parseVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  const core = text.split(/[-+]/)[0];
  const parts = core.split('.').map((piece) => {
    const num = Number.parseInt(piece.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(num) ? num : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

/* ---------------------------------------------------------------- */
/* 位置解析                                                           */
/* ---------------------------------------------------------------- */

function isHttpLocation(target) {
  return /^https?:\/\//i.test(String(target || ''));
}

function isFileUrl(target) {
  return /^file:\/\//i.test(String(target || ''));
}

function fileUrlToPath(target) {
  try {
    return decodeURIComponent(new URL(target).pathname.replace(/^\//, ''));
  } catch {
    return String(target).replace(/^file:\/{2,}/i, '');
  }
}

function toLocalPath(target) {
  return isFileUrl(target) ? fileUrlToPath(target) : String(target);
}

/** manifest 里可以写相对路径，按 manifest 自身位置补全。 */
function resolveAgainst(base, relative) {
  const rel = String(relative || '').trim();
  if (!rel) return '';
  if (isHttpLocation(rel) || isFileUrl(rel) || path.isAbsolute(rel)) return rel;
  if (isHttpLocation(base)) {
    try {
      return new URL(rel, base).href;
    } catch {
      return rel;
    }
  }
  const basePath = toLocalPath(base);
  return path.join(path.dirname(basePath), rel);
}

/* ---------------------------------------------------------------- */
/* manifest                                                           */
/* ---------------------------------------------------------------- */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchText(location, timeout = DEFAULT_TIMEOUT) {
  if (isHttpLocation(location)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await httpFetch(location, {
        signal: controller.signal,
        // 有的静态站点（对象存储、CDN）不认 Electron 的 UA，直接 403
        headers: {
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          'user-agent': BROWSER_UA,
          accept: 'application/json,text/plain,*/*',
        },
      });
      if (!response.ok) throw new Error(`更新源返回 ${response.status}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
  const file = toLocalPath(location);
  if (!fs.existsSync(file)) throw new Error('找不到更新源文件');
  return await fsp.readFile(file, 'utf8');
}

/**
 * 把清单里的 deltas 数组解析成统一的 {from,to,url,sha256,size}，url 按清单位置补全。
 * deltas 是可选的：老清单没有这个字段时返回空数组，行为与过去完全一致。
 */
function parseDeltas(data, base) {
  const list = Array.isArray(data && data.deltas) ? data.deltas : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const from = String(item.from || '').trim().replace(/^v/i, '');
    const to = String(item.to || '').trim().replace(/^v/i, '');
    const url = resolveAgainst(base, item.url);
    if (!from || !to || !url) continue;
    out.push({
      from,
      to,
      url,
      sha256: String(item.sha256 || '').trim().toLowerCase(),
      size: Number(item.size) || 0,
    });
  }
  return out;
}

/**
 * 读取并校验 manifest。
 *
 * 随包分发的那份 latest.json 只写「真正的清单在哪」（manifest 指针），
 * 因为打进包里的时候还没算出这个包自己的 sha256——自己算自己的哈希是不可能的。
 * 遇到这种清单就顺着指针再取一次真正的清单：下载地址和 sha256 都在那一份里。
 *
 * @returns {Promise<{version:string,notes:string,url:string,sha256:string,size:number,mandatory:boolean,source:string,title:string,date:string}>}
 */
async function readManifest(location, timeout = MANIFEST_TIMEOUT) {
  const raw = String(location || '').trim();
  if (!raw) throw new Error('还没有设置更新源');
  const text = await fetchText(raw, timeout);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('更新源不是有效的 JSON');
  }
  if (!data || typeof data !== 'object') throw new Error('更新源内容无效');

  // 指针式清单：自己没有下载地址，就去它指的地方拿真正的那份
  const pointer = String(data.manifest || data.redirect || '').trim();
  if (pointer && !data.url) {
    const real = await readManifest(resolveAgainst(raw, pointer), timeout);
    return { ...real, source: raw };
  }

  const version = String(data.version || '').trim().replace(/^v/i, '');
  if (!version) throw new Error('更新源里没有版本号');
  // 有签名就必须验过；没签名（过渡期的老清单）交给上层按「已验签过的版本」决定放不放行
  const sigCheck = minisign.verifyManifest(data);
  if (sigCheck.state === 'invalid') {
    const error = new Error(`更新清单签名校验失败：${sigCheck.reason}`);
    error.code = 'SIGNATURE_INVALID';
    throw error;
  }
  return {
    version,
    title: String(data.title || '').trim(),
    date: String(data.date || '').trim(),
    notes: String(data.notes || '').trim(),
    url: resolveAgainst(raw, data.url),
    sha256: String(data.sha256 || '').trim().toLowerCase(),
    size: Number(data.size) || 0,
    mandatory: Boolean(data.mandatory),
    deltas: parseDeltas(data, raw),
    sigState: sigCheck.state,
    sigReason: sigCheck.reason,
    source: raw,
  };
}

/**
 * 把若干候选地址挨个读一遍，挑版本最高的那份算数。
 *
 * 为什么不是「第一个读得通就用」：启动器目录里那份 latest.json 可能是上个版本留下的、
 * 版本号和当前一样，第一个就用它的话，永远只会得到「已是最新」，官网上更新的版本就再也
 * 看不见了。所以这里全部读一遍，谁能给出更高的版本号就用谁；都不比当前新时，返回版本
 * 最高的那份，让调用方照常判断「已是最新」。
 *
 * @returns {Promise<{ok:boolean,manifest?:object,source?:string,error?:string}>}
 */
async function resolveManifest(candidates) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
  if (!list.length) return { ok: false, error: '读不到更新源' };
  /*
   * 并发读，不是挨着读。
   *
   * 候选里既有本机文件、又有国内 CDN、还有国内根本不通的 raw.githubusercontent.com。
   * 串行的时候，排在前面的一条死了就白白占满一个超时；用户看到的就是「正在连接下载
   * 服务器…」停十几秒才动。现在同时发出去，整体耗时等于最快那条。
   */
  let best = null;
  let lastError = null;
  let sigError = null;
  let remaining = list.length;
  let settle = () => {};
  let graceTimer = null;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });

  let index = 0;
  for (const candidate of list) {
    const order = index;
    index += 1;
    readManifest(candidate)
      .then(
        (manifest) => {
          /*
           * 版本相同的时候不能「谁先返回用谁」。
           *
           * 各源清单里的下载地址并不一样：GitHub / jsDelivr 上那份写的是
           * github.com 直连，Gitee 镜像那份写的是带加速前缀的地址。同一时间
           * 全部返回 2.8.2，先到的那条就决定了用户走哪条线路——国内机器上
           * 这条恰好直连，188 MB 就下成了几十 KB/s，而且每次表现还不一样。
           * 所以版本持平时改用调用方给定的顺序，谁优先级高用谁。
           */
          if (!best) {
            best = { manifest, source: manifest.source, order };
          } else {
            const diff = compareVersions(manifest.version, best.manifest.version);
            if (diff > 0 || (diff === 0 && order < best.order)) {
              best = { manifest, source: manifest.source, order };
            }
          }
          /*
           * 已经有可用结果了，就别让剩下那条死链再把用户拖满一个超时。
           * 留一点宽限，是为了让「本地那份旧清单先到、线上新清单后到」这种情况下
           * 还能取到版本更高的那份。
           */
          if (!graceTimer) {
            graceTimer = setTimeout(() => {
              if (best) settle();
            }, MANIFEST_GRACE);
          }
        },
        (error) => {
          lastError = error;
          // 签名不对比「连不上」严重得多：混在普通网络错误里会被用户当成网络问题忽略掉
          if (error && error.code === 'SIGNATURE_INVALID') sigError = error;
        }
      )
      .finally(() => {
        remaining -= 1;
        if (remaining <= 0) {
          if (graceTimer) clearTimeout(graceTimer);
          settle();
        }
      });
  }

  await finished;
  if (best) return { ok: true, manifest: best.manifest, source: best.source };
  if (sigError) return { ok: false, code: 'SIGNATURE_INVALID', error: sigError.message };
  return {
    ok: false,
    error: lastError && lastError.message ? lastError.message : String(lastError || '读不到更新源'),
  };
}

/**
 * 比较本地版本与更新源。
 * 传入的 location 可以是数组（多个候选地址）：全部读一遍，取版本最高的那份。
 * @returns {Promise<{ok:boolean, hasUpdate:boolean, current:string, latest:string|null, notes:string, url:string, sha256:string, size:number, mandatory:boolean, source?:string, error?:string}>}
 */
async function checkForUpdate({ location, currentVersion }) {
  const current = String(currentVersion || '0.0.0');
  const candidates = (Array.isArray(location) ? location : [location]).filter(Boolean);
  if (!candidates.length) {
    return {
      ok: false,
      hasUpdate: false,
      current,
      latest: null,
      notes: '',
      url: '',
      sha256: '',
      size: 0,
      mandatory: false,
      error: '还没有设置更新源',
    };
  }
  const resolved = await resolveManifest(candidates);
  if (!resolved.ok) {
    return {
      ok: false,
      hasUpdate: false,
      current,
      latest: null,
      notes: '',
      url: '',
      sha256: '',
      size: 0,
      mandatory: false,
      code: resolved.code || '',
      error: resolved.error || '读不到更新源',
    };
  }
  const manifest = resolved.manifest;
  return {
    ok: true,
    hasUpdate: compareVersions(manifest.version, current) > 0,
    current,
    latest: manifest.version,
    title: manifest.title,
    date: manifest.date,
    notes: manifest.notes,
    url: manifest.url,
    sha256: manifest.sha256,
    size: manifest.size,
    mandatory: manifest.mandatory,
    deltas: manifest.deltas || [],
    sigState: manifest.sigState || 'none',
    sigReason: manifest.sigReason || '',
    // 匹配「当前版本 -> 目标版本」的增量；界面上据此提示「本次走增量」
    delta:
      (manifest.deltas || []).find(
        (d) =>
          d.from === String(current).replace(/^v/i, '') &&
          d.to === String(manifest.version).replace(/^v/i, '')
      ) || null,
    source: resolved.source,
  };
}
/* ---------------------------------------------------------------- */
/* 下载                                                               */
/* ---------------------------------------------------------------- */

/**
 * 下载一个候选地址:内部按 DOWNLOAD_RETRIES 重试(瞬时错误),
 * 4xx 这类「地址本身有问题」的错误不重试、直接换下一个候选。
 */
async function downloadSingle({ url, dest, expectedSize, report }) {
  let lastError = null;
  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT);
    try {
      const response = await httpFetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': BROWSER_UA, accept: '*/*' },
      });
      clearTimeout(timer);
      if (!response.ok) {
        const error = new Error(`下载失败（${response.status}）`);
        // 4xx 是地址本身有问题，重试没有意义
        error.retryable = response.status >= 500 || response.status === 408 || response.status === 429;
        throw error;
      }
      const total = Number(response.headers.get('content-length')) || expectedSize || 0;
      const handle = await fsp.open(dest, 'w');
      let received = 0;
      try {
        const reader = response.body.getReader();
        for (;;) {
          /*
           * 单连接也要有「读不动」的保护。原来只给建连设了 60 秒超时，
           * 一旦连接建好但对方不再吐数据（国内直连 GitHub 常见），
           * reader.read() 会永久挂着，进度条就定格不动了。
           */
          let idleTimer = null;
          const stalled = new Promise((_, reject) => {
            idleTimer = setTimeout(() => reject(new Error('连接长时间没有数据')), 30000);
          });
          let chunk;
          try {
            chunk = await Promise.race([reader.read(), stalled]);
          } finally {
            if (idleTimer) clearTimeout(idleTimer);
          }
          const { done, value } = chunk;
          if (done) break;
          await handle.write(value);
          received += value.length;
          report(total ? (received / total) * 100 : 0, received, total);
        }
      } catch (error) {
        try {
          await response.body?.cancel();
        } catch {
          /* 已经关闭 */
        }
        throw error;
      } finally {
        await handle.close();
      }
      report(100, received, total || received);
      return dest;
    } catch (error) {
      clearTimeout(timer);
      /*
       * 超时是这条链路上最常见的失败，但它原来以 AbortError / message='ABORTED'
       * 的形式直接冒到界面上，用户只看到「更新失败：ABORTED」，无从下手。
       * 这里翻译成人话，并打上 timeout 标记：同一地址不再原地重试（三次 20 秒
       * 白等一分钟），而是立刻交给上层换线路——镜像、直连、Chromium 栈各算一条。
       */
      let failure = error;
      if (controller.signal.aborted) {
        failure = new Error(`连接更新源超时（${CONNECT_TIMEOUT / 1000} 秒没有响应）`);
        failure.code = 'ABORTED';
        failure.timeout = true;
        failure.cause = error;
      }
      lastError = failure;
      if (failure.timeout || failure.retryable === false || attempt >= DOWNLOAD_RETRIES) break;
    }
  }
  throw lastError || new Error('下载失败');
}

/**
 * 下载一个更新包：先试多连接分段，不满足条件再退回单连接。
 *
 * 分段的意义在带宽之外——单连接被限速时，多连接能吃到被「每条连接」限掉的
 * 那部分余量。分段不可用（服务器不认 Range、包太小、本地写盘出错）时一律
 * 退回单连接，所以「快不了」不会变成「下不下来」。
 *
 * @param {object} options
 * @param {boolean} [options.minSpeed] 传入后启用慢速判定：平均速度低于阈值就
 *   抛 slow 错误，让上层重开一遍；退到单连接时不再判定（慢总比没有强）。
 */
async function downloadOne({ url, dest, expectedSize, report, minSpeed = 0 }) {
  const headers = { 'user-agent': BROWSER_UA, accept: '*/*' };
  /*
   * 分段必须走 node:https —— 每段一条独立 TCP。
   *
   * 用 Chromium 的 net.fetch 做分段等于白做：它对同一个 host 最多开 6 条 socket，
   * 而 GitHub 的下载资源还支持 HTTP/2，16 个 Range 请求会被并进一两条连接里，
   * 共享同一个拥塞窗口。表现就是「多线程加了，速度一点没变」。NDM 那种能跑满
   * 带宽的下载器，靠的正是每段各自一条连接、各走各的窗口。
   *
   * nodeRequest 连不上时（用户是靠系统代理才出得去网，Node 不读系统代理）
   * 再退回 Chromium 栈：那时只有 6 条并发，但也比一条强。
   */
  const plans = [
    { name: 'node', impl: segmentFetch },
    { name: 'chromium', impl: httpFetch },
  ];
  let lastError = null;
  for (const plan of plans) {
    try {
      return await multiDownload({
        url,
        dest,
        expectedSize,
        report,
        fetchImpl: plan.impl,
        headers,
        connections: DOWNLOAD_CONNECTIONS,
        minSpeed,
        /*
         * 两条栈的「CDN 认不认 Range」必须分开记。
         * node:https 读不到系统代理，靠代理出网的机器上它必然探测失败；
         * 要是把它记成「这台 CDN 不支持分段」，换到 Chromium 栈时缓存直接命中
         * false，连探测都不做就退回单连接——16 连接变 1 连接，速度掉几十倍。
         */
        stackName: plan.name,
      });
    } catch (error) {
      // 慢速判定要交给上层重开，不能在这里吞掉
      if (error && error.slow) throw error;
      lastError = error;
      console.warn(`[update] 分段下载（${plan.name}）不可用：`, error && error.message);
    }
  }
  if (lastError) {
    console.warn('[update] 退回单连接下载：', lastError.message);
  }
  return await downloadSingle({ url, dest, expectedSize, report });
}

/* ---------------------------------------------------------------- */
/* 下载地址：先挑一条快的，再开始下                                   */
/* ---------------------------------------------------------------- */

/**
 * 转发型加速前缀（拼在原始 https 地址前面即可用）。
 *
 * 为什么又加回来：2026-11 那次把镜像整层删掉，理由是「本机直连 16 连接能到
 * 6~10 MB/s」——那是国际出口通畅时的实测。国内大部分机器直连 GitHub Release
 * 是几十 KB/s 甚至直接超时，而转发型镜像在那类网络里反而快得多，两类用户
 * 的结论完全相反，所以「只留一个」注定要牺牲一半人。
 *
 * 现在的做法不再是二选一：开下载前先并发向每条线路各要一小段，谁先给、
 * 给得快就用谁。直连快就走直连（少一层转发，也少一个能改包的中间人），
 * 直连慢才落到镜像；镜像全挂也只是回到直连，不会比现在更差。
 *
 * sha256 仍由清单把关，中间人改不了包的内容。
 */
const ACCEL_PREFIXES = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://gh.llkk.cc/',
  'https://ghproxy.net/',
];

/** 探测时每条线路要多少字节。太小测不出速度，太大白等。 */
const PROBE_BYTES = 192 * 1024;
/** 单条线路的探测上限。探测是并发的，整体耗时约等于最慢那条。 */
const PROBE_TIMEOUT = 6000;
/** 小于这个体积的包不值得先探测（增量包往往只有几十 KB，探测反而更慢）。 */
const PROBE_MIN_SIZE = 2 * 1024 * 1024;
/** 直连比最快的镜像慢不超过这个比例时，仍然优先直连。 */
const DIRECT_PREFERENCE = 0.8;

/** 由官方地址派生出候选线路：官方直连在最前，后面是各加速前缀。 */
function accelerateCandidates(url) {
  const raw = String(url || '').trim();
  if (!raw) return [];
  const list = [raw];
  if (/^https:\/\/(www\.)?(github\.com|githubusercontent\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com)\//i.test(raw)) {
    for (const prefix of ACCEL_PREFIXES) {
      const candidate = prefix + raw;
      if (!list.includes(candidate)) list.push(candidate);
    }
  }
  return list;
}

/**
 * 向一条线路要最前面一小段，测它能不能通、有多快。
 * 只看首段的瞬时速度——完整包动辄上百 MB，等下完再判断就太晚了。
 */
async function probeSource(url, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await httpFetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': BROWSER_UA, accept: '*/*', range: `bytes=0-${PROBE_BYTES - 1}` },
    });
    // 206 = 认 Range；200 = 无视 Range 从开头整包给，也算通
    if (!response.ok && response.status !== 206) return { url, ok: false };
    const buffer = await response.arrayBuffer();
    const ms = Math.max(1, Date.now() - started);
    return { url, ok: true, bytes: buffer.byteLength, ms, speed: (buffer.byteLength / ms) * 1000 };
  } catch {
    return { url, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** 拿到第一条可用线路后，最多再等这么久，给别的线路一个反超的机会。 */
const PROBE_GRACE = 1200;

/**
 * 给候选线路排个序：快的在前。
 *
 * 探测失败（超时、被墙、镜像挂了）的线路直接出局，所以「免费镜像随时会挂」
 * 不再是需要提前担心的事——挂了这条就不会被选中。
 *
 * 不等所有线路都回来：拿到第一条能用的之后只再宽限 1.2 秒。否则一条死链
 * 就能把探测拖满 6 秒超时，用户还没开始下载就先干等着。
 */
async function rankSources(url, expectedSize = 0) {
  const list = accelerateCandidates(url);
  if (list.length <= 1) return list;
  if (expectedSize && expectedSize < PROBE_MIN_SIZE) return list;

  const usable = [];
  let remaining = list.length;
  let settle = () => {};
  let graceTimer = null;
  const done = new Promise((resolve) => {
    settle = resolve;
  });

  for (const item of list) {
    probeSource(item, PROBE_TIMEOUT)
      .then((result) => {
        if (result.ok && result.bytes > 0) {
          usable.push(result);
          if (!graceTimer) {
            graceTimer = setTimeout(settle, PROBE_GRACE);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        remaining -= 1;
        if (remaining <= 0) {
          if (graceTimer) clearTimeout(graceTimer);
          settle();
        }
      });
  }

  await done;
  if (!usable.length) return list;

  usable.sort((a, b) => b.speed - a.speed);
  const fastest = usable[0];
  const direct = usable.find((item) => item.url === url);

  // 直连能用，且没比最快的镜像慢太多，就还是走直连
  if (direct && direct.speed >= fastest.speed * DIRECT_PREFERENCE) {
    return [url, ...usable.filter((item) => item.url !== url).map((item) => item.url)];
  }
  const ordered = usable.map((item) => item.url);
  // 没测通的官方地址留在最后兜底：万一最快的那条中途断了还有原路可退
  if (!ordered.includes(url)) ordered.push(url);
  return ordered;
}

/**
 * 下载更新包：先挑一条快的线路，中途断了就换下一条。
 *
 * 这里不再做「平均速度低就重开一遍」：那种重来会把已经下好的进度清零，用户看到
 * 的就是进度条归零、又从 0 慢慢爬。真正该处理的「卡住」交给 multiDownload 的
 * 停滞看门狗（45 秒没进展就换网络栈/退单连接），有进展就一直往下走。
 */
async function downloadHttp({ url, dest, expectedSize, report }) {
  const official = String(url || '').trim();
  if (!official) throw new Error('没有可用的下载地址');
  const sources = await rankSources(official, expectedSize);
  let lastError = null;
  for (const source of sources) {
    try {
      return await downloadOne({ url: source, dest, expectedSize, report });
    } catch (error) {
      // 4xx 是地址本身有问题，换线路也没用
      if (error && error.retryable === false) throw error;
      lastError = error;
      console.warn(`[update] 这条线路下载失败，换下一条：${source} — ${error && error.message}`);
    }
  }
  /*
   * 所有线路（直连 + 各镜像）都没起来时，别把最后一条的内部错误原样丢给用户。
   * 「连接更新源超时」这类话要说清是「全都连不上」，并且给出下一步动作，
   * 否则用户只知道自己更新失败，不知道该怎么办。
   */
  if (lastError && lastError.timeout) {
    const mirrors = Math.max(0, sources.length - 1);
    const error = new Error(
      mirrors > 0
        ? `连不上更新源（直连和 ${mirrors} 条镜像线路都没有响应），请检查网络后重试；国内网络直连 GitHub 常常需要开加速器`
        : '连不上更新源（多次请求都没有响应），请检查网络后重试；国内网络直连 GitHub 常常需要开加速器'
    );
    error.retryable = true;
    error.timeout = true;
    error.cause = lastError;
    throw error;
  }
  throw lastError || new Error('下载失败');
}

async function downloadToFile({ url, dest, expectedSize = 0, onProgress }) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  /*
   * 速度也一起算出来给界面用。以前只给百分比，用户看到的是「0%」和一个不动的条，
   * 分不清是在慢慢下还是彻底卡住——把 MB/s 摆出来，卡没卡一眼就知道。
   */
  let lastAt = 0;
  let lastReceived = 0;
  let speed = 0;
  const report = (percent, received, total) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (lastAt && now > lastAt && received >= lastReceived) {
      const instant = ((received - lastReceived) / (now - lastAt)) * 1000;
      // 指数平滑：单次采样的抖动太大，直接显示会一直跳
      speed = speed > 0 ? speed * 0.7 + instant * 0.3 : instant;
    }
    lastAt = now;
    lastReceived = received;
    try {
      onProgress({
        percent: Math.max(0, Math.min(100, percent)),
        received,
        total,
        speed: Number.isFinite(speed) ? Math.max(0, speed) : 0,
      });
    } catch {
      /* 进度回调出错不影响下载 */
    }
  };

  if (isHttpLocation(url)) {
    return await downloadHttp({ url, dest, expectedSize, report });
  }

  const source = toLocalPath(url);
  if (!fs.existsSync(source)) throw new Error('更新包文件不存在');
  const stat = await fsp.stat(source);
  if (expectedSize && stat.size !== expectedSize) {
    throw new Error(`更新包大小不对（清单写 ${expectedSize}，实际 ${stat.size}）`);
  }
  await fsp.copyFile(source, dest);
  report(100, stat.size, stat.size);
  return dest;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/* ---------------------------------------------------------------- */
/* 解压                                                               */
/* ---------------------------------------------------------------- */

function runPowerShell(script, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: 'ignore' }
    );
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('解压超时'));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`解压失败（${code}）`));
    });
  });
}

async function extractZip(zipPath, extractRoot) {
  await fsp.mkdir(extractRoot, { recursive: true });
  // 优先用 .NET 的 ZipFile 解压：实测部分机器 / 旧版 PowerShell 的 Expand-Archive
  // 在解压大体积 ZIP（>100MB）时会中途静默退出（exit 0 但只抽出半截），导致覆盖后
  // 启动器缺文件打不开。.NET 的 ZipFile 更稳，Expand-Archive 作为兜底。
  const dotNet = `[System.IO.Compression.ZipFile]::ExtractToDirectory(${JSON.stringify(zipPath)}, ${JSON.stringify(extractRoot)})`;
  try {
    await runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem; ${dotNet}`);
    return;
  } catch (err) {
    try {
      await runPowerShell(
        `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(extractRoot)} -Force`
      );
      return;
    } catch (err2) {
      throw new Error(`解压更新包失败：${err2 && err2.message ? err2.message : err2}`);
    }
  }
}

function findPackageRoot(extractRoot) {
  const candidates = [path.join(extractRoot, '花筱灵启动器'), extractRoot];
  // 两种打包形态都认：asar 包（resources/app.asar）和展开目录（resources/app/package.json）。
  // electron-builder 默认打 asar，老的安装是展开目录，两边互相更新都要能装。
  const looksLikePackage = (dir) =>
    fs.existsSync(path.join(dir, EXE_NAME)) &&
    (fs.existsSync(path.join(dir, 'resources', 'app', 'package.json')) ||
      fs.existsSync(path.join(dir, 'resources', 'app.asar')));
  return candidates.find(looksLikePackage) || '';
}

/** 递归列出目录下的所有文件（相对路径统一用 / 分隔）。 */
async function listFiles(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await walk(root, '');
  return out;
}

/** 这个相对路径是不是「用户数据」或者「不该被更新动」的东西。 */
function isProtected(rel) {
  const norm = String(rel || '').replace(/\\/g, '/');
  const top = norm.split('/')[0];
  if (PROTECTED_ROOT.has(top)) return true;
  for (const guarded of PROTECTED_CHILD) {
    if (norm === guarded || norm.startsWith(`${guarded}/`)) return true;
  }
  // 用户自己留的备份、临时文件、编辑器存档
  if (/\.bak(-\S+)?$/i.test(norm)) return true;
  if (/\.(tmp|temp|part|download|crdownload)$/i.test(norm)) return true;
  if (/(^|\/)\.DS_Store$/i.test(norm)) return true;
  return false;
}

/**
 * 解压 + 校验 + 规划覆盖范围。
 * 这一步不碰程序目录，任何问题都在这里报出来，用户还能继续用旧版本。
 * @returns {Promise<{tempRoot:string, source:string, target:string, version:string, files:string[], removed:string[], locks:string[], installerSource:string, selfHealSource:string}>}
 */
/**
 * 解压 + 校验 + 规划覆盖范围。
 * 这一步不碰程序目录，任何问题都在这里报出来，用户还能继续用旧版本。
 *
 * 版本号来源有两个，优先用清单里的：清单是发布脚本写的，改起来不需要重新打 ZIP；
 * 包里 package.json 的版本号只作为兜底和一致性参考。
 *
 * @param {object} options
 * @param {string} options.zipPath    已下载的更新包
 * @param {string} options.tempBase   临时目录根（一般是 <程序目录>/data/tmp）
 * @param {string} [options.version]  manifest 里声明的版本号
 * @returns {Promise<{tempRoot:string, source:string, target:string, version:string, files:string[], removed:string[], locks:string[], installerSource:string, selfHealSource:string}>}
 */
async function stage({ zipPath, tempBase, version: declaredVersion = '' }) {
  await fsp.mkdir(tempBase, { recursive: true });
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, 'vela-update-'));
  const extractRoot = path.join(tempRoot, 'extract');
  await extractZip(zipPath, extractRoot);
  const source = findPackageRoot(extractRoot);
  if (!source) {
    // 解压成功却找不到启动器主程序，多半是 ZIP 结构不对 / 抽出半截。把解压清单留下来方便排障。
    try {
      const dumped = (await listFiles(extractRoot)).slice(0, 300);
      await fsp.writeFile(
        path.join(tempRoot, 'stage-debug.json'),
        JSON.stringify({ extractRoot, tempRoot, fileCount: dumped.length, files: dumped }, null, 2),
        'utf8'
      );
    } catch {
      /* 诊断写入失败不影响主流程报错 */
    }
    throw new Error('这个 ZIP 不是有效的花筱灵便携版更新包（解压后找不到启动器主程序；解压清单已记入 stage-debug.json）');
  }

  let packageVersion = '';
  try {
    packageVersion = String(
      JSON.parse(await fsp.readFile(path.join(source, 'resources', 'app', 'package.json'), 'utf8')).version || ''
    );
  } catch {
    packageVersion = '';
  }
  const declared = String(declaredVersion || '').trim().replace(/^v/i, '');
  const version = declared || packageVersion;
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error('更新包和清单里都没有版本号，不敢覆盖');
  }

  const target = path.dirname(process.execPath);
  if (path.resolve(source) === path.resolve(target)) throw new Error('更新包解压到了程序目录里，已中止');

  const listing = await listFiles(source);
  if (!listing.length) throw new Error('更新包是空的');
  const hasAsar = listing.includes('resources/app.asar');
  const hasAppDir = listing.includes('resources/app/electron/main.js');
  if (!hasAsar && !hasAppDir) {
    throw new Error('更新包里既没有 resources/app.asar 也没有 resources/app/electron/main.js，覆盖后启动器会打不开');
  }

  const files = listing.filter((rel) => !isProtected(rel));
  // 被覆盖的文件里可能有游戏正在跑的 exe，提前收集出来让主进程去核对
  const locks = files.filter((rel) => !rel.includes('/'));

  // 覆盖脚本是更新包的一部分，缺了这次的更新就等于装不上——必须在动程序目录之前拦下来
  const installerSource = path.join(source, 'resources', 'updater', 'HXL-Updater.ps1');
  const selfHealSource = path.join(source, 'resources', 'updater', 'self-heal.ps1');
  const applyJsSource = path.join(source, 'resources', 'updater', 'apply.js');
  // 覆盖器优先用 Node 版（不受安全软件拦 PowerShell 的影响）；
  // 老版本打出来的包里没有 apply.js，那种情况退回 ps1 兜底，所以不能一上来就抛错——
  // 只有「两套覆盖器都没有」才是真的装不上。
  const hasApplyJs = fs.existsSync(applyJsSource);
  if (!hasApplyJs) {
    if (!fs.existsSync(installerSource)) {
      throw new Error('更新包里既没有 resources/updater/apply.js 也没有 HXL-Updater.ps1，无法完成覆盖');
    }
    if (!fs.existsSync(selfHealSource)) {
      throw new Error('更新包里缺少 resources/updater/self-heal.ps1，升级失败后无法自动还原');
    }
  }

  // 新包里已经没有、但旧目录里还在的程序文件：覆盖时一起清掉，避免新旧掺杂
  const protectedExisting = new Set();
  try {
    const existing = await listFiles(target);
    for (const rel of existing) if (isProtected(rel)) protectedExisting.add(rel);
  } catch {
    /* 读不到就只做覆盖，不做清理 */
  }

  return {
    tempRoot,
    source,
    target,
    version,
    packageVersion,
    // 新包是 asar 还是展开目录：覆盖脚本据此清掉目标里另一套旧结构
    hasAsar,
    hasAppDir,
    files,
    removed: [],
    protectedExisting: [...protectedExisting],
    locks,
    installerSource,
    selfHealSource,
    applyJsSource,
  };
}

/* ---------------------------------------------------------------- */
/* 覆盖                                                               */
/* ---------------------------------------------------------------- */

function relaunchPath() {
  const runningExe = String(process.execPath || '');
  if (runningExe && fs.existsSync(runningExe)) return runningExe;
  return path.join(path.dirname(process.execPath), EXE_NAME);
}

/**
 * 生成并启动覆盖脚本。
 *
 * 覆盖脚本（优先 resources/updater/apply.js，PowerShell 版 HXL-Updater.ps1 兜底）负责：
 *   1. 等旧进程退出；
 *   2. 把要覆盖的程序文件逐个备份到 data\tmp\backup-<版本>；
 *   3. 按清单覆盖（逐项复制，绝不镜像整个目录）；
 *   4. 写「升级成功」标记，重新拉起启动器；
 *   5. 用户要求回滚时，先把旧备份还原回去再拉起。
 *
 * @returns {Promise<{ok:true, restarting:true, version:string, target:string}>}
 */
async function apply({ staged, onReadyToQuit }) {
  const meta = buildApplyMeta(staged);
  const metaPath = path.join(staged.tempRoot || staged.backupDir, 'apply-meta.json');
  await fsp.mkdir(path.dirname(metaPath), { recursive: true });
  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  /*
   * 退出前先跟覆盖脚本握手。
   *
   * 老版本是「spawn 完立刻 app.quit()」：脚本要是压根没起来（PowerShell 被策略拦住、
   * 被杀软拦下、脚本自己一上来就报错），启动器已经关了，用户看到的就是
   * 「下载到 100% 之后窗口消失，再也没回来」。
   * 现在脚本一进来就写 apply-started.json，等不到这个文件就不退出，把错误抛给界面。
   */
  const statusDir = updateStatusDir(meta.target);
  const startedPath = path.join(statusDir, 'apply-started.json');
  const errorPath = path.join(statusDir, 'update-error.json');
  for (const stale of [startedPath, errorPath]) {
    await fsp.rm(stale, { force: true }).catch(() => {});
  }

  let spawnError = null;
  const child = spawnApplyInstaller({ meta, metaPath });
  child.on('error', (error) => {
    spawnError = error;
  });
  try {
    child.unref();
  } catch {
    /* ignore */
  }

  const started = await waitForFile(startedPath, APPLY_HANDSHAKE_TIMEOUT, () => spawnError);
  if (!started) {
    const detail = await readUpdateError(errorPath);
    if (spawnError) {
      throw new Error(
        `系统没能启动覆盖脚本（${spawnError.message}），更新已取消，启动器没有被关闭`
      );
    }
    if (detail) {
      throw new Error(`覆盖脚本一启动就出错了：${detail}\n日志：${path.join(statusDir, 'update-log.txt')}`);
    }
    throw new Error(
      `覆盖脚本 ${Math.round(APPLY_HANDSHAKE_TIMEOUT / 1000)} 秒内没有响应，更新已取消，启动器没有被关闭`
    );
  }

  // 握手成功但脚本随即失败（比如解压目录被删）：别急着退出，先看一眼错误文件
  const early = await readUpdateError(errorPath);
  if (early) {
    throw new Error(`覆盖脚本准备阶段失败：${early}\n日志：${path.join(statusDir, 'update-log.txt')}`);
  }

  if (typeof onReadyToQuit === 'function') onReadyToQuit();
  return { ok: true, restarting: true, version: meta.targetVersion, target: meta.target };
}

/**
 * 拉起覆盖安装器。
 *
 * 首选 JS 版（resources/updater/apply.js）：它是这个 Electron 自带的 Node 跑起来的，
 * 不经过 PowerShell。这里踩过坑——不少机器的安全软件/策略会拦「Electron 进程调
 * PowerShell 执行脚本」，脚本压根没被执行，更新永远停在 100%。
 * PowerShell 那条路留作兜底：只有两份 apply.js 都不在时才走。
 */
function spawnApplyInstaller({ meta, metaPath }) {
  const applyJs = String((meta && meta.applyJs) || '');
  if (applyJs && fs.existsSync(applyJs)) {
    return spawn(process.execPath, [applyJs, '--meta', metaPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
  }
  return spawn(
    powershellCommand(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      meta.installer,
      '-MetaPath',
      metaPath,
    ],
    { detached: true, windowsHide: true, stdio: 'ignore' }
  );
}

/** 覆盖脚本报到的等待上限。脚本起来后要先建目录、写日志，给它留够时间。 */
const APPLY_HANDSHAKE_TIMEOUT = 25000;

/**
 * 等一个文件出现，期间每 250ms 看一眼。
 * probe 返回真值表示「别等了，已经失败」，用于 spawn 报错这类外部信号。
 */
function waitForFile(target, timeoutMs, probe) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (typeof probe === 'function' && probe()) {
        resolve(false);
        return;
      }
      if (fs.existsSync(target)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** 读覆盖脚本留下的错误说明，没有就返回空串。 */
async function readUpdateError(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    return String(parsed.message || '').trim();
  } catch {
    return '';
  }
}

/**
 * 用绝对路径找 PowerShell。
 * 走 PATH 的 'powershell.exe' 在某些机器上会失败（PATH 被改过、只装了 pwsh），
 * 这类失败在 detached + stdio:'ignore' 下完全静默，正是更新「卡在 100%」的来源之一。
 */
function powershellCommand() {
  if (process.platform !== 'win32') return 'powershell.exe';
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidates = [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

/**
 * 覆盖前的最后一道核对。返回空字符串表示可以覆盖，否则是要给用户看的拒绝理由。
 * 「新版本不比当前新」还硬装，等于让用户白下一次几百 MB —— 直接拦。
 */
function describeApplyProblem({ staged, currentVersion }) {
  const latest = String(staged.version || '');
  const current = String(currentVersion || '');
  if (compareVersions(latest, current) <= 0) {
    return `更新包的版本是 ${latest}，不比当前的 ${current} 新，已中止`;
  }
  const packageVersion = String(staged.packageVersion || '');
  if (packageVersion && compareVersions(packageVersion, latest) !== 0) {
    return `更新包里的 package.json 写的版本是 ${packageVersion}，和清单里的 ${latest} 对不上，已中止`;
  }
  return '';
}

/** 把 staged 对象整理成覆盖脚本要读的 apply-meta.json。 */
function buildApplyMeta(staged) {
  const applyJs = applyJsPath(staged);
  const installer = installerPs1Path(staged);
  if (!applyJs && !installer) {
    throw new Error('找不到覆盖脚本，更新包里缺少 resources/updater/apply.js 或 HXL-Updater.ps1');
  }
  return {
    action: staged.action || 'update',
    fromVersion: String(staged.fromVersion || ''),
    targetVersion: String(staged.version || staged.backupMeta?.fromVersion || ''),
    target: staged.target,
    source: staged.source || '',
    files: staged.files && staged.files.length ? staged.files : staged.backupMeta?.files || [],
    protectedExisting: staged.protectedExisting || staged.backupMeta?.protectedExisting || [],
    relaunch: relaunchPath(),
    selfHeal: selfHealPath(staged),
    statusDir: path.join(updateStatusDir(staged.target), ''),
    backupDir: staged.backupDir || '',
    staging: staged.tempRoot || '',
    installer,
    applyJs,
  };
}

/**
 * 覆盖安装器的路径：优先用更新包里那份（跟着版本走、能持续升级），
 * 包里没有就退回程序目录里现有的那份。两份都不在时返回空串。
 */
function applyJsPath(staged) {
  const fromPackage = String(staged.applyJsSource || '');
  if (fromPackage && fs.existsSync(fromPackage)) return fromPackage;
  const fallback = staged.source ? path.join(staged.source, 'resources', 'updater', 'apply.js') : '';
  if (fallback && fs.existsSync(fallback)) return fallback;
  const local = path.join(path.dirname(process.execPath), 'resources', 'updater', 'apply.js');
  return fs.existsSync(local) ? local : '';
}

/**
 * PowerShell 版覆盖脚本（兜底用）。同样优先包里那份，其次程序目录里那份。
 * 回滚时 staged 里没有 installerSource，必须能退到程序目录那份，否则回滚永远失败。
 */
function installerPs1Path(staged) {
  const fromPackage = String(staged.installerSource || '');
  if (fromPackage && fs.existsSync(fromPackage)) return fromPackage;
  const local = path.join(path.dirname(process.execPath), 'resources', 'updater', 'HXL-Updater.ps1');
  return fs.existsSync(local) ? local : '';
}

/**
 * 监护人脚本的路径：优先用更新包里那份（跟着版本走），
 * 包里没有就退回程序目录里现有的那份。
 */
function selfHealPath(staged) {
  const fromPackage = staged.tempRoot ? path.join(staged.tempRoot, 'resources', 'updater', 'self-heal.ps1') : '';
  if (fromPackage && fs.existsSync(fromPackage)) return fromPackage;
  const local = path.join(path.dirname(process.execPath), 'resources', 'updater', 'self-heal.ps1');
  return fs.existsSync(local) ? local : '';
}

/** 状态目录：放在程序目录旁边，跨版本保留。 */
function updateStatusDir(target) {
  return path.join(target, 'data', 'tmp');
}

/**
 * 准备回滚：把上一次升级留下的备份整理成一次「反向覆盖」。
 * 备份目录名是 backup-<旧版本>，所以不能写死 'backup'，要按 marker 找。
 * @returns {Promise<null|object>} 没有备份时返回 null
 */
async function prepareRollback({ tempBase }) {
  void tempBase;
  const target = path.dirname(process.execPath);
  const statusDir = updateStatusDir(target);
  let found = '';
  try {
    const marker = JSON.parse(await fsp.readFile(path.join(statusDir, 'last-update.json'), 'utf8'));
    if (marker.backupRoot && fs.existsSync(String(marker.backupRoot))) found = String(marker.backupRoot);
  } catch {
    /* marker 不在就扫目录 */
  }
  if (!found) {
    try {
      const entries = await fsp.readdir(statusDir, { withFileTypes: true });
      const backup = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
        .map((entry) => path.join(statusDir, entry.name))
        .filter((dir) => fs.existsSync(path.join(dir, 'meta.json')))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      if (backup) found = backup;
    } catch {
      /* ignore */
    }
  }
  if (!found) return null;

  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(path.join(found, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
  const files = (await listFiles(found)).filter((rel) => rel !== 'meta.json');
  return {
    action: 'rollback',
    target,
    source: found,
    version: String(meta.fromVersion || ''),
    fromVersion: String(meta.targetVersion || ''),
    files,
    protectedExisting: [],
    locks: files.filter((rel) => !rel.includes('/')),
    backupMeta: meta,
    tempRoot: '',
    backupDir: path.join(statusDir, 'rollback-staging'),
  };
}

/** 清理上一次留下的临时目录（尽力而为，备份目录不动）。 */
async function cleanTemp(tempBase) {
  try {
    const entries = await fsp.readdir(tempBase, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() && entry.name.startsWith('vela-update-') && !entry.name.includes('staging')
        )
        .map((entry) =>
          fsp.rm(path.join(tempBase, entry.name), { recursive: true, force: true }).catch(() => {})
        )
    );
  } catch {
    /* 没有临时目录就算了 */
  }
}

/* ---------------------------------------------------------------- */
/* 增量更新（HDiffPatch 逐文件差分）                                    */
/* ---------------------------------------------------------------- */

/**
 * hpatchz.exe 的真实路径。
 * 打包后它在 resources/app.asar.unpacked/electron/vendor/ 下（asarUnpack 解出来的）；
 * 开发态在 electron/vendor/。asar 虚拟路径能 existsSync 成 true，但拿去 spawn 会被系统
 * 当成「文件不存在」，所以优先取 unpacked 的真实路径。
 */
function hpatchzPath() {
  const dir = __dirname || '';
  const candidates = [];
  if (dir.includes('app.asar')) {
    candidates.push(path.join(dir.replace('app.asar', 'app.asar.unpacked'), 'vendor', 'hpatchz.exe'));
  }
  candidates.push(path.join(dir, 'vendor', 'hpatchz.exe'));
  const root = path.dirname(process.execPath);
  candidates.push(path.join(root, 'resources', 'app.asar.unpacked', 'electron', 'vendor', 'hpatchz.exe'));
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return file;
  }
  return '';
}

function normalizeRel(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

/** 从清单里挑一条「当前版本 -> 目标版本」的增量（版本号忽略前缀 v）。 */
function pickDelta(manifest, fromVersion, toVersion) {
  const from = String(fromVersion || '').trim().replace(/^v/i, '');
  const to = String(toVersion || '').trim().replace(/^v/i, '');
  const list = Array.isArray(manifest && manifest.deltas) ? manifest.deltas : [];
  return (
    list.find(
      (d) =>
        String(d.from || '').replace(/^v/i, '') === from &&
        (!to || String(d.to || '').replace(/^v/i, '') === to)
    ) || null
  );
}

/**
 * 解压增量包 + 逐文件重建出新版本文件，产出一个和 stage() 同构的 staged 对象，
 * 之后原样交给 apply()（备份 + 覆盖 + 重启那条已验证的链路）。
 *
 * 安全约定（任何一条不满足都抛错，让上层退回整包）：
 *   · 每个补丁先核对本地基文件的 size/sha256 与清单一致——对不上说明用户的版本不是
 *     做差分时假设的那一版（或文件被改过），硬套只会产出错误内容；
 *   · 重建结果再核对目标 size/sha256；
 *   · 路径必须是相对、不含 ..、不落在 data/downloads 等受保护目录。
 *
 * @param {object} options
 * @param {string} [options.deltaPath] 已下载的增量 zip（不给则用 options.extractedRoot 里现成的）
 * @param {string} [options.extractedRoot] 事先解压好的临时根（测试用）
 * @param {string} options.tempBase     临时目录根
 * @param {string} options.version      目标版本（清单声明）
 * @param {string} [options.currentVersion] 当前版本（校验增量起点）
 * @param {string} [options.target]     覆盖目标目录（默认 process.execPath 所在目录，测试时可指定）
 */
async function stageDelta({ deltaPath, tempBase, version, currentVersion = '', target, extractedRoot }) {
  const destTarget = target || path.dirname(process.execPath);
  const want = String(version || '').trim().replace(/^v/i, '');
  const from = String(currentVersion || '').trim().replace(/^v/i, '');

  await fsp.mkdir(tempBase, { recursive: true });
  const tempRoot = extractedRoot || (await fsp.mkdtemp(path.join(tempBase, 'vela-delta-')));
  const bundle = path.join(tempRoot, 'delta');
  if (!extractedRoot) await extractZip(deltaPath, bundle);

  let delta;
  try {
    delta = JSON.parse((await fsp.readFile(path.join(bundle, 'delta.json'), 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('增量包缺少 delta.json 或格式损坏');
  }
  if (!delta || Number(delta.format) !== 1) throw new Error('增量包格式版本不认识');
  if (String(delta.from || '').replace(/^v/i, '') !== from) {
    throw new Error(`增量包的起点是 v${delta.from}，和当前 v${from} 不符`);
  }
  if (want && String(delta.to || '').replace(/^v/i, '') !== want) {
    throw new Error(`增量包的终点是 v${delta.to}，和清单 v${want} 不符`);
  }

  const entries = Array.isArray(delta.files) ? delta.files : [];
  if (!entries.length) throw new Error('增量包里没有要重建的文件');

  const hpatchz = hpatchzPath();
  if (!hpatchz) throw new Error('找不到 hpatchz.exe，无法应用增量');

  const source = path.join(tempRoot, 'source');
  await fsp.mkdir(source, { recursive: true });
  const files = [];

  for (const entry of entries) {
    const rel = normalizeRel(entry.path);
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      throw new Error(`增量包里的路径非法：${entry.path}`);
    }
    if (isProtected(rel)) throw new Error(`增量包试图写入受保护目录：${rel}`);
    const destination = path.join(source, rel);
    await fsp.mkdir(path.dirname(destination), { recursive: true });

    if (entry.mode === 'full') {
      const srcFile = path.join(bundle, normalizeRel(entry.src));
      if (!fs.existsSync(srcFile)) throw new Error(`增量包缺少文件：${entry.src}`);
      await fsp.copyFile(srcFile, destination);
    } else if (entry.mode === 'patch') {
      const baseFile = path.join(destTarget, rel);
      if (!fs.existsSync(baseFile)) throw new Error(`本地缺少基准文件，无法打补丁：${rel}`);
      const baseSize = (await fsp.stat(baseFile)).size;
      if (Number(entry.baseSize) && baseSize !== Number(entry.baseSize)) {
        throw new Error(
          `基准文件大小不符：${rel}（本地 ${baseSize} 字节，期望 ${entry.baseSize} 字节）`
        );
      }
      if (entry.baseSha256) {
        const actualBase = await sha256File(baseFile);
        if (actualBase !== String(entry.baseSha256).toLowerCase()) {
          /*
           * 两边都留一段前缀：用户把这个日志发回来，一眼就能看出是「本地被改过」
           * 还是「增量包基准写错了」。差一个字节就得退回整包，这是设计如此，
           * 但要让人知道是哪一步拦下的。
           */
          throw new Error(
            `基准文件校验不符：${rel}（本地 ${actualBase.slice(0, 12)}…，期望 ${String(entry.baseSha256).slice(0, 12)}…）`
          );
        }
      }
      const patchFile = path.join(bundle, normalizeRel(entry.patch));
      if (!fs.existsSync(patchFile)) throw new Error(`增量包缺少补丁：${entry.patch}`);
      const outTmp = `${destination}.rebuilt`;
      await execFileAsync(hpatchz, [baseFile, patchFile, outTmp], {
        windowsHide: true,
        timeout: 5 * 60 * 1000,
      });
      try {
        await fsp.rename(outTmp, destination);
      } catch {
        await fsp.rm(destination, { force: true }).catch(() => {});
        await fsp.rename(outTmp, destination);
      }
    } else {
      throw new Error(`未知的增量模式：${entry.mode}`);
    }

    const stat = await fsp.stat(destination);
    if (Number(entry.size) && stat.size !== Number(entry.size)) {
      throw new Error(`重建文件大小不符：${rel}`);
    }
    if (entry.sha256) {
      const actual = await sha256File(destination);
      if (actual !== String(entry.sha256).toLowerCase()) throw new Error(`重建文件校验不符：${rel}`);
    }
    files.push(rel);
  }

  const hasAsar = files.includes('resources/app.asar');
  const hasAppDir = files.includes('resources/app/electron/main.js');
  if (!hasAsar && !hasAppDir) {
    throw new Error('增量包里既没有 resources/app.asar 也没有 resources/app/electron/main.js，覆盖后启动器会打不开');
  }

  const protectedExisting = new Set();
  try {
    const existing = await listFiles(destTarget);
    for (const rel of existing) if (isProtected(rel)) protectedExisting.add(rel);
  } catch {
    /* 读不到就只做覆盖 */
  }

  const applyJsSource = path.join(source, 'resources', 'updater', 'apply.js');
  const installerSource = path.join(source, 'resources', 'updater', 'HXL-Updater.ps1');
  const selfHealSource = path.join(source, 'resources', 'updater', 'self-heal.ps1');

  return {
    action: 'update',
    tempRoot,
    source,
    target: destTarget,
    version: want || String(delta.to || ''),
    packageVersion: '',
    fromVersion: from,
    hasAsar,
    hasAppDir,
    files,
    removed: Array.isArray(delta.removed) ? delta.removed : [],
    protectedExisting: [...protectedExisting],
    locks: files.filter((rel) => !rel.includes('/')),
    installerSource,
    selfHealSource,
    applyJsSource,
    delta: true,
    deltaFrom: from,
    deltaTo: String(delta.to || ''),
  };
}

module.exports = {
  EXE_NAME,
  parseVersion,
  compareVersions,
  isHttpLocation,
  readManifest,
  resolveManifest,
  checkForUpdate,
  downloadToFile,
  sha256File,
  extractZip,
  findPackageRoot,
  listFiles,
  isProtected,
  stage,
  stageDelta,
  apply,
  buildApplyMeta,
  pickDelta,
  hpatchzPath,
  normalizeRel,
  describeApplyProblem,
  updateStatusDir,
  prepareRollback,
  cleanTemp,
  rankSources,
  accelerateCandidates,
};
