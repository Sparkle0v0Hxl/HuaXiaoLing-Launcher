'use strict';

const api = window.launcher;

/* 音效预设 / 存储键 / 音量 / 音效链已拆到 services/audio-fx.js。
 * 普通 script 共享全局作用域，那边的常量与函数在这里照常可用。 */


/* ------------------------------------------------------------------ */
/* 界面缩放                                                             */
/* ------------------------------------------------------------------ */

/** 可选的界面缩放档位。窗口本体尺寸固定，靠缩放把内容等比放大或缩小。 */
const UI_SCALE_STEPS = [80, 90, 100, 110, 120, 130];

/**
 * 项目的 GitHub 地址。
 *
 * 内置的「检查更新」走 latest.json，网络受限或想直接看版本说明时，
 * 设置页还留了一个手动入口，直接跳到发版页自己下 ZIP。
 */
const REPO_URL = 'https://github.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher';
const REPO_RELEASES_URL = `${REPO_URL}/releases`;
/**
 * 国内镜像更新源（Gitee 上只放一个 latest.json，几 KB）。
 * 老版本客户端不认清单里的 mirrors 字段、只认 url，裸连 GitHub 下不动包；
 * 这份清单里的下载地址已经换成镜像前缀，填进「更新源」就能发现 + 下载一次搞定。
 */
const GITEE_MANIFEST_URL = 'https://gitee.com/SparkleHxl/hxl-update/raw/master/latest.json';
/**
 * 设置页「项目主页 / 问题反馈」这两个入口的地址。
 *
 * 反馈走仓库自带的 issue 表单（`.github/ISSUE_TEMPLATE/bug_report.yml`），
 * 提前把模板选好，省得用户进去还得自己挑用哪个模板、再手写一遍版本号。
 * 版本号用 URL 编码塞进 query，模板里对应的 input 会把预填值直接显示出来。
 */
const REPO_NEW_ISSUE_URL = `${REPO_URL}/issues/new?template=bug_report.yml`;
const REPO_FEEDBACK_URL = () => {
  const version = (state.app && state.app.version) || '';
  return version ? `${REPO_NEW_ISSUE_URL}&version=${encodeURIComponent(version)}` : REPO_NEW_ISSUE_URL;
};

function normalizeUiScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 100;
  return Math.round(Math.max(80, Math.min(130, number)));
}

/** 当前缩放比例；优先用设置里的值，渲染层本地记忆作为兜底。 */
function currentUiScale() {
  const fromSettings = Number(state.settings?.uiScale);
  if (Number.isFinite(fromSettings)) return normalizeUiScale(fromSettings);
  try {
    const saved = Number(localStorage.getItem('vela:ui-scale'));
    if (Number.isFinite(saved)) return normalizeUiScale(saved);
  } catch {
    /* 可选本地记忆 */
  }
  return 100;
}

/** 把缩放比例写进 CSS 变量，让纯 CSS 的地方也能跟着变。 */
function applyUiScaleClass(scale) {
  const value = normalizeUiScale(scale);
  document.documentElement.style.setProperty('--ui-scale', String(value / 100));
  document.documentElement.dataset.uiScale = String(value);
}

