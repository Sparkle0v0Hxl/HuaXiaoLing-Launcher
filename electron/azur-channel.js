'use strict';

/*
 * 蓝色星原：启动器渠道配置的读取 / 落盘 / 切换。
 *
 * ── 背景（2026-11-26 实测确认）────────────────────────────────────
 * 蓝原的「渠道身份」完全由一个 368/192 字节的加密文件决定：
 *     <启动器目录>/res/app_config.dat
 * 里面只有 6 个字段（解密后）：
 *     launcherId / gameId / appId / channelCode / secretKey / channelExtraParams
 *
 * 官服 channelCode=C000（192 字节）
 * B服  channelCode=C001（368 字节，多出 bilibili.* 一整套 SDK 参数）
 *
 * 用户实测：把官服启动器的这一个文件换成 B服 的，双击启动器就进了 B服。
 * 也就是**不需要换 launcher.exe、不需要换任何其它文件、不需要换版本**。
 *
 * ── 这个文件是加密的，我们不能凭空造 ────────────────────────────────
 * 加密/解密都在原生模块 napi-cutils 的 extApi1 里（只有解密没有加密）。
 * 密文 = 固定 16 字节 IV + AES-CBC 密文，密钥在二进制里，没有导出。
 * 所以只能「从已有的启动器读出来存着」，或者「从官方 CDN 下载」。
 *
 * ── 两个不同的 app_config.dat，别搞混 ──────────────────────────────
 *   ① <启动器目录>/res/app_config.dat          192/368 字节 → 启动器读，决定渠道
 *   ② <游戏目录>/mj_sdk/res/app_config.dat    1984/1392 字节 → 游戏进程读，含 bilibili SDK 参数
 * 本模块只管 ①。② 由硬链接 + 渠道件包负责。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** 各渠道的已知信息。channelCode 是唯一能用来区分渠道的字段。 */
const KNOWN_CHANNELS = {
  C000: { channel: 'official', label: '官服', size: 192 },
  C001: { channel: 'bilibili', label: 'B服', size: 368 },
};

/**
 * ⚠ 重要：CDN 上没有「启动器目录那份」app_config.dat。
 *
 * 实测（2026-11-26）：
 *   游戏清单里的 mj_sdk/res/app_config.dat   → 官服 1984 字节 / B服 1392 字节
 *   启动器目录的 res/app_config.dat          → 官服 192 字节 / B服 368 字节
 * 两者**体积和结构都不同**，CDN 只能下到前者，拿它写进启动器目录会让启动器解不开。
 * 所以下载走不通，只能从「用户已装的对应启动器」里读。
 *
 * 保留这张表是为了记录曾经试过的地址，不要用它去下载启动器配置。
 */
const CDN_CONFIG_PATHS = {
  C000: 'azurpromilia/pg_item_v2/target/c000_20261106144507_b3AtMTExMDQ4/mj_sdk/res/app_config.dat',
  C001: 'azurpromilia/pg_item_v2/target/sc010_20261106131610_b3AtMTExMDUw/mj_sdk/res/app_config.dat',
};
const CDN_BASE = 'https://syncstation.manjuu.com';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 加载官方启动器自带的原生模块 napi-cutils，拿到 extApi1（唯一的解密入口）。
 *
 * 这个 .node 文件随官方启动器分发，路径形如：
 *   <启动器目录>/resources/app.asar.unpacked/node_modules/napi-cutils/build/Release/cutils.node
 * 不同版本号目录不一样（1.0.1.1 / 1.0.2.3），所以要按 launcherDir 现算。
 *
 * 拿不到就返回 null —— 所有依赖解密的功能会降级（比如识别不出渠道号），
 * 绝不抛错到界面。
 */
const cutilsCache = new Map();
function loadCutils(launcherDir) {
  const key = path.resolve(launcherDir);
  if (cutilsCache.has(key)) return cutilsCache.get(key);
  let mod = null;
  const candidates = [
    path.join(key, 'resources', 'app.asar.unpacked', 'node_modules', 'napi-cutils', 'build', 'Release', 'cutils.node'),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const loaded = require(candidate);
      mod = loaded && loaded.CUtils ? new loaded.CUtils() : null;
      if (mod) break;
    } catch {
      /* 版本不匹配 / 缺依赖时跳过，不阻断流程 */
    }
  }
  cutilsCache.set(key, mod);
  return mod;
}

