'use strict';

/*
 * libuv 线程池按 CPU 定档（必须在第一次异步 fs / zstd 之前设）。
 *
 * 预下载写入是 16 路并发的文件组装，每一路都会调异步 zstd 解压 —— 而异步 zstd
 * 跑在 libuv 线程池里，线程池默认只有 4 条。不加这里的话，16 路会全堵在解压上。
 *
 * 但也不能无脑给 16：线程池超过物理核数时，多出来的线程只是在抢 CPU，
 * 上下文切换把收益吃回去。实测（600 个 400KB 文件 / NVMe）：
 *   4 逻辑核 + 池 16 → 16 路 86.8 MB/s（比 8 路的 99.1 还慢）
 *   4 逻辑核 + 池  8 → 16 路 99.5 MB/s（最优）
 *   12 逻辑核 + 池 16 → 16 路 117.7 MB/s（最优）
 * 所以按 2×逻辑核 给档、上下限 4~16：双核 4、四核 8、六核 12、八核以上 16。
 * 文件级并发始终是 16 路（低核机器上 16 路仍优于 8 路，缺的是线程池档位）。
 * 用户自己设了环境变量时不覆盖。
 */
const os = require('node:os');
const logicalCores = (() => {
  try {
    const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Number(n) || 4);
  } catch {
    return 4;
  }
})();
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.min(16, Math.max(4, logicalCores * 2)));
}

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  powerMonitor,
  globalShortcut,
  safeStorage,
  session,
  net,
  protocol,
  screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn, execFileSync, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

const { JsonStore } = require('./store');
const clientChannel = require('./client-channel');
const { DownloadManager } = require('./downloads');
const hgBackgrounds = require('./hg-backgrounds');
const { ensureSeedData } = require('./seed');
const { linkTrees, previewTrees } = require('./link');
const { prepareLinkedRuntime, walkFiles, hardlinkTree, copyTree } = require('./runtime');
/*
 * 终末地「每渠道独立硬链接运行时」用的两个工具：
 *   · overlayDirectory：把渠道包原地覆盖到该渠道运行时目录上，写入前先解除硬链接；
 *   · mustCopyNotLink：判断一个文件能不能硬链接（可写文件必须复制）。
 * prepareLinkedRuntime 保留给别的游戏用；终末地自己的 buildEndfieldChannelRuntime
 * 会在整树重建时把旧目录的 Persistent（用户下好的语音包）整体搬过去，不会丢下载内容。
 */
const { overlayDirectory, mustCopyNotLink } = require('./runtime');
const { loadGachaHistory } = require('./gacha');
const nteCapture = require('./nte-capture');
const nevernessPredownload = require('./neverness-predownload');
const nteTool = require('./nte-tool');
const updater = require('./updater');
const { loadGachaMeta } = require('./gacha-meta');
const { ensureErasedBackground } = require('./background-clean');
// 启动页官方动态背景（星铁 / 绝区零 / 崩坏3 的官方 webm 都从这个接口按游戏取）。
// 之前这里漏了引用，调用处抛 ReferenceError 又被空 catch 吞掉，表现就是
// 「这些游戏一直没有动态背景，背景按钮也跟着消失」。
const { officialBackgrounds } = require('./start-artwork');
const { httpFetch, nodeRequest, setRequestLogger } = require('./http-fetch');
// node:https 的代理隧道：Chromium 栈自动吃系统代理但只有 6 条连接，
// node 能开 16 条却不认代理。这一层把两边补起来（顶层 require，要进打包清单）。
const proxyTunnel = require('./proxy-agent');
// 全局下载限速：所有下载链路共享一个带宽上限（用户要求「全统一」）
const netThrottle = require('./net-throttle');
// 运行诊断：网络请求留痕 + 一键导出。挂在 http-fetch 上，只记元数据不记内容。
const diagnostics = require('./diagnostics');
// 诊断报告里要写「当前内置的签名公钥是谁」，用同一个常量，避免两处各写一份对不上
const minisign = require('./minisign');
const { describeStorage, cleanGroup, cleanSafe } = require('./file-manager');
const { resolveLiveRoom } = require('./live-rooms');
const { startDanmaku, pollDanmaku, stopDanmaku } = require('./live-danmaku');
const {
  musicCharts,
  chartSongs,
  mergedCharts,
  mergedChartSongs,
  searchSongs,
} = require('./music-platforms');
const {
  accountPlaylists,
  accountPlaylistSongs,
  webMyPlaylists,
  webLikedSongs,
  withLikedPlaylist,
  LIKED_ID,
  looksExpired: musicLooksExpired,
  publicPlaza,
  publicPlaylistSongs,
  parseSharedPlaylistLink,
} = require('./music-playlists');
const gameFeatures = require('./game-features');
const miyoushe = require('./miyoushe-login');
const pluginHost = require('./plugin-host');
const postArt = require('./post-art');
const passport = require('./passport-login');
const skland = require('./skland');
const screenshotLib = require('./screenshots');
const graphicsConfig = require('./graphics-config');
const graphicsSchema = require('./graphics-schema');
const graphicsDetect = require('./graphics-detect');
const installManager = require('./install-manager');
const windowMaterial = require('./window-material');
const { resolvePlayableUrl, sameSongEnough } = require('./music-resolve');
const {
  resolveSourceUrl,
  fetchLyric: fetchSourceLyric,
  validateCustomSource,
  clearResolveCache: clearMusicResolveCache,
  normalizeSourceFlags,
  disabledSourceOfUrl,
  pickBest,
  kugouSearch,
  kugouSongUrl,
  qqSearch,
  qqSongUrl,
} = require('./music-source');
const {
  PLATFORM_CONFIG: MUSIC_LOGIN_CONFIG,
  platformConfig: musicPlatformConfig,
  pickCookies: pickMusicCookies,
  hasAll: musicCookiesReady,
  checkLogin: checkMusicLogin,
  loadMusicSession,
  cookieHeader,
  verifyMusicSession,
  LOGIN_CLICK_SCRIPT: MUSIC_LOGIN_CLICK_SCRIPT,
} = require('./music-login');

/** 当前打开的登录窗口句柄，供「我已登录」兜底按钮调用。 */
let activeMusicLogin = null;
/** 最近一次轮询读到的 cookie 概况，登录窗口侧边提示用。 */
let musicLoginDebug = null;
/** 音乐登录窗口专用的 preload（只要「我已登录」一个能力）。 */
const MUSIC_LOGIN_PRELOAD = path.join(__dirname, 'music-login-preload.js');
const { importUigf, importsPath } = require('./gacha-import');
// 抽卡记录云备份：纯逻辑模块（WebDAV 客户端 + 加密 + 合并），主进程只管配置与调度
const gachaBackup = require('./gacha-backup');
const { syncGacha, extractUrlFromCache, cacheFiles: gachaCacheFiles } = require('./gacha-sync');
const { syncEndfieldGacha } = require('./endfield-gacha');
const { getStarRailFps, setStarRailFps } = require('./starrail-fps');
const {
  updateEndfieldPacks,
  updateEndfieldProfile,
  // 渠道包不再随安装包分发（安装包瘦 632 MB）：切服前要预问体积、按需下载
  measureChannelPack,
  channelPackFilesReady,
  profileByDirectory,
  verifyArknightsSource,
  ARKNIGHTS_BILIBILI_PROFILE,
  ARKNIGHTS_BILIBILI_READY,
  ARKNIGHTS_OFFICIAL_PROFILE,
  ARKNIGHTS_OFFICIAL_READY,
  PROFILES: ENDFIELD_PACK_PROFILES,
  updateEndfieldGame,
  checkEndfieldGame,
  fetchLatest,
  profileForChannel,
  // 一键下载：终末地全新安装走官方分卷整包（7z 解压），找不到 7-Zip 时用 findSevenZip 判断
  downloadAndExtractSplit,
  findSevenZip,
} = require('./endfield-packs');

/** 按渠道拿官方最新版本信息（安装与更新页用）。 */
async function fetchLatestForChannel(channel) {
  const profile = profileForChannel(channel);
  if (!profile) throw new Error('没有对应的更新渠道');
  return fetchLatest(profile);
}
const { launchEndfield, launchEndfieldElevated } = require('./endfield-launch');
// 渲染后端（DX11 / DX12）：支持范围与参数口径都集中在 render-api.js，启动时拼在用户参数前面
const renderApi = require('./render-api');
const { prepareSophon, prepareBilibiliRuntime, normalizeAudioLanguages, fetchLauncherConfig } = require('./sophon');
const { applyHdiffPrepass } = require('./hdiff');
const predownload = require('./predownload');
// 预下载演练模式：官方没开预下载时也能把整条链路走完（见 predownload-sim.js 顶部）。
const predownloadSim = require('./predownload-sim');
const nevernessChannels = require('./neverness-channels');
/*
 * 明日方舟国际服（Yostar：EN / JP / KR）。
 *
 * 这三个区和国服是**完全两套客户端**：发行商不同（Yostar vs 鹰角/B站）、协议不同
 * （Yostar REST + CRC64 vs 鹰角加密分卷）、主程序不同，所以既不能走 profileForChannel
 * （那是鹰角清单），也不能像国服官服/B服那样从同一个安装目录硬链接拼出来。
 *
 * ⚠ 顶层 require —— 必须登记 H:\HXL-pack\pack.js 的 ASAR_MUST_HAVE，漏包=打开就崩。
 */
const yostarPacks = require('./yostar-packs');
// 进度计量器：给各条下载/更新链路补速度与剩余时间（纯计算，无 IO、无依赖）
const progressMeter = require('./progress-meter');

/*
 * Mirror酱（MirrorChyan）更新源。
 *
 * 它提供「版本查询 + CDN 加速下载」，接入不需要付费；用户侧自己买 CDK 才走
 * 它的加速，不填 CDK 仍能查到版本号、继续用我们原来的源下载。所以这里的定位是
 * 「可选加速 + 额外兜底」，绝不作为唯一更新源。
 *
 * ⚠ 顶层 require —— 必须登记 H:\HXL-pack\pack.js 的 ASAR_MUST_HAVE，漏包=打开就崩。
 */
const mirrorchyan = require('./mirrorchyan');

app.setName('花筱灵启动器');
/* AUMID 尾缀 .x1：Explorer 的任务栏图标缓存按 AUMID 键值存储，旧 ID
 * 'com.huaxiaoling.launcher' 上粘了一个坏结果（任务栏一直显示系统兜底
 * 白纸图标，重启 explorer / 清 iconcache 都冲不掉）。换新 ID 让它重新
 * 解析——窗口已显式设 icon（WM_SETICON 是最高优先级来源），新 ID 下必
 * 走窗口图标，必出 logo。 */
app.setAppUserModelId('com.huaxiaoling.launcher.x1');

/*
 * 截图缩略图用的自定义协议，必须在 ready 之前声明特权：
 * - standard: 让 URL 解析按标准规则走；
 * - stream: 大图直接流式返回，不整块进内存；
 * - supportFetchAPI: 渲染层用 <img src> 和 fetch 都能取。
 * 注意：protocol 是 electron 模块级导出，不是 app 的属性。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hxl-shot',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

if (process.argv.includes('--safe-mode')) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('no-sandbox');
}

// 仅供调试脚本使用：设了 HX_DEBUG_PORT 才开远程调试端口，平时无影响。
if (process.env.HX_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.HX_DEBUG_PORT));
}

function writeCrashLog(label, error) {
  try {
    const file = path.join(app.getPath('userData'), 'crash.log');
    const detail = error && error.stack ? error.stack : String(error || '');
    fs.appendFileSync(
      file,
      `[${new Date().toISOString()}] ${label} electron=${process.versions.electron || ''} win=${os.release()} arch=${process.arch}\n${detail}\n\n`,
      'utf8'
    );
  } catch {
    /* logging must never throw */
  }
  // 同一件事也进诊断缓冲：导出诊断时不必再去翻 crash.log 找时间点
  try {
    const firstLine = String((error && error.stack) || error || '')
      .split('\n')[0]
      .slice(0, 300);
    diagnostics.recordEvent('error', label, firstLine);
  } catch {
    /* 诊断模块自己出错也不能影响崩溃日志 */
  }
}

/*
 * 崩溃处理器必须挂在模块最顶部：启动器启动早期（store 初始化、提权重启分支）
 * 就有可能抛异常或收到子进程异步 error，注册晚了的话进程直接静默消失，
 * 用户看到的是「双击没反应」，crash.log 里却一个字都没有（真实事故，2026-10-29）。
 */
process.on('uncaughtException', (error) => {
  writeCrashLog('uncaughtException', error);
  console.error('Uncaught exception:', error);
});

/*
 * 网络请求留痕。注入点放在模块级而不是 ready 之后：启动早期的清单检查、
 * 封面 seed 也要能记上——「启动就失败」恰恰是最需要日志的那一类问题。
 */
setRequestLogger((entry) => diagnostics.recordRequest(entry));

process.on('unhandledRejection', (error) => {
  writeCrashLog('unhandledRejection', error);
  console.error('Unhandled rejection:', error);
});

/**
 * 便携模式：数据、下载、缓存全部放在启动器 exe 所在目录。
 *
 * - 打包后：<启动器目录>\data 与 <启动器目录>\downloads
 * - 开发时：项目根目录\data 与 \downloads
 * 如果目录不可写（比如放在 Program Files），自动退回到 AppData，避免启动失败。
 */
function resolvePortableRoot() {
  const base = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
  return base;
}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/*
 * 绝区零那 111 份「任务▶主线 / 空洞▶…」分类剧情资源（约 19.73GB）要不要一起下。
 * 默认关：不勾只是缺剧情动画，勾上多占近 20GB，交给用户决定。
 * 继承链：server → game → settings → false。
 *
 * 声明在模块顶层：安装 / 更新（prepareSophon）和预下载（predownload）几条路径都要用它，
 * 而且两边必须用同一个值，否则会出现「安装时不下、一更新就补 20GB」这种自相矛盾。
 */
function storyResourcesEnabled(game, server) {
  if (server && typeof server.includeStoryResources === 'boolean') return server.includeStoryResources;
  if (game && typeof game.includeStoryResources === 'boolean') return game.includeStoryResources;
  return store.data?.settings?.includeStoryResources === true;
}

/**
 * 同一台机器上别的渠道 / 别的目录的同一款游戏客户端 —— 可以当硬链接的源。
 *
 * 为什么需要：官方同一个构建产物的资源包是逐字节相同的。官服原神已经更到 7.2、
 * 国际服还停在 7.1 时，更新国际服要用的新文件其实已经躺在官服目录里了，直接
 * 硬链接过来就等于 0 下载，不必再为同一份内容走一遍网络。
 *
 * 只收「目录里确实有 exe」的行：路径被删掉 / 移动过的残留行不能当源，
 * 否则每次更新都要白白 stat 几千个不存在的路径。
 */
function externalLinkSources(game, server, targetRoot) {
  const target = targetRoot ? path.resolve(targetRoot).toLowerCase() : '';
  const out = [];
  const seen = new Set();
  /*
   * 明日方舟的 Yostar 三区（EN / JP / KR）和国服是**两套完全独立的客户端**：
   * 不仅 arknights.exe 不同，连 streamingassets 下同名 .ab 的内容都不一样
   * （实测 EN↔JP 有 421 个同路径不同哈希的文件）。把它们当硬链接源会做出
   * 「壳是国服、资源是日服」的混合体，所以这两个方向都要切断：
   *   · 目标是 Yostar 区 → 不拿国服 / B服 / 其它区当源
   *   · 目标是国服 / B服 → 不拿 Yostar 区当源
   * 同区之间（EN↔JP↔KR）也不当源：真要省空间得按 CRC64 逐文件比对，
   * 那是另一套镜像方案，不在当前「先跑通三区接入」的范围内。
   */
  const targetIsYostar = game.builtinKey === 'arknights' && yostarPacks.isYostarChannel(server.channel);
  for (const item of game.servers || []) {
    if (item.id === server.id) continue;
    if (!item.root || !item.path || !targetExists(item.path)) continue;
    if (game.builtinKey === 'arknights') {
      const itemIsYostar = yostarPacks.isYostarChannel(item.channel);
      if (targetIsYostar || itemIsYostar) continue;
    }
    const root = path.resolve(item.root);
    const key = root.toLowerCase();
    if (!key || key === target || seen.has(key)) continue;
    if (!fs.existsSync(root)) continue;
    // 官服 / B服 共用同一个目录是正常玩法，同一根目录只当一次源
    seen.add(key);
    out.push(root);
  }
  return out;
}

let portableRoot = '';
let portableData = '';
let portableDownloads = '';
try {
  const base = resolvePortableRoot();
  const dataDir = path.join(base, 'data');
  if (canWrite(dataDir)) {
    portableRoot = base;
    portableData = dataDir;
    portableDownloads = path.join(base, 'downloads');
    fs.mkdirSync(portableDownloads, { recursive: true });
    app.setPath('userData', portableData);
    try {
      app.setPath('crashDumps', path.join(portableData, 'crash-dumps'));
    } catch {
      /* ignore */
    }
  }
} catch {
  portableRoot = '';
}

/**
 * 从旧版本（AppData 目录）迁移用户数据。
 *
 * 只搬真正有价值的东西：配置、登录会话、封面、背景视频、抽卡元数据。
 * Chromium 缓存、sophon 下载缓存这类可重建的直接丢弃，避免又占几百 MB。
 * 迁移完成后在旧目录留一个 .migrated 标记，避免重复搬运。
 */
function migrateLegacyUserData() {
  if (!portableData) return;
  const legacy = path.join(process.env.APPDATA || '', '花筱灵启动器');
  if (!legacy || !fs.existsSync(legacy)) return;
  if (path.resolve(legacy) === path.resolve(portableData)) return;

  const marker = path.join(portableData, '.migrated-from-appdata');
  if (fs.existsSync(marker)) return;

  // 已经有自己的数据就不覆盖
  const hasOwnStore = fs.existsSync(path.join(portableData, 'launcher-data.json'));
  const FILES = [
    'launcher-data.json',
    'sessions.enc.json',
    'gacha-imports.json',
    'gacha-meta.json',
    'gacha-meta-v2.json',
    'gacha-meta-ext.json',
  ];
  const DIRS = ['covers', 'backgrounds'];
  let copied = 0;

  try {
    fs.mkdirSync(portableData, { recursive: true });
    for (const name of FILES) {
      const from = path.join(legacy, name);
      const to = path.join(portableData, name);
      if (!fs.existsSync(from)) continue;
      if (hasOwnStore && name === 'launcher-data.json') continue;
      if (fs.existsSync(to)) continue;
      try {
        fs.copyFileSync(from, to);
        copied += 1;
      } catch {
        /* 单个文件失败不影响其它 */
      }
    }
    for (const dir of DIRS) {
      const from = path.join(legacy, dir);
      if (!fs.existsSync(from)) continue;
      const to = path.join(portableData, dir);
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (fs.existsSync(dst)) continue;
        try {
          fs.copyFileSync(src, dst);
          copied += 1;
        } catch {
          /* ignore */
        }
      }
    }
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
    if (copied) console.log(`已从旧数据目录迁移 ${copied} 个文件`);
  } catch (error) {
    console.warn('旧数据迁移失败：', error.message);
  }
}

migrateLegacyUserData();

if (process.env.HX_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.HX_USER_DATA));
  try {
    app.setPath('crashDumps', path.resolve(process.env.HX_USER_DATA, 'crash-dumps'));
  } catch {
    /* ignore */
  }
  portableData = path.resolve(process.env.HX_USER_DATA);
  portableDownloads = '';
}

/**
 * 启动器自己的版本号。
 *
 * app.getVersion() 读的是 exe 的文件版本资源。便携版只要没重新编译 exe，
 * 覆盖 resources/app 之后它永远停在 1.0.0——1.6.3 那会儿的更新检查就是因为
 * 「远端 1.6.3 > 本地 1.0.0」每次都判成有更新，结果下载一个同名的新包原地打转。
 * 所以版本号以 resources/app/package.json 为准。
 */
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const version = String(pkg.version || '').trim().replace(/^v/i, '');
    if (/^\d+\.\d+\.\d+/.test(version)) return version;
  } catch {
    /* 读不到就退回 exe 的版本资源 */
  }
  return app.getVersion();
})();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/*
 * 清掉上次更新留下的旧主程序映像（花筱灵启动器.exe.updating）。
 *
 * 覆盖脚本自己就跑在这个 exe 上，Windows 不让写运行中的映像（EBUSY），只能先把自己改名让位、
 * 再把新 exe 写到原位置——改名出来的那份在本次更新进程退出前删不掉。
 * 不清理的话用户目录里会一直多一份 250 MB 的旧 exe，而且每更新一次多一份。
 * 现在跑的是新 exe，旧的没被任何进程占用，直接删得掉；删不掉（杀软还在扫）就留到下次。
 */
try {
  const parkedExe = `${process.execPath}.updating`;
  if (fs.existsSync(parkedExe)) fs.rmSync(parkedExe, { force: true });
} catch {
  /* 删不掉不影响启动 */
}

/*
 * 清掉上次更新挪到旁路上的其它文件（icudtl.dat、v8_context_snapshot.bin 这类
 * 被运行时占着、只能先改名让位的）。覆盖脚本把挪过的每一个都记进了
 * last-update.json 的 parkedFiles，照单删就行——不去扫目录猜，扫目录有把
 * 用户自己的文件当成残留误删的风险。还删不掉的留在单子里，下次启动再试。
 */
try {
  const marker = path.join(app.getPath('userData'), 'tmp', 'last-update.json');
  if (fs.existsSync(marker)) {
    const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const list = Array.isArray(record.parkedFiles) ? record.parkedFiles : [];
    const left = list.filter((file) => {
      try {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
        return false;
      } catch {
        return true;
      }
    });
    if (left.length !== list.length) {
      record.parkedFiles = left;
      fs.writeFileSync(marker, JSON.stringify(record, null, 2), 'utf8');
    }
  }
} catch {
  /* 删不掉不影响启动 */
}

const isDev = !app.isPackaged;
const ROOT = path.join(__dirname, '..');

/*
 * 任务栏 / 托盘 / 标题栏这些小尺寸地方用的图标。
 *
 * 不能直接拿 build/icon.png：那是 1024×1024 的整幅插画（全身立绘 + 底部「花筱灵」文字），
 * Windows 任务栏只给 24px 左右，缩下去就只剩一团粉色，用户根本认不出这是启动器。
 * 所以单独准备一张只保留人物头部特写的 icon-taskbar.png，16~48px 下都能看出是一张脸。
 * 整幅插画仍然用于关于页 / 更新弹窗等大尺寸场景。
 *
 * 注意：下面这两个（ICON_FULL / ICON_SMALL）只给托盘用，不要再拿去设 BrowserWindow 的 icon。
 * Electron 从单张 PNG 建出来的 nativeImage 只有一个尺寸，窗口一旦设了它，
 * Windows 就会拿这张 256 的图去缩任务栏要的 24px，缩完糊成一团。
 * 不设 icon 时，Windows 直接读 exe 资源里那套 16/20/24/32/40/48/64/96/128/256 的
 * 多档图标，按尺寸精确取用，小尺寸才认得出是花筱灵。详见 createWindow() 里的说明。
 */
const ICON_FULL = path.join(ROOT, 'build', 'icon.png');
const ICON_SMALL = path.join(ROOT, 'build', 'icon-taskbar.png');
const ICON = fs.existsSync(ICON_SMALL) ? ICON_SMALL : ICON_FULL;
/* 托盘专用：已经缩到 16×16 并锐化过，不要再 resize，否则等于把糊图又放大一次。 */
const ICON_TRAY = path.join(ROOT, 'build', 'icon-tray.png');

/**
 * 读图标。打包成 asar 之后 createFromPath 可能读不到，退回直接读 buffer，
 * 两条路都失败就返回空图（调用处会兜底），避免「图标路径在一个环境成立、另一个环境变白纸」。
 */
function loadIconImage(file) {
  try {
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  } catch {
    /* 继续尝试 buffer */
  }
  try {
    return nativeImage.createFromBuffer(fs.readFileSync(file));
  } catch {
    return nativeImage.createEmpty();
  }
}

/**
 * 窗口显式图标（1x=32px、2x=64px 双表示，均已按小尺寸锐化）。
 *
 * 必须显式设，不能指望 exe 图标自动回落：实测（探针取证，见
 * .workbuddy/memory/2026-10-29.md）不设 icon 时窗口只有类图标、没有
 * WM_SETICON，任务栏在 AppUserModelId 无对应快捷方式时走 Explorer 的
 * 图标缓存回落——缓存一旦粘了坏结果就一直是白纸，且不随 exe 更新刷新。
 * WM_SETICON 是 Explorer 实时读取的最高优先级来源，设了就绕开缓存。
 * 单张 256 大图会被缩糊，所以这里给 32/64 两档锐化小图。
 */
function loadWindowIcon() {
  const icon = nativeImage.createEmpty();
  const p32 = path.join(ROOT, 'build', 'icon-window-32.png');
  const p64 = path.join(ROOT, 'build', 'icon-window-64.png');
  try {
    if (fs.existsSync(p32)) icon.addRepresentation({ scaleFactor: 1, buffer: fs.readFileSync(p32) });
    if (fs.existsSync(p64)) icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(p64) });
  } catch {
    /* 落到兜底 */
  }
  return icon.isEmpty() ? loadIconImage(ICON) : icon;
}

let win = null;
let splashWindow = null;
// splash 真正 show 出来的时间戳。主窗亮起前要等它「显示过 + 至少 1050ms」，
// 不能只看 splashWindow 对象非空 —— 见 createWindow 里的 waitForSplash 闸门。
let splashShownAt = 0;
let tray = null;
let store = null;
let downloads = null;
let quitting = false;
/*
 * 右上角关闭键第一次被按时，主进程拦下 close 事件、问渲染层要「收托盘还是退出」。
 * 这个标志防止用户连点关闭时叠出第二个询问框（回答 / 取消后都会复位）。
 */
let closeAskPending = false;
let neteaseServiceProcess = null;
let pushTimer = null;

/** @type {Map<string, {pid:number, startedAt:number}>} */

/**
 * 截图缩略图白名单：只有「本次扫描出来的绝对路径」能通过 hxl-shot 协议读取，
 * 防止渲染层用任意路径读本机文件。每次 screenshots:list 时整体重建。
 */
const screenshotAllow = new Set();
const running = new Map();
// id -> 开始启动的时间戳。用 Map 而不是 Set：卡住的「正在启动中」也要能被清掉，
// 否则用户点了打开游戏没反应，重启流程还会一直说「正在启动中」。
const launching = new Map();
const processMonitors = new Map();

/** @type {Map<string, {cancelled:boolean}>} */
const linkJobs = new Map();
const sophonJobs = new Map();
const predownloadJobs = new Map();
let powerBlockerId = null;
let backgroundTasks = 0;

function beginBackgroundTask() {
  backgroundTasks += 1;
  if (powerBlockerId === null) {
    try {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } catch {
      powerBlockerId = null;
    }
  }
}

function endBackgroundTask() {
  backgroundTasks = Math.max(0, backgroundTasks - 1);
  if (backgroundTasks === 0 && powerBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerBlockerId);
    } catch {
      /* ignore */
    }
    powerBlockerId = null;
  }
}

function dataFile() {
  return path.join(app.getPath('userData'), 'launcher-data.json');
}

function secretFile() {
  return path.join(app.getPath('userData'), 'sessions.enc.json');
}

async function readSecrets() {
  try {
    return JSON.parse(await fsp.readFile(secretFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function loadSecret(name) {
  if (!safeStorage.isEncryptionAvailable()) return '';
  const secrets = await readSecrets();
  const encoded = secrets[name];
  if (!encoded) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return '';
  }
}

async function saveSecret(name, value) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const secrets = await readSecrets();
  if (value) secrets[name] = safeStorage.encryptString(String(value)).toString('base64');
  else delete secrets[name];
  await fsp.mkdir(path.dirname(secretFile()), { recursive: true });
  await fsp.writeFile(secretFile(), JSON.stringify(secrets), 'utf8');
  return true;
}

/* ---------------- 米游社多账号存储 ---------------- */

/*
 * 一个米游社通行证账号底下挂着四款游戏的角色，但一个人完全可能有多个通行证
 * （小号、家里人共用一台电脑）。所以登录态不能只存一条 cookie，得存成账号列表。
 *
 * 结构（版本 2）：
 *   { version: 2, activeId: '<账号 id>', accounts: [{ id, cookie, savedAt, roles, label }] }
 *
 * 账号 id 取 cookie 里的 ltuid_v2（通行证数字 id），同一个账号重新登录就覆盖
 * 而不是新增一条。
 *
 * 旧版本只存了 { cookie, savedAt } 一条，readHoyolabStore 会就地迁移成一条账号，
 * 用户升级后不需要重新登录。
 */
const HOYOLAB_STORE_VERSION = 2;

/** 从 cookie 里取通行证账号 id（ltuid_v2 优先）。 */
function hoyolabAccountId(cookieStr) {
  return (
    miyoushe.cookieValue(cookieStr, 'ltuid_v2') ||
    miyoushe.cookieValue(cookieStr, 'ltuid') ||
    miyoushe.cookieValue(cookieStr, 'account_id_v2') ||
    miyoushe.cookieValue(cookieStr, 'account_id') ||
    ''
  );
}

/** 账号显示名：优先角色昵称，其次 UID，最后退回账号 id 尾号。 */
function hoyolabAccountLabel(account) {
  const roles = Array.isArray(account.roles) ? account.roles : [];
  const named = roles.find((role) => role && role.nickname);
  if (named) return named.nickname;
  const withUid = roles.find((role) => role && role.uid);
  if (withUid) return `UID ${withUid.uid}`;
  return account.id ? `账号 ${String(account.id).slice(-6)}` : '米游社账号';
}

/** 给渲染层看的账号信息 —— 一定不含 cookie。 */
function publicHoyolabAccount(account) {
  return {
    id: account.id,
    label: hoyolabAccountLabel(account),
    savedAt: account.savedAt || 0,
    roles: Array.isArray(account.roles) ? account.roles : [],
  };
}

async function readHoyolabStore(providerId) {
  const empty = { version: HOYOLAB_STORE_VERSION, accounts: [], activeId: '' };
  const raw = await loadSecret(`hoyolab-${providerId}`);
  if (!raw) return empty;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;

  // 旧格式迁移：{ cookie, savedAt }
  if (typeof parsed.cookie === 'string' && parsed.cookie && !Array.isArray(parsed.accounts)) {
    const account = {
      id: hoyolabAccountId(parsed.cookie) || 'legacy',
      cookie: parsed.cookie,
      savedAt: Number(parsed.savedAt) || 0,
      roles: [],
      label: '',
    };
    return { version: HOYOLAB_STORE_VERSION, accounts: [account], activeId: account.id };
  }

  const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : [])
    .filter((account) => account && typeof account.cookie === 'string' && account.cookie)
    .map((account) => ({
      id: String(
        account.id || hoyolabAccountId(account.cookie) || `a${Math.random().toString(36).slice(2, 8)}`
      ),
      cookie: account.cookie,
      savedAt: Number(account.savedAt) || 0,
      roles: Array.isArray(account.roles) ? account.roles : [],
      label: String(account.label || ''),
    }));

  // 按 id 去重（历史上可能把同一个账号写了两条）
  const seen = new Set();
  const unique = [];
  for (const account of accounts) {
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    unique.push(account);
  }

  const activeId = unique.some((account) => account.id === parsed.activeId)
    ? parsed.activeId
    : unique[0]?.id || '';
  return { version: HOYOLAB_STORE_VERSION, accounts: unique, activeId };
}

async function writeHoyolabStore(providerId, store) {
  await saveSecret(`hoyolab-${providerId}`, JSON.stringify(store));
}

/** 取某个账号：指定 id > 当前激活 > 第一个。 */
function pickHoyolabAccount(store, accountId) {
  const wanted = String(accountId || '');
  if (wanted) {
    const found = store.accounts.find((account) => account.id === wanted);
    if (found) return found;
  }
  return store.accounts.find((account) => account.id === store.activeId) || store.accounts[0] || null;
}

/** 校验并刷新某个账号缓存的角色列表（失败时保留旧列表，只带出原因）。 */
async function verifyHoyolabAccount(account, providerId) {
  try {
    const result = await miyoushe.verifyCookie(account.cookie, providerId);
    if (result.ok && Array.isArray(result.roles)) {
      account.roles = result.roles;
      account.savedAt = account.savedAt || Date.now();
    }
    return { ok: Boolean(result.ok), roles: account.roles || [], reason: result.ok ? '' : result.reason || '' };
  } catch (error) {
    return { ok: false, roles: account.roles || [], reason: String(error?.message || error) };
  }
}

function bundledEndfieldPackRoot() {
  for (const candidate of [
    path.join(process.resourcesPath || '', 'endfield-packs'),
    path.join(__dirname, '..', 'endfield-packs'),
  ]) {
    try {
      if (fs.existsSync(path.join(candidate, 'EndOfficial', 'U8Data'))) return candidate;
    } catch {
      /* ignore */
    }
  }
  return '';
}

/**
 * 渠道包根目录：内置包优先，其次扫描各磁盘上常见的 XelLauncher / 启动器缓存目录。
 * 这些探测都在启动时自动完成，用户不需要手动指定。
 */
function endfieldPackCandidates() {
  const list = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (const rel of [
      'XelLauncher\\load',
      'XelLauncher',
      'Games\\XelLauncher\\load',
      'Program Files\\XelLauncher\\load',
      'HuaXiaoLing\\endfield-packs',
    ]) {
      list.push(`${letter}:\\${rel}`);
    }
  }
  if (process.env.USERPROFILE) {
    list.push(path.join(process.env.USERPROFILE, 'XelLauncher', 'load'));
    list.push(path.join(process.env.USERPROFILE, 'Documents', 'XelLauncher', 'load'));
  }
  if (process.env.LOCALAPPDATA) {
    list.push(path.join(process.env.LOCALAPPDATA, 'XelLauncher', 'load'));
    list.push(path.join(process.env.LOCALAPPDATA, 'HuaXiaoLing', 'endfield-packs'));
  }
  // 自己下载/更新出来的目录也认
  try {
    list.push(path.join(app.getPath('userData'), 'endfield-packs'));
  } catch {
    /* app 尚未 ready */
  }
  return list;
}

function looksLikePackRoot(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    // 渠道包目录的特征：有 EndOfficial/EndBilibili 之一，且带 U8Data
    for (const name of ['EndOfficial', 'EndBilibili', 'EndGlobal', 'EndPlay', 'EndSteam']) {
      if (fs.existsSync(path.join(dir, name, 'U8Data'))) return true;
    }
    // 或者本身就是 load 目录，下面还有一层
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some(
      (entry) =>
        entry.isDirectory() &&
        /^End/i.test(entry.name) &&
        fs.existsSync(path.join(dir, entry.name, 'U8Data'))
    );
  } catch {
    return false;
  }
}

function detectEndfieldPackRoot() {
  const bundled = bundledEndfieldPackRoot();
  if (bundled) return bundled;
  for (const candidate of endfieldPackCandidates()) {
    if (looksLikePackRoot(candidate)) return candidate;
  }
  return '';
}

/** Starward 数据库：扫描各磁盘的常见安装位置。 */
function starwardDbCandidates() {
  const list = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (const rel of [
      'Starward\\StarwardDatabase.db',
      'Starward\\data\\StarwardDatabase.db',
      'Program Files\\Starward\\StarwardDatabase.db',
      'Games\\Starward\\StarwardDatabase.db',
    ]) {
      list.push(`${letter}:\\${rel}`);
    }
  }
  if (process.env.LOCALAPPDATA) {
    list.push(path.join(process.env.LOCALAPPDATA, 'Starward', 'StarwardDatabase.db'));
  }
  if (process.env.APPDATA) {
    list.push(path.join(process.env.APPDATA, 'Starward', 'StarwardDatabase.db'));
  }
  if (process.env.USERPROFILE) {
    list.push(path.join(process.env.USERPROFILE, 'Starward', 'StarwardDatabase.db'));
    list.push(path.join(process.env.USERPROFILE, 'Documents', 'Starward', 'StarwardDatabase.db'));
  }
  return list;
}

function detectStarwardDbPath() {
  for (const candidate of starwardDbCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return '';
}

function defaultSettings() {
  return {
    profileName: '大小姐',
    avatar: '',
    theme: 'dark',
    accent: 'spark',
    // 窗口材质：none / acrylic / mica / micaTabbed / auto
    material: 'none',
    // 自定义背景图（data URL 或本地 backgrounds/ 下的相对路径）
    customBackground: '',
    // 自定义背景不透明度 0-100：数值越低越透明，能看到更多系统材质
    backgroundOpacity: 100,
    // 背景图清晰度 0-100：100 为原图，越低越模糊（用来让内容更易读）
    backgroundBlur: 0,
    // 背景动态效果：缓慢运镜 + 鼠标视差 + 换图溶解，关掉就是一张静止的图
    backgroundMotion: true,
    // 官方背景轮播：每 26 秒换下一张官方主视觉（只对官方同步下来的图生效）
    backgroundRotate: true,
    sidebarCollapsed: true,
    uiRevision: 2,
    // 界面缩放：100% 为原始大小，范围 80% - 130%
    uiScale: 100,
    quickPanelPinned: false,
    alwaysAdmin: null,
    // 是否已经就「开游戏要管理员」问过一次：只问一次，选过就按选过的走
    elevationAsked: false,
    // 用户在上一次 UAC 弹窗里点了「否」。记住这个选择，
    // 不要每次冷启动都再弹一次授权（否则启动器一开就被拦住）。
    // 在设置里重新打开「总是以管理员身份运行」会把它清掉。
    elevationDeclined: false,
    nevernessUseOfficialLauncher: true,
    closeToTray: true,
    /*
     * 关闭按钮的行为，用户第一次点关闭时由那个询问框写入：
     * 'tray' = 收进托盘，'quit' = 退出程序，null = 还没选过（要问一次）。
     * closeToTray 保留下来给设置页的开关用，两者由同一处逻辑同步写入。
     */
    closeAction: null,
    launchAtLogin: false,
    minimizeOnLaunch: true,
    autoSyncOfficial: true,
    /*
     * 终末地渠道包的自动更新：null = 还没切过服，不自动更新（本机也没包可更新）；
     * true = 切过服，自动跟着官方更新；false = 用户手动关掉。
     * 只在明确 true 时才跑，undefined / null 一律不动手。
     */
    autoUpdateEndfieldPacks: null,
    /*
     * 明日方舟渠道包的自动更新：和上面那条同一套三态，但**分开一个键**。
     * 两个游戏的包互不相干，一个开关管两边会让「只玩终末地」的人也被拉去查方舟清单。
     */
    autoUpdateArknightsPacks: null,
    hasSwitchedServer: false,
    autoGacha: true,
    // 终末地语音包：只下勾中的语言。默认只要中文，多勾一种就多占好几个 GB。
    audioLanguages: ['zh-cn'],
    /*
     * 剧情等分类资源包：绝区零的 build 里除了 game + 语音，还有 111 份
     * 「任务▶主线」「任务▶个人线」「系统▶影像档案」「任务▶OVA」「空洞▶…」分类包，
     * 合计 19.73GB / 2068 个文件，与 game 清单互斥（0 个文件重叠）。
     * 默认不勾 —— 不勾只是缺剧情动画，勾上多占近 20GB，用户自己决定。
     * 可以按服务器单独覆盖：server.includeStoryResources。
     */
    includeStoryResources: false,
    /*
     * ldiff 增量加速：更新时先尝试用官方 hdiff 补丁就地修补文件，再走 chunk 校验补齐。
     * 原神 7.0.0 → 7.1.0 实测省流 30.86GB（76.8%），所以默认开。
     * 但它会**在正式更新过程中就地改写游戏文件**，一旦更新中途断了，
     * 目录里会留下「已修补 + 未修补」的混合状态（和 chunk 模式中途失败同一性质，
     * 靠「检查完整资源」修复）。介意这一点的可以在这里关掉，退回纯 chunk。
     *
     * 是否真的跑，判据是「官方给没给你当前版本的补丁」（applyHdiffPrepass 里按
     * diff_tags 判），与官方配置里的 enable_ldiff 无关 —— Starward 声明了那个字段
     * 却从没读过，Collapse 连字段都没解析。没有补丁的渠道（崩坏3）会在扫盘前就以
     * version-not-patchable 退出，不会白算一轮 md5。
     */
    enableLdiff: true,
    /*
     * 下载限速（单位 KB/s，0 = 不限速）。
     *
     * 为什么需要：几条下载链路的吞吐差得很远，最快的能把宽带整条吃满——
     * 终末地国际服差异包实测 127.8 MB/s，等于 1 Gbps 满载，同一条宽带下
     * 别人看视频必然卡。这里给一个全局上限，所有下载链路（启动器自更新、
     * 米哈游更新/预下载、终末地渠道包/差异包）共享同一个配额。
     *
     * 用 KB/s 而不是 MB/s：界面上要能设到「1 MB/s」以下的细档，用 KB 存整数
     * 最简单，也避免浮点数在存储里反复乘除。
     */
    downloadLimitKBps: 0,
    // 自更新：清单地址留空则不检查；支持 https / 局域网共享 / 本地路径
    updateManifest: '',
    /*
     * 更新源模式。界面上是个下拉：
     *   auto        自动（默认）—— Mirror酱 的 RID 和 CDK 都填了才去测它，
     *               否则按 gitee 那条顺序走我们自己的源。这是默认值，也是绝大多数
     *               用户该用的模式：没配 Mirror酱 时行为和以前一模一样。
     *   mirrorchyan 只用 Mirror酱（测不通会明说原因，不静默回退，方便排查配置）
     *   gitee / jsdelivr / github  锁定我们内置的某一条，便于用户绕开被卡的线路
     *   custom      只用下面手填的地址（内网共享、自建静态站点）
     * 不论哪种模式，Mirror酱 只在「能拿到带 sha256 的下载地址」时才真正接管下载，
     * 拿不到就回到我们自己的源——它不该变成单点。
     */
    updateSourceMode: 'auto',
    /*
     * Mirror酱 资源 ID（RID，API 里的 res_id）。由 Mirror酱 官方随接入方案分配，
     * 不等于仓库名，所以留空＝没接入，整套逻辑直接跳过。拿到之后填在这里就行，
     * 不用改代码。
     */
    mirrorchyanRid: '',
    /*
     * 用户的 Mirror酱 CDK：不填也能查版本（只是拿不到加速下载地址）。
     * 是凭证所以只进主进程、不进日志、不进导出诊断；界面上按掩码显示。
     */
    mirrorchyanCdk: '',
    autoCheckUpdate: true,
    /*
     * 网络代理：只影响启动器自己发出的请求（更新清单、更新包、封面、公告），
     * 改的是 Chromium 的内存配置，不写系统代理、不碰注册表，退出即还原。
     * 留空＝直连。填 `http://127.0.0.1:7890` 这种本地代理地址即可。
     */
    proxyRules: '',
    // 更新公告弹窗已经弹过的版本号；空串表示这次升级还没看，启动时弹一次
    notesSeenVersion: '',
    // 「发现新版本」点了「稍后再说」的推迟状态：同一版本在 updateSnoozeUntil 之前不再自动弹
    updateSnoozeVersion: '',
    updateSnoozeUntil: 0,
    /*
     * 最近一次「清单签名验过」的版本号。只在主进程里读写，界面不展示也不改。
     * 作用：一旦验签成功过，之后没签名的清单就不许再用（防止有人把 sig 删掉绕过）。
     */
    updateSignedVersion: '',
    /*
     * 自动检查更新失败时的「已经提示过」记录。
     *
     * 自动那次检查以前是彻底静默的：清单读不到、源被墙、清单没签名被拦，界面上
     * 一律只是「已是最新」，用户反馈过来只剩「自动更新没用」一句话，连卡在哪
     * 一步都不知道。现在第一次失败会明说一次，但同一条错误 24 小时内不再重复，
     * 免得拔网线开机每次弹红字。
     */
    updateFailNoticeText: '',
    updateFailNoticeAt: 0,
    endfieldPackRoot: detectEndfieldPackRoot(),
    // 本机实际已有的渠道包（官服 / B服 / 国际服 / Play / Steam），界面按它显示
    // 「缺哪个会在切过去时自动补下」，避免用户以为渠道包没被识别。
    endfieldPackChannels: [],
    arknightsPackChannels: [],
    starwardDbPath: detectStarwardDbPath(),
    runtimeRoot: '',
    // 默认下载目录：固定在启动器自身文件夹内的「花筱灵下载」专门子目录，
    // 既不会和系统下载/桌面混在一起，也不会把启动器自身资源（src、electron、assets 等）放进去。
    // 用户仍可在设置里自定义；首次使用会由主进程自动创建这个空目录。
    downloadDir: path.join(resolvePortableRoot(), '花筱灵下载'),
    lastPage: 'home',
    /*
     * 抽卡记录云备份（WebDAV）。
     *
     * 只存地址、账号和一个周期常量，密码与加密口令走 safeStorage
     * （sessions.enc.json，键名见 GACHA_BACKUP_PASSWORD_KEY / _SECRET_KEY），
     * 这里一个明文字符串都不留。
     *
     * 没有 intervalHours：周期固定 7 天（GACHA_BACKUP_INTERVAL_MS），
     * 做成可调只会让人反复纠结要不要缩短，抽卡记录本来就该攒一批再传。
     */
    gachaBackup: {
      enabled: false,
      url: '',
      username: '',
      keep: 5,
      lastAt: 0,
      // 上次的结果文案 / 错误，界面上直接显示，不用再点一次才知道发生了什么
      lastResult: '',
      lastError: '',
    },
  };
}

function createStore() {
  return new JsonStore(dataFile(), {
    version: 1,
    seedVersion: 0,
    seeded: false,
    lastOfficialSync: 0,
    settings: defaultSettings(),
    games: [],
    hiddenBuiltins: [],
    downloads: [],
    stats: {
      launches: 0,
      playSeconds: 0,
    },
    // 主窗口位置 / 尺寸 / 最大化状态记忆：每台电脑的屏幕不一样，
    // 启动时按 initialWindowBounds 还原，超出的部分按当前屏夹取。
    window: { width: 0, height: 0, x: -1, y: -1, maximized: false },
  });
}

/* ---------------- 我的歌单：本地磁盘缓存 ---------------- */

/*
 * 「我的歌单」原来只活在渲染进程内存里：关掉启动器再开，四家平台又得从头拉一遍，
 * 网络慢的时候要干等十几秒才看到卡片墙，酷狗那边还可能直接超时。
 * 这里落一份缓存到 userData/playlists-cache.json：
 *
 *   { version, savedAt, accounts: { 平台: 账号标识 }, groups: { 平台: {...} } }
 *
 * 只存歌单墙的元数据（id / 名字 / 封面 / 曲目数 / 作者），不存曲目详情 ——
 * 曲目动辄上千首，全存下来文件会胀到几 MB，而点进歌单现拉也就一两秒。
 * accounts 用来防串号：换了账号登录，账号标识对不上的那一组直接丢弃。
 */
const PLAYLIST_CACHE_PLATFORMS = ['netease', 'qq', 'kugou', 'kuwo'];
// 单平台最多缓存多少张歌单；封面 URL 超过这个长度（内联 base64）就不存了，卡片退回默认图标
const PLAYLIST_CACHE_MAX_ITEMS = 600;
const PLAYLIST_CACHE_MAX_COVER = 512;

let playlistCacheStore = null;

function playlistCacheFile() {
  return path.join(app.getPath('userData'), 'playlists-cache.json');
}

function playlistCache() {
  if (!playlistCacheStore) {
    playlistCacheStore = new JsonStore(playlistCacheFile(), {
      version: 1,
      savedAt: 0,
      accounts: {},
      groups: {},
    });
  }
  return playlistCacheStore;
}

/** 落盘前瘦身：只留卡片墙要用的字段，脏数据一律转成安全值。 */
function slimCachedPlaylists(group) {
  const list = Array.isArray(group?.list) ? group.list : [];
  const items = [];
  for (const item of list.slice(0, PLAYLIST_CACHE_MAX_ITEMS)) {
    const id = String(item?.id ?? '').trim();
    if (!id) continue;
    const rawCover = String(item?.cover || '');
    items.push({
      id,
      name: String(item?.name || ''),
      cover: rawCover && rawCover.length <= PLAYLIST_CACHE_MAX_COVER ? rawCover : '',
      count: Number(item?.count) || 0,
      creator: String(item?.creator || ''),
      playcount: Number(item?.playcount) || 0,
      plaza: Boolean(item?.plaza),
      subscribed: Boolean(item?.subscribed),
      /*
       * imported 必须存：冷启动时未登录的平台只捞回链接导入的歌单，
       * 全靠这个标记过滤；丢了它，导入的歌单会在重启后既显示成「自建歌单」，
       * 也失去卡片上的移除按钮。
       */
      imported: Boolean(item?.imported),
    });
  }
  return {
    platform: String(group?.platform || ''),
    label: String(group?.label || ''),
    ok: Boolean(group?.ok),
    error: String(group?.error || ''),
    stale: Boolean(group?.stale),
    syncedAt: Number(group?.syncedAt) || 0,
    durationMs: Number(group?.durationMs) || 0,
    list: items,
  };
}

function coverUrl(cover) {
  if (!cover) return null;
  if (/^(data:|https?:)/i.test(cover)) return cover;
  try {
    return pathToFileURL(path.isAbsolute(cover) ? cover : path.join(app.getPath('userData'), cover)).href;
  } catch {
    return null;
  }
}

/* 启动页背景专用 URL：带上文件 mtime 做版本号。
   去字图（-clean3）是后台异步生成的，文件名固定不变；如果前端在文件生成前
   就已经把同一个 URL 加载失败过，Chromium 会一直沿用那次失败状态，
   即使文件后来写好了也不会重试 —— 表现就是启动页背景全黑。
   拼上 mtime 后文件一更新 URL 就变，前端自然会重新拉取。 */
function startCoverUrlOf(cover) {
  const base = coverUrl(cover);
  if (!base) return base;
  if (/^(data:|https?:)/i.test(cover)) return base;
  try {
    const absolute = path.isAbsolute(cover) ? cover : path.join(app.getPath('userData'), cover);
    const stat = fs.statSync(absolute);
    return `${base}?v=${Math.round(stat.mtimeMs)}`;
  } catch {
    return base;
  }
}

function targetExists(target) {  if (!target) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return true;
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

// 展示派生字段专用：同一路径 1.5 秒内不重复 statSync，避免每次推状态
// 都对外接盘/网络盘做几十次同步 stat。实时校验（选路径、启动前）仍走
// targetExists()，不要替换那 34 处。
const targetExistsCache = new Map();
function targetExistsCached(target) {
  if (!target) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return true;
  const now = Date.now();
  const hit = targetExistsCache.get(target);
  if (hit && now - hit.at < 1500) return hit.value;
  const value = targetExists(target);
  targetExistsCache.set(target, { at: now, value });
  if (targetExistsCache.size > 200) targetExistsCache.clear();
  return value;
}

/*
 * 米哈游四款（原神 / 星铁 / 绝区零 / 崩3）切服时由 prepare*Runtime 生成的
 * 独立硬链接运行时，落在 <盘>:\VelaRuntimes\<game>\<channel>，是完整客户端、
 * 不是「资源替换包」。终末地也在 VelaRuntimes 下，但它有自己那一整套
 * endfieldChannelOf / isEndfieldRuntimeDir 链路，这里绝不碰终末地。
 */
const MIHOYO_RUNTIME_KEYS = ['genshin', 'starrail', 'zzz', 'bh3'];

/*
 * 这个目录是不是米哈游四款切服生成的独立硬链接运行时。
 * 默认落在 <盘>:\VelaRuntimes\<game>\<channel>；用户在设置里自定义过运行时根
 * （settings.runtimeRoot）时则是 <自定义根>\<game>\<channel>。两处都要认：
 * 只认默认布局时，自定义根下生成的运行时既扫不回启动器，又会在启动扫描里
 * 被当成「资源替换包」标成需要重建、切服被拦（对抗性复核 P1-2）。
 * 终末地也在 VelaRuntimes 下，靠 gameKey 白名单挡住，绝不碰它那套链路。
 */
function isMihoyoRuntimeDir(dir, gameKey) {
  if (!MIHOYO_RUNTIME_KEYS.includes(gameKey) || !dir) return false;
  const parts = path.resolve(dir).toLowerCase().split(/[\\/]/);
  const i = parts.lastIndexOf('velaruntimes');
  if (i >= 0 && parts[i + 1] === gameKey.toLowerCase()) return true;
  const configured = String(store.data.settings.runtimeRoot || '').trim();
  if (!configured) return false;
  const norm = path.resolve(dir).toLowerCase();
  const custom = path.resolve(configured, gameKey).toLowerCase();
  return norm === custom || norm.startsWith(custom + path.sep);
}

/*
 * 读一个 exe「自己声明」的渠道：config.ini 优先、目录名兜底。
 * 展示派生字段和自动检测都要用，config.ini 可能是 UTF-16，解码一遍不便宜，
 * 所以同一路径 2 秒内复用结果（与 targetExistsCached 同思路）。
 * 返回 { config, path }，两者都可能为空 —— 空表示「认不出来」，绝不瞎猜官服。
 */
const declaredChannelCache = new Map();
function declaredChannelOf(exePath) {
  if (!exePath) return { config: '', path: '' };
  const now = Date.now();
  const hit = declaredChannelCache.get(exePath);
  if (hit && now - hit.at < 2000) return hit.value;
  const value = {
    config: clientChannel.configChannelFromPath(exePath),
    path: clientChannel.pathChannelHint(exePath),
  };
  declaredChannelCache.set(exePath, { at: now, value });
  if (declaredChannelCache.size > 200) declaredChannelCache.clear();
  return value;
}

/*
 * 展示层判据：这一行服务器到底算不算「有可用客户端」。
 *
 * 光有 exe 还不够：米哈游三件套里 B服/国际服若 path 还指着官服目录（独立硬链接
 * 运行时没生成），就不该算这一服可用 —— 界面不该显示绿点，也不该显示「与官服
 * 共用目录」。用户手动确认过的行（server.confirmed）永远尊重用户选择。
 * 终末地那项「有官服本体当基础就算可切换」是自愈专用，原样保留在第二分支。
 */
function serverExistsForView(game, server, endfieldHasBase) {
  const declared = declaredChannelOf(server.path);
  const strongest = declared.config || declared.path;
  const channelOk =
    server.confirmed ||
    !strongest ||
    strongest === server.channel ||
    (String(server.channel).startsWith('global') && strongest === 'global');
  if (!channelOk) return false;
  return (
    targetExistsCached(server.path) ||
    (endfieldHasBase &&
      game.builtinKey === 'endfield' &&
      server.channel !== 'official' &&
      ENDFIELD_PACK_NAMES[server.channel] != null)
  );
}

const GAME_DETECTION = {  genshin: {
    exe: 'YuanShen.exe',
    registry: [
      'HKCU\\Software\\miHoYo\\原神',
      'HKCU\\Software\\miHoYo\\Genshin Impact',
      'HKLM\\SOFTWARE\\miHoYo\\原神',
      'HKLM\\SOFTWARE\\WOW6432Node\\miHoYo\\原神',
      'HKCU\\Software\\miHoYo\\HYP',
    ],
    paths: [
      'Genshin Impact\\Genshin Impact Game\\YuanShen.exe',
      'Genshin Impact Game\\YuanShen.exe',
      'GenshinImpact Game\\YuanShen.exe',
      'GenshinImpact\\GenshinImpact Game\\YuanShen.exe',
      'miHoYo\\Genshin Impact\\Genshin Impact Game\\YuanShen.exe',
      'HoYoPlay\\games\\Genshin Impact Game\\YuanShen.exe',
      'Games\\Genshin Impact\\Genshin Impact Game\\YuanShen.exe',
      'Games\\Genshin Impact Game\\YuanShen.exe',
    ],
    relative: ['YuanShen.exe', 'Genshin Impact Game\\YuanShen.exe', 'Game\\YuanShen.exe'],
  },
  starrail: {
    exe: 'StarRail.exe',
    registry: [
      'HKCU\\Software\\miHoYo\\崩坏：星穹铁道',
      'HKCU\\Software\\miHoYo\\Honkai: Star Rail',
      'HKLM\\SOFTWARE\\miHoYo\\崩坏：星穹铁道',
      'HKLM\\SOFTWARE\\WOW6432Node\\miHoYo\\崩坏：星穹铁道',
      'HKCU\\Software\\miHoYo\\HYP',
    ],
    paths: [
      'Star Rail\\Game\\StarRail.exe',
      'Star Rail\\StarRail.exe',
      'miHoYo\\Star Rail\\Game\\StarRail.exe',
      'HoYoPlay\\games\\Star Rail Game\\StarRail.exe',
      'Games\\Star Rail\\Game\\StarRail.exe',
    ],
    relative: ['StarRail.exe', 'Game\\StarRail.exe'],
  },
  zzz: {
    exe: 'ZenlessZoneZero.exe',
    registry: [
      'HKCU\\Software\\miHoYo\\绝区零',
      'HKCU\\Software\\miHoYo\\Zenless Zone Zero',
      'HKLM\\SOFTWARE\\miHoYo\\绝区零',
      'HKLM\\SOFTWARE\\WOW6432Node\\miHoYo\\绝区零',
      'HKCU\\Software\\miHoYo\\HYP',
    ],
    paths: [
      'ZenlessZoneZero Game\\ZenlessZoneZero.exe',
      'Zenless Zone Zero Game\\ZenlessZoneZero.exe',
      'miHoYo\\ZenlessZoneZero Game\\ZenlessZoneZero.exe',
      'HoYoPlay\\games\\ZenlessZoneZero Game\\ZenlessZoneZero.exe',
      'Games\\ZenlessZoneZero Game\\ZenlessZoneZero.exe',
    ],
    relative: ['ZenlessZoneZero.exe', 'Game\\ZenlessZoneZero.exe'],
  },
  neverness: {
    exe: 'HTGame.exe',
    registry: [
      'HKCU\\Software\\PerfectWorld\\异环',
      'HKCU\\Software\\Perfect World\\NTE',
      'HKLM\\SOFTWARE\\PerfectWorld\\异环',
      'HKLM\\SOFTWARE\\WOW6432Node\\PerfectWorld\\异环',
    ],
    paths: [
      'Neverness To Everness\\Client\\WindowsNoEditor\\HT\\Binaries\\Win64\\HTGame.exe',
      '异环\\Client\\WindowsNoEditor\\HT\\Binaries\\Win64\\HTGame.exe',
      'NTE\\Client\\WindowsNoEditor\\HT\\Binaries\\Win64\\HTGame.exe',
      'Perfect World\\异环\\Client\\WindowsNoEditor\\HT\\Binaries\\Win64\\HTGame.exe',
      'Games\\异环\\Client\\WindowsNoEditor\\HT\\Binaries\\Win64\\HTGame.exe',
      'Games\\Neverness To Everness\\Client\\WindowsNoEditor\\HT\\Binaries\\Win64\\HTGame.exe',
    ],
    relative: [
      'HTGame.exe',
      'Client\\WindowsNoEditor\\HT\\Binaries\\Win64\\HTGame.exe',
      'HT\\Binaries\\Win64\\HTGame.exe',
      'WindowsNoEditor\\HT\\Binaries\\Win64\\HTGame.exe',
    ],
  },
  endfield: {
    exe: 'Endfield.exe',
    registry: [
      'HKCU\\Software\\Hypergryph\\Endfield',
      'HKCU\\Software\\Hypergryph\\Launcher',
      'HKLM\\SOFTWARE\\Hypergryph\\Endfield',
      'HKLM\\SOFTWARE\\WOW6432Node\\Hypergryph\\Endfield',
    ],
    paths: [
      'Arknights Endfield\\Endfield.exe',
      'Endfield\\Endfield.exe',
      'Hypergryph\\Arknights Endfield\\Endfield.exe',
      'Games\\Arknights Endfield\\Endfield.exe',
    ],
    relative: ['Endfield.exe', 'PlatformProcess.exe'],
  },
  // 2.4.0 合并自对方分支：崩坏3 检测（BH3.exe + 常见安装路径 + 注册表）
  bh3: {
    exe: 'BH3.exe',
    registry: [
      'HKCU\\Software\\miHoYo\\崩坏3',
      'HKCU\\Software\\miHoYo\\Honkai Impact 3rd',
      'HKLM\\SOFTWARE\\miHoYo\\崩坏3',
      'HKLM\\SOFTWARE\\WOW6432Node\\miHoYo\\崩坏3',
      'HKCU\\Software\\miHoYo\\HYP',
    ],
    paths: [
      'Honkai Impact 3rd\\BH3.exe',
      'HonkaiImpact3\\BH3.exe',
      '崩坏3\\BH3.exe',
      'BH3\\BH3.exe',
      'miHoYo\\Honkai Impact 3rd\\BH3.exe',
      'HoYoPlay\\games\\Honkai Impact 3rd\\BH3.exe',
      'Games\\Honkai Impact 3rd\\BH3.exe',
      'Honkai Impact 3rd Game\\BH3.exe',
      // 官方安装器按 game_biz 命名，常见就是盘根目录下的 bh3_cn / bh3_global
      'bh3_cn\\BH3.exe',
      'bh3_global\\BH3.exe',
    ],
    relative: ['BH3.exe', '..\\BH3.exe'],
  },
  // 2.4.0 合并自对方分支：明日方舟 PC 端检测（安装目录默认 <盘>\Arknights）
  arknights: {
    exe: 'Arknights.exe',
    registry: [
      'HKCU\\Software\\Hypergryph\\Arknights',
      'HKCU\\Software\\Hypergryph\\Launcher',
      'HKLM\\SOFTWARE\\Hypergryph\\Arknights',
      'HKLM\\SOFTWARE\\WOW6432Node\\Hypergryph\\Arknights',
    ],
    paths: [
      'Arknights\\Arknights.exe',
      'Arknights\\games\\Arknights Game\\Arknights.exe',
      'Hypergryph\\Arknights\\Arknights.exe',
      'Games\\Arknights\\Arknights.exe',
      // Yostar 三区是独立客户端，官方启动器按 Arknights_<区> 分目录；
      // 我方一键下载也用同样的目录名（见 modals.js 的 YOSTAR_DIR_NAMES）。
      // 装在这儿的 exe 会被 detectionChannel 按 game-launcher-config.json 的 tag 分区。
      'YostarGames\\Arknights_EN\\Arknights.exe',
      'YostarGames\\Arknights_JP\\Arknights.exe',
      'YostarGames\\Arknights_KR\\Arknights.exe',
      'HuaXiaoLingGames\\arknights-Arknights_EN\\Arknights.exe',
      'HuaXiaoLingGames\\arknights-Arknights_JP\\Arknights.exe',
      'HuaXiaoLingGames\\arknights-Arknights_KR\\Arknights.exe',
    ],
    // PlatformProcess.exe 只在鹰角启动器的子目录里出现，不能当作游戏入口
    relative: ['Arknights.exe', 'games\\Arknights Game\\Arknights.exe'],
  },
};

function expandEnv(value) {
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
}

const OFFICIAL_SITES = {
  genshin: 'https://ys.mihoyo.com/',
  starrail: 'https://sr.mihoyo.com/',
  zzz: 'https://zzz.mihoyo.com/',
  endfield: 'https://endfield.hypergryph.com/',
  // 2.4.0 合并：明日方舟官网（封面同步 / 公告都用它）
  arknights: 'https://ak.hypergryph.com/',
  neverness: 'https://nte.perfectworld.com/en/',
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const OFFICIAL_BG_ENDPOINTS = [
  'https://autopatch.amarea.cn/hoyoplay_background/hyp_cn_games.json',
  'https://autopatch.hk4e.com/hoyoplay_background/hyp_cn_games.json',
];

const BACKGROUND_CATEGORIES = {
  genshin: 'hk4e_cn',
  starrail: 'hkrpg_cn',
  zzz: 'nap_cn',
  // 2.4.0 合并：崩坏3 背景随官方版本走（hyp_cn_games.json 里的 bh3_cn 类目），
  // latestBackground 的回退链路会自动取到它
  bh3: 'bh3_cn',
};

const BASIC_GAME_IDS = {
  genshin: '1Z8W5NHUQb',
  starrail: '64kMb5iAWu',
  zzz: 'x6znKlJ0xK',
};

// 2.4.0 合并：明日方舟接入官网公告（ak.hypergryph.com）
// 2.4.x 增量：崩坏3 接入 HoYoPlay 官方启动器内容接口（hyp-api.mihoyo.com），
// getGameContent 的 posts 就是启动器里的公告，banners 是轮播大图。
const NOTICE_GAME_KEYS = ['genshin', 'starrail', 'zzz', 'endfield', 'neverness', 'arknights', 'bh3'];
const NOTICE_CACHE_TTL = 5 * 60 * 1000;
const noticeCache = new Map();

function htmlText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => {
      try {
        return String.fromCodePoint(parseInt(code, 16));
      } catch {
        return match;
      }
    })
    .replace(/&#(\d+);/g, (match, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return match;
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchHoyoNotices(gameKey) {
  const gameId = BASIC_GAME_IDS[gameKey];
  if (!gameId) return [];
  const endpoints = [
    ['https://hyp-api.mihoyo.com/hyp/hyp-connect/api', 'jGHBHlcOq1'],
    ['https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api', 'VYTpXlbWo8'],
  ];
  for (const [base, launcherId] of endpoints) {
    try {
      const response = await fetch(
        `${base}/getGameContent?launcher_id=${launcherId}&language=zh-cn&game_id=${gameId}`,
        {
          headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        }
      );
      if (!response.ok) continue;
      const json = await response.json();
      const posts = json.data?.content?.posts;
      if (!Array.isArray(posts)) continue;
      return posts
        .filter((post) => post?.title && post?.link)
        .slice(0, 8)
        .map((post) => ({
          title: String(post.title),
          link: String(post.link),
          date: String(post.date || ''),
          type: String(post.type || ''),
        }));
    } catch {
      /* try the other launcher channel */
    }
  }
  return [];
}

async function fetchEndfieldNotices() {
  const response = await fetch('https://endfield.hypergryph.com/', {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return [];
  const html = await response.text();
  const items = [];
  const seen = new Set();
  for (const anchor of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = anchor[1];
    const href = (attrs.match(/\bhref="([^"]+)"/i) || [])[1];
    const label = (attrs.match(/\baria-label="([^"]+)"/i) || [])[1];
    if (!href || !label || !/^\/news\/\d+$/.test(href)) continue;
    const link = new URL(href, 'https://endfield.hypergryph.com/').href;
    if (seen.has(link)) continue;
    seen.add(link);
    items.push({ title: htmlText(label), link, date: '', type: '公告' });
    if (items.length >= 8) break;
  }
  return items;
}

async function fetchNevernessNotices() {
  const pages = [
    'https://yh.wanmei.com/news/gamebroad/index.html',
    'https://yh.wanmei.com/news/gamebroad/index1.html',
  ];
  const items = [];
  const seen = new Set();
  for (const page of pages) {
    try {
      const response = await fetch(page, {
        headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const html = await response.text();
      for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const href = (anchor[1].match(/\bhref="([^"]+)"/i) || [])[1];
        if (!href || !/^\/news\/gamebroad\/\d+\/\d+\.html$/.test(href)) continue;
        const inner = anchor[2];
        const title = (inner.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1];
        if (!title) continue;
        const date = (inner.match(/<p[^>]*class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || [])[1];
        const type = (inner.match(/<p[^>]*class="[^"]*type[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || [])[1];
        const link = new URL(href, 'https://yh.wanmei.com').href;
        if (seen.has(link)) continue;
        seen.add(link);
        items.push({
          title: htmlText(title),
          link,
          date: htmlText(date || ''),
          type: htmlText(type || '公告'),
        });
        if (items.length >= 8) break;
      }
    } catch {
      /* try the next page */
    }
    if (items.length >= 8) break;
  }
  return items;
}

// 2.4.0 合并自对方分支：明日方舟官网公告（ak.hypergryph.com/news）
async function fetchArknightsNotices() {
  /* 官网是 Next.js App Router，新闻列表藏在 self.__next_f.push 的 Flight 数据里，
     结构为 initialData.LATEST.list[{cid,tab,title,displayTime,...}]，tab 0=公告 1=活动 2=资讯 */
  const response = await fetch('https://ak.hypergryph.com/news', {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return [];
  const html = await response.text();
  const flight = [...html.matchAll(/self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g)]
    .map((chunk) => chunk[1])
    .join('\n');
  if (!flight) return [];
  /* Flight 载荷里 JSON 被多包了一层转义，先还原再定位数组 */
  const plain = flight.split('\\"').join('"').split('\\\\').join('\\');
  const anchor = plain.indexOf('"initialData":');
  if (anchor < 0) return [];
  const listKey = plain.indexOf('"list":[', anchor);
  if (listKey < 0) return [];
  const start = plain.indexOf('[', listKey);
  let depth = 0;
  let end = -1;
  for (let index = start; index < plain.length; index += 1) {
    const char = plain[index];
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (start < 0 || end < 0) return [];
  let entries = [];
  try {
    entries = JSON.parse(plain.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const labels = { 0: '公告', 1: '活动', 2: '资讯' };
  const items = [];
  const seen = new Set();
  for (const entry of entries) {
    const cid = String(entry?.cid || '').trim();
    const title = htmlText(entry?.title || '');
    if (!cid || !title || seen.has(cid)) continue;
    seen.add(cid);
    const seconds = Number(entry?.displayTime) || 0;
    const date = seconds ? new Date(seconds * 1000) : null;
    const dateText =
      date && !Number.isNaN(date.getTime())
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : '';
    items.push({
      title,
      link: `https://ak.hypergryph.com/news/${cid}`,
      date: dateText,
      type: labels[Number(entry?.tab)] || '公告',
    });
    if (items.length >= 8) break;
  }
  return items;
}

/*
 * 2.4.x 增量：崩坏3 走 HoYoPlay 官方启动器内容接口（米哈游官方、bh3 官服）。
 *   GET getGameContent?launcher_id=jGHBHlcOq1&game_id=osvnlOc0S8&language=zh-cn
 * 实测返回：
 *   - data.content.banners[]：4 项，image.url 是官方启动器轮播大图
 *     （launcher-webstatic.mihoyo.com），image.link 是米游社文章；
 *   - data.content.posts[]：5 项 {title, link, date("10/20"), type}，即公告；
 *   - 没有 background_video 字段；动态背景视频由 getAllGameBasicInfo
 *     （officialBackgrounds，见 start-artwork.js）的 bh3_cn 条目提供。
 */
const BH3_GAME_CONTENT_URL =
  'https://hyp-api.mihoyo.com/hyp/hyp-connect/api/getGameContent?launcher_id=jGHBHlcOq1&game_id=osvnlOc0S8&language=zh-cn';
const BH3_BANNER_REFERER = 'https://hyp.mihoyo.com/';

/* 拉取崩坏3启动器内容；带 UA 与超时，任何失败静默返回 null（启动页不受影响） */
async function fetchBh3Content() {
  try {
    const response = await fetch(BH3_GAME_CONTENT_URL, {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const json = await response.json();
    return json.data?.content || null;
  } catch {
    return null;
  }
}

/* 公告列表：posts -> {title, link, date, type}。
   date 只有「10/20」月/日，补当前年份（跨年后比今天晚超过 60 天按上一年算），
   前端 noticeDate 才能解析出完整日期。 */
async function fetchBh3Notices() {
  const content = await fetchBh3Content();
  const posts = content?.posts;
  if (!Array.isArray(posts)) return [];
  const now = new Date();
  const fullDate = (text) => {
    const match = String(text || '').match(/^(\d{1,2})\/(\d{1,2})$/);
    if (!match) return String(text || '');
    let year = now.getFullYear();
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (new Date(year, month - 1, day).getTime() - now.getTime() > 60 * 24 * 3600 * 1000) {
      year -= 1;
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  const typeLabels = {
    POST_TYPE_ANNOUNCE: '公告',
    POST_TYPE_ACTIVITY: '活动',
    POST_TYPE_INFO: '资讯',
    POST_TYPE_POST: '资讯',
  };
  return posts
    .filter((post) => post?.title && post?.link)
    .slice(0, 8)
    .map((post) => ({
      title: String(post.title),
      link: String(post.link),
      date: fullDate(post.date),
      type: typeLabels[String(post.type || '')] || String(post.type || '公告'),
    }));
}

/* 从 banners 里挑启动页背景图：按序取第一张 HEAD 校验通过的
   （官方启动器轮播大图本身就是启动器背景用途，无宽高字段，只能逐张验）。 */
async function pickBh3Cover(banners) {
  if (!Array.isArray(banners)) return '';
  for (const banner of banners) {
    const url = String(banner?.image?.url || '');
    if (!/^https:\/\//i.test(url)) continue;
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: { 'user-agent': BROWSER_UA, referer: BH3_BANNER_REFERER },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const type = String(response.headers.get('content-type') || '').toLowerCase();
      if (!type.startsWith('image/')) continue;
      const size = Number(response.headers.get('content-length') || 0);
      // 空洞占位图直接跳过：轮播大图不会小于 50KB
      if (size && size < 50 * 1024) continue;
      return url;
    } catch {
      /* 试下一张 */
    }
  }
  return '';
}

/* 动态背景拿不到时的静态兜底：把图落成 startCover
   （命名带 -clean2/-clean3 是既有清理逻辑的通行证：ensureAnimatedStartBackgrounds
   会把不带这两段的 startCover 直接清空）。失败静默，回退钉住封面。
   2.4.x 修正：优先用官方启动器背景（getAllGameBasicInfo 的 bh3_cn
   background 图，Starward 启动页同款、无活动文字压屏），轮播 banner
   降为第二兜底——banner 是带标题字的活动图，压当启动页背景很难看。 */
async function ensureBh3StartCover(game) {
  if (!game || !store) return;
  const expected = 'covers/official-bh3-clean2.png';
  if (game.startCover === expected) {
    const existing = path.join(app.getPath('userData'), expected);
    if (fs.existsSync(existing) && fs.statSync(existing).size > 4096) return;
  }
  let imageUrl = '';
  try {
    const art = await officialBackgrounds('bh3');
    imageUrl = art.images[0]?.url || '';
  } catch {
    /* 走 banner 兜底 */
  }
  if (!imageUrl) {
    const content = await fetchBh3Content();
    imageUrl = await pickBh3Cover(content?.banners);
  }
  if (!imageUrl) return;
  try {
    const response = await fetch(imageUrl, {
      headers: { 'user-agent': BROWSER_UA, referer: BH3_BANNER_REFERER, accept: 'image/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 24 * 1024 * 1024) throw new Error('图片大小异常');
    const dir = path.join(app.getPath('userData'), 'covers');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'official-bh3-clean2.png'), buffer);
    game.startCover = expected;
    await store.saveNow();
    // 顺手把卡片封面也从占位 SVG 换成这张官方主视觉
    if (promoteBh3Cover()) await store.saveNow();
    pushState(true);
  } catch (error) {
    console.warn('崩坏3 启动页静态背景兜底失败：', error.message);
  }
}

/* 2.4.x 增量：明日方舟静态兜底。PV 拉不到时把官网 KV 大图
   （web.hycdn.cn 官方 CDN，无活动文字压屏）落成 startCover，
   命名带 -clean2/-clean3 与崩坏3 同理，是既有清理逻辑的通行证。
   失败静默，回退钉住封面。 */
const ARKNIGHTS_KV_URLS = [
  'https://web.hycdn.cn/upload/image/20260805/8ed71a3d0fed6ca51a7df1b94544f84d.png',
  'https://web.hycdn.cn/upload/image/20250627/17770e12e3a1c477616bbaaccdcb83e0.jpg',
];

async function ensureArknightsStartCover(game) {
  if (!game || !store) return;
  const expected = 'covers/official-arknights-clean2.png';
  if (game.startCover === expected) {
    const existing = path.join(app.getPath('userData'), expected);
    if (fs.existsSync(existing) && fs.statSync(existing).size > 4096) return;
  }
  for (const imageUrl of ARKNIGHTS_KV_URLS) {
    try {
      const response = await fetch(imageUrl, {
        headers: { 'user-agent': BROWSER_UA, referer: 'https://ak.hypergryph.com/', accept: 'image/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > 24 * 1024 * 1024) throw new Error('图片大小异常');
      const dir = path.join(app.getPath('userData'), 'covers');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'official-arknights-clean2.png'), buffer);
      game.startCover = expected;
      await store.saveNow();
      pushState(true);
      return;
    } catch (error) {
      console.warn('明日方舟 启动页静态背景兜底失败：', error.message);
    }
  }
}

async function fetchGameNotices(gameKey, force = false) {
  const cached = noticeCache.get(gameKey);
  if (!force && cached && Date.now() - cached.at < NOTICE_CACHE_TTL) return cached.items;
  let items = [];
  try {
    if (BASIC_GAME_IDS[gameKey]) items = await fetchHoyoNotices(gameKey);
    else if (gameKey === 'endfield') items = await fetchEndfieldNotices();
    else if (gameKey === 'neverness') items = await fetchNevernessNotices();
    // 2.4.0 合并：明日方舟公告分发
    else if (gameKey === 'arknights') items = await fetchArknightsNotices();
    // 2.4.x 增量：崩坏3 公告（HoYoPlay 官方启动器内容接口，米游社文章直链）
    else if (gameKey === 'bh3') items = await fetchBh3Notices();
  } catch (error) {
    console.warn(`官方公告读取失败（${gameKey}）：`, error.message);
    items = [];
  }
  items = items.slice(0, 8);
  noticeCache.set(gameKey, { at: Date.now(), items });
  return items;
}

async function fetchAllGameNotices(force = false) {
  const keys = [...new Set([...NOTICE_GAME_KEYS, ...store.data.games.map((game) => game.builtinKey).filter(Boolean)])];
  const entries = await Promise.all(
    keys.map(async (key) => [key, await fetchGameNotices(key, force).catch(() => [])])
  );
  return Object.fromEntries(entries);
}

let noticeSyncTimer = null;
async function syncAllGameNotices(force = false) {
  try {
    await fetchAllGameNotices(force);
  } catch (error) {
    console.warn('官方公告自动更新失败：', error.message);
  }
}
function startNoticeAutoSync() {
  setTimeout(() => syncAllGameNotices(false), 4000);
  if (noticeSyncTimer) clearInterval(noticeSyncTimer);
  noticeSyncTimer = setInterval(() => syncAllGameNotices(true), 10 * 60 * 1000);
}

async function fetchVersionArtwork(gameKey) {
  const gameId = BASIC_GAME_IDS[gameKey];
  if (!gameId) return { image: '', video: '' };
  const endpoints = [
    ['https://hyp-api.mihoyo.com/hyp/hyp-connect/api', 'jGHBHlcOq1'],
    ['https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api', 'VYTpXlbWo8'],
  ];
  for (const [base, launcherId] of endpoints) {
    try {
      const response = await fetch(
        `${base}/getAllGameBasicInfo?launcher_id=${launcherId}&language=zh-cn`,
        {
          headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        }
      );
      if (!response.ok) continue;
      const json = await response.json();
      const info = (json.data?.game_info_list || []).find((item) => item.game?.id === gameId);
      const backgrounds = info?.backgrounds || [];
      // 版本图：官方每次新版本会新发一张，按 URL 里的上传日期取最新的一张。
      // 原神接口只有静态版本图（video 字段恒为空），所以下面 videoItem 通常拿不到东西。
      const uploadedAt = (item) => {
        const m = String(item?.background?.url || '').match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
        return m ? m[1] + m[2] + m[3] : '';
      };
      const imageItem = backgrounds
        .filter((item) => item.background?.url)
        .sort((a, b) => uploadedAt(b).localeCompare(uploadedAt(a)))[0];
      const videoItem = backgrounds.find((item) => item.video?.url);
      if (imageItem?.background?.url || videoItem?.video?.url) {
        return {
          image: imageItem?.background?.url || '',
          video: videoItem?.video?.url || '',
        };
      }
    } catch {
      /* try the other launcher channel */
    }
  }
  return { image: '', video: '' };
}

async function fetchHoyoBackgrounds() {
  for (const endpoint of OFFICIAL_BG_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (Array.isArray(data)) return data;
    } catch (error) {
      console.warn('背景数据源不可用：', endpoint, error.message);
    }
  }
  return [];
}

function latestBackground(backgrounds, key) {
  const category = BACKGROUND_CATEGORIES[key];
  if (!category) return null;
  const list = backgrounds.filter((item) => item && item.category === category && item.url);
  if (!list.length) return null;
  return list.reduce((latest, item) => {
    if (!latest) return item;
    return String(item.time || '') > String(latest.time || '') ? item : latest;
  }, null);
}

function imageExtension(url, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('webp')) return '.webp';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('png')) return '.png';
  const match = String(url).split('?')[0].match(/\.(webp|jpg|jpeg|png)$/i);
  return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

function pickEndfieldCover(html) {
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  for (const tag of images) {
    if (!/版本更新说明|版本PV|版本前瞻|版本上线/.test(tag)) continue;
    const src = tag.match(/src=["']([^"']+)["']/i);
    if (src && src[1]) return src[1];
  }
  const uploads = [...html.matchAll(/https:\/\/web\.hycdn\.cn\/upload\/image\/(\d{8})\/[^"'\s>]+?\.(?:jpg|png)/gi)]
    .map((match) => ({ date: match[1], url: match[0] }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return uploads.length ? uploads[0].url : '';
}

// 2.4.0 合并自对方分支：明日方舟官网封面抓取
function pickArknightsCover(html) {
  /* 官网首页轮播（swiper-slide）里挂的是当期活动大图，位置稳定且是最新的，
     比 upload/image/<日期>/ 里的散图更适合作封面；取不到再退回最新上传图。 */
  const slides = [...html.matchAll(/<div class="swiper-slide">[\s\S]{0,400}?<img[^>]+src="([^"]+)"/gi)]
    .map((match) => match[1])
    .filter((url) => /^https:\/\/web\.hycdn\.cn\/upload\/image\//.test(url));
  if (slides.length) return slides[0];
  const uploads = [...html.matchAll(/https:\/\/web\.hycdn\.cn\/upload\/image\/(\d{8})\/[^"'\s>]+?\.(?:jpg|png|webp)/gi)]
    .map((match) => ({ date: match[1], url: match[0] }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return uploads.length ? uploads[0].url : '';
}

function pickNevernessCover(html) {
  const candidates = [];
  const pattern =
    /https:\/\/nte\.perfectworld\.com\/[^"'\s>]+\/images\/(cover|main)(\d{6})\/([^"'\s>]+?\.(?:jpg|jpeg|png))/gi;
  for (const match of html.matchAll(pattern)) {
    candidates.push({
      url: match[0],
      kind: match[1].toLowerCase(),
      date: Number(match[2]),
      file: match[3].toLowerCase(),
    });
  }
  if (!candidates.length) return '';
  candidates.sort((a, b) => {
    if (b.date !== a.date) return b.date - a.date;
    if (a.kind !== b.kind) return a.kind === 'cover' ? -1 : 1;
    const score = (item) => {
      let value = 1;
      if (item.file.includes('slide2')) value = 3;
      else if (item.file.includes('slide1')) value = 2;
      if (item.url.includes('/m/')) value -= 0.5;
      return value;
    };
    return score(b) - score(a);
  });
  return candidates[0].url;
}

async function ensureNevernessCover() {
  if (!store) return;
  const game = store.data.games.find((item) => item.builtinKey === 'neverness');
  if (!game) return;
  const cachedCover =
    game.cover && /^covers\/official-neverness\.(?:jpg|jpeg|png)$/i.test(game.cover)
      ? path.join(app.getPath('userData'), game.cover)
      : null;
  let imageUrl = 'https://nte.perfectworld.com/en/images/cover260930/slide2.jpg';
  let liveVersion = '';
  try {
    const page = await fetch('https://nte.perfectworld.com/en/', {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html' },
      signal: AbortSignal.timeout(15000),
    });
    if (page.ok) {
      const html = await page.text();
      const picked = pickNevernessCover(html);
      if (picked) imageUrl = picked;
      const version =
        html.match(/Version\s*([0-9]+(?:\.[0-9]+)?)/i) ||
        html.match(/web_event[_-]([0-9]+(?:\.[0-9]+)?)/i);
      if (version) {
        liveVersion = version[1];
        // 首页正则抓到的版本不一定准（大版本更新后官网静态页常还挂着旧版本号），
        // 只在没有版本号时预填，绝不覆盖已检测到的真实版本（比如从已装游戏读到的 1.5）。
        if (!game.version) game.version = liveVersion;
      }
    }
  } catch {
    /* use fallback hero */
  }
  // 已经有一张缓存图、且这次没抓到「新版本号」也没换封面地址就别反复下；
  // 版本号变了（或首页换了新的 cover 路径）才重新拉，这样异环大版本更新后封面会自动跟着换。
  if (
    cachedCover &&
    fs.existsSync(cachedCover) &&
    (!liveVersion || liveVersion === game.nevernessCoverVersion) &&
    (!game.nevernessCoverUrl || game.nevernessCoverUrl === imageUrl)
  ) {
    return;
  }
  try {
    const response = await fetch(imageUrl, {
      headers: { 'user-agent': BROWSER_UA, referer: 'https://nte.perfectworld.com/en/', accept: 'image/*' },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 24 * 1024 * 1024) throw new Error('图片大小异常');
    const dir = path.join(app.getPath('userData'), 'covers');
    await fsp.mkdir(dir, { recursive: true });
    const ext = imageExtension(imageUrl, response.headers.get('content-type'));
    const fileName = `official-neverness${ext}`;
    await fsp.writeFile(path.join(dir, fileName), buffer);
    game.cover = `covers/${fileName}`;
    if (liveVersion) game.nevernessCoverVersion = liveVersion;
    game.nevernessCoverUrl = imageUrl;
    await store.saveNow();
    pushState(true);
  } catch (error) {
    console.warn('异环封面预取失败：', error.message);
  }
}

function findFileByName(root, fileName, maxDepth = 4) {
  const target = String(fileName || '').toLowerCase();
  const queue = [{ dir: root, depth: 0 }];
  const found = [];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) {
        try {
          found.push({ file: full, size: fs.statSync(full).size });
        } catch {
          /* ignore unreadable files */
        }
      } else if (entry.isDirectory() && depth < maxDepth) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  found.sort((a, b) => b.size - a.size);
  return found[0]?.file || '';
}

function findNevernessStartVideo(game) {
  const candidates = [
    game.target,
    ...(game.servers || []).map((server) => server.path),
  ].filter(Boolean);
  for (const exe of candidates) {
    let dir = path.dirname(exe);
    for (let depth = 0; depth < 7; depth += 1) {
      const resRoot = path.join(dir, 'NTELauncher', 'ResFilesM');
      if (fs.existsSync(resRoot)) {
        const video = findFileByName(resRoot, 'bg.mp4', 3);
        if (video) return video;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return '';
}

function extractStartVideo(html, baseUrl) {
  const pick = (tag) => {
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (!src || !/\.(?:mp4|webm)(?:[?#]|$)/i.test(src)) return '';
    const cleaned = src.replace(/&amp;/gi, '&').replace(/\\\//g, '/');
    try {
      return new URL(cleaned, baseUrl).href;
    } catch {
      return '';
    }
  };
  for (const match of html.matchAll(/<video\b[^>]*>/gi)) {
    const url = pick(match[0]);
    if (url) return url;
  }
  for (const match of html.matchAll(/<source\b[^>]*>/gi)) {
    const url = pick(match[0]);
    if (url) return url;
  }
  return '';
}

async function fetchEndfieldStartVideo() {
  const sites = [
    'https://endfield.hypergryph.com/',
    'https://endfield.gryphline.com/',
  ];
  for (const site of sites) {
    try {
      const response = await fetch(site, {
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) continue;
      const html = await response.text();
      const video = extractStartVideo(html, site);
      if (video) return video;
    } catch {
      /* try the other official site */
    }
  }
  return '';
}

// 2.4.0 合并自对方分支：明日方舟官网首页启动视频
async function fetchArknightsStartVideo() {
  /* 明日方舟官网首页用 HLS 播放 home_videos/PV04_landscape.m3u8；
     同目录下还有一份同名 mp4（约 35MB，已确认 Content-Type 为 video/mp4），
     直接取它省掉转封装，也落在 cacheStartVideo 的 80MB 上限之内。 */
  const candidates = [
    'https://web.hycdn.cn/arknights/official/home_videos/PV04_landscape.mp4',
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: { 'user-agent': BROWSER_UA, referer: 'https://ak.hypergryph.com/' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const type = String(response.headers.get('content-type') || '').toLowerCase();
      const size = Number(response.headers.get('content-length') || 0);
      if (!type.includes('mp4')) continue;
      if (size && size > 60 * 1024 * 1024) continue;
      return url;
    } catch {
      /* 试下一个候选 */
    }
  }
  return '';
}

/* 视频容器嗅探。官方动图有 mp4 也有 webm（崩坏3 官方背景就是 VP9/webm），
   绝不能一律按调用方给的 .mp4 落盘——否则文件名叫 mp4、内容是 webm，
   现在靠浏览器嗅探侥幸能播，但缓存一旦被清掉重下就会复现「名实不符」。
   EBML 头 1A 45 DF A3 → webm；第 4~8 字节 ftyp → mp4。 */
function sniffVideoExtension(buffer) {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'webm';
  }
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  return '';
}

async function cacheStartVideo(source, relativePath, local = false) {
  const destination = path.join(app.getPath('userData'), relativePath);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  if (local) {
    await fsp.copyFile(source, temporary);
  } else {
    const videoHeaders = {
      'user-agent': BROWSER_UA,
      accept: 'video/mp4,video/webm,video/*;q=0.9,*/*;q=0.5',
      referer: 'https://endfield.hypergryph.com/',
    };
    /*
     * 动图都是一二十兆的大文件，先走 Node 的 https 栈（独立连接、不受 Chromium
     * 对同 host 的 6 socket 限制）。Chromium 栈在开了 Steam++ 这类中间人代理时
     * 偶尔会卡到超时，所以失败后仍用它兜底。
     */
    let response;
    try {
      response = await nodeRequest(source, {
        headers: videoHeaders,
        signal: AbortSignal.timeout(90000),
      });
    } catch {
      response = await httpFetch(source, {
        headers: videoHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(90000),
      });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > 80 * 1024 * 1024) throw new Error('动图文件过大');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 80 * 1024 * 1024) throw new Error('动图文件大小异常');
    await fsp.writeFile(temporary, buffer);
  }
  const stat = await fsp.stat(temporary);
  if (!stat.size || stat.size > 80 * 1024 * 1024) {
    await fsp.rm(temporary, { force: true });
    throw new Error('动图文件为空或过大');
  }

  // 按真实容器修正扩展名（webm 不能叫 .mp4），并清掉同基础名的其它格式残留，
  // 免得 background 目录随「换格式 / 换来源」越堆越多。
  let finalRelative = relativePath;
  try {
    const head = Buffer.alloc(12);
    const handle = await fsp.open(temporary, 'r');
    try {
      await handle.read(head, 0, 12, 0);
    } finally {
      await handle.close();
    }
    const realExt = sniffVideoExtension(head);
    const wantExt = path.extname(relativePath).replace(/^\./, '').toLowerCase();
    if (realExt && realExt !== wantExt) {
      finalRelative = `${relativePath.replace(/\.[^./\\]+$/, '')}.${realExt}`;
    }
  } catch {
    /* 嗅探失败就按调用方给的扩展名 */
  }
  const finalDestination = path.join(app.getPath('userData'), finalRelative);
  try {
    const dir = path.dirname(finalDestination);
    const keep = path.basename(finalDestination);
    const base = keep.replace(/\.[^./\\]+$/, '');
    const stale = new RegExp(`^${base}\\.(?:mp4|webm)(?:\\.part)?$`, 'i');
    /*
     * 这个临时文件是当前正在写的那一份，绝对不能删。
     * 上面的 stale 正则会匹配到「arknights.mp4.part」，早先没排除它，
     * 于是流程成了「下完 → 清理旧残留 → 顺手把刚下好的 .part 删了 → rename 报 ENOENT」，
     * 日志里就是「启动页动图缓存失败」，界面上表现为没有动态背景。
     */
    const temporaryName = path.basename(temporary);
    for (const old of await fsp.readdir(dir)) {
      if (old === keep || old === temporaryName || !stale.test(old)) continue;
      await fsp.rm(path.join(dir, old), { force: true }).catch(() => {});
    }
  } catch {
    /* 清不掉不影响主流程 */
  }

  await fsp.rm(finalDestination, { force: true });
  await fsp.rename(temporary, finalDestination);
  return finalRelative;
}

// 2.4.0 合并自对方分支：崩坏3 的 builtin 封面是人工挑选的官方主视觉，按自定义封面保护，
// 避免被官网同步抓回来的活动 banner 顶掉（崩坏3 另有 ensureBh3StartCover 兜底启动页背景）。
// 明日方舟则相反：用户明确要求「同步官网封面」，所以 arknights 不进这个保护名单——
// 它的 builtin 封面当作普通初始图，首次同步就会被官网最新 KV 覆盖成 official-arknights。
//
// 2.4.4 修正：内置的 builtin-bh3.svg 只是一张深色占位插画，摆在主页卡片上几乎看不见，
// 用户反馈「崩坏3 封面图没有了」。官方去文字主视觉（ensureBh3StartCover 拉下来的
// official-bh3-clean2）本来就是真图，直接把它当卡片封面用，并一起钉住不让同步覆盖。
const PINNED_BUILTIN_COVERS = /^covers\/(?:builtin-bh3\.(?:jpg|jpeg|png|webp|svg)|official-bh3-clean2\.(?:png|jpg|jpeg|webp))$/i;
// 崩坏3 卡片的官方主视觉（与启动页背景同一张，本地已有就用，没有才退回内置 SVG）
const BH3_CARD_COVER = 'covers/official-bh3-clean2.png';
const BH3_PLACEHOLDER_COVER = 'covers/builtin-bh3.svg';
function isCustomCover(game) {
  const cover = (game && game.cover) || '';
  if (!cover) return false;
  if (PINNED_BUILTIN_COVERS.test(cover)) return true;
  return !/^covers\/(builtin|official)-/.test(cover);
}

/**
 * 崩坏3 卡片封面自愈。
 *
 * 老用户的库里 bh3 的 cover 还停在 covers/builtin-bh3.svg（深色占位图，看起来像没封面）。
 * 只要本地已经有官方主视觉，就把它换上去；文件还没下到就保持原样，等
 * ensureBh3StartCover 下完再调一次本函数即可。
 */
function promoteBh3Cover() {
  let changed = false;
  for (const game of store.data.games || []) {
    if (game.builtinKey !== 'bh3') continue;
    const cover = String(game.cover || '');
    if (cover && cover !== BH3_PLACEHOLDER_COVER) continue;
    const absolute = path.join(app.getPath('userData'), BH3_CARD_COVER);
    try {
      if (!fs.statSync(absolute).isFile() || fs.statSync(absolute).size < 8192) continue;
    } catch {
      continue;
    }
    game.cover = BH3_CARD_COVER;
    changed = true;
  }
  return changed;
}

let startArtworkJob = null;
// 2.4.x 增量：官方背景补拉的连续重试计数（成功一轮即清零）
let bh3OfficialRetry = 0;

/* nativeImage 只认 PNG/JPEG，而米家 CDN 的官方版本图全是 .webp ——
   createFromPath 直接返回空图，eraseImageText 拿到空图永远返回 null，
   这就是「clean3 一直生成不出来」的根因。
   这里用隐藏窗口的 canvas 解码转成 PNG 落盘（Chromium 一定认得 webp）。 */
let pngConvertWindow = null;

async function convertImageToPngBuffer(imagePath) {
  if (!pngConvertWindow || pngConvertWindow.isDestroyed()) {
    pngConvertWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        // file:// 图片要画进 canvas 不被污染，只能关掉同源校验
        webSecurity: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    pngConvertWindow.on('closed', () => {
      pngConvertWindow = null;
    });
    await pngConvertWindow.loadURL('data:text/html,<canvas id="c"></canvas>');
  }
  const fileUrl = require('node:url').pathToFileURL(imagePath).href;
  const dataUrl = await pngConvertWindow.webContents.executeJavaScript(
    `(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(fileUrl)};
      await img.decode();
      const c = document.getElementById('c');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    })()`,
    true
  );
  const base64 = String(dataUrl || '').split(',')[1] || '';
  if (!base64) throw new Error('webp 转 PNG 失败：canvas 返回空');
  return Buffer.from(base64, 'base64');
}

/* nativeImage 能吃的前提下做去字；源不是 PNG/JPEG 先转 PNG。
   转出的 PNG 与源图同名换扩展名，mtime 比源旧时重转。
   返回 clean3 文件名（covers 相对），失败返回 null。 */
async function ensureErasedCover(builtinKey, rawSourcePath) {
  const cleanName = `official-${builtinKey}-clean3.png`;
  const cleanPath = path.join(app.getPath('userData'), 'covers', cleanName);
  // clean3 已经比源图新就直接复用：否则每次启动都要把 webp 转成 4MB 的 PNG
  // 再跑几秒去字，白耗磁盘和 CPU，中间 PNG 还会把 covers 目录撑大。
  try {
    const [srcStat, cleanStat] = await Promise.all([
      fsp.stat(rawSourcePath),
      fsp.stat(cleanPath),
    ]);
    if (cleanStat.size > 8192 && cleanStat.mtimeMs >= srcStat.mtimeMs) return cleanName;
  } catch {
    /* 缺其中一个就继续走完整流程 */
  }

  let sourcePath = rawSourcePath;
  let converted = false;
  if (!/\.(png|jpe?g)$/i.test(sourcePath)) {
    const pngPath = sourcePath.replace(/\.[^.]+$/, '.png');
    try {
      const [srcStat, pngStat] = await Promise.all([
        fsp.stat(sourcePath).catch(() => null),
        fsp.stat(pngPath).catch(() => null),
      ]);
      if (!srcStat) return null;
      if (!pngStat || pngStat.mtimeMs < srcStat.mtimeMs) {
        await fsp.writeFile(pngPath, await convertImageToPngBuffer(sourcePath));
      }
      sourcePath = pngPath;
      converted = true;
    } catch (error) {
      console.warn(`[背景去字] ${builtinKey} 源图转 PNG 失败：`, error.message);
      return null;
    }
  }
  const cleaned = await ensureErasedBackground({
    nativeImage,
    sourcePath,
    cachePath: cleanPath,
  }).catch(() => null);
  // 转换用的中间 PNG 用完即删：clean3 才是最终产物，留着只会让 covers 越堆越大。
  if (converted) await fsp.rm(sourcePath, { force: true }).catch(() => {});
  return cleaned ? cleanName : null;
}

/* 去字缓存修补：不依赖官网同步。
   官方同步每 6 小时才跑一轮，而那轮里去字一旦失败（旧算法时期 / 网络抖动 /
   webp 解不出来），startCover 被清空，用户就得干等下一轮才可能补上。
   这里在启动时直接检查：内置米哈游系游戏本地已有官方版本图（covers/official-*）
   但启动页没有 -clean3 去字版的，用本地文件当场补一张，不联网。 */
const ERASED_COVER_KEYS = new Set(['genshin', 'starrail', 'zzz']);
let erasedCoverRepairJob = null;

function repairErasedStartCovers() {
  if (erasedCoverRepairJob || !store?.data?.games) return;
  erasedCoverRepairJob = (async () => {
    let changed = false;
    for (const game of store.data.games) {
      if (!ERASED_COVER_KEYS.has(game.builtinKey)) continue;
      if (isCustomCover(game)) continue;
      const coverRelative = String(game.cover || '');
      if (!/^covers\/official-/.test(coverRelative)) continue;
      const sourcePath = path.join(app.getPath('userData'), coverRelative);
      try {
        if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size < 8192) continue;
      /*
       * 已经有启动图就直接用，不再自动去字。
       *
       * 原来这里是「每次启动都重新评估一遍」，结果把本就没有文字的官方版本图也过了一遍
       * 形态学运算，把立绘的脸和头发当文字擦掉（2026-11-01 星铁就是这样被抹糊的，
       * 用户直接看出来了）。官方图有没有烧录文字，用像素算法判断本来就不靠谱；
       * 现在只在「这张游戏还没有启动图」时补一次，已有的一律保留原样——
       * 包括随包内置的、以及用户自己处理过（比如豆包重绘）的。
       */
      const startRelative = String(game.startCover || '');
      if (startRelative) {
        try {
          if (fs.statSync(path.join(app.getPath('userData'), startRelative)).size > 8192) continue;
        } catch {
          /* 引用存在但文件不在：继续走补生成 */
        }
      }
      } catch {
        continue;
      }
      // 已存在的 clean3 也拉回来重新评估：新鲜就保留，去字被放弃（区域过大/源不支持）
      // 就删掉旧 clean3 回退清晰原图（启动页左侧有 .start-shade 压暗遮罩，文字会被盖住）。
      const existingClean = game.startCover && /-clean3\./.test(game.startCover)
        ? path.join(app.getPath('userData'), game.startCover)
        : null;
      try {
        const cleanName = await ensureErasedCover(game.builtinKey, sourcePath);
        if (cleanName) {
          game.startCover = `covers/${cleanName}`;
          changed = true;
          console.log(`[背景修补] ${game.builtinKey} 已生成 ${cleanName}`);
        } else if (existingClean) {
          try { fs.unlinkSync(existingClean); } catch { /* ignore */ }
          game.startCover = '';
          changed = true;
          console.log(`[背景修补] ${game.builtinKey} 去字放弃，清除旧 clean3 回退原图`);
        }
      } catch (error) {
        console.warn(`[背景修补] ${game.builtinKey} 失败：`, error.message);
      }
    }
    if (changed) {
      await store.saveNow();
      pushState(true);
    }
  })()
    .catch((error) => console.warn('[背景修补] 异常：', error.message))
    .finally(() => {
      erasedCoverRepairJob = null;
    });
}

// 2.4.0 合并自对方分支：启动页动图的缓存文件名可能是 .mp4 也可能是 .webm，
// 按顺序探测已存在且非空的那一个。
function existingStartVideo(key) {
  for (const ext of ['mp4', 'webm']) {
    const relative = `backgrounds/${key}.${ext}`;
    const absolute = path.join(app.getPath('userData'), relative);
    try {
      if (fs.existsSync(absolute) && fs.statSync(absolute).size > 4096) return relative;
    } catch {
      /* 换下一个格式 */
    }
  }
  return '';
}
function ensureAnimatedStartBackgrounds(options = {}) {
  // only：只处理某款内置游戏。手动「重新获取动态背景」时用，别顺带把
  // 星铁 / 绝区零那几十兆 webm 全部重下一遍。
  const only = String(options.only || '');
  if (startArtworkJob) {
    if (!only) return startArtworkJob;
    // 有任务在跑就等它结束再按 only 重跑一次，避免手动刷新被旧任务吞掉
    return startArtworkJob.then(() => ensureAnimatedStartBackgrounds(options));
  }
  startArtworkJob = (async () => {
    if (!store) return;
    let changed = false;
    let officialMiss = false;
    for (const game of store.data.games) {
      if (!game.builtinKey) continue;
      if (only && game.builtinKey !== only) continue;
      if (game.startCover && !/-(?:clean2|clean3)\./.test(game.startCover)) game.startCover = '';
      // 2.4.0 合并：customCover 判定换成 isCustomCover —— 明日方舟 / 崩坏3 的
      // 钉住封面（PINNED_BUILTIN_COVERS）不算「用户自定义」，启动页背景照常跟官方走。
      const pinnedCover = PINNED_BUILTIN_COVERS.test(game.cover || '');
      if (isCustomCover(game) && !pinnedCover) continue;

      const key = game.builtinKey;
      // 2.4.0 合并自对方分支 existingStartVideo：官方动图有 mp4 也有 webm
      // （崩坏3 的官方启动器背景就是 VP9/webm），缓存文件名跟随实际格式，
      // 按 mp4 → webm 顺序探测已存在且非空的那一个，不要一律写死 .mp4。
      let cachedVideo = existingStartVideo(key);
      let videoRelative = cachedVideo || `backgrounds/${key}.mp4`;

      // 异环的启动页动图直接复用游戏目录里的官方 bg.mp4（本地文件），
      // 这份文件会随游戏大版本更新（1.4 → 1.5 …）。上面 existingStartVideo
      // 只要缓存存在就永久沿用，会导致启动器里的动图永远停在第一次复制时的
      // 旧版本。这里在「本地源」前提下做一次新鲜度核对：源文件比缓存新、或
      // 大小不同，就视为旧缓存失效，清掉它让后面的复制逻辑重拉最新一份。
      if (key === 'neverness' && cachedVideo) {
        const localSource = findNevernessStartVideo(game);
        if (localSource) {
          try {
            const srcStat = fs.statSync(localSource);
            const cacheAbs = path.join(app.getPath('userData'), videoRelative);
            const cacheStat = fs.statSync(cacheAbs);
            const stale =
              cacheStat.size !== srcStat.size ||
              cacheStat.mtimeMs < srcStat.mtimeMs - 1000;
            if (stale) {
              try {
                fs.rmSync(cacheAbs, { force: true });
              } catch {
                /* 删不掉不影响后续覆盖 */
              }
              cachedVideo = '';
              videoRelative = `backgrounds/${key}.mp4`;
            }
          } catch {
            /* 源或缓存不可读就维持现状 */
          }
        }
      }

      if (cachedVideo) {
        if (game.backgroundVideo !== videoRelative || game.startMotion !== 'video') {
          game.backgroundVideo = videoRelative;
          game.startMotion = 'video';
          changed = true;
        }
        continue;
      }

      let source = '';
      let local = false;
      if (key === 'neverness') {
        source = findNevernessStartVideo(game);
        local = Boolean(source);
      } else if (key === 'endfield') {
        source = await fetchEndfieldStartVideo();
      } else if (['starrail', 'zzz', 'genshin', 'bh3'].includes(key)) {
        // 2.4.x 增量：start-artwork.js 的 CATEGORY_BY_GAME 已补 bh3 -> bh3_cn，
        // 官方 getAllGameBasicInfo 的 bh3_cn 条目带 2 组 webm 动图，
        // 取到 videos[0] 就走官方动态背景；取不到再走下面的 banner 兜底。
        try {
          const art = await officialBackgrounds(key);
          if (art.videos.length) source = art.videos[0].url;
        } catch {
          source = '';
        }
      } else if (key === 'arknights') {
        // 2.4.0 合并：明日方舟 PV（web.hycdn.cn），用我方 cacheStartVideo 落盘
        source = await fetchArknightsStartVideo();
      }

      // 没有官方视频（原神）：静态图 + 前端缓动镜头
      if (!source) {
        if (!game.backgroundVideo && game.startMotion !== 'pan') {
          game.startMotion = 'pan';
          changed = true;
        }
        // 2.4.x 增量：崩坏3 拿不到官方动图时（接口挂/缓存失败），
        // 用官方启动器背景图（Starward 同款）兜底静态背景；再失败维持钉住
        // 封面，启动页不白屏也不造假。失败不拖死整个预取。
        if (key === 'bh3') {
          officialMiss = true;
          try {
            await ensureBh3StartCover(game);
          } catch (error) {
            console.warn('崩坏3 静态背景兜底异常：', error.message);
          }
        } else if (key === 'arknights') {
          // 2.4.x 增量：明日方舟 PV 拉不到时用官网 KV 大图兜底静态背景
          officialMiss = true;
          try {
            await ensureArknightsStartCover(game);
          } catch (error) {
            console.warn('明日方舟 静态背景兜底异常：', error.message);
          }
        }
        continue;
      }
      try {
        // 落盘后返回的是「按真实容器修正过扩展名」的路径，必须用它回填，
        // 否则 webm 内容会被记成 .mp4（见 cacheStartVideo 里的嗅探逻辑）。
        const writtenRelative = await cacheStartVideo(source, videoRelative, local);
        game.backgroundVideo = writtenRelative;
        game.startMotion = 'video';
        game.backgroundVideoSyncedAt = new Date().toISOString();
        changed = true;
      } catch (error) {
        console.warn(`${game.name} 启动页动图缓存失败：`, error.message);
        if (/^https?:/i.test(source)) {
          game.backgroundVideo = source;
          game.backgroundVideoSyncedAt = new Date().toISOString();
          game.startMotion = 'video';
          changed = true;
        }
      }
    }
    if (changed) {
      await store.saveNow();
      pushState(true);
    }
    /* 2.4.x 增量：官方背景偶尔一次拉不到（接口抖动/网络慢）就永远是静态图，
       之后 60 秒补一次预取，最多补 3 次。已落盘的游戏 existingStartVideo
       直接命中跳过，重跑代价只是每游戏一次 getAllGameBasicInfo。 */
    if (!only && officialMiss && bh3OfficialRetry < 3) {
      bh3OfficialRetry += 1;
      setTimeout(() => {
        startArtworkJob = null;
        ensureAnimatedStartBackgrounds();
      }, 60 * 1000);
    } else if (!officialMiss) {
      bh3OfficialRetry = 0;
    }
  })()
    .catch((error) => console.warn('启动页动图预取失败：', error.message))
    .finally(() => {
      startArtworkJob = null;
    });
  return startArtworkJob;
}

/*
 * 用户手动确认的版本号兜底（仅当官网静态页面确实挖不到版本号时才用，绝不编造）。
 * 明日方舟官网是 SPA，231KB 的静态 HTML 里完全不含版本号（连「2.7.81」都搜不到），
 * 所以自动同步拿不到；这里用用户给的权威值。游戏发新版本后需要同步更新这个表。
 */
const MANUAL_GAME_VERSIONS = {
  arknights: '2.7.81',
};

async function syncOfficialGame(game, backgrounds) {
  const site = OFFICIAL_SITES[game.builtinKey];
  if (!site) return { name: game.name, ok: false, error: '没有官网配置' };
  const result = {
    name: game.name,
    ok: false,
    version: game.version || null,
    versionName: game.versionName || null,
    cover: false,
    error: null,
  };

  let version = null;
  let versionName = '';
  let ogImage = '';
  try {
    const response = await fetch(site, {
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const html = await response.text();
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      const description = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
      // 版本号：先在 title/description 里找「X.Y版本」（米哈游系官网都这么写）；
      // 找不到再退回整页正文（终末地官网把版本号写在轮播/正文里，不在 title）。
      let versionMatch = `${title} ${description}`.match(/(\d+\.\d+)[^0-9]{0,10}版本/);
      if (!versionMatch) versionMatch = html.match(/(\d+\.\d+)[^0-9]{0,10}版本/);
      if (versionMatch) version = versionMatch[1];
      const versionNameMatch = html.match(/「([^」]{1,16})」版本(?:更新说明|PV)/);
      if (versionNameMatch) versionName = versionNameMatch[1];
      // 明日方舟官网是 SPA，静态 HTML 里不暴露任何版本号（实测 231KB 页面里连 2.7.81 都搜不到），
      // 所以站点正则永远挖不到。用用户确认的兜底值 MANUAL_GAME_VERSIONS.arknights（2.7.81），
      // 仅当真挖不到时才回退，不编造版本号。游戏更新后需同步更新那个表。
      if (game.builtinKey === 'arknights' && !version) {
        version = MANUAL_GAME_VERSIONS.arknights || null;
      }
      const ogMatch = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']*)["']/i);
      if (ogMatch && ogMatch[1]) {
        try {
          ogImage = new URL(ogMatch[1], site).href;
        } catch {
          ogImage = '';
        }
      }
      if (game.builtinKey === 'endfield') {
        const endfieldCover = pickEndfieldCover(html);
        if (endfieldCover) {
          try {
            ogImage = new URL(endfieldCover, site).href;
          } catch {
            /* keep share image */
          }
        }
      }
      if (game.builtinKey === 'neverness') {
        const nteVersion =
          html.match(/Version\s*([0-9]+(?:\.[0-9]+)?)/i) ||
          html.match(/web_event[_-]([0-9]+(?:\.[0-9]+)?)/i);
        if (nteVersion) version = nteVersion[1];
        const nteImage = pickNevernessCover(html);
        if (nteImage) ogImage = nteImage;
      }
      // 2.4.0 合并：明日方舟封面同步（官网轮播活动图 / 最新上传图）
      if (game.builtinKey === 'arknights') {
        const akImage = pickArknightsCover(html);
        if (akImage) {
          try {
            ogImage = new URL(akImage, site).href;
          } catch {
            /* keep share image */
          }
        }
      }
    }
  } catch (error) {
    result.error = error.message;
  }

  const background = latestBackground(backgrounds, game.builtinKey);
  // 去字缓存版本是 -clean3（v2 算法），失效的路径直接清掉
  if (game.startCover && !/-(?:clean2|clean3)\./.test(game.startCover)) game.startCover = '';
  // 2.4.0 合并：customCover 判定换成 isCustomCover（保护明日方舟 / 崩坏3 钉住的封面）
  const customCover = isCustomCover(game);
  const versionArtwork = customCover ? { image: '', video: '' } : await fetchVersionArtwork(game.builtinKey);
  const fromVersionArt = Boolean(versionArtwork.image);
  const imageUrl = versionArtwork.image || (background && background.url) || ogImage;
  if (customCover) {
    game.backgroundVideo = '';
    game.startCover = '';
  } else if (versionArtwork.video) {
    game.backgroundVideo = versionArtwork.video;
  }
  // 版本图复用规则：
  //   - 同一张图（对比 URL）且文件还在 -> 不重复下载
  //   - 游戏版本号变了 -> 强制重新取，保证「到下一个版本才换图」
  const versionChanged = Boolean(version && game.artVersion && version !== game.artVersion);
  const artFile =
    game.cover && /^covers\/official-/.test(game.cover)
      ? path.join(app.getPath('userData'), game.cover)
      : '';
  const reuseArt = Boolean(
    imageUrl &&
      game.artUrl === imageUrl &&
      artFile &&
      fs.existsSync(artFile) &&
      !versionChanged
  );
  if (reuseArt) {
    result.cover = true;
    result.coverReused = true;
    // 去字缓存可能被清掉过；复用原图时顺手补一次，别让启动页退回带字的版本
    if ((!game.startCover || !game.startCover.includes('-clean3.')) && fromVersionArt) {
      const cleanName = await ensureErasedCover(game.builtinKey, artFile).catch(() => null);
      if (cleanName) game.startCover = `covers/${cleanName}`;
    }
  } else if (imageUrl && !customCover) {
    try {
      const imageResponse = await fetch(imageUrl, {
        headers: { 'user-agent': BROWSER_UA, referer: site, accept: 'image/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
      });
      if (imageResponse.ok) {
        const buffer = Buffer.from(await imageResponse.arrayBuffer());
        if (buffer.length > 0 && buffer.length < 24 * 1024 * 1024) {
          const ext = imageExtension(imageUrl, imageResponse.headers.get('content-type'));
          const dir = path.join(app.getPath('userData'), 'covers');
          await fsp.mkdir(dir, { recursive: true });
          const fileName = `official-${game.builtinKey}${ext}`;
          // 官方图换格式（png → webp）或重新下载时，清掉同游戏的旧格式原图。
          // 否则每换一次格式就多留一份，userData/covers 会越堆越大（实测已堆 19MB 残留）。
          try {
            const pattern = new RegExp(
              `^official-${game.builtinKey}\\.(?:png|jpe?g|webp|gif|avif)$`,
              'i'
            );
            for (const old of await fsp.readdir(dir)) {
              if (old === fileName || !pattern.test(old)) continue;
              await fsp.unlink(path.join(dir, old)).catch(() => {});
            }
          } catch {
            /* 清不掉不影响主流程，启动时的封面清理会兜底 */
          }
          await fsp.writeFile(path.join(dir, fileName), buffer);
          game.cover = `covers/${fileName}`;
          game.artUrl = imageUrl;
          game.artVersion = version || game.version || '';
          result.cover = true;
          // 官方图常带烧录标题；生成一张去掉文字的版本给启动页用，
          // 游戏库封面仍用原图，避免影响卡片视觉。
          // 只有来源是官方版本图时才做去字；分享图/宣传图直接不进启动页
          const cleaned = fromVersionArt
            ? await ensureErasedCover(game.builtinKey, path.join(dir, fileName)).catch(() => null)
            : null;
          if (cleaned) {
            game.startCover = `covers/${cleaned}`;
            result.coverCleaned = true;
          } else {
            game.startCover = '';
          }
        }
      }
    } catch (error) {
      console.warn('官方背景下载失败：', error.message);
      result.error = error.message;
    }
  }

  if (version) {
    game.version = version;
    result.version = version;
  }
  if (versionName) {
    game.versionName = versionName;
    result.versionName = versionName;
  }
  if (version || versionName || result.cover) {
    result.ok = true;
    result.error = null;
    game.officialSyncedAt = new Date().toISOString();
  } else if (!result.error) {
    result.error = '没有找到可更新的版本或封面';
  }
  return result;
}

async function syncAllOfficial() {
  const targets = store.data.games.filter((game) => game.builtin && game.builtinKey);
  if (!targets.length) return [];
  const backgrounds = await fetchHoyoBackgrounds();
  const results = [];
  for (const game of targets) {
    results.push(await syncOfficialGame(game, backgrounds));
  }
  if (results.some((result) => result.ok)) {
    store.data.lastOfficialSync = Date.now();
    await store.saveNow();
    pushState(true);
  }
  return results;
}



function checkPath(candidate, def) {
  if (!candidate) return null;
  let value = expandEnv(candidate).trim().replace(/^"(.*)"$/, '$1').replace(/\//g, '\\');
  if (!value) return null;
  try {
    const stat = fs.statSync(value);
    if (stat.isFile()) {
      if (path.basename(value).toLowerCase() === def.exe.toLowerCase()) return value;
      const dir = path.dirname(value);
      for (const rel of def.relative) {
        const next = path.join(dir, rel);
        if (targetExists(next)) return next;
      }
      return null;
    }
    if (stat.isDirectory()) {
      for (const rel of def.relative) {
        const next = path.join(value, rel);
        if (targetExists(next)) return next;
      }
    }
  } catch {
    /* not found */
  }
  return null;
}

function decodeWindowsOutput(buffer) {
  if (!buffer || !buffer.length) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return buffer.toString('latin1');
    }
  }
}

function registryValues(key) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        'reg.exe',
        ['query', key, '/s'],
        { encoding: 'buffer', windowsHide: true, timeout: 2500, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve([]);
            return;
          }
          const output = decodeWindowsOutput(stdout);
          const values = [];
          for (const line of output.split(/\r?\n/)) {
            const match = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i);
            if (match) values.push(match[1]);
          }
          resolve(values);
        }
      );
    } catch {
      // 在受限环境里 spawn 可能直接抛出 EPERM；检测失败不应该让整个启动流程崩掉。
      resolve([]);
      return;
    }
    if (child && typeof child.on === 'function') {
      child.on('error', () => resolve([]));
    }
  });
}

function runtimePaths(baseRoot, gameKey, channel, overrideRoot = '') {
  /*
   * 基础客户端路径可能来自旧数据或手动填写的 "G:/Arknights Endfield"（正斜杠）。
   * path.parse('G:/x').root 得到的是 "G:/"，和目标盘符 "G:\\" 永远不相等，
   * 用户就会看到「运行时目录必须和基础客户端在同一个磁盘」——其实是同一块盘。
   * 这里先 normalize 再比较。
   */
  const baseDrive = path.parse(path.normalize(baseRoot || '')).root;
  const exact = String(overrideRoot || '').trim();
  const configured = String(store.data.settings.runtimeRoot || '').trim();
  const root = configured ? path.resolve(configured) : path.join(baseDrive, 'VelaRuntimes');
  /*
   * 自定义目录一律当「运行时根目录」用，自动补上 <游戏>\<渠道> 这一层。
   *
   * 以前弹窗里「选择目录」选中的文件夹会被当成客户端根，几十 GB 的游戏文件
   * 直接摊在你选的文件夹里 —— 看着就像「还是下到根目录了」。现在两种入口
   * （设置里的运行时目录 / 弹窗里临时选一个）语义一致：选父目录，子目录由
   * 启动器按游戏和渠道建，多个渠道也不会互相覆盖。
   */
  const withGameDir = (base) => {
    const resolved = path.resolve(base);
    const tail = path.join(gameKey, channel || '');
    return resolved.toLowerCase().endsWith(tail.toLowerCase())
      ? resolved
      : path.join(resolved, gameKey, channel || '');
  };
  const target = exact ? withGameDir(exact) : path.join(root, gameKey, channel);
  const sameDrive = path.parse(path.normalize(target)).root.toLowerCase() === baseDrive.toLowerCase();
  return {
    root,
    target,
    sameDrive,
    baseDrive,
  };
}

/*
 * ── 终末地：每渠道一份独立的硬链接运行时（2026-11-08 回归 v2.3.0 架构）──────
 *
 * 早期 v2.3.0 / Xel-Launcher / 三服切换器都是同一套：每个渠道一份独立目录，
 * 从官服本体整树硬链出来，只铺十几个渠道差异文件。2.6.0 之后改成「官服全量 base
 * + 936MB 差异大包覆盖」，本轮又一度改成「所有非官服渠道共用一个 work 目录、
 * 切服只铺不还原」——切国际服把国际服的 Endfield.exe / GameAssembly.dll /
 * UnityPlayer.dll 铺进 work，切 B服 时 B服 包不带这些重二进制，work 里就留着
 * 国际服那套；B服 用国际服 IL2CPP + B服 SDK 启动 6 秒直接崩（2026-11-08 报障），
 * 界面报「游戏文件损坏或缺失，要求重装游戏」。根因是「多个渠道共用一棵被叠加写入的树」。
 *
 * 现在回到每渠道独立：
 *   · 官服本体只读直启（directBase 分支），官方启动器维护的那份永远自洽、绝不写；
 *   · 其它每个渠道在 <运行时根>\endfield\<渠道> 各有一份独立目录，互不干扰；
 *   · 目录不存在 / 基础客户端更新 / 渠道包更新时，从基础客户端整树硬链重建，
 *     再只铺该渠道十几个差异文件（小渠道包，不含重二进制）；
 *   · 该渠道目录已就绪且签名未变时**完全跳过**，用户下好的语音包原样保留，
 *     切回来几秒完成、不重下一次；
 *   · 重建用 staging + 同卷 rename，且先把 Endfield_Data\Persistent 整体搬过去，
 *     所以整树重建也不会丢用户已下的语音包（11-07 事故的修复点）。
 *
 * 标记统一用 .hxl-endfield-runtime-v2：predownload / publicGame / 更新失效都认它。
 */
const ENDFIELD_RUNTIME_MARKER = '.hxl-endfield-runtime-v2';
// 建运行时时整棵强制拷贝的目录（多段前缀由 runtime.js 的 hardlinkTree 支持）。
//   U8Data / sdkdata：渠道登录态与 SDK 配置，硬链接会让一个渠道改写另一个渠道的身份；
//   Endfield_Data/Persistent：游戏自己维护的资源索引与已下载内容（约 3.9GB），
//     整棵拷过来之后它才真正「属于」该渠道的运行时。
const ENDFIELD_RUNTIME_COPY_DIRS = ['U8Data', 'sdkdata', 'Endfield_Data/Persistent'];

/** 两个路径是不是「同一个目录」或「互相包含」。运行时目录嵌进基础客户端里会把官服本体原地改写，反过来重建时也会连带删掉官服。 */
function pathsOverlap(left, right) {
  const norm = (value) =>
    path
      .resolve(String(value || ''))
      .toLowerCase()
      .replace(/[\\/]+$/, '');
  const a = norm(left);
  const b = norm(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

/**
 * 这个目录是不是我们生成/遗留的「绝不能当基础客户端」的运行时目录。
 *
 * 两个标记都认：
 *   · .hxl-endfield-runtime-v2 —— 当前架构的每渠道独立运行时；
 *   · .hxl-endfield-work-v1     —— 2026-11-08 那一版「所有非官服渠道共用一个 work」
 *     的混合体。它里面是「国际服重二进制 + 某渠道 SDK」的拼装结果，
 *     如果某个用户的 launcher-data.json 里 originalRoot 丢了、server.root 恰好
 *     指向它，endfieldBaseRoot 就会误把它当官服本体去硬链接出下一份运行时
 *     —— 那正是 B服 启动 6 秒崩的配方。认出来就能挡住，实测通过后这个目录会被删。
 */
function isEndfieldRuntimeDir(dir) {
  try {
    const base = String(dir || '');
    if (fs.existsSync(path.join(base, ENDFIELD_RUNTIME_MARKER))) return true;
    if (fs.existsSync(path.join(base, '.hxl-endfield-work-v1'))) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 一条 server 的路径是不是指向「旧单 work 混合目录」（本次回退要作废的那种）。
 *
 * 双判据，缺一不可省：
 *   · 路径尾部是 <根>\endfield\work —— 目录即使已被删除/重命名也认得出；
 *   · 目录里确有 .hxl-endfield-work-v1 标记 —— 覆盖自定义 runtimeRoot 的用户。
 * 用在升级迁移、以及「尽力而为」兜底前：指向它的路径绝不能当成「已就绪、
 * 可以静默沿用」，否则老用户升级后点开始游戏仍会启动那个 3~9 秒就崩的混合体。
 */
function isEndfieldLegacyWorkRoot(dir) {
  const value = String(dir || '');
  const normalized = value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  if (normalized.endsWith('\\endfield\\work')) return true;
  try {
    return fs.existsSync(path.join(value, '.hxl-endfield-work-v1'));
  } catch {
    return false;
  }
}

function readEndfieldRuntimeMarker(runtimeRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runtimeRoot, ENDFIELD_RUNTIME_MARKER), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // 老架构的标记是纯文本签名（不是 JSON）：读不出来就当没建过，走重建（会保留 Persistent）。
    return null;
  }
}

function writeEndfieldRuntimeMarker(runtimeRoot, payload) {
  try {
    const markerPath = path.join(runtimeRoot, ENDFIELD_RUNTIME_MARKER);
    // 「源=运行时」重建时，hardlinkTree 会把源运行时的 marker 一起硬链进目标；
    // 直接 writeFileSync 覆写会写穿同一个 inode，把源渠道的 marker 也改掉
    // （正是之前弄坏官服的同款形状）。写之前先断链，保证目标永远是独立文件：
    // 目标是硬链时只删这一个 link（源保留），目标是独立文件时重写的等价新建。
    // 真实客户端当源时源目录根本没有 marker，这条分支不受影响。
    try { fs.rmSync(markerPath, { force: true }); } catch {}
    fs.writeFileSync(
      markerPath,
      JSON.stringify(payload, null, 2),
      'utf8'
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 基础客户端里「只读、可以硬链接」那一部分的指纹（文件数:总字节）。
 *
 * 不算可写文件：游戏每次启动都会写日志、下语音包，那些变化不该让工作目录整体刷新。
 * 只统计 mustCopyNotLink 为假的那一批（StreamingAssets 的 .chk、CefView、plugins、各个 dll），
 * 它们才是「基础客户端更新了就该重新链接」的对象。
 */
async function endfieldBaseSignature(baseRoot) {
  const files = await walkFiles(baseRoot);
  let count = 0;
  let bytes = 0;
  for (const file of files) {
    if (mustCopyNotLink(file.rel)) continue;
    count += 1;
    bytes += file.size;
  }
  return `${count}:${bytes}`;
}

function endfieldBaseRoot(server) {
  const originalRoot = String(server?.originalRoot || '').trim();
  if (originalRoot && fs.existsSync(originalRoot) && !isEndfieldRuntimeDir(originalRoot)) {
    return path.normalize(originalRoot);
  }
  const root = String(server?.root || '').trim();
  // 允许拿任何已经存在的客户端目录当基础（例如别的渠道装好的完整客户端），只要它真的装着
  // Endfield.exe。以前这里会拒绝 VelaRuntimes / .vela-linked-runtime 路径，导致「国际服切官服」
  // 找不到基础客户端而报错；同源目录会在生成前用重叠校验拦住。
  // 但「生成的渠道运行时」本身绝不能当基础：它是渠道包覆盖出来的混合文件，拿它当基础
  // 会把上一个渠道的残留当成新运行时的起点。每渠道运行时由 server.path/root 指向，
  // originalRoot 才记着真正的安装目录。
  if (root && fs.existsSync(root) && fs.existsSync(path.join(root, 'Endfield.exe'))) {
    if (isEndfieldRuntimeDir(root)) return '';
    return path.normalize(root);
  }
  return '';
}

// 终末地的 config.ini 是二进制，读不出渠道；只能按渠道独有的文件特征判断。
//   B服     ：BLPlatform64/ 或 PCGameSDK.dll
//   国际服  ：gfsdk.dll / glfoundation.dll / sdkdata\sdk_glsdk_config.*
//   官服    ：hgsdk.dll / sdk_data.dat / sdkresources/ / sdkdata\sdk_hgsdk_config.*
//   Play    ：play_pc_sdk.dll / manifest.xml
//   Steam   ：steam_api64.dll / steam_appid.txt
// 注意顺序：Play / Steam 的差异包里也带 gfsdk、glfoundation，渠道运行时里也会保留
// 从基础客户端链接过来的 hgsdk.dll，所以必须从最独特的特征开始判断。
function endfieldChannelOf(root) {
  const dir = String(root || '').trim();
  if (!dir) return '';
  const has = (name) => {
    try {
      return fs.existsSync(path.join(dir, name));
    } catch {
      return false;
    }
  };
  let sdkFiles = [];
  try {
    sdkFiles = fs.readdirSync(path.join(dir, 'sdkdata')).map((name) => String(name).toLowerCase());
  } catch {
    sdkFiles = [];
  }
  const hasSdk = (prefix) => sdkFiles.some((name) => name.startsWith(prefix));
  if (has('play_pc_sdk.dll') || has('manifest.xml')) return 'play';
  if (has('steam_api64.dll') || has('steam_appid.txt')) return 'steam';
  if (has('BLPlatform64') || has('PCGameSDK.dll')) return 'bilibili';
  // sdkdata 里的渠道配置是「链接运行时」最权威的渠道标记：生成运行时只会保留目标渠道自己的
  // sdk_*_config（ENDFIELD_SDK_KEEP），而基础客户端遗留下来的 hgsdk/gfsdk.dll 反而会误判渠道。
  // 因此先按 sdk 配置判渠道，且官服（sdk_hgsdk_config）必须排在 global（sdk_glsdk_config）之前，
  // 否则用国际服客户端当基础生成的官服运行时会被误判成国际服（见 Bug 2）。
  if (hasSdk('sdk_hgsdk_config')) return 'official';
  if (hasSdk('sdk_glsdk_config')) return 'global';
  // sdkdata 配置缺失时（原始客户端还没生成过运行时）退回 dll 特征判断。
  if (has('hgsdk.dll') || has('sdk_data.dat') || has('sdkresources')) return 'official';
  if (has('gfsdk.dll') || has('glfoundation.dll')) return 'global';
  if (/bilibili|b服/i.test(dir)) return 'bilibili';
  if (/global|国际服/i.test(dir)) return 'global';
  return '';
}

// 不再假设「官服一定装着」。用户真正装好的任意渠道客户端（官服 / B服 / 国际服 / Play / Steam）
// 都能当基础：生成链接运行时本来就是「复制基础客户端 + 覆盖渠道差异文件」。
// 官服仍然排在最前（和官服比对时能链接的文件最多），但不再是必需条件。
function endfieldBaseServer(game, excludeId = '') {
  const servers = Array.isArray(game?.servers) ? game.servers : [];
  const order = ['official', 'global', 'bilibili', 'play', 'steam'];
  const candidates = [];
  for (const server of servers) {
    if (excludeId && server.id === excludeId) continue;
    const baseRoot = endfieldBaseRoot(server);
    if (!baseRoot) continue;
    if (!fs.existsSync(path.join(baseRoot, 'Endfield.exe'))) continue;
    candidates.push({
      server,
      baseRoot,
      channel: endfieldChannelOf(baseRoot) || String(server.channel || ''),
    });
  }
  if (!candidates.length) return null;
  const rank = (item) => {
    const index = order.indexOf(item.channel);
    return index < 0 ? order.length : index;
  };
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0];
}

// ── 运行时当源（MVP-1 / #6 主体）────────────────────────────────────
// 只在「所有渠道都只剩 VelaRuntimes 里的硬链接运行时」时启用，且必须由调用方
// 显式传 allowRuntimeBase:true。endfieldBaseRoot 的闸门（拒绝把生成的运行时
// 当基础）一个字符都不动 —— 这个函数是平行的第三级，不是它的替代品。
//
// 五个渠道（官服 / B服 / 国际服 / Play / Steam）任意渠道互相为源：相同文件硬链
// 复用，差异文件由渠道包覆盖。跨族（Hypergryph ↔ Gryphline）时源树里的 5 颗重
// 二进制（Endfield.exe / UnityPlayer.dll / ACE 两颗 / CrashSight64.dll）是源渠道版，
// 与目标 SDK 不配套会 6 秒崩；五个渠道包都已补上各自目标版的 5 颗，overlay 会先
// 断链再 copy 成目标版，壳与件刷成同一套，不会混搭。Play / Steam 同样在表内
// （用户 2026-11-10 拍板本轮一起做）：它们的 5 颗由各自 Gryphline 官方清单按同名
// 路径下载，不是硬编码内容，清单没给时既有 channelPackFilesReady 门禁判未就绪。
const ENDFIELD_RUNTIME_BASE_FAMILY = {
  official: ['official', 'bilibili', 'global', 'play', 'steam'],
  bilibili: ['official', 'bilibili', 'global', 'play', 'steam'],
  global: ['official', 'bilibili', 'global', 'play', 'steam'],
  play: ['official', 'bilibili', 'global', 'play', 'steam'],
  steam: ['official', 'bilibili', 'global', 'play', 'steam'],
};

// 以运行时为源时，这些必须改成真拷贝而不是共享 inode：
// hardlinkTree 对 .exe/.dll 走的是 fsp.link（runtime.js:263-278），而渠道包
// overlay 会原地重写它们（overlayDirectory 先 rm 再 copy，会断链 —— 但如果
// 目标文件压根没被 overlay 覆盖到，两个渠道就会永远共用同一个 inode）。
const ENDFIELD_SAFE_INHERIT_COPY = [
  'Endfield.exe',
  'UnityPlayer.dll',
  'GameAssembly.dll',
  'PlatformProcess.exe',
  'EndfieldBase.dll',
  'HGP.dll',
  'OneChannelLC.dll',
  'u8_channel.dll',
  'U8SDK.dll',
  'U8CoreUI.dll',
  'webviewsdk.dll',
  'PCGameSDK.dll',
  'hgsdk.dll',
  'config.ini',
  'AntiCheatExpert',
  'Endfield_Data/Plugins',
];

// ACE 的 pld.dat 是机器/渠道绑定的本地载荷（官服 234173 / B服 234176 /
// 国际服 7209，且不在 verify_files.json 的 521 条里、五个渠道包也都不带）。
// 注意：hardlinkTree 的 copyDirs 只能「整段 copy」，语法上无法排除单个文件
// （runtime.js:259-262 是前缀匹配，没有 exclude 参数）。所以这里**不引入
// 排除机制**：AntiCheatExpert 整目录走 copy，pld.dat 会被原样复制一份到目标树。
// 这比「不列 AntiCheatExpert、让它硬链共享 inode」更安全 —— 共享 inode 一旦被
// ACE 原地重写就是写穿（现网官服 pld.dat 与 bench 残留目录 n=2 就是这个形状）。
// 「copy 过来的 pld.dat 会不会让新渠道起不来」属于未证实项，见 §2.1 的 E1–E3
// 与 §7 的 U1，必须真机验证；本轮不臆断，也不额外加删除逻辑。

function endfieldRuntimeAsBase(game, server, channel, excludeRoot) {
  const family = ENDFIELD_RUNTIME_BASE_FAMILY[channel];
  if (!family) return null;                       // 跨族：本轮不放开，直接拒绝
  const servers = Array.isArray(game?.servers) ? game.servers : [];
  const picked = [];
  for (const item of servers) {
    if (server && item.id === server.id) continue; // 不能拿自己当源
    const root = String(item.root || '').trim();
    if (!root) continue;
    if (!isEndfieldRuntimeDir(root)) continue;     // 只接受「运行时」，不是真实安装目录
    if (!fs.existsSync(path.join(root, 'Endfield.exe'))) continue;
    const marker = readEndfieldRuntimeMarker(root);
    if (!marker) continue;                         // 读不出 marker＝来路不明，宁可不用
    const sourceChannel = String(marker.channel || endfieldChannelOf(root) || '');
    if (family.indexOf(sourceChannel) < 0) continue;
    if (excludeRoot && pathsOverlap(root, excludeRoot)) continue;
    picked.push({ server: item, baseRoot: path.normalize(root), channel: sourceChannel, marker });
  }
  if (!picked.length) return null;
  const rank = (item) => (item.channel === 'official' ? 0 : 1); // 官服系优先：能链接的文件最多
  picked.sort((a, b) => rank(a) - rank(b));
  const best = picked[0];
  return {
    baseRoot: best.baseRoot,
    baseKind: 'runtime',
    baseChannel: best.channel,
    baseRealRoot: String(best.marker.baseRealRoot || best.marker.baseRoot || ''),
    sourceServer: best.server,
  };
}

// 统一的基础解析（ensure 与 prepareJob 共用，保证「估算能过、真跑也能过」）
// 三级：① 自己记住的真实安装目录 → ② 别的服务器行上的真实安装目录
//       → ③ 运行时当源（默认关闭，必须 allowRuntimeBase:true）
function endfieldResolveBase(game, server, channel, options = {}) {
  const realRoot = endfieldBaseRoot(server);
  if (realRoot && fs.existsSync(path.join(realRoot, 'Endfield.exe'))) {
    return {
      baseRoot: realRoot,
      baseKind: 'real',
      baseChannel: endfieldChannelOf(realRoot) || String(channel || ''),
      baseRealRoot: realRoot,
    };
  }
  const other = endfieldBaseServer(game, server?.id) || endfieldBaseServer(game);
  if (other && other.baseRoot && fs.existsSync(path.join(other.baseRoot, 'Endfield.exe'))) {
    return {
      baseRoot: other.baseRoot,
      baseKind: 'real',
      baseChannel: other.channel || '',
      baseRealRoot: other.baseRoot,
    };
  }
  if (options.allowRuntimeBase === true) {
    const runtimeBase = endfieldRuntimeAsBase(game, server, channel, options.runtimeRoot || '');
    if (runtimeBase) return runtimeBase;
  }
  return null;
}

// 目标渠道运行时里允许保留哪些 SDK 配置文件。基础客户端（可能是官服 / B服 / 国际服）
// 复制过来的其它渠道 SDK 配置会让运行时仍走错误的登录通道，必须清掉。
const ENDFIELD_SDK_KEEP = {
  official: ['sdk_hgsdk_config'],
  bilibili: [],
  global: ['sdk_glsdk_config'],
  play: ['sdk_glsdk_config'],
  steam: ['sdk_hgsdk_config', 'sdk_glsdk_config'],
};

// 各渠道差异包目录名（官服也走同一套自动生成链路）。
const ENDFIELD_PACK_NAMES = {
  official: 'EndOfficial',
  bilibili: 'EndBilibili',
  global: 'EndGlobal',
  play: 'EndPlay',
  steam: 'EndSteam',
};

function discoverServerRoots() {
  const roots = new Set();
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`;
    if (!fs.existsSync(drive)) continue;
    for (const name of [
      '米哈游',
      '米哈游国际服',
      '米哈游B服',
      '米哈游哔哩哔哩',
      'miHoYo切换器',
      'HoYoPlay',
      'HoYoPlay\\games',
      'Games',
      'Star Rail',
      'Genshin Impact',
      'Genshin Impact Game',
      'Zenless Zone Zero',
      'Program Files\\HoYoPlay\\games',
      'Arknights Endfield',
      'Endfield',
      'Games\\Arknights Endfield',
      'Hypergryph',
      'Hypergryph\\Arknights Endfield',
      'Program Files\\Hypergryph\\Arknights Endfield',
      'Starward',
      // Yostar 官方启动器与我方一键下载都会把明日方舟国际服放在这些目录下；
      // 不列进来的话已装好的三区客户端只能靠用户手动选路径（见 bug #3）。
      'YostarGames',
      'YostarGames\\Arknights_EN',
      'YostarGames\\Arknights_JP',
      'YostarGames\\Arknights_KR',
      'HuaXiaoLingGames',
      // 米哈游四款切服生成的独立硬链接运行时在这里。只列这四款精确子目录，
      // 绝不列 'VelaRuntimes' 整棵 —— 终末地运行时也在那棵树下，扫进去会把
      // 它的渠道专属 .exe/.dll 当候选，正是之前弄坏官服的配方。
      // walkExecutables 按当前游戏的 exe 名过滤，别的游戏不会误匹配。
      'VelaRuntimes\\genshin',
      'VelaRuntimes\\starrail',
      'VelaRuntimes\\zzz',
      'VelaRuntimes\\bh3',
    ]) {
      roots.add(path.join(drive, name));
    }
  }
  // 用户在设置里自定义过运行时根时，米哈游四款的硬链接运行时不在默认
  // VelaRuntimes 下。只补这四款精确子目录，扫到的 exe 仍要过 B3 渠道护栏。
  const customRoot = String(store.data.settings.runtimeRoot || '').trim();
  if (customRoot) {
    for (const gameKey of MIHOYO_RUNTIME_KEYS) {
      roots.add(path.resolve(customRoot, gameKey));
    }
  }
  return [...roots].filter((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

function walkExecutables(root, names, depth = 3) {
  const found = [];
  const queue = [{ dir: root, level: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && names.some((name) => name.toLowerCase() === entry.name.toLowerCase())) {
        found.push(path.join(current.dir, entry.name));
      }
    }
    if (current.level >= depth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.vela-') || entry.name === 'chunk') continue;
      queue.push({ dir: path.join(current.dir, entry.name), level: current.level + 1 });
    }
  }
  return found;
}

/**
 * 终末地：确保某个渠道的「链接运行时」存在。
 *
 * 以前只有官服在切换/启动时会自动生成；B服等渠道每次都得手动点「重建」，
 * 而且重建成功后配置里的 incomplete 标记没被清掉，启动页小点一直是红的。
 * 现在所有渠道共用同一条链路：运行时缺失或缺 v2 标记就自动生成一次，
 * 成功后写 v2 标记并清掉 incomplete。
 * 失败直接抛错（错误文案沿用原手动重建入口的提示）。
 */
/**
 * 终末地：删掉 runtime 里「不属于目标渠道」的 SDK/平台文件。
 * XelLauncher 用 manifest 的 Removed 字段做这一步，我们之前缺了它：基础客户端若是国际服/B服，
 * 会硬链接带来 gfsdk/hgsdk/PCGameSDK/BLPlatform64 等外渠道 SDK，叠加后官服运行时混装多套 SDK
 * → U8SDK 选错 provider → 切回官服不弹登录 / 循环报缺失。
 * 规则：只删「已知渠道 SDK 特征、且目标渠道包里没有」的文件/目录，绝不碰普通游戏资源文件。
 */
/*
 * 把 srcDir 里的文件按 mtime 同步到 dstDir：目标缺少或源文件更新时才复制。
 * 用于官服运行时跟随基础客户端刷新平台状态（U8Data / sdkdata），
 * 只增改不删除，单个文件失败不影响整体。
 */
async function syncNewerFiles(srcDir, dstDir) {
  let entries;
  try {
    entries = await fsp.readdir(srcDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let synced = 0;
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      synced += await syncNewerFiles(src, dst);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const sb = await fsp.stat(src);
      const sr = await fsp.stat(dst).catch(() => null);
      if (sr && sb.mtimeMs <= sr.mtimeMs) continue;
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
      synced += 1;
    } catch {
      /* 单个文件被占用或复制失败，跳过 */
    }
  }
  return synced;
}

/*
 * 每个终末地渠道「运行时里绝对不能有」的其它渠道专属件。
 *
 * 2026-10-31 报障：切到国际服点开始游戏，进程 3 秒就退，Windows 事件日志是
 * BEX64 / 0xc0000005（模块 unknown），Faulting 路径指向 global\Endfield.exe。
 * 根因是运行时里同时躺着两套平台 SDK：国服/B服 的 hgsdk.dll（从基础客户端
 * 硬链接/补缺进来的）和国际服包自带的 gfsdk.dll + glfoundation.dll。
 * 两套 SDK 在平台层初始化时抢同一批符号，直接访问冲突。
 *
 * B服 例外：它走鹰角账号，仍然需要 hgsdk.dll，所以 B服 只清 Gryphline 那套。
 * 方舟不走这张表（它有自己的运行时目录，且官服/B服 都只用 hgsdk）。
 */
const ENDFIELD_FOREIGN_FILES = {
  official: ['gfsdk.dll', 'glfoundation.dll', 'PCGameSDK.dll', 'BLPlatform64', 'discord_partner_sdk.dll', 'socialsdk_gf.dll'],
  bilibili: ['gfsdk.dll', 'glfoundation.dll', 'discord_partner_sdk.dll', 'socialsdk_gf.dll'],
  global: ['hgsdk.dll', 'PCGameSDK.dll', 'BLPlatform64'],
  play: ['hgsdk.dll', 'PCGameSDK.dll', 'BLPlatform64'],
  steam: ['hgsdk.dll', 'PCGameSDK.dll', 'BLPlatform64'],
};

/** 按上表把别的渠道的 SDK 文件从运行时里清掉，返回删掉的条数。 */
async function purgeForeignChannelFiles(runtimeRoot, channel) {
  const list = ENDFIELD_FOREIGN_FILES[channel] || [];
  let removed = 0;
  for (const name of list) {
    const full = path.join(runtimeRoot, name);
    try {
      const stat = await fsp.stat(full);
      if (stat.isDirectory()) await fsp.rm(full, { recursive: true, force: true });
      else await fsp.rm(full, { force: true });
      removed += 1;
    } catch {
      /* 本来就不在 */
    }
  }
  return removed;
}

async function reconcileEndfieldRuntime(runtimeRoot, packDir, channel) {
  const KNOWN = new Set([
    'gfsdk.dll',
    'glfoundation.dll',
    'glextra.dll',
    'pcgamesdk.dll',
    'steam_api64.dll',
    'steam_appid.txt',
    'play_pc_sdk.dll',
    'game_security_protection.exe',
    'manifest.xml',
  ]);
  // 注意：以下文件不能进上面这个删除清单（都是官方基础客户端自带的全渠道通用
  // 文件，两个渠道的官方安装都有，渠道差异包里不一定带，删了官方完整性校验直接
  // 报「检查资源完整性时发现异常，请重新下载缺失的文件」）：
  //   - platformprocess.exe：官方平台进程，decoy/UAC 启动链的父进程（10-29 报障根因一）。
  //   - webviewsdk.dll：内嵌 WebView，登录/活动页依赖（10-29 报障根因二，完整性校验报缺失）。
  //   - hgsdk.dll：鹰角官方 SDK，B服差异包不带，误删后 B服同样报完整性异常。
  //   - onechannellc.dll：官方 OneChannel 组件，两渠道包虽都带，但保底不能靠包。
  const KNOWN_DIRS = new Set(['blplatform64']);
  // 本渠道不该有的外渠道 SDK（hgsdk ↔ gfsdk 两套互斥）也当成已知件处理，
  // 具体清单和根因见 ENDFIELD_FOREIGN_FILES 上方注释。
  for (const name of ENDFIELD_FOREIGN_FILES[channel] || []) KNOWN.add(name.toLowerCase());
  // 目标渠道包自己携带的 SDK 特征（首层 basename + 首层目录），这些是目标权威文件，必须保留。
  const keepArtifacts = new Set();
  const keepDirs = new Set();
  const collect = async (dir, top) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (top) keepDirs.add(e.name.toLowerCase());
        await collect(full, false);
      } else if (top) {
        keepArtifacts.add(e.name.toLowerCase());
      }
    }
  };
  await collect(packDir, true);
  const topEntries = await fsp.readdir(runtimeRoot).catch(() => []);
  for (const name of topEntries) {
    const full = path.join(runtimeRoot, name);
    const isDir = (await fsp.stat(full).catch(() => null))?.isDirectory();
    const lower = name.toLowerCase();
    if (isDir) {
      if (KNOWN_DIRS.has(lower) && !keepDirs.has(lower)) {
        await fsp.rm(full, { recursive: true, force: true });
      }
    } else if (KNOWN.has(lower) && !keepArtifacts.has(lower)) {
      await fsp.rm(full, { force: true });
    }
  }
  // U8Data/config：按内容哈希命名、随渠道而变。删掉 runtime 里基础残留、目标包没有的 config
  // 文件，避免两套渠道 config 并存导致 U8SDK 配置冲突（只动这个子目录，不碰 U8Data 其它内容）。
  await reconcileDirSubset(
    path.join(runtimeRoot, 'U8Data', 'config'),
    path.join(packDir, 'U8Data', 'config')
  );
}

/**
 * 渠道包会随官方版本持续自动更新（EndfieldBase.dll 等渠道差异文件会变），
 * 而已建好的运行时带着 v2 标记不会触发重建。这里把「包里内容与运行时
 * 不一致（或运行时缺失）」的文件补进去：先解除硬链接再复制，
 * 避免把基础客户端 / 别的渠道一起改掉。返回更新的文件数。
 */
async function syncEndfieldPackDelta(runtimeRoot, packDir) {
  const files = await walkFiles(packDir);
  const md5File = (file) =>
    new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      fs.createReadStream(file)
        .on('data', (chunk) => hash.update(chunk))
        .on('error', reject)
        .on('end', () => resolve(hash.digest('hex')));
    });
  let patched = 0;
  for (const file of files) {
    const target = path.join(runtimeRoot, file.rel);
    let same = false;
    try {
      const stat = await fsp.stat(target);
      if (stat.size === file.size) {
        // 渠道差异文件跨渠道时尺寸几乎都不同（EndfieldBase/HGP/OneChannelLC），
        // 尺寸相同的大文件（BLWebBrowser 的 libcef 这类）没必要每次启动都读一遍
        // md5：只校验 48MB 以下的小文件，超过的直接当一致。
        if (file.size <= 48 * 1024 * 1024) {
          same = (await md5File(target)) === (await md5File(file.full));
        } else {
          same = true;
        }
      }
    } catch {
      same = false;
    }
    if (same) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rm(target, { force: true });
    await fsp.copyFile(file.full, target).catch(() => {});
    patched += 1;
  }
  return patched;
}

/** 删掉 runtime 子目录里「不在目标包对应子目录」的文件；包里没有该子目录时不删，避免误删。 */
async function reconcileDirSubset(runtimeSub, packSub) {
  let packFiles = [];
  try {
    packFiles = (await fsp.readdir(packSub)).map((name) => name.toLowerCase());
  } catch {
    return;
  }
  if (!packFiles.length) return;
  const packSet = new Set(packFiles);
  let runtimeFiles = [];
  try {
    runtimeFiles = await fsp.readdir(runtimeSub);
  } catch {
    return;
  }
  for (const name of runtimeFiles) {
    if (!packSet.has(name.toLowerCase())) {
      await fsp.rm(path.join(runtimeSub, name), { force: true });
    }
  }
}

/* ── 渠道包：按需下载与本机状态 ───────────────────────────────────── */

const ENDFIELD_CHANNEL_LABEL = {
  official: '官服',
  bilibili: 'B服',
  global: '国际服',
  play: 'Play',
  steam: 'Steam',
};

/** 写渠道包用的目录：用户指定的目录优先，不可写时落到我们自己的数据目录。 */
function endfieldPackWritableRoot() {
  const configured = String(store.data.settings.endfieldPackRoot || '').trim();
  if (configured) {
    try {
      fs.accessSync(configured, fs.constants.W_OK);
      return configured;
    } catch {
      /* 别人只读的 load 目录 / 随包目录，不往里写 */
    }
  }
  return path.join(app.getPath('userData'), 'endfield-packs');
}

/**
 * 随安装包分发的内置渠道包：在程序目录里，只读。全新机器靠它开箱即用。
 * 判定交给 bundledEndfieldPackRoot，两边只认同一个地方。
 */
function builtinPackRoot() {
  return bundledEndfieldPackRoot();
}

/**
 * Xel-Launcher 把切服差异文件放在「自己目录下的 load\」里，渠道目录名和我们
 * 完全一致（EndOfficial / EndBilibili / ArkBilibili / …）。装了它的机器上这些包
 * 是现成的，借用一下就不用再下一遍 —— 只读，不往里写。
 */
function xelLauncherLoadDirs() {
  const bases = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const dirs = [];
  for (const base of bases) dirs.push(path.join(base, 'XelLauncher', 'load'));
  return dirs;
}

/**
 * 渠道包目录的所有候选位置，按优先级排列。
 *
 * 用户指认的最优先；其次是我们自己数据目录里那份（自动更新在维护它，通常比
 * 发版那一刻新）；然后才是随安装包分发的内置包 —— 它是「新装机开箱即用」的
 * 保底，也是用户数据被清光之后的退路。Xel-Launcher 的 load 目录垫底。
 */
/** 各渠道包目录名：终末地五个 + 明日方舟两个。 */
const ENDFIELD_PACK_DIRS = Object.values(ENDFIELD_PACK_NAMES);
const ARKNIGHTS_PACK_DIRS = [
  ARKNIGHTS_OFFICIAL_PROFILE.directory,
  ARKNIGHTS_BILIBILI_PROFILE.directory,
];

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        if (entry.isDirectory()) stack.push(path.join(current, entry.name));
        else total += fs.statSync(path.join(current, entry.name)).size;
      } catch {
        /* 跳过读不到的 */
      }
    }
  }
  return total;
}

/**
 * 渠道包现在占了多少空间、都放在哪。
 * 界面要能直说「点一下能释放 630MB」，而不是让用户自己去资源管理器里猜。
 */
function describePackUsage() {
  const measure = (root, dirs) => {
    let bytes = 0;
    const found = [];
    for (const name of dirs) {
      const dir = path.join(root, name);
      if (!fs.existsSync(dir)) continue;
      bytes += dirSize(dir);
      found.push(name);
    }
    return { bytes, dirs: found };
  };
  const builtin = builtinPackRoot();
  const writable = endfieldPackWritableRoot();
  const empty = { bytes: 0, dirs: [] };
  return {
    builtin: {
      root: builtin,
      endfield: builtin ? measure(builtin, ENDFIELD_PACK_DIRS) : empty,
      arknights: builtin ? measure(builtin, ARKNIGHTS_PACK_DIRS) : empty,
    },
    writable: {
      root: writable,
      endfield: measure(writable, ENDFIELD_PACK_DIRS),
      arknights: measure(writable, ARKNIGHTS_PACK_DIRS),
    },
  };
}

function endfieldPackCandidateRoots() {
  const roots = [String(store.data.settings.endfieldPackRoot || '').trim()].filter(Boolean);
  roots.push(endfieldPackWritableRoot());
  const builtin = builtinPackRoot();
  if (builtin) roots.push(builtin);
  roots.push(...xelLauncherLoadDirs());
  return roots.filter((root, index, list) => list.indexOf(root) === index);
}

/**
 * 保证某个渠道的渠道包在本机存在，没有就现下那一个。
 *
 * 以前切服前要求「渠道包目录已存在」，而渠道包既不随安装包分发、也只在
 * 装了 XelLauncher 的机器上才能被扫到 —— 新用户看到的就是「渠道差异包不
 * 存在」，扫到别人只装了 B服 的 load 目录时又只有 B服 能用。
 * 现在：缺哪个渠道就下哪个（单渠道几十 MB，比一次下齐五个轻得多）。
 */
async function ensureEndfieldPackFor(channel, onProgress, options = {}) {
  const packName = ENDFIELD_PACK_NAMES[channel];
  if (!packName) throw new Error(`这个服务器没有对应的渠道差异包（${channel}）`);
  const label = ENDFIELD_CHANNEL_LABEL[channel] || packName;
  const profile = (ENDFIELD_PACK_PROFILES || []).find((item) => item.directory === packName);
  if (!profile) throw new Error(`没有找到 ${packName} 的渠道配置`);
  /*
   * 先扫一遍所有候选位置（含 Xel-Launcher 的 load 目录）：那边有就直接借。
   * 「有」的判断和切服弹窗、设置页徽章共用 channelPackFilesReady —— 带 packRev
   * 的渠道要有对应版本的 .state 记录才算数：2.6.0~2.9.5 下过的那份 936 MB
   * 大差异包、以及更早随安装包内置的小 SDK 包，都没有这个记录 → 判未就绪 →
   * 重下当前这一份小渠道包（updateProfile 整包替换），老用户自动收敛到小包。
   */
  for (const root of endfieldPackCandidateRoots()) {
    const dir = path.join(root, packName);
    if (channelPackFilesReady(profile, dir)) return { packDir: dir, downloaded: false };
  }
  const root = endfieldPackWritableRoot();
  const packDir = path.join(root, packName);
  if (channelPackFilesReady(profile, packDir)) {
    await rememberEndfieldPackRoot(root);
    return { packDir, downloaded: false };
  }
  // 启动游戏这种「已经能跑就别等」的场景不下：几十 MB 会把「点开始游戏」拖成一次等待
  if (options.download === false) {
    throw new Error(`本机还没有${label}渠道包（切到${label}时会自动补下，也可以在设置 → 终末地渠道包里点一次下载）`);
  }
  if (typeof onProgress === 'function') {
    onProgress({
      phase: 'pack',
      processed: 0,
      total: 0,
      bytesDone: 0,
      totalBytes: 0,
      percent: 0,
      current: `正在下载${label}渠道包…`,
    });
  }
  /*
   * 必须把 onProgress 接下去。
   * 以前这里只发了一条「正在下载…」的开场事件就去 await 了，下载途中一个进度
   * 都收不到：界面停在「下载 0 · 0 KB / 0 KB」，用户只能看见网速在动、进度条不动。
   */
  await updateEndfieldProfile(profile, root, (progress) => {
    if (typeof onProgress !== 'function') return;
    onProgress({ ...progress, phase: 'pack', current: `正在下载${label}渠道包…` });
  });
  await rememberEndfieldPackRoot(root);
  return { packDir, downloaded: true };
}

async function rememberEndfieldPackRoot(root) {
  if (String(store.data.settings.endfieldPackRoot || '') !== root) {
    store.data.settings.endfieldPackRoot = root;
    await store.saveNow();
  }
  refreshPackChannels();
}

/**
 * 明日方舟 B服 渠道包：把 B服 专属的那套 SDK 备到本机。
 *
 * 官服和 B服 共用同一个安装目录，B服 只是多出渠道 SDK 那几样；以前没有时只能
 * 让用户自己先用 B服 官方启动器装一遍。这里试着从官方接口取一次 —— 但接口上
 * 到底有没有明日方舟 B服 的清单还没在真机上验证过，所以每一步都有闸门：
 * 先确认清单确实是方舟的（verifyArknightsBilibiliSource），取不到就返回空串，
 * 由调用方退回原来的提示。取到的包按渠道包目录缓存，不会每次切服都重下。
 * 装了 Xel-Launcher 的机器上，它的 load\ArkBilibili / load\ArkOfficial 会先被借来用。
 */
async function ensureArknightsPack(profile, readyFiles, label, onProgress) {
  const ready = (dir) => readyFiles.every((item) => fs.existsSync(path.join(dir, ...item.split('/'))));
  // 装了 Xel-Launcher 的机器上这两个包是现成的，先借再谈下载
  for (const root of endfieldPackCandidateRoots()) {
    const found = path.join(root, profile.directory);
    if (ready(found)) return found;
  }
  const root = endfieldPackWritableRoot();
  const packDir = path.join(root, profile.directory);
  // 两家用同一个接口，只靠 appcode / channel 区分：配错也会照常返回一份清单，
  // 而终末地的清单里同样有这些通用件。先看清单里有没有 Arknights.exe 再动手。
  if (!(await verifyArknightsSource(profile))) return '';
  const relay = (progress) => {
    if (typeof onProgress !== 'function') return;
    // 同上：字节字段要一起带出去，否则界面只能显示 0 KB / 0 KB
    onProgress({
      ...progress,
      phase: 'pack',
      current: `正在下载${label}渠道文件：${progress.current || ''}`,
    });
  };
  relay({ processed: 0, total: 0, current: `正在获取${label}渠道清单…` });
  try {
    await updateEndfieldProfile(profile, root, relay);
  } catch {
    return '';
  }
  return ready(packDir) ? packDir : '';
}

async function ensureArknightsBilibiliPack(onProgress) {
  return ensureArknightsPack(
    ARKNIGHTS_BILIBILI_PROFILE,
    ARKNIGHTS_BILIBILI_READY,
    'B服',
    onProgress
  );
}

async function ensureArknightsOfficialPack(onProgress) {
  return ensureArknightsPack(
    ARKNIGHTS_OFFICIAL_PROFILE,
    ARKNIGHTS_OFFICIAL_READY,
    '官服',
    onProgress
  );
}

/* ────────────────────────────────────────────────────────────────
 * 渠道包按需下载（2.5.0 起不再随安装包分发）
 *
 * 以前 resources/endfield-packs 整包 632 MB 跟着安装包走：终末地五个渠道 +
 * 明日方舟两个渠道，用户往往只用得上其中一个。现在第一次切到某个服时，
 * 先算出「这个渠道包多大」，弹窗问一句，点了才下，下完照常切服。
 *
 * 三件事分开：spec（这个渠道对应哪个目录）→ status（本机有没有 / 要下多少）
 * → download（真下）。切服流程只调 status，用户点了才进 download。
 * ──────────────────────────────────────────────────────────────── */

/** 明日方舟两个渠道包：目录 + 配置 + 「算齐了」的文件清单。 */
const ARKNIGHTS_PACK_CHANNELS = {
  official: {
    directory: ARKNIGHTS_OFFICIAL_PROFILE.directory,
    profile: ARKNIGHTS_OFFICIAL_PROFILE,
    ready: ARKNIGHTS_OFFICIAL_READY,
    label: '官服',
  },
  bilibili: {
    directory: ARKNIGHTS_BILIBILI_PROFILE.directory,
    profile: ARKNIGHTS_BILIBILI_PROFILE,
    ready: ARKNIGHTS_BILIBILI_READY,
    label: 'B服',
  },
};

/**
 * 某个渠道对应哪个渠道包。
 * 终末地和明日方舟都有 official / bilibili，靠 gameKey 区分，不能只看渠道名。
 */
function channelPackSpec(gameKey, channel) {
  const key = String(channel || '');
  if (gameKey === 'arknights') {
    const spec = ARKNIGHTS_PACK_CHANNELS[key];
    return spec ? { ...spec, game: 'arknights' } : null;
  }
  const directory = ENDFIELD_PACK_NAMES[key];
  if (!directory) return null;
  const profile = profileByDirectory(directory);
  if (!profile) return null;
  return {
    directory,
    profile,
    ready: null,
    label: ENDFIELD_CHANNEL_LABEL[key] || directory,
    game: 'endfield',
  };
}

/**
 * 某个根目录下的渠道包算不算齐了。
 *
 * 方舟看 ARKNIGHTS_*_READY 那几件；终末地交给 endfield-packs 的
 * channelPackFilesReady —— 差异渠道（国际服 / Play / Steam）必须确认
 * 「按这套差异完整下过一遍」，否则会把 2.6.0 之前那份只有 SDK 的旧包
 * 当成已就绪，铺出来的运行时一启动就崩。
 */
function channelPackReady(spec, root) {
  const dir = path.join(root, spec.directory);
  if (spec.ready) return spec.ready.every((item) => fs.existsSync(path.join(dir, ...item.split('/'))));
  return channelPackFilesReady(spec.profile, dir);
}

/**
 * 切服前问一句「这个渠道包本机有没有」。
 *
 * 有 → ready:true，切服流程照常走（一个字都不下载）。
 * 没有 → ready:false 并带上官方清单算出来的真实体积；弹窗直接写「194 MB」。
 * Steam 渠道的清单接口取不到（返回的不是有效密文），标成不能自动补。
 */
async function channelPackStatus(gameKey, channel) {
  const spec = channelPackSpec(gameKey, channel);
  if (!spec) return { ok: false, reason: '这个服务器没有渠道差异包，不需要下载' };
  for (const root of endfieldPackCandidateRoots()) {
    if (channelPackReady(spec, root)) {
      return {
        ok: true,
        ready: true,
        game: gameKey,
        channel,
        directory: spec.directory,
        label: spec.label,
        root,
      };
    }
  }
  const base = {
    ok: true,
    ready: false,
    game: gameKey,
    channel,
    directory: spec.directory,
    label: spec.label,
    root: endfieldPackWritableRoot(),
    bytes: 0,
    fileCount: 0,
    version: '',
    canDownload: spec.directory !== 'EndSteam',
    reason:
      spec.directory === 'EndSteam'
        ? 'Steam 渠道的清单接口取不到，只能先在 Steam 客户端里装一次'
        : '',
    error: '',
  };
  try {
    const measured = await measureChannelPack(spec.profile);
    base.bytes = measured.totalBytes;
    base.fileCount = measured.fileCount;
    base.version = measured.version;
  } catch (error) {
    // 离线 / 接口抽风不该把切服路堵死：体积留 0，界面显示「大小未知」再让用户点
    base.error = error.message;
  }
  return base;
}

/** 正在下载的渠道包：同一时间只允许一个，取消靠这里存的 controller。 */
const channelPackJobs = new Map();

/**
 * 真正下载一个渠道包。
 *
 * 进度统一走 endfield:progress 通道（phase:'pack'），渲染层已经订阅了它，
 * 不用再开一条；取消用 channelPackJobs 里的 AbortController。
 *
 * @returns {Promise<{root:string, directory:string, downloaded:boolean}>}
 */
async function downloadChannelPack(gameKey, channel, onProgress) {
  const spec = channelPackSpec(gameKey, channel);
  if (!spec) throw new Error('这个服务器没有渠道差异包');
  if (spec.directory === 'EndSteam') {
    throw new Error('Steam 渠道暂不支持自动补齐：请先在 Steam 客户端里安装一次终末地');
  }
  const jobKey = `${gameKey}:${channel}`;
  if (channelPackJobs.has(jobKey)) throw new Error('这个渠道包正在下载');
  const controller = new AbortController();
  channelPackJobs.set(jobKey, controller);
  const root = endfieldPackWritableRoot();
  try {
    await fsp.mkdir(root, { recursive: true });
    if (gameKey === 'arknights') {
      // 两家共用同一个接口，只靠 appcode / channel 区分：先确认清单里真有 Arknights.exe
      const valid = await verifyArknightsSource(spec.profile);
      if (!valid) {
        throw new Error(
          `官方接口没有返回明日方舟的清单，暂时没法自动补齐${spec.label}渠道文件：` +
            '先用官方启动器在这个目录里装一次，就能正常切换'
        );
      }
    }
    const result = await updateEndfieldProfile(
      spec.profile,
      root,
      (progress) =>
        onProgress?.({
          ...progress,
          phase: 'pack',
          channel,
          game: gameKey,
          label: spec.label,
          directory: spec.directory,
        }),
      { signal: controller.signal }
    );
    if (!channelPackReady(spec, root)) throw new Error(`${spec.label}渠道包下载完成但校验没通过`);
    await rememberEndfieldPackRoot(root);
    refreshEndfieldPackChannels();
    refreshArknightsPackChannels();
    return { root, directory: spec.directory, downloaded: !result?.skipped };
  } finally {
    channelPackJobs.delete(jobKey);
  }
}

/** 取消正在进行的渠道包下载（弹窗上的「取消」）。 */
function cancelChannelPack(gameKey, channel) {
  const jobKey = `${gameKey}:${channel}`;
  const controller = channelPackJobs.get(jobKey);
  if (!controller) return false;
  controller.abort();
  channelPackJobs.delete(jobKey);
  return true;
}

/**
 * 这次切服到底用不用得上渠道包？
 *
 * 前端如果只看「本机有没有这个渠道包」就弹下载框，会误伤两种根本不需要包的场景：
 *   · 终末地官服自己装了客户端 —— 走直启分支，一个渠道包都用不上（见
 *     ensureEndfieldChannelRuntime 里的 directBase）；直接下 50 MB 纯属白问。
 *   · 明日方舟基础目录本来就是目标渠道 —— 装的已经是 B服，切 B服不用换文件。
 * 判断条件照抄两条实际链路的前置分支，保证「弹窗说要不要下」和「真要切时下不下」一致。
 */
function channelPackNeededFor(game, server) {
  if (!game || !server) return null;
  const channel = String(server.channel || '');
  if (game.builtinKey === 'endfield') {
    if (!ENDFIELD_PACK_NAMES[channel]) return null;
    if (channel === 'official') {
      const ownRoot = endfieldBaseRoot(server);
      if (ownRoot && fs.existsSync(path.join(ownRoot, 'Endfield.exe'))) return null;
    }
    return { game: 'endfield', channel };
  }
  if (game.builtinKey === 'arknights') {
    if (!ARKNIGHTS_PACK_CHANNELS[channel]) return null;
    const root = String(server.root || '');
    // 已经生成过独立运行时的，渠道件必然齐了，不必再问
    if (!root || root.includes('VelaRuntimes')) return null;
    if (channelFromArknightsRoot(root) === channel) return null;
    return { game: 'arknights', channel };
  }
  return null;
}

/** 界面要知道本机已经有哪几个渠道包：缺的会在切到那个服时自动补下。 */
function refreshEndfieldPackChannels() {
  const roots = endfieldPackCandidateRoots();
  const list = [];
  for (const [channel, packName] of Object.entries(ENDFIELD_PACK_NAMES)) {
    // 用和切服同一套判定：状态没写过的差异包（2.6.0 之前随包分发的旧 EndGlobal）
    // 不算就绪，设置页才会显示「按需下载」，而不是装作有、切过去却崩。
    const profile = profileByDirectory(packName);
    if (roots.some((root) => channelPackFilesReady(profile, path.join(root, packName)))) list.push(channel);
  }
  store.data.settings.endfieldPackChannels = list;
}

/**
 * 明日方舟的两个渠道包（ArkOfficial / ArkBilibili）有没有就位。
 * 这两条还没在真机上验证过，所以状态单独报，不和终末地的五个混在一起。
 */
function refreshArknightsPackChannels() {
  const roots = endfieldPackCandidateRoots();
  const groups = [
    ['official', ARKNIGHTS_OFFICIAL_PROFILE, ARKNIGHTS_OFFICIAL_READY],
    ['bilibili', ARKNIGHTS_BILIBILI_PROFILE, ARKNIGHTS_BILIBILI_READY],
  ];
  const list = [];
  for (const [channel, profile, readyFiles] of groups) {
    const hit = roots.some((root) =>
      readyFiles.every((item) => fs.existsSync(path.join(root, profile.directory, ...item.split('/'))))
    );
    if (hit) list.push(channel);
  }
  store.data.settings.arknightsPackChannels = list;
}

/** 渠道包状态一起刷新：终末地五个和明日方舟两个现在都归设置页管。 */
function refreshPackChannels() {
  refreshEndfieldPackChannels();
  refreshArknightsPackChannels();
}

/**
 * 渠道包的内容签名：文件数 + 总字节数。
 *
 * 用途只有一个 —— 判断「运行时是不是按现在这份渠道包铺出来的」。渠道包换了内容
 * （比如国际服从 10 个 SDK 文件变成 126 个文件的整包差异），签名就变，运行时重建。
 * 不拿 mtime：包是先下到 staging 再整体 rename 过来的，目录 mtime 会一起变，
 * 但内容没变的情况下重建一次几十秒的硬链接纯属浪费。
 */
function packSignatureOf(dir) {
  let count = 0;
  let bytes = 0;
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        bytes += fs.statSync(full).size;
        count += 1;
      } catch {
        /* 文件刚好被删：跳过 */
      }
    }
  };
  walk(dir);
  return `${count}:${bytes}`;
}

/* ── 终末地每渠道独立硬链接运行时：建、切 ─────────────────────────────── */

/**
 * 为某一个渠道生成一份独立的硬链接运行时（staging → 一次性 rename 就位）。
 *
 * 只在「该渠道目录需要重建」时调用：首次切换、基础客户端/渠道包更新、目录被误删、
 * 或用户手动点「重新生成」。每个渠道一份目录，彼此绝不共用，所以从建好那一刻起
 * 就只可能被这一个渠道写入，不存在「叠加后要还原」的问题。
 *
 * 为什么不能直接往目标目录里铺：铺到一半被打断/断电，会留下一个「看着像运行时、
 * 其实缺一半文件」的目录，下次启动又得判断它算不算建好。staging 建完整再 rename，
 * 同卷 rename 是原子的，要么完全没有、要么完整。
 *
 * 硬链接策略全部交给 hardlinkTree + mustCopyNotLink：可写文件（Persistent 索引、
 * U8Data、sdkdata、mmkv、WebviewConfig…）复制，只读资源（StreamingAssets 63GB、
 * CefView、plugins、各个 dll）硬链接 —— 空间几乎不涨，但隔离性正确：运行时里
 * 任何一个可写文件都不是基础客户端那一份，游戏改写它不会碰坏官服本体。
 *
 * 重建时用户下好的 Endfield_Data\Persistent 必须原样留住：它不是本次重建要修
 * 的东西，却可能是几个小时的下载量。所以先把它整体搬到 staging 顶上再 rename 就位。
 * 老实现（v2.3.0 的 prepareLinkedRuntime）在这里是 removeTreeResilient 一刀切 ——
 * 正是「每切一次服就重下一次语音包」的源头，这次保留 Persistent 就是为了堵住它。
 */
async function buildEndfieldChannelRuntime({
  baseRoot,
  runtimeRoot,
  onProgress,
  signal,
  copyDirs = ENDFIELD_RUNTIME_COPY_DIRS,
}) {
  const stagingRoot = `${runtimeRoot}.staging-${Date.now()}`;
  let staleRoot = '';
  // 下面两个变量原来声明在 if (fs.existsSync(runtimeRoot)) 块里，回滚分支要用，提到外面。
  let carried = false;
  const stagingPersistent = path.join(stagingRoot, 'Endfield_Data', 'Persistent');
  // staging 是否已经就位成正式目录：决定 catch 里能不能删 staging。
  let placed = false;
  await fsp.mkdir(path.dirname(runtimeRoot), { recursive: true });
  await fsp.rm(stagingRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {});
  try {
    const linkResult = await hardlinkTree({
      sourceRoot: baseRoot,
      targetRoot: stagingRoot,
      copyDirs,
      onProgress,
      signal,
    });
    if (signal && signal.cancelled) throw new Error('已取消');
    // 渠道包不在这里铺：铺完基础树就 rename 就位，随后由 applyEndfieldChannelToWork
    // 统一做「purge → overlay → reconcile → refill」。渠道包只有十几个文件，铺两次没必要。
    if (fs.existsSync(runtimeRoot)) {
      /*
       * 旧目录里**仍然可能装着用户的下载内容**：Endfield_Data\Persistent 是游戏自己
       * 维护的资源索引 + 已下好的语音包（约 3.9GB）。重建是为了对齐新的基础客户端，
       * 不是为了把这些删掉 —— 所以先把它整体搬进 staging，覆盖掉刚从基础客户端
       * 拷过来的那一份（同卷 rename，瞬间完成，不占额外空间）。
       */
      const keptPersistent = path.join(runtimeRoot, 'Endfield_Data', 'Persistent');
      // stagingPersistent / carried 已在函数头声明。
      if (fs.existsSync(keptPersistent)) {
        await fsp.rm(stagingPersistent, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {});
        await fsp.mkdir(path.dirname(stagingPersistent), { recursive: true });
        try {
          await fsp.rename(keptPersistent, stagingPersistent);
          carried = true;
        } catch {
          /* 搬不过去就保留旧的，后面整体 rename 掉，用户重新下载即可 —— 不能因此让重建失败 */
        }
      }
      if (carried) writeLaunchLog(`[endfield] 重建运行时：已保留原有的 Endfield_Data\\Persistent（用户的资源与语音包）`);
      const stale = `${runtimeRoot}.stale-${Date.now()}`;
      try {
        await fsp.rename(runtimeRoot, stale);
      } catch (error) {
        /*
         * 旧目录改名失败（被占用 / 权限 / 跨卷）。原来的做法是直接 rm 掉旧目录重来，
         * 但那时 Persistent 可能还在里面（carried === false 表示搬进 staging 失败），
         * 一 rm 就等于把用户 3.9GB 语音包连目录一起删了。
         * 现在：搬走了才允许删；没搬走就整次失败、原样留着，让用户自己去关掉占用的进程。
         */
        if (!carried) {
          throw new Error(`无法把旧的运行时目录改名（可能有进程正在占用它）：${error.message}`);
        }
        await fsp.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
      }
      staleRoot = stale;
    }
    try {
      await fsp.rename(stagingRoot, runtimeRoot);
    } catch (error) {
      /*
       * 就位失败。原来这里直接落到外层 catch：staging 被删（里面装着刚搬过来的用户
       * 语音包），旧目录还叫 .stale-*，结果=「该渠道运行时连同 3.9GB 语音包一起没」。
       * 现在把旧目录 rename 回原处，再把 Persistent 搬回它里面，然后把错误抛出去。
       */
      if (staleRoot) {
        const restored = await fsp.rename(staleRoot, runtimeRoot).then(() => true).catch(() => false);
        if (restored) {
          staleRoot = '';
          if (carried) {
            const back = path.join(runtimeRoot, 'Endfield_Data', 'Persistent');
            await fsp.rm(back, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {});
            await fsp.mkdir(path.dirname(back), { recursive: true }).catch(() => {});
            await fsp.rename(stagingPersistent, back).catch(() => {});
          }
        }
      }
      throw error;
    }
    placed = true;
    // 旧目录改名成功后才敢删：硬链接居多、删了不额外回空间，但目录项会堆着，
    // 而且 walkFiles 之类遍历会扫到它。删失败不影响本次启动，下次重建再顺手清一遍。
    if (staleRoot) {
      fsp
        .rm(staleRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
        .then(() => writeLaunchLog(`[endfield] 已清理上一代运行时残留：${path.basename(staleRoot)}`))
        .catch(() => {});
    }
    return { ...linkResult, overlay: { processed: 0 } };
  } catch (error) {
    // 已经就位成正式目录的不能删（那就是用户现在的运行时），只有还在 staging 阶段的才清。
    if (!placed) {
      await fsp.rm(stagingRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {});
    }
    throw error;
  }
}

/**
 * 清掉上一代运行时留下的 .stale-* / .staging-* 残骸。
 *
 * buildEndfieldChannelRuntime 重建时把旧目录 rename 成 .stale-<时间戳>，随后异步删；
 * 但异步删除可能被关机/杀进程打断，也可能一直失败（占用、权限）。这些目录里
 * 绝大多数是硬链接，删了并不额外回空间，但目录项会堆着 —— 所以每次进终末地
 * 启动链路时顺手清一遍。只删「该渠道目录的同级、名字以 <basename>.stale- 或
 * .staging- 开头」的目录；绝不碰渠道目录本身，也不碰别的东西。删不掉就下次再试。
 */
async function cleanStaleRuntimeRoots(runtimeRoot) {
  if (!runtimeRoot) return 0;
  const parent = path.dirname(runtimeRoot);
  const base = path.basename(runtimeRoot);
  let entries = [];
  try {
    entries = await fsp.readdir(parent, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === base) continue;
    if (!entry.name.startsWith(`${base}.stale-`) && !entry.name.startsWith(`${base}.staging-`)) continue;
    try {
      await fsp.rm(path.join(parent, entry.name), { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
      removed += 1;
    } catch {
      /* 占着就下次再说，不能因为清残骸把启动弄失败 */
    }
  }
  if (removed > 0) writeLaunchLog(`[endfield] 已清理运行时残骸 ${removed} 个`);
  return removed;
}

/*
 * 渠道身份：Endfield_Data\app.info 与 Endfield_Data\boot.config 必须跟着渠道走。
 *
 * 每份运行时都从官服本体整树重建，app.info / boot.config 复制过来时天然是
 * 官服版（Hypergryph + hypergryph.com）。国际服 / Play / Steam 的小渠道包里带
 * Endfield_Data\app.info + boot.config，overlay 会覆盖成 Gryphline 版；官服 / B服
 * 渠道包不含 Endfield_Data，保持官服版即正确。
 *
 * 这个兜底只在「渠道包换了、但目录被复用（未整树重建）」时才有实际作用：确保
 * 包不带这两个文件时目录里仍是与目标渠道相符的身份，而不是上一次铺进来的那份。
 * 从干净树 + 小包起步时它是幂等的（written=0）。
 *
 * 厂商归属：官服 / B服 → Hypergryph（鹰角，同一套账号与平台 SDK）；
 *          国际服 / Play / Steam → Gryphline（万代南梦宫国际）。
 */
const ENDFIELD_CHANNEL_IDENTITY = {
  official: {
    vendor: 'Hypergryph',
    remoteBoot: 'https://game-config.hypergryph.com/api/remote_config/3/prod-engine/default/default/engine_config',
    region: false,
  },
  bilibili: {
    vendor: 'Hypergryph',
    remoteBoot: 'https://game-config.hypergryph.com/api/remote_config/3/prod-engine/default/default/engine_config',
    region: false,
  },
  global: {
    vendor: 'Gryphline',
    remoteBoot: 'https://game-config.gryphline.com/api/remote_config/1003/prod-engine/default/default/engine_config',
    region: true,
  },
  play: {
    vendor: 'Gryphline',
    remoteBoot: 'https://game-config.gryphline.com/api/remote_config/1003/prod-engine/default/default/engine_config',
    region: true,
  },
  steam: {
    vendor: 'Gryphline',
    remoteBoot: 'https://game-config.gryphline.com/api/remote_config/1003/prod-engine/default/default/engine_config',
    region: true,
  },
};

/**
 * 按目标渠道改写 boot.config 文本：换掉 remoteBoot 那一行、按需增删
 * package-region=1，其余行（gfx / gc / single-instance 等）原样保留。
 * 保留原有的换行风格（实测客户端用 CRLF）。
 */
function buildChannelBootConfig(text, identity) {
  const raw = String(text || '');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const trailingBlank = lines.length > 0 && lines[lines.length - 1] === '';
  const body = trailingBlank ? lines.slice(0, -1) : lines.slice();
  const out = [];
  let hasRegion = false;
  for (const line of body) {
    if (/^remoteBoot=/i.test(line)) {
      out.push(`remoteBoot=${identity.remoteBoot}`);
      continue;
    }
    if (/^package-region=/i.test(line)) {
      hasRegion = true;
      if (identity.region) out.push('package-region=1');
      continue;
    }
    out.push(line);
  }
  if (identity.region && !hasRegion) out.push('package-region=1');
  return `${out.join(eol)}${eol}`;
}

/**
 * 把工作目录的渠道身份对齐到目标渠道。
 *
 * 渠道包自带这两个文件时（只有国际服/Play/Steam 的差异包带）交给 overlayDirectory，
 * 这里不重复写；不带的（官服 / B服）才按目标厂商改写。
 * 写之前**必须先断链**：这两个文件若是从基础客户端硬链接来的，直接写会改掉基础客户端本体。
 */
async function applyEndfieldChannelIdentity({ workRoot, baseRoot, packDir, channel }) {
  const identity = ENDFIELD_CHANNEL_IDENTITY[channel];
  if (!identity) return { written: 0 };
  const targets = [
    { rel: 'Endfield_Data/app.info', build: () => `${identity.vendor}\nEndfield` },
    { rel: 'Endfield_Data/boot.config', build: (template) => buildChannelBootConfig(template, identity) },
  ];
  let written = 0;
  for (const item of targets) {
    if (packDir && fs.existsSync(path.join(packDir, item.rel))) continue;
    const dest = path.join(workRoot, item.rel);
    let current = '';
    try {
      current = await fsp.readFile(dest, 'utf8');
    } catch {
      /* 工作目录里还没这个文件：拿基础客户端那份当模板 */
      try {
        current = await fsp.readFile(path.join(baseRoot, item.rel), 'utf8');
      } catch {
        continue;
      }
    }
    const content = item.build(current);
    if (current === content) continue;
    await fsp.rm(dest, { force: true }).catch(() => {});
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.writeFile(dest, content, 'utf8');
      written += 1;
    } catch (error) {
      writeLaunchLog(`[endfield] 写渠道身份失败 ${item.rel}：${error.message}`);
    }
  }
  if (written > 0) {
    writeLaunchLog(`[endfield] 渠道身份已对齐到 ${identity.vendor}（${channel}）：${written} 个文件`);
  }
  return { written };
}

/**
 * 把某个渠道铺到工作目录上（切服 = 只做这一件事）。
 *
 * 顺序有讲究，照 Xel 的 ServerPayloadDeployment：
 *   1. purgeForeignChannelFiles：先去掉上一个渠道的 SDK（hgsdk / gfsdk / B服三件套）；
 *   2. overlayDirectory：渠道包整体覆盖（写入前逐文件断链，绝不写穿基础客户端）；
 *   3. sdkdata 只留目标渠道的 sdk_*_config；
 *   4. reconcileEndfieldRuntime：删掉基础客户端残留的外渠道平台件；
 *   5. refill：补回全渠道通用的官方件（decoy 父进程、webviewsdk、OneChannelLC）；
 *   6. 最后再 purge 一次 —— 补缺可能把外渠道件带回来（幂等）。
 * 全程不碰 Endfield_Data：那是游戏自己的地盘，包括用户下好的语音包。
 */
async function applyEndfieldChannelToWork({ workRoot, baseRoot, packDir, channel, onProgress, signal }) {
  const purgedBefore = await purgeForeignChannelFiles(workRoot, channel);
  const overlayResult = await overlayDirectory({ packRoot: packDir, targetRoot: workRoot, onProgress, signal });

  // 只保留目标渠道自己的 SDK 配置，避免工作目录还走上一个渠道的登录通道。
  const channelSdk = path.join(workRoot, 'sdkdata');
  const keepPrefixes = ENDFIELD_SDK_KEEP[channel] || [];
  try {
    for (const entry of await fsp.readdir(channelSdk)) {
      if (!/^sdk_[a-z]+_config/i.test(entry)) continue;
      const keep = keepPrefixes.some((prefix) => entry.toLowerCase().startsWith(prefix));
      if (!keep) await fsp.rm(path.join(channelSdk, entry), { force: true });
    }
  } catch {
    /* sdkdata 可能不存在 */
  }

  await reconcileEndfieldRuntime(workRoot, packDir, channel);

  const refill = ['PlatformProcess.exe', 'webviewsdk.dll', 'onechannellc.dll'];
  /*
   * hgsdk.dll 只属于「国服 / B服 / 方舟」那一套鹰角 SDK。
   * 国际服、Play、Steam 走的是 Gryphline（gfsdk.dll + glfoundation.dll），
   * 补上 hgsdk 会和渠道包的 SDK 抢符号，平台层初始化时直接 0xc0000005
   * （2026-10-31 国际服启动崩溃根因），所以只给国服系补。
   */
  if (channel === 'official' || channel === 'bilibili') refill.push('hgsdk.dll');
  for (const name of refill) {
    const runtimeFile = path.join(workRoot, name);
    if (fs.existsSync(runtimeFile)) continue;
    const baseFile = path.join(baseRoot, name);
    if (!fs.existsSync(baseFile)) continue;
    try {
      await fsp.link(baseFile, runtimeFile);
    } catch {
      await fsp.copyFile(baseFile, runtimeFile).catch(() => {});
    }
  }

  const purgedAfter = await purgeForeignChannelFiles(workRoot, channel);
  // 渠道身份（app.info / boot.config）最后写：渠道包若自带就被 overlay 覆盖成对的，
  // 不带的（官服 / B服）在这里按目标厂商改写，见 ENDFIELD_CHANNEL_IDENTITY 的注释。
  const identityResult = await applyEndfieldChannelIdentity({ workRoot, baseRoot, packDir, channel });
  return { overlay: overlayResult.processed || 0, purged: purgedBefore + purgedAfter, identity: identityResult.written || 0 };
}

// 以运行时为源建树后必须现身的文件。refill（见 applyEndfieldChannelToWork）只从
// baseRoot 找、找不到就 continue，于是「源里没有、包里也没有」的关键件会静默缺失：
// 树建成功、marker 写成功，用户点「开始游戏」时平台层初始化直接崩。
// 这里点名校验，缺就 hard-fail —— 宁可这次不给建，也不把一棵注定崩的树交给用户。
// 刻意不列 pld.dat：它是 ACE 的机器绑定载荷（官服 234173 / B服 234176 /
// 国际服 7209），五个渠道包都不带、verify_files.json 也不收，不能要求它存在。
const ENDFIELD_RUNTIME_REQUIRED = [
  'Endfield.exe',
  'PlatformProcess.exe',
  'EndfieldBase.dll',
  'HGP.dll',
  'OneChannelLC.dll',
  'U8SDK.dll',
  'U8CoreUI.dll',
  'u8_channel.dll',
  'webviewsdk.dll',
  'U8Data/config/config.bin',
];

function assertEndfieldRuntimeComplete(workRoot, channel) {
  const required = ENDFIELD_RUNTIME_REQUIRED.slice();
  // hgsdk.dll 只属于鹰角那一套 SDK；国际服/Play/Steam 用 gfsdk+glfoundation，
  // 强行补 hgsdk 会抢符号（见 applyEndfieldChannelToWork 的注释）。
  if (channel === 'official' || channel === 'bilibili') required.push('hgsdk.dll');
  const missing = [];
  for (const rel of required) {
    let ok = false;
    try {
      ok = fs.statSync(path.join(workRoot, rel)).size > 0;
    } catch {
      ok = false;
    }
    if (!ok) missing.push(rel);
  }
  if (missing.length) {
    throw new Error(`这个渠道的运行时缺少关键文件，已中止（避免启动即崩）：${missing.join('、')}`);
  }
}

async function ensureEndfieldChannelRuntime(game, server, options = {}) {
  if (game?.builtinKey !== 'endfield' || !server) {
    throw new Error('这个功能只用于明日方舟：终末地');
  }
  const channel = String(server.channel || '');
  const packName = ENDFIELD_PACK_NAMES[channel];
  if (!packName) throw new Error('这个服务器没有对应的渠道差异包');

  // 官服记住的是它自己的原始安装目录；其它渠道优先用官服/别的完整客户端当基础。
  let baseRoot = '';
  let ownOfficialBase = '';
  let resolvedBase = null;
  if (channel === 'official') {
    // 官服自己的原始安装目录单独判一次：只有它才是「真·官服本体」。
    // 直启分支必须用它 —— 用 fallback 借来的客户端直启会开错渠道的游戏。
    ownOfficialBase = endfieldBaseRoot(server);
    if (ownOfficialBase && !fs.existsSync(path.join(ownOfficialBase, 'Endfield.exe'))) ownOfficialBase = '';
    baseRoot = ownOfficialBase;
  }
  if (!baseRoot) {
    resolvedBase = endfieldResolveBase(game, server, channel, options);
    baseRoot = resolvedBase ? resolvedBase.baseRoot : '';
  } else {
    resolvedBase = { baseRoot, baseKind: 'real', baseChannel: endfieldChannelOf(baseRoot) || channel, baseRealRoot: baseRoot };
  }
  if (!baseRoot) {
    throw new Error(`没有找到可以当作基础的客户端。${server.name}需要一个已安装的终末地在同盘上做基础，请先在启动器里把已经装好的任意渠道客户端指到对应服务器上。`);
  }

  // 官服渠道直接从基础客户端启动（XelLauncher 已验证的做法，见它的 app.log：
  // 官服每次都是 staged G:\Arknights Endfield\PlatformProcess.exe 后直启本体）。
  // 基础客户端由官方启动器持续维护，verify_files.json / U8Data / eld 下载库等
  // 平台状态永远自洽。克隆运行时 + 渠道包覆盖后，U8SDK.dll / U8CoreUI.dll /
  // U8Data / config.ini 与官方校验清单出现错位（包和克隆都是旧快照），游戏
  // 平台层启动自检就报「检查资源完整性时发现异常，请重新下载缺失的文件」
  // （10-29 报障根因四，实测修补 U8Data 也不够）。
  // 注意：只在官服自己装了客户端时直启；fallback 借用别渠道客户端当基础时，
  // 直启会开错渠道的游戏，那种情况仍走链接运行时。B服渠道不受影响。
  if (channel === 'official' && ownOfficialBase && !options.forceRuntime) {
    const baseLaunch = path.join(ownOfficialBase, 'Endfield.exe');
    if (fs.existsSync(baseLaunch)) {
      server.originalRoot = ownOfficialBase;
      server.path = baseLaunch;
      server.root = ownOfficialBase;
      server.runtimeLinked = false;
      server.legacyRuntime = false;
      server.incomplete = false;
      return {
        ok: true,
        built: false,
        runtimeRoot: ownOfficialBase,
        launchPath: baseLaunch,
        directBase: true,
      };
    }
  }

  // 渠道包不在本机就现下这一个渠道的：新用户没装 XelLauncher、或只扫到别人
  // 的 B服 load 目录时，缺哪个下哪个，不再把「请先设置渠道包目录」扔给用户。
  // 放在官服直启分支之后：直接启动原客户端时一个渠道包都用不上，不必先下 50MB。
  const { packDir, downloaded: packDownloaded } = await ensureEndfieldPackFor(channel, options.onProgress, {
    download: options.allowPackDownload !== false,
  });

  /*
   * ── 每渠道一份独立的硬链接运行时 ──────────────────────────────────
   *
   * runtimePaths() 算出 <运行时根>\endfield\<渠道>：和明日方舟共用同一套目录规则，
   * 但每个渠道各有自己的目录，彼此绝不叠加写入。2026-11-08 那个「所有非官服渠道
   * 共用一个 work、切服只铺不还原」的混合目录，正是 B服 加载国际服 GameAssembly.dll
   * 启动 6 秒崩掉的根因，这里彻底回到「一个渠道一棵干净树」。
   */
  const runtime = runtimePaths(baseRoot, 'endfield', channel, options.runtimeRoot || '');
  if (!runtime.sameDrive) {
    throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
  }
  const runtimeRoot = runtime.target;
  if (pathsOverlap(baseRoot, runtimeRoot)) {
    throw new Error('运行时目录不能和基础客户端是同一个目录，也不能互相嵌套，请换个“运行时目录”再试');
  }

  // 顺手清掉上一代重建留下的 .stale-* / .staging-* 残骸（全是硬链接，删失败也不影响切服）。
  await cleanStaleRuntimeRoots(runtimeRoot).catch(() => {});

  const baseSignature = await endfieldBaseSignature(baseRoot);
  const packSignature = packSignatureOf(packDir);
  const marker = readEndfieldRuntimeMarker(runtimeRoot);
  const existingExecutable = path.join(runtimeRoot, 'Endfield.exe');
  /*
   * 只有这几种情况才整树重建（重建会把 Persistent 整体搬过去，用户的语音包不丢）：
   *   · 目录里没有 Endfield.exe（首次建 / 被误删 / 标记读不出来）；
   *   · 基础客户端的只读部分变了 —— 官方更新过，得从最新本体重新硬链；
   *   · 用户手动点「重新生成」（forceRuntime）。
   * 渠道包内容变了不整树重建，只重新铺一遍那十几个差异文件（见 needsApply）。
   * 同一渠道来回切、基础与包都没变时两条都不满足 —— 直接复用现有目录，
   * 几秒切过去、不重下任何语音包。
   */
  const baseKind = resolvedBase ? resolvedBase.baseKind : 'real';
  const needsRebuild =
    Boolean(options.forceRuntime) ||
    !fs.existsSync(existingExecutable) ||
    !marker ||
    String(marker.base || '') !== baseSignature ||
    // 旧 marker 没有 baseKind 字段 → 视为 'real'（历史行为），不触发额外重建
    String(marker.baseKind || 'real') !== baseKind;
  const needsApply =
    needsRebuild ||
    String((marker && marker.channel) || '') !== channel ||
    String((marker && marker.pack) || '') !== packSignature;

  const emit =
    typeof options.onProgress === 'function'
      ? options.onProgress
      : (progress) => send('endfield:progress', { ...progress, serverName: server.name });

  let result = { linked: 0, overlay: { processed: 0 } };
  let built = false;
  if (needsRebuild) {
    emit({ phase: 'link', processed: 0, total: 0, current: `正在为${server.name}生成独立硬链接运行时…` });
    writeLaunchLog(`[endfield] ${server.name} 生成独立运行时：${runtimeRoot}（基础 ${baseRoot}）`);
    result = await buildEndfieldChannelRuntime({
      baseRoot,
      runtimeRoot,
      onProgress: emit,
      signal: options.signal,
      // 以运行时为源时，渠道专属的 .exe/.dll 必须真拷贝：
      // 它们不在渠道包的 overlay 覆盖范围内时，硬链会让两个渠道永远共用
      // 同一个 inode，等于把「切服只铺不还原」的老事故换个入口重演。
      copyDirs: baseKind === 'runtime'
        ? ENDFIELD_RUNTIME_COPY_DIRS.concat(ENDFIELD_SAFE_INHERIT_COPY)
        : ENDFIELD_RUNTIME_COPY_DIRS,
    });
    built = true;
  } else {
    writeLaunchLog(`[endfield] ${server.name} 复用已有独立运行时：${runtimeRoot}`);
  }

  /*
   * 铺渠道差异文件（小渠道包，十几个 SDK/配置文件）。每渠道一棵干净树，
   * 所以这一步是「从基础客户端那套覆盖成目标渠道那套」，不存在跨渠道残留：
   *   1. purgeForeignChannelFiles 去掉基础客户端带过来的外渠道 SDK；
   *   2. overlayDirectory 整体覆盖（写入前逐文件断链，绝不写穿基础客户端）；
   *   3. sdkdata 只留目标渠道的 sdk_*_config；
   *   4. reconcileEndfieldRuntime 清外渠道平台件；
   *   5. refill 补回全渠道通用官方件；
   *   6. 渠道身份 app.info / boot.config 对齐。
   * Endfield_Data 整棵不参与 —— 用户下好的语音包 .chk 与游戏自己维护的索引
   * 就这样活过每一次切服与每一次重建。
   */
  let applied = { overlay: 0, purged: 0, identity: 0 };
  if (needsApply) {
    applied = await applyEndfieldChannelToWork({
      workRoot: runtimeRoot,
      baseRoot,
      packDir,
      channel,
      onProgress: emit,
    });
    if (applied.purged) {
      writeLaunchLog(`[endfield] ${server.name} 清掉外渠道 SDK 文件 ${applied.purged} 项（${channel}）`);
    }
  }
  result.overlay = { processed: applied.overlay };
  // 只有「以运行时为源」才做这道点名校验：真实安装目录当基础时，缺件由官方
  // 启动器/游戏自己的修复流程兜，硬失败反而会把本来能用的用户挡在外面。
  if (baseKind === 'runtime') {
    assertEndfieldRuntimeComplete(runtimeRoot, channel);
    writeLaunchLog(`[endfield] ${server.name} 关键件校验通过（源=运行时 ${baseKind}）`);
  }

  writeEndfieldRuntimeMarker(runtimeRoot, {
    v: 2,
    channel,
    base: baseSignature,
    pack: packSignature,
    // 这棵树是「拿哪个目录当源」建出来的。baseKind='runtime' 表示源本身是
    // 另一个渠道的运行时（MVP-1 新路径），'real' 表示源是真实安装目录。
    baseRoot: (resolvedBase && resolvedBase.baseRoot) || baseRoot,
    baseChannel: (resolvedBase && resolvedBase.baseChannel) || '',
    baseKind: (resolvedBase && resolvedBase.baseKind) || 'real',
    // 源运行时背后真正的安装目录（可能是 G:\Arknights Endfield，也可能为空）
    baseRealRoot: (resolvedBase && resolvedBase.baseRealRoot) || '',
    updatedAt: new Date().toISOString(),
  });

  // 官方启动器会持续刷新基础客户端里的平台状态（U8Data/config、sdkdata，
  // 还有 10-28 出现的 U8Data/config/Launcher.meta），而渠道包里的同名快照
  // 停在打包当天。运行时若一直用旧快照，游戏平台层校验资源时会报
  // 「检查资源完整性时发现异常，请重新下载缺失的文件」（10-29 报障根因三）。
  // 官服渠道以基础客户端为准：按 mtime 把更新的平台状态同步进运行时。
  // 注意：B服渠道的 U8Data 是 B 服渠道配置，基础客户端里是官服的，不能这样同步。
  // 官服其实在上面就直启返回了，这段只在 fallback 借用别的客户端当基础时有效。
  if (channel === 'official') {
    for (const dirName of ['U8Data', 'sdkdata']) {
      await syncNewerFiles(path.join(baseRoot, dirName), path.join(runtimeRoot, dirName));
    }
  }

  let launchPath = null;
  for (const name of ['Endfield.exe', 'PlatformProcess.exe']) {
    const candidate = path.join(runtimeRoot, name);
    if (fs.existsSync(candidate)) {
      launchPath = candidate;
      break;
    }
  }
  if (!launchPath) throw new Error('运行时中没有找到启动程序');

  /*
   * 每个渠道都记住「自己是拿哪个真实客户端当基础建起来的」。
   * 切过一次以后 server.root 变成该渠道的运行时目录（endfieldBaseRoot 会拒绝把
   * 生成的运行时当基础），一旦用户只有「国际服」这一份真实客户端，
   * 「国际服 → B服」就会找不到基础而报错。靠 originalRoot 记住真实目录，这条链才不会断。
   */
  // 运行时当源时，记「那个源运行时背后真正的安装目录」（marker.baseRealRoot），
  // 这样它下次还能从第一级（真实目录）解析，不会一路退化到只剩运行时可用。
  // baseRealRoot 为空（旧 marker / 来路不明）时退回 baseRoot——虽然它会被
  // isEndfieldRuntimeDir 拒掉，但至少保留了现场线索，方便日志定位。
  server.originalRoot = (resolvedBase && resolvedBase.baseRealRoot) || baseRoot;
  server.path = launchPath;
  server.root = runtimeRoot;
  server.runtimeLinked = true;
  server.legacyRuntime = false;
  // 关键：以前手动重建成功后没清这个标记，启动页状态点一直红。
  server.incomplete = false;

  return {
    ok: true,
    built,
    runtimeRoot,
    launchPath,
    linked: result.linked || 0,
    overlay: result.overlay?.processed || 0,
    packDownloaded,
  };
}

/**
 * 经「官方签名父进程」启动游戏。
 *
 * 终末地会校验自己的直接父进程：父进程文件必须名为 Games.exe 且带鹰角官方签名，
 * 直接拉起游戏会被判成 10100「请通过官方启动器打开游戏」。明日方舟 PC 端走同一套
 * 鹰角平台，所以两款游戏共用这条链路。
 *
 * @param {boolean} options.requireElevation 终末地创建游戏进程时就要求提权，必须走 UAC；
 *   明日方舟先按当前权限试一次，真拿到 740 再弹，免得每次开游戏都要授权。
 * @param {boolean} options.strict 终末地失败就如实报错（绝不能再退化成直接拉起，
 *   那样只会弹出官方启动器或让游戏报 10100）；明日方舟这条链路还没在真机上验证过，
 *   失败时退回原来的直接启动，不把用户挡在门外。
 * @returns {{handled:boolean, result?:object}} handled=false 表示这条路不适用，调用方按普通方式启动。
 */
async function launchWithSignedParent(game, target, cwd, options = {}) {
  const id = game.id;
  const base = path.basename(target);
  const { requireElevation = true, strict = true, args = game.args } = options;
  const isElevated = currentElevation();
  /*
   * 第一次遇到「必须提权」的游戏：先问一次要不要让启动器自己以管理员运行。
   *
   * 以前这里直接 Start-Process -Verb RunAs 起游戏 —— 每点一次「开始游戏」就弹
   * 一次 UAC，用户的原话是「老是要什么管理员启动，特别难用」。游戏侧 740
   * （实测非提权创建进程直接 failed to create game process 740）是硬限制，
   * 唯一能省掉的是「让父进程已经是管理员」：提权一次，整场都不再问。
   * elevationAsked 记「问过了没有」，只问一次；选过就按选过的走。
   */
  if (requireElevation && !isElevated && store.data.settings.elevationAsked !== true) {
    return {
      handled: true,
      result: {
        ok: false,
        elevationRequired: true,
        elevationUndecided: true,
        error: '终末地 / 明日方舟创建游戏进程需要管理员权限，这是官方客户端自己的限制，绕不过去。',
      },
    };
  }
  const plans = requireElevation
    ? isElevated
      ? [false, true]
      : [true]
    : isElevated
      ? [false]
      : [false, true];

  let lastError = '';
  for (const useUac of plans) {
    launching.set(id, Date.now());
    const result = useUac
      ? await launchEndfieldElevated(cwd, target, args)
      : await launchEndfield(cwd, target, args);
    if (result.ok) {
      await markLaunched(game);
      writeLaunchLog(`launch ${id}: 签名父进程=${result.parent || ''} uac=${useUac ? 1 : 0} exe=${base}`);
      trackGameProcess(id, base, Date.now()).catch(() => {});
      return {
        handled: true,
        result: { ok: true, pid: result.pid, official: true, elevated: useUac },
      };
    }
    lastError = result.error;
    launching.delete(id);
    writeLaunchLog(`launch ${id}: 签名父进程失败（uac=${useUac ? 1 : 0}）：${result.error}`);
    if (useUac) break;
    // 不是权限问题就别再试 UAC 了（父进程缺失、签名无效这些试多少次都一样）
    if (!/740|elevation|管理员/i.test(result.error)) break;
  }

  if (strict) {
    return {
      handled: true,
      result: {
        ok: false,
        error: `没能通过官方签名父进程启动：${lastError}。常见原因是安全软件拦下了 VelaEndfield.exe（本启动器靠它伪造官方签名父进程），把它加入白名单后重试；也可以在设置里打开「始终以管理员身份启动」。`,
        endfieldDecoy: true,
      },
    };
  }
  return { handled: false };
}

// 官服保持历史上的「尽力而为」语义：设置/差异包缺失时不阻断普通启动。
async function ensureEndfieldOfficialRuntime(game, server) {
  if (game?.builtinKey !== 'endfield' || server?.channel !== 'official') return false;
  try {
    const result = await ensureEndfieldChannelRuntime(game, server);
    return Boolean(result);
  } catch (error) {
    console.error('[endfield] 官服运行时自动准备失败：', error.message);
    return false;
  }
}

// ── 明日方舟（2.4.0 合并自对方分支）────────────────────────────────────
// 适配说明：对方版本的 ensureArknightsRuntime 是纯硬链接方案，不依赖
// endfield-packs.js；我方 endfield-packs.js 已带 Arknights profile 与
// profileForChannel('arknights')（供下载/校验链路使用），这里的切服运行时
// 仍按对方的硬链接实现 port，依赖的 runtimePaths / hardlinkTree 我方均有。

/**
 * 明日方舟官服 / B服 装在同一个目录里，靠渠道 SDK 文件区分：
 * B服 额外带 PCGameSDK.dll 和 BLPlatform64\，官服没有这两个。
 * 它的 config.ini 是加密二进制，读不出 game_biz，所以不能走 channelFromInstallPath。
 */
function channelFromArknightsRoot(root) {
  if (!root) return 'official';
  const hasBilibiliSdk =
    fs.existsSync(path.join(root, 'PCGameSDK.dll')) || fs.existsSync(path.join(root, 'BLPlatform64'));
  return hasBilibiliSdk ? 'bilibili' : 'official';
}

/**
 * 明日方舟切服，和终末地 / 原神国际服走同一套运行时目录方案：
 * 不再原地替换共用目录里的 SDK 文件，而是在 VelaRuntimes\arknights\<channel>
 * 生成一份独立运行时——大文件硬链接回基础安装目录，渠道 SDK 换成目标服的。
 * 这样官服和 B服 各自有独立的游戏目录和独立的 sdkdata，账号不会串。
 */
/*
 * 明日方舟两个国服渠道共用一套安装目录，切服要换的不只是「B服 多出来的那两样」。
 * 按 Xel-Launcher 的渠道清单（Helpers/GameChannelCatalog.cs），下面这些是**两个
 * 渠道都有、但内容不同**的：U8CoreUI.dll / U8SDK.dll / u8_channel.dll 三家通用件、
 * 平台层的 PlatformProcess 两件套 + webviewsdk.dll，以及决定登录到哪个渠道的
 * U8Data\config\（config.bin / config.gryph / u8ExtraConfig.bin）。
 * 只换 PCGameSDK.dll 是不够的：config 还是官服的，进游戏照样是官服。
 */
const ARKNIGHTS_CHANNEL_FILES = [
  'U8CoreUI.dll',
  'U8SDK.dll',
  'u8_channel.dll',
  'PlatformProcess.dll',
  'PlatformProcess.exe',
  'webviewsdk.dll',
  'U8Data/config',
];
/** 只有 B服 才有的两样：官服运行时里绝不能残留。 */
const ARKNIGHTS_BILIBILI_ONLY = ['PCGameSDK.dll', 'BLPlatform64'];
/** 切到 B服 时要用渠道件铺进去的全部条目。 */
const ARKNIGHTS_BILIBILI_PAYLOAD = [...ARKNIGHTS_CHANNEL_FILES, ...ARKNIGHTS_BILIBILI_ONLY];
/** 国服的两个渠道共用同一套安装目录；国际服 / 台服是各自独立的客户端。 */
const ARKNIGHTS_CN_CHANNELS = ['official', 'bilibili'];

function arknightsSegments(name) {
  return name.split('/');
}

/** 把渠道件从 sourceDir 铺进运行时：渠道包是长期缓存，只复制不硬链接。 */
async function placeArknightsChannelFile(runtime, sourceDir, name) {
  const segments = arknightsSegments(name);
  const target = path.join(runtime, ...segments);
  const from = path.join(sourceDir, ...segments);
  if (!fs.existsSync(from)) return false;
  if (fs.existsSync(target)) {
    // 目标多半是从基础客户端硬链接过来的；删不动就跳过这一件，别把整个运行时生成带崩
    await fsp
      .rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
      .catch(() => {});
  }
  const stat = await fsp.stat(from);
  if (stat.isDirectory()) await copyTree(from, target).catch(() => {});
  else await fsp.copyFile(from, target).catch(() => {});
  return true;
}

async function ensureArknightsRuntime(game, server, options = {}) {
  if (game.builtinKey !== 'arknights') return false;
  if (!server.root || server.root.includes('VelaRuntimes')) return false;
  // 国际服（EN / JP / KR）和台服由另外的发行商发行，主程序和国服不是一份，
  // 没法从国服目录硬链接拼出来，只能用它们自己的安装目录。
  // Yostar 三区各自就是一套完整客户端（含 game-launcher-config.json 元数据），
  // 不需要也不能再生成国服式硬链接运行时 —— 直接沿用它的目录启动即可。
  if (yostarPacks.isYostarChannel(server.channel)) return false;
  if (!ARKNIGHTS_CN_CHANNELS.includes(server.channel)) return false;
  const runtime = runtimePaths(server.root, 'arknights', server.channel, options.runtimeRoot || '');
  if (!runtime.sameDrive) return false;

  const emit = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  await fsp.mkdir(runtime.target, { recursive: true });
  const entries = await fsp.readdir(server.root, { withFileTypes: true });
  let index = 0;
  for (const entry of entries) {
    /*
     * 已生成的运行时跳过；B服 独有的两样也跳过（官服运行时里不能有它们）。
     * 其余渠道件照常链进来：官服运行时要用它们，切 B服 时下面会先删除再覆盖
     * —— 直接往硬链接上写会改到基础客户端的文件，所以必须先删后拷。
     */
    if (entry.name === '.vela-runtime' || ARKNIGHTS_BILIBILI_ONLY.includes(entry.name)) continue;
    index += 1;
    emit({ phase: 'link', processed: index, total: entries.length, current: `正在准备 ${entry.name}` });
    const target = path.join(runtime.target, entry.name);
    if (fs.existsSync(target)) continue;
    const from = path.join(server.root, entry.name);
    if (entry.isDirectory()) {
      await hardlinkTree({
        sourceRoot: from,
        targetRoot: target,
        signal: options.signal,
        onProgress: (progress) => emit({ ...progress, current: `${entry.name}\\${progress.current || ''}` }),
      }).catch(() => {});
    } else if (entry.isFile()) {
      await fsp.link(from, target).catch(() => fsp.copyFile(from, target).catch(() => {}));
    }
  }

  /*
   * 渠道件一律不能沿用上面那一趟通用硬链接 —— 装的是官服时，链进来的就是官服的
   * 那一份，B服 拿它进了游戏还是官服。所以这一步先把它们移出通用链接，再按
   * 目标渠道整包换掉：基础目录本身就是目标渠道装的就用基础目录，否则从渠道包取。
   */
  const baseIsBilibili = ARKNIGHTS_BILIBILI_ONLY.every((name) =>
    fs.existsSync(path.join(server.root, name))
  );
  if (server.channel === 'bilibili') {
    const packDir = baseIsBilibili ? '' : await ensureArknightsBilibiliPack(emit).catch(() => '');
    const missing = [];
    for (const name of ARKNIGHTS_BILIBILI_PAYLOAD) {
      // 基础目录是 B服 装的话它自己就是权威来源，否则渠道包优先、基础目录兜底
      const order = baseIsBilibili
        ? [server.root]
        : [packDir, server.root].filter(Boolean);
      let placed = false;
      for (const sourceDir of order) {
        if (await placeArknightsChannelFile(runtime.target, sourceDir, name)) {
          placed = true;
          break;
        }
      }
      if (!placed) missing.push(name);
    }
    if (missing.length) {
      throw new Error(
        `这个目录里没有 B服 的渠道文件（${missing.join('、')}），官方接口也没取到。` +
          '明日方舟官服和 B服 共用同一个安装目录：先用官方 B服 启动器在这个目录里装一次，就能自动切过去。'
      );
    }
    emit({ phase: 'link', processed: 1, total: 1, current: 'B服 渠道文件已按官方清单补齐' });
  } else {
    // 官服运行时里不能残留 B服 专属的两样，否则会带着 B站凭据启动
    for (const name of ARKNIGHTS_BILIBILI_ONLY) {
      await fsp.rm(path.join(runtime.target, ...arknightsSegments(name)), {
        recursive: true,
        force: true,
      });
    }
    /*
     * 反过来：手上装的是 B服 时，通用件（U8SDK.dll、U8Data\config\…）链进来的
     * 全是 B站 的，官服运行时拿了它照样登录 B站。这时整包从官服渠道包换掉。
     * 基础目录本来就是官服的（baseIsBilibili=false）则什么都不用做。
     */
    if (baseIsBilibili) {
      const packDir = await ensureArknightsOfficialPack(emit).catch(() => '');
      if (packDir) {
        for (const name of ARKNIGHTS_CHANNEL_FILES) {
          await placeArknightsChannelFile(runtime.target, packDir, name);
        }
        emit({ phase: 'link', processed: 1, total: 1, current: '官服渠道文件已按官方清单补齐' });
      }
    }
  }

  const executable = path.join(runtime.target, 'Arknights.exe');
  if (!fs.existsSync(executable)) return false;
  server.path = executable;
  server.rootDir = server.root;
  server.root = runtime.target;
  server.runtimeLinked = true;
  server.legacyRuntime = false;
  return true;
}

async function prepareGenshinPackRuntime(game, server, onProgress) {
  const packRoot = server.root;
  const packExe = path.join(packRoot, 'GenshinImpact.exe');
  const packData = path.join(packRoot, 'GenshinImpact_Data');
  if (!fs.existsSync(packExe) || !fs.existsSync(packData)) return null;
  if (fs.existsSync(path.join(packRoot, 'config.ini'))) return null;

  // 基础客户端谁装好的都行：官服优先，其次任意一个已安装的渠道客户端。
  // 资源包只是「缺的游戏本体」，官服客户端从来不是必需品。
  const base =
    game.servers.find((item) => item.channel === 'official' && item.root && fs.existsSync(item.root)) ||
    game.servers.find(
      (item) => item !== server && item.root && item.root !== packRoot && fs.existsSync(item.root)
    ) ||
    null;
  if (!base || !base.root) {
    throw new Error('这个资源包需要一个已安装的原神客户端作为基础：请先在任意一服那一行点“编辑”选择已安装的客户端。');
  }

  const runtimeRoot = path.join(path.dirname(packRoot), '.vela-runtime', 'genshin-global');
  const runtimeExe = path.join(runtimeRoot, 'GenshinImpact.exe');
  if (!fs.existsSync(runtimeExe)) {
    /*
     * 这一整段可能要搬几十 GB 的文件，以前完全不给进度 —— 用户在切服界面上
     * 看到的就是一个不动的转圈，几分钟没有任何反馈，很像卡死。
     * 现在把 hardlinkTree 的逐帧进度原样往上报（阶段名用 link，界面按「硬链接复用文件」显示）。
     */
    onProgress?.({
      phase: 'link',
      processed: 0,
      total: 0,
      current: '正在为国际服生成独立运行时（硬链接基础客户端文件）…',
    });
    await fsp.mkdir(runtimeRoot, { recursive: true });
    await hardlinkTree({ sourceRoot: packRoot, targetRoot: runtimeRoot, onProgress });
    let carried = 0;
    for (const entry of await fsp.readdir(base.root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (/^(config\.ini|YuanShen\.exe|GenshinImpact\.exe)$/i.test(entry.name)) continue;
      const target = path.join(runtimeRoot, entry.name);
      if (!fs.existsSync(target)) {
        await fsp.copyFile(path.join(base.root, entry.name), target).catch(() => {});
        carried += 1;
      }
    }
    onProgress?.({
      phase: 'link',
      processed: 1,
      total: 1,
      current: carried ? `补齐基础客户端的 ${carried} 个文件，准备收尾` : '正在收尾…',
    });
  }
  const version = String(game.version || '').replace(/^v/i, '') || '7.1.0';
  const configPath = path.join(runtimeRoot, 'config.ini');
  // 国际服预下载标记写在 config.ini 的 predownload= 行。每次切服重建这份运行时镜像时
  // 别把已经下好的标记抹掉，否则 checkHoyoPredownload 永远判「可以预下载」、重复下一遍。
  // 这份 config.ini 是启动器自己写的（hardlinkTree 明确跳过它），用 utf8 直读即可。
  let predownloadMark = '';
  try {
    const prev = fs.readFileSync(configPath, 'utf8');
    const mark = prev.match(/^predownload\s*=\s*(.+)$/im);
    if (mark && mark[1].trim()) predownloadMark = mark[1].trim();
  } catch {}
  const config = `[General]\nsub_channel=0\nsdk_version=\npredownload=${predownloadMark}\ngame_version=${version}\ngame_biz=hk4e_global\ncps=hyp_hoyoverse\nchannel=1\n`;
  await fsp.writeFile(configPath, config, 'utf8');
  return { runtimeRoot, executable: runtimeExe };
}


function findNteLauncher(target) {
  let dir = path.dirname(target);
  for (let level = 0; level < 7; level += 1) {
    const candidate = path.join(dir, 'NTELauncher.exe');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：安装根目录的入口 exe 不在时（被误删/绿色版），找 NTELauncher 子目录里的本体
  dir = path.dirname(target);
  for (let level = 0; level < 7; level += 1) {
    const candidate = path.join(dir, 'NTELauncher', 'NTELauncher.exe');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/**
 * 找异环的直达启动链入口 NTEGame.exe（官方链路 NTELauncher → NTEGame /launcher → HTGame）。
 * NTEGame /launcher 自带资源校验并直达登录窗，跳过 NTELauncher 主界面；
 * 优先 NTELauncher 子目录里的本体，其次向上找根目录入口。
 */
function findNteGame(target) {
  let dir = path.dirname(target);
  for (let level = 0; level < 7; level += 1) {
    for (const candidate of [path.join(dir, 'NTELauncher', 'NTEGame.exe'), path.join(dir, 'NTEGame.exe')]) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep walking up */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/**
 * 异环启动后自动帮用户点官方窗口上的按钮（默认「开始游戏」）。
 * NTEGame.exe /launcher 会弹 Qt 登录窗,按钮还要人手点一下;这里用 UIA 按窗口 PID 找到
 * 名字匹配的按钮直接 Invoke(备选 SelectionItem)。Qt QML / CEF 网页可能不暴露 UIA 树,
 * 拿不到就静默放弃,不影响正常启动流程。
 */
let nteAutoClickRunning = false;

/**
 * 把官方启动器窗口拉到前台。
 * 预下载场景下 NTEGame 很可能已经开着（用户在上一次点击里打开的），这时**不能**走
 * clearNteLingeringLauncher —— 那会把正在下载预下载资源的进程直接杀掉。
 */
function activateWindowByImage(image) {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$p=Get-Process -Name '${image.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if($p){(New-Object -ComObject WScript.Shell).AppActivate($p.Id)}',
  ].join('\n');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 8000 },
      () => resolve()
    );
  });
}

/**
 * 用 tasklist 查这些镜像名里哪些正在运行。查挂了就当没看见（和 assertLauncherClosed 一致：
 * 尽力而为，不让进程查询失败挡住启动）。
 */
function listRunningImages(names) {
  return Promise.all(
    names.map(
      (name) =>
        new Promise((resolve) => {
          execFile(
            'tasklist.exe',
            ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'],
            { windowsHide: true, timeout: 5000 },
            (error, output) => {
              if (error) return resolve('');
              resolve(new RegExp(`^"${name}"`, 'im').test(String(output)) ? name : '');
            }
          );
        })
    )
  ).then((hits) => hits.filter(Boolean));
}

/**
 * 官方启动器（NTEGame.exe）点 × 只是缩进托盘，进程不退出。这时再 spawn 一次会踩中它的
 * 单实例机制：新实例只负责「唤醒旧窗口」就秒退，旧实例收到唤醒后也开始优雅退出——
 * 结果一个窗口都不剩，用户看到的就是「点了开始游戏，毫无反应」。
 * （2026-10-30 15:57 的 NTEGame.log / NTEGame_100.log 完整记录了这一幕。）
 *
 * 所以启动前先清场：
 *   · HTGame.exe 在跑 → 游戏本体已经在运行，提示用户别重复拉；
 *   · NTEUpdate.exe 在跑 → 官方更新器正在自更新，杀掉有风险，让用户等几秒；
 *   · 只有 NTEGame / NTELauncher 挂着（窗口或托盘）→ 结束掉、等互斥量释放，再全新拉起。
 */
async function clearNteLingeringLauncher(gameId) {
  const gameExe = await listRunningImages(['HTGame.exe']);
  if (gameExe.length) return { ok: false, code: 'game-running' };
  const updater = await listRunningImages(['NTEUpdate.exe']);
  if (updater.length) {
    writeLaunchLog(`launch ${gameId}: NTEUpdate.exe 正在自更新，不抢跑`);
    return { ok: false, code: 'updater-running' };
  }
  const lingering = await listRunningImages(['NTEGame.exe', 'NTELauncher.exe']);
  if (!lingering.length) return { ok: true, code: 'clean' };
  writeLaunchLog(`launch ${gameId}: NTE 托盘残留进程 ${lingering.join('、')}（官方启动器关窗不退出），先结束再全新拉起`);
  for (const name of lingering) {
    await new Promise((resolve) => {
      execFile('taskkill.exe', ['/IM', name, '/F', '/T'], { windowsHide: true, timeout: 8000 }, () => resolve());
    });
  }
  // 等单实例互斥量（WMGP_*_MUTEX_NAME）真正释放，最多再等 4 秒
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const left = await listRunningImages(lingering);
    if (!left.length) break;
  }
  return { ok: true, code: 'cleared' };
}

function autoClickNteButton(gameId, keyword, label, rounds = 60) {
  if (nteAutoClickRunning) return;
  nteAutoClickRunning = true;
  const kw = String(keyword).replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "$procs=@(Get-Process -Name 'NTEGame' -ErrorAction SilentlyContinue)",
    "if($procs.Count -eq 0){[Console]::Out.Write('NOPROC');exit}",
    `$kw='${kw}'`,
    "$root=[System.Windows.Automation.AutomationElement]::RootElement",
    "foreach($p in $procs){",
    "  $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$p.Id)",
    "  $wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$cond)",
    "  foreach($w in $wins){",
    // 先按名字精确找（快，Qt QML 常见形态）
    "    $nameCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$kw)",
    "    $hits=@()",
    "    $exact=$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$nameCond)",
    "    if($exact -ne $null){$hits+=$exact}",
    // 再全树扫一遍做包含匹配：CEF 网页里的按钮常带前后缀（「立即预下载」）
    "    if($hits.Count -eq 0){",
    "      $all=$w.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)",
    "      foreach($el in $all){",
    "        $n=$null;try{$n=$el.Current.Name}catch{}",
    "        if(-not $n){continue}",
    "        if($n.Contains($kw)){$hits+=$el}",
    "      }",
    "    }",
    "    foreach($btn in $hits){",
    "      try{$inv=$btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);if($inv -ne $null){$inv.Invoke();[Console]::Out.Write('CLICKED');exit}}catch{}",
    "      try{$sel=$btn.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern);if($sel -ne $null){$sel.Select();[Console]::Out.Write('CLICKED');exit}}catch{}",
    "      try{$la=$btn.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern);if($la -ne $null){$la.DoDefaultAction();[Console]::Out.Write('CLICKED');exit}}catch{}",
    "    }",
    "  }",
    "}",
    "[Console]::Out.Write('NOBTN')",
  ].join('\n');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const attempt = () =>
    new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: 20000 },
        (error, stdout) => resolve(String(stdout || '').trim())
      );
    });
  (async () => {
    try {
      let noProcStreak = 0;
      // 60 轮 × 3.5s ≈ 3.5 分钟：覆盖「打开就是资源更新，更新完才开始按钮」的慢场景
      // （2026-10-30 B服切服实测：212MB 更新跑了 3 分半，25 轮等不到按钮就放弃了）。
      for (let round = 0; round < rounds; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3500));
        const out = await attempt();
        if (out === 'CLICKED') {
          writeLaunchLog(`launch ${gameId}: NTE ${label} button auto-clicked`);
          return;
        }
        if (out === 'NOPROC') {
          // NTEGame 还没起来 or 已被点过/游戏本体接管;连续三轮没有进程就收工
          noProcStreak += 1;
          if (noProcStreak >= 3) return;
          continue;
        }
        noProcStreak = 0;
      }
      writeLaunchLog(`launch ${gameId}: NTE auto-click gave up (${label} button not exposed)`);
    } catch {
      /* 尽力而为,失败不影响启动 */
    } finally {
      nteAutoClickRunning = false;
    }
  })();
}

function autoClickNteStart(gameId) {
  autoClickNteButton(gameId, '开始游戏', 'start');
}

/**
 * 预下载场景：官方页面上那颗「预下载」按钮。
 * CEF 网页不一定向 UIA 暴露内容，点不到就静默收工 —— 窗口已经打开，用户自己点一下即可，
 * 绝不为了「自动」去连点，免得误触别的按钮。
 */
function autoClickNtePredownload(gameId) {
  autoClickNteButton(gameId, '预下载', 'predownload', 24);
}

/*
 * 渠道判定的实现拆到 electron/client-channel.js：那边负责编码自适应（UTF-16 的
 * config.ini）和多字段交叉（game_biz / cps / uapc）。
 * 2.9.1 修复：星铁 / 绝区零的国际服客户端没有 game_biz，以前一律落进「官服」。
 */

/*
 * exe 自带的版本信息兜底：config.ini 读不出来、路径里也没有线索时，
 * 国际服客户端的 CompanyName 是 COGNOSPHERE / HoYoverse，国服是米哈游。
 * 只在前两步都没结论时才跑，结果按路径缓存，检测一轮最多问几次 PowerShell。
 */
const exeCompanyChannelCache = new Map();
function exeCompanyChannel(exePath) {
  if (!exePath) return Promise.resolve('');
  if (exeCompanyChannelCache.has(exePath)) return Promise.resolve(exeCompanyChannelCache.get(exePath));
  return new Promise((resolve) => {
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `$p = ${JSON.stringify(String(exePath))}`,
      'if (Test-Path -LiteralPath $p) { (Get-Item -LiteralPath $p).VersionInfo.CompanyName } else { "" }',
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 8000 },
      (error, stdout) => {
        const company = String(stdout || '').trim();
        let channel = '';
        /*
         * 公司名是「客户端到底是谁发行的」最硬的旁证，比目录名可靠：
         *   COGNOSPHERE / HoYoverse → 米哈游系国际服
         *   Yostar                  → 明日方舟国际服（EN/JP/KR 由 Yostar 发行）
         *   米哈游 / Hypergryph     → 国服
         * 明日方舟的 B服 由鹰角与 B站联合运营，exe 公司名仍是 Hypergryph，
         * 所以这里判不出来 —— 那种情况交给目录名与用户手动选，不硬猜。
         */
        if (/cognosphere|hoyoverse|yostar/i.test(company)) channel = 'global';
        else if (/mihoyo|米哈游|hypergryph|鹰角/i.test(company)) channel = 'official';
        exeCompanyChannelCache.set(exePath, channel);
        resolve(channel);
      }
    );
  });
}

// 检测到的 exe 属于哪个渠道。终末地读不了 config.ini，只能看文件特征。
async function detectionChannel(game, exePath) {
  if (!exePath) return '';
  const key = String(game?.builtinKey || '');
  if (key === 'endfield') return endfieldChannelOf(path.dirname(exePath));
  /*
   * 异环的渠道不写在游戏目录里，而在官方启动器的 NTELauncher/Config/Config.ini
   * 的 Branch 上（publish_ob → 官服、_b → B服）。项目里本来就有现成的读取实现
   * （neverness-channels.js，切换渠道就是改这几个字段），只是检测链路一直没接，
   * 于是国际服客户端会被当成官服写进官服行 —— 和米哈游那三款是同一个毛病。
   */
  if (key === 'neverness') {
    try {
      const read = await nevernessChannels.readNevernessChannel({
        installRoot: path.dirname(exePath),
        gamePath: exePath,
      });
      if (read && read.channel) return read.channel;
    } catch {
      /* 读不到就继续往下走通用判定 */
    }
  }
  const fromConfig = clientChannel.configChannelFromPath(exePath);
  if (fromConfig) return fromConfig;
  const fromPath = clientChannel.pathChannelHint(exePath);
  /*
   * 明日方舟的国际服 / 台服由不同发行商运营，客户端里没有米哈游式的 config.ini，
   * 只能靠目录名与 exe 公司名。Yostar 三区（EN / JP / KR）现在靠安装目录里的
   * `game-launcher-config.json` 的 tag 精确分区 —— 我方「下载游戏」会写这份
   * 元数据，官方启动器也写；认不出来才回落到「global → 组里第一行」。
   */
  if (key === 'arknights') {
    const yostar = await yostarPacks.detectChannelOf(path.dirname(exePath));
    if (yostar) return yostar;
    if (fromPath === 'taiwan') return 'taiwan';
    if (fromPath === 'global') return 'global-en';
    if (fromPath) return fromPath;
    const fromExe = await exeCompanyChannel(exePath);
    return fromExe === 'global' ? 'global-en' : fromExe || 'official';
  }
  if (fromPath) return fromPath;
  const fromExe = await exeCompanyChannel(exePath);
  if (fromExe) return fromExe;
  return 'official';
}

// 检测结果应该写进「真实渠道」那一行，而不是永远写进官服那一行：
// 只装了 B服 / 国际服的玩家，官服那一行本来就没有客户端。
function serverForDetected(game, channel) {
  const servers = game.servers || [];
  if (channel) {
    const matched = servers.find((server) => server.channel === channel);
    if (matched) return matched;
  }
  return servers.find((server) => server.channel === 'official') || servers[0] || null;
}

async function discoverBuiltinServers() {
  if (!store) return 0;
  const execNames = {
    genshin: ['YuanShen.exe', 'GenshinImpact.exe'],
    starrail: ['StarRail.exe'],
    zzz: ['ZenlessZoneZero.exe'],
    endfield: ['Endfield.exe'],
    // 2.4.0 合并：崩坏3 / 明日方舟的自动检测入口
    bh3: ['BH3.exe'],
    arknights: ['Arknights.exe'],
  };
  const roots = discoverServerRoots();
  let changed = 0;
  /*
   * 升级自愈：清掉指向旧「单 work 混合目录」的路径。
   *
   * 本次回退之前，所有非官服渠道共用 G:\VelaRuntimes\endfield\work 一棵树，
   * 里面是「国际服重二进制 + 某渠道 SDK」的混合体，切服会串渠道、启动 3~9 秒
   * 就崩（B服 报「游戏文件损坏或缺失」）。已回退成「每渠道一份独立运行时」，
   * 这些旧路径必须作废，否则老用户升级后直接点「开始游戏」仍会静默启动旧
   * 混合体：launcher-data.json 里 B服/国际服 的 path 还指着它，activeServer 命中
   * → allowPackDownload:false → 重建失败被「尽力而为」吞掉 → 又开旧目录。
   *
   * 只清 path（root 保留指向官服本体 originalRoot），不指向尚未生成的新目录：
   * 悬空 path 会被下面 discoverBuiltinServers 标 incomplete、前端随之拦断切服。
   * 靠 publicGame 的 exists 增强让前端把它当「可切换」，点切换/开始游戏时由
   * ensureEndfieldChannelRuntime 从官服本体整树重建该渠道独立运行时并写回 path。
   * 这是代码级自愈，所有升级用户都会自动收敛，不依赖手改任何一台机器的 data。
   */
  for (const game of store.data.games) {
    if (!game.builtin || game.builtinKey !== 'endfield') continue;
    const official = (game.servers || []).find((server) => server.channel === 'official');
    let gameTouched = false;
    for (const server of game.servers || []) {
      if (server.channel === 'official') continue;
      const dir = String(server.root || (server.path ? path.dirname(server.path) : ''));
      if (!dir) continue;
      // 双判据（路径尾部 + 标记）见 isEndfieldLegacyWorkRoot：目录被删/重命名、
      // 或自定义 runtimeRoot 的旧数据都能认出来；认不出的绝不动，免得误伤用户
      // 自己指到别处的目录。
      if (!isEndfieldLegacyWorkRoot(dir)) continue;
      server.path = '';
      server.root = String(server.originalRoot || (official && official.originalRoot) || '');
      server.runtimeLinked = false;
      server.incomplete = false;
      server.packPath = '';
      server.unavailable = false;
      server.confirmed = false;
      changed += 1;
      gameTouched = true;
      writeLaunchLog(
        `endfield legacy work root migrated: ${server.name}(${server.channel}) → rebuild on next switch`
      );
    }
    if (gameTouched) {
      // 旧 B服/国际服 可能正是当前活跃服：复位到永远可用的官服直启，
      // 免得启动页停在一个 path 已空的服上、点「开始游戏」无从下手。
      const active = (game.servers || []).find((server) => server.id === game.activeServerId);
      if (active && !active.path && official && official.path && targetExists(official.path)) {
        game.activeServerId = official.id;
        game.target = official.path;
        game.workDir = official.root || path.dirname(official.path);
      }
    }
  }
  for (const game of store.data.games) {
    if (!game.builtin || !execNames[game.builtinKey]) continue;
    for (const server of game.servers || []) {
      if (!server.channel || server.channel === 'custom') {
        const name = server.name || '';
        if (name.includes('\u56fd\u9645') || /global/i.test(name)) server.channel = 'global';
        else if (name.includes('B\u670d') || /bilibili/i.test(name)) server.channel = 'bilibili';
        else if (name.includes('\u5b98\u670d') || /official/i.test(name)) server.channel = 'official';
        changed += 1;
      }
      if (!server.path) continue;
      if (!targetExists(server.path)) {
        // 启动程序暂时不在（外接盘未挂载、盘符变化）：
        // 用户手动保存过的路径原样保留，只标记为「暂时不可用」。
        if (server.confirmed) {
          server.incomplete = false;
          server.unavailable = true;
          changed += 1;
          continue;
        }
        server.incomplete = true;
        if (!server.packPath) server.packPath = server.path;
        changed += 1;
        continue;
      }
      const dir = path.dirname(server.path);
      // 终末地每渠道生成的独立硬链接运行时里没有 config.ini（那是米哈游三件套的约定），
      // 只看我们自己写的标记；否则每次启动都会把 B服/国际服标成「需要重建」（红点）。
      // .hxl-endfield-runtime-v2 认所有渠道运行时目录；用户机器上改架构之前建的旧运行时
      // 用的也是这个标记，别让它突然变红。
      const isEndfieldRuntime =
        game.builtinKey === 'endfield' &&
        (server.runtimeLinked === true || isEndfieldRuntimeDir(dir));
      // 明日方舟国际服 EN/JP/KR 是 Yostar 发行的独立客户端，没有米哈游式 config.ini，
      // 它自己的元数据是 game-launcher-config.json（官方启动器与我方下载都会写）。
      // 不把它算作「完整客户端」，每次启动都会被标成 incomplete，切服时又被
      // servers:activate 的 incomplete 守卫拦断 —— 用户看到的就是「识别不到」。
      const isYostarClient =
        game.builtinKey === 'arknights' &&
        yostarPacks.isYostarChannel(server.channel) &&
        fs.existsSync(path.join(dir, 'game-launcher-config.json'));
      // 米哈游四款切服生成的独立硬链接运行时同样是完整客户端。正常情况
      // prepare*Runtime 会写一份渠道专属 config.ini，但若硬链接/合并链路漏写，
      // 别把这一行打回「需要重建」——用 VelaRuntimes 路径 + 渠道自证认它。
      // 终末地 / Yostar 三区 / 方舟国服各有自己的判据，一律不走这里。
      const isMihoyoLinkedRuntime =
        isMihoyoRuntimeDir(dir, game.builtinKey) &&
        (clientChannel.configChannelFromPath(server.path) === server.channel ||
          clientChannel.pathChannelHint(server.path) === server.channel) &&
        targetExists(server.path);
      const hasConfig =
        fs.existsSync(path.join(dir, 'config.ini')) ||
        isEndfieldRuntime ||
        isYostarClient ||
        isMihoyoLinkedRuntime;
      if (!hasConfig) {
        // 没有 config.ini：通常是资源替换包（B服 / 国际服增量包），标记为需要重建。
        // 但不要清空 path / root，否则用户手动配好的客户端会直接消失。
        if (server.confirmed) {
          // 用户手动选过这个启动程序：即使没有 config.ini，也尊重用户的选择，
          // 不再反复标成「需要重建」，否则用户刚配好就打不开。
          if (server.incomplete || server.packPath || server.unavailable) {
            server.incomplete = false;
            server.packPath = '';
            server.unavailable = false;
            changed += 1;
          }
          continue;
        }
        server.incomplete = true;
        if (!server.packPath) server.packPath = server.path;
        changed += 1;
        continue;
      }
      // config.ini 有效：这是一个完整客户端。之前可能被误标为 incomplete，
      // 在这里清掉标记，避免用户界面上一直显示「需要重建」。
      if (server.incomplete || server.packPath || server.unavailable) {
        server.incomplete = false;
        server.packPath = '';
        server.unavailable = false;
        changed += 1;
      }
      // 通道不匹配时不强行清空：config.ini 有效就说明这是一个可用客户端，
      // 自动推断的通道可能不准（例如目录名不含渠道信息）。清空只会让用户重新配置。
    }
    const found = roots.flatMap((root) => walkExecutables(root, execNames[game.builtinKey]));
    for (const exePath of found) {
      // 旧「单 work 混合目录」绝不能被当成客户端补回 path：它是国际服重二进制 +
      // 某渠道 SDK 的残留，启动 3~9 秒就崩。升级迁移会把指向它的 path 清空，
      // 这里再挡一道，免得下次启动又被 walkExecutables 补回来。用同一个双判据
      // helper：标记被删了也还能靠 \endfield\work 路径尾部认出来。
      if (isEndfieldLegacyWorkRoot(path.dirname(exePath))) continue;
      const channel = await detectionChannel(game, exePath);
      const server = (game.servers || []).find((item) => item.channel === channel);
      if (!server) continue;
      const exeDir = path.dirname(exePath);
      // B3：B1 把 VelaRuntimes 四款精确子目录纳入自动扫描后，给「官服 exe 被静默
      // 写进 B服/国际服行」上一道护栏。detectionChannel 对米哈游四款本来就优先
      // 采用同一个 config.ini 的声明，所以正常路径下这道恒不触发；它的价值是
      // 万一以后有人改了 detectionChannel 的兜底顺序，也不会把错渠道的 exe 写回。
      // 只认 config.ini 强声明，目录名弱提示不参与；Yostar 三区 / 终末地 /
      // 异环各有自己的 detectChannelOf / endfieldChannelOf，这里一律不碰。
      if (MIHOYO_RUNTIME_KEYS.includes(game.builtinKey)) {
        const declared = declaredChannelOf(exePath);
        if (declared.config && declared.config !== channel) continue;
      }
      // 完整客户端判据（与上面 hasConfig 四处判据一一对应，只是这里针对扫描到的
      // exe 而不是已有 path 的行）：config.ini / 终末地运行时标记 / Yostar 三区
      // game-launcher-config.json / 米哈游 VelaRuntimes 运行时渠道自证。
      // 少了后两项，Yostar 三区和米哈游硬链接运行时会被当成「资源替换包」标成
      // incomplete 并 continue，server.path 永远写不回去 —— 正是「识别不到」。
      const isCompleteClient =
        fs.existsSync(path.join(exeDir, 'config.ini')) ||
        (game.builtinKey === 'endfield' && isEndfieldRuntimeDir(exeDir)) ||
        (game.builtinKey === 'arknights' &&
          yostarPacks.isYostarChannel(channel) &&
          fs.existsSync(path.join(exeDir, 'game-launcher-config.json'))) ||
        (isMihoyoRuntimeDir(exeDir, game.builtinKey) &&
          (clientChannel.configChannelFromPath(exePath) === channel ||
            clientChannel.pathChannelHint(exePath) === channel) &&
          targetExists(exePath));
      if (!isCompleteClient) {
        if (!server.path || !targetExists(server.path)) {
          server.incomplete = true;
          server.packPath = exePath;
        }
        continue;
      }
      if (server.path && targetExists(server.path)) continue;
      server.path = exePath;
      server.root = exeDir;
      server.incomplete = false;
      server.packPath = '';
      changed += 1;
      if (game.activeServerId === server.id) {
        game.target = exePath;
        game.workDir = server.root;
      }
    }
  }
  return changed;
}

async function detectGame(key) {
  const found = await collectGameCandidates(key);
  return found[0] || null;
}

/**
 * 把某个游戏所有「能找到的客户端」都收出来，不去重渠道。
 *
 * detectGame 找到第一个就收工，够用于「这个游戏装没装」；但点「B服 - 自动扫描」
 * 时不行：注册表和常见目录里官服大概率排在前面，第一个命中的往往是官服 exe，
 * 记进 B服 那一行就成了「扫描B服扫到官服去了」。这个函数只负责全收，
 * 由调用方按 detectionChannel 过滤。
 */
async function collectGameCandidates(key) {
  const def = GAME_DETECTION[key];
  if (!def) return [];
  const out = [];
  const seen = new Set();
  const push = (found) => {
    if (!found) return;
    const stamp = found.toLowerCase();
    if (seen.has(stamp)) return;
    seen.add(stamp);
    out.push(found);
  };

  const registryLists = await Promise.all(def.registry.map((registryKey) => registryValues(registryKey)));
  for (const values of registryLists) {
    for (const value of values) push(checkPath(value, def));
  }

  const roots = new Set();
  for (const envName of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    if (process.env[envName]) roots.add(process.env[envName]);
  }
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`;
    if (fs.existsSync(drive)) {
      roots.add(drive);
      roots.add(path.join(drive, 'Games'));
      roots.add(path.join(drive, 'Program Files'));
    }
  }

  for (const root of roots) {
    for (const rel of def.paths) {
      push(checkPath(path.join(root, rel), def));
    }
  }
  return out;
}

/**
 * 按服务器（渠道）扫一遍：只返回真正属于这个渠道的客户端。
 * 找不到就返回 null，让界面老实说「没找到 B服」，而不是拿官服顶上去。
 */
async function detectServerExecutable(game, server) {
  if (!game || !server) return null;
  const candidates = await collectGameCandidates(game.builtinKey);
  const channel = server.channel || 'official';
  if (!channel || channel === 'custom') return candidates[0] || null;
  for (const item of candidates) {
    // 逐个问渠道：真渠道要靠 config.ini / 版本信息判，目录名不可靠
    // eslint-disable-next-line no-await-in-loop
    if ((await detectionChannel(game, item)) === channel) return item;
  }
  return null;
}

/*
 * 把「放错行」的客户端搬回它真正的渠道那一行（2.9.1 新增）。
 *
 * 为什么要单独修：检测逻辑现在会看 config.ini 的 cps / uapc 了，但老用户的
 * launcher-data.json 里已经存着「官服那一行 = 国际服客户端」这种错配。不清掉的话，
 * 每次更新检查都按 hkrpg_cn / nap_cn 去和客户端比对、gameBiz 也一直传 *_cn，
 * 光修检测不会让他们自愈。
 *
 * 依据只用 config.ini —— 那是客户端自己写的，可信；读不出渠道就一个字都不动，
 * 绝不按目录名猜。目标行已经有可用客户端时，也不搬（两行都有东西就不替用户做决定），
 * 只把这一行的错误路径清掉，让它老实显示「未配置」。
 */
async function repairServerChannels() {
  if (!store) return 0;
  let changed = 0;
  const norm = (value) => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
  for (const game of store.data.games) {
    if (!game.builtin || !game.builtinKey) continue;
    const servers = game.servers || [];
    for (const server of servers.slice()) {
      if (!server.path || !targetExists(server.path)) continue;
      /*
       * 四种情况一律不动，宁可漏修也不能动用户的数据：
       *   · confirmed：用户手动选过的启动程序，渠道标签错也是他的选择；
       *   · packPath：这一行挂的是资源替换包（B服 / 国际服增量包），不是完整客户端；
       *   · 别的服务器用同一个 exe 或同一个目录：官服 / B服 共用一个安装目录是正常玩法；
       *   · 没有任何渠道相同的那一行。
       */
      if (server.confirmed || server.packPath) continue;
      const ownPath = norm(server.path);
      const ownRoot = norm(server.root || path.dirname(server.path));
      const shared = servers.some(
        (item) =>
          item !== server &&
          (norm(item.path) === ownPath ||
            (ownRoot && (norm(item.root) === ownRoot || norm(item.originalRoot) === ownRoot)))
      );
      if (shared) continue;
      const actual = clientChannel.configChannelFromPath(server.path);
      if (!actual || actual === server.channel) continue;
      const target = servers.find((item) => item !== server && item.channel === actual);
      if (!target) continue;
      const targetUsable = Boolean(target.path && targetExists(target.path));
      const movedPath = server.path;
      if (!targetUsable) {
        target.path = movedPath;
        target.root = server.root || path.dirname(movedPath);
        target.incomplete = false;
        target.unavailable = false;
        target.packPath = '';
      }
      server.path = '';
      server.root = '';
      server.packPath = '';
      server.incomplete = true;
      server.unavailable = false;
      if (game.activeServerId === server.id) {
        game.activeServerId = target.id;
        game.target = target.path;
        game.workDir = target.root;
      } else if (game.target && game.target === movedPath) {
        game.target = target.path;
        game.workDir = target.root;
      }
      writeLaunchLog(
        `channel-repair ${game.builtinKey}: ${server.name}(${server.channel}) → ${target.name}(${target.channel}) ${movedPath}`
      );
      changed += 1;
    }
  }
  return changed;
}

async function detectBuiltins(onlyMissing = true) {
  if (!store) return 0;
  // 先修历史错配再检测，理由同 games:detect（否则两行会指向同一个 exe）
  let updated = await repairServerChannels();
  for (const game of store.data.games) {
    if (!game.builtin || !game.builtinKey) continue;
    if (onlyMissing && game.target && targetExists(game.target)) continue;
    const found = await detectGame(game.builtinKey);
    if (found) {
      const active = (game.servers || []).find((server) => server.id === game.activeServerId);
      // 检测到的客户端属于哪个渠道，就写进哪个渠道那一行。
      // 只装了 B服 / 国际服 的玩家本来就没有官服客户端，不能把路径塞进官服行。
      const detected = serverForDetected(game, await detectionChannel(game, found));
      if (detected && (!detected.path || !targetExists(detected.path))) {
        detected.path = found;
        detected.root = path.dirname(found);
        detected.incomplete = false;
        detected.unavailable = false;
      }
      // 已经有一个能用的服务器在用时，别把当前选择抢回默认那一行
      const activeUsable = Boolean(active && active.path && targetExists(active.path));
      if (detected && (!active || !activeUsable)) {
        game.activeServerId = detected.id;
        game.target = detected.path || found;
        game.workDir = path.dirname(game.target);
      }
      updated += 1;
    }
  }
  updated += await discoverBuiltinServers();
  updated += await repairServerChannels();
  if (updated) await store.saveNow();
  return updated;
}

const configIniProbeCache = new Map();
function ensureServers(game) {
  let changed = false;
  if (!Array.isArray(game.servers)) {
    game.servers = [];
    changed = true;
  }
  game.servers = game.servers.filter((server) => server && typeof server === 'object');
  for (const server of game.servers) {
    if (!server.id) {
      server.id = crypto.randomUUID();
      changed = true;
    }
    if (!server.name) {
      server.name = '默认';
      changed = true;
    }
    if (!server.channel) server.channel = 'custom';
    if (!server.path) server.path = '';
    if (server.path && !server.root) {
      server.root = path.dirname(server.path);
      changed = true;
    }
    if (!server.root) server.root = '';
    if (server.path && server.path.includes('.vela-linked-runtime')) {
      server.legacyRuntime = true;
    }
    /*
     * 空壳服务器（从没装过、root 和 path 都为空）不该留着版本号：
     * B服 / 国际服 这类占位服务器会残留上次生成失败时的 sophonVersion，
     * 本地明明已经是新版本，界面上却能看到旧版本号。
     */
    if (!server.root && !server.path && server.sophonVersion) {
      server.sophonVersion = '';
      changed = true;
    }
    /*
     * 已安装的服务器，版本号以磁盘上的 config.ini 为准。
     * 老数据里 sophonVersion 可能一直是空的（更新路径历史上不写这个字段），
     * 空的就按实际客户端补一次，别让服务器条一直显示「版本未知」。
     */
    if (server.root && !server.sophonVersion) {
      const probe = configIniProbeCache.get(server.root);
      if (probe && Date.now() - probe.at < 2000) {
        // 2 秒内刚探过这个目录，别再重复同步读（多数情况这里根本没有 config.ini）
      } else {
        try {
          const text = fs.readFileSync(path.join(server.root, 'config.ini'), 'utf8');
          const local = (text.match(/game_version\s*=\s*([^\r\n]+)/i) || [])[1]?.trim();
          if (local) {
            server.sophonVersion = local;
            changed = true;
          }
          configIniProbeCache.set(server.root, { at: Date.now() });
        } catch {
          configIniProbeCache.set(server.root, { at: Date.now() });
        }
      }
    }
    if (!server.addedAt) server.addedAt = new Date().toISOString();
  }

  if (!game.servers.length) {
    const fallbackPath = game.target && targetExists(game.target) ? game.target : '';
    game.servers.push({
      id: `${game.id || crypto.randomUUID()}-default`,
      name: game.builtin ? '官服' : '默认',
      channel: game.builtin ? 'official' : 'custom',
      path: fallbackPath,
      root: fallbackPath ? path.dirname(fallbackPath) : '',
      addedAt: new Date().toISOString(),
    });
    changed = true;
  }

  const builtinChannels = {
    genshin: [['official', '官服'], ['bilibili', 'B服'], ['global', '国际服']],
    starrail: [['official', '官服'], ['bilibili', 'B服'], ['global', '国际服']],
    zzz: [['official', '官服'], ['bilibili', 'B服'], ['global', '国际服']],
    endfield: [
      ['official', '官服'],
      ['bilibili', 'B服'],
      ['global', '国际服'],
      ['play', 'Play'],
      ['steam', 'Steam'],
    ],
    neverness: [['official', '官服'], ['global', '国际服']],
    // 2.4.0 合并自对方分支：崩坏3 与米家另外几款同构：官服 / B服 / 国际服
    bh3: [['official', '官服'], ['bilibili', 'B服'], ['global', '国际服']],
    // 2.4.0 合并自对方分支：明日方舟 国服（官服 / B服）+ 国际服（Yostar，EN/JP/KR）+ 台服
    arknights: [
      ['official', '官服'],
      ['bilibili', 'B服'],
      ['global-en', '国际服 · 英文', 'global'],
      ['global-jp', '国际服 · 日文', 'global'],
      ['global-kr', '国际服 · 韩文', 'global'],
      ['taiwan', '台服'],
    ],
  }[game.builtinKey];
  if (game.builtin && builtinChannels) {
    for (const [channel, name, group] of builtinChannels) {
      let server = game.servers.find((item) => item.channel === channel);
      if (!server) {
        server = {
          id: `${game.id}-${channel}`,
          name,
          channel,
          path: '',
          root: '',
          // 2.4.0 合并：明日方舟国际服三区域带 group 分组
          ...(group ? { group } : {}),
          addedAt: new Date().toISOString(),
        };
        game.servers.push(server);
        changed = true;
      }
      if (server.builtinServer !== true) {
        server.builtinServer = true;
        changed = true;
      }
      // 2.4.0 合并：分组信息跟着渠道定义走，老数据补一次
      if (group && server.group !== group) {
        server.group = group;
        changed = true;
      }
    }
  }

  let active = game.servers.find((server) => server.id === game.activeServerId);
  if (!active) {
    active = game.servers[0];
    game.activeServerId = active.id;
    changed = true;
  }

  if (active.path && targetExists(active.path)) {
    if (game.target !== active.path) {
      game.target = active.path;
      changed = true;
    }
    if (!game.workDir) game.workDir = active.root || path.dirname(active.path);
  } else if (game.target && targetExists(game.target) && !active.path) {
    active.path = game.target;
    active.root = path.dirname(game.target);
    changed = true;
  } else {
    // 当前服务器的路径失效（盘符变了 / 运行时被清理）：
    // 只要还有别的服务器能用就自动切过去，别让整个游戏退回「检测安装」。
    const usable = (game.servers || []).find(
      (server) => server.id !== active.id && server.path && targetExists(server.path)
    );
    if (usable) {
      game.activeServerId = usable.id;
      game.target = usable.path;
      game.workDir = usable.root || path.dirname(usable.path);
      changed = true;
    }
  }
  return changed;
}

function ensureAllServers() {
  let changed = false;
  for (const game of store.data.games) {
    if (ensureServers(game)) changed = true;
  }
  return changed;
}

function publicGame(game) {
  const hasOfficialCover = /^covers\/official-/.test(game.cover || '');
  const hasCustomCover = game.cover && !/^covers\/(builtin|official)-/.test(game.cover);
  const backgroundVideo = String(game.backgroundVideo || '');
  /*
   * 升级自愈的配套判据：终末地非官服渠道被清掉旧 work 混合体的 path 后，
   * 只要还存在一个完整客户端能当基础，就仍把它算「可切换」。
   * 否则前端 servers.js:699 会因 exists=false 拦断切服，老用户升级后就再也
   * 切不回 B服/国际服。点「切换」/「开始游戏」时主进程会从官服本体整树
   * 重建该渠道独立运行时并写回 path（ensureEndfieldChannelRuntime）。
   */
  const endfieldHasBase =
    game.builtinKey === 'endfield' ? Boolean(endfieldBaseServer(game)) : false;
  return {
    ...game,
    backgroundVideo: /^(?:https?:|file:|data:)/i.test(backgroundVideo)
      ? backgroundVideo
      : backgroundVideo
        ? coverUrl(backgroundVideo)
        : '',
    coverUrl: hasOfficialCover
      ? coverUrl(game.cover)
      : hasCustomCover
        ? coverUrl(game.cover)
        : game.coverUrl || coverUrl(game.cover),
    // 启动页专用：官方图的去文字版本；没有就回退到普通封面
    startMotion: game.startMotion || (game.backgroundVideo ? 'video' : 'pan'),
    startCoverUrl: game.startCover
      ? startCoverUrlOf(game.startCover)
      : hasOfficialCover
        ? startCoverUrlOf(game.cover)
        : hasCustomCover
          ? startCoverUrlOf(game.cover)
          : game.coverUrl || coverUrl(game.cover),
    installed: targetExistsCached(game.target),
    running: running.has(game.id),
    // 启动时刻，前端拿它算「已运行多久」
    runningSince: running.get(game.id)?.startedAt || null,
    // 更新弹窗的置顶图没配来源时，用它标注「图片来源」。
    officialSite: OFFICIAL_SITES[game.builtinKey] || '',
    activeServerId: game.activeServerId || null,
    servers: (game.servers || []).map((server) => ({
      ...server,
      // 判据见 serverExistsForView：光有 exe 不够，B服/国际服若还指着官服目录
      // （独立硬链接运行时没生成）就不算这一服可用。终末地那项「有官服本体
      // 当基础就算可切换」是自愈专用，helper 里原样保留了第二分支。
      exists: serverExistsForView(game, server, endfieldHasBase),
      /*
       * 目录本身还在不在。
       *
       * 「exe 不在」有两种完全不同的原因：没选过路径，和「整个客户端目录被删/挪走了」。
       * 界面靠这两个字段分开说人话，否则删完 B服 的人只会看到「还没选择启动程序」，
       * 根本不知道是自己把共用的客户端目录删掉了。
       */
      rootExists: Boolean(server.root) && targetExistsCached(server.root),
      active: server.id === game.activeServerId,
    })),
  };
}

// ── 异环：账号自动识别 + 导出目录自动导入 ───────────────────────────────
// 异环官方的抽卡记录页只在游戏内浏览器里打开，接口 token 在日志里是打码的，
// 所以没法像终末地那样直接读日志里的 URL 抓记录。能做的是两件事：
//   1. 从启动器日志里认出当前账号（uid / roleId / 区服 / 等级），导入时归到这个账号名下；
//   2. 盯一个固定的「导出目录」，NTE_Gacha_Exporter 导出到那里就自动导入。

function nteInstallRoots() {
  const game = store.data.games.find((item) => item.builtinKey === 'neverness');
  if (!game) return [];
  const roots = new Set();
  for (const server of game.servers || []) {
    let dir = String(server?.path ? path.dirname(server.path) : '');
    if (!dir) continue;
    for (let depth = 0; depth < 7 && dir; depth += 1) {
      if (fs.existsSync(path.join(dir, 'NTELauncher'))) {
        roots.add(dir);
        break;
      }
      const next = path.dirname(dir);
      if (next === dir) break;
      dir = next;
    }
  }
  return [...roots];
}

// 启动器日志是 GBK 写的，按 utf8 读会把中文区服名读成乱码
function decodeNteLog(buffer) {
  try {
    const text = new TextDecoder('gbk').decode(buffer);
    return text.includes('\uFFFD') ? buffer.toString('utf8') : text;
  } catch {
    return buffer.toString('utf8');
  }
}

function readNteAccount() {
  for (const root of nteInstallRoots()) {
    const logPath = path.join(root, 'NTELauncher', 'UserData', 'Log', 'NTEGame.log');
    let text;
    try {
      text = decodeNteLog(fs.readFileSync(logPath));
    } catch {
      continue;
    }
    const matches = [
      ...text.matchAll(
        /\{"appId":"(\d+)","uid":"([^"]*)","token":"[^"]*","roleName":"([^"]*)","level":"([^"]*)","serverId":"([^"]*)","serverName":"([^"]*)","roleId":"([^"]*)"/g
      ),
    ];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];
    return {
      appId: last[1],
      uid: last[2],
      roleName: last[3],
      level: last[4],
      serverId: last[5],
      serverName: last[6],
      roleId: last[7],
      at: new Date().toISOString(),
    };
  }
  return null;
}

async function refreshNteAccount() {
  const account = readNteAccount();
  if (!account) return null;
  const previous = store.data.nteAccount;
  const changed =
    !previous ||
    previous.roleId !== account.roleId ||
    previous.level !== account.level ||
    previous.serverId !== account.serverId;
  store.data.nteAccount = account;
  if (changed) await store.saveNow();
  return account;
}

function nteGachaDir() {
  return path.join(app.getPath('userData'), 'nte-gacha');
}

async function scanNteGachaDrops(options = {}) {
  const dir = nteGachaDir();
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const seen = (store.data.nteImportSeen = store.data.nteImportSeen || {});
  const account = store.data.nteAccount || null;
  let imported = 0;
  let touched = false;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      continue;
    }
    const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    if (seen[entry.name] === key) continue;
    try {
      const result = await importUigf({
        filePath,
        userData: app.getPath('userData'),
        game: 'neverness',
        fallbackUid: account?.roleId || '',
      });
      seen[entry.name] = key;
      touched = true;
      imported += result.imported || 0;
      if (options.notify) {
        send('toast', { type: 'success', message: `已自动导入异环抽卡记录 ${result.imported} 条` });
      }
    } catch (error) {
      // 同一个文件不反复重试，改过内容（mtime 变）才会再试
      seen[entry.name] = key;
      touched = true;
      if (options.notify) {
        send('toast', { type: 'error', message: `异环抽卡记录导入失败：${error.message}` });
      }
    }
  }
  if (touched) {
    await store.saveNow();
    if (imported) pushState(true);
  }
  return imported;
}

/* ---- 自更新 ------------------------------------------------------ */

// 最近一次检查结果，随 state 一起推给渲染层
let updateStatus = {
  checkedAt: 0,
  ok: false,
  hasUpdate: false,
  current: '',
  latest: '',
  notes: '',
  url: '',
  sha256: '',
  size: 0,
  mandatory: false,
  error: '',
  downloading: false,
  percent: 0,
  prepared: null,
  backup: { ok: false },
};

function updateTempBase() {
  const base = portableData ? path.join(portableData, 'tmp') : app.getPath('temp');
  return base;
}

/**
 * 覆盖脚本写日志的位置，按优先级排列。
 * 脚本用的是 <exe 所在目录>\data\tmp，和 updateTempBase() 在便携模式下是同一个地方；
 * 便携目录不可写时会退回系统临时目录，所以两个都试一遍。
 */
function updateLogDirs() {
  const exeDir = path.dirname(process.execPath);
  const dirs = [path.join(exeDir, 'data', 'tmp'), updateTempBase()];
  return [...new Set(dirs)];
}

/**
 * 启动时收拾上一次升级留下的现场。
 *
 * - 包成功应用后，覆盖脚本会写一个 .update-done 标记，下次启动核对到
 *   「package.json 的版本 == 标记里的目标版本」就认为升级落地了，清掉旧备份；
 * - 升级后连续起不来，由 updater.js 在外部把备份还原回来；
 * - 都正常时也只是删掉一个几百 MB 的旧备份目录，不碰其它东西。
 */
function settlePreviousUpdate() {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(updateTempBase(), 'pending.json'), 'utf8'));
  } catch {
    return;
  }
  if (!meta || !meta.backupDir) return;
  let version = '';
  try {
    version = String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '');
  } catch {
    /* ignore */
  }
  if (version && version !== String(meta.targetVersion || '')) {
    // 版本没变说明覆盖脚本没跑完，备份留着，留给用户回滚
    return;
  }
  try {
    fs.rmSync(meta.backupDir, { recursive: true, force: true });
  } catch {
    /* 备份删不掉不影响使用 */
  }
  for (const name of ['pending.json', 'launch-misses.log']) {
    try {
      fs.rmSync(path.join(updateTempBase(), name), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 启动器目录里的更新清单：随包分发的 latest.json。
 * 打包目录放一份、新版 ZIP 放进同一目录，就能离线自更新。
 */
function localUpdateManifest() {
  const dirs = [
    portableRoot || '',
    portableData ? path.dirname(portableData) : '',
    path.dirname(process.execPath),
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'latest.json');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 读不到的目录直接跳过 */
    }
  }
  return '';
}

/**
 * 内置的官方更新源。
 *
 * 随包的 latest.json 里只写了一个「指针」（manifest 字段），指回 GitHub 仓库里的正式清单——
 * 因为打进包里的时候，这个包自己的 sha256 还没算出来，没法把自己写进清单。
 * 正式清单跟着源码一起提交在仓库根目录，启动器启动时会自己去取。
 *
 * 两条路指向同一份文件：raw.githubusercontent 是源头，jsDelivr 是镜像
 * （国内直连 raw 经常被卡，镜像还能读到）。
 *
 * 顺序：用户填的更新源 → 启动器目录里那份 → 官方清单（源站 → 镜像）。
 */
/*
 * 顺序不只是「谁先试」，版本持平时它就是优先级。
 *
 * 各源清单里的下载地址不一样：GitHub 源站和 jsDelivr 上那份写的是 github.com
 * 直连，Gitee 镜像那份写的是带加速前缀的地址。同一时间它们都返回同一个版本号，
 * 所以挑中哪份，就决定了用户从哪条线路下那 188 MB。国内机器上挑到直连就是
 * 几十 KB/s，因此这里把带加速的排在前面；版本真有高低时仍以版本高的为准，
 * 镜像同步落后也不会让用户拿到旧版。
 */
const OFFICIAL_UPDATE_MANIFESTS = [
  // Gitee 镜像仓库：裸连可达，且清单里的下载地址带加速前缀，国内最快的一条。
  // 每次发版后把正式清单同步过去一份。
  'https://gitee.com/SparkleHxl/hxl-update/raw/master/latest.json',
  // fastly 节点：国内裸连比 cdn.jsdelivr.net 稳得多。
  'https://fastly.jsdelivr.net/gh/Sparkle0v0Hxl/HuaXiaoLing-Launcher@main/latest.json',
  'https://cdn.jsdelivr.net/gh/Sparkle0v0Hxl/HuaXiaoLing-Launcher@main/latest.json',
  // 源站放最后：国内直连 raw 经常被卡，只作兜底。
  'https://raw.githubusercontent.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher/main/latest.json',
];

/** 按域名认出这一条属于哪个内置源，给「更新源」下拉做锁定用。 */
function updateSourceKindOf(url) {
  const text = String(url || '').toLowerCase();
  if (!text) return '';
  if (text.includes('gitee.com')) return 'gitee';
  if (text.includes('jsdelivr.net')) return 'jsdelivr';
  if (text.includes('github.com') || text.includes('githubusercontent.com')) return 'github';
  return '';
}

/**
 * 更新源候选：一次给全，挨个试，第一个读得通的算数。
 *
 * 这里按设置里的 updateSourceMode 分流。注意「锁定某一个源」不是「只给它一条」——
 * 用户选中 Gitee 是因为别处走不通，真连 Gitee 也读不到时还是得往下试，否则
 * 一次镜像抖动就会让所有人卡在「检查更新失败」。所以锁定＝把它提到最前，
 * 其余官方源仍然排在后面兜底。
 */
function updateSourceList() {
  const configured = String(store?.data?.settings?.updateManifest || '').trim();
  const mode = String(store?.data?.settings?.updateSourceMode || 'auto').trim() || 'auto';
  const list = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !list.includes(text)) list.push(text);
  };
  /*
   * custom 只认手填地址：用户明确说了「用我自己的」，再拿官方源去试会让
   * 「明明填了却检查到官方版本」这种困惑出现。手填为空时退回自动，避免彻底没源。
   */
  if (mode === 'custom') {
    if (configured) {
      push(configured);
      for (const candidate of updateSourceCandidates(configured)) push(candidate);
    }
    if (!list.length) {
      push(localUpdateManifest());
      for (const url of OFFICIAL_UPDATE_MANIFESTS) push(url);
    }
    return list;
  }
  // mirrorchyan 模式下清单本身还是得从我们自己的源读：Mirror酱 只负责版本比对
  // 和加速下载，它不产出 latest.json。所以这里和 auto 走同一套，差别在
  // performUpdateCheck 里（那边会明说 Mirror酱 测不通的原因）。
  if (mode === 'gitee' || mode === 'jsdelivr' || mode === 'github') {
    for (const url of OFFICIAL_UPDATE_MANIFESTS) {
      if (updateSourceKindOf(url) === mode) push(url);
    }
  }
  if (configured && (mode === 'auto' || mode === 'mirrorchyan')) {
    push(configured);
    for (const candidate of updateSourceCandidates(configured)) push(candidate);
  }
  push(localUpdateManifest());
  for (const url of OFFICIAL_UPDATE_MANIFESTS) push(url);
  return list;
}

/**
 * 把用户填的更新源整理成一个「清单地址」。
 *
 * 设置页写的是「填 https 地址、局域网共享或本地路径」，用户很自然会直接填
 * 放 ZIP 的那个目录，或者只填到 github 仓库首页。这里按顺序试几种常见形态，
 * 免得因为少写一个 latest.json 就报「找不到更新源文件」：
 *   目录 / 省略协议的主机 / http 站点根        → 补 /latest.json
 *   指向 ZIP 本身                               → 换成它旁边的 latest.json
 *   分支名 v2 被当成版本目录                    → 改去试默认分支
 */
function updateSourceCandidates(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];
  const list = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !list.includes(text)) list.push(text);
  };

  // 用户直接粘了 ZIP 的地址
  if (/\.zip$/i.test(raw)) {
    push(raw.replace(/[^/\\]+\.zip$/i, 'latest.json'));
    push(raw.replace(/[^/\\]+\.zip$/i, ''));
  }
  push(raw);
  // 只填了主机（github.com/owner/repo 这类）
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && /^[^\s]+\.(com|cn|net|org|io|dev|app)\//i.test(raw)) {
    push(`https://${raw}`);
  }

  const bases = list.slice();
  for (const base of bases) {
    const trimmed = base.replace(/[/\\]+$/, '');
    if (!/\.json$/i.test(trimmed)) push(`${trimmed}/latest.json`);
    // 分支名恰好是 v2 / v1 这种，被误当成版本目录时再试默认分支
    if (/^(https?):\/\/([^/]+)\/([^/]+)\/([^/]+)\/v\d+\/latest\.json$/i.test(trimmed)) {
      push(trimmed.replace(/\/v\d+(\/latest\.json)$/i, '/main$1'));
      push(trimmed.replace(/\/v\d+(\/latest\.json)$/i, '/master$1'));
    }
  }
  return list.slice(0, 6);
}

/** 更新源候选：设置里填的优先，其次启动器目录里那份，最后官方源。 */
function resolveUpdateSource() {
  return updateSourceList();
}

// 本会话内已经自动弹过「发现新版本」的版本号：同一个版本后台复查（每 6 小时）不再重复弹
let autoNotifiedUpdateVersion = '';

/** 这次检查要不要去问 Mirror酱，以及为什么去/不去。 */
function mirrorchyanGate() {
  const settings = store?.data?.settings || {};
  const mode = String(settings.updateSourceMode || 'auto').trim() || 'auto';
  const rid = String(settings.mirrorchyanRid || '').trim();
  const cdk = String(settings.mirrorchyanCdk || '').trim();
  // 没 RID 就等于还没接入，任何模式都不该去请求——请求必然 404，只会白等 8 秒。
  if (!rid) return { ask: false, mode, rid, cdk, reason: 'no-rid' };
  if (mode === 'custom') return { ask: false, mode, rid, cdk, reason: 'custom-mode' };
  /*
   * 「自动」模式的判定就这一句：CDK 填了才去测。
   *
   * 不填 CDK 时 Mirror酱 只能给版本号、给不出下载地址，查了也只是多一次请求，
   * 而版本号从我们自己的清单就能拿到；更关键的是默认状态下不该让每个用户开机
   * 都向第三方发一次请求。所以自动模式的门槛是「RID 和 CDK 都有」。
   */
  if (mode === 'auto' && !cdk) return { ask: false, mode, rid, cdk, reason: 'auto-no-cdk' };
  return { ask: true, mode, rid, cdk, reason: '' };
}

/**
 * 问一次 Mirror酱 的最新版本，结果并进 updateStatus。
 *
 * 返回值只用来决定「下载走哪条路」，判断有没有更新仍然以我们自己签名的清单为准：
 * Mirror酱 的响应没有签名，不能作为「允许下载」的依据。
 */
async function probeMirrorchyan(gate, options = {}) {
  const result = await mirrorchyan.checkLatest({
    rid: gate.rid,
    cdk: gate.cdk,
    currentVersion: APP_VERSION,
    timeout: options.timeout,
  });
  if (!result.ok) {
    // 失败只留档不起哄：用户选了自动模式、只是 CDK 过期或次数用完，不该弹红字打断。
    writeLaunchLog(`mirrorchyan check failed: code=${result.code} ${result.error || ''}`);
  } else {
    writeLaunchLog(
      `mirrorchyan latest=${result.latest} hasUrl=${result.url ? 'yes' : 'no'} type=${result.updateType || '-'}`
    );
  }
  return result;
}

async function performUpdateCheck(options = {}) {
  const locations = resolveUpdateSource();
  if (!locations.length) {
    updateStatus = {
      ...updateStatus,
      checkedAt: Date.now(),
      ok: false,
      hasUpdate: false,
      current: APP_VERSION,
      latest: '',
      error: '启动器目录里没有 latest.json，也没有设置更新源',
    };
    if (options.push !== false) pushState(true);
    return updateStatus;
  }
  const gate = mirrorchyanGate();
  let mirror = null;
  if (gate.ask) {
    // 并行问：两边的结果要合并，串行会让「检查更新」白等一个来回。
    const [manifestResult, mcResult] = await Promise.all([
      updater.checkForUpdate({ location: locations, currentVersion: APP_VERSION }),
      probeMirrorchyan(gate),
    ]);
    mirror = mcResult;
    return finishUpdateCheck(manifestResult, mirror, gate, options);
  }
  const result = await updater.checkForUpdate({
    location: locations,
    currentVersion: APP_VERSION,
  });
  return finishUpdateCheck(result, null, gate, options);
}

/**
 * 把「自有清单结果」和「Mirror酱 结果」合成一份 updateStatus。
 *
 * 合并规矩：
 *   版本号   取两边更高的那个 —— Mirror酱 通常同步更快，我们自己的镜像偶尔落后。
 *   下载地址 优先 Mirror酱（它有 CDK 才有 url，有 url 就说明用户能用加速）。
 *   签名     Mirror酱 的结果没有签名，所以「能不能装」永远按自有清单的结论走：
 *            自有清单说没更新、而 Mirror酱 说有，仍然提示有更新，但下载回落到原来的源。
 */
function finishUpdateCheck(result, mirror, gate, options = {}) {
  const localLatest = String((result && result.latest) || '').replace(/^v/i, '');
  const localHasUpdate = Boolean(result && result.ok && result.hasUpdate);
  if (mirror && mirror.ok) {
    const mcLatest = String(mirror.latest || '').replace(/^v/i, '');
    const mcNewer =
      mcLatest && (!localLatest || updater.compareVersions(mcLatest, localLatest) > 0);
    if (mcNewer) {
      /*
       * Mirror酱 比我们自己的清单新。这时只能「知道有新版本」，下载地址得看
       * Mirror酱 有没有给：给了就能直接用加速地址，没给就只能等我们自己的
       * 清单跟上——绝不能拿一个没校验过的地址去装。
       */
      result = {
        ...result,
        ok: true,
        hasUpdate: true,
        latest: mcLatest,
        notes: mirror.notes || (result && result.notes) || '',
        // 有这个字段就说明走 Mirror酱 下载，startUpdate 认它
        mirrorUrl: mirror.url || '',
        mirrorSha256: mirror.sha256 || '',
        mirrorSize: mirror.size || 0,
        mirrorType: mirror.updateType || '',
        mirrorRef: gate.mode === 'mirrorchyan' ? 'mirrorchyan' : 'mirrorchyan-newer',
      };
    } else if (localHasUpdate && mirror.url && mirror.sha256) {
      /*
       * 版本一致、本地清单也说要更新，而 Mirror酱 又给了可用地址：这时把下载
       * 换成 Mirror酱 的加速地址。sha256 用 Mirror酱 自己给的——它和自己那份
       * url 是配套的，不能拿本地清单的 sha256 去校验 Mirror酱 的文件。
       */
      result = {
        ...result,
        mirrorUrl: mirror.url,
        mirrorSha256: mirror.sha256,
        mirrorSize: mirror.size || 0,
        mirrorType: mirror.updateType || '',
        mirrorRef: 'mirrorchyan',
      };
    }
  }
  if (gate.mode === 'mirrorchyan' && (!mirror || !mirror.ok)) {
    /*
     * 用户明确选了「只用 Mirror酱」却没测通：把原因写进 error，但不要 hasUpdate=false
     * 之外再翻旧账——自有清单那边可能读得到，只是用户不想用它。
     */
    result = {
      ...result,
      mirrorRef: 'mirrorchyan-failed',
      mirrorError: (mirror && mirror.error) || 'Mirror酱 没有响应',
    };
  }
  /*
   * Mirror酱 给了可用下载地址时，把它当作「用户自己配置的更新源」看待，
   * 和手填 updateManifest 走同一条宽容政策：不强求我们自己的签名。
   *
   * 理由和自定义源一致——是用户主动填了 RID/CDK 把这条链路接进来的，包的可信度
   * 由 Mirror酱 的 sha256 兜（下载时逐字节校验，对不上就丢弃重来）。而我们自己的
   * 签名清单在这里起的是「版本权威」的作用：它说没有更新就绝不升级。
   */
  if (result && result.mirrorUrl && result.mirrorSha256) {
    result = { ...result, sigState: 'mirrorchyan' };
  }
  return finalizeUpdateStatus(result, options);
}

function finalizeUpdateStatus(result, options = {}) {
  /*
   * 签名策略（TOFU：第一次验签成功之后就锁死）。
   *
   * 清单格式是公开的，攻击者想绕过验签最简单的办法不是伪造签名，而是把 sig
   * 字段整个删掉、让我们退回「只校验 sha256」。所以第一次验签成功之后记住那个
   * 版本，从此凡是没签名的清单一律拒绝——不能只拒「版本号更低」的，否则删掉
   * 签名再把 version 写高一点就绕过去了。
   *
   * 代价是「以后每一版都必须签名」。pack.js 已经自动签了，换机器发版记得把
   * H:\HXL-pack\keys\update-signing.pem 一起带走。
   *
   * 用户自己填了更新源（内网共享、自建静态站点）时不强求签名：那份清单本来就
   * 由他自己管，不该让自建源因为没签名而更不了。
   */
  const customSource = String(store?.data?.settings?.updateManifest || '').trim();
  const signedVersion = String(store?.data?.settings?.updateSignedVersion || '').replace(/^v/i, '');
  /*
   * 只在「确实要更新」时才要求签名。
   *
   * 远端版本不高于本机时，这份清单根本不会被拿去下载，拦它没有任何安全收益，
   * 只会让状态行常年挂一条红字——本机版本比线上高是很常见的状态（本地构建、
   * 测试包、镜像还没同步到新版），不能因此一直报「清单没签名」。
   */
  if (result.ok && result.hasUpdate && !customSource && result.sigState === 'none' && signedVersion) {
    /*
     * 拦下归拦下，话要说人话。
     *
     * 以前这里只写「更新清单没有签名（本机已验证过 vX）」，用户看不懂，也拿不到
     * 任何可反馈的信息。现在把「远端其实是多少版」一并写进去——真的遇到发布漏签，
     * 用户截图发过来就能立刻判断是哪一环断的。
     */
    const remoteVersion = String(result.latest || '').replace(/^v/i, '');
    const remoteNewer = remoteVersion && remoteVersion !== String(APP_VERSION || '').replace(/^v/i, '');
    result.ok = false;
    result.hasUpdate = false;
    result.code = 'SIGNATURE_MISSING';
    result.error = `这次更新的清单没带安全签名，已自动拦下（本机上次验签的是 v${signedVersion}${
      remoteNewer ? `，这次清单写的是 v${remoteVersion}` : ''
    }）。通常是发布时漏签了，请稍后再试或联系作者重新发布带签名的清单。`;
  }
  if (result.ok && result.sigState === 'ok') {
    const latest = String(result.latest || '').replace(/^v/i, '');
    /*
     * 只往前记，不往回调。
     *
     * 镜像同步慢、启动器目录里留着上一版的正式清单，这两种情况都会读到版本更低
     * 但带签名的清单；直接覆盖会把「已经验签过的最高版本」降下去，之后的拦截
     * 判断就跟着漂。这里只接受更高的版本。
     */
    if (latest && (!signedVersion || updater.compareVersions(latest, signedVersion) > 0)) {
      store.data.settings.updateSignedVersion = latest;
      store.saveNow().catch(() => {});
    }
  }
  updateStatus = { ...updateStatus, ...result, checkedAt: Date.now(), percent: 0, downloading: false };
  updateStatus.backup = updateBackupInfo();
  if (options.push !== false) pushState(true);
  if (result.hasUpdate) {
    const latest = String(result.latest || '').replace(/^v/i, '');
    // 用户点过「稍后再说」：同一个版本在推迟窗口内不再自动弹
    const snoozeVersion = String(store?.data?.settings?.updateSnoozeVersion || '').replace(/^v/i, '');
    const snoozeUntil = Number(store?.data?.settings?.updateSnoozeUntil) || 0;
    const snoozed = snoozeVersion === latest && Date.now() < snoozeUntil;
    // 同一版本本会话只自动弹一次，挡住每 6 小时的后台复查
    const alreadyAutoNotified = autoNotifiedUpdateVersion === latest;
    // 手动检查（options.manual）不受推迟 / 只弹一次的约束
    if (options.manual || (!snoozed && !alreadyAutoNotified)) {
      autoNotifiedUpdateVersion = latest;
      send('update:available', updateStatus);
    }
  }
  return updateStatus;
}

/** 这批文件正被启动器自己或者正在跑的游戏占用？ */
function describeRunningProcesses(paths) {
  const names = new Set();
  // 启动器自己的 exe 不能算「被别的程序占用」：更新流程本来就是先退自己、再由覆盖脚本接管，
  // 而且 tasklist 里同名的还有渲染/GPU 等子进程，它们会跟着主进程一起退。
  // 不排除的话，每次走到最后一步都会把自己当成占用者，更新永远停在「关掉之后再点一次」。
  const selfExe = path.basename(String(process.execPath || '')).toLowerCase();
  for (const item of paths || []) {
    const base = path.basename(String(item || ''));
    if (!base) continue;
    if (base.toLowerCase() === selfExe) continue;
    names.add(base);
  }
  if (!names.size) return [];
  try {
    const output = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    }).toString();
    const hits = [];
    for (const line of output.split(/\r?\n/)) {
      const name = (line.match(/^"([^"]+)"/) || [])[1];
      if (!name) continue;
      if (!names.has(name)) continue;
      // 只报主进程：Electron 和游戏的子进程会跟着主进程一起退
      if (/_crashpad|--type=/i.test(line)) continue;
      hits.push(name);
    }
    return [...new Set(hits)];
  } catch {
    return [];
  }
}

/* 上次「下载好了但被占用挡住」的更新包：落盘存一份，重启启动器后还能接着装，
 * 不用再下一次几百 MB。 */
function preparedUpdateFile() {
  return path.join(updateTempBase(), 'prepared-update.json');
}

function persistPreparedUpdate(staged) {
  try {
    fs.mkdirSync(updateTempBase(), { recursive: true });
    fs.writeFileSync(preparedUpdateFile(), JSON.stringify(staged, null, 2), 'utf8');
  } catch {
    /* 存不下就只是下次要重下，不影响本次 */
  }
}

function loadPreparedUpdate() {
  try {
    const staged = JSON.parse(fs.readFileSync(preparedUpdateFile(), 'utf8'));
    if (!staged || !staged.tempRoot || !staged.source) return null;
    if (!fs.existsSync(staged.source)) return null;
    // 两套覆盖器至少要有一套在（Node 版优先，老包只有 PowerShell 版）
    const hasApplyJs = staged.applyJsSource && fs.existsSync(staged.applyJsSource);
    const hasPs1 = staged.installerSource && fs.existsSync(staged.installerSource);
    if (!hasApplyJs && !hasPs1) return null;
    return staged;
  } catch {
    return null;
  }
}

function clearPreparedUpdate() {
  try {
    fs.rmSync(preparedUpdateFile(), { force: true });
  } catch {
    /* ignore */
  }
}

/** 覆盖的最后一段：核对 → 查占用 → 交给覆盖脚本重启。 */
async function applyStaged(staged) {
  const conflict = updater.describeApplyProblem({ staged, currentVersion: APP_VERSION });
  if (conflict) throw new Error(conflict);
  const busy = describeRunningProcesses(staged.locks);
  if (busy.length) {
    updateStatus = { ...updateStatus, downloading: false, percent: 0, prepared: staged };
    persistPreparedUpdate(staged);
    pushState(true);
    return {
      ok: false,
      message: `升级包已就绪，但这些程序还开着，关掉之后再点一次更新：\n${busy.join('、')}`,
      busy,
    };
  }

  updateStatus = { ...updateStatus, percent: 100, prepared: null };
  send('update:progress', { percent: 100, phase: 'apply', label: '正在覆盖程序文件，马上重启…' });
  await updater.apply({
    staged,
    onReadyToQuit: () => {
      setTimeout(() => {
        quitting = true;
        app.quit();
      }, 250);
    },
  });
  clearPreparedUpdate();
  return { ok: true, restarting: true, version: staged.version };
}

/** 增量包下载最多换几条线路。只是「更快」，绝不能成为「更新不了」的新原因。 */
const DELTA_DOWNLOAD_ATTEMPTS = 3;
const RETRYABLE_NET_CODES = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETRESET|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|ABORTED)$/;
const RETRYABLE_NET_MESSAGE = /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ABORTED|AbortError|timeout|超时|没有响应|连不上|连接.*失败|传输失败|停滞|socket hang up|read E|HTTP 5\d\d|下载失败（5\d\d）)/i;

/** 只认瞬时网络故障：校验不过、基准不符、路径非法这些重试多少次都不会变。 */
function isDeltaRetryable(error) {
  if (!error) return false;
  if (error.retryable === false) return false;
  const code = String(error.code || (error.cause && error.cause.code) || '').toUpperCase();
  if (RETRYABLE_NET_CODES.test(code) || /^UND_ERR_/.test(code)) return true;
  if (error.timeout === true || error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  return RETRYABLE_NET_MESSAGE.test(String(error.message || error || ''));
}

/**
 * 下载并重建增量包，产出 staged（之后交给 applyStaged 走同一套备份+覆盖+重启）。
 * 任何异常都往外抛，由 startUpdate 捕获后退回整包——增量只是「更快」，绝不能成为
 * 「更新不了」的新原因。
 *
 * 仅「下载」这一步做有限重试：每条线路失败就换下一条候选（镜像前置、直连末尾兜底）。
 * sha256 校验与 stageDelta 是确定性失败，放循环外，重试只会白等。
 */
async function downloadAndStageDelta({ delta, manifest, tempBase }) {
  const dir = path.join(tempBase, 'download');
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  // 独立文件名：两次尝试同时进行时不会互相踩掉对方的文件
  const deltaPath = path.join(
    dir,
    `delta-${APP_VERSION}-to-${manifest.version}-${Date.now().toString(36)}.zip`
  );
  send('update:progress', { percent: 0, phase: 'delta', label: '正在下载增量更新…' });
  let percent = -1;
  let lastPushAt = 0;
  const onDeltaProgress = (progress) => {
    const next = Math.round(progress.percent);
    const now = Date.now();
    // 百分比变了就推；没变但过了 800ms 也推，慢速时界面才不是死的
    if (next === percent && now - lastPushAt < 800 && next !== 100) return;
    percent = next;
    lastPushAt = now;
    updateStatus = { ...updateStatus, percent: next, delta: true, speed: progress.speed || 0 };
    const speedText = progress.speed
      ? ` · ${(progress.speed / 1048576).toFixed(1)} MB/s`
      : '';
    send('update:progress', {
      percent: next,
      phase: 'delta',
      received: progress.received,
      total: progress.total,
      speed: progress.speed || 0,
      label: `增量更新 ${next}%${speedText}`,
    });
  };
  try {
    let lastError = null;
    let downloaded = false;
    for (let attempt = 0; attempt < DELTA_DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        // 每条线路只下增量包（几百 KB）；失败就换下一批候选线路重来。
        // 镜像前置、裸直连末尾兜底，避免每次先卡满一次直连超时。
        await updater.downloadToFile({
          url: delta.url,
          dest: deltaPath,
          expectedSize: delta.size,
          onProgress: onDeltaProgress,
          sourceStartIndex: attempt,
        });
        downloaded = true;
        break;
      } catch (error) {
        await fsp.rm(deltaPath, { force: true }).catch(() => {});
        lastError = error;
        // 校验/基准/路径这类确定性失败不会因重试变好，直接抛给 startUpdate 退回整包
        if (!isDeltaRetryable(error) || attempt >= DELTA_DOWNLOAD_ATTEMPTS - 1) throw error;
        const reason = error && error.message ? error.message : String(error);
        writeLaunchLog(`delta download attempt ${attempt + 1} 失败：${reason}`);
        percent = -1;
        lastPushAt = 0;
        send('update:progress', {
          percent: 0,
          phase: 'delta',
          label: `增量下载线路 ${attempt + 1} 失败，正在换线路重试…`,
        });
        await delay(300 * (attempt + 1));
      }
    }
    if (!downloaded) throw lastError || new Error('增量包下载失败');
    const actual = await updater.sha256File(deltaPath);
    if (actual !== delta.sha256) throw new Error('增量包校验没通过（sha256 对不上）');
    send('update:progress', { percent: 100, phase: 'delta-apply', label: '正在按增量重建文件…' });
    return await updater.stageDelta({
      deltaPath,
      tempBase,
      version: manifest.version,
      currentVersion: APP_VERSION,
    });
  } catch (error) {
    await fsp.rm(deltaPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 清掉下载目录里超过一天的旧包。
 *
 * 每次尝试都用独立文件名（避免两次尝试互相删掉对方正在写的文件），
 * 不清理的话失败几次就会在 data\tmp\download 里攒下几百 MB。
 */
async function sweepOldDownloads(dir) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const entries = await fsp.readdir(dir).catch(() => []);
  for (const name of entries) {
    if (!/^(HuaXiaoLing-|delta-)/.test(name)) continue;
    const full = path.join(dir, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fsp.rm(full, { force: true }).catch(() => {});
  }
}

async function startUpdate(options = {}) {
  if (updateStatus.downloading) throw new Error('已经在下载更新了');
  // 上一次已经下载解压好、只是被占用程序挡住了：直接用那份，别再下一次几百 MB
  const ready = updateStatus.prepared || loadPreparedUpdate();
  if (ready) {
    try {
      return await applyStaged(ready);
    } catch {
      // 这份已经不能用了（版本对不上 / 解压目录被清掉），清掉走正常下载
      updateStatus = { ...updateStatus, prepared: null };
      clearPreparedUpdate();
    }
  }
  const locations = resolveUpdateSource();
  if (!locations.length) throw new Error('还没有设置更新源');
  updateStatus = { ...updateStatus, downloading: true, percent: 0, error: '' };
  pushState(true);
  let pendingVersion = '';
  try {
    // 挨个候选找一份读得通的清单：用户填的 → 目录里那份 → 官方源
    send('update:progress', { percent: 0, phase: 'manifest', label: '正在读取更新清单…' });
    const resolved = await updater.resolveManifest(locations);
    if (!resolved.ok) throw new Error(resolved.error || '读不到更新清单');
    const manifest = resolved.manifest;
    pendingVersion = String(manifest.version || '');
    if (updater.compareVersions(manifest.version, APP_VERSION) <= 0) {
      const info = await performUpdateCheck({ push: false });
      updateStatus = { ...info, downloading: false, percent: 0, error: '' };
      pushState(true);
      return { ok: false, message: `已经是最新版本（v${APP_VERSION}）` };
    }
    if (!manifest.url) throw new Error('更新源没有给出下载地址');
    if (!manifest.sha256) throw new Error('更新源里没有写 update 包的 sha256，为安全起见不自动安装');

    /*
     * Mirror酱 的加速地址：只在它给的是**完整包**（update_type=full）时才用。
     *
     * 它也可能返回 incremental（一个 changes.json + 改动的文件），那是它自己的一套
     * 增量格式，和 updater.stageDelta 认的补丁包完全不是一回事，硬套进去只会
     * 装出半个客户端。所以增量包一律不用它的地址，让它走我们自己的差分包/完整包
     * ——反正那份清单本来就是从我们自己的源读的，链路上没损失。
     *
     * 代价是买 CDK 的用户在「恰好只有增量包」的情况下享受不到加速。这个取舍是
     * 有意的：加速是锦上添花，装坏客户端不是。
     */
    const mirrorReady =
      updateStatus.mirrorUrl &&
      updateStatus.mirrorSha256 &&
      String(updateStatus.mirrorType || 'full').toLowerCase() !== 'incremental';
    const downloadUrl = mirrorReady ? updateStatus.mirrorUrl : manifest.url;
    const downloadSha = mirrorReady ? updateStatus.mirrorSha256 : manifest.sha256;
    const downloadSize = mirrorReady ? updateStatus.mirrorSize || manifest.size : manifest.size;

    const tempBase = updateTempBase();
    await fsp.mkdir(tempBase, { recursive: true }).catch(() => {});

    // 增量更新优先：清单里有「当前版本 -> 目标版本」的差分包时，只下变化的部分。
    // 任何一步不对都静默退回整包，绝不让「更快」变成「更新不了」。
    // Mirror酱 接管完整包下载时跳过这一步：它给的是另一个版本自己的完整包，
    // 我们的差分包基准对不上（也可能压根没有），硬试只会白等一轮失败。
    const deltaInfo = mirrorReady ? null : updater.pickDelta(manifest, APP_VERSION, manifest.version);
    if (deltaInfo && deltaInfo.url && deltaInfo.sha256) {
      try {
        const staged = await downloadAndStageDelta({ delta: deltaInfo, manifest, tempBase });
        return await applyStaged(staged);
      } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        updateStatus = { ...updateStatus, delta: false };
        /*
         * 必须留档：增量为什么退回整包，界面上一句 toast 看完就没了。
         * 「本地和基准对不上」往往不是这次才发生的——多半是更早某次更新有文件
         * 被占着没覆盖成功，从那以后每一版都只能下整包。
         */
        writeLaunchLog(`delta ${APP_VERSION} -> ${manifest.version} 失败：${msg}`);
        send('toast', { message: `增量更新没成功（${msg}），改用完整包`, type: 'info' });
        // 增量包自己在失败时已经删掉了，这里只顺手扫一遍过期残留
        await sweepOldDownloads(path.join(tempBase, 'download')).catch(() => {});
      }
    }

    // 包名带上版本号，换版本时不会认错上一个版本的残留文件；
    // 再加一个会话内唯一后缀，避免两次尝试同时写同一个文件（上一次失败的清理会把它删掉，
    // 正在写的那次就会拿到「文件不存在」，随后又从 0 重下）。
    const attemptTag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const zipPath = path.join(
      tempBase,
      'download',
      `HuaXiaoLing-${manifest.version}-Portable-${attemptTag}.zip`
    );
    await sweepOldDownloads(path.dirname(zipPath)).catch(() => {});
    let percent = 0;
    let lastPushAt = 0;
    try {
      await updater.downloadToFile({
        url: downloadUrl,
        dest: zipPath,
        expectedSize: downloadSize,
        onProgress: (progress) => {
          const next = Math.round(progress.percent);
          const now = Date.now();
          /*
           * 百分比变化就推；百分比没变但已经过去 800ms 也推一次——
           * 慢速线路上 1% 可能要走十几秒，不推的话界面上既没有新进度也没有速度，
           * 看着就像卡死在 0%。
           */
          if (next === percent && now - lastPushAt < 800 && next !== 100) return;
          percent = next;
          lastPushAt = now;
          updateStatus = { ...updateStatus, percent: next, speed: progress.speed || 0 };
          send('update:progress', {
            percent: next,
            received: progress.received,
            total: progress.total,
            speed: progress.speed || 0,
          });
          if (progress.total && options.onTotal) options.onTotal(progress.total);
        },
      });
    } catch (error) {
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      // 退回直连再试一次：局域网共享和本地文件走不到这里，HTTP 才需要
      if (options.retried || (error.retryable === false)) throw error;
      send('toast', { message: '直连下载失败，正在重试…', type: 'info' });
      percent = 0;
      return await startUpdate({ ...options, retried: true });
    }

    const actual = await updater.sha256File(zipPath);
    if (actual !== downloadSha) {
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      throw new Error('更新包校验没通过（sha256 对不上），可能没下载完整，请重试');
    }

    // 100% 之后还有解压、覆盖两大步，界面必须继续给反馈，否则用户以为卡死了
    send('update:progress', { percent: 100, phase: 'verify', label: '正在校验更新包…' });

    // 解压、检查包结构，同时算出被占用的程序文件。
    // 版本号以清单为准：package.json 只在发版时才改，清单是随时能改的。
    send('update:progress', { percent: 100, phase: 'extract', label: '正在解压更新包…' });
    const staged = await updater.stage({ zipPath, tempBase, version: manifest.version });
    return await applyStaged(staged);
  } catch (error) {
    const message = error?.message ? error.message : String(error);
    updateStatus = {
      ...updateStatus,
      downloading: false,
      percent: 0,
      error: message,
    };
    pushState(true);
    /*
     * 更新失败必须留档。用户界面上只有一句 toast，看完就没了；「别的用户更新失败：
     * ABORTED」那次反馈之所以只能靠猜，就是因为这里什么都没记。导出诊断时要能
     * 查到哪一步失败、什么错误码。
     */
    try {
      writeLaunchLog(
        `update ${APP_VERSION} -> ${pendingVersion || '?'} 失败：${message}${error && error.code ? `（code=${error.code}）` : ''}`
      );
      diagnostics.recordEvent('error', 'update', message, error && error.code ? `code=${error.code}` : '');
    } catch {
      /* 记录失败不能盖住真正的错误 */
    }
    throw error;
  }
}

/* 上次更新是否折腾过程序目录——决定要不要在设置页露出「回滚」。 */
function updateBackupInfo() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(updateTempBase(), 'backup-meta.json'), 'utf8'));
    return {
      ok: true,
      version: String(meta.fromVersion || ''),
      target: String(meta.targetVersion || ''),
      at: Number(meta.at) || 0,
    };
  } catch {
    return { ok: false };
  }
}

/*
 * 显卡加速是否可用。
 *
 * 显卡加速不可用（GPU 进程起不来 / 驱动被拉黑）时，Chromium 会退到 SwiftShader
 * 软件渲染：视频背景的每一帧都要 CPU 解码 + 软件合成，实测常驻吃掉一个核心，
 * 而用户看到的就是「启动器什么都没干却一直占 CPU」。
 * 渲染层拿到这个标记后，默认改用静态版本图（仍然可以手动切回视频）。
 */
let gpuFeatureStatus = null;

function refreshGpuStatus() {
  let next = {};
  try {
    next = app.getGPUFeatureStatus() || {};
  } catch {
    next = {};
  }
  const before = gpuFeatureStatus ? String(gpuFeatureStatus.gpu_compositing || '') : '';
  gpuFeatureStatus = next;
  const after = String(next.gpu_compositing || '');
  if (before && before !== after) {
    console.log(`[显卡加速] 状态变化：${before} → ${after || '未知'}`);
    pushState(true);
  }
  return after;
}

function softwareRendering() {
  const status = gpuFeatureStatus
    ? String(gpuFeatureStatus.gpu_compositing || '')
    : refreshGpuStatus();
  return status.includes('disabled_software');
}

/* ------------------------------------------------------------------ */
/* 抽卡记录云备份（WebDAV）                                             */
/* ------------------------------------------------------------------ */

/*
 * 周期固定 7 天，不给用户调。
 *
 * 取 7 天而不是更短：抽卡记录是只增不改的东西（一条记录抽出来就不会再变），
 * 备份之间隔得再密也不会多救回什么，只会让网盘里多几份几乎一样的文件。
 * 一周一次正好跟「抽卡记录本身也是按卡池周期在长」对上。
 *
 * 调度器没有用「setTimeout 睡 7 天」：合盖、待机、系统休眠之后长定时器会漂，
 * 醒来还得自己算补偿量。这里改成定时醒来看一眼 now - lastAt 够不够 7 天，
 * 不够继续睡 —— 错过的时段下一轮自然补上，服务重启也不影响判断。
 *
 * 醒来的间隔是 1 小时，不取更短：7 天 = 168 小时，1 小时的判断误差对备份周期
 * 没有任何意义。这一点要说清楚 ——「醒来」只是读内存里的 lastAt 做一次减法，
 * 不联网、不碰网盘、不读密码，真正带着账号发请求的只有到点那一次（7 天一回）。
 * 待机回来由 powerMonitor 的 resume 单独补一次检查，所以间隔拉长不会漏。
 *
 * 启动后 2 分钟的 kickoff 只做「首次检查」：新用户 lastAt=0，开了开关两分钟内就会
 * 走第一次备份，之后按 7 天算。
 */
const GACHA_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const GACHA_BACKUP_TICK_MS = 60 * 60 * 1000;
const GACHA_BACKUP_KICKOFF_MS = 2 * 60 * 1000;
/*
 * 失败退避：密码错、网盘抽风这类问题，不能每小时拿同一份凭据再去敲一次门
 * —— 连续失败既救不回任何数据，还可能撞上对方的风控。首败等 2 小时，
 * 之后逐次翻倍，封顶 12 小时。用户改完配置（保存 / 测试通过）会立刻清零重来。
 */
const GACHA_BACKUP_RETRY_BASE_MS = 2 * 60 * 60 * 1000;
const GACHA_BACKUP_RETRY_MAX_MS = 12 * 60 * 60 * 1000;
const GACHA_BACKUP_PASSWORD_KEY = 'gachaBackupPassword';
const GACHA_BACKUP_SECRET_KEY = 'gachaBackupSecret';

let gachaBackupTimer = null;
let gachaBackupKickoff = null;
let gachaBackupRunning = false;
let gachaBackupResumeHooked = false;
// 失败退避：到点前不再尝试，以及连续失败次数（用来算下次等多久）
let gachaBackupRetryAt = 0;
let gachaBackupFailStreak = 0;

/**
 * 口令到底存没存过。
 *
 * safeStorage 是异步的，而 snapshot() 必须同步返回，所以这里读一次缓存住；
 * 保存配置、启动时各刷新一次。不把这个标记写进 launcher-data.json ——
 * 用户手动删掉 sessions.enc.json 之后，存下来的标记就会开始骗人。
 */
const gachaSecretFlags = { password: false, secret: false };

async function refreshGachaSecretFlags() {
  const [password, secret] = await Promise.all([
    loadSecret(GACHA_BACKUP_PASSWORD_KEY),
    loadSecret(GACHA_BACKUP_SECRET_KEY),
  ]);
  gachaSecretFlags.password = Boolean(password);
  gachaSecretFlags.secret = Boolean(secret);
}

/** 存下来的配置（不含任何明文口令）。 */
function gachaBackupConfig() {
  const raw = (store && store.data.settings && store.data.settings.gachaBackup) || {};
  return {
    enabled: raw.enabled === true,
    url: String(raw.url || ''),
    username: String(raw.username || ''),
    keep: Math.max(1, Math.min(10, Number(raw.keep) || gachaBackup.DEFAULT_KEEP)),
    lastAt: Number(raw.lastAt) || 0,
  };
}

/** 给渲染层的快照：配置 + 上次结果 + 两个「有没有存口令」的标记。 */
function gachaBackupSnapshot() {
  const config = gachaBackupConfig();
  const raw = (store && store.data.settings && store.data.settings.gachaBackup) || {};
  return {
    enabled: config.enabled,
    url: config.url,
    username: config.username,
    keep: config.keep,
    lastAt: config.lastAt,
    lastResult: String(raw.lastResult || ''),
    lastError: String(raw.lastError || ''),
    hasPassword: gachaSecretFlags.password,
    hasSecret: gachaSecretFlags.secret,
    intervalDays: Math.round(GACHA_BACKUP_INTERVAL_MS / 86400000),
  };
}

/** 真正调模块时用的配置：把口令从 safeStorage 里取出来。 */
async function gachaBackupCredentials() {
  const config = gachaBackupConfig();
  return {
    url: config.url,
    username: config.username,
    password: await loadSecret(GACHA_BACKUP_PASSWORD_KEY),
    secret: await loadSecret(GACHA_BACKUP_SECRET_KEY),
    keep: config.keep,
  };
}

/** 跑一次备份，结果（成功或失败）都记进设置，界面直接能看到。 */
async function runGachaBackup(reason = '自动') {
  if (!store) return { ok: false, error: '数据还没准备好' };
  if (gachaBackupRunning) return { ok: false, error: '上一轮备份还在跑' };
  gachaBackupRunning = true;
  const settings = store.data.settings.gachaBackup;
  try {
    const config = await gachaBackupCredentials();
    const result = await gachaBackup.backupNow({
      config,
      userData: app.getPath('userData'),
      keep: config.keep,
    });
    settings.lastAt = Date.now();
    settings.lastResult = result.text;
    settings.lastError = '';
    gachaBackupFailStreak = 0;
    gachaBackupRetryAt = 0;
    await store.saveNow();
    pushState(true);
    console.log(`[抽卡云备份] ${reason}成功：${result.text}`);
    return result;
  } catch (error) {
    settings.lastError = error.message;
    // 失败不改 lastAt（改了就等于整周不重试），改用内存里的退避时间挡一阵
    gachaBackupFailStreak += 1;
    const wait = Math.min(
      GACHA_BACKUP_RETRY_BASE_MS * 2 ** (gachaBackupFailStreak - 1),
      GACHA_BACKUP_RETRY_MAX_MS
    );
    gachaBackupRetryAt = Date.now() + wait;
    await store.saveNow();
    pushState(true);
    console.warn(
      `[抽卡云备份] ${reason}失败：${error.message}（第 ${gachaBackupFailStreak} 次，` +
        `${Math.round(wait / 60000)} 分钟后才重试）`
    );
    return { ok: false, error: error.message };
  } finally {
    gachaBackupRunning = false;
  }
}

/** 到点没到点：没开开关、没填地址、还在失败退避里、还没满 7 天，一律不动手。 */
async function maybeGachaBackup() {
  const config = gachaBackupConfig();
  if (!config.enabled || !config.url || !config.username) return;
  if (Date.now() < gachaBackupRetryAt) return;
  if (Date.now() - config.lastAt < GACHA_BACKUP_INTERVAL_MS) return;
  await runGachaBackup('自动备份');
}

/** 重排定时器：开关一改就重来一遍，免得旧定时器还在按老配置跑。 */
function scheduleGachaBackup() {
  if (gachaBackupTimer) {
    clearInterval(gachaBackupTimer);
    gachaBackupTimer = null;
  }
  if (gachaBackupKickoff) {
    clearTimeout(gachaBackupKickoff);
    gachaBackupKickoff = null;
  }
  gachaBackupTimer = setInterval(() => {
    maybeGachaBackup().catch(() => {});
  }, GACHA_BACKUP_TICK_MS);
  if (gachaBackupTimer.unref) gachaBackupTimer.unref();
  gachaBackupKickoff = setTimeout(() => {
    maybeGachaBackup().catch(() => {});
  }, GACHA_BACKUP_KICKOFF_MS);
  if (gachaBackupKickoff.unref) gachaBackupKickoff.unref();

  // 轮询间隔是一小时，靠 resume 补上「合盖那几天正好跨过 7 天」的情况。
  // 只挂一次：scheduleGachaBackup 会被开关反复调用，重复挂会攒出一串同样的回调。
  if (!gachaBackupResumeHooked) {
    gachaBackupResumeHooked = true;
    const onResume = () => {
      maybeGachaBackup().catch(() => {});
    };
    powerMonitor.on('resume', onResume);
    powerMonitor.on('unlock-screen', onResume);
  }
}

/**
 * 代理地址规范化。只接受 http / https / socks5 形态，其余一律当没填。
 *
 * 用户常从别处整段复制，前后带空格或说明文字，这里统一裁掉；
 * 也挡住「随手填个域名」导致 setProxy 抛错、整个启动器联网全废的情况。
 */
function normalizeProxyRules(value) {
  const text = String(value || '').trim().slice(0, 200);
  if (!text) return '';
  if (!/^(https?|socks5h?):\/\/[^\s/]+/i.test(text)) return '';
  return text;
}

/**
 * 把 Chromium 的 resolveProxy 结果转成设置页认得的代理规则。
 *
 * 返回形如 "PROXY 127.0.0.1:7890;DIRECT" / "SOCKS5 127.0.0.1:1080" / "DIRECT"。
 * 取第一个选项；纯 DIRECT 返回空串——空串在这里表示「问过了，结论是直连」，
 * 而不是「问不出来」，这两种情况在 proxy-agent 里的后续行为不同。
 */
function proxyFromResolved(raw) {
  const text = String(raw || '');
  const match = text.match(/(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^\s;]+)/i);
  if (!match) return '';
  const scheme = match[1].toUpperCase();
  return scheme.startsWith('SOCKS') ? `socks5://${match[2]}` : `http://${match[2]}`;
}

/**
 * 把设置里的代理应用到 Electron 默认会话。
 *
 * 只改 Chromium 的内存代理配置——不写系统代理、不动注册表，退出启动器
 * 对系统毫无影响。写错了也只是启动器自己连不上，不会影响用户其他软件。
 */
async function applyProxySettings() {
  const target = session.defaultSession;
  if (!target) return;
  const rules = normalizeProxyRules(store?.data?.settings?.proxyRules);
  /*
   * 同一份代理要同时告诉两条网络栈。
   *
   * setProxy 只作用于 Chromium（net.fetch）；而下载的 16 路并发全跑在
   * node:https 上，node 完全不认 setProxy，也不读注册表。所以这里再注入一个
   * 解析器：优先用设置里手填的地址，没填就问 Chromium 系统代理的真实决策
   * （PAC 也由它算，比自己解析注册表可靠）。
   */
  proxyTunnel.setProxyResolver(async (requestUrl) => {
    const manual = normalizeProxyRules(store?.data?.settings?.proxyRules);
    if (manual) return manual;
    try {
      return proxyFromResolved(await target.resolveProxy(requestUrl));
    } catch {
      // 读不到系统代理：返回 undefined，让它退到环境变量（HTTPS_PROXY 等）
      return undefined;
    }
  });
  try {
    if (rules) {
      await target.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
    } else {
      await target.setProxy({ mode: 'direct' });
    }
  } catch {
    /* 代理填错不该让启动器起不来 */
  }
}

/**
 * 把设置里的下载限速应用到下载层。
 *
 * 存储用 KB/s（整数，界面上好填），下载层用字节/秒。0 表示不限速。
 * 任何时候都可以改，改完对正在跑的下载立刻生效——下载循环每读一块都会
 * 重新算当前该等多久，不需要重启或者重开下载。
 */
function applyDownloadLimit() {
  const kb = Number(store?.data?.settings?.downloadLimitKBps) || 0;
  const clamped = Math.max(0, Math.min(102400, Math.round(kb)));
  netThrottle.setLimit(clamped > 0 ? clamped * 1024 : 0);
  return clamped;
}

/**
 * 读系统代理，转成设置页那个输入框认得的格式。
 *
 * 用户装了 Clash / v2rayN 之后，最常卡住的一步是「知道自己在用代理，但不知道
 * 端口号」。resolveProxy 是 Chromium 自己解析出来的结果（系统代理、PAC 脚本
 * 都算），直接问它比读注册表可靠——PAC 和 Windows 的 ProxyServer 字段格式
 * 差得远，自己解析迟早出错。
 */
async function readSystemProxy() {
  const target = session.defaultSession;
  if (!target) return { ok: false, rules: '', detail: '当前没有可用的网络会话' };
  let raw = '';
  try {
    raw = await target.resolveProxy('https://raw.githubusercontent.com/');
  } catch (error) {
    return { ok: false, rules: '', detail: `读不到系统代理：${error.message}` };
  }
  // 形如 "PROXY 127.0.0.1:7890;DIRECT"、"SOCKS5 127.0.0.1:1080"、"DIRECT"
  const text = String(raw || '');
  const match = text.match(/(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^\s;]+)/i);
  if (!match) {
    return { ok: true, rules: '', direct: true, detail: '系统没有配置代理（当前是直连）' };
  }
  const scheme = match[1].toUpperCase();
  const host = match[2];
  const rules = scheme === 'SOCKS5' || scheme === 'SOCKS' ? `socks5://${host}` : `http://${host}`;
  return { ok: true, rules, direct: false, detail: `系统代理：${scheme} ${host}` };
}

/**
 * 实测一条代理规则通不通。
 *
 * 用独立的临时 session 发请求，绝不碰默认会话——用户点「测试」的时候，后台
 * 可能正在下载更新包，临时切代理会让那条下载直接断掉。
 *
 * 同时测 GitHub 和 Gitee：只测 GitHub 的话，「代理生效但 GitHub 本来就慢」
 * 和「代理根本没生效」看起来一模一样；两条结果放在一起才能判断问题在哪。
 */
const PROXY_PROBES = [
  {
    name: 'GitHub',
    url: 'https://raw.githubusercontent.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher/main/latest.json',
  },
  { name: 'Gitee', url: 'https://gitee.com/SparkleHxl/hxl-update/raw/master/latest.json' },
];

async function probeProxy(value) {
  const rules = normalizeProxyRules(value);
  const probeSession = session.fromPartition(`hxl-proxy-probe-${Date.now()}`, { cache: false });
  const results = [];
  try {
    if (rules) await probeSession.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
    else await probeSession.setProxy({ mode: 'direct' });
  } catch (error) {
    return { ok: false, rules, error: `代理规则无效：${error.message}`, results: [] };
  }
  try {
    for (const probe of PROXY_PROBES) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await probeSession.fetch(probe.url, {
          signal: controller.signal,
          headers: { 'cache-control': 'no-cache', accept: 'application/json,text/plain,*/*' },
        });
        results.push({
          name: probe.name,
          ok: response.ok,
          status: response.status,
          ms: Date.now() - started,
        });
        // 主动丢掉 body：探测只关心能不能连上，别把清单内容留在内存里
        try {
          await response.body?.cancel();
        } catch {
          /* 已经读完或没有 body */
        }
      } catch (error) {
        results.push({
          name: probe.name,
          ok: false,
          ms: Date.now() - started,
          error: error && error.name === 'AbortError' ? '超时（10 秒）' : String(error && error.message).slice(0, 120),
        });
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    try {
      probeSession.closeAllConnections();
    } catch {
      /* 关不掉也不影响主会话 */
    }
  }
  return { ok: results.some((item) => item.ok), rules, results };
}

function snapshot() {
  const data = store.data;
  return {
    games: data.games.map(publicGame),
    settings: data.settings,
    stats: data.stats,
    nteAccount: data.nteAccount || null,
    downloads: downloads ? downloads.list() : [],
    app: {
      version: APP_VERSION,
      platform: process.platform,
      isPackaged: app.isPackaged,
      userData: app.getPath('userData'),
      portable: Boolean(portableData),
      portableRoot: portableRoot || '',
      downloadDir: store?.data?.settings?.downloadDir || '',
      // 显卡加速不可用时渲染层默认不播启动页视频（见 file 顶部 softwareRendering 的说明）
      softwareRendering: softwareRendering(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    update: updateStatus,
    // 云备份的状态单独给一份：渲染层不用从 settings.gachaBackup 里拼，
    // 也能拿到 hasPassword / intervalDays 这些派生值
    gachaBackup: gachaBackupSnapshot(),
  };
}

function pushState(immediate = false) {
  if (!win || win.isDestroyed()) return;
  // 每次推状态前先自愈：盘符变了 / 运行时被清掉时自动切回还能用的服务器，
  // 避免启动页把「路径明明还在」的游戏显示成「检测安装」。
  ensureAllServers();
  if (immediate) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
    win.webContents.send('state:changed', snapshot());
    return;
  }
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('state:changed', snapshot());
  }, 120);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/*
 * 进度事件统一出口：补上速度、剩余时间、总百分比。
 *
 * 各个引擎（sophon / predownload / yostar / endfield-packs）自己报的字段只有
 * 「干了多少、总共多少」，速度得靠按时间采样算 —— 放在这里算而不是界面算，
 * 是因为节流点都在主进程，界面只能被动收事件，间隔一抖算出来的速度就乱跳。
 *
 * 每个 (频道, jobId) 一个计量器：不同任务的字节起点不同，混在一起会算出负数。
 * 计量器只保存最近 3 秒的采样，很轻；顺手限制一下 Map 大小防止长跑任务越攒越多。
 */
const progressMeters = new Map();
function sendProgress(channel, jobId, progress) {
  const key = `${channel}\u0000${jobId}`;
  let meter = progressMeters.get(key);
  if (!meter) {
    if (progressMeters.size > 32) {
      // 只留最近的：老任务已经结束，采样没有任何后续用途
      const oldest = progressMeters.keys().next();
      if (!oldest.done) progressMeters.delete(oldest.value);
    }
    meter = progressMeter.createMeter((event) => send(channel, event));
    progressMeters.set(key, meter);
  }
  meter({ jobId, ...progress });
}
function dropProgressMeter(channel, jobId) {
  progressMeters.delete(`${channel}\u0000${jobId}`);
}

function applyLoginItem(settings) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.launchAtLogin),
      path: process.execPath,
    });
  } catch (error) {
    console.warn('setLoginItemSettings failed:', error.message);
  }
}

function applyNativeTheme(theme) {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
}

/* ------------------------------------------------------------------ */
/* 界面缩放                                                             */
/* ------------------------------------------------------------------ */

/** 把百分比夹到可用区间，避免外部传入离谱数值把界面撑坏。 */
function normalizeUiScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 100;
  return Math.round(Math.max(80, Math.min(130, number)));
}

/** 当前实际生效的缩放系数；变更时按新旧系数的比例缩放窗口，避免累计放大。 */
let appliedUiFactor = 1;

/**
 * 按缩放比例放大/缩小整个窗口内容。
 * 用 setZoomFactor 而不是 CSS 变量：字号、间距、图标一起等比变化，
 * 不用逐条改几百处 px 字号。
 * 窗口尺寸按「当前尺寸 × 新旧系数比」同步调整，可见内容保持一样多，
 * 不会因为放大把右边或下面挤掉；启动页是固定尺寸的独立窗口，不跟着缩放。
 *
 * 启动路径不要走这里的尺寸调整：did-finish-load 里会先把 appliedUiFactor
 * 置成存档值（bounds 是上次退出时的物理尺寸，已含当时缩放），只补 zoom。
 */
function applyUiScale(scale) {
  const factor = normalizeUiScale(scale) / 100;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.setZoomFactor(factor);
  } catch (error) {
    console.warn('setZoomFactor failed:', error.message);
  }
  resizeWindowForScale(factor);
  appliedUiFactor = factor;
}

/**
 * 缩放时同步调整窗口尺寸：当前尺寸 × (新系数 / 旧系数)，夹在屏幕可用区域内。
 * 窗口最大化 / 全屏时不动，退出后下次缩放再调整。
 */
function resizeWindowForScale(factor) {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
  const previous = appliedUiFactor > 0 ? appliedUiFactor : 1;
  if (Math.abs(factor - previous) < 0.001) return;
  const current = win.getBounds();
  const ratio = factor / previous;
  const min = adaptiveMinSize(current);
  const wanted = {
    width: Math.round(current.width * ratio),
    height: Math.round(current.height * ratio),
  };
  try {
    const area = workAreaFor(current);
    wanted.width = Math.max(min.width, Math.min(wanted.width, area.width - 16));
    wanted.height = Math.max(min.height, Math.min(wanted.height, area.height - 16));
  } catch {
    /* 拿不到屏幕信息就按原尺寸来 */
  }
  try {
    win.setBounds({ x: current.x, y: current.y, width: wanted.width, height: wanted.height });
  } catch (error) {
    console.warn('setBounds failed:', error.message);
  }
}

/* ------------------------------------------------------------------ */
/* 多电脑环境适配：窗口尺寸 / 位置 / 最小尺寸                              */
/* ------------------------------------------------------------------ */

/** 主窗口基准尺寸：首启默认值。 */
const WINDOW_BASE_SIZE = { width: 1400, height: 880 };
/** 写死的最小尺寸（大屏够用）；小屏 / 高 DPI 屏由 adaptiveMinSize 收缩。 */
const WINDOW_MIN_SIZE = { width: 1060, height: 680 };
/** 屏幕再小也不低于这个值，纯粹是防呆。 */
const WINDOW_MIN_ABS = { width: 320, height: 240 };

/** 取能容纳某个矩形的工作区；匹配不到（屏拔了）就退主屏。 */
function workAreaFor(bounds) {
  try {
    const display = screen.getDisplayMatching({
      x: Number(bounds?.x) || 0,
      y: Number(bounds?.y) || 0,
      width: Number(bounds?.width) || WINDOW_BASE_SIZE.width,
      height: Number(bounds?.height) || WINDOW_BASE_SIZE.height,
    });
    return (display || screen.getPrimaryDisplay()).workArea;
  } catch {
    return screen.getPrimaryDisplay().workArea;
  }
}

/**
 * 按当前屏幕算窗口最小尺寸。
 *
 * 原来 minWidth/minHeight 写死 1060×680，在 Windows 125% 缩放的 1366×768
 * 笔记本上直接翻车：工作区折合 DIP 只有 1092×614，最小高 680 超出屏幕，
 * 窗口既没法缩小、也不会被任务栏让位，界面底下一条永远够不着。
 * 现在按工作区夹取：大屏照旧 1060×680，小屏缩到「工作区减 24px」。
 */
function adaptiveMinSize(bounds) {
  const area = workAreaFor(bounds);
  return {
    width: Math.max(WINDOW_MIN_ABS.width, Math.min(WINDOW_MIN_SIZE.width, area.width - 24)),
    height: Math.max(WINDOW_MIN_ABS.height, Math.min(WINDOW_MIN_SIZE.height, area.height - 24)),
  };
}

/**
 * 启动时的窗口 bounds：优先还原上次记住的位置/尺寸；
 * 超出当前屏幕（换了台电脑、拔了外接屏）就按工作区夹回来或居中。
 */
function initialWindowBounds() {
  const saved = store?.data?.window;
  let width = WINDOW_BASE_SIZE.width;
  let height = WINDOW_BASE_SIZE.height;
  let x = null;
  let y = null;
  if (saved && saved.width > 200 && saved.height > 200) {
    width = Math.round(saved.width);
    height = Math.round(saved.height);
    if (Number.isFinite(saved.x)) x = Math.round(saved.x);
    if (Number.isFinite(saved.y)) y = Math.round(saved.y);
  }
  const area = workAreaFor({ x, y, width, height });
  const min = adaptiveMinSize({ x, y, width, height });
  width = Math.max(min.width, Math.min(width, area.width - 16));
  height = Math.max(min.height, Math.min(height, area.height - 16));
  if (x === null || y === null) {
    // 没有记忆位置：主屏工作区里水平居中、垂直略偏上（视觉重心舒服些）
    x = Math.round(area.x + (area.width - width) / 2);
    y = Math.round(area.y + Math.max(0, (area.height - height) / 2 - 24));
  } else {
    // 有记忆位置：保证标题栏抓得到，不会整个卡到屏幕外
    x = Math.max(area.x - width + 120, Math.min(x, area.x + area.width - 120));
    y = Math.max(area.y, Math.min(y, area.y + area.height - 120));
  }
  return { width, height, x, y };
}

/** 换屏 / 改分辨率 / 改 DPI 时重算最小尺寸并把窗口收回可见区域（只绑一次）。 */
let displayMetricsWatching = false;
function watchDisplayMetrics() {
  if (displayMetricsWatching) return;
  displayMetricsWatching = true;
  screen.on('display-metrics-changed', () => {
    if (!win || win.isDestroyed()) return;
    try {
      const current = win.getBounds();
      const min = adaptiveMinSize(current);
      win.setMinimumSize(min.width, min.height);
      // 最大化 / 全屏时位置由系统管，不动
      if (win.isMaximized() || win.isFullScreen()) return;
      const area = workAreaFor(current);
      const next = {
        x: Math.max(area.x - current.width + 120, Math.min(current.x, area.x + area.width - 120)),
        y: Math.max(area.y, Math.min(current.y, area.y + area.height - 120)),
        width: Math.max(min.width, Math.min(current.width, area.width)),
        height: Math.max(min.height, Math.min(current.height, area.height)),
      };
      if (
        next.x !== current.x ||
        next.y !== current.y ||
        next.width !== current.width ||
        next.height !== current.height
      ) {
        win.setBounds(next);
      }
    } catch {
      /* 显示信息拿不到就保持原样 */
    }
  });
}

function applyTitlebar() {
  if (process.platform === 'win32') return;
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  const light = nativeTheme.shouldUseDarkColors === false;
  try {
    win.setTitleBarOverlay({
      color: light ? '#f6edde' : '#0b060b',
      symbolColor: light ? '#3a1a1c' : '#f0c674',
      height: 44,
    });
  } catch (error) {
    console.warn('setTitleBarOverlay failed:', error.message);
  }
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 520,
    height: 660,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#0b060b',
    title: '花筱灵启动器',
    icon: loadWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow.loadFile(path.join(ROOT, 'src', 'splash.html'));
  /*
   * 显示 splash 的唯一点做幂等封装，只记录一次 splashShownAt。
   * 只在 ready-to-show 里调用：Electron 的 ready-to-show 才是「页面完成首次渲染、
   * 合成器首帧已合成」的时刻。真机探针（_splash-probe/rts-main.js）实测：GPU 模式下
   * did-finish-load 那一刻 capturePage 报 UnknownVizError（首帧还没画出来），要到
   * ready-to-show 才 OK。以前在 did-finish-load 里也 show，GPU 慢/崩时窗口在立绘
   * 还没合成时就亮出来，用户看到的就是「图没加载出来」的空白启动页 —— 别再加回来。
   */
  const showSplash = () => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    if (!splashShownAt) {
      splashWindow.center();
      splashWindow.show();
      splashShownAt = Date.now();
    }
  };
  // 启动页版本号跟随 app.getVersion() 注入（splash.html 里那份只是兜底文案，
  // 之前硬编码 v2.4.0 一直没跟着升版，2026-10-31 用户指出）
  // 注意：这里只做 DOM 版本号注入，绝不 show 窗口 —— 显示必须等 ready-to-show。
  splashWindow.webContents.once('did-finish-load', () => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    splashWindow.webContents
      .executeJavaScript(
        `(function(){var el=document.getElementById('splash-version');if(el)el.textContent='VERSION v'+${JSON.stringify(app.getVersion())};})()`
      )
      .catch(() => {});
  });
  splashWindow.once('ready-to-show', () => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    showSplash();
    if (process.env.HX_SPLASH_SHOT === '1') {
      setTimeout(async () => {
        try {
          const image = await splashWindow.webContents.capturePage();
          const dir = path.join(ROOT, 'shots');
          await fsp.mkdir(dir, { recursive: true });
          await fsp.writeFile(path.join(dir, 'splash.png'), image.toPNG());
          console.log('captured splash');
        } catch (error) {
          console.error('splash capture failed:', error);
        }
        quitting = true;
        app.quit();
      }, 900);
    }
  });
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function createWindow() {
  // 启动尺寸/位置：还原上次记住的；超出的按当前屏夹取（适配每台电脑的屏幕）
  const bounds = initialWindowBounds();
  const minSize = adaptiveMinSize(bounds);
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: minSize.width,
    minHeight: minSize.height,
    show: false,
    backgroundColor: '#0b060b',
    title: '花筱灵启动器',
    icon: loadWindowIcon(),
    frame: process.platform === 'win32' ? false : true,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  // 上次退出时是最大化就还原（放在 show 之前，避免先还原再放大的闪烁）
  if (store?.data?.window?.maximized) win.maximize();

  /* 窗口位置/尺寸记忆：拖动、缩放、最大化、隐藏到托盘前都记，
     下次启动按 initialWindowBounds 还原。store 自身有 400ms 防抖。 */
  let boundsSaveTimer = null;
  const saveWindowBounds = (now = false) => {
    if (!win || win.isDestroyed() || !store?.data) return;
    try {
      const current = win.getBounds();
      store.data.window = {
        width: current.width,
        height: current.height,
        x: current.x,
        y: current.y,
        maximized: win.isMaximized(),
      };
      // now = true 用于真正关闭前：防抖可能来不及落盘
      if (now) store.saveNow().catch(() => {});
      else store.save();
    } catch {
      /* 记忆失败不影响使用 */
    }
  };
  const scheduleBoundsSave = () => {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => saveWindowBounds(false), 400);
  };
  win.on('move', scheduleBoundsSave);
  win.on('resize', scheduleBoundsSave);
  win.on('maximize', () => saveWindowBounds(false));
  win.on('unmaximize', () => saveWindowBounds(false));
  watchDisplayMetrics();

  win.loadFile(path.join(ROOT, 'src', 'index.html'));
  // 页面加载完再套缩放：loadFile 触发的导航会把提前设好的 zoomFactor 重置回 1
  win.webContents.on('did-finish-load', () => {
    // 启动路径只补 zoom：导航会把 zoomFactor 重置回 1，而窗口 bounds 是上次
    // 退出时的物理尺寸（已含当时缩放）。先把 appliedUiFactor 置成存档值，
    // applyUiScale 里的尺寸调整就会自动跳过，不会把窗口撑大一倍。
    appliedUiFactor = normalizeUiScale(store?.data?.settings?.uiScale ?? 100) / 100;
    applyUiScale(store?.data?.settings?.uiScale ?? 100);
    // 音乐服务预热：VIP 曲目的换源解锁全靠本地 NeteaseCloudMusicApi，
    // 开机就把它拉起来，用户点歌时不用干等（拉不起来就算了，不影响启动）。
    setTimeout(() => {
      // 注意：这里不能直接写 startNeteaseService(...)。
      // 实测（见 data/crash.log 的 uncaughtException）这个回调偶尔运行在一份
      // 重新求值的 main.js 闭包里，后段的函数声明绑定拿不到，会报
      // ReferenceError。定义处把预热闭包挂到了 globalThis 上（见
      // __hxlNeteaseWarmup），它的箭头函数在正确的作用域创建，从桥上调最稳。
      const warm = globalThis.__hxlNeteaseWarmup;
      if (typeof warm === 'function') warm();
    }, 3000);
    // 提权重启之后把刚才点的那款游戏接上：用户点「开始游戏」→ 弹一次 UAC →
    // 启动器以管理员重开 → 这里自动继续开，不用他再点第二次。
    setTimeout(() => resumePendingLaunch(), 1600);
    // 同理，因为权限不足被打断的更新也接着做：重启回来如果还挡着，
    // 预检会再报一次，至少不会出现「点了以管理员重启，回来什么都没有」。
    setTimeout(() => resumePendingUpdate(), 2000);
  });

  // 原生全屏不触发 CSS :fullscreen 伪类，只能由主进程把状态推给渲染进程
  const pushFullscreen = (value) => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('window:fullscreen', !!value);
    } catch (_) {}
  };
  win.on('enter-full-screen', () => pushFullscreen(true));
  win.on('leave-full-screen', () => pushFullscreen(false));
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => pushFullscreen(win && !win.isDestroyed() && win.isFullScreen()), 0);
  });

  // 最小化状态推给渲染层：据此停掉循环背景视频和装饰动画，别白烧 GPU
  // （backgroundThrottling 是 false，缩到任务栏后 CSS 动画和 video 解码照跑）。
  // minimizeOnLaunch 开机即最小化时补推一次当前状态。
  const pushMinimize = (value) => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('window:minimize-state', !!value);
    } catch (_) {}
  };
  win.on('minimize', () => pushMinimize(true));
  win.on('restore', () => pushMinimize(false));
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => pushMinimize(win && !win.isDestroyed() && win.isMinimized()), 0);
  });

  win.once('ready-to-show', () => {
    // 启动时恢复上次选的窗口材质（必须在窗口可见前设好，否则会闪一下不透明底）
    try {
      const savedMaterial = store?.data?.settings?.material || 'none';
      if (savedMaterial && savedMaterial !== 'none') {
        windowMaterial.applyMaterial(win, savedMaterial);
      }
    } catch (error) {
      console.warn('[material] 恢复失败:', error.message);
    }
    const reveal = () => {
      if (!win || win.isDestroyed()) return;
      win.show();
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents
          .executeJavaScript('document.body.classList.add("leaving")')
          .catch(() => {});
        const currentSplash = splashWindow;
        setTimeout(() => {
          if (currentSplash && !currentSplash.isDestroyed()) currentSplash.close();
        }, 300);
      }
      if (process.env.HX_CAPTURE === '1') {
        setTimeout(runCapture, 700);
      } else if (process.env.HX_PROBE === '1') {
        setTimeout(runLayoutProbe, 700);
      } else if (process.env.HX_SMOKE === '1') {
        setTimeout(() => {
          console.log('SMOKE_OK');
          quitting = true;
          app.quit();
        }, 2200);
      }
    };
    /*
     * 加载图「一闪就没」的根因：以前是「主窗 ready-to-show 后固定等 1050ms」，
     * 而 splash 的 show 在另一条事件链（ready-to-show）。GPU 首帧一慢，splash
     * 还藏在 show:false 就被加 leaving 关掉，用户只看到直接进主界面。
     * 现在改成等「splash 真的显示过 + 至少 1050ms」才放行；没建 splash（HX_CAPTURE）
     * 或它已被销毁则立即放行；2500ms 硬上限兜底，GPU 再慢也不会把启动挂死。
     */
    const started = Date.now();
    const waitForSplash = () => {
      const gone = !splashWindow || splashWindow.isDestroyed();
      const shownLongEnough = splashShownAt && Date.now() - splashShownAt >= 1050;
      const timedOut = Date.now() - started >= 2500;
      if (gone || shownLongEnough || timedOut) reveal();
      else setTimeout(waitForSplash, 50);
    };
    waitForSplash();
  });

  win.on('close', (event) => {
    // 真正关闭前立刻落盘（防抖可能来不及）；隐藏到托盘也记一份，位置可能刚变过
    saveWindowBounds(true);
    if (quitting || !store) return;
    const action = store.data.settings.closeAction;
    /*
     * tray 要真的存在才敢 hide：托盘图标没装上（图标缺失 / 系统托盘不可用）时
     * 把窗口藏起来，用户就再也叫不回来了。那种情况下按「退出」处理更安全。
     */
    if (action === 'tray' && tray) {
      event.preventDefault();
      win.hide();
      return;
    }
    if (action === 'quit' || action === 'tray') return;
    /*
     * 还没选过（首次点关闭）：先别关，问一句「收进托盘还是退出」。
     * 选择存在 settings.closeAction 里，之后都按它执行；
     * 想改去 设置 → 行为 → 关闭时收进托盘。
     *
     * 渲染层可能还没加载完（启动早期被系统关掉、页面崩了），这时候没人接
     * 这个询问，拦着就等于关不掉窗口 —— 那就直接放行。
     */
    const wc = win.webContents;
    if (!wc || wc.isDestroyed() || wc.isLoading()) return;
    event.preventDefault();
    if (closeAskPending) return;
    closeAskPending = true;
    wc.send('window:close-ask');
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  return win;
}

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function installTray() {
  try {
    /* 托盘只能显式给图（不会用 exe 图标），用预先缩好并锐化过的 16×16，
       不要再 resize —— 从 256 缩到 16 会把五官糊平，看不出是花筱灵。 */
    const image = fs.existsSync(ICON_TRAY) ? loadIconImage(ICON_TRAY) : loadIconImage(ICON);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip('花筱灵启动器');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开花筱灵启动器', click: showWindow },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ])
    );
    tray.on('double-click', showWindow);
  } catch (error) {
    console.warn('Tray init failed:', error.message);
  }
}

function splitArgs(input) {
  const text = String(input || '');
  const args = [];
  let current = '';
  let quote = null;
  let hasContent = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && text[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        current += ch;
      }
      hasContent = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true;
    } else if (/\s/.test(ch)) {
      if (hasContent) {
        args.push(current);
        current = '';
        hasContent = false;
      }
    } else {
      current += ch;
      hasContent = true;
    }
  }
  if (hasContent) args.push(current);
  return args;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLaunchLog(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'launch.log'), line, 'utf8');
  } catch {
    /* ignore */
  }
}

async function findProcessPid(exeName) {
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        'tasklist.exe',
        ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 5000 },
        (error, output, stderr) => {
          if (error) reject(new Error(stderr || error.message));
          else resolve(output);
        }
      );
    });
    for (const line of String(stdout).split(/\r?\n/)) {
      const match = line.match(/^"([^"]+)","(\d+)"/);
      if (match && match[1].toLowerCase() === exeName.toLowerCase()) {
        return Number(match[2]);
      }
    }
  } catch {
    /* process lookup is best-effort */
  }
  return null;
}

function clearProcessMonitor(id) {
  const timer = processMonitors.get(id);
  if (timer) {
    clearInterval(timer);
    processMonitors.delete(id);
  }
}

/**
 * 清理「卡住的运行状态」。
 *
 * 之前只要 running / launching 里还留着这个游戏，界面就一直说「游戏在运行」，
 * 点「打开游戏」当场被挡回去，用户看到的就是「点了没反应」。
 * 而 running 里记的 pid 可能早就退出了（游戏自己崩了、被任务管理器结束、
 * 或者上一次启动其实没成功）。这里用 pid 探活兜底，pid 不在了就把状态清掉。
 */
async function pruneStaleRunning() {
  if (!running.size && !launching.size) return false;
  let changed = false;
  // 启动超过 5 分钟还没落到 running 里，说明这一步已经死掉了（UAC 超时、启动器被杀…）。
  const launchStaleMs = 5 * 60 * 1000;
  for (const [id, startedAt] of [...launching.entries()]) {
    if (Date.now() - (Number(startedAt) || 0) < launchStaleMs) continue;
    launching.delete(id);
    changed = true;
    writeLaunchLog(`launching: ${id} 启动状态已超过 5 分钟，清除`);
  }
  for (const [id, info] of [...running.entries()]) {
    const pid = Number(info && info.pid) || 0;
    let alive = false;
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        // EPERM 说明进程还在（只是没权限查），ESRCH 才是真的没了
        alive = error && error.code === 'EPERM';
      }
    }
    if (!alive) {
      clearProcessMonitor(id);
      running.delete(id);
      changed = true;
      writeLaunchLog(`running: ${id} pid=${pid} 已不存在，清除卡住的运行状态`);
    }
  }
  return changed;
}

async function trackGameProcess(id, exeName, startedAt, attempts = 8) {
  let pid = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    pid = await findProcessPid(exeName);
    if (pid) break;
    await delay(1200);
  }
  launching.delete(id);
  if (!pid) {
    writeLaunchLog(`launch ${id}: process ${exeName} not detected after ${attempts * 1.2}s`);
    return;
  }
  if (running.has(id)) return;
  running.set(id, { pid, startedAt: startedAt || Date.now() });
  writeLaunchLog(`launch ${id}: pid=${pid} exe=${exeName}`);
  pushState(true);
  clearProcessMonitor(id);
  /*
   * 按具体 pid 探活，而不是按进程名。
   * 异环走官方启动器时，游戏窗口关掉后官方启动器还会留一个同名 HTGame.exe
   * 残留子进程，按名字找永远找得到，计时就停不下来（要关掉官方启动器才停）。
   * 认住启动时抓到的那个 pid，它退出才算本局结束。
   */
  const timer = setInterval(async () => {
    if (!running.has(id)) {
      clearProcessMonitor(id);
      return;
    }
    const knownPid = Number(running.get(id)?.pid) || 0;
    const alive = knownPid > 0 ? await isPidAlive(knownPid) : false;
    if (!alive) {
      writeLaunchLog(`launch ${id}: pid=${knownPid} 已退出，结束计时`);
      clearProcessMonitor(id);
      await finishGame(id);
    }
  }, 3000);
  processMonitors.set(id, timer);
}

/** 用 tasklist 按 pid 精确探活；查不到（进程没了）返回 false，查询本身出错按 false 处理。 */
async function isPidAlive(pid) {
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        'tasklist.exe',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 5000 },
        (error, output, stderr) => {
          if (error) reject(new Error(stderr || error.message));
          else resolve(output);
        }
      );
    });
    return String(stdout).includes(`","${pid}"`);
  } catch {
    return false;
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// 探活一次就记住：isElevated() 要起一个 powershell，不能每次点启动都来一遍。
let elevatedCache = null;

function currentElevation() {
  if (elevatedCache === null) elevatedCache = isElevated();
  return elevatedCache;
}

/** 本机 powershell.exe 绝对路径：PATH 被安全软件/定制系统改坏的机器上，
 * 裸写 'powershell.exe' 会 ENOENT，提权链整条瘫痪，所以直接按 SystemRoot 定位。 */
function powershellExe() {
  const candidate = path.join(
    process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* fall through */
  }
  return 'powershell.exe';
}

function isElevated() {
  try {
    const output = execFileSync(
      powershellExe(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    return /true/i.test(output);
  } catch {
    return false;
  }
}

/**
 * 以管理员身份重启自己。
 *
 * 有两个坑必须一起处理：
 *  1. 单实例锁：新进程一启动就去抢锁，旧进程还没退干净的话新进程会直接 quit，
 *     用户看到的就是「点了以管理员身份重启，然后什么都没有」。
 *     所以让提权进程先睡一会儿，等当前实例把锁放掉。
 *  2. 用户点了 UAC 的「否」：Start-Process -Verb RunAs 会抛异常，
 *     这时候旧进程已经退出了——启动器就这么消失了。
 *     所以捕获失败后用 --no-elevate 参数把非管理员实例拉回来，
 *     避免「取消一次授权 → 启动器没了 → 再打开又弹授权」的死循环。
 */
function spawnElevatedSelf() {
  /*
   * 优先用项目自带的 elevate.exe（resources/elevate.exe，Johannes Passing 的 Elevate）弹 UAC
   * 并以管理员拉起自身。关键：通过 argv 传路径（不是 PowerShell -Command 字符串），
   * 彻底规避「中文路径（H:\花筱灵启动器\）在 PowerShell -Command 里编码乱码 →
   * Start-Process 找不到 exe → 新实例起不来 → 旧实例已退 → 启动器消失」这个本机实锤的坑。
   * elevate.exe 不存在才退回 PowerShell RunAs（仅兜底，带中文路径风险）。
   */
  const elevateExe = path.join(process.resourcesPath, 'elevate.exe');
  const selfExe = process.execPath;
  if (fs.existsSync(elevateExe)) {
    writeLaunchLog(`alwaysAdmin: 用 elevate.exe 提权（${elevateExe}）`);
    return spawn(elevateExe, [selfExe], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  writeLaunchLog('alwaysAdmin: elevate.exe 缺失，退回 PowerShell RunAs');
  const script = `Start-Process -FilePath ${psQuote(selfExe)} -Verb RunAs -ArgumentList '--no-elevate' -Wait`;
  return spawn(powershellExe(), ['-NoProfile', '-Command', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function relaunchElevated() {
  if (!app.isPackaged) return false;
  const elevateExe = path.join(process.resourcesPath, 'elevate.exe');
  const selfExe = process.execPath;
  const useElevate = fs.existsSync(elevateExe);
  writeLaunchLog(`alwaysAdmin: 调度提权重启（elevate=${useElevate}，旧实例pid=${process.pid}）`);
  try {
    const child = spawnElevatedSelf();
    /*
     * 消失保险：提权进程退出且非成功码（UAC 拒绝 / elevate 失败）→ 立刻兜底起一个
     * --no-elevate 普通实例。这样无论本机 UAC 什么状态，启动器都不会「点了就没了」。
     */
    child.on('close', (code) => {
      if (code !== 0) {
        writeLaunchLog(`alwaysAdmin: 提权未成功（code=${code}），兜底以普通权限重新打开`);
        try {
          const fb = spawn(selfExe, ['--no-elevate'], { detached: true, stdio: 'ignore', windowsHide: true });
          fb.unref();
        } catch (e) {
          writeLaunchLog(`alwaysAdmin: 兜底普通实例启动失败: ${e.message}`);
        }
      }
    });
    const settled = await new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      child.on('error', () => {
        writeLaunchLog('alwaysAdmin: 提权进程启动失败（命令未执行），继续普通权限');
        finish(false);
      });
      child.on('spawn', () => { child.unref(); finish(true); });
      setTimeout(() => finish(false), 6000);
    });
    if (!settled) {
      writeLaunchLog('alwaysAdmin: 提权进程未能启动，继续以普通权限运行');
      return false;
    }
    // 提权进程已拉起 → 旧实例退出，让新实例（管理员或兜底普通）抢锁接管
    setTimeout(() => { quitting = true; app.quit(); }, 800);
    return true;
  } catch (error) {
    writeLaunchLog(`alwaysAdmin: 提权重启调度失败，继续以普通权限运行: ${error.message}`);
    return false;
  }
}

/**
 * 提权重启之后，把刚才点的那款游戏接着开起来。
 *
 * 为什么要这一步：终末地 / 明日方舟创建游戏进程必须提权（实测 740）。以前
 * 每点一次「开始游戏」弹一次 UAC；现在第一次问一次、之后启动器自己以管理员
 * 运行。重启过程中那一次点击要接上 —— 否则重启完还得再点一次，用户会以为
 * 点了个寂寞。
 */
async function resumePendingLaunch() {
  const gameId = String(store?.data?.settings?.pendingLaunchGameId || '');
  if (!gameId) return;
  store.data.settings.pendingLaunchGameId = '';
  await store.saveNow().catch(() => {});
  /*
   * 不再静默丢弃：提权失败 / UAC 点否 / 游戏列表比定时器晚加载，
   * 之前都会让「重启后自动续开游戏」悄悄失效。现在照发；列表未就绪时 1500ms 补发一次。
   */
  const fire = () => send('game:autolaunch', { gameId });
  if ((store.data.games || []).some((item) => item.id === gameId)) {
    fire();
  } else {
    setTimeout(fire, 1500);
  }
}

/**
 * 提权重启之后，把「刚才没做完的更新」接着做。
 *
 * 和 resumePendingLaunch 分开：那条是「开游戏」，这条是「继续更新」。
 * 更新是长任务，被权限挡住时下载可能还没开始，重启回来直接重跑一次更新最省事；
 * 已经下好的分块 / 补丁包会被 hasCache 命中，不会重下。
 */
async function resumePendingUpdate() {
  const gameId = String(store?.data?.settings?.pendingUpdateGameId || '');
  if (!gameId) return;
  const serverId = String(store?.data?.settings?.pendingUpdateServerId || '');
  store.data.settings.pendingUpdateGameId = '';
  store.data.settings.pendingUpdateServerId = '';
  await store.saveNow().catch(() => {});
  const fire = () => send('update:resume', { gameId, serverId });
  if ((store.data.games || []).some((item) => item.id === gameId)) {
    fire();
  } else {
    setTimeout(fire, 1500);
  }
}

function startWithShellExecute(target, args, cwd) {
  return new Promise((resolve) => {
    const argList = args.length ? ` -ArgumentList @(${args.map(psQuote).join(',')})` : '';
    const workDir = cwd ? ` -WorkingDirectory ${psQuote(cwd)}` : '';
    const script = [
      "$ErrorActionPreference='Stop'",
      `$p = Start-Process -FilePath ${psQuote(target)}${argList}${workDir} -PassThru`,
      'if ($p) { [Console]::Out.Write($p.Id) }',
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 20000 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: String(stderr || error.message).trim() });
          return;
        }
        const parsed = Number(String(stdout).trim().split(/\s+/).pop());
        resolve({ ok: true, pid: Number.isFinite(parsed) && parsed > 0 ? parsed : null });
      }
    );
  });
}

function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\.+$/g, '')
    .trim();
  return cleaned || '未命名文件';
}

function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

async function ensureDownloadsDir() {
  const fallback = path.join(resolvePortableRoot(), '花筱灵下载');
  let dir = String(store.data.settings.downloadDir || '').trim();
  /*
   * 目录建不出来（指向了别的机器 / 别的用户的路径，或没有写权限）时退回启动器自身文件夹。
   * 原来这里只做 mkdir，失败就抛，结果「打开下载文件夹」点了没反应，
   * 用户完全不知道文件下到哪里去了。
   */
  if (!dir || !canWrite(dir)) {
    if (dir && dir !== fallback) {
      console.warn(`下载目录不可用，已回退到启动器目录：${dir}`);
    }
    dir = fallback;
    store.data.settings.downloadDir = dir;
  }
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function installShotProtocol() {
  /*
   * 图片本体走自定义协议，而不是 file:// 或把 base64 塞进 JSON：
   * - file:// 在 sandbox + contextIsolation 下会被拦；
   * - base64 一张 4K 截图就是十几 MB，列表会卡死。
   * 只允许「扫描结果里出现过的路径」，用白名单堵住任意文件读取。
   */
  protocol.handle('hxl-shot', async (request) => {
    try {
      const url = new URL(request.url);
      const target = decodeURIComponent(url.searchParams.get('p') || '');
      if (!target) return new Response('missing path', { status: 400 });
      const allowed = screenshotAllow.has(path.normalize(target.toLowerCase()));
      if (!allowed) return new Response('forbidden', { status: 403 });
      // net.fetch 读 file:// 会按扩展名带上 Content-Type，图片能直接给 <img> 用
      return net.fetch(pathToFileURL(target).toString());
    } catch (error) {
      return new Response(String(error.message || 'error'), { status: 500 });
    }
  });
}

function installIpc() {
  ipcMain.handle('app:info', () => snapshot().app);

  /* ---------------- 文件管理：分类统计 + 按类清理 ---------------- */

  /*
   * 只统计 userData 里明确列出的目录（见 file-manager.js 的 GROUPS），
   * 不扫游戏本体、不碰存档。bundleCovers 传给清理逻辑，是为了让「随包内置的封面」
   * 永远进不了待删列表。
   */
  const storageOptions = () => ({
    bundleCovers: path.join(app.getAppPath(), 'data', 'covers'),
  });

  /*
   * 清掉动态背景缓存之后，游戏里存的 backgroundVideo 还指着已经不存在的文件。
   * 界面只看这个字段判「有没有视频可切」，于是会显示成「可切视频」但点开是黑的，
   * 看起来像功能坏了（2026-11-01 实际发生过一次，用户以为动态背景丢了）。
   * 这里把失效引用清空，回落到静态版本图；下次打开该游戏时按需重新缓存视频。
   */
  const repairMissingBackgrounds = (games) => {
    const userData = app.getPath('userData');
    let changed = 0;
    for (const game of Array.isArray(games) ? games : []) {
      const rel = String(game?.backgroundVideo || '');
      if (!rel || /^(?:https?:|file:|data:)/i.test(rel)) continue;
      if (fs.existsSync(path.join(userData, rel))) continue;
      game.backgroundVideo = '';
      if (game.startMotion === 'video') game.startMotion = 'pan';
      changed += 1;
    }
    return changed;
  };

  ipcMain.handle('fs:usage', () =>
    describeStorage(app.getPath('userData'), store?.data?.games || [], storageOptions())
  );
  ipcMain.handle('fs:clean', async (_event, input = {}) => {
    const id = String(input.id || '');
    const userData = app.getPath('userData');
    const games = store?.data?.games || [];
    if (id === 'all') {
      const result = await cleanSafe(userData, games, storageOptions());
      console.log(`[文件管理] 一键清理释放 ${(result.freed / 1048576).toFixed(1)}MB`);
      if (repairMissingBackgrounds(games)) {
        await store.saveNow();
        pushState(true);
      }
      return result;
    }
    const result = await cleanGroup(userData, games, id, storageOptions());
    console.log(`[文件管理] ${id} 释放 ${(result.freed / 1048576).toFixed(1)}MB`);
    if (id === 'backgrounds' && repairMissingBackgrounds(games)) {
      await store.saveNow();
      pushState(true);
    }
    return result;
  });

  /* ---------------- 米游社 / HoYoLAB 登录 ---------------- */

  /*
   * 打开米游社让用户自己登录。
   * 这里刻意不把 cookie 暴露给渲染层的任意代码：
   * 只有登录窗口自己会读到 cookie，渲染层拿到的只是角色列表。
   */
  ipcMain.handle('hoyolab:login', async (_event, input = {}) => {
    const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
    const provider = miyoushe.PROVIDERS[providerId];
    const targetGame = gameFeatures.normalizeKey(input.game || 'genshin');
    const url = provider.site?.[targetGame] || provider.home;

    const ses = session.fromPartition(`persist:hoyolab-${providerId}`);

    /*
     * 「添加账号」时先把登录窗口的会话清干净。
     *
     * 登录窗口和已保存的账号是两个东西：已登录的 cookie 存在 safeStorage 里，
     * 而窗口这个 persist 分区里还留着上一次的登录态。不清的话，点「添加账号」
     * 打开米游社就直接是已登录的旧账号，轮询立刻把同一个账号再存一遍 ——
     * 用户永远加不上第二个通行证。
     */
    if (input.addAccount) {
      try {
        await ses.clearStorageData({
          storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
        });
      } catch {}
    }

    return new Promise((resolve) => {
      let settled = false;
      /** 是否已经注过「自动点头像」脚本（只注一次，见下面的注释）。 */
      let dialogInjected = false;
      /** 上次注入的时间，用于挡住站点自己在 1 秒内重复刷新。 */
      let dialogInjectedAt = 0;
      /** 最近一次 cookie 校验失败的原因，超时后一起报给用户。 */
      let lastVerifyReason = '';
      const DIALOG_INJECT_COOLDOWN = 1200;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        try {
          if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
        } catch {}
        resolve(payload);
      };

      const loginWindow = new BrowserWindow({
        width: 1080,
        height: 800,
        parent: win && !win.isDestroyed() ? win : undefined,
        modal: false,
        show: true,
        title: `登录${provider.label}`,
        autoHideMenuBar: true,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      loginWindow.setMenuBarVisibility(false);
      loginWindow.webContents.setUserAgent(miyoushe.UA);

      /*
       * 只注一次，而且只认主文档加载完成。
       *
       * 这里踩过的坑：以前每收到 did-finish-load / did-navigate 就注一次，
       * 而米游社是 SPA——首屏就会触发两次 did-navigate-in-page，登录框本身又是跨域 iframe，
       * 它每次重建都会再带回一个加载事件 → 再注一次 → 再点头像 → iframe 再重建。
       * 实测 18 秒里 iframe 被重建了 100 多次，页面上永远是转圈，
       * 用户既输入不了也扫不了码（就是「登录框一直弹出」那个症状）。
       *
       * 现在的约束：
       * - 只挂 did-frame-finish-load（只认主框架）和 did-stop-loading，且注入幂等；
       * - 注入的脚本自己带幂等锁，同一个文档里最多点一次头像；
       * - 1.2 秒内的重复完成加载不再注入，避免站点自己刷新时把弹窗关掉重开。
       */
      const injectDialog = (why) => {
        if (!provider.openDialogScript) return;
        if (dialogInjected) return;
        if (dialogInjectedAt && Date.now() - dialogInjectedAt < DIALOG_INJECT_COOLDOWN) return;
        dialogInjected = true;
        dialogInjectedAt = Date.now();
        loginWindow.webContents.executeJavaScript(provider.openDialogScript, true).catch(() => {});
        if (process.env.HXL_LOGIN_DEBUG) console.log(`[login] inject openDialogScript via ${why}`);
      };

      /*
       * 只认主框架完成加载，子框架（比如登录框那个跨域 iframe）的加载一律不理。
       * 这是上面那段死循环的真正入口：以前 iframe 每重建一次就会重新注入一次脚本。
       */
      loginWindow.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
        if (isMainFrame) injectDialog('did-frame-finish-load');
      });
      loginWindow.webContents.on('did-stop-loading', () => injectDialog('did-stop-loading'));

      /*
       * 主框架换页（登录成功后往回跳、或站点自己刷新）时解锁一次，
       * 这样新文档里还能再点一次头像；子框架导航不触发这条。
       */
      loginWindow.webContents.on('did-navigate', () => {
        dialogInjected = false;
      });

      loginWindow.on('closed', () => {
        finish({ ok: false, cancelled: true, reason: '已取消登录' });
      });

      loginWindow.loadURL(url).catch(() => {});

      /*
       * 轮询 cookie：用户一登录成功，米游社就会种下登录 cookie，
       * 我们这边立刻收工，不需要用户手动点「完成」。
       *
       * 注意 get({}) 拿到的 cookie 是全站点的，米游社会把 cookie_token_v2 等
       * 同时写在 user.miyoushe.com / passport.miyoushe.com 多个子域上，
       * filterCookies 会按「域名 + 名字」保留，拼请求头时这些都带上。
       */
      const poll = setInterval(async () => {
        if (settled || !loginWindow || loginWindow.isDestroyed()) return;
        try {
          const all = await ses.cookies.get({});
          const picked = miyoushe.filterCookies(all, provider.cookieDomains);
          if (!miyoushe.hasLoginCookie(picked)) return;
          const cookieStr = miyoushe.cookieHeader(picked);
          const result = await miyoushe.verifyCookie(cookieStr, providerId);
          if (!result.ok) {
            /*
             * 有 cookie 但接口说无效：这通常是站点还没把 cookie 写全
             * （扫码刚完成的那一两秒），或者账号确实已失效。
             * 不要立刻放弃，记住原因继续轮询，超时后再报给用户。
             */
            lastVerifyReason = result.reason || '';
            return;
          }
          /*
           * 存成账号列表：同一个通行证账号重新登录就覆盖那一条，
           * 不同账号则新增，并把新登录的这个设为当前账号。
           */
          const store = await readHoyolabStore(providerId);
          const accountId = hoyolabAccountId(cookieStr) || `a${Date.now().toString(36)}`;
          const account = {
            id: accountId,
            cookie: cookieStr,
            savedAt: Date.now(),
            roles: result.roles || [],
            label: '',
          };
          const index = store.accounts.findIndex((item) => item.id === accountId);
          if (index >= 0) store.accounts[index] = account;
          else store.accounts.push(account);
          store.activeId = accountId;
          await writeHoyolabStore(providerId, store);
          finish({
            ok: true,
            provider: providerId,
            roles: result.roles,
            accountId,
            activeId: accountId,
            accounts: store.accounts.map(publicHoyolabAccount),
          });
        } catch (error) {
          lastVerifyReason = String(error?.message || error);
          // 网络抖动就下一轮再试
        }
      }, 1200);

      const timeout = setTimeout(() => {
        finish({
          ok: false,
          cancelled: true,
          reason: lastVerifyReason
            ? `登录超时（5 分钟）：${lastVerifyReason}`
            : '登录超时（5 分钟）：没有读到米游社的登录 cookie，请确认扫码后页面显示已登录',
        });
      }, 5 * 60 * 1000);
    });
  });

  /*
   * 登录状态查询。
   *
   * 多账号之后这里返回的是「账号列表 + 当前账号的角色」：
   * 只验证当前激活的那一个账号（verifyCookie 一轮就是四个 gameBiz 请求，
   * 账号一多会明显拖慢启动），其它账号直接用上次缓存的角色列表。
   */
  ipcMain.handle('hoyolab:status', async (_event, input = {}) => {
    const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
    let store;
    try {
      store = await readHoyolabStore(providerId);
    } catch (error) {
      return { ok: true, loggedIn: false, roles: [], accounts: [], activeId: '', reason: '登录状态损坏，请重新登录' };
    }
    const accounts = store.accounts.map(publicHoyolabAccount);
    if (!store.accounts.length) {
      return { ok: true, loggedIn: false, roles: [], accounts: [], activeId: '' };
    }

    const account = pickHoyolabAccount(store, input.accountId) || store.accounts[0];
    const verify = await verifyHoyolabAccount(account, providerId);
    if (verify.ok) {
      // 角色列表刷新过就顺手写回去，下次启动不用再查
      try {
        await writeHoyolabStore(providerId, store);
      } catch {}
    }
    return {
      ok: true,
      loggedIn: verify.ok,
      roles: verify.ok ? verify.roles : account.roles || [],
      accounts: store.accounts.map(publicHoyolabAccount),
      activeId: account.id,
      savedAt: account.savedAt || 0,
      reason: verify.ok ? '' : verify.reason || '',
    };
  });

  /*
   * 切换当前账号。
   * 只改 activeId，不重新登录；角色列表跟着新账号走。
   */
  ipcMain.handle('hoyolab:switch', async (_event, input = {}) => {
    const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
    const store = await readHoyolabStore(providerId);
    const account = pickHoyolabAccount(store, input.accountId);
    if (!account) return { ok: false, reason: '还没有登录米游社', accounts: [], activeId: '', roles: [] };
    store.activeId = account.id;
    const verify = await verifyHoyolabAccount(account, providerId);
    try {
      await writeHoyolabStore(providerId, store);
    } catch {}
    return {
      ok: true,
      loggedIn: verify.ok,
      roles: verify.ok ? verify.roles : account.roles || [],
      accounts: store.accounts.map(publicHoyolabAccount),
      activeId: account.id,
      reason: verify.ok ? '' : verify.reason || '',
    };
  });

  /*
   * 退出登录。
   *   { provider, id } —— 只移除这一个账号（删的是当前账号就自动切到第一个）
   *   { provider }     —— 移除全部账号并清掉登录窗口的 cookie
   */
  ipcMain.handle('hoyolab:logout', async (_event, input = {}) => {
    const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
    const removeId = String(input.id || '');
    const store = await readHoyolabStore(providerId);

    if (removeId && store.accounts.some((account) => account.id === removeId)) {
      store.accounts = store.accounts.filter((account) => account.id !== removeId);
      if (store.activeId === removeId) store.activeId = store.accounts[0]?.id || '';
      await writeHoyolabStore(providerId, store);
      // 只有全删光了才清 cookie 分区，否则会顺手把别的账号也一起踢掉
      if (!store.accounts.length) {
        try {
          const ses = session.fromPartition(`persist:hoyolab-${providerId}`);
          await ses.clearStorageData({ storages: ['cookies'] });
        } catch {}
      }
      return {
        ok: true,
        removedId: removeId,
        accounts: store.accounts.map(publicHoyolabAccount),
        activeId: store.activeId,
      };
    }

    await saveSecret(`hoyolab-${providerId}`, '');
    try {
      const ses = session.fromPartition(`persist:hoyolab-${providerId}`);
      await ses.clearStorageData({ storages: ['cookies'] });
    } catch {}
    return { ok: true, accounts: [], activeId: '' };
  });

  /*
   * 战绩数据（每日便笺 / 深渊 / 剧场…）。
   * 接口路径由能力注册表（game-features.js 的 TRAITS）给出，这里只负责：
   * 补 cookie、拼查询参数、补 DS2、选对宿主与 Referer。
   *
   * 两种入参，都保留：
   *   { provider, api }                        —— 旧用法：直接给相对路径
   *   { provider, game, feature, uid, region } —— 新用法：路径和参数都从 TRAITS 来
   *
   * 新用法里 uid/region 由渲染层从角色列表带过来。放在渲染层是因为
   * hoyolab:status 本来就会把角色列表返回给前端，前端已经在展示它；
   * 如果这里再查一遍 passport，每点一次卡片就多四次网络请求。
   */
  ipcMain.handle('hoyolab:record', async (_event, input = {}) => {
    const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
    const store = await readHoyolabStore(providerId);
    if (!store.accounts.length) {
      return { ok: false, error: '还没有登录米游社，请先在工具页点「登录」', retcode: null, url: '', debug: null };
    }
    /*
     * 战绩归属于某个具体的通行证账号：按 accountId 取，没指定就用当前激活的那个。
     * 这一步必须在拼接口之前定下来 —— 不同账号的 uid 不能混着查。
     */
    const account = pickHoyolabAccount(store, input.accountId);
    if (!account) {
      return { ok: false, error: '没有找到这个米游社账号，请重新登录', retcode: null, url: '', debug: null };
    }
    const saved = account;

    const provider = gameFeatures.LOGIN_PROVIDERS[providerId] || gameFeatures.LOGIN_PROVIDERS.miyoushe;
    let api = String(input.api || '');
    let referer = '';
    let withDs = true;

    if (input.game && input.feature) {
      const trait = gameFeatures.traitOf(input.game, input.feature);
      if (!trait || trait.kind !== 'game-record') {
        throw new Error('这个功能不在战绩接口的支持范围内');
      }
      /*
       * 留一个「接口已下线」的出口：trait 上写了 unavailable 就直接回一句人话。
       * 这里 return 而不是 throw —— throw 穿过 IPC 会变
       * 「Error invoking remote method ...」，界面上就是一句没法读的错误。
       * （原来绝区零的临界推演走的是这条，后来整条功能被删掉了，出口留着备用。）
       */
      if (trait.unavailable) {
        return { ok: false, error: String(trait.unavailable), retcode: null, url: '', debug: null };
      }
      const uid = String(input.uid || '').trim();
      const region = String(input.region || '').trim();
      if (!uid || !region) {
        throw new Error('没有读到这个游戏的角色，请先在工具页重新登录一次');
      }
      // schedule_type：1 当期，2 上期。只有深渊类接口模板里带 {schedule}
      const schedule = Number(input.schedule) === 2 ? 2 : 1;
      api = String(trait.api)
        .replace(/\{server\}/g, encodeURIComponent(region))
        .replace(/\{role_id\}/g, encodeURIComponent(uid))
        .replace(/\{region\}/g, encodeURIComponent(region))
        .replace(/\{uid\}/g, encodeURIComponent(uid))
        .replace(/\{schedule\}/g, String(schedule));
      if (/\{[a-z_]+\}/.test(api)) {
        throw new Error(`接口模板里还有没替换的参数：${api}`);
      }
      const baseKey = trait.host === 'act' ? 'act' : 'record';
      const base = provider.api && provider.api[baseKey];
      if (!base) {
        throw new Error('当前登录通道没有接入这个功能（国际服暂未接入战绩查询）');
      }
      api = `${base}${api}`;
      referer = trait.referer === 'act' ? provider.api.refererAct : provider.api.refererRecord;
      withDs = trait.ds !== false;
    } else {
      if (!api.startsWith('/')) throw new Error('接口路径不合法');
      referer = input.referer === 'act' ? provider.api.refererAct : provider.api.refererRecord;
    }

    /*
     * 排查用的请求头矩阵：同一个地址依次换几种头组合打一遍，
     * 把每个组合的 retcode 一起带回去。5003 这类风控错误光看一句话
     * 根本判断不出是哪个头被拒，只能这样 A/B。
     */
    if (input.probe) {
      const variants = [
        { name: 'A 现状（全部头 + DS2）', opts: {} },
        { name: 'B 全部头、不带 DS2', opts: { ds: false } },
        { name: 'C 去掉 X-Requested-With + DS2', opts: { withXrw: false } },
        { name: 'D 去掉 X-Requested-With、不带 DS2', opts: { withXrw: false, ds: false } },
        { name: 'E 去掉 XRW + Origin + DS2', opts: { withXrw: false, origin: 'https://webstatic.mihoyo.com' } },
        { name: 'F 固定指纹 0000000000000 + DS2', opts: { deviceFp: '0000000000000' } },
        { name: 'G client_type=2 + DS2', opts: { clientType: '2' } },
        { name: 'H 桌面 UA + DS2', opts: { ua: miyoushe.UA } },
      ];
      const results = [];
      for (const variant of variants) {
        try {
          const data = await miyoushe.fetchRecord(api, saved.cookie, providerId, {
            referer,
            ds: withDs && variant.opts.ds !== false,
            ...variant.opts,
          });
          results.push({
            name: variant.name,
            ok: true,
            keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 6) : [],
          });
        } catch (error) {
          results.push({
            name: variant.name,
            ok: false,
            retcode: error.retcode === undefined ? null : error.retcode,
            message: error.message || String(error),
          });
        }
      }
      return { ok: true, probe: results, url: api, deviceFp: await miyoushe.ensureDeviceFp(saved.cookie) };
    }

    try {
      const data = await miyoushe.fetchRecord(api, saved.cookie, providerId, { referer, ds: withDs });
      // url 一起带回去，出问题时能直接在控制台看到实际请求了什么
      return { ok: true, data, url: api };
    } catch (error) {
      /*
       * 以前这里两个条件都写成 10001，等于「参数错误就清登录态」，
       * 一次拼错参数的请求就会把好好的登录态删掉。
       * 真正代表凭据失效的是 -100（未登录）和 -101（登录过期）。
       */
      if (error.retcode === -100 || error.retcode === -101) {
        /*
         * 只摘掉这一个账号，别把其它通行证一起清了 ——
         * 多账号下某个小号过期是很正常的事，连坐会让人莫名其妙地重新登录。
         */
        const fresh = await readHoyolabStore(providerId);
        fresh.accounts = fresh.accounts.filter((item) => item.id !== account.id);
        if (fresh.activeId === account.id) fresh.activeId = fresh.accounts[0]?.id || '';
        await writeHoyolabStore(providerId, fresh);
      }
      /*
       * 不 throw：ipcMain.handle 抛错时 Electron 只把 message 传回渲染进程，
       * retcode 和实际请求地址都会丢，用户和排查的人都只能看到一句话。
       * 当成返回值带回去，前端就能把「打的是哪个地址、服务端回了什么码」显示出来。
       */
      /*
       * 诊断信息：只带 cookie 的字段名，不带值。
       * 5003 这类风控/参数错误，常见原因是 cookie 里缺 ltoken 或 cookie_token 中的某一项，
       * 但这层信息用户在界面上完全看不到，出问题时只能干瞪眼。
       */
      const cookieKeys = String(saved.cookie || '')
        .split(';')
        .map((part) => part.split('=')[0].trim())
        .filter(Boolean);
      return {
        ok: false,
        error: error.message || String(error),
        retcode: typeof error.retcode === 'number' ? error.retcode : null,
        url: error.url || api,
        debug: { cookieKeys },
      };
    }
  });
  ipcMain.handle('app:ui-scale', (_event, value) => {
    const scale = normalizeUiScale(value);
    store.data.settings.uiScale = scale;
    applyUiScale(scale);
    store.saveNow().catch(() => {});
    return scale;
  });
  ipcMain.handle('game:notices', async (_event, gameId) => {
    const game = store.data.games.find((item) => item.id === gameId);
    if (!game?.builtinKey) return [];
    return fetchGameNotices(game.builtinKey);
  });
  ipcMain.handle('games:notices', async (_event, force = false) => fetchAllGameNotices(Boolean(force)));
  /*
   * 更新弹窗的配图：读缓存，需要时刷新。
   * 登录态和战绩共用一份，没登录米游社就返回空表，前端退回官网美术图。
   */
  ipcMain.handle('postart:list', async (_event, force = false) => {
    const cached = postArt.readCache(app.getPath('userData'));
    const fresh = cached && Date.now() - Number(cached.updatedAt || 0) < 7 * 24 * 60 * 60 * 1000;
    if (!force && fresh) return { ok: true, cached: true, items: cached.items, updatedAt: cached.updatedAt };
    let cookie = '';
    try {
      const store2 = await readHoyolabStore('miyoushe');
      const account = pickHoyolabAccount(store2, '') || (store2.accounts && store2.accounts[0]);
      cookie = (account && account.cookie) || '';
    } catch {
      cookie = '';
    }
    try {
      return await postArt.refresh({ userDataDir: app.getPath('userData'), cookie, force: Boolean(force) });
    } catch (error) {
      return {
        ok: false,
        items: (cached && cached.items) || {},
        error: (error && error.message) || String(error),
      };
    }
  });
  ipcMain.handle('window:minimize', () => {
    if (win && !win.isDestroyed()) win.minimize();
  });
  ipcMain.handle('window:toggle-maximize', () => {
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', () => {
    if (win && !win.isDestroyed()) win.close();
  });

  /*
   * 首次点关闭时那个询问框的结果：执行选择，记住了以后就都按它走。
   * remember=false（弹窗里没勾「以后不再询问」）只执行这一次，不写设置 ——
   * 下次点 ✕ 还会问。
   * closeToTray 一起写，设置页的开关才不会和真实行为打架。
   */
  ipcMain.handle('window:close-choice', async (_event, payload) => {
    const choice = typeof payload === 'string' ? payload : payload?.action;
    const remember = typeof payload === 'object' && payload !== null ? payload.remember !== false : true;
    const action = choice === 'tray' || choice === 'quit' ? choice : null;
    if (!action || !store) return { ok: false };
    closeAskPending = false;
    if (remember) {
      store.data.settings.closeAction = action;
      store.data.settings.closeToTray = action === 'tray';
      await store.saveNow().catch(() => {});
      pushState(true);
    }
    if (!win || win.isDestroyed()) return { ok: true, action };
    if (action === 'tray' && tray) {
      win.hide();
      return { ok: true, action };
    }
    // 托盘图标没装上：不能 hide（否则再也叫不回来），按用户选「退出」处理
    quitting = true;
    app.quit();
    return { ok: true, action: action === 'tray' ? 'quit' : action };
  });

  /* 用户把询问框关掉了（没选）：允许下次点关闭再问一次 */
  ipcMain.handle('window:close-cancel', () => {
    closeAskPending = false;
    return true;
  });

  /*
   * 侧栏品牌图标既是设置页入口，也要能拖动窗口。
   * 它原本靠 -webkit-app-region: drag 拖，但拖拽区会吞掉鼠标事件，
   * 点不了；改成 no-drag + 这里按位移移动窗口，两种行为就能共存。
   */
  ipcMain.handle('window:move-by', (event, payload = {}) => {
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized() || win.isFullScreen()) return false;
    const dx = Math.round(Number(payload.dx) || 0);
    const dy = Math.round(Number(payload.dy) || 0);
    if (!dx && !dy) return false;
    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);
    return true;
  });

  /*
   * 启动页唤出侧栏 = 窗口向左「长」出去，抽屉钉在窗口左边缘被一点点露出来。
   *
   * 这里刻意不做补间，只负责「把窗口设成展开量 delta」；补间在渲染层的 rAF 里
   * 一帧帧调过来。一次 setBounds 跳到位和 CSS 动画永远对不齐，观感就是
   * 「窗口先拉伸一下、抽屉再追上来」—— 那正是要避免的东西。
   *
   *   · window:start-nav-room     问一句左侧还有多少空间（不够就退回「往里推」）
   *   · window:start-nav-resize   把窗口设成「基准 + delta」，每帧调一次
   *   · window:start-nav-collapse 立刻收回基准（跳转 / 最大化 / 界面重载时用）
   *
   * 基准（startNavBase）在第一次 resize 时记一次，之后所有帧都以它为准做绝对
   * 换算，不做相对累加 —— 否则每帧取整的误差会越滚越大。
   */
  let startNavBase = null;

  const startNavRoom = () => {
    if (!win || win.isDestroyed()) return { ok: false, room: 0 };
    if (win.isFullScreen() || win.isMaximized()) return { ok: false, room: 0, reason: 'fullscreen' };
    const bounds = win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    return { ok: true, room: Math.max(0, Math.round(bounds.x - area.x)), bounds };
  };

  const applyStartNav = (delta) => {
    if (!win || win.isDestroyed()) return 0;
    if (win.isFullScreen() || win.isMaximized()) return 0;
    const d = Math.max(0, Math.round(Number(delta) || 0));
    if (!startNavBase) {
      const b = win.getBounds();
      startNavBase = { x: b.x, y: b.y, width: b.width, height: b.height };
    }
    if (d > 0) {
      win.setBounds({
        x: startNavBase.x - d,
        y: startNavBase.y,
        width: Math.max(320, startNavBase.width + d),
        height: startNavBase.height,
      });
    }
    return d;
  };

  const collapseStartNav = () => {
    if (!startNavBase) return 0;
    if (win && !win.isDestroyed() && !win.isFullScreen() && !win.isMaximized()) {
      win.setBounds(startNavBase);
    }
    startNavBase = null;
    return 1;
  };

  ipcMain.handle('window:start-nav-room', () => startNavRoom());

  // 渲染层每帧调一次，只做事不回话（回话要排一趟请求-响应，纯浪费）
  ipcMain.on('window:start-nav-resize', (_event, payload = {}) =>
    applyStartNav(payload.delta)
  );

  ipcMain.handle('window:start-nav-collapse', () => collapseStartNav());

  ipcMain.handle('starrail:fps:get', async () => {
    const game = store.data.games.find((item) => item.builtinKey === 'starrail');
    const server = (game?.servers || []).find((item) => item.id === game.activeServerId);
    return getStarRailFps(server?.channel || '');
  });

  ipcMain.handle('starrail:fps:set', async (_event, fps) => {
    const game = store.data.games.find((item) => item.builtinKey === 'starrail');
    const server = (game?.servers || []).find((item) => item.id === game.activeServerId);
    return setStarRailFps(fps, server?.channel || '');
  });

  ipcMain.handle('endfield:login-token', async () => {
    return new Promise((resolve, reject) => {
      const loginWindow = new BrowserWindow({
        width: 520,
        height: 720,
        parent: win || undefined,
        modal: false,
        show: true,
        title: '终末地网页登录',
        webPreferences: {
          partition: 'persist:endfield-gacha-login',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      let settled = false;
      const finish = async (auth) => {
        if (settled) return;
        settled = true;
        await saveSecret('endfield', JSON.stringify(auth)).catch(() => {});
        try {
          loginWindow.close();
        } catch {
          /* ignore */
        }
        resolve(auth);
      };
      const checkUrl = (url) => {
        try {
          const parsed = new URL(url);
          if (!/ef-webview\.(?:hypergryph|gryphline)\.com$/.test(parsed.hostname)) return;
          const token = parsed.searchParams.get('u8_token');
          if (!token) return;
          finish({
            token,
            provider: parsed.hostname.includes('gryphline') ? 'gryphline' : 'hypergryph',
            serverId: parsed.searchParams.get('server') || parsed.searchParams.get('server_id') || '1',
          });
        } catch {
          /* ignore */
        }
      };
      loginWindow.webContents.on('will-navigate', (_event, url) => checkUrl(url));
      loginWindow.webContents.on('will-redirect', (_event, url) => checkUrl(url));
      loginWindow.webContents.on('did-navigate', (_event, url) => checkUrl(url));
      loginWindow.webContents.on('did-navigate-in-page', (_event, url) => checkUrl(url));
      loginWindow.webContents.setWindowOpenHandler(({ url }) => {
        checkUrl(url);
        return { action: 'deny' };
      });
      loginWindow.on('closed', () => {
        if (!settled) {
          settled = true;
          reject(new Error('已取消网页登录'));
        }
      });
      loginWindow.loadURL('https://ef-webview.hypergryph.com/page/gacha_char');
    });
  });

  /*
   * 通用通行证登录（鹰角 / 完美世界 / 库街区）。
   *
   * 和米游社那条路走同一套思路：内嵌浏览器让用户自己登录，
   * 我们只负责「判断什么时候登好了」和「把 cookie 存起来」。
   * 差别在于各家的登录成功标志不同，声明在 passport-login.js 的 PROVIDERS 里。
   *
   * 返回 { ok, cancelled?, provider, cookie?, roles? }；
   * roles 为 null 表示该渠道官方没有角色列表接口。
   */
  ipcMain.handle('passport:login', async (_event, input = {}) => {
    const providerId = String(input.provider || '');
    const provider = passport.PROVIDERS[providerId];
    if (!provider) return { ok: false, reason: `未知的通行证渠道：${providerId}` };

    const ses = session.fromPartition(`persist:passport-${providerId}`);

    return new Promise((resolve) => {
      let settled = false;
      let poll = null;
      let timeout = null;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        if (poll) clearInterval(poll);
        if (timeout) clearTimeout(timeout);
        try {
          if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
        } catch {
          /* ignore */
        }
        resolve(payload);
      };

      const loginWindow = new BrowserWindow({
        width: 520,
        height: 720,
        parent: win && !win.isDestroyed() ? win : undefined,
        modal: false,
        show: true,
        title: `登录${provider.label}`,
        autoHideMenuBar: true,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      loginWindow.setMenuBarVisibility(false);
      loginWindow.webContents.setUserAgent(passport.UA);

      /*
       * 和米游社那条路一样：只认主框架加载完成，子框架（通行证页自己嵌的登录 iframe）
       * 的加载不再触发注入，否则同样会把已经打开的登录框关掉重开。
       */
      const inject = () => {
        if (!provider.openDialogScript) return;
        loginWindow.webContents.executeJavaScript(provider.openDialogScript, true).catch(() => {});
      };
      loginWindow.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
        if (isMainFrame) inject();
      });

      loginWindow.on('closed', () => {
        finish({ ok: false, cancelled: true, reason: '已取消登录' });
      });

      loginWindow.loadURL(provider.home).catch(() => {});

      /*
       * 轮询 cookie。不用「用户点完成」按钮，是因为各家的登录完成页
       * 五花八门，而且有的会直接跳回站点首页；盯着 cookie 变最可靠。
       */
      poll = setInterval(async () => {
        if (settled || !loginWindow || loginWindow.isDestroyed()) return;
        try {
          const all = await ses.cookies.get({});
          const picked = passport.filterCookies(all, provider.cookieDomains);
          if (!passport.hasLoginCookie(picked, provider.loginKeys)) return;
          const cookieStr = passport.cookieHeader(picked);
          const roles = await passport.fetchRoles(providerId, cookieStr);
          await saveSecret(
            `passport-${providerId}`,
            JSON.stringify({ cookie: cookieStr, savedAt: Date.now(), provider: providerId })
          );
          finish({ ok: true, provider: providerId, cookie: cookieStr, roles });
        } catch {
          // 网络抖动就下一轮再试
        }
      }, 1200);

      timeout = setTimeout(() => {
        finish({ ok: false, cancelled: true, reason: '登录超时（5 分钟）' });
      }, 5 * 60 * 1000);
    });
  });

  ipcMain.handle('passport:status', async (_event, input = {}) => {
    const providerId = String(input.provider || '');
    const provider = passport.PROVIDERS[providerId];
    if (!provider) return { ok: false, loggedIn: false, roles: null, reason: `未知的通行证渠道：${providerId}` };
    const raw = await loadSecret(`passport-${providerId}`);
    if (!raw) return { ok: true, loggedIn: false, roles: null };
    try {
      const saved = JSON.parse(raw);
      /*
       * 鹰角 / 完美的 cookie 没有能直接验证有效性的公开接口，
       * 所以这里只报告「存过凭据」，真正的失效会在下次调用业务接口时暴露。
       * 米家那套有 roleList 可以验，所以走的是 miyoushe 分支。
       */
      return {
        ok: true,
        loggedIn: Boolean(saved.cookie),
        roles: null,
        savedAt: saved.savedAt || 0,
        verified: false,
      };
    } catch (error) {
      return { ok: true, loggedIn: false, roles: null, reason: String(error.message || error) };
    }
  });

  ipcMain.handle('passport:logout', async (_event, input = {}) => {
    const providerId = String(input.provider || '');
    await saveSecret(`passport-${providerId}`, '');
    try {
      const ses = session.fromPartition(`persist:passport-${providerId}`);
      await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage'] });
    } catch {
      /* ignore */
    }
    return { ok: true };
  });

  /* ------------------------------------------------------------------ */
  /* 森空岛（鹰角社区）—— 终末地 / 明日方舟的官方数据源                    */
  /* ------------------------------------------------------------------ */

  /*
   * 凭据分三层，缺一层就换不出数据：
   *   accountToken —— 账号级 token（网页登录后 cookie 里的那个），长期有效，用来重换 cred
   *   cred         —— 每次请求都带在头上的身份串，会过期
   *   credToken    —— 参与签名计算的密钥，和 cred 一起换
   * 这三样都是账号凭据，只走 safeStorage，不写进任何明文配置。
   */
  const SKLAND_STORE_KEY = 'skland-store';
  /**
   * 存储版本 2 的来由：v1 时期 `roles` 里存的是 bindingList 的 uid（森空岛的绑定编号），
   * 而终末地的接口要的是 `roles[].roleId`，两者差一个数量级之外还完全不同。
   * 旧数据留着只会让便笺/战争回响/签到一直 403·10001，所以升版本时把缓存角色清空一次，
   * 下次刷新自动按新解析方式重读。accountToken 不动，用户不需要重新登录。
   */
  const SKLAND_STORE_VERSION = 2;

  async function readSklandStore() {
    const empty = { version: SKLAND_STORE_VERSION, accounts: [], activeId: '' };
    const raw = await loadSecret(SKLAND_STORE_KEY);
    if (!raw) return empty;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return empty;
    }
    if (!parsed || typeof parsed !== 'object') return empty;
    const stale = Number(parsed.version) !== SKLAND_STORE_VERSION;
    const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : [])
      .filter((item) => item && item.accountToken)
      .map((item) => ({
        id: String(item.id || `sk${Math.random().toString(36).slice(2, 8)}`),
        accountToken: String(item.accountToken),
        cred: String(item.cred || ''),
        credToken: String(item.credToken || ''),
        userId: String(item.userId || ''),
        roles: !stale && Array.isArray(item.roles) ? item.roles : [],
        savedAt: Number(item.savedAt) || 0,
      }));
    const activeId = accounts.some((item) => item.id === parsed.activeId)
      ? parsed.activeId
      : accounts[0]?.id || '';
    return { version: SKLAND_STORE_VERSION, accounts, activeId };
  }

  async function writeSklandStore(store) {
    await saveSecret(SKLAND_STORE_KEY, JSON.stringify(store));
  }

  function publicSklandAccount(account) {
    /*
     * 账号得有个能认人的名字。
     * 森空岛只给 userId（一串数字），列表里全是数字谁也分不清哪个是哪个，
     * 所以优先用这个账号下终末地角色的昵称，没有角色才退回 userId 尾号。
     */
    const roles = skland.endfieldRolesOf(account.roles || []);
    const nickname = String(roles[0]?.nickname || '');
    return {
      id: account.id,
      userId: account.userId,
      label: nickname || (account.userId ? `鹰角 ${String(account.userId).slice(-6)}` : '森空岛账号'),
      nickname,
      savedAt: account.savedAt || 0,
      roles: account.roles || [],
    };
  }

  function pickSklandAccount(store, accountId) {
    const wanted = String(accountId || '');
    if (wanted) {
      const found = store.accounts.find((item) => item.id === wanted);
      if (found) return found;
    }
    return store.accounts.find((item) => item.id === store.activeId) || store.accounts[0] || null;
  }

  /**
   * 候选 token 的判定：形状像不像一段令牌。
   *
   * 换 cred 的接口本身就是校验器，所以这里只管「值看起来像不像」，
   * 不追求认得出是哪个字段。太短的（语言、主题、AB 分组）直接排掉，
   * 免得拿一堆垃圾值去撞接口。
   */
  function looksLikeToken(value) {
    const text = String(value || '').trim();
    if (text.length < 16 || text.length > 4096) return false;
    if (!/^[A-Za-z0-9+/=_.\-:]+$/.test(text)) return false;
    // 纯数字、纯日期这类不算令牌
    if (/^\d+$/.test(text)) return false;
    return true;
  }

  /**
   * 从 cookie 里抠出所有「可能是账号 token」的值。
   *
   * 森空岛网页把登录态种在 ACCOUNT 上，鹰角通行证自己用 HG_TOKEN，
   * 老版本 SDK 还丢过一个 u8_token；三者历史上有过混用。
   * 更要紧的是：**站点改过 cookie 名**，只认这三个名字的话，
   * 用户明明登录成功了也会一直「识别不到账号」。
   * 所以分两轮：名字像 token 的排前面，其余 cookie 兜底排后面。
   */
  function sklandTokenCandidates(items) {
    const list = [];
    const push = (raw) => {
      const value = String(raw || '').trim();
      if (!value) return;
      /*
       * 先解码再判断。
       * 森空岛把 ACCOUNT 的值做过 URL 编码，原文带 % 号，而 looksLikeToken 的字符集
       * 白名单里没有 % —— 先前是先校验原文、不过就 return，等于把所有 URL 编码过的
       * token 直接扔了。用户明明登着，这边永远「识别不到账号」，就是这一步卡掉的。
       */
      let decoded = '';
      try {
        decoded = decodeURIComponent(value);
      } catch {
        decoded = '';
      }
      for (const candidate of [value, decoded]) {
        if (!candidate || !looksLikeToken(candidate) || list.includes(candidate)) continue;
        list.push(candidate);
      }
    };
    const rows = Array.isArray(items) ? items : [];
    const tokenish = /token|account|hg_|u8_|cred|passport|skland/i;
    for (const item of rows) if (tokenish.test(String(item?.name || ''))) push(item?.value);
    for (const item of rows) push(item?.value);
    /* 上限 12 个：每轮轮询都要逐个试，太多会把这个账号试进风控 */
    return list.slice(0, 12);
  }

  /**
   * 森空岛网页版也可能把 token 放 localStorage（不走 cookie）。
   * 拿不到 cookie 时补这一手，顺带把 JSON 里像 token 的字段挖出来。
   */
  async function sklandStorageCandidates(webContents) {
    try {
      const pairs = await webContents.executeJavaScript(
        `(() => {
          const out = [];
          try {
            for (let i = 0; i < localStorage.length; i += 1) {
              const key = localStorage.key(i);
              out.push([key, String(localStorage.getItem(key) || '').slice(0, 4096)]);
            }
          } catch (error) {
            /* 跨域或页面未就绪，忽略 */
          }
          return out;
        })()`,
        true
      );
      if (!Array.isArray(pairs)) return [];
      const list = [];
      for (const [key, value] of pairs) {
        if (looksLikeToken(value)) list.push(value);
        /* 值是 JSON 时把里面的 token 字段也挖出来 */
        if (value && value.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(value);
            for (const field of ['token', 'access_token', 'accountToken', 'account_token', 'hgToken']) {
              const found = parsed?.[field];
              if (looksLikeToken(found)) list.push(String(found));
            }
          } catch {
            /* 不是合法 JSON */
          }
        }
        void key;
      }
      return list.slice(0, 6);
    } catch {
      return [];
    }
  }

  /** 用候选 token 逐个换 cred，第一个成功的就留下。 */
  async function sklandCredFromCandidates(candidates) {
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const cred = await skland.loginByToken(candidate);
        return { cred, accountToken: candidate };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('这个账号的登录凭据用不了，请重新登录森空岛');
  }

  /**
   * 把换到的 cred 落成账号记录。
   * 轮询、粘贴令牌、接管通行证分区三条路都走这里，免得三份实现慢慢跑偏。
   */
  async function sklandSaveAccount({ cred, accountToken }) {
    const account = {
      id: `sk-${cred.userId || accountToken.slice(-8)}`,
      accountToken,
      cred: cred.cred,
      credToken: cred.token,
      userId: cred.userId,
      roles: [],
      savedAt: Date.now(),
    };
    const store = await readSklandStore();
    store.accounts = store.accounts.filter((item) => item.id !== account.id);
    store.accounts.unshift(account);
    store.activeId = account.id;
    await writeSklandStore(store);
    try {
      await refreshSklandRoles(account);
    } catch {
      /* 角色拉不到不影响登录本身 */
    }
    await writeSklandStore(store);
    return account;
  }

  /**
   * 顺手接管「鹰角通行证」那张卡已经登录的状态。
   *
   * 工具页上的「鹰角通行证」登录窗口跑在 persist:passport-hypergryph 分区里，
   * 森空岛这边跑在 persist:skland，两者 cookie 不共享。但登录成功后种下的是
   * 同一枚账号 token —— 用户先在通行证那边登过、再来点森空岛，不该再让他登一遍。
   */
  async function sklandAdoptPassportSession() {
    try {
      const ses = session.fromPartition('persist:passport-hypergryph');
      const candidates = sklandTokenCandidates(await ses.cookies.get({}));
      if (!candidates.length) return null;
      return await sklandCredFromCandidates(candidates);
    } catch {
      return null;
    }
  }

  /**
   * 换一份能用的 cred：有就直接用，没有或被告知失效就重新换。
   * `force` 用于接口返回「凭据失效」之后的第二次尝试。
   */
  async function ensureSklandCred(account, force = false) {
    if (!force && account.cred && account.credToken) {
      return { cred: account.cred, token: account.credToken };
    }
    const fresh = await skland.loginByToken(account.accountToken);
    account.cred = fresh.cred;
    account.credToken = fresh.token;
    account.userId = fresh.userId || account.userId;
    return { cred: account.cred, token: account.credToken };
  }

  /**
   * 终末地的 card/detail 与 war-echoes 都必须带 `userId`（森空岛账号 ID）。
   *
   * 以前直接读 account.userId。这个值只在「拉绑定角色」那一步顺手取，
   * 取失败会被静默吞掉（注释写着"缺了也能用"，但终末地这两个接口缺了不行）——
   * 于是 URL 里变成 `userId=`，服务端不解释，直接回 HTTP 401，
   * 用户看到的只有一句「接口 HTTP 401」，怎么点重试都一样。
   *
   * 这里改成缺了就现取，取不到如实报错，不再让它退化成 401。
   */
  async function ensureSklandUserId(account, cred, token) {
    if (account?.userId) return String(account.userId);
    const userId = await skland.fetchUserId(cred, token);
    if (account) account.userId = userId;
    return userId;
  }

  /** 拉一次绑定角色，只留终末地那些，顺手写回 store。 */
  async function refreshSklandRoles(account) {
    const { cred, token } = await ensureSklandCred(account);
    const all = await skland.fetchBindings(cred, token);
    account.roles = all;
    if (!account.userId) {
      try {
        account.userId = await skland.fetchUserId(cred, token);
      } catch {
        /* 少数接口不要 userId，缺了也能用 */
      }
    }
    return account.roles;
  }

  /**
   * 角色列表为空时补拉一次（每分钟最多一次）。
   *
   * 场景：存储升到 v2 后旧的角色缓存被清掉、或者刚登录还没同步过。
   * 界面上每次重绘都会问状态，所以这里卡一个时间窗，避免打开工具页就
   * 连打十几个 binding 请求。
   */
  const sklandRolesRefreshAt = new Map();
  async function ensureSklandRoles(account, { force = false } = {}) {
    if (!account) return [];
    if (!force && skland.endfieldRolesOf(account.roles || []).length) return account.roles;
    const last = sklandRolesRefreshAt.get(account.id) || 0;
    if (!force && Date.now() - last < 60_000) return account.roles || [];
    sklandRolesRefreshAt.set(account.id, Date.now());
    try {
      return await refreshSklandRoles(account);
    } catch {
      return account.roles || [];
    }
  }

  /** 先查缓存，查不到再补拉一次绑定 —— 老数据迁移后用户不用手动点「同步角色」。 */
  async function resolveEndfieldRole(account, roleId) {
    const cached = endfieldRoleOf(account, roleId);
    if (cached) return cached;
    /*
     * 这里是用户主动点了刷新/切游戏，别再受 status 那个 60 秒窗口限制：
     * 窗口内不重试的话，网络刚好抖一下就会误报「这个账号下没有终末地角色」。
     */
    await ensureSklandRoles(account, { force: true });
    return endfieldRoleOf(account, roleId);
  }

  /**
   * 统一入口：挑账号 → 拿 cred → 执行 → 凭据失效时自动重换一次。
   *
   * 森空岛的过期信号是 10000（未登录）/ 10002（登录过期）。
   * 只重试一次：如果是账号本身出问题，反复重换只会把风控惹毛。
   */
  async function withSkland(input, runner) {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input?.accountId);
    if (!account) {
      return { ok: false, error: '还没有登录森空岛，请先在工具页点「登录森空岛」', needLogin: true };
    }
    const run = async () => {
      const { cred, token } = await ensureSklandCred(account);
      return runner({ account, cred, token });
    };
    try {
      const result = await run();
      await writeSklandStore(store);
      return { ok: true, data: result };
    } catch (error) {
      const code = error?.code;
      const biz = Number(error?.bizCode);
      /*
       * 401 / 403 / 10000 / 10002 都按「凭据可能不同步」处理。
       * 服务端对「cred 还有效、但签名用的 token 已经不是这一份」这种情况，
       * 返回的是 HTTP 403 / 401 而不是 10002 这类业务码；用账号 token 重换一次
       * cred 往往就通了，所以和 10002 走同一条重试路径。
       *
       * 401 是 2026-11-03 补的：终末地 card/detail 实际会返 401（响应体仍是
       * {"code":10000}），以前只认 403，于是这种「重登一下就好」的情况被直接
       * 当成最终错误甩给用户，点了重试还是同一条。
       *
       * 但 403 里有一种不该重试：响应体带 `code:10001` 的「操作失败，请稍后重试」。
       * 那不是登录问题，而是请求里的角色/区服对不上（实测把 bindingList 的 uid
       * 当 roleId 就会必现）。重换凭据一百次也是同一句，只会让用户以为号坏了。
       * 这种直接如实说明并指向「同步角色」。
       */
      const paramRejected = code === 403 && biz === 10001;
      const retryable =
        !paramRejected && (code === 10000 || code === 10002 || code === 401 || code === 403);
      if (!retryable) {
        await writeSklandStore(store).catch(() => {});
        if (paramRejected) {
          const hint = error?.bizMessage ? `（10001 ${error.bizMessage}）` : '（10001）';
          return {
            ok: false,
            error:
              `森空岛不接受这次查询${hint}：请求里的角色或区服和这个账号对不上，` +
              '不是登录过期。点战绩页的「同步角色」重新读一次绑定，再点刷新就好。',
            code,
          };
        }
        return { ok: false, error: String(error?.message || error), code: code ?? null };
      }
      try {
        await ensureSklandCred(account, true);
        const result = await run();
        await writeSklandStore(store);
        return { ok: true, data: result };
      } catch (retryError) {
        await writeSklandStore(store).catch(() => {});
        const retryBiz = Number(retryError?.bizCode);
        if (retryBiz === 10001) {
          const hint = retryError?.bizMessage ? `（10001 ${retryError.bizMessage}）` : '（10001）';
          return {
            ok: false,
            error:
              `森空岛不接受这次查询${hint}：角色或区服和这个账号对不上。` +
              '点「同步角色」重新读取绑定后再刷新。',
            code: retryError?.code ?? 403,
          };
        }
        const prefix = code === 401 || code === 403
          ? `森空岛拒绝了这次请求（${code}），已经自动重新换过凭据仍然被拒`
          : '森空岛登录态已失效';
        return {
          ok: false,
          error: `${prefix}：${String(retryError?.message || retryError)}`,
          needLogin: true,
        };
      }
    }
  }

  /** 终末地角色（可能一个账号下挂多个服）。 */
  function endfieldRoleOf(account, roleId) {
    const roles = skland.endfieldRolesOf(account.roles || []);
    if (!roles.length) return null;
    const wanted = String(roleId || '');
    if (wanted) {
      const found = roles.find((role) => String(role.uid) === wanted || String(role.roleId) === wanted);
      if (found) return found;
    }
    return roles.find((role) => role.isDefault) || roles[0];
  }

  /*
   * 登录森空岛。
   *
   * 打开的是森空岛网页版而不是鹰角通行证首页 —— 后者登完只种 hypergryph 域的 cookie，
   * 拿不到森空岛自己的 ACCOUNT；在森空岛页面里点登录，走的虽然是同一套通行证 SSO，
   * 但登录态会同时落到 skland.com 下，正好是我们要的那一份。
   */
  ipcMain.handle('skland:login', async (_event, input = {}) => {
    const ses = session.fromPartition('persist:skland');
    if (input.relogin) {
      try {
        await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
      } catch {
        /* ignore */
      }
    }

    /*
     * 最常见的一种「明明登录了却识别不到」：
     * 用户先在工具页的「鹰角通行证」卡里登过，再来点森空岛 —— 两边是不同的
     * 会话分区，cookie 不互通，于是又弹一个空白的登录窗。
     * 这里先拿通行证分区的凭据换一次 cred，成功了连窗口都不开。
     *
     * add=true（添加另一个账号）时必须跳过这一步：通行证分区里只有第一次那个号，
     * 接管过来等于把用户已经有的账号又存一遍，新账号根本进不来。
     */
    if (!input.relogin && !input.add) {
      const adopted = await sklandAdoptPassportSession();
      if (adopted) {
        const account = await sklandSaveAccount(adopted);
        return { ok: true, account: publicSklandAccount(account), adopted: true };
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      let poll = null;
      let timeout = null;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        if (poll) clearInterval(poll);
        if (timeout) clearTimeout(timeout);
        try {
          if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
        } catch {
          /* ignore */
        }
        resolve(payload);
      };

      const loginWindow = new BrowserWindow({
        width: 560,
        height: 760,
        parent: win && !win.isDestroyed() ? win : undefined,
        modal: false,
        show: true,
        title: '登录森空岛',
        autoHideMenuBar: true,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      loginWindow.setMenuBarVisibility(false);
      loginWindow.webContents.setUserAgent(passport.UA);

      loginWindow.on('closed', () => {
        finish({ ok: false, cancelled: true, reason: '已取消登录' });
      });

      loginWindow.loadURL('https://www.skland.com/').catch(() => {});

      /*
       * 轮询：每 1.5 秒探一次登录态。
       *
       * 两个讲究：
       * ① 一进窗口先跑一次 —— 用户之前登录过、cookie 还留在 persist:skland 分区里时
       *    能立刻接管，不用他自己发现「明明登着却还说我没登」。
       * ② cookie 没变化就不重复换 cred。候选最多十二个，每轮全试一遍等于每 1.5 秒
       *    打十几次接口，容易把这个账号试进风控；失败一次后补一轮 localStorage
       *    （森空岛网页版也可能把 token 存那儿），补完仍失败就等 cookie 变化。
       */
      let lastProbeKey = '';
      let needStorageFallback = false;
      const probe = async () => {
        if (settled || !loginWindow || loginWindow.isDestroyed()) return;
        try {
          const all = await ses.cookies.get({});
          const fromCookie = sklandTokenCandidates(all);
          const key = fromCookie.join('|');
          if (key && key === lastProbeKey && !needStorageFallback) return;
          lastProbeKey = key;
          const candidates = fromCookie.slice();
          if (needStorageFallback) {
            needStorageFallback = false;
            candidates.push(...(await sklandStorageCandidates(loginWindow.webContents)));
          }
          if (!candidates.length) return;
          const account = await sklandSaveAccount(await sklandCredFromCandidates(candidates));
          finish({ ok: true, account: publicSklandAccount(account) });
        } catch {
          /* 还没登好 / 网络抖动：允许补一次 localStorage，再失败就等 cookie 变化 */
          needStorageFallback = true;
        }
      };
      poll = setInterval(probe, 1500);
      probe();

      timeout = setTimeout(() => {
        finish({ ok: false, cancelled: true, reason: '登录超时（5 分钟）' });
      }, 5 * 60 * 1000);
    });
  });

  /** 兜底：用户从 web-api.skland.com/account/info/hg 抄来的 token 直接粘进来。 */
  ipcMain.handle('skland:login-token', async (_event, input = {}) => {
    const token = String(input.token || '').trim();
    if (!token) return { ok: false, error: '请先粘贴 token' };
    try {
      const cred = await skland.loginByToken(token);
      const account = await sklandSaveAccount({ cred, accountToken: token });
      return { ok: true, account: publicSklandAccount(account) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('skland:status', async (_event, input = {}) => {
    const store = await readSklandStore();
    const active = pickSklandAccount(store, input.accountId);
    /*
     * 这里不主动联网：状态查询在页面每次重绘时都会调，
     * 真去换 cred 会让打开工具页要多等两秒。失效会在读数据时被发现。
     *
     * 但要顺带看一眼分区里有没有残留的 cookie —— 有的话说明「用户在这个窗口里
     * 登录过、只是账号还没被接管」，界面就能提示「点一次登录即可」，而不是干巴巴
     * 写着「未登录」。读 cookie 是内存操作，不发网络请求。
     */
    let hasCookies = false;
    if (!active) {
      for (const partition of ['persist:skland', 'persist:passport-hypergryph']) {
        if (hasCookies) break;
        try {
          const pieces = await session.fromPartition(partition).cookies.get({});
          hasCookies = sklandTokenCandidates(pieces).length > 0;
        } catch {
          /* 分区还没建，视作没有 */
        }
      }
    }
    /*
     * 例外：存储升级后角色缓存是空的（v1 存的是绑定编号，已经不再兼容）。
     * 这时候补拉一次绑定，否则界面会误报「这个账号下没有终末地角色」。
     * ensureSklandRoles 内部有 60 秒时间窗，成功一次就写回 store，不会反复请求。
     */
    if (active && !skland.endfieldRolesOf(active.roles || []).length) {
      const before = (active.roles || []).length;
      await ensureSklandRoles(active);
      if ((active.roles || []).length !== before) await writeSklandStore(store).catch(() => {});
    }
    return {
      ok: true,
      loggedIn: Boolean(active),
      hasCookies,
      activeId: active?.id || '',
      accounts: store.accounts.map(publicSklandAccount),
      roles: active ? skland.endfieldRolesOf(active.roles || []) : [],
    };
  });

  ipcMain.handle('skland:roles', async (_event, input = {}) => {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input.accountId);
    if (!account) return { ok: false, error: '还没有登录森空岛', needLogin: true, roles: [] };
    try {
      const roles = await refreshSklandRoles(account);
      await writeSklandStore(store);
      return { ok: true, roles: skland.endfieldRolesOf(roles) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), roles: skland.endfieldRolesOf(account.roles || []) };
    }
  });

  /** 切换当前使用的森空岛账号。多个号各自有自己的 cred 与角色，互不影响。 */
  ipcMain.handle('skland:use-account', async (_event, input = {}) => {
    const store = await readSklandStore();
    const wanted = String(input.accountId || '');
    const account = store.accounts.find((item) => item.id === wanted);
    if (!account) return { ok: false, error: '没有这个森空岛账号，可能已经被移除了' };
    store.activeId = account.id;
    await writeSklandStore(store);
    return { ok: true, accountId: account.id, account: publicSklandAccount(account) };
  });

  ipcMain.handle('skland:logout', async (_event, input = {}) => {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input.accountId);
    if (account) {
      store.accounts = store.accounts.filter((item) => item.id !== account.id);
      if (store.activeId === account.id) store.activeId = store.accounts[0]?.id || '';
      await writeSklandStore(store);
    }
    /*
     * 只有「一个号都不剩」时才清分区。
     * 多账号时删掉其中一个就把整个 persist:skland 清空，会把另一个号留在分区里的
     * cookie 一起扔了 —— 虽然它还能靠 accountToken 重新换 cred，但下次启动就得
     * 多走一次授权，没必要。
     */
    if (!store.accounts.length) {
      try {
        const ses = session.fromPartition('persist:skland');
        await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage'] });
      } catch {
        /* ignore */
      }
    }
    return { ok: true, accounts: store.accounts.map(publicSklandAccount), activeId: store.activeId };
  });

  ipcMain.handle('skland:note', async (_event, input = {}) => {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input.accountId);
    if (!account) return { ok: false, error: '还没有登录森空岛', needLogin: true };
    const role = await resolveEndfieldRole(account, input.roleId);
    await writeSklandStore(store).catch(() => {});
    if (!role) return { ok: false, error: '这个鹰角账号下没有终末地角色，请先在游戏里创建角色' };
    const result = await withSkland(input, async ({ cred, token, account: current }) =>
      skland.endfieldCard(cred, token, {
        userId: await ensureSklandUserId(current, cred, token),
        roleId: role.roleId,
        serverId: role.serverId,
      })
    );
    return { ...result, role };
  });

  ipcMain.handle('skland:record', async (_event, input = {}) => {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input.accountId);
    if (!account) return { ok: false, error: '还没有登录森空岛', needLogin: true };
    const role = await resolveEndfieldRole(account, input.roleId);
    await writeSklandStore(store).catch(() => {});
    if (!role) return { ok: false, error: '这个鹰角账号下没有终末地角色，请先在游戏里创建角色' };
    const result = await withSkland(input, async ({ cred, token, account: current }) =>
      skland.endfieldWarEchoes(cred, token, {
        userId: await ensureSklandUserId(current, cred, token),
        roleId: role.roleId,
        serverId: role.serverId,
        seasonId: input.seasonId,
      })
    );
    return { ...result, role };
  });

  ipcMain.handle('skland:sign', async (_event, input = {}) => {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input.accountId);
    if (!account) return { ok: false, error: '还没有登录森空岛', needLogin: true };
    const role = await resolveEndfieldRole(account, input.roleId);
    await writeSklandStore(store).catch(() => {});
    if (!role) return { ok: false, error: '这个鹰角账号下没有终末地角色' };
    const result = await withSkland(input, ({ cred, token }) =>
      skland.endfieldAttendance(cred, token, { roleId: role.roleId, serverId: role.serverId })
    );
    return { ...result, role };
  });

  ipcMain.handle('app:install-update', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择花筱灵启动器更新包',
      properties: ['openFile'],
      filters: [{ name: '便携版 ZIP', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    const zipPath = result.filePaths[0];
    const tempBase = updateTempBase();
    await fsp.mkdir(tempBase, { recursive: true }).catch(() => {});
    // 解压到启动器旁边的临时目录，覆盖程序文件后自动重新打开（数据目录不动）
    const staged = await updater.stage({ zipPath, tempBase });
    const conflict = updater.describeApplyProblem({ staged, currentVersion: APP_VERSION });
    if (conflict) return { ok: false, message: conflict };
    const busy = describeRunningProcesses(staged.locks);
    if (busy.length) {
      return { ok: false, message: `这些程序还开着，关掉之后再导入一次：${busy.join('、')}` };
    }
    await updater.apply({
      staged,
      onReadyToQuit: () => {
        setTimeout(() => {
          quitting = true;
          app.quit();
        }, 250);
      },
    });
    return { ok: true, restarting: true, version: staged.version };
  });

  ipcMain.handle('update:check', async () => performUpdateCheck({ push: true, manual: true }));
  /*
   * Mirror酱 手动测试：设置页那个「测试」按钮。
   *
   * 和自动检查的区别是它不看模式门槛——用户点测试就是明确想验一次配置，
   * 哪怕现在是「自动」而 CDK 留空，也该如实告诉他「没 CDK 只能查版本」。
   */
  ipcMain.handle('update:mirrorchyan-test', async (_event, input) => {
    const patch = input && typeof input === 'object' ? input : {};
    const rid = String(patch.rid || store?.data?.settings?.mirrorchyanRid || '').trim();
    const cdk = String(patch.cdk || store?.data?.settings?.mirrorchyanCdk || '').trim();
    const result = await mirrorchyan.checkLatest({
      rid,
      cdk,
      currentVersion: APP_VERSION,
      sendPlatform: patch.sendPlatform !== false,
    });
    /*
     * 只回结果、不存 CDK：测试用的是界面上的输入值，用户没点保存就不该被写进
     * launcher-data.json。存盘由 settings:update 那条路负责。
     */
    return {
      ...result,
      // 回给界面的一律是打码 / 脱敏版本，免得渲染层日志或截图带出真实 CDK
      cdkMasked: mirrorchyan.maskCdk(cdk),
      rid,
    };
  });
  // 代理：从系统里读一条现成的规则，省得用户自己去翻 Clash 的端口
  ipcMain.handle('proxy:system', async () => readSystemProxy());
  // 代理：拿真实地址试一下通不通，比「保存了但不知道有没有用」强
  ipcMain.handle('proxy:test', async (_event, rules) => probeProxy(typeof rules === 'string' ? rules : ''));

  ipcMain.handle('update:apply', async () => startUpdate());

  ipcMain.handle('update:pick-source', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择更新源文件（latest.json）',
      properties: ['openFile'],
      filters: [{ name: '更新清单', extensions: ['json', 'txt'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    store.data.settings.updateManifest = result.filePaths[0];
    await store.saveNow();
    const status = await performUpdateCheck({ push: true });
    return { ok: true, status };
  });

  ipcMain.handle('update:backup', async () => updateBackupInfo());

  ipcMain.handle('update:rollback', async () => {
    const staged = await updater.prepareRollback({ tempBase: updateTempBase() });
    if (!staged) return { ok: false, message: '没有找到可回滚的上一个版本备份' };
    const busy = describeRunningProcesses(staged.locks);
    if (busy.length) {
      return { ok: false, message: `这些程序还开着，关掉之后再回滚：${busy.join('、')}` };
    }
    await updater.apply({
      staged,
      onReadyToQuit: () => {
        setTimeout(() => {
          quitting = true;
          app.quit();
        }, 250);
      },
    });
    return { ok: true, restarting: true, version: staged.version };
  });

  ipcMain.handle('state:get', () => snapshot());

  ipcMain.handle('settings:update', async (_event, patch) => {
    if (!patch || typeof patch !== 'object') return snapshot();
    const settings = store.data.settings;
    const allowed = [
      'profileName',
      'avatar',
      'theme',
      'accent',
      'sidebarCollapsed',
      'quickPanelPinned',
      'uiScale',
      'alwaysAdmin',
      // 「开游戏要管理员」这件事问过一次没有：界面点过「以管理员重启」或
      // 「每次弹一次」之后置 true，免得每次启动都重新问
      'elevationAsked',
      'elevationDeclined',
      'nevernessUseOfficialLauncher',
      'closeToTray',
      // 关闭按钮的真实行为（tray / quit）。和 closeToTray 由同一处逻辑同时写，
      // 不放进白名单的话设置页改完会被快照回推抹掉。
      'closeAction',
      'launchAtLogin',
      'minimizeOnLaunch',
      'autoSyncOfficial',
      'autoUpdateEndfieldPacks',
      'autoUpdateArknightsPacks',
      'autoGacha',
      'audioLanguages',
      'includeStoryResources',
      // ldiff 增量加速开关：不留退路的话，介意「就地改写游戏文件」的用户没有别的选择。
      'enableLdiff',
      // 下载限速：全局带宽上限（KB/s，0 = 不限速）
      'downloadLimitKBps',
      // 装饰挂饰 / 角色背景水印：这两个以前不在白名单里，快照永远不带这两个键，
      // 状态回推时会把刚点下去的值抹掉，开关表现为「点了直接弹回原状」。
      'charms',
      'charBg',
      // 侧栏底部那张火花立绘：展开侧栏时会占掉一截高度，用户要能自己关掉
      'sidebarChar',
      'updateManifest',
      // Mirror酱 接入三项：模式、RID、用户 CDK。不放进白名单的话，设置页写下去
      // 会被快照回推抹掉，表现为「选了模式一刷新又变回自动」。
      'updateSourceMode',
      'mirrorchyanRid',
      'mirrorchyanCdk',
      'autoCheckUpdate',
      'proxyRules',
      'notesSeenVersion',
      // 「稍后再说」的推迟状态：不在白名单里的话，界面写下去会被快照回推抹掉，等于没记
      'updateSnoozeVersion',
      'updateSnoozeUntil',
      'endfieldPackRoot',
      'starwardDbPath',
      'runtimeRoot',
      'downloadDir',
      'lastPage',
      'material',
      'customBackground',
      'backgroundOpacity',
      'backgroundBlur',
      'backgroundMotion',
      'backgroundRotate',
      // 点歌台音源：内置音源的开关 + 用户自己导入的第三方音源
      'musicSources',
      'musicCustomSources',
    ];
    for (const key of allowed) {
      if (!(key in patch)) continue;
      if (key === 'profileName') {
        settings.profileName = String(patch.profileName || '').slice(0, 24) || '大小姐';
      } else if (key === 'avatar') {
        settings.avatar = String(patch.avatar || '').slice(0, 500);
      } else if (key === 'theme') {
        if (['dark', 'light', 'system'].includes(patch.theme)) settings.theme = patch.theme;
      } else if (key === 'accent') {
        if (['spark', 'gold', 'sakura', 'cyan', 'rose', 'jade', 'violet', 'amber'].includes(patch.accent)) {
          settings.accent = patch.accent;
        }
      } else if (key === 'sidebarCollapsed') {
        settings.sidebarCollapsed = patch.sidebarCollapsed === true;
      } else if (key === 'uiScale') {
        settings.uiScale = normalizeUiScale(patch.uiScale);
      } else if (key === 'quickPanelPinned') {
        settings.quickPanelPinned = patch.quickPanelPinned === true;
      } else if (key === 'alwaysAdmin') {
        settings.alwaysAdmin = patch.alwaysAdmin === true;
        // 重新打开这个开关＝用户愿意再看到授权窗口
        if (settings.alwaysAdmin) settings.elevationDeclined = false;
      } else if (key === 'elevationDeclined') {
        settings.elevationDeclined = patch.elevationDeclined === true;
      } else if (key === 'nevernessUseOfficialLauncher') {
        settings.nevernessUseOfficialLauncher = patch.nevernessUseOfficialLauncher !== false;
      } else if (key === 'closeAction') {
        /*
         * 关闭按钮的行为。字符串不能走下面那个 Boolean() 兜底（会被压成 true）。
         * null 是「还没选过」，允许清空，下次点关闭会重新问一遍。
         */
        if (patch.closeAction === 'tray' || patch.closeAction === 'quit') {
          settings.closeAction = patch.closeAction;
          settings.closeToTray = patch.closeAction === 'tray';
        } else if (patch.closeAction === null) {
          settings.closeAction = null;
        }
      } else if (key === 'endfieldPackRoot') {
        const dir = String(patch.endfieldPackRoot || '').trim();
        if (dir && fs.existsSync(dir)) settings.endfieldPackRoot = dir;
        if (!dir) settings.endfieldPackRoot = '';
      } else if (key === 'starwardDbPath') {
        const dbPath = String(patch.starwardDbPath || '').trim();
        if (dbPath && fs.existsSync(dbPath)) settings.starwardDbPath = dbPath;
        if (!dbPath) settings.starwardDbPath = '';
      } else if (key === 'runtimeRoot') {
        const dir = String(patch.runtimeRoot || '').trim();
        settings.runtimeRoot = dir;
      } else if (key === 'material') {
        const value = String(patch.material || 'none');
        if (['none', 'acrylic', 'mica', 'micaTabbed', 'auto'].includes(value)) {
          settings.material = value;
        }
      } else if (key === 'customBackground') {
        // 只接受 <userData>/backgrounds/ 下的文件名，避免被写成任意路径
        const raw = String(patch.customBackground || '').trim();
        if (!raw) {
          settings.customBackground = '';
        } else {
          const base = path.basename(raw);
          // ef- 前缀是官方背景同步下来的（backgrounds/official/），custom- 是本地导入的
          if (
            /^(ef-[a-z]+[a-f0-9]{6}\.(png|jpe?g|webp)|custom-[0-9a-f-]{36}\.(png|jpe?g|webp|gif))$/i.test(base)
          ) {
            settings.customBackground = `backgrounds/${base}`;
          }
        }
      } else if (key === 'backgroundOpacity') {
        const value = Number(patch.backgroundOpacity);
        if (Number.isFinite(value)) settings.backgroundOpacity = Math.max(0, Math.min(100, Math.round(value)));
      } else if (key === 'backgroundBlur') {
        const value = Number(patch.backgroundBlur);
        if (Number.isFinite(value)) settings.backgroundBlur = Math.max(0, Math.min(60, Math.round(value)));
      } else if (key === 'backgroundMotion') {
        settings.backgroundMotion = patch.backgroundMotion !== false;
      } else if (key === 'backgroundRotate') {
        settings.backgroundRotate = patch.backgroundRotate !== false;
      } else if (key === 'musicSources') {
        // 内置音源开关：只认已知的五个键，值只认布尔
        const incoming = patch.musicSources;
        const next = {};
        if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
          for (const name of ['netease', 'kuwo', 'migu', 'kugou', 'qq']) {
            if (typeof incoming[name] === 'boolean') next[name] = incoming[name];
          }
        }
        settings.musicSources = next;
        // 开关变了必须清换源缓存：否则酷我开着时赢下的地址还会缓存 20 分钟，
        // 关掉后同一首歌"仍然识别到酷我音源"，用户以为停用没生效
        clearMusicResolveCache();
      } else if (key === 'musicCustomSources') {
        const list = Array.isArray(patch.musicCustomSources) ? patch.musicCustomSources : [];
        settings.musicCustomSources = list
          .filter((def) => validateCustomSource(def).ok)
          .slice(0, 20)
          .map((def) => ({
            id: String(def.id || def.name || '').slice(0, 60),
            name: String(def.name || def.id || '').slice(0, 60),
            search: def.search,
            url: def.url,
            headers: def.headers && typeof def.headers === 'object' ? def.headers : undefined,
            enabled: def.enabled !== false,
          }));
        // 启停第三方音源同理（导入那条路已经清了，这里补启停/删除）
        clearMusicResolveCache();
      } else if (key === 'updateManifest') {
        settings.updateManifest = String(patch.updateManifest || '').trim().slice(0, 500);
      } else if (key === 'updateSourceMode') {
        // 只认这几种，别的值一律回到「自动」——多一个拼错的值就会让更新链变哑巴。
        const mode = String(patch.updateSourceMode || '').trim();
        settings.updateSourceMode = ['auto', 'mirrorchyan', 'gitee', 'jsdelivr', 'github', 'custom'].includes(mode)
          ? mode
          : 'auto';
      } else if (key === 'mirrorchyanRid') {
        // RID 是官方分配的短标识（字母数字），顺手清掉空白和奇怪的字符
        settings.mirrorchyanRid = String(patch.mirrorchyanRid || '').trim().replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64);
      } else if (key === 'mirrorchyanCdk') {
        /*
         * 用户 CDK。它是凭证：既不能进日志（查到 url 会被脱敏打印），也不能截断成
         * 一半——截断后用户看到「填了但用不了」比不填更难受。这里只去首尾空白。
         */
        settings.mirrorchyanCdk = String(patch.mirrorchyanCdk || '').trim().slice(0, 128);
      } else if (key === 'proxyRules') {
        settings.proxyRules = normalizeProxyRules(patch.proxyRules);
      } else if (key === 'autoCheckUpdate') {
        settings.autoCheckUpdate = patch.autoCheckUpdate !== false;
      } else if (key === 'notesSeenVersion') {
        // 更新公告弹窗「看过了」的版本号：存到 settings 里，跟着 launcher-data.json 走，
        // 所以升级覆盖 resources/app 之后这个标记不会丢，同一个版本只弹一次。
        settings.notesSeenVersion = String(patch.notesSeenVersion || '').trim().replace(/^v/i, '').slice(0, 32);
      } else if (key === 'updateSnoozeVersion') {
        settings.updateSnoozeVersion = String(patch.updateSnoozeVersion || '').trim().replace(/^v/i, '').slice(0, 32);
      } else if (key === 'updateSnoozeUntil') {
        settings.updateSnoozeUntil = Number(patch.updateSnoozeUntil) || 0;
      } else if (key === 'downloadLimitKBps') {
        /*
         * 下载限速。上限按 100 MB/s 截：再高已经超过家用宽带上限，
         * 而填个天文数字只会让「限速开着」变成摆设。0 = 不限速。
         */
        const value = Number(patch.downloadLimitKBps);
        settings.downloadLimitKBps = Number.isFinite(value)
          ? Math.max(0, Math.min(102400, Math.round(value)))
          : 0;
      } else if (key === 'downloadDir') {
        const dir = String(patch.downloadDir || '').trim();
        if (dir) {
          await fsp.mkdir(dir, { recursive: true });
          settings.downloadDir = dir;
        }
      } else if (key === 'lastPage') {
        if (
          [
            'home',
            'start',
            'library',
            'servers',
            'gacha',
            'song',
            'downloads',
            'news',
            'announcements',
            'settings',
          ].includes(patch.lastPage)
        ) {
          settings.lastPage = patch.lastPage;
        }
      } else if (key === 'audioLanguages') {
        // 必须是数组：兜底分支走的是 Boolean()，数组会被压成 true
        settings.audioLanguages = normalizeAudioLanguages(patch.audioLanguages);
      } else {
        settings[key] = Boolean(patch[key]);
      }
    }
    applyNativeTheme(settings.theme);
    applyLoginItem(settings);
    applyTitlebar();
    applyUiScale(settings.uiScale);
    // 先推状态再写盘：渲染进程要的是设置本身，没必要等磁盘 IO。
    // 原来顺序反了，机械盘上点一次主题要等几十毫秒才有反应。
    pushState(true);
    await store.saveNow();
    // 代理改完立刻生效，不用重启：用户点保存就能看到联网行为变化
    if ('proxyRules' in patch) await applyProxySettings();
    // 限速同理：立刻生效，正在跑的下载下一块就按新上限走（不用等下次下载）
    if ('downloadLimitKBps' in patch) applyDownloadLimit();
    return snapshot();
  });

  ipcMain.handle('gacha:sync', async (_event, input = {}) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game || !['genshin', 'starrail', 'zzz', 'endfield'].includes(game.builtinKey)) {
      throw new Error('这个游戏没有接入官方抽卡同步');
    }
    if (game.builtinKey === 'endfield') {
      let auth = input?.auth;
      if (!auth) {
        try {
          auth = JSON.parse(await loadSecret('endfield'));
        } catch {
          auth = null;
        }
      }
      // 优先读游戏自己写的日志：只要玩家打开过一次抽卡记录，
      // 里面就有最新的 u8_token，完全不需要弹网页登录窗口。
      if (!auth?.token) {
        try {
          const fromLog = readEndfieldTokenFromLog();
          if (fromLog?.token) auth = fromLog;
        } catch {
          /* 日志不存在或格式变化时忽略 */
        }
      }
      if (!auth?.token) {
        // 只有真正拿不到 token 才需要用户介入。
        // Electron 的 invoke 会丢掉自定义 error.code，所以用结构化结果返回。
        return {
          ok: false,
          needLogin: true,
          error: '没有读到终末地抽卡凭据。请先在游戏里打开一次「抽卡记录」页面，再回来点同步；如果仍然失败，再选择网页登录。',
        };
      }
      try {
        const result = await syncEndfieldGacha({ userData: app.getPath('userData'), auth });
        await saveSecret('endfield', JSON.stringify(auth)).catch(() => {});
        return { ok: true, ...result };
      } catch (error) {
        if (/token|40100|登录|到期|invalid/i.test(String(error.message))) {
          await saveSecret('endfield', '').catch(() => {});
          // 凭据失效：告诉界面可以走网页登录，而不是让用户面对一段报错
          return {
            ok: false,
            needLogin: true,
            error: String(error.message || '终末地登录已失效'),
          };
        }
        throw error;
      }
    }
    const server = (game.servers || []).find((item) => item.id === game.activeServerId);
    let installRoot = server?.root;
    if (!installRoot && game.target) installRoot = path.dirname(game.target);
    if (!installRoot && server?.path) installRoot = path.dirname(server.path);
    if (!installRoot || !targetExists(server?.path)) {
      throw new Error('先配置这个游戏的客户端路径');
    }
    return syncGacha({
      game: game.builtinKey,
      installRoot,
      userData: app.getPath('userData'),
    });
  });

  ipcMain.handle('endfield:update-game', async (_event, options = {}) => {
    const game = store.data.games.find((item) => item.builtinKey === 'endfield');
    const server = game?.servers.find((item) => item.id === game.activeServerId);
    if (!game || !server?.root || !targetExists(server.path)) {
      throw new Error('先配置终末地客户端路径');
    }
    if (running.has(game.id)) throw new Error('请先退出终末地再更新');
    /*
     * 从启动页那颗「更新游戏」进来时会带 jobId：跟着发一份到 predownload:progress，
     * 启动页按钮才能显示百分比（它只认这条通道 + 自己的 jobId）。不带 jobId 的老入口
     * （服务器面板里的按钮）走原来的 endfield:game-progress，行为不变。
     */
    const jobId = String(options?.jobId || '');
    /*
     * 两个面板共用同一条出口：老入口只发 endfield:game-progress（服务器面板的 busy toast
     * 在听），带 jobId 的再发一份 predownload:progress 给启动页那个进度面板。
     * 补上 phase：endfield-packs 原来只发 current/processed/total/downloadedBytes，
     * 没有 phase，界面拿到事件也拼不出「下载更新 42%」——只能落回「正在更新…」。
     */
    const meter = require('./progress-meter').createMeter((progress) => {
      send('endfield:game-progress', progress);
      if (!jobId) return;
      send('predownload:progress', {
        jobId,
        ...progress,
        // 面板读的是 bytesDone，这里把下载字节映射过去，按钮才有百分比
        bytesDone: Number(progress?.bytesDone ?? progress?.downloadedBytes) || 0,
      });
    });
    const emit = (progress) => {
      const withPhase = { ...progress };
      if (!withPhase.phase) {
        // 有 downloadedBytes 认为是真在下网，否则是在比对/复用已有文件
        withPhase.phase = Number(progress?.downloadedBytes) > 0 ? 'download' : 'install';
      }
      meter(withPhase);
    };
    /*
     * 预下载过的 Diffs/ 里就是这次更新的 zip 分包，先走它：同名同 size 同 md5 直接命中，
     * 不用重新下载。没预下载过时 hasCache 为 false，整段跳过，还是原来的逐文件校验更新。
     */
    const predownloadRoot = predownload.endfieldInstallRoot(game, server);
    if (predownload.hasCache({ gameKey: 'endfield', channel: server.channel, installRoot: predownloadRoot })) {
      try {
        const applied = await predownload.apply({
          gameKey: 'endfield',
          channel: server.channel,
          installRoot: predownloadRoot,
          onProgress: (progress) => emit(progress),
        });
        if (applied?.ok) {
          const version = String(applied.version || '');
          server.predownload = null;
          if (version) {
            game.version = version;
            game.versionName = version;
          }
          await store.saveNow();
          pushState(true);
          // 预下载内容落进真实安装目录后，链接运行时要失效（与 predownload:apply 同一语义）
          invalidateRuntimesAfterUpdate(game);
          return applied;
        }
      } catch (error) {
        /*
         * 预下载内容用不上，回落成逐文件全量更新。
         *
         * 这条回落原来只写一行 launch.log —— 用户那边看到的是「我明明预下载完了，
         * 怎么更新还是下了几十 G」，没有任何提示。现在把原因报上去，界面能说明白；
         * 同时顺手把用不上的 Diffs 清掉（apply 失败说明这批包跟当前清单对不上，
         * 留着只会在下一次检测里继续被当成「可以应用」）。
         */
        const reason = String(error?.message || error || '未知原因');
        writeLaunchLog(`endfield update: predownload apply fallback: ${reason}`);
        emit({ phase: 'predownload', current: `预下载内容无法应用（${reason}），改为逐文件更新` });
        try {
          await predownload.clear({ gameKey: 'endfield', installRoot: predownloadRoot });
        } catch {
          /* 清不掉不影响后面的更新 */
        }
        if (server.predownload) {
          server.predownload = null;
          await store.saveNow();
          pushState(true);
        }
      }
    }
    const result = await updateEndfieldGame({
      root: server.root,
      channel: server.channel,
      // 同机另一份终末地（官服 / B服 / 国际服）已经在目标版本时，相同内容直接硬链接，不再重下
      linkSources: externalLinkSources(game, server, server.root),
      onProgress: (progress) => emit(progress),
    });
    /*
     * 更新完把版本号落库。以前这里直接 return，卡片版本要等下一次检测才动，
     * 用户看到「已更新到 1.5.0」的提示、卡片却还挂旧版本，以为没更上。
     */
    const version = String(result?.version || '');
    if (result?.ok && version) {
      game.version = version;
      game.versionName = version;
      game.lastOfficialSync = Date.now();
      // Diffs 里的预下载包已经用掉了，状态跟着清掉，别再显示「可以应用」
      server.predownload = null;
      await store.saveNow();
      pushState(true);
    }
    // 与其余逐文件更新落点统一：skipped（本地已是最新）时不触发无谓的运行时重建
    if (result?.ok && !result?.skipped) invalidateRuntimesAfterUpdate(game);
    return result;
  });

  ipcMain.handle('arknights:update-game', async (_event, options) => {
    const game = store.data.games.find((item) => item.builtinKey === 'arknights');
    const server = game?.servers.find((item) => item.id === game.activeServerId);
    if (!game || !server?.root || !targetExists(server.path)) {
      throw new Error('先配置明日方舟客户端路径');
    }
    if (running.has(game.id)) throw new Error('请先退出明日方舟再更新');
    /*
     * 进度双路输出：老入口只发 arknights:game-progress（原来全仓没人订阅，界面一直
     * 停在「正在准备更新…」），从启动页那颗按钮进来时带 jobId，再发一份
     * predownload:progress 给进度面板 —— 和终末地那条桥保持同一形状。
     */
    const jobId = String(options?.jobId || '');
    const emit = require('./progress-meter').createMeter((progress) => {
      const withPhase = { ...progress };
      if (!withPhase.phase) {
        withPhase.phase = Number(progress?.downloadedBytes) > 0 ? 'download' : 'install';
      }
      send('arknights:game-progress', withPhase);
      if (!jobId) return;
      send('predownload:progress', {
        jobId,
        ...withPhase,
        bytesDone: Number(withPhase.bytesDone ?? withPhase.downloadedBytes) || 0,
      });
    });
    /*
     * 国际服（EN / JP / KR）走 Yostar 自己的那套清单，和国服的鹰角清单毫无关系：
     * 逐文件 CRC64 + 官方 game-launcher-config.json / manifest.json 元数据，
     * 主程序和平台库都和国服不是一份文件。绝不能拿国服清单往它们目录里 in-place 写。
     */
    if (yostarPacks.isYostarChannel(server.channel)) {
      const result = await yostarPacks.updateGame({
        profile: server.channel,
        installRoot: server.root,
        allowDelete: true,
        onProgress: (progress) => emit(progress),
      });
      if (result?.ok) {
        game.version = String(result.version || game.version || '');
        game.versionName = game.version;
        await store.saveNow();
        pushState(true);
      }
      return result;
    }
    // profileForChannel('arknights') 是国服全量清单（13749 文件/25.4GB）的专用哨兵值，
    // 绝不能换成 server.channel（那会误拉终末地清单）。台服由第三个发行商发行、
    // 协议未验证，在发起任何网络请求或写盘之前先挡住，避免被国服清单 in-place 覆盖刷坏。
    if (!ARKNIGHTS_CN_CHANNELS.includes(server.channel)) {
      throw new Error('明日方舟台服暂不支持在此更新本体，请前往对应官网');
    }
    /*
     * 明日方舟本体走的是鹰角同一套加密逐文件清单（GET {base}/game_files），
     * 与终末地同构，直接用 updateEndfieldGame + profileForChannel('arknights') 重放即可，
     * 不需要拉起官方启动器。启动前的渠道 SDK 注入由 games:launch 里的 ensureArknightsRuntime 负责，
     * 更新完再启动依旧能正常进游戏。
     */
    const result = await updateEndfieldGame({
      root: server.root,
      channel: 'arknights',
      linkSources: externalLinkSources(game, server, server.root),
      onProgress: (progress) => emit(progress),
    });
    if (result?.ok && !result?.skipped) invalidateRuntimesAfterUpdate(game);
    return result;
  });

  /*
   * 全游戏通用的「修复游戏」：按官方清单逐文件校验，重新下载损坏/缺失的文件。
   * - 终末地 / 明日方舟：直接复用鹰角那套加密逐文件清单（force 重校，版本号没变也会重扫）
   * - 米哈游系（原神 / 星铁 / 绝区零 / 崩坏3）：走 Sophon 逐 chunk 校验补齐
   * - 异环：本体修复由官方启动器接管，这里直接拉起它
   */
  ipcMain.handle('games:repair-game', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到该游戏');
    const server =
      game.servers.find((item) => item.id === input?.serverId) ||
      game.servers.find((item) => item.id === game.activeServerId) ||
      game.servers[0];
    if (!server?.root || !server.path || !targetExists(server.path)) {
      throw new Error('这个服务器还没有可修复的客户端');
    }
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再修复');
    const key = game.builtinKey;
    if (key === 'endfield') {
      const result = await updateEndfieldGame({
        root: server.root,
        channel: server.channel,
        force: true,
        // 修复时整盘重扫，正是跨渠道复用收益最大的场景：同内容文件直接链，不用重下
        linkSources: externalLinkSources(game, server, server.root),
        onProgress: (progress) => send('repair:progress', progress),
      });
      // 逐文件 rm+rename 换了 inode，硬链接运行时镜像必须失效重建
      if (result?.ok && !result?.skipped) invalidateRuntimesAfterUpdate(game);
      return result;
    }
    if (key === 'arknights') {
      /*
       * 国际服（EN / JP / KR）：走 Yostar 自己的 updateGame 做全量校验补齐。
       * 那边没有「每个文件都能单独下」的公开接口 —— 官方只给整文件 CRC64 清单，
       * 所以修复就是「按清单对每个文件算 CRC64，不一致的重下」。allowDelete 传 false：
       * 修复的目的是补缺补坏，不该顺手删东西（删清单由「更新本体」那条链负责）。
       */
      if (yostarPacks.isYostarChannel(server.channel)) {
        const result = await yostarPacks.updateGame({
          profile: server.channel,
          installRoot: server.root,
          allowDelete: false,
          fullVerify: true,
          onProgress: (progress) => send('repair:progress', progress),
        });
        if (result?.ok) {
          game.version = String(result.version || game.version || '');
          game.versionName = game.version;
          await store.saveNow();
          pushState(true);
        }
        return { ...result, repaired: true };
      }
      // 修复带 force:true 会整盘重扫、逐文件 in-place 覆盖；台服由第三个发行商发行、
      // 协议未验证，绝不能被国服全量清单刷坏。'arknights' 是国服清单专用哨兵值，保持原样不动。
      if (!ARKNIGHTS_CN_CHANNELS.includes(server.channel)) {
        throw new Error('明日方舟台服暂不支持在此修复本体，请前往对应官网');
      }
      const result = await updateEndfieldGame({
        root: server.root,
        channel: 'arknights',
        force: true,
        linkSources: externalLinkSources(game, server, server.root),
        onProgress: (progress) => send('repair:progress', progress),
      });
      if (result?.ok && !result?.skipped) invalidateRuntimesAfterUpdate(game);
      return result;
    }
    if (['genshin', 'starrail', 'zzz', 'bh3'].includes(key)) {
      const signal = { cancelled: false };
      const result = await prepareSophon({
        gameKey: key,
        channel: server.channel,
        baseRoot: server.root,
        targetRoot: server.root,
        cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
        audioLanguages: store.data?.settings?.audioLanguages,
        includeStoryResources: storyResourcesEnabled(game, server),
        // 修复要查的是「中间分块坏掉」这类问题，只比首尾两块查不出来，必须整份校验
        verifyAll: true,
        signal,
        onProgress: (progress) => send('repair:progress', progress),
      });
      game.version = result.tag;
      game.versionName = result.tag;
      server.sophonVersion = result.tag;
      game.lastOfficialSync = Date.now();
      await store.saveNow();
      pushState(true);
      // 修复换了本体文件，链接运行时若有标记也应失效（非终末地当前为 no-op）
      invalidateRuntimesAfterUpdate(game);
      return { ok: true, version: result.tag, updated: result.files, root: server.root };
    }
    if (key === 'neverness') {
      const root = nevernessChannels.findConfigRoot(server?.root || server?.path || game.target || '');
      if (!root) throw new Error('没有找到异环安装目录，先在服务器设置里指好游戏路径');
      const launcher = path.join(root, 'NTELauncher.exe');
      if (!fs.existsSync(launcher)) throw new Error(`没有找到官方启动器：${launcher}`);
      const error = await shell.openPath(launcher);
      if (error) throw new Error(`官方启动器打开失败：${error}`);
      return { ok: true, official: true };
    }
    throw new Error('这个游戏暂不支持修复');
  });

  ipcMain.handle('endfield:update-official-packs', async (_event, options = {}) => {
    const root = endfieldPackWritableRoot();
    /*
     * 默认只补本机还缺的那几个渠道 —— 全新机器上五个一起下是约 400MB，把第一次
     * 用的人直接劝退。真要备齐是用户在弹窗里点「下载全部」（all=true）的事。
     */
    const missing = Object.entries(ENDFIELD_PACK_NAMES)
      .filter(([channel]) => !(store.data.settings.endfieldPackChannels || []).includes(channel))
      .map(([, packName]) => packName);
    const result = await updateEndfieldPacks({
      root,
      only: options.all ? null : missing,
      onProgress: (progress) => send('endfield:pack-progress', progress),
    });
    store.data.settings.endfieldPackRoot = root;
    refreshPackChannels();
    await store.saveNow();
    pushState(true);
    return { ...result, requested: options.all ? 'all' : 'missing', missingCount: missing.length };
  });

  ipcMain.handle('endfield:pack-usage', async () => describePackUsage());

  /*
   * 释放渠道包占的空间。
   *
   * 内置包（随安装包分发的那份）默认装在 %LOCALAPPDATA%\Programs 下，是用户自己的
   * 目录，可以直接删，不需要管理员。删完界面上就是「按需下载」，想要了随时能下回来。
   * 连带删掉 .state 里的记录：不然 updateProfile 会以为这个包还是最新的，
   * 重新下载时直接跳过，结果就是「显示能切，实际缺文件」。
   */
  ipcMain.handle('endfield:delete-packs', async (_event, options = {}) => {
    const scope = ['endfield', 'arknights', 'all'].includes(options.scope)
      ? options.scope
      : 'endfield';
    /*
     * 单渠道释放：管理窗口里每一行都有自己的「释放」，只删那一个目录。
     * 目录名过一遍白名单再拼路径 —— 这个值来自渲染层，不能直接当路径用。
     */
    const allDirs = new Set([...ENDFIELD_PACK_DIRS, ...ARKNIGHTS_PACK_DIRS]);
    const requested = Array.isArray(options.directories)
      ? options.directories.filter((name) => allDirs.has(String(name)))
      : [];
    const dirs = requested.length
      ? requested
      : scope === 'arknights'
        ? ARKNIGHTS_PACK_DIRS
        : scope === 'endfield'
          ? ENDFIELD_PACK_DIRS
          : [...ENDFIELD_PACK_DIRS, ...ARKNIGHTS_PACK_DIRS];
    const roots = [endfieldPackWritableRoot(), builtinPackRoot()].filter(Boolean);
    let freed = 0;
    const removed = [];
    for (const root of roots) {
      for (const name of dirs) {
        const dir = path.join(root, name);
        if (!fs.existsSync(dir)) continue;
        freed += dirSize(dir);
        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.rm(path.join(root, '.state', `${name}.json`), { force: true }).catch(() => {});
        removed.push(name);
      }
    }
    refreshPackChannels();
    refreshArknightsPackChannels();
    pushState(true);
    return { ok: true, freed, removed: Array.from(new Set(removed)) };
  });

  /*
   * 明日方舟的两个渠道包。和终末地分开成一条：这两条是照着 Xel-Launcher 的
   * 清单配的，虽然实测取得到（78.0.0），但还没在真机切服上验证过，
   * 让用户单独点、单独看结果，不跟着终末地一起静默发生。
   */
  ipcMain.handle('arknights:update-packs', async () => {
    const root = endfieldPackWritableRoot();
    const results = [];
    for (const [profile, label] of [
      [ARKNIGHTS_OFFICIAL_PROFILE, '官服'],
      [ARKNIGHTS_BILIBILI_PROFILE, 'B服'],
    ]) {
      if (!(await verifyArknightsSource(profile))) {
        results.push({ iconName: profile.iconName, skipped: true, error: '官方接口上没有这份清单' });
        continue;
      }
      try {
        await updateEndfieldProfile(profile, root, (progress) =>
          send('endfield:pack-progress', {
            ...progress,
            directory: profile.directory,
            current: `[${label}] ${progress.current || ''}`,
          })
        );
        results.push({ iconName: profile.iconName, skipped: false, updated: true });
      } catch (error) {
        results.push({ iconName: profile.iconName, skipped: false, error: error.message });
      }
    }
    refreshPackChannels();
    pushState(true);
    return { ok: true, results };
  });

  ipcMain.handle('endfield:sync-packs', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择 XelLauncher 的 load 文件夹（用于同步渠道包更新）',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    const source = result.filePaths[0];
    const names = ['EndOfficial', 'EndBilibili', 'EndGlobal', 'EndPlay', 'EndSteam'];
    const target = path.join(app.getPath('userData'), 'endfield-packs');
    const stateFile = (root) => path.join(root, '.state');
    const readState = (root, name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(stateFile(root), `${name}.json`), 'utf8'));
      } catch {
        return null;
      }
    };
    const updated = [];
    const skipped = [];
    for (const name of names) {
      const sourceDir = path.join(source, name);
      if (!fs.existsSync(path.join(sourceDir, 'U8Data'))) continue;
      const sourceState = readState(source, name);
      const targetState = readState(target, name);
      const sourceTime = Date.parse(sourceState?.UpdatedAtUtc || 0) || 0;
      const targetTime = Date.parse(targetState?.UpdatedAtUtc || 0) || 0;
      if (
        fs.existsSync(path.join(target, name, 'U8Data')) &&
        targetTime >= sourceTime &&
        targetState?.Version === sourceState?.Version
      ) {
        skipped.push(name);
        continue;
      }
      await fsp.rm(path.join(target, name), { recursive: true, force: true });
      await fsp.cp(sourceDir, path.join(target, name), { recursive: true, force: true });
      updated.push(name);
    }
    if (updated.length) {
      await fsp.mkdir(stateFile(target), { recursive: true });
      for (const name of updated) {
        const state = readState(source, name);
        if (state) {
          await fsp.writeFile(
            path.join(stateFile(target), `${name}.json`),
            JSON.stringify(state, null, 2),
            'utf8'
          );
        }
      }
      store.data.settings.endfieldPackRoot = target;
      refreshPackChannels();
      await store.saveNow();
      pushState(true);
    }
    return { ok: true, updated, skipped, path: target };
  });

  ipcMain.handle('endfield:import-packs', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择 XelLauncher 的 load 文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    const source = result.filePaths[0];
    const names = ['EndOfficial', 'EndBilibili', 'EndGlobal', 'EndPlay', 'EndSteam'];
    const found = names.filter((name) => fs.existsSync(path.join(source, name, 'U8Data')));
    if (!found.length) throw new Error('这个目录里没有找到 EndOfficial / EndBilibili / EndGlobal 等渠道包');
    const target = path.join(app.getPath('userData'), 'endfield-packs');
    await fsp.mkdir(target, { recursive: true });
    for (const name of found) {
      await fsp.cp(path.join(source, name), path.join(target, name), {
        recursive: true,
        force: true,
      });
      /*
       * 顺手把状态文件带过来：从另一台机器整个 endfield-packs 拷过来的机器，
       * 差异渠道（国际服 / Play / Steam）靠它证明「这份包是按整套差异下完的」，
       * 不带过来的话会被判成待下载、白问一遍。
       */
      try {
        await fsp.mkdir(path.join(target, '.state'), { recursive: true });
        await fsp.cp(
          path.join(source, '.state', `${name}.json`),
          path.join(target, '.state', `${name}.json`),
          { force: true }
        );
      } catch {
        /* XelLauncher 的 load 目录没有状态文件，正常 */
      }
    }
    store.data.settings.endfieldPackRoot = target;
    refreshPackChannels();
    await store.saveNow();
    pushState(true);
    return { ok: true, imported: found, path: target };
  });

  /*
   * 渠道包按需下载（2.5.0）：安装包不再内置这 632 MB，第一次切到某个服时
   * 由渲染层先问一次「有没有 / 要下多少」，用户点了才下。
   * 三条 IPC 分开是刻意的：查状态不该顺带下载，下载不该阻塞查状态。
   */
  ipcMain.handle('endfield:channel-pack-status', async (_event, input) => {
    const { game, channel } = input || {};
    return channelPackStatus(String(game || ''), String(channel || ''));
  });

  ipcMain.handle('endfield:channel-pack-download', async (_event, input) => {
    const { game, channel } = input || {};
    // 进度单独走一条通道：切服时的 busy toast 也在用 endfield:progress，
    // 两套进度混在一条通道里，界面会收到对方的百分比
    return downloadChannelPack(String(game || ''), String(channel || ''), (progress) => {
      if (win && !win.isDestroyed()) win.webContents.send('endfield:pack-progress', progress);
    });
  });

  ipcMain.handle('endfield:channel-pack-cancel', async (_event, input) => {
    const { game, channel } = input || {};
    return { ok: cancelChannelPack(String(game || ''), String(channel || '')) };
  });

  /** 设置页「释放空间」：列出现在占了哪些渠道包、各多大。 */
  ipcMain.handle('endfield:channel-pack-list', async () => {
    const rows = [];
    for (const game of ['endfield', 'arknights']) {
      const channels =
        game === 'arknights'
          ? Object.keys(ARKNIGHTS_PACK_CHANNELS)
          : Object.keys(ENDFIELD_PACK_NAMES);
      for (const channel of channels) {
        const spec = channelPackSpec(game, channel);
        if (!spec) continue;
        const root = endfieldPackCandidateRoots().find((item) => channelPackReady(spec, item));
        rows.push({
          game,
          channel,
          directory: spec.directory,
          label: spec.label,
          ready: Boolean(root),
          root: root || '',
          bytes: root ? dirSize(path.join(root, spec.directory)) : 0,
        });
      }
    }
    return { ok: true, rows };
  });

  /**
   * 切服前的唯一入口：这次切换需不需要先下渠道包、要下多少。
   *
   * 只回答「需不需要」（channelPackNeededFor），不下载；
   * 用户点了弹窗里的下载才走 endfield:channel-pack-download。
   */
  ipcMain.handle('servers:channel-pack-plan', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    const server = game && (game.servers || []).find((item) => item.id === input?.serverId);
    if (!game || !server) return { needed: false };
    const need = channelPackNeededFor(game, server);
    if (!need) return { needed: false };
    const status = await channelPackStatus(need.game, need.channel);
    if (status.ready) return { needed: false, ready: true };
    return { needed: true, ...status, serverName: server.name };
  });

  ipcMain.handle('media:url', async (_event, source) => {
    const value = String(source || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return pathToFileURL(path.resolve(value)).href;
  });

  ipcMain.handle('games:add', async (_event, input) => {
    const game = normalizeGame(input);
    game.id = crypto.randomUUID();
    game.createdAt = new Date().toISOString();
    game.launchCount = 0;
    game.playSeconds = 0;
    game.lastPlayed = null;
    game.demo = false;
    ensureServers(game);
    store.data.games.unshift(game);
    await store.saveNow();
    pushState(true);
    return publicGame(game);
  });

let neteaseSession = { apiBase: '', cookie: '' };
loadSecret('netease')
  .then((raw) => {
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.cookie) neteaseSession = { apiBase: parsed.apiBase || '', cookie: parsed.cookie };
  })
  .catch(() => {});

function normalizeNeteaseBase(value) {
  return String(value || 'http://127.0.0.1:3100').trim().replace(/\/+$/, '');
}

async function neteaseGet(apiBase, route, params = {}) {
  const base = normalizeNeteaseBase(apiBase);
  const query = new URLSearchParams({ ...params, timestamp: String(Date.now()) });
  /*
   * 把登录 cookie 带上，否则 /login/status 会返回未登录，
   * /user/playlist 就会是空列表。
   *
   * neteaseSession.apiBase 可能是空的（比如从二维码登录后没记下地址，
   * 或者地址是从 localStorage 默认值推出来的），这时只要有 cookie
   * 就应该带上 —— 之前这里要求两个地址完全相等，
   * 结果地址对不上时 cookie 被丢掉，表现就是「歌单是空的」。
   */
  if (neteaseSession.cookie) {
    const saved = normalizeNeteaseBase(neteaseSession.apiBase);
    if (!neteaseSession.apiBase || saved === base) {
      query.set('cookie', neteaseSession.cookie);
    }
  }
  const response = await fetch(`${base}${route}?${query.toString()}`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`本地网易云 API HTTP ${response.status}`);
  const json = await response.json();
  // 拿到不属于网易云 API 的响应时早点报错，别让界面显示成「歌单是空的」
  if (!looksLikeNeteaseApi(json)) {
    throw new Error(
      `本地 API 地址 ${base} 上跑的不是网易云服务（可能是别的程序占用了这个端口），请在登录窗口里换一个端口`
    );
  }
  return json;
}

/**
 * 判断某个地址上跑的是不是一个真正的 NeteaseCloudMusicApi。
 *
 * 之前这里只看 HTTP 状态码：只要 /login/status 返回 2xx 就认为服务已就绪。
 * 但 3000 端口常被别的本地服务占着（例如 QQ Agent 的 snowluma），
 * 它也回一份带 code/account 的 JSON，于是启动器会「复用」它，
 * 之后所有歌单 / 搜索请求都拿到 unauthorized 或空数据。
 *
 * 真正的网易云 API，/login/status 的响应形状是固定的：
 *   { data: { code, account: { id, userName, anonimousUser, ... }, profile } }
 * 特征是：code 在 data 里、account 嵌在 data 下、账号对象带 anonimousUser 之类的字段。
 * 别的服务很难同时长成这样，所以用「形状」而不是「有没有 code」来判别。
 */
function looksLikeNeteaseApi(json) {
  if (!json || typeof json !== 'object') return false;
  // snowluma 之类的失败响应
  if (json.status === 'failed' || json.retcode !== undefined) return false;

  // 典型形状：data.code + data.account
  const data = json.data;
  if (data && typeof data === 'object') {
    const code = Number(data.code);
    if (Number.isFinite(code)) {
      // 未登录时 account 为空、只有 code
      const account = data.account;
      if (!account) return code === 200 || code === 301;
      if (typeof account !== 'object') return false;
      // 账号对象必须带网易云特征字段
      return (
        account.id !== undefined &&
        ('anonimousUser' in account ||
          'whitelistAuthority' in account ||
          'tokenVersion' in account ||
          'baoyueVersion' in account)
      );
    }
  }

  /*
   * 其余接口（playlist / search 等）直接返回顶层 code。
   * 这里故意不接受「顶层 code + 顶层 account」：
   * /login/status 的真响应一定有 data 包装，而没有 data 包装、
   * 却带着顶层 account 的，正是 snowluma 那一类冒牌服务。
   */
  const topCode = Number(json.code);
  if (Number.isFinite(topCode) && !('account' in json)) return true;

  return false;
}

async function probeNeteaseApi(base, timeout = 1200) {
  try {
    const response = await fetch(`${base}/login/status`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return false;
    const json = await response.json().catch(() => null);
    return looksLikeNeteaseApi(json);
  } catch {
    return false;
  }
}

/*
 * 点歌预热入口挂到 globalThis：did-finish-load 的 3 秒预热在个别环境下运行于
 * 重新求值的 main.js 闭包里，直接引用本文件的函数绑定会 ReferenceError（实测
 * 反复出现在 data/crash.log）。闭包在定义处创建、作用域正确，从桥上调用最稳。
 */
globalThis.__hxlNeteaseWarmup = () => startNeteaseService(normalizeNeteaseBase()).catch(() => {});

async function startNeteaseService(apiBase) {
  const base = normalizeNeteaseBase(apiBase);
  if (await probeNeteaseApi(base)) return { started: false, apiBase: base, running: true };
  const candidates = [
    path.join(app.getPath('userData'), 'NeteaseCloudMusicApi'),
    path.join(app.getPath('userData'), 'netease-api'),
    path.join(process.env.USERPROFILE || '', 'NeteaseCloudMusicApi'),
    path.join(process.cwd(), 'NeteaseCloudMusicApi'),
    path.join(process.resourcesPath || '', 'NeteaseCloudMusicApi'),
    path.join(process.resourcesPath || '', 'netease-api'),
    path.join(app.getAppPath(), 'netease-api'),
  ];
  for (const dir of candidates) {
    const entry = ['app.js', 'server.js', 'index.js']
      .map((name) => path.join(dir, name))
      .find((file) => fs.existsSync(file));
    if (!entry) continue;
    const port = new URL(base).port || '3000';
    neteaseServiceProcess = spawn(process.execPath, [entry], {
      cwd: dir,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: port,
        HOST: '127.0.0.1',
      },
    });
    neteaseServiceProcess.unref();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await probeNeteaseApi(base, 1000)) return { started: true, apiBase: base, running: true };
    }
    throw new Error(
      `本地服务已启动，但还没有响应（端口 ${port}）。如果这个端口被其它程序占用，请换一个端口再试`
    );
  }
  throw new Error(
    '没有找到 NeteaseCloudMusicApi。请把它下载到启动器数据目录下的 NeteaseCloudMusicApi 文件夹，或手动运行后填写地址。'
  );
}

/** 一次查多少个播放地址：太多 id 拼在 URL 里会被本地 API 拒。 */
const NETEASE_URL_BATCH = 200;

  ipcMain.handle('media:netease-playlist', async (_event, input) => {
    const apiBase = String(input?.apiBase || 'http://127.0.0.1:3100').replace(/\/+$/, '');
    const rawUrl = String(input?.url || '');
    const match = rawUrl.match(/(?:playlist\?id=|\/playlist\/)(\d+)/i) || rawUrl.match(/id=(\d+)/);
    const playlistId = match?.[1];
    if (!playlistId) throw new Error('没有识别出网易云歌单 ID，请粘贴完整歌单链接');
    const detail = await neteaseGet(apiBase, '/playlist/detail', { id: playlistId });
    const playlist = detail.playlist || detail.result?.playlist;
    const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
    if (!tracks.length) throw new Error('歌单里没有歌曲，或本地 API 未登录/不可用');
    /*
     * 以前这里写的是 tracks.slice(0, 100)：不管歌单多少首都只导前 100 首，
     * 用户贴个八百首的链接进来，队列里还是 100 首 —— 这就是「只能拿到 100 首」的来源。
     * 现在整单全导，URL 查询按批切分（一次送上千个 id 会把请求撑爆）。
     */
    const level = input?.level || 'exhigh';
    const urlMap = new Map();
    for (let start = 0; start < tracks.length; start += NETEASE_URL_BATCH) {
      const ids = tracks.slice(start, start + NETEASE_URL_BATCH).map((track) => track.id);
      let urlJson = null;
      try {
        urlJson = await neteaseGet(apiBase, '/song/url/v1', { id: ids.join(','), level });
      } catch {
        urlJson = await neteaseGet(apiBase, '/song/url', { id: ids.join(',') });
      }
      for (const item of urlJson?.data || []) {
        urlMap.set(String(item.id), { url: item.url, quality: item.level || level });
      }
    }
    const songs = [];
    for (const track of tracks) {
      const info = urlMap.get(String(track.id));
      if (!info?.url) continue;
      const artists = (track.ar || track.artists || []).map((item) => item.name).filter(Boolean);
      songs.push({
        title: track.name,
        artist: artists.join(' / '),
        cover: String(track.al?.picUrl || track.album?.picUrl || '').replace(/^http:/i, 'https:'),
        neteaseId: track.id,
        quality: info.quality,
        url: info.url,
      });
    }
    return {
      ok: true,
      playlist: playlist.name || '网易云歌单',
      total: tracks.length,
      songs,
      skipped: tracks.length - songs.length,
    };
  });

  ipcMain.handle('netease:service-start', async (_event, apiBase) => startNeteaseService(apiBase));

/**
 * 当前的内置音源开关（settings.musicSources 归一化，缺的键用默认值补齐）。
 * 弹幕点歌 / 音质切换这些不走 music:resolve 的路径也要认这份开关，
 * 否则「停用酷我」只管住了换源竞速，管不住 unblock 兜底。
 */
function currentMusicSourceFlags() {
  return Object.assign(
    { netease: true, migu: true, kuwo: false, kugou: false, qq: false },
    normalizeSourceFlags(store?.data?.settings?.musicSources) || {}
  );
}

/**
 * 跨平台兜底的 flags 感知版：在酷狗 / QQ 上找同名同歌手的免费那一份。
 * 替代 music-platforms.js 的 resolveFallbackUrl——那个写死了两家都试，
 * 没法按音源开关跳过，谁被停用了就整条跳过。
 */
async function crossSourceFallbackUrl(title, artist, flags) {
  const name = String(title || '').trim();
  if (!name) throw new Error('没有歌名，无法换源');
  const keyword = `${name} ${String(artist || '').split('/')[0].trim()}`.trim();
  const tried = [];
  const wants = { title: name, artist: String(artist || '') };
  const tries = [];
  if (flags.kugou !== false) {
    tries.push([
      '酷狗',
      async () => {
        const best = pickBest(await kugouSearch(keyword, 5), wants);
        if (!best) throw new Error('没搜到同名曲');
        if (!sameSongEnough(name, artist, best.title, best.artist)) throw new Error('搜到的不是同一首歌');
        const info = await kugouSongUrl(best.hash);
        return { ...info, title: best.title, artist: best.artist, matched: `${best.title} - ${best.artist}` };
      },
    ]);
  }
  if (flags.qq !== false) {
    tries.push([
      'QQ 音乐',
      async () => {
        const best = pickBest(await qqSearch(keyword, 5), wants);
        if (!best) throw new Error('没搜到同名曲');
        if (!sameSongEnough(name, artist, best.title, best.artist)) throw new Error('搜到的不是同一首歌');
        const info = await qqSongUrl(best.mid);
        return { ...info, title: best.title, artist: best.artist, matched: `${best.title} - ${best.artist}` };
      },
    ]);
  }
  if (!tries.length) throw new Error('酷狗和 QQ 音乐音源都已被停用');
  for (const [label, run] of tries) {
    try {
      return await run();
    } catch (error) {
      tried.push(`${label}：${error.message}`);
    }
  }
  throw new Error(tried.join('；') || '没有可用的替代音源');
}

/**
 * 内置 API 自带的换源：`/song/url/match` 会用 unblockmusic-utils
 * 去别的平台匹配同一首歌的完整音源（会员曲目也能拿到全长）。
 * 拿不到就返回空串，交给上层继续降级。
 */
async function neteaseMatchUrl(apiBase, id) {
  try {
    const json = await neteaseGet(apiBase, '/song/url/match', { id });
    const url = typeof json?.data === 'string' ? json.data : '';
    return url ? String(url).replace(/^http:/i, 'https:') : '';
  } catch {
    return '';
  }
}

/**
 * 取一首歌的播放地址，会员曲目也尽量让它能放。
 *
 * 顺序：
 *   1. 用户选的音质，拿不到就逐级往下降；
 *   2. 只给到试听片段（会员曲目）时，走内置 API 的换源接口取完整音源；
 *   3. 网易云上同一个歌名的其它版本（重制、现场、翻唱），这些通常免费；
 *   4. 酷狗 / QQ 音乐上同名同歌手的免费那一份；
 *   5. 都不行才报错，并把原因说清楚。
 */
async function fetchNeteaseSongUrl(apiBase, id, level = 'exhigh', meta = {}) {
  const allowed = new Set(['standard', 'higher', 'exhigh', 'lossless', 'hires']);
  const wanted = allowed.has(String(level)) ? String(level) : 'exhigh';
  const ladder = [...new Set([wanted, 'exhigh', 'higher', 'standard'])];
  let trial = null;
  // 音源开关：网易云被停用时，原生直链和 unblock 换源都不走，只留跨平台兜底
  const flags = meta.flags || currentMusicSourceFlags();
  const neteaseAllowed = flags.netease !== false;

  for (const quality of neteaseAllowed ? ladder : []) {
    let json = null;
    try {
      json = await neteaseGet(apiBase, '/song/url/v1', { id, level: quality });
    } catch {
      try {
        json = await neteaseGet(apiBase, '/song/url', { id });
      } catch {
        json = null;
      }
    }
    const item = json?.data?.[0];
    if (!item?.url) continue;
    // unblock 可能把地址换成被停用平台的直链，撞上就当这条音质没拿到
    if (disabledSourceOfUrl(item.url, flags)) continue;
    const payload = {
      url: String(item.url),
      level: String(item.level || quality),
      br: Number(item.br) || 0,
      size: Number(item.size) || 0,
      type: String(item.type || ''),
    };
    // 会员曲目在非会员账号下只会给一段试听，先留着当兜底
    if (item.freeTrialInfo) {
      if (!trial) trial = { ...payload, trial: true };
      continue;
    }
    return payload;
  }

  // 2) 换源：拿到完整音源就不必再降级（match 结果同样按开关过滤）
  if (neteaseAllowed) {
    const matched = await neteaseMatchUrl(apiBase, id);
    if (matched && !disabledSourceOfUrl(matched, flags)) {
      return { url: matched, level: 'standard', br: 0, size: 0, type: 'flac', unblocked: true };
    }
  }

  const title = String(meta.title || '').trim();
  const artist = String(meta.artist || '').trim();

  /*
   * 3) 同一个歌名的其它版本（重制 / 现场 / 翻唱）通常没有版权限制。
   *    只按歌名搜出来的列表里混着同名不同曲和别人的翻唱，以前是「第一个能播的就用」，
   *    于是会出现「点了这首、放的是另一首」还毫无提示。先按同歌名 + 同歌手筛一遍。
   */
  if (neteaseAllowed && title) {
    try {
      const search = await neteaseGet(apiBase, '/search', { keywords: `${title} ${artist}`.trim(), limit: 8, type: 1 });
      const list = (search?.result?.songs || []).filter(
        (song) =>
          song?.id &&
          String(song.id) !== String(id) &&
          sameSongEnough(
            title,
            artist,
            song.name,
            (song.ar || song.artists || []).map((a) => a.name).filter(Boolean).join(' / ')
          )
      );
      for (const song of list) {
        if (!song?.id || String(song.id) === String(id)) continue;
        try {
          const alt = await neteaseGet(apiBase, '/song/url/v1', { id: song.id, level: 'standard' });
          const item = alt?.data?.[0];
          if (!item?.url || item.freeTrialInfo || disabledSourceOfUrl(item.url, flags)) continue;
          return {
            url: String(item.url),
            level: String(item.level || 'standard'),
            br: Number(item.br) || 0,
            size: Number(item.size) || 0,
            type: String(item.type || ''),
            // 带上实际用的这份的歌名 / 歌手：渲染层换源后还要再核一次身份
            // （用 matchedTitle/Artist，别覆盖 title/artist，否则队列里的歌名会被换掉）
            matchedTitle: String(song.name || title),
            matchedArtist: (song.ar || song.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
            altOf: {
              id: song.id,
              title: String(song.name || ''),
              artist: (song.ar || song.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
            },
          };
        } catch {
          /* 换下一个版本 */
        }
      }
    } catch {
      /* 搜索失败就走跨平台 */
    }
  }

  // 4) 酷狗 / QQ 音乐上免费的那一份（谁被停用就跳过谁）
  if (title) {
    try {
      const alt = await crossSourceFallbackUrl(title, artist, flags);
      return {
        url: alt.url,
        level: 'standard',
        br: alt.br || 0,
        size: 0,
        type: '',
        // 换到酷狗 / QQ 的那份：歌名歌手单独放 matched* 上，渲染层据此核「还是不是这首」
        matchedTitle: alt.title || title,
        matchedArtist: alt.artist || artist,
        otherSource: { source: alt.source, matched: alt.matched || '' },
      };
    } catch {
      /* 两家都要付费，落到最后统一报错 */
    }
  }

  // 5) 实在没有完整音源，就把 30 秒试听给他，别让播放器干站着
  if (neteaseAllowed && trial) return trial;

  throw new Error('这首歌是会员专享，暂时没有可播放的音源；登录有会员的账号后即可完整播放');
}

  ipcMain.handle('netease:search-song', async (_event, input) => {
    const apiBase = normalizeNeteaseBase(input?.apiBase);
    const keyword = String(input?.keyword || '').trim();
    if (!keyword) throw new Error('没有识别到歌名');
    const search = await neteaseGet(apiBase, '/search', { keywords: keyword, limit: 8, type: 1 });
    const list = search?.result?.songs || [];
    if (!list.length) throw new Error(`没有搜到「${keyword}」`);
    // 弹幕点歌也要认音源开关：解析时把 flags 带进去，停用的平台绝不给地址
    const flags = currentMusicSourceFlags();
    for (const song of list) {
      try {
        const urlInfo = await fetchNeteaseSongUrl(apiBase, song.id, input?.level || 'exhigh', {
          title: song.name,
          artist: (song.ar || song.artists || []).map((item) => item.name).filter(Boolean).join(' / '),
          flags,
        });
        return {
          title: song.name,
          artist: (song.ar || song.artists || []).map((item) => item.name).filter(Boolean).join(' / '),
          cover: String(song.al?.picUrl || song.album?.picUrl || '').replace(/^http:/i, 'https:'),
          neteaseId: song.id,
          quality: urlInfo.level,
          url: urlInfo.url,
        };
      } catch {
        /* try the next result */
      }
    }
    throw new Error(`「${keyword}」没有可播放地址`);
  });

  ipcMain.handle('netease:song-url', async (_event, input) => {
    const apiBase = normalizeNeteaseBase(input?.apiBase);
    return fetchNeteaseSongUrl(apiBase, String(input?.id || ''), input?.level || 'exhigh', {
      title: input?.title,
      artist: input?.artist,
      flags: currentMusicSourceFlags(),
    });
  });

  ipcMain.handle('live:bili-room', async (_event, input) => {
    const raw = String(input?.url || input || '');
    return resolveLiveRoom(raw);
  });

  /*
   * 斗鱼 / 虎牙 / 抖音 / 快手 的弹幕抓取。
   *
   * 用一个隐藏窗口加载直播间网页，只读聊天区文字（见 electron/live-danmaku.js）。
   * 渲染层每 900ms 拉一次新弹幕，断开时调 stop 关掉窗口。
   */
  ipcMain.handle('live:danmaku-start', async (_event, input) => startDanmaku(input));
  ipcMain.handle('live:danmaku-poll', async (_event, id) => pollDanmaku(id));
  ipcMain.handle('live:danmaku-stop', async (_event, id) => stopDanmaku(id));

  /*
   * B 站弹幕鉴权：官方 WebSocket 现在要求 auth 包里带 getDanmuInfo 发的
   * token（key 字段），不带 key 服务器照样接受连接（界面显示"已连接"），
   * 但一条弹幕都不会推——正是"连接成功、观众点歌没反应"的原因。
   * 放主进程走 net.fetch：没有 CORS 限制，还能带上默认会话里的 B 站 cookie。
   */
  /*
   * B 站风控(-352)：getDanmuInfo 只给"看起来像正常浏览器"的请求发鉴权 token，
   * 判断依据主要是 cookie 里有没有 buvid3/buvid4。启动器会话里从没有过 B 站
   * cookie 的用户就会被拦。这里主动领一对写进会话 cookie，让整个会话从此
   * 都以"带身份的浏览器"身份请求 B 站（写一次，长期有效）。
   */
  const BILI_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  async function ensureBiliBuvid() {
    const jar = session.defaultSession;
    const existing = await jar.cookies.get({ url: 'https://live.bilibili.com/' });
    if (existing.some((c) => c.name === 'buvid3')) return;
    const spi = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com/' },
    })
      .then((r) => r.json())
      .catch(() => null);
    const b3 = spi?.data?.b_3;
    if (!b3) return;
    const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    await jar.cookies.setCookie({
      url: 'https://www.bilibili.com/',
      name: 'buvid3',
      value: b3,
      domain: '.bilibili.com',
      path: '/',
      secure: true,
      expirationDate: expires,
    });
    if (spi?.data?.b_4) {
      await jar.cookies.setCookie({
        url: 'https://www.bilibili.com/',
        name: 'buvid4',
        value: spi.data.b_4,
        domain: '.bilibili.com',
        path: '/',
        secure: true,
        expirationDate: expires,
      });
    }
  }

  /*
   * 走 Chromium 网络栈并自动携带会话 cookie 的 GET。
   * 之前用 undici 的 fetch：手动拼 Cookie 头会被当"禁止头"剥掉，
   * 会话里的 buvid/登录态根本发不出去。
   */
  function biliFetchText(url, referer) {
    return new Promise((resolve, reject) => {
      const request = net.request({ url, method: 'GET', useSessionCookies: true });
      request.setHeader('User-Agent', BILI_UA);
      request.setHeader('Referer', referer);
      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      });
      request.on('error', reject);
      request.end();
    });
  }

  /*
   * 取一个 B 站接口的 JSON：先走 Chromium 栈，被拦了自动回落 Node 栈。
   * accept 用来判断"这份结果算不算拿到"，默认是 code===0。
   */
  async function biliGetJson(url, referer, accept) {
    const good = accept || ((parsed) => parsed?.code === 0);
    let detail = '';
    let json = null;
    // 路线一：Chromium 网络栈，自动带会话 cookie，TLS 指纹与真实浏览器一致
    try {
      const { status, body } = await biliFetchText(url, referer);
      detail = `HTTP ${status}`;
      try {
        json = JSON.parse(body);
        if (good(json)) return { json, detail };
      } catch {
        json = null;
        detail += `，返回的不是 JSON：${body.slice(0, 60)}`;
      }
    } catch (error) {
      detail = `Chromium 请求失败：${error.message}`;
    }
    /*
     * 路线二：Node fetch + 手动 Cookie。用户的系统级拦截软件（AdGuard 之类）
     * 会把 Chromium 栈的请求挡成 ERR_BLOCKED_BY_CLIENT，这时走 Node 的
     * 网络栈绕开它；undici 允许显式带 Cookie 头，会话里的 buvid/登录态照样能用。
     */
    try {
      const jarCookies = await session.defaultSession.cookies.get({ url }).catch(() => []);
      const cookie = jarCookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const res = await fetch(url, {
        headers: {
          'User-Agent': BILI_UA,
          Referer: referer,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      const body = await res.text();
      detail += `；Node 备用路线 HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') json = parsed;
      } catch {
        detail += `，非 JSON：${body.slice(0, 60)}`;
      }
    } catch (error) {
      detail += `；Node 备用路线失败：${error.message}`;
    }
    return { json, detail };
  }

  /*
   * WBI 签名：B 站给一批 web 接口加的风控，getDanmuInfo 就在其中。
   *
   * -352 的根因：请求里的 w_rid 算错。w_rid = md5(排序后的 query + mixinKey)，
   * 而 mixinKey 来自一份 64 位的置换表（WBI_MIXIN_TAB）。这份表以前在 idx40 之后
   * 是错的，于是无论登录与否、带不带 buvid，签名永远不对，B 站一律回 -352，
   * 文案一直让用户"去登录"，登录完照样 -352。已用探针逐位对照官方算法校正为规范表，
   * 实测：不带 cookie 只带签名即可 code=0 拿到 token。
   *
   * 密钥（img_key / sub_key）从 x/web-interface/nav 的 wbi_img 里取，
   * 未登录也能拿到，服务端会轮换，这里缓存 30 分钟。
   */
  // 注意：这是 B 站官方公开的规范 mixin 置换表（64 位）。之前这份表在 idx40 之后是错的，
  // 导致 w_rid 算错、getDanmuInfo 永远回 -352（签名未通过）。已用探针对照官方算法逐位校正。
  const WBI_MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 11, 60, 20, 21, 56, 34, 44, 52, 22, 36, 1, 63, 59, 57, 54, 62, 6,
    4, 30, 25, 51,
  ];
  let biliWbiKeysCache = null;

  function biliMixinKey(imgKey, subKey) {
    const raw = `${imgKey}${subKey}`;
    return WBI_MIXIN_TAB.map((index) => raw[index]).join('').slice(0, 32);
  }

  function biliWbiQuery(params, imgKey, subKey) {
    const wbiEncode = (text) =>
      encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(signed)
      .sort()
      .map((key) => `${wbiEncode(key)}=${wbiEncode(String(signed[key]))}`)
      .join('&');
    const wRid = crypto
      .createHash('md5')
      .update(query + biliMixinKey(imgKey, subKey))
      .digest('hex');
    return `${query}&w_rid=${wRid}`;
  }

  async function biliWbiKeys(force) {
    if (!force && biliWbiKeysCache && Date.now() - biliWbiKeysCache.at < 30 * 60 * 1000) {
      return biliWbiKeysCache;
    }
    // nav 未登录时回 -101，但 wbi_img 照样给，所以这里按"有没有 wbi_img"算成功
    const { json } = await biliGetJson(
      'https://api.bilibili.com/x/web-interface/nav',
      'https://www.bilibili.com/',
      (parsed) => Boolean(parsed?.data?.wbi_img?.img_url && parsed?.data?.wbi_img?.sub_url)
    );
    const imgUrl = json?.data?.wbi_img?.img_url;
    const subUrl = json?.data?.wbi_img?.sub_url;
    if (!imgUrl || !subUrl) throw new Error('拿不到B站签名密钥，稍后重试');
    biliWbiKeysCache = {
      imgKey: String(imgUrl).split('/').pop().split('.')[0],
      subKey: String(subUrl).split('/').pop().split('.')[0],
      at: Date.now(),
    };
    return biliWbiKeysCache;
  }

  ipcMain.handle('live:danmu-info', async (_event, roomId) => {
    const info = await getBiliDanmuInfo(roomId);
    const first = info.hosts[0] || {};
    return {
      token: info.token,
      host: String(first.host || ''),
      port: Number(first.port || 443),
      hosts: info.hosts,
    };
  });

  /*
   * 弹幕 WebSocket 迁到主进程（根治渲染层长连接被本机网络层掐断的问题）。
   * 渲染层只负责：发 live:danmu-connect(token+hosts) / 收 live:danmu-event。
   * 真正建连、鉴权、心跳、断线重连、服务器轮换、token 刷新全在这里（Node 栈，
   * 实测 95 秒以上稳定，不再受 Chromium 出站长连接约 70 秒被掐的限制）。
   */
  const zlib = require('zlib');
  const WS = globalThis.WebSocket || WebSocket;
  const biliDanmuConnections = new Map();

  /*
   * 组2：B 站弹幕「老捕捉不到 / 过一会就断」的稳定性修复参数。
   * 以前 open 回调一触发就发 open 事件当「已连接」，但服务器可能只是接受了 TCP
   * 握手、根本没推数据；也没有读超时，长连接变僵尸后永远等不到重连。
   */
  const BILI_FRAME_TIMEOUT = 60000;     // 60s 没收到任意帧（含 op=3 心跳回应）视为僵尸连接
  const BILI_WATCHDOG_TICK = 15000;     // watchdog 每 15s 巡检一次
  const BILI_FIRST_DANMU_WAIT = 15000;  // 真连上后若这段时间仍无弹幕，只给一句「房间较安静」提示（不重连）
  const BILI_RECONNECT_BASE = 3000;     // 指数退避基数
  const BILI_RECONNECT_MAX = 60000;     // 退避上限
  const BILI_DECODE_LOG_LIMIT = 5;      // 解码失败日志按连接限流，别刷屏
  const BILI_DANMU_LOG_LIMIT = 20;      // 弹幕落日志前 20 条（原来只记 5 条）

  // 判断这个 state 是不是「当前仍挂在 Map 上、且没被用户主动关掉」的连接。
  // 同 roomId 重连/重连替换时，旧 state 的异步回调靠这个判断避免误伤新连接。
  function biliIsCurrent(state) {
    return Boolean(state) && !state.closedByUser && biliDanmuConnections.get(state.roomId) === state;
  }

  // 统一删除：先清掉全部定时器，且只删「自己」，避免旧连接把新连接从 Map 里挤掉。
  function biliRemoveConnection(state) {
    biliClearAllTimers(state);
    if (biliDanmuConnections.get(state.roomId) === state) biliDanmuConnections.delete(state.roomId);
  }

  // 限流日志：同一 state 同一 kind 最多写 limit 条，最后一条附带「已限流」说明。
  function biliLogLimited(state, kind, limit, message) {
    if (!state || !state.logCounts) return;
    const key = String(kind);
    const seen = state.logCounts[key] || 0;
    if (seen >= limit) return;
    state.logCounts[key] = seen + 1;
    writeLaunchLog(seen + 1 === limit ? `${message}（后续同类日志已限流省略）` : message);
  }

  // 清掉「单条 ws 连接」的定时器（换 host / 断开时用）；reconnectTimer 是跨重连的，不动。
  function biliClearWsTimers(state) {
    if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
    if (state.watchdog) { clearInterval(state.watchdog); state.watchdog = null; }
    if (state.waitFirstDanmuTimer) { clearTimeout(state.waitFirstDanmuTimer); state.waitFirstDanmuTimer = null; }
  }

  // 连接彻底删除时把所有定时器都清掉，避免后台重试 / watchdog 泄漏。
  function biliClearAllTimers(state) {
    biliClearWsTimers(state);
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  }

  // 第 n 次重连的退避：3s、6s、12s、24s、48s、60s、60s…
  function biliBackoff(tries) {
    return Math.min(BILI_RECONNECT_BASE * Math.pow(2, Math.max(0, tries - 1)), BILI_RECONNECT_MAX);
  }

  /*
   * 统一的「断线 -> 后台重连」入口：指数退避 + 长期重试，不再有「重连 3 次就彻底 closed」。
   * 候选 host 全耗尽、被踢、1006、watchdog 超时都走这里，由 biliReconnect 重取 token 重来一轮。
   */
  function biliScheduleReconnect(state, code, opts = {}) {
    if (state.closedByUser || !biliIsCurrent(state) || state.reconnectArmed) return;
    // 先置 armed 再 close：下面 ws.close() 会在下一轮异步触发 onDrop，
    // 不能让它又排一次重连、更不能让它误去连下一个 host。
    state.reconnectArmed = true;
    // closeWs=false 用于 watchdog 这类「调用方已自己 close」的场景，避免重复关。
    if (opts.closeWs !== false) { try { state.ws && state.ws.close(); } catch {} }
    biliClearWsTimers(state);
    state.connected = false;
    state.forceToken = true;   // 异常断开：下次 biliReconnect 一律强制重取 token
    const tries = (state.retryCount || 0) + 1;
    state.retryCount = tries;
    state.lastRetryAt = Date.now();
    const delay = biliBackoff(tries);
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    writeLaunchLog(`danmu ${state.roomId}: 连接断开（code ${code ?? '未知'}），第 ${tries} 次重连，${Math.round(delay / 1000)}s 后重试`);
    safeSend(state.sender, 'live:danmu-event', { roomId: state.roomId, type: 'reconnecting', tries, code, delayMs: delay });
    // 保留原有 1006 / 被踢提示文案，只是从「彻底 closed」改成后台重连期间的状态提示
    const statusText = opts.status || (code === 1006 ? '像是被代理或加速器掐断的，关掉加速器再连一次' : undefined);
    if (statusText) {
      safeSend(state.sender, 'live:danmu-event', { roomId: state.roomId, type: 'status', status: statusText });
    }
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      state.reconnectArmed = false;
      biliReconnect(state);
    }, delay);
  }

  // 取弹幕鉴权：与 live:danmu-info 共用同一套 wbi 签名逻辑，重连时主进程自己取，不绕回渲染层。
  async function getBiliDanmuInfo(roomId) {
    const id = String(roomId || '').trim();
    if (!id) throw new Error('没有房间号');
    await ensureBiliBuvid().catch(() => {});
    const referer = `https://live.bilibili.com/${id}`;
    let json = null;
    let detail = '';
    for (let attempt = 0; attempt < 2 && json?.code !== 0; attempt += 1) {
      const { imgKey, subKey } = await biliWbiKeys(attempt > 0);
      const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${biliWbiQuery(
        { id, type: 0 },
        imgKey,
        subKey
      )}`;
      const result = await biliGetJson(url, referer);
      json = result.json;
      detail = result.detail;
    }
    if (json?.code !== 0 || !json?.data?.token) {
      const message = String(json?.message || '');
      throw new Error(
        message === '-352'
          ? `被B站风控拦截(-352)，接口签名未通过（${detail || '原因不明'}）`
          : `${message || '弹幕鉴权获取失败'}（${detail || '原因不明'}）`
      );
    }
    const hosts = (json.data.host_list || [])
      .map((item) => ({ host: String(item?.host || ''), port: Number(item?.wss_port || item?.ws_port || 443) }))
      .filter((item) => item.host);
    return { token: String(json.data.token), hosts };
  }

  function biliBuildWsUrls(hosts) {
    const list = [];
    const seen = new Set();
    const push = (host, port) => {
      const h = String(host || '').trim();
      const p = Number(port) || 443;
      if (!h) return;
      const key = `${h}:${p}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(`wss://${h}:${p}/sub`);
    };
    for (const item of hosts || []) {
      push(item && item.host, 443);
      push(item && item.host, item && item.port);
    }
    push('broadcastlv.chat.bilibili.com', 443);
    return list;
  }

  function biliPacketMain(value, operation = 7) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    const buffer = Buffer.alloc(16 + body.length);
    buffer.writeUInt32BE(16 + body.length, 0);
    buffer.writeUInt16BE(16, 4);
    buffer.writeUInt16BE(1, 6);
    buffer.writeUInt32BE(operation, 8);
    buffer.writeUInt32BE(1, 12);
    body.copy(buffer, 16);
    return buffer;
  }

  function safeSend(sender, channel, payload) {
    try {
      if (sender && !sender.isDestroyed()) sender.send(channel, payload);
    } catch {
      /* webContents 已销毁 */
    }
  }

  /*
   * 主进程的 WebSocket 是 Electron 暴露的 DOM 风格实现：用 addEventListener 注册事件，
   * 不是 Node 的 ws 包（ws 包才有 .on）。为了不依赖具体版本，这里做个兼容：
   * 优先 addEventListener；万一某版本暴露的是 ws 风格就退回 .on。
   * message 事件：addEventListener 给的是 {data}，ws 风格直接给 data；
   * close 事件：addEventListener 给的是 {code}，ws 风格直接给 code。都归一化一下。
   */
  function wsOn(ws, name, handler) {
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener(name, (event) => {
        if (name === 'message') return handler(event && event.data !== undefined ? event.data : event);
        if (name === 'close') return handler(event && event.code !== undefined ? event.code : event);
        return handler(event);
      });
    } else {
      ws.on(name, handler);
    }
  }

  // 只有服务器回了 op=8（确认 auth 包）才算「真连上」：发 open 事件、置 connected。
  // 空 key 的连接即使握手成功也拿不到 op=8，所以旧版那种「已连接（未取得弹幕鉴权）」
  // 的假状态不会再出现；握手成功但迟迟不推数据则由 watchdog 兜底。
  function biliMarkReallyConnected(state) {
    if (state.connected) return;
    state.connected = true;
    // 已经拿到首条弹幕，别再让「等首条弹幕」的超时器误触发换线路
    if (state.waitFirstDanmuTimer) { clearTimeout(state.waitFirstDanmuTimer); state.waitFirstDanmuTimer = null; }
    // 真正稳定收到弹幕后重置退避计数（只在成功的这一刻清零，不再按「>5 分钟」丢计数）
    state.retryCount = 0;
    state.lastRetryAt = 0;
    biliLogLimited(state, 'really-connected', BILI_DECODE_LOG_LIMIT,
      `danmu ${state.roomId}: 已确认真实连上（收到首条弹幕），重连计数清零`);
    safeSend(state.sender, 'live:danmu-event', { roomId: state.roomId, type: 'open', status: '已连接' });
  }

  function biliDecodeMain(buf, roomId, sender, state) {
    let offset = 0;
    while (offset + 16 <= buf.length) {
      const total = buf.readUInt32BE(offset);
      const header = buf.readUInt16BE(offset + 4);
      const version = buf.readUInt16BE(offset + 6);
      const operation = buf.readUInt32BE(offset + 8);
      if (!total || total > buf.length - offset) break;
      // 只要进了这个循环就是「收到了一帧」：刷新 watchdog 的读时间戳。
      state.lastFrameAt = Date.now();
      const body = buf.subarray(offset + header, offset + total);
      if (operation === 8) {
        // 服务器确认 auth 包：空 key / 被风控的连接永远收不到 op=8（配合 connect 处的空 token 拦截），
        // 所以拿到它才算「真连上」——不会再出现「已连接（未取得弹幕鉴权）」那种一条弹幕都没有的假状态。
        safeSend(sender, 'live:danmu-event', { roomId, type: 'pushing' });
        biliMarkReallyConnected(state);
        // 安静直播间可能几分钟都没弹幕：只给一句提示，绝不因「没弹幕」就换线路重连
        // （旧版 15 秒强制重连反而制造「过一会就断」）。真正的僵尸连接交给 watchdog。
        if (!state.waitFirstDanmuTimer) {
          state.waitFirstDanmuTimer = setTimeout(() => {
            state.waitFirstDanmuTimer = null;
            if (state.connected && biliIsCurrent(state) && state.captured === 0) {
              safeSend(sender, 'live:danmu-event', { roomId, type: 'status', status: '已连上，房间暂时没有弹幕' });
            }
          }, BILI_FIRST_DANMU_WAIT);
        }
      } else if (operation === 3) {
        // 心跳回应 / 人气包：服务器还活着，刷新读时间戳（watchdog 已统一刷新），不必解析内容。
      } else if (operation === 5) {
        if (version === 2 || version === 3) {
          try {
            const inflated = version === 3 ? zlib.brotliDecompressSync(body) : zlib.inflateSync(body);
            biliDecodeMain(inflated, roomId, sender, state);
          } catch (error) {
            biliLogLimited(state, `inflate-v${version}`, BILI_DECODE_LOG_LIMIT,
              `danmu ${roomId}: op 5 压缩帧解压失败 version=${version} operation=${operation}：${error.message}`);
          }
        } else {
          try {
            const json = JSON.parse(body.toString('utf8'));
            const items = Array.isArray(json) ? json : [json];
            for (const item of items) {
              if (String(item?.cmd || '').includes('DANMU_MSG')) {
                const message = String(item.info?.[1] || '');
                const user = String(item.info?.[2]?.[1] || '');
                state.captured += 1;
                state.lastMessageAt = Date.now();  // 真正的「最后一条弹幕」时间（token 复用看它）
                biliMarkReallyConnected(state);    // 首条弹幕 = 真连上，发 open
                if (state.captured <= BILI_DANMU_LOG_LIMIT) writeLaunchLog(`danmu ${roomId}: ${user}: ${message}`);
                safeSend(sender, 'live:danmu-event', { roomId, type: 'danmu', message, user, captured: state.captured });
              }
            }
          } catch (error) {
            biliLogLimited(state, 'json-parse', BILI_DECODE_LOG_LIMIT,
              `danmu ${roomId}: op 5 非 JSON 包 operation=${operation} version=${version}：${error.message}`);
          }
        }
      }
      offset += total;
    }
  }

  function biliOpenWs(state) {
    if (!biliIsCurrent(state)) return;
    const urls = state.urls;
    if (state.urlIndex >= urls.length) {
      // 一轮候选全失败：不再直接判死刑，交给后台重连重取 token 再来一轮
      // （closeWs:false 因为此刻没有在途 ws，避免重复关）。
      biliScheduleReconnect(state, 1006, { closeWs: false, status: '弹幕服务器暂时都不通，正在重试…' });
      return;
    }
    let ws = null;
    try {
      ws = new WS(urls[state.urlIndex]);
    } catch {
      state.urlIndex += 1;
      biliOpenWs(state);
      return;
    }
    state.ws = ws;
    state.opened = false;
    ws.binaryType = 'arraybuffer';
    let done = false;
    const goNext = () => {
      try { ws.close(); } catch {}
      state.urlIndex += 1;
      biliOpenWs(state);
    };
    wsOn(ws, 'open', () => {
      state.opened = true;
      state.openedAt = Date.now();
      state.lastFrameAt = Date.now();
      // 发鉴权包。旧的 try/catch 会把失败吞掉、让界面停在假「已连接」，这里记进 launch.log。
      try {
        ws.send(biliPacketMain({ uid: 0, roomid: Number(state.roomId), protover: 2, platform: 'web', type: 2, key: state.token }));
      } catch (error) {
        biliLogLimited(state, 'auth-send', BILI_DECODE_LOG_LIMIT,
          `danmu ${state.roomId}: 发送鉴权包失败：${error.message}`);
      }
      // 每次新 ws 都先清掉上一条 ws 遗留的定时器，避免叠加。
      if (state.heartbeat) clearInterval(state.heartbeat);
      if (state.watchdog) clearInterval(state.watchdog);
      if (state.waitFirstDanmuTimer) { clearTimeout(state.waitFirstDanmuTimer); state.waitFirstDanmuTimer = null; }
      state.heartbeat = setInterval(() => {
        if (ws.readyState === WS.OPEN) {
          try { ws.send(biliPacketMain({}, 2)); } catch {}
        }
      }, 20000);
      // 读超时 watchdog：只发心跳不验活，TCP 半开时会一直显示「已连接」却不重连。
      // 超过 BILI_FRAME_TIMEOUT 没收到任意帧（含 op=3 心跳回应）就主动重连。
      state.watchdog = setInterval(() => {
        if (!biliIsCurrent(state) || state.reconnectArmed) return;
        if (Date.now() - (state.lastFrameAt || 0) > BILI_FRAME_TIMEOUT) {
          writeLaunchLog(`danmu ${state.roomId}: ${Math.round(BILI_FRAME_TIMEOUT / 1000)}s 没收到任何数据，判定僵尸连接，主动重连`);
          biliScheduleReconnect(state, 1006, { status: '连接长时间没有数据，正在重连…' });
        }
      }, BILI_WATCHDOG_TICK);
      // 不再在这里发 open / 置 connected：等服务器回 op=8 由 biliMarkReallyConnected 发，
      // 彻底消除「TCP 握手成功就被当成已连接」和「一条弹幕都没推」的假状态。
    });
    wsOn(ws, 'message', (data) => {
      let buf;
      if (data instanceof ArrayBuffer) buf = Buffer.from(data);
      else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      else buf = Buffer.from(data);
      if (!buf || !buf.length) return;
      biliDecodeMain(buf, state.roomId, state.sender, state);
    });
    const onDrop = (code) => {
      if (done) return;
      done = true;
      biliClearWsTimers(state);
      state.connected = false;
      // 用户主动断开 / 旧连接已被替换：静默收尾，绝不往渲染层发事件。
      // 事件是按 roomId 路由的，旧连接若发 'closed' 会误伤同一 roomId 的新卡片
      // （手动重连时闪一下「已断开」），而这正是「过一会断开」要消除的观感。
      // 主动断开时卡片本就由渲染层同步移除，不需要这条 closed 事件。
      if (state.closedByUser || !biliIsCurrent(state)) {
        if (biliDanmuConnections.get(state.roomId) === state) biliRemoveConnection(state);
        return;
      }
      // 握手都没成功、或连上 5 秒内立刻被踢：先在本轮候选里换下一个 host。
      // 这两种都算「线路不可用」而非稳定连接断开，换 host 更对症。
      if (!state.opened || (state.openedAt && Date.now() - state.openedAt < 5000 && state.urlIndex + 1 < urls.length)) {
        safeSend(state.sender, 'live:danmu-event', { roomId: state.roomId, type: 'status', status: '这个弹幕服务器连上就被踢，换一个…' });
        goNext();
        return;
      }
      // 真正的一次掉线：统一走指数退避 + 长期后台重连，不再「重连 3 次就彻底 closed」。
      // 先置 armed（防止 ws.close 的异步 onDrop 二次入队），且本次 ws 已断不要再 close。
      biliScheduleReconnect(state, code, { closeWs: false, status: code === 1006 ? '像是被代理或加速器掐断的，关掉加速器再连一次' : undefined });
    };
    wsOn(ws, 'error', () => { if (!done) onDrop(1006); });
    wsOn(ws, 'close', (code) => onDrop(code));
  }

  async function biliReconnect(state) {
    if (state.closedByUser || !biliIsCurrent(state)) return;
    // 「最后弹幕时间」用真正的 lastMessageAt（旧 lastDanmuAt 其实是建连时间，命名误导）。
    // 异常断开（forceToken）或 5 分钟没收到过弹幕，一律重取 token，不再拿被风控踢掉的旧 key 重试。
    const recentMessage = state.lastMessageAt && Date.now() - state.lastMessageAt < 5 * 60 * 1000;
    if (state.forceToken || !state.token || !recentMessage) {
      try {
        const info = await getBiliDanmuInfo(state.roomId);
        // 取 token 是异步的，期间用户可能已断开或该连接已被替换。
        if (state.closedByUser || !biliIsCurrent(state)) return;
        state.token = info.token;
        state.hosts = info.hosts;
        state.lastMessageAt = Date.now();
        state.forceToken = false;
      } catch (error) {
        if (state.closedByUser || !biliIsCurrent(state)) return;
        biliLogLimited(state, 'reconnect-token', BILI_DECODE_LOG_LIMIT,
          `danmu ${state.roomId}: 重连取鉴权失败：${error.message}`);
        // 不彻底放弃：按退避继续后台重试（旧版这里直接判死刑）。
        biliScheduleReconnect(state, 1006);
        return;
      }
    }
    state.urls = biliBuildWsUrls(state.hosts);
    state.urlIndex = 0;
    biliOpenWs(state);
  }

  ipcMain.on('live:danmu-connect', (event, payload = {}) => {
    const roomId = String(payload.roomId || '');
    if (!roomId) return;
    const existing = biliDanmuConnections.get(roomId);
    if (existing) {
      existing.closedByUser = true;
      biliRemoveConnection(existing);   // 清掉旧连接的全部定时器 + 只删自己
      try { existing.ws && existing.ws.close(); } catch {}
    }
    const token = String(payload.token || '');
    const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
    const state = {
      roomId,
      token,
      hosts,
      lastDanmuAt: Date.now(),       // 保留旧字段以兼容，真正复用判断看 lastMessageAt
      lastMessageAt: 0,             // 真正的「最后一条弹幕」时间
      lastFrameAt: Date.now(),      // watchdog 的读时间戳
      sender: event.sender,
      urls: biliBuildWsUrls(hosts),
      urlIndex: 0,
      opened: false,
      openedAt: 0,
      retryCount: 0,
      lastRetryAt: 0,
      closedByUser: false,
      forceToken: false,
      reconnectArmed: false,
      reconnectTimer: null,
      heartbeat: null,
      watchdog: null,
      waitFirstDanmuTimer: null,
      logCounts: {},
      captured: 0,
      ws: null,
      connected: false,
    };
    biliDanmuConnections.set(roomId, state);
    if (typeof WS !== 'function') {
      safeSend(event.sender, 'live:danmu-event', { roomId, type: 'closed', status: '主进程缺少 WebSocket 支持' });
      biliRemoveConnection(state);
      return;
    }
    // 空 token 拦截：不带 key 服务器照样接受连接，但一条弹幕都不会推（旧版还会显示假「已连接」）。
    if (!token) {
      safeSend(event.sender, 'live:danmu-event', { roomId, type: 'closed', status: '弹幕鉴权失败：没有拿到 key，请重新连接或稍后再试' });
      biliRemoveConnection(state);
      return;
    }
    biliOpenWs(state);
  });

  ipcMain.on('live:danmu-disconnect', (_event, roomId) => {
    const state = biliDanmuConnections.get(String(roomId || ''));
    if (!state) return;
    state.closedByUser = true;
    biliRemoveConnection(state);   // 清 watchdog / 心跳 / 退避定时器 + 只删自己
    try { state.ws && state.ws.close(); } catch {}
  });

  /*
   * B 站账号登录窗口：passport.bilibili.com，扫码 / 账密都行。
   * 用默认会话开窗——登录产生的 SESSDATA 等 cookie 直接落在主会话里，
   * 弹幕鉴权（useSessionCookies）立刻就能用上，不需要导来导去。
   * 窗口轮询到 SESSDATA 出现就自动关闭并返回成功。
   *
   * 注意：-352 并不是"没登录"造成的（见上面的 WBI 签名），登录入口只是
   * 顺手保留。但它必须真的能用，不能点了没反应，所以这里补两件事：
   *   1. 伪装成桌面 Chrome——Electron 默认 UA 带 Electron/xx，B 站登录页
   *      会按 UA 判断"浏览器不受支持"，二维码渲染不出来 / 登录提交被拒。
   *   2. 放行 window.open——QQ / 微信 / 短信登录是弹窗，Electron 默认拦掉，
   *      不放行就是点了没反应。
   */
  let biliLoginWin = null;
  ipcMain.handle('bili:login', () => {
    if (biliLoginWin) {
      biliLoginWin.focus();
      return Promise.resolve({ ok: false, reason: '登录窗口已经开着，去看一眼' });
    }
    return new Promise((resolve) => {
      let settled = false;
      let poll = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (poll) clearInterval(poll);
        resolve(result);
      };
      biliLoginWin = new BrowserWindow({
        width: 1020,
        height: 720,
        title: '登录B站账号',
        autoHideMenuBar: true,
        backgroundColor: '#f6f7f8',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      try {
        biliLoginWin.webContents.setUserAgent(BILI_UA);
        biliLoginWin.webContents.session.setUserAgent(BILI_UA);
      } catch {
        /* ignore */
      }
      // QQ / 微信登录会另开弹窗，Electron 默认拦掉 window.open
      biliLoginWin.webContents.setWindowOpenHandler(() => ({
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      }));
      poll = setInterval(async () => {
        try {
          const cookies = await session.defaultSession.cookies.get({ domain: 'bilibili.com' });
          if (cookies.some((c) => c.name === 'SESSDATA')) {
            const win = biliLoginWin;
            biliLoginWin = null;
            try {
              win.close();
            } catch {
              /* already gone */
            }
            finish({ ok: true });
          }
        } catch {
          /* ignore poll errors */
        }
      }, 800);
      biliLoginWin.on('closed', () => {
        biliLoginWin = null;
        finish({ ok: false, reason: '窗口已关闭' });
      });
      biliLoginWin.loadURL('https://passport.bilibili.com/login').catch(() => {});
    });
  });

  // 应用退出时别把隐藏窗口留成孤儿进程
  app.on('before-quit', () => {
    try {
      stopDanmaku();
    } catch {
      /* ignore */
    }
  });

  /**
   * 打开内置浏览器窗口让用户真实登录 QQ 音乐 / 酷狗。
   *
   * 登录方式（扫码 / QQ / 微信 / 手机验证码）完全由官网页面自己提供，
   * 我们只负责在登录成功后把 cookie 里的凭证取出来并加密保存。
   */
  ipcMain.handle('music:login', async (_event, platform) => {
    const key = String(platform || '');
    const config = musicPlatformConfig(key);

    /*
     * 先把这个平台自己的登录态清干净再开窗口。
     *
     * 用户点「登录」的意思就是要扫码，可登录窗口跑在 persist 分区里，
     * 上一轮的 cookie 还留着时窗口一加载就自动登进去了，用户根本没机会扫码。
     * 而且这种情况下轮询会立刻判定「已登录」并把旧的整袋 cookie 再存一遍，
     * 等于「退出登录」没任何效果。所以这里进入登录流程前先清分区。
     */
    try {
      const stale = session.fromPartition(`persist:music-${key}-login`);
      await stale.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql'],
      });
      await stale.clearAuthCache();
    } catch (error) {
      console.error('[music-login] 清理旧登录态失败（继续登录）:', error);
    }

    return new Promise((resolve, reject) => {
      // 用明确的 session.fromPartition 拿分区，登录窗口和后续轮询共用同一个会话，
      // 也避免 webPreferences.partition 在某些版本下没真正落盘、cookie 取不全的问题。
      const ses = session.fromPartition(`persist:music-${key}-login`);
      const loginWindow = new BrowserWindow({
        width: 520,
        height: 720,
        parent: win || undefined,
        modal: false,
        show: true,
        title: `${config.label} 登录`,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: MUSIC_LOGIN_PRELOAD,
        },
      });

      // 官网会按 UA 判断「浏览器是否受支持」。Electron 默认 UA 里带着
      // Electron/xx 和启动器名字，QQ 音乐 / 酷狗会直接拒绝渲染登录二维码，
      // 表现就是「点登录没反应、认不出浏览器」。统一伪装成桌面 Chrome。
      try {
        loginWindow.webContents.setUserAgent(BROWSER_UA);
        loginWindow.webContents.session.setUserAgent(BROWSER_UA);
      } catch {
        /* ignore */
      }

      // QQ / 微信登录会另开一个弹窗（ptlogin2.qq.com 等）。
      // Electron 默认拦掉 window.open，弹窗根本不出现；这里显式放行，
      // 子窗口和父窗口共用同一个 session，cookie 仍然能被轮询抓到。
      loginWindow.webContents.setWindowOpenHandler(() => ({
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      }));

      let settled = false;
      let pollTimer = null;
      // 是否已经用登录接口验过这一袋 cookie（见 check() 里的说明）
      let verified = false;
      let lastVerifyAt = 0;

      const cleanup = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        try {
          loginWindow.close();
        } catch {
          /* ignore */
        }
      };

      const finish = async (bag) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          // 存【全量】cookie：歌单 / 取歌地址接口要的不止 uin + qqmusic_key，
          // 少了 qm_keyst / skey / p_skey 这些，服务端就直接当成未登录。
          const payload = {
            ...bag,
            __cookieHeader: cookieHeader(bag),
            savedAt: new Date().toISOString(),
          };
          // 存盘失败不能静默吞掉：否则界面显示「已登录」，重启后却全没了。
          // saveSecret 在没有系统加密可用时会返回 false，这种情况要明确报出来。
          const saved = await saveSecret(`music-${key}`, JSON.stringify(payload)).catch((error) => {
            console.error('[music-login] 保存登录状态失败:', error);
            return false;
          });
          if (!saved) {
            console.error('[music-login] saveSecret 返回 false，系统加密不可用或写入失败');
          }
          resolve({ ok: true, platform: key, cookies: payload, saved: Boolean(saved) });
        } catch (error) {
          reject(error);
        }
      };

      // 轮询 cookie：官网登录成功后 cookie 会出现在窗口里。
      // 不同平台（尤其酷狗）的 cookie 名不统一，这里把所有 cookie 都摊平成 bag，
      // 交给 checkLogin 按候选组挑，命中即认为登录完成。
      // 命中后存盘的是【整袋】cookie，不是挑出来的那几个键。
      const check = async () => {
        if (settled) return;
        try {
          const cookies = await ses.cookies.get({});
          const bag = {};
          for (const cookie of cookies || []) {
            if (!cookie?.name) continue;
            // 只认 kugou / qq 域的 cookie，避免把无关域的值混进来
            const domain = String(cookie.domain || '');
            if (config.host && !config.host.some((h) => domain.includes(h))) continue;
            bag[cookie.name] = cookie.value;
          }
          musicLoginDebug = { at: Date.now(), platform: key, cookieCount: cookies.length, matched: Object.keys(bag) };
          const checked = checkMusicLogin(config, bag);
          if (checked.ok) {
            /*
             * 只凭 cookie 名齐了就存盘是不行的：QQ 音乐扫码过程中
             * p_uin / p_tk 这类 QQ 互联的 cookie 会先落地，y.qq.com 自己的
             * 会话还没写完，这时候存下来的是一袋半截凭证 —— 之后取歌单
             * 一律 500003（服务端当未登录）。所以这里再用最轻的登录接口验一次，
             * 验过才存；验不过就接着轮询。验证限流 3 秒一次，别把接口打爆。
             */
            const now = Date.now();
            if (!verified && now - lastVerifyAt > 3000) {
              lastVerifyAt = now;
              const result = await verifyMusicSession(key, bag).catch(() => ({ ok: false }));
              verified = Boolean(result && result.ok);
              musicLoginDebug.verify = { ok: verified, error: (result && result.error) || '' };
            }
            if (verified) await finish(bag);
          }
        } catch {
          /* 窗口还在加载时忽略 */
        }
      };

      // 给界面一个「我已经扫码登录了」的兜底：只要窗口里出现过账号类 cookie，
      // 就把整袋 cookie 存下来，不再苛求 qqmusic_key / qm_keyst 这种凭证名。
      activeMusicLogin = {
        platform: key,
        confirm: async () => {
          if (settled) return { ok: false, error: '登录窗口已经关闭，请重新打开' };
          try {
            const cookies = await ses.cookies.get({});
            const bag = {};
            for (const cookie of cookies || []) {
              if (!cookie?.name) continue;
              const domain = String(cookie.domain || '');
              if (config.host && !config.host.some((h) => domain.includes(h))) continue;
              bag[cookie.name] = cookie.value;
            }
            if (!Object.keys(bag).length) {
              return { ok: false, error: '还没有读到任何登录 cookie，请先在窗口里完成扫码' };
            }
            /*
             * 「我已登录」是用户的断言，所以这里不拦着他存盘：
             * 只是顺手验一次，验不过就把话说明白，让他知道还要再等一下。
             */
            const probe = await verifyMusicSession(key, bag).catch(() => ({ ok: false, error: '验证没跑通' }));
            await finish(bag);
            return {
              ok: true,
              platform: key,
              cookies: bag,
              verified: Boolean(probe && probe.ok),
              warning: probe && probe.ok ? '' : `已经存下来了，但还查不到账号信息（${(probe && probe.error) || '验证失败'}），歌单可能还读不出来`,
            };
          } catch (error) {
            return { ok: false, error: error.message || '保存登录状态失败' };
          }
        },
      };

      const startPolling = () => {
        if (pollTimer) return;
        pollTimer = setInterval(check, 1200);
        setTimeout(check, 600);
      };

      loginWindow.webContents.on('dom-ready', startPolling);
      loginWindow.webContents.on('did-finish-load', async () => {
        startPolling();

        /*
         * 官网首页要自己找到「登录」才出二维码。
         * QQ 音乐的点开后是 yqq-dialog，里面嵌 graph.qq.com 的 OAuth；
         * 酷狗也是首页点登录才出扫码框。
         * 这里注入脚本帮用户点开，省得他在页面里找。
         */
        try {
          await loginWindow.webContents.executeJavaScript(MUSIC_LOGIN_CLICK_SCRIPT, true);
        } catch {
          /* 页面还没准备好就跳过，用户自己点也行 */
        }

        // 在官网页面上叠一条自己的提示条：告诉用户扫完码可以点「我已登录」强制保存，
        // 避免凭证 cookie 名不匹配导致窗口一直不关。
        try {
          await loginWindow.webContents.insertCSS(`
            #hxl-music-login-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
              display:flex;align-items:center;gap:10px;padding:8px 12px;
              background:rgba(16,10,12,.94);border-top:1px solid rgba(240,198,116,.35);
              font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#e9dcc8;}
            #hxl-music-login-bar span{flex:1}
            #hxl-music-login-bar b{color:#f0c674}
            #hxl-music-login-bar button{flex:none;height:26px;padding:0 12px;border-radius:6px;
              border:1px solid rgba(240,198,116,.5);background:rgba(240,198,116,.14);
              color:#f0c674;font:inherit;cursor:pointer;}
            #hxl-music-login-bar button:hover{background:rgba(240,198,116,.26)}
            body{padding-bottom:52px !important}
          `);
          await loginWindow.webContents.executeJavaScript(`
            (() => {
              if (document.getElementById('hxl-music-login-bar')) return true;
              const bar = document.createElement('div');
              bar.id = 'hxl-music-login-bar';
              bar.innerHTML = '<span>扫码 / 登录完成后如果窗口没有自动关闭，点右边 <b>我已登录</b> 保存。</span>';
              const btn = document.createElement('button');
              btn.textContent = '我已登录';
              btn.onclick = async () => {
                btn.textContent = '正在保存…';
                btn.disabled = true;
                try {
                  const r = await window.hxlMusicLoginConfirm();
                  btn.textContent = r && r.ok ? '已保存，窗口即将关闭' : (r?.error || '没有读到登录状态');
                  if (!r || !r.ok) { btn.disabled = false; btn.textContent = '我已登录'; }
                } catch (e) {
                  btn.disabled = false;
                  btn.textContent = '我已登录';
                }
              };
              bar.appendChild(btn);
              document.body.appendChild(bar);
              return true;
            })();
          `).catch(() => {});
        } catch {
          /* 官网页面结构特殊时忽略 */
        }
      });

      // 用户在窗口里导航到同域其他页面也要继续轮询
      loginWindow.webContents.on('did-navigate', () => {
        if (pollTimer) return;
        pollTimer = setInterval(check, 1200);
        setTimeout(check, 600);
      });

      loginWindow.on('closed', () => {
        if (activeMusicLogin && activeMusicLogin.platform === key) activeMusicLogin = null;
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        resolve({ ok: false, cancelled: true });
      });

      loginWindow.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
        if (!isMainFrame || settled) return;
        if (code === -3) return; // 用户自己中断的导航
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        try {
          loginWindow.close();
        } catch {
          /* ignore */
        }
        resolve({ ok: false, error: `登录页打不开（${desc || code}）` });
      });

      loginWindow.loadURL(config.loginUrl);
    });
  });

  /**
   * 「我已经登录了」兜底：不管 cookie 名字对不对，把窗口里现有的整袋 cookie 存下来。
   * 用于扫码成功但凭证 cookie 名不在候选列表里的情况。
   */
  ipcMain.handle('music:login-confirm', async () => {
    if (!activeMusicLogin) return { ok: false, error: '当前没有打开的登录窗口' };
    return activeMusicLogin.confirm();
  });

  /** 登录窗口的诊断信息：读到手几个 cookie、命中了哪些名字。 */
  ipcMain.handle('music:login-debug', async () => musicLoginDebug);

  /** 当前已保存哪些平台的登录。 */
  /**
   * 把登录窗口分区里现存的 cookie 合并进已保存的凭据。
   *
   * 为什么要这一步：登录成功时我们是把「当时的整袋 cookie」存下来的，
   * 但酷狗 / QQ 音乐会在登录后再陆续补写几条关键 cookie（比如酷狗的
   * userid、QQ 的 refreshing 票据）。只吃存盘那一份，就会出现
   * 「明明登录了，服务端却说没登录」的情况。
   */
  async function mergePartitionCookies(key, creds) {
    const bag = { ...creds };
    try {
      const part = session.fromPartition(`persist:music-${key}-login`);
      const cookies = await part.cookies.get({});
      for (const cookie of cookies || []) {
        if (cookie && cookie.name) bag[cookie.name] = cookie.value;
      }
    } catch {
      /* 分区可能没建过，用已保存的即可 */
    }
    // QQ 号在不同版本落在不同 cookie 名上，这里统一补一次
    if (!bag.uin) bag.uin = bag.p_uin || bag.ptui_loginuin || bag.luin || bag.wxuin || '';
    const pairs = [];
    for (const [name, value] of Object.entries(bag)) {
      if (name === '__cookieHeader' || name === 'savedAt') continue;
      if (!/^[A-Za-z0-9_.$-]+$/.test(name)) continue;
      if (value == null) continue;
      pairs.push(`${name}=${String(value).replace(/;/g, '')}`);
    }
    bag.__cookieHeader = pairs.join('; ');
    return bag;
  }

  /** 给任意 Promise 套硬上限，任何一步卡住都不能让界面一直转圈。 */
  function playlistDeadline(promise, ms, label) {
    let timer = null;
    const guard = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label || '读取'}超时（${Math.round(ms / 1000)} 秒没有响应）`));
      }, ms);
    });
    return Promise.race([promise, guard]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** 打开一个带登录态的内置窗口（分区就是登录时用的那个）。 */
function musicLoginWindow(target) {
  // 抓歌单用的窗口必须隐藏：弹出来的窗口会被用户随手关掉，
  // 一关整个应用就退出（window-all-closed），而且隐藏窗口配合
  // backgroundThrottling:false 一样能发请求、能跑 executeJavaScript。
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    show: false,
    webPreferences: {
      session: session.fromPartition(`persist:music-${target}-login`),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // 伪装成桌面 Chrome：Electron 默认 UA 带 "Electron/xx"，
  // QQ 音乐/酷狗会拒绝渲染或返回精简页。
  try {
    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
  } catch {
    /* ignore */
  }
  return win;
}

/** 收集一个 QQ 音乐 / 酷狗账号的歌单：先走网页，失败回退 OpenAPI。 */
  async function collectPlatformPlaylists(key) {
    /*
     * 注意：这里的变量名不能叫 session。
     * 早前写成 `const session = await loadMusicSession(...)`，把 electron 的
     * session 模块整个遮住了，下面 `session.fromPartition` 直接抛
     * 「fromPartition is not a function」——网页这条路从来没跑通过一次，
     * 于是每次都默默回退到 OpenAPI，QQ 音乐 / 酷狗 的歌单也就一直是空的。
     */
    const saved = await loadMusicSession(key, loadSecret);
    if (!saved) throw new Error('还没有登录');
    const creds = await mergePartitionCookies(key, saved);
    // 酷狗：m.kugou.com 的「我的歌单」要浏览器自己种的 cookie（Node 侧裸拼多半 Access Deny），
    // 所以先走隐藏窗口。但曲目的 mobilecdn 接口是免登录的、Node 直连可用
    // （只认 http，https 握手失败），所以「点开某个歌单」这条路径不必开窗口。
    // QQ 音乐：先试接口（cookie 手动拼 header），失败再退到隐藏窗口抓包。
    const tryApi = async () => {
      const list = await playlistDeadline(accountPlaylists(key, creds), 18000, '接口读取歌单');
      if (Array.isArray(list) && list.length) return { list: withLikedPlaylist(key, list), source: 'api' };
      throw new Error('接口返回空列表');
    };
    const tryWeb = async () => {
      const list = await playlistDeadline(
        webMyPlaylists(key, creds, {
          getWindow: async (target) => {
            return { win: musicLoginWindow(target), ownWindow: true };
          },
        }),
        key === 'qq' ? 60000 : 35000,
        '网页读取歌单'
      );
      if (Array.isArray(list) && list.length) return { list: withLikedPlaylist(key, list), source: 'web' };
      throw new Error('网页返回空列表');
    };

    if (key === 'kuwo') {
      // 酷我：网页端用户歌单接口已全部删除，只走老接口 nplserver（api 路径）
      try { return await tryApi(); }
      catch (apiError) {
        throw new Error(`酷我：读取我的歌单失败（${apiError.message}）`);
      }
    }
    if (key === 'kugou') {
      // 酷狗：网页优先（隐藏窗口），接口兜底
      try { return await tryWeb(); }
      catch (webError) {
        try { return await tryApi(); }
        catch (apiError) {
          throw new Error(`酷狗：网页读取失败（${webError.message}）；接口也失败（${apiError.message}）`);
        }
      }
    }
    // QQ 音乐：接口优先，网页兜底
    try { return await tryApi(); }
    catch (apiError) {
      try { return await tryWeb(); }
      catch (webError) {
        throw new Error(`QQ 音乐：接口失败（${apiError.message}）；网页也失败（${webError.message}）`);
      }
    }
  }

  /** 三个平台的登录状态，含网易云（它的会话不在 MUSIC_LOGIN_CONFIG 里）。 */
  async function musicStatus() {
    const out = {
      netease: {
        label: '网易云',
        loggedIn: Boolean(neteaseSession.cookie),
        savedAt: null,
        uin: '',
        userid: '',
      },
    };
    for (const key of Object.keys(MUSIC_LOGIN_CONFIG)) {
      const session = await loadMusicSession(key, loadSecret);
      out[key] = {
        label: MUSIC_LOGIN_CONFIG[key].label,
        loggedIn: Boolean(session),
        savedAt: session?.savedAt || null,
        uin: session?.uin || '',
        userid: session?.userid || '',
      };
    }
    return out;
  }

  ipcMain.handle('music:status', async () => musicStatus());

  /*
   * 我的歌单缓存：读 / 写 / 丢。
   *
   * 写是合并的 —— 前端只把这次真正同步到的那几个平台传上来，
   * 没传的平台保留旧缓存，否则点一次酷狗同步会把网易云那份缓存抹掉。
   */
  ipcMain.handle('music:playlists-cache', async () => {
    const cache = playlistCache();
    return {
      ok: true,
      savedAt: Number(cache.data.savedAt) || 0,
      accounts: cache.data.accounts || {},
      groups: cache.data.groups || {},
    };
  });

  ipcMain.handle('music:playlists-cache-save', async (_event, input) => {
    const cache = playlistCache();
    const groups = Array.isArray(input?.groups) ? input.groups : [];
    const accounts = input?.accounts && typeof input.accounts === 'object' ? input.accounts : null;
    if (accounts) {
      for (const key of PLAYLIST_CACHE_PLATFORMS) {
        if (Object.prototype.hasOwnProperty.call(accounts, key)) {
          cache.data.accounts[key] = String(accounts[key] || '');
        }
      }
    }
    for (const group of groups) {
      const key = String(group?.platform || '');
      if (!PLAYLIST_CACHE_PLATFORMS.includes(key)) continue;
      const slim = slimCachedPlaylists(group);
      // 空列表不写：同步失败时 list 是空的，写进去等于把上次好好的缓存冲掉
      if (!slim.list.length) continue;
      cache.data.groups[key] = slim;
    }
    cache.data.version = 1;
    cache.data.savedAt = Date.now();
    // JsonStore.save() 自带 400ms 防抖 + 串行写 + 原子 rename，不用自己再拼一遍
    cache.save();
    return { ok: true, savedAt: cache.data.savedAt };
  });

  /*
   * 从「我的歌单」缓存里剔掉一张具体的歌单（链接导入的那种）。
   *
   * 为什么不复用 music:playlists-cache-save：那个是**合并写 + 空列表跳过**，
   * 删掉某平台最后一张歌单时前端传上来的 list 是空的，主进程会直接 continue，
   * 磁盘上的旧缓存原封不动 —— 重启后歌单原样复活，「删了没用」。
   * 所以删除必须按 id 精确落到缓存上：剔完为空就把这个平台整组丢掉。
   */
  ipcMain.handle('music:playlist-remove', async (_event, input) => {
    const key = String(input?.platform || '').trim().toLowerCase();
    const id = String(input?.id || '').trim();
    if (!PLAYLIST_CACHE_PLATFORMS.includes(key) || !id) {
      return { ok: false, removed: 0, reason: '参数不完整' };
    }
    const cache = playlistCache();
    const groups = cache.data.groups && typeof cache.data.groups === 'object' ? cache.data.groups : null;
    const group = groups?.[key];
    if (!Array.isArray(group?.list)) return { ok: true, removed: 0 };
    const before = group.list.length;
    const list = group.list.filter((item) => String(item?.id || '') !== id);
    const removed = before - list.length;
    if (!removed) return { ok: true, removed: 0 };
    if (list.length) cache.data.groups[key] = { ...group, list };
    else delete cache.data.groups[key];
    // JsonStore.save() 自带防抖 + 串行写 + 原子 rename
    cache.save();
    return { ok: true, removed };
  });

  ipcMain.handle('music:playlists-cache-drop', async (_event, input) => {
    const cache = playlistCache();
    const keys = Array.isArray(input?.platforms)
      ? input.platforms
          .map((item) => String(item || '').trim().toLowerCase())
          .filter((item) => PLAYLIST_CACHE_PLATFORMS.includes(item))
      : [];
    if (!keys.length) {
      cache.data.groups = {};
      cache.data.accounts = {};
    } else {
      for (const key of keys) {
        delete cache.data.groups[key];
        delete cache.data.accounts[key];
      }
    }
    cache.save();
    return { ok: true };
  });


  /**
   * 退出登录：本地凭证和登录窗口里的网页会话都要清掉。
   *
   * 只删 sessions.enc.json 是不够的：登录窗口跑在 persist:music-qq-login 分区里，
   * 那里的 cookie 还留着登录态，下次再点「登录」窗口一加载就自动登进去了，
   * 用户根本没机会扫码。所以这里把分区里的 cookies / storage 一起清掉，
   * 用户再点登录才会看到二维码。
   */
  ipcMain.handle('music:logout', async (_event, platform) => {
    const key = String(platform || '');
    musicPlatformConfig(key);
    await saveSecret(`music-${key}`, '').catch((error) => {
      console.error('[music-logout] 清除本地凭证失败:', error);
    });
    try {
      const partition = session.fromPartition(`persist:music-${key}-login`);
      await partition.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql'],
      });
      await partition.clearAuthCache();
    } catch (error) {
      // 分区可能压根没建过（从没登录过），这种失败不影响退出
      console.error('[music-logout] 清理登录分区失败:', error);
    }
    return { ok: true };
  });

  /** 验证保存的会话是否还有效。 */
  ipcMain.handle('music:verify', async (_event, platform) => {
    const key = String(platform || '');
    musicPlatformConfig(key);
    const session = await loadMusicSession(key, loadSecret);
    if (!session) return { ok: false, error: '还没有登录' };
    return verifyMusicSession(key, session);
  });

  /**
   * 登录账号的歌单列表。
   * 没登录或接口拿不到时返回 { ok:false, reason }，由界面提示，
   * 不要抛异常让用户看到一屏报错。
   */
  /**
   * 把 QQ / 酷狗 的曲目解析成可播放地址。
   * 走网易云找同名曲 + 内置 unblock 兜底，所以不需要会员也能听。
   */
  /*
   * 把曲目解析成可以直接播放的地址。
   *
   * 顺序（见 electron/music-source.js）：
   * 点歌台的换源现在走「多源并发竞速」：所有启用的音源同时开跑，谁先出
   * 地址用谁，结果缓存 20 分钟（详见 music-source.js）。
   * 默认只启用第三方免费音源：本地 NeteaseCloudMusicApi（含 /song/url/match
   * 换源解锁，VIP 曲目也能出地址）+ 咪咕；酷狗 / QQ 的匿名接口对付费曲目一律
   * 要会员，酷我常把人往手机端引，三家默认不参与，用户可在设置里打开。
   * 全部失败时再退回老的「网易云找同名曲 + unblock」那条路。
   */
  ipcMain.handle('music:sources-import', async (_event, input) => {
    let raw = '';
    if (input?.text) {
      raw = String(input.text).slice(0, 200000);
    } else if (input?.url) {
      const target = String(input.url).trim();
      if (!/^https?:\/\//i.test(target)) return { ok: false, reason: '订阅地址必须是 http(s) 链接' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(target, { signal: controller.signal });
        raw = await response.text();
      } catch (error) {
        return { ok: false, reason: `下载失败：${error.message}` };
      } finally {
        clearTimeout(timer);
      }
    } else {
      return { ok: false, reason: '没有拿到音源内容' };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: '不是合法的 JSON' };
    }
    const incoming = Array.isArray(parsed) ? parsed : [parsed];
    const accepted = [];
    const rejected = [];
    for (const def of incoming) {
      const check = validateCustomSource(def);
      if (!check.ok) {
        rejected.push(`${def?.name || def?.id || '未命名'}：${check.reason}`);
        continue;
      }
      accepted.push({
        id: String(def.id || def.name || '').slice(0, 60),
        name: String(def.name || def.id || '').slice(0, 60),
        search: def.search,
        url: def.url,
        headers: def.headers && typeof def.headers === 'object' ? def.headers : undefined,
        enabled: true,
      });
    }
    if (!accepted.length) return { ok: false, reason: rejected.join('；') || '里面没有可用的音源' };

    const current = Array.isArray(store.data.settings.musicCustomSources)
      ? store.data.settings.musicCustomSources
      : [];
    // 同 id 覆盖，最多存 20 个，免得被塞一堆死链把竞速拖垮
    const merged = current
      .filter((def) => !accepted.some((item) => item.id === def.id))
      .concat(accepted)
      .slice(0, 20);
    store.data.settings.musicCustomSources = merged;
    await store.saveNow().catch(() => {});
    // 音源变了，旧的换源结果可能不再合适
    clearMusicResolveCache();
    // 这个 IPC 不走 settings:update，得自己把新状态推给界面，否则卡片看不到刚导入的音源
    pushState(true);
    return { ok: true, sources: merged, added: accepted.length, rejected };
  });

  ipcMain.handle('music:resolve', async (_event, input) => {
    const song = input?.song || {};
    const level = String(input?.level || 'exhigh');
    const apiBase = normalizeNeteaseBase(input?.apiBase || '');
    const settings = store?.data?.settings || {};
    const attempts = [];
    try {
      const direct = await resolveSourceUrl(song, {
        apiBase,
        level,
        sources: settings.musicSources,
        customSources: settings.musicCustomSources,
      });
      if (direct?.url) return { ok: true, ...direct };
    } catch (error) {
      attempts.push(String(error.message || '解析失败'));
    }
    /*
     * 回退路径走的是本地网易云 API（unblock 会在服务端偷偷换成酷我等平台的
     * 直链），这里同样要认音源开关：网易云被停用就整条跳过；拿回来的地址
     * 宿主撞上被停用的音源（比如酷我）就丢弃，不能因为「能放」就绕过开关。
     */
    try {
      const flags = currentMusicSourceFlags();
      const resolved = flags.netease === false ? null : await resolvePlayableUrl(apiBase, song, level);
      if (resolved?.url) {
        const banned = disabledSourceOfUrl(resolved.url, flags);
        if (banned) {
          attempts.push(`回退地址来自已停用的音源（${banned}），已丢弃`);
        } else {
          return { ok: true, ...resolved };
        }
      }
      if (!resolved) {
        return {
          ok: false,
          reason: attempts.join('；') || '没有找到可播放的版本',
        };
      }
    } catch (error) {
      attempts.push(String(error.message || '解析失败'));
    }
    return { ok: false, reason: attempts.join('；') || '解析失败' };
  });

  /*
   * 歌词：按平台各自的公开接口取 LRC 文本。
   * 原生平台没词时用「歌名 + 歌手」去酷我 / QQ 再找一遍。
   */
  ipcMain.handle('music:lyric', async (_event, input) => {
    const song = input?.song || {};
    const apiBase = normalizeNeteaseBase(input?.apiBase || '');
    try {
      const result = await fetchSourceLyric(song, { apiBase });
      return { ok: Boolean(result?.lyric), lyric: result?.lyric || '', source: result?.source || '' };
    } catch (error) {
      return { ok: false, lyric: '', source: '', reason: String(error.message || '读取歌词失败') };
    }
  });

  ipcMain.handle('music:my-playlists', async (_event, platform) => {
    const key = String(platform || '');
    try {
      /*
       * 网易云单独处理：它的凭证是本地 API 的 cookie，不走 persist 分区。
       * 平台白名单校验（musicPlatformConfig）必须排在网易云分支之后：
       * PLATFORM_CONFIG 里只有 qq / kugou，这句以前写在 try 外面先执行，
       * 网易云一进来就抛「不支持的平台：netease」，界面上就变成了
       * 「我的歌单里有网易云，点进去永远是空的」。
       */
      if (key === 'netease') {
        // 本地服务可能要先启动，再加上逐次请求的超时，整体给个硬上限，
        // 免得界面停在「正在读取网易云账号里的歌单…」。
        const list = await playlistDeadline(
          neteaseMyPlaylists(neteaseSession.apiBase || 'http://127.0.0.1:3100'),
          45000,
          '读取网易云歌单'
        );
        return { ok: true, list, source: 'api' };
      }
      musicPlatformConfig(key);
      /*
       * QQ 音乐 / 酷狗：先走网页（在 persist 分区里让页面自己请求，
       * 用的是浏览器真实的 cookie / Referer / 签名上下文），
       * 失败再退回 OpenAPI 直连，保证不会比之前更差。
       */
      const result = await collectPlatformPlaylists(key);
      return { ok: true, list: result.list, source: result.source };
    } catch (error) {
      const reason = String(error.message || '读取歌单失败');
      /*
       * 500003 / Access Deny / 页面里找不到歌单链接，本质都是同一件事：
       * 对方不认这次请求的登录态。标成 expired，界面就能直接给一个
       * 「重新登录」的按钮，而不是让用户对着一串代码发呆。
       */
      const expired = musicLooksExpired(reason);
      return { ok: false, reason, expired };
    }
  });

  /**
   * 网易云「我创建的歌单」。
   *
   * 走本地 NeteaseCloudMusicApi：先 /login/status 拿 uid，再 /user/playlist。
   * 未登录时返回空列表而不是抛错，这样界面上「已登录但没歌单」和
   * 「根本没登录」能区分开。
   */
  async function neteaseMyPlaylists(apiBase) {
    const base = normalizeNeteaseBase(apiBase);
    /*
     * 先把本地服务探活 / 拉起来再查询。
     * 用户直接点「我的歌单」时，可能还没进行过任何播放，服务压根没启动；
     * 这时 neteaseGet 只会拿到 fetch failed，界面显示成「读取失败」，
     * 谁都看不出真正原因是「本地网易云服务没跑」。
     */
    await startNeteaseService(base).catch((error) => {
      console.error('[netease] 本地服务启动失败:', error);
    });
    const status = await neteaseGet(base, '/login/status');
    const body = status?.data || status || {};
    const account = body.account || body.profile || null;
    const profile = body.profile || account || null;
    const uid = profile?.userId || profile?.user_id || account?.id || '';
    if (!uid) {
      throw new Error('本地网易云服务没有登录（在网易云窗口里扫码后重试）');
    }
    const json = await neteaseGet(base, '/user/playlist', { uid: String(uid), limit: '1000' });
    const list = Array.isArray(json?.playlist) ? json.playlist : [];
    return list
      .map((item) => ({
        id: String(item.id || ''),
        // 「我喜欢的音乐」和自建/收藏歌单都算，用户想看的是自己账号里有什么
        name: String(item.name || '未命名歌单'),
        count: Number(item.trackCount || 0),
        cover: String(item.coverImgUrl || '').replace(/^http:/i, 'https:'),
        creator: String(item.creator?.nickname || ''),
        subscribed: Boolean(profile && item.creator?.userId && String(item.creator.userId) !== String(uid)),
      }))
      .filter((item) => item.id);
  }

  ipcMain.handle('netease:my-playlists', async () => {
    const apiBase = neteaseSession.apiBase || 'http://127.0.0.1:3100';
    try {
      const list = await neteaseMyPlaylists(apiBase);
      return { ok: true, list };
    } catch (error) {
      return { ok: false, reason: String(error.message || '读取网易云歌单失败') };
    }
  });

  /**
   * 一次性拿到所有已登录平台的歌单，按平台分组。
   *
   * 之前界面只显示「当前选中的那一个平台」，登了 QQ 音乐就看不到网易云的。
   * 这里并发去要，哪个失败就只让那个平台带错误，不影响其它平台。
   */
  ipcMain.handle('music:all-playlists', async (_event, input) => {
    const startedAt = Date.now();
    /*
     * 可选入参 { platforms: ['kugou'] }：只同步点名的这一家。
     *
     * 以前不论点哪个平台的「同步」，都会把四家全拉一遍 —— 用户抱怨的就是这个：
     * 只想知道酷狗有没有更新，结果 QQ 和网易云跟着一起转。
     * 不传 / 传空数组 = 全部，老的调用方式（preload 的 musicAllPlaylists()）照旧能用。
     */
    const PLATFORM_ORDER = ['netease', 'qq', 'kugou', 'kuwo'];
    const requested = Array.isArray(input?.platforms)
      ? [
          ...new Set(
            input.platforms
              .map((item) => String(item || '').trim().toLowerCase())
              .filter((item) => PLATFORM_ORDER.includes(item))
          ),
        ]
      : [];
    const wanted = requested.length ? requested : PLATFORM_ORDER;
    const status = await musicStatus();
    /*
     * 四家平台一律并发。
     * 以前网易云是「先 await 完再并发其它三家」，它自己有 45 秒硬上限，
     * 一旦本地 NeteaseCloudMusicApi 没起来，QQ/酷狗要白等 45 秒才开始动，
     * 用户看到的就是「点同步全部，转半天一个平台都没出来」。
     * 现在各自独立跑，谁慢谁慢，快的那几家先落进结果里。
     */
    const jobs = [];
    if (status?.netease?.loggedIn && wanted.includes('netease')) {
      jobs.push(
        (async () => {
          try {
            const list = await neteaseMyPlaylists(neteaseSession.apiBase || 'http://127.0.0.1:3100');
            return { platform: 'netease', label: '网易云', ok: true, list, error: '', expired: false };
          } catch (error) {
            const message = String(error.message || '读取失败');
            return {
              platform: 'netease',
              label: '网易云',
              ok: false,
              list: [],
              error: message,
              expired: musicLooksExpired(message),
            };
          }
        })()
      );
    }
    for (const key of ['qq', 'kugou', 'kuwo']) {
      if (!wanted.includes(key)) continue;
      if (!status?.[key]?.loggedIn) continue;
      jobs.push(
        (async () => {
          const label = key === 'qq' ? 'QQ 音乐' : key === 'kuwo' ? '酷我' : '酷狗';
          try {
            const result = await collectPlatformPlaylists(key);
            return { platform: key, label, ok: true, list: result.list, error: '', expired: false };
          } catch (error) {
            const message = String(error.message || '读取失败');
            return { platform: key, label, ok: false, list: [], error: message, expired: musicLooksExpired(message) };
          }
        })()
      );
    }
    // allSettled：某一家的实现里万一漏了 catch，也不至于把整次同步拖垮
    const settled = await Promise.allSettled(jobs);
    const groups = settled
      .map((item) =>
        item.status === 'fulfilled'
          ? item.value
          : { platform: 'unknown', label: '未知平台', ok: false, list: [], error: String(item.reason?.message || '未知错误'), expired: false }
      )
      // 固定顺序，界面上的分区不会因为谁先返回就跳来跳去
      .sort((a, b) => {
        return PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform);
      });
    return { ok: true, groups, syncedAt: Date.now(), durationMs: Date.now() - startedAt };
  });

  /*
   * 歌单广场：网易云 / QQ音乐 / 酷狗 / 酷我 四家的公开热门歌单，免登录。
   * 返回 { ok, lists: [...], page }，渲染层按页续拉。
   */
  ipcMain.handle('music:plaza', async (_event, input) => {
    const platform = String(input?.platform || '');
    const page = Math.max(1, Number(input?.page) || 1);
    try {
      const lists = await playlistDeadline(publicPlaza(platform, page), 20000, '读取歌单广场');
      return { ok: true, lists, page };
    } catch (error) {
      return { ok: false, reason: String(error.message || '读取歌单广场失败') };
    }
  });

  ipcMain.handle('music:playlist-songs', async (_event, input) => {
    const key = String(input?.platform || '');
    const playlistId = String(input?.playlistId || '');
    if (!playlistId) return { ok: false, reason: '缺少歌单 ID' };
    /*
     * 酷狗「自建歌单」的 ID 是 opaque 的（collect:uid:listid:chain:sign），
     * 它跟账号登录态没关系，也不该先拿去做一次账号路径的尝试 ——
     * 那条路只认纯数字 specialid，对它会直接抛「歌单 ID 无效」，
     * 白等一轮再退回来。认出来就直奔公开读取。
     */
    if (/^collect:/i.test(playlistId)) {
      try {
        const detail = await playlistDeadline(
          publicPlaylistSongs('kugou', playlistId),
          40000,
          '读取酷狗分享歌单'
        );
        return { ok: true, detail: { id: playlistId, name: detail.name, songs: detail.songs || [] } };
      } catch (error) {
        return { ok: false, reason: String(error.message || '读取酷狗分享歌单失败') };
      }
    }
    try {
      /*
       * 网易云的歌单走本地 API：它没有存盘会话，loadMusicSession 读不到，
       * 而 accountPlaylistSongs 也只支持 qq/kugou。
       *
       * 注意这里必须在 musicPlatformConfig(key) 之前处理：
       * PLATFORM_CONFIG 里只有 qq / kugou，没有 netease，
       * 之前那句校验会直接抛「不支持的平台：netease」，
       * 被 catch 吞成 {ok:false}，界面上又没地方显示这个 reason，
       * 于是用户看到的就是「歌单列表出来了，点进去毫无反应」。
       */
      if (key === 'netease') {
        return await playlistDeadline(
          (async () => {
        /*
         * 公开直连优先：music.163.com 的 v6 接口免登录可用，
         * 不依赖本地服务；失败（私有歌单/网络问题）再退本地 API。
         */
        try {
          const pub = await publicPlaylistSongs('netease', playlistId);
          if (pub && pub.songs && pub.songs.length) {
            return { ok: true, detail: { id: playlistId, name: pub.name, songs: pub.songs } };
          }
        } catch (pubError) {
          console.error('[netease] 公开直连失败，退本地服务:', pubError && pubError.message);
        }
        const apiBase = neteaseSession.apiBase || 'http://127.0.0.1:3100';
        // 本地服务没起来就先把它拉起来，否则读取必然失败
        await startNeteaseService(apiBase).catch((error) => {
          console.error('[netease] 本地服务启动失败:', error);
        });
        /*
         * /playlist/detail 自带完整曲目（本地 API 的 module/playlist_detail.js
         * 用的是 n=100000），所以一次请求就够；
         * 万一拿到的是空列表，再走 /playlist/track/all 补一次。
         */
        let json = null;
        let playlist = null;
        try {
          json = await neteaseGet(apiBase, '/playlist/detail', { id: playlistId });
          playlist = json?.playlist || null;
        } catch (error) {
          console.error('[netease] 读取歌单详情失败:', error);
        }
        let tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
        if (!tracks.length && playlist) {
          /*
           * /playlist/track/all 每页最多 200 条，之前只拉了一页，
           * 381 首的歌单后半截全是空的。改成 offset 分页循环拉全：
           * 空页 / 不满一页 / 去重后没新增，三个条件任一命中就停。
           */
          const PAGE = 200;
          const seen = new Set();
          for (let offset = 0; offset < PAGE * 50; offset += PAGE) {
            const all = await neteaseGet(apiBase, '/playlist/track/all', {
              id: playlistId,
              limit: String(PAGE),
              offset: String(offset),
            }).catch(() => null);
            const rows = Array.isArray(all?.songs) ? all.songs : [];
            if (!rows.length) break;
            let added = 0;
            for (const row of rows) {
              const songId = String(row?.id || '');
              if (!songId || seen.has(songId)) continue;
              seen.add(songId);
              tracks.push(row);
              added += 1;
            }
            if (!added || rows.length < PAGE) break;
          }
        }
        if (!playlist && !tracks.length) {
          return { ok: false, reason: '读取网易云歌单失败（本地网易云服务可能没启动，或歌单 ID 无效）' };
        }
        const songs = tracks.map((song) => ({
          title: String(song.name || ''),
          artist: String(
            (song.ar || song.artists || []).map((a) => a.name || '').filter(Boolean).join(' / ')
          ),
          cover: String(song.al?.picUrl || song.album?.picUrl || '').replace(/^http:/i, 'https:'),
          neteaseId: String(song.id || ''),
          mid: String(song.id || ''),
          hash: '',
        }));
        return {
          ok: true,
          detail: {
            id: playlistId,
            name: String(playlist?.name || '歌单'),
            songs,
          },
        };
          })(),
          30000,
          '读取网易云歌单'
        );
      }
      /*
       * 酷我：登录态歌单走老接口 nplserver（账号数据，含私有列表）；
       * 没登录或账号路径失败时退到公开详情接口（广场歌单）。
       * 详情要逐个 musicInfo 补元信息，给 35 秒。
       */
      if (key === 'kuwo') {
        const savedKuwo = await loadMusicSession('kuwo', loadSecret);
        if (savedKuwo) {
          const creds = await mergePartitionCookies('kuwo', savedKuwo);
          try {
            const detail = await playlistDeadline(
              accountPlaylistSongs('kuwo', creds, playlistId),
              35000,
              '读取酷我歌单'
            );
            return { ok: true, detail: { id: playlistId, name: detail.name, songs: detail.songs || [] } };
          } catch (accountError) {
            console.error('[kuwo] 登录歌单失败，退公开详情:', accountError && accountError.message);
          }
        }
        const pub = await playlistDeadline(
          publicPlaylistSongs('kuwo', playlistId),
          30000,
          '读取酷我公开歌单'
        );
        return { ok: true, detail: { id: playlistId, name: pub.name, songs: pub.songs || [] } };
      }
      musicPlatformConfig(key);
      const session = await loadMusicSession(key, loadSecret);
      /*
       * 没登录时直接走公开详情（歌单广场的卡片本来就是公开歌单）；
       * 登录了但账号路径失败，也退公开详情再试一次。
       */
      if (!session) {
        const pub = await playlistDeadline(
          publicPlaylistSongs(key, playlistId),
          25000,
          '读取公开歌单'
        ).catch(() => null);
        if (pub && pub.songs && pub.songs.length) {
          return { ok: true, detail: { id: playlistId, name: pub.name, songs: pub.songs } };
        }
        return { ok: false, reason: '还没有登录，且公开详情不可用' };
      }
      let detail;
      try {
        detail =
          playlistId === LIKED_ID
            ? await playlistDeadline(
                webLikedSongs(key, session, {
                  getWindow: async (target) => ({ win: musicLoginWindow(target), ownWindow: true }),
                }),
                34000,
                '读取我喜欢的音乐'
              )
            : await playlistDeadline(
                accountPlaylistSongs(key, session, playlistId),
                25000,
                '读取歌单曲目'
              );
      } catch (accountError) {
        if (playlistId === LIKED_ID) throw accountError;
        console.error('[music] 账号路径读取失败，退公开详情:', accountError && accountError.message);
        detail = await playlistDeadline(
          publicPlaylistSongs(key, playlistId),
          25000,
          '读取公开歌单'
        );
      }
      return { ok: true, detail };
    } catch (error) {
      return { ok: false, reason: String(error.message || '读取歌单失败') };
    }
  });

  /**
   * 歌单分享链接 → 平台 + 歌单 ID。
   * 只做解析，不去取曲目，方便界面先告诉用户「识别成酷狗歌单了」再去拉。
   * 认不出来时把原因原样回给界面，由界面 toast 出来，
   * 绝不让用户看到一个干巴巴的「导入失败」。
   */
  ipcMain.handle('music:parse-playlist-link', async (_event, input) => {
    try {
      /*
       * 必须 await：解析酷狗短链要跟一次 302（见 music-playlists.js 里的说明），
       * 函数已经是 async 的。漏了 await 会拿到一个 Promise，
       * 展开成 {...promise} 就是空对象，界面只会看到 ok:true 但没有任何字段。
       */
      const parsed = await parseSharedPlaylistLink(typeof input === 'string' ? input : input?.url || '');
      return { ok: true, ...parsed };
    } catch (error) {
      return { ok: false, reason: String(error.message || '没有识别出歌单 ID') };
    }
  });

  // QQ 音乐 / 酷狗的公开榜单：只读曲目列表，播放仍走网易云或原站
  /**
   * 榜单：默认返回三家合并去重后的列表。
   * 传 platform 时保留旧的单平台行为，方便回退。
   */
  ipcMain.handle('music:charts', async (_event, input) => {
    const platform = typeof input === 'string' ? input : input?.platform || '';
    const apiBase = normalizeNeteaseBase(
      (typeof input === 'object' && input?.apiBase) || ''
    );
    if (!platform || platform === 'all') {
      return mergedCharts(apiBase);
    }
    return { charts: await musicCharts(platform, apiBase), counts: { [platform]: 0, merged: 0 } };
  });

  ipcMain.handle('music:chart-songs', async (_event, input) => {
    const limit = Math.max(1, Math.min(60, Number(input?.limit) || 30));
    const apiBase = normalizeNeteaseBase(input?.apiBase || '');

    // 新的合并结构：直接给 chart 对象（含 sourceIds）
    if (input?.chart && typeof input.chart === 'object') {
      const detail = await mergedChartSongs(input.chart, apiBase, limit);
      return { ...detail, songs: detail.songs };
    }

    // 旧调用方式保持兼容
    const platform = String(input?.platform || '');
    const chartId = String(input?.chartId || '');
    if (!chartId) throw new Error('缺少榜单 ID');
    return chartSongs(platform, chartId, limit, apiBase);
  });

  /**
   * 搜索歌曲：三个平台都走公开接口，不需要登录。
   * platform 传 all（或不传）时并发搜全部三家，单个平台失败不影响其它平台。
   */
  ipcMain.handle('music:search', async (_event, input) => {
    const platform = String(input?.platform || 'all');
    const keyword = String(input?.keyword || '').trim();
    const limit = Math.max(1, Math.min(50, Number(input?.limit) || 30));
    const apiBase = normalizeNeteaseBase(input?.apiBase || '');
    if (!keyword) return { keyword: '', songs: [], errors: [] };
    const result = await searchSongs(platform, keyword, apiBase, limit);
    // 搜索结果也按音源开关过滤：停用了酷我，列表里就不该再出现「酷我」标签
    const flags = currentMusicSourceFlags();
    const songs = (result?.songs || []).filter((item) => flags[item.platform] !== false);
    return { ...result, songs };
  });

  ipcMain.handle('netease:song-meta', async (_event, input) => {
    const apiBase = normalizeNeteaseBase(input?.apiBase);
    const id = String(input?.id || '');
    if (!id) return { lyric: '' };
    const [detail, lyric] = await Promise.all([
      neteaseGet(apiBase, '/song/detail', { ids: id }).catch(() => null),
      neteaseGet(apiBase, '/lyric', { id }).catch(() => null),
    ]);
    const song = detail?.songs?.[0];
    return {
      name: song?.name || '',
      artist: (song?.ar || []).map((item) => item.name).filter(Boolean).join(' / '),
      cover: String(song?.al?.picUrl || '').replace(/^http:/i, 'https:'),
      lyric: lyric?.lrc?.lyric || '',
      translated: lyric?.tlyric?.lyric || '',
    };
  });

  ipcMain.handle('netease:qr-create', async (_event, input) => {
    const apiBase = normalizeNeteaseBase(input?.apiBase);
    const keyJson = await neteaseGet(apiBase, '/login/qr/key');
    const key = keyJson.data?.unikey;
    if (!key) throw new Error('本地 API 没有返回二维码 key');
    const qrJson = await neteaseGet(apiBase, '/login/qr/create', { key, qrimg: 'true' });
    return { apiBase, key, qrimg: qrJson.data?.qrimg || '', qrurl: qrJson.data?.qrurl || '' };
  });

  /**
   * 把 NeteaseCloudMusicApi 吐出来的 cookie 串修成合法的请求 Cookie 头。
   *
   * 那个接口返回的 cookie 是【Set-Cookie 格式】：
   *   `NMTID=xxx; Max-Age=315360000; Expires=Wed, 22 Oct 2036 ...; Path=/;`
   * 直接塞进请求头会把 Max-Age / Expires / Path 当成 cookie 名，
   * 服务端解析失败 → 认不出登录态 → 退成匿名账号（profile 为 null）。
   * 这里只保留 name=value 形式的片段，属性名白名单外的都丢掉。
   */
  function sanitizeNeteaseCookie(raw) {
    const ATTRS = new Set([
      'max-age', 'expires', 'path', 'domain', 'secure', 'httponly', 'samesite',
      'partitioned', 'priority', 'version', 'comment',
    ]);
    const parts = [];
    for (const piece of String(raw || '').split(';')) {
      const text = piece.trim();
      if (!text) continue;
      const eq = text.indexOf('=');
      if (eq <= 0) continue;
      const name = text.slice(0, eq).trim();
      if (!name || ATTRS.has(name.toLowerCase())) continue;
      parts.push(text);
    }
    return parts.join('; ');
  }

  ipcMain.handle('netease:qr-check', async (_event, input) => {
    const apiBase = normalizeNeteaseBase(input?.apiBase);
    const json = await neteaseGet(apiBase, '/login/qr/check', { key: input?.key });
    if (Number(json.code) === 803 && json.cookie) {
      const cookie = sanitizeNeteaseCookie(json.cookie);
      neteaseSession = { apiBase, cookie };
      await saveSecret('netease', JSON.stringify(neteaseSession)).catch(() => {});
    }
    return {
      code: Number(json.code) || 0,
      message: String(json.message || ''),
      loggedIn: Boolean(neteaseSession.cookie && neteaseSession.apiBase === apiBase),
    };
  });

  ipcMain.handle('netease:status', async () => ({
    loggedIn: Boolean(neteaseSession.cookie),
    apiBase: neteaseSession.apiBase,
  }));

  ipcMain.handle('netease:logout', async () => {
    neteaseSession = { apiBase: '', cookie: '' };
    await saveSecret('netease', '').catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('games:update-cover', async (_event, id, cover) => {
    const game = store.data.games.find((item) => item.id === id);
    if (!game) throw new Error('没有找到这个游戏');
    const value = String(cover || '').trim();
    if (value && !fs.existsSync(path.join(app.getPath('userData'), value))) {
      throw new Error('封面文件不存在');
    }
    game.cover = value;
    await store.saveNow();
    pushState(true);
    return publicGame(game);
  });

  ipcMain.handle('games:update', async (_event, id, input) => {
    const index = store.data.games.findIndex((g) => g.id === id);
    if (index === -1) throw new Error('没有找到这个游戏');
    const current = store.data.games[index];
    const next = normalizeGame(input);
    /*
     * 调用方没提渲染后端就沿用原值。
     * 收藏、改名这些局部更新都会走这个 IPC，而 normalizeGame 对缺失字段给的是默认值，
     * 直接合并会把用户设好的 DX12 悄悄改回「跟随默认」——用户只会觉得「设了不生效」。
     */
    if (!input || input.renderApi === undefined) {
      next.renderApi = renderApi.normalizeMode(current.renderApi);
    }
    const merged = {
      ...current,
      ...next,
      demo: current.demo && !next.target ? current.demo : false,
      id,
    };
    if (next.target !== current.target) {
      const active =
        (merged.servers || []).find((server) => server.id === merged.activeServerId) ||
        (merged.servers || [])[0];
      if (active) {
        active.path = next.target || '';
        active.root = next.target ? path.dirname(next.target) : '';
      }
    }
    ensureServers(merged);
    store.data.games[index] = merged;
    await store.saveNow();
    pushState(true);
    return publicGame(merged);
  });

  /*
   * 只改渲染后端这一个字段（启动页「开始游戏」下面的三段式开关走这里）。
   *
   * 不复用 games:update 是有原因的：那个入口收的是整份编辑表单，只传 renderApi 会被
   * normalizeGame 当成「没填游戏名称」直接抛错；补齐所有字段又等于把编辑逻辑抄一遍，
   * 漏一个字段就会把用户的改名/启动参数覆盖回默认值。这里点名改一个键，风险为零。
   */
  ipcMain.handle('games:render-api', async (_event, id, mode) => {
    const game = store.data.games.find((item) => item.id === id);
    if (!game) throw new Error('没有找到这个游戏');
    // 参数只在启动那一刻传给客户端，运行中改了也不会生效，直接挡住比让它「看起来成功了」好
    if (running.has(id)) throw new Error('游戏正在运行，关掉之后再切换渲染后端');
    game.renderApi = renderApi.normalizeMode(mode);
    await store.saveNow();
    pushState(true);
    return publicGame(game);
  });

  ipcMain.handle('games:remove', async (_event, id) => {
    if (running.has(id)) {
      await killGame(id);
    }
    const index = store.data.games.findIndex((g) => g.id === id);
    if (index === -1) return false;
    const [removed] = store.data.games.splice(index, 1);
    if (removed?.builtinKey) {
      store.data.hiddenBuiltins = Array.from(
        new Set([...(store.data.hiddenBuiltins || []), removed.builtinKey])
      );
    }
    if (removed && removed.cover && removed.cover.startsWith('covers/cover-')) {
      fsp.unlink(path.join(app.getPath('userData'), removed.cover)).catch(() => {});
    }
    await store.saveNow();
    pushState(true);
    return true;
  });

  ipcMain.handle('games:clear-demo', async () => {
    store.data.games = store.data.games.filter((g) => !g.demo);
    await store.saveNow();
    pushState(true);
    return true;
  });

  ipcMain.handle('games:detect', async (_event, id) => {
    const targets = id
      ? store.data.games.filter((game) => game.id === id)
      : store.data.games.filter((game) => game.builtin);
    if (!targets.length) {
      return { ok: false, error: '没有找到可以自动检测的游戏' };
    }
    /*
     * 先修历史错配，再检测。
     * 顺序很重要：老数据里「官服行 = 国际服客户端」时，先检测会把同一条路径
     * 也写进国际服行，两行指向同一个 exe，后面的修复就看不出该清哪一条了。
     * 先修能把路径搬回国际服行，检测再写一次也只是原地覆盖。
     */
    let repaired = await repairServerChannels();
    const updated = [];
    for (const game of targets) {
      if (!game.builtinKey) continue;
      const found = await detectGame(game.builtinKey);
      if (found) {
        const active = (game.servers || []).find((server) => server.id === game.activeServerId);
        const activeHadPath = Boolean(active && active.path);
        // 同 detectBuiltins：写进真实渠道那一行，没有官服客户端时不再凭空占用官服行。
        const channel = await detectionChannel(game, found);
        // 留一行日志：以后用户再报「被识别成官服」，从 launch.log 就能看到判定结果与依据
        writeLaunchLog(`detect ${game.builtinKey}: ${channel || '未知'} ← ${found}`);
        const detected = serverForDetected(game, channel);
        if (detected) {
          detected.path = found;
          detected.root = path.dirname(found);
          detected.incomplete = false;
          detected.unavailable = false;
        }
        if (detected && (!active || !activeHadPath)) {
          game.activeServerId = detected.id;
          game.target = found;
          game.workDir = path.dirname(found);
        }
        updated.push(game.name);
      }
    }
    // 检测完再扫一遍：discover 类逻辑可能又把路径写回了旧行
    repaired += await repairServerChannels();
    if (updated.length || repaired) {
      await store.saveNow();
      pushState(true);
    }
    if (!updated.length) {
      return {
        ok: false,
        error: id
          ? '没有自动找到安装位置，可以手动选择启动程序，或前往官网下载。'
          : '没有自动找到已安装的游戏，可以手动添加或前往官网下载。',
      };
    }
    return {
      ok: true,
      updated,
      path: id ? targets[0].target : null,
    };
  });

  /*
   * 按「某个服务器的渠道」扫一遍。
   *
   * 和 games:detect 的区别：那个是「这个游戏装在哪」，找到就写进对应渠道那一行；
   * 这个是「B服 装在哪」，只认 B服 的 exe。用户在 B服 那一行点自动扫描，
   * 期待的显然是 B服 被填上，而不是官服那一行又刷新一遍。
   */
  ipcMain.handle('games:detect-server', async (_event, id, serverId) => {
    const game = store.data.games.find((item) => item.id === id);
    if (!game) return { ok: false, error: '没有找到这个游戏' };
    const server = (game.servers || []).find((item) => item.id === serverId);
    if (!server) return { ok: false, error: '没有找到这个服务器' };
    const found = await detectServerExecutable(game, server);
    if (!found) {
      return {
        ok: false,
        error: `没扫到${server.name}的客户端。它可能还没下载，或者装在非常规目录里 —— 可以手动选路径。`,
      };
    }
    server.path = found;
    server.root = path.dirname(found);
    server.incomplete = false;
    server.unavailable = false;
    await store.saveNow();
    pushState(true);
    return { ok: true, path: found, name: server.name };
  });

  ipcMain.handle('servers:add', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    const serverPath = String(input?.path || '').trim();
    if (!serverPath || !targetExists(serverPath)) throw new Error('请选择一个存在的启动程序');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(serverPath)) throw new Error('服务器配置需要一个本地启动程序');
    if (!Array.isArray(game.servers)) game.servers = [];
    const name = String(input?.name || '').trim().slice(0, 40) || `服务器 ${game.servers.length + 1}`;
    const serverRoot = String(input?.root || '').trim();
    if (serverRoot) {
      let rootStat;
      try { rootStat = fs.statSync(serverRoot); } catch {}
      if (!rootStat || !rootStat.isDirectory()) throw new Error('自定义根目录不存在，请重新选择');
    }
    const server = {
      id: crypto.randomUUID(),
      name,
      channel: 'custom',
      path: serverPath,
      root: serverRoot || path.dirname(serverPath),
      addedAt: new Date().toISOString(),
    };
    game.servers.push(server);
    if (!game.activeServerId) game.activeServerId = server.id;
    ensureServers(game);
    await store.saveNow();
    pushState(true);
    return publicGame(game);
  });

  ipcMain.handle('servers:update', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    const prevPath = server.path;
    const prevRoot = server.root;
    server.name = String(input?.name || '').trim().slice(0, 40) || server.name;
    const serverPath = String(input?.path || '').trim();
    if (serverPath) {
      if (!targetExists(serverPath)) throw new Error('这个启动程序不存在');
      server.path = serverPath;
      server.confirmed = true;
      // 用户手动指定了有效启动程序：它就是一个可用的客户端，不再视为「需要重建」。
      server.incomplete = false;
      server.unavailable = false;
      if (server.packPath === server.path) server.packPath = '';
    }
    const serverRoot = String(input?.root || '').trim();
    if (serverRoot) {
      let rootStat;
      try { rootStat = fs.statSync(serverRoot); } catch {}
      if (!rootStat || !rootStat.isDirectory()) throw new Error('自定义根目录不存在，请重新选择');
      server.root = serverRoot;
    } else if (serverPath) {
      server.root = path.dirname(serverPath);
    }
    if (game.activeServerId === server.id && server.path) {
      game.target = server.path;
      game.workDir = server.root;
    }
    // 换了安装目录/启动程序，旧渠道的预下载状态不能再挂到新目录上（切服假状态）。
    if (prevPath !== server.path || prevRoot !== server.root) server.predownload = null;
    ensureServers(game);
    await store.saveNow();
    pushState(true);
    return publicGame(game);
  });

  /*
   * 清路径 / 移出配置时，把所有「跟着这个路径走」的运行时记忆一并清掉。
   *
   * 以前只清 path/root/incomplete/packPath，originalRoot、runtimeLinked、
   * rootDir、confirmed 全都留着。于是清完 B服 之后，官服那条的
   * endfieldBaseRoot() 还会拿 B服 的 originalRoot 当基础、
   * hasOtherInstalledServer 也还以为 B服 装着客户端，点「重建」就真的
   * 去硬链接重做一份 —— 用户看到的是「我明明有官服，怎么还要重建」。
   */
  function resetServerState(server) {
    server.path = '';
    server.root = '';
    server.incomplete = false;
    server.packPath = '';
    server.originalRoot = '';
    server.rootDir = '';
    server.runtimeLinked = false;
    server.legacyRuntime = false;
    server.confirmed = false;
    server.unavailable = false;
    server.predownload = null;
  }

  ipcMain.handle('servers:clear-path', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再修改服务器');
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    resetServerState(server);
    ensureServers(game);
    await store.saveNow();
    pushState(true);
    return publicGame(game);
  });

  ipcMain.handle('servers:remove', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再修改服务器');
    const target = game.servers.find((item) => item.id === input?.serverId);
    if (target?.builtinServer || game.builtin) {
      if (!target) throw new Error('没有找到这个服务器');
      resetServerState(target);
      await store.saveNow();
      pushState(true);
      return publicGame(game);
    }
    if (game.servers.length <= 1) throw new Error('至少保留一个服务器配置');
    game.servers = game.servers.filter((server) => server.id !== input?.serverId);
    if (!game.servers.some((server) => server.id === game.activeServerId)) {
      game.activeServerId = game.servers[0]?.id || null;
    }
    ensureServers(game);
    await store.saveNow();
    pushState(true);
    return publicGame(game);
  });

  ipcMain.handle('servers:activate', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再切换服务器');
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    if (server.incomplete && game.builtinKey !== 'endfield') {
      throw new Error('这个目录是资源替换包，不是完整客户端；请点这一行的下载按钮生成国际服客户端');
    }
    if (!server.path || !targetExists(server.path)) {
      if (game.builtinKey !== 'endfield') {
        throw new Error('这个服务器还没有配置启动程序，先点“编辑”选择客户端');
      }
    }
    if (game.builtinKey === 'genshin' && server.channel === 'global') {
      /*
       * 生成国际服运行时可能要搬几十 GB：以前这里不传 onProgress，用户点「切换」
       * 只看到一个不动的转圈。现在照终末地那条路把进度发到同一个频道，
       * 界面上现有的切换提示条就能显示「百分比 + 已处理/总量 + 速度」。
       */
      const prepared = await prepareGenshinPackRuntime(game, server, (progress) =>
        send('endfield:progress', { ...progress, serverName: server.name })
      );
      if (prepared) {
        server.path = prepared.executable;
        server.root = prepared.runtimeRoot;
        server.runtimeLinked = true;
      }
    }
    if (game.builtinKey === 'endfield') {
      // 有可用路径时保持“尽力而为”：渠道包/基础客户端缺失不阻断已就绪服务器的切换；
      // 没有任何路径时才把自动生成的错误抛给用户看。
      // 旧单 work 混合目录绝不能算「已就绪、可以静默沿用」：它正是 B服 6 秒崩
      // 的配方。即使迁移没覆盖到的历史数据残留了指向它的路径，这里也要当作
      // 没有可用路径，让重建失败显式报错，而不是被「尽力而为」吞掉又启动旧目录。
      const hadPath =
        server.path &&
        targetExists(server.path) &&
        !isEndfieldLegacyWorkRoot(path.dirname(server.path));
      // 切服是「官服删了」最常走的入口：只剩运行时可用时必须能建
      const prepared = await ensureEndfieldChannelRuntime(game, server, { allowRuntimeBase: true }).catch((error) => {
        if (hadPath) return null;
        throw error;
      });
      if (prepared) {
        server.path = prepared.launchPath;
        server.root = prepared.runtimeRoot;
        // 官服直启自己客户端、没有生成独立运行时时不贴「差异运行时」标签
        server.runtimeLinked = !prepared.directBase;
      }
    }
    // 明日方舟（2.4.0 合并）：官服 / B服 在同一套安装目录里，按终末地那套运行时
    // 方案复制出独立目录，大文件硬链接、渠道 SDK 换成目标服的。缺 B服 载荷时直接抛错。
    if (game.builtinKey === 'arknights') {
      // 同上：方舟硬链接运行时也要报进度，否则切服时界面一动不动
      await ensureArknightsRuntime(game, server, {
        onProgress: (progress) => send('endfield:progress', { ...progress, serverName: server.name }),
      });
    }
    /*
     * 版本号跟着当前客户端走。以前它是「一个游戏一个」，官服更到 7.2 再切到还是 7.1
     * 的国际服，启动页仍写着 v7.2 —— 看着像切了个假服。以目标客户端 config.ini
     * 为准重读一次；读不出来（非米哈游客户端 / 没这份 ini）就保持原值不动。
     */
    const clientVersion = clientChannel.gameVersionFromPath(server.path);
    if (clientVersion) {
      game.version = clientVersion;
      game.versionName = clientVersion;
    }
    /*
     * 切成功了：记下「用过切服」，并在这个用户还没表过态（null）时把对应游戏的
     * 渠道包自动更新打开。两个游戏各一个开关：只切过终末地的人，不该被顺手打开
     * 明日方舟那条。手动关掉的（false）保持关着 —— 用户明确表过态就不替他改。
     */
    store.data.settings.hasSwitchedServer = true;
    if (game.builtinKey === 'arknights') {
      if (store.data.settings.autoUpdateArknightsPacks == null) {
        store.data.settings.autoUpdateArknightsPacks = true;
      }
    } else if (store.data.settings.autoUpdateEndfieldPacks == null) {
      store.data.settings.autoUpdateEndfieldPacks = true;
    }
    game.activeServerId = server.id;
    game.target = server.path;
    game.workDir = server.root || path.dirname(server.path);
    await store.saveNow();
    pushState(true);
    /*
     * 切完再问一次这个渠道有没有更新（不阻塞返回，界面先切过去）。
     * 以前这一步要等 30 分钟的自动检查，切到落后的那个服时按钮不会变「更新游戏」。
     */
    setTimeout(() => {
      refreshPredownloadAfterSwitch(game).catch(() => {});
    }, 400);
    return publicGame(game);
  });

  /*
   * 解析硬链接的两个根目录：既支持已配置的服务器，也支持直接指定两个文件夹。
   * 「检测」和「真正建立链接」共用这一套校验，免得出现预览能过、执行却报错。
   */
  function resolveLinkRoots(game, input) {
    const customSource = String(input?.sourceRoot || '').trim();
    const customTarget = String(input?.targetRoot || '').trim();
    if ((customSource || customTarget) && (!customSource || !customTarget)) {
      throw new Error('自定义文件夹需要同时指定源目录和目标目录');
    }
    if (customSource && customTarget) {
      // 自定义模式下不校验已配置服务器的启动程序，只要求两个目录存在且同盘。
      // 这在“没有对应渠道的 .exe 客户端，但本机有完整游戏目录”时尤其有用。
      let stat;
      try { stat = fs.statSync(customSource); } catch {}
      if (!stat || !stat.isDirectory()) throw new Error('源目录不存在，请重新选择');
      try { stat = fs.statSync(customTarget); } catch {}
      if (!stat || !stat.isDirectory()) throw new Error('目标目录不存在，请重新选择');
      // 先 normalize：手填的路径可能是 "G:/xxx"（正斜杠），
      // path.parse('G:/x').root 得到 "G:/"，和 "G:////" 不相等，会误判成不同盘。
      const sourceDrive = path.parse(path.normalize(customSource)).root.toLowerCase();
      const targetDrive = path.parse(path.normalize(customTarget)).root.toLowerCase();
      if (sourceDrive !== targetDrive) {
        throw new Error('两个目录不在同一个磁盘分区，Windows 无法创建硬链接');
      }
    } else {
      const source = game.servers.find((item) => item.id === input?.sourceId);
      const target = game.servers.find((item) => item.id === input?.targetId);
      if (!source || !target) throw new Error('请选择源服务器和目标服务器');
      if (source.id === target.id) throw new Error('源服务器和目标服务器不能相同');
      if (!source.path || !target.path) throw new Error('两个服务器都需要先配置启动程序');
      if (!source.root || !target.root) throw new Error('无法确定安装目录');
      if (!targetExists(source.path) || !targetExists(target.path)) throw new Error('启动程序不存在，请重新配置');
      // 同上一处：先 normalize 再取盘符，避免正斜杠路径被误判成不同盘。
      const sourceDrive = path.parse(path.normalize(source.root)).root.toLowerCase();
      const targetDrive = path.parse(path.normalize(target.root)).root.toLowerCase();
      if (sourceDrive !== targetDrive) {
        throw new Error('两个目录不在同一个磁盘分区，Windows 无法创建硬链接');
      }
      return {
        sourceRoot: source.root,
        targetRoot: target.root,
        sourceName: source.name,
        targetName: target.name,
      };
    }
    return {
      sourceRoot: customSource,
      targetRoot: customTarget,
      sourceName: path.basename(customSource),
      targetName: path.basename(customTarget),
    };
  }

  ipcMain.handle('servers:link', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再建立硬链接');

    // 检测与执行共用同一套根目录解析
    const { sourceRoot, targetRoot, sourceName, targetName } = resolveLinkRoots(game, input);

    const jobId = crypto.randomUUID();
    const signal = { cancelled: false };
    linkJobs.set(jobId, signal);
    send('link:progress', {
      jobId,
      gameId: game.id,
      phase: 'scan',
      processed: 0,
      total: 0,
      linked: 0,
      savedBytes: 0,
      skipped: 0,
      current: '正在扫描两个客户端…',
    });

    try {
      const result = await linkTrees({
        sourceRoot,
        targetRoot,
        mode: input?.mode === 'fast' ? 'fast' : 'full',
        signal,
        onProgress: (progress) => {
          send('link:progress', {
            jobId,
            gameId: game.id,
            ...progress,
            sourceName,
            targetName,
          });
        },
      });
      send('link:done', { jobId, gameId: game.id, ...result });
      return { ok: true, jobId, ...result };
    } catch (error) {
      send('link:done', { jobId, gameId: game.id, ok: false, error: error.message });
      throw error;
    } finally {
      linkJobs.delete(jobId);
    }
  });

  ipcMain.handle('servers:link-preview', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再检测');
    const { sourceRoot, targetRoot, sourceName, targetName } = resolveLinkRoots(game, input);

    const jobId = crypto.randomUUID();
    const signal = { cancelled: false };
    linkJobs.set(jobId, signal);
    const sendPreview = (payload) => send('link:preview-progress', { jobId, gameId: game.id, sourceName, targetName, ...payload });

    try {
      const result = await previewTrees({
        sourceRoot,
        targetRoot,
        mode: input?.mode === 'fast' ? 'fast' : 'full',
        signal,
        onProgress: sendPreview,
      });
      send('link:preview-done', { jobId, gameId: game.id, ...result });
      return { ok: true, jobId, ...result };
    } catch (error) {
      send('link:preview-done', { jobId, gameId: game.id, ok: false, error: error.message });
      throw error;
    } finally {
      linkJobs.delete(jobId);
    }
  });

  ipcMain.handle('servers:prepare-endfield', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game || game.builtinKey !== 'endfield') throw new Error('这个功能只用于明日方舟：终末地');
    if (await pruneStaleRunning()) pushState(true);
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再切换服务器');
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    if (server.channel === 'official') throw new Error('官服请直接指定官服客户端');

    if (!ENDFIELD_PACK_NAMES[server.channel]) throw new Error('这个服务器没有对应的渠道差异包');

    // 渠道包缺失时会在 ensureEndfieldChannelRuntime 里现下（它自己调
    // ensureEndfieldPackFor），这里不再重复准备一遍。
    // 基础客户端的挑选、每渠道运行时目录的位置与重叠校验，也全部在那边统一做
    // —— 它本来就是「启动游戏」时走的那条路，两条路合一才不会慢慢走偏。
    /*
     * 手动「重新生成」传 forceRuntime:true，强制从最新官服本体整树重建该渠道的
     * 独立运行时；buildEndfieldChannelRuntime 会把旧目录的 Endfield_Data\Persistent
     * （用户下好的语音包 + 游戏自己维护的索引）整体搬到 staging 再就位，不会丢下载内容。
     */
    try {
      const result = await ensureEndfieldChannelRuntime(game, server, {
        runtimeRoot: input?.runtimeRoot,
        forceRuntime: true,
        allowRuntimeBase: true,
      });
      ensureServers(game);
      await store.saveNow();
      pushState(true);
      return {
        ok: true,
        runtimeRoot: result.runtimeRoot,
        path: result.launchPath,
        linked: result.linked || 0,
        overlay: result.overlay || 0,
        packDownloaded: result.packDownloaded || false,
      };
    } catch (error) {
      pushState(true);
      throw error;
    }
  });

  /**
   * 估算生成差异客户端要占多少空间。
   *
   * 生成时会把基础客户端里内容相同的文件直接硬链接过去，那部分不额外占空间，
   * 所以这里只给两个确定的事实：目标盘还剩多少、基础客户端有多大。
   * 客户端体积靠遍历目录算，给了 4 秒上限 —— 超大客户端算不完就先报可用空间，
   * 不能让「看个数字」把界面卡住。
   *
   * 2026-11-08：多给一个 copyBytes —— 真正要写盘的那部分。
   *
   * 以前只报「基础客户端 67GB」，而实际生成时 62GB 的基础资源是硬链接（不占额外空间），
   * 真正落盘的只有 Persistent / U8Data / sdkdata 那些可写文件约 3.7GB。界面拿 67GB 去和
   * 剩余空间比，就会报「可能不够」把用户吓一跳，实际上绰绰有余。
   *
   * shouldCopyFn(rel) 为真表示「这个文件会被复制、真占盘」。传了就顺便统计 copyBytes；
   * 不传（米哈游 Sophon 那条链路）就维持原样，只统计 baseBytes，copyBytes 返回 null。
   */
  async function estimateRuntimeSpace(baseRoot, targetRoot, shouldCopyFn) {
    const drive = path.parse(path.resolve(targetRoot || baseRoot || '.')).root;
    let freeBytes = 0;
    try {
      const stats = await fsp.statfs(drive);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      freeBytes = 0;
    }

    let baseBytes = 0;
    let baseFiles = 0;
    let copyBytes = 0;
    let copyFiles = 0;
    const countCopy = typeof shouldCopyFn === 'function';
    let partial = false;
    if (baseRoot) {
      const deadline = Date.now() + 4000;
      const stack = [baseRoot];
      while (stack.length) {
        if (Date.now() > deadline) {
          partial = true;
          break;
        }
        const dir = stack.pop();
        let entries = [];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
          } else if (entry.isFile()) {
            try {
              const info = await fsp.stat(full);
              const size = Number(info.size) || 0;
              baseBytes += size;
              baseFiles += 1;
              if (countCopy) {
                const rel = path.relative(baseRoot, full).replace(/\\/g, '/');
                if (shouldCopyFn(rel)) {
                  copyBytes += size;
                  copyFiles += 1;
                }
              }
            } catch {
              /* 读不到就跳过，不影响其它文件 */
            }
          }
        }
      }
    }

    return {
      ok: true,
      estimate: true,
      drive,
      freeBytes,
      baseBytes,
      baseFiles,
      copyBytes: countCopy ? copyBytes : null,
      copyFiles: countCopy ? copyFiles : null,
      partial,
      targetRoot,
    };
  }

  /**
   * 终末地走自己的链路（硬链接基础客户端 + 覆盖渠道差异包），不读 Sophon 清单。
   *
   * 以前这个函数只认米哈游三游，于是终末地服务器面板 / 切换引导里点
   * 「硬链接生成一份」，拿到的是「这个游戏没有接入 Sophon 清单」，
   * 界面只把开始按钮置灰 —— 用户只能绕到服务器管理里点「重建」。
   */
  async function prepareEndfieldRuntimeJob(game, input = {}) {
    const server = (game.servers || []).find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    if (await pruneStaleRunning()) pushState(true);
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再切换服务器');

    /*
     * 目标目录必须和真正写入的地方是同一个：这里算的目录和
     * ensureEndfieldChannelRuntime 用的是同一套 runtimePaths（<根>\endfield\<渠道>）。
     * 判据是「不得互相嵌套」而不是「不得相等」：每渠道目录本来就在游戏盘上，
     * 真正危险的是渠道目录嵌进基础客户端里（会把官服本体当运行时原地改写），
     * 或基础客户端嵌在渠道目录里（重建时连带删掉官服）。与 ensure 完全一致，
     * 免得「估算能过、真跑却被拦」。
     */
    // 与 ensureEndfieldChannelRuntime 用同一个解析器，避免「估算能过、真跑却被拦」
    // （:13840-13844 的注释已经声明了这个要求，但当时两份代码是各写各的）。
    const resolvedBase = endfieldResolveBase(game, server, String(server.channel || ''), {
      runtimeRoot: input?.runtimeRoot,
      allowRuntimeBase: true,
    });
    const baseRoot = resolvedBase ? resolvedBase.baseRoot : '';
    if (!baseRoot) {
      throw new Error(`没有找到可以当作基础的客户端。${server.name}需要一个已安装的终末地在同盘上做基础，请先在启动器里把已经装好的任意渠道客户端指到对应服务器上。`);
    }
    const runtime = runtimePaths(baseRoot, 'endfield', server.channel, input?.runtimeRoot);
    if (!runtime.sameDrive) {
      throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
    }
    if (pathsOverlap(baseRoot, runtime.target)) {
      throw new Error('运行时目录不能和基础客户端是同一个目录，也不能互相嵌套，请换个“运行时目录”再试');
    }
    /*
     * 传 mustCopyNotLink 进去，让估算能区分「硬链接过去的」和「真写的」：
     * 基础客户端 67GB 里 62GB 是只读资源、链接过去不占额外空间，
     * 真正落盘的只有 Persistent / U8Data / sdkdata 那些可写文件（约 3.7GB）。
     * 不传这个判据就会拿 67GB 去比剩余空间，白白报一句「可能不够」。
     */
    if (input?.estimate) return estimateRuntimeSpace(baseRoot, runtime.target, mustCopyNotLink);

    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = { cancelled: false };
    sophonJobs.set(jobId, signal);
    beginBackgroundTask();
    try {
      /*
       * 整条 progress 透传。
       * 以前这里是白名单（只挑 processed/total/current），把字节进度
       * bytesDone / totalBytes / percent 全丢在门外——渠道包下得再快，
       * 界面也只能显示「下载 0 · 0 KB / 0 KB」，因为事件里根本没这些数。
       */
      const emit = (progress) =>
        send('sophon:progress', {
          ...progress,
          jobId,
          phase: progress.phase === 'pack' ? 'pack' : progress.phase || 'link',
        });
      emit({ phase: 'start', current: '正在准备运行时…' });
      const result = await ensureEndfieldChannelRuntime(game, server, {
        runtimeRoot: input?.runtimeRoot,
        onProgress: emit,
        // 预下载/重建必须和估算走同一条解析链，否则「估算通过 → 真跑 throw」
        allowRuntimeBase: true,
      });
      if (signal.cancelled) return { ok: false, cancelled: true };
      server.incomplete = false;
      game.activeServerId = server.id;
      game.target = result.launchPath;
      game.workDir = result.runtimeRoot;
      ensureServers(game);
      await store.saveNow();
      pushState(true);
      send('sophon:progress', {
        jobId,
        phase: 'done',
        processed: 1,
        total: 1,
        current: '完成',
      });
      return {
        ok: true,
        tag: result.directBase ? '官方客户端' : '差异运行时',
        linked: result.linked || 0,
        downloaded: 0,
        packDownloaded: Boolean(result.packDownloaded),
        files: (result.linked || 0) + (result.overlay || 0),
        targetRoot: result.runtimeRoot,
        built: Boolean(result.built),
        directBase: Boolean(result.directBase),
      };
    } finally {
      endBackgroundTask();
      sophonJobs.delete(jobId);
    }
  }

  /**
   * 明日方舟：官服 / B服 共用同一个安装目录，切服就是「把整份客户端硬链接一份，
   * 再把目标渠道的 SDK 换掉」，和米哈游的 Sophon 清单不是一回事。
   * 以前这里同样被「没有接入 Sophon 清单」挡住，于是明日方舟在服务器面板里
   * 点「硬链接生成一份」没有任何反应。
   */
  async function prepareArknightsRuntimeJob(game, input = {}) {
    const server = (game.servers || []).find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    if (await pruneStaleRunning()) pushState(true);
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再切换服务器');
    if (!ARKNIGHTS_CN_CHANNELS.includes(server.channel)) {
      throw new Error('国际服 / 台服是各自独立的客户端，请直接指到它们自己的安装目录，不能用国服生成');
    }
    const baseRoot = String(server.root || '').trim();
    if (!baseRoot || !fs.existsSync(baseRoot)) {
      throw new Error('这个服务器还没有客户端目录，先在它那一行点“编辑”把目录指到明日方舟的安装目录');
    }
    const runtime = runtimePaths(baseRoot, 'arknights', server.channel, input?.runtimeRoot);
    if (!runtime.sameDrive) {
      throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
    }
    if (path.resolve(baseRoot).toLowerCase() === path.resolve(runtime.target).toLowerCase()) {
      throw new Error('运行时目录不能和基础客户端是同一个目录，请换个“运行时目录”再试');
    }
    if (input?.estimate) return estimateRuntimeSpace(baseRoot, runtime.target);

    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = { cancelled: false };
    sophonJobs.set(jobId, signal);
    beginBackgroundTask();
    try {
      const emit = (progress) => sendProgress('sophon:progress', jobId, progress);
      emit({ phase: 'start', processed: 0, total: 0, current: '正在准备运行时…' });
      const ok = await ensureArknightsRuntime(game, server, {
        runtimeRoot: input?.runtimeRoot,
        onProgress: emit,
        signal,
      });
      if (signal.cancelled) return { ok: false, cancelled: true };
      if (!ok) throw new Error('没有生成出运行时：这个目录里没找到 Arknights.exe，请确认选中的是明日方舟的安装目录');
      server.incomplete = false;
      game.activeServerId = server.id;
      game.target = server.path;
      game.workDir = server.root;
      await store.saveNow();
      pushState(true);
      emit({ phase: 'done', processed: 1, total: 1, current: '完成' });
      return { ok: true, tag: server.name, linked: 1, downloaded: 0, targetRoot: server.root };
    } finally {
      endBackgroundTask();
      sophonJobs.delete(jobId);
    }
  }

  ipcMain.handle('servers:prepare-sophon', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    if (game.builtinKey === 'endfield') return prepareEndfieldRuntimeJob(game, input);
    if (game.builtinKey === 'arknights') return prepareArknightsRuntimeJob(game, input);
    if (!['genshin', 'starrail', 'zzz'].includes(game.builtinKey)) {
      throw new Error('这个游戏没有接入 Sophon 清单');
    }
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再准备服务器');
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    /*
     * 放开官服作为「生成」目标：没有官服客户端、但装了 B服 / 国际服的玩家，
     * 也能以 B服 / 国际服 当基础，硬链接相同的文件、只下载官服独有的差异分块，
     * 省下一次完整下载。原来这里只允许 bilibili / global，官服点「重建」只会让你选路径，
     * 而没官服客户端的人根本没路径可选，死循环。
     * play / steam 这些没接入 Sophon 清单的渠道仍然不支持。
     */
    if (!['official', 'bilibili', 'global'].includes(server.channel)) {
      throw new Error('这个渠道暂时不支持生成差异客户端');
    }
    // 基础客户端优先取官服、其次 B服（都是国服系，本地分块能复用得最多），
    // 只装了国际服的玩家用国际服当基础也能生成，只是复用率略低。
    const base =
      game.servers.find(
        (item) => item.id !== server.id && item.channel === 'official' && item.path && targetExists(item.path)
      ) ||
      game.servers.find(
        (item) => item.id !== server.id && item.channel === 'bilibili' && item.path && targetExists(item.path)
      ) ||
      game.servers.find((item) => item.id !== server.id && item.path && item.root && targetExists(item.path));
    if (!base || !base.root) {
      throw new Error(
        '没有找到可以当作基础的客户端。生成国际服 / B服 需要一份已安装的客户端当基础：请先在任意一服那一行点“编辑”选择已经装好的客户端（官服、国际服或 B服 都行）。'
      );
    }

    // 基础客户端和目标目录重合时，生成过程会把基础客户端本身清空，必须先拦住。
    const runtime = runtimePaths(base.root, game.builtinKey, server.channel, input?.runtimeRoot);
    if (!runtime.sameDrive) {
      throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
    }
    const targetRoot = runtime.target;
    if (path.resolve(base.root).toLowerCase() === path.resolve(targetRoot).toLowerCase()) {
      throw new Error('运行时目录不能和基础客户端是同一个目录，请换个“运行时目录”再试');
    }

    /*
     * 只做预估，不真跑：界面里先告诉用户目标盘还剩多少、基础客户端有多大，
     * 免得跑到一半才发现空间不够。只读本地信息，不走网络。
     */
    if (input?.estimate) {
      return estimateRuntimeSpace(base.root, targetRoot);
    }

    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = { cancelled: false };
    sophonJobs.set(jobId, signal);
    beginBackgroundTask();
    send('sophon:progress', {
      jobId,
      phase: 'start',
      current: '正在读取官方清单…',
      processed: 0,
      total: 0,
    });
    try {
      const result =
        server.channel === 'bilibili' && base.channel === 'official'
          ? await prepareBilibiliRuntime({
              gameKey: game.builtinKey,
              baseRoot: base.root,
              targetRoot,
              cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
              signal,
              onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
            })
          : await prepareSophon({
              gameKey: game.builtinKey,
              channel: server.channel,
              baseRoot: base.root,
              targetRoot,
              // 除了当基础的那份，其它渠道客户端里也有大量同内容文件，一并拿来硬链接
              linkSources: externalLinkSources(game, server, targetRoot),
              cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
              audioLanguages: store.data?.settings?.audioLanguages,
              // 绝区零那 111 份分类剧情资源（约 19.73GB）要不要一起装。默认不装。
              includeStoryResources: storyResourcesEnabled(game, server),
              signal,
              onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
            });
      if (signal.cancelled) return { ok: false, cancelled: true };
      if (!result.executable) throw new Error('清单安装完成，但没有找到游戏启动程序');
      server.path = result.executable;
      server.root = targetRoot;
      server.sophonVersion = result.tag;
      server.incomplete = false;
      server.packPath = '';
      game.activeServerId = server.id;
      game.target = result.executable;
      game.workDir = targetRoot;
      ensureServers(game);
      await store.saveNow();
      pushState(true);
      send('sophon:progress', {
        jobId,
        phase: 'done',
        processed: result.files,
        total: result.files,
        linked: result.linked,
        downloaded: result.downloaded,
        bytesDone: result.totalBytes,
        totalBytes: result.totalBytes,
        current: '完成',
      });
      return { ok: true, ...result };
    } finally {
      endBackgroundTask();
      sophonJobs.delete(jobId);
    }
  });

  ipcMain.handle('servers:update-sophon', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game || !['genshin', 'starrail', 'zzz', 'bh3'].includes(game.builtinKey)) {
      throw new Error('这个游戏没有接入 Sophon 更新');
    }
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再更新');
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server || !server.root || !server.path || !targetExists(server.path)) {
      throw new Error('这个服务器还没有可更新的客户端');
    }
    if (game.builtinKey === 'bh3' && server.channel && server.channel !== 'official') {
      throw new Error('崩坏3 本体更新仅支持官服（B服 / 国际服请使用对应官方启动器）');
    }
    /*
     * 动手之前先探一下「这个目录到底让不让我们写」。
     *
     * 不探的话，权限问题会在下载完几十 GB、开始替换文件的那一刻才爆出来，报错还被
     * Node 说成「文件被其它程序占用」，用户把所有程序都关掉也修不好（2026-11-11 报障）。
     * 预检只做只读探测（试建临时文件 + 试改名已有可执行文件再改回来），不删用户任何东西。
     *
     * 这里不自动提权：UAC 弹在开始之前是最佳时机，但由界面决定要不要弹 —— 主进程只把
     * 结论告诉界面，界面弹「以管理员身份重启并继续更新」，用户点了才走 app:relaunch-admin。
     */
    if (!currentElevation()) {
      const probe = await probeUpdateWritable(server.root);
      if (probe.blocked) {
        writeLaunchLog(`update ${game.id}: 写权限预检未过 → ${probe.reason}`);
        return {
          ok: false,
          code: 'NEED_ELEVATION',
          reason: probe.reason,
          root: server.root,
          gameId: game.id,
          serverId: server.id,
        };
      }
    }
    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = { cancelled: false };
    sophonJobs.set(jobId, signal);
    beginBackgroundTask();
    /*
     * 别的渠道客户端（官服 / B服 / 国际服）可以作为硬链接源：
     * 官方同一个构建产物的资源包逐字节相同，另一份已经更新过的话，
     * 这次更新只需要链接、不需要为同一份内容再下一次。
     */
    const linkSources = externalLinkSources(game, server, server.root);
    if (linkSources.length) {
      writeLaunchLog(`update ${game.id}: 可用复用源 ${linkSources.length} 份 → ${linkSources.join(' ; ')}`);
    }
    /*
     * 更新时以「客户端自己声明的渠道」为准，不跟着服务器行的标签走。
     *
     * 行的 channel 是启动器推断/用户手选的，可能错配（比如 B服 那一行挂着官服客户端）；
     * 而 prepareSophon 收尾会用这个 channel 整份重写 config.ini ——
     * 只要标签错一次，就会把玩家的官服客户端改写成 B服，之后每次登录都要先弹一次
     * 「二级地址解析失败」再回退。config.ini 里读不到渠道时才回退到行标签。
     */
    const actualChannel =
      (server.channel !== 'custom' && clientChannel.configChannelFromPath(server.path)) || server.channel;
    if (actualChannel !== server.channel) {
      writeLaunchLog(
        `update ${game.id}: 行标签 ${server.channel} 与客户端实际渠道 ${actualChannel} 不一致，按客户端渠道更新`
      );
    }
    /*
     * 之前预下载过的话，产物就在这里吃掉：
     *   - 分块模式：chunk/ 里就是新版本的分块，命中的 0 流量，缺的才联网补；
     *   - 补丁模式：ldiff/ 里是官方给的差量补丁包，就地打比按块下省一半。
     * 两者都没有时两个判据都是 false，这里整段跳过，行为与原来完全一致。
     */
    if (
      predownload.hasCache({ gameKey: game.builtinKey, channel: actualChannel, installRoot: server.root }) ||
      predownload.hasPatchCache({ gameKey: game.builtinKey, channel: actualChannel, installRoot: server.root })
    ) {
      try {
        const appliedResult = await predownload.apply({
          gameKey: game.builtinKey,
          channel: actualChannel,
          installRoot: server.root,
          cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
          audioLanguages: store.data?.settings?.audioLanguages,
          includeCategory: storyResourcesEnabled(game, server),
          // 预下载产物 + 别的渠道客户端的同内容文件，两条路都能省掉下载
          linkSources,
          signal,
          onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
        });
        if (signal.cancelled) return { ok: false, cancelled: true };
        if (appliedResult?.ok) {
          server.predownload = null;
          game.version = appliedResult.tag;
          game.versionName = appliedResult.tag;
          game.lastOfficialSync = Date.now();
          if (game.activeServerId === server.id) {
            game.target = server.path;
            game.workDir = server.root;
          }
          await store.saveNow();
          pushState(true);
          syncOfficialGame(game, []).catch(() => {});
          send('sophon:progress', {
            jobId,
            phase: 'done',
            processed: appliedResult.files,
            total: appliedResult.files,
            linked: 0,
            downloaded: appliedResult.applied,
            skipped: appliedResult.skipped,
            current: `预下载内容已应用完成（复用分块 ${appliedResult.reusedChunks} 个）`,
          });
          // 预下载内容落进真实安装目录后，链接运行时要失效（与 predownload:apply 同一语义）
          invalidateRuntimesAfterUpdate(game);
          return { ok: true, ...appliedResult, patched: true, fromPredownload: true };
        }
      } catch (error) {
        writeLaunchLog(`update ${game.id}: predownload apply fallback: ${error.message}`);
      }
    }
    try {
      /*
       * ldiff 预修补：把「本地已有旧文件 + 官方给了本地版本补丁」的那批文件就地改成新内容。
       *
       * 它**不是**一次完整更新 —— 补丁清单只覆盖有差分的文件，没差分的文件不在清单里，
       * 所以绝不能像以前那样 patch 完就宣布更新完成（那会漏文件还报成功）。
       * 这里只当省钱预处理用，后面必须照常跑 prepareSophon 做最终校验：
       * 被这里改对的文件会走 quickFileMatches → skipped，其余走本地 chunk 复用 / 联网补下。
       *
       * 原神 7.0.0 → 7.1.0 实测：1151 个文件可修补；这些文件走 chunk 要下 37.26GB（压缩后、按
       * chunk id 去重），ldiff 补丁只要 9.32GB，省流 27.94GB（75.0%）。
       *
       * 判据与 Starward / Collapse 保持一致：**不看 enable_ldiff**。
       * 那两家一个只在 GameConfig 里声明了这个字段却从没读过（Starward），
       * 一个连字段都没解析（Collapse）；它们真正的判据是「补丁清单里有没有当前版本」，
       * 也就是下面 applyHdiffPrepass 内部按 diff_tags 判的那一步。
       * 官方配置说别用、但清单里确实给了你当前版本的补丁 —— 那这份补丁就是能用的。
       * 没给（崩坏3 这类真没补丁的）会在里面以 version-not-patchable 干净退出，
       * 不会白算一轮 md5：那一步在读完分支信息之后、扫盘之前。
       */
      let ldiff = null;
      try {
        const userEnabled = store.data?.settings?.enableLdiff !== false;
        if (userEnabled) {
          ldiff = await applyHdiffPrepass({
            gameKey: game.builtinKey,
            channel: actualChannel,
            installRoot: server.root,
            cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
            // 预下载时先存下的补丁包在这儿：命中就不用再下一遍
            patchRoot: path.join(server.root, 'ldiff'),
            audioLanguages: store.data?.settings?.audioLanguages,
            includeStory: storyResourcesEnabled(game, server),
            // 别的渠道已经更到目标版本时，这批文件直接硬链接，别去下增量补丁
            linkSources,
            signal,
            onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
          });
          if (ldiff?.ok && (ldiff.applied > 0 || ldiff.linked > 0)) {
            writeLaunchLog(
              `update ${game.id}: ldiff 修补 ${ldiff.applied} 个文件，` +
                `硬链接复用 ${ldiff.linked || 0} 个，补丁 ${ldiff.patchBytes} 字节，省流 ${ldiff.saveBytes} 字节`
            );
          } else if (ldiff?.reason) {
            writeLaunchLog(`update ${game.id}: ldiff 跳过（${ldiff.reason}）`);
          }
        } else {
          writeLaunchLog(`update ${game.id}: 跳过 ldiff（用户在设置里关掉了），走纯 chunk`);
        }
      } catch (error) {
        writeLaunchLog(`update ${game.id}: ldiff 预处理失败，退回纯 chunk：${error.message}`);
      }
      if (signal.cancelled) return { ok: false, cancelled: true };
      const result = await prepareSophon({
        gameKey: game.builtinKey,
        // 同理：写回 config.ini 用的就是这个 channel，必须取客户端真实渠道
        channel: actualChannel,
        baseRoot: server.root,
        targetRoot: server.root,
        cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
        audioLanguages: store.data?.settings?.audioLanguages,
        // 必须和安装那条路径用同一个取值，否则会出现「安装时不装、一更新就补 19.73GB」
        includeStoryResources: storyResourcesEnabled(game, server),
        linkSources,
        signal,
        onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
      });
      if (signal.cancelled) return { ok: false, cancelled: true };
      if (result.externalLinked) {
        writeLaunchLog(
          `update ${game.id}: 从其它渠道客户端硬链接复用 ${result.externalLinked} 个文件（${(
            Number(result.externalBytes || 0) / 1024 ** 3
          ).toFixed(2)} GB），没走下载`
        );
      }
      if (game.activeServerId === server.id) {
        const exe = result.executable || server.path;
        game.target = exe;
        game.workDir = server.root;
        server.path = exe;
      }
      game.version = result.tag;
      game.versionName = result.tag;
      // 更新成功后同步服务器实际版本：以前只有「生成一份」会写这个字段，
      // 更新不写，本地更到 7.2 了服务器还挂着上次生成的 7.1.0
      server.sophonVersion = result.tag;
      game.lastOfficialSync = Date.now();
      await store.saveNow();
      pushState(true);
      // 本体文件被刷过，链接运行时若有标记也应失效（非终末地当前为 no-op）
      invalidateRuntimesAfterUpdate(game);
      syncOfficialGame(game, []).catch(() => {});
      // 把 ldiff 的战果带回去，界面上能显示「其中 N 个文件是本地补丁修好的，省流 X」。
      if (ldiff?.ok && ldiff.applied > 0) {
        return {
          ok: true,
          ...result,
          ldiff: {
            applied: ldiff.applied,
            failed: ldiff.failed,
            // 从别的渠道客户端硬链接过来的文件数：这批既没下补丁、也没走 chunk
            linked: ldiff.linked || 0,
            patchBytes: ldiff.patchBytes,
            saveBytes: ldiff.saveBytes,
            localVersion: ldiff.localVersion,
          },
        };
      }
      return { ok: true, ...result };
    } finally {
      endBackgroundTask();
      sophonJobs.delete(jobId);
    }
  });

  ipcMain.handle('servers:pause-sophon', async (_event, input) => {
    const job = sophonJobs.get(String(input?.jobId));
    if (!job) return false;
    job.paused = input?.paused === true;
    return true;
  });

  ipcMain.handle('servers:cancel-sophon', async (_event, jobId) => {
    const job = sophonJobs.get(String(jobId));
    if (!job) return false;
    job.cancelled = true;
    return true;
  });

  /*
   * ── 一键下载（未安装游戏） ──────────────────────────────────────────
   * 启动页选中没装过的内置游戏时，「下载游戏」按钮走这里：
   *   - 米哈游三游 + 崩坏3：prepareSophon 的全新安装模式。
   *     baseRoot 和 targetRoot 传同一个空目录时，sophon.js 会跳过本地分块索引，
   *     所有文件按官方清单逐 chunk 下载落盘组装 —— 本地基线就相当于「空清单」。
   *     崩坏3 官服和三游共用 HoYoPlay 的 sophon 接口（game/asb 两份清单），
   *     B服 / 国际服不在 HoYoPlay 分发体系里，只接官服。
   *   - 终末地 / 明日方舟：官方分卷整包（packList）+ 7z 解压；没有 7-Zip 时
   *     退回逐文件清单全量下载。明日方舟只实测了官服分发接口（鹰角启动器
   *     batch_proxy，appcode 在 endfield-packs.js 的 Arknights profile 里）。
   *   - 异环：官网只提供启动器安装器，游戏本体走启动器内部私有接口，
   *     没有公开的下载管线，前端会如实提示「暂不支持」。
   * 进度复用 sophon:progress 通道和 sophonJobs 信号表，暂停 / 取消的 IPC 原样生效。
   */

  /** 支持一键下载的内置游戏 → 下载引擎。 */
  const DOWNLOADABLE_KEYS = {
    genshin: 'sophon',
    starrail: 'sophon',
    zzz: 'sophon',
    bh3: 'sophon',
    endfield: 'endfield',
    arknights: 'endfield',
  };

  /*
   * 引擎按「渠道」再细分一次：明日方舟的三个 Yostar 服不走鹰角分卷，走 Yostar 自己
   * 那套逐文件清单。国服官服/B服 保持 endfield（鹰角）不变。
   *
   * 之所以做成函数而不是改 DOWNLOADABLE_KEYS 表：那张表是按游戏查的，这里要按
   * 「游戏 × 渠道」查，混在一起会让所有调用点都要先判断一遍渠道。
   */
  function engineFor(gameKey, channel) {
    if (gameKey === 'arknights' && yostarPacks.isYostarChannel(channel)) return 'yostar';
    return DOWNLOADABLE_KEYS[gameKey];
  }

  /** 找「这个渠道」对应的服务器行；没有就报错（渠道行由 ensureServers 统一维护）。 */
  function serverForDownload(game, channel) {
    const server = (game.servers || []).find((item) => item.channel === channel);
    if (!server) throw new Error('没有找到这个渠道的服务器，请先在服务器管理里添加');
    return server;
  }

  /*
   * 终末地 / 明日方舟共用鹰角分卷引擎，但 profile 按游戏分开解析：
   * 明日方舟只实测了官服分发接口（B服 / 国际服 / 台服的 appcode 没配），
   * 其它渠道在这里就给出明确报错，而不是让用户等 estimate 走到一半才失败。
   */
  function downloadPackProfile(gameKey, channel) {
    if (gameKey === 'arknights') {
      if (channel !== 'official') {
        throw new Error('明日方舟这个渠道暂不支持自动下载，请前往官网下载安装');
      }
      return profileForChannel('arknights');
    }
    const profile = profileForChannel(channel);
    if (!profile) throw new Error('没有对应的终末地渠道');
    return profile;
  }

  /** 校验安装目录可写：真实写入并删除一个探针文件，权限问题当场暴露。 */
  async function assertDirWritable(dir) {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.hxl-write-test-${Date.now()}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
  }

  /**
   * 判断这次更新到底会不会被「权限」挡住，以及要不要建议以管理员身份重开。
   *
   * 为什么不只试目录：目录能建能删，不代表里面的文件能删。游戏目录里常有官方安装器
   * 用管理员身份写的文件，ACL 上普通用户只给了「读取+执行」，连 DELETE 都没有；
   * 这种文件 rm 会 EPERM，而目录本身完全可写 —— 光探目录会漏判（这就是 2026-11-11
   * 那位用户明明目录正常却更新不了的原因）。
   *
   * 所以这里抽几类真正会被改写的东西各试一次：
   *   1) 目录本身能不能建/删临时文件（最基础的一条）
   *   2) 目录里已有的**可执行文件和 dll**：更新几乎必然要替换它们，最能代表真实情况
   *   3) 已有文件数量太少（全新安装）就只看目录
   *
   * 只做「能不能删掉并原样重建」的探测，探测完立刻把内容原样写回去、权限不动 ——
   * 探针文件用的是改名挪开再改名回原位，绝不删除用户的东西。
   */
  async function probeUpdateWritable(installDir) {
    const report = { dir: installDir, dirWritable: false, filesProbed: 0, filesBlocked: [], blocked: false, reason: '' };
    try {
      await assertDirWritable(installDir);
      report.dirWritable = true;
    } catch (error) {
      report.blocked = true;
      report.reason = `安装目录本身不可写：${String(error?.message || error)}`;
      return report;
    }
    // 目录可写，再看里面的文件能不能动。只抽少量代表件，别为了探测把几万个文件都 stat 一遍。
    const probes = [];
    try {
      const entries = await fsp.readdir(installDir, { withFileTypes: true });
      for (const entry of entries) {
        if (probes.length >= 3) break;
        if (!entry.isFile()) continue;
        if (/\.(exe|dll)$/i.test(entry.name)) probes.push(path.join(installDir, entry.name));
      }
    } catch {
      /* 读不到就只按目录结论走 */
    }
    for (const target of probes) {
      report.filesProbed += 1;
      const parked = `${target}.hxl-probe-${Date.now()}`;
      let parkedOk = false;
      try {
        // 用改名探「能不能动这个文件」：ACL 缺 DELETE 时 rm 会 EPERM，但改名通常可以，
        // 所以这里能改名的就认为「更新时我们有办法替换它」，不算被挡。
        await fsp.rename(target, parked);
        parkedOk = true;
      } catch {
        /* 改名也不行，那就是真动不了 */
      }
      if (parkedOk) {
        await fsp.rename(parked, target).catch(() => {});
      } else {
        report.filesBlocked.push(path.basename(target));
      }
    }
    if (report.filesBlocked.length) {
      report.blocked = true;
      report.reason = `安装目录里有文件动不了：${report.filesBlocked.join('、')}`;
    }
    return report;
  }

  /** 目标盘剩余空间；读不到就返回 0（调用方自行决定是否放行）。 */
  async function driveFreeBytes(dir) {
    try {
      const stats = await fsp.statfs(path.parse(path.resolve(dir)).root);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return 0;
    }
  }

  /** 官方清单口径的全量体积：sophon 读清单，终末地 / 明日方舟读整包卷 total_size，Yostar 读远端清单。 */
  async function estimateDownloadBytes(game, server, engine, installDir) {
    if (engine === 'yostar') {
      /*
       * 用 planForGame 而不是 loadRemoteTargetPackage：前者会把「本地已有多少可以复用」
       * 也算进去（downloadBytes 是真实要下的量）。全新安装时它等于 totalBytes，
       * 但用户在已有目录上重新下载时这个差别就是几十 MB 和 3.5 GB 的差别。
       */
      const plan = await yostarPacks.planForGame({ profile: server.channel, installRoot: installDir });
      return {
        version: plan.version,
        totalBytes: plan.totalBytes,
        downloadBytes: plan.downloadBytes,
        needDownload: plan.needDownload,
        willDelete: plan.willDelete,
        storyResources: null,
      };
    }
    if (engine === 'sophon') {
      await fsp.mkdir(installDir, { recursive: true });
      const preview = await prepareSophon({
        gameKey: game.builtinKey,
        channel: server.channel,
        baseRoot: installDir,
        targetRoot: installDir,
        cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
        audioLanguages: store.data?.settings?.audioLanguages,
        includeStoryResources: storyResourcesEnabled(game, server),
        dryRun: true,
      });
      return {
        version: preview.tag,
        totalBytes: preview.totalBytes,
        storyResources: preview.storyResources || null,
        // 没有本地增量基准时提前告诉界面：这次会是整包量级，不是几十 MB 的小更新
        localBaseMissing: Boolean(preview.localBaseMissing),
        localBaseReason: preview.localBaseReason || '',
      };
    }
    const profile = downloadPackProfile(game.builtinKey, server.channel);
    const latest = await fetchLatest(profile);
    return { version: latest.version, totalBytes: latest.totalSize, storyResources: null };
  }

  ipcMain.handle('servers:download-estimate', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    if (!DOWNLOADABLE_KEYS[game.builtinKey]) throw new Error('这款游戏暂不支持自动下载，请前往官网下载安装');
    const installDir = path.resolve(String(input?.installDir || '').trim());
    if (!installDir || installDir === path.parse(installDir).root) {
      throw new Error('请先选择一个安装目录');
    }
    const server = serverForDownload(game, String(input?.channel || ''));
    const engine = engineFor(game.builtinKey, server.channel);
    if (!engine) throw new Error('这个渠道暂不支持自动下载，请前往官网下载安装');
    const summary = await estimateDownloadBytes(game, server, engine, installDir);
    return {
      ok: true,
      engine,
      ...summary,
      freeBytes: await driveFreeBytes(installDir),
      installDir,
    };
  });

  ipcMain.handle('servers:download-game', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    if (!DOWNLOADABLE_KEYS[game.builtinKey]) throw new Error('这款游戏暂不支持自动下载，请前往官网下载安装');
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再下载');
    const server = serverForDownload(game, String(input?.channel || ''));
    const engine = engineFor(game.builtinKey, server.channel);
    if (!engine) throw new Error('这个渠道暂不支持自动下载，请前往官网下载安装');
    const installDir = path.resolve(String(input?.installDir || '').trim());
    if (!installDir || installDir === path.parse(installDir).root) {
      throw new Error('请先选择一个安装目录');
    }
    await assertDirWritable(installDir);

    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = { cancelled: false };
    // 信号登记进 sophonJobs：现有的 servers:pause-sophon / servers:cancel-sophon 直接生效
    sophonJobs.set(jobId, signal);
    beginBackgroundTask();
    send('sophon:progress', { jobId, phase: 'start', current: '正在读取官方清单…', processed: 0, total: 0 });
    try {
      /*
       * 同盘空间校验：全新安装要下整个客户端，剩余空间必须盖得住清单总大小。
       * 清单请求有缓存（sophon-cache / 接口本身很轻），多读一次不亏。
       */
      const summary = await estimateDownloadBytes(game, server, engine, installDir);
      const freeBytes = await driveFreeBytes(installDir);
      const needBytes = Number(summary.totalBytes) || 0;
      if (needBytes > 0 && freeBytes > 0 && freeBytes < needBytes) {
        throw new Error(
          `目标盘剩余空间不足：客户端约 ${(needBytes / 1024 ** 3).toFixed(1)} GB，` +
            `该盘只剩 ${(freeBytes / 1024 ** 3).toFixed(1)} GB，请换个安装目录或先清理空间`
        );
      }
      let executable = '';
      let version = String(summary.version || '');
      if (engine === 'sophon') {
        /*
         * 全新安装：baseRoot = targetRoot = 安装目录（空目录）。
         * prepareSophon 在两者同路径时跳过本地分块索引，所有文件按清单逐 chunk
         * 下载写盘并做 md5 校验 —— 本地基线相当于空清单，即完整下载。
         */
        const result = await prepareSophon({
          gameKey: game.builtinKey,
          channel: server.channel,
          baseRoot: installDir,
          targetRoot: installDir,
          cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
          audioLanguages: store.data?.settings?.audioLanguages,
          // 必须和安装 / 更新那条路径用同一个取值，否则口径不一致
          includeStoryResources: storyResourcesEnabled(game, server),
          signal,
          onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
        });
        executable = result.executable || '';
      } else if (engine === 'yostar') {
        /*
         * 明日方舟 EN / JP / KR：Yostar 自己的逐文件清单（CRC64 校验）。
         * 秒传 / 断点续传 / 断硬链接都在 yostarPacks.installGame 里做完了，
         * 这里只负责把进度翻成界面认识的那套 phase 字段。
         */
        const result = await yostarPacks.installGame({
          profile: server.channel,
          installRoot: installDir,
          signal,
          onProgress: (progress) => {
            const phase =
              progress.phase === 'download' ? 'download' : progress.phase === 'install' ? 'install' : 'manifest';
            send('sophon:progress', {
              jobId,
              phase,
              current: progress.current || '',
              processed: progress.processed || 0,
              total: progress.total || 0,
              bytesDone: progress.processed && progress.total && summary.totalBytes
                ? Math.round((Number(summary.totalBytes) || 0) * (progress.processed / progress.total))
                : 0,
              totalBytes: Number(summary.totalBytes) || 0,
            });
          },
        });
        executable = path.join(installDir, result.executable || 'Arknights.exe');
        version = String(result.version || version || '');
      } else {
        /*
         * 终末地 / 明日方舟：优先官方分卷整包 + 7z 解压（一卷连读 .002/.003）；
         * 没有 7-Zip 退回逐文件全量下载。渠道合法性在 downloadPackProfile 里先校验。
         */
        const packProfile = downloadPackProfile(game.builtinKey, server.channel);
        const packChannel = game.builtinKey === 'arknights' ? 'arknights' : server.channel;
        if (findSevenZip()) {
          await downloadAndExtractSplit({
            profile: packProfile,
            root: installDir,
            onProgress: (progress) => {
              if (progress.phase === 'download') {
                // 分卷进度换算成和 sophon 一样的 processed/total 口径，前端进度条不用另写一套；
                // 字节按整包体积线性折算，只为进度显示，不做精确承诺
                const totalPacks = progress.total || 0;
                const packIndex = progress.index || 0;
                // 卷内进度（0~1）：几百 MB 的一卷要能看出在走，不能一卷一跳
                const done = packIndex + (Number(progress.fraction) || 0);
                send('sophon:progress', {
                  jobId,
                  phase: 'download',
                  processed: packIndex,
                  total: totalPacks,
                  bytesDone: totalPacks ? Math.round((Number(summary.totalBytes) || 0) * (done / totalPacks)) : 0,
                  totalBytes: Number(summary.totalBytes) || 0,
                  current: `下载分卷 ${packIndex} / ${totalPacks}`,
                });
              } else if (progress.phase === 'extract') {
                send('sophon:progress', {
                  jobId,
                  phase: 'install',
                  processed: 1,
                  total: 1,
                  bytesDone: 0,
                  totalBytes: 0,
                  current: '解压整包（7-Zip）…',
                });
              }
            },
          });
        } else {
          send('sophon:progress', { jobId, phase: 'manifest', current: '没有找到 7-Zip，改用逐文件下载…' });
          await updateEndfieldGame({
            root: installDir,
            channel: packChannel,
            onProgress: (progress) =>
              send('sophon:progress', {
                jobId,
                phase: 'download',
                processed: progress.processed || 0,
                total: progress.total || 0,
                bytesDone: progress.downloadedBytes || 0,
                totalBytes: progress.totalBytes || 0,
                current: progress.current || '',
              }),
          });
        }
        // 解压 / 下载完找启动程序；整包解出来的目录结构有出入时按检测注册表兜底
        const packExes =
          game.builtinKey === 'arknights'
            ? // 明日方舟整包根目录是 Arknights.exe，鹰角启动器子目录布局留给 detectGame 兜底
              ['Arknights.exe', path.join('games', 'Arknights Game', 'Arknights.exe')]
            : ['Endfield.exe', 'PlatformProcess.exe'];
        executable = packExes.map((name) => path.join(installDir, name)).find((file) => fs.existsSync(file)) || '';
        if (!executable) {
          const found = await detectGame(game.builtinKey);
          if (found) executable = found;
        }
      }
      if (signal.cancelled) return { ok: false, cancelled: true };
      if (!executable) throw new Error('下载完成，但没有找到游戏启动程序');
      // 写回服务器与游戏：收尾口径和 servers:prepare-sophon 保持一致
      server.path = executable;
      server.root = installDir;
      server.incomplete = false;
      server.unavailable = false;
      game.activeServerId = server.id;
      game.target = executable;
      game.workDir = installDir;
      if (version) {
        game.version = version;
        game.versionName = version;
        // 全新安装也要记服务器版本，否则这条服务器一直挂着空值
        if (engine === 'sophon') server.sophonVersion = version;
      }
      ensureServers(game);
      await store.saveNow();
      pushState(true);
      send('sophon:progress', {
        jobId,
        phase: 'done',
        processed: 1,
        total: 1,
        bytesDone: Number(summary.totalBytes) || 0,
        totalBytes: Number(summary.totalBytes) || 0,
        current: '下载完成',
      });
      return { ok: true, engine, version, path: executable, targetRoot: installDir };
    } finally {
      endBackgroundTask();
      sophonJobs.delete(jobId);
    }
  });

  /*
   * ── 预下载 ──────────────────────────────────────────────────────────
   * 新版本正式上线前，官方会先放出预下载分支 / 预下载增量包。这里提前把内容拉到本地：
   *   - 米哈游系（原神 / 星穹铁道 / 绝区零）：<安装目录>/chunk/<chunk.id>，保持压缩态，不安装；
   *   - 终末地：<安装目录>/Diffs/<zip 文件名>，不解压；
   *   - 异环：官方没有公开的版本清单接口，不支持（predownload.describe 里有完整说明）。
   * 正式版上线后用 predownload:apply 应用，两个厂商都是「命中本地产物 → 0 流量，缺的才补下」。
   */
  /*
   * 演练模式的开关文件放在 userData 里：存在即启用，删掉即恢复真实链路。
   * 关掉的时候顺手把上次演练写进 server.predownload 的假状态摘掉 ——
   * 不然卡片会一直挂着「可以预下载」，而官方根本没有那个版本。
   */
  predownloadSim.setup({ userDataDir: app.getPath('userData') });
  predownloadSim.cleanup(store).catch(() => {});

  /*
   * 剧情等分类资源包的开关继承链：server → game → settings → false。
   * 默认是关的 —— 绝区零那 111 份分类包要 19.73GB，而主安装链路那边也是「默认不包含」，
   * 预下载要是默认开就会白下 20GB。
   */
  function storyResourcesEnabled(game, server) {
    if (typeof server?.includeStoryResources === 'boolean') return server.includeStoryResources;
    if (typeof game?.includeStoryResources === 'boolean') return game.includeStoryResources;
    return store.data?.settings?.includeStoryResources === true;
  }

  function resolvePredownload(input) {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    const server =
      (game.servers || []).find((item) => item.id === input?.serverId) ||
      (game.servers || []).find((item) => item.id === game.activeServerId);
    if (!server) throw new Error('没有找到这个服务器');
    const installRoot =
      game.builtinKey === 'endfield'
        ? predownload.endfieldInstallRoot(game, server)
        : predownload.hoyoInstallRoot(server);
    if (!installRoot) throw new Error('还没有配置这个游戏的客户端目录');
    /*
     * 渠道以客户端自己的 config.ini 为准（2.9.1）。
     * 老数据里可能把国际服客户端记在官服那一行，repairServerChannels 会搬走，
     * 但「点更新」这条链不该依赖那次修复已经跑过：这里再问一次客户端本身，
     * 免得拿着 nap_cn / hkrpg_cn 去和国际服客户端比对版本。
     */
    const clientChannelOfServer =
      game.builtinKey === 'endfield' ? '' : clientChannel.configChannelFromPath(server.path);
    return {
      game,
      server,
      installRoot,
      base: {
        gameKey: game.builtinKey,
        channel: clientChannelOfServer || server.channel,
        installRoot,
        cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
        audioLanguages: store.data?.settings?.audioLanguages,
        includeCategory: storyResourcesEnabled(game, server),
      },
    };
  }

  async function savePredownloadState(server, report) {
    server.predownload = predownload.stateFromReport(report);
    await store.saveNow();
    pushState(true);
  }

  /*
   * 启动时在后台悄悄问一次「官方有没有放出新版本的预下载」。
   *
   * 为什么要自动查：预下载按钮按设计**只在真的有新版本时才出现**（Starward 也是这样），
   * 如果非要用户先点一次「检查」才知道有没有，等于把这个功能藏起来了 ——
   * 用户根本不知道该点哪里。
   *
   * 三条约束，都是踩过坑才加的：
   *   1. 同一个服务器 2 小时内不重复问（PREDOWNLOAD_AUTO_TTL），别把官方接口当轮询用；
   *   2. 串行 + 每次间隔 1.5s，冷启动瞬间不要同时打五六个渠道，拖慢首屏；
   *   3. 查询失败**不覆盖**上一次的有效状态 —— 断网时按钮不能凭空消失。
   */
  const PREDOWNLOAD_AUTO_TTL = 2 * 60 * 60 * 1000;

  /*
   * 更新应用成功后，让基于这份客户端的「链接运行时」失效。
   *
   * 本体更新永远写进真实安装目录（endfieldInstallRoot 会自动排除运行时目录），
   * 运行时只是硬链接镜像 —— 所以「官服点了更新、国际服再点更新」**不会各下一次**：
   * 第二次检测到真实目录已是最新版本，apply 没有东西可下，直接走运行时刷新（秒级）。
   *
   * 每渠道一份独立运行时（<根>\endfield\<渠道>），标记 .hxl-endfield-runtime-v2 是 JSON。
   * 本体更新后只把标记里的 base 签名清空：下次切到该渠道时 ensureEndfieldChannelRuntime
   * 会发现 marker.base !== 最新 baseSignature，自动从更新后的本体整树重建。
   * 重建走 buildEndfieldChannelRuntime 的 staging + 同卷 rename，会把旧目录的
   * Endfield_Data/Persistent（用户下好的语音包 + 游戏自己维护的索引）整体搬过去，
   * 所以这里触发整树重建是安全的、不会丢下载内容。
   * 标记文件本身保留（不删），免得 publicGame 一时认不出这是运行时目录而误标红。
   */
  function invalidateRuntimesAfterUpdate(game) {
    for (const server of game.servers || []) {
      for (const dir of [server.root, server.originalRoot]) {
        if (!dir) continue;
        if (!isEndfieldRuntimeDir(dir)) continue;
        const marker = readEndfieldRuntimeMarker(dir);
        if (marker && marker.base) {
          writeEndfieldRuntimeMarker(dir, { ...marker, base: '', updatedAt: new Date().toISOString() });
        }
      }
    }
  }

  /*
   * 启动/切服前的轻量只读预检（边界①）。
   *
   * 设计约束（都是踩过坑才定的）：
   *   · 只读本地已落盘状态，绝不联网、绝不下载、绝不写游戏本体；
   *   · 只发 toast，绝不 return { ok:false } 阻断启动；调用方 fire-and-forget；
   *   · 断网 / 状态缺失 / 任何异常一律静默；
   *   · 同一游戏 30 分钟内不重复提示，别每次点开始都弹。
   *
   * 覆盖 7 款：预下载状态由 autoRefreshPredownloadStatus 每 30 分钟落盘到
   * server.predownload（米哈游4 + 终末地 + 异环）；明日方舟不进预下载，
   * 由 checkArknightsUpdateNotice 的 toast 覆盖。这里在「点开始游戏」那一刻
   * 再把已知状态问一遍，补掉启动后 18 秒定时检查的空窗。
   * 即时联网版本探测 / 运行时 marker / 渠道包齐备检查留到下一轮（要先修
   * 方舟 channel 硬编码与 root 指向，否则会误报）。
   */
  const LAUNCH_PREFLIGHT_TTL = 30 * 60 * 1000;
  const launchPreflightAt = new Map();

  function launchPreflightNotice(game, server) {
    const key = `${game.id}:${server?.id || ''}`;
    const now = Date.now();
    if (now - (launchPreflightAt.get(key) || 0) < LAUNCH_PREFLIGHT_TTL) return;
    const st = server?.predownload;
    if (!st || st.error || st.state !== 'update') return;
    // 只有真正要弹 toast 时才占用节流窗口：非 update 的启动不该烧掉 30 分钟，
    // 否则随后官方放包、状态变成 update 时，提示会被这次空跑压住漏报。
    launchPreflightAt.set(key, now);
    const label = String(game.name || game.builtinKey || '这个游戏');
    // 异环只刷启动器资源，文案别写成「更新游戏本体」
    const what =
      st.scope === 'launcher' || game.builtinKey === 'neverness' ? '启动器资源' : '游戏本体';
    send('toast', {
      type: 'info',
      message: `${label} 有官方${what}更新可应用，点「更新游戏」即可一键完成`,
    });
  }


  /*
   * 切服之后按新渠道补查一次更新状态。
   *
   * 自动检查只认「当前在用的那一服」，而且 30 分钟才轮一次：切到另一个渠道
   * （官服 7.2 ↔ 国际服 7.1）之后，那颗按钮要等半小时才可能变成「更新游戏」，
   * 中间那段就是「切过去了、可是没提示要更新」，看着像这个服永远是最新的。
   * 这里在切服成功后立刻问一次，结果照常落盘 + 推状态，按钮当回合就能变。
   */
  async function refreshPredownloadAfterSwitch(game) {
    if (!game || quitting) return;
    const server = (game.servers || []).find((item) => item.id === game.activeServerId);
    if (!server || !server.root) return;
    // 正在预下载 / 正在更新时别插队，免得两边抢同一份清单
    if (predownloadJobs.size) return;
    try {
      const { base } = resolvePredownload({ gameId: game.id, serverId: server.id });
      const report = await predownloadSim.check({ ...base, verify: false });
      if (report) await savePredownloadState(server, report);
    } catch (error) {
      writeLaunchLog(`predownload check after switch ${game.id}: ${error.message}`);
    }
  }

  async function autoRefreshPredownloadStatus() {
    const now = Date.now();
    for (const game of store.data.games || []) {
      if (quitting) return;
      /*
       * 这里原来写的是 `if (!game.installed) continue;` —— 那是错的：
       * store.data.games 上没有 installed 字段，它是 publicGame() 拼给渲染层时才加的。
       * 结果是这个「自动检查」从上线起一次都没跑过，预下载按钮只会在用户手动点
       * 「检查」之后才出现。改成看有没有可用客户端目录（下面本来就要用它）。
       */
      const servers = (game.servers || []).filter((item) => item.root);
      // 只查当前在用的那个渠道：别的渠道在启动页点不到，问了也是白问
      const server = servers.find((item) => item.active) || servers[0];
      if (!server) continue;
      // 演练模式下每次启动都重查，否则 2 小时 TTL 会让人以为开关没生效
      const fresh = predownloadSim.enabled() ? 0 : Date.parse(server.predownload?.updatedAt || '') || 0;
      /*
       * 异环在 2.8.3 之前落盘的状态不可信，两处都对不上现在的事实：
       *   1. 没有 scope 字段 —— 界面会把它说成「更新游戏」，可它只覆盖启动器资源；
       *   2. state 是按「版本号字面不等」算的 —— 官方改个命名就天天报「有更新」，
       *      而游戏本体一个字节都没动。
       * 所以别等两小时 TTL，当作过期直接重查。
       */
      const staleNte =
        String(server.predownload?.kind || '') === 'nte' && !server.predownload?.scope;
      if (server.predownload && !staleNte && now - fresh < PREDOWNLOAD_AUTO_TTL) continue;
      // 正在预下载 / 正在更新时别插队，免得两边抢同一份清单
      if (predownloadJobs.size) return;
      try {
        const { base } = resolvePredownload({ gameId: game.id, serverId: server.id });
        const report = await predownloadSim.check({ ...base, verify: false });
        if (report) await savePredownloadState(server, report);
      } catch (error) {
        writeLaunchLog(`predownload auto-check ${game.id}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  /*
   * 启动后先查一轮官方预下载状态，之后每 30 分钟补查。
   *
   * 这段定时器以前挂在 app.whenReady() 里，而 autoRefreshPredownloadStatus 定义在
   * 本闭包内 —— 跨作用域拿不到，每次触发都是
   * `ReferenceError: autoRefreshPredownloadStatus is not defined`（crash.log 里刷了几十次）。
   * 所以「启动后自动检查预下载」从上线起一次都没跑过，预下载入口只能靠手动点「检查」
   * 才出现。定时器必须和函数待在同一个作用域里，别再挪出去。
   */
  setTimeout(
    () => autoRefreshPredownloadStatus().catch(() => {}),
    predownloadSim.enabled() ? 2500 : 18000
  );
  setInterval(() => autoRefreshPredownloadStatus().catch(() => {}), 30 * 60 * 1000);

  ipcMain.handle('predownload:check', async (_event, input) => {
    const { server, base } = resolvePredownload(input);
    const report = await predownloadSim.check({ ...base, verify: input?.verify === true });
    await savePredownloadState(server, report);
    return report;
  });

  ipcMain.handle('predownload:start', async (_event, input) => {
    const { game, server, base } = resolvePredownload(input);
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再预下载');
    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = { cancelled: false };
    predownloadJobs.set(jobId, signal);
    beginBackgroundTask();
    send('predownload:progress', { jobId, phase: 'start', current: '正在读取官方清单…' });
    try {
      const result = await predownloadSim.start({
        ...base,
        signal,
        onProgress: (progress) => sendProgress('predownload:progress', jobId, progress),
      });
      if (signal.cancelled) return { ok: false, cancelled: true };
      await savePredownloadState(server, await predownloadSim.check(base));
      send('predownload:progress', { jobId, phase: 'done', current: '预下载完成' });
      return { ok: true, ...result };
    } catch (error) {
      server.predownload = {
        ...(server.predownload || {}),
        state: 'error',
        error: error.message,
        updatedAt: new Date().toISOString(),
      };
      await store.saveNow().catch(() => {});
      send('predownload:progress', { jobId, phase: 'error', current: error.message });
      throw error;
    } finally {
      endBackgroundTask();
      predownloadJobs.delete(jobId);
    }
  });

  ipcMain.handle('predownload:apply', async (_event, input) => {
    const { game, server, base } = resolvePredownload(input);
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再应用更新');
    // 异环更新会改写 NTELauncher 下的文件，官方启动器开着会锁文件 / 退出时回写配置
    if (game.builtinKey === 'neverness') await nevernessChannels.assertLauncherClosed();
    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = { cancelled: false };
    predownloadJobs.set(jobId, signal);
    beginBackgroundTask();
    send('predownload:progress', { jobId, phase: 'start', current: '正在校验并应用预下载内容…' });
    try {
      /*
       * 同机另一渠道客户端里已经有同内容的文件时，直接硬链接过来，别再下/解压一遍。
       * 「更新游戏」那条路一直是这么做的，应用预下载这条以前没接上：assembleFile 里的
       * 复用逻辑一直在，但没人把源递进来，等于白写。
       */
      const linkSources =
        game.builtinKey === 'endfield' ? [] : externalLinkSources(game, server, base.installRoot);
      const result = await predownloadSim.apply({
        ...base,
        linkSources,
        signal,
        onProgress: (progress) => sendProgress('predownload:progress', jobId, progress),
      });
      if (signal.cancelled) return { ok: false, cancelled: true };
      const tag = String(result?.tag || result?.version || '');
      /*
       * 异环这条「更新」动的只是 NTELauncher 那层资源，返回的是启动器资源版本
       * （实测 1.0.7.1029），跟卡片上的游戏版本（1.4）不是一回事。以前无条件
       * 覆盖，点完「更新启动器」卡片就变成 v1.0.7.1029，用户以为游戏升到别的版本了。
       * scope='launcher' 或异环这种「只更启动器」的结果一律不碰游戏版本号。
       */
      const launcherOnly =
        String(result?.scope || '') === 'launcher' || game.builtinKey === 'neverness' || base.gameKey === 'neverness';
      server.predownload = null;
      // 更新落在了真实安装目录，把链接运行时的标记清掉，下次启动自动重建
      invalidateRuntimesAfterUpdate(game);
      // 演练模式不能改写游戏真实版本号，否则卡片会挂一个官方根本没发布过的版本
      if (tag && !result?.simulated && !launcherOnly) {
        game.version = tag;
        game.versionName = tag;
      }
      game.lastOfficialSync = Date.now();
      if (game.activeServerId === server.id) {
        game.target = server.path || game.target;
        game.workDir = server.root || game.workDir;
      }
      await store.saveNow();
      pushState(true);
      syncOfficialGame(game, []).catch(() => {});
      send('predownload:progress', { jobId, phase: 'done', current: '更新已应用' });
      return { ok: true, ...result };
    } catch (error) {
      send('predownload:progress', { jobId, phase: 'error', current: error.message });
      throw error;
    } finally {
      endBackgroundTask();
      predownloadJobs.delete(jobId);
    }
  });

  ipcMain.handle('predownload:clear', async (_event, input) => {
    const { server, base } = resolvePredownload(input);
    const result = await predownloadSim.clear({ gameKey: base.gameKey, installRoot: base.installRoot });
    server.predownload = null;
    await store.saveNow();
    pushState(true);
    return { ok: true, ...result };
  });

  /*
   * ── 异环（neverness）官服 / B服 渠道 ─────────────────────────────────
   * 异环不是米哈游体系，没有 Sophon 清单，也不能用「重建 B服客户端」那套做法。
   * 它的渠道就写在启动器配置里：<安装目录>/NTELauncher/Config/Config.ini
   *   官服 Branch=publish_ob,   serialNumber=1
   *   B服  Branch=publish_ob_B, serialNumber=2, Partner=123
   * 所以这里只读写那三行，不动任何游戏文件。官方口径是「PC 端只支持官服」，
   * B服能否登录以实际为准 —— 这条提示放在返回的 notice 里，界面要显示出来。
   */
  ipcMain.handle('neverness:channel', async (_event, input) => {
    const game = store.data.games.find((item) => item.builtinKey === 'neverness');
    if (!game) throw new Error('没有找到异环');
    const server =
      (game.servers || []).find((item) => item.id === input?.serverId) ||
      (game.servers || []).find((item) => item.id === game.activeServerId);
    return nevernessChannels.readNevernessChannel({
      installRoot: server?.root || '',
      gamePath: server?.path || game.target || '',
    });
  });

  ipcMain.handle('neverness:set-channel', async (_event, input) => {
    const game = store.data.games.find((item) => item.builtinKey === 'neverness');
    if (!game) throw new Error('没有找到异环');
    if (running.has(game.id)) throw new Error('游戏正在运行，先退出异环再切换服务器');
    const server =
      (game.servers || []).find((item) => item.id === input?.serverId) ||
      (game.servers || []).find((item) => item.id === game.activeServerId);
    const result = await nevernessChannels.setNevernessChannel({
      installRoot: server?.root || '',
      gamePath: server?.path || game.target || '',
      channel: input?.channel,
    });
    // 把当前渠道记在服务器上，界面下次打开就能直接显示
    const target =
      (game.servers || []).find((item) => item.channel === result.channel) || server || null;
    if (target) game.activeServerId = target.id;
    await store.saveNow();
    pushState(true);
    return result;
  });

  /*
   * 切到 B服后一键拉起官方启动器下载 B服资源。
   * 官方启动器按 Config.ini 里的 VersionInfoFileURL 拉对应渠道的版本清单，
   * 资源只有首次需要下载，之后切来切去都是秒切，这一步只是为了省得用户手动去找。
   */
  ipcMain.handle('neverness:open-launcher', async () => {
    const game = store.data.games.find((item) => item.builtinKey === 'neverness');
    if (!game) throw new Error('没有找到异环');
    const server =
      (game.servers || []).find((item) => item.id === game.activeServerId) ||
      (game.servers || [])[0] ||
      null;
    const root = nevernessChannels.findConfigRoot(
      server?.root || server?.path || game.target || ''
    );
    if (!root) throw new Error('没有找到异环安装目录，先在服务器设置里指好游戏路径');
    const launcher = path.join(root, 'NTELauncher.exe');
    if (!fs.existsSync(launcher)) throw new Error(`没有找到官方启动器：${launcher}`);
    const error = await shell.openPath(launcher);
    if (error) throw new Error(`官方启动器打开失败：${error}`);
    return { ok: true };
  });

  /*
   * 预下载渠道资源：花筱灵自己按官方清单把对应渠道的启动器侧文件铺齐，
   * 之后官方启动器启动就没有"下载"环节。可取消。
   */
  let ntePredownloadAbort = null;
  let nteToolAbort = null;
  ipcMain.handle('neverness:predownload', async (_event, input) => {
    if (ntePredownloadAbort) throw new Error('已有预下载在进行中');
    const game = store.data.games.find((item) => item.builtinKey === 'neverness');
    if (!game) throw new Error('没有找到异环');
    const server =
      (game.servers || []).find((item) => item.id === input?.serverId) ||
      (game.servers || []).find((item) => item.id === game.activeServerId) ||
      (game.servers || [])[0] ||
      null;
    ntePredownloadAbort = new AbortController();
    try {
      return await nevernessPredownload.predownload({
        installRoot: server?.root || server?.path || game.target || '',
        channel: input?.channel || 'bilibili',
        signal: ntePredownloadAbort.signal,
        onProgress: (progress) => send('nte-predownload', progress),
      });
    } finally {
      ntePredownloadAbort = null;
    }
  });
  ipcMain.handle('neverness:predownload-cancel', () => {
    if (ntePredownloadAbort) {
      ntePredownloadAbort.abort();
      return { ok: true };
    }
    return { ok: false };
  });

  /*
   * 异环抽卡导出工具一键获取：查 GitHub 最新 release → 下载（自动换镜像）→
   * 解压到系统下载目录并打开文件夹。可取消，进度走 send('nte-tool', ...)。
   */
  ipcMain.handle('gacha:nte-tool', async (_event, _input) => {
    if (nteToolAbort) throw new Error('工具正在下载中');
    nteToolAbort = new AbortController();
    try {
      const result = await nteTool.run({
        downloadsDir: app.getPath('downloads'),
        signal: nteToolAbort.signal,
        onProgress: (progress) => send('nte-tool', progress),
      });
      // 下载解压完直接打开文件夹，省得用户自己找
      if (result?.dir) shell.openPath(result.dir).catch(() => {});
      return result;
    } finally {
      nteToolAbort = null;
    }
  });
  ipcMain.handle('gacha:nte-tool-cancel', () => {
    if (nteToolAbort) {
      nteToolAbort.abort();
      return { ok: true };
    }
    return { ok: false };
  });

  /*
   * 单个服务器覆盖「剧情分类资源包」开关。
   * 走独立 IPC 而不是扩 servers:update 的白名单，是为了不改动那个 handler 的现有逻辑。
   * 传 enabled=null 表示「不覆盖，跟随全局设置」。
   */
  ipcMain.handle('predownload:set-story-resources', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    const server = (game.servers || []).find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    const enabled = input?.enabled;
    if (enabled === null || enabled === undefined) {
      delete server.includeStoryResources;
    } else {
      server.includeStoryResources = Boolean(enabled);
    }
    await store.saveNow();
    pushState(true);
    // 口径变了要重新查一次，界面上的「已完成 / 需要重新预下载」才会跟着变
    const report = await predownload
      .check({
        gameKey: game.builtinKey,
        channel: server.channel,
        installRoot:
          game.builtinKey === 'endfield' ? predownload.endfieldInstallRoot(game, server) : predownload.hoyoInstallRoot(server),
        cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
        audioLanguages: store.data?.settings?.audioLanguages,
        includeCategory: storyResourcesEnabled(game, server),
      })
      .catch((error) => ({ state: 'error', error: error.message }));
    server.predownload = predownload.stateFromReport(report);
    await store.saveNow();
    pushState(true);
    return { ok: true, enabled: server.includeStoryResources ?? null, report };
  });

  ipcMain.handle('predownload:cancel', async (_event, jobId) => {
    const job = predownloadJobs.get(String(jobId));
    if (!job) return false;
    job.cancelled = true;
    return true;
  });

  ipcMain.handle('predownload:pause', async (_event, input) => {
    const job = predownloadJobs.get(String(input?.jobId));
    if (!job) return false;
    job.paused = input?.paused === true;
    return true;
  });

  ipcMain.handle('servers:cancel-link', async (_event, jobId) => {
    const job = linkJobs.get(jobId);
    if (!job) return false;
    job.cancelled = true;
    return true;
  });

  ipcMain.handle('servers:open-folder', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    const server = game?.servers.find((item) => item.id === input?.serverId);
    if (!server || !server.root) return false;
    await shell.openPath(server.root);
    return true;
  });

  /*
   * 卸载某个渠道的客户端（删掉安装目录里的文件）。
   *
   * 只删「这一台服务器独占」的目录，两条红线：
   *   ① 官服 / B服 常常指向同一个文件夹 —— 只要还有别的服务器（任何游戏）用着
   *      同一个 root，直接拒绝。这是之前「删了 B服 官服也一起没了」那件事的补偿。
   *   ② 目录浅到只剩盘符（G:\）或者用户主目录这种，一律不动：真要误删了找不回来。
   *
   * 删除动作走系统回收站（shell.trashItem），不是 rm -rf —— 删错了还能捞。
   */
  const uninstallPlan = (game, server) => {
    /*
     * 游戏开着的时候优先说这一句。
     * 以前这个判断放在渲染层、而且排在「目录被共用」后面：共用目录一挡，
     * 用户看到的是「还被 XX 用着」，跟他此刻真正的问题（游戏没关）对不上号。
     * 更要紧的是文件被进程占着，trashItem 会直接失败，抛出来的还是英文系统错误。
     */
    if (running.has(game.id) || launching.has(game.id)) {
      return {
        ok: false,
        running: true,
        reason: '游戏正在运行，先关掉游戏再卸载客户端',
      };
    }
    const root = String(server?.root || '').trim();
    if (!root) {
      return { ok: false, reason: '这个服务器还没有安装目录，没有可卸载的文件' };
    }
    const norm = root.replace(/[\\/]+$/, '').toLowerCase();
    const segments = norm.split(/[\\/]+/).filter(Boolean);
    // 盘符根目录（G:\）和用户主目录一律不碰：误删的代价太大，让用户自己去资源管理器
    const home = os.homedir().replace(/[\\/]+$/, '').toLowerCase();
    if (segments.length < 2 || norm === home) {
      return {
        ok: false,
        reason: `「${root}」层级太浅，为免误删，请到资源管理器里手动处理`,
      };
    }
    const shared = [];
    for (const other of store.data.games) {
      for (const item of other.servers || []) {
        if (other.id === game.id && item.id === server.id) continue;
        const otherRoot = String(item.root || '').replace(/[\\/]+$/, '').toLowerCase();
        if (otherRoot && otherRoot === norm) {
          shared.push(`${other.name} · ${item.name}`);
        }
      }
    }
    if (shared.length) {
      return {
        ok: false,
        reason: `这个文件夹还被「${shared.join(
          '」「'
        )}」用着：它们共用同一个目录，删掉就一起没了`,
        root,
        shared,
      };
    }
    return { ok: true, root, exists: fs.existsSync(root) };
  };

  ipcMain.handle('servers:uninstall-plan', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) return { ok: false, reason: '没有找到这个游戏' };
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server) return { ok: false, reason: '没有找到这个服务器' };
    const plan = uninstallPlan(game, server);
    return { ...plan, running: running.has(game.id) };
  });

  /*
   * 卸载客户端。
   *
   * 全部走返回值、不抛异常：IPC 抛出来的错误只剩一句 message，既带「Error invoking
   * remote method」的英文壳，也带不了「能不能改成永久删除」这种结构化信息。用户看
   * 到的就是一句看不懂的英文，压根不知道该干嘛。
   *
   * 失败分三类，各自给一句能照着做的话：
   *   BUSY  文件被占着（游戏/更新器没退干净）
   *   TRASH 回收站用不了（被策略禁用、回收站损坏、UWP 精简系统）—— 可以 force 直删
   *   OTHER 其它系统错误，附原始信息
   */
  ipcMain.handle('servers:uninstall', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) return { ok: false, code: 'NOT_FOUND', reason: '没有找到这个游戏' };
    if (running.has(game.id) || launching.has(game.id)) {
      return {
        ok: false,
        code: 'RUNNING',
        reason: '游戏正在运行，先关掉游戏再卸载客户端',
      };
    }
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server) return { ok: false, code: 'NOT_FOUND', reason: '没有找到这个服务器' };
    const plan = uninstallPlan(game, server);
    if (!plan.ok) return { ok: false, code: plan.running ? 'RUNNING' : 'BLOCKED', reason: plan.reason };

    let moved = false;
    if (plan.exists) {
      if (input?.force === true) {
        // 二次确认过的永久删除：回收站用不了时的唯一出路
        try {
          await fsp.rm(plan.root, { recursive: true, force: true, maxRetries: 2 });
        } catch (error) {
          return {
            ok: false,
            code: 'OTHER',
            reason: `直接删除也没成功，可能有程序还占着这些文件：${String(
              error?.message || error || ''
            )}`,
            root: plan.root,
          };
        }
      } else {
        // 回收站而不是直接删：这一步之后用户还能在回收站里找回来
        try {
          await shell.trashItem(plan.root);
        } catch (error) {
          const raw = String(error?.message || error || '');
          if (/EBUSY|EPERM|EACCES|being used|正在使用|占用|locked/i.test(raw)) {
            return {
              ok: false,
              code: 'BUSY',
              // 别断言「被占用」：Windows 上「ACL 没给 DELETE 权限」和「文件被别的进程打开」
              // 在 Node 里都是 EPERM，靠错误码分不出来（2026-11-11 用户报障就是这个误判）。
              // 这里只把两种可能都摆出来，让用户按顺序排查。
              reason: `「${plan.root}」里的文件动不了：可能是游戏/更新器还开着（托盘里也退掉），也可能是这个目录的权限不够。完全退出后仍然不行，就用管理员身份重新打开启动器再试`,
              root: plan.root,
            };
          }
          /*
           * 剩下最常见的就是回收站本身用不了 —— 系统策略禁用、回收站损坏、
           * 或者目录在某个不支持回收站的卷上。这种情况允许改成永久删除。
           */
          return {
            ok: false,
            code: 'TRASH',
            reason: '系统回收站用不了，没法把文件挪进去（文件本身没动）',
            detail: raw,
            root: plan.root,
          };
        }
      }
      moved = true;
    }
    // 文件没了，路径记录也要跟着清：否则启动器还指着一个空目录
    resetServerState(server);
    ensureServers(game);
    await store.saveNow();
    pushState(true);
    return { ok: true, target: plan.root, moved, forced: input?.force === true };
  });

  ipcMain.handle('games:sync-official', async () => syncAllOfficial());

  ipcMain.handle('games:launch', async (_event, id, options) => {
    const game = store.data.games.find((g) => g.id === id);
    if (!game) return { ok: false, error: '没有找到这个游戏' };
    /*
     * purpose 目前只有一个值：'predownload'（异环「打开官方预下载」）。
     * 这条路上的差别是：不刷新最近游玩、不自动点「开始游戏」，也绝不杀掉
     * 已经在跑的官方启动器（用户可能正靠它下载预下载资源）。
     */
    const purpose = options && typeof options === 'object' ? String(options.purpose || '') : '';
    // 先清掉已经不存在的进程，避免「点了没反应、只说游戏在运行」
    if (await pruneStaleRunning()) pushState(true);
    if (running.has(id)) return { ok: false, error: '游戏已经在运行了' };
    if (launching.has(id)) {
      return { ok: false, error: '正在启动中，请稍候…（如果弹出了管理员授权窗口，请点“是”）' };
    }

    let target = String(game.target || '').trim();
    const activeServer = (game.servers || []).find(
      (server) =>
        server.id === game.activeServerId &&
        server.path &&
        targetExists(server.path) &&
        // 旧单 work 混合目录绝不沿用：否则 allowPackDownload 会被关掉、
        // 重建失败又被「尽力而为」吞掉，最后静默启动那个 3~9 秒就崩的目录。
        !isEndfieldLegacyWorkRoot(path.dirname(server.path))
    );
    if (activeServer) {
      target = activeServer.path;
      game.target = activeServer.path;
      game.workDir = activeServer.root || path.dirname(activeServer.path);
    }
    if (game.builtinKey === 'endfield' && !running.has(id)) {
      // 所有渠道统一先走自动生成：该渠道的独立运行时已建好且签名未变就只复用（很快），
      // 只有目录里连 Endfield.exe 都没有、或基础客户端更新过才会重建，并清掉 incomplete
      // 让启动页状态点变绿。
      const efServer = (game.servers || []).find((server) => server.id === game.activeServerId);
      if (efServer) {
        // 已经能直接启动时就不要再为了补渠道包让「开始游戏」等上一场下载
        const prepared = await ensureEndfieldChannelRuntime(game, efServer, {
          allowPackDownload: !(activeServer && targetExists(activeServer.path)),
          allowRuntimeBase: true,
        }).catch((error) => {
          // 已经有可用路径时尽力而为：重建失败不阻断启动；连路径都没有就只能报错。
          if (activeServer && targetExists(activeServer.path)) return null;
          return { ok: false, error: '自动生成' + efServer.name + '运行时失败：' + error.message };
        });
        if (prepared) writeLaunchLog(`launch ${id}: endfield runtime ok=${prepared.ok !== false} built=${prepared.built === true} root=${prepared.runtimeRoot || ''}`);
        if (prepared && prepared.ok === false) return prepared;
        if (prepared) {
          target = prepared.launchPath;
          game.target = prepared.launchPath;
          game.workDir = prepared.runtimeRoot;
        }
      }
    }
    /*
     * 启动前轻量只读预检（边界①）：只读已落盘的 server.predownload 发个 toast，
     * 补掉「启动后 18 秒定时检查」的空窗。fire-and-forget：不联网、不下载、
     * 不阻断启动；异环打开官方预下载那条路不提示。异常一律吞掉。
     */
    if (purpose !== 'predownload' && activeServer) {
      try { launchPreflightNotice(game, activeServer); } catch {}
    }
    if (!target) {
      return { ok: false, error: '还没有配置启动程序，先编辑这个游戏吧' };
    }

    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
        await shell.openExternal(target);
        await markLaunched(game);
        return { ok: true, external: true };
      }

      if (!path.isAbsolute(target)) {
        return { ok: false, error: '启动程序需要使用完整路径，请重新选择一次' };
      }

      if (!fs.existsSync(target)) {
        return { ok: false, error: '启动程序不存在，请编辑游戏重新选择' };
      }

      const stat = fs.statSync(target);
      if (!stat.isFile()) return { ok: false, error: '启动路径不是一个文件' };

      let nteDirectArgs = [];
      if (game.builtinKey === 'neverness' && store.data.settings.nevernessUseOfficialLauncher !== false) {
        /*
         * 官方启动链的中间环节 NTEGame.exe /launcher：自带资源校验，直达登录窗，
         * 跳过 NTELauncher 主界面（资讯/商城那些）——点花筱灵「启动」≈直接到登录。
         * NTEGame 不在时回落 NTELauncher.exe 完整链路。
         */
        const nteGame = findNteGame(target);
        if (nteGame) {
          writeLaunchLog(`launch ${id}: NTE direct game chain=${nteGame}`);
          target = nteGame;
          nteDirectArgs = ['/launcher'];
        } else {
          const launcher = findNteLauncher(target);
          if (launcher) {
            writeLaunchLog(`launch ${id}: NTE official launcher=${launcher}`);
            target = launcher;
          }
        }
        /*
         * 清掉官方启动器的托盘残留：它关窗只是缩托盘，进程不退。带着旧进程 spawn
         * 会触发它的单实例「唤醒旧实例→旧实例退出→新实例秒退」，点了等于没点。
         */
        if (/^nte(game|launcher)\.exe$/i.test(path.basename(target))) {
          if (purpose === 'predownload') {
            /*
             * 预下载只借用官方启动页：它已经开着就直接拉到前台，绝不先杀掉。
             * 官方正在下载预下载资源时把它结束掉，等于把用户几十分钟的进度连进程一起收了。
             */
            const alive = await listRunningImages(['NTEGame.exe']);
            if (alive.length) {
              await activateWindowByImage('NTEGame.exe');
              writeLaunchLog(`launch ${id}: NTE official launcher already open, reused for predownload`);
              return { ok: true, reused: true, officialPage: true };
            }
          }
          const nteClear = await clearNteLingeringLauncher(id);
          if (nteClear.code === 'game-running') {
            return { ok: false, error: '异环已经在运行了（HTGame.exe）。先玩着，或退出游戏再启动。' };
          }
          if (nteClear.code === 'updater-running') {
            return { ok: false, error: '异环官方更新器正在自更新，等十几秒再点一次。' };
          }
        }
      }

      if (game.builtinKey === 'endfield') {
        /*
         * 「点了启动却弹出官方启动器」的根因：安装/更新/兜底链路会把 server.path
         * 存成 PlatformProcess.exe（平台进程）甚至 HypergryphLauncher.exe ——
         * 这两个直接跑起来就是官方平台/启动器界面，永远不会是游戏。
         * 启动前统一修正：同目录（或 workDir）有 Endfield.exe 就用它，
         * 按官方启动器托管布局再找一层（games\Endfield Game\Endfield.exe）；
         * 都没有就明确报错，绝不直接执行平台进程。
         */
        const baseName = path.basename(target).toLowerCase();
        if (baseName !== 'endfield.exe') {
          const rootDir =
            game.workDir && fs.existsSync(path.join(game.workDir, 'Endfield.exe'))
              ? game.workDir
              : path.dirname(target);
          const gameExe = [
            path.join(path.dirname(target), 'Endfield.exe'),
            path.join(rootDir, 'Endfield.exe'),
            path.join(path.dirname(target), 'games', 'Endfield Game', 'Endfield.exe'),
            path.join(rootDir, 'games', 'Endfield Game', 'Endfield.exe'),
          ].find((candidate) => fs.existsSync(candidate));
          if (gameExe) {
            writeLaunchLog(`launch ${id}: 终末地启动路径被修正 ${target} -> ${gameExe}`);
            target = gameExe;
            game.workDir = path.dirname(gameExe);
          } else if (/platformprocess|hypergryphlauncher/i.test(baseName)) {
            writeLaunchLog(`launch ${id}: 终末地路径指向平台进程且找不到游戏本体：${target}`);
            return {
              ok: false,
              error:
                '这个服务器指向的是官方启动器的平台进程，不是游戏本体（Endfield.exe 缺失）。' +
                '请在这个服务器上点「重建运行时」，或到服务器设置里把路径指到 Endfield.exe。',
            };
          }
        }
      }

      if (game.builtinKey === 'arknights') {
        /*
         * 明日方舟官服 / B服 的目录里同样躺着 PlatformProcess.exe（鹰角两家游戏
         * 共用同一套平台层，Xel-Launcher 的方舟渠道清单里就包含它）。扫描时我们
         * 只认 Arknights.exe 当入口，不会存成它；但用户手改过路径、或者数据是从
         * 更早的版本升上来的，server.path 有可能已经指向平台进程 —— 跑起来就是
         * 官方平台界面。这里同样修正到本体。
         */
        const baseName = path.basename(target).toLowerCase();
        if (baseName !== 'arknights.exe') {
          const rootDir =
            game.workDir && fs.existsSync(path.join(game.workDir, 'Arknights.exe'))
              ? game.workDir
              : path.dirname(target);
          const gameExe = [
            path.join(path.dirname(target), 'Arknights.exe'),
            path.join(rootDir, 'Arknights.exe'),
            path.join(path.dirname(target), 'games', 'Arknights Game', 'Arknights.exe'),
            path.join(rootDir, 'games', 'Arknights Game', 'Arknights.exe'),
          ].find((candidate) => fs.existsSync(candidate));
          if (gameExe) {
            writeLaunchLog(`launch ${id}: 明日方舟启动路径被修正 ${target} -> ${gameExe}`);
            target = gameExe;
            game.workDir = path.dirname(gameExe);
          } else if (/platformprocess|hypergryphlauncher/i.test(baseName)) {
            writeLaunchLog(`launch ${id}: 明日方舟路径指向平台进程且找不到游戏本体：${target}`);
            return {
              ok: false,
              error:
                '这个服务器指向的是官方启动器的平台进程，不是游戏本体（Arknights.exe 缺失）。' +
                '请在这个服务器上点「重建运行时」，或到服务器设置里把路径指到 Arknights.exe。',
            };
          }
        }
      }

      const lower = target.toLowerCase();
      let cwd = game.workDir && fs.existsSync(game.workDir) ? game.workDir : path.dirname(target);
      if (
        game.builtinKey === 'neverness' &&
        ['ntelauncher.exe', 'ntegame.exe'].includes(path.basename(target).toLowerCase())
      ) {
        cwd = path.dirname(target);
      }
      let args = splitArgs(game.args);
      /*
       * 渲染后端（DX11 / DX12）参数拼在最前面：用户自定义参数在后，
       * 万一两边写了冲突的开关，以用户手填的为准。
       */
      const renderArgs = renderApi.argsFor(game.builtinKey, game.renderApi);
      if (renderArgs.length) args = [...renderArgs, ...args];
      if (
        nteDirectArgs.length &&
        path.basename(target).toLowerCase() === 'ntegame.exe' &&
        !args.some((item) => /^\/?launcher$/i.test(item))
      ) {
        args = [...nteDirectArgs, ...args];
      }

      if (lower.endsWith('.lnk') || lower.endsWith('.url')) {
        /*
         * 终末地不允许走快捷方式：快捷方式可能指向官方启动器（那就白弹一次界面），
         * 而且绕过签名父进程后游戏会报 10100。直接让用户指到本体。
         */
        if (game.builtinKey === 'endfield') {
          return {
            ok: false,
            error: '终末地不能用快捷方式启动（可能指向官方启动器）。请在这个服务器上把路径直接指到 Endfield.exe。',
          };
        }
        const openError = await shell.openPath(target);
        if (openError) return { ok: false, error: openError };
        await markLaunched(game);
        return { ok: true, external: true };
      }

      if (!lower.endsWith('.exe') && !lower.endsWith('.bat') && !lower.endsWith('.cmd')) {
        const openError = await shell.openPath(target);
        if (openError) return { ok: false, error: openError };
        await markLaunched(game);
        return { ok: true, external: true };
      }

      /*
       * 终末地：不论 exe 叫什么名字（含用户改过名的 Endfield_cn.exe），一律经签名
       * 父进程 —— 只要落到下面的通用启动，父进程就是花筱灵自己，游戏立刻报
       * 10100「请通过官方启动器打开游戏」。指向平台进程的那种在上面已经被拦下。
       *
       * 明日方舟**不走**这条链路：它不校验父进程，双击本体就能开。Xel-Launcher 里
       * 也是同一条界线 —— 它的 decoy 父进程桥只对 Endfield / BiliEndfield /
       * GlobalEndfield / PlayEndfield 四个渠道启用，Arknights 系一律普通启动。
       * 套上去只会让每次开方舟都白跑一次 PowerShell，在没装终末地的机器上
       * 还会必然失败。
       */
      if (game.builtinKey === 'endfield') {
        const signed = await launchWithSignedParent(game, target, cwd, {
          requireElevation: true,
          strict: true,
          // 渲染后端参数也要一起传：这条链路绕过了下面的 spawn，漏传等于 DX 开关对终末地无效
          args: args.join(' '),
        });
        if (signed.handled) return signed.result;
      }

      launching.set(id, Date.now());
      writeLaunchLog(`launch ${id}: target=${target} args=${args.join(' ')} cwd=${cwd}`);

      let pid = null;
      let shellError = '';
      const needExplicitArgs = args.length > 0 || (game.workDir && fs.existsSync(game.workDir));
      if (needExplicitArgs) {
        const result = await startWithShellExecute(target, args, cwd);
        if (result.ok) pid = result.pid;
        else shellError = result.error;
      } else {
        const openError = await shell.openPath(target);
        if (openError) {
          const result = await startWithShellExecute(target, args, cwd);
          if (result.ok) pid = result.pid;
          else shellError = result.error;
        }
      }

      if (!pid && shellError) {
        // 最后再尝试一次 CreateProcess，部分绿色程序不接受 ShellExecute。
        try {
          const child = spawn(target, args, {
            cwd,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          });
          if (child.pid) {
            pid = child.pid;
            running.set(id, { pid, startedAt: Date.now() });
            child.once('error', () => {
              running.delete(id);
              pushState(true);
            });
            child.once('exit', () => finishGame(id));
            child.unref();
          }
        } catch (error) {
          launching.delete(id);
          writeLaunchLog(`launch ${id}: failed ${shellError}; ${error.message}`);
          return { ok: false, error: shellError || error.message };
        }
      }

      // 预下载只是去官方页面下资源，不算「玩过这个游戏」——别去动最近游玩时间
      if (purpose !== 'predownload') await markLaunched(game);

      if (lower.endsWith('.exe') && !running.has(id)) {
        const isNeverness = game.builtinKey === 'neverness';
        const trackExe = isNeverness ? 'HTGame.exe' : path.basename(target);
        trackGameProcess(
          id,
          trackExe,
          isNeverness ? null : Date.now(),
          isNeverness ? 150 : 8
        ).catch(() => {});
        /*
         * 请求了渲染后端就核对一次结果。
         * 参数传过去不等于生效：客户端可能不认这个开关，也可能显卡不支持而静默回退。
         * 45 秒足够冷启动写完 Player.log，又不至于拖到用户已经进游戏几分钟。
         * 详情只进启动日志，不打扰界面 —— 读不到日志路径是常态，不该弹提示。
         */
        if (renderArgs.length) {
          const probe = setTimeout(async () => {
            try {
              const requested = renderApi.labelFor(game.builtinKey, game.renderApi);
              const actual = await renderApi.readActualApi(game.builtinKey);
              writeLaunchLog(
                `launch ${id}: 渲染后端 请求=${requested} 实际=${actual || '未从游戏日志确认'}`
              );
            } catch {
              /* 日志读不到就算了，不影响游戏 */
            }
          }, 45000);
          probe.unref?.();
        }
        if (isNeverness && path.basename(target).toLowerCase() === 'ntegame.exe') {
          if (purpose === 'predownload') {
            // 只试着点官方页面上的「预下载」，绝不点「开始游戏」——那是直接进游戏
            autoClickNtePredownload(id);
          } else {
            // 异环直达登录窗后，帮忙把「开始游戏」也点了（UIA 找按钮，找不到就静默让人点）
            autoClickNteStart(id);
          }
        }
      } else {
        launching.delete(id);
      }

      return { ok: true, pid: pid || null };
    } catch (error) {
      launching.delete(id);
      writeLaunchLog(`launch ${id}: exception ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('games:stop', async (_event, id) => {
    if (!running.has(id)) return { ok: false, error: '这个游戏没有在运行' };
    await killGame(id);
    return { ok: true };
  });

  ipcMain.handle('games:reveal', async (_event, id) => {
    const game = store.data.games.find((g) => g.id === id);
    if (!game || !game.target) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(game.target)) return false;
    try {
      if (fs.existsSync(game.target)) {
        shell.showItemInFolder(game.target);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  });

  ipcMain.handle('dialog:pick-executable', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择游戏的启动程序',
      properties: ['openFile'],
      filters: [
        { name: '可执行文件与快捷方式', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-image', async () => {
    const result = await dialog.showOpenDialog(win, {
      // 头像、封面、自定义背景都走这个选择器，所以标题保持中性
      title: '选择图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-audio', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择歌曲',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-directory', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('cover:import', async (_event, sourcePath) => {
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('图片不存在');
    const stat = fs.statSync(sourcePath);
    if (stat.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB');
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
    if (!allowed.has(ext)) throw new Error('不支持这种图片格式');
    const dir = path.join(app.getPath('userData'), 'covers');
    await fsp.mkdir(dir, { recursive: true });
    const fileName = `cover-${crypto.randomUUID()}${ext}`;
    await fsp.copyFile(sourcePath, path.join(dir, fileName));
    return `covers/${fileName}`;
  });

  ipcMain.handle('avatar:import', async (_event, sourcePath) => {
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('图片不存在');
    const stat = fs.statSync(sourcePath);
    if (stat.size > 20 * 1024 * 1024) throw new Error('头像不能超过 20 MB');
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
    if (!allowed.has(ext)) throw new Error('不支持这种图片格式');
    const dir = path.join(app.getPath('userData'), 'avatars');
    await fsp.mkdir(dir, { recursive: true });
    const fileName = `avatar-${crypto.randomUUID()}${ext}`;
    await fsp.copyFile(sourcePath, path.join(dir, fileName));
    return `avatars/${fileName}`;
  });

  /*
   * 官方背景：跟随鹰角「版本简报」页面自动换。
   * sync 是手动按钮 / 启动时共用的入口；official-state 给切换器出缩略图。
   */
  let officialSyncState = { busy: false, lastError: '', lastResult: null };
  ipcMain.handle('background:sync-official', async () => {
    if (officialSyncState.busy) return { busy: true };
    officialSyncState.busy = true;
    officialSyncState.lastError = '';
    try {
      const result = await hgBackgrounds.syncOfficialBackgrounds(app.getPath('userData'));
      officialSyncState.lastResult = result;
      return { ok: true, ...result };
    } catch (error) {
      officialSyncState.lastError = (error && error.message) || String(error);
      console.warn('官方背景同步失败：', officialSyncState.lastError);
      return { ok: false, error: officialSyncState.lastError };
    } finally {
      officialSyncState.busy = false;
    }
  });
  ipcMain.handle('background:official-state', async () => {
    const backgrounds = await hgBackgrounds.listOfficialBackgrounds(app.getPath('userData'));
    return {
      backgrounds,
      busy: officialSyncState.busy,
      lastError: officialSyncState.lastError,
      lastResult: officialSyncState.lastResult,
    };
  });
  ipcMain.handle('background:official-stat', async () =>
    hgBackgrounds.officialBackgroundsStat(app.getPath('userData'))
  );

  ipcMain.handle('background:import', async (_event, sourcePath) => {
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('图片不存在');
    const stat = fs.statSync(sourcePath);
    if (stat.size > 40 * 1024 * 1024) throw new Error('背景图不能超过 40 MB');
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
    if (!allowed.has(ext)) throw new Error('请选择 PNG / JPG / WebP / GIF 图片');
    const dir = path.join(app.getPath('userData'), 'backgrounds');
    await fsp.mkdir(dir, { recursive: true });
    // 清掉旧的自定义背景，避免目录无限增长
    try {
      for (const name of await fsp.readdir(dir)) {
        if (name.startsWith('custom-')) await fsp.rm(path.join(dir, name), { force: true });
      }
    } catch {
      /* 清理失败不影响导入 */
    }
    const fileName = `custom-${crypto.randomUUID()}${ext}`;
    await fsp.copyFile(sourcePath, path.join(dir, fileName));
    return `backgrounds/${fileName}`;
  });

  ipcMain.handle('shell:open-path', async (_event, target) => {
    if (!target || typeof target !== 'string') return false;
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (!/^https?:\/\//i.test(String(url))) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('app:open-data-folder', async () => {
    await fsp.mkdir(app.getPath('userData'), { recursive: true });
    await shell.openPath(app.getPath('userData'));
  });

  ipcMain.handle('app:open-download-folder', async () => {
    try {
      const dir = await ensureDownloadsDir();
      const error = await shell.openPath(dir);
      // 静默失败最糟：用户点了没反应，还以为下载丢了自己去找
      if (error) return { ok: false, path: dir, error };
      return { ok: true, path: dir, error: '' };
    } catch (error) {
      console.warn('打开下载文件夹失败：', error && error.message);
      return { ok: false, path: '', error: (error && error.message) || String(error) };
    }
  });

  /*
   * 打开覆盖脚本留下的日志。
   * 更新是在 detached 的 PowerShell 里做的，控制台没人看得到；
   * 用户报「更新没完成」时，让他把这个文件发回来就能定位到底卡在哪一步。
   */
  ipcMain.handle('app:open-update-log', async () => {
    const candidates = ['update-log.txt', 'self-heal.log', 'last-update.json', 'update-error.json'];
    for (const dir of updateLogDirs()) {
      for (const name of candidates) {
        const target = path.join(dir, name);
        if (fs.existsSync(target)) {
          await shell.openPath(target);
          return { ok: true, path: target, opened: true };
        }
      }
    }
    const dir = updateLogDirs()[0];
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    await shell.openPath(dir);
    return { ok: true, path: dir, opened: false };
  });

  /** 直接把日志内容读回渲染层，省得用户还要去找文件。 */
  ipcMain.handle('app:read-update-log', async () => {
    const dirs = updateLogDirs();
    const read = async (name) => {
      for (const dir of dirs) {
        try {
          const text = await fsp.readFile(path.join(dir, name), 'utf8');
          return text.replace(/^\uFEFF/, '').trim();
        } catch {
          /* 换下一个目录 */
        }
      }
      return '';
    };
    return {
      dir: dirs[0],
      log: await read('update-log.txt'),
      selfHeal: await read('self-heal.log'),
      error: await read('update-error.json'),
    };
  });

  /*
   * 一键导出诊断信息到桌面。
   *
   * 不打包成 zip：导出的是一个纯文本文件，用户直接拖进聊天窗口就能发，不用先找
   * 压缩软件。内容只含版本、系统、设置摘要、网络请求元数据和已有日志；设置是
   * 按白名单逐项挑的，不是把 settings 整个 dump 出去——那里有账号和密钥。
   */
  ipcMain.handle('diag:export', async () => {
    try {
      const dirs = updateLogDirs();
      const readLog = async (name, limit = 12000) => {
        for (const dir of dirs) {
          try {
            const text = await fsp.readFile(path.join(dir, name), 'utf8');
            const clean = text.replace(/^\uFEFF/, '').trim();
            return clean.length > limit ? clean.slice(-limit) : clean;
          } catch {
            /* 换下一个目录 */
          }
        }
        return '';
      };
      let crashLog = '';
      try {
        const raw = await fsp.readFile(path.join(app.getPath('userData'), 'crash.log'), 'utf8');
        crashLog = raw.length > 20000 ? raw.slice(-20000) : raw;
      } catch {
        /* 没崩溃过就没有这个文件 */
      }

      /*
       * stage 失败时写的「解压结构诊断」：最有用的一份证据，以前用户拿不到——
       * 它在 vela-update-* 里，下次启动就被 cleanTemp 删了。所以 stage 现在会
       * 额外往 tempBase 根写一份（cleanTemp 不删根文件），这里两处都找，取最新的。
       */
      const findLatestStageDebug = async (limit = 12000) => {
        const found = [];
        for (const dir of dirs) {
          try {
            const file = path.join(dir, 'stage-debug.json');
            const stat = await fsp.stat(file);
            found.push({ path: file, mtimeMs: stat.mtimeMs });
          } catch {
            /* 没有根级兜底副本就算了 */
          }
        }
        for (const dir of dirs) {
          let entries;
          try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('vela-update-') || entry.name.includes('staging')) continue;
            const file = path.join(dir, entry.name, 'stage-debug.json');
            try {
              const stat = await fsp.stat(file);
              found.push({ path: file, mtimeMs: stat.mtimeMs });
            } catch {
              /* 这个目录里没有诊断文件 */
            }
          }
        }
        if (!found.length) return null;
        found.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const latest = found[0];
        let text = (await fsp.readFile(latest.path, 'utf8')).replace(/^\uFEFF/, '').trim();
        if (text.length > limit) text = text.slice(-limit);
        return { path: latest.path, text };
      };
      const stageDebug = await findLatestStageDebug();
      let launchLog = '';
      try {
        const raw = await fsp.readFile(path.join(app.getPath('userData'), 'launch.log'), 'utf8');
        launchLog = raw.length > 6000 ? raw.slice(-6000) : raw;
      } catch {
        /* 没记录过就没有这个文件 */
      }

      const cfg = store?.data?.settings || {};
      const updateSourceModeText = {
        auto: '自动（内置镜像依次尝试）',
        mirrorchyan: 'Mirror酱 优先',
        gitee: 'Gitee 镜像优先',
        jsdelivr: 'jsDelivr 优先',
        github: 'GitHub 直连优先',
        custom: '只用手填地址',
      }[cfg.updateSourceMode || 'auto'] || `未知（${cfg.updateSourceMode}）`;
      const settingsSummary = {
        主题: `${cfg.theme || '跟随系统'} / 强调色 ${cfg.accent || '默认'}`,
        代理: cfg.proxyRules ? String(cfg.proxyRules) : '未设置（直连）',
        更新源模式: updateSourceModeText,
        更新源: cfg.updateManifest ? String(cfg.updateManifest) : '内置官方源',
        /*
         * Mirror酱 只报「配没配」和 RID，不报 CDK —— 诊断包是要发给别人的文本，
         * CDK 是用户的付费凭证，写进去等于替他公开了。
         */
        Mirror酱: cfg.mirrorchyanRid
          ? `RID ${String(cfg.mirrorchyanRid).slice(0, 64)} / CDK ${cfg.mirrorchyanCdk ? '已配置（不在诊断里显示）' : '未填（只能查版本，不能加速下载）'}`
          : '未配置',
        自动检查更新: cfg.autoCheckUpdate === false ? '关闭' : '开启',
        清单签名: `已启用，公钥 ${minisign.KEY_ID}，最近验签版本 ${cfg.updateSignedVersion || '（还没验过）'}`,
        最近一次检查: updateStatus
          ? `${updateStatus.ok ? '成功' : '失败'}  当前 ${updateStatus.current || APP_VERSION} / 最新 ${updateStatus.latest || '?'}${updateStatus.error ? `  错误：${updateStatus.error}` : ''}`
          : '（还没检查过）',
        游戏数量: String((store?.data?.games || []).length),
      };
      const env = {
        版本: APP_VERSION,
        Electron: process.versions.electron || '',
        Chrome: process.versions.chrome || '',
        Node: process.versions.node || '',
        系统: `${os.type()} ${os.release()} ${process.arch}`,
        安装目录: path.dirname(process.execPath),
        数据目录: app.getPath('userData'),
      };

      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stampName = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const target = path.join(app.getPath('desktop'), `花筱灵诊断-${stampName}.txt`);
      const text = diagnostics.buildReport({
        generatedAt: now.toLocaleString('zh-CN'),
        env,
        settings: settingsSummary,
        logs: [
          { title: '覆盖安装日志 update-log.txt', text: await readLog('update-log.txt') },
          { title: '自愈日志 self-heal.log', text: await readLog('self-heal.log', 6000) },
          { title: '崩溃日志 crash.log（尾部）', text: crashLog },
          { title: '启动/运行日志 launch.log（尾部 6000 字）', text: launchLog },
          ...(stageDebug
            ? [{ title: `最近一次解压诊断 stage-debug.json：${stageDebug.path}`, text: stageDebug.text }]
            : []),
        ],
      });
      await fsp.mkdir(path.dirname(target), { recursive: true }).catch(() => {});
      await fsp.writeFile(target, text, 'utf8');
      diagnostics.recordEvent('info', 'diag', `诊断已导出：${path.basename(target)}`);
      return { ok: true, path: target, requests: diagnostics.requestCount() };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  });

  ipcMain.handle('start:refresh-art', async (_event, gameId) => {
    const game = store?.data?.games?.find((item) => item.id === gameId);
    if (!game) return { ok: false, reason: '没有找到这个游戏' };
    if (!game.builtinKey) return { ok: false, reason: '这个游戏不是内置游戏，没有官方动态背景' };
    // 手动触发时把自动重试计数清零，否则接口抖动留下的 3 次上限会一直卡着
    bh3OfficialRetry = 0;
    try {
      await ensureAnimatedStartBackgrounds({ only: game.builtinKey });
    } catch (error) {
      return { ok: false, reason: error.message || '获取失败' };
    }
    const video = String(game.backgroundVideo || '');
    if (video) return { ok: true, video };
    return { ok: false, reason: `${game.name} 的官方接口这次没有返回动态背景` };
  });

  ipcMain.handle('start:export-video', async (_event, gameId) => {
    const game = store.data.games.find((item) => item.id === gameId);
    if (!game) throw new Error('没有找到这个游戏');
    const relative = String(game.backgroundVideo || '');
    if (!relative) throw new Error('这个游戏还没有动态背景');

    // 只有本地缓存能导出；远程 URL 先下载到临时文件再让用户另存
    let sourcePath = '';
    if (/^https?:/i.test(relative)) {
      const cachePath = path.join(app.getPath('userData'), 'backgrounds', `${game.builtinKey}.mp4`);
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      const response = await fetch(relative, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`下载动图失败：HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fsp.writeFile(cachePath, buffer);
      sourcePath = cachePath;
    } else if (/^file:/i.test(relative)) {
      sourcePath = decodeURIComponent(relative.replace(/^file:\/\/\/?/i, ''));
    } else {
      sourcePath = path.join(app.getPath('userData'), relative);
    }
    if (!fs.existsSync(sourcePath)) throw new Error('动态背景文件不存在，可能已被清理');

    const defaultName = `${safeFileName(game.name)}-启动页动图.mp4`;
    const result = await dialog.showSaveDialog(win, {
      title: '保存动态背景',
      defaultPath: path.join(
        portableDownloads || app.getPath('downloads'),
        defaultName
      ),
      filters: [{ name: '视频', extensions: ['mp4', 'webm'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    await fsp.copyFile(sourcePath, result.filePath);
    const stat = await fsp.stat(result.filePath);
    return { ok: true, path: result.filePath, bytes: stat.size };
  });

  ipcMain.handle('app:create-desktop-shortcut', async () => {
    if (process.platform !== 'win32') {
      throw new Error('当前系统不支持创建 Windows 桌面快捷方式');
    }
    const desktop = app.getPath('desktop');
    await fsp.mkdir(desktop, { recursive: true });
    const shortcutPath = path.join(desktop, '花筱灵启动器.lnk');
    const portableTarget = process.env.PORTABLE_EXECUTABLE_FILE;
    const target =
      portableTarget && fs.existsSync(portableTarget) ? portableTarget : process.execPath;
    const existed = fs.existsSync(shortcutPath);
    const options = {
      target,
      cwd: app.isPackaged ? path.dirname(target) : app.getAppPath(),
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      description: '花筱灵启动器',
      icon: target,
      iconIndex: 0,
      appUserModelId: 'com.huaxiaoling.launcher',
    };
    const ok = shell.writeShortcutLink(shortcutPath, existed ? 'replace' : 'create', options);
    if (!ok) throw new Error('系统未能创建桌面快捷方式');
    return { ok: true, path: shortcutPath, existed };
  });

  ipcMain.handle('app:relaunch-admin', async (_event, input) => {
    if (!app.isPackaged) return { ok: false, error: '开发模式下请直接用管理员终端运行' };
    /*
     * 带上「重启后要开哪个游戏」：界面上点的是「以管理员重启」，用户的本意是
     * 「把游戏打开」「别再问权限」，重启完必须接着开，不能让他再点一次。
     */
    const gameId = String(input?.launchGameId || '');
    if (gameId) {
      store.data.settings.pendingLaunchGameId = gameId;
      await store.saveNow().catch(() => {});
    }
    /*
     * 「更新到一半被权限挡住 → 以管理员重启 → 接着更新」这条链。
     * 和开游戏那条分开存：游戏目录权限不够和开游戏提权不是一回事，
     * 用户可能只是想更新，不想一开机就把游戏拉起来。
     */
    const updateGameId = String(input?.updateGameId || '');
    if (updateGameId) {
      store.data.settings.pendingUpdateGameId = updateGameId;
      store.data.settings.pendingUpdateServerId = String(input?.updateServerId || '');
      await store.saveNow().catch(() => {});
    }
    if (currentElevation()) return { ok: true, already: true };
    /*
     * 必须走 relaunchElevated()：它确认提权脚本进程真的起来了才退当前实例。
     * 以前这里直接 spawn + app.quit()——powershell 被安全软件拦掉时脚本没跑、
     * 老实例已经退了，用户看到的就是「点了重启，启动器消失，权限还是普通」，
     * 也就是「管理员权限功能根本无效」。
     */
    if (await relaunchElevated()) return { ok: true };
    return {
      ok: false,
      error: '无法调度提权重启（PowerShell 可能被安全软件拦截）。请右键启动器选「以管理员身份运行」',
    };
  });

  ipcMain.handle('app:quit', () => {
    quitting = true;
    app.quit();
  });

  ipcMain.handle('news:list', async () => {
    try {
      const file = path.join(ROOT, 'src', 'data', 'news.json');
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      return [];
    }
  });

  /* ── 抽卡记录云备份：状态 / 保存 / 测试 / 列云端 / 恢复 ──────────────── */
  ipcMain.handle('gacha:backup-status', () => gachaBackupSnapshot());

  /*
   * 保存配置。
   *
   * 密码和加密口令走「空串 = 沿用已存的那份」：表单是密码框，回显不了明文，
   * 用户只是想改地址时不该被迫重填密码。要清掉就传 null。
   */
  ipcMain.handle('gacha:backup-save', async (_event, patch = {}) => {
    const settings = store.data.settings.gachaBackup;
    if (!settings) return { ok: false, error: '设置还没准备好' };
    const input = patch && typeof patch === 'object' ? patch : {};
    if ('enabled' in input) settings.enabled = input.enabled === true;
    if ('url' in input) settings.url = String(input.url || '').trim().slice(0, 500);
    if ('username' in input) settings.username = String(input.username || '').trim().slice(0, 200);
    if ('keep' in input) {
      settings.keep = Math.max(1, Math.min(10, Number(input.keep) || gachaBackup.DEFAULT_KEEP));
    }
    if ('password' in input) {
      const value = input.password === null ? '' : String(input.password || '').trim();
      if (input.password === null || value) await saveSecret(GACHA_BACKUP_PASSWORD_KEY, value);
    }
    if ('secret' in input) {
      const value = input.secret === null ? '' : String(input.secret || '');
      if (input.secret === null || value) await saveSecret(GACHA_BACKUP_SECRET_KEY, value);
    }
    await refreshGachaSecretFlags();
    await store.saveNow();
    // 用户刚改过地址或密码：失败退避清零，否则他要白等几小时才会重试
    gachaBackupFailStreak = 0;
    gachaBackupRetryAt = 0;
    // 开开关之后要重排定时器，否则要等到下一次启动才会开始算周期
    scheduleGachaBackup();
    pushState(true);
    return { ok: true, backup: gachaBackupSnapshot() };
  });

  ipcMain.handle('gacha:backup-test', async () => {
    try {
      const result = await gachaBackup.testConnection({ config: await gachaBackupCredentials() });
      // 刚验证通过：说明配置能用，把自动备份的失败退避清掉
      if (result && result.ok !== false) {
        gachaBackupFailStreak = 0;
        gachaBackupRetryAt = 0;
      }
      return result;
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('gacha:backup-list', async () => {
    try {
      return await gachaBackup.listBackups({ config: await gachaBackupCredentials() });
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('gacha:backup-restore', async (_event, input = {}) => {
    try {
      const result = await gachaBackup.restoreFrom({
        config: await gachaBackupCredentials(),
        userData: app.getPath('userData'),
        name: input && input.name ? String(input.name) : '',
      });
      const settings = store.data.settings.gachaBackup;
      settings.lastResult = result.text;
      settings.lastError = '';
      await store.saveNow();
      pushState(true);
      return result;
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  /** 手动「立即备份」：直接复用 runGachaBackup（内部有锁、成败记录、pushState）。 */
  ipcMain.handle('gacha:backup-now', async () => {
    try {
      return await runGachaBackup('手动');
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  /*
   * 启动器设置导出 / 导入。
   * 导出＝把 launcher-data.json 复制到用户挑的位置；导入＝读回文件后与默认合并
   * （只增不改：本地已有的键不会被远端文件的旧值冲掉，结构不符直接报错）。
   * 注意：sessions.enc.json（密码 / 加密口令等凭据）不在这份文件里，导出导入
   * 不会把别人的凭据带进来，也带不走你自己的凭据——这点和抽卡云备份一样。
   */
  ipcMain.handle('settings:export', async () => {
    try {
      const source = dataFile();
      if (!fs.existsSync(source)) throw new Error('还没生成设置文件，先改个设置再导出');
      const result = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : undefined, {
        title: '导出启动器设置',
        defaultPath: path.join(app.getPath('downloads') || app.getPath('userData'), '花筱灵设置.json'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      await fsp.copyFile(source, result.filePath);
      const stat = await fsp.stat(result.filePath);
      return { ok: true, path: result.filePath, bytes: stat.size };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('settings:import', async () => {
    try {
      const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
        title: '导入启动器设置',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePaths || !result.filePaths.length) {
        return { ok: false, cancelled: true };
      }
      const file = result.filePaths[0];
      const raw = await fsp.readFile(file, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, error: '文件不是合法的 JSON' };
      }
      if (!parsed || typeof parsed !== 'object') return { ok: false, error: '文件内容不是设置数据' };
      // 只认可顶层带 settings 的启动器数据文件，避免误导入别的东西把配置冲了
      if (!parsed.settings || typeof parsed.settings !== 'object') {
        return { ok: false, error: '这份文件不是启动器设置备份（缺少 settings 字段）' };
      }
      const merged = { ...store.data, settings: { ...store.data.settings, ...parsed.settings } };
      store.data = merged;
      await store.saveNow();
      pushState(true);
      return { ok: true, path: file };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('gacha:load', async (_event, force = false) => {
    // 用户不需要手动选库：路径为空或已失效时自动重新探测一次
    const configured = store.data.settings.starwardDbPath;
    if (!configured || !fs.existsSync(configured)) {
      const detected = detectStarwardDbPath();
      if (detected !== configured) {
        store.data.settings.starwardDbPath = detected;
        await store.saveNow();
      }
    }
    return loadGachaHistory(
      store.data.settings.starwardDbPath,
      path.join(app.getPath('userData'), 'gacha-meta-v2.json'),
      force === true,
      importsPath(app.getPath('userData'))
    );
  });

  ipcMain.handle('gacha:import', async (_event, input = {}) => {
    const result = await dialog.showOpenDialog(win, {
      title: '导入 UIGF 抽卡记录',
      properties: ['openFile'],
      filters: [{ name: 'UIGF / SRGF JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    const imported = await importUigf({
      filePath: result.filePaths[0],
      userData: app.getPath('userData'),
      game: input?.game,
    });
    return { ...imported, filePath: result.filePaths[0] };
  });

  // 异环：把导出目录开给用户，并把当前识别到的账号回给界面
  ipcMain.handle('gacha:nte-folder', async () => {
    const dir = nteGachaDir();
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('gacha:nte-refresh', async () => {
    const account = await refreshNteAccount().catch(() => null);
    const imported = await scanNteGachaDrops({ notify: true }).catch(() => 0);
    pushState(true);
    return { ok: true, account: account || store.data.nteAccount || null, imported };
  });

  ipcMain.handle('gacha:nte-capture-info', async () =>
    nteCapture.info(app.getPath('userData')),
  );

  ipcMain.handle('gacha:nte-capture-start', async (_event, input = {}) => {
    const result = await nteCapture.start({
      userData: app.getPath('userData'),
      jsonDir: nteGachaDir(),
      autoPage: input?.autoPage !== false,
      onProgress: (message) => send('nte-capture', { phase: 'progress', message }),
      onDone: async (payload) => {
        const imported = await scanNteGachaDrops({ notify: false }).catch(() => 0);
        await refreshNteAccount().catch(() => null);
        pushState(true);
        send('nte-capture', {
          phase: 'done',
          imported,
          captured: payload?.count || 0,
          jsonPath: payload?.jsonPath || '',
        });
        send('toast', {
          type: imported > 0 ? 'success' : 'info',
          message:
            imported > 0
              ? `已自动导入异环抽卡记录 ${imported} 条`
              : '抓取完成，但没有发现新的抽卡记录',
        });
      },
      onError: (error) => {
        send('nte-capture', { phase: 'error', message: error.message || '抓取失败' });
        send('toast', { type: 'error', message: error.message || '异环抓取失败' });
      },
    });
    send('nte-capture', { phase: 'capturing', jsonPath: result.jsonPath, autoPage: input?.autoPage !== false });
    return { ok: true, ...result };
  });

  ipcMain.handle('gacha:nte-capture-stop', async () => {
    const result = await nteCapture.stop();
    send('nte-capture', { phase: 'stopped', message: result.message || '' });
    return result;
  });

  ipcMain.handle('gacha:refresh-meta', async () => {
    // 强制刷新终末地 / 异环的图鉴缓存，拉到新版本角色和武器
    const metaPath = path.join(app.getPath('userData'), 'gacha-meta-ext.json');
    const meta = await loadGachaMeta(metaPath, true);
    return {
      ok: true,
      updatedAt: meta.updatedAt ? new Date(meta.updatedAt).toISOString() : null,
      endfield: Object.keys(meta.endfield?.bySlug || {}).length,
      neverness: Object.keys(meta.neverness?.items || {}).length,
      errors: meta.errors || [],
    };
  });

  ipcMain.handle('gacha:pick-db', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择抽卡记录数据库',
      properties: ['openFile'],
      filters: [{ name: '抽卡记录数据库', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    if (result.canceled) return null;
    const dbPath = result.filePaths[0];
    store.data.settings.starwardDbPath = dbPath;
    await store.saveNow();
    pushState(true);
    return dbPath;
  });

  ipcMain.handle('downloads:add', async (_event, input) => {
    const dir = await ensureDownloadsDir();
    const rawUrl = String(input && input.url ? input.url : '').trim();
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('请输入有效的下载链接');
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http 或 https 链接');

    let fileName = String(input && input.fileName ? input.fileName : '').trim();
    if (!fileName) {
      try {
        fileName = decodeURIComponent(path.basename(parsed.pathname)) || 'download';
      } catch {
        fileName = 'download';
      }
    }
    fileName = safeFileName(fileName);
    const finalPath = uniquePath(dir, fileName);

    const item = downloads.add({
      url: parsed.href,
      fileName: path.basename(finalPath),
      filePath: finalPath,
      dir,
      total: 0,
      received: 0,
      status: 'queued',
      speed: 0,
      error: null,
      createdAt: Date.now(),
    });
    downloads.start(item.id);
    pushState(true);
    return item;
  });

  ipcMain.handle('downloads:pause', (_event, id) => downloads.pause(id));
  ipcMain.handle('downloads:resume', (_event, id) => downloads.resume(id));
  ipcMain.handle('downloads:cancel', async (_event, id) => downloads.cancel(id));
  ipcMain.handle('downloads:remove', async (_event, id) => downloads.remove(id));
  ipcMain.handle('downloads:open', async (_event, id) => downloads.open(id));
  ipcMain.handle('downloads:open-folder', async (_event, id) => downloads.openFolder(id));

  /* ---------------- 游戏能力注册表 ---------------- */
  /*
   * 渲染层通过这三个通道拿到「哪些游戏支持哪些功能」，
   * 从而不必在 app.js 里散落 if (game === 'genshin') 之类的判断。
   * 以后加游戏只改 electron/game-features.js，前端自动跟随。
   */
  ipcMain.handle('features:all', async () => gameFeatures.describeAll());
  ipcMain.handle('features:describe', async (_event, gameKey) => gameFeatures.describe(gameKey));
  ipcMain.handle('features:by-category', async () => gameFeatures.featuresByCategory());

  /* ---------------- 用户自定义插件 ---------------- */
  /*
   * 打开插件开发说明。
   *
   * 用户目录里那份是给「写插件的人」看的随包文档；它可能被用户删掉或者
   * 从没装过（比如只装了示例插件没要说明），所以找不到就退回打开插件目录，
   * 至少让用户看见 .hxl 文件长什么样，别弹一个「文件不存在」的死路。
   */
  ipcMain.handle('plugin:open-doc', async () => {
    const dir = pluginHost.pluginsDir(app.getPath('userData'));
    await fsp.mkdir(dir, { recursive: true });
    const doc = path.join(dir, 'README.md');
    const exists = await fsp
      .access(doc)
      .then(() => true)
      .catch(() => false);
    const target = exists ? doc : dir;
    const reason = await shell.openPath(target);
    return { ok: !reason, path: target, error: reason || '' };
  });

  /*
   * 插件文件都放在 userData/plugins 下，配置在 userData/plugins.json。
   * 这里只做文件层面的收发，真正执行在渲染层的 Worker 里（src/plugin-runtime.js）。
   * 一律返回 { ok, ... } 形状，不 throw —— 穿过 IPC 的异常会变成
   * "Error invoking remote method ..."，界面上没法读。
   */
  const pluginRoot = () => app.getPath('userData');

  ipcMain.handle('plugin:list', async () => {
    const { dir, plugins } = await pluginHost.listPlugins(pluginRoot());
    return { ok: true, dir, plugins, permissions: pluginHost.PERMISSIONS };
  });

  ipcMain.handle('plugin:read', async (_event, id) => pluginHost.readPlugin(pluginRoot(), String(id || '')));

  ipcMain.handle('plugin:import', async () => {
    const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
      title: '选择插件文件',
      properties: ['openFile'],
      filters: [{ name: '花筱灵插件', extensions: ['hxl', 'js'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    return pluginHost.importPlugin(pluginRoot(), result.filePaths[0]);
  });

  ipcMain.handle('plugin:remove', async (_event, id) => pluginHost.removePlugin(pluginRoot(), String(id || '')));

  ipcMain.handle('plugin:storage-get', async (_event, id) => pluginHost.getStorage(pluginRoot(), String(id || '')));

  ipcMain.handle('plugin:storage-set', async (_event, input) => {
    const payload = input && typeof input === 'object' ? input : {};
    return pluginHost.setStorage(pluginRoot(), String(payload.id || ''), payload.value);
  });


  /* ---------------- 截图管理 ---------------- */
  ipcMain.handle('screenshots:list', async () => {
    const customRoots = store.data?.settings?.screenshotRoots || {};
    try {
      // 游玩区间 → 游戏 key，用于把混在一个目录里的截图分回各自游戏
      const playLog = store.data?.stats?.playLog || [];
      const idToKey = new Map();
      const knownKeys = new Set(gameFeatures.listGames().map((item) => item.key));
      for (const game of store.data?.games || []) {
        const key = gameFeatures.normalizeKey(game.featureKey || game.id) || '';
        // 自定义游戏 normalizeKey 会原样返回 id，那种 key 图鉴里没有意义，丢掉
        if (key && knownKeys.has(key)) idToKey.set(game.id, key);
      }
      const sessionWindows = screenshotLib.sessionWindowsFrom(playLog, (id) => idToKey.get(id) || '');
      // 截图管理要指向「每个游戏的截图目录」，而不是电脑自带的截图文件夹。
      // 游戏安装目录 = exe 所在目录，截图通常落在 <游戏目录>\ScreenShot 及常见变体。
      // 所以当用户没手动配置截图目录时，就从各游戏安装路径推导出它的截图目录，
      // 而不是退回 defaultRoots 里的 Pictures\Screenshots。
      const screenshotRoots = {};
      if (customRoots && Object.keys(customRoots).length) {
        screenshotRoots.custom = customRoots;
      } else {
        for (const game of store.data?.games || []) {
          const key = idToKey.get(game.id);
          const dirs = new Set();
          for (const server of game.servers || []) {
            if (!server.path || !targetExists(server.path)) continue;
            const gameDir = path.dirname(server.path);
            const shotNames = ['ScreenShot', 'Screenshot', '截图', 'screenshot', 'Screenshots', 'ScreenShots'];
            for (const name of shotNames) dirs.add(path.join(gameDir, name));
            dirs.add(path.join(gameDir, 'Photos'));
          }
          if (key && dirs.size) screenshotRoots[key] = [...dirs];
        }
      }
      const result = await screenshotLib.listScreenshots({
        customRoots: screenshotRoots.custom || screenshotRoots,
        sessionWindows,
      });
      // 刷新缩略图白名单：只有本次扫描出来的路径能被 hxl-shot 协议读到
      screenshotAllow.clear();
      for (const list of Object.values(result.groups || {})) {
        for (const item of list) screenshotAllow.add(path.normalize(item.path.toLowerCase()));
      }
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, reason: String(error.message || '扫描失败') };
    }
  });

  ipcMain.handle('screenshots:check-dir', async (_event, dir) => screenshotLib.checkDir(String(dir || '')));

  /*
   * 缩略图本体通过 IPC 取回 data URL，而不是自定义协议：
   * 页面跑在 file:// 下，file:// → hxl-shot:// 属于跨源，会被 CORS 直接拦掉。
   * 只允许「本次扫描过的路径」，单张超过 8MB 不内联，避免内存暴涨。
   */
  ipcMain.handle('screenshots:thumb', async (_event, filePath) => {
    const target = String(filePath || '');
    if (!target) return { ok: false, reason: '缺少路径' };
    if (!screenshotAllow.has(path.normalize(target.toLowerCase()))) {
      return { ok: false, reason: '这个文件不在扫描结果里' };
    }
    try {
      const stat = await fsp.stat(target);
      if (stat.size > 8 * 1024 * 1024) return { ok: false, reason: '图片太大，请用系统看图工具打开' };
      const buffer = await fsp.readFile(target);
      const ext = path.extname(target).toLowerCase().replace('.', '');
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' }[ext];
      if (!mime) return { ok: false, reason: '不支持的图片格式' };
      return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
    } catch (error) {
      return { ok: false, reason: String(error.message || '读取失败') };
    }
  });


  ipcMain.handle('screenshots:open', async (_event, filePath) => {
    const target = String(filePath || '');
    if (!target) return { ok: false };
    try {
      await shell.openPath(target);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error.message || '') };
    }
  });

  ipcMain.handle('screenshots:reveal', async (_event, filePath) => {
    const target = String(filePath || '');
    if (!target) return { ok: false };
    shell.showItemInFolder(target);
    return { ok: true };
  });

  /* ---------------- 窗口材质 ---------------- */

  ipcMain.handle('window:material', async (_event, input) => {
    const material = String(input?.material || 'none');
    const result = windowMaterial.applyMaterial(win, material);
    return {
      ...result,
      material,
      transparency: windowMaterial.transparencyEnabled(),
      supported: windowMaterial.MATERIALS,
    };
  });

  ipcMain.handle('window:material-state', async () => ({
    ok: true,
    material: store.data.settings?.material || 'none',
    transparency: windowMaterial.transparencyEnabled(),
    supported: windowMaterial.MATERIALS,
  }));

  /* ---------------- 安装与更新 ---------------- */

  /**
   * 汇总每个内置游戏的安装状态。
   *
   * 分三类：
   *   hyp  米哈游 — 版本读 exe 的 FileVersion，更新交给官方启动器
   *   pack 鹰角   — 本地版本读 .vela-game-state.json，远端版本查 launcher API
   * 远端查询是网络操作，所以单独放进 games:update-check，列表接口只给本地信息。
   */
  ipcMain.handle('install:list', async () => {
    const rows = [];
    for (const game of store.data.games || []) {
      const key = game.builtinKey || game.featureKey || '';
      const normalized = gameFeatures.normalizeKey(key);
      const trait = normalized ? gameFeatures.traitOf(normalized, 'install-manager') : null;
      const servers = Array.isArray(game.servers) ? game.servers : [];
      const active = servers.find((s) => s.id === game.activeServerId) || servers[0] || null;

      // 找一个真实存在的安装目录
      let installed = null;
      for (const server of servers) {
        const entryName =
          normalized === 'arknights' ? 'Arknights.exe' : normalized === 'endfield' ? 'Endfield.exe' : '';
        if (!server.root || !entryName) continue;
        // 明日方舟（2.4.0 合并）：官服 / B服 共用同一目录，
        // 按渠道 SDK 文件校正真实渠道（只读，不落盘）
        if (normalized === 'arknights') {
          server.channel = channelFromArknightsRoot(server.root);
        }
        const probe = installManager.looksInstalled(server.root, entryName);
        if (probe && probe.hasEntry) {
          installed = { ...probe, serverName: server.name, serverId: server.id, channel: server.channel };
          break;
        }
      }

      const exePath = installed?.entry || active?.path || game.target || '';
      const fileVer = installed ? installManager.fileVersion(exePath) : '';

      rows.push({
        id: game.id,
        name: game.name,
        subtitle: game.subtitle || '',
        featureKey: normalized,
        kind: trait ? trait.kind : null,
        packId: trait && trait.id ? trait.id : null,
        installed: Boolean(installed),
        root: installed ? installed.root : active?.root || '',
        entry: exePath,
        totalBytes: installed ? installed.totalBytes : 0,
        fileCount: installed ? installed.fileCount : 0,
        fileVersion: fileVer,
        serverName: installed ? installed.serverName : active?.name || '',
        channel: installed ? installed.channel : active?.channel || '',
        servers: servers.map((s) => ({ id: s.id, name: s.name, channel: s.channel, root: s.root || '' })),
        activeServerId: game.activeServerId || '',
        running: running.has(game.id),
      });
    }
    return {
      ok: true,
      games: rows,
      miyousheLauncher: installManager.findMiyousheLauncher(),
    };
  });

  /** 查某个鹰角游戏的远端最新版，和本地版本对比。 */
  ipcMain.handle('install:check-remote', async (_event, input) => {
    const channel = String(input?.channel || '').trim();
    if (!channel) return { ok: false, reason: '缺少渠道' };
    try {
      const latest = await fetchLatestForChannel(channel);
      const root = String(input?.root || '').trim();
      let localVersion = '';
      if (root) {
        try {
          const stateFile = path.join(root, '.vela-game-state.json');
          const raw = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
          localVersion = String(raw?.version || '');
        } catch {
          /* 没有本地状态文件就当未知 */
        }
      }
      return {
        ok: true,
        localVersion,
        remoteVersion: latest.version,
        clientVersion: latest.clientVersion || '',
        totalSize: latest.totalSize || 0,
        base: latest.base || '',
        packCount: Array.isArray(latest.packs) ? latest.packs.length : 0,
        outdated: Boolean(localVersion && latest.version && localVersion !== latest.version),
      };
    } catch (error) {
      return { ok: false, reason: String(error.message || '查询失败') };
    }
  });

  /** 打开官方启动器 / 官网 / 安装目录。 */
  ipcMain.handle('install:open', async (_event, input) => {
    const what = String(input?.what || '');
    if (what === 'miyoushe') {
      const exe = installManager.findMiyousheLauncher();
      if (!exe) return { ok: false, reason: '没有找到米哈游启动器（HYP.exe），请先安装 HoYoPlay' };
      await shell.openPath(exe);
      return { ok: true };
    }
    if (what === 'folder') {
      const target = String(input?.path || '');
      if (!target || !fs.existsSync(target)) return { ok: false, reason: '目录不存在' };
      await shell.openPath(target);
      return { ok: true };
    }
    if (what === 'site') {
      const url = String(input?.url || '');
      if (!/^https:\/\//i.test(url)) return { ok: false, reason: '链接不合法' };
      await shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, reason: '未知操作' };
  });

  /* ---------------- 画质配置 ---------------- */

  /** 自动探测出来的注册表项，画质页只看不写（写入另走 resolveGraphicsKey） */
  const GRAPHICS_DETECT_FILE = 'graphics-detect.json';

  /**
   * 探测结论的固定表：gameKey → { key, at }。
   *
   * 用户的原话是「有读取也固定读取那一个就可以」：自动探测一次要 1.2~3.3 秒
   * （把 HKCU\Software 下七十多个厂商目录逐个 reg query 再打分），没必要每次进画质页
   * 都重来一遍。这里把「哪款游戏对应哪个注册表项」记下来，落到
   * userData\graphics-detect.json，重启之后也直接用。
   *
   * 失效兜底见 graphicsFixedKeyOf：记下来的项读不到值就丢掉这条记录重新探测，
   * 所以卸载重装 / 换盘之后不会一直读一个已经不存在的位置。
   */
  const graphicsFixed = new Map();
  let graphicsFixedLoaded = false;

  function graphicsFixedFile() {
    return path.join(app.getPath('userData'), GRAPHICS_DETECT_FILE);
  }

  async function loadGraphicsFixed() {
    if (graphicsFixedLoaded) return;
    graphicsFixedLoaded = true;
    try {
      const raw = JSON.parse(await fsp.readFile(graphicsFixedFile(), 'utf8'));
      for (const [key, value] of Object.entries(raw || {})) {
        const item = typeof value === 'string' ? { key: value } : value;
        const registryKey = String(item?.key || '').trim();
        if (!key || !registryKey) continue;
        graphicsFixed.set(key, { key: registryKey, at: Number(item?.at) || 0 });
      }
    } catch (error) {
      // 文件不存在 / 内容坏了都只是「还没记住过」，不影响任何功能
      if (error.code !== 'ENOENT') console.warn('读取画质探测记录失败：', error.message);
    }
  }

  function saveGraphicsFixed() {
    const payload = {};
    for (const [key, value] of graphicsFixed) payload[key] = { key: value.key, at: value.at };
    const file = graphicsFixedFile();
    const tmp = `${file}.tmp`;
    fsp
      .writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
      .then(() => fsp.rename(tmp, file))
      .catch((error) => console.warn('保存画质探测记录失败：', error.message));
  }

  /**
   * 记住「这款游戏就是这一项」。成功后立刻落盘 —— 记录本身很小，
   * 而且要保证「提前关掉启动器」也不丢这次探测的结论。
   */
  function rememberGraphicsKey(gameKey, registryKey) {
    if (!gameKey || !registryKey) return;
    const previous = graphicsFixed.get(gameKey);
    if (previous && previous.key === registryKey) return;
    graphicsFixed.set(gameKey, { key: registryKey, at: Date.now() });
    saveGraphicsFixed();
  }

  function forgetGraphicsKey(gameKey, game) {
    if (gameKey && graphicsFixed.delete(gameKey)) saveGraphicsFixed();
    // 顺手把内存里的探测缓存也丢掉，免得下次又拿回同一条已经失效的结论
    graphicsDetect.invalidate(game);
  }

  /**
   * 记下来的注册表项还能不能用？能用就直接返回，不再扫注册表。
   *
   * 两道校验，任何一道不过都算失效（丢掉记录，回到一次完整探测）：
   *   1. 这一项确实还在（父目录的子项列表里有它）—— 卸载 / 换盘重装会过不了这一关；
   *   2. 按「哪些值名算画质」筛一遍，还能列出画质值的名 —— 项还在但内容被清空也过不了。
   * 真正读值的兜底在 graphics:read 里：读到空结果同样作废这条记录。
   */
  async function graphicsFixedKeyUsable(registryKey) {
    if (!registryKey) return false;
    try {
      if (await graphicsDetect.stillExists(registryKey) === false) return false;
      const names = await graphicsConfig.listValueNamesFast(
        registryKey,
        path.join(app.getPath('userData'), 'hxl-reg-check.reg')
      );
      if (!names || !names.length) return false;
      return names.some((name) => graphicsSchema.isGraphicsEntry(name) && !graphicsSchema.isMetaEntry(name));
    } catch {
      return false;
    }
  }

  /**
   * 把渲染层传来的参数整理成 { gameKey, game }。
   *
   * 两种入参都要认：
   *   老：'starrail'                              —— 只有内置 key
   *   新：{ gameKey, name, path, exe, id, builtinKey } —— 带游戏对象，能拿去自动探测注册表项
   *
   * `path` 优先取可执行文件全路径；渲染层给的是启动器里的 `target`（游戏 exe 或目录），
   * 探测模块自己也认目录（它会往下找 exe），这里不强行解析。
   *
   * force=true 表示用户点了「重新读取」：不吃任何缓存，注册表项也重新探测一遍。
   */
  function graphicsInput(input) {
    const source = input && typeof input === 'object' ? input : { gameKey: input };
    const gameKey = gameFeatures.normalizeKey(source.gameKey || source.builtinKey || '');
    const game = {
      key: gameKey,
      name: String(source.name || '').trim() || (gameFeatures.gameOf(gameKey) || {}).name || gameKey,
      path: String(source.path || source.exePath || '').trim(),
      exe: String(source.exe || '').trim(),
    };
    return { gameKey, game, force: Boolean(source.force) };
  }

  /**
   * 解析一个游戏该读写哪个注册表项。
   *
   * 优先用 features 里写死的 trait（四个米哈游游戏走这条，行为与改造前完全一致）；
   * trait 里没有注册表项时，交给 graphics-detect 按游戏名 + 安装路径自动探测，
   * 探测到的结论会固定下来（见 graphicsFixed），下次进来直接命中。
   *
   * 返回 { ok:true, registryKey, source:'trait'|'fixed'|'auto', detect } 或 { ok:false, reason, detect }。
   * 写入路径同样只用这里的结果 —— 探测不到就拒绝写，绝不猜一个项去改。
   */
  async function resolveGraphicsKey(gameKey, game, options = {}) {
    const trait = gameFeatures.traitOf(gameKey, 'graphics');
    if (trait && trait.kind === 'registry' && trait.key) {
      return { ok: true, registryKey: trait.key, source: 'trait', detect: null };
    }
    if (!gameKey) return { ok: false, reason: '缺少游戏 key', detect: null };
    await loadGraphicsFixed();
    // 1) 记住过的项：校验还成立就直接用，一次注册表扫描都不做
    if (!options.force) {
      const fixed = graphicsFixed.get(gameKey);
      if (fixed && await graphicsFixedKeyUsable(gameKey, game, fixed.key)) {
        /*
         * 顺手喂进 graphics-detect 的探测缓存：同一个 gameKey 如果上次是另一条路径
         * （比如换了安装目录），缓存键会不同，这里把这次的结论对齐，省掉一轮扫描。
         */
        const detect = { ok: true, key: fixed.key, fixed: true };
        graphicsDetect.remember(game, detect);
        return { ok: true, registryKey: fixed.key, source: 'fixed', detect };
      }
      if (fixed) {
        // 失效兜底：游戏卸了 / 换盘重装了，丢掉这条记录重新探测一次
        forgetGraphicsKey(gameKey, game);
      }
    }
    let detect = null;
    try {
      // probe 会把同款游戏的并发请求合成一次，用户连点标签也不会连扫两遍注册表
      detect = options.force
        ? await graphicsDetect.detect(Object.assign({}, game, { _force: true }))
        : await graphicsDetect.probe(game);
    } catch (error) {
      detect = { ok: false, reason: String(error.message || '自动检测失败') };
    }
    if (!detect || !detect.ok) {
      const why = (detect && detect.reason) || '没有找到这个游戏的画质配置';
      return { ok: false, reason: `自动检测失败：${why}`, detect };
    }
    rememberGraphicsKey(gameKey, detect.key);
    return { ok: true, registryKey: detect.key, source: 'auto', detect };
  }

  /**
   * 开机预读画质缓存：gameKey → { at, result }。
   *
   * 用户的原话是「打开软件的时间直接去读取」。启动器一开起来就在后台把
   * 已登记游戏（game-features 里带 registry trait 的）和固定表里记过的游戏
   * 全读一遍，点进画质页时 graphics:read 命中这份缓存，一次注册表也不碰。
   *
   * 单次读取在 50–100ms（一次 reg export 拿全量与全值），几个游戏加起来
   * 也就几百毫秒，放在窗口创建之后的空闲时间里做，不影响启动观感。
   * 缓存在主进程，不在渲染层 —— 所以切页面、重开窗口都还在，只有重启才失效。
   */
  const graphicsPrimeCache = new Map();
  const GRAPHICS_PRIME_TTL = 5 * 60 * 1000;

  async function primeGraphicsOnce(gameKey, game) {
    const hit = graphicsPrimeCache.get(gameKey);
    if (hit && Date.now() - hit.at < GRAPHICS_PRIME_TTL) return hit.result;
    const resolved = await resolveGraphicsKey(gameKey, game);
    if (!resolved.ok) return null;
    const result = await graphicsConfig.readGraphics(
      resolved.registryKey,
      (name) => graphicsSchema.isGraphicsEntry(name) && !graphicsSchema.isMetaEntry(name)
    );
    if (!result.ok || !Array.isArray(result.entries) || !result.entries.length) {
      if (resolved.source === 'fixed') forgetGraphicsKey(gameKey, game);
      return null;
    }
    const payload = {
      ...result,
      gameKey,
      source: resolved.source,
      detectKey: resolved.source === 'fixed' || resolved.source === 'auto' ? resolved.registryKey : '',
      fields: result.entries.map((entry) => graphicsSchema.describeEntry(entry)),
    };
    graphicsPrimeCache.set(gameKey, { at: Date.now(), result: payload });
    return payload;
  }

  let graphicsPrimeTask = null;
  let graphicsPrimeTimer = null;

  /**
   * 预读全部已知游戏。串行执行，一次只开一个 reg 进程，
   * 不会和用户正在点的画质页抢 CPU / 句柄。
   */
  function primeGraphicsCache(options = {}) {
    if (process.platform !== 'win32') return;
    const delay = Number(options.delay);
    if (graphicsPrimeTimer) clearTimeout(graphicsPrimeTimer);
    graphicsPrimeTimer = setTimeout(async () => {
      graphicsPrimeTimer = null;
      if (graphicsPrimeTask) await graphicsPrimeTask.catch(() => {});
      graphicsPrimeTask = (async () => {
        await loadGraphicsFixed();
        // trait 里写死了注册表位置的游戏
        const keys = [];
        for (const feature of gameFeatures.describeAll().games || []) {
          const trait = gameFeatures.traitOf(feature.key, 'graphics');
          if (trait && trait.kind === 'registry' && trait.key) keys.push({ gameKey: feature.key, game: null });
        }
        // 固定表里记过、靠自动探测定位的游戏（终末地这类第三方游戏）
        for (const gameKey of graphicsFixed.keys()) {
          if (keys.some((item) => item.gameKey === gameKey)) continue;
          keys.push({ gameKey, game: null });
        }
        for (const item of keys) {
          try {
            await primeGraphicsOnce(item.gameKey, item.game);
          } catch {
            // 预读失败无所谓：用户点进去时会走正常的读取路径
          }
        }
      })();
      try {
        await graphicsPrimeTask;
        if (options.notify !== false) send('graphics:primed', { count: graphicsPrimeCache.size });
      } catch {
        /* ignore */
      }
    }, Number.isFinite(delay) ? delay : 1200);
  }

  ipcMain.handle('graphics:read', async (_event, input) => {
    const { gameKey, game, force } = graphicsInput(input);
    // 开机预读过的直接给，用户点进画质页就是瞬开（「重新读取」走 force，不吃缓存）
    if (!force) {
      const primed = graphicsPrimeCache.get(gameKey);
      if (primed && Date.now() - primed.at < GRAPHICS_PRIME_TTL) {
        return { ...primed.result, primed: true, primedAge: Date.now() - primed.at };
      }
    }
    const resolved = await resolveGraphicsKey(gameKey, game, { force });
    if (!resolved.ok) {
      // 探测失败不算异常：前端会把 reason 显示在该游戏的空态里，整页不报错
      return { ok: false, reason: resolved.reason, gameKey, source: 'none', detectKey: '' };
    }
    try {
      // 只读画质相关的键：原神项里有 345KB 的 device 数据，全量读要十几秒
      const result = await graphicsConfig.readGraphics(
        resolved.registryKey,
        (name) => graphicsSchema.isGraphicsEntry(name) && !graphicsSchema.isMetaEntry(name)
      );
      if (!result.ok) {
        /*
         * 读不出来就作废这条固定记录：下一次进来重新探测一次。
         * 这里只丢记录、不在同一次请求里重试 —— 用户正在等结果，
         * 再扫一遍注册表又要几秒，不如把空态先如实显示出来。
         */
        if (resolved.source === 'fixed') forgetGraphicsKey(gameKey, game);
        return {
          ...result,
          gameKey,
          source: resolved.source,
          detectKey: resolved.source === 'fixed' || resolved.source === 'auto' ? resolved.registryKey : '',
        };
      }
      if (!Array.isArray(result.entries) || !result.entries.length) {
        if (resolved.source === 'fixed') forgetGraphicsKey(gameKey, game);
      }
      const payload = {
        ...result,
        gameKey,
        // source 说明这个注册表项是从哪来的：trait 是代码里写死的，auto 是刚探测的，
        // fixed 是以前探测过、记下来直接复用的
        source: resolved.source,
        detectKey: resolved.source === 'fixed' || resolved.source === 'auto' ? resolved.registryKey : '',
        fields: result.entries.map((entry) => graphicsSchema.describeEntry(entry)),
      };
      // 回填预读缓存：同一个游戏下一次进来（包括用户按了「重新读取」之后）就是瞬开
      if (result.entries.length) graphicsPrimeCache.set(gameKey, { at: Date.now(), result: payload });
      return payload;
    } catch (error) {
      if (resolved.source === 'fixed') forgetGraphicsKey(gameKey, game);
      return { ok: false, reason: String(error.message || '读取失败'), gameKey, source: resolved.source, detectKey: '' };
    }
  });

  ipcMain.handle('graphics:write', async (_event, input) => {
    const { gameKey, game } = graphicsInput(input);
    // 写入必须落在「确认过」的注册表项上：trait 里写死的，或固定表 / 探测明确给出的。
    // 探测失败就直接拒绝，不退回任何默认项。
    const resolved = await resolveGraphicsKey(gameKey, game);
    if (!resolved.ok) {
      return { ok: false, reason: `拒绝写入：${resolved.reason}` };
    }
    const registryKey = resolved.registryKey;
    const name = String(input?.name || '');
    // JSON 值里的单个字段：entry 是注册表值名，field 是 JSON 里的字段名。
    // 只改字段时 name 传的是字段名（它当然不在注册表里），所以校验要看 entry。
    const entry = String(input?.entry || '');
    const field = String(input?.field || '');
    if (!name && !entry) return { ok: false, reason: '缺少值名' };
    // 只允许写回注册表里已经存在的值，避免往游戏配置里塞垃圾键
    const tempPath = path.join(app.getPath('userData'), 'hxl-reg-check.reg');
    const existing = await graphicsConfig.listValueNamesFast(registryKey, tempPath);
    const target = entry || name;
    if (!existing.includes(target)) {
      return { ok: false, reason: `注册表里没有 ${target}，拒绝新增` };
    }
    const backupPath = path.join(app.getPath('userData'), 'registry-backup.json');
    try {
      /*
       * 两种写法：
       *   { entry, field } —— 改 JSON 值里的一个字段，其余字段原样保留（崩3/星铁的 JSON 画质项）
       *   { name, value }  —— 整条值改写（单值项，以及老接口）
       *
       * 关键：`entry` 和 `field` 可能相等（单值项渲染时 field 就是字段名），
       * 这时如果还走 updateJsonField，一条 REG_DWORD 就会被当成 JSON 去解析，
       * 报「不是 JSON，没法单独改其中的字段」—— 界面上表现成「所有选项都不可用」。
       * 所以要先看这条值到底是不是 JSON 对象，再决定走哪条路。
       */
      const isJsonValue = entry && field && field !== entry && await graphicsConfig.looksLikeJsonObject(registryKey, target);
      if (isJsonValue) {
        return await graphicsConfig.updateJsonField(registryKey, entry, field, input?.value, backupPath, input?.type);
      }
      return await graphicsConfig.writeValue(registryKey, entry || name, input?.value, backupPath, input?.type);
    } catch (error) {
      return { ok: false, reason: String(error.message || '写入失败') };
    } finally {
      // 写过的游戏，预读缓存立刻作废：下次读要拿到注册表里的新值，不能喂旧的
      graphicsPrimeCache.delete(gameKey);
    }
  });

  // 把预热入口交出去：installIpc 里的这些函数是闭包，外面拿不到
  return { primeGraphicsCache };
}

function normalizeGame(input) {
  const source = input && typeof input === 'object' ? input : {};
  const name = String(source.name || '').trim();
  if (!name) throw new Error('请填写游戏名称');
  if (name.length > 80) throw new Error('游戏名称太长了');
  const tags = Array.isArray(source.tags)
    ? source.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 5)
    : String(source.tags || '')
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 5);
  return {
    name,
    subtitle: String(source.subtitle || '').trim().slice(0, 80),
    description: String(source.description || '').trim().slice(0, 600),
    version: String(source.version || '').trim().slice(0, 32),
    tags,
    target: String(source.target || '').trim(),
    args: String(source.args || '').trim().slice(0, 1000),
    /*
     * 渲染后端：只接受 render-api.js 认可的三个值（default / dx11 / dx12），
     * 其余一律当「跟随游戏默认」。存档是老版本、或用户手改过 json 都不会炸。
     */
    renderApi: renderApi.normalizeMode(source.renderApi),
    workDir: String(source.workDir || '').trim(),
    cover: String(source.cover || '').trim(),
    accent: /^#[0-9a-f]{6}$/i.test(String(source.accent || '')) ? source.accent : '#f08ba6',
    favorite: Boolean(source.favorite),
  };
}

async function markLaunched(game) {
  game.lastPlayed = new Date().toISOString();
  game.launchCount = (game.launchCount || 0) + 1;
  store.data.stats.launches = (store.data.stats.launches || 0) + 1;
  await store.saveNow();
  pushState(true);
  if (game.demo) {
    send('toast', {
      type: 'info',
      message: '这是示例条目，编辑它并选择启动程序后即可真正启动。',
    });
  }
}

async function finishGame(id) {
  clearProcessMonitor(id);
  const info = running.get(id);
  running.delete(id);
  if (!info) return;
  const game = store.data.games.find((g) => g.id === id);
  if (game) {
    const seconds = Math.max(1, Math.round((Date.now() - info.startedAt) / 1000));
    game.playSeconds = (game.playSeconds || 0) + seconds;
    store.data.stats.playSeconds = (store.data.stats.playSeconds || 0) + seconds;
    /*
     * 记一段游玩区间，给「截图按游戏归档」用：
     * 用户截图目录常常是一锅乱炖（Windows 自带截图也存这里），
     * 只靠文件名猜不出属于哪个游戏，但截图时间一定落在某次游玩区间里。
     * 只保留最近 60 段，避免数据文件无限长。
     */
    const playLog = Array.isArray(store.data.stats.playLog) ? store.data.stats.playLog : [];
    playLog.push({
      gameId: id,
      start: info.startedAt,
      end: Date.now(),
      seconds,
    });
    store.data.stats.playLog = playLog.slice(-60);
    await store.saveNow();
    /*
     * 异环：游戏退出后官方启动器（NTEGame 登录窗 / NTELauncher 主界面）还会留在后台，
     * 用户希望一起退掉。只针对异环做，别误伤其他游戏可能共用的进程。
     */
    if (game.builtinKey === 'neverness') {
      for (const name of ['NTEGame.exe', 'NTELauncher.exe']) {
        try {
          await new Promise((resolve) => {
            execFile('taskkill', ['/IM', name, '/F', '/T'], { windowsHide: true, timeout: 8000 }, () => resolve());
          });
        } catch {
          /* 进程本来就不在或杀不掉都无所谓 */
        }
      }
      writeLaunchLog(`finish ${id}: NTE launcher processes cleaned`);
    }
  }
  pushState(true);
  send('game:exited', { id });
}

async function killGame(id) {
  clearProcessMonitor(id);
  await pruneStaleRunning();
  const info = running.get(id);
  if (!info) {
    pushState(true);
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(info.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      process.kill(-info.pid, 'SIGTERM');
    }
  } catch {
    /* ignore */
  }
  running.delete(id);
  pushState(true);
}

async function runLayoutProbe() {
  // [PROBE] 发布前删除：HX_PROBE=1 时打印关键元素的实际位置，代替肉眼看截图。
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      cy: Math.round(r.y + r.height / 2),
    };
  };
  const script = `(async () => {
    const rect = ${rect.toString()};
    const out = { viewport: { w: innerWidth, h: innerHeight } };
    window.__navigate && window.__navigate('home');
    const head = document.querySelector('.page-head');
    const actions = document.querySelector('.page-head-actions');
    out.home = {
      head: rect(head),
      actions: rect(actions),
      firstBtn: rect(actions && actions.querySelector('.btn')),
      view: rect(document.querySelector('.view')),
    };
    window.__navigate && window.__navigate('start');
    const top = document.querySelector('.start-screen .start-top');
    const brand = document.querySelector('.start-screen .start-brand');
    const mark = document.querySelector('.start-screen .start-brand-mark');
    const back = document.querySelector('.start-screen .chrome-back');
    const closeBtn = document.querySelector('.start-screen .chrome-close');
    out.start = {
      top: rect(top),
      brand: rect(brand),
      mark: rect(mark),
      back: rect(back),
      close: rect(closeBtn),
      topPadding: top ? getComputedStyle(top).padding : '',
    };
    window.__navigate && window.__navigate('home');
    document.body.classList.remove('sidebar-collapsed');
    const sidebar = document.querySelector('.sidebar');
    const brandRow = document.querySelector('.sidebar .brand');
    const brandMark = document.querySelector('.sidebar .brand-mark');
    const brandName = document.querySelector('.sidebar .brand-name');
    const navFirst = document.querySelector('.sidebar .nav-item');
    const navFirstIcon = navFirst && navFirst.querySelector('.icon');
    const navFirstSpan = navFirst && navFirst.querySelector('span');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    out.sidebar = {
      sidebar: rect(sidebar),
      brand: rect(brandRow),
      brandMark: rect(brandMark),
      brandName: rect(brandName),
      navFirst: rect(navFirst),
      navIcon: rect(navFirstIcon),
      navSpan: rect(navFirstSpan),
      brandPad: brandRow ? cs(brandRow).padding : '',
      brandGap: brandRow ? cs(brandRow).gap : '',
      navItemPad: navFirst ? cs(navFirst).padding : '',
      navGap: navFirst ? cs(navFirst).gap : '',
      sidebarPad: sidebar ? cs(sidebar).padding : '',
      markRadius: brandMark ? cs(brandMark).borderRadius : '',
    };
    window.__navigate && window.__navigate('start');
    const gamesHead = document.querySelector('.start-screen .start-games-head');
    const gamesStrong = gamesHead && gamesHead.querySelector('strong');
    out.dock = {
      head: rect(gamesHead),
      strong: rect(gamesStrong),
      headAlign: gamesHead ? cs(gamesHead).alignItems : '',
    };
    window.__navigate && window.__navigate('home');
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const duo = document.querySelector('.char-duo');
    const duoCards = [...document.querySelectorAll('.char-duo-card')];
    out.duo = {
      wrap: rect(duo),
      cardHeight: duoCards[0] ? cs(duoCards[0]).height : '',
      emMaxHeight: duoCards[0] ? cs(duoCards[0].querySelector('.char-duo-copy em')).maxHeight : '',
      statMaxHeight: duoCards[0] ? cs(duoCards[0].querySelector('.char-duo-stat')).maxHeight : '',
      cards: duoCards.map((card) => {
        const statB = card.querySelector('.char-duo-stat b');
        const statI = card.querySelector('.char-duo-stat i');
        const img = card.querySelector('img');
        return {
          cls: card.className,
          action: card.dataset.action || '',
          game: card.dataset.game || '',
          rect: rect(card),
          stat: statB ? statB.textContent.trim() : '',
          sub: statI ? statI.textContent.trim() : '',
          imgLoaded: Boolean(img && img.complete && img.naturalWidth),
          cursor: cs(card) ? cs(card).cursor : '',
        };
      }),
    };
    const sparxie = document.querySelector('.hero-sparxie');
    const sparxieImg = sparxie ? sparxie.querySelector('img') : null;
    out.hero = {
      rect: rect(document.querySelector('.hero')),
      sparxie: rect(sparxie),
      sparxieOpacity: sparxie ? cs(sparxie).opacity : '',
      sparxieLoaded: Boolean(sparxieImg && sparxieImg.complete && sparxieImg.naturalWidth),
      contentRect: rect(document.querySelector('.hero-content')),
    };
    const sideChar = document.querySelector('.sidebar-char');
    const sideCharImg = sideChar ? sideChar.querySelector('img') : null;
    out.sideChar = {
      rect: rect(sideChar),
      opacity: sideChar ? cs(sideChar).opacity : '',
      loaded: Boolean(sideCharImg && sideCharImg.complete && sideCharImg.naturalWidth),
      display: sideChar ? cs(sideChar).display : '',
      position: sideChar ? cs(sideChar).position : '',
      width: sideChar ? cs(sideChar).width : '',
      parent: sideChar && sideChar.parentElement ? sideChar.parentElement.className : '',
      parentDisplay: sideChar && sideChar.parentElement ? cs(sideChar.parentElement).display : '',
      parentPosition: sideChar && sideChar.parentElement ? cs(sideChar.parentElement).position : '',
      bodyClass: document.body.className,
    };
    const order = [...document.querySelectorAll('.page > *')].map((el) => el.className || el.tagName);
    out.homeOrder = order;
    // ── 启动页小按钮与品牌 ──
    window.__navigate && window.__navigate('start');
    await new Promise((resolve) => setTimeout(resolve, 600));
    // 只量「最后一个 .start-screen」：换游戏做动图过渡时会残留旧屏幕，
    // 全量 querySelectorAll 会把过渡中 translate 到屏幕外的旧按钮也算进来
    const liveScreen = [...document.querySelectorAll('.start-screen')].at(-1);
    const stTop = liveScreen && liveScreen.querySelector('.start-top');
    const stTools = liveScreen && liveScreen.querySelector('.start-video-tools');
    const stToggles = liveScreen ? [...liveScreen.querySelectorAll('.start-video-toggle')] : [];
    const stVideo = liveScreen && liveScreen.querySelector('video[data-start-video]');
    const stBrand = liveScreen && liveScreen.querySelector('.start-brand');
    const stMark = liveScreen && liveScreen.querySelector('.start-brand-mark');
    const stSpan = stBrand && stBrand.querySelector('span');
    const cs2 = (el) => (el ? getComputedStyle(el) : null);
    out.startTools = {
      top: rect(stTop),
      tools: rect(stTools),
      toolsDisplay: stTools ? cs2(stTools).display : '',
      toolsPosition: stTools ? cs2(stTools).position : '',
      toolsCount: stToggles.length,
      toggles: stToggles.map((b) => ({ action: b.dataset.action || '', rect: rect(b), w: cs2(b).width, h: cs2(b).height, disabled: b.disabled, pos: cs2(b).position, parentCls: b.parentElement ? b.parentElement.className : '' })),
      videoPresent: Boolean(stVideo),
      videoSrc: stVideo ? String(stVideo.src).slice(0, 80) : '',
      videoHidden: stVideo ? cs2(stVideo).display : '',
      liveScreenCount: document.querySelectorAll('.start-screen').length,
      toolsHtml: stTools ? String(stTools.outerHTML).slice(0, 300) : '',
      allTools: [...document.querySelectorAll('.start-video-tools')].map((t) => ({
        rect: rect(t),
        pos: cs2(t).position,
        transform: cs2(t).transform,
        children: t.children.length,
        childRects: [...t.children].map((c) => ({
          rect: rect(c),
          transform: cs2(c).transform,
          offsetParent: c.offsetParent ? (c.offsetParent.className || c.offsetParent.tagName) : '',
          inline: c.getAttribute('style') || '',
          offsetTop: c.offsetTop,
          offsetLeft: c.offsetLeft,
          margin: cs2(c).margin,
          top: cs2(c).top,
          left: cs2(c).left,
          position: cs2(c).position,
        })),
        parent: t.parentElement ? (t.parentElement.className || t.parentElement.tagName) : '',
      })),
    };
    out.startBrand2 = {
      brand: rect(stBrand),
      mark: rect(stMark),
      markSize: stMark ? cs2(stMark).width + 'x' + cs2(stMark).height : '',
      spanFont: stSpan ? cs2(stSpan).fontSize : '',
      spanRect: rect(stSpan),
    };
    // ── 启动页背景视频：为什么终末地/异环只剩静态图 ──
    // 视频元素是透明的（opacity:0），只有 .video-ready 才淡入；
    // 只要这个类没加上，用户看到的就是下面那张静态图。
    const videoArt = liveScreen && liveScreen.querySelector('.start-art:not(.start-art-prev)');
    const bgVideo = videoArt && videoArt.querySelector('video[data-start-video]');
    const bgImg = videoArt && videoArt.querySelector('img[data-cover]');
    out.startVideo = {
      artCls: videoArt ? videoArt.className : '',
      artKey: videoArt ? videoArt.dataset.artKey || '' : '',
      videoPresent: Boolean(bgVideo),
      videoSrc: bgVideo ? String(bgVideo.src || '').slice(0, 120) : '',
      videoReadyState: bgVideo ? bgVideo.readyState : -1,
      videoNetworkState: bgVideo ? bgVideo.networkState : -1,
      videoPaused: bgVideo ? bgVideo.paused : null,
      videoError: bgVideo && bgVideo.error ? bgVideo.error.code : 0,
      videoOpacity: bgVideo ? cs2(bgVideo).opacity : '',
      videoW: bgVideo ? cs2(bgVideo).width : '',
      videoH: bgVideo ? cs2(bgVideo).height : '',
      imgOpacity: bgImg ? cs2(bgImg).opacity : '',
      imgLoaded: Boolean(bgImg && bgImg.complete && bgImg.naturalWidth),
      imgSrc: bgImg ? String(bgImg.src || '').slice(0, 120) : '',
      liveScreenCount: document.querySelectorAll('.start-screen').length,
      artCount: document.querySelectorAll('.start-art').length,
    };
    // ── 换游戏场景：逐个点游戏缩略图，记录每次切换后的视频状态 ──
    // 现象是「换过游戏之后只剩静态图」，所以必须真的点一次切换。
    // 注意：每次点击都会触发 render()，整个 view 的 innerHTML 被换掉，
    // 之前拿到的缩略图节点会脱离文档 —— 必须在循环里重新查询，
    // 否则点的是已分离的节点，事件不会冒泡到 document，等于什么都没发生。
    out.switchScenario = [];
    const ids = [...document.querySelectorAll('.start-game-thumb')].map((b) => b.dataset.id || '');
    for (const gid of ids) {
      // 注意：这段脚本整体是一段模板字符串，里面不能再用反引号和模板占位符
      const thumb = document.querySelector('.start-game-thumb[data-id="' + gid + '"]');
      if (!thumb) {
        out.switchScenario.push({ id: gid, step: 'thumb-missing' });
        continue;
      }
      thumb.click();
      await new Promise((resolve) => setTimeout(resolve, 2400));
      const screen2 = [...document.querySelectorAll('.start-screen')].at(-1);
      const art2 = screen2 && screen2.querySelector('.start-art:not(.start-art-prev)');
      const v2 = art2 && art2.querySelector('video[data-start-video]');
      const i2 = art2 && art2.querySelector('img[data-cover]');
      out.switchScenario.push({
        id: gid,
        artCls: art2 ? art2.className : '',
        videoPresent: Boolean(v2),
        videoReadyState: v2 ? v2.readyState : -1,
        videoError: v2 && v2.error ? v2.error.code : 0,
        videoPaused: v2 ? v2.paused : null,
        videoOpacity: v2 ? cs2(v2).opacity : '',
        videoSrc: v2 ? String(v2.src || '').slice(-40) : '',
        imgOpacity: i2 ? cs2(i2).opacity : '',
        imgLoaded: Boolean(i2 && i2.complete && i2.naturalWidth),
        artCount: document.querySelectorAll('.start-art').length,
        liveScreenCount: document.querySelectorAll('.start-screen').length,
        prevArtCount: document.querySelectorAll('.start-art-prev').length,
      });
    }
    // ── 启动页 mini 播放器：位置与可点性 ──
    const mini = document.querySelector('#mini-player');
    const chipCopy = document.querySelector('#mini-player .mini-chip-copy');
    const chipCover = document.querySelector('#mini-player .mini-chip-cover');
    const atChip = chipCopy ? document.elementFromPoint(
      chipCopy.getBoundingClientRect().left + chipCopy.getBoundingClientRect().width / 2,
      chipCopy.getBoundingClientRect().top + chipCopy.getBoundingClientRect().height / 2
    ) : null;
    out.miniStart = {
      exists: Boolean(mini),
      hidden: mini ? mini.hidden : null,
      cls: mini ? mini.className : '',
      display: mini ? cs2(mini).display : '',
      zIndex: mini ? cs2(mini).zIndex : '',
      chipCopy: rect(chipCopy),
      chipCover: rect(chipCover),
      chipCopyAction: chipCopy ? chipCopy.dataset.action : '',
      chipCoverAction: chipCover ? chipCover.dataset.action : '',
      topAtChip: atChip ? atChip.tagName + '.' + atChip.className + '[' + (atChip.dataset.action || '') + ']' : '',
    };
    // ── 侧栏展开与收起几何 ──
    window.__navigate && window.__navigate('home');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const side = document.querySelector('.sidebar');
    const navs = [...document.querySelectorAll('.sidebar .nav-item')];
    const navsInfo = () => navs.map((n) => {
      const r = n.getBoundingClientRect();
      const icon = n.querySelector('.icon');
      return {
        cls: n.className,
        text: (n.textContent || '').trim().slice(0, 8),
        y: Math.round(r.y),
        h: Math.round(r.height),
        cy: Math.round(r.y + r.height / 2),
        iconCy: icon ? Math.round(icon.getBoundingClientRect().y + icon.getBoundingClientRect().height / 2) : -1,
        gap: cs2(n).gap,
        pad: cs2(n).padding,
      };
    });
    out.sideExpanded = {
      sidebar: rect(side),
      navCount: navs.length,
      navs: navsInfo(),
      navGap: navs[0] ? cs2(navs[0]).gap : '',
    };
    document.body.classList.add('sidebar-collapsed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    out.sideCollapsed = {
      sidebar: rect(side),
      navs: navsInfo(),
      navGap: navs[0] ? cs2(navs[0]).gap : '',
      bodyClass: document.body.className,
    };
    document.body.classList.remove('sidebar-collapsed');
    return out;
  })()`;
  try {
    const result = await win.webContents.executeJavaScript(script, true);
    console.log('PROBE ' + JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('probe failed:', error);
  }
  quitting = true;
  app.quit();
}

async function runCapture() {
  const shotsDir = path.join(ROOT, 'shots');
  await fsp.mkdir(shotsDir, { recursive: true });
  const pages = ['home', 'library', 'gacha', 'downloads', 'song', 'news', 'announcements', 'settings'];
  for (const page of pages) {
    try {
      const navResult = await win.webContents.executeJavaScript(
        `(() => { try { window.__navigate && window.__navigate('${page}'); return 'ok'; } catch (error) { return String(error && error.stack || error); } })()`
      );
      if (navResult !== 'ok') console.error(`navigate ${page}:`, navResult);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          page === 'gacha' ? 2200 : page === 'announcements' || page === 'song' ? 3200 : 650
        )
      );
      const image = await win.webContents.capturePage();
      await fsp.writeFile(path.join(shotsDir, `${page}.png`), image.toPNG());
      console.log(`captured ${page}`);
    } catch (error) {
      console.error(`capture ${page} failed:`, error);
    }
  }

  try {
    await win.webContents.executeJavaScript(`window.__navigate('home')`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await win.webContents.executeJavaScript(
      `document.querySelector('#home-stats')?.scrollIntoView({ block: 'start' })`
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    const statsImage = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shotsDir, 'home-stats.png'), statsImage.toPNG());
    console.log('captured home-stats');
  } catch (error) {
    console.error('capture home-stats failed:', error);
  }

  try {
    await win.webContents.executeJavaScript(`window.__navigate('servers')`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-action="add-server"]')?.click()`
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    const modal = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shotsDir, 'server-modal.png'), modal.toPNG());
    console.log('captured server-modal');
    await win.webContents.executeJavaScript(`document.querySelector('[data-close]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-action="link-servers"]')?.click()`
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    const linkModal = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shotsDir, 'link-modal.png'), linkModal.toPNG());
    console.log('captured link-modal');

    // 音效设置弹窗
    await win.webContents.executeJavaScript(`document.querySelector('[data-close]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-action="open-audio-fx"]')?.click()`
    );
    await new Promise((resolve) => setTimeout(resolve, 420));
    const fxModal = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shotsDir, 'audio-fx.png'), fxModal.toPNG());
    console.log('captured audio-fx');

    // 启动页（主界面胶囊 + 右下角操作区）
    for (const [id, name] of [
      ['builtin-genshin', 'start-genshin'],
      ['builtin-endfield', 'start-endfield'],
    ]) {
      const ok = await win.webContents.executeJavaScript(`
        (() => {
          if (typeof window.__startGame === 'function') {
            window.__startGame(${JSON.stringify(id)});
          } else {
            const g = (window.__state && window.__state().games || []).find(x => x.id === ${JSON.stringify(id)});
            if (!g) return 'missing';
            window.__navigate('start');
            document.querySelector('[data-action="start-select"][data-id="' + ${JSON.stringify(id)} + '"]')?.click();
          }
          return 'ok';
        })()
      `);
      if (ok !== 'ok') { console.error('start ' + id + ': ' + ok); continue; }
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const shot = await win.webContents.capturePage();
      await fsp.writeFile(path.join(shotsDir, name + '.png'), shot.toPNG());
      console.log('captured ' + name);
    }

    // 抽卡：终末地 / 异环 两个新数据源的概览
    await win.webContents.executeJavaScript(`window.__navigate('gacha')`);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    for (const key of ['endfield', 'neverness']) {
      const ok = await win.webContents.executeJavaScript(`
        (() => {
          const tab = document.querySelector('[data-action="gacha-game"][data-value="${key}"]');
          if (!tab) return 'missing';
          tab.click();
          return 'ok';
        })()
      `);
      if (ok !== 'ok') {
        console.error(`gacha ${key}: ${ok}`);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      const shot = await win.webContents.capturePage();
      await fsp.writeFile(path.join(shotsDir, `gacha-${key}.png`), shot.toPNG());
      console.log(`captured gacha-${key}`);
    }

    // 卡池统计 / 最近获得 两个子页（用终末地数据，垫数上限不同能看出差异）
    await win.webContents.executeJavaScript(`window.__navigate('gacha')`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-action="gacha-game"][data-value="endfield"]')?.click()`
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const [tab, name] of [
      ['banners', 'gacha-banners'],
      ['recent', 'gacha-recent'],
    ]) {
      const ok = await win.webContents.executeJavaScript(`
        (() => {
          const button = document.querySelector('[data-action="gacha-tab"][data-value="${tab}"]');
          if (!button) return 'missing';
          button.click();
          return 'ok';
        })()
      `);
      if (ok !== 'ok') {
        console.error(`gacha tab ${tab}: ${ok}`);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const shot = await win.webContents.capturePage();
      await fsp.writeFile(path.join(shotsDir, `${name}.png`), shot.toPNG());
      console.log(`captured ${name}`);
    }
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-action="gacha-tab"][data-value="overview"]')?.click()`
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    // 导入弹窗
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="import-gacha"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const importShot = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shotsDir, 'gacha-import.png'), importShot.toPNG());
    console.log('captured gacha-import');
    await win.webContents.executeJavaScript(`document.querySelector('[data-close]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 同步弹窗
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="sync-gacha"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const syncShot = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shotsDir, 'gacha-sync.png'), syncShot.toPNG());
    console.log('captured gacha-sync');
    await win.webContents.executeJavaScript(`document.querySelector('[data-close]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 迷你播放器：展开形态
    await win.webContents.executeJavaScript(`
      (() => {
        const mini = document.querySelector('#mini-player');
        if (!mini) return 'no mini';
        mini.hidden = false;
        mini.classList.remove('is-ball');
        return 'ok';
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const miniPanelShot = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shotsDir, 'mini-expanded-shot.png'), miniPanelShot.toPNG());
    console.log('captured mini-expanded');
    await win.webContents.executeJavaScript(`
      document.querySelector('#mini-player')?.classList.add('is-ball')
    `);

    // 抽卡：五款游戏逐个切换，确认都能正常渲染
    await win.webContents.executeJavaScript(`window.__navigate('gacha')`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const gachaResults = [];
    for (const key of ['genshin', 'starrail', 'zzz', 'endfield', 'neverness']) {
      const state = await win.webContents.executeJavaScript(`
        (() => {
          const tab = document.querySelector('[data-action="gacha-game"][data-value="' + ${JSON.stringify(key)} + '"]');
          if (!tab) return JSON.stringify({ key: ${JSON.stringify(key)}, present: false });
          tab.click();
          const content = document.querySelector('.gacha-content');
          const err = document.querySelector('.empty h3');
          return JSON.stringify({
            key: ${JSON.stringify(key)},
            present: true,
            hasContent: Boolean(content),
            htmlLength: content ? content.innerHTML.length : 0,
            kpi: document.querySelectorAll('.gacha-kpi').length,
            banners: document.querySelectorAll('.gacha-pity-row').length,
            error: err ? err.textContent : '',
          });
        })()
      `);
      gachaResults.push(state);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const shot = await win.webContents.capturePage();
      await fsp.writeFile(path.join(shotsDir, 'gacha-' + key + '.png'), shot.toPNG());
    }
    console.log('GACHA_SWEEP ' + gachaResults.join(' | '));

    // 点歌台榜单面板
    await win.webContents.executeJavaScript(`window.__navigate('song')`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await win.webContents.executeJavaScript(`
      (() => {
        const btn = document.querySelector('[data-action="chart-platform"][data-value="kugou"]');
        if (btn) btn.click();
        return 'ok';
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await win.webContents.executeJavaScript(`
      (() => {
        const first = document.querySelector('[data-action="chart-open"]');
        if (first) first.click();
        return 'ok';
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await win.webContents.executeJavaScript(`
      document.querySelector('.song-charts')?.scrollIntoView({ block: 'start' })
    `);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const chartShot = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shotsDir, 'chart-shot.png'), chartShot.toPNG());
    console.log('captured song-charts');


    // 动态页底部的官方公告区
    await win.webContents.executeJavaScript(`window.__navigate('news')`);
    await new Promise((resolve) => setTimeout(resolve, 3200));
    await win.webContents.executeJavaScript(`
      document.querySelector('.news-notices')?.scrollIntoView({ block: 'start' })
    `);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const noticeShot = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shotsDir, 'news-notices-shot.png'), noticeShot.toPNG());
    console.log('captured news-notices');

    // 迷你播放器外观（强制显示，仅用于截图）
    await win.webContents.executeJavaScript(`document.querySelector('[data-close]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await win.webContents.executeJavaScript(`
      (() => {
        const mini = document.querySelector('#mini-player');
        if (!mini) return 'no mini';
        mini.hidden = false;
        const title = document.querySelector('#mini-title');
        const artist = document.querySelector('#mini-artist');
        if (title) title.textContent = '夜航星';
        if (artist) artist.textContent = '不才';
        const range = document.querySelector('#mini-volume');
        if (range) range.value = '80';
        return 'ok';
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 420));
    const miniShot = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shotsDir, 'mini-player.png'), miniShot.toPNG());
    console.log('captured mini-player');

    if (process.env.HX_LINK_RUN === '1') {
      await win.webContents.executeJavaScript(`document.querySelector('#link-start')?.click()`);
      await new Promise((resolve) => setTimeout(resolve, 2600));
      const done = await win.webContents.capturePage();
      await fsp.writeFile(path.join(shotsDir, 'link-done.png'), done.toPNG());
      const text = await win.webContents.executeJavaScript(
        `JSON.stringify({ phase: document.querySelector('#link-phase')?.textContent, saved: document.querySelector('#link-saved')?.textContent, current: document.querySelector('#link-current')?.textContent })`
      );
      console.log('link ui:', text);
    }
  } catch (error) {
    console.error('capture modal failed:', error);
  }

  setTimeout(() => {
    quitting = true;
    app.quit();
  }, 400);
}

let endfieldGachaWatcher = null;
let endfieldGachaWatching = false;
function startEndfieldGachaWatcher() {
  if (endfieldGachaWatcher) return;
  const paths = [
    path.join(os.homedir(), 'AppData/LocalLow/Hypergryph/Endfield/sdklogs/HGWebview.log'),
    path.join(os.homedir(), 'AppData/LocalLow/Gryphline/Endfield/sdklogs/HGWebview.log'),
  ];
  const sizes = new Map();
  for (const file of paths) {
    try {
      sizes.set(file, fs.statSync(file).size);
    } catch {
      sizes.set(file, 0);
    }
  }
  const check = async () => {
    if (endfieldGachaWatching || store.data.settings.autoGacha === false) return;
    for (const file of paths) {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      const previous = sizes.get(file) || 0;
      if (size <= previous) continue;
      sizes.set(file, size);
      let text = '';
      try {
        const fd = fs.openSync(file, 'r');
        const length = Math.min(size, 128 * 1024);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, Math.max(0, size - length));
        fs.closeSync(fd);
        text = buffer.toString('utf8');
      } catch {
        continue;
      }
      const matches = [...text.matchAll(/https:\/\/ef-webview\.(hypergryph|gryphline)\.com\/page\/gacha_[^\s]+/g)];
      if (!matches.length) continue;
      let auth = null;
      for (const match of matches.reverse()) {
        try {
          const url = new URL(match[0]);
          const token = url.searchParams.get('u8_token');
          if (!token) continue;
          auth = {
            token,
            provider: match[1],
            serverId: url.searchParams.get('server') || url.searchParams.get('server_id') || '1',
          };
          break;
        } catch {
          /* next match */
        }
      }
      if (!auth) continue;
      endfieldGachaWatching = true;
      setTimeout(async () => {
        try {
          const result = await syncEndfieldGacha({ userData: app.getPath('userData'), auth });
          if (result.imported > 0) {
            send('gacha:updated', result);
            send('toast', {
              type: 'success',
              message: `终末地抽卡记录已自动同步 ${result.imported} 条`,
            });
          }
        } catch {
          /* opening the gacha page can happen before the token is valid */
        } finally {
          endfieldGachaWatching = false;
        }
      }, 1800);
      return;
    }
  };
  endfieldGachaWatcher = setInterval(check, 5000);
}

let mihoyoGachaWatching = false;
const mihoyoGachaSignatures = new Map();
function startMihoyoGachaWatcher() {
  const MIHOYO = ['genshin', 'starrail', 'zzz'];
  const attempt = async () => {
    if (mihoyoGachaWatching || store.data.settings.autoGacha === false) return;
    for (const game of store.data.games) {
      if (!MIHOYO.includes(game.builtinKey)) continue;
      if (!running.has(game.id)) continue;
      const server = (game.servers || []).find((item) => item.id === game.activeServerId);
      const root = server?.root || (game.target ? path.dirname(game.target) : '') || (server?.path ? path.dirname(server.path) : '');
      if (!root) continue;
      // 只看缓存目录里的文件名与 mtime（轻量 stat），不整读几十 MB 的 data_2。
      // 用户新开一次抽卡记录页，data_2 的 mtime 就会变，签名随之变化 → 触发一次同步。
      let signature;
      try {
        signature = gachaCacheFiles(root, game.builtinKey)
          .map((item) => `${item.file}:${item.mtimeMs}`)
          .join('|');
      } catch {
        continue;
      }
      if (signature === mihoyoGachaSignatures.get(game.id)) continue;
      let api;
      try {
        api = extractUrlFromCache(root, game.builtinKey); // 抛错 = 还没缓存/链接未就绪
      } catch {
        continue; // 缓存还没就绪，不记签名，下个 tick 用同签名重试
      }
      mihoyoGachaWatching = true;
      try {
        const result = await syncGacha({ game: game.builtinKey, installRoot: root, userData: app.getPath('userData'), api });
        mihoyoGachaSignatures.set(game.id, signature); // 只有真的同步成功，才把这份缓存记为已处理
        if (result.imported > 0) {
          send('gacha:updated', result);
          send('toast', { type: 'success', message: `${game.name || game.builtinKey} 抽卡记录已自动同步 ${result.imported} 条` });
        }
      } catch {
        /* 链接过期或暂未就绪，不记签名，下个 tick 重试（与优化前行为一致，不空转也不漏） */
      } finally {
        mihoyoGachaWatching = false;
      }
    }
  };
  setInterval(attempt, 20000);
}

/**
 * 只比对版本号，不下任何东西。
 *
 * 自动更新开着时它会顺手把包装上，关着时也照比 —— 关掉自动更新的人多半是不想
 * 被后台下载，不是不想知道有新版本。更关键的是：渠道包现在随安装包分发，装在
 * 只读资源目录里，用户数据目录是空的，只更新「已存在」的自动更新会全部跳过，
 * 那样用户永远看不到有更新。这里直接对全部候选取到的渠道包做版本比对。
 */
async function checkPackUpdates() {
  const groups = [];
  for (const profile of ENDFIELD_PACK_PROFILES || []) {
    groups.push([profile, profile.directory]);
  }
  groups.push([ARKNIGHTS_OFFICIAL_PROFILE, ARKNIGHTS_OFFICIAL_PROFILE.directory]);
  groups.push([ARKNIGHTS_BILIBILI_PROFILE, ARKNIGHTS_BILIBILI_PROFILE.directory]);
  const candidates = endfieldPackCandidateRoots();
  const updates = [];
  for (const [profile, dirName] of groups) {
    let localRoot = '';
    for (const root of candidates) {
      if (fs.existsSync(path.join(root, dirName, 'U8Data'))) {
        localRoot = root;
        break;
      }
    }
    if (!localRoot) continue;
    let localVersion = '';
    try {
      localVersion =
        JSON.parse(await fsp.readFile(path.join(localRoot, '.state', `${dirName}.json`), 'utf8'))
          .Version || '';
    } catch {
      continue;
    }
    if (!localVersion) continue;
    try {
      const latest = await fetchLatest(profile);
      if (latest.version && String(latest.version) !== String(localVersion)) {
        updates.push({ iconName: profile.iconName, from: localVersion, to: latest.version });
      }
    } catch {
      /* 比版本是尽力的，网络不通就算了 */
    }
  }
  return updates;
}

async function notifyPackUpdates() {
  /*
   * 只提示「用户机器上确实存在的游戏」的渠道包。
   *
   * 原来这里是一行 `some(builtinKey === 'endfield')` 的早退：只装明日方舟、或者把终末地
   * 这个内置游戏删掉了的机器，方舟渠道包的更新提示永远发不出去（checkPackUpdates 明明
   * 已经比过了）。改成按 builtinKey 收集，再把 updates 按 iconName 前缀分回两个游戏：
   *   · 终末地 5 个包的 iconName 全部以 End 开头（Endfield / BiliEndfield / GlobalEndfield /
   *     PlayEndfield / SteamEndfield）；
   *   · 明日方舟 3 个包全部不以 End 开头（Arknights / ArkBilibili / ArkOfficial）。
   * 顺带修掉「两类同时有更新时只说终末地、却把 Arknights 塞进括号」的文案缺陷。
   */
  const wanted = new Set((store.data.games || []).map((item) => item.builtinKey).filter(Boolean));
  if (!wanted.has('endfield') && !wanted.has('arknights')) return;
  const updates = await checkPackUpdates().catch(() => []);
  if (!updates.length) return;
  const label = { endfield: '终末地', arknights: '明日方舟' };
  const familyOf = (item) => (String(item.iconName).startsWith('End') ? 'endfield' : 'arknights');
  const lines = [];
  for (const family of ['endfield', 'arknights']) {
    if (!wanted.has(family)) continue;
    const list = updates.filter((item) => familyOf(item) === family);
    if (!list.length) continue;
    lines.push(
      `${label[family]}渠道包有新版本（${list.map((item) => item.iconName).join('、')}），可在设置 → 渠道包里更新`
    );
  }
  if (!lines.length) return;
  send('toast', {
    type: 'info',
    message: lines.join('；'),
  });
}

let endfieldPackAutoRunning = false;
/**
 * 后台自动更新渠道包：终末地、明日方舟各跑各的。
 *
 * 两个游戏一共 7 个渠道包，但开关是分开的两个（settings.autoUpdateEndfieldPacks /
 * autoUpdateArknightsPacks）—— 一个键管两边会让「只玩终末地」的机器在启动时
 * 平白去拉方舟清单，反过来也一样。
 */
async function autoUpdateChannelPacksFor(family) {
  const isArknights = family === 'arknights';
  const flagKey = isArknights ? 'autoUpdateArknightsPacks' : 'autoUpdateEndfieldPacks';
  /*
   * 只在明确开启时跑。原来写的是 `=== false` 才跳过，于是「从没表过态」（undefined / null）
   * 也当成开着——没切过服、本机一个渠道包都没有的机器，照样会在后台去碰官方清单。
   * 现在必须这个键 === true 才动手，它只在成功切过对应游戏的服之后才自动打开。
   */
  if (store.data.settings[flagKey] !== true) return;
  if (endfieldPackAutoRunning) return;
  const game = store.data.games.find((item) => item.builtinKey === family);
  if (!game) return;
  if (!(game.servers || []).some((server) => targetExists(server.path))) return;
  const configured = String(store.data.settings.endfieldPackRoot || '').trim();
  let root = path.join(app.getPath('userData'), 'endfield-packs');
  if (configured) {
    try {
      await fsp.access(configured, fs.constants.W_OK);
      root = configured;
    } catch {
      /* bundled resources are read-only: update a writable copy */
    }
  }
  // 只更新本机已经存在的渠道包：全部下下来几百 MB，没装过客户端的新用户不该在
  // 后台被悄悄塞这么多东西。缺的渠道等切到那个服时按需下载。
  const exists = isArknights
    ? (store.data.settings.arknightsPackChannels || []).length > 0
    : (store.data.settings.endfieldPackChannels || []).length > 0;
  if (!exists) return;
  endfieldPackAutoRunning = true;
  try {
    const result = await updateEndfieldPacks({ root, onlyExisting: true, family });
    if (isArknights) refreshArknightsPackChannels();
    else refreshPackChannels();
    const updated = (result.results || []).filter((item) => !item.skipped && !item.error);
    if (updated.length) {
      store.data.settings.endfieldPackRoot = root;
      await store.saveNow();
      pushState(true);
      send('toast', {
        type: 'success',
        message: `${isArknights ? '明日方舟' : '终末地'}渠道包已自动更新：${updated.map((item) => item.iconName).join('、')}`,
      });
    }
  } catch {
    /* auto update is best effort */
  } finally {
    endfieldPackAutoRunning = false;
  }
}

/** 启动时按各自开关跑两条（谁开着就更新谁）。 */
async function autoUpdateEndfieldPacks() {
  await autoUpdateChannelPacksFor('endfield');
  await autoUpdateChannelPacksFor('arknights');
}

/**
 * 自动检查失败时说一次，别一声不响。
 *
 * 以前只有用户主动点「检查更新」才看得到失败原因，开机那次自动检查是彻底静默的：
 * 网络被墙、清单读不到、清单没签名被拦，界面上一律只是「已是最新」。用户反馈过来
 * 就只剩「自动更新没用」一句话，连卡在哪一步都问不出来。
 *
 * 但每次开机都弹红字太吵（拔网线开机最明显），所以同一条错误 24 小时内只报一次，
 * 换了一条新错误立刻报。记录写进 settings，重启也认。
 */
const UPDATE_FAIL_NOTICE_WINDOW = 24 * 60 * 60 * 1000;
function reportAutoCheckFailure(status) {
  if (!status || status.ok) return;
  const reason = String(status.error || '').trim();
  if (!reason) return;
  const settings = store?.data?.settings;
  if (!settings) return;
  const lastAt = Number(settings.updateFailNoticeAt) || 0;
  const lastText = String(settings.updateFailNoticeText || '');
  if (lastText === reason && Date.now() - lastAt < UPDATE_FAIL_NOTICE_WINDOW) return;
  settings.updateFailNoticeText = reason;
  settings.updateFailNoticeAt = Date.now();
  store.saveNow().catch(() => {});
  send('toast', {
    type: 'error',
    message: `自动检查更新失败：${reason}（可在 设置 → 软件更新 里手动重试）`,
  });
}

async function autoCheckLauncherUpdate() {
  if (!store?.data?.settings?.autoCheckUpdate) return;
  if (process.env.HX_CAPTURE === '1' || process.env.HX_SMOKE === '1') return;
  try {
    const status = await performUpdateCheck({ push: true });
    reportAutoCheckFailure(status);
  } catch {
    /* 更新源不可达时静默 */
  }
}

async function checkEndfieldUpdateNotice() {
  const game = store.data.games.find((item) => item.builtinKey === 'endfield');
  const server = game?.servers.find((item) => item.id === game.activeServerId);
  if (!game || !server?.root) return;
  try {
    const stateFile = path.join(server.root, '.vela-game-state.json');
    let local = null;
    try {
      local = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
    } catch {
      return;
    }
    const remote = await checkEndfieldGame({ root: server.root, channel: server.channel });
    if (local?.version && remote.version !== local.version) {
      send('toast', {
        type: 'info',
        message: `终末地发现新版本 ${remote.version}，可在设置 → 终末地渠道包目录 → 更新游戏本体`,
      });
    }
  } catch {
    /* update check is best effort */
  }
}

async function checkArknightsUpdateNotice() {
  const game = store.data.games.find((item) => item.builtinKey === 'arknights');
  const server = game?.servers.find((item) => item.id === game.activeServerId);
  if (!game || !server?.root) return;
  /*
   * 国际服（EN / JP / KR）走 Yostar 自己的版本号体系，和国服清单完全无关：
   * 国服这周更新了、国际服可能还停在上一版，反之亦然。所以这里必须分开查，
   * 否则要么永远不提示、要么提示一个根本装不上的版本。
   *
   * 版本号来源用官方 game-launcher-config.json 的 version（本地读一份、远端拿一份），
   * 这也是官方自己判断「要不要更新」的字段。
   */
  if (yostarPacks.isYostarChannel(server.channel)) {
    try {
      const profile = yostarPacks.profileFor(server.channel);
      const [local, remote] = await Promise.all([
        yostarPacks.readGameConfig(server.root),
        yostarPacks.loadRemoteTargetPackage(profile),
      ]);
      const localVersion = local?.version ? String(local.version) : '';
      const remoteVersion = remote?.config?.version ? String(remote.config.version) : '';
      if (localVersion && remoteVersion && localVersion !== remoteVersion) {
        send('toast', {
          type: 'info',
          message: `明日方舟 ${profile.tag} 发现新版本 ${remoteVersion}（当前 ${localVersion}），可在设置 → 明日方舟渠道包 → 更新游戏本体`,
        });
      }
    } catch {
      /* update check is best effort */
    }
    return;
  }
  // 版本检查用的是国服清单（channel:'arknights' 哨兵值），台服由第三个发行商发行、
  // 协议未验证，给它弹「去更新国服本体」的提示只会误导。best-effort toast，静默跳过即可。
  if (!ARKNIGHTS_CN_CHANNELS.includes(server.channel)) return;
  try {
    const stateFile = path.join(server.root, '.vela-game-state.json');
    let local = null;
    try {
      local = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
    } catch {
      return;
    }
    const remote = await checkEndfieldGame({ root: server.root, channel: 'arknights' });
    if (local?.version && remote.version !== local.version) {
      send('toast', {
        type: 'info',
        message: `明日方舟发现新版本 ${remote.version}，可在设置 → 明日方舟渠道包 → 更新游戏本体`,
      });
    }
  } catch {
    /* update check is best effort */
  }
}

app.whenReady().then(async () => {
  // 便携模式：Chromium 缓存也放进启动器目录（必须在 ready 之后设置）
  if (portableData && !process.env.HX_USER_DATA) {
    try {
      app.setPath('sessionData', portableData);
    } catch {
      /* ignore */
    }
  }
  // 全新安装判定：数据文件还不存在时不吵醒任何旧值，用来决定默认称呼
  const freshStore = !fs.existsSync(dataFile());
  store = createStore();
  await store.load();
  // 歌单缓存单独一个文件：它是可丢的派生数据，不该和 launcher-data.json 共命运
  await playlistCache().load();
  await ensureSeedData(store, app.getPath('userData'));
  /*
   * 官方背景启动静默同步：官方每次发版本简报都会换一批主视觉背景，
   * 这里延迟 20 秒拉一次（失败完全静默），用户打开设置页就能看到最新一期。
   */
  setTimeout(() => {
    hgBackgrounds
      .syncOfficialBackgrounds(app.getPath('userData'))
      .then((result) => {
        if (result.added > 0) console.log(`[官方背景] 新增 ${result.added} 张（共 ${result.total}）`);
      })
      .catch((error) => console.warn('[官方背景] 同步失败：', (error && error.message) || error));
  }, 20 * 1000).unref?.();
  const previousUiRevision = store.data.settings?.uiRevision;
  store.data.settings = { ...defaultSettings(), ...(store.data.settings || {}) };
  // 代理要在任何联网动作之前生效（更新检查、封面、公告都在后面）
  await applyProxySettings();
  // 限速同样要在启动时就装上：开机自动检查更新那次下载也会受它约束
  applyDownloadLimit();
  if (!previousUiRevision) store.data.settings.sidebarCollapsed = true;
  const bundledPacks = bundledEndfieldPackRoot();
  if (bundledPacks) store.data.settings.endfieldPackRoot = bundledPacks;
  /*
   * 2.6.0：渠道包自动更新改成「切过服才默认开」。
   * 老版本把 autoUpdateEndfieldPacks 默认写成 true，从没切过服的机器（本机一个渠道包都没下）
   * 也会在后台去碰官方清单并更新。这里做一次性迁移：没有切服记录的机器回到「未决定」（null），
   * 下次成功切服时由 servers:activate 自动勾上；用户手动设过的 false 不受影响。
   */
  if (!store.data.settings.channelPackAutoMigrated) {
    store.data.settings.channelPackAutoMigrated = true;
    if (!store.data.settings.hasSwitchedServer && store.data.settings.autoUpdateEndfieldPacks === true) {
      store.data.settings.autoUpdateEndfieldPacks = null;
    }
    await store.saveNow().catch(() => {});
  }
  // 启动时补一次自动探测：用户换了机器、装了 XelLauncher / Starward 都能直接被认出来
  if (!store.data.settings.endfieldPackRoot || !fs.existsSync(store.data.settings.endfieldPackRoot)) {
    const detectedPacks = detectEndfieldPackRoot();
    if (detectedPacks) store.data.settings.endfieldPackRoot = detectedPacks;
  }
  // 界面要知道「哪几个渠道的包已经在机器上」：一个都没有时不再显示成"未识别"，
  // 而是说明会在切到那个服时自动补下。
  refreshPackChannels();
  // 云备份：先把「有没有存过密码/口令」读进内存（snapshot 是同步的），再排定时器
  await refreshGachaSecretFlags().catch(() => {});
  scheduleGachaBackup();
  // 下载目录默认迁移：旧版本可能落在系统下载、系统文档或 AppData 下，
  // 也可能指向一台根本不存在的机器 / 用户的路径。这些都统一迁回启动器自身文件夹内的专门子目录；
  // 用户自己挑的、且现在还能正常写入的路径保持不变。
  {
    const current = String(store.data.settings.downloadDir || "");
    const launcherDefault = path.join(resolvePortableRoot(), "花筱灵下载");
    const safeGet = (name) => {
      try {
        return app.getPath(name) || "";
      } catch {
        return "";
      }
    };
    const legacyRoots = [safeGet("downloads"), safeGet("documents"), safeGet("userData")].filter(Boolean);
    const withSep = (dir) => (dir.endsWith(path.sep) ? dir : dir + path.sep);
    // 落在系统下载 / 系统文档 / userData 下 —— 都是启动器自己选的默认位置，不是用户挑的
    const isLegacy = legacyRoots.some((root) => current.startsWith(withSep(root)));
    // 目录不存在（多半是旧机器 / 旧用户名留下的路径），或存在但写不进去
    const unusable = current ? !fs.existsSync(current) || !canWrite(current) : true;
    if (!current || isLegacy || unusable) {
      store.data.settings.downloadDir = launcherDefault;
    }
  }
  // 确保默认下载目录存在：首次使用自动创建空目录，不会把启动器自身资源混进去。
  try {
    const dd = String(store.data.settings.downloadDir || "").trim();
    if (dd) fs.mkdirSync(dd, { recursive: true });
  } catch {
    /* 无写权限等极端情况忽略，真正下载时再报错 */
  }
  if (!store.data.settings.starwardDbPath || !fs.existsSync(store.data.settings.starwardDbPath)) {
    const detectedDb = detectStarwardDbPath();
    if (detectedDb) store.data.settings.starwardDbPath = detectedDb;
    else store.data.settings.starwardDbPath = '';
  }
  const accentMigration = { rose: 'spark', jade: 'cyan', amber: 'gold', violet: 'sakura' };
  if (accentMigration[store.data.settings.accent]) {
    store.data.settings.accent = accentMigration[store.data.settings.accent];
  }
  if (!store.data.settings.profileName || store.data.settings.profileName === '旅行者') {
    store.data.settings.profileName = '大小姐';
  }
  // 新用户第一次打开：主页称呼默认「主人」；已有数据的老用户保持自己原来的称呼
  if (freshStore && store.data.settings.profileName === '大小姐') {
    store.data.settings.profileName = '主人';
  }
  // --no-elevate：用户在上一次 UAC 弹窗里点了「否」，这一次就老老实实用普通权限跑，
  // 不能每次开都再弹一次（那会变成关不掉的弹窗循环）。
  const elevationDeclined = process.argv.includes('--no-elevate');
  if (elevationDeclined) store.data.settings.elevationDeclined = true;
  if (
    store.data.settings.alwaysAdmin &&
    !isElevated() &&
    !elevationDeclined &&
    !store.data.settings.elevationDeclined &&
    process.env.HX_CAPTURE !== '1' &&
    process.env.HX_SMOKE !== '1'
  ) {
    if (await relaunchElevated()) return;
  }
  applyNativeTheme(store.data.settings.theme);
  applyUiScale(store.data.settings.uiScale);
  await store.saveNow();
  if (ensureAllServers()) await store.saveNow();
  await detectBuiltins(true);
  // 崩坏3 卡片封面自愈：占位 SVG → 已缓存的官方主视觉（没有官方图就保持原样）
  if (promoteBh3Cover()) await store.saveNow();

  downloads = new DownloadManager({
    store,
    onChange: () => pushState(false),
    onToast: (payload) => send('toast', payload),
  });
  downloads.restore();

  // 协议必须在创建任何窗口之前注册好，否则首帧里的 <img src="hxl-shot:..."> 会 404
  installShotProtocol();
  const ipc = installIpc();
  if (process.env.HX_CAPTURE !== '1') createSplashWindow();
  createWindow();
  // 开机预读画质：用户点进画质页时直接拿缓存，不用再等注册表
  ipc?.primeGraphicsCache?.();
  ensureNevernessCover();
  ensureAnimatedStartBackgrounds();
  // 去字缓存修补：启动后 2.5 秒跑，不挡首帧（单张约 0.9s，最多三张）
  setTimeout(repairErasedStartCovers, 2500);
  /*
   * 显卡加速体检：GPU 进程起不来时 Chromium 要连续崩几次才彻底切成软件渲染，
   * 所以 2.5s 与 9s 各看一次。状态真的变了会 pushState，启动页当场换成静态背景。
   */
  setTimeout(refreshGpuStatus, 2500);
  setTimeout(refreshGpuStatus, 9000);
  startNoticeAutoSync();
  setTimeout(checkEndfieldUpdateNotice, 8000);
  setTimeout(checkArknightsUpdateNotice, 11000);
  setTimeout(async () => {
    await autoUpdateEndfieldPacks();
    // 自动更新只管用户数据目录里已有的包；内置那一份靠这里单独提醒
    await notifyPackUpdates();
  }, 12000);
  // 游戏更新自动检测与预下载自动检查都在 registerIpc 闭包里注册（函数也在那边，
  // 放这里会 ReferenceError —— 以前就这么错过一次，见那个函数上方的说明）。
  setTimeout(startEndfieldGachaWatcher, 5000);
  setTimeout(startMihoyoGachaWatcher, 5000);
  // 自更新：开机后 15 秒查一次，之后每 6 小时一次（老版本机器靠这个收到提示）
  settlePreviousUpdate();
  updater.cleanTemp(updateTempBase()).catch(() => {});
  setTimeout(() => autoCheckLauncherUpdate(), 15000);
  setInterval(() => autoCheckLauncherUpdate(), 6 * 60 * 60 * 1000);
  setTimeout(async () => {
    await refreshNteAccount().catch(() => {});
    await scanNteGachaDrops({ notify: true }).catch(() => {});
    pushState(true);
  }, 6000);
  await fsp.mkdir(nteGachaDir(), { recursive: true }).catch(() => {});
  setInterval(() => {
    scanNteGachaDrops({ notify: true }).catch(() => {});
    refreshNteAccount().catch(() => {});
  }, 30 * 1000);
  installTray();
  if (process.env.KUGOU_COOKIE_DUMP === '1') {
    setTimeout(async () => {
      try {
        const dump = await new Promise((resolve) => {
          const w = new BrowserWindow({
            width: 900,
            height: 700,
            show: false,
            webPreferences: { partition: 'persist:kugou-dump', contextIsolation: true, sandbox: true },
          });
          w.loadURL('https://www.kugou.com/');
          w.webContents.once('did-finish-load', async () => {
            await new Promise((r) => setTimeout(r, 3000));
            const cookies = await w.webContents.session.cookies.get({});
            const domains = [...new Set(cookies.map((c) => c.domain))];
            const payload = ({
              count: cookies.length,
              domains,
              names: cookies.map((c) => c.name).sort(),
              sample: cookies.filter((c) => /u|t|token|kugoo|kg/i.test(c.name)).map((c) => ({ name: c.name, domain: c.domain, valueLen: String(c.value || '').length })),
            });
            try { fs.writeFileSync(path.join(app.getPath('userData'), 'kugou-cookies.json'), JSON.stringify(payload, null, 1), 'utf8'); } catch {}
            w.destroy();
            resolve(true);
          });
        });
        void dump;
      } catch (error) {
        console.error('kugou dump failed:', error);
      }
      setTimeout(() => { quitting = true; app.quit(); }, 500);
    }, 2000);
  }

  if (process.env.HX_REMOVE_UI_TEST === '1') {
    setTimeout(async () => {
      try {
        await win.webContents.executeJavaScript(`window.__navigate && window.__navigate('library')`);
        const id = await win.webContents.executeJavaScript(`
          window.launcher.games.add({
            name: 'DeleteMeTest',
            target: 'C:\\\\Windows\\\\System32\\\\notepad.exe',
            subtitle: '', description: '', version: '', tags: [], args: '', workDir: '', cover: '', accent: '#e8435a'
          }).then((game) => game.id)
        `);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const before = await win.webContents.executeJavaScript(`document.querySelectorAll('.game-card').length`);
        await win.webContents.executeJavaScript(`openGameModal(${JSON.stringify(id)})`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const modalText = await win.webContents.executeJavaScript(
          `document.querySelector('.modal')?.innerText.slice(0, 500)`
        );
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-action="delete-game"]')?.click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        const confirm = await win.webContents.executeJavaScript(
          `document.querySelector('#confirm-yes')?.innerText`
        );
        await win.webContents.executeJavaScript(`document.querySelector('#confirm-yes')?.click()`);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const after = await win.webContents.executeJavaScript(`document.querySelectorAll('.game-card').length`);
        const message = await win.webContents.executeJavaScript(
          `document.querySelector('#form-error')?.textContent || ''`
        );
        console.log('REMOVE_UI_TEST', JSON.stringify({ id, before, after, confirm, message, modalText }));
      } catch (error) {
        console.error('REMOVE_UI_TEST_ERROR', error);
      } finally {
        setTimeout(() => {
          quitting = true;
          app.quit();
        }, 300);
      }
    }, 2500);
  }
  if (process.env.HX_LAUNCH_TEST === '1') {
    setTimeout(async () => {
      try {
        const game = {
          id: 'test-notepad',
          name: 'Notepad Test',
          subtitle: '',
          description: '',
          version: '',
          tags: [],
          target: path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'notepad.exe'),
          args: '',
          workDir: '',
          cover: '',
          accent: '#e8435a',
          favorite: false,
          builtin: false,
          demo: false,
          servers: [],
          activeServerId: null,
          createdAt: new Date().toISOString(),
          lastPlayed: null,
          launchCount: 0,
          playSeconds: 0,
        };
        ensureServers(game);
        store.data.games.push(game);
        await store.saveNow();
        pushState(true);
        const result = await win.webContents.executeJavaScript(
          `window.launcher.games.launch('test-notepad')`
        );
        console.log('LAUNCH_TEST_RESULT', JSON.stringify(result));
        await new Promise((resolve) => setTimeout(resolve, 4500));
        console.log('LAUNCH_TEST_RUNNING', running.size);
        await win.webContents.executeJavaScript(`window.launcher.games.stop('test-notepad')`);
      } catch (error) {
        console.error('LAUNCH_TEST_ERROR', error);
      } finally {
        quitting = true;
        app.quit();
      }
    }, 2500);
  }
  applyLoginItem(store.data.settings);
  if (process.env.HX_ENDFIELD_TEST === '1') {
    setTimeout(async () => {
      try {
        const game = store.data.games.find((item) => item.builtinKey === 'endfield');
        const server = game?.servers.find((item) => item.channel === 'global');
        console.log('ENDFIELD_TEST_BEFORE', JSON.stringify({ game: game?.target, server: server?.path }));
        const result = await win.webContents.executeJavaScript(
          `window.launcher.servers.prepareEndfield(${JSON.stringify({
            gameId: game?.id,
            serverId: server?.id,
          })})`
        );
        console.log('ENDFIELD_TEST_RESULT', JSON.stringify(result));
        const after = store.data.games.find((item) => item.builtinKey === 'endfield');
        console.log('ENDFIELD_TEST_AFTER', JSON.stringify({ target: after?.target, active: after?.activeServerId }));
      } catch (error) {
        console.error('ENDFIELD_TEST_ERROR', error);
      } finally {
        quitting = true;
        app.quit();
      }
    }, 3500);
  }
  // 官网自动同步：每 6 小时扫一轮。
  // 注意：轮询定时器必须「无条件注册」，不能和「距上次同步是否超过 6h」的判断写进同一个 if。
  // 旧代码把 setInterval 也塞在那个判断里，导致「6h 内重新打开启动器」时定时器根本没建起来，
  // 于是一整天都不自动同步——用户说的「重开也不获取」就是这个 bug。
  // 现在：定时器常驻；首轮是否立即跑，才用 6h 阈值去抖（避免频繁开关启动器反复打官网）。
  if (process.env.HX_CAPTURE !== '1' && store.data.settings.autoSyncOfficial !== false) {
    if (Date.now() - (store.data.lastOfficialSync || 0) > 6 * 60 * 60 * 1000) {
      setTimeout(() => {
        syncAllOfficial().catch((error) => console.warn('自动同步官网失败：', error.message));
      }, 4200);
    }
    setInterval(() => {
      if (store?.data?.settings?.autoSyncOfficial !== false) {
        syncAllOfficial().catch((error) => console.warn('自动同步官网失败：', error.message));
      }
    }, 6 * 60 * 60 * 1000);
  }
  nativeTheme.on('updated', () => {
    applyTitlebar();
    pushState(true);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
}).catch((error) => {
  writeCrashLog('startup', error);
  try {
    dialog.showErrorBox(
      '花筱灵启动器启动失败',
      `${error.message || error}\n\n诊断日志：${path.join(app.getPath('userData'), 'crash.log')}`
    );
  } catch {
    /* ignore */
  }
  app.quit();
});

app.on('second-instance', showWindow);

app.on('before-quit', () => {
  quitting = true;
  try {
    if (neteaseServiceProcess) neteaseServiceProcess.kill();
  } catch {
    /* ignore */
  }
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  try {
    downloads?.shutdown();
  } catch (error) {
    console.warn('Download shutdown failed:', error.message);
  }
  try {
    store?.flushSync();
  } catch (error) {
    console.warn('Store flush failed:', error.message);
  }
  try {
    // 歌单缓存也要落一次：它走 400ms 防抖，直接关窗口时可能还在队列里
    playlistCacheStore?.flushSync();
  } catch (error) {
    console.warn('Playlist cache flush failed:', error.message);
  }
  if (win && !win.isDestroyed()) win.removeAllListeners('close');
});

app.on('window-all-closed', () => {
  /*
   * 窗口真的没了才走到这里（「收进托盘」只是 hide，窗口还在）。
   * 判断用 closeAction：它和 closeToTray 由同一处写入，但语义更直接 ——
   * 选过「收进托盘」就留着托盘图标准备唤回，选「退出」就退进程。
   */
  if (process.platform !== 'darwin' && store?.data?.settings?.closeAction !== 'tray') app.quit();
});

app.on('child-process-gone', (_event, details) => {
  writeCrashLog('child-process-gone', JSON.stringify(details));
  /*
   * GPU 进程崩溃后 Chromium 会试着重启，连续失败最终切成软件渲染。
   * 这里等它落定再复查一次，状态真的变了就通知渲染层（它会换成静态背景）。
   */
  if (details && details.type === 'GPU') {
    setTimeout(refreshGpuStatus, 1500);
  }
});

app.on('render-process-gone', (_event, _contents, details) => {
  writeCrashLog('render-process-gone', JSON.stringify(details));
});