const state = {
  games: [],
  settings: {},
  stats: { launches: 0, playSeconds: 0 },
  downloads: [],
  app: {},
  news: [],
  // 动态页分类筛选：all / release / guide
  newsFilter: 'all',
  // 动态页「更新日志」是否展开全部版本（默认只显示最新几个，旧版本折叠）
  newsReleasesExpanded: false,
  // 游戏能力注册表（主进程 game-features.js 提供），tools 页据此渲染
  features: null,
  // 侧栏「工具」分组的展开状态
  navToolsOpen: false,
  // 启动页左上「导航」浮层的开合状态（不落盘；开合只切 class 不重绘，视频不中断）
  startNavOpen: false,
  // 这次展开是不是把窗口往左外扩了（收起时要按外扩量缩回去）
  startNavExpanded: false,
  hoyolab: null,
  // 鹰角 / 完美世界 / 库街区等通行证的登录态，key 是 provider id
  passport: null,
  // 截图管理：按游戏分组，组内按时间倒序
  shots: null,
  shotsLoading: false,
  shotsError: '',
  shotsGame: '',
  // 画质配置：读的是注册表，每一项都能改（改动前自动备份旧值）
  graphics: null,
  graphicsLoading: false,
  graphicsError: '',
  graphicsGame: 'starrail',
  // 'trait'＝能力表里写死了注册表项；'auto'＝主进程探测出来的（终末地 / 明日方舟这类）
  graphicsSource: '',
  // 自动探测命中的注册表项，仅供排查显示，不做任何写入依据
  graphicsDetectKey: '',
  // 画质读取结果缓存：{ [gameKey]: { at, result, dirty } }，见 loadGraphics()
  graphicsCache: {},
  // 正在写入的那一项，画质页用它显示「写入中」，形如 { name, value }
  graphicsPending: null,
  // 安装与更新的展示改由启动页承担（版本、更新入口都在启动页上），
  // 这里不再单开一个页面，state 里也不再保留 install / installLoading 等字段。
  noticeBoard: {},
  noticeBoardLoading: false,
  noticeBoardUpdatedAt: 0,
  noticeBoardError: '',
  // 更新弹窗的配图：米游社画师同人图，key 是游戏的 builtinKey。
  // 主进程抓不到就是空表，versionHero() 会退回官网美术图，弹窗不会开天窗。
  postArt: {},
  route: 'home',
  filter: 'all',
  search: '',
  sort: 'recent',
  gacha: null,
  gachaLoading: false,
  gachaError: '',
  gachaGameKey: '',
  gachaUid: '',
  nteAccount: null,
  update: {
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
  },
  nteCapture: { running: false, phase: '', message: '' },
  // 启动页「更新游戏」按钮的进行中状态：{ gameId, jobId, label }
  gameUpdate: null,
  nteAutoPage: localStorage.getItem('vela:nte-auto-page') !== '0',
  songs: [],
  songIndex: 0,
  startGameId: '',
  startServerMenu: false,
  starrailFps: 60,
  notices: [],
  noticesGameId: '',
  noticesLoading: false,
  // 弹幕点歌的输入框记忆上次连接的直播间链接（localStorage），重启后不用重新复制
  live: { roomUrl: localStorage.getItem('vela:live-room-url') || '', connecting: false },
  // 最近连接过的直播间（最多 5 个）：重启后一键重连，不用再翻聊天记录找链接
  liveHistory: (() => {
    try {
      const list = JSON.parse(localStorage.getItem('vela:live-room-history') || '[]');
      return Array.isArray(list) ? list.filter((item) => typeof item === 'string').slice(0, 5) : [];
    } catch {
      return [];
    }
  })(),
  /* 已连接的直播间列表（支持同时连多个平台）：每项
   * { id, url, connected, connecting, roomTitle, roomId, platform, platformLabel, danmaku, status, captured } */
  liveRooms: [],
  charts: { platform: 'all', loading: false, list: [], detail: null, error: '' },
  musicLogin: { qq: null, kugou: null, kuwo: null, loading: false },
  neteaseLogin: { loggedIn: false, apiBase: '' },
  songTab: localStorage.getItem('vela:song-tab') || 'queue',
  // 点歌台搜索：无状态输入放在 input 里，结果只在内存
  songSearch: { keyword: '', platform: 'all', loading: false, list: [], errors: [], done: false },
  /*
   * 队列页的折叠与过滤（会话内状态，不落盘）：
   *   queueExpanded[段序号] = true/false，用户点过「展开/收起」的段按记忆来，
   *   没点过的段里含当前播放的默认展开、其余默认折叠（见 song-ui.js）。
   *   queueFilter 是队列顶部的轻量过滤词，输入即过滤标题/歌手。
   * 队列变化（增删歌）后段序号可能漂移，折叠状态允许漂，不影响正确性。
   */
  queueExpanded: {},
  queueFilter: '',
  // syncedAt / syncDurationMs 来自主进程 music:all-playlists 的返回值，用来显示「上次同步」
  myPlaylists: {
    platform: '',
    loading: false,
    list: [],
    error: '',
    detail: null,
    groups: [],
    loadingAll: false,
    /*
     * 每个平台各自的同步开关：loadingAll 是「同步全部」，这里是单平台。
     * 分开存是因为界面上「同步中…」只该出现在被点的那一个平台行里，
     * 用一个全局布尔会把四行一起点亮。
     */
    syncing: { netease: false, qq: false, kugou: false, kuwo: false },
    syncedAt: 0,
    syncDurationMs: 0,
    plaza: {},
    plazaPlatform: 'netease',
    /*
     * 后台静默刷新中：和 loadingAll 分开。
     * loadingAll 会让界面整片转圈、按钮变「同步中…」，而冷启动时按缓存画完卡片墙之后
     * 偷偷补一次最新数据，不该让用户看着转圈 —— 所以单独一个标记。
     */
    bgRefreshing: false,
    /*
     * 歌单详情的会话内缓存：key=`${platform}:${id}`，值={ detail, at }。
     * 之前每点一次歌单卡片都重新拉一遍全量曲目（网易大歌单公开直连失败时
     * 要退本地 API 全量解析，动辄几十秒），来回切换就是来回重拉。
     * 只存内存、不落盘：刷新应用即清，TTL 过期后先显示旧的再后台补新。
     */
    detailCache: {},
    // 各歌单正在后台静默刷新的标记，防止同一张歌单并发刷两次
    detailRefreshing: {},
  },
  // 默认 Hi-Res；用户手动改过后会记住那个选择
  songQuality: (() => {
    const saved = localStorage.getItem('vela:song-quality');
    return ['standard', 'higher', 'exhigh', 'lossless', 'hires'].includes(saved) ? saved : 'hires';
  })(),
  playMode: (() => {
    const saved = localStorage.getItem('vela:play-mode') || 'list';
    return ['order', 'list', 'single', 'shuffle'].includes(saved) ? saved : 'list';
  })(),
  sound: (() => {
    const defaults = { enabled: true, volume: 35, click: true, notify: true, launch: true };
    try {
      const saved = JSON.parse(localStorage.getItem('vela:sound-settings') || 'null');
      if (saved && typeof saved === 'object') Object.assign(defaults, saved);
    } catch {
      /* optional local preference */
    }
    const volume = Number(defaults.volume);
    defaults.volume = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 35;
    return defaults;
  })(),
  songVolume: (() => {
    const value = Number(localStorage.getItem('vela:song-volume') ?? 80);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 80;
  })(),
  songMuted: localStorage.getItem('vela:song-muted') === '1',
  // 打开启动器是否自动继续上次听的歌；默认关闭，需要手动点播放
  autoResumeSong: localStorage.getItem('vela:auto-resume-song') === '1',
  audioFx: (() => {
    const defaults = { enabled: false, preset: 'off', intensity: 55 };
    try {
      const saved = JSON.parse(localStorage.getItem(AUDIO_FX_STORAGE) || 'null');
      if (saved && typeof saved === 'object') Object.assign(defaults, saved);
    } catch {
      /* optional local preference */
    }
    const intensity = Number(defaults.intensity);
    defaults.intensity = Number.isFinite(intensity)
      ? Math.max(0, Math.min(100, intensity))
      : 55;
    if (!AUDIO_FX_KEYS.includes(defaults.preset)) defaults.preset = 'off';
    defaults.enabled = defaults.preset !== 'off';
    return defaults;
  })(),
  /*
   * 战绩页状态。
   *
   * cache 的键是 `${game}/${feature}`，值是 { loading, error, view, url, at }。
   * 之所以按组合缓存而不是只存一份：用户会在「原神便笺 → 深渊 → 星铁便笺」
   * 之间来回点，每次都重新请求既慢又容易触发风控。
   */
  /* 工具页左侧分组导航当前停在哪个分类（默认停在「按游戏查看」） */
  toolsTab: 'games',
  /* 工具页右侧能力面板当前显示哪个游戏（key），空则用列表第一个 */
  toolsGame: '',
  /*
   * 二级页「返回工具页」条的来路标记。
   * 从工具页点功能入口进 record / gacha 等页时置真，目标页据此渲染返回条；
   * 任何不带 fromTools 的路由切换都会清掉它，从侧栏直接进这些页面不会多出按钮。
   */
  fromTools: false,
  /* 工具页「按游戏查看」里展开的是哪张游戏卡（'' 表示全部收起） */
  toolsGame: '',
  record: {
    feature: 'daily-note',
    game: 'genshin',
    // 上期/当期开关：1 当期，2 上期
    schedule: 1,
    /*
     * 当前看的是哪个通行证账号（米游社多账号）。
     * 空串表示「跟随工具页当前激活的账号」，登录/切换账号时会同步写进来。
     */
    account: '',
    // 每个游戏选中的角色 { genshin: { uid, region, nickname, level } }
    role: {},
    cache: {},
  },
  /*
   * 插件页。
   *
   * list 是 plugins.list() 的原始结果（null 表示还没读过）；views / errors / running
   * 由 window.HXLPlugin.Host 通过回调写回来，这里只存快照，好让重绘时能还原现场。
   * active 是右边面板正在看哪个插件；pending 是刚导入、还没确认权限的插件。
   */
  plugins: {
    list: null,
    loading: false,
    error: '',
    active: '',
    views: {},
    errors: {},
    running: {},
    pending: '',
  },
};
/*
 * 多直播间并存的运行时句柄：room.id → { socket, heartbeat, timer }。
 * B 站的 WebSocket / 其它平台的轮询定时器都挂在各自房间上，互不影响。
 */