/** 各渠道的官方启动器安装包地址（用于从中提取 res/app_config.dat）。 */
const INSTALLER_URLS = {
  /* 官服：从 https://api-grp.manjuu.com/activity/web/download/info?gameId=35 拿到的 */
  C000: 'https://syncstation.manjuu.com/azurpromilia/launcher/c000/20261124220849_kehudsjwjewqwgog/AzurPromilia_manjuu_installer_1.0.2.2_35_SC000_202611242140.exe',
  /*
   * B服：B站 官网详情页 https://www.biligame.com/detail/?id=111392 的下载按钮。
   * 那个页面是 JS 渲染的，静态抓不到地址，所以这里写死当前版本；
   * 官方更新后这个 URL 会失效，届时要让用户「手动指定已下载的安装包」走本地提取。
   */
  C001: '', // 留空：B站 的地址带哈希，无法稳定构造，改由用户提供本地安装包
};

/**
 * 获取某渠道的启动器配置。
 *
 * 优先级：
 *   ① userData 已有 → 直接用（用户装过对应启动器、或之前提取/内置过）
 *   ② 内置的 → 复制到 userData（560 字节随包分发，用户装一个启动器就够）
 *   ③ 本机装了对应启动器 → 直接读它的 res/app_config.dat
 *   ④ 从官方安装包提取（约 28MB 起）或本地已下载的安装包
 *
 * @param {object} opts
 * @param {string} opts.userData
 * @param {string} opts.channelCode C000 / C001
 * @param {Array<string>} [opts.launcherRoots] 本机可能的启动器根目录
 * @param {string} [opts.installerPath] 用户已下载的安装包本地路径（优先于远程）
 */
async function acquireChannelConfig({ userData, channelCode, launcherRoots, installerPath } = {}) {
  if (!KNOWN_CHANNELS[channelCode]) throw new Error(`未知渠道号：${channelCode}`);
  const label = KNOWN_CHANNELS[channelCode].label;

  /* ① userData 已有 */
  const stored = storePath(userData, channelCode);
  try {
    const st = await fsp.stat(stored);
    if (st.size > 0) return { path: stored, size: st.size, source: 'cached' };
  } catch {
    /* 没有就往下 */
  }

  /* ② 内置的（最省事：零下载、零依赖用户装对应启动器） */
  const bundled = bundledConfigPath(channelCode);
  if (bundled) {
    const buf = await fsp.readFile(bundled);
    await fsp.mkdir(storeDir(userData), { recursive: true });
    await fsp.writeFile(stored, buf);
    return { path: stored, size: buf.length, source: 'bundled' };
  }

  /* ③ 本机启动器里读 */
  if (launcherRoots && launcherRoots.length) {
    const dirs = findLauncherDirs(launcherRoots);
    for (const d of dirs) {
      const cutils = loadCutils(d.dir);
      const info = readChannelCode(d.dir, cutils);
      if (info && info.channelCode === channelCode) {
        await saveChannelConfig(userData, channelCode, info.file);
        return { path: stored, size: info.size, source: 'local-launcher', launcherDir: d.dir };
      }
    }
  }

  /* ④ 从安装包提取 */
  const extract = require('./azur-installer-extract');
  let result = null;
  if (installerPath) {
    result = extract.extractFromLocalFile(installerPath, KNOWN_CHANNELS[channelCode].size);
  } else if (INSTALLER_URLS[channelCode]) {
    result = await extract.extractFromRemote(INSTALLER_URLS[channelCode], KNOWN_CHANNELS[channelCode].size);
  } else {
    throw new Error(
      `拿不到 ${label} 的启动器配置。请先安装一次 ${label} 官方启动器，` +
        '或把它的安装包下载到本机后在设置里指定路径。'
    );
  }
  if (!result.ok) throw new Error(`从安装包提取 ${label} 配置失败：${result.error}`);

  await fsp.mkdir(storeDir(userData), { recursive: true });
  await fsp.writeFile(stored, result.data);
  return {
    path: stored,
    size: result.size,
    source: result.from === 'local' ? 'installer-local' : 'installer-remote',
    downloadBytes: result.downloadBytes || 0,
  };
}

