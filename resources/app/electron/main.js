'use strict';

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
  globalShortcut,
  safeStorage,
  session,
  net,
  protocol,
} = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn, execFileSync, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

const { JsonStore } = require('./store');
const { DownloadManager } = require('./downloads');
const { ensureSeedData } = require('./seed');
const { linkTrees } = require('./link');
const { prepareLinkedRuntime } = require('./runtime');
const { hardlinkTree } = require('./runtime');
const { loadGachaHistory } = require('./gacha');
const nteCapture = require('./nte-capture');
const updater = require('./updater');
const { loadGachaMeta } = require('./gacha-meta');
const { ensureErasedBackground } = require('./background-clean');
const { resolveLiveRoom } = require('./live-rooms');
const { musicCharts, chartSongs, mergedCharts, mergedChartSongs, searchSongs } = require('./music-platforms');
const { accountPlaylists, accountPlaylistSongs, webMyPlaylists } = require('./music-playlists');
const gameFeatures = require('./game-features');
const miyoushe = require('./miyoushe-login');
const passport = require('./passport-login');
const screenshotLib = require('./screenshots');
const graphicsConfig = require('./graphics-config');
const graphicsSchema = require('./graphics-schema');
const installManager = require('./install-manager');
const windowMaterial = require('./window-material');
const { resolvePlayableUrl } = require('./music-resolve');
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
const { syncGacha } = require('./gacha-sync');
const { syncEndfieldGacha } = require('./endfield-gacha');
const { getStarRailFps, setStarRailFps } = require('./starrail-fps');
const {
  updateEndfieldPacks,
  updateEndfieldGame,
  checkEndfieldGame,
  fetchLatest,
  profileForChannel,
} = require('./endfield-packs');

/** 按渠道拿官方最新版本信息（安装与更新页用）。 */
async function fetchLatestForChannel(channel) {
  const profile = profileForChannel(channel);
  if (!profile) throw new Error('没有对应的更新渠道');
  return fetchLatest(profile);
}
const { launchEndfield, launchEndfieldElevated } = require('./endfield-launch');
const { prepareSophon, prepareBilibiliRuntime } = require('./sophon');
const { applyHdiffUpdate } = require('./hdiff');

app.setName('花筱灵启动器');
app.setAppUserModelId('com.huaxiaoling.launcher');

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
}

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

const isDev = !app.isPackaged;
const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build', 'icon.png');

let win = null;
let splashWindow = null;
let tray = null;
let store = null;
let downloads = null;
let quitting = false;
let neteaseServiceProcess = null;
let pushTimer = null;

/** @type {Map<string, {pid:number, startedAt:number}>} */

/**
 * 截图缩略图白名单：只有「本次扫描出来的绝对路径」能通过 hxl-shot 协议读取，
 * 防止渲染层用任意路径读本机文件。每次 screenshots:list 时整体重建。
 */
const screenshotAllow = new Set();
const running = new Map();
const launching = new Set();
const processMonitors = new Map();

/** @type {Map<string, {cancelled:boolean}>} */
const linkJobs = new Map();
const sophonJobs = new Map();
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
    sidebarCollapsed: true,
    uiRevision: 2,
    // 界面缩放：100% 为原始大小，范围 80% - 130%
    uiScale: 100,
    quickPanelPinned: false,
    alwaysAdmin: false,
    nevernessUseOfficialLauncher: true,
    closeToTray: true,
    launchAtLogin: false,
    minimizeOnLaunch: true,
    autoSyncOfficial: true,
    autoUpdateEndfieldPacks: true,
    autoGacha: true,
    // 自更新：清单地址留空则不检查；支持 https / 局域网共享 / 本地路径
    updateManifest: '',
    autoCheckUpdate: true,
    // 更新公告弹窗已经弹过的版本号；空串表示这次升级还没看，启动时弹一次
    notesSeenVersion: '',
    endfieldPackRoot: detectEndfieldPackRoot(),
    starwardDbPath: detectStarwardDbPath(),
    runtimeRoot: '',
    downloadDir: portableDownloads
      ? path.join(portableDownloads, '花筱灵下载')
      : path.join(app.getPath('downloads'), '花筱灵下载'),
    lastPage: 'home',
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
  });
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

function targetExists(target) {
  if (!target) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return true;
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
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
};

function expandEnv(value) {
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
}

const OFFICIAL_SITES = {
  genshin: 'https://ys.mihoyo.com/',
  starrail: 'https://sr.mihoyo.com/',
  zzz: 'https://zzz.mihoyo.com/',
  endfield: 'https://endfield.hypergryph.com/',
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
};

const BASIC_GAME_IDS = {
  genshin: '1Z8W5NHUQb',
  starrail: '64kMb5iAWu',
  zzz: 'x6znKlJ0xK',
};

const NOTICE_GAME_KEYS = ['genshin', 'starrail', 'zzz', 'endfield', 'neverness'];
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