const liveRuntimes = new Map();

/*
 * 弹幕 WebSocket 已迁到主进程：渲染层只负责发 connect/disconnect、收 live:danmu-event。
 * 这里统一订阅主进程转发过来的弹幕事件，按 bilibili 房间号路由到对应卡片，更新 UI。
 * 主进程持有长连接（Node 栈，实测 95 秒以上稳定），渲染层约 70 秒被本机网络层掐断的
 * 问题在这一层根治，无需渲染层再做任何 WebSocket 建连 / 重连。
 */
try {
  api.live.onDanmuEvent(handleBiliDanmuEvent);
} catch (error) {
  /* 旧版主进程没暴露该桥时静默降级，不影响其它功能 */
}

try {
  const savedSongs = JSON.parse(localStorage.getItem('vela:songs') || '[]');
  if (Array.isArray(savedSongs)) state.songs = savedSongs;
} catch {
  state.songs = [];
}

const PAGE_META = {
  home: { label: '主页', eyebrow: 'OVERVIEW' },
  // 侧栏导航叫「启动页」，标题栏 / 窗口标题跟着用它，别一处叫开始一处叫启动页
  start: { label: '启动页', eyebrow: 'START' },
  library: { label: '游戏库', eyebrow: 'LIBRARY' },
  gacha: { label: '抽卡', eyebrow: 'WISHES' },
  downloads: { label: '下载', eyebrow: 'DOWNLOADS' },
  song: { label: '音乐', eyebrow: 'MUSIC' },
  news: { label: '动态', eyebrow: 'JOURNAL' },
  tools: { label: '工具', eyebrow: 'TOOLBOX' },
  record: { label: '战绩', eyebrow: 'RECORD' },
  screenshots: { label: '截图管理', eyebrow: 'GALLERY' },
  graphics: { label: '画质配置', eyebrow: 'GRAPHICS' },
  plugins: { label: '插件', eyebrow: 'PLUGINS' },
  // 公告已并入动态页；保留键只为兼容旧数据的 lastPage
  announcements: { label: '动态', eyebrow: 'JOURNAL' },
  settings: { label: '设置', eyebrow: 'PREFERENCES' },
};

const dom = {
  view: document.querySelector('#view'),
  modalRoot: document.querySelector('#modal-root'),
  toastRoot: document.querySelector('#toast-root'),
  nav: document.querySelector('#nav'),
  tbSection: document.querySelector('#tb-section'),
  tbVersion: document.querySelector('#tb-version'),
  profileName: document.querySelector('#profile-name'),
  profileAvatar: document.querySelector('#profile-avatar'),
  badgeLibrary: document.querySelector('#badge-library'),
  badgeDownloads: document.querySelector('#badge-downloads'),
  navToolsGroup: document.querySelector('#nav-tools-group'),
  navToolsSub: document.querySelector('#nav-tools-sub'),
};

let editingId = null;
let editingCover = null;
let editingCoverUrl = null;
let modalOnClose = null;
let gachaRefreshTimer = null;
let noticeBoardTimer = null;
let sophonUi = null;
let sophonJobs = [];
let activeSophonJob = null;
let quickOpen = false;

/* helpers（esc / icon）已拆到 services/helpers.js（第 3 批），全局可见。 */

/* 界面音效状态与音效链已拆到 services/audio-fx.js（全局可见，用法不变）。
 * 只有 lyricFollowPaused 是歌词状态，留在本文件。 */
/*
 * 歌词是否暂停了「自动跟播」。必须放在模块级：
 * 歌词面板每次 render 都会重建，状态挂在 DOM 上会跟着丢，
 * 表现就是切个界面回来歌词又开始自动滚。
 */
let lyricFollowPaused = false;

/* 更新域（发现新版本弹窗 / 更新内容公告 / 版本配图 / 进度显示）已拆到
 * services/update.js（第 3 批）。splitNotes、notesMarkup、versionHero、
 * updateStatusText、formatUpdateSize、openUpdateModal、openReleaseNotesModal、
 * startReleaseNotesWatch 等均在其中，全局可见，调用方式不变。 */

/** 收起音效小窗口。 */
function closeFxPop() {
  const pop = document.querySelector('#fx-pop');
  if (pop) pop.remove();
  document.querySelectorAll('[data-action="open-audio-fx"]').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
  });
}

/**
 * 音效小窗口：贴着播放条右上角弹出的一小块，不再开成整屏弹窗。
 * 14 个预设按「基础 / 空间 / 频段 / 场景」分行排成胶囊，一屏放得下。
 * 按钮本身是开关：再点一次、点外面、点右上角 × 都收起。
 */