/**
 * 内置渠道配置（随启动器分发，共 560 字节）。
 *
 * ── 文件来源 ──────────────────────────────────────────────────
 *   resources/azur-channel/C000.dat  192 字节  官服  channelCode=C000
 *   resources/azur-channel/C001.dat  368 字节  B服   channelCode=C001
 *
 * 两个文件都是从**官方启动器安装包的 res/app_config.dat 原样复制**的，
 * 未修改任何一个字节、未做任何破解：
 *   官服包 https://syncstation.manjuu.com/azurpromilia/launcher/c000/.../
 *          AzurPromilia_manjuu_installer_1.0.2.2_35_SC000_*.exe
 *   B服 包 https://www.biligame.com/detail/?id=111392 的下载按钮
 *          （文件名 lsxylyPCb_bilibili_*.exe）
 * 任何用户下载这两个安装包、用 7z 打开都能取到同样的字节。
 *
 * ── 内容与用途 ────────────────────────────────────────────────
 * 解密后是 6 个字段：launcherId / gameId / appId / channelCode /
 * secretKey / channelExtraParams。它们用于：
 *   · launcherId   → 拉清单、查版本时作为渠道标识（只读接口）
 *   · secretKey    → 本机签名（extApi2 初始化），不直接发送
 *   · channelExtraParams → B站 渠道 SDK 参数
 * 不含任何账号、密码、用户数据；官服与 B服 的 secretKey 是同一个值。
 *
 * ── 为什么内置 ────────────────────────────────────────────────
 * 蓝原必须由官方启动器拉起，而启动器只认自己目录里这份配置的 channelCode。
 * 内置后用户**装一个官服启动器就能切 B服**，不必再下载 200MB 的 B服 启动器，
 * 也不需要从安装包里手动提取。
 *
 * ── 如何撤除 ──────────────────────────────────────────────────
 * 删掉 resources/azur-channel/ 下这两个文件，或把 ENABLE_BUNDLED 改回 false，
 * 获取链路会自动退回「从本机已装启动器读」→「从安装包提取」，
 * 功能不受影响，只是用户需要自己装一次对应渠道的启动器。
 */
const ENABLE_BUNDLED = true;

function bundledConfigPath(channelCode) {
  if (!ENABLE_BUNDLED) return '';
  const roots = [];
  try {
    if (process.resourcesPath) roots.push(process.resourcesPath);
  } catch {
    /* 非 Electron 环境 */
  }
  roots.push(path.join(__dirname, '..', 'resources'));
  roots.push(path.join(__dirname, 'resources'));

  for (const root of roots) {
    const p = path.join(root, 'azur-channel', `${channelCode}.dat`);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 继续找下一个 */
    }
  }
  return '';
}

/** 渠道配置的本地存档目录（在 userData 下）。 */
function storeDir(userData) {
  return path.join(userData, 'azur-channel');
}

function storePath(userData, channelCode) {
  return path.join(storeDir(userData), `${channelCode}.dat`);
}

/**
 * 找出某渠道应该用哪个 launcher.exe。
 *
 * 蓝原的启动器目录结构是 <安装根>\<版本号>\launcher.exe，
 * 版本号会随更新变化，所以这里按「根目录下找任意子目录里的 launcher.exe」来搜。
 */
function findLauncherDirs(roots) {
  const found = [];
  for (const root of roots || []) {
    if (!root || !fs.existsSync(root)) continue;
    /* 根目录直接就是启动器目录 */
    if (fs.existsSync(path.join(root, 'resources', 'app.asar'))) {
      found.push({ dir: root, exe: path.join(root, 'launcher.exe') });
      continue;
    }
    /* <root>\<版本>\launcher.exe */
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const exe = path.join(dir, 'launcher.exe');
      if (fs.existsSync(exe) && fs.existsSync(path.join(dir, 'resources', 'app.asar'))) {
        found.push({ dir, exe });
      }
    }
  }
  return found;
}

/**
 * 从某个启动器目录读出它的渠道号。
 *
 * 注意：渠道号在加密文件里，必须靠原生模块解。
 * 拿不到原生模块（比如用户机器上没有装过蓝原启动器）时返回 null。
 */
