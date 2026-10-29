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
const { spawn } = require('node:child_process');

/*
 * 网络请求入口：优先走 Electron 的 Chromium 网络栈（net.fetch）。
 *
 * 为什么不用 Node 的 fetch：Node 只认自己内置的 CA 列表，不读系统证书库——
 * Steam++（Watt Toolkit）这类 GitHub 加速器的原理就是本地中间人代理 +
 * 把自己的根证书装进系统证书库，Node fetch 对它伪造的证书一律校验失败；
 * 不开加速器国内又直连不上 GitHub，两头堵死（10-29 用户反馈：开了 Steam++
 * 检查更新失败，关了直连也失败）。Chromium 网络栈两个问题都没有：
 *   - 证书走系统证书库，用户装了什么根证书就认什么；
 *   - 代理走系统设置，系统代理和 Steam++ 的本地端口自动生效。
 * 自测环境（selftest-update.js）没有 Electron，降级回 Node fetch。
 */
let electronNetFetch = null;
try {
  const electron = require('electron');
  const net = electron && electron.net;
  if (net && typeof net.fetch === 'function') electronNetFetch = net.fetch.bind(net);
} catch {
  /* 非 Electron 环境：require('electron') 拿到的是 exe 路径字符串或直接抛错 */
}

async function httpFetch(url, options = {}) {
  const { dispatcher, ...rest } = options; // dispatcher 是 undici 专属参数，Chromium 栈不认
  if (electronNetFetch) {
    try {
      return await electronNetFetch(url, rest);
    } catch (error) {
      // Chromium 栈连不上时退回 Node fetch 再试一把：两边各自的可达性盲区
      // （系统代理配置异常、证书库被改）不同，互为兜底。
      if (typeof fetch === 'function') return fetch(url, options);
      throw error;
    }
  }
  return fetch(url, options);
}

const EXE_NAME = '花筱灵启动器.exe';
const DEFAULT_TIMEOUT = 15000;
/** 下载断线时最多重试几次（不含第一次）。 */
const DOWNLOAD_RETRIES = 2;

/*
 * 内置下载镜像：GitHub 直连失败时（国内裸连很常见）挨个试加速代理。
 *
 * 形式是「前缀」：拼在官方下载地址前面，即 ghproxy 系代理的通用用法
 * （https://ghfast.top/https://github.com/...）。第三方代理理论上可以篡改
 * 文件，但下载完有 sha256 校验兜底——篡改的包进不了安装流程，最多浪费一次
 * 下载。清单里的 mirrors 字段（发布方维护，支持 {url} 占位符模板，比如自建
 * Cloudflare Worker）会排在这些内置兜底前面。
 */
const DEFAULT_MIRROR_PREFIXES = [
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
  'https://mirror.ghproxy.com/',
];

function isGithubHostUrl(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

/**
 * 官方地址 + 镜像候选，按优先级排好。
 * @param {string} url 清单里的官方下载地址
 * @param {string[]} [mirrors] 清单 mirrors 字段：完整地址、前缀，或含 {url} 占位符的模板
 */
function buildDownloadCandidates(url, mirrors) {
  const official = String(url || '').trim();
  const list = official ? [official] : [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !list.includes(text)) list.push(text);
  };
  if (official) {
    // 清单自带的镜像（发布方可随时热更，比如自建 Worker）优先于内置兜底
    const declared = Array.isArray(mirrors) ? mirrors : [];
    for (const item of declared) {
      const text = String(item || '').trim();
      if (!text) continue;
      push(text.includes('{url}') ? text.replace('{url}', official) : text + official);
    }
    if (isGithubHostUrl(official)) {
      for (const prefix of DEFAULT_MIRROR_PREFIXES) push(prefix + official);
    }
  }
  return list;
}

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
 * 读取并校验 manifest。
 *
 * 随包分发的那份 latest.json 只写「真正的清单在哪」（manifest 指针），
 * 因为打进包里的时候还没算出这个包自己的 sha256——自己算自己的哈希是不可能的。
 * 遇到这种清单就顺着指针再取一次真正的清单：下载地址和 sha256 都在那一份里。
 *
 * @returns {Promise<{version:string,notes:string,url:string,sha256:string,size:number,mandatory:boolean,source:string,title:string,date:string}>}
 */