function openAudioFxModal() {
  if (document.querySelector('#fx-pop')) {
    closeFxPop();
    return;
  }
  const groups = [];
  AUDIO_FX_PRESETS.forEach((item) => {
    let group = groups.find((entry) => entry.name === item.group);
    if (!group) groups.push((group = { name: item.group, items: [] }));
    group.items.push(item);
  });
  const preset = state.audioFx.preset;
  const pop = document.createElement('div');
  pop.className = 'fx-pop';
  pop.id = 'fx-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '音效');
  pop.innerHTML = `
    <div class="fx-pop-head">
      <strong>音效</strong>
      <small>${esc(audioFxLabel())}</small>
      <button class="fx-pop-x" data-action="close-fx-pop" title="收起" aria-label="收起">${icon('x')}</button>
    </div>
    <div class="fx-pop-body">
      ${groups
        .map(
          (group) => `<div class="fx-pop-group">
            <span class="fx-pop-group-label">${esc(group.name)}</span>
            <div class="fx-pop-chips">
              ${group.items
                .map(
                  (item) =>
                    `<button class="fx-chip${preset === item.key ? ' active' : ''}" data-action="fx-preset" data-value="${item.key}" title="${esc(item.desc)}">${esc(item.label)}</button>`
                )
                .join('')}
            </div>
          </div>`
        )
        .join('')}
      <div class="fx-pop-intensity">
        <span>强度</span>
        <input id="fx-intensity" type="range" min="0" max="100" step="1" value="${state.audioFx.intensity}" aria-label="音效强度" />
        <small id="fx-intensity-value">${state.audioFx.intensity}%</small>
      </div>
      <p class="fx-pop-hint">直链不允许跨域时自动回原声，不打断听歌。</p>
    </div>`;
  document.body.appendChild(pop);
  document.querySelectorAll('[data-action="open-audio-fx"]').forEach((button) => {
    button.setAttribute('aria-expanded', 'true');
  });

  const intensity = pop.querySelector('#fx-intensity');
  if (intensity) {
    const label = pop.querySelector('#fx-intensity-value');
    intensity.addEventListener('input', () => {
      const value = setAudioFxIntensity(intensity.value);
      if (label) label.textContent = `${value}%`;
    });
  }
}

/* ---------- 界面音效：已拆到 services/ui-sound.js（第 2 批） ----------
 * uiSoundNoise / playUiSound / uiSoundBudget / uiSoundKindFor 及私有状态
 * （uiSoundContext、uiNoiseBuffer、uiSoundStamp、uiSoundAnyStamp）都在那里，
 * 全局可见，调用方式不变。
 */

function cssUrl(url) {
  return `url("${String(url).replace(/["\\\n\r]/g, (ch) => encodeURIComponent(ch))}")`;
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function fmtSpeed(bytes) {
  return `${fmtBytes(bytes)}/s`;
}

function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return '不到 1 分钟';
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours <= 0) return `${minutes} 分钟`;
  if (minutes <= 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分`;
}

function etaText(download) {
  if (!download.total || !download.speed || download.speed <= 0) return '';
  const left = Math.max(0, download.total - download.received);
  const seconds = Math.round(left / download.speed);
  if (seconds < 60) return `${Math.max(1, seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.ceil((seconds % 3600) / 60)} 分`;
}

function relativeDate(iso) {
  if (!iso) return '尚未启动';
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '尚未启动';
  const diff = Date.now() - value.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 48 * 60 * 60 * 1000) return '昨天';
  return `${value.getMonth() + 1} 月 ${value.getDate()} 日`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** 截图列表用的紧凑时间：今天只显示时分，其余显示月-日 时:分。 */
function formatShotTime(value) {
  const date = new Date(Number(value) || 0);
  if (Number.isNaN(date.getTime()) || !Number(value)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameDay ? `今天 ${time}` : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function formatPlaytime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return total > 0 ? `${total} 秒` : '0 分钟';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 100) return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function homeMood() {
  const hour = new Date().getHours();
  if (hour < 5) {
    return {
      greeting: '夜深了',
      sub: '后台的灯还亮着，最后一场戏，留给还不想睡的你。',
      kicker: '散场之后',
      title: '灯火还未谢幕',
      desc: '深夜的舞台安静下来，只剩未读完的剧目。想再演一场，或把故事留到晨光里，都由你。',
    };
  }
  if (hour < 11) {
    return {
      greeting: '早上好',
      sub: '晨光落进后台，今天的第一幕，想从哪个世界开始？',
      kicker: '晨间场',
      title: '新的一幕，正在开场',
      desc: '把昨夜的余韵收进后台，替今天挑一个合适的开场。',
    };
  }
  if (hour < 14) {
    return {
      greeting: '中午好',
      sub: '午间的幕间休息，刚好够一场短途冒险。',
      kicker: '午间幕间',
      title: '幕间小憩',
      desc: '灯光暂歇，茶还温着。挑一幕不用赶时间的剧情，当作今天的间奏。',
    };
  }
  if (hour < 18) {
    return {
      greeting: '下午好',
      sub: '日影偏西，后台的剧目单还停在昨天那一页。',
      kicker: '午后场',
      title: '把下午交给下一幕',
      desc: '阳光慢下来，正好续上未完的故事。',
    };
  }
  return {
    greeting: '晚上好',
    sub: '今晚的舞台，想从哪里开幕？帷幕拉开之前，先选好你的剧目。',
    kicker: '今夜舞台',
    title: '帷幕已经拉开',
    desc: '把喜欢的游戏放在同一个书架，把不同服务器收进同一座后台。今晚想从哪里开幕，由你决定。',
  };
}

function initial(name) {
  const text = String(name || '').trim();
  return text ? Array.from(text)[0] : '花';
}

function avatarContent(settings) {
  const name = settings.profileName || '大小姐';
  if (settings.avatar) {
    const url = toFileUrl(settings.avatar);
    if (url) return `<img src="${esc(url)}" alt="" />`;
  }
  return esc(initial(name));
}

function toFileUrl(relative) {
  if (!relative) return null;
  if (/^(data:|https?:|file:)/i.test(relative)) return relative;
  const base = String(state.app.userData || '').replace(/\\/g, '/');
  if (!base) return null;
  return `file:///${encodeURI(`${base}/${relative}`)}`;
}

function humanError(error) {
  return String(error && error.message ? error.message : error || '操作失败')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '');
}

function activeDownloads() {
  return state.downloads.filter((d) => d.status === 'downloading' || d.status === 'queued');
}

