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
  screen,
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
const { linkTrees, previewTrees } = require('./link');
const { prepareLinkedRuntime } = require('./runtime');
const { hardlinkTree } = require('./runtime');
const { loadGachaHistory } = require('./gacha');
const nteCapture = require('./nte-capture');
const nevernessPredownload = require('./neverness-predownload');
const nteTool = require('./nte-tool');
const updater = require('./updater');
const { loadGachaMeta } = require('./gacha-meta');
const { ensureErasedBackground } = require('./background-clean');
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
const screenshotLib = require('./screenshots');
const graphicsConfig = require('./graphics-config');
const graphicsSchema = require('./graphics-schema');
const graphicsDetect = require('./graphics-detect');
const installManager = require('./install-manager');
const windowMaterial = require('./window-material');
const { resolvePlayableUrl } = require('./music-resolve');
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
const { syncGacha } = require('./gacha-sync');
const { syncEndfieldGacha } = require('./endfield-gacha');
const { getStarRailFps, setStarRailFps } = require('./starrail-fps');
const {
  updateEndfieldPacks,
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
const { prepareSophon, prepareBilibiliRuntime, normalizeAudioLanguages, fetchLauncherConfig } = require('./sophon');
const { applyHdiffPrepass } = require('./hdiff');
const predownload = require('./predownload');
const nevernessChannels = require('./neverness-channels');

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
    sidebarCollapsed: true,
    uiRevision: 2,
    // 界面缩放：100% 为原始大小，范围 80% - 130%
    uiScale: 100,
    quickPanelPinned: false,
    alwaysAdmin: false,
    // 用户在上一次 UAC 弹窗里点了「否」。记住这个选择，
    // 不要每次冷启动都再弹一次授权（否则启动器一开就被拦住）。
    // 在设置里重新打开「总是以管理员身份运行」会把它清掉。
    elevationDeclined: false,
    nevernessUseOfficialLauncher: true,
    closeToTray: true,
    launchAtLogin: false,
    minimizeOnLaunch: true,
    autoSyncOfficial: true,
    autoUpdateEndfieldPacks: true,
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
     * 官方 enable_ldiff 为 false 的渠道（绝区零三渠道）无论这个开关如何都不会跑。
     */
    enableLdiff: true,
    // 自更新：清单地址留空则不检查；支持 https / 局域网共享 / 本地路径
    updateManifest: '',
    autoCheckUpdate: true,
    // 更新公告弹窗已经弹过的版本号；空串表示这次升级还没看，启动时弹一次
    notesSeenVersion: '',
    endfieldPackRoot: detectEndfieldPackRoot(),
    starwardDbPath: detectStarwardDbPath(),
    runtimeRoot: '',
    // 默认下载目录：固定在启动器自身文件夹内的「花筱灵下载」专门子目录，
    // 既不会和系统下载/桌面混在一起，也不会把启动器自身资源（src、electron、assets 等）放进去。
    // 用户仍可在设置里自定义；首次使用会由主进程自动创建这个空目录。
    downloadDir: path.join(resolvePortableRoot(), '花筱灵下载'),
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
   （命名带 -clean2 是既有清理逻辑的通行证：ensureAnimatedStartBackgrounds
   会把不带 -clean2 的 startCover 直接清空）。失败静默，回退钉住封面。
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
    pushState(true);
  } catch (error) {
    console.warn('崩坏3 启动页静态背景兜底失败：', error.message);
  }
}

/* 2.4.x 增量：明日方舟静态兜底。PV 拉不到时把官网 KV 大图
   （web.hycdn.cn 官方 CDN，无活动文字压屏）落成 startCover，
   命名带 -clean2 与崩坏3 同理，是既有清理逻辑的通行证。
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

// 2.4.0 合并自对方分支：明日方舟 / 崩坏3 的 builtin 封面是人工挑选的官方主视觉，
// 要按自定义封面保护，否则会被官网同步抓回来的活动 banner 顶掉。
// 启动页背景（含 startCover 静态图）因此要照常保留。
const PINNED_BUILTIN_COVERS = /^covers\/builtin-(?:arknights|bh3)\.(?:jpg|jpeg|png|webp|svg)$/i;
function isCustomCover(game) {
  const cover = (game && game.cover) || '';
  if (!cover) return false;
  if (PINNED_BUILTIN_COVERS.test(cover)) return true;
  return !/^covers\/(builtin|official)-/.test(cover);
}

let startArtworkJob = null;
// 2.4.x 增量：官方背景补拉的连续重试计数（成功一轮即清零）
let bh3OfficialRetry = 0;
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
function ensureAnimatedStartBackgrounds() {
  if (startArtworkJob) return startArtworkJob;
  startArtworkJob = (async () => {
    if (!store) return;
    let changed = false;
    let officialMiss = false;
    for (const game of store.data.games) {
      if (!game.builtinKey) continue;
      if (game.startCover && !game.startCover.includes('-clean2.')) game.startCover = '';
      // 2.4.0 合并：customCover 判定换成 isCustomCover —— 明日方舟 / 崩坏3 的
      // 钉住封面（PINNED_BUILTIN_COVERS）不算「用户自定义」，启动页背景照常跟官方走。
      const pinnedCover = PINNED_BUILTIN_COVERS.test(game.cover || '');
      if (isCustomCover(game) && !pinnedCover) continue;

      const key = game.builtinKey;
      // 2.4.0 合并自对方分支 existingStartVideo：官方动图有 mp4 也有 webm
      // （崩坏3 的官方启动器背景就是 VP9/webm），缓存文件名跟随实际格式，
      // 按 mp4 → webm 顺序探测已存在且非空的那一个，不要一律写死 .mp4。
      const cachedVideo = existingStartVideo(key);
      const videoRelative = cachedVideo || `backgrounds/${key}.mp4`;

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
    /* 2.4.x 增量：官方背景偶尔一次拉不到（接口抖动/网络慢）就永远是静态图，
       之后 60 秒补一次预取，最多补 3 次。已落盘的游戏 existingStartVideo
       直接命中跳过，重跑代价只是每游戏一次 getAllGameBasicInfo。 */
    if (officialMiss && bh3OfficialRetry < 3) {
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
  // 旧版本的去字缓存换成 -clean2，失效的路径直接清掉
  if (game.startCover && !game.startCover.includes('-clean2.')) game.startCover = '';
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
  const target = exact
    ? path.resolve(exact)
    : path.join(root, gameKey, channel);
  const sameDrive = path.parse(path.normalize(target)).root.toLowerCase() === baseDrive.toLowerCase();
  return {
    root,
    target,
    sameDrive,
    baseDrive,
  };
}