async function fetchGameNotices(gameKey, force = false) {
  const cached = noticeCache.get(gameKey);
  if (!force && cached && Date.now() - cached.at < NOTICE_CACHE_TTL) return cached.items;
  let items = [];
  try {
    if (BASIC_GAME_IDS[gameKey]) items = await fetchHoyoNotices(gameKey);
    else if (gameKey === 'endfield') items = await fetchEndfieldNotices();
    else if (gameKey === 'neverness') items = await fetchNevernessNotices();
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
  if (game.cover && /^covers\/official-neverness\.(?:jpg|jpeg|png)$/i.test(game.cover)) {
    if (fs.existsSync(path.join(app.getPath('userData'), game.cover))) return;
  }
  let imageUrl = 'https://nte.perfectworld.com/en/images/cover260930/slide2.jpg';
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
      if (version && !game.version) game.version = version[1];
    }
  } catch {
    /* use fallback hero */
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

async function cacheStartVideo(source, relativePath, local = false) {
  const destination = path.join(app.getPath('userData'), relativePath);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  if (local) {
    await fsp.copyFile(source, temporary);
  } else {
    const response = await fetch(source, {
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'video/mp4,video/webm,video/*;q=0.9,*/*;q=0.5',
        referer: 'https://endfield.hypergryph.com/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(90000),
    });
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
  await fsp.rm(destination, { force: true });
  await fsp.rename(temporary, destination);
  return destination;
}

let startArtworkJob = null;
function ensureAnimatedStartBackgrounds() {
  if (startArtworkJob) return startArtworkJob;
  startArtworkJob = (async () => {
    if (!store) return;
    let changed = false;
    for (const game of store.data.games) {
      if (!game.builtinKey) continue;
      if (game.startCover && !game.startCover.includes('-clean2.')) game.startCover = '';
      const customCover = game.cover && !/^covers\/(builtin|official)-/.test(game.cover);
      if (customCover) continue;

      const key = game.builtinKey;
      const videoRelative = `backgrounds/${key}.mp4`;
      const videoCached = path.join(app.getPath('userData'), videoRelative);

      if (fs.existsSync(videoCached)) {
        try {
          if (fs.statSync(videoCached).size > 4096) {
            if (game.backgroundVideo !== videoRelative || game.startMotion !== 'video') {
              game.backgroundVideo = videoRelative;
              game.startMotion = 'video';
              changed = true;
            }
            continue;
          }
        } catch {
          /* 重新下载 */
        }
      }

      let source = '';
      let local = false;
      if (key === 'neverness') {
        source = findNevernessStartVideo(game);
        local = Boolean(source);
      } else if (key === 'endfield') {
        source = await fetchEndfieldStartVideo();
      } else if (['starrail', 'zzz', 'genshin'].includes(key)) {
        try {
          const art = await officialBackgrounds(key);
          if (art.videos.length) source = art.videos[0].url;
        } catch {
          source = '';
        }
      }

      // 没有官方视频（原神）：静态图 + 前端缓动镜头
      if (!source) {
        if (!game.backgroundVideo && game.startMotion !== 'pan') {
          game.startMotion = 'pan';
          changed = true;
        }
        continue;
      }
      try {
        await cacheStartVideo(source, videoRelative, local);
        game.backgroundVideo = videoRelative;
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
  })()
    .catch((error) => console.warn('启动页动图预取失败：', error.message))
    .finally(() => {
      startArtworkJob = null;
    });
  return startArtworkJob;
}

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
      const versionMatch = `${title} ${description}`.match(/(\d+\.\d+)[^0-9]{0,10}版本/);
      if (versionMatch) version = versionMatch[1];
      const versionNameMatch = html.match(/「([^」]{1,16})」版本(?:更新说明|PV)/);
      if (versionNameMatch) versionName = versionNameMatch[1];
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
    }
  } catch (error) {
    result.error = error.message;
  }

  const background = latestBackground(backgrounds, game.builtinKey);
  // 旧版本的去字缓存换成 -clean2，失效的路径直接清掉
  if (game.startCover && !game.startCover.includes('-clean2.')) game.startCover = '';
  const customCover = game.cover && !/^covers\/(builtin|official)-/.test(game.cover);
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
    if ((!game.startCover || !game.startCover.includes('-clean2.')) && fromVersionArt) {
      const cleanName = `official-${game.builtinKey}-clean2.png`;
      const cleaned = await ensureErasedBackground({
        nativeImage,
        sourcePath: artFile,
        cachePath: path.join(app.getPath('userData'), 'covers', cleanName),
      }).catch(() => null);
      if (cleaned) game.startCover = `covers/${cleanName}`;
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
          await fsp.writeFile(path.join(dir, fileName), buffer);
          game.cover = `covers/${fileName}`;
          game.artUrl = imageUrl;
          game.artVersion = version || game.version || '';
          result.cover = true;
          // 官方图常带烧录标题；生成一张去掉文字的版本给启动页用，
          // 游戏库封面仍用原图，避免影响卡片视觉。
          const cleanName = `official-${game.builtinKey}-clean2.png`;
          // 只有来源是官方版本图时才做去字；分享图/宣传图直接不进启动页
          const cleaned = fromVersionArt ? await ensureErasedBackground({
            nativeImage,
            sourcePath: path.join(dir, fileName),
            cachePath: path.join(dir, cleanName),
          }).catch(() => null) : null;
          if (cleaned) {
            game.startCover = `covers/${cleanName}`;
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
  const baseDrive = path.parse(baseRoot).root;
  const exact = String(overrideRoot || '').trim();
  const configured = String(store.data.settings.runtimeRoot || '').trim();
  const root = configured ? path.resolve(configured) : path.join(baseDrive, 'VelaRuntimes');
  const target = exact
    ? path.resolve(exact)
    : path.join(root, gameKey, channel);
  const sameDrive = path.parse(target).root.toLowerCase() === baseDrive.toLowerCase();
  return {
    root,
    target,
    sameDrive,
    baseDrive,
  };
}

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
    ]) {
      roots.add(path.join(drive, name));
    }
  }
  for (const extra of ['H:\\miHoYo切换器', 'H:\\Starward']) {
    if (fs.existsSync(extra)) roots.add(extra);
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

async function ensureEndfieldOfficialRuntime(game, server) {
  if (game.builtinKey !== 'endfield' || server.channel !== 'official') return false;
  if (!server.root || server.root.includes('VelaRuntimes')) return false;
  const packRoot = store.data.settings.endfieldPackRoot;
  if (!packRoot) return false;
  const packDir = path.join(packRoot, 'EndOfficial');
  if (!fs.existsSync(packDir)) return false;
  const runtime = runtimePaths(server.root, 'endfield', 'official');
  if (!runtime.sameDrive) return false;
  await prepareLinkedRuntime({
    baseRoot: server.root,
    packRoot: packDir,
    targetRoot: runtime.target,
  });
  const globalSdk = path.join(runtime.target, 'sdkdata');
  try {
    for (const entry of await fsp.readdir(globalSdk)) {
      if (entry.startsWith('sdk_glsdk_config')) {
        await fsp.rm(path.join(globalSdk, entry), { force: true });
      }
    }
  } catch {
    /* sdkdata may not exist */
  }
  const executable = path.join(runtime.target, 'Endfield.exe');
  if (!fs.existsSync(executable)) return false;
  server.path = executable;
  server.root = runtime.target;
  server.runtimeLinked = true;
  server.legacyRuntime = false;
  return true;
}

async function prepareGenshinPackRuntime(game, server) {
  const packRoot = server.root;
  const packExe = path.join(packRoot, 'GenshinImpact.exe');
  const packData = path.join(packRoot, 'GenshinImpact_Data');
  if (!fs.existsSync(packExe) || !fs.existsSync(packData)) return null;
  if (fs.existsSync(path.join(packRoot, 'config.ini'))) return null;

  const base =
    game.servers.find((item) => item.channel === 'official' && item.root && fs.existsSync(item.root)) ||
    null;
  if (!base) throw new Error('原神国际服资源包需要官服客户端作为基础，请先配置官服目录');

  const runtimeRoot = path.join(path.dirname(packRoot), '.vela-runtime', 'genshin-global');
  const runtimeExe = path.join(runtimeRoot, 'GenshinImpact.exe');
  if (!fs.existsSync(runtimeExe)) {
    await fsp.mkdir(runtimeRoot, { recursive: true });
    await hardlinkTree({ sourceRoot: packRoot, targetRoot: runtimeRoot });
    for (const entry of await fsp.readdir(base.root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (/^(config\.ini|YuanShen\.exe|GenshinImpact\.exe)$/i.test(entry.name)) continue;
      const target = path.join(runtimeRoot, entry.name);
      if (!fs.existsSync(target)) {
        await fsp.copyFile(path.join(base.root, entry.name), target).catch(() => {});
      }
    }
  }
  const version = String(game.version || '').replace(/^v/i, '') || '7.1.0';
  const config = `[General]\nsub_channel=0\nsdk_version=\npredownload=\ngame_version=${version}\ngame_biz=hk4e_global\ncps=hyp_hoyoverse\nchannel=1\n`;
  await fsp.writeFile(path.join(runtimeRoot, 'config.ini'), config, 'utf8');
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
  return '';
}

function channelFromInstallPath(exePath) {
  let folder = exePath;
  try {
    const configPath = path.join(path.dirname(exePath), 'config.ini');
    if (fs.existsSync(configPath)) {
      const text = fs.readFileSync(configPath, 'utf8');
      const biz = (text.match(/game_biz\s*=\s*([^\r\n]+)/i) || [])[1] || '';
      const cps = (text.match(/cps\s*=\s*([^\r\n]+)/i) || [])[1] || '';
      const channelLine = (text.match(/^channel\s*=\s*(\d+)/im) || [])[1] || '';
      // 国际服优先
      if (/global/i.test(biz) || /hoyoverse/i.test(cps)) return 'global';
      // B服：cps 带 bilibili，或 channel=14（B服客户端常见只有 channel 标记）
      if (/bilibili/i.test(cps) || /bilibili/i.test(biz) || channelLine === '14') return 'bilibili';
      if (/_cn/i.test(biz)) return 'official';
    }
  } catch {
    /* fall through to path hints */
  }
  if (/global|国际服/i.test(folder)) return 'global';
  if (/bilibili|b服/i.test(folder)) return 'bilibili';
  if (/GenshinImpact\.exe$/i.test(exePath)) return 'global';
  if (/YuanShen\.exe$/i.test(exePath)) return 'official';
  return 'official';
}

async function discoverBuiltinServers() {
  if (!store) return 0;
  const execNames = {
    genshin: ['YuanShen.exe', 'GenshinImpact.exe'],
    starrail: ['StarRail.exe'],
    zzz: ['ZenlessZoneZero.exe'],
  };
  const roots = discoverServerRoots();
  let changed = 0;
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
      const hasConfig = fs.existsSync(path.join(dir, 'config.ini'));
      if (!hasConfig) {
        // 没有 config.ini：通常是资源替换包（B服 / 国际服增量包），标记为需要重建。
        // 但不要清空 path / root，否则用户手动配好的客户端会直接消失。
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
      const channel = channelFromInstallPath(exePath);
      const server = (game.servers || []).find((item) => item.channel === channel);
      if (!server) continue;
      if (!fs.existsSync(path.join(path.dirname(exePath), 'config.ini'))) {
        if (!server.path || !targetExists(server.path)) {
          server.incomplete = true;
          server.packPath = exePath;
        }
        continue;
      }
      if (server.path && targetExists(server.path)) continue;
      server.path = exePath;
      server.root = path.dirname(exePath);
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
  const def = GAME_DETECTION[key];
  if (!def) return null;

  const registryLists = await Promise.all(def.registry.map((registryKey) => registryValues(registryKey)));
  for (const values of registryLists) {
    for (const value of values) {
      const found = checkPath(value, def);
      if (found) return found;
    }
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
      const found = checkPath(path.join(root, rel), def);
      if (found) return found;
    }
  }
  return null;
}

async function detectBuiltins(onlyMissing = true) {
  if (!store) return 0;
  let updated = 0;
  for (const game of store.data.games) {
    if (!game.builtin || !game.builtinKey) continue;
    if (onlyMissing && game.target && targetExists(game.target)) continue;
    const found = await detectGame(game.builtinKey);
    if (found) {
      const active = (game.servers || []).find((server) => server.id === game.activeServerId);
      const activeHadPath = Boolean(active && active.path);
      const official =
        (game.servers || []).find((server) => server.channel === 'official') || (game.servers || [])[0];
      if (official && (!official.path || !targetExists(official.path))) {
        official.path = found;
        official.root = path.dirname(found);
        official.incomplete = false;
      }
      // 已经有一个能用的服务器在用时，别把当前选择抢回官服
      const activeUsable = Boolean(active && active.path && targetExists(active.path));
      if (official && (!active || !activeUsable)) {
        game.activeServerId = official.id;
        game.target = official.path || found;
        game.workDir = path.dirname(game.target);
      }
      updated += 1;
    }
  }
  updated += await discoverBuiltinServers();
  if (updated) await store.saveNow();
  return updated;
}

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
  }[game.builtinKey];
  if (game.builtin && builtinChannels) {
    for (const [channel, name] of builtinChannels) {
      let server = game.servers.find((item) => item.channel === channel);
      if (!server) {
        server = {
          id: `${game.id}-${channel}`,
          name,
          channel,
          path: '',
          root: '',
          addedAt: new Date().toISOString(),
        };
        game.servers.push(server);
        changed = true;
      }
      if (server.builtinServer !== true) {
        server.builtinServer = true;
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
      ? coverUrl(game.startCover)
      : hasOfficialCover
        ? coverUrl(game.cover)
        : hasCustomCover
          ? coverUrl(game.cover)
          : game.coverUrl || coverUrl(game.cover),
    installed: targetExists(game.target),
    running: running.has(game.id),
    activeServerId: game.activeServerId || null,
    servers: (game.servers || []).map((server) => ({
      ...server,
      exists: targetExists(server.path),
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

/** 更新源：设置里填的优先，否则用启动器目录里那份。 */
function resolveUpdateSource() {
  const configured = String(store.data.settings?.updateManifest || '').trim();
  return configured || localUpdateManifest();
}

async function performUpdateCheck(options = {}) {
  const location = resolveUpdateSource();
  if (!location) {
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
    location,
    currentVersion: APP_VERSION,
  });
  updateStatus = { ...updateStatus, ...result, checkedAt: Date.now(), percent: 0, downloading: false };
  updateStatus.backup = updateBackupInfo();
  if (options.push !== false) pushState(true);
  if (result.hasUpdate) {
    send('update:available', updateStatus);
  }
  return updateStatus;
}

/** 这批文件正被启动器自己或者正在跑的游戏占用？ */
function describeRunningProcesses(paths) {
  const names = new Set();
  for (const item of paths || []) {
    const base = path.basename(String(item || ''));
    if (base) names.add(base);
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

async function startUpdate(options = {}) {
  if (updateStatus.downloading) throw new Error('已经在下载更新了');
  const location = resolveUpdateSource();
  if (!location) throw new Error('还没有设置更新源');
  updateStatus = { ...updateStatus, downloading: true, percent: 0, error: '' };
  pushState(true);
  try {
    const manifest = await updater.readManifest(location);
    if (updater.compareVersions(manifest.version, APP_VERSION) <= 0) {
      const info = await performUpdateCheck({ push: false });
      updateStatus = { ...info, downloading: false, percent: 0, error: '' };
      pushState(true);
      return { ok: false, message: `已经是最新版本（v${APP_VERSION}）` };
    }
    if (!manifest.url) throw new Error('更新源没有给出下载地址');
    if (!manifest.sha256) throw new Error('更新源里没有写 update 包的 sha256，为安全起见不自动安装');

    const tempBase = updateTempBase();
    await fsp.mkdir(tempBase, { recursive: true }).catch(() => {});
    // 包名带上版本号，换版本时不会认错上一个版本的残留文件
    const zipPath = path.join(tempBase, 'download', `HuaXiaoLing-${manifest.version}-Portable.zip`);
    let percent = 0;
    try {
      await updater.downloadToFile({
        url: manifest.url,
        dest: zipPath,
        expectedSize: manifest.size,
        onProgress: (progress) => {
          const next = Math.round(progress.percent);
          // 每 1% 推一次就够了，避免 IPC 刷屏把渲染层卡住
          if (next === percent && next !== 100) return;
          percent = next;
          updateStatus = { ...updateStatus, percent: next };
          send('update:progress', { percent: next, received: progress.received, total: progress.total });
          if (progress.total && options.onTotal) options.onTotal(progress.total);
        },
      });
    } catch (error) {
      // 退回直连再试一次：局域网共享和本地文件走不到这里，HTTP 才需要
      if (options.retried || (error.retryable === false)) throw error;
      send('toast', { message: '直连下载失败，正在重试…', type: 'info' });
      percent = 0;
      return await startUpdate({ ...options, retried: true });
    }

    const actual = await updater.sha256File(zipPath);
    if (actual !== manifest.sha256) {
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      throw new Error('更新包校验没通过（sha256 对不上），可能没下载完整，请重试');
    }

    // 解压、检查包结构，同时算出被占用的程序文件。
    // 版本号以清单为准：package.json 只在发版时才改，清单是随时能改的。
    const staged = await updater.stage({ zipPath, tempBase, version: manifest.version });
    const conflict = updater.describeApplyProblem({ staged, currentVersion: APP_VERSION });
    if (conflict) throw new Error(conflict);
    const busy = describeRunningProcesses(staged.locks);
    if (busy.length) {
      updateStatus = { ...updateStatus, downloading: false, percent: 0, prepared: staged };
      pushState(true);
      return {
        ok: false,
        message: `升级包已就绪，但这些程序还开着，关掉之后再点一次更新：\n${busy.join('、')}`,
        busy,
      };
    }

    updateStatus = { ...updateStatus, percent: 100 };
    send('update:progress', { percent: 100, phase: 'apply' });
    await updater.apply({
      staged,
      onReadyToQuit: () => {
        setTimeout(() => {
          quitting = true;
          app.quit();
        }, 250);
      },
    });
    return { ok: true, restarting: true, version: manifest.version };
  } catch (error) {
    updateStatus = {
      ...updateStatus,
      downloading: false,
      percent: 0,
      error: error?.message ? error.message : String(error),
    };
    pushState(true);
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
  electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    update: updateStatus,
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

/**
 * 按缩放比例放大/缩小整个窗口内容。
 * 用 setZoomFactor 而不是 CSS 变量：字号、间距、图标一起等比变化，
 * 不用逐条改 479 处 px 字号。
 * 同时把窗口尺寸按比例放大/缩小，让可见内容保持和 100% 一样多，
 * 不会因为放大把右边或下面挤掉；启动页是固定尺寸的独立窗口，不跟着缩放。
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
}

/** 主窗口的基准尺寸，缩放时按它来算，避免一直累计放大。 */
function defaultWindowSize() {
  return { width: 1400, height: 880 };
}

/**
 * 缩放时同步调整窗口尺寸：factor * 基准尺寸，夹在屏幕可用区域内。
 * 窗口最大化 / 全屏时不动，退出后下次缩放再调整。
 */
function resizeWindowForScale(factor) {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
  if (Math.abs(factor - 1) < 0.001) return;
  const base = defaultWindowSize();
  const wanted = {
    width: Math.round(base.width * factor),
    height: Math.round(base.height * factor),
  };
  try {
    const screen = require('electron').screen;
    const display = screen.getDisplayMatching(win.getBounds());
    const area = display.workArea;
    wanted.width = Math.min(wanted.width, area.width - 24);
    wanted.height = Math.min(wanted.height, area.height - 24);
  } catch {
    /* 拿不到屏幕信息就按原尺寸来 */
  }
  const current = win.getBounds();
  if (Math.abs(current.width - wanted.width) < 8 && Math.abs(current.height - wanted.height) < 8) return;
  try {
    win.setBounds({ x: current.x, y: current.y, width: wanted.width, height: wanted.height });
  } catch (error) {
    console.warn('setBounds failed:', error.message);
  }
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
    icon: ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow.loadFile(path.join(ROOT, 'src', 'splash.html'));
  splashWindow.once('ready-to-show', () => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    splashWindow.center();
    splashWindow.show();
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
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b060b',
    title: '花筱灵启动器',
    icon: ICON,
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

  win.loadFile(path.join(ROOT, 'src', 'index.html'));
  // 页面加载完再套缩放：loadFile 触发的导航会把提前设好的 zoomFactor 重置回 1
  win.webContents.on('did-finish-load', () => {
    applyUiScale(store?.data?.settings?.uiScale ?? 100);
  });

  win.once('ready-to-show', () => {
    const delay = splashWindow ? 1050 : 0;
    // 启动时恢复上次选的窗口材质（必须在窗口可见前设好，否则会闪一下不透明底）
    try {
      const savedMaterial = store?.data?.settings?.material || 'none';
      if (savedMaterial && savedMaterial !== 'none') {
        windowMaterial.applyMaterial(win, savedMaterial);
      }
    } catch (error) {
      console.warn('[material] 恢复失败:', error.message);
    }
    setTimeout(() => {
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
      } else if (process.env.HX_SMOKE === '1') {
        setTimeout(() => {
          console.log('SMOKE_OK');
          quitting = true;
          app.quit();
        }, 2200);
      }
    }, delay);
  });

  win.on('close', (event) => {
    if (!quitting && store && store.data.settings.closeToTray) {
      event.preventDefault();
      win.hide();
    }
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
    const image = nativeImage.createFromPath(ICON);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 20, height: 20 }));
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
  const timer = setInterval(async () => {
    if (!running.has(id)) {
      clearProcessMonitor(id);
      return;
    }
    const current = await findProcessPid(exeName);
    if (!current) {
      clearProcessMonitor(id);
      await finishGame(id);
    }
  }, 3000);
  processMonitors.set(id, timer);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function isElevated() {
  try {
    const output = execFileSync(
      'powershell.exe',
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

function relaunchElevated() {
  if (!app.isPackaged) return false;
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process -FilePath ${psQuote(process.execPath)} -Verb RunAs`],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.unref();
    setTimeout(() => {
      quitting = true;
      app.quit();
    }, 600);
    return true;
  } catch {
    return false;
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
  const dir = store.data.settings.downloadDir;
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
          await saveSecret(`hoyolab-${providerId}`, JSON.stringify({ cookie: cookieStr, savedAt: Date.now() }));
          finish({ ok: true, provider: providerId, roles: result.roles });
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

  ipcMain.handle('hoyolab:status', async (_event, input = {}) => {
    const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
    const raw = await loadSecret(`hoyolab-${providerId}`);
    if (!raw) return { ok: true, loggedIn: false, roles: [] };
    let saved;
    try {
      saved = JSON.parse(raw);
    } catch (error) {
      return { ok: true, loggedIn: false, roles: [], reason: '登录状态损坏，请重新登录' };
    }
    try {
      const result = await miyoushe.verifyCookie(saved.cookie, providerId);
      return {
        ok: true,
        loggedIn: result.ok,
        roles: result.roles,
        savedAt: saved.savedAt || 0,
        reason: result.ok ? '' : result.reason || '',
      };
    } catch (error) {
      return { ok: true, loggedIn: false, roles: [], reason: String(error.message || error) };
    }
  });

  ipcMain.handle('hoyolab:logout', async (_event, input = {}) => {
    const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
    await saveSecret(`hoyolab-${providerId}`, '');
    try {
      const ses = session.fromPartition(`persist:hoyolab-${providerId}`);
      await ses.clearStorageData({ storages: ['cookies'] });
    } catch {}
    return { ok: true };
  });

  /*
   * 战绩数据（每日便笺 / 深渊 / 剧场…）。
   * api 由能力注册表给出，这里只负责补 cookie 和 DS2。
   */
  ipcMain.handle('hoyolab:record', async (_event, input = {}) => {
    const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
    const raw = await loadSecret(`hoyolab-${providerId}`);
    if (!raw) throw new Error('还没有登录米游社，请先在工具页点「登录」');
    let saved;
    try {
      saved = JSON.parse(raw);
    } catch {
      throw new Error('登录状态损坏，请重新登录');
    }
    const api = String(input.api || '');
    if (!api.startsWith('/')) throw new Error('接口路径不合法');
    try {
      return { ok: true, data: await miyoushe.fetchRecord(api, saved.cookie, providerId) };
    } catch (error) {
      if (error.retcode === 10001 || error.retcode === 10001) {
        await saveSecret(`hoyolab-${providerId}`, '');
      }
      throw error;
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

  ipcMain.handle('update:check', async () => performUpdateCheck({ push: true }));

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
      'nevernessUseOfficialLauncher',
      'closeToTray',
      'launchAtLogin',
      'minimizeOnLaunch',
      'autoSyncOfficial',
      'autoUpdateEndfieldPacks',
      'autoGacha',
      'updateManifest',
      'autoCheckUpdate',
      'notesSeenVersion',
      'endfieldPackRoot',
      'starwardDbPath',
      'runtimeRoot',
      'downloadDir',
      'lastPage',
      'material',
      'customBackground',
      'backgroundOpacity',
      'backgroundBlur',
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
      } else if (key === 'nevernessUseOfficialLauncher') {
        settings.nevernessUseOfficialLauncher = patch.nevernessUseOfficialLauncher !== false;
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
          if (/^custom-[0-9a-f-]{36}\.(png|jpe?g|webp|gif)$/i.test(base)) {
            settings.customBackground = `backgrounds/${base}`;
          }
        }
      } else if (key === 'backgroundOpacity') {
        const value = Number(patch.backgroundOpacity);
        if (Number.isFinite(value)) settings.backgroundOpacity = Math.max(0, Math.min(100, Math.round(value)));
      } else if (key === 'backgroundBlur') {
        const value = Number(patch.backgroundBlur);
        if (Number.isFinite(value)) settings.backgroundBlur = Math.max(0, Math.min(60, Math.round(value)));
      } else if (key === 'updateManifest') {
        settings.updateManifest = String(patch.updateManifest || '').trim().slice(0, 500);
      } else if (key === 'autoCheckUpdate') {
        settings.autoCheckUpdate = patch.autoCheckUpdate !== false;
      } else if (key === 'notesSeenVersion') {
        // 更新公告弹窗「看过了」的版本号：存到 settings 里，跟着 launcher-data.json 走，
        // 所以升级覆盖 resources/app 之后这个标记不会丢，同一个版本只弹一次。
        settings.notesSeenVersion = String(patch.notesSeenVersion || '').trim().replace(/^v/i, '').slice(0, 32);
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
    if (!server?.root || !targetExists(server.path)) {
      throw new Error('先配置这个游戏的客户端路径');
    }
    return syncGacha({
      game: game.builtinKey,
      installRoot: server.root,
      userData: app.getPath('userData'),
    });
  });

  ipcMain.handle('endfield:update-game', async () => {
    const game = store.data.games.find((item) => item.builtinKey === 'endfield');
    const server = game?.servers.find((item) => item.id === game.activeServerId);
    if (!game || !server?.root || !targetExists(server.path)) {
      throw new Error('先配置终末地客户端路径');
    }
    if (running.has(game.id)) throw new Error('请先退出终末地再更新');
    return updateEndfieldGame({
      root: server.root,
      channel: server.channel,
      onProgress: (progress) => send('endfield:game-progress', progress),
    });
  });

  ipcMain.handle('endfield:update-official-packs', async () => {
    const root = path.join(app.getPath('userData'), 'endfield-packs');
    const result = await updateEndfieldPacks({
      root,
      onProgress: (progress) => send('endfield:pack-progress', progress),
    });
    store.data.settings.endfieldPackRoot = root;
    await store.saveNow();
    pushState(true);
    return result;
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
    }
    store.data.settings.endfieldPackRoot = target;
    await store.saveNow();
    pushState(true);
    return { ok: true, imported: found, path: target };
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
  if (neteaseSession.cookie && neteaseSession.apiBase === base) {
    query.set('cookie', neteaseSession.cookie);
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
    const ids = tracks.slice(0, 100).map((track) => track.id);
    const level = input?.level || 'exhigh';
    let urlJson = null;
    try {
      urlJson = await neteaseGet(apiBase, '/song/url/v1', { id: ids.join(','), level });
    } catch {
      urlJson = await neteaseGet(apiBase, '/song/url', { id: ids.join(',') });
    }
    const urlMap = new Map(
      (urlJson.data || []).map((item) => [
        String(item.id),
        { url: item.url, quality: item.level || level },
      ])
    );
    const songs = [];
    for (const track of tracks.slice(0, 100)) {
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

async function fetchNeteaseSongUrl(apiBase, id, level = 'exhigh') {
  const allowed = new Set(['standard', 'higher', 'exhigh', 'lossless', 'hires']);
  const quality = allowed.has(String(level)) ? String(level) : 'exhigh';
  let json = null;
  try {
    json = await neteaseGet(apiBase, '/song/url/v1', { id, level: quality });
  } catch {
    json = await neteaseGet(apiBase, '/song/url', { id });
  }
  const item = json?.data?.[0];
  if (!item?.url) {
    throw new Error(`${quality === 'lossless' ? '无损' : quality === 'hires' ? 'Hi-Res' : '当前'}音质不可用，可能需要网易云会员`);
  }
  return {
    url: String(item.url),
    level: String(item.level || quality),
    br: Number(item.br) || 0,
    size: Number(item.size) || 0,
    type: String(item.type || ''),
  };
}

  ipcMain.handle('netease:search-song', async (_event, input) => {
    const apiBase = normalizeNeteaseBase(input?.apiBase);
    const keyword = String(input?.keyword || '').trim();
    if (!keyword) throw new Error('没有识别到歌名');
    const search = await neteaseGet(apiBase, '/search', { keywords: keyword, limit: 8, type: 1 });
    const list = search?.result?.songs || [];
    if (!list.length) throw new Error(`没有搜到「${keyword}」`);
    for (const song of list) {
      try {
        const urlInfo = await fetchNeteaseSongUrl(apiBase, song.id, input?.level || 'exhigh');
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
    return fetchNeteaseSongUrl(apiBase, String(input?.id || ''), input?.level || 'exhigh');
  });

  ipcMain.handle('live:bili-room', async (_event, input) => {
    const raw = String(input?.url || input || '');
    return resolveLiveRoom(raw);
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
          if (checked.ok) await finish(bag);
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
            await finish(bag);
            return { ok: true, platform: key, cookies: bag };
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
  /** 收集一个 QQ 音乐 / 酷狗账号的歌单：先走网页，失败回退 OpenAPI。 */
  async function collectPlatformPlaylists(key) {
    const session = await loadMusicSession(key, loadSecret);
    if (!session) throw new Error('还没有登录');
    const webErrors = [];
    try {
      const list = await webMyPlaylists(key, session, {
        getWindow: async (target) => {
          const win = new BrowserWindow({
            width: 1100,
            height: 780,
            show: false,
            webPreferences: {
              session: session.fromPartition(`persist:music-${target}-login`),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          });
          return { win, ownWindow: true };
        },
      });
      if (Array.isArray(list) && list.length) return { list, source: 'web' };
      webErrors.push('网页返回空列表');
    } catch (error) {
      webErrors.push(String(error.message || error));
    }
    try {
      const list = await accountPlaylists(key, session);
      if (Array.isArray(list) && list.length) return { list, source: 'api' };
      throw new Error(webErrors[0] || '账号里没有可读的歌单');
    } catch (error) {
      throw new Error(String(error.message || webErrors[0] || '读取歌单失败'));
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
  ipcMain.handle('music:resolve', async (_event, input) => {
    const song = input?.song || {};
    const level = String(input?.level || 'exhigh');
    const apiBase = normalizeNeteaseBase(input?.apiBase || '');
    try {
      const resolved = await resolvePlayableUrl(apiBase, song, level);
      if (!resolved) return { ok: false, reason: '没有找到可播放的版本' };
      return { ok: true, ...resolved };
    } catch (error) {
      return { ok: false, reason: String(error.message || '解析失败') };
    }
  });

  ipcMain.handle('music:my-playlists', async (_event, platform) => {
    const key = String(platform || '');
    musicPlatformConfig(key);
    try {
      /*
       * 网易云单独处理：它的凭证是本地 API 的 cookie，不走 persist 分区。
       * 之前这里只处理 QQ 音乐 / 酷狗，导致网易云登录后「我的歌单」是空的。
       */
      if (key === 'netease') {
        const list = await neteaseMyPlaylists(neteaseSession.apiBase || 'http://127.0.0.1:3100');
        return { ok: true, list, source: 'api' };
      }
      /*
       * QQ 音乐 / 酷狗：先走网页（在 persist 分区里让页面自己请求，
       * 用的是浏览器真实的 cookie / Referer / 签名上下文），
       * 失败再退回 OpenAPI 直连，保证不会比之前更差。
       */
      const result = await collectPlatformPlaylists(key);
      return { ok: true, list: result.list, source: result.source };
    } catch (error) {
      return { ok: false, reason: String(error.message || '读取歌单失败') };
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
  ipcMain.handle('music:all-playlists', async () => {
    const status = await musicStatus();
    const groups = [];

    if (status?.netease?.loggedIn) {
      try {
        const list = await neteaseMyPlaylists(neteaseSession.apiBase || 'http://127.0.0.1:3100');
        groups.push({ platform: 'netease', label: '网易云', ok: true, list, error: '' });
      } catch (error) {
        groups.push({ platform: 'netease', label: '网易云', ok: false, list: [], error: String(error.message || '读取失败') });
      }
    }

    for (const key of ['qq', 'kugou']) {
      if (!status?.[key]?.loggedIn) continue;
      const label = key === 'qq' ? 'QQ 音乐' : '酷狗';
      try {
        const result = await collectPlatformPlaylists(key);
        groups.push({ platform: key, label, ok: true, list: result.list, error: '' });
      } catch (error) {
        groups.push({ platform: key, label, ok: false, list: [], error: String(error.message || '读取失败') });
      }
    }

    return { ok: true, groups };
  });

  ipcMain.handle('music:playlist-songs', async (_event, input) => {
    const key = String(input?.platform || '');
    const playlistId = String(input?.playlistId || '');
    musicPlatformConfig(key);
    if (!playlistId) return { ok: false, reason: '缺少歌单 ID' };
    try {
      const session = await loadMusicSession(key, loadSecret);
      if (!session) return { ok: false, reason: '还没有登录' };
      const detail = await accountPlaylistSongs(key, session, playlistId);
      return { ok: true, detail };
    } catch (error) {
      return { ok: false, reason: String(error.message || '读取歌单失败') };
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
    return { charts: await musicCharts(platform), counts: { [platform]: 0, merged: 0 } };
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
    return chartSongs(platform, chartId, limit);
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
    return searchSongs(platform, keyword, apiBase, limit);
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
    const updated = [];
    for (const game of targets) {
      if (!game.builtinKey) continue;
      const found = await detectGame(game.builtinKey);
      if (found) {
        const active = (game.servers || []).find((server) => server.id === game.activeServerId);
        const activeHadPath = Boolean(active && active.path);
        const official =
          (game.servers || []).find((server) => server.channel === 'official') || (game.servers || [])[0];
        if (official) {
          official.path = found;
          official.root = path.dirname(found);
        }
        if (!active || !activeHadPath) {
          game.activeServerId = official.id;
          game.target = found;
          game.workDir = path.dirname(found);
        }
        updated.push(game.name);
      }
    }
    if (updated.length) {
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
    server.name = String(input?.name || '').trim().slice(0, 40) || server.name;
    const serverPath = String(input?.path || '').trim();
    if (serverPath) {
      if (!targetExists(serverPath)) throw new Error('这个启动程序不存在');
      server.path = serverPath;
      server.confirmed = true;
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
    ensureServers(game);
    await store.saveNow();
    pushState(true);
    return publicGame(game);
  });

  ipcMain.handle('servers:clear-path', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再修改服务器');
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    server.path = '';
    server.root = '';
    server.incomplete = false;
    server.packPath = '';
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
      target.path = '';
      target.root = '';
      target.incomplete = false;
      target.packPath = '';
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
    if (server.incomplete) {
      throw new Error('这个目录是资源替换包，不是完整客户端；请点这一行的下载按钮生成国际服客户端');
    }
    if (!server.path || !targetExists(server.path)) {
      throw new Error('这个服务器还没有配置启动程序，先点“编辑”选择客户端');
    }
    if (game.builtinKey === 'genshin' && server.channel === 'global') {
      const prepared = await prepareGenshinPackRuntime(game, server);
      if (prepared) {
        server.path = prepared.executable;
        server.root = prepared.runtimeRoot;
        server.runtimeLinked = true;
      }
    }
    if (game.builtinKey === 'endfield' && server.channel === 'official') {
      await ensureEndfieldOfficialRuntime(game, server);
    }
    game.activeServerId = server.id;
    game.target = server.path;
    game.workDir = server.root || path.dirname(server.path);
    await store.saveNow();
    pushState(true);
    return publicGame(game);
  });

  ipcMain.handle('servers:link', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再建立硬链接');
    const source = game.servers.find((item) => item.id === input?.sourceId);
    const target = game.servers.find((item) => item.id === input?.targetId);

    // 自定义文件夹模式：允许直接指定两个目录，不绑定到已配置的服务器。
    // 这在“没有对应渠道的 .exe 客户端，但本机有完整游戏目录”时尤其有用。
    const customSource = String(input?.sourceRoot || '').trim();
    const customTarget = String(input?.targetRoot || '').trim();
    if ((customSource || customTarget) && (!customSource || !customTarget)) {
      throw new Error('自定义文件夹需要同时指定源目录和目标目录');
    }
    if (customSource && customTarget) {
      // 自定义模式下不校验已配置服务器的启动程序，只要求两个目录存在且同盘。
      let stat;
      try { stat = fs.statSync(customSource); } catch {}
      if (!stat || !stat.isDirectory()) throw new Error('源目录不存在，请重新选择');
      try { stat = fs.statSync(customTarget); } catch {}
      if (!stat || !stat.isDirectory()) throw new Error('目标目录不存在，请重新选择');
      const sourceDrive = path.parse(customSource).root.toLowerCase();
      const targetDrive = path.parse(customTarget).root.toLowerCase();
      if (sourceDrive !== targetDrive) {
        throw new Error('两个目录不在同一个磁盘分区，Windows 无法创建硬链接');
      }
    } else {
      if (!source || !target) throw new Error('请选择源服务器和目标服务器');
      if (source.id === target.id) throw new Error('源服务器和目标服务器不能相同');
      if (!source.path || !target.path) throw new Error('两个服务器都需要先配置启动程序');
      if (!source.root || !target.root) throw new Error('无法确定安装目录');
      if (!targetExists(source.path) || !targetExists(target.path)) throw new Error('启动程序不存在，请重新配置');
      const sourceDrive = path.parse(source.root).root.toLowerCase();
      const targetDrive = path.parse(target.root).root.toLowerCase();
      if (sourceDrive !== targetDrive) {
        throw new Error('两个目录不在同一个磁盘分区，Windows 无法创建硬链接');
      }
    }
    let sourceRoot = customSource || (source && source.root);
    let targetRoot = customTarget || (target && target.root);

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
            sourceName: customSource ? path.basename(customSource) : source.name,
            targetName: customTarget ? path.basename(customTarget) : target.name,
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

  ipcMain.handle('servers:prepare-endfield', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game || game.builtinKey !== 'endfield') throw new Error('这个功能只用于明日方舟：终末地');
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再切换服务器');
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    if (server.channel === 'official') throw new Error('官服请直接指定官服客户端');

    const packRoot = store.data.settings.endfieldPackRoot;
    if (!packRoot || !fs.existsSync(packRoot)) {
      throw new Error('还没有设置终末地渠道包目录，请先在设置里指向 XelLauncher 的 load 文件夹');
    }
    const packName = {
      bilibili: 'EndBilibili',
      global: 'EndGlobal',
      play: 'EndPlay',
      steam: 'EndSteam',
    }[server.channel];
    if (!packName) throw new Error('这个服务器没有对应的渠道差异包');
    const packDir = path.join(packRoot, packName);
    if (!fs.existsSync(packDir)) throw new Error(`渠道差异包不存在：${packDir}`);

    const base =
      game.servers.find(
        (item) => item.channel === 'official' && item.path && targetExists(item.path)
      ) ||
      game.servers.find(
        (item) => item.id !== server.id && item.path && item.root && targetExists(item.path)
      );
    if (!base || !base.root) throw new Error('请先配置官服客户端作为基础安装');

    const runtime = runtimePaths(base.root, 'endfield', server.channel, input?.runtimeRoot);
    if (!runtime.sameDrive) {
      throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
    }
    const runtimeRoot = runtime.target;
    send('endfield:progress', {
      phase: 'link',
      processed: 0,
      total: 0,
      current: '正在创建链接运行时…',
    });
    try {
      const result = await prepareLinkedRuntime({
        baseRoot: base.root,
        packRoot: packDir,
        targetRoot: runtimeRoot,
        onProgress: (progress) =>
          send('endfield:progress', {
            ...progress,
            serverName: server.name,
          }),
      });
      if (result.cancelled) throw new Error('已取消');

      const candidates = ['Endfield.exe', 'PlatformProcess.exe'];
      let launchPath = null;
      for (const name of candidates) {
        const candidate = path.join(runtimeRoot, name);
        if (fs.existsSync(candidate)) {
          launchPath = candidate;
          break;
        }
      }
      if (!launchPath) throw new Error('运行时中没有找到启动程序');

      server.path = launchPath;
      server.root = runtimeRoot;
      server.runtimeLinked = true;
      server.legacyRuntime = false;
      game.activeServerId = server.id;
      game.target = launchPath;
      game.workDir = runtimeRoot;
      ensureServers(game);
      await store.saveNow();
      pushState(true);
      return {
        ok: true,
        runtimeRoot,
        path: launchPath,
        linked: result.linked,
        overlay: result.overlay?.processed || 0,
      };
    } catch (error) {
      pushState(true);
      throw error;
    }
  });

  ipcMain.handle('servers:prepare-sophon', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game || !['genshin', 'starrail', 'zzz'].includes(game.builtinKey)) {
      throw new Error('这个游戏没有接入 Sophon 清单');
    }
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再准备服务器');
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server) throw new Error('没有找到这个服务器');
    if (!['bilibili', 'global'].includes(server.channel)) {
      throw new Error('只有 B服 / 国际服需要生成差异客户端');
    }
    const base =
      game.servers.find((item) => item.channel === 'official' && item.path && targetExists(item.path)) ||
      game.servers.find((item) => item.path && item.root && targetExists(item.path));
    if (!base || !base.root) {
      throw new Error(
        '这台电脑没有找到官服客户端。国际服 / B服需要官服客户端作为基础；请先在官服那一行点“编辑”选择客户端，或手动选择已经安装的国际服客户端。'
      );
    }

    const runtime = runtimePaths(base.root, game.builtinKey, server.channel, input?.runtimeRoot);
    if (!runtime.sameDrive) {
      throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
    }
    const targetRoot = runtime.target;
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
              onProgress: (progress) => send('sophon:progress', { jobId, ...progress }),
            })
          : await prepareSophon({
              gameKey: game.builtinKey,
              channel: server.channel,
              baseRoot: base.root,
              targetRoot,
              cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
              signal,
              onProgress: (progress) => send('sophon:progress', { jobId, ...progress }),
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
    if (!game || !['genshin', 'starrail', 'zzz'].includes(game.builtinKey)) {
      throw new Error('这个游戏没有接入 Sophon 更新');
    }
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再更新');
    const server = game.servers.find((item) => item.id === input?.serverId);
    if (!server || !server.root || !server.path || !targetExists(server.path)) {
      throw new Error('这个服务器还没有可更新的客户端');
    }
    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = { cancelled: false };
    sophonJobs.set(jobId, signal);
    beginBackgroundTask();
    try {
      let patchResult = null;
      try {
        patchResult = await applyHdiffUpdate({
          gameKey: game.builtinKey,
          channel: server.channel,
          installRoot: server.root,
          cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
          signal,
          onProgress: (progress) => send('sophon:progress', { jobId, ...progress }),
        });
      } catch (error) {
        writeLaunchLog(`update ${game.id}: hdiff fallback: ${error.message}`);
      }
      if (signal.cancelled) return { ok: false, cancelled: true };
      if (patchResult && (patchResult.applied > 0 || patchResult.skipped > 0)) {
        game.version = patchResult.tag;
        game.versionName = patchResult.tag;
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
          processed: patchResult.applied + patchResult.skipped,
          total: patchResult.applied + patchResult.skipped,
          current: '补丁更新完成',
        });
        return {
          ok: true,
          tag: patchResult.tag,
          targetRoot: server.root,
          linked: 0,
          downloaded: patchResult.applied,
          files: patchResult.applied + patchResult.skipped,
          patched: true,
        };
      }
      const result = await prepareSophon({
        gameKey: game.builtinKey,
        channel: server.channel,
        baseRoot: server.root,
        targetRoot: server.root,
        cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
        signal,
        onProgress: (progress) => send('sophon:progress', { jobId, ...progress }),
      });
      if (signal.cancelled) return { ok: false, cancelled: true };
      if (game.activeServerId === server.id) {
        const exe = result.executable || server.path;
        game.target = exe;
        game.workDir = server.root;
        server.path = exe;
      }
      game.version = result.tag;
      game.versionName = result.tag;
      game.lastOfficialSync = Date.now();
      await store.saveNow();
      pushState(true);
      syncOfficialGame(game, []).catch(() => {});
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

  ipcMain.handle('games:sync-official', async () => syncAllOfficial());

  ipcMain.handle('games:launch', async (_event, id) => {
    const game = store.data.games.find((g) => g.id === id);
    if (!game) return { ok: false, error: '没有找到这个游戏' };
    if (running.has(id) || launching.has(id)) return { ok: false, error: '游戏已经在运行了' };

    let target = String(game.target || '').trim();
    const activeServer = (game.servers || []).find(
      (server) => server.id === game.activeServerId && server.path && targetExists(server.path)
    );
    if (activeServer) {
      target = activeServer.path;
      game.target = activeServer.path;
      game.workDir = activeServer.root || path.dirname(activeServer.path);
      if (game.builtinKey === 'endfield' && activeServer.channel === 'official') {
        const fixed = await ensureEndfieldOfficialRuntime(game, activeServer);
        if (fixed) {
          target = activeServer.path;
          game.target = activeServer.path;
          game.workDir = activeServer.root;
        }
      }
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

      if (game.builtinKey === 'neverness' && store.data.settings.nevernessUseOfficialLauncher !== false) {
        const launcher = findNteLauncher(target);
        if (launcher) {
          writeLaunchLog(`launch ${id}: NTE official launcher=${launcher}`);
          target = launcher;
        }
      }

      const lower = target.toLowerCase();
      let cwd = game.workDir && fs.existsSync(game.workDir) ? game.workDir : path.dirname(target);
      if (game.builtinKey === 'neverness' && path.basename(target).toLowerCase() === 'ntelauncher.exe') {
        cwd = path.dirname(target);
      }
      const args = splitArgs(game.args);

      if (lower.endsWith('.lnk') || lower.endsWith('.url')) {
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

      if (game.builtinKey === 'endfield' && path.basename(target).toLowerCase() === 'endfield.exe') {
        launching.add(id);
        const official = await launchEndfield(cwd, target, game.args);
        if (official.ok) {
          await markLaunched(game);
          trackGameProcess(id, 'Endfield.exe', Date.now()).catch(() => {});
          return { ok: true, pid: official.pid, official: true };
        }
        launching.delete(id);
        writeLaunchLog(`launch ${id}: Endfield decoy failed: ${official.error}`);
        if (/740|elevation|管理员/i.test(official.error)) {
          launching.add(id);
          writeLaunchLog(`launch ${id}: Endfield requesting UAC for official parent`);
          const elevated = await launchEndfieldElevated(cwd, target, game.args);
          if (elevated.ok) {
            await markLaunched(game);
            trackGameProcess(id, 'Endfield.exe', Date.now()).catch(() => {});
            return { ok: true, pid: elevated.pid, official: true, elevated: true };
          }
          launching.delete(id);
          writeLaunchLog(`launch ${id}: Endfield UAC failed: ${elevated.error}`);
          return {
            ok: false,
            error: `终末地需要管理员权限：${elevated.error}`,
            elevationRequired: true,
          };
        }
      }

      launching.add(id);
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

      await markLaunched(game);

      if (lower.endsWith('.exe') && !running.has(id)) {
        const isNeverness = game.builtinKey === 'neverness';
        const trackExe = isNeverness ? 'HTGame.exe' : path.basename(target);
        trackGameProcess(
          id,
          trackExe,
          isNeverness ? null : Date.now(),
          isNeverness ? 150 : 8
        ).catch(() => {});
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
    const dir = await ensureDownloadsDir();
    await shell.openPath(dir);
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

  ipcMain.handle('app:relaunch-admin', async () => {
    if (!app.isPackaged) return { ok: false, error: '开发模式下请直接用管理员终端运行' };
    const script = `Start-Process -FilePath ${psQuote(process.execPath)} -Verb RunAs`;
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      setTimeout(() => {
        quitting = true;
        app.quit();
      }, 600);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
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
      title: '选择 Starward 数据库',
      properties: ['openFile'],
      filters: [{ name: 'Starward 数据库', extensions: ['db', 'sqlite', 'sqlite3'] }],
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
      const result = await screenshotLib.listScreenshots({ customRoots, sessionWindows });
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
  ipcMain.handle('graphics:read', async (_event, gameKey) => {
    const key = gameFeatures.normalizeKey(gameKey);
    const trait = gameFeatures.traitOf(key, 'graphics');
    if (!trait || trait.kind !== 'registry') {
      return { ok: false, reason: '这个游戏不支持读取画质配置' };
    }
    try {
      // 只读画质相关的键：原神项里有 345KB 的 device 数据，全量读要十几秒
      const result = graphicsConfig.readGraphics(
        trait.key,
        (name) => graphicsSchema.isGraphicsEntry(name) && !graphicsSchema.isMetaEntry(name)
      );
      if (!result.ok) return result;
      return {
        ...result,
        gameKey: key,
        fields: result.entries.map((entry) => graphicsSchema.describeEntry(entry)),
      };
    } catch (error) {
      return { ok: false, reason: String(error.message || '读取失败') };
    }
  });

  ipcMain.handle('graphics:write', async (_event, input) => {
    const key = gameFeatures.normalizeKey(input?.gameKey);
    const trait = gameFeatures.traitOf(key, 'graphics');
    if (!trait || trait.kind !== 'registry') {
      return { ok: false, reason: '这个游戏不支持修改画质配置' };
    }
    const name = String(input?.name || '');
    if (!name) return { ok: false, reason: '缺少值名' };
    // 只允许写回注册表里已经存在的值，避免往游戏配置里塞垃圾键
    const tempPath = path.join(app.getPath('userData'), 'hxl-reg-check.reg');
    const existing = graphicsConfig.listValueNamesFast(trait.key, tempPath);
    if (!existing.includes(name)) {
      return { ok: false, reason: `注册表里没有 ${name}，拒绝新增` };
    }
    const backupPath = path.join(app.getPath('userData'), 'registry-backup.json');
    try {
      return graphicsConfig.writeValue(trait.key, name, input?.value, backupPath, input?.type);
    } catch (error) {
      return { ok: false, reason: String(error.message || '写入失败') };
    }
  });
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
  }
  pushState(true);
  send('game:exited', { id });
}

async function killGame(id) {
  clearProcessMonitor(id);
  const info = running.get(id);
  if (!info) return;
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

let endfieldPackAutoRunning = false;
async function autoUpdateEndfieldPacks() {
  if (endfieldPackAutoRunning || store.data.settings.autoUpdateEndfieldPacks === false) return;
  const game = store.data.games.find((item) => item.builtinKey === 'endfield');
  if (!game) return;
  if (!(game.servers || []).some((server) => targetExists(server.path))) return;
  endfieldPackAutoRunning = true;
  try {
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
    const result = await updateEndfieldPacks({ root });
    const updated = (result.results || []).filter((item) => !item.skipped && !item.error);
    if (updated.length) {
      store.data.settings.endfieldPackRoot = root;
      await store.saveNow();
      pushState(true);
      send('toast', {
        type: 'success',
        message: `终末地渠道包已自动更新：${updated.map((item) => item.iconName).join('、')}`,
      });
    }
  } catch {
    /* auto update is best effort */
  } finally {
    endfieldPackAutoRunning = false;
  }
}

async function autoCheckLauncherUpdate() {
  if (!store?.data?.settings?.autoCheckUpdate) return;
  if (process.env.HX_CAPTURE === '1' || process.env.HX_SMOKE === '1') return;
  try {
    await performUpdateCheck({ push: true });
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

app.whenReady().then(async () => {
  // 便携模式：Chromium 缓存也放进启动器目录（必须在 ready 之后设置）
  if (portableData && !process.env.HX_USER_DATA) {
    try {
      app.setPath('sessionData', portableData);
    } catch {
      /* ignore */
    }
  }
  store = createStore();
  await store.load();
  await ensureSeedData(store, app.getPath('userData'));
  const previousUiRevision = store.data.settings?.uiRevision;
  store.data.settings = { ...defaultSettings(), ...(store.data.settings || {}) };
  if (!previousUiRevision) store.data.settings.sidebarCollapsed = true;
  const bundledPacks = bundledEndfieldPackRoot();
  if (bundledPacks) store.data.settings.endfieldPackRoot = bundledPacks;
  // 启动时补一次自动探测：用户换了机器、装了 XelLauncher / Starward 都能直接被认出来
  if (!store.data.settings.endfieldPackRoot || !fs.existsSync(store.data.settings.endfieldPackRoot)) {
    const detectedPacks = detectEndfieldPackRoot();
    if (detectedPacks) store.data.settings.endfieldPackRoot = detectedPacks;
  }
  // 便携迁移：旧版本的下载目录如果落在用户目录，改到便携 downloads
  if (portableDownloads) {
    const current = String(store.data.settings.downloadDir || "");
    const systemDownloads = (() => {
      try {
        return app.getPath("downloads");
      } catch {
        return "";
      }
    })();
    if (!current || (systemDownloads && current.startsWith(systemDownloads))) {
      store.data.settings.downloadDir = path.join(portableDownloads, "花筱灵下载");
    }
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
  if (
    store.data.settings.alwaysAdmin &&
    !isElevated() &&
    process.env.HX_CAPTURE !== '1' &&
    process.env.HX_SMOKE !== '1'
  ) {
    if (relaunchElevated()) return;
  }
  applyNativeTheme(store.data.settings.theme);
  applyUiScale(store.data.settings.uiScale);
  await store.saveNow();
  if (ensureAllServers()) await store.saveNow();
  await detectBuiltins(true);

  downloads = new DownloadManager({
    store,
    onChange: () => pushState(false),
    onToast: (payload) => send('toast', payload),
  });
  downloads.restore();

  // 协议必须在创建任何窗口之前注册好，否则首帧里的 <img src="hxl-shot:..."> 会 404
  installShotProtocol();
  installIpc();
  if (process.env.HX_CAPTURE !== '1') createSplashWindow();
  createWindow();
  ensureNevernessCover();
  ensureAnimatedStartBackgrounds();
  startNoticeAutoSync();
  setTimeout(checkEndfieldUpdateNotice, 8000);
  setTimeout(autoUpdateEndfieldPacks, 12000);
  setTimeout(startEndfieldGachaWatcher, 5000);
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
  if (
    process.env.HX_CAPTURE !== '1' &&
    store.data.settings.autoSyncOfficial !== false &&
    Date.now() - (store.data.lastOfficialSync || 0) > 6 * 60 * 60 * 1000
  ) {
    setTimeout(() => {
      syncAllOfficial().catch((error) => console.warn('自动同步官网失败：', error.message));
    }, 4200);
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
  if (win && !win.isDestroyed()) win.removeAllListeners('close');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !store?.data?.settings?.closeToTray) app.quit();
});

process.on('uncaughtException', (error) => {
  writeCrashLog('uncaughtException', error);
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  writeCrashLog('unhandledRejection', error);
  console.error('Unhandled rejection:', error);
});

app.on('child-process-gone', (_event, details) => {
  writeCrashLog('child-process-gone', JSON.stringify(details));
});

app.on('render-process-gone', (_event, _contents, details) => {
  writeCrashLog('render-process-gone', JSON.stringify(details));
});