function sortedGames() {
  const games = [...state.games];
  const mode = state.sort;
  games.sort((a, b) => {
    if (mode === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN');
    if (mode === 'added') return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    const aTime = new Date(a.lastPlayed || a.createdAt || 0).getTime();
    const bTime = new Date(b.lastPlayed || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
  return games;
}

function filteredGames() {
  const query = state.search.trim().toLowerCase();
  return sortedGames().filter((game) => {
    if (state.filter === 'favorite' && !game.favorite) return false;
    if (state.filter === 'installed' && !game.installed) return false;
    if (state.filter === 'demo' && !game.demo) return false;
    if (!query) return true;
    const haystack = [game.name, game.subtitle, game.description, game.version, game.versionName, ...(game.tags || [])]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function featuredGame() {
  if (!state.games.length) return null;
  return [...state.games].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return new Date(b.lastPlayed || b.createdAt || 0) - new Date(a.lastPlayed || a.createdAt || 0);
  })[0];
}

/* chrome & routing（设置应用 / updateChrome / 启动页抽屉 / navigate /
 * 启动页动态背景 / render 主循环）已拆到 views/chrome.js（第 4 批）。 */
/* home + 启动页（首页卡片 / 启动页背景 / 启动页服务器面板 / 切服引导 /
 * 启动页视频状态 / homeView / startView）已拆到 views/home.js（第 5 批）。 */
/* library（游戏库骨架 / 卡片 / 筛选结果 / 快捷面板）已拆到
 * views/library.js（第 6 批）。 */
/* servers（服务器状态与卡片 / 切服 / 启动 / 预下载 / 终末地通道 / 修游戏）
 * 已拆到 views/servers.js（第 7 批）。 */
/* ------------------------------------------------------------------ */
/* gacha                                                               */
/* ------------------------------------------------------------------ */

/* gacha（固定游戏表 / 选择 / 稀有度与保底标签 / 卡片组件 / 整页 / 导入与同步弹窗 /
 * 刷新定时器）已拆到 views/gacha.js（第 8 批）。 */

/* ------------------------------------------------------------------ */
/* karaoke request queue                                               */
/* ------------------------------------------------------------------ */

/* karaoke request queue（点歌队列 / 播放模式 / 音质档位 / 播不动跳下一首 / 进度记忆 /
 * 迷你播放器 / 歌词区 / 直播间点歌）已拆到 views/song.js（第 9 批）。 */

/* 音乐 · 歌单广场 / 我的歌单同步与缓存 / 歌单播放 / 直播间点歌 / 音质档位
 * 已拆到 views/song-playlist.js（第 10 批）。 */

/* 音乐 · 导入/添加弹窗 / 音乐源与播放设置 / 直播间面板 / 点歌台与音乐页视图 /
 * 歌单卡片与榜单面板 已拆到 views/song-view.js（第 11 批）。 */

/* gacha（分类标签 / 头像 / 抽卡格 / 池卡片 / 概览）已拆到 views/gacha.js（第 8 批）。 */

/* downloads（下载任务队列）+ NTE 渠道资源补齐链路（预下载窗 / 抓包状态 / 同步面板）
 * + 终末地打包弹窗 已拆到 views/downloads.js（第 12 批）。 */

/* tools（能力注册表 / 米游社·HoYoLAB 登录 / 截图管理 / 插件 / 画质配置 / 工具页 /
 * 战绩页）+ news（动态页）+ official announcements（官方公告）
 * 已拆到 views/tools.js（第 13 批）。 */

/* settings（开关组件 / 设置回显 / 界面缩放 / 主题与强调色候选值 /
 * 设置页分组与整页渲染）已拆到 views/settings.js（第 14 批）。 */

/* view bindings（封面兜底 / 整页事件绑定）已拆到 views/bindings.js（第 15 批）。 */

/* actions（toggleFavorite / handleAction 全站 data-action 分发）
 * 已拆到 views/actions.js（第 15 批）。 */

/* modals（弹窗外壳 / 游戏与服务器弹窗 / 下载与 Sophon 差异更新窗 /
 * 任务坞 / 链接与动态详情）已拆到 views/modals.js（第 16 批）。 */

/* toasts & state subscription（提示条 / 下载行局部补丁 / 状态回推合并）
 * 已拆到 views/toasts.js（第 17 批）。 */

/* ------------------------------------------------------------------ */
/* global events & boot                                                */
/* ------------------------------------------------------------------ */

// 封面图挂掉时整块收掉，别留一个破图标（CSP 禁止内联 onerror，只能捕获阶段监听）。
document.addEventListener(
  'error',
  (event) => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    const figure = img.closest('.news-figure');
    if (figure) figure.remove();
  },
  true,
);

/* 点歌台音源文件导入：<input type="file"> 的 change 不走点击委托，
 * 而且整页重绘会把这个 input 换掉，所以挂在 document 上按 id 认。 */
document.addEventListener('change', async (event) => {
  const picker = event.target;
  if (!picker || picker.id !== 'music-source-file') return;
  const file = picker.files && picker.files[0];
  if (!file) return;
  const text = await musicSourceFileText(file).catch(() => '');
  picker.value = '';
  if (!text) {
    toast('这个文件读不出内容', 'error');
    return;
  }
  await importMusicSource({ text });
});

/* 点击涟漪：跟随指针的一层径向高光，圆角跟随宿主，不会溢到按钮外面。
 * 只在少数「扁平、纯色、有明确边界」的控件上用；卡片类自带 hover 抬升，不叠这一层。 */
const TAP_FLASH_HOSTS =
  '.btn, .btn-primary, .btn-ghost, .btn-quiet, .btn-danger, .mini-chip, .chip, .segmented button, .fx-chip, .tg-rail-item';

function spawnTapFlash(element, event) {
  if (!element || !element.matches(TAP_FLASH_HOSTS)) return;
  if (element.dataset.noRipple !== undefined) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = element.getBoundingClientRect();
  if (rect.width < 12 || rect.height < 12) return;
  const node = document.createElement('span');
  node.className = 'tap-flash';
  const x = event && typeof event.clientX === 'number' ? event.clientX - rect.left : rect.width / 2;
  const y = event && typeof event.clientY === 'number' ? event.clientY - rect.top : rect.height / 2;
  node.style.setProperty('--tap-x', `${Math.round(x)}px`);
  node.style.setProperty('--tap-y', `${Math.round(y)}px`);
  element.appendChild(node);
  window.setTimeout(() => node.remove(), 460);
}

/* 按下就出声、出光：等 click（松手）才反馈，手感会慢半拍。
 * 键盘激活没有 pointerdown，靠 click 里 detail===0 兜底。 */
document.addEventListener(
  'pointerdown',
  (event) => {
    if (event.button !== 0) return;
    const element = event.target.closest('button, [data-nav], [data-action]');
    if (!element || element.disabled) return;
    if (element.dataset.noSound !== undefined || element.dataset.sound === 'off') return;
    playUiSound(uiSoundKindFor(element));
    spawnTapFlash(element, event);
  },
  true,
);

document.addEventListener('click', async (event) => {
  const feedback = event.target.closest('button, [data-nav], [data-action]');
  if (
    feedback &&
    !feedback.disabled &&
    feedback.dataset.noSound === undefined &&
    feedback.dataset.sound !== 'off'
  ) {
    // 键盘（Enter / Space）激活的点击 detail 为 0，没有 pointerdown，这里补一次
    if (event.detail === 0) {
      playUiSound(uiSoundKindFor(feedback));
      spawnTapFlash(feedback, null);
    }
  }

  const close = event.target.closest('[data-close]');
  if (close) {
    closeModal();
    return;
  }

  /* 点在下拉外面就把它收起来 */
  if (!event.target.closest('.song-pop')) closeSongPops();

  /* 音效小窗口：点面板外或点开面板的按钮以外的地方就收起 */
  if (
    document.querySelector('#fx-pop') &&
    !event.target.closest('#fx-pop') &&
    !event.target.closest('[data-action="open-audio-fx"]')
  ) {
    closeFxPop();
  }

  /* 启动页背景面板：点在工具区之外就收起 */
  if (state.bgPanelOpen && !event.target.closest('.start-video-tools')) closeBgPanel();

  /* 启动页唤出的侧栏：点在侧栏和菜单按钮之外的任意位置就收回 */
  if (
    state.startNavOpen &&
    !event.target.closest('.sidebar') &&
    !event.target.closest('.chrome-menu')
  ) {
    setStartNavOpen(false).catch(() => {});
  }

  const nav = event.target.closest('[data-nav]');
  if (nav) {
    /*
     * 「工具」现在只是一条普通导航：侧栏不再挂子项，
     * 点了直接进工具页（工具页自己是左导航 + 右侧面板）。
     */
    if (nav.dataset.action === 'nav-tools-toggle') {
      state.navToolsOpen = false;
      syncNavToolsOpen();
      navigate('tools');
      return;
    }
    /*
     * 侧栏「工具」子项里，战绩类都指向同一个 record 页，
     * 靠 data-feature 区分具体看哪个功能 —— 只传 route 的话会永远停在便笺。
     */
    const navRoute = nav.dataset.nav;
    const navFeature = nav.dataset.feature || '';
    if (navRoute === 'record' && navFeature) {
      navigate('record', { feature: navFeature });
    } else {
      navigate(navRoute);
    }
    // 从工具子项跳走时把分组收起来，省得占着侧栏
    if (nav.classList.contains('nav-sub-item')) {
      state.navToolsOpen = false;
      syncNavToolsOpen();
    }
    return;
  }

  const actionElement = event.target.closest('[data-action]');
  if (!actionElement) return;
  event.preventDefault();
  const { action, id } = actionElement.dataset;
  if (!action || actionElement.disabled) return;
  /*
   * 下拉框不算「点一下就执行」的按钮。
   *
   * select 也带 data-action="graphics-set"，如果在这里同步执行，
   * 用户只是点开看看有哪些档位就会被写一次；选完选项再触发 change 又写一次，
   * 于是「点开切一次、选完再切一次」，弹出两条提示。
   * 下拉统一交给下面的 change 委托处理。
   */
  if (actionElement.tagName === 'SELECT') return;
  // 数字输入框同理：点进去只是想改数字，写入交给失焦 / 回车那条路径
  if (actionElement.tagName === 'INPUT') return;
  try {
    await handleAction(action, id, actionElement, event);
  } catch (error) {
    toast(humanError(error), 'error');
  }
});

/*
 * 画质页的下拉与数字框。
 *
 * 全部走一个委托监听：下拉在 change 时立刻写入，数字框按回车或失焦才写入，
 * 免得每敲一个字符就打一次注册表。
 */
document.addEventListener('change', (event) => {
  const target = event.target;
  if (!target || target.dataset?.action !== 'graphics-set') return;
  if (target.tagName !== 'SELECT') return;
  handleAction('graphics-set', undefined, target, event).catch((error) => {
    toast(humanError(error), 'error');
  });
});

document.addEventListener(
  'blur',
  (event) => {
    const target = event.target;
    if (!target || target.dataset?.action !== 'graphics-set') return;
    if (target.tagName !== 'INPUT' || target.type !== 'number') return;
    if (target.dataset.manual !== '1') return;
    const changed = String(target.value) !== String(target.defaultValue);
    if (!changed) return;
    handleAction('graphics-set', undefined, target, event).catch((error) => {
      toast(humanError(error), 'error');
    });
  },
  true
);

document.addEventListener(
  'error',
  (event) => {
    const video = event.target.closest?.('video[data-start-video]');
    if (video) video.remove();
  },
  true
);

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target && target.dataset?.action === 'graphics-set' && target.tagName === 'INPUT' && event.key === 'Enter') {
    event.preventDefault();
    handleAction('graphics-set', undefined, target, event).catch((error) => {
      toast(humanError(error), 'error');
    });
    return;
  }
  if (event.key === 'Escape' && dom.modalRoot.childElementCount) {
    closeModal();
  }
  /* Esc：启动页上先收服务器弹层，再收侧栏；侧栏没收起时就回主界面（原返回键的承诺） */
  if (event.key === 'Escape' && !dom.modalRoot.childElementCount && !event.target.closest?.('input, textarea, select')) {
    if (state.route === 'start' && state.startServerMenu) {
      closeStartServerMenu();
    } else if (state.route === 'start' && state.startNavOpen) {
      setStartNavOpen(false).catch(() => {});
    } else if (state.route === 'start') {
      navigate('home');
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !dom.modalRoot.childElementCount) {
    event.preventDefault();
    openGameModal();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    if (state.route === 'library') {
      event.preventDefault();
      const search = document.querySelector('#game-search');
      if (search) search.focus();
    }
  }
  // Ctrl + 加号 / 减号 / 0：像浏览器一样快速缩放界面
  if (event.ctrlKey || event.metaKey) {
    const key = event.key;
    if (key === '+' || key === '=') {
      event.preventDefault();
      stepUiScale(1);
    } else if (key === '-' || key === '_') {
      event.preventDefault();
      stepUiScale(-1);
    } else if (key === '0') {
      event.preventDefault();
      setUiScale(100);
    }
  }
});

/* 侧栏底部「头像 + 名字」还是回设置页；左上角品牌图标才进启动页（走 data-nav）。 */
document.querySelector('#profile-btn').addEventListener('click', () => navigate('settings'));

/* 左上角品牌那块是 <div>，键盘也要能触发，补一下回车 / 空格 */
document.querySelector('.brand[data-nav]')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  navigate(event.currentTarget.dataset.nav);
});