// 终末地的 U8Data/config 保存渠道登录态，sdkdata 保存 SDK 渠道配置。
// 这些目录不能和基础官服硬链接：B服覆盖时会原地改写官服配置，
// 表现为「切回官服登录页消失/卡死」和「B服启动仍是官服账号」。
const ENDFIELD_COPY_DIRS = ['U8Data', 'sdkdata'];

function endfieldBaseRoot(server) {
  const originalRoot = String(server?.originalRoot || '').trim();
  if (originalRoot && fs.existsSync(originalRoot)) return path.normalize(originalRoot);
  const root = String(server?.root || '').trim();
  // 允许拿任何已经存在的客户端目录当基础（含已生成的链接运行时，例如
  // G:\VelaRuntimes\endfield\global），只要它真的装着 Endfield.exe。
  // 以前这里会拒绝 VelaRuntimes / .vela-linked-runtime 路径，导致「国际服切官服」
  // 找不到基础客户端而报错；同源目录会在生成前用相同目录校验拦住。
  if (root && fs.existsSync(root) && fs.existsSync(path.join(root, 'Endfield.exe'))) {
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

async function ensureEndfieldChannelRuntime(game, server, options = {}) {
  if (game?.builtinKey !== 'endfield' || !server) {
    throw new Error('这个功能只用于明日方舟：终末地');
  }
  const channel = String(server.channel || '');
  const packName = ENDFIELD_PACK_NAMES[channel];
  if (!packName) throw new Error('这个服务器没有对应的渠道差异包');

  const packRootSetting = store.data.settings.endfieldPackRoot;
  if (!packRootSetting || !fs.existsSync(packRootSetting)) {
    throw new Error('还没有设置终末地渠道包目录，请先在设置里指向 XelLauncher 的 load 文件夹');
  }
  const packDir = path.join(packRootSetting, packName);
  if (!fs.existsSync(packDir)) throw new Error(`渠道差异包不存在：${packDir}`);

  // 官服记住的是它自己的原始安装目录；其它渠道优先用官服/别的完整客户端当基础。
  let baseRoot = '';
  let ownOfficialBase = '';
  if (channel === 'official') {
    baseRoot = endfieldBaseRoot(server);
    ownOfficialBase = baseRoot;
    // 官服自己没装客户端时，退回用别的已装渠道（如国际服）当基础强制重建运行时，
    // 否则「国际服切官服」会因找不到基础客户端而反复失败（见 Bug 1）。
    if (!baseRoot) {
      const fallback = endfieldBaseServer(game, server.id) || endfieldBaseServer(game);
      baseRoot = fallback ? fallback.baseRoot : '';
    }
  } else {
    const base = endfieldBaseServer(game, server.id) || endfieldBaseServer(game);
    baseRoot = base ? base.baseRoot : '';
  }
  if (!baseRoot) {
    throw new Error(
      `没有找到可以当作基础的客户端。${server.name}需要一个已安装的终末地在同盘上做基础，请先在启动器里把已经装好的任意渠道客户端指到对应服务器上。`
    );
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

  const runtime = runtimePaths(baseRoot, 'endfield', channel, options.runtimeRoot || '');
  if (!runtime.sameDrive) {
    throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
  }
  const runtimeRoot = runtime.target;
  if (path.resolve(baseRoot).toLowerCase() === path.resolve(runtimeRoot).toLowerCase()) {
    throw new Error('运行时目录不能和基础客户端是同一个目录，请换个“运行时目录”再试');
  }

  const existingExecutable = path.join(runtimeRoot, 'Endfield.exe');
  const marker = path.join(runtimeRoot, '.hxl-endfield-runtime-v2');
  const needsBuild = !fs.existsSync(existingExecutable) || !fs.existsSync(marker);

  // 重建前把旧运行时里的登录态/SDK 配置暂存，生成完拷回来，避免用户重新登录。
  // ⚠️ 但「跨渠道」时绝不能把旧渠道的配置复活：例如官服运行时目录之前装过国际服，
  // 若把国际服的 sdkdata/U8Data 拷回来，会覆盖渠道包写入的官服配置，导致
  // 切回官服仍是国际服界面、不弹登录、资源校验一直报缺失（B服→国际服→官服循环的根因）。
  // 所以只有「同渠道重建」才保留登录态；切换渠道一律让渠道包的配置当权威。
  let savedState = null;
  let savedChannel = '';
  if (needsBuild && fs.existsSync(runtimeRoot)) {
    savedChannel = endfieldChannelOf(runtimeRoot);
    if (savedChannel && savedChannel === channel) {
      savedState = {};
      for (const dir of ENDFIELD_COPY_DIRS) {
        const from = path.join(runtimeRoot, dir);
        if (!fs.existsSync(from)) continue;
        const to = path.join(os.tmpdir(), `hxl-endfield-${channel}-${Date.now()}-${dir}`);
        await fsp.cp(from, to, { recursive: true });
        savedState[dir] = to;
      }
    }
  }

  let result = { linked: 0, overlay: { processed: 0 } };
  if (needsBuild) {
    const emit =
      typeof options.onProgress === 'function'
        ? options.onProgress
        : (progress) => send('endfield:progress', { ...progress, serverName: server.name });
    emit({ phase: 'link', processed: 0, total: 0, current: `正在为${server.name}创建链接运行时…` });
    result = await prepareLinkedRuntime({
      baseRoot,
      packRoot: packDir,
      targetRoot: runtimeRoot,
      copyDirs: ENDFIELD_COPY_DIRS,
      onProgress: emit,
    });
    if (result.cancelled) throw new Error('已取消');

    if (savedState) {
      for (const [dir, from] of Object.entries(savedState)) {
        const to = path.join(runtimeRoot, dir);
        await fsp.rm(to, { recursive: true, force: true });
        await fsp.cp(from, to, { recursive: true });
        await fsp.rm(from, { recursive: true, force: true });
      }
    }

    // 只保留目标渠道自己的 SDK 配置，避免运行时还走基础客户端那个渠道登录。
    const channelSdk = path.join(runtimeRoot, 'sdkdata');
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

    // 删掉基础客户端残留的外渠道 SDK/平台文件（见 reconcileEndfieldRuntime 注释）：
    // 这是 XelLauncher 用 manifest Removed 字段做的那一步，补上后官服运行时不再混装多套 SDK。
    await reconcileEndfieldRuntime(runtimeRoot, packDir, channel);

    await fsp.writeFile(marker, new Date().toISOString(), 'utf8');
  }

  // 官方启动器会持续刷新基础客户端里的平台状态（U8Data/config、sdkdata，
  // 还有 10-28 出现的 U8Data/config/Launcher.meta），而渠道包里的同名快照
  // 停在打包当天。运行时若一直用旧快照，游戏平台层校验资源时会报
  // 「检查资源完整性时发现异常，请重新下载缺失的文件」（10-29 报障根因三）。
  // 官服渠道以基础客户端为准：按 mtime 把更新的平台状态同步进运行时。
  // 注意：B服渠道的 U8Data 是 B 服渠道配置，基础客户端里是官服的，不能这样同步。
  if (channel === 'official') {
    for (const dirName of ['U8Data', 'sdkdata']) {
      await syncNewerFiles(path.join(baseRoot, dirName), path.join(runtimeRoot, dirName));
    }
  }

  // 旧版本 reconcile 会把这几个全渠道通用的官方文件误删，而已建好的
  // 运行时带着 v2 标记不会触发重建，所以这里统一补缺：缺了就从基础客户端
  // 硬链接（跨盘/被占用时退回复制；基础客户端也没有就跳过）。
  //   - PlatformProcess.exe：decoy 启动链的签名父进程（10-29 根因一）。
  //   - webviewsdk.dll：登录/活动页 WebView，官方完整性校验必查（10-29 根因二）。
  //   - hgsdk.dll：鹰角官方 SDK，B服差异包不带，只能从基础客户端补。
  //   - onechannellc.dll：官方 OneChannel 组件，保底不能靠包。
  for (const name of ['PlatformProcess.exe', 'webviewsdk.dll', 'hgsdk.dll', 'onechannellc.dll']) {
    const runtimeFile = path.join(runtimeRoot, name);
    if (fs.existsSync(runtimeFile)) continue;
    const baseFile = path.join(baseRoot, name);
    if (!fs.existsSync(baseFile)) continue;
    try {
      await fsp.link(baseFile, runtimeFile);
    } catch {
      await fsp.copyFile(baseFile, runtimeFile).catch(() => {});
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

  if (channel === 'official') server.originalRoot = baseRoot;
  server.path = launchPath;
  server.root = runtimeRoot;
  server.runtimeLinked = true;
  server.legacyRuntime = false;
  // 关键：以前手动重建成功后没清这个标记，启动页状态点一直红。
  server.incomplete = false;

  return {
    ok: true,
    built: needsBuild,
    runtimeRoot,
    launchPath,
    linked: result.linked || 0,
    overlay: result.overlay?.processed || 0,
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
const ARKNIGHTS_BILIBILI_PAYLOAD = ['PCGameSDK.dll', 'BLPlatform64', 'U8SDK.dll'];
/** 国服的两个渠道共用同一套安装目录；国际服 / 台服是各自独立的客户端。 */
const ARKNIGHTS_CN_CHANNELS = ['official', 'bilibili'];

async function ensureArknightsRuntime(game, server) {
  if (game.builtinKey !== 'arknights') return false;
  if (!server.root || server.root.includes('VelaRuntimes')) return false;
  // 国际服（EN / JP / KR）和台服由另外的发行商发行，主程序和国服不是一份，
  // 没法从国服目录硬链接拼出来，只能用它们自己的安装目录。
  if (!ARKNIGHTS_CN_CHANNELS.includes(server.channel)) return false;
  const runtime = runtimePaths(server.root, 'arknights', server.channel);
  if (!runtime.sameDrive) return false;

  await fsp.mkdir(runtime.target, { recursive: true });
  for (const entry of await fsp.readdir(server.root, { withFileTypes: true })) {
    // 已生成的运行时、以及渠道载荷都跳过，下面单独处理
    if (entry.name === '.vela-runtime' || ARKNIGHTS_BILIBILI_PAYLOAD.includes(entry.name)) continue;
    const target = path.join(runtime.target, entry.name);
    if (fs.existsSync(target)) continue;
    const from = path.join(server.root, entry.name);
    if (entry.isDirectory()) {
      await hardlinkTree({ sourceRoot: from, targetRoot: target }).catch(() => {});
    } else if (entry.isFile()) {
      await fsp.link(from, target).catch(() => fsp.copyFile(from, target).catch(() => {}));
    }
  }

  if (server.channel === 'bilibili') {
    // B服 独有文件优先从基础目录拿；基础目录没有就报错，不能假装切过去
    let missing = [];
    for (const name of ARKNIGHTS_BILIBILI_PAYLOAD) {
      const from = path.join(server.root, name);
      if (!fs.existsSync(from)) {
        missing.push(name);
        continue;
      }
      const target = path.join(runtime.target, name);
      if (fs.existsSync(target)) await fsp.rm(target, { recursive: true, force: true });
      const stat = await fsp.stat(from);
      if (stat.isDirectory()) await hardlinkTree({ sourceRoot: from, targetRoot: target }).catch(() => {});
      else await fsp.link(from, target).catch(() => fsp.copyFile(from, target).catch(() => {}));
    }
    if (missing.length) {
      throw new Error(
        `这个目录里没有 B服 的渠道文件（${missing.join('、')}）。` +
          '明日方舟官服和 B服 共用同一个安装目录，需要先放入 B服 渠道文件才能切换。'
      );
    }
  } else {
    // 官服运行时里不能残留 B服 的 SDK，否则会带着 B站凭据启动
    for (const name of ARKNIGHTS_BILIBILI_PAYLOAD) {
      await fsp.rm(path.join(runtime.target, name), { recursive: true, force: true });
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

async function prepareGenshinPackRuntime(game, server) {
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
 * 异环启动后自动帮用户点登录窗上的「开始游戏」按钮。
 * NTEGame.exe /launcher 会弹 Qt 登录窗,按钮还要人手点一下;这里用 UIA 按窗口 PID 找到
 * Name=「开始游戏」的按钮直接 Invoke(备选 SelectionItem)。Qt QML 可能不暴露 UIA 树,
 * 拿不到就静默放弃,不影响正常启动流程。
 */
let nteAutoClickRunning = false;

function autoClickNteStart(gameId) {
  if (nteAutoClickRunning) return;
  nteAutoClickRunning = true;
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "$procs=@(Get-Process -Name 'NTEGame' -ErrorAction SilentlyContinue)",
    "if($procs.Count -eq 0){[Console]::Out.Write('NOPROC');exit}",
    "$root=[System.Windows.Automation.AutomationElement]::RootElement",
    "foreach($p in $procs){",
    "  $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$p.Id)",
    "  $wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$cond)",
    "  foreach($w in $wins){",
    "    $nameCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'开始游戏')",
    "    $btn=$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$nameCond)",
    "    if($btn -eq $null){continue}",
    "    $invoke=$btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)",
    "    if($invoke -ne $null){$invoke.Invoke();[Console]::Out.Write('CLICKED');exit}",
    "    $sel=$btn.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)",
    "    if($sel -ne $null){$sel.Select();[Console]::Out.Write('CLICKED');exit}",
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
      for (let round = 0; round < 25; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3500));
        const out = await attempt();
        if (out === 'CLICKED') {
          writeLaunchLog(`launch ${gameId}: NTE start button auto-clicked`);
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
      writeLaunchLog(`launch ${gameId}: NTE auto-click gave up (start button not exposed)`);
    } catch {
      /* 尽力而为,失败不影响启动 */
    } finally {
      nteAutoClickRunning = false;
    }
  })();
}

function channelFromInstallPath(exePath) {  let folder = exePath;
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

// 检测到的 exe 属于哪个渠道。终末地读不了 config.ini，只能看文件特征。
function detectionChannel(game, exePath) {
  if (!exePath) return '';
  if (game && game.builtinKey === 'endfield') return endfieldChannelOf(path.dirname(exePath));
  return channelFromInstallPath(exePath);
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
      // 终末地的链接运行时本来就没有 config.ini（那是米哈游三件套的约定），
      // 只看我们自己写的 v2 标记；否则每次启动都会把 B服/国际服标成「需要重建」（红点）。
      const isEndfieldRuntime =
        game.builtinKey === 'endfield' &&
        (server.runtimeLinked === true || fs.existsSync(path.join(dir, '.hxl-endfield-runtime-v2')));
      const hasConfig = fs.existsSync(path.join(dir, 'config.ini')) || isEndfieldRuntime;
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
      const channel = detectionChannel(game, exePath);
      const server = (game.servers || []).find((item) => item.channel === channel);
      if (!server) continue;
      if (
        !fs.existsSync(path.join(path.dirname(exePath), 'config.ini')) &&
        !(game.builtinKey === 'endfield' && fs.existsSync(path.join(path.dirname(exePath), '.hxl-endfield-runtime-v2')))
      ) {
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
      // 检测到的客户端属于哪个渠道，就写进哪个渠道那一行。
      // 只装了 B服 / 国际服 的玩家本来就没有官服客户端，不能把路径塞进官服行。
      const detected = serverForDetected(game, detectionChannel(game, found));
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
    // 启动时刻，前端拿它算「已运行多久」
    runningSince: running.get(game.id)?.startedAt || null,
    // 更新弹窗的置顶图没配来源时，用它标注「图片来源」。
    officialSite: OFFICIAL_SITES[game.builtinKey] || '',
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
const OFFICIAL_UPDATE_MANIFESTS = [
  'https://raw.githubusercontent.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher/main/latest.json',
  'https://cdn.jsdelivr.net/gh/Sparkle0v0Hxl/HuaXiaoLing-Launcher@main/latest.json',
];

/** 更新源候选：一次给全，挨个试，第一个读得通的算数。 */
function updateSourceList() {
  const configured = String(store?.data?.settings?.updateManifest || '').trim();
  const list = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !list.includes(text)) list.push(text);
  };
  if (configured) {
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
  const locations = resolveUpdateSource();
  if (!locations.length) throw new Error('还没有设置更新源');
  updateStatus = { ...updateStatus, downloading: true, percent: 0, error: '' };
  pushState(true);
  try {
    // 挨个候选找一份读得通的清单：用户填的 → 目录里那份 → 官方源
    const resolved = await updater.resolveManifest(locations);
    if (!resolved.ok) throw new Error(resolved.error || '读不到更新清单');
    const manifest = resolved.manifest;
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
        mirrors: manifest.mirrors,
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

    // 100% 之后还有解压、覆盖两大步，界面必须继续给反馈，否则用户以为卡死了
    send('update:progress', { percent: 100, phase: 'verify', label: '正在校验更新包…' });

    // 解压、检查包结构，同时算出被占用的程序文件。
    // 版本号以清单为准：package.json 只在发版时才改，清单是随时能改的。
    send('update:progress', { percent: 100, phase: 'extract', label: '正在解压更新包…' });
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
    icon: loadWindowIcon(),
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

  win.loadFile(path.join(ROOT, 'src', 'index.html'));
  // 页面加载完再套缩放：loadFile 触发的导航会把提前设好的 zoomFactor 重置回 1
  win.webContents.on('did-finish-load', () => {
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
      } else if (process.env.HX_PROBE === '1') {
        setTimeout(runLayoutProbe, 700);
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
function spawnElevatedSelf(delayMs = 2500) {
  /*
   * 不只是「睡一会儿」：直接用 Wait-Process 等当前进程真的退出。
   * 固定 sleep 在慢机器上不够（Electron 退进程可能要好几秒），
   * 新实例抢不到单实例锁就又变成「点了没反应」。
   */
  const script = [
    "$ErrorActionPreference='Stop'",
    `Start-Sleep -Milliseconds ${delayMs}`,
    `try { Wait-Process -Id ${process.pid} -Timeout 30 -ErrorAction Stop } catch { }`,
    '$elevated = $null',
    'try {',
    `  $elevated = Start-Process -FilePath ${psQuote(process.execPath)} -Verb RunAs -PassThru`,
    '  Start-Sleep -Seconds 6',
    '  if ($elevated.HasExited) { throw "elevated instance exited immediately" }',
    '} catch {',
    '  Start-Sleep -Milliseconds 400',
    `  Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList '--no-elevate'`,
    '}',
  ].join("\n");
  const child = spawn(powershellExe(), ['-NoProfile', '-Command', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  return child;
}

function relaunchElevated() {
  if (!app.isPackaged) return false;
  try {
    writeLaunchLog('alwaysAdmin: 当前非管理员，调度提权重启（UAC 拒绝或新实例未存活会自动回退普通权限）');
    const child = spawnElevatedSelf(1500);
    /*
     * 关键：只有确认提权脚本进程真的起来了，才退出当前实例。
     * 之前是先 app.quit() 再祈祷——spawn 一失败（powershell 被拦、PATH 异常），
     * 脚本没跑、老实例已退，用户看到的就是「双击没反应」且 crash.log 无记录。
     * 现在 spawn 失败就吞掉事件继续以普通权限跑；脚本起来了它自己会兜底
     * （UAC 拒绝 / 提权实例 6 秒内退出 → 自动拉起 --no-elevate 实例）。
     */
    let spawnSettled = false;
    child.on('error', () => {
      spawnSettled = true;
      writeLaunchLog('alwaysAdmin: 提权脚本进程启动失败，继续以普通权限运行');
    });
    child.on('spawn', () => {
      spawnSettled = true;
      child.unref();
      setTimeout(() => {
        quitting = true;
        app.quit();
      }, 400);
    });
    setTimeout(() => {
      if (!spawnSettled) writeLaunchLog('alwaysAdmin: 提权脚本 5 秒未启动，继续以普通权限运行');
    }, 5000);
    return true;
  } catch (error) {
    writeLaunchLog(`alwaysAdmin: 提权重启调度失败，继续以普通权限运行: ${error.message}`);
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
   * 启动页唤出侧栏：把窗口整体向左「外扩」出一块放侧栏，
   * 这样画面本身不用缩窄、不用右移被裁。扩不出去时（全屏 / 最大化 /
   * 已经贴着显示器左边缘）返回 ok:false，渲染层改走浮层方案。
   */
  let startNavBaseBounds = null;
  ipcMain.handle('window:expand-left', (event, payload = {}) => {
    if (!win || win.isDestroyed() || win.isMinimized()) return { ok: false, reason: 'unavailable' };
    const expand = Boolean(payload.expand);
    if (!expand) {
      if (!startNavBaseBounds) return { ok: true, expanded: false };
      const restore = startNavBaseBounds;
      startNavBaseBounds = null;
      win.setBounds(restore);
      return { ok: true, expanded: false };
    }
    const width = Math.round(Number(payload.width) || 0);
    if (width <= 0) return { ok: false, reason: 'no-width' };
    // 已经扩过了就别叠加
    if (startNavBaseBounds) return { ok: true, expanded: true };
    if (win.isFullScreen() || win.isMaximized()) return { ok: false, reason: 'no-expand' };
    const bounds = win.getBounds();
    let area = bounds;
    try {
      area = screen.getDisplayMatching(bounds).workArea;
    } catch (error) {
      area = bounds;
    }
    // 左边没地方了（贴边 / 多屏拼接处）也扩不了
    if (bounds.x - width < area.x) return { ok: false, reason: 'no-space' };
    startNavBaseBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    win.setBounds({
      x: bounds.x - width,
      y: bounds.y,
      width: bounds.width + width,
      height: bounds.height,
    });
    return { ok: true, expanded: true };
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
      'elevationDeclined',
      'nevernessUseOfficialLauncher',
      'closeToTray',
      'launchAtLogin',
      'minimizeOnLaunch',
      'autoSyncOfficial',
      'autoUpdateEndfieldPacks',
      'autoGacha',
      'audioLanguages',
      'includeStoryResources',
      // ldiff 增量加速开关：不留退路的话，介意「就地改写游戏文件」的用户没有别的选择。
      'enableLdiff',
      // 装饰挂饰 / 角色背景水印：这两个以前不在白名单里，快照永远不带这两个键，
      // 状态回推时会把刚点下去的值抹掉，开关表现为「点了直接弹回原状」。
      'charms',
      'charBg',
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
          onProgress: (progress) => send('endfield:game-progress', progress),
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
          return applied;
        }
      } catch (error) {
        writeLaunchLog(`endfield update: predownload apply fallback: ${error.message}`);
      }
    }
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
        const info = await kugouSongUrl(best.hash);
        return { ...info, matched: `${best.title} - ${best.artist}` };
      },
    ]);
  }
  if (flags.qq !== false) {
    tries.push([
      'QQ 音乐',
      async () => {
        const best = pickBest(await qqSearch(keyword, 5), wants);
        if (!best) throw new Error('没搜到同名曲');
        const info = await qqSongUrl(best.mid);
        return { ...info, matched: `${best.title} - ${best.artist}` };
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

  // 3) 同一个歌名的其它版本（重制 / 现场 / 翻唱）通常没有版权限制
  if (neteaseAllowed && title) {
    try {
      const search = await neteaseGet(apiBase, '/search', { keywords: `${title} ${artist}`.trim(), limit: 8, type: 1 });
      const list = search?.result?.songs || [];
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
   * 会话里的 buvid/登录态根本发不出去，-352 风控就是这么一直拦着的。
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

  ipcMain.handle('live:danmu-info', async (_event, roomId) => {
    const id = String(roomId || '').trim();
    if (!id) throw new Error('没有房间号');
    await ensureBiliBuvid().catch(() => {});
    const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${encodeURIComponent(id)}&type=0`;
    const referer = `https://live.bilibili.com/${id}`;
    let json = null;
    let detail = '';
    // 路线一：Chromium 网络栈，自动带会话 cookie，TLS 指纹与真实浏览器一致
    try {
      const { status, body } = await biliFetchText(url, referer);
      detail = `HTTP ${status}`;
      try {
        json = JSON.parse(body);
      } catch {
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
    if (json?.code !== 0) {
      try {
        const jarCookies = await session.defaultSession.cookies
          .get({ url: 'https://live.bilibili.com/' })
          .catch(() => []);
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
          json = JSON.parse(body);
        } catch {
          detail += `，非 JSON：${body.slice(0, 60)}`;
        }
      } catch (error) {
        detail += `；Node 备用路线失败：${error.message}`;
      }
    }
    if (json?.code !== 0 || !json?.data?.token) {
      const message = String(json?.message || '');
      throw new Error(
        message === '-352'
          ? '被B站风控拦截(-352)，点「登录B站」登录一次账号即可解决'
          : `${message || '弹幕鉴权获取失败'}（${detail || '原因不明'}）`
      );
    }
    const host = (json.data.host_list || [])[0] || {};
    return { token: String(json.data.token), host: String(host.host || ''), port: Number(host.wss_port || 443) };
  });

  /*
   * B 站账号登录窗口：passport.bilibili.com，扫码 / 账密都行。
   * 用默认会话开窗——登录产生的 SESSDATA 等 cookie 直接落在主会话里，
   * 弹幕鉴权（useSessionCookies）立刻就能用上，不需要导来导去。
   * 窗口轮询到 SESSDATA 出现就自动关闭并返回成功。
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
        // 同 detectBuiltins：写进真实渠道那一行，没有官服客户端时不再凭空占用官服行。
        const detected = serverForDetected(game, detectionChannel(game, found));
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
    if (server.incomplete && game.builtinKey !== 'endfield') {
      throw new Error('这个目录是资源替换包，不是完整客户端；请点这一行的下载按钮生成国际服客户端');
    }
    if (!server.path || !targetExists(server.path)) {
      if (game.builtinKey !== 'endfield') {
        throw new Error('这个服务器还没有配置启动程序，先点“编辑”选择客户端');
      }
    }
    if (game.builtinKey === 'genshin' && server.channel === 'global') {
      const prepared = await prepareGenshinPackRuntime(game, server);
      if (prepared) {
        server.path = prepared.executable;
        server.root = prepared.runtimeRoot;
        server.runtimeLinked = true;
      }
    }
    if (game.builtinKey === 'endfield') {
      // 有可用路径时保持“尽力而为”：渠道包/基础客户端缺失不阻断已就绪服务器的切换；
      // 没有任何路径时才把自动生成的错误抛给用户看。
      const hadPath = server.path && targetExists(server.path);
      const prepared = await ensureEndfieldChannelRuntime(game, server).catch((error) => {
        if (hadPath) return null;
        throw error;
      });
      if (prepared) {
        server.path = prepared.launchPath;
        server.root = prepared.runtimeRoot;
        server.runtimeLinked = true;
      }
    }
    // 明日方舟（2.4.0 合并）：官服 / B服 在同一套安装目录里，按终末地那套运行时
    // 方案复制出独立目录，大文件硬链接、渠道 SDK 换成目标服的。缺 B服 载荷时直接抛错。
    if (game.builtinKey === 'arknights') {
      await ensureArknightsRuntime(game, server);
    }
    game.activeServerId = server.id;
    game.target = server.path;
    game.workDir = server.root || path.dirname(server.path);
    await store.saveNow();
    pushState(true);
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

    // 基础客户端不再要求必须是官服：只装了 B服 / 国际服 / Play / Steam 的玩家，
    // 用他自己装好的那个客户端当基础一样能生成（链接+覆盖渠道差异文件，与渠道无关）。
    // 官服仍然排在第一优先：和官服用同一个版本比对时能链接的文件最多。
    // 优先拿别的服务器当基础；如果玩家整个电脑上只有这一种渠道的客户端，
    // 就用它自己当基础（生成出来的运行时内容与它一致，只是独立一份）。
    const base = endfieldBaseServer(game, server.id) || endfieldBaseServer(game);
    if (!base) {
      throw new Error(
        `没有找到可以当作基础的客户端。${server.name}需要一个已安装的终末地在同盘上做基础，请先在启动器里把已经装好的任意渠道客户端指到对应服务器上。`
      );
    }
    const baseRoot = base.baseRoot;

    const runtime = runtimePaths(baseRoot, 'endfield', server.channel, input?.runtimeRoot);
    if (!runtime.sameDrive) {
      throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
    }
    const runtimeRoot = runtime.target;
    // 生成过程会先清空目标目录再写入；万一基础客户端和目标算到了同一个目录，
    // 那一步就会把玩家的基础客户端删掉。宁可报错也不能冒这个险。
    if (path.resolve(baseRoot).toLowerCase() === path.resolve(runtimeRoot).toLowerCase()) {
      throw new Error('运行时目录不能和基础客户端是同一个目录，请换个“运行时目录”再试');
    }
    send('endfield:progress', {
      phase: 'link',
      processed: 0,
      total: 0,
      current: '正在创建链接运行时…',
    });
    try {
      const result = await prepareLinkedRuntime({
        baseRoot,
        packRoot: packDir,
        targetRoot: runtimeRoot,
        copyDirs: ENDFIELD_COPY_DIRS,
        onProgress: (progress) =>
          send('endfield:progress', {
            ...progress,
            serverName: server.name,
          }),
      });
      if (result.cancelled) throw new Error('已取消');

      // 渠道包不自带对家 sdkdata；基础客户端（可能是任意渠道）复制过来的渠道 SDK 配置
      // 会让运行时仍走基础客户端那个渠道登录，所以只保留目标渠道自己的配置。
      const channelSdk = path.join(runtimeRoot, 'sdkdata');
      try {
        for (const entry of await fsp.readdir(channelSdk)) {
          if (!/^sdk_[a-z]+_config/i.test(entry)) continue;
          const keep = (ENDFIELD_SDK_KEEP[server.channel] || []).some((prefix) =>
            entry.toLowerCase().startsWith(prefix)
          );
          if (!keep) await fsp.rm(path.join(channelSdk, entry), { force: true });
        }
      } catch {
        /* sdkdata 可能不存在 */
      }

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
      // 重建成功后清掉「资源包/未就绪」标记，启动页状态点才会变绿。
      server.incomplete = false;
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

  /**
   * 估算生成差异客户端要占多少空间。
   *
   * 生成时会把基础客户端里内容相同的文件直接硬链接过去，那部分不额外占空间，
   * 所以这里只给两个确定的事实：目标盘还剩多少、基础客户端有多大。
   * 客户端体积靠遍历目录算，给了 4 秒上限 —— 超大客户端算不完就先报可用空间，
   * 不能让「看个数字」把界面卡住。
   */
  async function estimateRuntimeSpace(baseRoot, targetRoot) {
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
              baseBytes += Number(info.size) || 0;
              baseFiles += 1;
            } catch {
              /* 读不到就跳过，不影响其它文件 */
            }
          }
        }
      }
    }

    return { ok: true, estimate: true, drive, freeBytes, baseBytes, baseFiles, partial, targetRoot };
  }

  ipcMain.handle('servers:prepare-sophon', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game || !['genshin', 'starrail', 'zzz'].includes(game.builtinKey)) {
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
              onProgress: (progress) => send('sophon:progress', { jobId, ...progress }),
            })
          : await prepareSophon({
              gameKey: game.builtinKey,
              channel: server.channel,
              baseRoot: base.root,
              targetRoot,
              cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
              audioLanguages: store.data?.settings?.audioLanguages,
              // 绝区零那 111 份分类剧情资源（约 19.73GB）要不要一起装。默认不装。
              includeStoryResources: storyResourcesEnabled(game, server),
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
    /*
     * 之前预下载过的话，chunk/ 里就是新版本的分块，先把它吃掉：
     * 命中的分块 0 流量，缺的才联网补。没有预下载产物时 hasCache 为 false，
     * 这里整段跳过，行为与原来完全一致。
     */
    if (predownload.hasCache({ gameKey: game.builtinKey, channel: server.channel, installRoot: server.root })) {
      try {
        const appliedResult = await predownload.apply({
          gameKey: game.builtinKey,
          channel: server.channel,
          installRoot: server.root,
          cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
          audioLanguages: store.data?.settings?.audioLanguages,
          includeCategory: storyResourcesEnabled(game, server),
          signal,
          onProgress: (progress) => send('sophon:progress', { jobId, ...progress }),
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
       * 绝区零三个渠道 enable_ldiff=false，直接跳过这轮全盘 md5。
       */
      let ldiff = null;
      try {
        const launcherConfig = await fetchLauncherConfig(game.builtinKey, server.channel);
        const userEnabled = store.data?.settings?.enableLdiff !== false;
        if (userEnabled && launcherConfig.enableLdiff) {
          ldiff = await applyHdiffPrepass({
            gameKey: game.builtinKey,
            channel: server.channel,
            installRoot: server.root,
            cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
            audioLanguages: store.data?.settings?.audioLanguages,
            includeStory: storyResourcesEnabled(game, server),
            signal,
            onProgress: (progress) => send('sophon:progress', { jobId, ...progress }),
          });
          if (ldiff?.ok && ldiff.applied > 0) {
            writeLaunchLog(
              `update ${game.id}: ldiff 修补 ${ldiff.applied} 个文件，补丁 ${ldiff.patchBytes} 字节，省流 ${ldiff.saveBytes} 字节`
            );
          } else if (ldiff?.reason) {
            writeLaunchLog(`update ${game.id}: ldiff 跳过（${ldiff.reason}）`);
          }
        } else {
          writeLaunchLog(
            `update ${game.id}: 跳过 ldiff（${
              userEnabled ? launcherConfig.defaultDownloadMode || '渠道未启用' : '用户在设置里关掉了'
            }），走纯 chunk`
          );
        }
      } catch (error) {
        writeLaunchLog(`update ${game.id}: ldiff 预处理失败，退回纯 chunk：${error.message}`);
      }
      if (signal.cancelled) return { ok: false, cancelled: true };
      const result = await prepareSophon({
        gameKey: game.builtinKey,
        channel: server.channel,
        baseRoot: server.root,
        targetRoot: server.root,
        cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
        audioLanguages: store.data?.settings?.audioLanguages,
        // 必须和安装那条路径用同一个取值，否则会出现「安装时不装、一更新就补 19.73GB」
        includeStoryResources: storyResourcesEnabled(game, server),
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
      // 把 ldiff 的战果带回去，界面上能显示「其中 N 个文件是本地补丁修好的，省流 X」。
      if (ldiff?.ok && ldiff.applied > 0) {
        return {
          ok: true,
          ...result,
          ldiff: {
            applied: ldiff.applied,
            failed: ldiff.failed,
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

  /** 目标盘剩余空间；读不到就返回 0（调用方自行决定是否放行）。 */
  async function driveFreeBytes(dir) {
    try {
      const stats = await fsp.statfs(path.parse(path.resolve(dir)).root);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return 0;
    }
  }

  /** 官方清单口径的全量体积：sophon 读清单，终末地 / 明日方舟读整包卷 total_size。 */
  async function estimateDownloadBytes(game, server, engine, installDir) {
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
      return { version: preview.tag, totalBytes: preview.totalBytes, storyResources: preview.storyResources || null };
    }
    const profile = downloadPackProfile(game.builtinKey, server.channel);
    const latest = await fetchLatest(profile);
    return { version: latest.version, totalBytes: latest.totalSize, storyResources: null };
  }

  ipcMain.handle('servers:download-estimate', async (_event, input) => {
    const game = store.data.games.find((item) => item.id === input?.gameId);
    if (!game) throw new Error('没有找到这个游戏');
    const engine = DOWNLOADABLE_KEYS[game.builtinKey];
    if (!engine) throw new Error('这款游戏暂不支持自动下载，请前往官网下载安装');
    const installDir = path.resolve(String(input?.installDir || '').trim());
    if (!installDir || installDir === path.parse(installDir).root) {
      throw new Error('请先选择一个安装目录');
    }
    const server = serverForDownload(game, String(input?.channel || ''));
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
    const engine = DOWNLOADABLE_KEYS[game.builtinKey];
    if (!engine) throw new Error('这款游戏暂不支持自动下载，请前往官网下载安装');
    if (running.has(game.id)) throw new Error('游戏正在运行，先结束进程再下载');
    const server = serverForDownload(game, String(input?.channel || ''));
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
          onProgress: (progress) => send('sophon:progress', { jobId, ...progress }),
        });
        executable = result.executable || '';
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
                send('sophon:progress', {
                  jobId,
                  phase: 'download',
                  processed: packIndex,
                  total: totalPacks,
                  bytesDone: totalPacks ? Math.round((Number(summary.totalBytes) || 0) * (packIndex / totalPacks)) : 0,
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
    return {
      game,
      server,
      installRoot,
      base: {
        gameKey: game.builtinKey,
        channel: server.channel,
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
   *   1. 同一个服务器 6 小时内不重复问，别把官方接口当轮询用；
   *   2. 串行 + 每次间隔 1.5s，冷启动瞬间不要同时打五六个渠道，拖慢首屏；
   *   3. 查询失败**不覆盖**上一次的有效状态 —— 断网时按钮不能凭空消失。
   */
  const PREDOWNLOAD_AUTO_TTL = 6 * 60 * 60 * 1000;

  async function autoRefreshPredownloadStatus() {
    const now = Date.now();
    for (const game of store.data.games || []) {
      if (quitting) return;
      if (!game.installed) continue;
      const servers = (game.servers || []).filter((item) => item.root);
      // 只查当前在用的那个渠道：别的渠道在启动页点不到，问了也是白问
      const server = servers.find((item) => item.active) || servers[0];
      if (!server) continue;
      const fresh = Date.parse(server.predownload?.updatedAt || '') || 0;
      if (server.predownload && now - fresh < PREDOWNLOAD_AUTO_TTL) continue;
      // 正在预下载 / 正在更新时别插队，免得两边抢同一份清单
      if (predownloadJobs.size) return;
      try {
        const { base } = resolvePredownload({ gameId: game.id, serverId: server.id });
        const report = await predownload.check({ ...base, verify: false });
        if (report) await savePredownloadState(server, report);
      } catch (error) {
        writeLaunchLog(`predownload auto-check ${game.id}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  ipcMain.handle('predownload:check', async (_event, input) => {
    const { server, base } = resolvePredownload(input);
    const report = await predownload.check({ ...base, verify: input?.verify === true });
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
      const result = await predownload.start({
        ...base,
        signal,
        onProgress: (progress) => send('predownload:progress', { jobId, ...progress }),
      });
      if (signal.cancelled) return { ok: false, cancelled: true };
      await savePredownloadState(server, await predownload.check(base));
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
    const jobId = String(input?.jobId || crypto.randomUUID());
    const signal = { cancelled: false };
    predownloadJobs.set(jobId, signal);
    beginBackgroundTask();
    send('predownload:progress', { jobId, phase: 'start', current: '正在校验并应用预下载内容…' });
    try {
      const result = await predownload.apply({
        ...base,
        signal,
        onProgress: (progress) => send('predownload:progress', { jobId, ...progress }),
      });
      if (signal.cancelled) return { ok: false, cancelled: true };
      const tag = String(result?.tag || result?.version || '');
      server.predownload = null;
      if (tag) {
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
    const result = await predownload.clear({ gameKey: base.gameKey, installRoot: base.installRoot });
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

  ipcMain.handle('games:sync-official', async () => syncAllOfficial());

  ipcMain.handle('games:launch', async (_event, id) => {
    const game = store.data.games.find((g) => g.id === id);
    if (!game) return { ok: false, error: '没有找到这个游戏' };
    // 先清掉已经不存在的进程，避免「点了没反应、只说游戏在运行」
    if (await pruneStaleRunning()) pushState(true);
    if (running.has(id)) return { ok: false, error: '游戏已经在运行了' };
    if (launching.has(id)) {
      return { ok: false, error: '正在启动中，请稍候…（如果弹出了管理员授权窗口，请点“是”）' };
    }

    let target = String(game.target || '').trim();
    const activeServer = (game.servers || []).find(
      (server) => server.id === game.activeServerId && server.path && targetExists(server.path)
    );
    if (activeServer) {
      target = activeServer.path;
      game.target = activeServer.path;
      game.workDir = activeServer.root || path.dirname(activeServer.path);
    }
    if (game.builtinKey === 'endfield' && !running.has(id)) {
      // 所有渠道统一先走自动生成：有 v2 标记就直接复用（很快），
      // 缺标记/缺文件就重建，并把 incomplete 清掉让启动页状态点变绿。
      const efServer = (game.servers || []).find((server) => server.id === game.activeServerId);
      if (efServer) {
        const prepared = await ensureEndfieldChannelRuntime(game, efServer).catch((error) => {
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
      if (
        nteDirectArgs.length &&
        path.basename(target).toLowerCase() === 'ntegame.exe' &&
        !args.some((item) => /^\/?launcher$/i.test(item))
      ) {
        args = [...nteDirectArgs, ...args];
      }

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
        /*
         * 终末地的启动链路会 CreateProcess 子进程，非管理员身份一定拿到 740（ERROR_ELEVATION_REQUIRED）。
         * 以前是先跑一遍注定失败的官方登录流程、等它报错再弹 UAC，
         * 用户看到的就是「点了打开游戏，半天没反应，最后说要管理员权限」。
         * 现在直接判断当前权限：没提权就直接走 UAC 那一条，省掉那次必然失败的尝试。
         */
        if (!currentElevation()) {
          launching.set(id, Date.now());
          writeLaunchLog(`launch ${id}: 当前非管理员，直接请求 UAC 启动终末地`);
          const elevated = await launchEndfieldElevated(cwd, target, game.args);
          if (elevated.ok) {
            await markLaunched(game);
            trackGameProcess(id, 'Endfield.exe', Date.now()).catch(() => {});
            return { ok: true, pid: elevated.pid, official: true, elevated: true };
          }
          launching.delete(id);
          writeLaunchLog(`launch ${id}: Endfield UAC failed: ${elevated.error}`);
          return { ok: false, error: elevated.error, elevationRequired: true };
        }
        launching.set(id, Date.now());
        const official = await launchEndfield(cwd, target, game.args);
        if (official.ok) {
          await markLaunched(game);
          trackGameProcess(id, 'Endfield.exe', Date.now()).catch(() => {});
          return { ok: true, pid: official.pid, official: true };
        }
        launching.delete(id);
        writeLaunchLog(`launch ${id}: Endfield decoy failed: ${official.error}`);
        if (/740|elevation|管理员/i.test(official.error)) {
          launching.set(id, Date.now());
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
        // 异环直达登录窗后，帮忙把「开始游戏」也点了（UIA 找按钮，找不到就静默让人点）
        if (isNeverness && path.basename(target).toLowerCase() === 'ntegame.exe') {
          autoClickNteStart(id);
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
    try {
      // 等当前实例退干净再提权启动，否则新实例抢不到单实例锁会直接退出（表现为「没反应」）
      spawnElevatedSelf(1500);
      setTimeout(() => {
        quitting = true;
        app.quit();
      }, 400);
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
  function graphicsFixedKeyUsable(registryKey) {
    if (!registryKey) return false;
    try {
      if (graphicsDetect.stillExists(registryKey) === false) return false;
      const names = graphicsConfig.listValueNamesFast(
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
      if (fixed && graphicsFixedKeyUsable(gameKey, game, fixed.key)) {
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
        ? graphicsDetect.detect(Object.assign({}, game, { _force: true }))
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
    const result = graphicsConfig.readGraphics(
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
      const result = graphicsConfig.readGraphics(
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
    const existing = graphicsConfig.listValueNamesFast(registryKey, tempPath);
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
      const isJsonValue = entry && field && field !== entry && graphicsConfig.looksLikeJsonObject(registryKey, target);
      if (isJsonValue) {
        return graphicsConfig.updateJsonField(registryKey, entry, field, input?.value, backupPath, input?.type);
      }
      return graphicsConfig.writeValue(registryKey, entry || name, input?.value, backupPath, input?.type);
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
  // 全新安装判定：数据文件还不存在时不吵醒任何旧值，用来决定默认称呼
  const freshStore = !fs.existsSync(dataFile());
  store = createStore();
  await store.load();
  // 歌单缓存单独一个文件：它是可丢的派生数据，不该和 launcher-data.json 共命运
  await playlistCache().load();
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
  const ipc = installIpc();
  if (process.env.HX_CAPTURE !== '1') createSplashWindow();
  createWindow();
  // 开机预读画质：用户点进画质页时直接拿缓存，不用再等注册表
  ipc?.primeGraphicsCache?.();
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
  try {
    // 歌单缓存也要落一次：它走 400ms 防抖，直接关窗口时可能还在队列里
    playlistCacheStore?.flushSync();
  } catch (error) {
    console.warn('Playlist cache flush failed:', error.message);
  }
  if (win && !win.isDestroyed()) win.removeAllListeners('close');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !store?.data?.settings?.closeToTray) app.quit();
});

app.on('child-process-gone', (_event, details) => {
  writeCrashLog('child-process-gone', JSON.stringify(details));
});

app.on('render-process-gone', (_event, _contents, details) => {
  writeCrashLog('render-process-gone', JSON.stringify(details));
});
