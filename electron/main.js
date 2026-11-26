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
const { loadSecret, saveSecret } = require('./secret-store');
const { powershellExe } = require('./ps-path');
// 可取消信号：既是真 AbortSignal、又带 cancelled/paused 老字段。
// 各 IPC 分片里手造 `{ cancelled: false }` 的对象传到 fetch 会 TypeError，
// 统一用这个工厂造（详见 cancel-signal.js 文件头）。
const { createCancelSignal } = require('./cancel-signal');
const { installRosterIpc } = require('./roster-ipc');
const { installPassportIpc } = require('./passport-ipc');
const { installPostartIpc } = require('./postart-ipc');
const { installHoyolabIpc } = require('./hoyolab-ipc');
// 主题包：一个包 = userData/art-pack/<id>/ 目录，带 theme.json（名字/皮肤/强调色/配色）。
// 图片名单、包 id 校验、配色白名单、资源回落顺序全在这个模块里，主进程与渲染层共用同一份口径。
const themePack = require('./theme-pack');
const endfieldOfficial = require('./endfield-official');
const { installThemePackIpc, syncActive: syncActiveThemePack } = require('./theme-pack-ipc');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn, execFileSync, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

const { JsonStore } = require('./store');
const clientChannel = require('./client-channel');
/*
 * 渠道能力表：某一款游戏的某个渠道「能不能硬链接 / 下载 / 修复 / 更新 / 预下载」
 * 的唯一权威来源。以前这些白名单散在前端 home.js、servers.js 和后端
 * servers-ipc.js、sophon.js 十几处，改漏一处就是「按钮没了 / 点了报错」。
 * 详见 electron/game-channels.js 文件头（有用户 2026-11-16 定的原话规则）。
 */
const gameChannels = require('./game-channels');
const { DownloadManager } = require('./downloads');
/*
 * 升级后自动清掉旧版本遗留的分块缓存（userData/sophon-cache/chunks）。
 *
 * 2026-11-19 。
 * 本机实测那份缓存堆了 10.99 GB / 10588 个文件，全是旧版只写不删的残留。
 * 新版（sophon.js 的边下边清）不再产生堆积，这个模块只负责清老版本留下的那份。
 *
 * ⚠ 顶层 require —— 必须登记
 */