/*
 * 品牌图标两种行为共存：
 *   按住拖动 → 移动窗口（它已经从 app-region: drag 改成 no-drag）
 *   单击     → 进启动页
 * 位移超过 5px 就算拖动，并吃掉紧随其后的那次 click，拖完不会顺带跳页。
 */
function setupBrandDrag() {
  const brand = document.querySelector('.brand[data-nav]');
  if (!brand) return;
  let drag = null;
  brand.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = {
      x: event.screenX,
      y: event.screenY,
      lx: event.screenX,
      ly: event.screenY,
      moved: false,
    };
    try {
      brand.setPointerCapture(event.pointerId);
    } catch {
      /* 指针捕获失败不影响拖动 */
    }
  });
  brand.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const totalX = event.screenX - drag.x;
    const totalY = event.screenY - drag.y;
    if (!drag.moved && Math.abs(totalX) < 5 && Math.abs(totalY) < 5) return;
    drag.moved = true;
    const dx = event.screenX - drag.lx;
    const dy = event.screenY - drag.ly;
    drag.lx = event.screenX;
    drag.ly = event.screenY;
    if (dx || dy) api.moveWindowBy(dx, dy);
  });
  const finish = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) {
      brand.dataset.justDragged = '1';
      setTimeout(() => {
        delete brand.dataset.justDragged;
      }, 80);
    }
  };
  brand.addEventListener('pointerup', finish);
  brand.addEventListener('pointercancel', finish);
  brand.addEventListener(
    'click',
    (event) => {
      if (!brand.dataset.justDragged) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}

setupBrandDrag();

const media = window.matchMedia('(prefers-color-scheme: light)');
media.addEventListener('change', () => {
  if ((state.settings.theme || 'dark') === 'system') applySettings();
});

async function boot() {
  try {
    const [snapshot, news] = await Promise.all([api.getState(), api.news.list()]);
    state.games = snapshot.games || [];
    state.settings = snapshot.settings || {};
    state.stats = snapshot.stats || state.stats;
    state.downloads = snapshot.downloads || [];
    state.app = snapshot.app || {};
    state.news = Array.isArray(news) ? news : [];
    state.startGameId = localStorage.getItem('vela:start-game') || '';
    state.route = state.games.length
      ? 'start'
      : PAGE_META[state.settings.lastPage]
        ? state.settings.lastPage === 'library'
          ? 'home'
          : state.settings.lastPage
        : 'home';
    state.settings.lastPage = state.route;
    applySettings();
    applyUiScaleClass(currentUiScale());
    initSidebarScroll();
    applySongVolume();
    applyAudioFx();
    updateChrome();
    resumeLastSong();
    render({ preserveScroll: false });
    if (state.route === 'gacha') loadGacha();
    if (state.route === 'start') {
      const startGame =
        state.games.find((game) => game.id === state.startGameId) ||
        [...state.games].sort(
          (a, b) => new Date(b.lastPlayed || b.createdAt || 0) - new Date(a.lastPlayed || a.createdAt || 0)
        )[0];
      if (startGame) loadGameNotices(startGame.id);
    }
    api.starrail
      .getFps()
      .then((result) => {
        state.starrailFps = result.fps || 60;
        if (state.route === 'settings') render({ preserveScroll: true });
      })
      .catch(() => {});

    api.onState(onState);
    /*
     * 更新弹窗的配图（米游社画师同人图）。主进程先读本地缓存，
     * 超过一周才真去抓；抓不到就保持空表，versionHero() 会用官网图。
     * 慢一点也无所谓，所以不 await。
     */
    loadPostArt().catch(() => {});
    /*
     * 侧栏「工具」分组的内容来自 game-features，启动时就预取一份，
     * 用户第一次点开工具组不至于看到「读取中…」。
     * 失败了也无所谓，renderNavToolsSub 会显示错误提示，工具页自己还会重试。
     */
    loadFeatures().catch(() => {});
    /*
     * 开机就把画质配置读进渲染层缓存。
     *
     * 用户的原话是「打开软件的时间直接去读取」：主进程会在窗口建好后自己
     * 串行预读一遍（primeGraphicsCache），这里再按启动页顺序把结果灌进
     * state.graphicsCache，用户点进画质页时首帧直接就是数据，连 loading 都没有。
     * 失败无所谓：点进画质页会走正常的读取路径。
     */
    primeGraphicsFrontend().catch(() => {});
    api.onToast((payload) => {
      if (payload && payload.message) toast(payload.message, payload.type || 'info');
    });
    /*
     * 提权重启之后接着开游戏：主进程在页面加载完后用 game:autolaunch 通知，
     * 这里走同一条 launch-game 动作，提示与错误处理都复用，不另开一份逻辑。
     */
    if (typeof api.onGameAutolaunch === 'function') {
      api.onGameAutolaunch((payload) => {
        const gameId = payload && payload.gameId;
        if (!gameId) return;
        handleAction('launch-game', gameId).catch((error) => toast(humanError(error), 'error'));
      });
    }
    /*
     * 「更新游戏」按钮的进度直显：dock 上那颗按钮的文案跟着进度走，
     * 不整页重绘（重绘会把 <video> 背景重启，闪一下静态图）。
     * 只在 gameUpdate 挂着且 jobId 对得上时才改，预下载面板自己的订阅不受影响。
     */
    if (typeof api.onPredownloadProgress === 'function') {
      api.onPredownloadProgress((event) => {
        const current = state.gameUpdate;
        if (!current || !event || event.jobId !== current.jobId) return;
        let label = String(event.current || '');
        if (event.phase === 'download' && Number(event.total) > 0) {
          label = `更新中 ${event.processed || 0}/${event.total}`;
        } else if (event.phase === 'apply' || event.phase === 'link') {
          label = '正在应用更新…';
        } else if (event.phase === 'done') {
          label = '更新完成';
        }
        if (label) {
          current.label = label;
          const el = document.querySelector('.start-dock-update-label');
          if (el) el.textContent = label;
        }
      });
    }
    api.onUpdateAvailable((info) => {
      if (!info || !info.hasUpdate) return;
      if (state.update && state.update.downloading) return;
      openUpdateModal(info);
    });
    /*
     * 窗口全屏状态。
     *
     * Electron 的原生全屏（F11 / 窗口按钮）不会让 CSS 的 :fullscreen 伪类生效，
     * 那是 HTML5 Fullscreen API 专用的，所以只能由主进程把状态推过来，
     * 这里落成 body.is-fullscreen 供样式判断（启动页侧栏的展开方向靠它区分）。
     */
    if (typeof api.onFullscreenChange === 'function') {
      api.onFullscreenChange((value) => {
        document.body.classList.toggle('is-fullscreen', !!value);
      });
    }

    /*
     * 窗口最小化 / 页面不可见 → body.is-idle：停循环视频和装饰动画省 GPU
     * （CSS 见 styles.css 末尾的「空闲降跑」段）。主进程推 minimize 状态；
     * visibilitychange 是第二道闸，被别的窗口完全遮住时也停。音频不受影响。
     */
    if (typeof api.onMinimizeChange === 'function') {
      api.onMinimizeChange((value) => setIdleMode(!!value));
    }
    document.addEventListener('visibilitychange', () => {
      setIdleMode(document.hidden);
    });

    /*
     * 第一次点右上角 ✕：主进程拦下 close、把选择权交回来（收托盘 / 退出）。
     * 选完主进程记住并执行，之后不再问；要改去 设置 → 行为。
     *
     * 先关掉手头那个弹窗再开询问框：openModal 是直接换掉 #modal-root 的
     * innerHTML，如果正开着下载任务弹窗，硬盖会让任务条再也回不来
     * （closeModal 里的 taskModalGuard 才是把它收进任务坞的正路）。
     */
    if (typeof api.onCloseAsk === 'function') {
      api.onCloseAsk(() => {
        if (document.body.classList.contains('modal-open')) closeModal();
        openCloseChoiceDialog();
      });
    }

    /*
     * 界面重载（Ctrl+R）时窗口可能还带着上次的外扩宽度：主进程没重启，
     * 那个宽度还在，但页面这一侧已经没有补偿了，画面会整体偏左 220px。
     * 开机先把外扩收回来，收不到也没关系（本来就没扩时它返回 0）。
     */
    if (typeof api.startNavCollapse === 'function') {
      Promise.resolve(api.startNavCollapse()).catch(() => {});
      document.body.classList.remove('start-nav-outward');
    }

    /*
     * 更新公告弹窗：等主进程开机后那次自动检查（15 秒）把清单读完。
     *
     * 主进程那边发现 hasUpdate 才会 push update:available，装完新版本时
     * 「远端 == 本地」，它不会推，所以这里只能轮询 state.update，几秒一次，
     * 最多看两分钟，读到清单里就是这个版本就弹。
     *
     * 顺序很重要：先弹「有新版本可装」，装完才轮到「这次更新改了什么」。
     * 自动检查被用户关掉时不打扰（自动更新都关了，弹窗也一并停下）。
     */
    startReleaseNotesWatch();

    api.onUpdateProgress((progress) => {
      if (!progress) return;
      state.update = {
        ...state.update,
        downloading: true,
        percent: Number(progress.percent) || 0,
        received: Number(progress.received) || 0,
        total: Number(progress.total) || Number(state.update?.total) || 0,
      };
      setUpdateProgress(state.update.percent, progress.label);
      if (state.route === 'settings') {
        const bar = document.querySelector('.update-progress-bar span');
        if (bar) {
          bar.style.width = state.update.percent + '%';
          const label = document.querySelector('.update-progress small');
          if (label) label.textContent = updateProgressText(state.update.percent, progress.label);
        }
      }
    });
    api.onGachaUpdated(() => {
      state.gacha = null;
      if (state.route === 'gacha') loadGacha(true);
    });
    api.onGameExited(() => {
      toast('游戏已退出，本次游玩时长已记录', 'info');
    });

    api.onNteCapture((event) => {
      if (!event) return;
      const current = state.nteCapture || {};
      if (event.phase === 'done') {
        state.nteCapture = {
          running: false,
          phase: 'done',
          message: event.imported > 0
            ? `抓取完成，导入 ${event.imported} 条记录`
            : '抓取完成，没有新的抽卡记录',
        };
      } else if (event.phase === 'error') {
        state.nteCapture = { running: false, phase: 'error', message: event.message || '抓取失败' };
      } else if (event.phase === 'stopped') {
        state.nteCapture = { running: false, phase: 'stopped', message: event.message || '抓取已结束' };
      } else if (event.phase === 'capturing') {
        state.nteCapture = {
          running: true,
          phase: 'capturing',
          message: current.message || '抓取中，请在游戏里打开抽卡记录',
        };
      } else {
        state.nteCapture = {
          running: true,
          phase: event.phase || 'progress',
          message: event.message || current.message || '抓取中…',
        };
      }
      renderNteCapture();
    });

    window.__navigate = (route) => navigate(route, { silent: true });
    window.__state = () => state;
    window.__render = () => render({ preserveScroll: true });
    window.__startGame = (id) => {
      state.startGameId = id;
      navigate('start', { silent: true });
    };
  } catch (error) {
    dom.view.innerHTML = `<div class="page"><div class="empty"><div class="empty-icon">${icon('alert')}</div><h3>启动器没有正常加载</h3><p>${esc(humanError(error))}</p></div></div>`;
  }
}

boot();