async function readManifest(location) {
  const raw = String(location || '').trim();
  if (!raw) throw new Error('还没有设置更新源');
  const text = await fetchText(raw);
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
    const real = await readManifest(resolveAgainst(raw, pointer));
    return { ...real, source: raw };
  }

  const version = String(data.version || '').trim().replace(/^v/i, '');
  if (!version) throw new Error('更新源里没有版本号');
  return {
    version,
    title: String(data.title || '').trim(),
    date: String(data.date || '').trim(),
    notes: String(data.notes || '').trim(),
    url: resolveAgainst(raw, data.url),
    mirrors: Array.isArray(data.mirrors) ? data.mirrors.map((m) => String(m || '').trim()).filter(Boolean) : [],
    sha256: String(data.sha256 || '').trim().toLowerCase(),
    size: Number(data.size) || 0,
    mandatory: Boolean(data.mandatory),
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
  let best = null;
  let lastError = null;
  for (const candidate of list) {
    try {
      const manifest = await readManifest(candidate);
      if (!best || compareVersions(manifest.version, best.manifest.version) > 0) {
        best = { manifest, source: candidate };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (best) return { ok: true, manifest: best.manifest, source: best.source };
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
    mirrors: manifest.mirrors || [],
    sha256: manifest.sha256,
    size: manifest.size,
    mandatory: manifest.mandatory,
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
async function downloadOne({ url, dest, expectedSize, report }) {
  let lastError = null;
  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
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
          const { done, value } = await reader.read();
          if (done) break;
          await handle.write(value);
          received += value.length;
          report(total ? (received / total) * 100 : 0, received, total);
        }
      } finally {
        await handle.close();
      }
      report(100, received, total || received);
      return dest;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (error.retryable === false || attempt >= DOWNLOAD_RETRIES) break;
    }
  }
  throw lastError || new Error('下载失败');
}

/**
 * 下载更新包:官方地址下载失败(连不上/超时,典型是国内裸连 GitHub)时,
 * 挨个尝试镜像候选(清单 mirrors + 内置加速代理前缀),谁先成功用谁。
 * 换候选时进度回调重置;下载完成后有 sha256 校验,镜像内容不可信也进不了安装。
 */
async function downloadHttp({ url, mirrors, dest, expectedSize, report }) {
  const candidates = buildDownloadCandidates(url, mirrors);
  if (!candidates.length) throw new Error('没有可用的下载地址');
  let lastError = null;
  for (let i = 0; i < candidates.length; i += 1) {
    if (i > 0) {
      // 换候选:进度归零,让用户看到下载从头开始而不是卡在半截
      report(0, 0, expectedSize || 0);
    }
    try {
      return await downloadOne({ url: candidates[i], dest, expectedSize, report });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('下载失败');
}

async function downloadToFile({ url, mirrors, dest, expectedSize = 0, onProgress }) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const report = (percent, received, total) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ percent: Math.max(0, Math.min(100, percent)), received, total });
    } catch {
      /* 进度回调出错不影响下载 */
    }
  };

  if (isHttpLocation(url)) {
    return await downloadHttp({ url, mirrors, dest, expectedSize, report });
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
  await runPowerShell(
    `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(extractRoot)} -Force`
  );
}

function findPackageRoot(extractRoot) {
  const candidates = [path.join(extractRoot, '花筱灵启动器'), extractRoot];
  return (
    candidates.find(
      (dir) =>
        fs.existsSync(path.join(dir, EXE_NAME)) &&
        fs.existsSync(path.join(dir, 'resources', 'app', 'package.json'))
    ) || ''
  );
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
  if (!source) throw new Error('这个 ZIP 不是有效的花筱灵便携版更新包');

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
  if (!listing.includes('resources/app/electron/main.js')) {
    throw new Error('更新包里缺少 resources/app/electron/main.js，覆盖后启动器会打不开');
  }

  const files = listing.filter((rel) => !isProtected(rel));
  // 被覆盖的文件里可能有游戏正在跑的 exe，提前收集出来让主进程去核对
  const locks = files.filter((rel) => !rel.includes('/'));

  // 覆盖脚本是更新包的一部分，缺了这次的更新就等于装不上——必须在动程序目录之前拦下来
  const installerSource = path.join(source, 'resources', 'updater', 'HXL-Updater.ps1');
  const selfHealSource = path.join(source, 'resources', 'updater', 'self-heal.ps1');
  if (!fs.existsSync(installerSource)) {
    throw new Error('更新包里缺少 resources/updater/HXL-Updater.ps1，无法完成覆盖');
  }
  if (!fs.existsSync(selfHealSource)) {
    throw new Error('更新包里缺少 resources/updater/self-heal.ps1，升级失败后无法自动还原');
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
    files,
    removed: [],
    protectedExisting: [...protectedExisting],
    locks,
    installerSource,
    selfHealSource,
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
 * 脚本（resources/updater/HXL-Updater.ps1）负责：
 *   1. 等旧进程退出；
 *   2. 把要覆盖的程序文件逐个备份到 data\tmp\backup-<版本>；
 *   3. 按清单覆盖（用 -LiteralPath 逐项复制，绝不镜像整个目录）；
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
  const child = spawn(
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
  const installer =
    staged.installerSource && fs.existsSync(staged.installerSource)
      ? staged.installerSource
      : path.join(__dirname, 'updater-installer.ps1');
  if (!fs.existsSync(installer)) throw new Error('找不到覆盖脚本，更新包里缺少 resources/updater/HXL-Updater.ps1');
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
  };
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

module.exports = {
  EXE_NAME,
  parseVersion,
  compareVersions,
  isHttpLocation,
  readManifest,
  resolveManifest,
  checkForUpdate,
  buildDownloadCandidates,
  downloadToFile,
  sha256File,
  extractZip,
  findPackageRoot,
  listFiles,
  isProtected,
  stage,
  apply,
  buildApplyMeta,
  describeApplyProblem,
  updateStatusDir,
  prepareRollback,
  cleanTemp,
};