const { purgeLegacyChunkCache } = require('./cache-purge');
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
const { overlayDirectory, mustCopyNotLink, breakSharedPersistentState, recordPlacedFiles, recordPlacedFilesAsync } = require('./runtime');
const gameFileDb = require('./game-file-db');
const { runMigrations } = require('./migrations');
const endfieldIsolation = require('./endfield-isolation');
const { loadGachaHistory } = require('./gacha');
const nteCapture = require('./nte-capture');
const nevernessPredownload = require('./neverness-predownload');
const nteTool = require('./nte-tool');
const updater = require('./updater');
const { loadGachaMeta } = require('./gacha-meta');
const { ensureErasedBackground } = require('./background-clean');
// 启动页官方动态背景（星铁 / 绝区零 / 崩坏3 的官方 webm 都从这个接口按游戏取）。
// 之前这里漏了引用，调用处抛 ReferenceError 又被空 catch 吞掉，表现就是
//
const { officialBackgrounds } = require('./start-artwork');
const { httpFetch, nodeRequest, setRequestLogger } = require('./http-fetch');
// node:https 的代理隧道：Chromium 栈自动吃系统代理但只有 6 条连接，
// node 能开 16 条却不认代理。这一层把两边补起来（顶层 require，要进打包清单）。
const proxyTunnel = require('./proxy-agent');
// 全局下载限速：所有下载链路共享一个带宽上限（）
const netThrottle = require('./net-throttle');
// 运行诊断：网络请求留痕 + 一键导出。挂在 http-fetch 上，只记元数据不记内容。
const diagnostics = require('./diagnostics');
// 诊断报告里要写「当前内置的签名公钥是谁」，用同一个常量，避免两处各写一份对不上
const minisign = require('./minisign');
const { describeStorage, cleanGroup, cleanSafe } = require('./file-manager');
const { resolveLiveRoom } = require('./live-rooms');
const { installLiveIpc } = require('./live-ipc');
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
const { installSklandIpc } = require('./skland-ipc');
const { installGachaIpc } = require('./gacha-ipc');
const { installServersIpc } = require('./servers-ipc');
const { installGamesIpc } = require('./games-ipc');
const { installEndfieldIpc } = require('./endfield-ipc');
const { installPredownloadIpc } = require('./predownload-ipc');
const { installWindowIpc } = require('./window-ipc');
const { installAppIpc } = require('./app-ipc');
const { installSettingsIpc } = require('./settings-ipc');
const { installDownloadsIpc } = require('./downloads-ipc');
const { installPluginIpc } = require('./plugin-ipc');
const { installUpdateIpc } = require('./update-ipc');
const { installDialogIpc } = require('./dialog-ipc');
const { installBackgroundIpc } = require('./background-ipc');
const { installInstallIpc } = require('./install-ipc');
const { installArknightsIpc } = require('./arknights-ipc');
const { installWuwaIpc } = require('./wuwa-ipc');
const { installNevernessIpc } = require('./neverness-ipc');
const { installScreenshotsIpc } = require('./screenshots-ipc');
const { installMiscIpc } = require('./misc-ipc');
const screenshotLib = require('./screenshots');
const graphicsConfig = require('./graphics-config');
const graphicsSchema = require('./graphics-schema');
const graphicsDetect = require('./graphics-detect');
const installManager = require('./install-manager');
const windowMaterial = require('./window-material');
const { installMusicIpc } = require('./music-ipc');
const { resolvePlayableUrl, sameSongEnough } = require('./music-resolve');
const {
  normalizeNeteaseBase,
  neteaseGet,
  looksLikeNeteaseApi,
  probeNeteaseApi,
  startNeteaseService,
  currentMusicSourceFlags,
  crossSourceFallbackUrl,
  neteaseMatchUrl,
  fetchNeteaseSongUrl,
  NETEASE_URL_BATCH,
  getNeteaseSession,
  setNeteaseSession,
  killNeteaseService,
  setStoreRef: setNeteaseStoreRef,
} = require('./netease-client');
const {
  resolveSourceUrl,
  fetchLyric: fetchSourceLyric,
  validateCustomSource,
  clearResolveCache: clearMusicResolveCache,
  normalizeSourceFlags,
  migrateLegacySourceFlags,
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
const kuroGacha = require('./kuro-gacha');
/* 明日方舟：鹰角账号 token → 寻访记录（官网只留最近 30 天） */
const arknightsGacha = require('./arknights-gacha');
const roster = require('./roster');
const { syncEndfieldGacha } = require('./endfield-gacha');
// SToken 抽卡同步：用它就不必每次开游戏去刷那条 24 小时过期的链接。
// 米哈游的 authkey 只能拿真 SToken 换，ltoken / ltoken_v2 一律 -100。
const stokenSync = require('./stoken-sync');
const accountProfile = require('./account-profile');
const gachaIcons = require('./gacha-icons');
// 扫码登录：genAuthKey 只认真 SToken，而内嵌网页登录拿不到，只能让用户扫一次码
const qrLogin = require('./qr-login');
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
  ARKNIGHTS_TW_PROFILE,
  ARKNIGHTS_TW_READY,
  PROFILES: ENDFIELD_PACK_PROFILES,
  updateEndfieldGame,
  checkEndfieldGame,
  verifyLocalMatchesRemote,
  // 复核「本地是否已是最新」时要拿完整清单（含 .blc/.chk），不能只用 checkEndfieldGame 的摘要
  loadRemoteManifest,
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
 * ⚠ 顶层 require —— 必须登记
 */
const yostarPacks = require('./yostar-packs');
/*
 * 鸣潮（库洛官方协议：官服 10003 / B服 10004 / 国际服 50004）。
 * 接口是公开 CDN（index.json → 逐文件 md5 清单 → 直接下载），无需鉴权；
 * 官服↔B服内容 99.24% 相同（847/816 个文件 md5 一致），硬链接切服收益 98.8%；
 * 国际服与国服 pak 全部不同（0.4%），只做检测/下载/更新，不做硬链接互切。
 *
 * ⚠ 顶层 require —— 必须登记
 */
const kuroPacks = require('./kuro-packs');
/**
 * 鸣潮启动参数：客户端断言「必须由启动器启动」，缺 -krqlv=<画质档位> 就自杀
 * （Fatal error: kuro: Use launcher to start game!）。详见 electron/wuwa-launch.js。
 *
 * ⚠ 顶层 require —— 必须登记
 */
const wuwaLaunch = require('./wuwa-launch');
// 进度计量器：给各条下载/更新链路补速度与剩余时间（纯计算，无 IO、无依赖）
const progressMeter = require('./progress-meter');

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
  {
    /* 播放过的音频字节缓存：corsEnabled 让音效链的 createMediaElementSource 能取样本 */
    scheme: 'hxl-audio',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  {
    /*
     * 可选素材包：hxl-art://<文件名>
     * 用户把同名 png 放进 userData/art-pack/ 就覆盖包内那 13 张装饰图，
     * 没有再回落到 src/assets/。协议里做回落，渲染层就不用判状态。
     */
    scheme: 'hxl-art',
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

/*
 * 卸载模式：跳过单实例锁。
 *
 * 启动器正在运行时，它的单实例锁占着 —— 卸载器（同一份 asar 的另一个 exe）
 * 拿不到锁就会直接 app.quit()，用户点了卸载什么都不出现。卸载是一次性的
 * 独立进程，没有理由和正在跑的启动器互斥。
 *
 * ★ 两种进入方式都要认：
 *   1) 命令行带 --uninstall —— 「设置 → 应用」里那条注册表记录走的这个；
 *   2) exe 文件名是 Uninstall* —— 安装目录里那个硬链接快捷入口走的这个。
 *      硬链接没法改命令行参数（双击就是裸启动），只能靠文件名判断。
 *      硬链接的好处：和主程序是同一个文件，不多占 250 MB，也不会像以前那样
 *      因为「复制出去的 exe 加载到同目录的启动器 asar」而跑成主界面。
 */
const isUninstallMode =
  process.argv.includes('--uninstall') || /^uninstall/i.test(path.basename(process.execPath));
/** 静默卸载：给「设置 → 应用」里那种不弹界面的卸载入口用（注册表 QuietUninstallString）。 */
const isUninstallSilent = isUninstallMode && process.argv.includes('--silent');
const gotLock = isUninstallMode ? true : app.requestSingleInstanceLock();
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
/* netease-client 里读音源开关要拿 store，但不该由它自己 require main.js（会成环） */
setNeteaseStoreRef(() => store);
let downloads = null;
let quitting = false;
/*
 * 右上角关闭键第一次被按时，主进程拦下 close 事件、问渲染层要「收托盘还是退出」。
 * 这个标志防止用户连点关闭时叠出第二个询问框（回答 / 取消后都会复位）。
 */
let closeAskPending = false;
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

/*
 * 加密凭据存取（loadSecret / saveSecret / secretFile）已抽到 electron/secret-store.js。
 * 那个模块被森空岛、米游社、鹰角、网易云、音乐登录等多处共用，
 * 定义在这里的话每拆一块都要通过 ctx 传一次，容易漏。
 */

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
    // 音乐缓存：播放过的音频字节落盘，同一首歌再播直接读本机，不再重新下载。
    // 0 = 不缓存；关掉开关时已缓存的文件保留（只是不再写入 / 不再命中）。
    musicCache: true,
    musicCacheLimitMB: 2048,
    profileName: '大小姐',
    avatar: '',
    theme: 'dark',
    accent: 'spark',
    // 界面皮肤：classic / midnight / sakura / frost / amber（2026-11-18）
    skin: 'classic',
    // 主题包 id：builtin = 内置那套；其余是 userData/art-pack/<id>/ 下的目录（2026-11-20）
    themePack: 'builtin',
    // 窗口材质：none / acrylic / mica / micaTabbed / auto
    material: 'none',
    // 自定义背景图（data URL 或本地 backgrounds/ 下的相对路径）
    customBackground: '',
    // 自定义背景不透明度 0-100：数值越低越透明，能看到更多系统材质
    backgroundOpacity: 100,
    // 界面不透明度（40–100，2026-11-18）
    uiOpacity: 100,
    // 背景图清晰度 0-100：100 为原图，越低越模糊（用来让内容更易读）
    backgroundBlur: 0,
    // 背景动态效果：缓慢运镜 + 鼠标视差 + 换图溶解，关掉就是一张静止的图
    backgroundMotion: true,
    // 官方背景轮播：每 26 秒换下一张官方主视觉（只对官方同步下来的图生效）
    backgroundRotate: true,
    sidebarCollapsed: true,
    /*
     * 启动页唤出侧栏时，左上角那颗菜单键是否钉在原位（2026-11-26 做成可选开关）。
     *
     * 默认 false = 原来那套：键和品牌跟着画面一起让开、淡出，收起靠抽屉自己的
     * 入口（底部「收起侧栏」/ 头像 / 点画面 / Esc）。
     * 打开 = 键留在原位、图标变成返回箭头，再点一下收回；logo 图和字飞进抽屉
     * 顶部那个 logo 的位置。
     */
    startNavPinMenu: false,
    uiRevision: 2,
    // 界面缩放：100% 为原始大小，范围 80% - 130%
    uiScale: 100,
    quickPanelPinned: false,
    alwaysAdmin: null,
    // 是否已经就「开游戏要管理员」问过一次：只问一次，选过就按选过的走
    elevationAsked: false,
    /*
     * 用户点了「以后不再提醒」（2026-11-25 加）。
     * 和 elevationDeclined 的区别：那个是「这次拒绝了」（10 分钟后还能再试），
     * 这个是「别再问了」—— 之后只在设置里手动开，启动器不再自动弹询问框。
     * 从设置里打开「总是以管理员身份运行」会自动清掉它。
     */
    elevationDontAsk: false,
    // 用户在上一次 UAC 弹窗里点了「否」。记住这个选择，
    // 不要每次冷启动都再弹一次授权（否则启动器一开就被拦住）。
    // 在设置里重新打开「总是以管理员身份运行」会把它清掉。
    elevationDeclined: false,
    /* 「最近一次拒绝提权」的时刻（毫秒时间戳）。0 = 没有拒绝记录。
     * 只存时间戳不存永久布尔：布尔一旦写成 true，判定条件里 !elevationDeclined
     * 永远不成立 → 再也不尝试提权 → 也永远不可能「已经是管理员」→ 反向自愈
     * 那条（只有已是管理员才清）永远不触发，卡成死锁。 */
    elevationDeclinedAt: 0,
    /*
     * 终末地启动方式（2026-11-25 用户定）：
     *   'full'   全自动 —— 给官方启动器开调试口，用 CDP 点「开始游戏」，
     *            进游戏后自动关掉启动器。体验最好。
     *   'manual' 手动 —— 只把官方启动器拉起来并最小化，用户自己点一次。
     *            不碰调试口，是「哪天官方查启动链路」时的退路。
     * 默认 full；自动模式连续失败会自动退回 manual（见 endfieldAutoFail*）。
     */
    endfieldLaunchMode: 'full',
    endfieldAutoFailCount: 0,
    endfieldAutoFailReason: '',
    endfieldAutoFailAt: 0,
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
     *   auto       自动（默认）—— 按 Gitee → jsDelivr → GitHub 的顺序挨个试
     *   gitee / jsdelivr / github  锁定我们内置的某一条，便于用户绕开被卡的线路
     *   custom     只用下面手填的地址（内网共享、自建静态站点）
     * 「锁定某一条」不会把其它源删掉，只是把它排到最前面，前面那条挂了仍会回落，
     * 否则某一条镜像抖动一下所有人都会卡住。
     */
    updateSourceMode: 'auto',
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
 * 「这个路径还在不在」——文件或目录都算。
 *
 * targetExists() 只认文件（isFile），它服务的是「启动程序 exe 在不在」这个问题，
 * 那 30 多处调用都靠这个语义。但 server.root 是**目录**，拿 targetExists 去测它
 * 恒为 false，界面就会把「好好的独立客户端目录」说成「目录已不在（被删除或移动过）」，
 * 用户生成完 B服 一看就以为失败了。目录存活性必须单独有判据。
 */
function pathExists(target) {
  if (!target) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return true;
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

const pathExistsCache = new Map();
function pathExistsCached(target) {
  if (!target) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return true;
  const now = Date.now();
  const hit = pathExistsCache.get(target);
  if (hit && now - hit.at < 1500) return hit.value;
  const value = pathExists(target);
  pathExistsCache.set(target, { at: now, value });
  if (pathExistsCache.size > 200) pathExistsCache.clear();
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
    /*
     * config 通道改用 resolveChannelFromRoot（config.ini + 文件层渠道 SDK 复核）。
     * 第三方三服切换器会把官服目录的 config.ini 改成 cps=bilibili，光看 ini 会把
     * 官服本体当成 B服客户端 —— 于是 B服 行被判成「有可用客户端」（绿灯），
     * 实际用的还是官服那份，账号态和渠道配置全串。
     */
    config: clientChannel.resolveChannelFromRoot(path.dirname(exePath)).channel,
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
      ENDFIELD_PACK_NAMES[server.channel] != null) ||
    /*
     * 鸣潮：记账路径失效但真实客户端还装在 rootDir / originalRoot 指向的原地。
     * discoverBuiltinServers 的启动自愈会把 path 收回去，但「自愈后、界面重取之前」
     * 那一次渲染仍会读到旧 path —— 这里再兜一道，别让用户瞥见一闪而过的「变灰」。
     * 判据比自愈更严：只认鸣潮官方体系渠道，且目标目录必须真能启动。
     */
    (game.builtinKey === 'wutheringwaves' &&
      ['official', 'bilibili', 'global'].includes(String(server.channel || '')) &&
      Boolean(wuwaExeAt(server.rootDir || server.originalRoot)))
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
      // 2026-11-25 起默认装到「花筱灵下载」，老路径仍然保留（两个都认）
      '花筱灵下载\\arknights-Arknights_EN\\Arknights.exe',
      '花筱灵下载\\arknights-Arknights_JP\\Arknights.exe',
      '花筱灵下载\\arknights-Arknights_KR\\Arknights.exe',
    ],
    // PlatformProcess.exe 只在鹰角启动器的子目录里出现，不能当作游戏入口
    relative: ['Arknights.exe', 'games\\Arknights Game\\Arknights.exe'],
  },
  // 鸣潮（库洛）：主程序是 UE 的 Client-Win64-Shipping.exe，根目录另有启动壳 Wuthering Waves.exe。
  // 渠道判据（kuroPacks.detectChannelOfSync）：KRSDKRes/Bilibili/ 目录 = B服；
  // ThirdParty/KrPcSdk_Global = 国际服；都没有 = 官服。
  wutheringwaves: {
    exe: 'Client-Win64-Shipping.exe',
    registry: [
      'HKCU\\Software\\KuroGames\\Wuthering Waves',
      'HKLM\\SOFTWARE\\KuroGames\\Wuthering Waves',
      'HKLM\\SOFTWARE\\WOW6432Node\\KuroGames\\Wuthering Waves',
    ],
    paths: [
      'Wuthering Waves Game\\Client-Win64-Shipping.exe',
      'Wuthering Waves\\Client-Win64-Shipping.exe',
      'KuroGames\\Wuthering Waves Game\\Client-Win64-Shipping.exe',
      'Games\\Wuthering Waves Game\\Client-Win64-Shipping.exe',
      'HuaXiaoLingGames\\wutheringwaves-official\\Client-Win64-Shipping.exe',
      'HuaXiaoLingGames\\wutheringwaves-bilibili\\Client-Win64-Shipping.exe',
      'HuaXiaoLingGames\\wutheringwaves-global\\Client-Win64-Shipping.exe',
      '花筱灵下载\\wutheringwaves-official\\Client-Win64-Shipping.exe',
      '花筱灵下载\\wutheringwaves-bilibili\\Client-Win64-Shipping.exe',
      '花筱灵下载\\wutheringwaves-global\\Client-Win64-Shipping.exe',
      // WeGame 版：下载中在 downloading\2002137，装好后 WeGame 会把整个目录搬到
      // rail_apps\Wuthering Waves(2002137)。写目录而非 exe 路径，checkPath 会按
      // relative 两层探测主程序（UE 的可执行文件在 Client\Binaries\Win64 下）。
      'WeGameApps\\downloading\\2002137',
      'WeGameApps\\rail_apps\\Wuthering Waves(2002137)',
    ],
    relative: [
      'Client-Win64-Shipping.exe',
      'Client\\Binaries\\Win64\\Client-Win64-Shipping.exe',
      'Wuthering Waves.exe',
    ],
  },

  /*
   * 蓝色星原：旅谣（2026-11-26 接入，蛮啾 / 上海蛮奈网络科技）。
   *
   * 主程序 AzurPromilia.exe 是 asInvoker（不需提权），但**不能直接启动** ——
   * 游戏进程的父进程必须是官方 launcher.exe，否则界面报「请通过启动器打开」，
   * 硬起还会触发 ACE「安全组件发生异常」（2026-11-26 实测）。
   *
   * 所以这里的路径只用于「识别安装位置 / 判断装没装」，
   * 真正的启动走 electron/azur-launcher.js 的官方启动器托管。
   *
   * 注册表实测：
   *   HKCU\Software\AzurPromilia\35_C000  →  Path / Version / VersionName / Exe
   *   HKCU\Software\AzurPromilia\Game_35_C000_SC1003V → uuid
   *   HKCU\Software\Manjuu_Game
   */
  azurpromilia: {
    exe: 'AzurPromilia.exe',
    registry: [
      'HKCU\\Software\\AzurPromilia',
      'HKCU\\Software\\Manjuu_Game',
      'HKLM\\SOFTWARE\\AzurPromilia',
      'HKLM\\SOFTWARE\\WOW6432Node\\AzurPromilia',
    ],
    paths: [
      'AzurPromilia_Game\\AzurPromilia.exe',
      'AzurPromilia\\AzurPromilia.exe',
      'Manjuu\\AzurPromilia\\AzurPromilia.exe',
      'Games\\AzurPromilia_Game\\AzurPromilia.exe',
      '花筱灵下载\\azurpromilia\\AzurPromilia.exe',
    ],
    relative: ['AzurPromilia.exe'],
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
  // 鸣潮官网（库洛）
  wutheringwaves: 'https://www.kurogames.com/',
  // 蓝色星原：旅谣官网（蛮啾 / 上海蛮奈网络科技，2026-11-26 接入）
  azurpromilia: 'https://azurpromilia.manjuu.com/',
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
// 2.10.x 增量：鸣潮（库洛），公告来自 kurobbs + 国际服 ArticleMenu。
// 缺表时下面用 store.data.games 的 builtinKey 动态兜底，但显式列上更稳：
// 游戏记录还没建（新用户首次启动）时也要能拿到公告。
const NOTICE_GAME_KEYS = ['genshin', 'starrail', 'zzz', 'endfield', 'neverness', 'arknights', 'bh3', 'wutheringwaves', 'azurpromilia'];
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

  /*
   * 官方背景图会随版本换（URL 里带 2026/09/17、2026/09/24 这种日期目录），
   * 但落盘文件名是固定的。原来这里只判断「startCover 等于那个固定名
   * 且文件存在」就直接 return，等于第一次抓下来之后再也不会检查官方换没换图
   * —— 这就是「崩坏3 静态背景永远是旧的那张」。
   *
   * 现在记一个 startCoverSource 保存上次用的官方 URL：
   *   - 和官方当前给的不同 → 重新下
   *   - 相同 → 才走快路径
   *   - 老数据没有这个字段 → 当作过期重下一次，下完就有了
   *
   * 另外官方现在给的是 .webp，所以落盘名按真实格式决定（见下面的 sniffImageExtension），
   * 判定时不能再拿 .png 写死。
   */
  let officialUrl = '';
  try {
    const art = await officialBackgrounds('bh3');
    officialUrl = art.images[0]?.url || '';
  } catch {
    /* 接口挂了就什么都别改，保持现有文件 */
  }

  // startCover 可能是 .png 也可能是 .webp（按真实格式落盘），所以按前缀判
  const coverMatches = /^covers\/official-bh3-clean2\.(png|webp|jpg|gif)$/i.test(String(game.startCover || ''));
  if (coverMatches && officialUrl && game.startCoverSource === officialUrl) {
    const existing = path.join(app.getPath('userData'), game.startCover);
    if (fs.existsSync(existing) && fs.statSync(existing).size > 4096) return;
  }

  let imageUrl = officialUrl;
  if (!imageUrl) {
    // 官方接口没给图时才退回活动 banner（banner 带标题字，只作兜底）
    if (coverMatches) {
      const existing = path.join(app.getPath('userData'), game.startCover);
      // 已有的官方图还能用，就别为了 banner 覆盖它
      if (fs.existsSync(existing) && fs.statSync(existing).size > 4096) return;
    }
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
    /*
     * 按真实格式落盘。官方现在给的是 .webp，历史代码把名字写死成 .png，
     * 于是磁盘上出现「叫 .png 其实是 webp」的文件 —— nativeImage 与
     * 系统看图都按扩展名解码，直接打不开；下游去字流程也会误判成 png 而跳过转码。
     */
    const realExt = sniffImageExtension(buffer) || 'png';
    const fileName = `official-bh3-clean2.${realExt}`;
    if (fileName !== 'official-bh3-clean2.png') {
      // 清掉历史上那个扩展名不符的旧文件，避免两份并存
      await fsp.rm(path.join(dir, 'official-bh3-clean2.png'), { force: true }).catch(() => {});
    }
    await fsp.writeFile(path.join(dir, fileName), buffer);
    game.startCover = `covers/${fileName}`;
    // 记下这次用的是哪张官方图，下次拿它和接口返回值比对，判断要不要重下
    game.startCoverSource = officialUrl || imageUrl;
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

/*
 * 鸣潮卡片封面：官网 MainMenu.json → pcTopPicture.coverImage（1920x1080 PNG，实测 3.75MB）。
 * 报告 `_wuwa-art-report.md`：URL 随版本时间戳换图，启动器缓存机制按 URL 变化重新落盘。
 */
async function pickKuroCover() {
  for (const url of [
    'https://media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/zh/MainMenu.json',
    'https://hw-media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/zh/MainMenu.json',
  ]) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const json = await response.json();
      const image = json?.pcTopPicture?.coverImage || json?.topPicture?.coverImage || '';
      if (image && /^https?:\/\//.test(image)) return String(image);
    } catch {
      /* try next mirror */
    }
  }
  return '';
}

/*
 * 鸣潮启动页动态背景：官网 MainMenu.json → pcTopPicture.backgroundVideo（mp4，
 * 实测 29.4MB / 200）。与卡片封面 coverImage 同源，但官网 og:image 不是它，
 * 必须单独取。走 ensureAnimatedStartBackgrounds → cacheStartVideo 落到 backgrounds/。
 */
/**
 * 蓝色星原启动页动态背景（2026-11-26 接入）。
 *
 * 官网是 SPA，视频地址写在 assets/index-*.js 里，文件名带构建 hash
 * （实测当前 kv-D8QVMDES.mp4，3840x2160 / 15 秒 / 30 MB）。
 * 每次发版 hash 会变，所以不能写死 URL。两步解析：
 *   ① 抓官网首页 → 找到主 JS 文件名
 *   ② 抓主 JS → 正则取 kv-*.mp4 的完整地址
 *
 * 拿不到返回空串，调用方退回静态图（startCover），不阻断任何流程。
 */
async function pickAzurStartVideo() {
  const SITE = 'https://azurpromilia.manjuu.com/';
  const ASSET_BASE = 'https://webstatic.manjuu.com/web/static/azurpromilia.manjuu.com/assets/';

  const grab = async (url, timeout) => {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: '*/*' },
      signal: AbortSignal.timeout(timeout || 20000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  };

  try {
    const html = await grab(SITE, 15000);
    const jsMatch = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
    const jsName = jsMatch ? jsMatch[1] : '';

    const candidates = [];
    if (jsName) {
      try {
        const js = await grab(ASSET_BASE + jsName, 25000);
        for (const m of js.matchAll(/assets\/(kv-[A-Za-z0-9_-]+\.mp4)/g)) candidates.push(m[1]);
        if (!candidates.length) {
          for (const m of js.matchAll(/assets\/([A-Za-z0-9_-]+\.mp4)/g)) candidates.push(m[1]);
        }
      } catch {
        /* 主 JS 拉不到就往下走 */
      }
    }

    if (!candidates.length) return '';
    const pick = candidates.find((c) => c.startsWith('kv-')) || candidates[0];
    return ASSET_BASE + pick;
  } catch {
    return '';
  }
}

async function pickKuroStartVideo() {
  for (const url of [
    'https://media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/zh/MainMenu.json',
    'https://hw-media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/zh/MainMenu.json',
  ]) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const json = await response.json();
      const video = json?.pcTopPicture?.backgroundVideo || json?.topPicture?.backgroundVideo || '';
      if (video && /^https?:\/\//.test(video)) return String(video);
    } catch {
      /* try next mirror */
    }
  }
  return '';
}

/*
 * 鸣潮公告（2026-11-12）：两条源，都实测可用（接口研究见工作区 _wuwa-art-report.md）。
 *   · 国服/B服：库街区 companyEvent/findEventList（表单 gameId=3=鸣潮，无需登录 token）
 *   · 国际服：官网静态 CDN ArticleMenu.json（zh 走 media-cdn 域、en 走 hw-media-cdn 域，域名严格绑定）
 * 字段映射到启动器统一模型 {title, link, date, type}。
 */
async function fetchKuroNotices() {
  const items = [];
  // ① 国服：库街区活动公告列表
  try {
    const devCode = crypto.randomBytes(16).toString('hex');
    const body = new URLSearchParams({ gameId: '3', page: '1', pageSize: '30' }).toString();
    const response = await fetch('https://api.kurobbs.com/forum/companyEvent/findEventList', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        source: 'h5',
        version: '1.0.0',
        devCode,
        distinct_id: devCode,
        'User-Agent': BROWSER_UA,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const json = await response.json();
      const list = json?.data?.list || [];
      const typeNames = { 1: '活动', 2: '资讯', 3: '公告' };
      for (const entry of list) {
        if (!entry?.postTitle || !entry?.postId) continue;
        items.push({
          title: String(entry.postTitle),
          link: `https://www.kurobbs.com/mc/post/${entry.postId}`,
          date: entry.publishTime ? new Date(Number(entry.publishTime)).toISOString().slice(0, 10) : '',
          type: typeNames[entry.eventType] || '公告',
          image: entry.coverUrl ? String(entry.coverUrl) : '',
        });
      }
    }
  } catch (error) {
    console.warn('鸣潮国服公告（库街区）读取失败：', error.message);
  }
  // ② 国际服：官网 ArticleMenu（zh 源当补充；en 用户量少，暂只接 zh 的 CDN）
  if (items.length < 8) {
    try {
      const response = await fetch(
        'https://media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/zh/ArticleMenu.json',
        { headers: { 'User-Agent': BROWSER_UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) }
      );
      if (response.ok) {
        const json = await response.json();
        const flat = Array.isArray(json) ? json : (json?.list || json?.data || []);
        const typeNames = { 52: '公告', 51: '新闻', 53: '活动' };
        for (const entry of flat) {
          if (!entry?.articleTitle || !entry?.articleId) continue;
          items.push({
            title: String(entry.articleTitle),
            link: `https://wutheringwaves.kurogames.com/zh/main/news/detail/${entry.articleId}`,
            date: entry.startTime ? new Date(Number(entry.startTime)).toISOString().slice(0, 10) : '',
            type: typeNames[entry.articleType] || '公告',
            /* 这条源本来就没封面图：2026-11-12 实网核对，199 条里 suggestCover 非空的 0 条，
             * 只有 articleContent/articleDesc/articleId/articleTitle/articleType/createTime/
             * sortingMark/startTime/suggestCover/top 这十个键。所以这里恒空是事实，不是漏字段；
             * 封面图由 pickKuroCover（MainMenu.json 的 pcTopPicture.coverImage）另外提供。 */
            image: '',
          });
        }
      }
    } catch (error) {
      console.warn('鸣潮国际服公告（官网 CDN）读取失败：', error.message);
    }
  }
  // 去重（两个源可能报同一件事）+ 取前 8
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    if (seen.has(item.title)) continue;
    seen.add(item.title);
    deduped.push(item);
    if (deduped.length >= 8) break;
  }
  return deduped;
}

/*
 * 蓝色星原公告（2026-11-26）：蛮啾自家的公告系统，官网 /home/news 就是它渲染的。
 *
 * 之前以为蓝原「没有公告」，是因为只在主站 azurpromilia.manjuu.com 的 index-*.js
 * 里翻了一圈 —— 那是宣传页，本来就没有公告位。真正的新闻页是独立的 /home 子站，
 * 接口写在它的 App-*.js 里：
 *   GET  /announce/web/announcement/pagelatestlist?gameId=35
 *   GET  /announce/web/announcement/getdetail?gameId=35&id=<id>
 *
 * 鉴权只有一层 MD5 签名，不需要登录：
 *   sign = md5(String(timestamp) + querystring)
 * 必须带 gameId=35（35 = 蓝原，官方前端 index-*.js 的 GAME_ID 常量），
 * 且 querystring 参与签名时字段顺序要和实际发送顺序一致 —— 所以这里固定用
 * 同一个字符串既拼 URL 又算签名，不要让它俩各写一遍。
 *
 * 返回体里 type 只有两种：notice（公告）/ activity（活动），映射成中文。
 * 详情页是 SPA，正文要再调 getdetail 拿 contentUrl；列表页只需要标题和跳转链接，
 * 所以这里不额外发详情请求，把 link 指向官网详情页即可。
 */
const AZUR_NOTICE_GAME_ID = '35';
const AZUR_API_BASE = 'https://api-grp.manjuu.com';

/** 蓝原公告接口的签名请求头。querystring 必须与实际发送的完全一致。 */
function azurSignHeaders(queryString) {
  const timestamp = Date.now();
  const sign = crypto
    .createHash('md5')
    .update(String(timestamp) + queryString)
    .digest('hex');
  return {
    'user-agent': BROWSER_UA,
    'Content-Type': 'application/json',
    'device-id': crypto.randomUUID(),
    'grp-trace-id': '',
    'sdk-version': '2.4.1',
    lang: 'zh-Hans',
    timestamp: String(timestamp),
    sign,
  };
}

async function fetchAzurNotices() {
  const query = new URLSearchParams({
    gameId: AZUR_NOTICE_GAME_ID,
    pageSize: '10',
  }).toString();
  const response = await fetch(`${AZUR_API_BASE}/announce/web/announcement/pagelatestlist?${query}`, {
    headers: azurSignHeaders(query),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (!json || json.code !== 0) {
    throw new Error(`公告接口返回 ${json && json.code}：${(json && json.msg) || '未知错误'}`);
  }
  const rows = Array.isArray(json.data?.rows) ? json.data.rows : [];
  const typeLabels = { notice: '公告', activity: '活动' };
  const items = [];
  for (const row of rows) {
    if (!row?.id || !row?.title) continue;
    items.push({
      title: String(row.title),
      link: `https://azurpromilia.manjuu.com/home/news/detail/${row.id}/`,
      // startTime 是毫秒时间戳；缺失时留空，前端会隐藏日期那一栏
      date: row.startTime ? new Date(Number(row.startTime)).toISOString().slice(0, 10) : '',
      type: typeLabels[String(row.type || '')] || '公告',
      // 列表接口给的是 356x200 横图，和别的游戏一样当封面用
      image: row.pcCoverImageUrl ? String(row.pcCoverImageUrl) : '',
    });
    if (items.length >= 8) break;
  }
  return items;
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
    // 鸣潮：库街区 + 官网 CDN（2026-11-12）
    else if (gameKey === 'wutheringwaves') items = await fetchKuroNotices();
    // 蓝色星原：蛮啾公告系统（官网 /home/news 同源，2026-11-26）
    else if (gameKey === 'azurpromilia') items = await fetchAzurNotices();
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
      /*
       * 星铁：官方每个新版本先发一张动态图（带 video），版本中途才会补卡池静态图。
       * 启动页背景要用这张动态图用到版本结束，所以有 video 时版本图取「同一条动态图
       * 自带的静态图」，而不是上传日期最新的那张（那通常是版本中途补的卡池图）——
       * 否则卡池图会被下载并去字，去字后字发糊，正是用户不想看到的。
       */
      const versionImageItem =
        gameKey === 'starrail' && videoItem?.background?.url ? videoItem : imageItem;
      if (versionImageItem?.background?.url || videoItem?.video?.url) {
        return {
          image: versionImageItem?.background?.url || '',
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

/**
 * 按魔数判断图片真实格式，返回扩展名（png / webp / jpg），认不出返回 ''。
 *
 * 米家 CDN 的官方背景图现在是 .webp，而历史上落盘名写死成 .png，
 * 结果文件内容与扩展名不符 —— 按扩展名解码的路径（nativeImage、系统看图、
 * 去字流程里的 png 判定）会全部失效。
 */
function sniffImageExtension(buffer) {
  if (!buffer || buffer.length < 12) return '';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'png';
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  // GIF
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'gif';
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
// 。官方去文字主视觉（ensureBh3StartCover 拉下来的
// official-bh3-clean2）本来就是真图，直接把它当卡片封面用，并一起钉住不让同步覆盖。
const PINNED_BUILTIN_COVERS = /^covers\/(?:builtin-bh3\.(?:jpg|jpeg|png|webp|svg)|official-bh3-clean2\.(?:png|jpg|jpeg|webp))$/i;
// 崩坏3 卡片的官方主视觉（与启动页背景同一张，本地已有就用，没有才退回内置 SVG）
/*
 * 崩坏3 卡片封面的候选名。
 *
 * 官方背景图现在是 .webp，历史落盘名叫 .png，两种都可能存在，
 * 所以不能写死一个 —— 按这个顺序到磁盘上找实际存在的那个。
 */
const BH3_CARD_COVER_CANDIDATES = [
  'covers/official-bh3-clean2.webp',
  'covers/official-bh3-clean2.png',
  'covers/official-bh3-clean2.jpg',
];
function findBh3CardCover() {
  for (const relative of BH3_CARD_COVER_CANDIDATES) {
    try {
      const absolute = path.join(app.getPath('userData'), relative);
      const stat = fs.statSync(absolute);
      if (stat.isFile() && stat.size >= 8192) return relative;
    } catch {
      /* 试下一个 */
    }
  }
  return '';
}
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
    /*
     * 占位 SVG 要换成官方主视觉；另外 cover 指向的「official-bh3-clean2.xxx」
     * 如果实际文件不在（比如扩展名从 .png 改成 .webp 之后），也要重新指向。
     */
    const isPlaceholder = !cover || cover === BH3_PLACEHOLDER_COVER;
    const isStaleOfficial =
      /^covers\/official-bh3-clean2\./i.test(cover) &&
      !fs.existsSync(path.join(app.getPath('userData'), cover));
    if (!isPlaceholder && !isStaleOfficial) continue;

    const found = findBh3CardCover();
    if (!found) continue;
    game.cover = found;
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
let pngConvertIdleTimer = null;
// 空闲多久之后销毁这个隐藏窗口（理由同 background-clean 的 releaseDecoderLater）
const PNG_CONVERT_IDLE_RELEASE_MS = 20000;

function releasePngConvertLater() {
  if (pngConvertIdleTimer) clearTimeout(pngConvertIdleTimer);
  pngConvertIdleTimer = setTimeout(() => {
    pngConvertIdleTimer = null;
    if (pngConvertWindow && !pngConvertWindow.isDestroyed()) {
      try {
        pngConvertWindow.destroy();
      } catch {
        /* 已经没了 */
      }
    }
    pngConvertWindow = null;
  }, PNG_CONVERT_IDLE_RELEASE_MS);
  if (pngConvertIdleTimer.unref) pngConvertIdleTimer.unref();
}

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
  // 每次用到就把「闲时销毁」往后推一次：一次启动刷新可能连着转好几张图
  releasePngConvertLater();
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
/**
 * 米哈游系（原神 / 星铁 / 绝区零 / 崩坏3）的动图缓存新鲜度核对。
 *
 * existingStartVideo 是「有缓存就用」，这在官方换背景时会让启动页永远停在旧版。
 * 官方 getAllGameBasicInfo 给的 video.url 带版本日期（2026/09/17 这种），
 * 所以用「上次记录的源 URL」和「当前官方 URL」比对：
 *   - 不同 → 删掉旧缓存返回 ''，让上层重新下载
 *   - 相同 → 返回原缓存路径（省一次几十兆的下载）
 *   - 拿不到官方 URL（接口挂了）→ 保持现状，别把能用的缓存删了
 *
 * 返回应当使用的缓存相对路径（'' 表示需要重新下载）。
 */
async function refreshMihoyoStartVideo(game, cachedRelative) {
  const key = game.builtinKey;
  if (!['genshin', 'starrail', 'zzz', 'bh3'].includes(key)) return cachedRelative;
  let officialUrl = '';
  try {
    const art = await officialBackgrounds(key);
    officialUrl = art.videos[0]?.url || '';
  } catch {
    return cachedRelative; // 接口抖动不折腾缓存
  }
  if (!officialUrl) return cachedRelative;
  if (game.startVideoSource === officialUrl) return cachedRelative;

  // 官方换了背景（或老数据没记录来源）→ 作废旧缓存
  try {
    fs.rmSync(path.join(app.getPath('userData'), cachedRelative), { force: true });
  } catch {
    /* 删不掉就让后面的写入覆盖 */
  }
  game.startVideoSource = officialUrl;
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

      /*
       * 崩坏3 的静态兜底图独立维护。
       *
       * 它以前只在「视频拿不到」的分支里生成，可崩坏3 只要有 backgrounds/bh3.webm
       * 就永远走不到那里 —— 静态图于是从来没更新过（甚至压根没生成）。
       * 这里提到前面无条件核对一次：内部靠 startCoverSource 判断官方换没换图，
       * 没换会快速返回，代价只是多一次 getAllGameBasicInfo。
       */
      if (key === 'bh3') {
        try {
          await ensureBh3StartCover(game);
        } catch (error) {
          console.warn('崩坏3 静态背景核对异常：', error.message);
        }
      }

      /*
       * 米家四款：官方换背景时要能感知到（否则启动页永远停在第一次下载的那版）。
       * 这里只在已有缓存时才多问一次接口；没缓存会走下面正常下载流程。
       */
      if (cachedVideo) {
        const fresh = await refreshMihoyoStartVideo(game, cachedVideo);
        if (!fresh) {
          cachedVideo = '';
          videoRelative = `backgrounds/${key}.mp4`;
          changed = true;
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
      } else if (key === 'wutheringwaves') {
        // 官网 MainMenu.json 的 pcTopPicture.backgroundVideo（29.4MB mp4），
        // 与卡片封面 coverImage 同源；走 cacheStartVideo 落到 backgrounds/。
        source = await pickKuroStartVideo();
      } else if (key === 'azurpromilia') {
        // 官网 index-*.js 里的 kv-*.mp4（4K / 15 秒），文件 hash 每次发版会变，
        // 所以按「首页 → 主 JS → 视频地址」两级解析，不写死 URL。
        source = await pickAzurStartVideo();
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
          // 静态图已在循环开头核对过，这里只标记「这轮没拿到动图」用于重试
          officialMiss = true;
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
        // 记下这份动图来自哪个官方 URL，下次拿它判断有没有换过
        if (/^https?:/i.test(source)) game.startVideoSource = source;
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
      // 鸣潮封面移到下面 try/catch 之外无条件取（官网 fetch 可能整个失败）。
    }
  } catch (error) {
    result.error = error.message;
  }

  // 鸣潮卡片封面：
  // 官网 og:image 是 /favicon.ico（模糊 logo 大图），且官网 fetch 可能整个失败，
  // 所以必须在 try/catch 之外无条件取 MainMenu.json 的 pcTopPicture.coverImage。
  if (game.builtinKey === 'wutheringwaves') {
    const kuroImage = await pickKuroCover().catch(() => '');
    if (kuroImage) ogImage = kuroImage;
  }

  const background = latestBackground(backgrounds, game.builtinKey);
  // 去字缓存版本是 -clean3（v2 算法），失效的路径直接清掉
  if (game.startCover && !/-(?:clean2|clean3)\./.test(game.startCover)) game.startCover = '';
  // 2.4.0 合并：customCover 判定换成 isCustomCover（保护明日方舟 / 崩坏3 钉住的封面）
  const customCover = isCustomCover(game);
  const versionArtwork = customCover ? { image: '', video: '' } : await fetchVersionArtwork(game.builtinKey);
  const fromVersionArt = Boolean(versionArtwork.image);
  // 鸣潮强制用 MainMenu 的 pcTopPicture.coverImage：官网 og:image 是 favicon、
  // latestBackground 也可能塞官网图，都会盖掉正确封面。
  const imageUrl =
    game.builtinKey === 'wutheringwaves' && ogImage
      ? ogImage
      : versionArtwork.image || (background && background.url) || ogImage;
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

/*
 * 注册表查询的进程内缓存。
 *
 * 背景（2026-11-19 实测）：这台机器上 HKCU\Software\miHoYo\原神 与
 * HKCU\Software\miHoYo\Genshin Impact 两条键「打开本身」就要 3.9~25.9 秒
 * （去掉 /s 也一样，慢的不是递归展开，是键本身），而启动链里 detectBuiltins
 * 会对 8 个游戏跑 35 个键。原来的写法 timeout 2500 让每条慢键都必然
 * ETIMEDOUT 白等 2.5 秒，用户看到的就是「双击图标后两三秒才出窗口」。
 *
 * 所以这里做三件事，目标是把启动路径上的白等压到几乎为 0：
 *   1. timeout 2500 → 600 ms：实测（_bench-timeout.js）600 ms 与 2500 ms
 *      录到的结果**完全一样**（都是 8/35 条有值），但全部键并发总耗时
 *      从 2686 ms 降到 720 ms；压到 300 ms 才开始丢结果，所以 600 留了余量。
 *   2. 负缓存：同一条键在一次进程生命周期里只查一次，失败的也记住，
 *      避免 detectBuiltins / detectServerExecutable 反复踩同一个坑。
 *   3. 常量只读一次：查询本身是异步 execFile，不再额外阻塞事件循环。
 *
 * 注意：缓存只存本进程结果，不落盘 —— 用户新装了游戏后重启启动器即可扫到；
 * 手动「重新检测」会先清缓存（见 clearRegistryCache 的调用点）。
 */
const REGISTRY_QUERY_TIMEOUT = 600;
const registryCache = new Map();

/** 用户主动重新检测游戏时清掉，否则新装的游戏会被上一次的负结果挡住。 */
function clearRegistryCache() {
  registryCache.clear();
}

function registryValues(key) {
  const cached = registryCache.get(key);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    let settled = false;
    const done = (values) => {
      if (settled) return;
      settled = true;
      registryCache.set(key, values);
      resolve(values);
    };
    let child;
    try {
      child = execFile(
        'reg.exe',
        ['query', key, '/s'],
        { encoding: 'buffer', windowsHide: true, timeout: REGISTRY_QUERY_TIMEOUT, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => {
          if (error || !stdout) {
            done([]);
            return;
          }
          const output = decodeWindowsOutput(stdout);
          const values = [];
          for (const line of output.split(/\r?\n/)) {
            const match = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i);
            if (match) values.push(match[1]);
          }
          done(values);
        }
      );
    } catch {
      // 在受限环境里 spawn 可能直接抛出 EPERM；检测失败不应该让整个启动流程崩掉。
      done([]);
      return;
    }
    if (child && typeof child.on === 'function') {
      child.on('error', () => done([]));
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
//   U8Data / sdkdata：渠道登录态与 SDK 配置，硬链接会让一个渠道改写另一个渠道的身份。
//
// ★ Endfield_Data/Persistent 已从这份清单里去掉（2026-11-19）。
//   原来把它整棵拷贝，是为了堵 11-07 那次官服污染 —— 但那次真正的元凶只有
//   index_main.json / pref_*.json 这类**进程内直接写**的索引（同 inode 写穿），
//   加上 .blc 索引，合计只有 61 MB；而 Persistent 下 178 个 .chk 占了 3.63 GB，
//   被连带拷了三份（官服 + B服 + 国际服，各渠道独占 4 GB 左右）。
//
//   一手证据：G:\Arknights Endfield\sdklogs\HGDownloadLog.log 显示官方下载器落位
//   全程是 rename（旧文件 → .bak，temp → 正式名，删 .bak），没有原地覆写。
//   Windows 同卷 rename 只改目录项、不动 inode 数据 → .chk 硬链接安全。
//   已实证：StreamingAssets\VFS 下同类 .chk 早就 nlink=3、三渠道共享 63.3 GB。
//
//   现在的保护靠 runtime.js 的前缀+扩展名配对准入（HARDLINK_ALLOW_PAIRS）：
//   `endfield_data/persistent` 这个前缀配 `.chk` 这个扩展名，两个同时命中才走硬链接；
//   .json / .blc 不在配对准入里 → 继续命中 MUTABLE_DIR_SEGMENTS 的 'persistent' 判据
//   被强制拷贝。索引仍然各渠道一份，隔离性一点没少。
const ENDFIELD_RUNTIME_COPY_DIRS = ['U8Data', 'sdkdata'];

/*
 * 清掉历史遗留的终末地语音包备份（2026-11-19）。
 *
 * 老版本每次重建运行时都会把 Endfield_Data\Persistent 整份拷到
 *   <userData>\endfield-persistent-backup\<渠道>\Persistent
 * 两个渠道就是 7.39 GB。现在 .chk 走硬链接、基础客户端里本来就有一份，
 * 这份备份不再需要，留着纯占盘。
 *
 * 只在「没有任何终末地任务在跑」时动手，避免和重建抢文件；
 * 失败只写日志，绝不影响启动或切服。
 */
async function cleanupLegacyEndfieldBackup() {
  try {
    const backupRoot = path.join(app.getPath('userData'), 'endfield-persistent-backup');
    if (!fs.existsSync(backupRoot)) return { removed: false };
    // 有正在跑的终末地任务就不动它（终末地重建/切服走 sophonJobs 与 linkJobs 两张表）
    const busy =
      (typeof sophonJobs !== 'undefined' && sophonJobs && sophonJobs.size > 0) ||
      (typeof linkJobs !== 'undefined' && linkJobs && linkJobs.size > 0);
    if (busy) {
      writeLaunchLog('[endfield] 语音包备份清理：有相关任务在跑，本次跳过');
      return { removed: false, skipped: 'busy' };
    }
    await fsp.rm(backupRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
    writeLaunchLog('[endfield] 已清理历史语音包备份（endfield-persistent-backup，老版本遗留，现已不需要）');
    return { removed: true };
  } catch (error) {
    writeLaunchLog('[endfield] 清理历史语音包备份失败（不影响使用）：' + (error && error.message));
    return { removed: false, error: String((error && error.message) || error) };
  }
}

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

/*
 * 鸣潮 WeGame 版目录定位（2026-11-12）：WeGame 下载中是
 * `<盘>:\WeGameApps\downloading\2002137`，装好之后会把整个目录搬到
 * `<盘>:\WeGameApps\rail_apps\Wuthering Waves(2002137)`（实测装完 downloading
 * 目录直接消失）。用户要求两个路径都能识别到。
 *
 * 这里必须在模块级：ensureKuroRuntime 是模块级函数，之前把 helper 写在
 * installIpc() 里，它一调用就 ReferenceError —— 切服直接崩。probe / convert /
 * 识别 / 启动全部共用这一份，绝不重复定义（内层同名会遮蔽本版本）。
 */
const WEGAME_WUWA_ID = '2002137';
const WEGAME_WUWA_DIRNAME = 'Wuthering Waves(2002137)';
/** WeGame 只能靠 URI 拉起（直 spawn 主程序缺 Rail 票据会进不去，见 _wegame-launch-research.md）。 */
const WEGAME_LAUNCH_URI = 'wegame://action=StartFor&game_id=2002137';

/** UE 主程序在 Client\Binaries\Win64 下，根目录只有启动转发器；两层都认，兼容老存档 root 指到 Binaries 的情况。 */
function wuwaExeAt(root) {
  if (!root) return '';
  for (const candidate of [
    path.join(root, 'Client', 'Binaries', 'Win64', 'Client-Win64-Shipping.exe'),
    path.join(root, 'Client-Win64-Shipping.exe'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * 鸣潮客户端的「本体」判据：库洛官方客户端的安装根目录一定有
 * `launcherDownloadConfig.json`（它自己的下载器版本记账），而主程序在三层深的
 * `Client\Binaries\Win64` 下。
 *
 * 米哈游那套「根目录有 config.ini 才是完整客户端」的约定对鸣潮完全不成立 ——
 * 真实官服本体 `G:\Wuthering Waves Game` 根本没有 config.ini。于是老判据
 * 会把好好的客户端当成「资源替换包（增量包）」标成需要重建，官服行整行变灰、
 * 还要求用户重新选路径。传 exe 或它所在目录都行，返回找到的本体根目录。
 */
function wuwaClientRootOf(dirOrExe) {
  let dir = String(dirOrExe || '').trim();
  if (!dir) return '';
  if (path.extname(dir).toLowerCase() === '.exe') dir = path.dirname(dir);
  // normalize 一次：调用方可能传 "G:/xxx"（正斜杠）或带尾斜杠，返回给 server.root
  // 的必须是 Windows 形式，否则下次比较 !== 又把这一行当失效。
  dir = path.normalize(dir);
  for (let depth = 0; depth < 5 && dir; depth += 1) {
    if (fs.existsSync(path.join(dir, 'launcherDownloadConfig.json'))) return dir;
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return '';
}

/** 下载中目录的根（WeGameApps\downloading），转换功能的目标目录用。 */
function findWeGameDownloadRoots() {
  const roots = [];
  const seen = new Set();
  const push = (dir) => {
    if (!dir) return;
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(path.resolve(dir));
  };
  for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    push(`${drive}:\\WeGameApps\\downloading`);
  }
  try {
    for (const key of [
      'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\WeGame',
      'HKCU\\Software\\Tencent\\WeGame',
    ]) {
      try {
        const out = require('node:child_process').execSync(
          `reg query "${key}" /v InstallPath`,
          { encoding: 'utf8', timeout: 4000 }
        );
        const m = String(out).match(/InstallPath\s+REG_SZ\s+(\S+)/i);
        if (m) {
          const install = m[1];
          push(path.join(install, 'WeGameApps', 'downloading'));
          push(path.join(path.dirname(install), 'WeGameApps', 'downloading'));
        }
      } catch {}
    }
  } catch {}
  return roots.filter((dir) => fs.existsSync(dir));
}

/** 所有「装好/下载中」的 WeGame 鸣潮目录，按「下载中 → 已安装」顺序去重。 */
function findWeGameWuwaRoots() {
  const out = [];
  const seen = new Set();
  const push = (dir) => {
    if (!dir || !wuwaExeAt(dir)) return;
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(path.resolve(dir));
  };
  for (const root of findWeGameDownloadRoots()) push(path.join(root, WEGAME_WUWA_ID));
  for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    push(`${drive}:\\WeGameApps\\rail_apps\\${WEGAME_WUWA_DIRNAME}`);
  }
  return out;
}

/** 切服当源时取第一个可用的 WeGame 目录（含已安装版）。 */
function findWeGameWuwaRoot() {
  return findWeGameWuwaRoots()[0] || '';
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

/**
 * 这一行终末地的客户端现在能不能直接启动？—— **唯一权威判据**。
 *
 * 为什么要有这个函数：
 *   以前「客户端完整不完整」这件事散在 26 处各写各的判据：
 *   有的看 config.ini，有的看 runtimeLinked 字段，有的看目录标记，有的只看 exe 在不在。
 *   三套判据不一致的直接后果（用户报障，反复出现）：
 *     · 硬链接运行时明明生成好了、.hxl-endfield-runtime-v2 标记也在、后端也认它是完整客户端，
 *       但 launcher-data.json 里的 runtimeLinked 字段丢了（配置回滚 / 从旧版本升级 /
 *       手工改过配置 / 切服「尽力而为」分支没写回），界面就一直挂着「缺独立目录」；
 *     · 用户点「生成」重建一遍也没用，因为重建完字段可能又没写回去。
 *
 * 设计原则（与 Starward 同一思路）：**以文件系统事实为准，配置字段只做辅助**。
 *   字段对了说明记账没坏；字段坏了只要目录是好的，就不该判成缺。
 *
 * @param {object} game   游戏对象（要读 builtinKey / servers）
 * @param {object} server 服务器行
 * @returns {{ready:boolean, reason:string}}
 *   reason 取值：'official-direct' | 'runtime-dir' | 'runtime-field' |
 *                'config-ini' | 'missing-exe' | 'missing-runtime' | 'not-endfield'
 */
function endfieldClientReady(game, server) {
  if (!server) return { ready: false, reason: 'missing-exe' };
  if (!game || game.builtinKey !== 'endfield') return { ready: false, reason: 'not-endfield' };

  const channel = String(server.channel || '');
  const exe = String(server.path || '');
  const exeOk = Boolean(exe) && targetExists(exe);

  // 官服：直启官方本体，只要 exe 在就算就绪（不需要独立运行时）
  if (channel === 'official') {
    return exeOk ? { ready: true, reason: 'official-direct' } : { ready: false, reason: 'missing-exe' };
  }

  // 非官服：必须有自己的独立运行时
  const runtimeDir = String(server.root || '');

  // 走的是「旧单 work 混合目录」→ 就算 exe 在也不能用（启动 3~9 秒就崩）
  if (runtimeDir && isEndfieldLegacyWorkRoot(runtimeDir)) {
    return { ready: false, reason: 'missing-runtime' };
  }

  /*
   * ① 查记账库（借鉴 Starward 的 GameFileDatabase）——**最权威**。
   *
   * 这是替代「看一个布尔字段」的正解：记账里存了这个渠道运行时每个文件的
   * 路径 + Size + NTFS FileId。文件都在、大小没变、FileId 没变，就说明这份
   * 运行时是完好的 —— 不看任何 launcher-data.json 字段，也就不存在
   * 「字段丢了界面就永久报错、重建也修不回来」那个老问题。
   *
   * 校验是有成本的（要 stat 上千个文件），所以只在该渠道的记录存在时才做，
   * 且 checkFileId 只在文件数不多时开（fsutil 是 spawn，上万次会慢到不可用）。
   */
  if (runtimeDir) {
    try {
      const rows = gameFileDb.listChannelFiles('endfield', channel);
      if (rows.length) {
        // 记录里的路径必须落在当前 runtimeDir 下，否则是旧目录的记账（运行时搬过家）
        const dirNorm = path.resolve(runtimeDir).toLowerCase();
        const inDir = rows.filter((r) => String(r.Path || '').toLowerCase().startsWith(dirNorm + path.sep));
        if (inDir.length) {
          const checkFileId = inDir.length <= 200; // 小规模才逐个核 FileId
          const v = gameFileDb.verify(inDir, { checkFileId });
          if (v.ok) {
            return { ready: true, reason: 'db-verified', files: v.total };
          }
          /*
           * 记账说有问题：文件缺了 / 大小变了 / FileId 变了。
           * 这时**不能**直接判不就绪 —— 用户可能刚更新过客户端，记账还没来得及更新。
           * 往下走目录标记那条路；真要重建，调用方的 needsRebuild 会重新记账。
           */
        }
      }
    } catch {
      /* 记账库没开或读失败：往下走目录标记判据 */
    }
  }

  // ② 目录标记在 + exe 在 → 就绪（事实优先，不看字段）
  const dirHasMarker = Boolean(runtimeDir) && isEndfieldRuntimeDir(runtimeDir);
  if (dirHasMarker && exeOk) {
    return { ready: true, reason: 'runtime-dir' };
  }
  // ③ 字段说生成过 + exe 在 → 就绪（目录标记可能被清过，但记账还在、exe 也在）
  if (server.runtimeLinked === true && exeOk) {
    return { ready: true, reason: 'runtime-field' };
  }
  // ④ 运行时目录里有 config.ini（老架构运行时）也算
  if (runtimeDir && exeOk) {
    try {
      if (fs.existsSync(path.join(path.dirname(exe), 'config.ini'))) {
        return { ready: true, reason: 'config-ini' };
      }
    } catch {
      /* 读不到就当没有 */
    }
  }

  return { ready: false, reason: exeOk ? 'missing-runtime' : 'missing-exe' };
}

/*
 * 老用户升级上来的记账补齐。
 *
 * 场景：用户从旧版本升级，运行时目录是旧版建的、GameFile.db 里一条记录都没有。
 * 不做这个的话，这批人永远走「目录标记」那个旧判据 —— 能跑，但享受不到
 * 「查表验证完整性」的好处（文件被删/被改要等启动失败才发现）。
 *
 * 做法：启动后**后台**扫一遍已有运行时目录，把文件补记进库。
 *   · 不阻塞启动：放在 setTimeout 里，且全程 try/catch；
 *   · 已经有记录的渠道直接跳过（幂等）；
 *   · 只读目录、只写库，绝不碰运行时里的文件。
 */
async function backfillGameFileDb(game) {
  const report = { channels: 0, files: 0 };
  if (!game || game.builtinKey !== 'endfield') return report;
  if (!gameFileDb.isOpen()) return report;

  for (const server of game.servers || []) {
    const channel = String(server.channel || '');
    if (!channel) continue;
    const runtimeDir = String(server.root || '');
    if (!runtimeDir || !fs.existsSync(runtimeDir)) continue;
    // 官服直启本体，不需要记账（它的完整性由官方启动器维护）
    if (channel === 'official') continue;
    // 旧 work 混合目录不配记账（本来就要作废）
    if (isEndfieldLegacyWorkRoot(runtimeDir)) continue;
    // 已经有记录就不重复补
    try {
      const existing = gameFileDb.listChannelFiles('endfield', channel);
      if (existing.length > 0) continue;
    } catch {
      continue;
    }
    try {
      const files = await walkFiles(runtimeDir);
      if (!files.length) continue;
      for (const f of files) {
        try {
          gameFileDb.upsert({ path: f.full, gameKey: 'endfield', channel });
        } catch {
          /* 单个文件失败不影响其它 */
        }
      }
      gameFileDb.persist();
      report.channels += 1;
      report.files += files.length;
      writeLaunchLog('[endfield] 记账补齐：' + channel + ' 补了 ' + files.length + ' 个文件（' + runtimeDir + '）');
    } catch (error) {
      writeLaunchLog('[endfield] 记账补齐失败 ' + channel + '：' + (error && error.message));
    }
  }
  return report;
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
// 它们的 5 颗由各自 Gryphline 官方清单按同名
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
      // 2026-11-25 起游戏默认下载到「花筱灵下载」（跟设置里的下载目录一致），
      // 老版本装到 HuaXiaoLingGames 的也要继续认出来，两个都扫。
      '花筱灵下载',
      // 鸣潮 WeGame 版：下载中与已安装（装完 WeGame 会把目录从 downloading
      // 搬到 rail_apps），都纳入 exe 扫描根。walkExecutables 按当前游戏的
      // exe 名过滤，别的游戏不会误匹配。
      'WeGameApps\\downloading\\2002137',
      'WeGameApps\\rail_apps\\Wuthering Waves(2002137)',
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
 * 报障：切到国际服点开始游戏，进程 3 秒就退，Windows 事件日志是
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
  channel = '',
  copyDirs = ENDFIELD_RUNTIME_COPY_DIRS,
}) {
  const stagingRoot = `${runtimeRoot}.staging-${Date.now()}`;
  let staleRoot = '';
  // 下面两个变量原来声明在 if (fs.existsSync(runtimeRoot)) 块里，回滚分支要用，提到外面。
  let carried = false;
  const stagingPersistent = path.join(stagingRoot, 'Endfield_Data', 'Persistent');
  // staging 是否已经就位成正式目录：决定 catch 里能不能删 staging。
  let placed = false;
  // hardlinkTree 回传的落位清单：rename 到正式目录后再按最终路径记账（见 recordPlacedFiles）
  let placedFiles = null;
  await fsp.mkdir(path.dirname(runtimeRoot), { recursive: true });
  await fsp.rm(stagingRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {});
  try {
    const linkResult = await hardlinkTree({
      sourceRoot: baseRoot,
      targetRoot: stagingRoot,
      copyDirs,
      onProgress,
      signal,
      collectPlaced: true,
        gameKey: 'endfield',
    });
    placedFiles = linkResult.placedFiles || null;
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
    // ★ 语音包自愈：没有旧运行时可搬时，看备份里有没有 Persistent（用户以前下载过的语音包）。
    if (!carried) {
      const backupPersistent = path.join(app.getPath('userData'), 'endfield-persistent-backup', path.basename(runtimeRoot), 'Persistent');
      if (fs.existsSync(backupPersistent)) {
        try {
          await fsp.rm(stagingPersistent, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {});
          await fsp.mkdir(path.dirname(stagingPersistent), { recursive: true });
          await fsp.cp(backupPersistent, stagingPersistent, { recursive: true });
          carried = true;
          writeLaunchLog('[endfield] 重建运行时：从备份恢复 Endfield_Data\\Persistent（语音包等已下载内容）');
        } catch (error) {
          writeLaunchLog('[endfield] 重建运行时：恢复 Persistent 备份失败，游戏会重新下载语音包：' + (error && error.message));
        }
      }
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
    /*
     * 文件记账（借鉴 Starward）：把这一轮落位的文件记进 GameFile.db。
     *
     * 放在 rename 之后：hardlinkTree 是在 staging 目录里建的，rename 到 runtimeRoot
     * 之后路径才最终确定，这时记账才指向真实位置。
     *
     * 有了这份记账，以后判断「这个渠道的运行时装没装好」就不用再猜 launcher-data.json
     * 里那个 runtimeLinked 布尔字段了 —— 查表看文件在不在、FileId 对不对就行。
     * 这正是用户反复报的「硬链接完了还说客户端不完整」的根治方向。
     */
    if (placedFiles && placedFiles.length) {
      /*
       * 记账放到后台，不阻塞收尾。
       *
       * 用户实测（2026-11-26）：「终末地硬链接收尾的记账很慢」。
       * 根因：readFileId 每个文件 spawn 一次 fsutil，实测 52.8ms/次，
       * 2567 个文件就是约 136 秒 —— 全耗在创建子进程上，界面看起来卡死。
       *
       * 但记账本身只是辅助数据（用于以后判断运行时完不完整），
       * 不影响游戏文件、不影响启动。所以这里直接 fire-and-forget：
       * 收尾立刻返回，记账在后台慢慢跑，跑完自己落盘。
       */
      const placedSnapshot = placedFiles.slice();
      const rootSnapshot = runtimeRoot;
      const channelSnapshot = channel;
      setImmediate(() => {
        recordPlacedFilesAsync(placedSnapshot, rootSnapshot, {
          gameKey: 'endfield',
          channel: channelSnapshot,
        }, {
          onProgress,
          signal,
          progressEvery: 400,
        })
          .then((rec) => {
            writeLaunchLog(
              `[endfield] 文件记账（后台完成）：${rec.recorded} 条${rec.failed ? `（失败 ${rec.failed}）` : ''} → ${rootSnapshot}`
            );
          })
          .catch((error) => {
            writeLaunchLog(`[endfield] 文件记账失败（不影响运行时本身）：${error && error.message}`);
          });
      });
      writeLaunchLog(`[endfield] 文件记账已转后台（${placedFiles.length} 个文件），收尾不等它`);
    }
    /*
     * ★ 语音包误弹修复（2026-11-13）：
     * 官服版 Persistent 的 4 个索引 json（index_initial/index_main/pref_initial/pref_main）
     * 记录的是官服渠道的「已下载语音包」状态。国际服/Play/Steam 渠道全新重建时
     * （无旧运行时可搬、也无该渠道备份），这份官服索引会被原样灌进国际服运行时，
     * 国际服客户端按它自己渠道的清单逐条核对对不上 → 弹「下载中文/日文语音包 3.9G」。
     * 处理：这三种渠道落位后，检测 Persistent 4 json 是否与官服基线一致（一致=官服
     * 灌来的），是就把索引删掉、保留 VFS chk —— 客户端回到「初始态自扫」判定，
     * 与早期 142MB 小包时代「硬链接过去不弹下载」的行为一致。
     * 注意只在「没有搬旧运行时、也没有该渠道备份」这个全新场景动手：carried=true
     * 说明搬的是用户自己的国际服态，绝不能动。官服/B服渠道不进这个分支。
     */
    if (!carried && channel && !['official', 'bilibili'].includes(channel)) {
      try {
        const runtimePersistent = path.join(runtimeRoot, 'Endfield_Data', 'Persistent');
        const indexes = [
          ['index_initial.json', '4b3530e7cb455b9b23cdf373a9135226'],
          ['index_main.json', '7a7f47fef9c9eee3169f13b9396a8485'],
          ['pref_initial.json', '67816d833950ddb25308d0aabd3d50d9'],
          ['pref_main.json', 'd9e3eff101f8ed51888b381f90a4692f'],
        ];
        let removed = 0;
        for (const [name, officialMd5] of indexes) {
          const file = path.join(runtimePersistent, name);
          if (!fs.existsSync(file)) continue;
          const actual = crypto.createHash('md5')
            .update(await fsp.readFile(file))
            .digest('hex');
          if (actual === officialMd5) {
            await fsp.rm(file, { force: true });
            removed += 1;
          }
        }
        if (removed > 0) {
          writeLaunchLog(`[endfield] 国际服渠道全新重建：已重置 ${removed} 个官服版语音索引 json（保留 VFS chk，客户端首启自扫，避免误弹下载语音包）`);
        }
      } catch (error) {
        writeLaunchLog('[endfield] 重置国际服语音索引失败（不影响本次运行）：' + (error && error.message));
      }
    }
    /*
     * ★ 语音包备份已取消（2026-11-19），这一段原来会把 Persistent 整份拷到 userData：
     *     endfield-persistent-backup/<渠道>/Persistent  （每渠道约 3.7 GB，两个渠道 7.39 GB）
     *
     * 为什么可以取消：
     *   1. Persistent 下的 .chk 现在走硬链接（见 runtime.js 的 HARDLINK_ALLOW_PAIRS）。
     *      基础客户端里就有同一批 .chk（官服本体 Persistent 3.75 GB / 208 个文件），
     *      重建时直接从基础客户端链过来，不需要备份兜底。
     *   2. 索引类（.json / .blc 合计 61 MB）本来就强制拷贝，代价可以忽略。
     *   3. 真正会丢的是「该渠道自己新下的、基础客户端里没有的 .chk」—— 这类场景由
     *      上面 :4969-4981 的 rename 搬运兜住（carried = true，同卷瞬间完成、不占空间）。
     *   备份只在「旧运行时目录整个被删 / 搬不动」这种边角情况下才有意义，
     *   为了它常驻 7.39 GB 不划算。
     *
     * 兼容：下面 :5013-5028 的「从备份恢复」分支原样保留，老用户已经存在的备份
     * 照样能读；历史备份由 cleanupLegacyEndfieldBackup() 一次性清掉。
     */
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

  /*
   * 渠道隔离性当场自检（借鉴 Starward 的「以文件系统事实为准」）。
   *
   * 放在这里是因为：**隔离问题就是在这一步产生的**（purge 清漏了 → SDK 混入；
   * overlay 没覆盖到 → 差异文件链错；reconcile 误删了 → 缺通用件）。当场发现，
   * 用户还没点「开始游戏」，就不会撞上「点开始 3 秒闪退」再回来报障。
   *
   * 只查根目录一层（+ sdkdata 一层）—— 隔离问题全部发生在这一层，开销是几次
   * readdir、几十毫秒。刻意不做递归 inode 比对：那要 stat 上万个文件，属于
   * 「离线体检」的活（见工作区 _verify-endfield-channel-isolation.js），
   * 不该塞进用户每次切服的路径里。
   *
   * 检查失败绝不阻断生成流程 —— 一条日志 + 一条 toast 就够。
   */
  try {
    const iso = endfieldIsolation.checkChannelRuntimeIsolation(workRoot, channel);
    if (!iso.ok) {
      writeLaunchLog(
        '[endfield] ⚠ 渠道隔离自检发现问题（' + channel + '，检查 ' + iso.checked + ' 个根条目）：' +
        iso.problems.join('；')
      );
      send('toast', {
        type: 'error',
        message:
          '「' + channel + '」运行时自检发现问题：' + iso.problems[0] +
          (iso.problems.length > 1 ? ' 等 ' + iso.problems.length + ' 项' : '') +
          '。建议在服务器行上点「重新生成」。',
      });
    }
  } catch (error) {
    writeLaunchLog('[endfield] 渠道隔离自检自身异常（不影响生成）：' + (error && error.message));
  }

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

  /*
   * 硬链接运行时生成也走计量器（sendProgress），否则启动页那块统一面板拿不到
   * bytesPerSec / etaSeconds / rows，只会在「硬链接生成」时显示一行文字 —— 用户 2026-11-11
   * 明确要求硬链接生成过程也要有和下载更新一样的小面板。
   * 这条链路没有 jobId，用 server.id 当键：同一个服务器的多次生成共用一份采样，正合适。
   */
  const emit =
    typeof options.onProgress === 'function'
      ? options.onProgress
      : (progress) => sendProgress('endfield:progress', server.id, { ...progress, serverName: server.name });

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
      channel,
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
  // 台服（繁中，Gryphline 直营）自带 gfsdk.dll / glfoundation.dll，和官服/B服都不一样
  if (fs.existsSync(path.join(root, 'gfsdk.dll'))) return 'taiwan';
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

/**
 * 明日方舟 Yostar 三区互为源的硬链接运行时：
 *   目标渠道的「安装目录」如果还不存在，就从**另一个区**的现有安装目录生成；
 *   如果用户已经自己装了目标区（目录存在且元数据可信），什么都不做、直接沿用。
 *
 * 源的优先级：先找「元数据可信且 tag 是别的区」的目录；多个可用时挑清单版本最接近
 * 的（版本越近差异件越少）。生成的目录就是一套完整 Yostar 客户端（buildCrossRuntime
 * 最后会写目标区自己的元数据），后续「更新本体 / 修复游戏」全部走既有 Yostar 链路。
 */
async function ensureArknightsYostarRuntime(game, server, options = {}) {
  const emit = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const targetRoot = server.root ? path.resolve(server.root) : '';
  const targetExe = targetRoot ? path.join(targetRoot, 'Arknights.exe') : '';

  // 用户已经把目标区装好了：直接沿用，不做任何写盘动作
  if (targetRoot && fs.existsSync(targetRoot) && fs.existsSync(targetExe)) {
    const meta = await yostarPacks.detectChannelOf(targetRoot).catch(() => '');
    if (meta && meta !== server.channel) {
      // 目录是别的区的（用户把 root 指错了），不能拿它当目标区启动，继续走生成流程
    } else {
      return false; // false = 没有生成运行时，但目录本身可直接启动
    }
  }
  if (!targetRoot) return false;

  // 找源：另一个区的现有安装目录（root 存在 + Arknights.exe 在 + 元数据 tag 是别的 Yostar 区）
  const candidates = [];
  for (const item of game.servers || []) {
    if (item.id === server.id) continue;
    if (!yostarPacks.isYostarChannel(item.channel) || item.channel === server.channel) continue;
    const root = item.root ? path.resolve(item.root) : '';
    if (!root || !fs.existsSync(root) || !fs.existsSync(path.join(root, 'Arknights.exe'))) continue;
    if (path.resolve(root).toLowerCase() === path.resolve(targetRoot).toLowerCase()) continue;
    const meta = await yostarPacks.detectChannelOf(root).catch(() => '');
    if (meta && meta !== item.channel) continue; // 元数据对不上（指错目录），不安全
    candidates.push({ channel: item.channel, root });
  }
  if (!candidates.length) {
    emit({
      phase: 'error',
      current: `还没有别的国际服安装目录可以当源：先用「下载游戏」装出 ${server.channel} 之外的任意一个区，之后就能互切`,
    });
    return false;
  }
  // 多个源时挑「本地清单版本与目标清单最近」的没太大意义（三区版本本来就不齐），直接取第一个
  const source = candidates[0];

  const runtime = runtimePaths(source.root, 'arknights', server.channel, options.runtimeRoot || '');
  if (!runtime.sameDrive) {
    throw new Error(
      `运行时目录必须和源客户端（${source.root}）在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`
    );
  }
  if (path.resolve(source.root).toLowerCase() === path.resolve(runtime.target).toLowerCase()) {
    throw new Error('运行时目录不能和源客户端是同一个目录，请换个“运行时目录”再试');
  }

  // 目标运行时已经存在且元数据可信：不管标记直接校验（防止旧标记骗过）
  const existingMeta = await yostarPacks.detectChannelOf(runtime.target).catch(() => '');
  if (existingMeta === server.channel && fs.existsSync(path.join(runtime.target, 'Arknights.exe'))) {
    server.path = path.join(runtime.target, 'Arknights.exe');
    server.rootDir = server.root || runtime.target;
    server.root = runtime.target;
    server.runtimeLinked = true;
    server.legacyRuntime = false;
    return true;
  }

  emit({ phase: 'start', processed: 0, total: 0, current: `正在从 ${source.channel} 生成 ${server.channel} 运行时…` });
  const result = await yostarPacks.buildCrossRuntime({
    sourceRoot: source.root,
    targetProfile: server.channel,
    installRoot: runtime.target,
    signal: options.signal,
    onProgress: (progress) => emit({ ...progress, current: progress.current || '' }),
  });
  if (!result?.ok) return false;

  server.path = path.join(runtime.target, result.executable || 'Arknights.exe');
  server.rootDir = server.root || runtime.target;
  server.root = runtime.target;
  server.runtimeLinked = true;
  server.legacyRuntime = false;
  emit({
    phase: 'done',
    processed: 1,
    total: 1,
    current: `完成：硬链接 ${result.linked} 个、下载 ${result.downloaded} 个。确认能正常进游戏后，另一个渠道的安装目录可以卸载（两边互为硬链接，互不影响）。`,
  });
  return true;
}

/**
 * 明日方舟台服运行时：整树硬链接国服客户端，再按台服官方清单逐文件核对补齐。
 *
 * 为什么不能套 Yostar 三区那套（三区互为源、逐文件 CRC64）：
 *   台服是 Gryphline 直营的第三套发行，走 batch_proxy + md5 清单（与国服同协议），
 *   和 Yostar 区的 CRC64 清单口径完全不同 —— 拿对方的清单去核对只会全量下载。
 *
 * 为什么不能套「官服目录 + 渠道小包覆盖」那套：
 *   实测台服与国服同名不同内容的文件有 48 个根级 dll，差异面一直覆盖到
 *   GameAssembly.dll 与 Arknights_Data 资源 —— 不是几件 SDK 能盖住的。
 *   所以走「整树硬链（先白拿 35% 一模一样的文件）→ 再按台服清单逐文件 md5 核对，
 *   不一致的从台服 CDN 补下」这条路。
 */
async function ensureArknightsTaiwanRuntime(game, server, options = {}) {
  if (game.builtinKey !== 'arknights') return false;
  /*
   * 源只能是国服官服 / B服 已装客户端：台服清单里 Arknights.exe 与国服
   * 同名不同 md5，整树硬链过来的是国服那份，必须靠后面的清单核对替换掉。
   */
  const source = (game.servers || []).find((item) => {
    if (item.id === server.id) return false;
    if (!['official', 'bilibili'].includes(String(item.channel || ''))) return false;
    if (!item.root || !fs.existsSync(item.root)) return false;
    return fs.existsSync(path.join(item.root, 'Arknights.exe'));
  });
  if (!source) return false;
  const runtime = runtimePaths(source.root, 'arknights', 'taiwan', options.runtimeRoot || '');
  if (!runtime.sameDrive) return false;
  const emit = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  await fsp.mkdir(runtime.target, { recursive: true });
  const entries = await fsp.readdir(source.root, { withFileTypes: true });
  let index = 0;
  for (const entry of entries) {
    if (entry.name === '.vela-runtime') continue;
    index += 1;
    emit({ phase: 'link', processed: index, total: entries.length, current: `正在准备 ${entry.name}` });
    const target = path.join(runtime.target, entry.name);
    if (fs.existsSync(target)) continue;
    const from = path.join(source.root, entry.name);
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
   * 清掉国服专属件：台服用的是 gfsdk.dll / glfoundation.dll / sdk_glsdk_config.*，
   * 国服的 hgsdk.dll 与 sdk_hgsdk_config.* 留着会让客户端走错发行商。
   */
  for (const name of ['hgsdk.dll', 'sdkdata']) {
    await fsp.rm(path.join(runtime.target, ...arknightsSegments(name)), {
      recursive: true,
      force: true,
    });
  }
  /*
   * 按台服官方清单逐文件核对：md5 相同的就是硬链过来那份（省下 35%），
   * 不同的从 ak-tw.hg-cdn.com 补下；台服独有的文件（AntiCheatExpert/ 等）也会在这里补齐。
   */
  await updateEndfieldGame({
    root: runtime.target,
    channel: 'taiwan',
    force: true,
    linkSources: [source.root],
    onProgress: emit,
  });
  const executable = path.join(runtime.target, 'Arknights.exe');
  if (!fs.existsSync(executable)) return false;
  server.path = executable;
  server.rootDir = source.root;
  server.root = runtime.target;
  server.runtimeLinked = true;
  server.legacyRuntime = false;
  return true;
}

async function ensureArknightsRuntime(game, server, options = {}) {
  if (game.builtinKey !== 'arknights') return false;
  if (!server.root || server.root.includes('VelaRuntimes')) return false;
  /*
   * Yostar 三区（EN / JP / KR）互为源：拿另一个区的安装目录当源，相同 CRC64 的文件
   * 硬链接复用（实测三区共有 1.97GiB），差异件（EN↔JP 约 1.4GB）按 Yostar 清单下载。
   * 国服 / B服 和三区是两套发行商的客户端（国服只有 21.9GB 分卷 zip、没有逐文件清单），
   * 与三区之间不做互切。没有另一个区的目录可用时，三区渠道就维持原样 —— 用户先用
   * 「下载游戏」或官方启动器装出第一个区，之后才有源可链。
   */
  if (yostarPacks.isYostarChannel(server.channel)) {
    return ensureArknightsYostarRuntime(game, server, options);
  }
  // 台服（繁中）：整树硬链国服客户端 + 按台服清单逐文件核对
  if (server.channel === 'taiwan') {
    return ensureArknightsTaiwanRuntime(game, server, options);
  }
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

/**
 * 鸣潮官服 ↔ B服 硬链接切服（2026-11-11 用户拍板，参考 Xel/三服切换器思路但用官方清单）。
 *
 * 实测收益（v3.7.1 官方 index.json 交叉）：same 847 文件/79.91GiB（99.24%），
 * 差异 68 + 仅B服 71 ≈ 切服只下 1.3GiB。国际服与国服 pak 全部不同（0.4%），
 * **不做互切**——global 渠道在这里原样返回（用户用「下载游戏」直接装国际服）。
 *
 * 与方舟/终末地那套「官服目录 + 渠道包覆盖」不同：鸣潮没有渠道包概念，差异件直接
 * 从库洛官方 CDN 按 md5 清单下载（kuroPacks.buildCrossRuntime 三步走）。
 */
async function ensureKuroRuntime(game, server, options = {}) {
  if (game.builtinKey !== 'wutheringwaves') return false;
  const channel = String(server.channel || '');
  // 国际服与其它渠道差异约 98%，不做硬链接互切；WeGame 版自己就是
  // 一份完整客户端、启动走 wegame:// URI，也不需要生成运行时。
  if (channel === 'global' || channel === 'wegame') return false;
  if (!['official', 'bilibili'].includes(channel)) return false;

  const emit = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  /*
   *  / ：已经装好的渠道客户端（官服、B服都一样）点「切换」就该
   * 直接切，不该再跑一遍硬链接生成；官服也不是什么「权威源」，只是恰好装好了而已。
   * 只有「这个渠道还没有能启动的客户端」时才生成运行时，入口是设置弹窗里的
   * 「硬链接生成一份」（会走到 servers:activate，守卫已在那里放宽）。
   */
  const alreadyInstalled =
    Boolean(server.path) &&
    targetExists(server.path) &&
    !server.runtimeLinked &&
    Boolean(server.root) &&
    !String(server.root).includes('VelaRuntimes') &&
    /*
     * 还要确认这份客户端「自己声明的渠道」就是这一行。
     * 老数据里 B服 行可能指着官服本体（被第三方三服切换器改过 config.ini，
     * 目录其实是官服的），这时界面显示绿灯、点切换却启动的还是官服。
     * 渠道对不上就不算「已装好」，继续往下走去生成一份独立的。
     */
    (() => {
      const root = wuwaClientRootOf(server.path) || server.root || '';
      const declared = root ? kuroPacks.detectChannelOfSync(root) : '';
      // 读不出特征 = 官服（库洛官服没有专属目录特征）
      const actual = declared || 'official';
      return actual === channel;
    })();
  if (alreadyInstalled) return false;

  // 先找「另一个渠道」的完整客户端当源：官服 / B服 / WeGame 任意互相为源
  // 国际服差异太大排除。
  const candidates = (game.servers || []).filter(
    (item) =>
      ['official', 'bilibili'].includes(String(item.channel || '')) &&
      item.channel !== channel &&
      item.root &&
      !String(item.root).includes('VelaRuntimes') &&
      wuwaExeAt(item.root)
  );
  const wegameRoot = findWeGameWuwaRoot();
  if (wegameRoot && wuwaExeAt(wegameRoot)) {
    candidates.push({ channel: 'wegame', root: wegameRoot, name: 'WeGame 版', isWeGame: true });
  }
  if (!candidates.length) {
    emit({
      phase: 'error',
      current: `还没有另一个鸣潮渠道的安装目录可以当源（需要官服、B服 或 WeGame 的完整客户端）。请先用「下载游戏」或官方启动器装一个，再回来生成${channel === 'bilibili' ? 'B服' : '官服'}运行时。`,
    });
    return false;
  }
  // WeGame 版排在最后：优先用官方体系内的源（渠道件差异最小），WeGame 兜底
  candidates.sort((a, b) => (a.isWeGame ? 1 : 0) - (b.isWeGame ? 1 : 0));

  // 未配置的渠道没有自己的 root，就拿「源」的盘算运行时目录（runtimePaths 只关心同盘）。
  const baseRoot =
    server.root && !String(server.root).includes('VelaRuntimes') ? server.root : candidates[0].root;
  const runtime = runtimePaths(baseRoot, 'wutheringwaves', channel, options.runtimeRoot || '');
  if (!runtime.sameDrive) return false;
  await fsp.mkdir(runtime.target, { recursive: true });

  // 目标运行时已经是目标渠道的完整客户端（我方元数据可信）→ 直接沿用
  const existingChannel = await kuroPacks.detectChannelOf(runtime.target).catch(() => '');
  const runtimeExe = wuwaExeAt(runtime.target);
  if (existingChannel === channel && runtimeExe) {
    server.path = runtimeExe;
    server.rootDir = server.root;
    server.root = runtime.target;
    server.runtimeLinked = true;
    server.legacyRuntime = false;
    return true;
  }
  // 现有运行时若是别的渠道，也是一份完整客户端，可以当源（避免又去动别的安装目录）
  if (existingChannel && existingChannel !== channel && runtimeExe) {
    candidates.push({ channel: existingChannel, root: runtime.target, name: `现有运行时（${existingChannel}）` });
  }
  const source = candidates[0];

  emit({ phase: 'link', processed: 0, total: 0, current: `正在以${source.name || source.channel}为源生成${channel === 'bilibili' ? 'B服' : '官服'}运行时…` });
  const result = await kuroPacks.buildCrossRuntime({
    sourceRoot: source.root,
    targetProfile: channel,
    installRoot: runtime.target,
    signal: options.signal,
    onProgress: emit,
  });

  // 主程序在 Client\Binaries\Win64\ 下；写回必须用真实路径，否则下次启动会因
  // server.path 不存在把这一行标成「需要重建」。
  server.path =
    wuwaExeAt(runtime.target) ||
    path.join(runtime.target, 'Client', 'Binaries', 'Win64', result.executable || 'Client-Win64-Shipping.exe');
  server.rootDir = server.root;
  server.root = runtime.target;
  server.runtimeLinked = true;
  server.legacyRuntime = false;
  emit({
    phase: 'done',
    processed: 1,
    total: 1,
    current: `完成：硬链接 ${result.linked} 个、下载 ${result.downloaded} 个（${((result.downloadBytes || 0) / 1024 ** 3).toFixed(2)} GB）。确认能正常进游戏后，另一个渠道的安装目录可以卸载（两边互为硬链接，互不影响）。`,
  });
  return true;
}

/**
 * 这个渠道能不能被「切过去」（2026-11-17，bug 3）。
 *
 * 鸣潮国际服（global）和 WeGame 版**不生成独立运行时**
 * （ensureKuroRuntime 开头就是 `if (channel === 'global' || channel === 'wegame') return false;`），
 * 它们只能指向自己那份已经装好的客户端。而 servers:activate 那边原来不检查这个返回值，
 * 照样执行 `game.activeServerId = server.id; game.target = server.path;` ——
 * 一旦这一行没有自己的客户端目录（server.path 为空或文件不在），切过去之后
 * target 是空的、界面上却是绿灯，点启动直接失败，而且切不回来。
 *
 * 判据：只有「鸣潮 + global/wegame + 自己没有可用的客户端目录」才判不可切。
 * 有自己的客户端（server.path 存在）时照常允许切 —— WeGame 版就是这么用的。
 *
 * 调用方（electron/servers-ipc.js）在 servers:activate 里切之前问一句：
 *   if (typeof kuroChannelSwitchable === 'function' && !kuroChannelSwitchable(game, server)) return;
 */
function kuroChannelSwitchable(game, server) {
  if (!game || !server) return false;
  if (game.builtinKey !== 'wutheringwaves') return true;
  const channel = String(server.channel || '');
  if (!['global', 'wegame'].includes(channel)) return true;
  // 自己有可用的客户端目录（WeGame 已安装 / 国际服已装好）就允许切。
  if (server.path && targetExists(server.path)) return true;
  return false;
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
      powershellExe(),
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
        powershellExe(),
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
      powershellExe(),
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
        // 台服是 Gryphline（鹰角海外品牌）直营的繁中服，公司名与国服不同
        else if (/gryphline/i.test(company)) channel = 'taiwan';
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
  /*
   * 2026-11-17（）：
   * config.ini 会被第三方三服切换器改（官服本体的 cps 被写成 bilibili），
   * 光看 ini 会把官服本体判成 B服。所以对米哈游四款再叠一层「文件层」复核：
   * 真 B服客户端带 BLPlatform64 渠道 SDK，没有的就是官服本体被改了 ini。
   */
  if (MIHOYO_RUNTIME_KEYS.includes(key)) {
    const resolved = clientChannel.resolveChannelFromRoot(path.dirname(exePath));
    if (resolved.channel) return resolved.channel;
  }
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
  /*
   * 鸣潮的渠道写在文件特征上（我方下载会写 kuro-launcher-config.json 元数据；
   * 官方客户端按渠道判据：KRSDKRes/Bilibili/ 目录 = B服、ThirdParty/KrPcSdk_Global
   * = 国际服、都没有 = 官服）。detectChannelOfSync 先查元数据再看目录特征，
   * 都认不出来才回落到路径提示 / 官服。
   */
  if (key === 'wutheringwaves') {
    // WeGame 版（downloading\2002137 或已安装的 rail_apps\Wuthering Waves(2002137)）
    // 是独立渠道行，绝不落进官服：否则扫描到的 WeGame 客户端会被写进官服行，
    // 「WeGame」那一行永远点不亮。kuro-packs 的
    // detectChannelOfSync 只认 bilibili/global，不认 wegame，所以在这里先判。
    if (/WeGameApps/i.test(exePath)) return 'wegame';
    /*
     * 2026-11-17（bug 1）：这里原来传的是 exe 所在目录（...\Client\Binaries\Win64），
     * 而 kuro-packs 的 detectChannelOfSync(installRoot) 判据是**相对本体根**的路径
     * （KRSDKRes/Bilibili = B服、Client/Binaries/Win64/ThirdParty/KrPcSdk_Global =
     * 国际服）。本体根在三层深（本体根\launcherDownloadConfig.json 认定），主程序
     * 却在本体根\Client\Binaries\Win64 下 —— 传 exe 目录必然判不到特征，
     * B服 / 国际服客户端恒定落回兜底的 'official'。
     * 修法：传本体根（wuwaClientRootOf 对 exe 或目录都认，找不到再退回 exe 目录）。
     */
    const wuwaRoot = wuwaClientRootOf(exePath) || path.dirname(exePath);
    const kuro = kuroPacks.detectChannelOfSync(wuwaRoot);
    if (kuro) return kuro;
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

/*
 * 这个目录是不是已经被别的渠道行占用了。
 *
 * 2026-11-17（）：
 * 每个渠道都该有一份独立的硬链接运行时，非官服渠道绝不能和官服指向同一个目录 ——
 * 否则「切到 B服」实际切的还是官服那份客户端，渠道配置、登录态、画质包全都串了。
 *
 * 只比 root（本体根），path 比 root 更严（exe 在 root 下面），root 相同就一定冲突。
 * 官服行本身不算冲突源：官服是本体，其它渠道都该从它「派生」出独立目录，
 * 而不是「指着它」。
 */
function rootUsedByOtherChannel(game, server, root) {
  const target = String(root || '').replace(/[\\/]+$/, '').toLowerCase();
  if (!target) return false;
  return (game.servers || []).some((item) => {
    if (!item || item === server) return false;
    if (item.channel === server.channel) return false;
    const other = String(item.root || '').replace(/[\\/]+$/, '').toLowerCase();
    if (!other) return false;
    if (other === target) return true;
    // 一方是另一方的子目录也算冲突（B服的目录嵌在官服目录里）
    return other.startsWith(`${target}\\`) || other.startsWith(`${target}/`);
  });
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
    // 鸣潮（含 WeGame 版）必须进这张表：discoverBuiltinServers 开头
    // 「!execNames[game.builtinKey] → continue」会把整个游戏跳过，自动扫描
    // 永远找不到 WeGame 已安装目录。
    wutheringwaves: ['Client-Win64-Shipping.exe', 'Wuthering Waves.exe'],
    // 异环：之前这张表没有它，自动扫描在下面
    // 「!execNames[game.builtinKey] → continue」处把整个游戏跳过了 ——
    // 装了异环的用户点「自动检测」永远扫不出来（审计 P1）。
    // 主程序名与 GAME_DETECTION.neverness.exe 一致。
    neverness: ['HTGame.exe'],
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
        /*
         * 鸣潮自愈：
         *
         * 官服 / B服 行曾被「硬链接生成一份」指到 VelaRuntimes 里的独立运行时，
         * 那个运行时目录后来被清理/搬家后，server.path 就悬在一条已经不存在的路径上，
         * 而真实客户端还好好装在 rootDir / originalRoot 记着的原地。这是纯记账失效，
         * 不是用户删了游戏 —— 直接按记账把 path/root 收回去，别让用户重新选路径。
         *
         * 只处理「指向运行时目录且已失效」的行；渠道必须由目标目录自证一致
         * （官服行绝不能收回到 B服 / 国际服的客户端上）。多用户产品级代码自愈，
         * 不手改 launcher-data.json。
         */
        if (game.builtinKey === 'wutheringwaves') {
          const stalePath = String(server.path || '');
          const pointsIntoRuntime = /[\\/]velaruntimes[\\/]/i.test(stalePath);
          if (pointsIntoRuntime && ['official', 'bilibili', 'global'].includes(String(server.channel || ''))) {
            const remembered = String(server.rootDir || server.originalRoot || '').trim();
            // 回填目标必须是一个「真安装目录」：它自己再指向 VelaRuntimes 就是同一类
            // 记账失效（运行时搬家前的旧记录），回填过去只是把一个坏路径换成另一个，没意义。
            const rememberedUsable =
              remembered && !/[\\/]velaruntimes[\\/]/i.test(remembered);
            const healedExe = rememberedUsable ? wuwaExeAt(remembered) : '';
            const healedChannel = healedExe ? kuroPacks.detectChannelOfSync(remembered) : '';
            // healedChannel 为空表示「没有任何 B服 / 国际服 特征」＝官服，这是正常结果。
            const channelOk =
              !healedChannel ||
              healedChannel === server.channel ||
              (server.channel === 'official' && healedChannel === 'official');
            if (healedExe && channelOk) {
              server.path = healedExe;
              server.root = path.normalize(remembered);
              server.rootDir = '';
              server.runtimeLinked = false;
              server.legacyRuntime = false;
              server.incomplete = false;
              server.packPath = '';
              server.unavailable = false;
              changed += 1;
              writeLaunchLog(
                `wutheringwaves stale runtime path healed: ${server.name}(${server.channel}) → ${server.root}`
              );
              if (game.activeServerId === server.id) {
                game.target = healedExe;
                game.workDir = server.root;
              }
              continue;
            }
          }
        }
        // 启动程序暂时不在（外接盘未挂载、盘符变化）：
        // 用户手动保存过的路径原样保留，只标记为「暂时不可用」。
        if (server.confirmed) {
          server.incomplete = false;
          server.unavailable = true;
          changed += 1;
          continue;
        }
        /*
         * 置「不完整」之前先问一次权威判据：上面的识别逻辑可能漏了某条
         * （历史上漏过 Yostar 三区 / 米哈游运行时 / 鸣潮官服 / 终末地运行时目录），
         * 而 endfieldClientReady 只看文件系统事实，它说就绪就不该把这一行标坏。
         */
        if (game.builtinKey === 'endfield' && endfieldClientReady(game, server).ready) {
          if (server.incomplete) {
            server.incomplete = false;
            server.packPath = '';
            changed += 1;
          }
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
      /*
       * 终末地「是不是完整客户端」统一走 endfieldClientReady（唯一权威判据）。
       * 原来这里只看 runtimeLinked 字段 or 目录标记，和 needsRuntime、扫描路径
       * 各有各的写法 —— 三套不一致正是「硬链接完还说不完整」的根源。
       */
      const isEndfieldRuntime =
        game.builtinKey === 'endfield' && endfieldClientReady(game, server).ready;
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
      /*
       * 我们自己生成的渠道运行时（<盘>:\VelaRuntimes\<game>\<channel>）是完整客户端。
       *
       * 原来的判据只认「config.ini 与 SDK 自证出同一个渠道」。问题在于生成链路的
       * 开关是串行的：hardlinkTree → 装渠道 SDK → 写 config.ini。中间任何一步失败
       * （最典型的是解压渠道 SDK 时 PowerShell 起不来），config.ini 就停在从官服
       * 硬链接过来的那版（cps=hyp_mihoyo），于是 resolveChannelFromRoot 判成 official、
       * 与 server.channel 不符 → 这一行被打成 incomplete，界面显示「客户端不完整」；
       * 而 server.path 指向的 exe 是好的，用户根本不知道发生了什么。
       *
       * 所以补一条：生成流程自己写了 runtimeLinked 标记的，就以它为准。
       * 仍然是「路径在 VelaRuntimes 下 + 由我方生成」双条件，不会把随便一个目录认成客户端。
       */
      const isMihoyoLinkedRuntime =
        isMihoyoRuntimeDir(dir, game.builtinKey) &&
        targetExists(server.path) &&
        (server.runtimeLinked === true ||
          clientChannel.resolveChannelFromRoot(dir).channel === server.channel ||
          clientChannel.pathChannelHint(server.path) === server.channel);
      // 鸣潮 WeGame 版（rail_apps\Wuthering Waves(2002137)）没有 config.ini，
      // 它自己的身份文件是 rail_files\rail_game_identify.json + WeGameLauncher\。
      // 不认它的话每次启动都被标成「需要重建」，用户明明装好了却点不亮 WeGame 行。
      const isWeGameWuwa =
        game.builtinKey === 'wutheringwaves' &&
        server.channel === 'wegame' &&
        (fs.existsSync(path.join(dir, 'rail_files', 'rail_game_identify.json')) ||
          /[\\/]wegameapps[\\/]/i.test(dir));
      // 鸣潮官方体系的客户端（官服 / B服 / 国际服）根本没有 config.ini，它的本体
      // 判据是根目录里的 launcherDownloadConfig.json。不认这条，每次启动都会把
      // 装好的客户端标成「需要重建」—— 官服行变灰、还要求重新选路径。
      const isKuroClient =
        game.builtinKey === 'wutheringwaves' && Boolean(wuwaClientRootOf(dir));
      const hasConfig =
        fs.existsSync(path.join(dir, 'config.ini')) ||
        isEndfieldRuntime ||
        isYostarClient ||
        isMihoyoLinkedRuntime ||
        isWeGameWuwa ||
        isKuroClient;
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
        /*
         * 置「不完整」之前先问一次权威判据：上面的识别逻辑可能漏了某条
         * （历史上漏过 Yostar 三区 / 米哈游运行时 / 鸣潮官服 / 终末地运行时目录），
         * 而 endfieldClientReady 只看文件系统事实，它说就绪就不该把这一行标坏。
         */
        if (game.builtinKey === 'endfield' && endfieldClientReady(game, server).ready) {
          if (server.incomplete) {
            server.incomplete = false;
            server.packPath = '';
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
          (clientChannel.resolveChannelFromRoot(exeDir).channel === channel ||
            clientChannel.pathChannelHint(exePath) === channel) &&
          targetExists(exePath)) ||
        (game.builtinKey === 'wutheringwaves' &&
          channel === 'wegame' &&
          /[\\/]wegameapps[\\/]/i.test(exeDir)) ||
        // 鸣潮官方体系（官服 / B服 / 国际服）的客户端没有 config.ini，本体判据是
        // 根目录里的 launcherDownloadConfig.json。少了这条，真实官服本体扫到了也
        // 会被当成「资源替换包」跳过，server.path 永远写不回去 —— 官服行一直是灰的。
        (game.builtinKey === 'wutheringwaves' && Boolean(wuwaClientRootOf(exeDir)));
      if (!isCompleteClient) {
        if (!server.path || !targetExists(server.path)) {
          /*
           * 置「不完整」之前先问一次权威判据：上面的识别逻辑可能漏了某条
           * （历史上漏过 Yostar 三区 / 米哈游运行时 / 鸣潮官服 / 终末地运行时目录），
           * 而 endfieldClientReady 只看文件系统事实，它说就绪就不该把这一行标坏。
           */
          if (game.builtinKey === 'endfield' && endfieldClientReady(game, server).ready) {
            if (server.incomplete) {
              server.incomplete = false;
              server.packPath = '';
              changed += 1;
            }
            continue;
          }

          server.incomplete = true;
          server.packPath = exePath;
        }
        continue;
      }
      if (server.path && targetExists(server.path)) continue;
      /*
       * 非官服渠道不能和别的渠道共用同一个安装目录。
       * 扫到的官服本体（config.ini 被第三方切换器改成 cps=bilibili 那种半吊子配置）
       * 绝不能写进 B服 那一行 —— 写进去就是「两个渠道共用一个目录」，
       * 切到 B服 实际还是官服那份客户端。
       */
      /*
       * 2026-11-17（bug 2）：这里原来判的是 exe 目录（...\Client\Binaries\Win64），
       * 而「这个目录是不是被别的渠道占了」必须按**本体根**比 —— 本体根在三层深，
       * 老数据里 server.root 又常常被填成 Client\Binaries\Win64 这一层，
       * 拿 exe 目录去比永远比不相等（等于这个占用检查对鸣潮从来没生效）。
       */
      const occupiedRoot = game.builtinKey === 'wutheringwaves'
        ? (wuwaClientRootOf(exeDir) || exeDir)
        : exeDir;
      if (server.channel !== 'official' && rootUsedByOtherChannel(game, server, occupiedRoot)) continue;
      server.path = exePath;
      /*
       * 鸣潮的本体根不是 exe 目录（主程序在 Client\Binaries\Win64 下），
       * 靠根目录的 launcherDownloadConfig.json 认。填 exeDir 会让「点更新」
       * 判成「不是库洛官方客户端」（2026-11-17 报障）。
       */
      server.root = game.builtinKey === 'wutheringwaves'
        ? (wuwaClientRootOf(exeDir) || exeDir)
        : exeDir;
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
       *
       * 修订（）：
       * 「共用目录」不再是合法玩法 —— 每个渠道都该有一份独立的硬链接运行时。
       * 所以「共用」本身不再豁免：只要这一行的 config.ini 强声明了别的渠道，
       * 就该把它清掉（而不是让它一直占着官服目录）。
       * 仍然是「不动」的情况保留 —— 用户手动确认过的行由用户负责。
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
      if (shared) {
        /*
         * 共用目录时也继续往下走，但只在「客户端自己声明了别的渠道」时改：
         * 判据是 config.ini + 文件层渠道 SDK 复核，可信；读不出声明就照旧不动。
         *
         * 新增「同一目录只能属于一个渠道」的迁移（用户口径：
         * 「官服和B服就不该有共用一个文件夹的情况」）：
         * 先问这个目录到底是谁的 —— resolveChannelFromRoot 会用 config.ini
         * 加上文件层渠道 SDK（BLPlatform64 / PCGameSDK.dll）复核，
         * 被第三方三服切换器改过 config.ini 的官服目录会被判回官服。
         * 目录判给谁，那一行留下；别的行（尤其是非官服）把路径清空，
         * 回到「未配置」，用户点「硬链接生成一份」就能得到自己独立的目录。
         * 判不出归属就一个字都不动，绝不猜。
         */
        const resolvedShared = clientChannel.resolveChannelFromRoot(path.dirname(server.path));
        if (!resolvedShared.channel) continue;
        /*
         * 审查指出这里原来有两处死路，导致共用状态永远自愈不了：
         *   ① `owner = servers.find(item => item !== server && item.channel === resolvedShared.channel)`
         *      —— 目录判给的正好是这一行自己时，owner 必 undefined，直接 continue；
         *   ② 官服行无条件 continue。
         *   两者叠加 = 「官服目录被写进了 B服 行」这种最常见的错配一个都修不掉。
         *
         * 现在：如果目录就属于这一行自己（owner 为空但渠道对得上），清空后保留它自己、
         * 不需要搬给别人；只有判给**别的**行时才把 activeServerId 转过去。
         */
        if (server.channel === 'official') continue; // 官服行是本体所在，别的行去让
        const owner = servers.find((item) => item !== server && item.channel === resolvedShared.channel) || null;
        if (!owner && server.channel !== resolvedShared.channel) continue; // 判给了别的渠道但那一行不存在：不动，别猜
        const movedSharedPath = server.path;
        /*
         * 字段清理要清干净（11 个），并且 incomplete 必须是 false 而不是 true：
         * 设成 true 的话界面会显示「客户端不完整（文件缺失），现在启动会失败」+ 主按钮「重建」，
         * 正确语义是「缺独立目录」+ 主按钮「生成」。
         * ★这里不能调 resetServerState —— 它定义在 installIpc() 内部（本文件 10351 行），
         *   而 repairServerChannels 是顶层函数，够不到。所以按同一份字段清单内联。
         */
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
        if (owner && game.activeServerId === server.id) {
          game.activeServerId = owner.id;
          game.target = owner.path;
          game.workDir = owner.root;
        } else if (!owner && game.activeServerId === server.id) {
          // 目录本来就是自己的，但被清空了：active 指向一个空行没意义，交回第一个可用的行
          const fallback = servers.find((item) => item.id !== server.id && item.path && targetExists(item.path));
          if (fallback) {
            game.activeServerId = fallback.id;
            game.target = fallback.path;
            game.workDir = fallback.root;
          }
        }
        writeLaunchLog(
          `shared-root-split ${game.builtinKey}: ${server.name}(${server.channel}) 与 ` +
            `${owner ? `${owner.name}(${owner.channel})` : '自己'} 共用同一目录，已把前者清空为「未配置」（${movedSharedPath}）`
        );
        changed += 1;
        continue;
      }
      /*
       * 实际渠道：config.ini 的声明 + 文件层渠道 SDK 复核。
       * config.ini 说 B服、但目录里没有 B服渠道 SDK（BLPlatform64 / PCGameSDK.dll）
       * → 这份客户端本体其实是官服（ini 被第三方三服切换器改过），判官服。
       */
      const resolvedActual = clientChannel.resolveChannelFromRoot(path.dirname(server.path));
      const actual = resolvedActual.channel || clientChannel.configChannelFromPath(server.path);
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
      /*
       * 置「不完整」之前先问一次权威判据：上面的识别逻辑可能漏了某条
       * （历史上漏过 Yostar 三区 / 米哈游运行时 / 鸣潮官服 / 终末地运行时目录），
       * 而 endfieldClientReady 只看文件系统事实，它说就绪就不该把这一行标坏。
       */
      if (game.builtinKey === 'endfield' && endfieldClientReady(game, server).ready) {
        if (server.incomplete) {
          server.incomplete = false;
          server.packPath = '';
          changed += 1;
        }
        continue;
      }

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
  /*
   * 2026-11-19（启动更快）：检测拆成「先并发探、再串行写」两段。
   *
   * 原来是一个 for 循环里 await detectGame() —— 8 个游戏完全串行。
   * 实测（_bench-reg-keys.js）光注册表就 8012 ms：米哈游三条中文键
   * （HKCU\Software\miHoYo\原神 / 崩坏：星穹铁道 / 绝区零）在这台机器上
   * 「打开键本身」就要 4~26 秒，被 timeout 拦住也各白等 2.5 秒。
   *
   * 检测阶段只有读（detectGame + detectionChannel 都不写 store），
   * 所以可以安全并发；写 store 的那段（serverForDetected / targetExists /
   * rootUsedByOtherChannel）必须在拿到全部结果之后按原顺序串行做，
   * 否则两个游戏抢同一行会互相覆盖。
   */
  const pending = [];
  for (const game of store.data.games) {
    if (!game.builtin || !game.builtinKey) continue;
    if (onlyMissing && game.target && targetExists(game.target)) continue;
    pending.push(game);
  }
  const probes = await Promise.all(
    pending.map(async (game) => {
      const found = await detectGame(game.builtinKey);
      if (!found) return { game, found: null, channel: '' };
      return { game, found, channel: await detectionChannel(game, found) };
    })
  );
  for (const { game, found, channel } of probes) {
    if (found) {
      const active = (game.servers || []).find((server) => server.id === game.activeServerId);
      // 检测到的客户端属于哪个渠道，就写进哪个渠道那一行。
      // 只装了 B服 / 国际服 的玩家本来就没有官服客户端，不能把路径塞进官服行。
      const detected = serverForDetected(game, channel);
      const detectedRoot = detected ? path.dirname(found) : '';
      /*
       * 2026-11-17（bug 2）：占用检查必须按**本体根**比。本体根在三层深
       * （本体根\launcherDownloadConfig.json），主程序在本体根\Client\Binaries\Win64，
       * 老数据里 server.root 又常被填成 Client\Binaries\Win64 这一层 ——
       * 拿 exe 目录去比永远不相等，这个检查对鸣潮等于没写。
       */
      const detectedRootReal = game.builtinKey === 'wutheringwaves'
        ? (wuwaClientRootOf(found) || detectedRoot)
        : detectedRoot;
      /*
       * 非官服渠道不能和别的渠道共用同一个安装目录。
       * 真出现了（老数据里 B服 行指着官服本体）就不写这一行 ——
       * 让它保持「未配置」，用户点「硬链接生成一份」就能得到独立目录。
       */
      const sharedWithOther =
        Boolean(detected) &&
        detected.channel !== 'official' &&
        rootUsedByOtherChannel(game, detected, detectedRootReal);
      if (detected && !sharedWithOther && (!detected.path || !targetExists(detected.path))) {
        detected.path = found;
        detected.root = detectedRootReal;
        detected.incomplete = false;
        detected.unavailable = false;
      }
      // 已经有一个能用的服务器在用时，别把当前选择抢回默认那一行
      const activeUsable = Boolean(active && active.path && targetExists(active.path));
      if (detected && !sharedWithOther && (!active || !activeUsable)) {
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
      /*
       * 鸣潮 / 异环的本体根不是 exe 所在目录：主程序在三层深的
       * `Client\Binaries\Win64` 下，根目录才是本体（鸣潮靠
       * launcherDownloadConfig.json、异环靠 NTELauncher.exe 那些标记）。
       * 这里一律按 dirname(path) 填会把 root 指到 Binaries 层，后面
       * 「点更新」就会判「这不是官方客户端」。
       */
      if (game.builtinKey === 'wutheringwaves') {
        const kuroRoot = wuwaClientRootOf(server.path);
        server.root = kuroRoot || path.dirname(server.path);
      } else {
        server.root = path.dirname(server.path);
      }
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
    /*
     * 异环三条渠道都要留：官服 / B服 / 国际服。
     *
     * 修正（用户：「异环的国际服选项咋没了？就算做不了硬链接，也留个口吧」）。
     * 之前这里被我改成只有官服 / B服，理由是国际服从头到尾没接过 —— 这个理由只对了
     * 一半：国际服确实没有 CHANNEL_CONFIG、没有 CDN 前缀、没有硬链接，但它仍然是
     * 异环的一个真渠道，玩家可能真的装了国际服客户端。渠道行不留，用户连「我有这份
     * 客户端」都告诉不了启动器，等于把一个渠道整个删掉，太重了。
     *
     * 现在：三行都留。国际服是「能选路径、能启动、不能由花筱灵自动切服/预下载」，
     * 界面点它会给明确说明（见 src/views/servers.js 的 nteChannelMarkup）。
     * 真正做好的 B服 也一起保留（它以前不是内置渠道，老数据没有 builtinServer 标记）。
     */
    neverness: [
      ['official', '官服'],
      ['bilibili', 'B服'],
      ['global', '国际服'],
    ],
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
    /*
     * 清掉「已经下线的内置渠道」留下的空壳行。
     *
     * 渠道表改过之后（例：异环从「官服 / 国际服」改成「官服 / B服」），老数据里
     * 那条旧渠道会一直留在列表里：它既不在 builtinChannels 里、不会再被补全，
     * 也没有任何 UI / 后端分支认它，界面上就是一条永远点不亮、切了也没用的空行。
     *
     * 只删同时满足三条的：
     *   ① 是内置占位（builtinServer === true，用户自己加的服务器绝不动）
     *   ② 没配路径也没配目录（真装过客户端的，哪怕渠道下线也留着让用户能启动）
     *   ③ 不在当前渠道表里
     */
    const keepChannels = new Set(builtinChannels.map(([channel]) => channel));
    const beforeCount = game.servers.length;
    game.servers = game.servers.filter(
      (server) =>
        !(
          server.builtinServer === true &&
          !String(server.path || '').trim() &&
          !String(server.root || '').trim() &&
          !keepChannels.has(String(server.channel || ''))
        )
    );
    if (game.servers.length !== beforeCount) changed = true;
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
    servers: (game.servers || []).map((server) => {
      // 判据见 serverExistsForView：光有 exe 不够，B服/国际服若还指着官服目录
      // （独立硬链接运行时没生成）就不算这一服可用。终末地那项「有官服本体
      // 当基础就算可切换」是自愈专用，helper 里原样保留了第二分支。
      const exists = serverExistsForView(game, server, endfieldHasBase);
      /*
       * 终末地：能切（有本体当源，切服时后端会自愈重建），但这一服自己的独立
       * 运行时还没生成 —— 此刻没有能直接启动的客户端。
       *
       * serverExistsForView 为了「老用户升级后还切得回 B服」把这种行也算 exists，
       * 于是界面一直按 ready 显示绿灯、按钮写「切换」。用户 2026-11-16 报障：
       *
       * 前端拿这个标记显示黄灯 + 「生成」入口，走 openServerSetupDialog 那套
       * （硬链接生成一份 → sophon 面板下差异分块 → 完成后才变绿可切）。
       * 官服直启本体，不算「缺运行时」。
       */
      /*
       * 「这一服到底有没有自己的独立运行时」必须以后端同一套判据为准。
       *
       * 原来这里只看 `server.runtimeLinked` 这一个配置字段，而同一个问题在别处
       * 有两份更宽松的判据（`hasConfig` 里的 isEndfieldRuntime 认「字段 or 目录标记」，
       * 扫描时的 isCompleteClient 只认目录标记）。三处不一致的后果很具体：
       *
       *   运行时目录明明生成好了、`.hxl-endfield-runtime-v2` 标记也在、后端也认它是
       *   完整客户端 —— 只要 launcher-data.json 里的 runtimeLinked 字段丢了
       *   （配置回滚、从旧版本升级上来、手工动过配置、activate 某些分支清过它），
       *   界面就一直挂着「缺独立目录」，用户点「生成」重建一遍也没用，因为重建完
       *   字段可能又没写回去。用户反馈的「硬链接完了还说客户端不完整」就是这条。
       *
       * 所以这里补上目录标记这一路：字段没了但目录在，同样算已生成。
       */
      /*
       * 「缺独立目录」= 这一服的客户端现在不能直接启动。
       * 统一走 endfieldClientReady（唯一权威判据），不再自己看字段。
       */
      const endfieldReady = endfieldClientReady(game, server);
      const needsRuntime =
        game.builtinKey === 'endfield' &&
        String(server.channel || '') !== 'official' &&
        exists &&
        !endfieldReady.ready &&
        ENDFIELD_PACK_NAMES[server.channel] != null;
      return {
        ...server,
        exists,
        needsRuntime,
        /*
         * 这个渠道支持哪些能力，直接跟着 server 走。
         *
         * 前端不再自己维护一份「哪款游戏哪个渠道能怎么样」的白名单（那是
         * 「界面上少一个按钮 / 点了报错」的根源），一律读这里。权威定义在
         * electron/game-channels.js，按用户 2026-11-16 定的规则：
         *   原神 / 星铁 / 绝区零 全渠道；崩坏3 硬链接全渠道（官方只有官服清单，
         *   下载/更新/预下载仍限官服）；终末地全渠道；明日方舟 国服两服 + 国际三区 + 台服；
         *   鸣潮 官服/B服/国际服/WeGame。
         */
        caps: gameChannels.capsForServer(game.builtinKey, server.channel),
        /*
         * 目录本身还在不在。
         *
         * 「exe 不在」有两种完全不同的原因：没选过路径，和「整个客户端目录被删/挪走了」。
         * 界面靠这两个字段分开说人话，否则删完 B服 的人只会看到「还没选择启动程序」，
         * 根本不知道是自己把共用的客户端目录删掉了。
         */
        rootExists: Boolean(server.root) && pathExistsCached(server.root),
        active: server.id === game.activeServerId,
      };
    }),
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
  // GitCode 更新源：只放清单（Release 附件接口不开放，包传不上去）。
  // 清单里的下载地址同样带加速前缀，所以它当兜底源很好用。
  'https://raw.gitcode.com/huahuozuikeai/hxl-update/raw/master/latest.json',
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
  if (text.includes('gitcode.com')) return 'gitcode';
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
  // 锁定某一条内置源时，把它排到最前面；其余官方源仍排在后面兜底。
  if (mode === 'gitee' || mode === 'gitcode' || mode === 'jsdelivr' || mode === 'github') {
    for (const url of OFFICIAL_UPDATE_MANIFESTS) {
      if (updateSourceKindOf(url) === mode) push(url);
    }
  }
  /*
   * 自动模式：Gitee 镜像最先（国内裸连最稳、清单里的下载地址还带加速前缀），
   * 其次 GitCode 更新源，再其次 fastly / cdn 两个 jsDelivr 节点，最后 GitHub 源站。
   * 手填地址在自动模式下不参与——设置页也是这样写的「只在选了自定义地址时生效」，
   * 不然用户填过一个旧地址之后，明明选着「自动」却一直读那份旧的，很难看出来。
   */
  for (const url of OFFICIAL_UPDATE_MANIFESTS) push(url);
  // 启动器目录里自带的那份清单放最后兜底：内网 / 完全离线时它是唯一能读到的，
  // 但不能排在网络源前面，否则刚更新完那版清单会让「检查更新」永远读到自己。
  push(localUpdateManifest());
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
  const result = await updater.checkForUpdate({
    location: locations,
    currentVersion: APP_VERSION,
  });
  return finalizeUpdateStatus(result, options);
}

function finalizeUpdateStatus(result, options = {}) {
  /*
   * 签名策略（TOFU：第一次验签成功之后就锁死）。
   *
   * 清单格式是公开的，攻击者想绕过验签最简单的办法不是造一个合法签名，而是把 sig
   * 字段整个删掉、让我们退回「只校验 sha256」。所以第一次验签成功之后记住那个
   * 版本，从此凡是没签名的清单一律拒绝——不能只拒「版本号更低」的，否则删掉
   * 签名再把 version 写高一点就绕过去了。
   *
   * 代价是「以后每一版都必须签名」。pack.js 已经自动签了，换机器发版记得把
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
  if (result.ok && result.hasUpdate && !customSource && result.sigState === 'none') {
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
    const signedLabel = signedVersion ? `本机上次验签的是 v${signedVersion}` : '本机尚未验签过任何清单（首次安装）';
    result.error = `这次更新的清单没带安全签名，已自动拦下（${signedLabel}${
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
        /*
         * 强制退出兜底（「下载完整包后卡住不重启」的根因之一）。
         *
         * 覆盖脚本 waitForMainProcessExit 最多等 60 秒，等不到主进程退出就整次放弃，
         * 用户看到的是「覆盖完了没反应、启动器还挂在旧版本」。app.quit() 本身不发
         * 异步，但渲染层若卡在同步任务里、或某个窗口的 close 被拦下，进程就会一直活着。
         * 这里给 3 秒宽限，之后直接 app.exit(0)：文件已经覆盖完，退出只是为了让
         * 覆盖脚本能接手拉起新版本，不留半截状态。
         */
        setTimeout(() => {
          try {
            if (typeof app.exit === 'function') app.exit(0);
          } catch {
            /* 已经退了就什么都不做 */
          }
        }, 3000);
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

    const downloadUrl = manifest.url;
    const downloadSha = manifest.sha256;
    const downloadSize = manifest.size;

    const tempBase = updateTempBase();
    await fsp.mkdir(tempBase, { recursive: true }).catch(() => {});

    // 增量更新优先：清单里有「当前版本 -> 目标版本」的差分包时，只下变化的部分。
    // 任何一步不对都静默退回整包，绝不让「更快」变成「更新不了」。
    const deltaInfo = updater.pickDelta(manifest, APP_VERSION, manifest.version);
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
  // 纯白主题已下线（2026-11-18）：历史配置里的 white 按浅色处理
  nativeTheme.themeSource =
    theme === 'dark' ? 'dark' : theme === 'light' || theme === 'white' ? 'light' : 'system';
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

/**
 * 窗口最小尺寸。
 *
 * ── 这个值怎么定的（实测，不是拍脑袋）─────────────────────────────────
 *
 * 用户截图 1465×643 时说「从这里就开始丢按钮、也不好看」。按 CSS 实测：
 *   · 抽卡页首屏「一屏看全」需要窗口高约 640px（titlebar 44 + 页头 110 +
 *     游戏标签 40 + UID 行 44 + 池子标签 40 + 统计卡 120 + 图表卡 180 + padding 62）；
 *   · 640 高时底部那张卡片刚好贴边，再矮就得滚动 —— 用户说的「不好看」就是这个；
 *   · 宽度方面：1240 以下侧栏从 238 变 220，820 以下才变 76px 图标模式。
 *     内容宽度掉到 700 以下时，抽卡页的 `.gacha-stat-row`（固定 4 列网格）
 *     和图表三列会被压得很挤 —— 那是「难看」的来源。
 *
 * 所以最小值定 **1180×720**：
 *   · 1180 宽：还在「侧栏 220 + 内容 ≥ 900」的区间，四列网格和图表三列都还舒展；
 *   · 720 高：比「一屏看全」的 640 多 80px，留出首屏不贴边的呼吸空间。
 *
 * 为什么不再往下放：用户明确说 1465×643 那个尺寸已经「丢按钮 + 不好看」。
 * 把下限压到 820×640（上一版的值）等于让用户随时能进那个难看的尺寸。
 *
 * ★ 光靠限制最小值是不够的 —— 用户也说了「或者你就要做最小值的适配」。
 *   所以同时在 styles.css 里补了窄屏适配：见文件末尾「窄屏紧凑模式」那段。
 *   即使以后迫不得已把窗口弄小（比如小屏笔记本 + 系统缩放），布局也不会散。
 */
const WINDOW_MIN_SIZE = { width: 1180, height: 720 };

/**
 * 窗口绝对下限（屏幕特别小的情况，比如 1024×600 的上网本）。
 *
 * 到这个尺寸界面已经偏紧了，但总比「窗口比屏幕大、永远够不着」强。
 * 这时靠 styles.css 的窄屏紧凑模式兜住：
 *   · 侧栏自动收成图标；
 *   · 四列统计卡变两列；
 *   · 图表三列变一列。
 */
const WINDOW_MIN_ABS = { width: 900, height: 600 };

/**
 * 窗口尺寸上限。
 *
 * ── 为什么不硬限面积（第一版做错了，记下来别再犯）────────────────────
 *
 * 我一开始按「面积封顶 220 万像素」来限制，理由是「拉太大 GPU 合成压力大、
 * 界面会崩」。但那等于**把 4K 屏幕卡住**：
 *   · 4K 屏在 150% 缩放下，工作区 DIP 是 2560×1440 = 369 万像素；
 *   · 4K 屏在 100% 缩放下更是 3840×2160 = 830 万像素。
 * 用户买了 4K 屏就是想拉满用，卡在 1920×1145 是明显不合理的限制。
 *
 * ── 正确做法：允许拉满，但大窗口自动降级视觉效果 ────────────────────
 *
 * 「拉太大崩」的根因不是尺寸本身，是**启动页那层全屏动态背景 + 几十个装饰动画**
 * 在超大尺寸下同时合成。所以：
 *   · 窗口该多大就多大，不人为限制（只防「超出工作区」和「超宽屏拉成一条」）；
 *   · 尺寸大到一定程度（面积超过 LARGE_WINDOW_AREA）时，通知渲染层进入
 *     「大窗口模式」：暂停动态背景视频、关掉装饰动画浮动。
 *     这个降级动作已经在渲染层有现成机制（setIdleMode 那套），只是触发条件
 *     从「窗口最小化」扩展到「窗口太大 + 最小化」。
 *
 * 这样 4K 用户能拉满，老显卡用户拉到 4K 也不会崩。
 */
/** 单边最大宽高：只防「超宽屏拉成一条」（5120 宽也够用）。 */
const WINDOW_MAX_SIDE = { width: 5200, height: 3200 };

/**
 * 「大窗口模式」阈值 —— 按**物理像素面积**判定。
 *
 * ── 为什么必须用物理像素，不能用 DIP ────────────────────────────────
 *
 * 第一版我用的是 `win.getBounds()` 拿到的宽高（那是 DIP）× 直接乘，等于按 DIP 面积判。
 * 但 DIP 面积区分不了两个负载差 2.25 倍的场景：
 *
 *   · 2560×1440 的 2K 屏（100% 缩放）：DIP 358 万，物理像素 358 万
 *   · 3840×2160 的 4K 屏（150% 缩放）：DIP 工作区 2560×1440 = 358 万，
 *     物理像素 3840×2160 = **830 万**
 *
 * 两者 DIP 一样，但 4K 那块屏要合成 2.25 倍的像素量。按 DIP 判会出现两个错误：
 *   ① 2K 屏拉满（358 万 > 320 万）被误判成「大窗口」，好好的 2K 用户最大化就丢动态背景；
 *   ② 4K 150% 和 2K 判成同一个量级，无法区分真负载。
 *
 * 所以改成：**DIP 尺寸 × scaleFactor² = 物理像素面积**，阈值按物理像素定。
 *
 * ── 阈值 600 万物理像素 ──────────────────────────────────────────────
 *
 * | 场景 | 物理像素 | 降级 |
 * |---|---|---|
 * | 1080p 100% 拉满 | 200 万 | ❌ |
 * | 2560×1080 超宽 100% | 276 万 | ❌ |
 * | 2K 2560×1440 100% | 358 万 | ❌ |
 * | **4K 150% 缩放拉满** | **806 万** | **✅** |
 * | 4K 100% 拉满 | 830 万 | ✅ |
 * | 4K 200% 缩放（DIP 只有 1920×1080） | 200 万 | ❌（DIP 小，合成压力确实小）|
 *
 * 卡在「2K 及以下不打扰」和「4K 一定保护」之间。
 */
const LARGE_WINDOW_AREA = 6000000;

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
 * 规则：大屏用 WINDOW_MIN_SIZE（1180×720），小屏缩到「工作区减 24px」，
 * 但绝不低于 WINDOW_MIN_ABS（900×600）。
 *
 * 为什么小屏要缩：1366×768 的笔记本在 125% 缩放下工作区只有 1092×614，
 * 如果硬要 1180×720，窗口比屏幕还大 —— 既缩不动也够不着底部，
 * 这种情况下宁可让界面进「窄屏紧凑模式」（styles.css 里有适配）。
 */
function adaptiveMinSize(bounds) {
  const area = workAreaFor(bounds);
  return {
    width: Math.max(WINDOW_MIN_ABS.width, Math.min(WINDOW_MIN_SIZE.width, area.width - 24)),
    height: Math.max(WINDOW_MIN_ABS.height, Math.min(WINDOW_MIN_SIZE.height, area.height - 24)),
  };
}

/**
 * 按当前屏幕算窗口最大尺寸。
 *
 * ── 规则：最大 = 工作区本身（能拉满）────────────────────────────────
 *
 * 用户明确要求「起码拉满到 2K」。所以**不做面积封顶** —— 屏幕工作区有多大，
 * 窗口就允许拉多大。1080p / 2K / 4K / 超宽屏全都能拉满。
 *
 * 那「拉太大崩」怎么防？靠**大窗口降级**（isLargeWindow → 渲染层停掉全屏
 * 背景视频与装饰动画），阈值按物理像素算：600 万。
 *
 *   屏型                  拉满物理像素    降级
 *   1080p 100%            200 万          不触发
 *   2K 2560x1440 100%     368 万          不触发  ← 用户要的就是能拉满
 *   2560x1080 超宽        276 万          不触发
 *   4K 150% 缩放          828 万          触发（保护）
 *   4K 100%               814 万          触发（保护）
 *
 * ── 中间那段弯路（记下来别再绕）────────────────────────────────────
 *
 * 我一度把上限卡在「刚好是降级阈值」的尺寸上。那套在小屏上没问题，但
 * 4K 150% 缩放的屏上会算出 2208 宽的 DIP 上限 —— 而那块屏的 DIP 工作区
 * 就是 2560，用户会觉得「连 2K 都拉不满」。所以放弃，改回「允许拉满 + 降级兜底」。
 *
 * 降级是既有的成熟机制（窗口最小化时也在用），把背景视频和装饰动画停掉后，
 * 4K 满屏也扛得住。
 *
 * 保留的两道保险：
 *   · 上限 = 工作区（不超屏，避免窗口跑到屏幕外够不着鼠标）；
 *   · 单边上限 WINDOW_MAX_SIDE（防 5120 宽超宽屏把窗口拉成一条细线）。
 *
 * @param {{x?:number,y?:number,width?:number,height?:number}} bounds 用来定位在哪个屏
 * @returns {{width:number, height:number}}
 */
function adaptiveMaxSize(bounds) {
  const area = workAreaFor(bounds);
  const min = adaptiveMinSize(bounds);

  // 能拉满：上限就是工作区本身；只叠单边上限防超宽屏
  const limitW = Math.min(Math.floor(area.width), WINDOW_MAX_SIDE.width);
  const limitH = Math.min(Math.floor(area.height), WINDOW_MAX_SIDE.height);

  /*
   * 最后一道保险：如果「最小」和「最大」挤在一起（小屏 + 高缩放的笔记本上会出现，
   * 比如 1366x768 @125% 工作区只有 1092x614），窗口会变成「大小固定、拖不动」。
   * 这时把最大再往上放一点，保证至少留出 120px 宽 / 80px 高的调节余地 ——
   * 界面靠 styles.css 的「窄屏紧凑模式」兜住。
   */
  const MIN_ADJUST_ROOM = { width: 120, height: 80 };

  return {
    width: Math.max(min.width + MIN_ADJUST_ROOM.width, limitW),
    height: Math.max(min.height + MIN_ADJUST_ROOM.height, limitH),
  };
}

/**
 * 这个尺寸算不算「大窗口」（需要让渲染层降级视觉效果）。
 *
 * @param {number} width  DIP 宽度（win.getBounds() 给的）
 * @param {number} height DIP 高度
 * @param {number} scaleFactor 该窗口所在屏的 scaleFactor（1.0 = 100%，1.5 = 150%）
 */
function isLargeWindow(width, height, scaleFactor) {
  const sf = Number(scaleFactor) > 0 ? Number(scaleFactor) : 1;
  // 物理像素面积 = DIP 面积 × scaleFactor²
  return Number(width) * Number(height) * sf * sf >= LARGE_WINDOW_AREA;
}

/**
 * 取某个 bounds 所在屏的 scaleFactor。
 * 拿不到就按 1 处理（等于退回按 DIP 判，至少不会崩）。
 */
function scaleFactorFor(bounds) {
  try {
    const display = screen.getDisplayMatching({
      x: Number(bounds?.x) || 0,
      y: Number(bounds?.y) || 0,
      width: Number(bounds?.width) || WINDOW_BASE_SIZE.width,
      height: Number(bounds?.height) || WINDOW_BASE_SIZE.height,
    });
    const sf = Number((display || screen.getPrimaryDisplay()).scaleFactor);
    return sf > 0 ? sf : 1;
  } catch {
    return 1;
  }
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

/*
 * 启动页抽屉临时撑宽窗口期间，跳过窗口尺寸记忆（见 saveWindowBounds）。
 * 必须放在模块级：createWindow 里的保存逻辑和 installIpc 里的抽屉逻辑是两个作用域。
 */
let startNavWindowExpanded = false;
/*
 * 抽屉展开前的窗口基准。**必须跨「收起」保留**：
 * 以前 collapse 把 base 清成 null，若下一次展开在窗口真正缩回之前发生，
 * applyStartNav 会把「还宽着的当前尺寸」当成新基准 —— 每开合一次就宽一条，
 * 用户看到的就是「越点越大、界面像放大半屏」。只在窗口被拖动/缩放且抽屉没开时刷新。
 */
let startNavBase = null;

function refreshStartNavBase() {
  if (!win || win.isDestroyed() || startNavWindowExpanded) return;
  if (win.isMaximized() || win.isFullScreen()) return;
  const b = win.getBounds();
  startNavBase = { x: b.x, y: b.y, width: b.width, height: b.height };
}

function createWindow() {
  // 启动尺寸/位置：还原上次记住的；超出的按当前屏夹取（适配每台电脑的屏幕）
  const bounds = initialWindowBounds();
  const minSize = adaptiveMinSize(bounds);
  const maxSize = adaptiveMaxSize(bounds);
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: minSize.width,
    minHeight: minSize.height,
    maxWidth: maxSize.width,
    maxHeight: maxSize.height,
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
  /*
   * 2026-11-26：启动页抽屉把窗口临时撑宽时，不要把「展开宽度」记成常规尺寸。
   *
   * 之前只在收起时还原窗口，但如果用户在抽屉开着时关掉启动器 / 进程被杀，
   * 保存下来的就是 base+抽屉宽 的尺寸 —— 下次启动窗口凭空宽一条，而且再也
   * 缩不回去（进程内的基准从头记，越开越宽）。抽屉开着期间直接跳过记忆，
   * 保留上一次的正常尺寸；收起后 restore 会触发一次正常保存。
   */
  const saveWindowBounds = (now = false) => {
    if (!win || win.isDestroyed() || !store?.data) return;
    if (startNavWindowExpanded) return;
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
  /* 抽屉没开时，窗口被拖动/缩放要同步刷新基准；否则下次展开会弹回旧位置 */
  win.on('move', () => {
    refreshStartNavBase();
    scheduleBoundsSave();
  });
  win.on('resize', () => {
    refreshStartNavBase();
    scheduleBoundsSave();
    /*
     * 大窗口降级通知。
     *
     * 「窗口拉太大界面会崩」的根因不是尺寸本身，而是启动页那层全屏动态背景
     * + 几十个装饰动画在超大尺寸下同时合成。所以不限制窗口能拉多大（4K 用户
     * 该能拉满），而是在超过阈值时让渲染层降级：暂停背景视频、停装饰动画。
     *
     * 这个降级复用渲染层已有的 setIdleMode 那套（原本只由「窗口最小化」触发），
     * 现在把「窗口太大」也作为触发条件之一。
     *
     * 用 requestAnimationFrame 节流：拖动窗口时 resize 会连发几十次，
     * 每次都算一遍 + 发 IPC 没必要。
     */
    scheduleLargeWindowCheck();
  });
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

/*
 * 大窗口降级：窗口拉到超大尺寸时，通知渲染层停掉循环视频与装饰动画。
 *
 * 为什么需要：启动页有一层全屏动态背景（<video> 或大图）+ 几十个浮动装饰，
 * 窗口拉到 4K 满屏时 GPU 要同时合成整屏视频和那些图层 —— 集显 / 老卡会花屏
 * 甚至渲染进程崩。用户报的「拉太大界面崩掉」就是这个。
 *
 * 为什么不直接限制窗口大小：4K 用户买了屏就是想拉满，卡在 1920 宽不合理
 * （第一版就是那么做的，已经改掉）。
 *
 * 阈值 LARGE_WINDOW_AREA = 360 万像素：
 *   · 1080p (207万) / 2K (369万 刚好到) / 你这台 2560x1080 (276万) 拉满都不触发；
 *   · 4K 150% 缩放 (369万，略超) / 4K 100% (830万) 拉满触发 —— 正是要降级的那批。
 *
 * 渲染层收到 window:large-mode 后调 setIdleMode(true)，
 * 和「窗口最小化」走同一套降级路径（暂停视频 + body.is-idle 停 CSS 动画）。
 */
const pushLargeWindow = (large) => {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('window:large-mode', !!large);
  } catch (_) {}
};
let largeWindowTimer = null;
let lastLargeState = null;
const checkLargeWindow = () => {
  if (!win || win.isDestroyed()) return;
  let b;
  try {
    b = win.getBounds();
  } catch {
    return;
  }
  const sf = scaleFactorFor(b);
  const large = isLargeWindow(b.width, b.height, sf);
  // 状态没变就别重复发 IPC（拖动窗口时 resize 连发几十次）
  if (large === lastLargeState) return;
  lastLargeState = large;
  pushLargeWindow(large);
  writeLaunchLog(
    '[window] 大窗口模式 ' + (large ? '开启（暂停背景视频与装饰动画）' : '关闭') +
    '：' + b.width + 'x' + b.height + ' DIP × ' + sf + ' 缩放 = ' +
    Math.round(b.width * sf) + 'x' + Math.round(b.height * sf) + ' 物理像素'
  );
};
/** resize 节流：200ms 内只算一次，拖动时不会连发。 */
function scheduleLargeWindowCheck() {
  if (largeWindowTimer) return;
  largeWindowTimer = setTimeout(() => {
    largeWindowTimer = null;
    try {
      checkLargeWindow();
    } catch {
      /* 降级判断失败不影响窗口 */
    }
  }, 200);
}
// 页面加载完后补推一次当前状态（首帧就是超大窗口时也要降级）
win.webContents.on('did-finish-load', () => {
  setTimeout(() => {
    lastLargeState = null; // 强制重算并发一次
    checkLargeWindow();
  }, 0);
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

/*
 * ===== 管理员权限（提权）判定 =====
 *
 * 2026-11-25 报障复盘：用户手动给了启动器管理员权限，日志里仍然是
 *   launch builtin-endfield: 官方托管启动 ... elevated=0
 * 于是 endfield-official.js 的 spawnOfficialLauncher() 走了非提权分支，
 * 又用 UAC 包装脚本把官方启动器界面拉起来一遍 —— 用户的原话是
 * 「我给权限了，你不应该还拉起来官方启动器了啊」。
 *
 * 旧实现的两个毛病：
 *   1. 只有一条探测路径（powershell -Command ... IsInRole），实测 290~420ms；
 *      机器上开着安全软件还会更慢，而超时是 5000ms。任何一次超时 / 被拦 /
 *      PowerShell 不可用 / 输出没解析出来，都落进 catch 返回 false。
 *   2. currentElevation() 无条件把结果写进 elevatedCache —— 包括这种
 *      「这一次没探出来」的 false。于是本进程余下的整个生命周期都认为
 *      自己不是管理员，用户再怎么授权都没用。
 *
 * 现在改成三路信号，任一给出确定结论就采信，并且**把「不确定」和「不是」分开**：
 *   A. __COMPAT_LAYER 含 RUNASADMIN —— 0 成本。系统在按「以管理员身份运行」/
 *      兼容性标记启动进程时会写入这个变量，命中即说明提权层真的生效了。
 *   B. 令牌完整性级别（whoami /groups 里的 S-1-16-xxxx）—— 约 100ms，
 *      纯 Win32 命令行工具，不吃 PowerShell 的执行策略 / 杀软 / 加载慢。
 *      ≥ 0x3000 即高完整性（12288）或更高（16384 系统 / 20480 受保护）。
 *      只解析 ASCII 的 SID：whoami 的正文是本地化文本（中文系统写
 *      「强制标签\高强制级别」），按文字匹配会被系统语言带偏。
 *   C. PowerShell 的 IsInRole —— 只在 A/B 都给不出结论时兜底。
 *
 * 三路都得不出结论 → 返回 null。调用方按 false 处理，但**不写缓存**，下次重试。
 */
let elevatedCache = null;
/* 「不确定」和「确定」各只写一次日志：排查权限问题时就靠这两行。 */
let elevationLogged = false;
let elevationUnknownLogged = false;

/**
 * 三态探测：{ elevated: true | false | null, via: string }
 * elevated === null 表示这次探测本身没得出结论（≠ 不是管理员）。
 */
function probeElevation() {
  // ── 信号 A：兼容性标记 / 「以管理员身份运行」由系统写入
  const compat = String(process.env.__COMPAT_LAYER || '');
  if (/RUNASADMIN/i.test(compat)) return { elevated: true, via: 'compat-layer' };

  // ── 信号 B：令牌完整性级别（权威、不依赖 PowerShell）
  const integrity = readIntegrityLevel();
  if (integrity !== null) {
    return { elevated: integrity >= 0x3000, via: 'integrity-0x' + integrity.toString(16) };
  }

  // ── 信号 C：PowerShell 兜底
  const byPowershell = probeElevationByPowershell();
  if (byPowershell !== null) return { elevated: byPowershell, via: 'powershell' };

  return { elevated: null, via: 'unknown' };
}

/**
 * 读当前进程令牌的完整性级别（RID 数值：0x2000=中, 0x3000=高, 0x4000=系统）。
 * 拿不到返回 null —— 调用方必须把它和「确定不是管理员」区分开。
 */
function readIntegrityLevel() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidates = [
    // 32 位进程在 64 位系统上：System32 会被重定向到 SysWOW64，Sysnative 才是真的 64 位
    path.join(root, 'Sysnative', 'whoami.exe'),
    path.join(root, 'System32', 'whoami.exe'),
    'whoami.exe',
  ];
  let output = null;
  for (const exe of candidates) {
    if (exe !== 'whoami.exe' && !fs.existsSync(exe)) continue;
    try {
      output = execFileSync(exe, ['/groups', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      });
      break;
    } catch {
      /* 这条路不通，试下一个 */
    }
  }
  if (output === null) return null;
  const matches = String(output).match(/S-1-16-(\d+)/g) || [];
  let level = -1;
  for (const sid of matches) {
    const value = Number(sid.slice('S-1-16-'.length));
    if (Number.isFinite(value) && value > level) level = value;
  }
  return level >= 0 ? level : null;
}

/** 兜底：PowerShell 的 IsInRole。拿不到结论返回 null（不是 false）。 */
function probeElevationByPowershell() {
  try {
    const output = execFileSync(
      powershellExe(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    );
    const answer = String(output).trim();
    if (/^true$/i.test(answer)) return true;
    if (/^false$/i.test(answer)) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * 当前进程是否已在管理员上下文里。
 *
 * elevatedCache 的哨兵是 null，含义是「还没算出确定结论」：
 *   · true / false = 已经确定了，直接用；
 *   · null          = 还没算过，或者上一次探测没得出结论 —— 都要重新探。
 *
 * 注意别把「探测失败」也写成缓存：以前的实现无条件缓存，一次失败就把
 * 「不是管理员」钉死到进程结束，用户后来再怎么授权都翻不过来。
 */
function currentElevation() {
  if (elevatedCache === null) {
    const probe = probeElevation();
    if (probe.elevated === null) {
      if (!elevationUnknownLogged) {
        elevationUnknownLogged = true;
        writeLaunchLog(
          'elevation: 探测未得出结论（不缓存，下次重试）compatLayer=' + (process.env.__COMPAT_LAYER || '-')
        );
      }
      return false;
    }
    elevatedCache = probe.elevated;
    if (!elevationLogged) {
      elevationLogged = true;
      writeLaunchLog(
        'elevation: ' + (probe.elevated ? 'elevated=1' : 'elevated=0') +
          ' via=' + probe.via +
          ' compatLayer=' + (process.env.__COMPAT_LAYER || '-')
      );
    }
  }
  return elevatedCache;
}

/** 兼容旧调用点 / 验证脚本：语义与 currentElevation() 完全一致。 */
function isElevated() {
  return currentElevation();
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
      powershellExe(),
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

/*
 * 可选素材包（hxl-art:// 协议）。
 *
 * 包内 src/assets/ 那 13 张都是本项目自制：7 张角色插画（含品牌 logo 与头部特写）
 * + 6 张几何装饰图。用户如果想换成自己的图，把同名 png 丢进 userData/art-pack/
 * 就行，这里优先取用户的。
 *
 * 只认 theme-pack.js 里 ART_NAMES 那 13 个名字，其余一律 403
 * —— 不能变成「任意文件读取」。也不接受带子目录的名字（path.basename 兜一层）。
 */
const ART_PACK_NAMES = themePack.ART_NAME_SET;

function installArtProtocol() {
  protocol.handle('hxl-art', async (request) => {
    try {
      const url = new URL(request.url);
      // hxl-art://character.png → standard 协议把首段解析成 hostname
      const raw = decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, ''));
      const name = path.basename(raw);
      if (!ART_PACK_NAMES.has(name)) return new Response('forbidden', { status: 403 });
      const userData = app.getPath('userData');
      const packId = store && store.data && store.data.settings ? store.data.settings.themePack : '';
      const bundled = path.join(ROOT, 'src', 'assets');
      /*
       * ?builtin=1：这个位置固定用内置素材，不跟主题包（2026-11-22 用户反馈：
       * 首页 hero 背景和方形立绘位要保持「没装主题」时的样子）。
       * 回落顺序写在 theme-pack.js 里：选定主题包 → 老的平铺 art-pack/<名> → 内置 src/assets。
       */
      const useBuiltin = url.searchParams.get('builtin') === '1';
      let target = useBuiltin ? path.join(bundled, name) : themePack.resolveAsset(userData, packId, name, bundled);
      /*
       * 内置素材已转 WebP（2026-11-26），对外仍用 .png 名字。
       * resolveAsset 内部已带同名 .webp 回落；这里补上 ?builtin=1 的直接回落。
       */
      if (target && !fs.existsSync(target) && /\.(png|jpe?g)$/i.test(target)) {
        const alt = target.replace(/\.(png|jpe?g)$/i, '.webp');
        if (fs.existsSync(alt)) target = alt;
      }
      if (!target || !fs.existsSync(target)) return new Response('not found', { status: 404 });
      /*
       * 主题包素材同名不同内容（每个包里都叫 char-cool.png / sparkle-mask.png）。
       * 直接透传 net.fetch 的响应会被 Chromium 当普通文件缓存，换包后仍是上一套图。
       * 这里强制 no-store：文件名带 ?v=<包 id> 时每次换包都重新读盘（2026-11-22）。
       */
      const fetched = await net.fetch(pathToFileURL(target).toString());
      return new Response(await fetched.arrayBuffer(), {
        status: fetched.status,
        headers: {
          'content-type': fetched.headers.get('content-type') || 'image/png',
          'cache-control': 'no-store, max-age=0',
        },
      });
    } catch (error) {
      return new Response(String(error.message || 'error'), { status: 500 });
    }
  });
}

function installIpc() {

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


  /* ---------------- 米游社 / HoYoLAB 登录 ---------------- */

  /*
   * 打开米游社让用户自己登录。
   * 这里刻意不把 cookie 暴露给渲染层的任意代码：
   * 只有登录窗口自己会读到 cookie，渲染层拿到的只是角色列表。
   */
  installHoyolabIpc({ store, win, pushState, readHoyolabStore, writeHoyolabStore, pickHoyolabAccount, verifyHoyolabAccount, hoyolabAccountId, publicHoyolabAccount });

  /*
   * 首次点关闭时那个询问框的结果：执行选择，记住了以后就都按它走。
   * remember=false（弹窗里没勾「以后不再询问」）只执行这一次，不写设置 ——
   * 下次点 ✕ 还会问。
   * closeToTray 一起写，设置页的开关才不会和真实行为打架。
   */

  /* 用户把询问框关掉了（没选）：允许下次点关闭再问一次 */

  /*
   * 侧栏品牌图标既是设置页入口，也要能拖动窗口。
   * 它原本靠 -webkit-app-region: drag 拖，但拖拽区会吞掉鼠标事件，
   * 点不了；改成 no-drag + 这里按位移移动窗口，两种行为就能共存。
   */

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
    startNavWindowExpanded = d > 0;
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
    if (!startNavBase) {
      startNavWindowExpanded = false;
      return 0;
    }
    /* 先解除「展开中」标记，再还原窗口 —— 这次 setBounds 触发的记忆要正常存基准尺寸 */
    startNavWindowExpanded = false;
    if (win && !win.isDestroyed() && !win.isFullScreen() && !win.isMaximized()) {
      win.setBounds(startNavBase);
    }
    /* 注意：不要清 startNavBase。保留它，下一次展开才能在窗口缩回完成前也用正确的基准 */
    return 1;
  };




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
  installPassportIpc({ store, win });

  installSklandIpc({
    passport,
    skland,
    win,
  });

  installGachaIpc({
    getStore: () => store,
    gachaBackupSnapshot,
    gachaBackupCredentials,
    pushState,
    readHoyolabStore,
    pickHoyolabAccount,
    win,
    send,
    // 重构拆分时漏掉的依赖
    targetExists,
    publicGame,
    running,
    refreshGachaSecretFlags,
    scheduleGachaBackup,
    runGachaBackup,
    detectStarwardDbPath,
    nteGachaDir,
    refreshNteAccount,
    scanNteGachaDrops,
    hoyolabAccountLabel,
    verifyHoyolabAccount,
    stopScanSession,
    qrLog,
    getNteToolAbort: () => nteToolAbort,
    setNteToolAbortCtx: (value) => { nteToolAbort = value; },
    setScanSessionCtx: (value) => { scanSession = value; },
    setGachaBackupFailStreakCtx: (value) => { gachaBackupFailStreak = value; },
    setGachaBackupRetryAtCtx: (value) => { gachaBackupRetryAt = value; },
  });

  installServersIpc({
    getStore: () => store,
    getRunning: () => running,
    getLaunching: () => launching,
    getLinkJobs: () => linkJobs,
    getLinkTrees: () => linkTrees,
    ENDFIELD_PACK_NAMES,
    applyHdiffPrepass,
    beginBackgroundTask,
    endBackgroundTask,
    buildEndfieldChannelRuntime,
    ensureEndfieldChannelRuntime,
    ensureArknightsRuntime,
    ensureKuroRuntime,
    // 2026-11-17（bug 3）：鸣潮国际服 / WeGame 没有独立运行时，切过去前必须问一句。
    kuroChannelSwitchable,
    channelPackNeededFor,
    channelPackStatus,
    clientChannel,
    currentElevation,
    detectGame,
    externalLinkSources,
    isEndfieldLegacyWorkRoot,
    isEndfieldRuntimeDir,
    endfieldClientReady,
    pushState,
    send,
    sendProgress,
    targetExists,
    writeLaunchLog,
    storyResourcesEnabled,
    syncOfficialGame,
    fsp,
    ensureServers,
    publicGame,
    pruneStaleRunning,
    runtimePaths,
    sophonJobs,
    prepareSophon,
    prepareBilibiliRuntime,
    prepareGenshinPackRuntime,
    yostarPacks,
    kuroPacks,
    linkTrees,
    previewTrees,
    findSevenZip,
    downloadAndExtractSplit,
    updateEndfieldGame,
    // 重构拆分时漏掉的依赖
    resetServerState,
    refreshPredownloadAfterSwitch,
    resolveLinkRoots,
    prepareEndfieldRuntimeJob,
    prepareArknightsRuntimeJob,
    prepareKuroRuntimeJob,
    prepareAzurRuntimeJob,
    estimateRuntimeSpace,
    probeUpdateWritable,
    invalidateRuntimesAfterUpdate,
    // DOWNLOADABLE_KEYS / uninstallPlan 声明在本函数后面，按值传会踩 TDZ，必须走 getter
    getDownloadableKeys: () => DOWNLOADABLE_KEYS,
    getUninstallPlan: () => uninstallPlan,
    serverForDownload,
    engineFor,
    estimateDownloadBytes,
    driveFreeBytes,
    assertDirWritable,
    downloadPackProfile,
    launching,
  });

  installGamesIpc({
    getStore: () => store,
    getRunning: () => running,
    getLaunching: () => launching,
    pushState,
    send,
    detectServerExecutable,
    fetchAllGameNotices,
    syncAllOfficial,
    writeLaunchLog,
    targetExists,
    currentElevation,
    finishGame,
    killGame,
    markLaunched,
    updater,
    ensureServers,
    detectBuiltins,
    detectGame,
    // 用户点「自动检测」时先清注册表负缓存，否则新装的游戏会被上次的失败结果挡住
    clearRegistryCache,
    // 重构拆分时漏掉的依赖
    fetchGameNotices,
    updateEndfieldGame,
    externalLinkSources,
    invalidateRuntimesAfterUpdate,
    yostarPacks,
    ARKNIGHTS_CN_CHANNELS,
    predownload,
    prepareSophon,
    storyResourcesEnabled,
    nevernessChannels,
    normalizeGame,
    publicGame,
    repairServerChannels,
    detectionChannel,
    serverForDetected,
    pruneStaleRunning,
    isEndfieldLegacyWorkRoot,
    WEGAME_LAUNCH_URI,
    ensureEndfieldChannelRuntime,
    breakSharedPersistentState,
    launchPreflightNotice,
    findNteGame,
    findNteLauncher,
    listRunningImages,
    activateWindowByImage,
    clearNteLingeringLauncher,
    splitArgs,
    startWithShellExecute,
    spawn,
    trackGameProcess,
    autoClickNtePredownload,
    autoClickNteStart,
    wuwaLaunch,
  });

  installEndfieldIpc({ BrowserWindow, win, targetExists, send, pushState, writeLaunchLog, updateEndfieldGame, externalLinkSources, endfieldPackWritableRoot, ENDFIELD_PACK_NAMES, updateEndfieldPacks, refreshPackChannels, describePackUsage, ARKNIGHTS_PACK_DIRS, ENDFIELD_PACK_DIRS, builtinPackRoot, dirSize, refreshArknightsPackChannels, channelPackStatus, downloadChannelPack, cancelChannelPack, ARKNIGHTS_PACK_CHANNELS, channelPackSpec, endfieldPackCandidateRoots, channelPackReady, getStore: () => store, getRunning: () => running, invalidateRuntimesAfterUpdate });
  installPredownloadIpc({
    beginBackgroundTask,
    send,
    sendProgress,
    endBackgroundTask,
    writeLaunchLog,
    externalLinkSources,
    pushState,
    syncOfficialGame,
    storyResourcesEnabled,
    getStore: () => store,
    getRunning: () => running,
    getPredownloadJobs: () => predownloadJobs,
    // 重构拆分时漏掉的依赖
    resolvePredownload,
    savePredownloadState,
    invalidateRuntimesAfterUpdate,
  });
  /*
   * closeAskPending / quitting 是模块级 let，`win.on('close')` 也在这里读写。
   * 必须传 getter/setter：按值传过去的是启动那一刻的快照，而且到了模块里成了 const，
   * 一赋值就抛 TypeError —— 点关闭既弹不出询问框，也退不出去。
   */
  installWindowIpc({
    win,
    pushState,
    tray,
    getStarRailFps,
    channelFromArknightsRoot,
    getCloseAskPending: () => closeAskPending,
    setCloseAskPending: (value) => { closeAskPending = Boolean(value); },
    setQuitting: (value) => { quitting = Boolean(value); },
    startNavRoom,
    applyStartNav,
    collapseStartNav,
    getStore: () => store,
    getRunning: () => running,
  });
  installAppIpc({ snapshot, normalizeUiScale, applyUiScale, win, updateTempBase, APP_VERSION, describeRunningProcesses, setQuitting: (v) => { quitting = Boolean(v); }, ensureDownloadsDir, updateLogDirs, currentElevation, relaunchElevated, probeElevation, getStore: () => store });
  installSettingsIpc({ snapshot, normalizeUiScale, clearMusicResolveCache, validateCustomSource, normalizeProxyRules, normalizeAudioLanguages, applyNativeTheme, applyLoginItem, applyTitlebar, applyUiScale, pushState, applyProxySettings, applyDownloadLimit, dataFile, win, getStore: () => store });
  installThemePackIpc({ pushState, getStore: () => store, userData: () => app.getPath('userData') });
  installDownloadsIpc({ ensureDownloadsDir, safeFileName, uniquePath, pushState, getDownloads: () => downloads });
  installPluginIpc({ dialog, win, getPluginRoot: () => pluginRoot() });
  installUpdateIpc({ performUpdateCheck, readSystemProxy, probeProxy, startUpdate, dialog, win, updateBackupInfo, updateTempBase, describeRunningProcesses, setQuitting: (v) => { quitting = Boolean(v); }, getStore: () => store });
  installDialogIpc({ win });
  installBackgroundIpc({ getOfficialSyncState: () => officialSyncState });
  installInstallIpc({ fetchLatestForChannel, shell });
  installArknightsIpc({ targetExists, send, pushState, ARKNIGHTS_CN_CHANNELS, updateEndfieldGame, externalLinkSources, endfieldPackWritableRoot, ARKNIGHTS_OFFICIAL_PROFILE, ARKNIGHTS_BILIBILI_PROFILE, verifyArknightsSource, updateEndfieldProfile, refreshPackChannels, getStore: () => store, getRunning: () => running, invalidateRuntimesAfterUpdate });
  installWuwaIpc({ targetExists, send, pushState, writeLaunchLog, getStore: () => store, getRunning: () => running, invalidateRuntimesAfterUpdate, externalLinkSources });
  installNevernessIpc({
    pushState,
    send,
    getStore: () => store,
    getRunning: () => running,
    getNtePredownloadAbort: () => ntePredownloadAbort,
    setNtePredownloadAbort: (value) => { ntePredownloadAbort = value; },
  });
  installScreenshotsIpc({ targetExists, screenshotAllow, getStore: () => store });
  installMiscIpc({
    describeStorage, cleanSafe, pushState, cleanGroup, setStarRailFps, snapshot, pathToFileURL,
    neteaseGet, NETEASE_URL_BATCH, wuwaExeAt, findWeGameWuwaRoots, findWeGameDownloadRoots,
    WEGAME_WUWA_ID, pathsOverlap, send, sendProgress, hardlinkTree, updateLogDirs, updateStatus,
    APP_VERSION, ensureAnimatedStartBackgrounds, win, portableDownloads, ROOT,
    getStore: () => store, getLinkJobs: () => linkJobs,
    // 重构拆分时漏掉的依赖
    repairMissingBackgrounds,
    safeFileName,
    minisign,
    os,
    setBh3OfficialRetry: (value) => { bh3OfficialRetry = Number(value) || 0; },
  });

  // 更新弹窗配图（同人图）：读缓存，需要时刷新
  installPostartIpc({ store, readHoyolabStore, pickHoyolabAccount });






loadSecret('netease')
  .then((raw) => {
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.cookie) setNeteaseSession({ apiBase: parsed.apiBase || '', cookie: parsed.cookie });
  })
  .catch(() => {});



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


/*
 * 点歌预热入口挂到 globalThis：did-finish-load 的 3 秒预热在个别环境下运行于
 * 重新求值的 main.js 闭包里，直接引用本文件的函数绑定会 ReferenceError（实测
 * 反复出现在 data/crash.log）。闭包在定义处创建、作用域正确，从桥上调用最稳。
 */
globalThis.__hxlNeteaseWarmup = () => startNeteaseService(normalizeNeteaseBase()).catch(() => {});


/** 一次查多少个播放地址：太多 id 拼在 URL 里会被本地 API 拒。 */


  ipcMain.handle('netease:service-start', async (_event, apiBase) => startNeteaseService(apiBase));

/**
 * 当前的内置音源开关（settings.musicSources 归一化，缺的键用默认值补齐）。
 * 弹幕点歌 / 音质切换这些不走 music:resolve 的路径也要认这份开关，
 * 否则「停用酷我」只管住了换源竞速，管不住换源兜底。
 */

/**
 * 跨平台兜底的 flags 感知版：在酷狗 / QQ 上找同名同歌手的免费那一份。
 * 替代 music-platforms.js 的 resolveFallbackUrl——那个写死了两家都试，
 * 没法按音源开关跳过，谁被停用了就整条跳过。
 */

/**
 * 内置 API 自带的换源：`/song/url/match` 会用内置的换源工具
 * 去别的平台匹配同一首歌的公开可播版本。
 * 拿不到就返回空串，交给上层继续降级。
 */

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

  installLiveIpc({
    writeLaunchLog,
  });

  installMusicIpc({
    store,
    pushState,
    playlistCache,
    slimCachedPlaylists,
    PLAYLIST_CACHE_PLATFORMS,
    BROWSER_UA,
    MUSIC_LOGIN_PRELOAD,
    // 重构拆分时漏掉的依赖
    getMainWindow: () => win,
    clearMusicResolveCache,
    fetchSourceLyric,
    musicLooksExpired,
  });

  // 音乐缓存的统计 / 清空 / 打开目录 IPC（协议 handler 已在创建窗口前注册）
  try {
    const { installMusicCacheIpc } = require('./music-cache');
    installMusicCacheIpc({ store, pushState });
  } catch (error) {
    console.warn('[music-cache] IPC 注册失败:', error?.message || error);
  }


  /*
   * 只改渲染后端这一个字段（启动页「开始游戏」下面的三段式开关走这里）。
   *
   * 不复用 games:update 是有原因的：那个入口收的是整份编辑表单，只传 renderApi 会被
   * normalizeGame 当成「没填游戏名称」直接抛错；补齐所有字段又等于把编辑逻辑抄一遍，
   * 漏一个字段就会把用户的改名/启动参数覆盖回默认值。这里点名改一个键，风险为零。
   */
  /* ------------------------------------------------------------------ */
  /* 角色图鉴（原神 / 星铁 / 绝区零）                                    */
  /* ------------------------------------------------------------------ */
  /*
   * 和战绩接口共用同一个登录态取法，uid/server 由前端从账号中心带过来 ——
   * 这里不猜，猜错了就是查别人的号。
   */
  installRosterIpc({ store, readHoyolabStore, pickHoyolabAccount });

  /* ------------------------------------------------------------------ */
  /* 明日方舟（鹰角账号 token）                                          */
  /* ------------------------------------------------------------------ */


  /*
   * 鹰角账号：打开官网登录窗口，登录完成后自动把账号 token 拿回来。
   *
   * 手填 token 那条路太劝退 —— 要开 F12 或者翻页面源码找一串 base64。
   * 官网的登录态就在 cookie 里，而 web-api.hypergryph.com/account/info/hg
   * 只认登录域的 cookie，所以这里用同一个 persist 分区开 user.hypergryph.com，
   * 轮询到登录态就回主进程换 token。换成 token 之后 cookie 就没用了。
   */


  /*
   * 按「某个服务器的渠道」扫一遍。
   *
   * 和 games:detect 的区别：那个是「这个游戏装在哪」，找到就写进对应渠道那一行；
   * 这个是「B服 装在哪」，只认 B服 的 exe。用户在 B服 那一行点自动扫描，
   * 期待的显然是 B服 被填上，而不是官服那一行又刷新一遍。
   */


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
      /*
       * 2026-11-17（）：
       * 两个渠道共用同一个安装目录时不能建硬链接 —— 那不是「去重」，
       * 是把一份客户端当成两个渠道用，渠道配置和登录态全串。
       * 正确做法是每个渠道各自「硬链接生成一份」，得到独立目录。
       */
      const normDir = (value) => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
      if (normDir(source.root) === normDir(target.root)) {
        throw new Error(
          `「${source.name}」和「${target.name}」现在装在同一个目录里，没法去重。` +
            '每个渠道要一份独立目录：请先给其中一个渠道点「硬链接生成一份」。'
        );
      }
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


  /**
   * 估算生成差异客户端要占多少空间。
   *
   * 生成时会把基础客户端里内容相同的文件直接硬链接过去，那部分不额外占空间，
   * 所以这里只给两个确定的事实：目标盘还剩多少、基础客户端有多大。
   * 客户端体积靠遍历目录算，给了 4 秒上限 —— 超大客户端算不完就先报可用空间，
   * 不能让「看个数字」把界面卡住。
   *
   * 多给一个 copyBytes —— 真正要写盘的那部分。
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

  /*
   * 鸣潮走自己的链路（库洛官方 index.json 清单 + 整树硬链接），
   * 不读 Sophon 清单，所以以前点「硬链接生成一份」只能走 servers:activate 那条闷头路径：
   * 一条不会动的 toast、没有空间估算、没有分阶段进度，和别的游戏手感完全不一样
   * 。
   *
   * 这一版统一成和终末地 / 明日方舟同一套：
   *   · estimate 分支先给出目标盘剩余、可复用上限、空间判断；
   *   · 真跑时走 sophon:progress 频道，弹窗与启动页那块统一面板都能拿到字节进度；
   *   · 完成后由弹窗自己写回状态并收起（前端那一屏负责）。
   */
  async function prepareKuroRuntimeJob(game, input = {}) {
    const server = (game.servers || []).find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    if (await pruneStaleRunning()) pushState(true);
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再切换服务器');
    const channel = String(server.channel || '');
    if (!['official', 'bilibili'].includes(channel)) {
      throw new Error(
        channel === 'global'
          ? '鸣潮国际服与国服内容几乎完全不同，不支持硬链接互切；请用「下载游戏」直接安装国际服'
          : '这个渠道暂时不支持生成差异客户端'
      );
    }

    /*
     * 基础客户端：官服 / B服 / WeGame 任意互相为源。
     * 国际服差异太大排除（kuro-packs.js 的 buildCrossRuntime 也会拒）。
     */
    const candidates = (game.servers || []).filter(
      (item) =>
        ['official', 'bilibili'].includes(String(item.channel || '')) &&
        item.channel !== channel &&
        item.root &&
        !String(item.root).includes('VelaRuntimes') &&
        wuwaExeAt(item.root)
    );
    const wegameRoot = findWeGameWuwaRoot();
    if (wegameRoot && wuwaExeAt(wegameRoot)) {
      candidates.push({ channel: 'wegame', root: wegameRoot, name: 'WeGame 版', isWeGame: true });
    }
    if (!candidates.length) {
      throw new Error(
        `还没有另一个鸣潮渠道的安装目录可以当源（需要官服、B服 或 WeGame 的完整客户端）。请先用「下载游戏」或官方启动器装一个，再回来生成${
          channel === 'bilibili' ? 'B服' : '官服'
        }运行时。`
      );
    }
    // WeGame 版排在最后：优先用官方体系内的源（渠道件差异最小），WeGame 兜底
    candidates.sort((a, b) => (a.isWeGame ? 1 : 0) - (b.isWeGame ? 1 : 0));

    const baseRoot = candidates[0].root;
    const runtime = runtimePaths(baseRoot, 'wutheringwaves', channel, input?.runtimeRoot);
    if (!runtime.sameDrive) {
      throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
    }
    /*
     * 判据是「不得互相嵌套」而不是「不得相等」：和终末地 / 明日方舟用同一个
     * pathsOverlap，运行时目录嵌进基础客户端里会把官服本体原地改写。
     */
    if (pathsOverlap(baseRoot, runtime.target)) {
      throw new Error('运行时目录不能和基础客户端是同一个目录，也不能互相嵌套，请换个“运行时目录”再试');
    }

    if (input?.estimate) {
      /*
       * 空间判断先走本地统计（离线、只读）：目标盘剩余 + 基础客户端体积。
       * 库洛自己的清单能给「还要下多少字节」，但那要联网读远端 index.json，
       * 断网时不该把整个估算卡死 —— 拿不到就退成 copyBytes=null，界面显示「按默认目录继续」。
       */
      const space = await estimateRuntimeSpace(baseRoot, runtime.target);
      let plan = null;
      try {
        plan = await kuroPacks.planCrossRuntime({ sourceRoot: baseRoot, targetProfile: channel });
      } catch (error) {
        writeLaunchLog(`kuro estimate: 读官方清单失败（${error.message}），只给本地空间信息`);
      }
      return {
        ok: true,
        estimate: true,
        drive: space.drive,
        freeBytes: space.freeBytes,
        baseBytes: space.baseBytes,
        copyBytes: plan ? Number(plan.downloadBytes) || 0 : null,
        copyFiles: plan ? Number(plan.downloadCount) || 0 : null,
        partial: space.partial,
        targetRoot: runtime.target,
        plan,
      };
    }

    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = createCancelSignal();
    sophonJobs.set(jobId, signal);
    beginBackgroundTask();
    try {
      const emit = (progress) => sendProgress('sophon:progress', jobId, progress);
      emit({ phase: 'start', processed: 0, total: 0, current: '正在准备鸣潮运行时…' });
      const result = await kuroPacks.buildCrossRuntime({
        sourceRoot: baseRoot,
        targetProfile: channel,
        installRoot: runtime.target,
        signal,
        onProgress: emit,
      });
      if (signal.cancelled) return { ok: false, cancelled: true };
      /*
       * 主程序在 Client\Binaries\Win64\ 下；写回必须用真实路径，否则下次启动会因
       * server.path 不存在把这一行标成「需要重建」（与 ensureKuroRuntime 同一套写法）。
       */
      const exe =
        wuwaExeAt(runtime.target) ||
        path.join(runtime.target, 'Client', 'Binaries', 'Win64', result.executable || 'Client-Win64-Shipping.exe');
      server.path = exe;
      server.rootDir = server.root;
      server.root = runtime.target;
      server.runtimeLinked = true;
      server.legacyRuntime = false;
      server.incomplete = false;
      game.activeServerId = server.id;
      game.target = exe;
      game.workDir = runtime.target;
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
        tag: result.version || server.name,
        linked: result.linked || 0,
        downloaded: result.downloaded || 0,
        files: result.files || 0,
        totalBytes: result.totalBytes || 0,
        targetRoot: runtime.target,
      };
    } finally {
      endBackgroundTask();
      sophonJobs.delete(jobId);
    }
  }

  /**
   * 把整棵源目录按原结构硬链接到目标目录（目标必须已存在且为空）。
   *
   * 为什么不能直接用 linkTrees：它的 buildCandidates 只遍历**目标目录**已有的文件，
   * 空目录 ⇒ 零候选 ⇒ 什么都不做。而「生成一份新渠道运行时」的起点恰恰就是空目录。
   *
   * 这里的语义是「镜像」而不是「去重」：
   *   · 每个文件都用 fs.link 建硬链接（同盘、同 NTFS，不占额外空间）
   *   · 跨盘或文件系统不支持硬链接时，退化成复制（并计入 copied 而不是 linked）
   *   · 目标已存在的同名文件不覆盖（避免把用户已经放好的东西冲掉）
   */
  async function mirrorTreeByHardLink({ sourceRoot, targetRoot, signal, onProgress = () => {} }) {
    const src = path.resolve(sourceRoot);
    const dst = path.resolve(targetRoot);
    let files = 0;
    let linked = 0;
    let copied = 0;
    let linkedBytes = 0;
    let skipped = 0;
    const errors = [];
    let lastEmit = 0;

    /* 先走一遍收集所有文件（顺便统计总字节，进度条要按字节算） */
    const entries = [];
    const walk = async (rel) => {
      if (signal?.cancelled) return;
      const absSrc = rel ? path.join(src, rel) : src;
      let items;
      try {
        items = await fsp.readdir(absSrc, { withFileTypes: true });
      } catch (error) {
        errors.push(`读取失败：${rel || '.'}（${error.message}）`);
        return;
      }
      for (const item of items) {
        if (signal?.cancelled) return;
        const childRel = rel ? path.join(rel, item.name) : item.name;
        if (item.isDirectory()) {
          await walk(childRel);
        } else if (item.isFile()) {
          let size = 0;
          try {
            size = (await fsp.stat(path.join(src, childRel))).size;
          } catch {
            size = 0;
          }
          entries.push({ rel: childRel, size });
        }
        /* 符号链接等其它类型一律跳过：蓝原客户端里没有需要用到的 */
      }
    };
    await walk('');

    const total = entries.length;
    const totalBytes = entries.reduce((sum, item) => sum + item.size, 0);
    const emit = (current) => {
      const now = Date.now();
      if (now - lastEmit < 180) return;
      lastEmit = now;
      onProgress({
        phase: 'copy',
        processed: files,
        total,
        linked,
        copied,
        skipped,
        savedBytes: linkedBytes,
        bytesDone: linkedBytes,
        totalBytes,
        current,
      });
    };

    for (const entry of entries) {
      if (signal?.cancelled) break;
      const from = path.join(src, entry.rel);
      const to = path.join(dst, entry.rel);
      files += 1;
      try {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        let exists = false;
        try {
          await fsp.access(to);
          exists = true;
        } catch {
          exists = false;
        }
        if (exists) {
          skipped += 1;
          emit(entry.rel);
          continue;
        }
        try {
          await fsp.link(from, to);
          linked += 1;
          linkedBytes += entry.size;
        } catch (linkError) {
          /* 跨盘 / 非 NTFS / 权限不足：退化成复制，功能不受影响，只是多占空间 */
          await fsp.copyFile(from, to);
          copied += 1;
          errors.push(`无法硬链接、已改为复制：${entry.rel}（${linkError.code || linkError.message}）`);
        }
      } catch (error) {
        errors.push(`写入失败：${entry.rel}（${error.message}）`);
      }
      emit(entry.rel);
    }

    /* 最后补一次满进度，避免界面停在 99% */
    onProgress({
      phase: 'copy',
      processed: files,
      total,
      linked,
      copied,
      skipped,
      savedBytes: linkedBytes,
      bytesDone: linkedBytes,
      totalBytes,
      current: '完成',
    });

    return {
      ok: errors.length === 0,
      cancelled: Boolean(signal?.cancelled),
      total,
      processed: files,
      linked,
      copied,
      skipped,
      savedBytes: linkedBytes,
      totalBytes,
      errors: errors.slice(0, 50),
      mirrored: true,
    };
  }
  /**
   * 蓝色星原：硬链接生成一份（官方托管体系之外，唯一能做的「多服」能力）。
   *
   * 为什么需要这个函数：
   *   servers:prepare-sophon 的白名单里原本只有米哈游三游 + 崩坏3 + 终末地/方舟/鸣潮，
   *   蓝原点「硬链接生成一份」会直接抛「这个游戏没有接入 Sophon 清单」——
   *   和终末地当年撞的是同一个坑（见下面 prepareEndfieldRuntimeJob 的注释）。
   *
   * 和别的游戏的根本区别：蓝原没有任何可用的逐文件远端清单
   *   · 官方启动器那套 _index 清单是私有加密格式，且只有下载时才下发
   *   · 我们拿不到 downloadUrl，也就没法算「还要补多少」
   * 所以这里**不做「补差异分块」**，只做纯本地硬链接：
   *   以已装客户端为源，把内容完全相同的文件链过去，差异文件原样不碰。
   *
   * 这也正是用户要的效果：「弄个B服的修复功能过来，然后拿官服硬链接过来，
   * 修复不就可以对比出来差异文件了吗」。linkTrees 的判据天然就是
   * 「目标目录有什么才比什么」，差异文件自然留在原地，等于把差异标出来了。
   */
  async function prepareAzurRuntimeJob(game, input = {}) {
    const server = (game.servers || []).find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    if (await pruneStaleRunning()) pushState(true);
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再生成');

    const channel = String(server.channel || '');
    /*
     * 基础客户端：同游戏下另一个渠道、且目录里真有 AzurPromilia.exe 的。
     * 蓝原的客户端结构是 <盘>\AzurPromilia_Game 一整份，没有子目录层级差异，
     * 所以只要求「另一个渠道 + exe 在」这两条。
     */
    const azurExeAt = (root) => {
      if (!root) return '';
      const exe = path.join(root, 'AzurPromilia.exe');
      return targetExists(exe) ? exe : '';
    };
    const candidates = (game.servers || []).filter(
      (item) =>
        item.id !== server.id &&
        String(item.channel || '') !== channel &&
        item.root &&
        !String(item.root).includes('VelaRuntimes') &&
        azurExeAt(item.root)
    );
    if (!candidates.length) {
      throw new Error(
        `还没有另一个蓝色星原渠道的安装目录可以当源。请先装一个别的渠道（官服 / B服 / 国际服 都行），或在服务器管理里把已装的客户端指到对应那一行，再回来生成。`
      );
    }
    // 官服优先当源：内容最全，复用率最高
    candidates.sort((a, b) => {
      const rank = (x) => (x.channel === 'official' ? 0 : x.channel === 'bilibili' ? 1 : 2);
      return rank(a) - rank(b);
    });
    const baseRoot = candidates[0].root;
    const baseName = candidates[0].name || '另一个渠道';

    const runtime = runtimePaths(baseRoot, 'azurpromilia', channel, input?.runtimeRoot);
    if (!runtime.sameDrive) {
      throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改「运行时目录」`);
    }
    /* 不得互相嵌套：嵌进去会把源客户端原地改写 */
    const normDir = (v) => path.resolve(String(v || '')).replace(/[\\/]+$/, '').toLowerCase();
    const a = normDir(baseRoot);
    const b = normDir(runtime.target);
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
      throw new Error('运行时目录不能和基础客户端是同一个目录，也不能互相嵌套，请换个「运行时目录」再试');
    }

    /* ── 估算分支：只读，不动任何文件 ── */
    if (input?.estimate) {
      const space = await estimateRuntimeSpace(baseRoot, runtime.target);
      /*
       * 蓝原拿不到远端清单，所以「还要下多少」恒为 0 —— 这条链路不下任何东西。
       * 界面那边 copyBytes=0 会显示「不需要额外下载」，这是事实而不是失败。
       */
      let preview = null;
      try {
        preview = await previewTrees({
          sourceRoot: baseRoot,
          targetRoot: runtime.target,
          mode: 'fast',
          onProgress: () => {},
        });
      } catch {
        preview = null;
      }
      return {
        ok: true,
        estimate: true,
        drive: space.drive,
        freeBytes: space.freeBytes,
        baseBytes: space.baseBytes,
        copyBytes: 0,
        copyFiles: 0,
        partial: space.partial,
        targetRoot: runtime.target,
        // 已经存在目标目录时，把「现在能合并多少」提前算出来给界面看
        matchable: preview ? preview.matchable : null,
        matchableBytes: preview ? preview.matchableBytes : null,
        baseName,
        plan: null,
      };
    }

    /* ── 真跑 ── */
    /*
     * 硬链接安全加固（2026-11-26）：真正写盘前做两件事：
     *   ① 进程探活：有游戏/官方启动器正从源目录或目标目录运行就拒绝，
     *      避免写到一半被占用（EPERM/EBUSY）或把运行时改成半新半旧；
     *   ② 启动占位：正在启动中的游戏同样视为「忙碌」，避免 spawn 之后、
     *      进程还没被识别出来的那几秒空档。
     */
    {
      const hardlinkGuard = require('./hardlink-guard');
      hardlinkGuard.assertNoGameRunning([baseRoot, runtime.target], '生成蓝色星原运行时');
      if (launching.has(game.id)) {
        throw new Error('这个游戏正在启动中，请等它启动完成或先关闭，再生成硬链接运行时。');
      }
    }
    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = createCancelSignal();
    sophonJobs.set(jobId, signal);
    beginBackgroundTask();
    try {
      const emit = (progress) => sendProgress('sophon:progress', jobId, progress);
      emit({ phase: 'start', processed: 0, total: 0, current: `正在以「${baseName}」为源生成…` });

      /*
       * linkTrees 要求源和目标都已是目录（它第一件事就是 fsp.stat 两边）。
       * 新生成的渠道运行时目录当然还不存在，这里先建出来。
       * 别的游戏（鸣潮/终末地）由各自引擎负责建目录，所以没暴露这个问题。
       */
      await fsp.mkdir(runtime.target, { recursive: true });

      /*
       * linkTrees 的判据是「目标目录里已有什么，就从源里链什么」。
       * 全新运行时目录是空的 → 一个候选都没有 → 什么都不做。
       * 那样用户点了「生成」只会得到一句「目标目录里没有 AzurPromilia.exe」。
       *
       * 所以空目录时改成「整树铺过去」：把源目录的每个文件都按原结构硬链接到目标。
       * 这才是「生成一份」的真正语义 —— 不是去重，而是造出第二份可独立启动的目录，
       * 且与源共用同一份磁盘数据。
       */
      const targetEmpty = await fsp.readdir(runtime.target).then((list) => list.length === 0).catch(() => true);
      let result;
      if (targetEmpty) {
        emit({ phase: 'copy', processed: 0, total: 0, current: `正在把「${baseName}」整树硬链接过来…` });
        result = await mirrorTreeByHardLink({
          sourceRoot: baseRoot,
          targetRoot: runtime.target,
          signal,
          onProgress: emit,
        });
      } else {
        result = await linkTrees({
          sourceRoot: baseRoot,
          targetRoot: runtime.target,
          mode: 'full',
          signal,
          onProgress: emit,
        });
      }
      if (signal.cancelled) return { ok: false, cancelled: true };

      /*
       * ★ 关键一步：把「渠道差异文件」从硬链接里独立出来。
       *
       * 为什么必须做（2026-11-26 用户实测报障）：
       *   硬链接会把官服目录整棵树原样铺过去，包括
       *     mj_sdk/res/app_config.dat
       *   这个文件里写着 channel_code=C000（官服）。游戏进程读它来判断自己属于哪个渠道，
       *   于是「用 B服 启动器拉起来，进游戏后还是官服」。
       *
       *   之前用户那次能进 B服，是因为 B服 官方启动器跑了一次「修复」，把 83 个渠道件
       *   换成了 C001 版本（文件被重写 → 硬链接断开 → 变成独立文件）。
       *   只做硬链接、不换渠道件，就必然是「启动器是 B服、游戏是官服」。
       *
       * 做法：用目标渠道的 _index 清单，把「与源内容不同」的文件
       * 从源目录复制一份独立的过来（先 unlink 断链，再写入）。
       *   · 目标渠道有清单 → 按清单精确定位差异文件（83 个 / 493MB）
       *   · 没有清单 → 至少把已知的渠道关键文件单独处理
       */
      let channelFiles = null;
      try {
        const azurChannelFiles = require('./azur-channel-files');
        channelFiles = await azurChannelFiles.ensureChannelRuntime({
          root: runtime.target,
          channel,
          onLog: (m) => writeLaunchLog(m),
          onProgress: emit,
          signal,
        });
        if (!channelFiles.ok && channelFiles.errors && channelFiles.errors.length) {
          writeLaunchLog(`[azur] 渠道文件自愈未全部成功：${channelFiles.errors.slice(0, 3).join('；')}`);
        }
      } catch (error) {
        writeLaunchLog(`[azur] 渠道文件自愈失败：${error.message}`);
      }
      if (channelFiles) {
        result.channelFiles = channelFiles;
        writeLaunchLog(
          `[azur] 渠道差异文件：独立 ${channelFiles.replaced} 个` +
            (channelFiles.downloaded ? ` / 下载 ${channelFiles.downloaded} 个` : '') +
            (channelFiles.errors.length ? ` / 失败 ${channelFiles.errors.length} 个` : '')
        );
      }

      const exe = azurExeAt(runtime.target);
      if (!exe) {
        throw new Error(
          `生成完成，但目标目录里没有 AzurPromilia.exe —— 说明源客户端本身不完整（${baseRoot}）。请先在源那一行确认客户端完好。`
        );
      }
      server.path = exe;
      server.rootDir = server.root;
      server.root = runtime.target;
      server.runtimeLinked = true;
      server.legacyRuntime = false;
      server.incomplete = false;
      game.activeServerId = server.id;
      game.target = exe;
      game.workDir = runtime.target;
      ensureServers(game);
      await store.saveNow();
      pushState(true);
      send('sophon:progress', { jobId, phase: 'done', processed: 1, total: 1, current: '完成' });
      return {
        ok: true,
        tag: server.name,
        linked: result.linked || 0,
        // 蓝原这条链路一个字节都不下载，会把差异文件留在原地由用户自己处理
        downloaded: 0,
        files: result.processed || 0,
        totalBytes: result.savedBytes || 0,
        skipped: result.skipped || 0,
        targetRoot: runtime.target,
        baseName,
      };
    } finally {
      endBackgroundTask();
      sophonJobs.delete(jobId);
    }
  }

  /**
   * 蓝色星原「修复」：没有官方逐文件清单，所以做的是**本地一致性修复**。
   *
   * 为什么不能照抄别的游戏：
   *   米哈游 / 鹰角 / 库洛 都能拿到「每个文件的 hash + 下载地址」的远端清单，
   *   修复 = 按清单逐文件校验，不一样的重新下。
   *   蓝原的清单（_index/<版本>）是私有加密格式、且只有下载时才下发 downloadUrl，
   *   我们既算不出「正确 hash」也下不到单个文件，所以那条路走不通。
   *
   * 那还能修什么？修「结构性问题」，这几类都是真实会发生的：
   *   ① 目录里有文件被删了 —— 从同机另一个渠道的客户端补回来（硬链接）
   *   ② 文件被改坏了 —— 比大小；大小一致时按需算 md5，和源不一致就用源覆盖
   *   ③ 占位的空文件 / 0 字节文件 —— 明显是下载中断的产物，同样从源补齐
   *   ④ 硬链接被切断（官方启动器重写过）—— 链接数回落但内容一致，重新链回源
   *
   * 返回里会把「修了什么、还差什么」分门别类，界面可以如实展示。
   */
  async function repairAzurGame({ root, channel, onProgress = () => {}, dryRun = false }) {
    const game = store.data.games.find((item) => item.builtinKey === 'azurpromilia');
    if (!game) throw new Error('没有找到蓝色星原');
    const targetRoot = path.resolve(root);
    if (!fs.existsSync(targetRoot)) throw new Error('这个渠道的客户端目录不存在');

    /* 找一个别的渠道当源（官服优先） */
    const azurExeAt = (dir) => {
      if (!dir) return '';
      const exe = path.join(dir, 'AzurPromilia.exe');
      return targetExists(exe) ? exe : '';
    };
    const sources = (game.servers || [])
      .filter(
        (item) =>
          String(item.channel) !== String(channel) &&
          item.root &&
          !String(item.root).includes('VelaRuntimes') &&
          azurExeAt(item.root) &&
          path.resolve(item.root).toLowerCase() !== targetRoot.toLowerCase()
      )
      .sort((a, b) => {
        const rank = (x) => (x.channel === 'official' ? 0 : x.channel === 'bilibili' ? 1 : 2);
        return rank(a) - rank(b);
      });
    if (!sources.length) {
      throw new Error('没有另一个渠道的完整客户端可以当修复源。请先装好官服或另一个渠道的客户端。');
    }
    const sourceRoot = sources[0].root;
    const sourceName = sources[0].name || '另一个渠道';

    /* 先把源目录建成 rel(小写) → {abs,size} 的索引 */
    const sourceIndex = new Map();
    const collectSource = (rel) => {
      const abs = rel ? path.join(sourceRoot, rel) : sourceRoot;
      let items;
      try {
        items = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const childRel = rel ? path.join(rel, item.name) : item.name;
        if (item.isDirectory()) {
          collectSource(childRel);
        } else if (item.isFile()) {
          let size = 0;
          try {
            size = fs.statSync(path.join(sourceRoot, childRel)).size;
          } catch {
            size = 0;
          }
          sourceIndex.set(childRel.toLowerCase(), { rel: childRel, size });
        }
      }
    };
    collectSource('');

    /* 再扫目标，分成「缺的 / 空的 / 大小不对的 / 好的」 */
    const missing = [];
    const empty = [];
    const sizeBad = [];
    const good = [];
    const targetFiles = [];
    const collectTarget = (rel) => {
      const abs = rel ? path.join(targetRoot, rel) : targetRoot;
      let items;
      try {
        items = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const childRel = rel ? path.join(rel, item.name) : item.name;
        if (item.isDirectory()) {
          collectTarget(childRel);
        } else if (item.isFile()) {
          targetFiles.push(childRel);
        }
      }
    };
    collectTarget('');

    /* 源里有、目标没有 → 缺失 */
    for (const [keyLower, info] of sourceIndex) {
      if (!targetFiles.some((f) => f.toLowerCase() === keyLower)) missing.push(info.rel);
    }

    /* 目标里每个文件对一遍 */
    for (const rel of targetFiles) {
      const abs = path.join(targetRoot, rel);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size === 0 && st.isFile()) {
        const src = sourceIndex.get(rel.toLowerCase());
        /* 源里这个文件不是 0 字节，才算是「坏的空壳」 */
        if (src && src.size > 0) {
          empty.push(rel);
          continue;
        }
        good.push(rel);
        continue;
      }
      const src = sourceIndex.get(rel.toLowerCase());
      if (!src) {
        /* 源里没有：可能是渠道独有文件（B服的渠道件），原样保留 */
        good.push(rel);
        continue;
      }
      if (src.size !== st.size) {
        sizeBad.push(rel);
        continue;
      }
      good.push(rel);
    }

    const needFix = [...missing, ...empty, ...sizeBad];
    const summary = {
      total: targetFiles.length + missing.length,
      sourceName,
      sourceRoot,
      missing: missing.length,
      empty: empty.length,
      sizeMismatch: sizeBad.length,
      needFix: needFix.length,
      good: good.length,
      dryRun,
    };

    if (dryRun) {
      onProgress({ phase: 'scan', processed: summary.total, total: summary.total, current: '扫描完成', ...summary });
      return { ok: true, ...summary, fixed: 0, samples: needFix.slice(0, 40) };
    }

    /* 开修：缺的 / 空的 / 大小不对的，全部从源硬链接（同盘）或复制（跨盘） */
    let fixed = 0;
    let linked = 0;
    let copied = 0;
    const errors = [];
    for (let i = 0; i < needFix.length; i += 1) {
      const rel = needFix[i];
      const from = path.join(sourceRoot, rel);
      const to = path.join(targetRoot, rel);
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        try {
          fs.unlinkSync(to);
        } catch {
          /* 不存在就算了 */
        }
        try {
          fs.linkSync(from, to);
          linked += 1;
        } catch (linkError) {
          fs.copyFileSync(from, to);
          copied += 1;
        }
        fixed += 1;
      } catch (error) {
        errors.push(`${rel}: ${error.message}`);
      }
      if (i % 200 === 0 || i === needFix.length - 1) {
        onProgress({
          phase: 'repair',
          processed: i + 1,
          total: needFix.length,
          current: rel,
          fixed,
          ...summary,
        });
      }
    }

    return {
      ok: errors.length === 0,
      ...summary,
      fixed,
      linked,
      copied,
      errors: errors.slice(0, 40),
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

    /*
     * 硬链接安全加固（2026-11-26）：写盘前做进程探活 + 启动占位检查。
     * 游戏运行中做生成/修复，最容易在替换可写索引或大文件时被句柄咬住，
     * 表现为任务中途 EPERM、界面卡在某个百分比。
     */
    {
      const hardlinkGuard = require('./hardlink-guard');
      hardlinkGuard.assertNoGameRunning([baseRoot, runtime.target], '生成终末地运行时');
      if (launching.has(game.id)) {
        throw new Error('这个游戏正在启动中，请等它启动完成或先关闭，再生成硬链接运行时。');
      }
    }

    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = createCancelSignal();
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
    /*
     * Yostar 三区（EN/JP/KR）走三区互为源的镜像分支：root 可以是空的（目录还没装出来，
     * 从另一个区生成）；国服 / B服 仍要求 root 已存在（硬链接基础客户端的旧链路）。
     */
    const isYostarTarget = yostarPacks.isYostarChannel(server.channel);
    const isTaiwanTarget = server.channel === 'taiwan';
    if (!isYostarTarget && !isTaiwanTarget && !ARKNIGHTS_CN_CHANNELS.includes(server.channel)) {
      throw new Error('国际服是各自独立的客户端，请直接指到它们自己的安装目录，不能用国服生成');
    }
    let baseRoot = String(server.root || '').trim();
    if (isTaiwanTarget && !baseRoot) {
      // 台服可以没有自己的目录：以国服官服 / B服 已装客户端为源生成一份
      const source = (game.servers || []).find(
        (item) =>
          item.id !== server.id &&
          ['official', 'bilibili'].includes(String(item.channel || '')) &&
          item.root &&
          fs.existsSync(path.join(item.root, 'Arknights.exe'))
      );
      if (!source) {
        throw new Error('还没有国服明日方舟的安装目录可以当源：先用官方启动器装一份国服，台服就能从它硬链接生成');
      }
      baseRoot = String(source.root || '').trim();
    }
    if (!isYostarTarget && (!baseRoot || !fs.existsSync(baseRoot))) {
      throw new Error('这个服务器还没有客户端目录，先在它那一行点“编辑”把目录指到明日方舟的安装目录');
    }
    if (isYostarTarget && !baseRoot) {
      throw new Error('这个服务器还没有客户端目录：先用「下载游戏」装一个国际服，或把目录指到已有的国际服客户端');
    }
    if (isYostarTarget && input?.estimate) {
      // 三区互切的空间估算：从另一个区运行时算「可硬链 / 需下载」的真实数字
      const source = (game.servers || []).find(
        (item) => item.id !== server.id && yostarPacks.isYostarChannel(item.channel) && item.root && fs.existsSync(item.root)
      );
      if (!source) {
        return {
          estimate: true,
          needBytes: 0,
          note: '还没有其它国际服安装目录可以当源（先用「下载游戏」装一个），生成时会改为完整下载',
        };
      }
      const plan = await yostarPacks.planCrossRuntime({
        sourceRoot: source.root,
        targetProfile: server.channel,
      });
      return {
        estimate: true,
        needBytes: Number(plan.downloadBytes) || 0,
        hardlinkBytes: Number(plan.hardlinkBytes) || 0,
        downloadCount: plan.downloadCount,
        hardlinkCount: plan.hardlinkCount,
        note: `可硬链接 ${plan.hardlinkCount} 个（${((Number(plan.hardlinkBytes) || 0) / 1024 ** 3).toFixed(2)} GB），需下载 ${plan.downloadCount} 个（${((Number(plan.downloadBytes) || 0) / 1024 ** 3).toFixed(2)} GB）`,
      };
    }
    const runtime = runtimePaths(baseRoot, 'arknights', server.channel, input?.runtimeRoot);
    if (!runtime.sameDrive) {
      throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
    }
    if (path.resolve(baseRoot).toLowerCase() === path.resolve(runtime.target).toLowerCase()) {
      throw new Error('运行时目录不能和基础客户端是同一个目录，请换个“运行时目录”再试');
    }
    if (isTaiwanTarget && input?.estimate) {
      return {
        estimate: true,
        needBytes: 0,
        hardlinkBytes: 0,
        downloadCount: 0,
        hardlinkCount: 0,
        note: '台服与国服同协议，可从国服客户端硬链接生成：内容相同的直接复用，不一致的按台服官方清单补下',
      };
    }
    if (!isYostarTarget && input?.estimate) return estimateRuntimeSpace(baseRoot, runtime.target);

    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = createCancelSignal();
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
    // 鸣潮：三渠道全走库洛官方 index.json 清单引擎（kuro-packs.js）
    wutheringwaves: 'kuro',
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
    if (gameKey === 'wutheringwaves') {
      // WeGame 版没有库洛官方清单（它在 WeGame 商店里下），别把它当 kuro 引擎
      // 再去报一句费解的「没有对应的鸣潮渠道」。
      if (!kuroPacks.isKuroChannel(channel)) return '';
      return 'kuro';
    }
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
      if (channel === 'taiwan') return ARKNIGHTS_TW_PROFILE;
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
        report.filesBlocked.push(path.basename(target));
      } finally {
        // 探的是用户真实的 exe/dll，改名后必须在 finally 里搬回原名：
        // 中间再抛任何异常都不能把真文件留在 X.exe.hxl-probe-* 上，否则游戏直接少一个文件。
        if (parkedOk) {
          try {
            await fsp.rename(parked, target);
          } catch (error) {
            // 搬回失败不抛（预检本身不能把更新流程炸掉），但必须记日志、且判为被挡：
            // 真文件此刻还停在探针名下，绝不能吞掉错误还报「可写」放行更新（预检会误判）。
            console.warn(`[update] 探针文件搬回失败 ${parked} -> ${target}：${String(error?.message || error)}`);
            report.filesBlocked.push(`${path.basename(target)}（探针搬回失败，真文件暂留在 ${path.basename(parked)}）`);
          }
        }
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

  /** 官方清单口径的全量体积：sophon 读清单，终末地 / 明日方舟读整包卷 total_size，Yostar / 库洛读远端清单。 */
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
    if (engine === 'kuro') {
      // 鸣潮：同 Yostar 口径，planForGame 返回清单求和的真实下载量
      const plan = await kuroPacks.planForGame({ profile: server.channel, installRoot: installDir });
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
        : game.builtinKey === 'wutheringwaves'
          ? predownload.kuroInstallRoot(server)
          : predownload.hoyoInstallRoot(server);
    if (!installRoot) throw new Error('还没有配置这个游戏的客户端目录');
    /*
     * 渠道以客户端自己的 config.ini 为准（2.9.1）。
     * 老数据里可能把国际服客户端记在官服那一行，repairServerChannels 会搬走，
     * 但「点更新」这条链不该依赖那次修复已经跑过：这里再问一次客户端本身，
     * 免得拿着 nap_cn / hkrpg_cn 去和国际服客户端比对版本。
     */
    // 鸣潮的渠道记在 launcherDownloadConfig.json，不是米哈游那套 config.ini；
    // 拿 configChannelFromPath 去问只会读出空或误判成 official，直接用渠道行本身。
    const clientChannelOfServer =
      game.builtinKey === 'endfield' || game.builtinKey === 'wutheringwaves'
        ? ''
        : clientChannel.resolveChannelFromRoot(path.dirname(server.path)).channel;
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
  /*
   * 「有官方更新可应用」的提醒（2026-11-26 二改）。
   * 原来是 30 分钟的进程内节流：计时器一重启就清零，用户每次开启动器点开始又看到一遍，
   * 即使用户暂时不想更新也天天被念。现在改成落盘 12 小时，跨会话有效。
   */
  const LAUNCH_PREFLIGHT_TTL = 12 * 60 * 60 * 1000;

  function launchPreflightNotice(game, server) {
    const key = `${game.id}:${server?.id || ''}`;
    const st = server?.predownload;
    if (!st || st.error || st.state !== 'update') return;
    // 只有真正要弹 toast 时才占用节流窗口：非 update 的启动不该烧掉 12 小时，
    // 否则随后官方放包、状态变成 update 时，提示会被这次空跑压住漏报。
    const settings = store.data.settings;
    const now = Date.now();
    const seenAt = Number((settings.launchPreflightNoticeAt || {})[key]) || 0;
    if (now - seenAt < LAUNCH_PREFLIGHT_TTL) return;
    settings.launchPreflightNoticeAt = { ...(settings.launchPreflightNoticeAt || {}), [key]: now };
    store.saveNow().catch(() => {});
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


  /*
   * ── 异环（neverness）官服 / B服 渠道 ─────────────────────────────────
   * 异环不是米哈游体系，没有 Sophon 清单，也不能用「重建 B服客户端」那套做法。
   * 它的渠道就写在启动器配置里：<安装目录>/NTELauncher/Config/Config.ini
   *   官服 Branch=publish_ob,   serialNumber=1
   *   B服  Branch=publish_ob_B, serialNumber=2, Partner=123
   * 所以这里只读写那三行，不动任何游戏文件。官方口径是「PC 端只支持官服」，
   * B服能否登录以实际为准 —— 这条提示放在返回的 notice 里，界面要显示出来。
   */

  /*
   * 切到 B服后一键拉起官方启动器下载 B服资源。
   * 官方启动器按 Config.ini 里的 VersionInfoFileURL 拉对应渠道的版本清单，
   * 资源只有首次需要下载，之后切来切去都是秒切，这一步只是为了省得用户手动去找。
   */

  /*
   * 预下载渠道资源：花筱灵自己按官方清单把对应渠道的启动器侧文件铺齐，
   * 之后官方启动器启动就没有"下载"环节。可取消。
   */
  let ntePredownloadAbort = null;
  let nteToolAbort = null;

  /*
   * 异环抽卡导出工具一键获取：查 GitHub 最新 release → 下载（自动换镜像）→
   * 解压到系统下载目录并打开文件夹。可取消，进度走 send('nte-tool', ...)。
   */

  /*
   * 单个服务器覆盖「剧情分类资源包」开关。
   * 走独立 IPC 而不是扩 servers:update 的白名单，是为了不改动那个 handler 的现有逻辑。
   * 传 enabled=null 表示「不覆盖，跟随全局设置」。
   */


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
    return {
      ok: true,
      root,
      exists: fs.existsSync(root),
      /*
       * 硬链接运行时：这一份目录里绝大多数文件是链到官服本体的同一个 inode，
       * 删掉它只省得掉「真正独占的那几个渠道件」，空间不会像目录体积那样掉下来。
       * 前端要据此多说一句，不然用户删完看到没腾出空间会以为是没删干净。
       */
      runtimeLinked: Boolean(server?.runtimeLinked),
    };
  };


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



  /*
   * WeGame 版鸣潮转换：探针与执行入口。
   *
   * 背景（2026-11-11 用户验证 + B站评论区实测）：WeGame 版鸣潮与官方启动器版的
   * Client/ 主体是同一份文件，把官方版目录整树放进 WeGame 的下载目录
   * `WeGameApps\downloading\2002137\` 后，WeGame 能识别已就位的文件，
   * 只补 <1GB 的渠道件（TPS 登录 SDK 等）即可启动 —— 与官B服 99.24% 相似的
   * 结论完全一致。这条链路只往 WeGame 自己的目录写，绝不碰官方版本体。
   */
  /*
   * WeGame 目录 helper 一律用模块级（pathsOverlap 之后）的那一份：
   * WEGAME_WUWA_ID / WEGAME_WUWA_DIRNAME / WEGAME_LAUNCH_URI / wuwaExeAt /
   * findWeGameDownloadRoots / findWeGameWuwaRoots / findWeGameWuwaRoot。
   * 这里绝不重复定义：内层同名函数会遮蔽模块级版本，又退回「只认
   * downloading\2002137」的旧行为，而装好后 WeGame 会把目录搬到
   * rail_apps\Wuthering Waves(2002137)、downloading 目录直接消失。
   */



  /*
   * 官方背景：跟随鹰角「版本简报」页面自动换。
   * sync 是手动按钮 / 启动时共用的入口；official-state 给切换器出缩略图。
   */
  let officialSyncState = { busy: false, lastError: '', lastResult: null };



  /*
   * 打开覆盖脚本留下的日志。
   * 更新是在 detached 的 PowerShell 里做的，控制台没人看得到；
   * 用户报「更新没完成」时，让他把这个文件发回来就能定位到底卡在哪一步。
   */

  /** 直接把日志内容读回渲染层，省得用户还要去找文件。 */

  /*
   * 一键导出诊断信息到桌面。
   *
   * 不打包成 zip：导出的是一个纯文本文件，用户直接拖进聊天窗口就能发，不用先找
   * 压缩软件。内容只含版本、系统、设置摘要、网络请求元数据和已有日志；设置是
   * 按白名单逐项挑的，不是把 settings 整个 dump 出去——那里有账号和密钥。
   */



  /* ── 抽卡记录云备份：状态 / 保存 / 测试 / 列云端 / 恢复 ──────────────── */

  /** 手动「立即备份」：直接复用 runGachaBackup（内部有锁、成败记录、pushState）。 */

  /*
   * 启动器设置导出 / 导入。
   * 导出＝把 launcher-data.json 复制到用户挑的位置；导入＝读回文件后与默认合并
   * （只增不改：本地已有的键不会被远端文件的旧值冲掉，结构不符直接报错）。
   * 注意：sessions.enc.json（密码 / 加密口令等凭据）不在这份文件里，导出导入
   * 不会把别人的凭据带进来，也带不走你自己的凭据——这点和抽卡云备份一样。
   */


  // 异环：把导出目录开给用户，并把当前识别到的账号回给界面

  /*
   * SToken 账号管理。
   *
   * 只有这里能拿到完整的 stoken / ltoken，返回给渲染进程的一律是
   * listAccounts() 处理过的脱敏版本 —— 界面不需要真值，也就不给它。
   */

  /*
   * 扫码登录。
   *
   * 为什么要扫码：申请抽卡 authkey 的 genAuthKey 只认真正的 SToken，
   * 而启动器里内嵌的米游社网页登录只能拿到 ltoken_v2 —— 那条路实测一律 -100。
   * 手机米游社扫一下游戏二维码是唯一能自助拿到 SToken 的路径，
   * 而且扫码返回里带着 UID，用户不用开游戏、也不用自己抄任何东西。
   */
  let scanSession = null;

  /*
   * 扫码日志：只记状态码、stat、raw 长度和开头 160 字符，不记 token 本身。
   * 目的是回答「扫完为什么没反应」——这只能靠服务端的原始返回判断。
   */
  function qrLogPath() {
    return path.join(app.getPath('userData'), 'stoken-scan.log');
  }

  function qrLog(payload) {
    try {
      fs.appendFileSync(qrLogPath(), new Date().toISOString() + ' ' + JSON.stringify(payload) + '\n');
    } catch {
      /* 记日志失败不影响扫码本身 */
    }
  }

  function stopScanSession() {
    if (scanSession) {
      scanSession.stop();
      scanSession = null;
    }
  }



  /*
   * 插件文件都放在 userData/plugins 下，配置在 userData/plugins.json。
   * 这里只做文件层面的收发，真正执行在渲染层的 Worker 里（src/plugin-runtime.js）。
   * 一律返回 { ok, ... } 形状，不 throw —— 穿过 IPC 的异常会变成
   * "Error invoking remote method ..."，界面上没法读。
   */
  const pluginRoot = () => app.getPath('userData');



  /* ---------------- 截图管理 ---------------- */



  /* ---------------- 窗口材质 ---------------- */


  /** 查某个鹰角游戏的远端最新版，和本地版本对比。 */

  /** 打开官方启动器 / 官网 / 安装目录。 */

  /* ---------------- 画质配置 ---------------- */

  /** 自动探测出来的注册表项，画质页只看不写（写入另走 resolveGraphicsKey） */
  const GRAPHICS_DETECT_FILE = 'graphics-detect.json';

  /**
   * 探测结论的固定表：gameKey → { key, at }。
   *
   * 自动探测一次要 1.2~3.3 秒
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
   * 启动器一开起来就在后台把
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
/*
 * 失败签名与冷却时间。
 *
 * 去掉 running 那道闸之后，如果某条缓存里的链接已经过期（常见：绝区零的
 * authkey 过期后接口回 auth key time out），20 秒一轮就会一直重试同一个
 * 失败请求，白白发网络。这里记下「这份签名试过了、失败了」，冷却期内不再
 * 试；用户重新打开一次抽卡记录页 → data_2 的 mtime 变 → 签名变 → 立刻重试。
 */
const mihoyoGachaFailures = new Map();
const MIHOYO_GACHA_FAIL_COOLDOWN = 5 * 60 * 1000;
function startMihoyoGachaWatcher() {
  const MIHOYO = ['genshin', 'starrail', 'zzz'];
  /*
   * 一台机器上同一款游戏可能有多个渠道各存一份客户端（原神官服/国际服、星铁
   * 官服/B服/国际服），抽卡缓存是跟着「哪一份客户端跑过」走的。以前只看
   * activeServer 那一份：用户用 A 渠道玩了、切到 B 渠道之后，缓存明明更新了
   * 却看的是 B 的旧缓存 → 永远不同步。这里把该游戏所有配好路径的渠道都当候选。
   */
  const rootsOf = (game) => {
    const roots = [];
    const pushDir = (value) => {
      if (!value) return;
      let dir = value;
      try {
        if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
      } catch {
        return;
      }
      if (!roots.includes(dir)) roots.push(dir);
    };
    for (const server of game.servers || []) {
      pushDir(server.root); // 渠道根目录（独立运行时 / 本体目录）
      pushDir(server.path); // exe 路径，取所在目录
    }
    pushDir(game.target); // 兜底：当前启动程序
    return roots;
  };
  const attempt = async () => {
    if (mihoyoGachaWatching || store.data.settings.autoGacha === false) return;
    for (const game of store.data.games) {
      if (!MIHOYO.includes(game.builtinKey)) continue;
      /*
       * 这里以前有一句 `if (!running.has(game.id)) continue;`，是个真 bug：
       * running 是纯内存 Map，启动器一重启就空了，而 alwaysAdmin 会在启动时
       * 自己提权重启一次 —— 用户开游戏、再切回启动器，运行态就丢了，
       * 后面无论怎么打开抽卡记录页都不会自动同步（2026-11-11 用户报的就是这个）。
       * 更常见的情况是游戏根本就是绕过启动器直接开的，running 里当然没有。
       * 判据改成只看缓存签名：data_2 的 mtime 一变就说明用户在游戏里点开过
       * 抽卡记录页、链接已经刷新，跟「启动器认不认为游戏在跑」没有关系。
       * 游戏没开时缓存不会自己变，所以这不会造成空转。
       */
      for (const root of rootsOf(game)) {
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
        if (!signature) continue; // 这个渠道没装/没有网页缓存
        // 签名按「游戏 + 渠道目录」记，多渠道时互不干扰
        const key = `${game.id}\u0000${root}`;
        if (signature === mihoyoGachaSignatures.get(key)) continue;
        // 这份缓存刚试过且失败了，冷却期内不再重复打网络；签名一变（用户重新
        // 打开抽卡记录页）自然就走下一条，冷却带的是旧签名，不会误伤。
        // 限流时冷却会更长（error.cooldownMs），所以这里按记录里存的时长判。
        const failed = mihoyoGachaFailures.get(key);
        if (
          failed &&
          failed.signature === signature &&
          Date.now() - failed.at < (Number(failed.cooldownMs) || MIHOYO_GACHA_FAIL_COOLDOWN)
        ) continue;
        let api;
        try {
          api = extractUrlFromCache(root, game.builtinKey); // 抛错 = 还没缓存/链接未就绪
        } catch {
          continue; // 缓存还没就绪，不记签名，下个 tick 用同签名重试
        }
        mihoyoGachaWatching = true;
        try {
          const result = await syncGacha({ game: game.builtinKey, installRoot: root, userData: app.getPath('userData'), api });
          mihoyoGachaSignatures.set(key, signature); // 只有真的同步成功，才把这份缓存记为已处理
          mihoyoGachaFailures.delete(key);
          if (result.imported > 0) {
            send('gacha:updated', result);
            send('toast', { type: 'success', message: `${game.name || game.builtinKey} 抽卡记录已自动同步 ${result.imported} 条` });
          }
        } catch (error) {
          /*
           * 链接过期（authkey time out / 10001 / -100 / -101）、被限流（2001 /
           * visit too frequently）、或者另一条同步正在跑 —— 这三种都要记冷却，
           * 免得 20 秒一轮反复打。限流冷却拉长到 10 分钟：米哈游那边的窗口
           * 一般就是这个量级，5 分钟不够，会一进来就再撞一次。
           * 不弹 toast：用户此刻多半还没意识到要重新打开抽卡页，等他下次点开
           * 时签名一变就自动接上。
           */
          const cooldownMs = Number(error?.cooldownMs) || MIHOYO_GACHA_FAIL_COOLDOWN;
          mihoyoGachaFailures.set(key, { signature, at: Date.now(), cooldownMs });
          writeLaunchLog(
            `gacha ${game.builtinKey}: 自动同步失败（${error?.message || error}），这份缓存 ${Math.round(cooldownMs / 60000)} 分钟内不再重试`
          );
          /*
           * 链接过期是唯一一种「用户必须动手才能解决」的失败（进游戏点一次抽卡
           * 记录页）。把它单独发到前端，抽卡记录页顶部挂一条常驻提醒；同步成功
           * 或链接刷新（签名变化触发重试）后由前端自动撤掉。限流 / 忙这类不用
           * 用户动手的失败不发这条，免得提醒常驻却无事可做。
           */
          const messageText = String(error?.message || error || '');
          if (messageText.includes('过期')) {
            send('gacha:link-expired', { game: game.builtinKey, message: messageText });
          }
        } finally {
          mihoyoGachaWatching = false;
        }
      }
    }
  };
  setInterval(attempt, 20000);
}

/*
 * 鸣潮抽卡自动同步（2026-11-12）。
 *
 * 鸣潮跟米哈游不一样：它没有「本地抽卡缓存文件」，抽卡分享链接是游戏自己写进
 * `Client/Saved/Logs/Client*.log` 的（ELog XOR 加密，kuro-gacha.js 负责解密）。
 * 用户每一次在游戏里打开「抽卡记录」页并点分享，都会往这个日志里追加一条链接。
 *
 * 所以自动同步的触发条件就是「这个日志文件变大」：
 *   - 只 stat 文件大小，不整读几十 MB 的日志（和米哈游那套同样轻量）；
 *   - 签名按「游戏 + 渠道目录」记，多渠道互不干扰；
 *   - 只有真同步成功才把签名记为已处理，失败下个 tick 用同签名重试；
 *   - 失败记冷却，免得 20 秒一轮反复打网络（分享链接过期是常见失败）。
 * 这样用户在游戏里点一次分享，切回启动器最多 20 秒抽卡记录就自己进来了，
 * 不需要再手动点「同步」。
 */
let kuroGachaWatching = false;
const kuroGachaSignatures = new Map();
const kuroGachaFailures = new Map();
const KURO_GACHA_FAIL_COOLDOWN = 5 * 60 * 1000;

function startKuroGachaWatcher() {
  const rootsOf = (game) => {
    const roots = [];
    const pushDir = (value) => {
      if (!value) return;
      let dir = value;
      try {
        if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
      } catch {
        return;
      }
      if (!roots.includes(dir)) roots.push(dir);
    };
    for (const server of game.servers || []) {
      pushDir(server.root);
      pushDir(server.path);
    }
    pushDir(game.target);
    /*
     * 2026-11-17（bug 4）：上面 push 进去的目录不一定是本体根 ——
     * 老数据里 server.root 常常被填成 `Client\Binaries\Win64` 这一层，
     * 而日志目录在 `<本体根>\Client\Saved\Logs`（本体根在三层深，靠根目录的
     * launcherDownloadConfig.json 认定）。不做还原的话 logSignature(root) 拼出来的
     * 目录根本不存在 → 抽卡自动同步**永久静默**，用户完全不知道。
     *
     * 还原判据（两种）：
     *  1) 目录本身或其祖先里有 launcherDownloadConfig.json → 用 wuwaClientRootOf；
     *  2) 我们自己生成的运行时目录（VelaRuntimes\wutheringwaves\<channel>）
     *     没有那个 json → 改成「向上最多 5 层找第一个存在 Client\Saved\Logs 的祖先」。
     */
    const restored = [];
    for (const dir of roots) {
      let dir2 = dir;
      try {
        if (fs.statSync(dir2).isFile()) dir2 = path.dirname(dir2);
      } catch {
        continue;
      }
      const wuwaRoot = wuwaClientRootOf(dir2);
      if (wuwaRoot) {
        if (!restored.includes(wuwaRoot)) restored.push(wuwaRoot);
        continue;
      }
      // 运行时目录（无 launcherDownloadConfig.json）：向上找带 Client\Saved\Logs 的那层
      let dir3 = dir2;
      let picked = '';
      for (let depth = 0; depth < 5 && dir3; depth += 1) {
        if (fs.existsSync(path.join(dir3, 'Client', 'Saved', 'Logs'))) {
          picked = dir3;
          break;
        }
        const next = path.dirname(dir3);
        if (next === dir3) break;
        dir3 = next;
      }
      const finalDir = picked || dir2;
      if (!restored.includes(finalDir)) restored.push(finalDir);
    }
    return restored;
  };
  /* 日志签名：目录下 Client*.log 的「文件名:大小」。只 stat，不读内容。 */
  const logSignature = (root) => {
    const dir = path.join(root, 'Client', 'Saved', 'Logs');
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return '';
    }
    const parts = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^Client.*\.log$/i.test(entry.name)) continue;
      try {
        const stat = fs.statSync(path.join(dir, entry.name));
        parts.push(`${entry.name}:${stat.size}`);
      } catch {
        /* 文件正在被游戏写，stat 偶尔失败，下一轮再看 */
      }
    }
    parts.sort();
    return parts.join('|');
  };
  const attempt = async () => {
    if (kuroGachaWatching || store.data.settings.autoGacha === false) return;
    for (const game of store.data.games) {
      if (game.builtinKey !== 'wutheringwaves') continue;
      for (const root of rootsOf(game)) {
        const signature = logSignature(root);
        if (!signature) continue;
        const key = `${game.id}\u0000${root}`;
        if (signature === kuroGachaSignatures.get(key)) continue;
        const failed = kuroGachaFailures.get(key);
        if (
          failed &&
          failed.signature === signature &&
          Date.now() - failed.at < (Number(failed.cooldownMs) || KURO_GACHA_FAIL_COOLDOWN)
        ) continue;
        kuroGachaWatching = true;
        try {
          const result = await kuroGacha.syncWuwaGacha({
            installRoot: root,
            userData: app.getPath('userData'),
          });
          kuroGachaSignatures.set(key, signature);
          kuroGachaFailures.delete(key);
          if (result.imported > 0) {
            send('gacha:updated', result);
            send('toast', {
              type: 'success',
              message: `鸣潮抽卡记录已自动同步 ${result.imported} 条`,
            });
          }
        } catch (error) {
          /*
           * needShare（日志里没有可用分享链接）是最常见的：用户只是玩了游戏、
           * 没点过分享。不弹 toast、不挂常驻提醒，记冷却就好 —— 等他真的点了
           * 分享、日志变大，签名一变就自动接上。
           */
          const cooldownMs = Number(error?.cooldownMs) || KURO_GACHA_FAIL_COOLDOWN;
          kuroGachaFailures.set(key, { signature, at: Date.now(), cooldownMs });
          writeLaunchLog(
            `gacha wutheringwaves: 自动同步跳过（${error?.message || error}），这份日志 ${Math.round(
              cooldownMs / 60000
            )} 分钟内不再重试`
          );
        } finally {
          kuroGachaWatching = false;
        }
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
/*
 * 「按字节复核过、确认本地已经是某版本」的进程内缓存。
 *
 * checkEndfieldUpdateNotice 在启动时调用。版本号对不上时要复核一次（约 7~12 秒），
 * 复核结论在这个进程里不会变（文件不会自己改），所以同一个 root + 版本只算一次，
 * 避免用户来回开窗口时反复读几万个文件。
 */
const endfieldVerifyMemo = new Map();

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
    if (!local?.version || remote.version === local.version) return;

    /*
     * 版本号对不上，先别急着弹「发现新版本」—— 状态文件可能只是过期了。
     *
     * 用户报障（2026-11-26）：「终末地怎么老是提示新版本，明明已经是最新版了」。
     * 实测他那份 .vela-game-state.json 停在 1.6.4（11-08 04:43），
     * 而 Endfield.exe / index_main.json / VFS 都是 11-25 的时间戳，
     * 18 个 .blc 块索引与 1.7.2 清单完全一致、抽 16 个 .chk 也全对 —— 盘上早就是新版，
     * 只有那个 JSON 没跟上（它只在 updateEndfieldGame 成功时才会写）。
     *
     * 所以这里按字节复核一次：真对得上就顺手把状态文件修正，并且**不弹提示**。
     * 复核本身很轻：根目录重二进制 + .blc 全验，.chk 抽样。
     */
    let verify = null;
    try {
      const memoKey = `${server.root}|${remote.version}`;
      if (endfieldVerifyMemo.has(memoKey)) {
        verify = endfieldVerifyMemo.get(memoKey);
      } else {
        writeLaunchLog(`[endfield] 版本号不一致（${local.version} vs ${remote.version}），开始按字节复核`);
        const profile = profileForChannel(server.channel);
        const manifest = await loadRemoteManifest(profile, true);
        verify = await verifyLocalMatchesRemote({ root: server.root, remote: manifest, sampleLimit: 8 });
        writeLaunchLog(
          `[endfield] 复核完成 matched=${verify.matched} checked=${verify.checked} ` +
            `mismatched=${verify.mismatched} missing=${verify.missing}`
        );
        endfieldVerifyMemo.set(memoKey, verify);
      }
    } catch (error) {
      // 复核失败不改变原判断（宁可提示，也别漏报真的没更新）
      writeLaunchLog(`[endfield] 复核异常，退回提示：${error && error.message}`);
      verify = null;
    }

    if (verify && verify.matched) {
      /*
       * 本地文件确实已经是目标版本：把过期状态补齐，下次就不会再提示。
       * 用 remote 里已有的 version / manifestSha256，口径与 updateEndfieldGame 写的一致。
       */
      try {
        await fsp.writeFile(
          stateFile,
          JSON.stringify(
            {
              version: remote.version,
              manifestSha256: remote.manifestSha256,
              updatedAt: new Date().toISOString(),
              fileCount: remote.fileCount,
              reconciledFrom: local.version,
            },
            null,
            2
          ),
          'utf8'
        );
        writeLaunchLog(
          `[endfield] 状态文件已修正：${local.version} → ${remote.version}（按字节复核，文件本就已是最新）`
        );
      } catch {
        /* 写不进去就算了，至少这次不再误报 */
      }
      return;
    }

    /*
     * 同一渠道的同一版本只提醒一次（2026-11-26 二改）。
     * 以前每次启动都弹，用户感知就是「天天说发现新版本」；这条记录落盘，
     * 换版本才会重新提醒。真正更新完以后本地版本追上远端，这里也不会再走到。
     */
    const settings = store.data.settings;
    const lastNotice = settings.endfieldVersionNotice || {};
    if (
      lastNotice.version === String(remote.version) &&
      lastNotice.channel === String(server.channel || '')
    ) {
      return;
    }
    settings.endfieldVersionNotice = {
      version: String(remote.version),
      channel: String(server.channel || ''),
      at: new Date().toISOString(),
    };
    store.saveNow().catch(() => {});
    send('toast', {
      type: 'info',
      message: `终末地发现新版本 ${remote.version}，可在设置 → 终末地渠道包目录 → 更新游戏本体`,
    });
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
  /*
   * 卸载模式：只建卸载窗口，不加载 store、不探测游戏、不建托盘。
   *
   * 放在最前面是必须的 —— 后面任何一步（store.load / detectBuiltins / 提权检查）
   * 都可能弹窗、写日志、或者干脆卡住，而卸载只需要删文件。
   */
  if (isUninstallMode) {
    const { runUninstallWindow, performUninstall } = require('./uninstall');
    /*
     * 静默卸载：注册表的 QuietUninstallString 带 --silent。
     *
     * 以前没有这条分支，--silent 被忽略，照样弹窗口 —— 于是「静默」只是
     * 注册表里一个好看的字符串，任何走 QuietUninstallString 的调用方都会看到
     * 一个窗口，还能被用户点取消。这里按真静默处理：不建窗口，直接删，
     * 结果写进启动日志，进程退出码反映成败（0 成功 / 1 失败）。
     */
    if (isUninstallSilent) {
      const path = require('node:path');
      const installDir = path.dirname(process.execPath);
      performUninstall(installDir, () => {})
        .then((result) => {
          try {
            const line = `[${new Date().toISOString()}] 静默卸载 ${result.ok ? '成功' : '失败'}：${installDir} 移除 ${result.removed} 项，待清理 ${result.pending.length} 项${result.error ? '，错误：' + result.error : ''}`;
            require('node:fs').appendFileSync(path.join(installDir, 'data', 'uninstall.log'), line + '\n');
          } catch {
            /* data 目录可能已不可写，日志失败不影响卸载 */
          }
          setTimeout(() => app.exit(result.ok ? 0 : 1), 500);
        })
        .catch(() => app.exit(1));
      return;
    }
    runUninstallWindow({ BrowserWindow, ipcMain, app, rootDir: ROOT });
    return;
  }
  /*
   * 启动图必须第一个建出来。
   *
   * 以前这一句在 store.load() / ensureSeedData() / detectBuiltins() / 提权检查
   * 之后才执行，那几件事加起来要 1.4~1.6 秒（isElevated 还要同步跑一次
   * PowerShell，detectBuiltins 要扫一遍 8 个游戏的安装目录）。这段时间里进程
   * 一个窗口都没有，用户看到的就是「点了图标 → 黑屏一两秒 → 直接进主界面」，
   * 启动图根本没机会露面 —— 2026-11-16 用户报的正是这个。
   *
   * createSplashWindow() 本身不依赖 store，也不 await 任何东西（loadFile 是
   * fire-and-forget，show 在 ready-to-show 里），所以可以安全地提到最前面。
   * 别把它挪回后面：挪回去黑屏就回来。
   */
  if (process.env.HX_CAPTURE !== '1') createSplashWindow();
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
  /*
   * 文件记账库（借鉴 Starward 的 GameFileDatabase）。
   *
   * 打开失败不能让启动失败 —— 它只是「更准的记录方式」，没有它照样能跑
   * （endfieldClientReady 还会退回看目录标记）。所以整段 try/catch 兜住。
   */
  try {
    await gameFileDb.open(app.getPath('userData'));
  } catch (error) {
    console.error('[game-file-db] 打开失败（不影响启动）：', error && error.message);
  }
  /*
   * 音源开关一次性迁移。
   *
   * 旧版本把「网易云 + 咪咕」这组默认值写进了用户配置，可这两个现在都出不来声音
   * （本地 NeteaseCloudMusicApi 没部署、咪咕 listen-url 回 201007），默认配置下
   * 点歌必然失败。migrateLegacySourceFlags 只在「整组值还等于老默认」时才动手，
   * 用户自己改过的配置一律不动。
   */
  if (store.data.settings) {
    const migrated = migrateLegacySourceFlags(store.data.settings.musicSources);
    if (migrated) {
      store.data.settings.musicSources = migrated;
      await store.saveNow();
      console.log('[音源] 已把老默认的开关组合升级为当前默认（新增酷我）');
    }
  }
  /*
   * 主题包校准（2026-11-20）：settings 里记的是包 id + 那个包自带的配色。
   * 用户随时可能把 art-pack 下的目录删掉或改 theme.json，启动时按盘上的实况纠正一次：
   * 包没了回内置（不然所有 hxl-art:// 全部 404，界面上是一片空白），
   * 配色改了就跟上。这里不 push，紧接着 createWindow 会走首帧。
   */
  if (store.data.settings) {
    const themeResult = syncActiveThemePack(store, app.getPath('userData'));
    if (themeResult.changed) {
      if (themeResult.dropped) console.log('[主题包] 目录已不存在，回落到内置：' + themeResult.dropped);
      await store.saveNow();
    }
  }
  /*
   * 终末地安装目录自检（2026-11-21）：官方托管启动会临时把安装目录换成指向
   * 当前渠道运行时的 junction（点完就换回来）。万一上次启动器/系统异常退出，
   * junction 会留在那里 —— 下次启动必须复位，否则官方启动器和用户看到的
   * 「终末地安装目录」永远是那个渠道运行时。
   *
   * 只在「确认是链接」且「游戏/官方启动器都没在跑」时才动手；异常一律吞掉，
   * 绝不阻塞启动（这里失败也还有下次点开始游戏时的前置检查兜底）。
   */
  try {
    const endfieldGame = (store.data.games || []).find((item) => item && item.builtinKey === 'endfield');
    const efServer = endfieldGame
      ? (endfieldGame.servers || []).find((item) => item && item.id === endfieldGame.activeServerId)
      : null;
    const efRoot =
      (typeof endfieldOfficial.readGameInstallPath === 'function' && endfieldOfficial.readGameInstallPath()) ||
      String((efServer && efServer.originalRoot) || '').trim();
    if (efRoot) {
      const healed = endfieldOfficial.healBaseOnBoot(efRoot, {
        onLog: (msg) => console.log('[终末地] ' + msg),
      });
      if (healed && healed.changed) console.log('[终末地] 安装目录已从链接状态复原：' + efRoot);
    }
  } catch (error) {
    console.warn('[终末地] 安装目录自检失败（不影响启动）：', (error && error.message) || error);
  }
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
  /*
   * --no-elevate：上一次 UAC 没成功（用户点了「否」，或者 UAC 本身被安全软件拦了），
   * 这一次先用普通权限把启动器拉起来，不能让用户「点了启动器就没了」。
   *
   * 它只是「这一次」的结论，不该变成永久的否决票。
   */
  const noElevateArg = process.argv.includes('--no-elevate');
  /*
   * 用户拒绝提权后，隔多久才允许再试一次。
   * 太短（0）会变成「每次开启动器都弹 UAC」，用户会烦；太长等于永久否决。
   * 10 分钟足够让用户在「刚拒过、马上又想给权限」的场景下等一等就好。
   */
  const ELEVATION_DECLINE_COOLDOWN_MS = 10 * 60 * 1000;
  if (noElevateArg && !currentElevation()) {
    store.data.settings.elevationDeclined = true;
    store.data.settings.elevationDeclinedAt = Date.now();
  }
  /*
   * 已经是管理员：那条「用户拒绝过 UAC」的记录就没有意义了，清掉。
   */
  if (currentElevation()) {
    store.data.settings.elevationDeclined = false;
    store.data.settings.elevationDeclinedAt = 0;
  }
  /*
   * 老数据自愈：历史版本只写了 elevationDeclined 布尔、没有时间戳，
   * 而那个布尔正是死锁的来源。没有时间戳就说明不知道是什么时候拒的，
   * 一律当作「早就过期」，允许重新提权一次。
   */
  if (store.data.settings.elevationDeclined && !Number(store.data.settings.elevationDeclinedAt || 0)) {
    store.data.settings.elevationDeclined = false;
  }
  const declinedAt = Number(store.data.settings.elevationDeclinedAt || 0);
  const recentlyDeclined = declinedAt > 0 && Date.now() - declinedAt < ELEVATION_DECLINE_COOLDOWN_MS;
  if (
    store.data.settings.alwaysAdmin &&
    // 走缓存：currentElevation() 在本进程内只探一次（正常路径是 whoami，约 100ms，
    // 只有 whoami 不可用时才落到 powershell 兜底）。这里没有理由重算。
    !currentElevation() &&
    // 用「最近刚拒过」代替「曾经拒过」：这是本次修复的核心，
    // 永久布尔会把用户永远锁在普通权限里。
    !recentlyDeclined &&
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

  /*
   * 升级后自动清掉旧版本遗留的 sophon 分块缓存（10.99 GB / 10588 个文件那堆）。
   *
   * 为什么不 await：这是纯后台维护动作，删一万一多个文件在机械盘上要几秒，
   * 绝不能挂在启动链上拖慢窗口。setTimeout 3 秒也只是错开首帧和 IPC 注册。
   *
   * 为什么不阻塞判断：分块缓存同时被三条链路占着 —— 下载管理器的普通下载、
   * sophon 安装/修复（sophonJobs）、预下载（predownloadJobs）。三张表里任意一张
   * 非空就不清，也不写标记，下次启动再试（正在续传的包可能还指着这份缓存）。
   *
   * 顺序铁律不动：这一段插在 installShotProtocol / createWindow 之前，但它是
   * 定时器回调、不占启动链，createWindow → installTray → installIpc 的相对顺序原样保留。
   */
  setTimeout(() => {
    try {
      purgeLegacyChunkCache({
        userData: app.getPath('userData'),
        version: APP_VERSION,
        isBusy: () => {
          // ① 下载管理器里的普通下载（downloads.js 的状态名：downloading / queued）
          if (
            Array.isArray(downloads?.items) &&
            downloads.items.some(
              (item) => item && (item.status === 'downloading' || item.status === 'queued')
            )
          ) {
            return true;
          }
          // ② 正在跑的 sophon 安装 / 修复：这些正是往 chunks 里读写分块的那条链路
          if (sophonJobs.size > 0) return true;
          // ③ 预下载任务：同样可能走分块缓存
          if (predownloadJobs.size > 0) return true;
          return false;
        },
        log: writeLaunchLog,
      }).catch(() => {
        /* 清理失败不影响使用：模块内部已经兜底，这里只防未处理的 rejection */
      });
    } catch {
      /* ignore */
    }
  }, 3000);

  /*
   * 启动时顺带清掉老版本留下的终末地语音包备份（endfield-persistent-backup，约 7.39 GB）。
   *
   * 老用户不一定马上重建运行时，所以不能只依赖 buildEndfieldChannelRuntime 里那一次调用。
   * 同样是定时器回调、不 await、不占启动链；有终末地任务在跑时 cleanup 内部会自己跳过。
   * 和上面 purgeLegacyChunkCache 一样错开 3 秒，避免和首帧抢磁盘。
   */
  setTimeout(() => {
    cleanupLegacyEndfieldBackup().catch(() => {
      /* 清理失败不影响使用：函数内部已经写日志兜底 */
    });
  }, 3000);

  /*
   * 统一的升级迁移表（electron/migrations.js）。
   *
   * 上面两处（purgeLegacyChunkCache / cleanupLegacyEndfieldBackup）有更精细的
   * 「当前有任务在跑就先别清」判断，所以保留它们。这里跑的是**其它那些零散
   * 没人管的遗留**：旧架构运行时目录、废弃的会话文件、崩溃残留的临时配置等。
   *
   * 为什么要有专门一张表而不是继续加 if：
   *   每加一个就得记得再写一个函数、再挂一次启动，漏了就永久残留（用户只看到
   *   硬盘越来越占）。声明式迁移表每条都有 id，跑过写标记，新增条目对老用户
   *   也会执行；清理失败不写标记，下次启动重试。
   *
   * 放在 4.5 秒：错开上面两个 3 秒的，也错开首帧渲染。
   */
  setTimeout(() => {
    runMigrations({
      userData: app.getPath('userData'),
      version: APP_VERSION,
      onLog: writeLaunchLog,
    })
      .then((r) => {
        if (r.removed > 0) {
          writeLaunchLog(`[migrations] 升级清理完成：清掉 ${r.removed} 项，释放 ${(r.freed / 1048576).toFixed(1)} MB`);
        }
      })
      .catch(() => {
        /* 清理失败不影响使用：模块内部逐条兜底 */
      });
  }, 4500);

  // 协议必须在创建任何窗口之前注册好，否则首帧里的 <img src="hxl-shot:..."> 会 404
  installShotProtocol();
  // 可选素材包协议：同样要在 createWindow 之前，否则首页装饰图第一帧 404
  installArtProtocol();
  // 音乐缓存协议：同样必须在创建窗口之前注册，否则 hxl-audio:// 的 <audio> 会静默不播
  try {
    const musicCache = require('./music-cache');
    musicCache.setSettingsProvider(() => store?.data?.settings);
    musicCache.installMusicCacheProtocol();
  } catch (error) {
    console.warn('[music-cache] 协议注册失败:', error?.message || error);
  }

  /*
   * 顺序很重要，别调回去：
   *
   * `installIpc()` 会把 win / tray 作为「按值参数」发给 14 个 IPC 模块
   * （window / dialog / app / gacha / music / settings / skland / endfield /
   *  hoyolab / passport / plugin / misc / update / live）。这些模块内部拿到的是
   * 启动那一刻的快照 —— 如果 installIpc() 跑在 createWindow() 之前，
   * 快照里的 win 就是 null，于是关闭、最小化、最大化、所有「以主窗口为父窗口」
   * 的对话框全部静默失效（点关闭没反应就是这么来的）。
   *
   * tray 同理：installTray() 原本在最下面，installWindowIpc 拿到的 tray 是 null，
   * 「收进托盘」那条分支永远走不到。
   *
   * 所以：先把窗口和托盘建出来，再注册 IPC。
   *
   * 注意 splash 不在这里建 —— 它已经提到 whenReady 的最开头了（那里一个
   * await 都还没开始）。这里只建主窗和托盘。
   */
  createWindow();
  installTray();

  const ipc = installIpc();
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
  setTimeout(startKuroGachaWatcher, 5000);
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
  /* installTray() 已经在创建窗口时提前调用过了（IPC 注册需要拿到真实 tray） */
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

  /*
   * 老用户记账补齐（借鉴 Starward 的 GameFileDatabase）。
   *
   * 从旧版本升级上来的用户，运行时目录早就建好了，但 GameFile.db 里没有它们的记录。
   * 这里启动 8 秒后（避开启动高峰）在后台扫一遍，把文件补记进库。
   * 补完以后就能用「查表验证完整性」替代「看 runtimeLinked 布尔字段」了。
   *
   * 为什么要等 8 秒：全盘 stat 上万个文件要几秒，虽然不阻塞主线程（异步 IO），
   * 但会抢磁盘 IO，和启动时的资源扫描打架。等启动稳下来再做。
   */
  if (process.env.HX_CAPTURE !== '1' && process.env.HX_SMOKE !== '1') {
    setTimeout(() => {
      const efGame = (store?.data?.games || []).find((g) => g.builtinKey === 'endfield');
      if (!efGame) return;
      backfillGameFileDb(efGame)
        .then((r) => {
          if (r.channels) writeLaunchLog('[endfield] 记账补齐完成：' + r.channels + ' 个渠道 / ' + r.files + ' 个文件');
        })
        .catch((error) => {
          writeLaunchLog('[endfield] 记账补齐异常（不影响启动）：' + (error && error.message));
        });
    }, 8000);
  }

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
    killNeteaseService();
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

/*
 * 2026-11-17（bug 3）：把「这个渠道能不能被切过去」的守卫导出。
 * servers-ipc.js 那边的调用由另一个 agent 接（servers:activate 里切之前问一句）。
 * 注意：main.js 是 Electron 主进程入口，直接 require 它会把 App 跑起来 ——
 * 需要这个函数的模块请走 installServersIpc 的 ctx（那边已经拿到 kuroChannelSwitchable），
 * 这里的导出只作契约声明与自检用。
 */
module.exports = {
  kuroChannelSwitchable,
};