function readChannelCode(launcherDir, cutils) {
  const file = path.join(launcherDir, 'res', 'app_config.dat');
  if (!fs.existsSync(file)) return null;
  if (!cutils) return null;
  try {
    const plain = cutils.extApi1(file);
    const parsed = JSON.parse(plain);
    return {
      channelCode: String(parsed.channelCode || ''),
      launcherId: String(parsed.launcherId || ''),
      size: fs.statSync(file).size,
      file,
    };
  } catch {
    return null;
  }
}

/** 把某份渠道配置存档到 userData（幂等，内容没变就不重写）。 */
async function saveChannelConfig(userData, channelCode, srcFile) {
  if (!KNOWN_CHANNELS[channelCode]) throw new Error(`未知渠道号：${channelCode}`);
  const target = storePath(userData, channelCode);
  await fsp.mkdir(storeDir(userData), { recursive: true });
  const buf = await fsp.readFile(srcFile);
  let same = false;
  try {
    const old = await fsp.readFile(target);
    same = old.equals(buf);
  } catch {
    same = false;
  }
  if (!same) await fsp.writeFile(target, buf);
  return { path: target, size: buf.length, wrote: !same };
}

/**
 * 把存档里的某渠道配置写进目标启动器目录。
 *
 * 关键：写之前先 unlink，因为启动器目录里那份可能是硬链接（会写穿）。
 */
async function applyChannelConfig(userData, channelCode, launcherDir) {
  if (!KNOWN_CHANNELS[channelCode]) throw new Error(`未知渠道号：${channelCode}`);
  const src = storePath(userData, channelCode);
  if (!fs.existsSync(src)) {
    throw new Error(`没有 ${KNOWN_CHANNELS[channelCode].label} 的渠道配置存档，需要先读取或下载一次`);
  }
  const target = path.join(launcherDir, 'res', 'app_config.dat');
  const buf = await fsp.readFile(src);
  let same = false;
  try {
    const old = await fsp.readFile(target);
    same = old.equals(buf);
  } catch {
    same = false;
  }
  if (same) return { changed: false, size: buf.length, path: target };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  /* 断链：万一这份是硬链接到别处的，直接写会改到源文件 */
  try {
    await fsp.unlink(target);
  } catch {
    /* 不存在就算了 */
  }
  await fsp.writeFile(target, buf);
  return { changed: true, size: buf.length, path: target };
}

/**
 * 从官方 CDN 下载**游戏目录那份** app_config.dat（1984/1392 字节）。
 *
 * 不要用它去替换启动器目录的 res/app_config.dat —— 两者格式不同，会解不开。
 * 这个函数的用途是：给「硬链接生成的渠道运行时」补齐游戏目录里的渠道件，
 * 也就是 <游戏目录>/mj_sdk/res/app_config.dat。
 */
async function downloadGameConfig(userData, channelCode, signal) {
  const rel = CDN_CONFIG_PATHS[channelCode];
  if (!rel) throw new Error(`没有 ${channelCode} 的 CDN 路径`);
  const url = `${CDN_BASE}/${rel}`;
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: '*/*' },
    signal: signal || AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`下载游戏渠道配置失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const target = path.join(storeDir(userData), `${channelCode}-game.dat`);
  await fsp.mkdir(storeDir(userData), { recursive: true });
  await fsp.writeFile(target, buf);
  return { path: target, size: buf.length, url };
}

/** 列出当前有哪些渠道配置存档（给界面显示用）。 */
function listStoredChannels(userData) {
  const out = {};
  for (const [code, meta] of Object.entries(KNOWN_CHANNELS)) {
    const p = storePath(userData, code);
    const gp = path.join(storeDir(userData), `${code}-game.dat`);
    let size = 0;
    let gameSize = 0;
    try {
      size = fs.statSync(p).size;
    } catch {
      size = 0;
    }
    try {
      gameSize = fs.statSync(gp).size;
    } catch {
      gameSize = 0;
    }
    out[code] = { ...meta, stored: size > 0, size, gameStored: gameSize > 0, gameSize };
  }
  return out;
}

module.exports = {
  KNOWN_CHANNELS,
  bundledConfigPath,
  acquireChannelConfig,
  INSTALLER_URLS,
  loadCutils,
  CDN_CONFIG_PATHS,
  findLauncherDirs,
  readChannelCode,
  saveChannelConfig,
  applyChannelConfig,
  downloadGameConfig,
  listStoredChannels,
  storePath,
};
