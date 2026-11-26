'use strict';

/**
 * 鸣潮（库洛 / Wuthering Waves）官方「分包(bundle)协议」预下载：检查 / 下载 / 应用。
 *
 * 本模块是**全新独立文件**，与 main.js / kuro-packs.js / seed.js 等完全解耦：
 * 只 require 仓库已有的 `./kuro-packs` 复用下载器与比对器，不修改它、不给它加导出，
 * 也不碰任何 src/views。lead 按文末 module.exports 的 5 个契约接入即可。
 *
 * ── 为什么单独写一份 bundle 协议 ────────────────────────────────────────────
 * 官方 3.0.1.0 起已迁到分包协议。legacy index.json
 * （`{host}/launcher/game/G152/10003_Y8x.../index.json`）里**永远没有**预下载：
 * 它既没有 `default.predownload`，也没有顶层 `predownload`，是给旧客户端的静态快照。
 * 真正的预下载在 bundle game index 的**顶层 `predownload` 槽**（与 `default` 平级）：
 *   {host}/launcher/game/{appId}_{bundleAppKey}/{gameId}/{serverCode}/index.json
 * 顶层 keys = cdnList / resourcePacks / bundles / config / resourcesGray / predownload，
 * `config.predownloadSwitch` 是总开关。不存在独立的 /predownload/index.json 端点，
 * query 参数也无效（实测 33 个候选路径全 404）。
 *
 * ── 三步 ─────────────────────────────────────────────────────────────────────
 *  check    : 读 bundle index → gate → 汇总「下载大小 / 所需空间 / 最终包 / 当前包」
 *  download : 取差量清单 → 复用 kuro-packs.downloadOne 把资源落到**暂存目录**
 *  apply    : 官方切版本后 → 取全量清单走 kuro-packs.planUpdate → 暂存命中搬进游戏目录
 *             → 删 deleteFiles → 重写 launcherDownloadConfig.json → 清暂存
 *
 * ── 关键决策 ─────────────────────────────────────────────────────────────────
 * 1. **为什么暂存**：预下载发生在「新版本还没正式开放」的窗口，此时游戏目录里的
 *    3.7.1 文件仍要能正常启动。绝不能在下载阶段就覆盖/删除游戏目录任何东西，
 *    所以全部落到 `<installRoot>/_kuro_predownload/<targetVersion>/<pack>/`。
 *    断点续传由 downloadOne 的 `.kuro-tmp` + Range 天然支持，本模块只需跳过
 *    size+md5 都已对的文件。
 * 2. **为什么不用 hpatchz**：官方应用是 krpdiff + hpatchz + groupInfos 的增量差分合并，
 *    但差量清单 `resource[].dest` 本来就是「游戏目录相对路径」、`md5` 本来就是
 *    「目标文件 md5」。所以最小实现把 3.8.0 **全量清单**当新 remoteManifest 走一次
 *    planUpdate：游戏目录里没变的旧文件直接 reuse，变了的文件从暂存按 md5 命中后搬入，
 *    等价于「应用」，且完全复用 md5+size 双校验，不必实现 krpdiff 合并。
 *    代价是差量包里的 *.krpdiff / groupInfos 白下载（12.08GiB 中的一小部分），
 *    换来的是实现复杂度最低、最不容易出错。hpatchz 调用参数未在本机反汇编确认，不做。
 * 3. **为什么补斜杠**：差量 `patch.baseUrl` 末尾**没有** `/`
 *    （实测 `.../hd/3.7.1/resources`），纯字符串拼接会粘成 `resources3.7.1_...` → 404；
 *    而全量 `pack.baseUrl` 末尾**带** `/`（`.../zip/`），不归一又会出现 `zip//Client`
 *    双斜杠。更要注意的是 kuro-packs.js:139 的 buildDownloadUrl 会在 middle 与 dest
 *    之间**无条件补一个 /**，它期望 middle 末尾不带斜杠。所以本模块先把 base 剥成
 *    「开头无 /、末尾无 /」再交给它，保证两种来源都恰好一个斜杠。见 joinResourceUrl。
 * 4. **不碰官方元数据**：只读 launcherDownloadConfig.json 拿本地版本；应用阶段只改
 *    它的 bundles[bundle].version，不写 LocalGameResources.json / OriginResource.json
 *    （与 kuro-packs.js 顶部「只读官方元数据」纪律一致）。
 *
 * 事实来源：`_kuro-predownload-report.md`（2026-11-12 实网快照，§2 / §4 / §9）。
 * 所有 UI 可见的失败一律翻成中文 reason，绝不把原始英文异常抛给界面。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

// 只复用现成导出；fetchText 没有导出，本模块自己实现一个最小 HTTPS GET。
const kuroPacks = require('./kuro-packs');
// krpdiff（库洛改过的 DirHDiff）应用器：纯 JS 解析 + 仓库自带 hpatchz。
// 见 kuro-krpdiff.js 文件头 —— 库洛在 headData 里多插了一个 oldRefSizeList。
const krpdiff = require('./kuro-krpdiff');
/*
 * 跨客户端硬链接复用（2026-11-16 用户要求）。
 * 「所有服只要有其中一个更新到最新版，没更新的那个点更新应该能靠硬链接补齐，
 *   缺的再下差异文件」——米哈游（sophon / predownload-hoyo）、终末地、方舟国服
 * 早就接了 link-source；鸣潮这边一直缺，导致官服更完再更国际服又要重下一遍。
 * 判定口径与「本地文件是否已就位」完全一致：size + 整份 md5。
 */
const linkSource = require('./link-source');

// ── 常量 ─────────────────────────────────────────────────────────────────────

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 单次 GET 超时（毫秒）。索引/清单都是百 KB 级，15s 足够；大文件下载走 downloadOne。 */
const GET_TIMEOUT_MS = 15 * 1000;
/** 最大重定向次数。 */
const MAX_REDIRECTS = 5;

const STAGE_DIR_NAME = '_kuro_predownload';
const STATE_FILE_NAME = 'state.json';
const DIFF_MANIFEST_NAME = '_kuro_diff_manifest.json';
const LAUNCHER_CONFIG_NAME = 'launcherDownloadConfig.json';

/**
 * 三服 bundle 协议参数。**只属于本模块**，不要拿去改 kuro-packs.js 的 KURO_PROFILES：
 * 那边是 legacy（appIdKey / indexHost），这边是 bundle（appId + bundleAppKey + serverCode）。
 *
 * 国服实测 URL：
 * https://prod-cn-alicdn-gamestarter.kurogame.com/launcher/game/10003_oLNgHF1CESo51DGHN2odtp40e3oI1HfZ/G152/official/index.json
 *
 * 备用域差异（实网验证）：国服是 `.xyz`，`.net` 国服 404；只有国际服才用 `.net`。
 */
const BUNDLE_PROFILES = {
  official: {
    channel: 'official',
    name: '官服',
    appId: '10003',
    bundleAppKey: 'oLNgHF1CESo51DGHN2odtp40e3oI1HfZ',
    gameId: 'G152',
    serverCode: 'official',
    host: 'https://prod-cn-alicdn-gamestarter.kurogame.com',
    backup: 'https://prod-volcdn-gamestarter.kurogame.xyz', // 国服 .xyz，不是 .net
    defaultBundle: 'HD',
  },
  bilibili: {
    channel: 'bilibili',
    name: 'B服',
    appId: '10004',
    bundleAppKey: 'IY6xmlAusbImBjWrpPj1OwNuirXEO44x',
    gameId: 'G152',
    serverCode: 'bilibili',
    host: 'https://prod-cn-alicdn-gamestarter.kurogame.com',
    backup: 'https://prod-volcdn-gamestarter.kurogame.xyz',
    defaultBundle: 'HD',
  },
  global: {
    channel: 'global',
    name: '国际服',
    appId: '50004',
    bundleAppKey: 'P7xcUZnEr1AXIGON25E6KjpOgTlVrg6e',
    gameId: 'G153',
    serverCode: 'official',
    // 国际服用不带 -cn 的主机：带 -cn 的域名上 G153 全是 404（实网逐条试过）。
    host: 'https://prod-alicdn-gamestarter.kurogame.com',
    backup: 'https://prod-volcdn-gamestarter.kurogame.net', // 国际服才用 .net
    defaultBundle: 'HD',
  },
};

// ── 通用小工具 ───────────────────────────────────────────────────────────────

/** 日志统一前缀，方便在启动器日志里 grep。 */
function warn(...args) {
  console.warn('[kuro-predownload]', ...args);
}

/**
 * 把底层英文异常翻成中文 reason，绝不把原始英文字符串透给 UI。
 * 我们自己抛的都是中文，直接放行；node / TLS 的英文错误按表映射；
 * 兜底给一句通用中文（原始英文只进 warn 日志，不进返回值）。
 */
function toChineseReason(error) {
  const raw = String((error && error.message) || error || '');
  if (!raw) return '未知错误，请稍后重试';
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw;
  const table = [
    [/ENOTFOUND|EAI_AGAIN/i, '域名解析失败，请检查网络或 DNS 设置'],
    [/ECONNREFUSED/i, '连接被拒绝，预下载服务器暂时不可达'],
    [/ECONNRESET|EPIPE|socket hang up/i, '网络连接被重置，请稍后重试'],
    [/ETIMEDOUT|timed out|timeout/i, '请求超时，请稍后重试'],
    [/CERT_|self.signed|self signed|UNABLE_TO_VERIFY|ERR_TLS|DEPTH_ZERO/i,
      'HTTPS 证书校验失败（若本机走本地代理自签证书，需用 --use-system-ca 启动）'],
    [/ENOENT/i, '需要的文件或目录不存在'],
    [/EACCES|EPERM|EBUSY/i, '没有文件读写权限，或文件正被占用'],
    [/EXDEV|cross-device/i, '跨磁盘移动文件失败'],
    [/ENOSPC/i, '磁盘空间不足'],
    [/JSON|Unexpected token|Unexpected end/i, '远端清单不是合法 JSON'],
    [/HTTP 404/i, '远端清单不存在（404）'],
    [/HTTP 403/i, '远端拒绝访问（403）'],
    [/HTTP 5\d\d/i, '预下载服务器暂时出错，请稍后重试'],
    [/redirect/i, '重定向次数过多'],
  ];
  for (const [re, cn] of table) if (re.test(raw)) return cn;
  return '网络请求或本地文件操作失败，请稍后重试';
}

/** 兼容两种取消信号：kuro-packs 用 signal.cancelled，标准 AbortSignal 用 aborted。 */
function isAborted(signal) {
  if (!signal) return false;
  return signal.cancelled === true || signal.aborted === true;
}

/**
 * 点分数字版本比较：a 比 b 新返回 1，相等返回 0，更旧返回 -1。
 * 只按 `.` 切、逐段 parseInt，不引任何依赖（版本形如 3.7.1 / 3.8.0）。
 */
function compareVersion(a, b) {
  const pa = String(a == null ? '' : a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b == null ? '' : b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * checkPredownload 的 gate ③④ 纯判定，单独拎出来方便自测直接验证
 *
 */
function versionGate(targetVersion, localVersion) {
  if (!targetVersion || !localVersion) {
    return { allowed: false, reason: '读不到版本号，无法判断是否需要预下载' };
  }
  const cmp = compareVersion(targetVersion, localVersion);
  if (cmp === 0) {
    return { allowed: false, reason: `本地已是最新版本 ${localVersion}，无需预下载` };
  }
  if (cmp < 0) {
    return { allowed: false, reason: `本地版本 ${localVersion} 已新于预下载目标 ${targetVersion}，无需预下载` };
  }
  return { allowed: true, reason: '' };
}

/**
 * 资源直链拼接（本模块自己的拼接函数）。
 *
 * 把 baseUrl 归一化成「开头无 /、末尾恰好一个 /」再拼 dest：
 *  - 差量 patch.baseUrl 末尾无 `/` → 不能粘成 `resources3.7.1_...`，必须补；
 *  - 全量 pack.baseUrl 末尾带 `/` → 不能出现 `zip//Client` 双斜杠；
 *  - kuro-packs.js:133-141 的 buildDownloadUrl 会在 middle 与 dest 之间**无条件再补一个 /**，
 *    所以这里先把 base 剥成「不带尾斜杠」再交给它，由它补那唯一一个斜杠。
 * 这样既复用现成实现，又对两种来源都产出单斜杠 URL（实测 CDN 对双斜杠虽常容错，但不该依赖）。
 */
function joinResourceUrl(cdnUrl, baseUrl, dest) {
  const cdn = String(cdnUrl == null ? '' : cdnUrl).trim().replace(/\/+$/, '');
  if (!cdn) throw new Error('没有可用的 CDN 域名');
  const middle = String(baseUrl == null ? '' : baseUrl).trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const rel = kuroPacks.normalizeManifestPath(dest);
  if (!rel) throw new Error('清单条目缺少下载路径');
  return kuroPacks.buildDownloadUrl(cdn, middle, rel);
}

/** 进度回调：形状固定为契约要求的 7 个字段，UI 回调自己抛错也不影响主流程。 */
function emit(onProgress, { phase, percent, bytesDone, totalBytes, current, processed, total }) {
  if (typeof onProgress !== 'function') return;
  const pct = Number.isFinite(percent)
    ? percent
    : totalBytes > 0
      ? Math.min(100, Math.round((bytesDone / totalBytes) * 10000) / 100)
      : total > 0
        ? Math.min(100, Math.round((processed / total) * 10000) / 100)
        : 0;
  try {
    onProgress({
      phase,
      percent: Math.max(0, Math.min(100, pct)),
      bytesDone: Number(bytesDone) || 0,
      totalBytes: Number(totalBytes) || 0,
      current: String(current || ''),
      processed: Number(processed) || 0,
      total: Number(total) || 0,
    });
  } catch {
    /* 界面回调异常不该中断下载 */
  }
}

// ── 路径 / 状态 ──────────────────────────────────────────────────────────────

function stageRoot(installRoot) {
  return path.join(String(installRoot || ''), STAGE_DIR_NAME);
}
function statePath(installRoot) {
  return path.join(stageRoot(installRoot), STATE_FILE_NAME);
}
function versionStageDir(installRoot, targetVersion) {
  return path.join(stageRoot(installRoot), String(targetVersion || ''));
}
function packStageDir(installRoot, targetVersion, packName) {
  return path.join(versionStageDir(installRoot, targetVersion), String(packName || ''));
}

/** 读 state.json；不存在 / 损坏都返回 null，绝不抛给上层。 */
async function readState(installRoot) {
  try {
    const text = await fsp.readFile(statePath(installRoot), 'utf8');
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** 事务式写 state.json（tmp → 先删目标 → rename），与 kuro-packs.writeMetadata 同纪律。 */
async function writeState(installRoot, state) {
  const target = statePath(installRoot);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rm(target, { force: true });
  await fsp.rename(tmp, target);
}

function readJsonSafe(filePath) {
  return fsp.readFile(filePath, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);
}

// ── 最小 HTTPS GET（fetchText 未导出，自己实现） ──────────────────────────────

/**
 * node 内置 https/http 的最小 GET：支持 5 次重定向、15s 超时；
 * 判 `content-encoding: gzip` 或 body magic `0x1f 0x8b` 后 zlib.gunzipSync。
 * 返回 { buffer(解压后原文), statusCode, headers }。
 *
 * 库洛的 index.json / indexFile.json 实测发 `Accept-Encoding: identity` 也回 gzip，
 * 不手动解 JSON.parse 会拿到一坨二进制直接炸。
 */
function httpGetRaw(url, { timeoutMs = GET_TIMEOUT_MS, redirects = MAX_REDIRECTS, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(String(url));
    } catch {
      reject(new Error('下载地址格式不正确'));
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      reject(new Error('只支持 HTTP/HTTPS 下载地址'));
      return;
    }
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(
      target,
      {
        method: 'GET',
        headers: {
          Accept: '*/*',
          'User-Agent': USER_AGENT,
          'Accept-Encoding': 'gzip, identity',
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const code = Number(res.statusCode) || 0;
        const location = res.headers && res.headers.location;
        if ([301, 302, 303, 307, 308].includes(code) && location) {
          res.resume();
          if (redirects <= 0) {
            reject(new Error('重定向次数过多'));
            return;
          }
          let next;
          try {
            next = new URL(String(location), target).toString();
          } catch {
            reject(new Error('重定向地址格式不正确'));
            return;
          }
          httpGetRaw(next, { timeoutMs, redirects: redirects - 1, headers }).then(resolve, reject);
          return;
        }
        if (code !== 200 && code !== 206) {
          res.resume();
          reject(new Error(`HTTP ${code}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          let buffer = Buffer.concat(chunks);
          const encoding = String((res.headers && res.headers['content-encoding']) || '').toLowerCase();
          if (encoding.includes('gzip') || (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b)) {
            try {
              buffer = zlib.gunzipSync(buffer);
            } catch {
              // 头说 gzip 但内容不是（少见）——按原文继续试 JSON
            }
          }
          resolve({ buffer, statusCode: code, headers: res.headers });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 取一份清单并校验原文 md5（对**解压后的原文**算，与 kuro-packs.loadManifest 同口径）。
 * CDN 边缘不同步是真实存在的情况：不一致时重拉一次，仍不一致只 warn 后继续用
 * （md5 不匹配不代表清单不可用），与 kuro-packs.js:264-267 的宽容策略一致。
 */
async function fetchManifestJson(url, expectedMd5) {
  const once = async () => {
    const { buffer } = await httpGetRaw(url);
    let json;
    try {
      json = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new Error('清单不是合法 JSON');
    }
    return { json, buffer };
  };
  let { json, buffer } = await once();
  const want = String(expectedMd5 == null ? '' : expectedMd5).trim().toLowerCase();
  if (want) {
    let got = crypto.createHash('md5').update(buffer).digest('hex');
    if (got !== want) {
      warn(`清单 md5 不一致（期望 ${want}，实际 ${got}），重拉一次：${url}`);
      ({ json, buffer } = await once());
      got = crypto.createHash('md5').update(buffer).digest('hex');
      if (got !== want) warn('清单 md5 重拉后仍不一致，按「不校验」继续');
    }
  }
  return json;
}

// ── bundle index ─────────────────────────────────────────────────────────────

/**
 * 主域 → 备用域依次尝试。国际服报告 §2.2 实测主域为不带 `-cn-` 中缀的
 * `https://prod-alicdn-gamestarter.kurogame.com`；本模块 BUNDLE_PROFILES.global.host
 * 按任务给定值保留带 `-cn-` 的形式，这里**追加**实测可达域名作第三兜底，
 * 不改 BUNDLE_PROFILES 本身的字段（那是契约）。
 */
function hostCandidates(profile) {
  const list = [profile.host, profile.backup].filter((h) => typeof h === 'string' && h.trim());
  if (profile.channel === 'global') list.push('https://prod-alicdn-gamestarter.kurogame.com');
  return [...new Set(list.map((h) => String(h).replace(/\/+$/, '')))];
}

/** bundle game index 的 URL 模板。 */
function bundleIndexUrl(host, profile) {
  return `${String(host).replace(/\/+$/, '')}/launcher/game/${profile.appId}_${profile.bundleAppKey}/${profile.gameId}/${profile.serverCode}/index.json`;
}

/** 拉 bundle index，返回原始 body（顶层 predownload 槽就在里面）。 */
async function loadBundleIndex(profile) {
  const hosts = hostCandidates(profile);
  let lastError = null;
  for (const host of hosts) {
    const url = bundleIndexUrl(host, profile);
    try {
      const { buffer } = await httpGetRaw(url);
      let body;
      try {
        body = JSON.parse(buffer.toString('utf8'));
      } catch {
        throw new Error('清单不是合法 JSON');
      }
      if (!body || typeof body !== 'object') throw new Error('bundle index 内容不是对象');
      return { body, host, url };
    } catch (error) {
      lastError = error;
      warn(`bundle index 拉取失败（${host}）：${String((error && error.message) || error)}`);
    }
  }
  throw lastError || new Error('全部域名均无法拉取 bundle index');
}

/** 预下载可以用独立 CDN；空则回退顶层 cdnList[0].url。当前实测两者相同。 */
function pickCdnUrl(body, predownload) {
  const fromPred = predownload && Array.isArray(predownload.cdnList) && predownload.cdnList[0];
  const fromTop = body && Array.isArray(body.cdnList) && body.cdnList[0];
  return String((fromPred && fromPred.url) || (fromTop && fromTop.url) || '').trim();
}

// ── 本地记账（只读） ─────────────────────────────────────────────────────────

/**
 * 官方 `launcherDownloadConfig.json` 全文（实测）：
 * {"appId":"10003","version":"","state":"","bundles":{"HD":{"version":"3.7.1","state":"","resourcePacks":["common","hd"]}}}
 * 顶层 version 为空，版本记在 bundles.HD.version；档位记在 bundles.HD.resourcePacks。
 */
/**
 * 从给定目录往上找库洛官方客户端的「本体根目录」（最多 5 层）。
 *
 * 为什么要往上找：主程序在三层深的 `Client\Binaries\Win64` 下，而
 * `launcherDownloadConfig.json` 只在本体根目录里。启动器记录的行里
 * root 有时被填成了 exe 所在目录（手动选路径、自动扫描都踩过），
 * 只读 root 这一层就会判定「这不是库洛官方客户端」而直接拒绝更新。
 *
 * 用户报障：极致画质（UHD）的鸣潮客户端识别出来后，点「更新游戏」
 * 报「这个目录不是库洛官方客户端」，但游戏其实已经是最新版了 —— 就是这里
 * 只读一层导致的。
 *
 * @param {string} dirOrExe 目录或 exe 路径
 * @returns {string} 找到的本体根目录；找不到返回空串
 */
function findKuroClientRoot(dirOrExe) {
  let dir = String(dirOrExe || '').trim();
  if (!dir) return '';
  if (path.extname(dir).toLowerCase() === '.exe') dir = path.dirname(dir);
  dir = path.normalize(dir);
  for (let depth = 0; depth < 5 && dir; depth += 1) {
    try {
      if (fs.existsSync(path.join(dir, LAUNCHER_CONFIG_NAME))) return dir;
    } catch {
      /* 读不了就当这一层没有 */
    }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return '';
}

async function readLauncherConfig(installRoot) {
  // 先在本体根目录找（认得出就往上走），找不到再按原样读这一层。
  const root = findKuroClientRoot(installRoot);
  const targets = root && root !== String(installRoot) ? [root, String(installRoot)] : [String(installRoot)];
  for (const dir of targets) {
    try {
      const text = await fsp.readFile(path.join(dir, LAUNCHER_CONFIG_NAME), 'utf8');
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object') return obj;
    } catch {
      /* 换下一层 */
    }
  }
  return null;
}

function localVersionOf(config, bundle, override) {
  if (override != null && String(override).trim()) return String(override).trim();
  const b = config && config.bundles && config.bundles[bundle];
  return String((b && b.version) || (config && config.version) || '');
}

function localPacksOf(config, bundle) {
  const b = config && config.bundles && config.bundles[bundle];
  if (b && Array.isArray(b.resourcePacks) && b.resourcePacks.length) {
    return b.resourcePacks.map((p) => String(p));
  }
  return null;
}

/**
 * 认出本机客户端装的是哪一档画质包（HD / SD / UHD）。
 *
 * 官方 launcherDownloadConfig.json 的 bundles 只记「这一份客户端实际装的档位」，
 * 正常只有一条（HD 或 SD 或 UHD）。我们以前硬编码 HD，装了 SD/UHD 的机器会被
 * 拉 HD 的清单去比对 —— 那就等于按另一个画质包重下整份游戏。
 *
 * 选法：优先 hasVersion 的档位（version 非空 ＝ 真装过），同分按 HD → SD → UHD
 * 的固定顺序（官方默认 HD）。一条都没有就回退调用方给的默认值。
 */
function localBundleOf(config, fallback) {
  const bundles = (config && config.bundles) || null;
  const def = String(fallback || 'HD');
  if (!bundles || typeof bundles !== 'object') return def;
  const known = ['HD', 'SD', 'UHD'];
  const keys = known.filter((name) => bundles[name] && typeof bundles[name] === 'object');
  if (!keys.length) return def;
  // 先看有没有记着版本号的（＝真装过这一档）
  const withVersion = keys.filter((name) => String((bundles[name] && bundles[name].version) || '').trim());
  const pool = withVersion.length ? withVersion : keys;
  if (pool.includes(def)) return def;
  return pool[0];
}

// ── ① 检查 ──────────────────────────────────────────────────────────────────

const EMPTY_CHECK = {
  ok: true,
  available: false,
  targetVersion: '',
  downloadSize: 0,
  requiredSpace: 0,
  finalSize: 0,
  currentSize: 0,
  packs: [],
  reason: '',
  // 官方撤掉 predownload 槽时把「线上正式版本 / 本地版本」带出去，
  // 让 predownload.js kuroReport 能点亮「更新游戏」。
  liveVersion: '',
  localVersion: '',
};

/**
 * 检查是否有可预下载的新版本包，以及弹窗要展示的四个数。
 *
 * gate（缺一即 available:false，绝不抛）：
 *  ① config.predownloadSwitch === 1
 *  ② 顶层 predownload 存在且 predownload.bundles[defaultBundle].resourcePacks 非空
 *  ③ 目标版本 > 本地版本（点分数字比较）
 *  ④ 本地已是最新则不预下载
 *
 * 数字口径（HD = common + hd）：
 *  downloadSize  = Σ patchConfig[localVersion].size        → 12.08 GiB「下载文件大小」
 *  requiredSpace = downloadSize + max(patch.ext.maxFileSize) → 13.48 GiB「所需空间」
 *  finalSize     = Σ predownload.resourcePacks[pack].size  → 82.32 GiB「最终约」
 *  currentSize   = Σ live.resourcePacks[pack].size         → 80.52 GiB「当前」
 */
async function checkPredownload({ channel, installRoot, localVersion } = {}) {
  try {
    // 缺省按国服（启动器默认渠道）；显式给了不认识的渠道也要给中文 reason，不抛。
    const key = String(channel || 'official');
    const profile = Object.prototype.hasOwnProperty.call(BUNDLE_PROFILES, key) ? BUNDLE_PROFILES[key] : null;
    if (!profile) {
      return { ...EMPTY_CHECK, reason: `没有对应的鸣潮渠道配置（${key}）` };
    }

    let body;
    try {
      ({ body } = await loadBundleIndex(profile));
    } catch (error) {
      warn('检查预下载时拉取 bundle index 失败：', String((error && error.message) || error));
      return { ...EMPTY_CHECK, reason: `检查预下载失败：${toChineseReason(error)}` };
    }

    // ① 总开关
    const switchValue = Number(body && body.config && body.config.predownloadSwitch);
    if (switchValue !== 1) {
      return { ...EMPTY_CHECK, reason: `官方预下载开关未开启（predownloadSwitch=${switchValue || 0}）` };
    }

    // ② 顶层 predownload 槽 + 本机档位对应的包列表
    const pred = body && body.predownload;
    const bundle = String(profile.defaultBundle || 'HD');
    const bundleDef = pred && pred.bundles && pred.bundles[bundle];
    const predPackNames = bundleDef && Array.isArray(bundleDef.resourcePacks) ? bundleDef.resourcePacks : null;
    if (!pred || !pred.resourcePacks || !predPackNames || !predPackNames.length) {
      // 官方把 predownload 槽撤成 null，通常就是新版本已经从「预下载」转「正式更新」
      // （实测 2026-11-12：predownload=null，resourcePacks.*.version 全是 3.8.0，
      //  而本机还停在 3.7.1）。除了给中文提示，还要把线上/本地版本带出去，
      //  让上层点亮「更新游戏」徽标。
      const live = body && body.resourcePacks;
      const liveVersion = live
        ? String((live.common || Object.values(live)[0] || {}).version || '')
        : '';
      const cfgEarly = await readLauncherConfig(installRoot);
      const localV = localVersionOf(cfgEarly, bundle, localVersion);
      return {
        ...EMPTY_CHECK,
        liveVersion,
        localVersion: localV,
        reason: liveVersion
          ? `官方未挂预下载包（线上已是 ${liveVersion}），请直接点「更新游戏」`
          : '官方暂未放出预下载资源包',
      };
    }

    // 本机档位优先按 launcherDownloadConfig.json 读（用户可能装的是 SD/UHD，不能硬编码 HD）
    const cfg = await readLauncherConfig(installRoot);
    const localPacks = localPacksOf(cfg, bundle) || predPackNames.map((p) => String(p));
    const packNames = localPacks.filter((name) => pred.resourcePacks[name]);
    if (!packNames.length) {
      return { ...EMPTY_CHECK, reason: '本机档位对应的预下载资源包不存在' };
    }

    const firstPack = pred.resourcePacks[packNames[0]] || {};
    const targetVersion = String(firstPack.version || '');
    if (!targetVersion) {
      return { ...EMPTY_CHECK, reason: '预下载包缺少目标版本号' };
    }

    const currentVersion = localVersionOf(cfg, bundle, localVersion);
    if (!currentVersion) {
      return {
        ...EMPTY_CHECK,
        targetVersion,
        reason: '读不到本地游戏版本（launcherDownloadConfig.json 不存在或不是合法 JSON）',
      };
    }

    // ③④ 版本比较
    const gate = versionGate(targetVersion, currentVersion);
    if (!gate.allowed) {
      return { ...EMPTY_CHECK, targetVersion, reason: gate.reason };
    }

    // 汇总四个数 + 每个包的清单信息（供下载/应用阶段使用）
    let downloadSize = 0;
    let finalSize = 0;
    let currentSize = 0;
    let maxFileSize = 0;
    const packs = [];
    for (const name of packNames) {
      const pack = pred.resourcePacks[name] || {};
      const patchList = Array.isArray(pack.patchConfig) ? pack.patchConfig : [];
      // 挑「从本地版本升级」的差量；找不到就退化为用该包的全量清单（报告 §9.2）
      const patch = patchList.find((p) => p && String(p.version) === currentVersion) || null;
      const patchSize = Number((patch && patch.size) || pack.size || 0) || 0;
      const indexFile = String((patch && patch.indexFile) || pack.indexFile || '');
      const indexFileMd5 = String((patch && patch.indexFileMd5) || pack.indexFileMd5 || '').toLowerCase();
      const fullIndexFile = String(pack.indexFile || '');
      const extMax = Number(patch && patch.ext && patch.ext.maxFileSize) || 0;
      if (extMax > maxFileSize) maxFileSize = extMax;
      downloadSize += patchSize;
      finalSize += Number(pack.size || 0) || 0;
      const live = body && body.resourcePacks && body.resourcePacks[name];
      currentSize += Number(live && live.size) || 0;
      packs.push({ name, patchSize, indexFile, indexFileMd5, fullIndexFile });
    }

    return {
      ok: true,
      available: true,
      targetVersion,
      downloadSize,
      requiredSpace: downloadSize + maxFileSize,
      finalSize,
      currentSize,
      packs,
      reason: '',
    };
  } catch (error) {
    // 兜底：任何意外都翻成中文，绝不把英文异常抛给 UI
    warn('检查预下载出现未预期错误：', String((error && error.message) || error));
    return {
      ...EMPTY_CHECK,
      reason: `检查预下载失败：${toChineseReason(error)}`,
    };
  }
}

// ── ② 下载 ──────────────────────────────────────────────────────────────────

/**
 * 把差量清单列出的资源下载到暂存目录。
 *
 * ★ 绝不直接写游戏目录：全部落到
 *   <installRoot>/_kuro_predownload/<targetVersion>/<pack>/<f.dest>
 * 状态写 <installRoot>/_kuro_predownload/state.json，另把差量清单原文缓存成
 * <pack>/_kuro_diff_manifest.json（应用阶段要读它的 deleteFiles[]）。
 * 断点续传由 downloadOne 的 .kuro-tmp + Range 天然支持；本模块额外跳过
 * size+md5 都已对的文件，省一次全文件 md5。
 */
async function downloadPredownload({ channel, installRoot, signal, onProgress, linkSources = [] } = {}) {
  const result = { ok: false, stageDir: '', downloadedFiles: 0, bytes: 0, reason: '' };
  try {
    const key = String(channel || 'official');
    const profile = Object.prototype.hasOwnProperty.call(BUNDLE_PROFILES, key) ? BUNDLE_PROFILES[key] : null;
    if (!profile) {
      result.reason = `没有对应的鸣潮渠道配置（${key}）`;
      return result;
    }

    emit(onProgress, { phase: 'check', bytesDone: 0, totalBytes: 0, current: '', processed: 0, total: 0 });
    const info = await checkPredownload({ channel: key, installRoot });
    if (!info || !info.ok || !info.available) {
      result.reason = `无需下载预下载包：${(info && info.reason) || '检查未通过'}`;
      return result;
    }

    const targetVersion = String(info.targetVersion);
    const bundle = String(profile.defaultBundle || 'HD');
    const stageDir = versionStageDir(installRoot, targetVersion);
    result.stageDir = stageDir;

    // 重新拉一次 index：下载可能距 check 很久，要校验目标版本没变、并拿 patch.baseUrl。
    let body;
    try {
      ({ body } = await loadBundleIndex(profile));
    } catch (error) {
      warn('下载阶段拉取 bundle index 失败：', String((error && error.message) || error));
      result.reason = `下载预下载包失败：${toChineseReason(error)}`;
      return result;
    }
    const pred = body && body.predownload;
    const onlineTarget = String(
      (pred && pred.resourcePacks && pred.resourcePacks[info.packs[0] && info.packs[0].name] &&
        pred.resourcePacks[info.packs[0].name].version) || ''
    );
    if (onlineTarget && onlineTarget !== targetVersion) {
      result.reason = `预下载目标版本已变化（${targetVersion} → ${onlineTarget}），请重新检查`;
      return result;
    }

    const cfg = await readLauncherConfig(installRoot);
    const localVersion = localVersionOf(cfg, bundle, null);
    if (!localVersion) {
      result.reason = '读不到本地游戏版本，无法确定该用哪份差量清单';
      return result;
    }
    const cdnUrl = pickCdnUrl(body, pred);
    if (!cdnUrl) {
      result.reason = 'bundle index 里没有可用的 CDN 域名';
      return result;
    }

    // 先统计总文件数 / 总字节，供进度分母（分母用 Σ patch.size，与弹窗 12.08 GiB 一致）
    const jobs = [];
    const deleteSet = new Set();
    const statePacks = [];
    let totalBytes = Number(info.downloadSize) || 0;

    emit(onProgress, { phase: 'manifest', bytesDone: 0, totalBytes, current: '', processed: 0, total: 0 });
    for (const item of info.packs) {
      const name = String(item.name);
      const packDir = packStageDir(installRoot, targetVersion, name);
      await fsp.mkdir(packDir, { recursive: true });

      const packDef = (pred && pred.resourcePacks && pred.resourcePacks[name]) || {};
      const patch = (Array.isArray(packDef.patchConfig) ? packDef.patchConfig : [])
        .find((p) => p && String(p.version) === localVersion) || null;
      const diffIndexFile = String(item.indexFile || (patch && patch.indexFile) || '');
      if (!diffIndexFile) {
        warn(`包 ${name} 没有可用的差量清单，跳过`);
        continue;
      }

      // 清单 URL：middle 为空，直接复用 buildDownloadUrl（此时它不会插多余斜杠）
      const diffUrl = kuroPacks.buildDownloadUrl(cdnUrl, '', diffIndexFile);
      let diffJson;
      try {
        diffJson = await fetchManifestJson(diffUrl, item.indexFileMd5);
      } catch (error) {
        warn(`包 ${name} 差量清单拉取失败：`, String((error && error.message) || error));
        result.reason = `下载预下载包失败：${toChineseReason(error)}`;
        return result;
      }
      // 缓存差量清单原文，应用阶段读 deleteFiles[]
      await fsp.writeFile(
        path.join(packDir, DIFF_MANIFEST_NAME),
        JSON.stringify(diffJson),
        'utf8'
      );
      for (const d of (Array.isArray(diffJson.deleteFiles) ? diffJson.deleteFiles : [])) {
        const rel = kuroPacks.normalizeManifestPath(d);
        if (rel) deleteSet.add(rel);
      }

      const resources = Array.isArray(diffJson.resource) ? diffJson.resource : [];
      // fromFolder 优先于 patch.baseUrl（Arietta GameUpdateDownloader.cs:137-139）
      const fallbackBase = String((patch && patch.baseUrl) || packDef.baseUrl || '');
      for (const f of resources) {
        if (!f || typeof f !== 'object') continue;
        const rel = kuroPacks.normalizeManifestPath(f.dest);
        if (!rel) continue;
        jobs.push({
          packName: name,
          rel,
          size: Number(f.size) || 0,
          hash: String(f.md5 == null ? '' : f.md5).toLowerCase(),
          url: joinResourceUrl(cdnUrl, String(f.fromFolder || fallbackBase || ''), rel),
          dest: kuroPacks.resolveInside(packDir, rel),
        });
      }
      statePacks.push({
        name,
        patchSize: Number(item.patchSize) || 0,
        indexFile: diffIndexFile,
        indexFileMd5: String(item.indexFileMd5 || ''),
        fullIndexFile: String(item.fullIndexFile || (packDef && packDef.indexFile) || ''),
        fullIndexFileMd5: String((packDef && packDef.indexFileMd5) || '').toLowerCase(),
        baseUrl: fallbackBase,
        diffCache: path.join(packDir, DIFF_MANIFEST_NAME),
      });
    }

    if (!jobs.length) {
      result.reason = '差量清单里没有需要下载的资源文件';
      return result;
    }
    const total = jobs.length;
    let processed = 0;
    let bytesDone = 0;
    let downloadedFiles = 0;

    for (const job of jobs) {
      if (isAborted(signal)) {
        result.downloadedFiles = downloadedFiles;
        result.bytes = bytesDone;
        result.reason = '下载已取消';
        return result;
      }

      // 跳过已完成文件：size 对且 md5 对（断点续传）
      const st = await fsp.stat(job.dest).catch(() => null);
      if (st && st.isFile() && (job.size === 0 || st.size === job.size)) {
        let ok = !job.hash;
        if (!ok) {
          const got = await kuroPacks.md5File(job.dest, { signal }).catch(() => null);
          ok = got === job.hash;
        }
        if (ok) {
          bytesDone += job.size;
          processed += 1;
          emit(onProgress, {
            phase: 'download', bytesDone, totalBytes,
            current: path.basename(job.rel), processed, total,
          });
          continue;
        }
      }

      /*
       * 跨服复用：别的服已经预下载过同一个差量文件，直接硬链接过来。
       *
       * 暂存目录结构是 _kuro_predownload/<目标版本>/<包名>/<rel>，两边的
       * 版本、包名、相对路径都必须一致才会撞上同一个 dest —— 而这三个恰好
       * 都是官方清单里的字段，不同渠道只要下的是同一份资源就是同名同内容。
       * 判定口径和上面断点续传那段完全一致（size + md5），不能放宽。
       */
      if (linkSources.length && job.hash) {
        const grabbed = await linkSource.reuseNamedFile({
          target: job.dest,
          roots: linkSources,
          subdir: `${targetVersion}/${job.packName}`,
          name: job.rel,
          match: async (candidate) => {
            try {
              const info2 = await fsp.stat(candidate);
              if (!info2.isFile()) return false;
              if (job.size && info2.size !== job.size) return false;
              const got = await kuroPacks.md5File(candidate, { signal }).catch(() => null);
              return got === job.hash;
            } catch {
              return false;
            }
          },
        });
        if (grabbed.ok) {
          bytesDone += job.size;
          processed += 1;
          emit(onProgress, {
            phase: 'download', bytesDone, totalBytes,
            current: path.basename(job.rel), processed, total,
          });
          continue;
        }
      }

      try {
        // 断点续传由 downloadOne 的 .kuro-tmp + Range 天然支持；这里不依赖它的
        // onProgress（只在真正发起 GET 时才触发），成功后自己累加，保证每个文件恰好计一次。
        await kuroPacks.downloadOne({
          url: job.url,
          dest: job.dest,
          expectedSize: job.size,
          expectedHash: job.hash,
          signal,
        });
      } catch (error) {
        warn(`文件下载失败（${job.rel}）：`, String((error && error.message) || error));
        result.downloadedFiles = downloadedFiles;
        result.bytes = bytesDone;
        result.reason = `下载预下载包失败：${toChineseReason(error)}`;
        return result;
      }
      bytesDone += job.size;
      downloadedFiles += 1;
      processed += 1;
      emit(onProgress, {
        phase: 'download', bytesDone, totalBytes,
        current: path.basename(job.rel), processed, total,
      });
    }

    // 写 state.json：契约字段 targetVersion/bundle/packs/patchIndexFile/indexFileMd5/completed 全带上
    const first = statePacks[0] || {};
    await writeState(installRoot, {
      targetVersion,
      bundle,
      channel: key,
      packs: statePacks,
      patchIndexFile: String(first.indexFile || ''),
      indexFileMd5: String(first.indexFileMd5 || ''),
      cdnUrl,
      localVersion,
      deleteFiles: [...deleteSet],
      completed: true,
      applied: false,
      downloadedFiles,
      bytes: bytesDone,
      createdAt: new Date().toISOString(),
    }).catch((error) => {
      warn('写 state.json 失败：', String((error && error.message) || error));
    });

    emit(onProgress, {
      phase: 'done', bytesDone, totalBytes,
      current: '', processed, total,
    });
    result.ok = true;
    result.downloadedFiles = downloadedFiles;
    result.bytes = bytesDone;
    result.reason = '';
    return result;
  } catch (error) {
    warn('下载预下载包出现未预期错误：', String((error && error.message) || error));
    result.reason = `下载预下载包失败：${toChineseReason(error)}`;
    return result;
  }
}

// ── ③ 应用 ──────────────────────────────────────────────────────────────────

/**
 * Windows 下把暂存文件搬进游戏目录：先删目标再 rename（断硬链接的正确写法），
 * 跨磁盘 rename 会 EXDEV，回退 copyFile（暂存稍后由 clearPredownload 统一清）。
 */
async function moveIntoGame(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rm(dst, { force: true });
  try {
    await fsp.rename(src, dst);
  } catch (error) {
    const code = String((error && error.code) || '').toUpperCase();
    if (code === 'EXDEV' || /cross-device/i.test(String((error && error.message) || ''))) {
      await fsp.copyFile(src, dst);
      return;
    }
    throw error;
  }
}

/** 把 indexFile.json 的 resource[] 转成 planUpdate 要的 {files:[{path,hash,size}]}。 */
function toRemoteManifest(json) {
  const files = [];
  for (const item of (json && Array.isArray(json.resource) ? json.resource : [])) {
    if (!item || typeof item !== 'object') continue;
    const p = kuroPacks.normalizeManifestPath(item.dest);
    if (!p) continue;
    files.push({
      path: p,
      hash: String(item.md5 == null ? '' : item.md5).toLowerCase(),
      size: Number(item.size) || 0,
    });
  }
  return { files };
}

/**
 * 官方正式切到新版本后，把暂存里的目标文件应用进游戏目录。
 *
 * 流程：读 state.json → 校验线上 live 版本已切到 targetVersion → 取 3.8.0 全量清单
 * → kuro-packs.planUpdate 比对（fullVerify，hash 判定交给调用方实算 md5）
 * → 游戏目录里 md5 已对的旧文件 reuse、暂存里 md5 命中的目标文件搬入
 * → 删差量清单 deleteFiles[] → 重写 launcherDownloadConfig.json 的 bundles[bundle].version
 * → 写 state 完成标记 → 清暂存。
 *
 * **不实现 krpdiff / hpatchz 合并**：见文件头「关键决策 2」。
 * 线上版本还没切（仍是 3.7.1）时返回 applied:0 + 中文 reason，不报错、不动暂存。
 */
async function applyPredownload({ channel, installRoot, signal, onProgress } = {}) {
  const result = { ok: true, applied: 0, reused: 0, deleted: 0, reason: '' };
  try {
    const state = await readState(installRoot);
    if (!state) {
      result.reason = '没有找到预下载暂存记录（state.json 不存在或不是合法 JSON）';
      return result;
    }
    const targetVersion = String(state.targetVersion || '');
    if (!targetVersion) {
      result.reason = '暂存记录缺少目标版本号';
      return result;
    }
    if (!state.completed) {
      result.reason = '预下载尚未下载完成，暂不应用';
      return result;
    }
    if (state.applied) {
      result.reason = '这批预下载已经应用过了';
      return result;
    }

    const key = String(channel || state.channel || 'official');
    const profile = Object.prototype.hasOwnProperty.call(BUNDLE_PROFILES, key) ? BUNDLE_PROFILES[key] : null;
    if (!profile) {
      result.reason = `没有对应的鸣潮渠道配置（${key}）`;
      return result;
    }
    const bundle = String(state.bundle || profile.defaultBundle || 'HD');
    const statePacks = Array.isArray(state.packs) ? state.packs : [];
    if (!statePacks.length) {
      result.reason = '暂存记录里没有资源包明细';
      return result;
    }
    const packNames = statePacks.map((p) => String((p && p.name) || '')).filter(Boolean);

    let body;
    try {
      ({ body } = await loadBundleIndex(profile));
    } catch (error) {
      warn('应用阶段拉取 bundle index 失败：', String((error && error.message) || error));
      result.reason = `应用预下载失败：${toChineseReason(error)}`;
      return result;
    }

    // 线上正式版本看顶层 resourcePacks[pack0].version（当前 3.7.1；切版后变 3.8.0）
    const firstLive = (body && body.resourcePacks && body.resourcePacks[packNames[0]]) || {};
    const liveVersion = String(firstLive.version || (body && body.config && body.config.version) || '');
    if (!liveVersion || liveVersion !== targetVersion) {
      if (liveVersion && compareVersion(liveVersion, targetVersion) > 0) {
        result.reason = '线上已更新到更新版本，这批预下载包已过期，请清除后重新预下载';
      } else {
        result.reason = '新版本还没正式开放，预下载包先留着';
      }
      return result;
    }

    const pred = body && body.predownload;
    const cdnUrl = pickCdnUrl(body, pred) || String(state.cdnUrl || '');
    if (!cdnUrl) {
      result.reason = '没有可用的 CDN 域名，无法读取全量清单';
      return result;
    }
    const stageVersionDir = versionStageDir(installRoot, targetVersion);
    const stagePackDirs = packNames.map((name) => path.join(stageVersionDir, name));

    // ① 取每个包的 3.8.0 全量清单，汇成一份 remoteManifest
    emit(onProgress, { phase: 'manifest', bytesDone: 0, totalBytes: 0, current: '', processed: 0, total: 0 });
    const remoteFiles = [];
    const deleteSet = new Set();
    for (const def of (Array.isArray(state.deleteFiles) ? state.deleteFiles : [])) {
      const rel = kuroPacks.normalizeManifestPath(def);
      if (rel) deleteSet.add(rel);
    }

    for (const item of statePacks) {
      const name = String((item && item.name) || '');
      if (!name) continue;
      const onlinePack = pred && pred.resourcePacks && pred.resourcePacks[name];
      // 版本切换后官方可能清空 predownload 槽，所以优先线上、回退 state 里缓存的 fullIndexFile
      const fullIndexFile = String((onlinePack && onlinePack.indexFile) || item.fullIndexFile || '');
      if (!fullIndexFile) {
        warn(`包 ${name} 拿不到全量清单路径，跳过该包`);
        continue;
      }
      const indexInfo = {
        cdnUrl,
        indexFile: fullIndexFile,
        indexFileMd5: String((onlinePack && onlinePack.indexFileMd5) || item.fullIndexFileMd5 || '').toLowerCase(),
        baseUrl: '',
        version: targetVersion,
      };
      let manifest = null;
      try {
        // 复用 kuro-packs.loadManifest（含 indexFileMd5 原文校验）
        const kuroProfile = kuroPacks.KURO_PROFILES && kuroPacks.KURO_PROFILES[key];
        manifest = await kuroPacks.loadManifest(kuroProfile || key, indexInfo, { verifyMd5: true });
      } catch (error) {
        warn(`包 ${name} loadManifest 失败，改用内置 GET 解析：`, String((error && error.message) || error));
      }
      if (!manifest) {
        try {
          const json = await fetchManifestJson(
            kuroPacks.buildDownloadUrl(cdnUrl, '', fullIndexFile),
            indexInfo.indexFileMd5
          );
          manifest = toRemoteManifest(json);
        } catch (error) {
          warn(`包 ${name} 全量清单拉取失败：`, String((error && error.message) || error));
          result.reason = `应用预下载失败：${toChineseReason(error)}`;
          return result;
        }
      }
      for (const f of (manifest.files || [])) remoteFiles.push(f);

      // deleteFiles 也可能来自缓存的差量清单（state 里没有时的兜底）
      const diff = await readJsonSafe(String(item.diffCache || ''));
      for (const d of (diff && Array.isArray(diff.deleteFiles) ? diff.deleteFiles : [])) {
        const rel = kuroPacks.normalizeManifestPath(d);
        if (rel) deleteSet.add(rel);
      }
    }

    if (!remoteFiles.length) {
      result.reason = '全量清单为空，无法应用预下载';
      return result;
    }

    // ② 走现有 planUpdate 比对（fullVerify：hash 判定交给我们下面实算 md5）
    const localManifest = (await kuroPacks.readManifest(installRoot)) || { files: [] };
    let plan = null;
    try {
      plan = kuroPacks.planUpdate({
        installRoot,
        remoteManifest: { files: remoteFiles },
        localManifest,
        fullVerify: true,
        localExists: (rel) => {
          const r = kuroPacks.normalizeManifestPath(rel);
          if (!r) return { exists: false, size: null };
          try {
            const st = fs.statSync(kuroPacks.resolveInside(installRoot, r));
            if (st.isFile()) return { exists: true, size: st.size };
          } catch { /* 继续查暂存 */ }
          for (const dir of stagePackDirs) {
            try {
              const st = fs.statSync(kuroPacks.resolveInside(dir, r));
              if (st.isFile()) return { exists: true, size: st.size };
            } catch { /* 下一个包 */ }
          }
          return { exists: false, size: null };
        },
        cdnUrl,
        baseUrl: '',
      });
    } catch (error) {
      // planUpdate 是纯比对，失败不该阻断应用；记日志后继续用自己的实算路径
      warn('planUpdate 比对失败，改用逐文件实算 md5：', String((error && error.message) || error));
    }
    if (plan) {
      warn(
        `planUpdate 结果：download=${plan.download.length} reuse=${plan.reuse.length} ` +
        `needsVerify=${plan.needsVerify} delete=${plan.delete.length}`
      );
      // 注意：删除以差量清单 deleteFiles[] 为准，不直接用 plan.delete
      // （花筱灵自己的 kuro-manifest.json 可能不全，按官方 deleteFiles 删最安全）。
    }

    // ③ 逐文件：游戏目录已对 → reuse；暂存命中 → 搬入；都没有 → 记缺失交给普通更新补齐
    const total = remoteFiles.length;
    const totalBytes = remoteFiles.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    let processed = 0;
    let movedBytes = 0;
    let applied = 0;
    let reused = 0;
    let missing = 0;

    for (const f of remoteFiles) {
      if (isAborted(signal)) {
        result.applied = applied;
        result.reused = reused;
        result.reason = '应用已取消';
        return result;
      }
      const rel = kuroPacks.normalizeManifestPath(f.path);
      const want = String(f.hash || '').toLowerCase();
      let gameAbs;
      try {
        gameAbs = kuroPacks.resolveInside(installRoot, rel);
      } catch {
        warn(`跳过路径越界的清单项：${rel}`);
        processed += 1;
        continue;
      }

      // 游戏目录里没变的旧文件：md5 一致，直接复用（deltaSize 仅 0.90GiB，绝大多数走这里）
      const gStat = await fsp.stat(gameAbs).catch(() => null);
      if (gStat && gStat.isFile() && (Number(f.size) || 0) === gStat.size) {
        let same = !want;
        if (!same) {
          const got = await kuroPacks.md5File(gameAbs, { signal }).catch(() => null);
          same = got === want;
        }
        if (same) {
          reused += 1;
          movedBytes += Number(f.size) || 0;
          processed += 1;
          emit(onProgress, {
            phase: 'apply', bytesDone: movedBytes, totalBytes,
            current: path.basename(rel), processed, total,
          });
          continue;
        }
      }

      // 暂存命中：size+md5 都对才搬，避免把 *.krpdiff 之类的中间文件当成目标文件
      let moved = false;
      for (const dir of stagePackDirs) {
        let stageAbs;
        try {
          stageAbs = kuroPacks.resolveInside(dir, rel);
        } catch {
          continue;
        }
        const sStat = await fsp.stat(stageAbs).catch(() => null);
        if (!sStat || !sStat.isFile()) continue;
        if (Number(f.size) > 0 && sStat.size !== Number(f.size)) continue;
        if (want) {
          const got = await kuroPacks.md5File(stageAbs, { signal }).catch(() => null);
          if (got !== want) continue;
        }
        try {
          await moveIntoGame(stageAbs, gameAbs);
          moved = true;
        } catch (error) {
          warn(`搬运失败（${rel}）：`, String((error && error.message) || error));
        }
        break;
      }
      if (moved) {
        applied += 1;
        movedBytes += Number(f.size) || 0;
      } else {
        missing += 1;
      }
      processed += 1;
      emit(onProgress, {
        phase: 'apply', bytesDone: movedBytes, totalBytes,
        current: path.basename(rel), processed, total,
      });
    }

    // ④ 按差量清单 deleteFiles[] 删旧文件（只删清单明确列出的，绝不扫盘）
    let deleted = 0;
    for (const rel of deleteSet) {
      let abs;
      try {
        abs = kuroPacks.resolveInside(installRoot, rel);
      } catch {
        continue;
      }
      try {
        await fsp.rm(abs, { force: true });
        deleted += 1;
      } catch (error) {
        warn(`删除旧文件失败（${rel}）：`, String((error && error.message) || error));
      }
    }

    // ⑤ 重写记账：launcherDownloadConfig.json 的版本（含顶层 version / bundles[bundle].version
    //    与 launcherDownloadConfig/<pack>.json），走 kuro-packs 的同一实现，
    //    保证「预下载应用」与「真升级」写出来的记账字段完全一致（否则游戏/官方启动器
    //    读到分档文件的旧版本号，会当文件损坏重新校验）。
    //    事务式 tmp + 先删后 rename；不碰 LocalGameResources.json 等官方其它字段。
    const packedNames = statePacks.map((p) => String((p && p.name) || '')).filter(Boolean);
    await kuroPacks.writeLauncherConfig({
      installRoot: String(installRoot),
      channel,
      bundle,
      version: targetVersion,
      packs: packedNames.length ? packedNames : ['common', 'hd'],
    });

    // ⑥ 写 state 完成标记
    await writeState(installRoot, {
      ...state,
      applied: true,
      appliedAt: new Date().toISOString(),
      appliedFiles: applied,
      reusedFiles: reused,
      deletedFiles: deleted,
      missingFiles: missing,
    }).catch((error) => {
      warn('写 state 完成标记失败：', String((error && error.message) || error));
    });

    result.applied = applied;
    result.reused = reused;
    result.deleted = deleted;

    // ⑦ 清暂存：全部命中才清；有缺失说明用户可能换了档位，保留暂存让普通更新流程补齐
    if (missing === 0) {
      await clearPredownload(installRoot);
      result.reason = '';
    } else {
      result.reason = `已应用 ${applied} 个文件、复用 ${reused} 个；另有 ${missing} 个文件暂存里没有，需走普通更新补齐，暂存暂保留`;
    }
    emit(onProgress, {
      phase: 'done', bytesDone: movedBytes, totalBytes,
      current: '', processed, total,
    });
    return result;
  } catch (error) {
    warn('应用预下载出现未预期错误：', String((error && error.message) || error));
    result.reason = `应用预下载失败：${toChineseReason(error)}`;
    return result;
  }
}

// ── 清暂存 ──────────────────────────────────────────────────────────────────

/** 清掉 <installRoot>/_kuro_predownload/ 整个目录（含 state.json）。 */
async function clearPredownload(installRoot) {
  const root = stageRoot(installRoot);
  try {
    await fsp.rm(root, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    warn('清理暂存目录失败：', String((error && error.message) || error));
    return { ok: false, reason: `清理暂存目录失败：${toChineseReason(error)}` };
  }
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

// ── 真升级：把官方 bundle 全量清单逐文件刷成最新正式版 ─────────────────────────

/**
 * 官方 3.0.1.0 起改用 bundle 分包协议：正式版清单在
 *   resourcePacks[pack].indexFile（相对 CDN 主机根，不相对 index.json 目录），
 * 每个文件 URL = {cdnHost}/{resourcePacks[pack].baseUrl}/{dest}。
 *
 * 与「应用预下载」的差别：这里不依赖 _kuro_predownload 暂存，也不实现
 * krpdiff / hpatchz（组差分参数未确认）；直接拿目标版本全量清单，逐文件
 * size+md5 比对，只把「变了 / 缺了」的文件下载到游戏目录，然后删官方
 * 差量清单明确列出的旧文件，最后事务式重写本地版本记账。
 *
 * 这样升级一次的实际下载量只有变化的文件（官方 deltaSize 约 0.9GiB/pack），
 * 既不用重下 82GB 全量，也不会因为版本号被提前改写而跳过校验；中途失败
 * 不改写记账，下次可重续（downloadOne 自带 .kuro-tmp + Range 断点续传）。
 */
async function updateGameFromBundle({
  channel, installRoot, signal, onProgress, allowMissingConfig = false, linkSources = [],
} = {}) {
  const result = {
    ok: false, version: '', tag: '', downloaded: 0, reused: 0, deleted: 0, bytes: 0, reason: '',
  };
  /*
   * signal 规范化（2026-11-13）：底层 fetch 有两条栈，对 signal 的要求不一样——
   *   node:https 栈（http-fetch.js:181）调用 signal.addEventListener('abort', …)，
   *     传 {cancelled,paused} 手造对象会 TypeError「addEventListener is not a function」；
   *   Chromium/undici 栈严格要求 AbortSignal 实例，普通对象同样 TypeError。
   * dock 链传的是支持暂停/取消的手造信号，这里统一换成真 AbortSignal，
   * 用轮询把原信号的 cancelled 状态搬过去——调用方不用改，两条栈都满足。
   */
  if (!(signal instanceof AbortSignal)) {
    const manual = signal || {};
    const controller = new AbortController();
    signal = controller.signal;
    const timer = setInterval(() => {
      if (manual.cancelled) { try { controller.abort(); } catch { /* 已 abort */ } clearInterval(timer); }
    }, 300);
    timer.unref?.();
  }
  try {
    const key = String(channel || 'official');
    const profile = Object.prototype.hasOwnProperty.call(BUNDLE_PROFILES, key) ? BUNDLE_PROFILES[key] : null;
    if (!profile) {
      result.reason = 'WeGame 版请在 WeGame 里更新；启动器只升级官服 / B服 / 国际服客户端';
      return result;
    }
    const root = String(installRoot || '');
    const cfg = await readLauncherConfig(root);
    if (!cfg && !allowMissingConfig) {
      result.reason = '这个目录不是库洛官方客户端（找不到 launcherDownloadConfig.json），请先在官方启动器里装好游戏';
      return result;
    }
    // 档位自适应：客户端记着哪一档就升哪一档（HD/SD/UHD），绝不能默认拉 HD
    // 的清单去升一个 SD 客户端 —— 那等于按另一个画质包重下整份游戏。
    // localBundleOf 优先「记着版本号的档位」（＝真装过），同分按 HD→SD→UHD。
    const bundle = String(localBundleOf(cfg, profile.defaultBundle || 'HD'));
    const packs = (cfg && localPacksOf(cfg, bundle)) || ['common', 'hd'];

    emit(onProgress, { phase: 'manifest', bytesDone: 0, totalBytes: 0, current: '', processed: 0, total: 0 });
    let body;
    try {
      ({ body } = await loadBundleIndex(profile));
    } catch (error) {
      result.reason = `读取官方更新清单失败：${toChineseReason(error)}`;
      return result;
    }
    const cdnUrl = pickCdnUrl(body, body && body.predownload);
    if (!cdnUrl) {
      result.reason = '官方清单里没有可用的 CDN 域名';
      return result;
    }
    const livePacks = (body && body.resourcePacks) || {};
    const targetVersion = String(
      (livePacks[packs[0]] && livePacks[packs[0]].version) ||
      (livePacks.common && livePacks.common.version) || ''
    ).trim();
    if (!targetVersion) {
      result.reason = '官方清单里没有正式版本号，暂时不能升级';
      return result;
    }

    // ① 汇总每个包的目标版本全量清单；顺带收集差量清单里的 deleteFiles[]
    //    和 krpdiff 组（目录差分，见 kuro-krpdiff.js 文件头）。
    const remote = new Map();
    const deleteSet = new Set();
    const groupJobs = [];
    const localV = localVersionOf(cfg, bundle, null);
    for (const name of packs) {
      const pack = livePacks[name];
      if (!pack) continue;
      const indexFile = String(pack.indexFile || '');
      if (!indexFile) continue;
      let json;
      try {
        json = await fetchManifestJson(kuroPacks.buildDownloadUrl(cdnUrl, '', indexFile), pack.indexFileMd5);
      } catch (error) {
        result.reason = `读取 ${name} 资源清单失败：${toChineseReason(error)}`;
        return result;
      }
      for (const item of (json && Array.isArray(json.resource) ? json.resource : [])) {
        if (!item || typeof item !== 'object') continue;
        const rel = kuroPacks.normalizeManifestPath(item.dest);
        if (!rel) continue;
        remote.set(rel, {
          path: rel,
          hash: String(item.md5 == null ? '' : item.md5).toLowerCase(),
          size: Number(item.size) || 0,
          baseUrl: String(pack.baseUrl || ''),
        });
      }
      // deleteFiles / groupInfos 只存在于「从本地版本升级」的差量清单里；
      // 本机已是目标版本时没有对应 patchConfig，也就不需要再次删除。
      const patchList = Array.isArray(pack.patchConfig) ? pack.patchConfig : [];
      const patch = localV && localV !== targetVersion
        ? patchList.find((p) => p && String(p.version) === localV)
        : null;
      if (patch && patch.indexFile) {
        try {
          const diffUrl = kuroPacks.buildDownloadUrl(cdnUrl, '', String(patch.indexFile));
          const diffJson = await fetchManifestJson(diffUrl, patch.indexFileMd5);
          for (const raw of (diffJson && Array.isArray(diffJson.deleteFiles) ? diffJson.deleteFiles : [])) {
            const rel = kuroPacks.normalizeManifestPath(raw);
            if (rel && !remote.has(rel)) deleteSet.add(rel);
          }
          // 每个 group 是一个独立的目录差分：srcFiles 是本机旧文件、dstFiles 是
          // 应用后应得到的新文件。只要能凑齐全部 srcFiles，就只需下这一个
          // krpdiff（几 MB～几十 MB），不必逐个下 dstFiles（合计数 GiB）。
          // 注意：groupInfos[] 条目本身不带 size/md5 —— 差分文件的尺寸和校验值
          // 在差量清单的 resource[] 里（dest 与 group.dest 同名），必须去那里取。
          const patchBase = String(patch.baseUrl || '');
          const diffResource = new Map();
          for (const item of (diffJson && Array.isArray(diffJson.resource) ? diffJson.resource : [])) {
            const rel = kuroPacks.normalizeManifestPath(item && item.dest);
            if (!rel) continue;
            diffResource.set(rel, {
              size: Number((item && item.size) || 0),
              hash: String((item && item.md5) == null ? '' : item.md5).toLowerCase(),
              fromFolder: String((item && item.fromFolder) || ''),
            });
          }
          for (const group of (Array.isArray(diffJson.groupInfos) ? diffJson.groupInfos : [])) {
            if (!group || typeof group !== 'object') continue;
            const dest = kuroPacks.normalizeManifestPath(group.dest);
            if (!dest) continue;
            const srcFiles = (Array.isArray(group.srcFiles) ? group.srcFiles : [])
              .map((f) => ({
                path: kuroPacks.normalizeManifestPath(f && f.dest),
                hash: String((f && f.md5) == null ? '' : f.md5).toLowerCase(),
                size: Number((f && f.size) || 0),
              }))
              .filter((f) => f.path);
            const dstFiles = (Array.isArray(group.dstFiles) ? group.dstFiles : [])
              .map((f) => ({
                path: kuroPacks.normalizeManifestPath(f && f.dest),
                hash: String((f && f.md5) == null ? '' : f.md5).toLowerCase(),
                size: Number((f && f.size) || 0),
              }))
              .filter((f) => f.path);
            if (!srcFiles.length || !dstFiles.length) continue;
            const meta = diffResource.get(dest) || { size: 0, hash: '', fromFolder: '' };
            groupJobs.push({
              dest,
              packName: name,
              url: joinResourceUrl(cdnUrl, meta.fromFolder || patchBase, dest),
              expectedSize: meta.size,
              expectedHash: meta.hash,
              srcFiles,
              dstFiles,
            });
          }
        } catch (error) {
          warn(`读取 ${name} 删除清单失败（不阻断升级，只是不删旧文件）：`, String((error && error.message) || error));
        }
      }
    }
    if (!remote.size) {
      result.reason = '官方清单里没有可用文件，暂时不能升级';
      return result;
    }

    // ①b 只挑「整体还是旧版本」的组：全部 dst 都不是目标版本时才走差分。
    //     两类必须排除：
    //     (a) dst 全都已正确 —— 再跑差分会用 3.8.0 的文件拼 old.cat，
    //         hpatchz 必然失败，②b 又把整组 dstFiles 整份重下（白下几十 GiB）；
    //     (b) 只有个别 dst 缺失（典型：上次升级中断、只剩 1 个半截文件）——
    //         整组重跑差分收益为负，交给 ② 的逐文件队列即可，那只会续传那
    //         0.13GiB 尾巴（downloadOne 有 .kuro-tmp 断点续传）。
    //     官方 KRGroupApplyTask 也不对已就位/半就位的文件打补丁。
    //     注意：这里不预校验 srcFiles md5（REA 结论：官方从不预校验）。
    //     ★但「src 不匹配由 hpatchz 自己报错后回落」这句是错的 —— hpatchz 单文件
    //     模式只比对旧文件的字节长度，不比内容；长度刚好相同的话它会 exit 0 并产出
    //     一份内容全错的成品。真正兜底的是 applyGroup 之后逐文件 md5 比对
    //     （见本文件 1715 行附近的 krpdiff.md5OfFile），对不上就 fallbackJobs 重下。
    const plannedGroups = [];
    const groupDestSet = new Set();
    for (const group of groupJobs) {
      const wanted = group.dstFiles.filter((f) => remote.has(f.path));
      if (!wanted.length) continue;
      let wrong = 0;
      for (const file of wanted) {
        const target = remote.get(file.path);
        const abs = kuroPacks.resolveInside(root, file.path);
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat || !stat.isFile() || stat.size !== target.size) wrong += 1;
      }
      // 只有「整组都还旧」才值得下差分；否则留给逐文件队列精准补齐。
      if (wrong !== wanted.length) continue;
      plannedGroups.push(group);
      for (const file of wanted) groupDestSet.add(file.path);
    }

    // ② 逐文件比对：size + md5 都对就复用，否则排进下载队列。
    //    「由 krpdiff 组产出」的 dst 路径直接跳过 —— 它们会在 ②b 里由差分生成。
    //    P0-1 修复：比对循环对几万文件串行 stat+md5 可能跑几十分钟，
    //    两次 emit 之间零事件会让弹窗冻在 0%；每 25 个文件报一次 compare 进度。
    const jobs = [];
    let reused = 0;
    let linkedFromSources = 0;
    let scanned = 0;
    const remoteTotal = remote.size;
    /*
     * 同机另一份鸣潮（官服 / B服 / 国际服三份并存很常见）已经在目标版本时，
     * 内容相同的文件直接硬链接过来，不必再为同一份字节走一遍网络。
     * usableSources 会丢掉跨卷的源（跨卷既不能硬链接，复制反而双份 IO）。
     */
    const usableSources = linkSource.usableSources(linkSources, { targetRoot: root });
    for (const file of remote.values()) {
      scanned += 1;
      if (scanned % 25 === 0 || scanned === remoteTotal) {
        emit(onProgress, {
          phase: 'compare', processed: scanned, total: remoteTotal, current: file.path,
          percent: remoteTotal > 0 ? Math.min(100, Math.round((scanned / remoteTotal) * 1000) / 10) : 0,
        });
      }
      if (groupDestSet.has(file.path)) continue;
      let abs;
      try {
        abs = kuroPacks.resolveInside(root, file.path);
      } catch {
        continue;
      }
      const stat = await fsp.stat(abs).catch(() => null);
      if (stat && stat.isFile() && stat.size === file.size && file.hash) {
        try {
          if ((await kuroPacks.md5File(abs, { signal })) === file.hash) {
            reused += 1;
            continue;
          }
        } catch {
          /* 校验失败按「需要重下」处理 */
        }
      }
      /*
       * 本地这份不在目标版本 → 先问同机别的鸣潮客户端有没有同一个文件。
       * 命中就 unlink + link（同卷秒完成），源那份不受影响。
       * match 口径必须和上面「本地是否已就位」一致：size + 整份 md5，
       * 否则会出现「这里说命中、那边又重新下」。
       */
      if (usableSources.length) {
        const linked = await linkSource.reuseFromSources({
          file: { ...file, file: file.path },
          target: abs,
          gameKey: 'wutheringwaves',
          sources: usableSources,
          match: async (candidate) => {
            const info = await fsp.stat(candidate).catch(() => null);
            if (!info || !info.isFile() || info.size !== file.size) return false;
            return (await kuroPacks.md5File(candidate, { signal })) === file.hash;
          },
        });
        if (linked.ok) {
          linkedFromSources += 1;
          reused += 1;
          continue;
        }
      }
      jobs.push({
        url: joinResourceUrl(cdnUrl, file.baseUrl, file.path),
        dest: abs,
        expectedSize: file.size,
        expectedHash: file.hash,
        path: file.path,
      });
    }
    // 进度分母 = 普通下载字节 + 差分补丁字节（两者都要下）
    const directBytes = jobs.reduce((sum, job) => sum + (Number(job.expectedSize) || 0), 0);
    const groupBytesPlanned = plannedGroups.reduce((sum, g) => sum + (Number(g.expectedSize) || 0), 0);
    const totalBytes = directBytes + groupBytesPlanned;
    let bytesDone = 0;
    let processed = 0;
    let downloaded = 0;
    emit(onProgress, {
      phase: 'download', bytesDone: 0, totalBytes, current: '', processed: 0, total: jobs.length,
    });
    await kuroPacks.runPool(jobs, Math.min(4, Math.max(1, jobs.length)), async (job) => {
      if (signal && signal.cancelled) throw new Error('已取消');
      await kuroPacks.downloadOne({
        url: job.url,
        dest: job.dest,
        expectedSize: job.expectedSize,
        expectedHash: job.expectedHash,
        signal,
      });
      downloaded += 1;
      bytesDone += Number(job.expectedSize) || 0;
      processed += 1;
      emit(onProgress, {
        phase: 'download', bytesDone, totalBytes, current: job.path, processed, total: jobs.length,
      });
    });

    // ②b 应用 krpdiff 目录差分。每组只需下几 MB～几十 MB 的差分文件，
    //     就能重建出该组全部 dstFiles（合计数 GiB）—— 这是把「要下 81GiB」
    //     压到「约 12GiB」的关键一步。单组失败不影响其它组：它的 dstFiles
    //     在 ② 里已被跳过，所以要在这里补回去（退回整文件下载）。
    let groupApplied = 0;
    let groupBytes = 0;
    const fallbackJobs = [];
    if (plannedGroups.length) {
      const workRoot = path.join(root, '.hxl-kuro-update');
      await fsp.mkdir(workRoot, { recursive: true }).catch(() => {});
      // 并发 4 组：差分文件和整文件下载可以同时跑，否则十几 GiB 串行下太久。
      // applyGroup 内部每组用 mkdtemp 独立临时目录，互不干扰。
      await kuroPacks.runPool(plannedGroups, Math.min(4, plannedGroups.length), async (group) => {
        if (signal && signal.cancelled) throw new Error('已取消');
        const diffPath = path.join(workRoot, String(group.dest).replace(/[\\/]/g, '_'));
        try {
          await kuroPacks.downloadOne({
            url: group.url,
            dest: diffPath,
            expectedSize: group.expectedSize,
            expectedHash: group.expectedHash,
            signal,
          });
          bytesDone += Number(group.expectedSize) || 0;
          const applied = await krpdiff.applyGroup({
            installRoot: root,
            krpdiff: diffPath,
            tempDir: workRoot,
            pathHelper: kuroPacks,
            signal,
          });
          if (applied.ok) {
            groupApplied += 1;
            groupBytes += applied.bytes;
            for (const rel of applied.files) {
              const target = remote.get(rel);
              if (!target) continue;
              const abs = kuroPacks.resolveInside(root, rel);
              const actual = await krpdiff.md5OfFile(abs, { signal }).catch(() => '');
              if (!target.hash || actual === target.hash) downloaded += 1;
              else fallbackJobs.push({ rel, target });
            }
          } else {
            warn(`差分组 ${group.dest} 应用失败，退回整文件下载：`, applied.reason);
            for (const file of group.dstFiles) {
              const target = remote.get(file.path);
              if (target) fallbackJobs.push({ rel: file.path, target });
            }
          }
        } catch (error) {
          warn(`差分组 ${group.dest} 处理失败，退回整文件下载：`, String((error && error.message) || error));
          for (const file of group.dstFiles) {
            const target = remote.get(file.path);
            if (target) fallbackJobs.push({ rel: file.path, target });
          }
        } finally {
          await fsp.rm(diffPath, { force: true }).catch(() => {});
        }
        emit(onProgress, {
          phase: 'download', bytesDone, totalBytes, current: `差分补丁 ${groupApplied}/${plannedGroups.length}`, processed, total: jobs.length,
        });
      });
      await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => {});
    }
    // 兜底：没能由差分生成的文件，老老实实整份下
    if (fallbackJobs.length) {
      await kuroPacks.runPool(fallbackJobs, Math.min(4, Math.max(1, fallbackJobs.length)), async (job) => {
        if (signal && signal.cancelled) throw new Error('已取消');
        await kuroPacks.downloadOne({
          url: joinResourceUrl(cdnUrl, job.target.baseUrl, job.rel),
          dest: kuroPacks.resolveInside(root, job.rel),
          expectedSize: job.target.size,
          expectedHash: job.target.hash,
          signal,
        });
        downloaded += 1;
        bytesDone += Number(job.target.size) || 0;
        processed += 1;
        emit(onProgress, {
          phase: 'download', bytesDone, totalBytes, current: job.rel, processed, total: jobs.length,
        });
      });
    }

    // ③ 全部下载成功才删旧文件、才写版本号：中途失败不改写记账，下次可重续
    let deleted = 0;
    for (const rel of deleteSet) {
      try {
        await fsp.rm(kuroPacks.resolveInside(root, rel), { force: true });
        deleted += 1;
      } catch (error) {
        warn('删除旧版本文件失败（忽略）：', String((error && error.message) || error));
      }
    }
    await writeLocalVersion(root, bundle, packs, targetVersion);

    result.ok = true;
    result.version = targetVersion;
    result.tag = targetVersion;
    result.downloaded = downloaded;
    result.reused = reused;
    result.linked = linkedFromSources;
    result.deleted = deleted;
    result.bytes = bytesDone;
    emit(onProgress, {
      phase: 'done', bytesDone, totalBytes, current: '', processed, total: jobs.length,
    });
    return result;
  } catch (error) {
    // 真实错误必须透出：笼统的「网络请求或本地文件操作失败」救不了排查。
    // 诊断行（含堆栈首行）写进 reason 与 console，用户看到的仍是中文人话。
    const detail = String((error && error.message) || error || '');
    const stack1 = String((error && error.stack) || '').split('\n').slice(0, 2).join(' | ');
    console.warn('[kuro updateGameFromBundle] 真实错误:', detail, stack1);
    result.reason = `升级失败：${toChineseReason(error)}（诊断: ${detail.slice(0, 200)}）`;
    return result;
  }
}

/**
 * 事务式重写本地版本记账（顶层 version + bundles[bundle].version + 各 pack 的 version）。
 *
 * **统一走 `kuro-packs.writeLauncherConfig`**：预下载应用（applyPredownload）、真升级
 * （updateGameFromBundle）、下载游戏 / 更新 / 硬链接切服三处都会写这份记账，
 * 必须字字一致。以前这里自己抄了一份，一旦两边的字段口径跑偏，就会出现
 *
 */
async function writeLocalVersion(installRoot, bundle, packs, version) {
  await kuroPacks.writeLauncherConfig({
    installRoot: String(installRoot),
    channel: '',
    bundle,
    version,
    packs: Array.isArray(packs) && packs.length ? packs.map((p) => String(p)) : ['common', 'hd'],
  });
}

module.exports = {
  // ── 契约：lead 按这 5 个接 main.js / UI ──
  checkPredownload,
  downloadPredownload,
  applyPredownload,
  clearPredownload,
  updateGameFromBundle,
  BUNDLE_PROFILES,
  findKuroClientRoot,

  // ── 契约外的纯函数 / 工具导出：供自测直接验证拼接、版本比较、state 往返；
  //    lead 不必接入，也不影响上面 5 个键的用法。
  joinResourceUrl,
  compareVersion,
  versionGate,
  readState,
  writeState,
};
