'use strict';

const api = window.launcher;

const AUDIO_FX_PRESETS = [
  { key: 'off', label: '原声', desc: '不做任何处理，保持原始音色。', group: '基础' },
  { key: 'wide', label: '宽阔声场', desc: '拉开左右声道，声场更开阔。', group: '空间' },
  { key: 'hall', label: '音乐厅', desc: '加入混响尾音，像在小演出厅。', group: '空间' },
  { key: 'headphone', label: '耳机 3D', desc: 'HRTF 环绕，戴耳机时定位更明显。', group: '空间' },
  { key: 'room', label: '小房间', desc: '短混响，像在卧室或书房里听。', group: '空间' },
  { key: 'cave', label: '洞穴', desc: '长尾混响 + 低频堆积，空旷回响。', group: '空间' },
  { key: 'stadium', label: '体育场', desc: '超长混响，像在大型场馆。', group: '空间' },
  { key: 'bass', label: '低音增强', desc: '加强低频，适合电子与摇滚。', group: '频段' },
  { key: 'vocal', label: '人声清晰', desc: '抬高中高频，咬字更清楚。', group: '频段' },
  { key: 'treble', label: '高音明亮', desc: '提亮高频，器乐与女声更透。', group: '频段' },
  { key: 'warm', label: '温暖模拟', desc: '柔化高频、略微加厚中低频。', group: '频段' },
  { key: 'lofi', label: '复古电话', desc: '砍掉高低频，像老收音机。', group: '频段' },
  { key: 'night', label: '深夜低扰', desc: '压缩动态并轻微降噪，适合戴耳机小声听。', group: '场景' },
  { key: 'live', label: '现场感', desc: '轻微混响 + 高频空气感，像 live 录音。', group: '场景' },
];
const AUDIO_FX_KEYS = AUDIO_FX_PRESETS.map((item) => item.key);
const AUDIO_FX_STORAGE = 'vela:audio-fx';

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

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

let uiSoundContext = null;
let uiNoiseBuffer = null;
/* 连点节流：同一种音色 45ms 内只响一次，任意两种音色间隔不足 26ms 时压掉后者，
 * 否则快速点列表会叠成一片电流声。 */
const uiSoundStamp = Object.create(null);
let uiSoundAnyStamp = 0;

function saveSoundSettings() {
  try {
    localStorage.setItem('vela:sound-settings', JSON.stringify(state.sound));
  } catch {
    /* optional local preference */
  }
}

function saveAudioFx() {
  try {
    localStorage.setItem(AUDIO_FX_STORAGE, JSON.stringify(state.audioFx));
  } catch {
    /* optional local preference */
  }
}

function audioFxLabel() {
  const preset = AUDIO_FX_PRESETS.find((item) => item.key === state.audioFx.preset);
  return state.audioFx.preset === 'off' ? '原声' : preset ? preset.label : '原声';
}

/* ---------- Web Audio 音效链 ---------- */

let audioFxGraph = null;
let audioFxOrbit = null;
let audioFxFallback = false;

/*
 * 歌词是否暂停了「自动跟播」。必须放在模块级：
 * 歌词面板每次 render 都会重建，状态挂在 DOM 上会跟着丢，
 * 表现就是切个界面回来歌词又开始自动滚。
 */
let lyricFollowPaused = false;

function applySongVolume() {
  const audio = document.querySelector('#song-audio');
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, state.songVolume / 100));
  audio.muted = Boolean(state.songMuted);
  syncVolumeUi();
}

function syncVolumeUi() {
  const muted = Boolean(state.songMuted);
  const value = String(Math.round(state.songVolume));

  const miniRange = document.querySelector('#mini-volume');
  if (miniRange && document.activeElement !== miniRange) miniRange.value = value;
  const miniValue = document.querySelector('#mini-volume-value');
  if (miniValue) miniValue.textContent = muted ? '静音' : value;

  const mainRange = document.querySelector('#song-volume-main');
  if (mainRange && document.activeElement !== mainRange) mainRange.value = value;
  const mainValue = document.querySelector('#song-volume-main-value');
  if (mainValue) mainValue.textContent = muted ? '静音' : `${value}%`;

  const settingsRange = document.querySelector('#song-volume');
  if (settingsRange && document.activeElement !== settingsRange) settingsRange.value = value;
  const settingsValue = document.querySelector('#song-volume-value');
  if (settingsValue) settingsValue.textContent = `${value}%`;

  const iconHref = muted || state.songVolume === 0 ? '#i-volume-x' : '#i-volume';
  document
    .querySelectorAll('#mini-volume-use, #song-mute-use, #dock-volume-use')
    .forEach((use) => {
      use.setAttribute('href', iconHref);
    });

  const fxLabel = audioFxLabel();
  document.querySelectorAll('.song-fx-btn').forEach((button) => {
    button.classList.toggle('active', state.audioFx.preset !== 'off');
    const span = button.querySelector('span');
    if (span) span.textContent = fxLabel;
  });
  document.querySelectorAll('[data-action="open-audio-fx"].mini-btn').forEach((button) => {
    button.classList.toggle('active', state.audioFx.preset !== 'off');
  });
  document.querySelectorAll('[data-action="mini-mute"], [data-action="song-mute"]').forEach((button) => {
    button.classList.toggle('is-muted', muted);
    button.title = muted ? '取消静音' : '静音';
  });
}

function setSongVolume(value) {
  const next = Math.max(0, Math.min(100, Number(value) || 0));
  state.songVolume = next;
  if (next > 0) state.songMuted = false;
  try {
    localStorage.setItem('vela:song-volume', String(next));
    localStorage.setItem('vela:song-muted', state.songMuted ? '1' : '0');
  } catch {
    /* optional local preference */
  }
  applySongVolume();
}

function toggleSongMute() {
  state.songMuted = !state.songMuted;
  try {
    localStorage.setItem('vela:song-muted', state.songMuted ? '1' : '0');
  } catch {
    /* optional local preference */
  }
  applySongVolume();
  return state.songMuted;
}

function makeReverbImpulse(context, seconds = 2.2, decay = 2.8) {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const impulse = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, decay);
    }
  }
  return impulse;
}

function ensureAudioFxGraph(audio) {
  if (audioFxGraph && audioFxGraph.audio === audio) return audioFxGraph;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    const context = new AudioCtor();
    const source = context.createMediaElementSource(audio);
    const input = context.createGain();
    const output = context.createGain();
    input.connect(output);
    output.connect(context.destination);
    source.connect(input);
    audioFxGraph = { audio, context, source, input, output, chain: [] };
    return audioFxGraph;
  } catch {
    return null;
  }
}

function clearAudioFxChain(graph) {
  if (audioFxOrbit) {
    clearInterval(audioFxOrbit);
    audioFxOrbit = null;
  }
  for (const node of graph.chain) {
    try {
      node.disconnect();
    } catch {
      /* already detached */
    }
  }
  graph.chain = [];
  try {
    graph.input.disconnect();
  } catch {
    /* ignore */
  }
}

function buildAudioFxChain(graph, preset, intensity) {
  const { context, input, output } = graph;
  clearAudioFxChain(graph);
  const amount = Math.max(0, Math.min(1, intensity / 100));
  if (preset === 'off' || amount <= 0) {
    input.connect(output);
    return;
  }

  if (preset === 'wide') {
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    const left = context.createGain();
    const right = context.createGain();
    const delay = context.createDelay(0.2);
    const bleed = context.createGain();
    left.gain.value = 1 + 0.3 * amount;
    right.gain.value = 1 + 0.3 * amount;
    delay.delayTime.value = 0.008 + 0.014 * amount;
    bleed.gain.value = 0.18 * amount;
    input.connect(splitter);
    splitter.connect(left, 0);
    left.connect(merger, 0, 0);
    splitter.connect(delay, 1);
    delay.connect(right);
    right.connect(merger, 0, 1);
    splitter.connect(bleed, 1);
    bleed.connect(merger, 0, 0);
    merger.connect(output);
    graph.chain.push(splitter, left, right, delay, bleed, merger);
    return;
  }

  if (preset === 'hall') {
    const dry = context.createGain();
    const wet = context.createGain();
    const convolver = context.createConvolver();
    dry.gain.value = 1 - 0.25 * amount;
    wet.gain.value = 0.35 + 0.65 * amount;
    convolver.buffer = makeReverbImpulse(context);
    input.connect(dry);
    dry.connect(output);
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(output);
    graph.chain.push(dry, wet, convolver);
    return;
  }

  if (preset === 'headphone') {
    const dry = context.createGain();
    const panner = context.createPanner();
    dry.gain.value = 1 - 0.18 * amount;
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 6;
    panner.rolloffFactor = 0.6;
    input.connect(dry);
    dry.connect(output);
    input.connect(panner);
    panner.connect(output);
    graph.chain.push(dry, panner);
    const radius = 0.55 + 0.9 * amount;
    let angle = 0;
    const orbit = () => {
      angle += 0.05;
      const x = Math.sin(angle) * radius;
      const z = Math.cos(angle) * radius - 0.6;
      try {
        panner.positionX.setTargetAtTime(x, context.currentTime, 0.12);
        panner.positionZ.setTargetAtTime(z, context.currentTime, 0.12);
      } catch {
        panner.setPosition(x, 0, z);
      }
    };
    orbit();
    audioFxOrbit = setInterval(orbit, 90);
    return;
  }

  if (preset === 'bass') {
    const shelf = context.createBiquadFilter();
    const compressor = context.createDynamicsCompressor();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 150;
    shelf.gain.value = 3 + 9 * amount;
    compressor.threshold.value = -12;
    compressor.ratio.value = 4;
    input.connect(shelf);
    shelf.connect(compressor);
    compressor.connect(output);
    graph.chain.push(shelf, compressor);
    return;
  }

  if (preset === 'room') {
    // 短混响：卧室 / 书房感
    const dry = context.createGain();
    const wet = context.createGain();
    const convolver = context.createConvolver();
    dry.gain.value = 1 - 0.15 * amount;
    wet.gain.value = 0.18 + 0.3 * amount;
    convolver.buffer = makeReverbImpulse(context, 0.6, 4.5);
    input.connect(dry);
    dry.connect(output);
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(output);
    graph.chain.push(dry, wet, convolver);
    return;
  }

  if (preset === 'cave') {
    // 长尾 + 低频堆积
    const dry = context.createGain();
    const wet = context.createGain();
    const convolver = context.createConvolver();
    const low = context.createBiquadFilter();
    dry.gain.value = 1 - 0.3 * amount;
    wet.gain.value = 0.4 + 0.55 * amount;
    low.type = 'lowshelf';
    low.frequency.value = 220;
    low.gain.value = 2 + 5 * amount;
    convolver.buffer = makeReverbImpulse(context, 4.5, 1.6);
    input.connect(dry);
    dry.connect(output);
    input.connect(convolver);
    convolver.connect(low);
    low.connect(wet);
    wet.connect(output);
    graph.chain.push(dry, wet, convolver, low);
    return;
  }

  if (preset === 'stadium') {
    // 超长混响，大场馆
    const dry = context.createGain();
    const wet = context.createGain();
    const convolver = context.createConvolver();
    const pre = context.createDelay(0.3);
    dry.gain.value = 1 - 0.35 * amount;
    wet.gain.value = 0.35 + 0.6 * amount;
    pre.delayTime.value = 0.03 + 0.05 * amount;
    convolver.buffer = makeReverbImpulse(context, 6, 1.1);
    input.connect(dry);
    dry.connect(output);
    input.connect(pre);
    pre.connect(convolver);
    convolver.connect(wet);
    wet.connect(output);
    graph.chain.push(dry, wet, convolver, pre);
    return;
  }

  if (preset === 'treble') {
    // 高音提亮
    const shelf = context.createBiquadFilter();
    const air = context.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 6000;
    shelf.gain.value = 2 + 8 * amount;
    air.type = 'highshelf';
    air.frequency.value = 12000;
    air.gain.value = 1 + 4 * amount;
    input.connect(shelf);
    shelf.connect(air);
    air.connect(output);
    graph.chain.push(shelf, air);
    return;
  }

  if (preset === 'warm') {
    // 温暖：削一点刺耳高频，加厚中低频
    const low = context.createBiquadFilter();
    const cut = context.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 180;
    low.gain.value = 1 + 4 * amount;
    cut.type = 'highshelf';
    cut.frequency.value = 7000;
    cut.gain.value = -(1 + 5 * amount);
    input.connect(low);
    low.connect(cut);
    cut.connect(output);
    graph.chain.push(low, cut);
    return;
  }

  if (preset === 'lofi') {
    // 复古电话：带通 + 轻微失真
    const hp = context.createBiquadFilter();
    const lp = context.createBiquadFilter();
    const shaper = context.createWaveShaper();
    hp.type = 'highpass';
    hp.frequency.value = 380;
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const curve = new Float32Array(1024);
    const drive = 1 + 6 * amount;
    for (let i = 0; i < curve.length; i += 1) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = ((1 + drive) * x) / (1 + drive * Math.abs(x));
    }
    shaper.curve = curve;
    input.connect(hp);
    hp.connect(lp);
    lp.connect(shaper);
    shaper.connect(output);
    graph.chain.push(hp, lp, shaper);
    return;
  }

  if (preset === 'night') {
    // 深夜：压缩动态 + 轻微降噪（高通去嗡声）
    const hp = context.createBiquadFilter();
    const compressor = context.createDynamicsCompressor();
    const gain = context.createGain();
    hp.type = 'highpass';
    hp.frequency.value = 60;
    compressor.threshold.value = -28 - 12 * amount;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.22;
    gain.gain.value = 1 + 0.35 * amount;
    input.connect(hp);
    hp.connect(compressor);
    compressor.connect(gain);
    gain.connect(output);
    graph.chain.push(hp, compressor, gain);
    return;
  }

  if (preset === 'live') {
    // 现场：短混响 + 空气感
    const dry = context.createGain();
    const wet = context.createGain();
    const air = context.createBiquadFilter();
    const convolver = context.createConvolver();
    dry.gain.value = 1 - 0.18 * amount;
    wet.gain.value = 0.2 + 0.35 * amount;
    air.type = 'highshelf';
    air.frequency.value = 8000;
    air.gain.value = 1 + 3 * amount;
    convolver.buffer = makeReverbImpulse(context, 1.6, 3);
    input.connect(dry);
    dry.connect(air);
    air.connect(output);
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(output);
    graph.chain.push(dry, wet, air, convolver);
    return;
  }

  if (preset === 'vocal') {
    const highpass = context.createBiquadFilter();
    const peak = context.createBiquadFilter();
    const air = context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 85;
    peak.type = 'peaking';
    peak.frequency.value = 2600;
    peak.Q.value = 1.1;
    peak.gain.value = 2 + 7 * amount;
    air.type = 'highshelf';
    air.frequency.value = 9000;
    air.gain.value = 1 + 4 * amount;
    input.connect(highpass);
    highpass.connect(peak);
    peak.connect(air);
    air.connect(output);
    graph.chain.push(highpass, peak, air);
    return;
  }

  input.connect(output);
}

let audioFxWatchdog = null;

function clearFxWatchdog() {
  if (audioFxWatchdog) {
    clearTimeout(audioFxWatchdog);
    audioFxWatchdog = null;
  }
}

/**
 * Web Audio 对跨域音源会「静音但不报错」，所以用播放进度做一个看门狗：
 * 打开音效后如果 1.8 秒内进度完全不动，就自动回退到原声。
 */
function armFxWatchdog(audio) {
  clearFxWatchdog();
  if (state.audioFx.preset === 'off') return;
  const startTime = audio.currentTime;
  audioFxWatchdog = setTimeout(() => {
    audioFxWatchdog = null;
    if (state.audioFx.preset === 'off') return;
    if (audio.paused) return;
    if (Math.abs(audio.currentTime - startTime) > 0.05) return;
    disableAudioFxOnError();
  }, 1800);
}

function applyAudioFx() {
  const audio = document.querySelector('#song-audio');
  if (!audio) return;
  const fx = state.audioFx;
  if (fx.preset === 'off' || !fx.enabled) {
    clearFxWatchdog();
    if (audioFxGraph) buildAudioFxChain(audioFxGraph, 'off', 0);
    document.body.dataset.audioFx = 'off';
    return;
  }
  if (audioFxFallback) {
    document.body.dataset.audioFx = 'off';
    return;
  }
  const graph = ensureAudioFxGraph(audio);
  if (!graph) return;
  if (graph.context.state === 'suspended') graph.context.resume().catch(() => {});
  buildAudioFxChain(graph, fx.preset, fx.intensity);
  document.body.dataset.audioFx = fx.preset;
  if (!audio.paused) armFxWatchdog(audio);
}

function reloadSongForFx() {
  const audio = document.querySelector('#song-audio');
  const song = currentSongEntry();
  if (!audio || !song?.url) return;
  const time = audio.currentTime || 0;
  const wasPlaying = Boolean(audio.src) && !audio.paused;
  audio.dataset.songKey = `${state.songIndex}:${song.url}`;
  audio.src = song.url;
  audio.load();
  audio.addEventListener(
    'loadedmetadata',
    () => {
      if (time > 0) audio.currentTime = time;
      if (wasPlaying) audio.play().catch(() => {});
    },
    { once: true }
  );
}

function setAudioFxPreset(preset) {
  const next = AUDIO_FX_KEYS.includes(preset) ? preset : 'off';
  state.audioFx.preset = next;
  state.audioFx.enabled = next !== 'off';
  if (next !== 'off') audioFxFallback = false;
  saveAudioFx();

  const audio = document.querySelector('#song-audio');
  const needsCors = next !== 'off' && !audioFxFallback;
  if (audio) {
    const hasCors = audio.getAttribute('crossorigin');
    if (needsCors && hasCors !== 'anonymous') {
      audio.setAttribute('crossorigin', 'anonymous');
      reloadSongForFx();
    } else if (!needsCors && hasCors !== null) {
      audio.removeAttribute('crossorigin');
      reloadSongForFx();
    }
  }
  applyAudioFx();
  updateSongChrome();
  return next;
}

function setAudioFxIntensity(value) {
  const next = Math.max(0, Math.min(100, Number(value) || 0));
  state.audioFx.intensity = next;
  saveAudioFx();
  applyAudioFx();
  return next;
}

function disableAudioFxOnError() {
  if (audioFxFallback) return;
  if (state.audioFx.preset === 'off') return;
  audioFxFallback = true;
  state.audioFx.preset = 'off';
  state.audioFx.enabled = false;
  saveAudioFx();
  const audio = document.querySelector('#song-audio');
  if (audio) audio.removeAttribute('crossorigin');
  if (audioFxGraph) buildAudioFxChain(audioFxGraph, 'off', 0);
  document.body.dataset.audioFx = 'off';
  reloadSongForFx();
  /*
   * 不弹提示：这是「这次播放的地址读不了跨域」，属于自动处理的内部决定，
   * 用户听到的就是原声，没有需要他做判断的事。留在控制台里方便排查。
   */
  console.info('[音效] 当前音源不支持跨域读取，已自动切回原声');
}

/**
 * 把清单里的 notes 拆成一行一条。
 *
 * latest.json 只支持「一行一条」：行首的 - / * / • 会剥掉，空行和空白直接丢。
 * 更新公告弹窗还要给行首加个小星标，所以单独抽出来，两边共用同一套拆分规则，
 * 免得设置页和弹窗对同一份 notes 理解出两种结果。
 */
function splitNotes(notes) {
  return String(notes || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*•]\s*/, ''))
    .filter(Boolean);
}

function notesMarkup(notes) {
  const clean = splitNotes(notes);
  if (!clean.length) return '<p>没有附带更新说明。</p>';
  if (clean.length === 1) return '<p>' + esc(clean[0]) + '</p>';
  return '<ul>' + clean.map((line) => '<li>' + esc(line) + '</li>').join('') + '</ul>';
}

function updateStatusText() {
  const info = state.update || {};
  const current = `当前 v${state.app.version || '1.0.0'}`;
  if (info.downloading) return `${current} · 正在下载更新（${Number(info.percent) || 0}%）`;
  if (info.error) return `${current} · ${info.error}`;
  if (info.hasUpdate) return `${current} · 发现新版本 v${info.latest}${info.mandatory ? '（建议尽快更新）' : ''}`;
  if (info.checkedAt) return `${current} · 已是最新${info.latest ? `（远端 v${info.latest}）` : ''}`;
  return `${current} · 还没检查过`;
}

function formatUpdateSize(bytes) {
  const size = Number(bytes) || 0;
  if (!size) return '';
  if (size > 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

/**
 * 更新弹窗 / 动态详情里的配图。
 *
 * 图片挂在 news.json 的 `image` 字段上（每个版本一张、取游戏库里的游戏），
 * `imageSource` 是找到这张图的页面，`imageCredit` 是显示用的来源名。
 * 来源链接一律做成按钮走 openExternal，不在页面里直接外跳。
 */
function newsFigure(post, extraClass) {
  if (!post || !post.image) return '';
  const credit = post.imageSource
    ? `<button class="figure-credit" data-action="open-external" data-url="${esc(post.imageSource)}" title="${esc(post.imageSource)}">图片来源：${esc(post.imageCredit || post.imageSource)}</button>`
    : '';
  return `
    <figure class="news-figure ${extraClass || ''}">
      <img src="${esc(post.image)}" alt="${esc(post.title || '')}" loading="lazy" referrerpolicy="no-referrer" />
      ${credit}
    </figure>`;
}

/**
 * 按版本号在本地动态里找那一条，用来取这一版的配图。
 * 找不到就返回 null，弹窗退化成纯文字。
 */
function releaseEntry(version) {
  const target = String(version || '')
    .replace(/^v/i, '')
    .trim();
  if (!target) return null;
  return (
    (state.news || []).find(
      (item) =>
        String(item.version || '')
          .replace(/^v/i, '')
          .trim() === target
    ) || null
  );
}

/** 版本号 → 一个稳定的整数，用来决定这一版挑哪款游戏当封面。 */
function versionHash(text) {
  const raw = String(text || '');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * 更新弹窗的置顶图。
 *
 * 取图顺序：
 *   1. news.json 里这一版自己的 `image`（带找图来源）；
 *   2. 下面这张选好的官方美术图（按版本号挑一款游戏，来源写官网）；
 *   3. 再没有就用游戏库里那款游戏已经下载好的封面。
 * 第 2、3 步都不需要联网准备，所以每次发版一定有图。
 */
const HERO_ART = {
  genshin: {
    image:
      'https://sdk-webstatic.mihoyo.com/upload/ann/2026/09/23/92220da84f2e0fbeb5b6ddfd09b22336_6625910379513968240_transformed.jpg',
    source: 'https://ys.mihoyo.com/main/news/detail/21888',
    credit: '原神官网',
  },
  starrail: {
    image:
      'https://sdk-webstatic.mihoyo.com/upload/ann/2026/09/15/0e28df09eb425be765a8f22f6b30c9c6_554111496134813712_transformed.png',
    source: 'https://sr.mihoyo.com/main/news',
    credit: '星穹铁道官网',
  },
  neverness: {
    image: 'https://yh.wanmei.com/images/cover260924/box3Slide1.jpg',
    source: 'https://yh.wanmei.com/',
    credit: '异环官网',
  },
  zzz: {
    image:
      'https://launcher-webstatic.mihoyo.com/launcher-public/2026/10/20/c20eaf6a8a32d6342da4d5334be51bfe_5591770470767677066.png',
    source: 'https://zzz.mihoyo.com/',
    credit: '绝区零官网',
  },
  endfield: {
    image: 'https://web.hycdn.cn/upload/image/20261016/79d9bdebd562b2b7421339c40d5c1199.jpg',
    source: 'https://endfield.hypergryph.com/',
    credit: '明日方舟：终末地官网',
  },
};

function versionHero(version) {
  const entry = releaseEntry(version);
  if (entry && entry.image) return entry;
  const games = (state.games || []).filter((game) => game.coverUrl || game.startCoverUrl);
  if (!games.length) return entry;
  const pick = games[versionHash(version) % games.length];
  /*
   * 米游社画师图优先：它是联网抓的，带作者和帖子地址，
   * 比官网美术图更适合放更新弹窗。抓不到就往下走官网那套。
   */
  const artist = (state.postArt || {})[pick.builtinKey];
  if (artist && artist.image) {
    return {
      ...(entry || {}),
      image: artist.image,
      imageSource: artist.source || '',
      imageCredit: artist.credit || '',
    };
  }
  const art = HERO_ART[pick.builtinKey];
  if (art) {
    return {
      ...(entry || {}),
      image: art.image,
      imageSource: art.source,
      imageCredit: art.credit,
    };
  }
  return {
    ...(entry || {}),
    image: pick.startCoverUrl || pick.coverUrl,
    imageSource: pick.officialSite || '',
    imageCredit: pick.officialSite ? `${pick.name} 官网` : '',
  };
}

/**
 * 取更新弹窗的配图。
 * 主进程那边：有缓存就直接给，超过一周才去米游社抓一次；
 * 没登录米游社或抓不到，返回的 items 是空的，界面自动用官网美术图。
 * 配图只是锦上添花，所以这里任何失败都咽下去。
 */
async function loadPostArt(force = false) {
  if (typeof api.postArt !== 'function') return;
  try {
    const result = await api.postArt(force);
    const items = (result && result.items) || {};
    if (!Object.keys(items).length) return;
    state.postArt = items;
    render({ preserveScroll: true });
  } catch {
    /* 忽略：没有配图也照样能更新 */
  }
}

function openUpdateModal(info) {
  const data = info || state.update || {};
  const size = formatUpdateSize(data.size);
  const entry = versionHero(data.latest);
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal narrow update-modal" role="dialog" aria-modal="true">
        ${newsFigure(entry, 'update-hero')}
        <div class="modal-head">
          <div>
            <h2>发现新版本 v${esc(data.latest || '')}</h2>
            <p>当前 v${esc(state.app.version || '')}${size ? ` · 更新包 ${esc(size)}` : ''}</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          ${data.notes ? `<div class="update-notes"><strong>这一版改了什么</strong>${notesMarkup(data.notes)}</div>` : '<p class="desc">没有附带更新说明。</p>'}
          <div class="update-progress" id="update-modal-progress" hidden><div class="update-progress-bar"><span style="width:0%"></span></div><small>准备下载…</small></div>
          <p class="desc" style="margin-top:14px">更新会关闭启动器、覆盖程序文件然后自动重新打开。游戏、账号、抽卡记录、歌单和设置都在数据目录里，不会被覆盖。</p>
          <p class="desc">不想走弹窗更新的话，也可以去 GitHub 自己下新版 ZIP，覆盖程序文件同样不会动数据。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_RELEASES_URL}" title="${REPO_RELEASES_URL}">${icon('external')}打开发布页</button>
          <span style="flex:1"></span>
          <button class="btn btn-ghost" data-close>稍后再说</button>
          <button class="btn btn-primary" data-action="apply-update">${icon('download')}立即更新</button>
        </div>
      </div>
    </div>`);
  setUpdateProgress(data.percent || 0);
}

/* ------------------------------------------------------------------ */
/* 更新公告弹窗                                                        */
/* ------------------------------------------------------------------ */

/*
 * 「这次更新改了什么」。
 *
 * 和上面那个「发现新版本」弹窗是两回事：那个是有新版本可装时的下载入口，
 * 这个是升级装好之后、告诉用户这一版干了什么。数据直接来自 latest.json 的
 * notes 字段（主进程 updater.readManifest 读出来塞进 state.update），
 * 所以只要发布时往清单里写 notes，这次更新就会有自己的公告。
 *
 * 「看过了」记在 settings.notesSeenVersion：settings 落在数据目录的
 * launcher-data.json 里，升级覆盖 resources/app 不会动它，所以同一个版本只会弹一次；
 * 版本号一变（清单里写了新版本），下次启动再弹。
 */
function pendingReleaseNotes(info) {
  const data = info || state.update || {};
  const version = String(data.latest || '').replace(/^v/i, '').trim();
  if (!version) return null;
  // 和本地版本一致才算「这一版已经装上了」，远端比本地新时走的是下载流程
  const current = String((state.app && state.app.version) || '').replace(/^v/i, '').trim();
  if (!current || version !== current) return null;
  const items = splitNotes(data.notes);
  if (!items.length) return null;
  const seen = String((state.settings && state.settings.notesSeenVersion) || '').replace(/^v/i, '').trim();
  if (seen === version) return null;
  return { version, items };
}

let releaseNotesOpen = false;

function openReleaseNotesModal(info) {
  const data = info || state.update || {};
  const release = pendingReleaseNotes(data);
  if (!release || releaseNotesOpen) return;
  releaseNotesOpen = true;
  const meta = [data.date ? esc(data.date) : '', data.title ? esc(data.title) : ''].filter(Boolean).join(' · ');
  const entry = versionHero(release.version);
  openModal(
    `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal release-notes update-modal" role="dialog" aria-modal="true" aria-labelledby="release-notes-title">
        ${newsFigure(entry, 'update-hero')}
        <div class="modal-head">
          <div>
            <h2 id="release-notes-title">更新内容 · v${esc(release.version)}</h2>
            <p>${meta || '启动器已经更新到这一版，下面是这次改了什么。'}</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <ul class="release-notes-list">
            ${release.items.map((item) => `<li><span>${esc(item)}</span></li>`).join('')}
          </ul>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_RELEASES_URL}" title="${REPO_RELEASES_URL}">${icon('external')}打开发布页</button>
          <label class="release-notes-ask"><input type="checkbox" id="release-notes-ask" checked /> 以后有更新也这样弹出来</label>
          <button class="btn btn-primary" data-close>知道了</button>
        </div>
      </div>
    </div>`,
    {
      onClose: () => {
        // 注意：onClose 是在 closeModal 把 dom.modalRoot 清空之后才调的，
        // 所以要在这之前把勾选框的状态读出来，不能等进 markReleaseNotesSeen 再查 DOM。
        const ask = document.querySelector('#release-notes-ask');
        const keepAsking = !ask || ask.checked;
        releaseNotesOpen = false;
        markReleaseNotesSeen(release.version, keepAsking);
      },
    }
  );
}

/**
 * 记下「这个版本的公告看过了」，顺手记住用户要不要以后继续弹。
 *
 * 走 applySettingLocally 而不是直接调 api.updateSettings：它只就地更新
 * state.settings 并重画 chrome，不会整页重绘，弹窗刚关掉时画面不会跳一下。
 */
function markReleaseNotesSeen(version, keepAsking) {
  applySettingLocally({
    notesSeenVersion: String(version || ''),
    autoCheckUpdate: keepAsking !== false,
  }).catch(() => {});
}

/**
 * 启动后守着「这次更新改了什么」的触发时机。
 *
 * 主进程开机 15 秒自动查一次清单，这里每 3 秒看一眼 state.update；
 * 读到、并且清单版本 == 本地版本、settings 里还没记过这个版本，就弹。
 * 两分钟没等到就收工，不常驻轮询。
 */
function startReleaseNotesWatch() {
  if (!(state.settings && state.settings.autoCheckUpdate !== false)) return;
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    if (!releaseNotesOpen) {
      // 弹「有新版本可装」的时候先让位，等它关掉再来
      if (dom.modalRoot && dom.modalRoot.childElementCount === 0) {
        const release = pendingReleaseNotes(state.update);
        if (release) {
          openReleaseNotesModal(state.update);
          return;
        }
      }
    }
    if (attempts >= 40) return;
    // 清单写的是更老的版本（比如发布了 1.6.3，本地已经是 2.0.0）时永远等不到，
    // 这里主动查一次，把 state.update 拉成「远端 = 本地」。
    if (attempts === 1 && !(state.update && state.update.latest)) {
      api.checkUpdate().then((result) => {
        if (result && typeof result === 'object') state.update = { ...state.update, ...result };
      }).catch(() => {});
    }
    window.setTimeout(tick, 3000);
  };
  window.setTimeout(tick, 3000);
}

/** 把字节数说成人看得懂的大小，进度条上要显示「下了多少 / 一共多少」。 */
function formatMB(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** 进度条下面那行字：优先用主进程给的阶段说明，否则拼出百分比 + 已下/总量。 */
function updateProgressText(percent, label) {
  if (label) return label;
  const update = state.update || {};
  const done = formatMB(update.received);
  const total = formatMB(update.total);
  if (Number(percent) >= 100) return '下载完成，正在校验并覆盖文件…';
  if (done && total) return `正在下载 ${percent}% · ${done} / ${total}`;
  if (done) return `正在下载 ${percent}% · 已下 ${done}`;
  return `正在下载 ${percent}%`;
}

function setUpdateProgress(percent, label) {
  const wrap = document.querySelector('#update-modal-progress');
  if (!wrap) return;
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  if (value > 0) wrap.hidden = false;
  const bar = wrap.querySelector('.update-progress-bar span');
  const text = wrap.querySelector('small');
  if (bar) bar.style.width = `${value}%`;
  if (text) text.textContent = updateProgressText(value, label);
}

function openAudioFxModal() {
  const cards = AUDIO_FX_PRESETS.map(
    (item) => `
      <button class="fx-card ${state.audioFx.preset === item.key ? 'active' : ''}" data-action="fx-preset" data-value="${item.key}">
        <strong>${esc(item.label)}</strong>
        <small>${esc(item.desc)}</small>
      </button>`
  ).join('');

  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>音效</h2><p>给音乐页加上空间感、耳机定位或频段增强，随歌曲实时生效。</p></div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="fx-grid">${cards}</div>
          <div class="field" style="margin-top:16px">
            <label>强度</label>
            <div class="volume-control" style="justify-content:flex-start">
              <input class="volume-range" id="fx-intensity" type="range" min="0" max="100" step="1" value="${state.audioFx.intensity}" />
              <span class="volume-value" id="fx-intensity-value">${state.audioFx.intensity}%</span>
            </div>
          </div>
          <p class="hint">音效需要浏览器支持 Web Audio。若某些直链不允许跨域读取，播放会没有声音，此时会自动切回原声（不再弹提示，免得打断听歌）。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-primary" data-close>完成</button>
        </div>
      </div>
    </div>
  `);

  const intensity = document.querySelector('#fx-intensity');
  if (intensity) {
    const label = document.querySelector('#fx-intensity-value');
    intensity.addEventListener('input', () => {
      const value = setAudioFxIntensity(intensity.value);
      if (label) label.textContent = `${value}%`;
    });
  }
}

/* ---------- 界面音效：现场合成，不带音频文件 ----------
 * 两层结构，缺一层就会「电子味」或者「没手感」：
 *   · 噪声瞬态 tick（8~26ms、带通）提供「哒」的接触感，纯正弦永远做不出这个质感；
 *   · 音体 tone（正弦 / 三角、短滑音）提供音高与方向，区分「轻点」「确认」「警告」。
 * 音量走 pow(x,1.4) 感知曲线：线性映射时 35% 听感不足 20%，用户会以为音效坏了。
 */
function uiSoundNoise(context) {
  if (uiNoiseBuffer && uiNoiseBuffer.sampleRate === context.sampleRate) return uiNoiseBuffer;
  const length = Math.max(1, Math.floor(context.sampleRate * 0.12));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  // 固定种子的伪随机：每次启动噪声频谱一致，不会「这次脆、下次闷」
  let seed = 22695477;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed / 0x3fffffff - 1;
  }
  uiNoiseBuffer = buffer;
  return buffer;
}

function playUiSound(kind = 'click', force = false) {
  const settings = state.sound;
  if (!settings.enabled) return;
  // 三个开关管四类音：tap / primary / toggle 归「点击音」，error 归「通知音」
  const gate = kind === 'notify' || kind === 'error' ? 'notify' : kind === 'launch' ? 'launch' : 'click';
  if (!settings[gate] && !force) return;
  if (force) {
    // 预览按钮连点也别叠成电流声
    const stamp = performance.now();
    if (stamp - (uiSoundStamp[kind] || 0) < 140) return;
    uiSoundStamp[kind] = stamp;
  }
  const volume = Math.max(0, Math.min(100, Number(settings.volume) || 0)) / 100;
  if (volume <= 0) return;
  if (!force && !uiSoundBudget(kind)) return;
  const amp = Math.pow(volume, 1.4);
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    if (!uiSoundContext) uiSoundContext = new AudioCtor();
    if (uiSoundContext.state === 'suspended') uiSoundContext.resume().catch(() => {});
    const context = uiSoundContext;
    const now = context.currentTime + 0.004;

    const tone = (frequency, delay, duration, endFrequency, gain, type = 'sine', attack = 0.006) => {
      const start = now + delay;
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (endFrequency && endFrequency !== frequency) {
        oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
      }
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * amp), start + Math.min(attack, duration * 0.4));
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(envelope);
      envelope.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    };

    const tick = (frequency, delay, duration, gain, q = 1.6) => {
      const start = now + delay;
      const source = context.createBufferSource();
      source.buffer = uiSoundNoise(context);
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(frequency, start);
      filter.Q.setValueAtTime(q, start);
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * amp), start + Math.min(0.004, duration * 0.35));
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      source.connect(filter);
      filter.connect(envelope);
      envelope.connect(context.destination);
      source.start(start);
      source.stop(start + duration + 0.01);
    };

    switch (kind) {
      case 'tap':
        // 导航 / 图标按钮：只留一点点接触感，点多了不烦
        tick(3200, 0, 0.014, 0.075);
        tone(1560, 0, 0.04, 1320, 0.03);
        break;
      case 'primary':
        // 主行动（开始游戏 / 下载 / 确认）：更厚，带一点下沉
        tick(1500, 0, 0.026, 0.12);
        tone(520, 0, 0.12, 300, 0.055, 'triangle');
        tone(1040, 0.018, 0.05, 1180, 0.026);
        break;
      case 'toggle':
        // 开关：短促上扬，闭眼也能听出是「拨过去」而不是「按一下」
        tick(3600, 0, 0.012, 0.085);
        tone(980, 0.004, 0.05, 1420, 0.035);
        break;
      case 'error':
        tick(520, 0, 0.03, 0.1);
        tone(300, 0, 0.17, 186, 0.05, 'triangle');
        break;
      case 'notify':
        tone(659.25, 0, 0.2, 783.99, 0.06, 'sine', 0.012);
        tone(987.77, 0.1, 0.24, 880, 0.042, 'sine', 0.012);
        break;
      case 'launch':
        tone(261.63, 0, 0.3, 659.25, 0.055, 'triangle', 0.02);
        tone(523.25, 0.1, 0.36, 1046.5, 0.036, 'sine', 0.016);
        tone(130.81, 0, 0.32, 196, 0.03, 'sine', 0.03);
        break;
      default:
        // click：普通按钮，短、干、带明确接触点
        tick(2600, 0, 0.022, 0.095);
        tone(1120, 0, 0.055, 760, 0.045);
    }
  } catch {
    /* audio feedback is optional */
  }
}

/* 连点节流：正常点击走 45ms 同音色 / 26ms 全音色两道闸 */
function uiSoundBudget(kind) {
  const stamp = performance.now();
  if (stamp - (uiSoundStamp[kind] || 0) < 45) return false;
  if (stamp - uiSoundAnyStamp < 26) return false;
  uiSoundStamp[kind] = stamp;
  uiSoundAnyStamp = stamp;
  return true;
}

/* 按控件角色挑音色：主按钮、导航、开关不该是同一个「哒」 */
function uiSoundKindFor(element) {
  if (!element) return 'click';
  if (element.closest('.switch')) return 'toggle';
  if (element.matches('.btn-primary, .btn-danger')) return 'primary';
  if (element.closest('.nav-item, [data-nav], .mini-btn, .chrome-btn, .segmented, .chip')) return 'tap';
  return 'click';
}


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

/* ------------------------------------------------------------------ */
/* chrome & routing                                                    */
/* ------------------------------------------------------------------ */

/**
 * 背景层：把「窗口材质」和「自定义背景图」两件事分开。
 * - `:root[data-material]` 决定 body 要不要透明。有材质时 body 必须透明，
 *   否则会盖住 DWM 合成的亚克力/云母。
 * - `#app-backdrop` 是自定义背景图的独立一层，`--bg-opacity` 控制它的不透明度，
 *   `--bg-blur` 控制模糊半径。它铺在 body 之上、`.app` 之下，所以不会挡住内容。
 */
const MATERIAL_LABEL = {
  none: '无',
  acrylic: '亚克力',
  mica: '云母',
  micaTabbed: '云母·选项卡',
  auto: '自动',
};

/* 材质候选值：按钮渲染、点击校验、主进程白名单必须是同一份，否则会出现
 * 「界面上根本没有这个按钮，但数据里是它」这种对不上的状态。 */
const MATERIAL_OPTIONS = ['none', 'acrylic', 'mica', 'micaTabbed', 'auto'];

function applyBackdrop(settings) {
  const root = document.documentElement;
  const material = settings.material || 'none';
  const image = settings.customBackground || '';
  const opacity = Math.max(0, Math.min(100, Number(settings.backgroundOpacity ?? 100)));
  const blur = Math.max(0, Math.min(60, Number(settings.backgroundBlur ?? 0)));

  root.dataset.material = material;
  root.style.setProperty('--bg-opacity', String(opacity / 100));
  root.style.setProperty('--bg-blur', `${blur}px`);
  // 背景图越实（opacity 高），内容底就越实，否则文字读不清；
  // 背景图拉得很淡时，内容底也跟着让位，让材质纹理透上来。
  root.style.setProperty('--bg-veil', `${Math.round(34 + (opacity / 100) * 34)}%`);

  let layer = document.getElementById('app-backdrop');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'app-backdrop';
    document.body.insertBefore(layer, document.body.firstChild);
  }
  if (image) {
    const url = toFileUrl(image);
    layer.style.backgroundImage = url ? `url("${url.replace(/"/g, '\\"')}")` : '';
    if (!url) layer.hidden = true;
    else layer.hidden = false;
    layer.classList.toggle('is-authoritative', material === 'none');
  } else {
    layer.style.backgroundImage = '';
    layer.hidden = true;
  }
  document.body.classList.toggle('has-material', material !== 'none');
  document.body.classList.toggle('has-backdrop', Boolean(image));
}

/*
 * charms（装饰挂饰）和 charBg（角色背景水印）只在渲染进程里用：主进程的
 * settings:update 白名单没有这两个键，快照里永远不出现它们。于是任何一次
 * 状态回推 / applySettingLocally 回填，都会把刚点下去的值抹掉，开关看着就是
 * 「点了又弹回去」。这里在覆盖 state.settings 之前把这两个值捞回来。
 */
const RENDERER_ONLY_SETTINGS = ['charms', 'charBg'];

function keepRendererSettings(next, fallback) {
  const merged = { ...(next || {}) };
  for (const key of RENDERER_ONLY_SETTINGS) {
    if (fallback && key in fallback) merged[key] = fallback[key];
  }
  return merged;
}

function applySettings() {
  const settings = state.settings || {};
  const mode = settings.theme || 'dark';
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : mode;
  document.documentElement.dataset.theme = resolved === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.accent = settings.accent || 'spark';
  document.body.classList.toggle('sidebar-collapsed', settings.sidebarCollapsed === true);
  document.body.classList.toggle('charms-on', settings.charms !== false);
  document.body.classList.toggle('charbg-on', settings.charBg !== false);
  document.body.classList.toggle('no-sidebar-char', settings.sidebarChar === false);
  applyBackdrop(settings);
  document.title = `花筱灵启动器 · ${PAGE_META[state.route]?.label || '主页'}`;
}

/**
 * 改一项设置：先在本地生效，再等主进程落盘。
 *
 * 原来的写法是 `await api.updateSettings(...)` 然后什么都不做，界面完全靠
 * 主进程回推 state:changed 才刷新；而主进程是先 await store.saveNow() 写盘、
 * 之后才推状态，所以点一下要等磁盘写完才有反应，看起来就是「点了不改」。
 * 更糟的是回推时如果本地 state 还是旧值，applySettings 会照着旧值把刚画上去的
 * 主题/强调色又刷回去。
 *
 * 这里统一成乐观更新：本地先写、立刻重画，落盘失败再把旧值滚回去并提示。
 */
async function applySettingLocally(patch) {
  const previous = { ...(state.settings || {}) };
  state.settings = { ...previous, ...patch };
  applySettings();
  updateChrome();

  let saved = null;
  try {
    saved = await api.updateSettings(patch);
  } catch (error) {
    state.settings = previous;
    applySettings();
    updateChrome();
    toast(humanError(error), 'error');
    return false;
  }

  if (saved?.settings) {
    // 就地保留 charms / charBg：主进程不认这两个键，直接覆盖会把它俩抹掉
    state.settings = keepRendererSettings(saved.settings, state.settings);
    applySettings();
    updateChrome();
  }
  return true;
}

function updateChrome() {
  const settings = state.settings || {};
  document.body.classList.toggle('sidebar-collapsed', settings.sidebarCollapsed === true);
  document.querySelectorAll('.sidebar-toggle').forEach((button) => {
    button.title = settings.sidebarCollapsed ? '展开侧栏' : '收起侧栏';
    const label = button.querySelector('span');
    if (label) label.textContent = settings.sidebarCollapsed ? '展开侧栏' : '收起侧栏';
  });
  if (dom.profileName) dom.profileName.textContent = settings.profileName || '大小姐';
  if (dom.profileAvatar) {
    dom.profileAvatar.innerHTML = avatarContent(settings);
    const image = dom.profileAvatar.querySelector('img');
    if (image) {
      image.addEventListener(
        'error',
        () => {
          dom.profileAvatar.textContent = initial(settings.profileName || '大小姐');
        },
        { once: true }
      );
    }
  }
  if (dom.badgeLibrary) dom.badgeLibrary.textContent = String(state.games.length);
  const active = activeDownloads().length;
  if (dom.badgeDownloads) {
    dom.badgeDownloads.hidden = active === 0;
    dom.badgeDownloads.textContent = String(active);
  }
  if (dom.tbVersion) dom.tbVersion.textContent = `v${state.app.version || '1.0.0'}`;
  if (dom.tbSection) dom.tbSection.textContent = PAGE_META[state.route]?.label || '主页';
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.nav === state.route);
  });
  // 侧栏工具子项也参与高亮：点「抽卡记录」时高亮的是工具父项
  document.querySelectorAll('.nav-sub-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.nav === state.route && item.dataset.feature !== undefined);
  });
  syncNavToolsOpen();
}

/*
 * 启动页唤出侧栏：抽屉不自己动，靠窗口往左「长」出来。
 *
 *   · 外扩（默认，普通窗口）：窗口一次性往左张开 push 宽，画面钉死在窗口右边缘，
 *     在屏幕上一像素都不动；抽屉就在新露出来的那一条里显形。
 *   · 内推（全屏 / 最大化 / 贴着屏幕左边缘没空间）：没有窗口可长，只能把画面
 *     往右推、右侧裁掉，抽屉压在左边。全屏没有窗口可用，只能是这一种。
 *
 * 外扩为什么不再逐帧推窗口：窗口每变一次尺寸，系统都会把上一帧位图按窗口左上角
 * 再贴一次，画面在屏幕上就跟着窗口左沿抖一段 —— 一帧几像素、连起来就是「背景
 * 跟着一起过去」。这是窗口层的账，画面这边怎么钉都追不上。所以窗口一步到位，
 * 动效交给抽屉自己（见 styles.css 的 startNavDrawerIn）。
 */
const START_NAV_MS = 180;
let startNavCloseTimer = 0;

/** 动画期间的守卫：这段时间里任何「跟着窗口尺寸重算」的活都可以先跳过。 */
function startNavAnimating() {
  return document.body.classList.contains('start-nav-anim');
}

/** 动画收尾后补一次全局 resync，把补间期间跳过的尺寸相关布局补上。 */
function resyncAfterStartNav() {
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

/*
 * 展开方向要看窗口左边还剩多少空间，问主进程是一趟 IPC 往返。窗口不动的时候
 * 这个值恒定，所以缓存住：点下去立刻开跑，不用先站着等一次往返 —— 那 10~20ms
 * 的空档就是「点了没反应」的来源。窗口被人挪过或超过 4s 就当过期重问。
 */
const startNavRoomCache = { room: -1, at: 0 };
async function readStartNavRoom(force = false) {
  const age = performance.now() - startNavRoomCache.at;
  if (!force && startNavRoomCache.room >= 0 && age < 4000) return startNavRoomCache.room;
  try {
    const info = await api.startNavRoom();
    const room = Math.max(0, Number(info?.room) || 0);
    startNavRoomCache.room = room;
    startNavRoomCache.at = performance.now();
    return room;
  } catch {
    return startNavRoomCache.room >= 0 ? startNavRoomCache.room : 0;
  }
}
function warmStartNavRoom() {
  readStartNavRoom(true).catch(() => {});
}

// 指针一沾到菜单键就先问起来，等真正点下去时缓存已经是热的
document.addEventListener(
  'pointerenter',
  (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-action="toggle-start-nav"]')) {
      warmStartNavRoom();
    }
  },
  true
);

/** 把窗口左沿一步挪到「基准 - delta」，画面那边靠 CSS 钉住右沿，两边不需要同步。 */
function applyStartNavWidth(delta) {
  document.documentElement.style.setProperty('--start-nav-push', `${Math.round(delta)}px`);
  Promise.resolve(api.startNavResize(Math.round(delta))).catch(() => {});
}

async function setStartNavOpen(open, options = {}) {
  if (state.startNavOpen === open) return;
  state.startNavOpen = open;
  const bar = document.querySelector('.sidebar');
  const measured = bar ? Math.round(bar.getBoundingClientRect().width) : 0;
  // 展开态 220、收起态 72（图标条）：量出来当补间终点，画面补偿量、窗口外扩量共用它
  const push = measured > 0 ? measured : 220;
  const instant = options.instant === true;

  if (open) {
    // 正在退场（120ms）时又被点开：把那条收尾砍掉，抽屉原样留在原位
    if (startNavCloseTimer) {
      clearTimeout(startNavCloseTimer);
      startNavCloseTimer = 0;
    }
    document.body.classList.remove('start-nav-closing');
    // 命中缓存就直接开跑，同时后台把缓存刷成最新；没命中才等这一趟
    let room = startNavRoomCache.room;
    if (room < 0 || performance.now() - startNavRoomCache.at >= 4000) {
      room = await readStartNavRoom(true);
    } else {
      warmStartNavRoom();
    }
    // 等这一下的时间里用户可能又点回去了：那就什么都别做
    if (state.startNavOpen !== true) return;
    const outward = room >= push;
    const wasOutward = document.body.classList.contains('start-nav-outward');
    state.startNavExpanded = outward;
    /*
     * 外扩的画面基准宽必须在窗口还没动、也还没挂 start-nav-open 的时候量：
     * 一旦挂上类，.start-screen 就 fixed 到右边缘了，这时量到的是「已经被撑开的
     * 视口」。中途被打断重开时也不能重量 —— 那会儿窗口本来就不是基准宽。
     */
    if (outward && !wasOutward) {
      /*
       * 基准宽取画面自己的宽度，不用 clientWidth：窗口带竖向滚动条时 clientWidth
       * 会少掉那条的宽度，画面会平白窄十几像素（看着就是「画面缩了一下」）。
       */
      const screenEl = document.querySelector('.start-screen');
      const baseW = Math.round(
        screenEl ? screenEl.getBoundingClientRect().width : document.documentElement.clientWidth
      );
      document.documentElement.style.setProperty('--start-nav-base-w', `${baseW}px`);
    }
    document.body.classList.toggle('start-nav-outward', outward);
    document.body.classList.add('start-nav-open');
    if (!outward) {
      /*
       * 内推：全屏 / 最大化 / 窗口贴着屏幕左边缘，没有地方让窗口长，只能把画面
       * 整体往右推、右边被裁掉，侧栏压在左边。
       * 这里以前直接 return，--start-nav-push 一直是 0 —— 侧栏虽然置为可见，
       * 却被纹丝不动的画面整个盖住，全屏下点完只看到「什么都没发生」。
       */
      document.documentElement.style.setProperty('--start-nav-push', `${push}px`);
      setTimeout(resyncAfterStartNav, START_NAV_MS + 40);
      return;
    }
    /*
     * 外扩：窗口一步张开到位，画面在屏幕上不动。
     *
     * 以前这里是一帧一帧把窗口左沿往左挪、宽度跟着长，看着像把抽屉「推」出去；
     * 但窗口每变一次尺寸，系统都会把上一帧位图按窗口左上角再贴一次，画面就跟着
     * 窗口左沿抖一段（一帧几像素，连起来就是「背景跟着一起过去」）。这是窗口层
     * 面的事，画面怎么用 CSS 钉右沿都追不上。现在窗口只动一次，多出来的那条左侧
     * 由抽屉自己滑出来接住（styles.css 的 startNavDrawerIn）。
     */
    /*
     * 先把抽屉摆好，再让窗口长出去。
     * 顺序反过来的话会有一两帧「窗口已经宽了、左边那条还是空的」—— 那正是用户
     * 说的「闪一下」。读一次 offsetWidth 把刚加的类强制落地（同步重排），
     * 保证主进程 setBounds 生效时，抽屉已经画在新位置上。
     */
    void document.body.offsetWidth;
    applyStartNavWidth(push);
    // 窗口尺寸变了：小播放器那类按矩形定位的东西要重新量一次
    setTimeout(resyncAfterStartNav, 80);
    return;
  }

  const finish = () => {
    // 中途又被点开了：窗口和画面补偿都留着，别在这一刻收
    if (state.startNavOpen) return;
    state.startNavExpanded = false;
    // 先归零再摘类：摘类的一瞬间 translateX(var(--push)) 会立刻生效，顺序反了就跳一下
    document.documentElement.style.setProperty('--start-nav-push', '0px');
    document.documentElement.style.removeProperty('--start-nav-base-w');
    document.body.classList.remove(
      'start-nav-outward',
      'start-nav-open',
      'start-nav-anim',
      'start-nav-closing'
    );
    Promise.resolve(api.startNavCollapse()).catch(() => {});
  };

  if (!state.startNavExpanded) {
    // 内推模式：窗口没动过，把展开量归零，画面自己滑回去（transform 是常驻的）
    document.documentElement.style.setProperty('--start-nav-push', '0px');
    document.body.classList.remove('start-nav-open', 'start-nav-outward');
    setTimeout(resyncAfterStartNav, START_NAV_MS + 40);
    return;
  }
  if (instant) {
    finish();
    resyncAfterStartNav();
    return;
  }
  // 直接一步收回：抽屉不做退场动画，窗口缩回的同时那块区域一起消失，
  // 画面钉在右沿一帧都不动。以前是「先退 120ms 再收窗口」，那段时间窗口还宽着、
  // 左边空出一条，看上去就是闪了一下。
  finish();
  resyncAfterStartNav();
}

function navigate(route, options = {}) {
  if (route === 'library') route = 'home';
  if (!PAGE_META[route]) route = 'home';
  // 启动页唤出的侧栏开着时跳走：顺手收回。
  // 离开启动页时必须「立刻」收：画面马上要换成别的页，等 0.36s 动画的话，
  // 外层窗口还多着一条侧栏的宽度，新页面会先按窄画面画一帧再跳回来。
  if (state.startNavOpen) {
    setStartNavOpen(false, { instant: route !== 'start' }).catch(() => {});
  }
  const changed = route !== state.route;
  /*
   * 「返回工具页」条的来路标记：工具页的功能入口 navigate 时会带 fromTools，
   * 目标二级页据此显示返回条；任何其它路由切换都视为已离开工具页链路，
   * 自动清除，保证从侧栏直接进这些页面时不多出按钮、也不弄坏现有返回行为。
   */
  if (options.fromTools) state.fromTools = true;
  else if (changed) state.fromTools = false;
  state.route = route;
  if (!document.body.classList.contains('sophon-minimized')) closeModal();
  render({ preserveScroll: false });
  if (route !== 'gacha') stopGachaRefresh();
  if (route !== 'start') stopStartRunningTimer();
  // 离开插件页就把所有 Worker 停掉：它们没必要在后台占着 CPU 和内存
  if (changed && state.route === 'plugins') stopAllPlugins();
  if (route === 'gacha' && !state.gacha && !state.gachaLoading) {
    loadGacha();
  }
  if (route === 'announcements') {
    // 旧数据可能停在已合并的公告页：直接转到动态
    navigate('news', { silent: true });
    return;
  }
  if (route === 'news') {
    startNoticeBoardTimer();
    loadNoticeBoard();
  } else {
    stopNoticeBoardTimer();
  }
  if (route === 'tools' && !state.features) {
    // 先异步取数据，拿到后再重绘；失败也要重绘，否则会卡在「正在读取」
    loadFeatures().then(() => {
      // 2.4.0 修复：这里不能传 preserveScroll —— navigate 进工具页时是异步重绘，
      // 传 true 会把用户进入工具页之前的滚动位置原样还原回去，表现为「点进工具页滚动条跑到奇怪的地方」。
      if (state.route === 'tools') render();
    });
  }
  if (route === 'tools') {
    // 顺带刷一次米游社登录态，拿到角色后重绘
    refreshHoyolabStatus('miyoushe').then(() => {
      // 同上：异步数据回来后的重绘不还原滚动位
      if (state.route === 'tools') render();
    });
    // 鹰角 / 完美世界 / 库街区的登录态一并拉一次
    const passportIds = [
      ...new Set(
        (state.games || [])
          .map((game) => game?.login?.provider)
          .filter((id) => id && id !== 'miyoushe' && id !== 'hoyolab')
      ),
    ];
    Promise.all(passportIds.map((id) => refreshPassportStatus(id))).then(() => {
      // 同上：异步数据回来后的重绘不还原滚动位
      if (state.route === 'tools') render();
    });
  }
  if (route === 'record') {
    /*
     * 战绩页只认 13 个战绩功能。抽卡记录、截图管理、画质配置这些
     * 从别处误传进来时回落到每日便笺，不能把它们当战绩页的内容渲染。
     */
    const requested = String(options.feature || state.record.feature || 'daily-note');
    const feature = RECORD_FEATURE_SET.has(requested) ? requested : 'daily-note';
    const changed = feature !== state.record.feature;
    state.record.feature = feature;
    if (options.game) {
      state.record.game = String(options.game);
    } else if (changed) {
      /*
       * 从工具页点「打开 X」进来时只知道功能，不知道该看哪个游戏。
       * 优先选「已经登录且支持这个功能」的那款，用户点完就能直接看到数据。
       */
      state.record.game = pickRecordGame(feature);
    }
    if (options.schedule) state.record.schedule = Number(options.schedule) === 2 ? 2 : 1;
    /*
     * 战绩页依赖两份数据：能力矩阵（这个游戏支持哪些功能）和登录态（有哪些角色）。
     * 两份都要先就位再请求，否则会拿空 uid 去调接口、或者标签行少几个游戏。
     */
    (async () => {
      if (!state.features) await loadFeatures();
      /*
       * 能力矩阵回来后才发现「这个游戏不支持当前功能」很常见：
       * 深境螺旋只有原神有，切到星铁时不该停在空页，落到它自己的第一个战绩功能。
       */
      const supported = recordFeaturesOf(state.record.game);
      if (supported.length && !supported.includes(state.record.feature)) {
        state.record.feature = supported[0];
      }
      await refreshHoyolabStatus('miyoushe');
      if (state.route !== 'record') return;
      render({ preserveScroll: true });
      await loadRecord();
      if (state.route === 'record') render({ preserveScroll: true });
    })();
  }
  if (route === 'screenshots' && !state.shots && !state.shotsLoading) {
    loadScreenshots(false);
  }
  if (route === 'graphics' && !state.graphics && !state.graphicsLoading) {
    loadGraphics(state.graphicsGame);
  }
  if (route === 'plugins' && !state.plugins.list) {
    loadPlugins();
  }
  if (route === 'start') {
    const startGame =
      state.games.find((game) => game.id === state.startGameId) ||
      [...state.games].sort(
        (a, b) => new Date(b.lastPlayed || b.createdAt || 0) - new Date(a.lastPlayed || a.createdAt || 0)
      )[0];
    if (startGame) loadGameNotices(startGame.id);
  }
  if (route === 'song') {
    refreshMusicLogin();
    refreshNeteaseLogin();
    const song = state.songs[state.songIndex];
    if (song) {
      Promise.resolve()
        .then(() => hydrateSong(song))
        .then(() => ensureSongQuality(song))
        .then(() => {
          if (state.route === 'song') render({ preserveScroll: true });
        });
    }
  }
  if (changed) {
    dom.view.classList.remove('entering');
    void dom.view.offsetWidth;
    dom.view.classList.add('entering');
    window.setTimeout(() => dom.view.classList.remove('entering'), 600);
    if (!options.silent) {
      api.updateSettings({ lastPage: route }).catch(() => {});
    }
  }
}

function captureFocus() {
  const active = document.activeElement;
  if (!active || !['INPUT', 'TEXTAREA'].includes(active.tagName) || !active.id) return null;
  return {
    id: active.id,
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const element = document.getElementById(snapshot.id);
  if (!element) return;
  element.focus();
  if (snapshot.start != null && typeof element.setSelectionRange === 'function') {
    element.setSelectionRange(snapshot.start, snapshot.end);
  }
}

/*
 * 启动页的动态背景是 <video>，每次整页重绘（切服务器、游戏状态刷新）都会
 * 把元素重新创建一遍，画面直接跳回第 0 秒 —— 看起来就像「又打开了一次启动页」。
 * 重绘前把播放位置和暂停状态记下来，重绘后原样还回去；
 * 换了游戏（src 变了）就不还原，免得新视频从中间开始播。
 */
/*
 * 重绘时 <video> 是全新节点，currentTime 从 0 开始、元数据也还没到，
 * 所以「读旧节点 + 写新节点」这条路在连续两次重绘时会读到 0 ——
 * 表现就是点服务器展开面板、切服务器时动态背景一直跳回开头。
 * 这里额外用一个模块级记忆记录最近一次真实播放进度，作为兜底。
 */
let startVideoMemo = { src: '', time: 0, paused: false };

/*
 * 换游戏时旧画面会作为过渡层压在顶上，于是 DOM 里同时存在两个 .start-art。
 * 所有「当前画面」的查找都必须跳过过渡层，否则 querySelector 会命中旧的
 * 那一层 —— video-ready 加错节点，新视频一直是 opacity:0，用户看到的就是
 * 「换游戏之后只剩静态图」。下面这个选择器是唯一入口，别再手写 .start-art。
 */
const START_ART_LIVE = '.start-art:not(.start-art-prev)';
const START_VIDEO_LIVE = `${START_ART_LIVE} video[data-start-video]`;

function liveStartArt(root = dom.view) {
  return root.querySelector(START_ART_LIVE);
}

function liveStartVideo(root = dom.view) {
  return root.querySelector(START_VIDEO_LIVE);
}

function memoStartVideo() {
  const video = liveStartVideo();
  if (!video) return null;
  const src = video.getAttribute('src') || '';
  const live = {
    src,
    time: Number(video.currentTime) || 0,
    paused: video.paused,
  };
  // 旧节点已经有真实进度：直接用它
  if (live.time > 0.05 || video.readyState >= 1) return live;
  // 旧节点是刚建出来的（进度 0 且未就绪）：退回记忆值
  if (startVideoMemo.src === src) {
    return { src, time: startVideoMemo.time, paused: live.paused };
  }
  return live;
}

function restoreStartVideo(memo) {
  if (!memo) return;
  const video = liveStartVideo();
  if (!video) return;
  if ((video.getAttribute('src') || '') !== memo.src) return;
  const seek = () => {
    if (memo.time > 0.05 && Number.isFinite(video.duration) && memo.time < video.duration) {
      try {
        video.currentTime = memo.time;
      } catch {
        /* 元数据还没就绪，下一次重绘再还原 */
      }
    }
    if (memo.paused) video.pause();
    else video.play().catch(() => {});
  };
  if (video.readyState >= 1) seek();
  else video.addEventListener('loadedmetadata', seek, { once: true });
}

/*
 * 切游戏 / 切服务器时整块 DOM 会重建，<video> 也跟着换新，
 * 新 video 在解出第一帧之前是空白，于是先露出下面的静态版本图 ——
 * 用户看到的就是「先闪一下静态图再放视频」（终末地、异环最明显）。
 * 做法：video 默认透明，真正有画面后再淡入；如果换的是同一个源，
 * 直接把就绪状态接上，连这一下淡入都省掉。
 */

/*
 * 重绘会把 .start-art 整块换掉，新 <video> 从零开始加载，
 * 于是先露一下静态版本图，再跳成视频（终末地、异环最明显）。
 * 这里做画面交接：
 *   · 指纹相同（切服务器、开合面板）→ 直接复用旧节点，视频不动
 *   · 指纹不同（换游戏）→ 旧画面盖在上面，新视频就绪后再淡出
 */
function handoffStartArt(prevArt) {
  const screen = dom.view.querySelector('.start-screen');
  if (!screen || !prevArt) return;
  const nextArt = liveStartArt(screen);
  if (!nextArt || nextArt === prevArt) return;

  const prevKey = prevArt.dataset.artKey || '';
  const nextKey = nextArt.dataset.artKey || '';

  if (prevKey && prevKey === nextKey) {
    // 同一画面：旧节点（含正在播放的视频）直接顶替新节点
    nextArt.replaceWith(prevArt);
    return;
  }

  // 换画面：旧画面当过渡层压在顶部
  prevArt.classList.add('start-art-prev');
  screen.insertBefore(prevArt, screen.firstChild);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    prevArt.classList.add('start-art-prev-out');
    setTimeout(() => prevArt.remove(), 340);
  };

  const video = nextArt.querySelector('video[data-start-video]');
  if (!video) {
    setTimeout(close, 260);
    return;
  }
  if (video.readyState >= 2) {
    setTimeout(close, 200);
    return;
  }
  video.addEventListener('loadeddata', () => setTimeout(close, 200), { once: true });
  setTimeout(close, 2600);
}

let startArtReadySrc = '';

function bindStartArtVideo() {
  const wrap = liveStartArt();
  if (!wrap) return;
  const video = wrap.querySelector('video[data-start-video]');
  if (!video) return;
  const src = video.getAttribute('src') || '';
  const markReady = () => {
    startArtReadySrc = src;
    wrap.classList.add('video-ready');
  };
  // 同一个视频源：上一次播放过，直接接上，不再闪图
  if (startArtReadySrc && startArtReadySrc === src) wrap.classList.add('video-ready');
  if (video.readyState >= 2) markReady();
  else video.addEventListener('loadeddata', markReady, { once: true });
  video.addEventListener('playing', markReady, { once: true });
  // 把真实播放进度记到模块里，下一次重绘即使新节点还没就绪也能接上
  video.addEventListener('timeupdate', () => {
    if (video.currentTime > 0.05) {
      startVideoMemo = { src, time: video.currentTime, paused: video.paused };
    }
  });
  video.addEventListener('pause', () => {
    startVideoMemo = {
      src,
      time: Number(video.currentTime) || startVideoMemo.time,
      paused: true,
    };
  });
  video.addEventListener('play', () => {
    startVideoMemo = { src, time: Number(video.currentTime) || 0, paused: false };
  });
  video.addEventListener('error', () => {
    if (startArtReadySrc === src) startArtReadySrc = '';
    wrap.classList.remove('video-ready');
    video.remove();
  });
}

/**
 * 给顶栏小按钮挂上角色纹样：花火的笑脸面具 + 火花的兔子耳朵。
 * 用真元素而不是伪元素 —— 这些按钮的 ::before 是光轨、::after 是底光，都占着。
 * 关闭键用冷白红，别和粉金混在一起。
 */
function decorateCharacterMotifs() {
  const selector = [
    '.window-controls .window-control',
    '.start-screen .start-top .chrome-btn',
    '.start-screen .start-top .start-video-toggle',
    '.page-head-actions .btn-ghost',
  ].join(', ');
  document.querySelectorAll(selector).forEach((btn) => {
    if (btn.querySelector(':scope > .hx-orn')) return;
    const orn = document.createElement('span');
    orn.className = 'hx-orn';
    orn.setAttribute('aria-hidden', 'true');
    if (btn.classList.contains('window-control-close') || btn.classList.contains('chrome-close')) {
      orn.classList.add('hx-orn-danger');
    }
    btn.appendChild(orn);
  });
}

/*
 * 「点歌台点什么都跳回顶部」的根因：
 * .view 上写了 scroll-behavior: smooth，render() 里 `dom.view.scrollTop = scroll`
 * 因此变成一次平滑滚动动画而不是瞬间归位。下一次重绘读 scrollTop 时，动画
 * 还没滚到位，读到的是中途的较小值，再设回去又矮一截——连续几次操作就逐级
 * 衰减到 0，看起来就是"无论点啥都回到顶部"。
 *
 * 两条对策：
 *   1. 恢复滚动时临时关掉 smooth，让它瞬间归位（下一帧还原 CSS 的设定）；
 *      内容还没撑开时浏览器会把 scrollTop 钳到 0，所以下一帧再补一次。
 *   2. 记住上一次"命令式"设进去的位置，下回重绘优先用它，而不是读实时值。
 *      用户真的滚了（滚轮 / 按键 / 触摸 / 按滚动条）就以实时值为准。
 */
let appliedViewScroll = null;
/*
 * 点歌台外层滚动容器（.song-app-scroll）的位置记忆。
 *
 * 以前只在 preserveScroll 为真时保存/还原它，可点歌台里有太多重绘不带这个参数
 * （主进程回推状态、入队、播放进度、封面加载…），每来一次列表就归零，
 * 表现就是「点什么都会跳回顶部」。这里改成模块级记忆：只要还在同一个 tab，
 * 不论哪次重绘都还原原位；换 tab / 离开页面才从头开始。
 */
let songScrollMemo = { tab: '', top: 0, left: 0 };
for (const type of ['wheel', 'keydown', 'touchstart', 'mousedown']) {
  dom.view.addEventListener(type, () => {
    appliedViewScroll = null;
  }, { passive: true });
}

function setViewScroll(top) {
  const el = dom.view;
  const prevBehavior = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  el.scrollTop = top;
  requestAnimationFrame(() => {
    el.scrollTop = top;
    el.style.scrollBehavior = prevBehavior;
  });
  appliedViewScroll = top;
}

function render(options = {}) {
  if (!state.games.length && !state.app.version) return;
  document.body.classList.toggle('start-mode', state.route === 'start');
  /*
   * 侧栏的滑入过渡要等启动页「站稳」之后才启用。
   * 刚进启动页那一帧，侧栏从布局内的可见元素变成 fixed + 藏到左边缘外，
   * 如果过渡已经生效，它会当着用户面从原地滑出去一次（进页面就看到侧栏往左跑）。
   * 等一帧（样式已落地）再挂 start-nav-ready，之后唤出/收起才有动画。
   */
  if (state.route === 'start') {
    requestAnimationFrame(() => {
      if (state.route === 'start') document.body.classList.add('start-nav-ready');
    });
  } else {
    document.body.classList.remove('start-nav-ready');
  }
  // 二级功能页隐藏悬挂装饰：挂件固定在左上角，正好压住战绩/抽卡页第一行标签的字
  document.body.classList.toggle(
    'is-subpage',
    ['record', 'gacha', 'graphics', 'screenshots', 'downloads'].includes(state.route)
  );
  // 点歌台底部有 82px 的播放条：任务坞（硬链接/下载）fixed 在右下会压住它，CSS 里据此抬升
  document.body.classList.toggle('is-song-page', state.route === 'song');
  if (state.route !== 'start' && state.startServerMenu) state.startServerMenu = false;
  applySettings();
  updateChrome();
  const scroll = appliedViewScroll != null ? appliedViewScroll : dom.view.scrollTop;
  const view = {
    home: homeView,
    start: startView,
    library: libraryView,
    gacha: gachaView2,
    song: songView,
    downloads: downloadsView,
    news: newsView,
    tools: toolsView,
    record: recordView,
    screenshots: shotsView,
    graphics: graphicsView,
    plugins: pluginsView,
    announcements: announcementsView,
    settings: settingsView,
  }[state.route];
  // 小播放器正嵌在启动页标题行里时，先挪回 body，免得被整页重绘删掉
  const miniNode = document.querySelector('#mini-player');
  if (miniNode && miniNode.parentElement && miniNode.parentElement !== document.body) {
    document.body.appendChild(miniNode);
  }
  /*
   * 歌词面板也在重绘范围内，innerHTML 一换滚动位置就丢了，
   * 结果是每次切界面歌词都重新滚一遍。这里把滚动位置和
   * 「用户是否手动滚动过」一起存下来，重绘后原样还回去。
   */
  const lyricBox = dom.view.querySelector('#song-lyrics');
  const lyricScroll = lyricBox ? lyricBox.scrollTop : 0;
  /*
   * 内层滚动容器也要保滚：队列列表（.song-list）有 max-height + overflow，
   * 是自己的滚动容器。整页 innerHTML 重绘后这些节点是全新的，scrollTop 归零，
   * 表现为"点收起后列表跳回顶部"。按选择器记忆各容器位置，重绘后原样还回去。
   */
  // 点歌台真正的外层滚动容器是 .song-app-scroll（整块搜索结果 / 榜单 / 队列都在它里面滚），
  // 它由下面单独的 songScrollMemo 负责，不受 preserveScroll 影响。
  if (state.route === 'song') {
    const songScrollEl = dom.view.querySelector('.song-app-scroll');
    const songTabNow = String(state.songTab || 'queue');
    if (songScrollEl && songScrollMemo.tab === songTabNow) {
      songScrollMemo.top = songScrollEl.scrollTop;
      songScrollMemo.left = songScrollEl.scrollLeft;
    } else {
      // 刚进页面 / 换了 tab：容器内容整体换掉，回到顶部才对
      songScrollMemo = { tab: songTabNow, top: 0, left: 0 };
    }
  } else if (songScrollMemo.tab) {
    songScrollMemo = { tab: '', top: 0, left: 0 };
  }
  const INNER_SCROLL_SELECTORS = ['.song-list'];
  const innerScrollMemo = options.preserveScroll
    ? INNER_SCROLL_SELECTORS.map((sel) =>
        Array.from(dom.view.querySelectorAll(sel)).map((el) => ({ top: el.scrollTop, left: el.scrollLeft }))
      )
    : [];
  const videoMemo = memoStartVideo();
  const prevArt = dom.view.querySelector(`.start-screen ${START_ART_LIVE}`);
  dom.view.innerHTML = view ? view() : homeView();
  handoffStartArt(prevArt);
  // 点歌台外层滚动位置还原：任何一次重绘都保住用户当前看到的位置
  if (state.route === 'song') {
    const wantTop = options.resetSongScroll ? 0 : songScrollMemo.top;
    const wantLeft = options.resetSongScroll ? 0 : songScrollMemo.left;
    const songScrollEl = dom.view.querySelector('.song-app-scroll');
    if (songScrollEl) {
      songScrollEl.scrollTop = wantTop;
      songScrollEl.scrollLeft = wantLeft;
      // 列表里的封面图 / 异步内容可能晚一帧才把高度撑够，scrollTop 会先被钳小；
      // 下一帧补一次，确保真的回到原位。
      requestAnimationFrame(() => {
        const again = dom.view.querySelector('.song-app-scroll');
        if (again && Math.abs(again.scrollTop - wantTop) > 1) again.scrollTop = wantTop;
      });
    }
  }
  if (options.preserveScroll) {
    setViewScroll(scroll);
    INNER_SCROLL_SELECTORS.forEach((sel, i) => {
      const nodes = dom.view.querySelectorAll(sel);
      (innerScrollMemo[i] || []).forEach((memo, j) => {
        const el = nodes[j];
        if (!el) return;
        el.scrollTop = memo.top;
        el.scrollLeft = memo.left;
      });
    });
  } else setViewScroll(0);
  const nextLyricBox = dom.view.querySelector('#song-lyrics');
  if (nextLyricBox && lyricScroll) nextLyricBox.scrollTop = lyricScroll;
  bindView();
  restoreStartVideo(videoMemo);
  bindStartArtVideo();
  setupStartDrawerSync();
  setupStartGameRail();
  updateSongChrome();
  renderQuickPanel();
  decorateCharacterMotifs();
}

/* ------------------------------------------------------------------ */
/* home                                                                */
/* ------------------------------------------------------------------ */

function stageHero(latest, mood) {
  let action = 'add-game';
  let actionLabel = '添加游戏';
  let actionIcon = 'plus';
  let actionId = '';
  if (latest) {
    action = latest.running
      ? 'stop-game'
      : latest.installed
        ? 'launch-game'
        : latest.builtin
          ? 'detect-game'
          : 'edit-game';
    actionLabel = latest.running
      ? '结束当前剧目'
      : latest.installed
        ? '继续上一幕'
        : latest.builtin
          ? '检测已安装的游戏'
          : '配置上一幕';
    actionIcon = latest.running ? 'stop' : latest.installed ? 'play' : latest.builtin ? 'refresh' : 'wrench';
    actionId = ` data-id="${esc(latest.id)}"`;
  }
  return `
    <section class="hero">
      <div class="hero-bg" style="background-image:${esc(cssUrl('assets/character.png'))}"></div>
      <div class="hero-shade"></div>
      <div class="hero-sparxie" aria-hidden="true"><img src="assets/sparkle-hero.png" alt="" draggable="false" /></div>
      <div class="hero-sparks" aria-hidden="true">
        <svg viewBox="0 0 260 260">
          <g fill="none" stroke="currentColor">
            <circle cx="130" cy="130" r="52" opacity=".5" />
            <circle cx="130" cy="130" r="88" opacity=".22" />
            <circle cx="130" cy="130" r="126" opacity=".1" />
            <path d="M130 6v248M6 130h248M42 42l176 176M218 42 42 218" opacity=".12" />
            <path d="M130 46c7 45 29 67 74 74-45 7-67 29-74 74-7-45-29-67-74-74 45-7 67-29 74-74Z" opacity=".32" />
          </g>
          <g fill="currentColor">
            <circle cx="130" cy="18" r="2.2" opacity=".8" />
            <circle cx="244" cy="130" r="1.6" opacity=".55" />
            <circle cx="130" cy="244" r="1.4" opacity=".4" />
            <circle cx="16" cy="130" r="1.8" opacity=".5" />
            <circle cx="198" cy="58" r="2.6" opacity=".7" />
            <circle cx="66" cy="198" r="1.8" opacity=".45" />
          </g>
        </svg>
      </div>
      <div class="hero-index">花</div>
      <div class="hero-content">
        <div class="hero-kicker">
          <span class="pill">${mood.kicker}</span>
          <span class="line"></span>
          <span>${latest ? '上一幕已就绪' : '第一幕'}</span>
        </div>
        <h2>${mood.title}</h2>
        <div class="hero-sub">
          <span>花筱灵的私人游戏舞台</span>
          <span class="dot"></span>
          <span>${state.games.length} 个剧目</span>
          ${latest && latest.running ? `<span class="hero-running"><span class="pulse"></span>演出中</span>` : ''}
        </div>
        <p class="hero-desc">${mood.desc}</p>
        <div class="hero-actions">
          <button class="btn btn-primary" data-action="${action}"${actionId}>
            ${icon(actionIcon)}${esc(actionLabel)}
          </button>
          ${
            /* 2.4.x：有游戏时直达该游戏的启动页（侧栏直达后主页转「快速通道」定位）；
               没有游戏时退回普通启动页入口。 */
            latest
              ? `<button class="btn btn-glass hero-start-btn" data-action="continue-game" data-id="${esc(latest.id)}">
            ${icon('play')}进入启动页
          </button>`
              : `<button class="btn btn-glass hero-start-btn" data-nav="start">
            ${icon('play')}启动页
          </button>`
          }
          <button class="btn btn-glass" data-action="scroll-library">${icon('library')}查看游戏库</button>
        </div>
      </div>
      <div class="hero-portrait" aria-hidden="true">
        <img src="assets/character.png" alt="" draggable="false" />
      </div>
    </section>`;
}

function recentRow(game) {
  const action = game.running
    ? 'stop-game'
    : game.installed
      ? 'launch-game'
      : game.builtin
        ? 'detect-game'
        : 'edit-game';
  const actionIcon = game.running ? 'stop' : game.installed ? 'play' : game.builtin ? 'refresh' : 'wrench';
  const actionText = game.running ? '停止' : game.installed ? '启动' : game.builtin ? '检测安装' : '配置';
  return `
    <button class="recent-row" data-action="${action}" data-id="${esc(game.id)}" title="${actionText} ${esc(game.name)}">
      ${
        game.coverUrl
          ? `<img class="recent-cover" decoding="async" src="${esc(game.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover />`
          : `<span class="recent-cover" style="display:grid;place-items:center;color:var(--accent);font-weight:700">${esc(initial(game.name))}</span>`
      }
      <span class="recent-info">
        <span class="recent-name">${esc(game.name)}</span>
        <span class="recent-meta">
          ${game.running ? '<span class="pulse"></span>正在运行' : esc(relativeDate(game.lastPlayed))}
          ${game.builtin ? '<span>·</span><span>内置</span>' : game.demo ? '<span>·</span><span>示例</span>' : ''}
        </span>
      </span>
      <span class="recent-play">${icon(actionIcon)}</span>
    </button>`;
}

function newsCard(post) {
  return `
    <button class="news-card" data-action="open-news" data-id="${esc(post.id)}">
      <span class="news-top">
        <span class="news-tag">${esc(post.tag)}</span>
        <span>${esc(post.readTime || '')}</span>
      </span>
      <h4>${esc(post.title)}</h4>
      <p>${esc(post.excerpt)}</p>
      <span class="news-more">阅读全文 ${icon('chevron-right')}</span>
    </button>`;
}

/* 主页专用的一行动态条：标题 + 日期 + 箭头，点击行为与 news-card 一致（open-news），
   只是把三张大卡换成单行列表，让主页不用为动态区滚一大屏。 */
function homeNewsRow(post) {
  return `
    <button class="home-news-row" data-action="open-news" data-id="${esc(post.id)}">
      <span class="home-news-tag">${esc(post.tag)}</span>
      <span class="home-news-title">${esc(post.title)}</span>
      <span class="home-news-date">${esc(post.date || '')}</span>
      ${icon('chevron-right')}
    </button>`;
}


async function loadGameNotices(gameId) {
  if (!gameId) return;
  state.noticesGameId = gameId;
  state.notices = [];
  state.noticesLoading = true;
  if (state.route === 'start') render({ preserveScroll: false });
  try {
    const notices = await api.gameNotices(gameId);
    if (state.noticesGameId !== gameId) return;
    state.notices = Array.isArray(notices) ? notices : [];
  } catch {
    if (state.noticesGameId !== gameId) return;
    state.notices = [];
  } finally {
    if (state.noticesGameId === gameId) {
      state.noticesLoading = false;
      if (state.route === 'start') render({ preserveScroll: false });
    }
  }
}

function startView() {
  if (!state.games.length) return homeView();
  const ordered = [...state.games].sort(
    (a, b) =>
      new Date(b.lastPlayed || b.createdAt || 0) - new Date(a.lastPlayed || a.createdAt || 0)
  );
  const selected =
    state.games.find((game) => game.id === state.startGameId) ||
    ordered.find((game) => game.installed) ||
    ordered[0];
  const activeServer = (selected.servers || []).find((server) => server.id === selected.activeServerId);
  // 优先用「去文字」版本作为背景，避免官方图上的标题和我们的游戏名打架
  const cover = selected.startCoverUrl || selected.coverUrl || cssUrl('assets/character.png');
  const coverSrc = cover.replace(/^url\("|"\)$/g, '');
  // 画面指纹：切服务器 / 开合面板时画面没变，就能复用同一层 DOM，
  // 视频既不重载也不跳进度，从根上消掉「先闪静态图」
  const artKey = [selected.id, coverSrc, selected.backgroundVideo || ''].join('|');

  // 有背景视频时，视频里也可能烧录了文字，叠加一层文字遮罩带
  const hasVideo = Boolean(selected.backgroundVideo);
  return `
    <div class="start-screen${selected.builtinKey === 'endfield' ? ' start-screen-endfield' : ''}" style="--start-cover:${cover}">
      <div class="start-art${selected.builtinKey === 'endfield' ? ' start-art-cinema' : ''}${selected.backgroundVideo ? '' : ' start-art-pan'}" data-art-key="${esc(artKey)}" style="background-image:${esc(cssUrl(coverSrc))}">
        <img src="${esc(coverSrc)}" alt="" referrerpolicy="no-referrer" loading="eager" data-cover />
        ${
          selected.backgroundVideo
            ? `<video src="${esc(selected.backgroundVideo)}" poster="${esc(coverSrc)}" autoplay muted loop playsinline preload="auto" data-start-video></video>`
            : ''
        }
      </div>
      <div class="start-shade"></div>
      ${hasVideo ? '<div class="start-text-veil" aria-hidden="true"></div>' : ''}
      <header class="start-top">
        <!-- 2.4.x：返回键换成「打开导航」——侧栏浮层直接去任何页面，
             回主页走浮层第一项或 Esc，不再单独占一个键 -->
        <button class="chrome-btn chrome-menu" data-action="toggle-start-nav" title="打开侧栏（Esc 返回主界面）" aria-label="打开侧栏">${icon('menu')}</button>
        <div class="start-brand">
          <img class="start-brand-mark" src="assets/character-face.png" alt="" aria-hidden="true" />
          <div class="start-brand-copy">
            <strong>花筱灵</strong>
            <small>HANABI STAGE</small>
          </div>
        </div>
        <div class="start-video-tools">
          <button class="start-video-toggle" data-action="toggle-start-video" title="${hasVideo ? '暂停动态背景' : '这个游戏没有官方动态背景'}" aria-label="暂停或播放动态背景" ${hasVideo ? '' : 'disabled'}>
            <svg class="icon" aria-hidden="true"><use id="start-video-use" href="#i-pause"></use></svg>
          </button>
          <button class="start-video-toggle" data-action="export-start-video" title="${hasVideo ? '把这个动态背景另存为视频文件' : '这个游戏没有官方动态背景'}" aria-label="保存动态背景" ${hasVideo ? '' : 'disabled'}>
            ${icon('download')}
          </button>
        </div>
        <div class="start-window-controls">
          <button class="chrome-btn" data-action="window-minimize" title="最小化" aria-label="最小化">${icon('minus')}</button>
          <button class="chrome-btn" data-action="window-maximize" title="最大化 / 还原" aria-label="最大化">${icon('maximize')}</button>
          <button class="chrome-btn chrome-close" data-action="window-close" title="关闭" aria-label="关闭">${icon('x')}</button>
        </div>
      </header>
      <div class="start-main">
        <div class="start-sparks" aria-hidden="true">
          <svg viewBox="0 0 260 260">
            <g fill="none" stroke="currentColor">
              <circle cx="130" cy="130" r="52" opacity=".5" />
              <circle cx="130" cy="130" r="88" opacity=".22" />
              <circle cx="130" cy="130" r="126" opacity=".1" />
              <path d="M130 6v248M6 130h248M42 42l176 176M218 42 42 218" opacity=".12" />
              <path d="M130 46c7 45 29 67 74 74-45 7-67 29-74 74-7-45-29-67-74-74 45-7 67-29 74-74Z" opacity=".32" />
            </g>
            <g fill="currentColor">
              <circle cx="130" cy="18" r="2.2" opacity=".8" />
              <circle cx="244" cy="130" r="1.6" opacity=".55" />
              <circle cx="130" cy="244" r="1.4" opacity=".4" />
              <circle cx="16" cy="130" r="1.8" opacity=".5" />
              <circle cx="198" cy="58" r="2.6" opacity=".7" />
              <circle cx="66" cy="198" r="1.8" opacity=".45" />
            </g>
          </svg>
        </div>
        <div class="start-kicker"><span class="line"></span>${esc(activeServer?.name || '未配置服务器')}</div>
        <div class="start-titlebox"><h1>${esc(selected.name)}</h1></div>
        <p class="start-sub">${esc(selected.subtitle || selected.description || '准备好继续了吗？')}</p>
        <div class="start-meta">
          ${selected.version ? `<span>v${esc(selected.version)}</span>` : ''}
          ${activeServer?.path ? `<span>${esc(activeServer.path.split(/[\\/]/).pop())}</span>` : '<span>等待配置客户端</span>'}
        </div>
        <details class="start-notices" open>
          <summary>
            <span>${icon('news')}游戏公告</span>
            <small>${state.noticesGameId === selected.id && state.notices.length ? `${state.notices.length} 条` : state.noticesLoading && state.noticesGameId === selected.id ? '加载中…' : '展开'}</small>
            ${icon('chevron-down', 'start-notices-chevron')}
          </summary>
          <div class="start-notice-list">
            ${
              state.noticesGameId === selected.id && state.notices.length
                ? state.notices
                    .slice(0, 4)
                    .map(
                      (notice) => `
                      <button class="start-notice" data-action="open-external" data-url="${esc(notice.link)}">
                        <span>${esc(notice.title)}</span>
                        <small>${esc(noticeMeta(notice))}</small>
                      </button>`
                    )
                    .join('')
                : state.noticesLoading && state.noticesGameId === selected.id
                  ? '<p class="start-notice-empty">正在读取官方公告…</p>'
                  : '<p class="start-notice-empty">暂无公告，或这个渠道没有开放公告接口。</p>'
            }
          </div>
        </details>
      </div>
      <div class="start-games">
        <div class="start-games-head">
          <strong>${icon('chevron-down', 'start-games-chevron')}选择游戏</strong>
          <span class="start-games-mini-slot" id="start-mini-slot" aria-hidden="true"></span>
          <span>${state.games.length} 款 · 悬停展开</span>
        </div>
        <div class="start-game-rail">
          <button class="start-game-nav is-prev" type="button" tabindex="-1" aria-label="往前翻游戏">${icon('chevron-down', 'start-games-nav-icon')}</button>
          <div class="start-game-list">
          ${ordered
            .map((game) => {
              /*
               * 状态点必须三种状态都给全：老代码只在「运行中 / 已安装」时挂 class，
               * 新加进来还没配客户端的游戏就是一颗没样式的裸元素，看着像没画出来。
               * 现在 运行中 / 已就绪 / 未配置 各有一档，鼠标悬停也能读到文字。
               */
              const dot = game.running
                ? { cls: 'is-running', text: '运行中' }
                : game.installed
                  ? { cls: 'is-ready', text: '已就绪' }
                  : { cls: 'is-missing', text: game.builtin ? '未检测到安装' : '未配置启动程序' };
              return `
              <button class="start-game-thumb ${game.id === selected.id ? 'active' : ''}" data-action="start-select" data-id="${esc(game.id)}" title="${esc(`${game.name} · ${dot.text}`)}">
                <span class="start-game-media">
                  ${(game.startCoverUrl || game.coverUrl) ? `<img src="${esc(game.startCoverUrl || game.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover />` : `<span class="start-game-initial">${esc(initial(game.name))}</span>`}
                </span>
                <span class="start-game-copy">
                  <strong>${esc(game.name)}</strong>
                  ${game.running ? '<small>运行中</small>' : ''}
                </span>
                <span class="start-game-state ${dot.cls}" aria-label="${esc(dot.text)}"></span>
              </button>`;
            })
            .join('')}
          </div>
          <button class="start-game-nav is-next" type="button" tabindex="-1" aria-label="往后翻游戏">${icon('chevron-down', 'start-games-nav-icon')}</button>
        </div>
      </div>
      <button class="start-menu-scrim" data-action="start-server-menu" aria-label="关闭服务器选择"></button>
      ${startServerPanel(selected)}
    </div>`;
}

/**
 * 启动页的服务器选择器：只保留「当前服务器」一行，点开才展开完整列表。
 * 列表里点某个服 = 只切换（不启动游戏）；要进游戏用 dock 底部的「开始游戏」。
 * 切换、检测、硬链接、管理都在弹层里完成。
 */
/* 服务器面板是纯 DOM 开合，离开/切换时要主动把类名摘掉，否则下次进来是展开态。 */
function closeStartServerMenu() {
  state.startServerMenu = false;
  document.querySelector('.start-dock')?.classList.remove('is-menu-open');
  document.querySelector('.start-screen')?.classList.remove('dock-open');
}

/**
 * 服务器列表按 group 分组渲染（2.4.0 合并自对方分支）。
 * 明日方舟的国际服是 Yostar 发行的一组区域服（EN / JP / KR），
 * 它们平铺在一起会和「官服 / B服」混成六个平级条目，看不出层级关系。
 * 这里把同组的收进一个小标题下面，其余条目照原样平铺。
 */
function groupServersForDisplay(servers) {
  const GROUP_LABELS = { global: '国际服 · 选择区域' };
  const groups = [];
  const seen = new Map();
  for (const server of servers) {
    const key = server.group || '';
    if (!key) {
      groups.push({ key: 'solo-' + server.id, label: '', items: [server] });
      continue;
    }
    if (!seen.has(key)) {
      const entry = { key, label: GROUP_LABELS[key] || key, items: [] };
      seen.set(key, entry);
      groups.push(entry);
    }
    seen.get(key).items.push(server);
  }
  return groups;
}

/**
 * 启动页 dock 的主按钮区。
 * 已安装：单个「开始游戏」，行为一字不变。
 * 未安装的内置游戏：换成【下载游戏】+【自动检测】+【路径选择】三个动作 ——
 *   - 下载游戏：米哈游三游 / 崩坏3官服 / 终末地 / 明日方舟官服走官方渠道一键下载；
 *     异环没有公开下载接口，点开弹窗会如实说明并附官网入口；
 *   - 自动检测：复用 games:detect，扫注册表和常见目录找已装好的客户端；
 *   - 路径选择：手动指定启动程序（复用服务器编辑弹窗）。
 * 非内置游戏保持原来的「配置游戏」。
 */
function startDockDownloadActions(game) {
  if (game.installed) {
    // 有官方更新时主按钮让位给「更新游戏」，更新完自动变回「开始游戏」。
    // 状态来自 server.predownload（后台自动检测落盘），update = 本地落后正式版。
    const updating = state.gameUpdate && state.gameUpdate.gameId === game.id;
    if (updating) {
      return `<button class="start-dock-play is-updating" disabled title="正在更新，完成后自动变回开始游戏">
          ${icon('refresh', 'sm')}
          <span class="start-dock-update-label">${esc(state.gameUpdate.label || '正在更新…')}</span>
        </button>`;
    }
    const servers = game.servers || [];
    const server = servers.find((item) => item.active) || servers[0];
    const info = predownloadInfo(server);
    if (info && info.state === 'update') {
      const target = String(info.latestVersion || info.targetVersion || '');
      return `<button class="start-dock-play is-update" data-action="start-update-game" data-id="${esc(game.id)}" title="${target ? `下载并更新到 ${esc(target)}` : '下载并应用官方更新'}">
          ${icon('download')}
          <span class="start-dock-update-label">更新游戏</span>
        </button>`;
    }
    return `<button class="start-dock-play" data-action="start-selected" data-id="${esc(game.id)}">
        ${icon('play')}
        <span>开始游戏</span>
      </button>`;
  }
  if (!game.builtin) {
    return `<button class="start-dock-play" data-action="edit-game" data-id="${esc(game.id)}">
        ${icon('wrench')}
        <span>配置游戏</span>
      </button>`;
  }
  return `<div class="start-dock-dl-row">
      <button class="start-dock-play" data-action="download-game" data-id="${esc(game.id)}" title="从官方渠道下载并安装">
        ${icon('download')}
        <span>下载游戏</span>
      </button>
      <button class="start-dock-secondary" data-action="detect-game" data-id="${esc(game.id)}" title="扫描注册表和常见安装目录，找已经装好的客户端">
        ${icon('refresh')}
        <span>自动检测</span>
      </button>
      <button class="start-dock-secondary" data-action="start-pick-path" data-id="${esc(game.id)}" title="手动指定客户端启动程序">
        ${icon('folder')}
        <span>路径选择</span>
      </button>
    </div>`;
}

function startServerPanel(game) {
  const servers = game.servers || [];
  const active =
    servers.find((server) => server.id === game.activeServerId) || servers[0] || null;
  const status = active ? serverState(active) : null;
  const fileName = active && active.path ? active.path.split(/[\\/]/).pop() : '';
  const activeBlock = active ? serverBlockHint(active) : null;
  const ready = servers.filter((server) => server.exists && !server.incomplete).length;
  const open = Boolean(state.startServerMenu);

  const itemMarkup = (server) => {
    const state_ = serverState(server);
    const file = server.path ? server.path.split(/[\\/]/).pop() : '';
    const tag = serverChannelTag(game, server);
    const block = serverBlockHint(server);
    // 右边这枚小标签是「一眼看出状态」的那一眼；就绪态不写字（点已经是绿的），
    // 留白比「已就绪」三个字更干净，也能把宽度让给渠道和文件名
    const badge = server.active ? '当前' : state_.label;
    // 2.4.5：下拉行不再显示 exe 文件名——只有「没有文件」时才写短状态
    // （未选 exe / 告警块），有文件的行只留 渠道 tag，行高更矮
    const sub = file ? '' : (block ? block.short : '') || '';
    // 没装好的行点下去不是「切过去」，而是问「怎么把它补上」（硬链接 / 选路径 / 扫描）
    const usable = server.exists && !server.incomplete;
    return `
        <button class="start-server-item ${server.active ? 'is-active' : ''} ${
          usable ? '' : 'is-unavailable'
        } ${block ? 'is-broken sw-srv-unusable' : ''}"
          role="option" aria-selected="${server.active ? 'true' : 'false'}"
          data-action="${usable ? 'start-server-pick' : 'start-server-setup'}" data-game="${esc(game.id)}" data-server="${esc(server.id)}"
          title="${esc(block ? `${server.name} · ${block.text}` : server.path || server.packPath || server.name)}">
          <span class="start-server-item-dot ${state_.cls}"></span>
          <span class="start-server-item-copy">
            <strong>${esc(server.name)}${
              // 渠道跟在名字后面同一行：文件名会被截断，渠道不能跟着一起消失
              tag ? `<em class="sw-srv-tag">${esc(tag)}</em>` : ''
            }</strong>
            ${sub ? `<small>${esc(sub)}</small>` : ''}
          </span>
          ${badge ? `<em class="sw-srv-state ${state_.cls}">${esc(badge)}</em>` : ''}
          ${server.active ? `<span class="start-server-item-tick">${icon('check')}</span>` : ''}
          <span class="start-server-item-go" aria-hidden="true">${icon('chevron-right', 'xs')}</span>
        </button>`;
  };

  /*
   * 2.4.0 合并自对方分支：服务器列表按 group 分组渲染。
   * 明日方舟的国际服是 Yostar 发行的一组区域服（EN / JP / KR），
   * 它们平铺在一起会和「官服 / B服」混成六个平级条目，看不出层级关系。
   * 这里把同组的收进一个小标题下面，其余条目照原样平铺。
   */
  const items = groupServersForDisplay(servers)
    .map((group) => {
      const body = group.items.map(itemMarkup).join('');
      if (!group.label) return body;
      return `<div class="start-server-group">
          <div class="start-server-group-label">${esc(group.label)}</div>
          ${body}
        </div>`;
    })
    .join('');

  /*
   * 下拉里的「服务器列表」和「动作区」必须是两个兄弟节点。
   * 之前动作区用 position:sticky;bottom:0 钉在滚动区底部，实测直接把服务器行盖住了
   * （官服那行带告警块、比较高，B服/国际服被压在动作区下面，既看不见也点不到）。
   * 现在列表自己滚（.sw-srv-list），动作区在文档流里占固定高度。
   */
  return `
    <div class="start-dock${open ? ' is-menu-open' : ''}">
      <span class="start-dock-crest" aria-hidden="true"><img src="assets/sparxie.png" alt="" draggable="false" /></span>
      <span class="start-dock-charm" aria-hidden="true"><img src="assets/sparkle-mask.png" alt="" draggable="false" /></span>
      <span class="start-dock-sparks" aria-hidden="true"><i></i><i></i><i></i></span>
      <div class="start-server-anchor">
        <div class="start-dock-server-head">
          <span class="start-dock-label">服务器 <em>${ready} / ${servers.length} 可用</em></span>
        </div>
        <button class="start-server-pick" data-action="start-server-menu" aria-expanded="${open ? 'true' : 'false'}" title="展开服务器列表">
          <span class="start-server-pick-dot ${status ? status.cls : 'missing'}"></span>
          <span class="start-server-pick-copy">
            <strong>${esc(active ? active.name : '未配置服务器')}</strong>
            <small>${
              activeBlock
                ? `<span class="sw-srv-pick-bad">${esc(activeBlock.short)}</span>`
                : `${
                    active && serverChannelTag(game, active)
                      ? `<em class="sw-srv-tag">${esc(serverChannelTag(game, active))}</em>`
                      : ''
                  }${fileName ? '' : esc(status ? status.label : '还没有可用客户端')}`
            }</small>
          </span>
          <span class="start-server-pick-caret">${icon('chevron-down')}</span>
        </button>
        <div class="start-server-menu" role="listbox" aria-label="服务器列表">
              <div class="sw-srv-actions">
                ${
                  // 全都认出来了就没必要再「重新扫描」——那个按钮只在还没找全的时候才有用
                  ready < servers.length
                    ? `<button class="sw-srv-action" data-action="start-detect" data-game="${esc(game.id)}" title="刚装完游戏或挪过文件夹时，让启动器重新找一遍">
                  <span class="sw-srv-action-icon">${icon('refresh')}</span>
                  <span class="sw-srv-action-copy"><strong>重新扫描</strong></span>
                </button>`
                    : ''
                }
                <button class="sw-srv-action" data-action="start-server-manage" data-game="${esc(game.id)}" title="切换、重建、编辑 exe 路径、硬链接去重都在这里">
                  <span class="sw-srv-action-icon">${icon('settings')}</span>
                  <span class="sw-srv-action-copy"><strong>服务器管理</strong></span>
                </button>
              </div>
              <div class="sw-srv-list">${items || '<p class="start-server-empty">还没有服务器</p>'}</div>
        </div>
      </div>
      ${
        game.running
          ? `<div class="start-dock-running">
              <span class="start-dock-running-dot"></span>
              <span class="start-dock-running-copy">
                <strong>正在运行</strong>
                <small id="start-run-timer" data-since="${esc(String(game.runningSince || 0))}">00:00</small>
              </span>
              <button class="start-dock-stop" data-action="stop-game" data-id="${esc(game.id)}" title="结束游戏进程" aria-label="结束游戏进程">${icon('stop')}</button>
            </div>`
          : `${startDockPredownload(game)}${startDockDownloadActions(game)}`
      }
    </div>`;
}

/** 完整的服务器管理面板：复用 servers 页的每一行操作。 */
function openStartServerManager(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;
  const servers = game.servers || [];
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal modal-servers" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div class="ms-head">
            <h2>服务器 · ${esc(game.name)}</h2>
            <span class="ms-count"><strong>${servers.filter((server) => server.exists && !server.incomplete).length}</strong> 可用 · <strong>${servers.filter((server) => !server.exists || server.incomplete).length}</strong> 待处理</span>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          ${
            game.builtinKey === 'neverness'
              ? nteChannelMarkup(game, servers.find((item) => item.active) || servers[0])
              : ''
          }
          <div class="server-list" id="server-manager-list" data-game="${esc(game.id)}">${servers.map((server) => serverRow(game, server)).join('') || '<p class="gacha-empty-line">还没有服务器</p>'}</div>
        </div>
        <div class="modal-foot ms-foot">
          <div class="ms-actions">
            <button class="btn btn-ghost btn-sm" data-action="start-detect" data-game="${esc(game.id)}" title="重新扫描安装目录，找已经装好的客户端">${icon('refresh')}重新扫描</button>
            <button class="btn btn-ghost btn-sm" data-action="start-link" data-game="${esc(game.id)}" title="两个客户端里完全相同的文件只留一份，省下重复占的空间">${icon('link')}硬链接去重</button>
            <button class="btn btn-ghost btn-sm" data-action="start-server-guide" data-game="${esc(game.id)}" title="切换服务器会做什么、需要你准备什么">${icon('alert')}切换说明</button>
            ${game.builtin ? '' : `<button class="btn btn-ghost btn-sm" data-action="add-server" data-game="${esc(game.id)}">${icon('plus')}添加服务器</button>`}
          </div>
          <button class="btn btn-primary btn-sm" data-action="start-server-done" data-game="${esc(game.id)}">完成</button>
        </div>
      </div>
    </div>
  `);
  // 渠道和预下载状态都是外部读来的，弹窗建好后再补，不阻塞打开
  if (game.builtinKey === 'neverness') refreshNtePanel();
  autoCheckPredownload(game);
}

/* ------------------------------------------------------------------ */
/* 切换服务器的第一次引导                                              */
/* ------------------------------------------------------------------ */

/**
 * 没装过的那个服，点它先问一句「怎么补上这份客户端」。
 *
 * 原来的行为是一步到位：官方渠道直接进硬链接安装，其它渠道直接开「选路径」。
 * 问题是用户手里到底是「已经装了、只是没告诉启动器」还是「根本还没下」，
 * 启动器猜不出来 —— 猜错就是白等一个几十分钟的安装，或者对着文件选择框发愣。
 *
 * 三条路摊开写清楚代价：硬链接最省空间（但要有源）、选路径最快（已经装好了）、
 * 自动扫描不用记路径。选完才真正进各自动作，弹窗自己先关掉。
 */
function openServerSetupDialog(gameId, serverId) {
  const game = state.games.find((item) => item.id === gameId);
  const server = game && (game.servers || []).find((item) => item.id === serverId);
  if (!game || !server) return;
  // 能当硬链接源的：别的渠道、文件真的还在
  const bases = (game.servers || []).filter(
    (item) =>
      item.id !== server.id && item.exists && !item.incomplete && item.channel !== server.channel
  );
  const canLink = bases.length > 0;
  const baseNames = bases.map((item) => item.name).join(' / ');
  openModal(
    `<div class="modal-backdrop" data-backdrop>
      <div class="modal narrow modal-setup" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>${esc(server.name)}</h2>
            <p>${esc(game.name)} · 这个服还没有能启动的客户端</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <ul class="setup-pick">
            <li>
              <button class="setup-opt" data-setup="link" ${canLink ? '' : 'disabled'}>
                <span class="setup-opt-icon">${icon('link')}</span>
                <span class="setup-opt-copy">
                  <strong>硬链接生成一份</strong>
                  <small>${
                    canLink
                      ? `以「${esc(baseNames)}」为源，一样的文件直接复用，只下差异部分`
                      : '本机还没有别的渠道客户端可以当源'
                  }</small>
                </span>
                <span class="setup-opt-go">${icon('chevron-right')}</span>
              </button>
            </li>
            <li>
              <button class="setup-opt" data-setup="path">
                <span class="setup-opt-icon">${icon('folder-open')}</span>
                <span class="setup-opt-copy">
                  <strong>选择已经装好的客户端</strong>
                  <small>${esc(server.name)} 其实装过了，手动指到它的 exe</small>
                </span>
                <span class="setup-opt-go">${icon('chevron-right')}</span>
              </button>
            </li>
            <li>
              <button class="setup-opt" data-setup="scan">
                <span class="setup-opt-icon">${icon('refresh')}</span>
                <span class="setup-opt-copy">
                  <strong>自动扫描一遍</strong>
                  <small>在常见安装目录里找 ${esc(server.name)} 的客户端</small>
                </span>
                <span class="setup-opt-go">${icon('chevron-right')}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>`
  );
  dom.modalRoot.querySelectorAll('[data-setup]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const choice = btn.dataset.setup;
      closeModal();
      if (choice === 'link') {
        openSophonModal(gameId, serverId, 'prepare');
        return;
      }
      if (choice === 'path') {
        openServerModal(gameId, serverId);
        return;
      }
      const result =
        typeof api.games?.detectServer === 'function'
          ? await api.games.detectServer(gameId, serverId)
          : await api.games.detect(gameId);
      if (result && result.ok) {
        toast(`${server.name} 已找到，路径已填好`, 'success');
      } else {
        toast((result && result.error) || '没找到这个服的客户端，可以手动选路径', 'info');
      }
    });
  });
}


const SERVER_SWITCH_GUIDE_KEY = 'vela:server-switch-guide';

/** 切换说明的每一条：都是「换之前要知道的」，一句一件事。 */
/* 三步讲清「怎么换」：顺序就是用户真正要做的顺序，别的都算补充说明 */
const SERVER_SWITCH_GUIDE_STEPS = [
  {
    title: '先把游戏关掉',
    text: '开着的时候切换会被拦下来：客户端文件正被占用，切过去也起不来。',
  },
  {
    title: '点一下要换到的服务器',
    text: '只列已经装好的。灰掉的那些点进去是去做准备，不会开始下载。',
  },
  {
    title: '看到「当前」跳过去就好了',
    text: '再点开始游戏，启动的就是它的客户端。第一次进游戏要重新登录。',
  },
];

/* 容易误会的事：两句，短到一眼扫完 */
const SERVER_SWITCH_GUIDE_POINTS = [
  '各渠道的账号、存档、更新包互不相通，换过去要重新登录。',
  '同一个客户端文件夹别被两行同时占：删掉它，两边一起失效。',
];

function serverSwitchGuideSeen() {
  try {
    return localStorage.getItem(SERVER_SWITCH_GUIDE_KEY) === '1';
  } catch {
    // 隐私模式读不到存储，就当没看过——多弹一次比一次不弹好
    return false;
  }
}

function markServerSwitchGuideSeen() {
  try {
    localStorage.setItem(SERVER_SWITCH_GUIDE_KEY, '1');
  } catch {
    /* 写不进去就算了，大不了下次再弹一遍 */
  }
}

/**
 * 「切换服务器是怎么回事」的说明卡。
 * 第一次在启动页切换成功后自动弹一次；以后想看，从「服务器管理」里的
 * 「切换说明」进，关掉后回到管理面板，不把人晾在原地。
 */
function openServerSwitchGuide({ returnToManager = '' } = {}) {
  openModal(
    `<div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="server-guide-title">
        <div class="modal-head">
          <div>
            <h2 id="server-guide-title">怎么换服务器</h2>
            <p>以后想再看，在「服务器管理」里点「切换说明」。</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <ol class="switch-guide-steps">
            ${SERVER_SWITCH_GUIDE_STEPS.map(
              (step, index) => `
              <li class="switch-guide-step">
                <span class="switch-guide-num">${index + 1}</span>
                <div class="switch-guide-copy">
                  <strong>${esc(step.title)}</strong>
                  <p>${esc(step.text)}</p>
                </div>
              </li>`
            ).join('')}
          </ol>
          <ul class="switch-guide-notes">
            ${SERVER_SWITCH_GUIDE_POINTS.map((text) => `<li>${esc(text)}</li>`).join('')}
          </ul>
        </div>
        <div class="modal-foot">
          <button class="btn btn-primary" data-close>知道了</button>
        </div>
      </div>
    </div>`,
    {
      onClose: () => {
        if (returnToManager) openStartServerManager(returnToManager);
      },
    }
  );
}

/** 真切换成功之后才调：没看过就弹一次，顺手记下已经看过。 */
function showServerSwitchGuideOnce() {
  if (serverSwitchGuideSeen()) return;
  markServerSwitchGuideSeen();
  openServerSwitchGuide();
}

/** 让暂停按钮的图标和文案跟着视频状态走。 */
/**
 * 开始页的运行计时：游戏跑起来后，开始按钮的位置改显示「已运行 时:分:秒」，
 * 跟 Starward 一样让人一眼看到这局跑了多久。
 */
function syncStartRunningTimer() {
  const el = document.querySelector('#start-run-timer');
  if (!el) return false;
  const since = Number(el.dataset.since || 0);
  if (!since) return false;
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  el.textContent = hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
  return true;
}

let startRunTimerId = null;

function stopStartRunningTimer() {
  if (startRunTimerId) clearInterval(startRunTimerId);
  startRunTimerId = null;
}

function startStartRunningTimer() {
  stopStartRunningTimer();
  if (!syncStartRunningTimer()) return;
  startRunTimerId = setInterval(() => {
    if (!syncStartRunningTimer()) stopStartRunningTimer();
  }, 1000);
}

function restoreStartVideoState() {
  const video = liveStartVideo();
  if (!video) return;
  const gameId = state.startGameId || (state.games[0] && state.games[0].id) || '';
  const paused = wasStartVideoPaused(gameId);

  // 只有用户主动暂停过才保持暂停；
  // 因为离开启动页（DOM 重建 / 页面切走）浏览器也会触发 pause，
  // 那种情况不算「用户暂停」，回来时要继续播放。
  if (paused) {
    video.pause();
    updateStartVideoToggle(true);
  } else {
    video.play().catch(() => {});
    updateStartVideoToggle(false);
  }

  if (video.dataset.pauseBound !== '1') {
    video.dataset.pauseBound = '1';
    video.addEventListener('pause', () => {
      updateStartVideoToggle(true);
      // 只有用户点击过暂停按钮，才记为「手动暂停」
      if (video.dataset.userPaused === '1') {
        rememberStartVideoPaused(state.startGameId || '', true);
      }
    });
    video.addEventListener('play', () => {
      video.dataset.userPaused = '0';
      updateStartVideoToggle(false);
      rememberStartVideoPaused(state.startGameId || '', false);
    });
  }
}

function updateStartVideoToggle(paused) {
  const use = document.querySelector('#start-video-use');
  if (use) use.setAttribute('href', paused ? '#i-play' : '#i-pause');
  const button = document.querySelector('[data-action="toggle-start-video"]');
  if (button) {
    button.classList.toggle('is-paused', Boolean(paused));
    button.title = paused ? '继续播放动态背景' : '暂停动态背景';
  }
}

/** 启动页背景视频的暂停状态记忆（每个游戏独立）。 */
const START_VIDEO_PAUSED_KEY = 'vela:start-video-paused';

function rememberStartVideoPaused(gameId, paused) {
  try {
    const raw = JSON.parse(localStorage.getItem(START_VIDEO_PAUSED_KEY) || '{}');
    const map = raw && typeof raw === 'object' ? raw : {};
    map[gameId] = Boolean(paused);
    localStorage.setItem(START_VIDEO_PAUSED_KEY, JSON.stringify(map));
  } catch {
    /* 可选记忆 */
  }
}

function wasStartVideoPaused(gameId) {
  try {
    const map = JSON.parse(localStorage.getItem(START_VIDEO_PAUSED_KEY) || '{}');
    return Boolean(map && map[gameId]);
  } catch {
    return false;
  }
}

/**
 * 花火 / 火花：官方透明立绘（1306 / 1501），摆在主页当后台双人卡。
 *
 * 这两张卡不是纯摆设：
 *   花火 = 游戏快启：显示最近游玩的封面和名字，点一下直接开那个游戏；
 *   火花 = 音乐遥控：显示正在播的歌，卡上自带 上一首/播放暂停/下一首 三个键，
 *          连了直播点歌还会亮牌子；点卡身其它位置进点歌台。
 * 数据都取自本机现有状态，播放键图标由 updateSongChrome() 在 play/pause 事件里同步。
 */
function characterDuoMarkup() {
  const recent =
    [...state.games]
      .filter((game) => game.lastPlayed)
      .sort((a, b) => new Date(b.lastPlayed || 0) - new Date(a.lastPlayed || 0))[0] ||
    state.games[0] ||
    null;
  const totalSeconds = state.games.reduce((sum, game) => sum + (game.playSeconds || 0), 0);
  const song = currentSongEntry();
  const songTitle = song ? String(song.title || song.name || '') : '';
  const songArtist = song ? String(song.artist || song.singer || '') : '';
  // 这里必须自己取一次 audio：它只是别处函数里的局部变量，
  // 直接写 audio.src 会在渲染主页时抛 "audio is not defined"，整个主页都切不过去。
  const audio = document.querySelector('#song-audio');
  const playing = Boolean(song) && Boolean(audio && audio.src) && Boolean(audio && !audio.paused);
  const queue = state.songs.length;
  const liveCount = Array.isArray(state.liveRooms) ? state.liveRooms.length : 0;

  const gameSub = recent
    ? `累计 ${formatPlaytime(totalSeconds)} · 点一下接着演`
    : '在游戏库里挑一个开场吧';
  const songSub = song
    ? `${playing ? '正在播放' : '已暂停'}${songArtist ? ' · ' + songArtist : ''} · 队列 ${queue} 首`
    : `队列 ${queue} 首 · 点一下去点歌`;

  const gameBody = recent
    ? `<span class="duo-game">
        ${
          recent.coverUrl
            ? `<img class="duo-game-cover" src="${esc(recent.coverUrl)}" alt="" referrerpolicy="no-referrer" />`
            : `<span class="duo-game-cover is-initial">${esc(initial(recent.name))}</span>`
        }
        <span class="duo-game-name">${esc(recent.name)}</span>
        ${recent.running ? '<span class="duo-live is-running">运行中</span>' : ''}
      </span>
      <small class="duo-note">累计 ${formatPlaytime(totalSeconds)} · 点击直接启动</small>`
    : '<small class="duo-note">先去游戏库添加一款游戏</small>';

  const songBody = `
    <span class="duo-song-line" id="duo-song-title">${esc(song ? songTitle || '未知曲目' : '队列空着，去点歌')}</span>
    <span class="duo-controls">
      <span class="duo-ctrl" data-action="duo-prev" title="上一首">${icon('chevron-left', 'xs')}</span>
      <span class="duo-ctrl is-main" data-action="duo-toggle" title="${playing ? '暂停' : '播放'}">
        <span class="duo-ic" data-when="play"${playing ? ' hidden' : ''}>${icon('play')}</span>
        <span class="duo-ic" data-when="pause"${playing ? '' : ' hidden'}>${icon('pause')}</span>
      </span>
      <span class="duo-ctrl" data-action="duo-next" title="下一首">${icon('chevron-right', 'xs')}</span>
      ${liveCount ? `<span class="duo-live">${icon('mic', 'xs')}直播点歌 × ${liveCount}</span>` : ''}
    </span>
    <small class="duo-note">${songArtist ? esc(songArtist) + ' · ' : ''}队列 ${queue} 首</small>`;

  return `
    <div class="char-duo">
      <button type="button" class="char-duo-card is-sparkle" data-action="duo-game" title="${esc(gameSub)}"${
        recent ? ` data-game="${esc(recent.id)}"` : ''
      }>
        <img src="assets/sparkle-fullbody.png" alt="花火" />
        <span class="char-duo-copy">
          <strong>花火 <i class="duo-tag">游戏快启</i></strong>
          <span class="char-duo-stat">${gameBody}</span>
        </span>
      </button>
      <button type="button" class="char-duo-card is-sparxie" data-action="duo-song" title="${esc(songSub)}">
        <img src="assets/sparxie-fullbody.png" alt="火花" />
        <span class="char-duo-copy">
          <strong>火花 <i class="duo-tag">音乐遥控</i></strong>
          <span class="char-duo-stat">${songBody}</span>
        </span>
      </button>
    </div>
  `;
}

function homePlaytimeMarkup() {
  const ordered = [...state.games].sort(
    (a, b) =>
      (b.playSeconds || 0) - (a.playSeconds || 0) ||
      new Date(b.lastPlayed || b.createdAt || 0) - new Date(a.lastPlayed || a.createdAt || 0)
  );
  const total = ordered.reduce((sum, game) => sum + (game.playSeconds || 0), 0);
  const launches = ordered.reduce((sum, game) => sum + (game.launchCount || 0), 0);
  const playedCount = ordered.filter((game) => (game.playSeconds || 0) > 0).length;
  const maxSeconds = Math.max(1, ...ordered.map((game) => game.playSeconds || 0));
  /*
   * 主页紧凑化：整个统计区改成 <details> 折叠条，默认收起只留一行摘要，
   * 数字全部内联在摘要里；展开后仍是原来的 KPI 卡和逐款明细，数据一点不丢。
   */
  return `
    <details class="home-stats" id="home-stats">
      <summary class="home-stats-summary">
        <span class="home-stats-title">游玩统计</span>
        <span class="home-stats-brief">累计 <strong>${formatPlaytime(total)}</strong> · ${launchedLabel(launches)} · ${ordered.length} 款游戏${total ? ` · 已游玩 ${playedCount} 款` : ''}</span>
        <span class="home-stats-hint">点开看明细</span>
      </summary>
      <div class="playtime-summary">
        <div class="playtime-total">
          <span>累计游玩</span>
          <strong>${formatPlaytime(total)}</strong>
          <small>${launchedLabel(launches)} · ${ordered.length} 款游戏</small>
        </div>
        <div class="playtime-kpi"><strong>${launches}</strong><span>总启动次数</span></div>
        <div class="playtime-kpi"><strong>${playedCount}</strong><span>已游玩游戏</span></div>
      </div>
      <div class="playtime-list">
        ${ordered
          .map((game) => {
            const seconds = game.playSeconds || 0;
            const percent = Math.max(0, Math.min(100, (seconds / maxSeconds) * 100));
            return `
              <article class="playtime-row ${game.running ? 'is-running' : ''}">
                <span class="playtime-cover" data-initial="${esc(initial(game.name))}">
                  ${game.coverUrl ? `<img src="${esc(game.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover />` : esc(initial(game.name))}
                </span>
                <div class="playtime-main">
                  <div class="playtime-name"><strong>${esc(game.name)}</strong>${game.running ? '<span class="playtime-running"><i></i>运行中</span>' : ''}</div>
                  <small>${esc(relativeDate(game.lastPlayed))} · ${game.launchCount || 0} 次启动</small>
                  <span class="playtime-bar"><i style="width:${percent}%"></i></span>
                </div>
                <div class="playtime-value">
                  <strong>${formatPlaytime(seconds)}</strong>
                  <small>${seconds ? `占比 ${Math.round((seconds / total) * 100)}%` : '未游玩'}</small>
                </div>
              </article>`;
          })
          .join('')}
      </div>
    </details>`;
}

function launchedLabel(count) {
  return count ? `${count} 次启动` : '还没有启动记录';
}

function homeView() {
  const name = state.settings.profileName || '大小姐';
  const mood = homeMood();
  const recent = [...state.games]
    .sort((a, b) => new Date(b.lastPlayed || b.createdAt || 0) - new Date(a.lastPlayed || a.createdAt || 0))
    .slice(0, 3);
  const demoCount = state.games.filter((game) => game.demo).length;
  const installedCount = state.games.filter((game) => game.installed).length;
  const favoriteCount = state.games.filter((game) => game.favorite).length;
  const playSeconds = state.games.reduce((sum, game) => sum + (game.playSeconds || 0), 0);
  const ratio = state.games.length ? Math.round((installedCount / state.games.length) * 100) : 0;

  const head = `
    <div class="page-head">
      <div>
        <div class="eyebrow">${PAGE_META.home.eyebrow}</div>
        <h1>${mood.greeting}，${esc(name)}</h1>
        <p class="sub">${mood.sub}</p>
      </div>
      <div class="page-head-actions">
        <button class="btn btn-ghost" data-action="create-desktop-shortcut" title="在桌面创建花筱灵启动器快捷方式">${icon('monitor')}创建桌面快捷</button>
        <button class="btn btn-primary" data-action="add-game">${icon('plus')}添加游戏</button>
      </div>
    </div>`;

  if (!state.games.length) {
    return `
      <div class="page home-page">
        ${head}
        <div class="empty">
          <div class="empty-char" aria-hidden="true"><img src="assets/character-face.png" alt="" /></div>
          <div class="empty-icon">${icon('gamepad')}</div>
          <h3>把第一款游戏放进来</h3>
          <p>选择游戏的启动程序，挑一张封面，剩下的交给花筱灵。游戏资料、游玩时长和设置都只保存在这台电脑上。</p>
          <button class="btn btn-primary" data-action="add-game">${icon('plus')}添加我的第一款游戏</button>
        </div>
        ${
          state.news.length
            ? `<div class="section-head"><div><h3>最新动态</h3><p>使用指南与更新记录</p></div><button class="link-btn" data-nav="news">全部动态 ${icon('chevron-right')}</button></div>
               <div class="news-grid">${state.news.slice(0, 3).map(newsCard).join('')}</div>`
            : ''
        }
      </div>`;
  }

  return `
    <div class="page home-page">
      ${head}
      ${stageHero(recent[0], mood)}
      ${
        demoCount
          ? `<div class="notice">
              ${icon('sparkle')}
              <span>库中还有 <strong>${demoCount}</strong> 个示例条目，它们不会真的启动。添加你自己的游戏，或者清空示例重新开始。</span>
              <span class="notice-actions">
                <button class="link-btn" data-action="clear-demo">清空示例</button>
                <button class="link-btn" data-action="add-game" style="color:var(--accent)">添加游戏 ${icon('chevron-right')}</button>
              </span>
            </div>`
          : ''
      }
      ${librarySectionMarkup()}
      ${homePlaytimeMarkup()}
      <div class="section-head home-news-head">
        <div><h3>最新动态</h3></div>
        <button class="link-btn" data-nav="news">全部动态 ${icon('chevron-right')}</button>
      </div>
      <div class="home-news-list">${state.news.slice(0, 3).map(homeNewsRow).join('')}</div>
      ${characterDuoMarkup()}
    </div>`;
}

/* ------------------------------------------------------------------ */
/* library                                                             */
/* ------------------------------------------------------------------ */

function librarySectionMarkup() {
  const filters = [
    ['all', '全部'],
    ['favorite', '收藏'],
    ['installed', '已安装'],
  ];
  return `
    <section class="home-library" id="home-library">
      <div class="section-head home-library-head">
        <div><h3>游戏库</h3></div>
        <div class="home-library-actions">
          <button class="btn btn-ghost btn-icon" data-action="sync-official" title="同步官网版本与封面">${icon('sparkle')}</button>
          <button class="btn btn-ghost btn-icon" data-action="detect-all" title="自动检测已安装游戏">${icon('refresh')}</button>
          <button class="btn btn-primary" data-action="add-game">${icon('plus')}添加游戏</button>
        </div>
      </div>
      <div class="library-toolbar">
        <label class="search-box">
          ${icon('search')}
          <input id="game-search" type="text" placeholder="搜索游戏、标签或简介…" value="${esc(state.search)}" autocomplete="off" spellcheck="false" />
          <button class="search-clear" data-action="clear-search" title="清除搜索" style="${state.search ? '' : 'display:none'}">${icon('x')}</button>
        </label>
        <div class="chips">
          ${filters
            .map(
              ([key, label]) =>
                `<button class="chip ${state.filter === key ? 'active' : ''}" data-action="set-filter" data-value="${key}">${label}</button>`
            )
            .join('')}
        </div>
        <div class="toolbar-right">
          <select class="select" id="sort-select" aria-label="排序方式">
            <option value="recent" ${state.sort === 'recent' ? 'selected' : ''}>最近游玩</option>
            <option value="added" ${state.sort === 'added' ? 'selected' : ''}>最近添加</option>
            <option value="name" ${state.sort === 'name' ? 'selected' : ''}>名称排序</option>
          </select>
        </div>
      </div>
      <div id="library-results">${libraryResultsMarkup()}</div>
    </section>`;
}

function gameCard(game) {
  const running = game.running;
  const action = running
    ? 'stop-game'
    : game.installed
      ? 'launch-game'
      : game.builtin
        ? 'detect-game'
        : 'edit-game';
  const actionLabel = running ? '停止' : game.installed ? '启动' : game.builtin ? '检测' : '配置';
  const actionIcon = running ? 'stop' : game.installed ? 'play' : game.builtin ? 'refresh' : 'wrench';
  const tags = (game.tags || []).slice(0, 2);
  const activeServer = (game.servers || []).find((server) => server.id === game.activeServerId);
  return `
    <article class="game-card" data-id="${esc(game.id)}">
      <div class="game-cover ${game.coverUrl ? '' : 'no-img'}" data-initial="${esc(initial(game.name))}" style="--accent:${esc(/^#[0-9a-f]{6}$/i.test(game.accent || '') ? game.accent : '#f08ba6')}">
        ${game.coverUrl ? `<img src="${esc(game.coverUrl)}" alt="${esc(game.name)} 封面" loading="lazy" decoding="async" draggable="false" referrerpolicy="no-referrer" data-cover />` : ''}
        <div class="cover-top">
          <span style="display:flex;gap:5px;flex-wrap:wrap">
            ${game.demo ? '<span class="badge demo">示例</span>' : ''}
            ${game.builtin && !game.installed ? '<span class="badge">待检测</span>' : ''}
            ${running ? '<span class="badge running"><span class="dot"></span>运行中</span>' : ''}
          </span>
          <button class="fav-btn ${game.favorite ? 'on' : ''}" data-action="toggle-fav" data-id="${esc(game.id)}" title="${game.favorite ? '取消收藏' : '加入收藏'}" aria-label="${game.favorite ? '取消收藏' : '加入收藏'}">
            ${icon('star', game.favorite ? 'fill' : '')}
          </button>
        </div>
        <div class="cover-actions">
          <button class="card-play ${game.installed || running ? '' : 'configure'}" data-action="${action}" data-id="${esc(game.id)}">
            ${icon(actionIcon)}${actionLabel}
          </button>
          <button class="card-tool" data-action="change-cover" data-id="${esc(game.id)}" title="更换封面">${icon('image')}</button>
          <button class="card-tool" data-action="edit-game" data-id="${esc(game.id)}" title="编辑游戏">${icon('edit')}</button>
          ${cardPredownloadEntry(game)}
          ${game.builtin ? '' : `<button class="card-tool danger" data-action="delete-game" data-id="${esc(game.id)}" title="从游戏库移除">${icon('trash')}</button>`}
        </div>
      </div>
      <div class="game-info">
        <div class="game-title">${esc(game.name)}</div>
        <div class="game-sub">${esc(game.subtitle || game.description || '等待补充一点介绍')}</div>
        <div class="game-meta">
          ${activeServer ? `<span>${esc(activeServer.name)}</span><span class="sep"></span>` : ''}
          ${game.version ? `<span>v${esc(game.version)}</span><span class="sep"></span>` : game.versionName ? `<span>${esc(game.versionName)}</span><span class="sep"></span>` : ''}
          ${tags.length ? `<span>${esc(tags.join(' · '))}</span>` : `<span>${game.installed ? '已安装' : '未配置'}</span>`}
          <span class="sep"></span>
          <span>${running ? '<span class="running-text">正在运行</span>' : game.builtin && !game.installed ? '未检测到安装' : esc(relativeDate(game.lastPlayed))}</span>
        </div>
      </div>
    </article>`;
}

function renderQuickPanel() {
  const panel = document.querySelector('#quick-panel');
  const list = document.querySelector('#quick-list');
  if (!panel || !list) return;
  const pinned = state.settings.quickPanelPinned === true;
  if (pinned) quickOpen = true;
  panel.hidden = !quickOpen;
  const pin = panel.querySelector('.quick-pin');
  if (pin) pin.classList.toggle('on', pinned);
  const games = state.games
    .map((game) => ({
      game,
      servers: (game.servers || []).filter((server) => server.exists),
    }))
    .filter((item) => item.servers.length);
  if (!games.length) {
    list.innerHTML = '<div class="quick-empty">还没有已配置的服务器。<br />先在服务器页配置一个客户端。</div>';
    return;
  }
  list.innerHTML = games
    .map(
      ({ game, servers }) => `
      <div class="quick-game">
        <div class="quick-game-name">${esc(game.name)}</div>
        ${servers
          .map(
            (server) => `
          <button class="quick-server ${server.active ? 'active' : ''}" data-action="quick-launch" data-game="${esc(
            game.id
          )}" data-server="${esc(server.id)}" title="启动 ${esc(server.name)}">
            <span class="dot"></span>
            <span>${esc(server.name)}</span>
            ${icon('play')}
          </button>`
          )
          .join('')}
      </div>`
    )
    .join('');
}

function libraryResultsMarkup() {
  const games = filteredGames();
  if (!games.length) {
    if (!state.games.length) {
      return `<div class="empty">
        <div class="empty-icon">${icon('library')}</div>
        <h3>游戏库还是空的</h3>
        <p>添加已安装的游戏，封面、标签、版本和启动参数都可以慢慢补。每次启动的时长也会被记下来。</p>
        <button class="btn btn-primary" data-action="add-game">${icon('plus')}添加游戏</button>
      </div>`;
    }
    return `<div class="empty">
      <div class="empty-icon">${icon('search')}</div>
      <h3>没有找到匹配的游戏</h3>
      <p>换一个关键词，或者清除筛选条件再看看。</p>
      <button class="btn btn-ghost" data-action="clear-filters">清除筛选</button>
    </div>`;
  }
  return `<div class="game-grid">${games.map(gameCard).join('')}</div>`;
}

function libraryView() {
  const games = filteredGames();
  const filters = [
    ['all', '全部'],
    ['favorite', '收藏'],
    ['installed', '已安装'],
  ];
  return `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">${PAGE_META.library.eyebrow}</div>
          <h1>游戏库 <span class="count">${state.games.length} 款</span></h1>
          <p class="sub">管理本地游戏、封面和启动路径。内置游戏会自动检测，其他游戏可以手动添加。</p>
        </div>
        <div class="page-head-actions">
          <button class="btn btn-ghost btn-icon" data-action="sync-official" title="同步官网版本与封面">${icon('sparkle')}</button>
          <button class="btn btn-ghost btn-icon" data-action="detect-all" title="自动检测已安装游戏">${icon('refresh')}</button>
          <button class="btn btn-primary" data-action="add-game">${icon('plus')}添加游戏</button>
        </div>
      </div>
      <div class="library-toolbar">
        <label class="search-box">
          ${icon('search')}
          <input id="game-search" type="text" placeholder="搜索游戏、标签或简介…" value="${esc(state.search)}" autocomplete="off" spellcheck="false" />
          <button class="search-clear" data-action="clear-search" title="清除搜索" style="${state.search ? '' : 'display:none'}">${icon('x')}</button>
        </label>
        <div class="chips">
          ${filters
            .map(
              ([key, label]) =>
                `<button class="chip ${state.filter === key ? 'active' : ''}" data-action="set-filter" data-value="${key}">${label}</button>`
            )
            .join('')}
        </div>
        <div class="toolbar-right">
          <select class="select" id="sort-select" aria-label="排序方式">
            <option value="recent" ${state.sort === 'recent' ? 'selected' : ''}>最近游玩</option>
            <option value="added" ${state.sort === 'added' ? 'selected' : ''}>最近添加</option>
            <option value="name" ${state.sort === 'name' ? 'selected' : ''}>名称排序</option>
          </select>
        </div>
      </div>
      <div id="library-results">${libraryResultsMarkup()}</div>
      <div class="panel-sub" style="margin-top:18px">${games.length} 个结果</div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* servers                                                             */
/* ------------------------------------------------------------------ */

function serverState(server) {
  if (server.incomplete) return { label: '需要重建', cls: 'missing' };
  if (server.active && server.exists) return { label: '当前服务器', cls: 'active' };
  // 「已经就绪」是正常态，不用再写三个字：左边的点已经是绿的，
  // 状态徽标只留给「要用户动手」的那几种（需要重建 / 目录丢失 / 未配置）。
  if (server.exists) return { label: '', cls: 'ready' };
  // 目录本身都没了：和「从没配过路径」是两回事，状态文案得分开
  if (server.root && server.rootExists === false) return { label: '目录丢失', cls: 'missing' };
  return { label: '未配置', cls: 'missing' };
}

/**
 * 渠道短名（官服 / B服 / 国际服 …）。
 *
 * 内置渠道的服务器名本身就叫「官服」「B服」，再贴一个同名标签只是噪音，
 * 所以名字已经写着渠道时返回空串；只有玩家自己加的行才需要标出来。
 */
function serverChannelTag(game, server) {
  if (!server || !server.channel) return '';
  const tags = {
    // 终末地官方口径叫「国服」，和原神那套「官服」不是一回事
    official: '官服',
    bilibili: 'B服',
    global: '国际服',
    play: 'Play',
    steam: 'Steam',
    custom: '自建',
  };
  const tag = tags[server.channel] || '';
  return tag && tag !== server.name ? tag : '';
}

/**
 * 服务器行左侧的图标。
 *
 * 参考图里每个服务器是一枚「图标 + 粗体字」的大按钮，图标是识别第一眼，
 * 所以按渠道分：官方=盾牌、B服=火花（渠道）、国际服=月/地球感、Play=播放、
 * Steam=下载、自建=服务器。认不出来就退回通用服务器图标。
 */
function serverIconId(server) {
  const channel = server && server.channel ? String(server.channel) : '';
  const name = server && server.name ? String(server.name) : '';
  const pick = (...keys) => keys.some((key) => name.includes(key) || channel.includes(key));
  if (channel === 'official' || pick('官方', '官服', 'official')) return 'shield';
  if (channel === 'bilibili' || pick('bilibili', 'B服')) return 'sparkle';
  if (channel === 'global' || pick('国际', 'global')) return 'moon';
  if (channel === 'play' || pick('play')) return 'play';
  if (channel === 'steam' || pick('steam')) return 'download';
  if (channel === 'custom' || pick('自建', 'custom')) return 'server';
  return 'server';
}

/**
 * 这一行为什么用不了、下一步该点哪。
 *
 * 只说「未配置」玩家分不清是没装游戏、没选 exe，还是上次生成到一半，
 * 于是只能在几个菜单之间乱点 —— 这里把原因和去处分两行写清楚。
 */
function serverBlockHint(server) {
  if (!server) return null;
  /*
   * text 是「说清楚发生了什么」，short 是「塞得进行内的四五个字」。
   * 下拉列表里一行只留 short，长句只留给 toast —— 之前每行下面挂一整块
   * 「点这一行 → 服务器管理 → 编辑 → 选 exe」，三行服务器就堆出六行字，
   * 整个列表看着像说明书。
   */
  if (server.incomplete) {
    return {
      text: '客户端不完整（文件缺失），现在启动会失败',
      short: '客户端不完整',
      next: '点这一行 → 服务器管理 → 重建',
    };
  }
  if (!server.exists) {
    /*
     * 「exe 不在」有两种原因，以前都说成「还没选择启动程序」。
     * 用户删了共用目录之后看到这句话完全对不上号 —— 他明明选过路径，
     * 只是那个目录被删/挪走了。所以这里按 root 还在不在分两句说。
     */
    if (server.root && server.rootExists === false) {
      return {
        text: '客户端目录已经不见了（被删除或移动过）',
        short: '目录已不在',
        next: '点「编辑」重新指定目录；文件真没了就点「重建」用其它渠道客户端生成',
      };
    }
    return {
      text: '还没选择启动程序（.exe）',
      short: '未选 exe',
      next: '点这一行 → 服务器管理 → 编辑 → 选 exe',
    };
  }
  return null;
}

/**
 * 这个服务器和同一游戏里的谁共用同一个安装目录。
 *
 * 官服 / B服 在米家三件套里经常指向同一个文件夹（只是启动程序不同）。
 * 用户以为「删 B服」只影响 B服，去资源管理器把那个目录删了，
 * 结果官服一起失效 —— 卡片上必须先把这个共用关系说出来。
 */
function sharedRootWith(game, server) {
  if (!game || !server || !server.root) return null;
  return (
    (game.servers || []).find((item) => item.id !== server.id && item.path && sameRoot(item, server)) ||
    null
  );
}

/* ------------------------------------------------------------------ */
/* 切换服务器：所有入口共用同一套操作                                    */
/* ------------------------------------------------------------------ */

/* 切换中标记：终末地生成运行时可能要几十秒，这期间再点同一行只会叠出第二条提示 */
let switchingKey = '';

/**
 * 一条不会自己消失的提示，给「切换服务器」这种要等一会儿的操作报进度。
 * 返回 { update, done }：update 只换文案，done 换成最终结果并自动消失。
 */
function beginBusyToast(message) {
  if (!dom.toastRoot) return { update() {}, done() {} };
  const node = document.createElement('div');
  node.className = 'toast info is-busy';
  node.innerHTML = `${icon('refresh')}<span>${esc(message)}</span>`;
  dom.toastRoot.appendChild(node);
  let closed = false;
  const drop = () => {
    node.classList.add('leaving');
    window.setTimeout(() => node.remove(), 240);
  };
  return {
    update(next) {
      const label = node.querySelector('span');
      if (label && next) label.textContent = next;
    },
    done(text, type) {
      if (closed) return;
      closed = true;
      if (!text) {
        drop();
        return;
      }
      node.className = `toast ${type || 'info'}`;
      node.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info')}<span>${esc(text)}</span>`;
      playUiSound(type === 'error' ? 'error' : 'notify');
      window.setTimeout(drop, 2800);
    },
  };
}

/** 终末地生成运行时期间的进度文案（主进程发 phase / processed / total / current）。 */
function endfieldProgressText(progress) {
  const name = progress.serverName || '渠道';
  const total = Number(progress.total) || 0;
  const done = Number(progress.processed) || 0;
  if (total > 0) {
    const pct = Math.min(100, Math.round((done / total) * 100));
    return `正在为${name}生成运行时 ${pct}%（${done} / ${total} 个文件）`;
  }
  return progress.current || `正在为${name}生成运行时…`;
}

/** 启动游戏；需要提权时弹确认框，其余失败直接提示。返回是否真的起来了。 */
async function launchGameOrExplain(game) {
  const result = await api.games.launch(game.id);
  if (result.ok) {
    playUiSound('launch');
    return true;
  }
  if (result.elevationRequired) {
    const restart = await confirmDialog({
      title: '需要管理员权限',
      message: result.error,
      confirmText: '以管理员身份重启',
    });
    if (restart) await api.relaunchAdmin();
    return false;
  }
  toast(result.error, 'error');
  return false;
}

/**
 * 切换服务器的唯一实现 —— 启动页下拉、服务器管理弹窗、快捷面板、服务器胶囊全走这里。
 *
 * 以前这几个入口各写一套，于是同一件事在不同地方点出不同结果：
 *   · 启动页下拉：会先改异环的 Config.ini，但切完不启动、也没有成功提示
 *   · 服务器管理弹窗：直接 activate 再启动，异环的渠道根本没改，切完进游戏还是原服
 *   · 快捷面板 / 服务器胶囊：同上，渠道也没改
 *   · 终末地要现场生成链接运行时（几十秒），四套里没有任何进行中反馈，
 *     只有一句一闪而过的 toast —— 看起来就是「点切换没反应」
 * 现在统一成一条路：运行中先拦 → 不可用转去管理面板 → 异环先改渠道 →
 * activate（终末地 / 原神国际服 / 明日方舟的运行时都由主进程在里面处理）→
 * 统一的「进行中 / 已切换」提示。要不要顺带启动由入口显式传 launch。
 */
async function switchServerProfile(gameId, serverId, options = {}) {
  const { launch = false } = options;
  const game = state.games.find((item) => item.id === gameId);
  const server = game && (game.servers || []).find((item) => item.id === serverId);
  if (!game || !server) return { ok: false };
  // 先把下拉收起来：无论后面是早退还是真去切换，菜单都不该留在屏幕上
  closeStartServerMenu();

  // 已经停在这个服上：不必重跑渠道 / 运行时流程，要启动就直接启动
  if (server.active) {
    if (!launch) return { ok: true, unchanged: true };
    // 已经起来了就别再拉一个进程出来（重复点「启动」很常见）
    if (game.running) {
      toast(`${game.name} 正在运行`, 'info');
      return { ok: true, unchanged: true };
    }
    await launchGameOrExplain(game);
    return { ok: true };
  }
  if (switchingKey) {
    toast('上一次切换还没完成，等它跑完再点', 'info');
    return { ok: false };
  }
  if (game.running) {
    toast(`${game.name} 正在运行，先结束进程再切换服务器`, 'info');
    return { ok: false };
  }
  if (!server.exists || server.incomplete) {
    // 不可用不是错误，是「还没准备好」：直接带用户去管理面板，别让人对着「切换失败」猜
    const hint = serverBlockHint(server);
    openStartServerManager(gameId);
    toast(
      hint
        ? `「${server.name}」还不能切换：${hint.text}`
        : `「${server.name}」还不能切换，先把客户端路径补齐`,
      'info'
    );
    return { ok: false };
  }
  const busy = beginBusyToast(`正在切换到 ${server.name}…`);
  switchingKey = `${gameId}:${serverId}`;
  const offProgress =
    typeof api.onEndfieldProgress === 'function'
      ? api.onEndfieldProgress((progress) => {
          if (!progress || progress.serverName !== server.name) return;
          busy.update(endfieldProgressText(progress));
        })
      : null;
  try {
    /*
     * 异环的「服务器」是同一个客户端的渠道，真正生效的是 Config.ini。
     * 这段以前只写在启动页下拉里，另外三个入口都没有，所以那几处切完、
     * 游戏里还是原渠道 —— 也是「操作不一样」最明显的一处。
     */
    if (
      game.builtinKey === 'neverness' &&
      ['official', 'bilibili'].includes(String(server.channel || ''))
    ) {
      const switched = await switchNteChannel(game, server, server.channel);
      if (!switched) {
        busy.done();
        return { ok: false, cancelled: true };
      }
    }
    await api.servers.activate({ gameId, serverId });
    busy.done(`已切换到 ${server.name}`, 'success');
    showServerSwitchGuideOnce();
  } catch (error) {
    busy.done(humanError(error), 'error');
    return { ok: false, error };
  } finally {
    if (offProgress) offProgress();
    switchingKey = '';
  }

  if (!launch) return { ok: true };
  await launchGameOrExplain(game);
  return { ok: true };
}

function serverRow(game, server) {
  const status = serverState(server);
  const usable = server.exists && !server.incomplete;
  const shared = sharedRootWith(game, server);
  const block = serverBlockHint(server);
  const canPrepare =
    game.builtinKey === 'endfield' &&
    server.channel !== 'official' &&
    usable &&
    server.legacyRuntime;
  const canUpdateSophon =
    ['genshin', 'starrail', 'zzz'].includes(game.builtinKey) && usable;
  const fileName = server.path ? server.path.split(/[\\/]/).pop() : '';
  const primaryAction = usable
    ? server.active
      ? 'launch-game'
      : 'activate-server'
    : 'rebuild-server';
  const primaryLabel = usable ? (server.active ? '启动' : '切换') : '重建';
  // 一行只留一句能读的话：有 exe 就写文件名，没有才用「未选 exe」这种四字状态。
  // 以前这里叠着 状态胶囊 + 三个徽标 + 一句长提示，四行字挤在 250px 里。
  const sub = fileName || (block ? block.short : '') || '未选择客户端';
  return `
    <article class="server-tile ${server.active ? 'is-active' : ''} ${
      usable ? '' : 'is-broken'
    }" data-state="${status.cls}">
      <span class="st-dot ${status.cls}" aria-hidden="true"></span>
      <div class="st-main">
        <div class="st-title">
          <strong>${esc(server.name)}</strong>
          ${server.active ? '<span class="st-flag">当前</span>' : ''}
          ${!usable && status.label ? `<span class="st-chip is-warn">${status.label}</span>` : ''}
          ${server.runtimeLinked ? '<span class="st-chip">差异运行时</span>' : ''}
          ${
            shared
              ? `<span class="st-chip is-shared" title="${esc(
                  `${esc(server.name)} 和「${shared.name}」用的是同一个安装目录：删掉这个文件夹，两边都会失效`
                )}">与${esc(shared.name)}共用目录</span>`
              : ''
          }
        </div>
        <div class="st-sub" title="${esc(server.path || server.packPath || '')}">${esc(sub)}</div>
      </div>
      <div class="st-tools">
        ${
          canUpdateSophon
            ? `<button class="st-tool" data-action="update-sophon" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="检查官方更新">${icon('refresh')}</button>`
            : ''
        }
        ${
          canPrepare
            ? `<button class="st-tool" data-action="prepare-endfield" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="重新生成运行时">${icon('link')}</button>`
            : ''
        }
        <button class="st-tool" data-action="edit-server" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="编辑服务器">${icon('edit')}</button>
        ${
          usable
            ? `<button class="st-tool" data-action="open-server-folder" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="打开安装目录">${icon('folder-open')}</button>`
            : ''
        }
        ${
          server.builtinServer || (game.builtin && server.channel)
            ? `<button class="st-tool is-danger" data-action="clear-server-path" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="清除路径记录（不删文件）">${icon('x')}</button>`
            : (game.servers || []).length > 1
              ? `<button class="st-tool is-danger" data-action="remove-server" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="移除这个服务器（不删文件）">${icon('x')}</button>`
              : ''
        }
        ${
          server.root
            ? `<button class="st-tool is-text is-danger ${game.running ? 'is-locked' : ''}" data-action="uninstall-server" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="${
                game.running
                  ? '游戏正在运行，先关掉游戏再卸载'
                  : '把这一份客户端删到回收站，不影响别的服务器'
              }">${icon('trash')}<span>卸载</span></button>`
            : ''
        }
      </div>
      <button class="btn ${server.active ? 'btn-primary' : 'btn-ghost'} btn-sm st-go" data-action="${primaryAction}" data-id="${esc(game.id)}" data-game="${esc(game.id)}" data-server="${esc(server.id)}">
        ${icon(usable ? (server.active ? 'play' : 'swap') : 'refresh')}${primaryLabel}
      </button>
    </article>`;
}

/* ------------------------------------------------------------------ */
/* 预下载                                                              */
/* ------------------------------------------------------------------ */

/*
 * 预下载的全部结论都由主进程算好，存在 server.predownload 里（结构见
 * electron/predownload.js 顶部注释），界面只负责呈现：拿到什么显示什么，
 * 没拿过就显示「未查询」并给一个「检查」按钮。
 *
 * 异环和终末地 Steam 是明确不支持的，但后端给的 reason 必须显示出来 ——
 * 藏起来只会让用户以为功能坏了。
 */
const PREDOWNLOAD_GAMES = ['genshin', 'starrail', 'zzz', 'endfield', 'neverness'];

/** state → 徽标文案与配色。没有查过就是 unknown，界面给「检查」按钮。 */
const PREDOWNLOAD_STATES = {
  available: { label: '可以预下载', cls: 'is-ready' },
  done: { label: '预下载已完成', cls: 'is-done' },
  update: { label: '正式版已上线', cls: 'is-update' },
  none: { label: '官方暂未开放', cls: 'is-idle' },
  'not-installed': { label: '没读到客户端版本', cls: 'is-idle' },
  unsupported: { label: '不支持预下载', cls: 'is-block' },
  error: { label: '状态读取失败', cls: 'is-block' },
};

/** 进度事件里 phase 的人话翻译。 */
const PREDOWNLOAD_PHASES = {
  start: '准备中',
  version: '版本信息',
  manifest: '读取官方清单',
  download: '下载预下载内容',
  install: '写入游戏文件',
  extract: '解压预下载包',
  stage: '整理更新内容',
  patch: '应用补丁',
  done: '完成',
  error: '出错',
};

/** 正在向官方查询的服务器，界面上显示「查询中」而不是假装没事。 */
const pdBusy = new Set();

/** 预下载面板打开时登记的重绘函数，查完状态时顺手把面板也刷一遍。 */
let pdModalRepaint = null;
let pdModalStoryRepaint = null;

/** 异环渠道是读启动器配置来的，缓存一份，免得每次重绘都去读文件。 */
const nteChannelCache = new Map();

function predownloadApi() {
  return api.predownload && typeof api.predownload.check === 'function' ? api.predownload : null;
}

/** 只有这五个内置游戏才有预下载这条链路；自建游戏没有清单可查。 */
function predownloadWired(game) {
  return Boolean(game && PREDOWNLOAD_GAMES.includes(game.builtinKey));
}

function predownloadInfo(server) {
  const info = server && server.predownload;
  return info && typeof info === 'object' ? info : null;
}

function predownloadMeta(info) {
  return PREDOWNLOAD_STATES[String(info && info.state ? info.state : '')] || null;
}

/** 游戏卡上那个预下载入口：只在接入了预下载的游戏上出现，点击直达面板。 */
function cardPredownloadEntry(game) {
  if (!predownloadWired(game)) return '';
  const servers = game.servers || [];
  const server = servers.find((item) => item.active) || servers[0];
  const info = predownloadInfo(server);
  const pdState = String((info && info.state) || '');
  const known = {
    available: { cls: 'is-ready', title: '预下载新版本' },
    done: { cls: 'is-done', title: '应用预下载更新' },
    update: { cls: 'is-update', title: '应用官方更新' },
    unsupported: { cls: 'is-block', title: '这个服务器不支持预下载，点开看原因' },
    none: { cls: 'is-idle', title: '查看预下载状态' },
  };
  const view = known[pdState] || { cls: 'is-idle', title: '查看预下载状态' };
  return `<button class="card-tool pd-card-entry ${view.cls}" data-action="open-predownload" data-id="${esc(game.id)}" title="${view.title}" aria-label="${view.title}">${icon('download')}</button>`;
}

/**
 * 启动页「开始游戏」上方那条预下载入口。
 *
 * 只在两种情况下出现：官方真的放出了新版本可以预下载（available），
 * 或者已经下好了等着安装（done）。没新版本时这里一个字都不显示 ——
 * 留一个灰按钮占位只会让人以为功能坏了。
 *
 * 这块是照 Starward 的位置做的：预下载不是「工具」，是「比开始游戏更早一步的事」，
 * 所以它待在开始游戏正上方，而不是藏进服务器卡片或设置里。
 */
function startDockPredownload(game) {
  if (!predownloadWired(game)) return '';
  const servers = game.servers || [];
  const server = servers.find((item) => item.active) || servers[0];
  const info = predownloadInfo(server);
  const pdState = String((info && info.state) || '');
  if (pdState !== 'available' && pdState !== 'done') return '';
  const done = pdState === 'done';
  const version = String(info.targetVersion || info.latestVersion || '');
  const bytes =
    Number(info.bytesTotal) ||
    Number(info.bytesGame || 0) + Number(info.bytesAudio || 0) + Number(info.bytesCategory || 0);
  const bits = [];
  if (version) bits.push(version);
  if (done && Number(info.storedBytes)) bits.push(`已下 ${fmtBytes(info.storedBytes)}`);
  else if (!done && bytes) bits.push(`约 ${fmtBytes(bytes)}`);
  return `<button class="start-dock-pd" data-action="open-predownload" data-id="${esc(game.id)}" title="${
    done ? '预下载内容已经下好了，点开安装到游戏目录' : '官方放出了新版本，现在可以先下载'
  }">
      ${icon('download', 'xs')}
      <span class="start-dock-pd-label">${done ? '安装预下载的版本' : '预下载新版本'}</span>
      ${bits.length ? `<span class="start-dock-pd-meta">${esc(bits.join(' · '))}</span>` : ''}
    </button>`;
}

/** 体积拆解只列后端真算出来的那几段，凑不出「0 GB」这种没意义的行。 */function predownloadSizeText(info) {
  if (!info) return '';
  const parts = [];
  if (Number(info.bytesGame)) parts.push(`本体 ${fmtBytes(info.bytesGame)}`);
  if (Number(info.bytesAudio)) parts.push(`语音 ${fmtBytes(info.bytesAudio)}`);
  if (Number(info.bytesCategory)) parts.push(`剧情 ${fmtBytes(info.bytesCategory)}`);
  return parts.join(' + ');
}

function predownloadDetail(info, busy) {
  if (busy) return '正在向官方查询…';
  if (!info) return '还没查过，点「检查」问一次官方有没有开放预下载';
  const state = String(info.state || '');
  if (state === 'unsupported') return info.reason || '这个游戏 / 渠道不支持预下载';
  if (state === 'error') {
    // 后端会把「用户点停止」也记成 error，别让用户看到一条像是坏掉的红字
    if (String(info.error || '').includes('已取消')) return '上次预下载被你停掉了，已经下好的分块还在，接着下就行';
    return info.error || '读取预下载状态失败';
  }
  const bits = [];
  if (info.localVersion) bits.push(`本地 ${info.localVersion}`);
  if (info.targetVersion) bits.push(`预下载目标 ${info.targetVersion}`);
  // 正式版只有在「已经比本地新」时才值得说；否则和本地版本是同一个，说了是废话
  if (info.latestVersion && info.latestVersion !== info.localVersion) {
    bits.push(`正式版 ${info.latestVersion}`);
  }
  const size = predownloadSizeText(info);
  if (size) bits.push(`约 ${size}`);
  if (state === 'done') {
    if (info.storedFiles) bits.push(`已存 ${info.storedFiles} 个分块 · ${fmtBytes(info.storedBytes)}`);
    if (info.categoryCount) bits.push(`含 ${info.categoryCount} 份剧情分类包`);
  }
  if (state === 'update') bits.push('预下载按钮让位，直接用「应用更新」把新版本装上');
  return bits.join(' · ');
}

/** 预下载面板里的状态行。 */
function predownloadStatusMarkup(server) {
  const info = predownloadInfo(server);
  const meta = predownloadMeta(info);
  return `
    <div class="pd-status-row">
      <span class="pd-badge ${meta ? meta.cls : 'is-idle'}">${meta ? meta.label : '未查询'}</span>
      <span class="pd-status-note">${esc(predownloadDetail(info, false))}</span>
    </div>`;
}

/**
 * 单个服务器覆盖「剧情分类资源包」：true / false 是覆盖，null 是跟随全局。
 * 继承链在后端是 server → game → settings（见 main.js 的 storyResourcesEnabled）。
 */
function storyOverride(server) {
  return typeof (server && server.includeStoryResources) === 'boolean'
    ? server.includeStoryResources
    : null;
}

function storyResourcesMarkup(game, server) {
  if (game.builtinKey !== 'zzz') {
    return `<p class="pd-note">${icon('info', 'xs')}<span>这款游戏的官方清单里没有单独的剧情分类包（原神 / 星穹铁道实测为 0 份），剧情资源开关对它不起作用。</span></p>`;
  }
  const override = storyOverride(server);
  const on = override === null ? state.settings.includeStoryResources === true : override;
  const attrs = `data-game="${esc(game.id)}" data-server="${esc(server.id)}"`;
  return `
    <div class="pd-story">
      <div class="pd-story-copy">
        <strong>剧情资源</strong>
        <span>把主线剧情、个人线、影像档案这些分类包一起预下载。不勾只是缺剧情动画，不影响进游戏；勾上多占近 20GB。</span>
        <em class="pd-story-tag${override === null ? '' : ' is-over'}">${override === null ? '跟随全局设置' : '已单独设置'}</em>
      </div>
      <div class="pd-story-control">
        <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-action="toggle-pd-story" ${attrs} title="${on ? '关闭' : '开启'}"></button>
        <button class="btn btn-quiet" data-action="reset-pd-story" ${attrs} title="不覆盖，跟随全局设置" ${override === null ? 'hidden' : ''}>跟随全局</button>
      </div>
    </div>`;
}

/** 预下载面板：状态 + 剧情资源开关 + 进度 + 开始 / 应用 / 清除。 */
function openPredownloadModal(gameId, serverId) {
  if (!predownloadApi()) {
    toast('当前版本还没有接入预下载', 'info');
    return;
  }
  const game = state.games.find((item) => item.id === gameId);
  const server = game && (game.servers || []).find((item) => item.id === serverId);
  if (!game || !server) {
    toast('没有找到这个服务器', 'error');
    return;
  }
  const jobId = `pd-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>预下载</h2>
            <p>${esc(game.name)} · ${esc(server.name)} · 新版本上线前先把内容拉到本地，上线后再应用</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="pd-status" id="pd-status">${predownloadStatusMarkup(server)}</div>
          <div class="pd-story-host" id="pd-story">${storyResourcesMarkup(game, server)}</div>
          <div class="link-progress" id="pd-progress" style="display:none">
            <div class="link-progress-head">
              <strong id="pd-phase">准备中…</strong>
              <span id="pd-count"></span>
            </div>
            <div class="progress-bar"><span id="pd-bar" style="width:0%"></span></div>
            <div class="link-progress-meta">
              <span id="pd-stats"></span>
              <span id="pd-current"></span>
            </div>
          </div>
          <div class="field-error" id="pd-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
          <button class="btn btn-ghost" id="pd-pause" style="display:none">暂停</button>
          <button class="btn btn-ghost" id="pd-cancel" style="display:none">停止</button>
          <button class="btn btn-ghost" id="pd-refresh">${icon('refresh')}重新检查</button>
          <button class="btn btn-primary" id="pd-apply" style="display:none">${icon('download')}应用更新</button>
          <button class="btn btn-primary" id="pd-start">${icon('download')}开始预下载</button>
        </div>
      </div>
    </div>`;

  openModal(html, {
    onClose: () => {
      // 关窗即视为停止：先记下，免得后端抛回「已取消」时又弹一条错误提示
      if (running) {
        cancelled = true;
        api.predownload.cancel(jobId).catch(() => {});
      }
      if (unsubscribe) unsubscribe();
      pdModalRepaint = null;
      pdModalStoryRepaint = null;
    },
  });

  const phase = document.querySelector('#pd-phase');
  const count = document.querySelector('#pd-count');
  const stats = document.querySelector('#pd-stats');
  const current = document.querySelector('#pd-current');
  const bar = document.querySelector('#pd-bar');
  const progress = document.querySelector('#pd-progress');
  const errorBox = document.querySelector('#pd-error');
  const start = document.querySelector('#pd-start');
  const apply = document.querySelector('#pd-apply');
  const cancel = document.querySelector('#pd-cancel');
  const pause = document.querySelector('#pd-pause');
  let running = false;
  let cancelled = false;
  let paused = false;
  let unsubscribe = null;

  const currentServer = () => {
    const live = state.games.find((item) => item.id === gameId);
    return live && (live.servers || []).find((item) => item.id === serverId);
  };

  /** 只重绘状态行和两个按钮的可见性，不动整页，也不重建开关节点。 */
  const repaint = () => {
    const target = currentServer();
    if (!target) return;
    const statusHost = document.querySelector('#pd-status');
    if (statusHost) statusHost.innerHTML = predownloadStatusMarkup(target);
    const info = predownloadInfo(target);
    const pdState = String((info && info.state) || '');
    if (start) start.style.display = pdState === 'available' ? '' : 'none';
    if (apply) apply.style.display = pdState === 'done' || pdState === 'update' ? '' : 'none';
  };
  /** 剧情资源那块单独重绘：只有「跟随全局」这种非开关点击才需要重建。 */
  const repaintStory = () => {
    const target = currentServer();
    const storyHost = document.querySelector('#pd-story');
    if (target && storyHost) storyHost.innerHTML = storyResourcesMarkup(game, target);
  };
  pdModalRepaint = repaint;
  pdModalStoryRepaint = repaintStory;

  const onProgress = (event) => {
    if (!event || event.jobId !== jobId) return;
    const total = Number(event.total) || 0;
    const processed = Number(event.processed) || 0;
    const percent = total ? Math.min(100, (processed / total) * 100) : 0;
    const base = PREDOWNLOAD_PHASES[event.phase] || '处理中…';
    const counted = ['download', 'install', 'patch'].includes(event.phase);
    const tip = counted ? '' : String(event.current || '');
    if (phase) phase.textContent = tip ? `${base} · ${tip}` : base;
    if (count) count.textContent = total ? `${processed} / ${total}` : '';
    if (bar) bar.style.width = `${event.phase === 'done' ? 100 : percent}%`;
    if (stats) {
      const parts = [];
      if (Number(event.totalBytes)) {
        parts.push(`${fmtBytes(event.bytesDone)} / ${fmtBytes(event.totalBytes)}`);
      } else if (Number(event.bytesDone)) {
        parts.push(fmtBytes(event.bytesDone));
      }
      if (Number(event.skipped)) parts.push(`复用 ${event.skipped}`);
      if (Number(event.reusedChunks)) parts.push(`命中缓存 ${event.reusedChunks} 块`);
      stats.textContent = parts.join(' · ');
    }
    if (current) current.textContent = String(event.current || '');
  };

  const resetFoot = () => {
    running = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    start.disabled = false;
    cancel.style.display = 'none';
    pause.style.display = 'none';
    pause.textContent = '暂停';
    paused = false;
  };

  const run = async (kind) => {
    cancelled = false;
    running = true;
    progress.style.display = 'block';
    errorBox.textContent = '';
    start.disabled = true;
    apply.disabled = true;
    cancel.style.display = '';
    pause.style.display = '';
    unsubscribe = typeof api.onPredownloadProgress === 'function' ? api.onPredownloadProgress(onProgress) : null;
    const bridge = predownloadApi();
    try {
      const result = await (kind === 'apply'
        ? bridge.apply({ gameId, serverId, jobId })
        : bridge.start({ gameId, serverId, jobId }));
      if (cancelled || (result && result.cancelled)) {
        toast('已停止，下次可以从头再来或继续', 'info');
      } else if (kind === 'apply') {
        toast(`更新已应用到 ${result.tag || '新版本'}`, 'success');
      } else {
        toast(`预下载完成，目标版本 ${result.targetVersion || ''}`, 'success');
      }
    } catch (error) {
      const text = humanError(error);
      if (!cancelled) {
        errorBox.textContent = text;
        toast(text, 'error');
      }
    } finally {
      resetFoot();
      apply.disabled = false;
      // 后端会把「点停止」也记成 error 状态，重新查一次才能把「开始预下载」还回来
      if (cancelled) await runPredownloadCheck(gameId, serverId);
      repaint();
      repaintServerRows();
    }
  };

  start.addEventListener('click', () => run('start'));
  apply.addEventListener('click', () => run('apply'));
  cancel.addEventListener('click', () => {
    cancelled = true;
    cancel.disabled = true;
    api.predownload.cancel(jobId).catch(() => {});
  });
  pause.addEventListener('click', () => {
    paused = !paused;
    api.predownload.pause({ jobId, paused }).catch(() => {});
    pause.textContent = paused ? '继续' : '暂停';
    if (phase) phase.textContent = paused ? '已暂停（点继续恢复）' : '恢复中…';
  });
  document.querySelector('#pd-refresh').addEventListener('click', () => {
    runPredownloadCheck(gameId, serverId);
  });

  // 打开时还没查过就先问一次官方，别让用户对着「未查询」发呆
  if (!predownloadInfo(server)) runPredownloadCheck(gameId, serverId);
}

/**
 * 向官方查一次预下载状态。
 * 弹窗开着时主进程的回推不会重绘页面（onState 会跳过），所以这里自己重绘
 * 受影响的那两小块，而不是整页 render()。
 */
async function runPredownloadCheck(gameId, serverId) {
  const bridge = predownloadApi();
  if (!bridge) return;
  const key = `${gameId}:${serverId}`;
  if (pdBusy.has(key)) return;
  pdBusy.add(key);
  repaintServerRows();
  try {
    await bridge.check({ gameId, serverId });
  } catch (error) {
    toast(humanError(error), 'error');
  } finally {
    pdBusy.delete(key);
    repaintServerRows();
    if (pdModalRepaint) pdModalRepaint();
  }
}

/** 服务器管理弹窗里整片列表的就地重绘。 */
function repaintServerRows() {
  const host = document.querySelector('#server-manager-list');
  if (!host) return;
  const game = state.games.find((item) => item.id === host.dataset.game);
  if (!game) return;
  const servers = game.servers || [];
  host.innerHTML =
    servers.map((server) => serverRow(game, server)).join('') ||
    '<p class="gacha-empty-line">还没有服务器</p>';
}

/** 打开服务器管理时自动查一次当前服务器，省得每次都要手点。 */
async function autoCheckPredownload(game) {
  if (!predownloadWired(game)) return;
  const servers = game.servers || [];
  const server =
    servers.find((item) => item.active) || servers.find((item) => item.exists) || servers[0];
  if (!server || !server.exists || predownloadInfo(server)) return;
  await runPredownloadCheck(game.id, server.id);
}

/* ------------------------------------------------------------------ */
/* 异环官服 / B服                                                      */
/* ------------------------------------------------------------------ */

/*
 * 异环的渠道写在 <安装目录>/NTELauncher/Config/Config.ini 里，切渠道只改三行
 * 配置，不动游戏文件。后端把「两服账号独立、官方口径 PC 只支持官服、切完要重启」
 * 放在返回的 notice 里，界面必须原样呈现给用户 —— 尤其是切到 B服之前，
 * 不能默默就切了。
 */
function nteChannelLabel(channel) {
  if (channel === 'bilibili') return 'B服';
  if (channel === 'official') return '官服';
  return '未读取';
}

function nteChannelMarkup(game, server) {
  const cached = server ? nteChannelCache.get(server.id) : null;
  const channel = cached ? String(cached.channel || '') : '';
  const serverId = server ? server.id : '';
  const attrs = `data-game="${esc(game.id)}" data-server="${esc(serverId)}"`;
  const notice = cached ? String(cached.notice || '') : '';
  const reason = cached ? String(cached.reason || cached.error || '') : '';
  const broken = Boolean(cached && cached.state !== 'ok');
  // 渠道做成两张可点卡片：点了就是切过去，当前渠道亮着带「当前」角标
  const card = (key, label, desc) => {
    const active = channel === key;
    return `
      <button class="nte-channel-card${active ? ' is-active' : ''}" data-action="nte-set-channel" data-channel="${key}" ${attrs} ${active || broken ? 'disabled' : ''}>
        <strong>${label}</strong>
        <small>${desc}</small>
        ${active ? '<em>当前</em>' : ''}
      </button>`;
  };
  return `
    <section class="nte-panel" id="nte-channel-panel" data-game="${esc(game.id)}" data-server="${esc(serverId)}">
      <div class="nte-panel-head">
        <strong>异环渠道</strong>
        <span class="nte-current ${channel === 'bilibili' ? 'is-bili' : ''}">${cached ? nteChannelLabel(channel) : '读取中…'}</span>
      </div>
      <div class="nte-channel-cards">
        ${card('official', '官服', '完美世界账号 · 官方完整链路')}
        ${card('bilibili', 'B服', 'B站账号 · 与官服数据不互通')}
      </div>
      <p class="nte-notice">${icon('alert', 'xs')}<span>${esc(notice || '正在读取 NTELauncher 配置…')}</span></p>
      ${reason ? `<p class="nte-notice is-reason">${icon('info', 'xs')}<span>${esc(reason)}</span></p>` : ''}
    </section>`;
}

/**
 * 异环渠道切换完整流程（服务器管理面板和主界面 dock 的服务器下拉共用）：
 * B服先弹四步确认 → 改 Config.ini → 切换成功后两个渠道都询问「花筱灵直接下载」（官方链路切服后都可能要补渠道资源）。
 * 返回是否成功（用户取消/失败都算 false，调用方据此决定要不要继续 activate）。
 */
async function switchNteChannel(game, server, channel) {
  if (channel === 'bilibili') {
    const ok = await confirmDialog({
      title: '切换到异环 B服',
      message:
        '切换流程（很简单，不用慌）：\n' +
        '1. 点「切到 B服」改的是启动器配置，游戏文件一个不动；\n' +
        '2. 首次切 B服，花筱灵可以按官方清单直接下载 B服资源（只此一次，之后互相切换都是秒切）；\n' +
        '3. 下载完从花筱灵点「启动」就能进 B服，用 B站账号登录；\n' +
        '4. 切换前记得完全退出异环官方启动器（右下角薄荷托盘图标也要退）。\n\n' +
        '注意：官服（完美世界账号）和 B服（B站账号）数据完全不互通。',
      confirmText: '切到 B服',
      danger: true,
    });
    if (!ok) return false;
  }
  try {
    const result = await api.neverness.setChannel({
      gameId: game.id,
      serverId: server.id,
      channel,
    });
    if (result && result.changed) {
      // 成功提示交给调用方（dock 说「已切换到 xx」，面板刷新后自己显示当前渠道），
      // 避免 dock 场景下「已切回官服」+「已切换到 国服」弹两个框。
      // 两个渠道对称：切换后官方链路都可能要补几十 M 渠道资源，问一次要不要花筱灵直接下。
      const isB = channel === 'bilibili';
      const direct = await confirmDialog({
        title: isB ? '下载 B服资源' : '下载官服资源',
        message: isB
          ? '花筱灵可以直接按官方清单把 B服资源下载好，全程不用打开官方启动器。\n' +
            '只下载本机缺的文件，已存在的自动跳过；下载完从花筱灵点「启动」就能进 B服。'
          : '切回官服后，官方链路可能还要补几十 M 的官服资源。\n' +
            '花筱灵可以直接按官方清单提前下载好，全程不用打开官方启动器；\n' +
            '只下载本机缺的文件，已存在的自动跳过，之后切回官服就不用再下了。',
        confirmText: '花筱灵直接下载',
      });
      if (direct) {
        openNtePredownloadModal(server.id, channel);
      } else {
        try {
          await api.neverness.openLauncher();
          toast(`官方启动器已打开，等下载完就能从花筱灵启动${isB ? ' B服' : ''}`, 'success');
        } catch (err) {
          toast(humanError(err), 'error');
        }
      }
    } else {
      toast('渠道没有变化', 'info');
    }
    return true;
  } catch (error) {
    toast(humanError(error), 'error');
    return false;
  }
}

/** 读一次渠道配置并就地替换整块面板。 */
async function refreshNtePanel() {
  const host = document.querySelector('#nte-channel-panel');
  if (!host) return;
  const game = state.games.find((item) => item.id === host.dataset.game);
  const serverId = host.dataset.server;
  if (!game) return;
  try {
    const result = await api.neverness.channel({ serverId });
    nteChannelCache.set(serverId, result);
  } catch (error) {
    nteChannelCache.set(serverId, { channel: '', notice: humanError(error), state: 'error' });
  }
  const server = (game.servers || []).find((item) => item.id === serverId);
  const next = document.querySelector('#nte-channel-panel');
  if (next) next.outerHTML = nteChannelMarkup(game, server);
}

/* ------------------------------------------------------------------ */
/* gacha                                                               */
/* ------------------------------------------------------------------ */

/** 抽卡页固定展示这五款，缺数据时给导入引导，而不是让标签消失。 */
const GACHA_GAMES = [
  { key: 'genshin', name: '原神' },
  { key: 'starrail', name: '崩坏：星穹铁道' },
  { key: 'zzz', name: '绝区零' },
  { key: 'endfield', name: '明日方舟：终末地' },
  { key: 'neverness', name: '异环' },
];

/** 把「有数据的游戏」和「固定五款」合并，没数据的补一个空壳。 */
function gachaAllGames() {
  const loaded = state.gacha?.games || [];
  return GACHA_GAMES.map((def) => {
    const found = loaded.find((item) => item.key === def.key);
    return found
      ? { ...found, name: found.name || def.name, missing: false }
      : { key: def.key, name: def.name, users: [], missing: true };
  });
}

function gachaEnsureSelection() {
  const games = gachaAllGames();
  if (!state.gacha) return null;
  if (!games.some((game) => game.key === state.gachaGameKey)) {
    // 优先停在有数据的游戏上
    const withData = games.find((game) => !game.missing && (game.users || []).length);
    state.gachaGameKey = (withData || games[0]).key;
    state.gachaUid = '';
  }
  const game = games.find((item) => item.key === state.gachaGameKey) || games[0];
  const users = game.users || [];
  if (!users.some((user) => user.uid === state.gachaUid)) {
    state.gachaUid = users[0]?.uid || '';
  }
  return {
    games,
    game,
    user: users.find((user) => user.uid === state.gachaUid) || users[0] || null,
  };
}

function gachaHighLabel(game) {
  if (game.key === 'endfield') return '6★';
  if (game.key === 'neverness') return '5★';
  return game.key === 'zzz' ? 'S级' : '5★';
}

function gachaMidLabel(game) {
  if (game.key === 'endfield') return '5★';
  if (game.key === 'neverness') return '4★';
  return game.key === 'zzz' ? 'A级' : '4★';
}

/** 每个游戏的保底上限，用于垫数进度条；没有官方保底的按 90 兜底。 */
function gachaPityCap(game) {
  if (game.key === 'endfield') return 80;
  if (game.key === 'neverness') return 70;
  if (game.key === 'zzz') return 90;
  return 90;
}

/* ------------------------------------------------------------------ */
/* karaoke request queue                                               */
/* ------------------------------------------------------------------ */

/** 上一次提示「存档写不下」的时间戳，用来节流，别每加一首就弹一次。 */
let saveSongsWarnedAt = 0;

function saveSongs() {
  try {
    // 队列里的歌原来最多只存 200 首：整张歌单八百首进来时，
    // 重开一次启动器就只剩前 200 首，注释还要告诉用户去恢复。现在改存全诗。
    localStorage.setItem('vela:songs', JSON.stringify(state.songs));
  } catch (error) {
    /*
     * 不再截 200 首之后，几百首的队列有可能顶到 localStorage 配额。
     * 内存里的队列一首没少，只是没写进本地存档而已，
     * 但默认静默吞掉会让用户以为「歌单丢了」——必须说清楚。
     * 每加一首都会走到这里，所以用时间戳压一下，别反复弹同一句。
     */
    console.error('[saveSongs] 队列写不进本地存档:', error);
    if (Date.now() - saveSongsWarnedAt > 60000) {
      saveSongsWarnedAt = Date.now();
      toast('队列太长了，这次没能写进本地存档。歌单还在播放列表里没丢，只是重启启动器后需要重新导入一次。', 'info');
    }
  }
}

const PLAY_MODES = [
  { key: 'order', label: '顺序播放', short: '顺序', icon: 'order' },
  { key: 'list', label: '列表循环', short: '列表', icon: 'repeat' },
  { key: 'single', label: '单曲循环', short: '单曲', icon: 'repeat-one' },
  { key: 'shuffle', label: '随机播放', short: '随机', icon: 'shuffle' },
];

function playModeMeta(mode = state.playMode) {
  return PLAY_MODES.find((item) => item.key === mode) || PLAY_MODES[1];
}

function playModeOptions(short = false) {
  return PLAY_MODES.map(
    (item) =>
      `<option value="${item.key}" ${state.playMode === item.key ? 'selected' : ''}>${short ? item.short : item.label}</option>`
  ).join('');
}

/* 音质档位：和 electron 侧 /song/url/v1 的 level 参数一一对应 */
const QUALITY_LEVELS = [
  ['standard', '标准'],
  ['higher', '较高'],
  ['exhigh', '极高 320K'],
  ['lossless', '无损'],
  ['hires', 'Hi-Res'],
];

function qualityLabel(level) {
  const hit = QUALITY_LEVELS.find(([key]) => key === level);
  return hit ? hit[1] : QUALITY_LEVELS[0][1];
}

/**
 * 底部工具条上的小下拉。
 *
 * 原生 <select> 的弹层方向由系统决定，播放器贴在窗口底边时只能往下弹，
 * 会被窗口裁掉、点不到下面的选项，所以这里自己画一个向上展开的菜单。
 */
function songPopMarkup(id, options, { current, cls = '', title = '' } = {}) {
  const active = options.find((item) => item[0] === current) || options[0];
  return `
    <div class="song-pop${cls ? ` ${cls}` : ''}" data-pop="${esc(id)}">
      <button class="song-pop-trigger" data-action="song-pop-toggle" data-pop="${esc(id)}" title="${esc(title)}">
        <span class="song-pop-label">${esc(active[1])}</span>
        ${icon('chevron-up', 'xs')}
      </button>
      <div class="song-pop-menu" role="listbox" aria-label="${esc(title)}">
        ${options
          .map(
            ([value, label]) =>
              `<button class="song-pop-item${value === current ? ' is-active' : ''}" role="option" aria-selected="${value === current}" data-action="song-pop-pick" data-pop="${esc(id)}" data-value="${esc(value)}">${esc(label)}</button>`
          )
          .join('')}
      </div>
    </div>`;
}

function qualityPopMarkup(id, cls = '') {
  return songPopMarkup(id, QUALITY_LEVELS, { current: state.songQuality, cls, title: '音质' });
}

function playModePopMarkup(id, cls = '') {
  return songPopMarkup(id, PLAY_MODES.map((item) => [item.key, item.label]), {
    current: state.playMode,
    cls,
    title: '播放模式',
  });
}

/** 下拉被切换后同步按钮文案和高亮项（不重绘整页）。 */
function refreshSongPops() {
  document.querySelectorAll('.song-pop').forEach((wrap) => {
    const id = wrap.dataset.pop || '';
    const isMode = id.indexOf('mode') >= 0;
    const current = isMode ? state.playMode : state.songQuality;
    const options = isMode ? PLAY_MODES.map((item) => [item.key, item.label]) : QUALITY_LEVELS;
    const label = wrap.querySelector('.song-pop-label');
    if (label) {
      const hit = options.find(([key]) => key === current) || options[0];
      label.textContent = hit[1];
    }
    wrap.querySelectorAll('.song-pop-item').forEach((item) => {
      const on = item.dataset.value === current;
      item.classList.toggle('is-active', on);
      item.setAttribute('aria-selected', String(on));
    });
  });
}

/** 点空白处把展开的下拉收起来。 */
function closeSongPops() {
  document.querySelectorAll('.song-pop.is-open').forEach((wrap) => wrap.classList.remove('is-open'));
}

function applyPlayModeUi() {
  const meta = playModeMeta();
  document.querySelectorAll('#song-mode, #dock-play-mode').forEach((select) => {
    select.value = state.playMode;
  });
  refreshSongPops();
  const miniIcon = document.querySelector('#mini-mode-use');
  if (miniIcon) miniIcon.setAttribute('href', `#i-${meta.icon}`);
  const miniButton = document.querySelector('[data-action="cycle-play-mode"]');
  if (miniButton) miniButton.title = `播放模式：${meta.label}（点击切换）`;
}

function setPlayMode(mode) {
  if (!PLAY_MODES.some((item) => item.key === mode)) return;
  state.playMode = mode;
  try {
    localStorage.setItem('vela:play-mode', mode);
  } catch {
    /* optional local preference */
  }
  applyPlayModeUi();
}

function cyclePlayMode() {
  const index = PLAY_MODES.findIndex((item) => item.key === state.playMode);
  const next = PLAY_MODES[(index + 1) % PLAY_MODES.length];
  setPlayMode(next.key);
  toast(`播放模式：${next.label}`, 'info');
}

function randomSongIndex() {
  const total = state.songs.length;
  if (total <= 1) return 0;
  let next = state.songIndex;
  while (next === state.songIndex) {
    next = Math.floor(Math.random() * total);
  }
  return next;
}

async function playSongAt(index, options = {}) {
  if (!state.songs.length) return;
  state.songIndex = Math.max(0, Math.min(Number(index) || 0, state.songs.length - 1));
  await hydrateSong(state.songs[state.songIndex]);
  await ensureSongQuality(state.songs[state.songIndex]);
  if (options.skipRender) updateSongChrome();
  else render({ preserveScroll: options.preserveScroll !== false });
  playCurrentSong();
}

async function handleSongEnded() {
  const audio = document.querySelector('#song-audio');
  if (!audio || !state.songs.length) return;
  if (state.playMode === 'single') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    updateSongChrome();
    return;
  }
  if (state.playMode === 'order' && state.songIndex >= state.songs.length - 1) {
    /*
     * 歌单续播还在往后排（点了一首，后面几十首正在一首首解析）：
     * 这里等下一刻，别刚放完一首就报「播放完毕」。
     */
    if (playlistFill && (await waitForMoreSongs(8000)) && state.songIndex < state.songs.length - 1) {
      await playSongAt(state.songIndex + 1, { skipRender: state.route !== 'song' });
      return;
    }
    audio.currentTime = 0;
    updateSongChrome();
    toast('歌单已经播放完毕', 'info');
    return;
  }
  const next =
    state.playMode === 'shuffle' ? randomSongIndex() : (state.songIndex + 1) % state.songs.length;
  await playSongAt(next, { skipRender: state.route !== 'song' });
}

/* ── 播不动就跳下一首 ─────────────────────────────────────── */

/*
 * 以前「歌播不了」是怎么被吞掉的：
 *   1. #song-audio 的 error 只被音效模块拿去关音效（app.js 的 fx 那段），
 *      音效本来就关着时那句 if 直接不成立，等于什么都没做；
 *   2. 队列推进只挂在 ended 上，播不了的歌永远等不到 ended；
 *   3. 没有任何超时 —— 请求挂在那儿不报错也不出声，就一直停着。
 * 三条合起来就是用户说的「放到听不到的歌曲后，就一直停住」。
 *
 * 现在解析没拿到地址 / audio 报 error / 超过 SONG_LOAD_TIMEOUT_MS 没出声，
 * 都收进 handleSongFailed 这一个口子：先试着重新取一次链，还不行就标不可用并跳下一首。
 */
const SONG_LOAD_TIMEOUT_MS = 12000;
/** 连着这么多首都播不了就停手，别把整个队列空转一遍。 */
const SONG_FAIL_STREAK_LIMIT = 5;
/** 同一首歌重新取链的冷却时间，防止「重取 → 又失败 → 再重取」转圈。 */
const SONG_REFETCH_COOLDOWN_MS = 5 * 60 * 1000;

let songLoadTimer = 0;
let songFailStreak = 0;
// 同一首歌的失败去重键：用「序号 + 地址」做键，避免同一首歌的 error 被反复处理陷入死循环，
// 但跳到下一首后键就变了，不会挡住下一首的失败接管（原来是全局布尔锁，会在连续多首播不动时把
// 第二首起的 error 静默吞掉，导致卡在第二首出不来）。
let songFailGuard = '';
let songSkipBatch = { count: 0, titles: [], reason: '', timer: 0 };

function clearSongLoadWatchdog() {
  if (songLoadTimer) clearTimeout(songLoadTimer);
  songLoadTimer = 0;
}

/**
 * 挂上「多久还没出声就算失败」的定时器。
 * 只用在「已经在尝试播放但迟迟没声音」的情况：真正出声（playing）会摘掉它，
 * 自动播放被浏览器拦下时 play() 会 reject，也会摘掉它 —— 那不是这首歌的错。
 */
function armSongLoadWatchdog() {
  clearSongLoadWatchdog();
  const audio = document.querySelector('#song-audio');
  if (!audio || !audio.src) return;
  songLoadTimer = window.setTimeout(() => {
    songLoadTimer = 0;
    // 已经出声了，或者根本没在尝试播放（自动播放被拦 / 用户暂停）：都不算失败
    if (audio.currentTime > 0.5 || audio.paused) return;
    void handleSongFailed('加载超时');
  }, SONG_LOAD_TIMEOUT_MS);
}

/** 把 audio 的 MediaError 翻成人话。 */
function describeAudioError(audio) {
  const code = audio?.error?.code;
  if (code === 1) return '播放被中断';
  if (code === 2) return '网络错误';
  if (code === 3) return '音频解码失败';
  if (code === 4) return '音源不可用（地址过期，或受到版权 / 会员限制）';
  return '无法播放';
}

/**
 * 歌名主体：去括号后缀（Live / 重制 / 伴奏）、标点、空格和大小写。
 * 与主进程 music-resolve.js 里的同名函数保持同一套规则。
 */
function songCoreName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(【\[].*?[)）】\]]/g, ' ')
    .replace(/[\s\-_/、,.·'"!?·・。，！？：:；;]+/g, '');
}

/** 歌手串拆成名字数组，"A / B"、"A、B"、"A feat. B" 都算多人。 */
function artistNameList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item?.name || item || '')).filter(Boolean);
  return String(value || '')
    .split(/[\/、,&;；·]|feat\.?/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 换源拿回来的到底还是不是原来那首。
 *
 * 换源最糟的结果不是失败，而是「换成了另一首」：能放、也不报错、也没有提示，
 * 但唱的是同名不同曲或者别人的翻唱。所以渲染层再核一次歌名主体 + 歌手，
 * 对不上就当这次没换成功，走正常的失败/跳过流程。
 */
function songIdentityMatches(want, got) {
  const wantCore = songCoreName(want?.title || want?.name);
  // 主进程把「实际拿到地址的那一份」放在 matchedTitle / matchedArtist 上
  const gotCore = songCoreName(got?.matchedTitle || got?.title || got?.name);
  if (!wantCore || !gotCore) return true;
  if (!(gotCore === wantCore || gotCore.includes(wantCore) || wantCore.includes(gotCore))) return false;
  const wantNames = artistNameList(want?.artist).map(songCoreName).filter(Boolean);
  const gotNames = artistNameList(got?.matchedArtist || got?.artist).map(songCoreName).filter(Boolean);
  if (!wantNames.length || !gotNames.length) return true;
  return wantNames.some((wantName) => gotNames.some((gotName) => gotName === wantName || gotName.includes(wantName) || wantName.includes(gotName)));
}

/**
 * 失败时先试着重新取一次链。
 *
 * 地址过期是会员曲最常见的死法：队列整份存在 localStorage 里，
 * 隔天再打开，昨天还能播的地址今天多半已经 403。
 * 拿得到新地址就返回它，拿不到就把后端给的原因（会员专享 / 没有可播放版本）
 * 留在 song.failReason 上，交给提示文案。
 */
async function refetchSongUrl(song) {
  if (!song) return '';
  // 本地文件没有可重新解析的对象
  if (String(song.url || '').startsWith('file:')) return '';
  if (Date.now() - (song.refetchedAt || 0) < SONG_REFETCH_COOLDOWN_MS) return '';
  song.refetchedAt = Date.now();
  try {
    const result = await api.musicResolve({
      song: {
        title: song.title,
        artist: song.artist,
        album: song.album,
        platform: song.source || song.platform || '',
        mid: song.mid,
        hash: song.hash,
        neteaseId: song.neteaseId,
      },
      apiBase: localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100',
      level: state.songQuality,
    });
    if (result?.ok && result.url) {
      // 换回来的必须还是同一首歌、同一个歌手；换到别的歌就当没换到
      if (songIdentityMatches(song, result)) return String(result.url);
      song.failReason = '换到的音源不是同一首歌';
    } else {
      song.failReason = String(result?.reason || '');
    }
  } catch (error) {
    song.failReason = String(error?.message || '');
  }
  saveSongs();
  return '';
}

/**
 * 从 from 往后找第一首还没被标不可用的。
 * 返回 -1 表示没得跳：队列只有一首，或者剩下的全标了不可用。
 */
function nextPlayableIndex(from) {
  const total = state.songs.length;
  if (total <= 1) return -1;
  const start = Number(from) || 0;
  if (state.playMode === 'shuffle') {
    const pool = [];
    for (let i = 0; i < total; i += 1) {
      if (i !== start && !state.songs[i]?.unavailable) pool.push(i);
    }
    if (!pool.length) return -1;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  for (let step = 1; step <= total; step += 1) {
    const index = (start + step) % total;
    if (!state.songs[index]?.unavailable) return index;
  }
  return -1;
}

function resetSkipBatch() {
  if (songSkipBatch.timer) clearTimeout(songSkipBatch.timer);
  songSkipBatch = { count: 0, titles: [], reason: '', timer: 0 };
}

/**
 * 跳过提示。连着跳多首时合并成一条，不刷屏。
 * 后端给得出原因就写原因（「会员专享」「版权受限」之类），给不出就统一说无法播放。
 */
function queueSkipToast(song, reason) {
  songSkipBatch.count += 1;
  songSkipBatch.reason = songSkipBatch.reason || reason;
  if (song?.title && songSkipBatch.titles.length < 3) songSkipBatch.titles.push(song.title);
  if (songSkipBatch.timer) clearTimeout(songSkipBatch.timer);
  songSkipBatch.timer = window.setTimeout(() => {
    const count = songSkipBatch.count;
    const titles = songSkipBatch.titles.slice();
    const why = songSkipBatch.reason;
    resetSkipBatch();
    if (count <= 1) {
      toast(`「${titles[0] || '这首'}」${why}，已跳过`, 'error');
      return;
    }
    const more = count > titles.length ? ` 等 ${count} 首` : '';
    toast(`已跳过 ${count} 首播不了的歌：${titles.join('、')}${more}`, 'error');
  }, 700);
}

/** 一首歌「起不来」的统一收口。 */
async function handleSongFailed(rawReason = '') {
  const audio = document.querySelector('#song-audio');
  // 手动关掉迷你播放器会 removeAttribute('src') 再 load()，那也会冒一个 error，
  // 跟歌曲本身没关系，别去动队列。
  if (!audio || !audio.src) return;
  const song = currentSongEntry();
  if (!song) return;
  // 同一首歌不要重复处理（防死循环），但允许下一首接管：
  // 用「序号 + 地址」做去重键，跳到下一首后键就变了，不会挡住它。
  const guardKey = `${state.songIndex}:${song.url || ''}`;
  if (songFailGuard === guardKey) return;
  songFailGuard = guardKey;
  clearSongLoadWatchdog();
  try {
    // 1) 先试着重新取一次链：地址过期 / 能换源救回来的，就不该跳
    const fresh = await refetchSongUrl(song);
    if (fresh) {
      song.url = fresh;
      song.unavailable = false;
      delete song.unavailableReason;
      delete song.failReason;
      songFailStreak = 0;
      saveSongs();
      playCurrentSong();
      /*
       * 换源成功不弹提示：换回来的是同一首歌、同一个歌手，接着往下放就行，
       * 弹一句「音源已刷新」属于系统自己的事，用户不需要知道。
       * 换到的不是同一首（或换不到）才走下面的提示/跳过。
       */
      return;
    }

    // 2) 真的播不了：标不可用 → 提示 → 跳下一首
    const reason = song.failReason || rawReason || '无法播放';
    song.unavailable = true;
    song.unavailableReason = reason;
    saveSongs();
    songFailStreak += 1;
    queueSkipToast(song, reason);
    if (state.route === 'song') render({ preserveScroll: true });
    else updateSongChrome();

    if (songFailStreak >= SONG_FAIL_STREAK_LIMIT) {
      resetSkipBatch();
      toast('连续多首无法播放，已停止。检查一下音源开关，以及网易云的登录和会员状态。', 'error');
      return;
    }
    const next = nextPlayableIndex(state.songIndex);
    if (next < 0) {
      toast('队列里没有其它能播的歌了', 'info');
      return;
    }
    await playSongAt(next, { skipRender: state.route !== 'song' });
  } finally {
    // 只在我们还停在「同一首」时清锁：跳到下一首后若下一首的 error 已抢先接管，
    // 它的 guard 键不同，这里就不该把它清掉。
    if (songFailGuard === guardKey) songFailGuard = '';
  }
}

/**
 * 启动时恢复上次的歌曲：
 * - 只恢复「当前曲目指针」和封面信息，不自动播放；
 * - 只有用户开启了 autoResumeSong 才真正开始播放；
 * - 没开启时，播放器会停在「已就绪」状态，等用户点播放。
 */
/** 播放进度记忆：曲目索引 + 秒数，关掉再打开能接着听。 */
const SONG_PROGRESS_KEY = 'vela:song-progress';

function saveSongProgress() {
  const audio = document.querySelector('#song-audio');
  if (!audio || !audio.src) return;
  try {
    localStorage.setItem(
      SONG_PROGRESS_KEY,
      JSON.stringify({
        index: state.songIndex,
        time: Math.max(0, Math.floor(audio.currentTime || 0)),
        at: Date.now(),
      })
    );
  } catch {
    /* 可选记忆 */
  }
}

function readSongProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(SONG_PROGRESS_KEY) || 'null');
    if (!saved || !Number.isFinite(saved.index)) return null;
    return {
      index: Math.max(0, Math.min(Number(saved.index) || 0, Math.max(0, state.songs.length - 1))),
      time: Math.max(0, Number(saved.time) || 0),
    };
  } catch {
    return null;
  }
}

function resumeLastSong() {
  const saved = readSongProgress();
  if (saved) state.songIndex = saved.index;

  const song = state.songs[state.songIndex];
  if (!song?.url) return;
  const audio = document.querySelector('#song-audio');
  if (!audio) return;

  // 先把 src 挂上，让播放器显示这首歌
  const key = `${state.songIndex}:${song.url}`;
  if (audio.dataset.songKey !== key) {
    audio.dataset.songKey = key;
    audio.src = song.url;
    audio.preload = 'metadata';
    audio.load();
  }

  // 恢复上次听到的位置（等元数据就绪再 seek）
  const seekTo = saved ? saved.time : 0;
  const applySeek = () => {
    if (!seekTo) return;
    try {
      audio.currentTime = Math.min(seekTo, Math.max(0, (audio.duration || seekTo) - 0.5));
    } catch {
      /* 某些直链不允许 seek */
    }
  };
  if (audio.readyState >= 1) applySeek();
  else audio.addEventListener('loadedmetadata', applySeek, { once: true });

  // 只有开启自动续播才真的出声；否则保持「已就绪」等用户点播放
  if (state.autoResumeSong) {
    audio.play().catch(() => {
      /* 浏览器策略可能拦下自动播放 */
    });
  }
  updateSongChrome();
}

function playCurrentSong(toggle = false) {
  const audio = document.querySelector('#song-audio');
  const song = currentSongEntry();
  if (!audio) return;
  /*
   * 没有可播放地址时以前是直接 return：不出声、不报错、也不推进队列，
   * 播放器就静悄悄地死在这一首上。现在按「播不了」处理，交给失败收口去跳。
   */
  if (!song?.url) {
    if (song) void handleSongFailed('没有可播放地址');
    return;
  }
  const key = `${state.songIndex}:${song.url}`;
  if (audio.dataset.songKey !== key) {
    audio.dataset.songKey = key;
    audio.src = song.url;
    audio.load();
  }
  if (toggle && !audio.paused) {
    audio.pause();
    clearFxWatchdog();
    clearSongLoadWatchdog();
    updateSongChrome();
    return;
  }
  if (state.audioFx.preset !== 'off' && !audioFxFallback) {
    applyAudioFx();
    armFxWatchdog(audio);
  }
  armSongLoadWatchdog();
  audio.play().catch(() => {
    /*
     * 自动播放被浏览器策略拦下时 promise 会 reject：这首歌本身没问题，
     * 只是还没轮到用户点播放。不在这里摘掉超时判定——真正出声时
     * 'playing' 事件会清掉它；若一首死链连 error 都没冒，超时判定还能兜底。
     * （autoplay 被拦时 audio.paused 仍为 true，watchdog 本身也不会误判失败。）
     */
  });
  updateSongChrome();
}

function openNeteaseLoginModal() {
  const defaultApi = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
  let timer = null;
  let key = '';
  openModal(
    `
    <div class="modal-head"><div><h2>网易云扫码登录</h2><p>连接你本机运行的 NeteaseCloudMusicApi 服务，扫码后只在本机内存保存登录态。</p></div><button class="icon-btn" data-close>${icon('x')}</button></div>
    <div class="modal-body">
      <label class="field"><span>本地 API 地址</span><input class="text-input" id="netease-login-api" value="${esc(defaultApi)}" placeholder="http://127.0.0.1:3100" /></label>
      <div class="netease-qr-box">
        <div class="netease-qr-image" id="netease-qr-image">${icon('music')}</div>
        <div class="netease-qr-copy"><strong id="netease-login-status">等待获取二维码</strong><span id="netease-login-hint">先确认本地 API 已启动，再点获取二维码。</span></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>关闭</button>
        <button class="btn btn-ghost" id="netease-service-start">${icon('play')}自动启动服务</button>
        <button class="btn btn-primary" id="netease-login-refresh">${icon('refresh')}获取二维码</button>
      </div>
    </div>
  `,
    { onClose: () => timer && clearInterval(timer) }
  );
  const apiInput = document.querySelector('#netease-login-api');
  const status = document.querySelector('#netease-login-status');
  const hint = document.querySelector('#netease-login-hint');
  const image = document.querySelector('#netease-qr-image');
  const refresh = document.querySelector('#netease-login-refresh');
  if (!apiInput || !refresh) return;
  api.netease
    .startService(apiInput.value.trim())
    .then((result) => {
      if (result?.apiBase) apiInput.value = result.apiBase;
      status.textContent = result?.started ? '本地服务已自动启动' : '本地服务已经在运行';
      hint.textContent = '正在获取登录二维码…';
      refresh.click();
    })
    .catch(() => {});
  const check = async () => {
    if (!key) return;
    try {
      const result = await api.netease.qrCheck({ apiBase: apiInput.value.trim(), key });
      if (result.loggedIn) {
        if (timer) clearInterval(timer);
        status.textContent = '登录成功';
        hint.textContent = '登录态已保存在本次运行中，可以直接导入歌单。';
        toast('网易云登录成功', 'success');
        setTimeout(() => closeModal(), 900);
      } else if (result.code === 802) {
        status.textContent = '已扫码，请在手机上确认';
        hint.textContent = result.message || '确认后会自动完成登录。';
      } else if (result.code === 800) {
        status.textContent = '二维码已过期';
        hint.textContent = '重新获取二维码。';
        if (timer) clearInterval(timer);
      } else {
        hint.textContent = result.message || '等待扫码…';
      }
    } catch (error) {
      if (timer) clearInterval(timer);
      status.textContent = '登录检查失败';
      hint.textContent = error.message;
    }
  };
  refresh.addEventListener('click', async () => {
    if (timer) clearInterval(timer);
    key = '';
    refresh.disabled = true;
    status.textContent = '正在获取二维码…';
    hint.textContent = '连接本地 API';
    try {
      const apiBase = apiInput.value.trim();
      localStorage.setItem('vela:netease-api', apiBase);
      const result = await api.netease.qrCreate({ apiBase });
      key = result.key;
      image.innerHTML = result.qrimg
        ? `<img src="${esc(result.qrimg)}" alt="网易云登录二维码" />`
        : icon('music');
      status.textContent = '请使用网易云音乐扫码';
      hint.textContent = '扫码后在手机上确认登录。';
      timer = setInterval(check, 2000);
    } catch (error) {
      status.textContent = '获取二维码失败';
      hint.textContent = error.message;
    } finally {
      refresh.disabled = false;
    }
  });
  const serviceStart = document.querySelector('#netease-service-start');
  serviceStart?.addEventListener('click', async () => {
    serviceStart.disabled = true;
    status.textContent = '正在启动本地服务…';
    hint.textContent = '查找 NeteaseCloudMusicApi 并启动，需要几秒钟。';
    try {
      const result = await api.netease.startService(apiInput.value.trim());
      if (result?.apiBase) apiInput.value = result.apiBase;
      status.textContent = result?.started ? '本地服务已启动' : '本地服务已经在运行';
      hint.textContent = '现在正在获取登录二维码…';
      refresh.click();
    } catch (error) {
      status.textContent = '自动启动服务失败';
      hint.textContent = error.message;
    } finally {
      serviceStart.disabled = false;
    }
  });
}

function parseLrc(text) {
  const lines = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((raw) => {
      const match = raw.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/);
      if (!match) return;
      const title = match[4].trim();
      if (!title) return;
      const seconds =
        Number(match[1]) * 60 +
        Number(match[2]) +
        (match[3] ? Number(match[3].padEnd(3, '0').slice(0, 3)) / 1000 : 0);
      lines.push({ time: seconds, text: title });
    });
  return lines.sort((a, b) => a.time - b.time);
}

function currentSongEntry() {
  return state.songs[state.songIndex] || null;
}

function songCover(song) {
  return String(song?.cover || '').replace(/^http:/i, 'https:');
}

function formatSongTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const MINI_POS_KEY = 'vela:mini-pos';

function clampMiniPosition(mini, x, y) {
  const margin = 6;
  const width = mini.offsetWidth || 338;
  const height = mini.offsetHeight || 92;
  return {
    x: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin)),
    y: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - height - margin)),
  };
}

/** 位置按场景分开存：启动页和主界面各自记住自己的位置。 */
function miniPosKey() {
  return state.route === 'start' ? `${MINI_POS_KEY}:start` : `${MINI_POS_KEY}:main`;
}

/**
 * 主界面小球默认停靠点：侧栏底部，压在「收起侧栏」按钮上方。
 *
 * 侧栏本身就是一块抽屉面板，小球停在这一列里，收起 / 展开时都贴着中线，
 * 不压导航项，也不压底部的收起按钮和个人资料。
 */
function defaultMiniPosition(mini) {
  const sidebar = document.querySelector('.sidebar');
  const toggle = document.querySelector('.sidebar-toggle');
  const profile = document.querySelector('.profile');
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : collapsed ? 76 : 238;
  const width = mini.offsetWidth || 200;
  const height = mini.offsetHeight || 34;
  const anchor = toggle || profile;
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : window.innerHeight - 74;
  const limit = window.innerHeight - height - 12;
  return {
    x: Math.max(10, Math.round(sidebarWidth / 2 - width / 2)),
    y: Math.round(Math.min(Math.max(56, anchorTop - height - 14), limit)),
  };
}

/** 停靠状态下展开成面板时，向侧栏右侧弹出，别压住侧栏本身。 */
function dockedPanelPosition(mini) {
  const sidebar = document.querySelector('.sidebar');
  const anchorEl = document.querySelector('.sidebar-toggle') || document.querySelector('.profile');
  const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 238;
  const anchorTop = anchorEl ? anchorEl.getBoundingClientRect().top : window.innerHeight - 74;
  const width = mini.offsetWidth || 320;
  const height = mini.offsetHeight || 150;
  return {
    x: Math.min(sidebarWidth + 14, Math.max(8, window.innerWidth - width - 14)),
    y: Math.max(16, Math.round(Math.min(anchorTop - height - 6, window.innerHeight - height - 14))),
  };
}

function applyMiniPosition(mini = document.querySelector('#mini-player')) {
  const miniRef = mini;
  if (miniRef && miniRef.classList && miniRef.classList.contains('is-start-chip')) return;

  if (!mini || mini.hidden) return;
  // 启动页的位置由 updateSongChrome 内联写死，这里不要覆盖
  if (state.route === 'start') return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(miniPosKey()) || 'null');
  } catch {
    saved = null;
  }

  // 先切样式再量尺寸：停靠态的球比自由态小一圈，量晚了会算偏
  const docked = !(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y));
  mini.classList.toggle('is-docked', docked);

  let position;
  if (!docked) {
    position = clampMiniPosition(mini, saved.x, saved.y);
  } else if (state.route !== 'start') {
    // 主界面没有记录时，默认停靠在侧栏底部；展开成面板时朝侧栏右侧弹出
    position = isMiniExpanded() ? dockedPanelPosition(mini) : defaultMiniPosition(mini);
  } else {
    return;
  }

  mini.style.left = `${position.x}px`;
  mini.style.top = `${position.y}px`;
  mini.style.right = 'auto';
  mini.style.bottom = 'auto';
}

/**
 * 小播放器总开关：关掉之后，即使还在放歌、即使来回切界面，都不再冒出来，
 * 直到用户在设置或点歌台里重新打开。默认开着。
 */
const MINI_ENABLED_KEY = 'vela:mini-enabled';

function isMiniEnabled() {
  try {
    return localStorage.getItem(MINI_ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

function setMiniEnabled(enabled) {
  try {
    localStorage.setItem(MINI_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    /* 可选记忆 */
  }
  const mini = document.querySelector('#mini-player');
  if (!enabled && mini) {
    mini.hidden = true;
    mini.style.setProperty('display', 'none', 'important');
  }
  updateSongChrome();
  if (enabled) requestAnimationFrame(() => applyMiniPosition(mini));
}

/** 窄条 / 展开卡片 的形态记忆，默认收成窄条。 */
const MINI_EXPANDED_KEY = 'vela:mini-expanded';

/**
 * 展开前那一刻窄条所在的左上角坐标。
 *
 * 收起时回到这里，才是用户说的「按原位收缩」。
 * 之前拿展开卡片的左上角当锚点，而卡片比窄条宽一圈、高一截，
 * 收起后窄条就贴在卡片的左上角上 —— 看起来就是「往左上缩了一下」。
 */
let miniExpandOrigin = null;

function isMiniExpanded() {
  try {
    return localStorage.getItem(MINI_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

function setMiniExpanded(expanded) {
  const mini = document.querySelector('#mini-player');
  if (!mini) return;
  const before = mini.getBoundingClientRect();
  const wasExpanded = !mini.classList.contains('is-chip');
  if (expanded && !wasExpanded) {
    // 记住窄条现在的位置，收起时原样回去（用户要的「按原位收缩」）
    miniExpandOrigin = { x: before.left, y: before.top };
    delete mini.dataset.draggedSinceExpand;
  }
  mini.classList.toggle('is-chip', !expanded);
  try {
    localStorage.setItem(MINI_EXPANDED_KEY, expanded ? '1' : '0');
  } catch {
    /* 可选记忆 */
  }
  // 形态变化后尺寸不同，重新夹回可视区
  requestAnimationFrame(() => {
    /*
     * 从展开卡片收回窄条：优先回到展开前那个位置；
     * 如果展开期间用户把卡片拖走了，就以卡片中心为锚点收，
     * 这样视觉上也是「原地缩小」，而不是飘到某个角上。
     */
    if (!expanded && wasExpanded) {
      // 启动页收起：直接嵌回抽屉标题行的槽里，别让窄条飘在固定定位上
      if (state.route === 'start') {
        miniExpandOrigin = null;
        delete mini.dataset.draggedSinceExpand;
        positionStartMini(mini);
        return;
      }
      mini.classList.remove('is-docked');
      const dragged = mini.dataset.draggedSinceExpand === '1';
      const width = mini.offsetWidth || 214;
      const height = mini.offsetHeight || 52;
      const target =
        miniExpandOrigin && !dragged
          ? { x: miniExpandOrigin.x, y: miniExpandOrigin.y }
          : {
              x: before.left + before.width / 2 - width / 2,
              y: before.top + before.height / 2 - height / 2,
            };
      const anchored = clampMiniPosition(mini, target.x, target.y);
      mini.style.left = `${anchored.x}px`;
      mini.style.top = `${anchored.y}px`;
      mini.style.right = 'auto';
      mini.style.bottom = 'auto';
      miniExpandOrigin = null;
      delete mini.dataset.draggedSinceExpand;
      try {
        localStorage.setItem(
          miniPosKey(),
          JSON.stringify({ x: Math.round(anchored.x), y: Math.round(anchored.y) })
        );
      } catch {
        /* 位置持久化是可选的 */
      }
      return;
    }
    /*
     * 启动页展开：chip 原本内嵌在抽屉标题行右侧的槽里（position: static !important），
     * 直接去掉 is-chip 只会让卡片卡在槽内被 overflow 裁掉、看起来「没弹出来」。
     * 这里把 mini 挪回 body，改成固定定位停在 chip 原位，卡片才能真正浮出来。
     */
    if (expanded && state.route === 'start') {
      if (mini.parentElement !== document.body) document.body.appendChild(mini);
      [
        'position',
        'left',
        'right',
        'top',
        'bottom',
        'width',
        'max-width',
        'margin',
        'transform',
        'display',
      ].forEach((prop) => mini.style.removeProperty(prop));
      // 展开卡片按 chip 原位弹出：以 chip 的「右下角」为锚点向左上生长，
      // 卡片就不会再向下延伸、盖住下方的「开始游戏」按钮。
      const anchorX = (miniExpandOrigin?.x ?? before.left) + before.width;
      const anchorY = (miniExpandOrigin?.y ?? before.top) + before.height;
      const cardW = mini.offsetWidth || 240;
      const cardH = mini.offsetHeight || 320;
      const position = clampMiniPosition(mini, anchorX - cardW, anchorY - cardH);
      mini.style.position = 'fixed';
      mini.style.left = `${position.x}px`;
      mini.style.top = `${position.y}px`;
      mini.style.right = 'auto';
      mini.style.bottom = 'auto';
      return;
    }
    const rect = mini.getBoundingClientRect();
    const position = clampMiniPosition(mini, rect.left, rect.top);
    mini.style.left = `${position.x}px`;
    mini.style.top = `${position.y}px`;
    mini.style.right = 'auto';
    mini.style.bottom = 'auto';
    if (expanded) {
      const volume = mini.querySelector('#mini-volume');
      if (volume) volume.value = String(state.songVolume);
    }
  });
}

/** 启动页底部抽屉展开时，小球跟着抬高。 */
function setupStartDrawerSync() {
  const drawer = document.querySelector('.start-games');
  const mini = document.querySelector('#mini-player');
  if (!drawer || drawer.dataset.syncBound === '1') return;
  drawer.dataset.syncBound = '1';
  const sync = () => {
    const open = drawer.matches(':hover') || drawer.matches(':focus-within');
    // body 级联动：展开时左下任务面板 / 右下开始面板整体让路（CSS 接手），
    // 否则这两个浮层会压在抽屉的游戏卡片上，排后面的游戏点不到。
    document.body.classList.toggle('drawer-open', open);
    if (mini) mini.classList.toggle('drawer-open', open);
    // 展开形态已挪到 body 固定定位，别在抽屉 hover 时把它拽回槽里
    if (mini && mini.classList.contains('is-on-start') && !isMiniExpanded()) positionStartMini(mini);
  };
  drawer.addEventListener('mouseenter', sync);
  drawer.addEventListener('mouseleave', sync);
  drawer.addEventListener('focusin', sync);
  drawer.addEventListener('focusout', () => setTimeout(sync, 60));
}

/**
 * 启动页抽屉的游戏列表导轨：左右翻页箭头 + 滚轮横滚。
 *
 * 游戏多了以后一行放不下，列表本身能横向滚（滚动条特意藏了），
 * 但没有可见的翻页入口，排在后面的游戏「看不到」。这里补两个箭头：
 * - 箭头按滚动位置自动显隐（到头的一侧不显示）；
 * - 鼠标滚轮在列表上直接横向滚，不用按住 Shift。
 */
function setupStartGameRail() {
  const rail = document.querySelector('.start-game-rail');
  const list = rail?.querySelector('.start-game-list');
  if (!rail || !list || rail.dataset.railBound === '1') return;
  rail.dataset.railBound = '1';
  const prev = rail.querySelector('.start-game-nav.is-prev');
  const next = rail.querySelector('.start-game-nav.is-next');
  const step = () => Math.max(list.clientWidth * 0.65, 320);
  const sync = () => {
    const max = list.scrollWidth - list.clientWidth;
    rail.classList.toggle('is-at-start', list.scrollLeft <= 4);
    rail.classList.toggle('is-at-end', list.scrollLeft >= max - 4);
  };
  prev?.addEventListener('click', () => list.scrollBy({ left: -step(), behavior: 'smooth' }));
  next?.addEventListener('click', () => list.scrollBy({ left: step(), behavior: 'smooth' }));
  list.addEventListener(
    'wheel',
    (event) => {
      // 触控板横向手势原生就有，只接管纵向滚轮；deltaX 为主时别画蛇添足
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (list.scrollWidth <= list.clientWidth) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    },
    { passive: false }
  );
  list.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
  sync();
}

/**
 * 启动页：把小播放器直接挂进「选择游戏」标题行右边的槽里。
 *
 * 不用固定定位、也不用算坐标 —— 它就是标题行里的一个子元素，抽屉收起 / 展开、
 * 窗口缩放都交给 flex 布局自己处理。挂在抽屉内部还有个好处：鼠标停在窄条上时
 * 抽屉仍然算被 hover，不会因为指到窄条就把抽屉收回去。
 */
function positionStartMini(mini = document.querySelector('#mini-player')) {
  if (!mini) return;
  const slot = document.querySelector('#start-mini-slot');
  if (!slot) return;
  if (mini.parentElement !== slot) slot.appendChild(mini);
  // 历史样式里有 #mini-player.mini-player { position: fixed; right: 28px; bottom: 96px }
  // 特异性很高，光靠 class 覆盖不掉，直接写内联最稳。
  // 用 important 写内联：后面的 applyMiniPosition 想改也改不动
  mini.style.setProperty('position', 'static', 'important');
  mini.style.setProperty('left', 'auto', 'important');
  mini.style.setProperty('right', 'auto', 'important');
  mini.style.setProperty('top', 'auto', 'important');
  mini.style.setProperty('bottom', 'auto', 'important');
  mini.style.setProperty('width', 'auto', 'important');
  mini.style.setProperty('max-width', '420px', 'important');
  mini.style.setProperty('margin', '0', 'important');
  mini.style.setProperty('transform', 'none', 'important');
  mini.style.setProperty('display', 'flex', 'important');
}

/** 离开启动页：挪回 body，恢复固定定位。 */
function unmountStartMini(mini = document.querySelector('#mini-player')) {
  if (!mini) return;
  if (mini.parentElement !== document.body) document.body.appendChild(mini);
  [
    'position',
    'left',
    'right',
    'top',
    'bottom',
    'width',
    'max-width',
    'margin',
    'transform',
    'display',
  ].forEach((prop) => mini.style.removeProperty(prop));
}

/** 侧栏宽度有过渡动画，收起/展开后隔一拍再贴一次。 */
function repositionDockedMini() {
  const mini = document.querySelector('#mini-player');
  if (!mini || mini.hidden || !mini.classList.contains('is-docked')) return;
  requestAnimationFrame(() => applyMiniPosition(mini));
  setTimeout(() => applyMiniPosition(mini), 320);
}

function setupMiniPlayer() {
  const mini = document.querySelector('#mini-player');
  if (!mini) return;

  /* 音量与音效控件每次都重新绑定（迷你播放器可能被重建） */
  const miniVolume = document.querySelector('#mini-volume');
  if (miniVolume && miniVolume.dataset.bound !== '1') {
    miniVolume.dataset.bound = '1';
    miniVolume.value = String(state.songVolume);
    miniVolume.addEventListener('input', () => setSongVolume(miniVolume.value));
  }
  const miniFx = mini.querySelector('[data-action="open-audio-fx"]');
  if (miniFx) miniFx.classList.toggle('active', state.audioFx.preset !== 'off');
  syncVolumeUi();

  if (mini.dataset.dragReady === '1') {
    applyMiniPosition(mini);
    return;
  }
  mini.dataset.dragReady = '1';
  applyMiniPosition(mini);

  /* 整个顶栏（封面、歌名以外的空白）都可以拖，不再要求精确按住小圆点 */
  // 小球形态下整个球都能拖；展开后用手柄或歌名区域拖
  const handles = [
    mini.querySelector('#mini-chip'),
    mini.querySelector('[data-mini-drag]'),
    mini.querySelector('.mini-copy'),
  ].filter(Boolean);

  let drag = null;
  let moved = false;

  const move = (event) => {
    if (!drag) return;
    if (!moved) {
      const dx = Math.abs(event.clientX - drag.startX);
      const dy = Math.abs(event.clientY - drag.startY);
      if (dx < 3 && dy < 3) return;
      moved = true;
      mini.classList.add('dragging');
    }
    const position = clampMiniPosition(
      mini,
      event.clientX - drag.offsetX,
      event.clientY - drag.offsetY
    );
    mini.style.left = `${position.x}px`;
    mini.style.top = `${position.y}px`;
    mini.style.right = 'auto';
    mini.style.bottom = 'auto';
  };

  const end = () => {
    if (!drag) return;
    const wasMoved = moved;
    drag = null;
    moved = false;
    mini.classList.remove('dragging');
    mini.style.cursor = '';
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (!wasMoved) return;
    mini.dataset.justDragged = '1';
    // 展开状态下拖过：收起时就不能再回到展开前的老位置了，改按卡片中心收
    if (!mini.classList.contains('is-chip')) mini.dataset.draggedSinceExpand = '1';
    window.setTimeout(() => delete mini.dataset.justDragged, 260);
    try {
      localStorage.setItem(
        miniPosKey(),
        JSON.stringify({
          x: Math.round(mini.getBoundingClientRect().left),
          y: Math.round(mini.getBoundingClientRect().top),
        })
      );
    } catch {
      /* position persistence is optional */
    }
  };

  for (const handle of handles) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('input, select, textarea')) return;
      const rect = mini.getBoundingClientRect();
      drag = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY,
      };
      moved = false;
      window.addEventListener('pointermove', move, { passive: true });
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
  }

  /* 拖动后不要误触「打开点歌台」 */
  // 拖动过后屏蔽紧接着的那次 click，避免「拖完球突然展开」
  mini.addEventListener(
    'click',
    (event) => {
      if (mini.dataset.justDragged !== '1') return;
      const draggable = event.target.closest('[data-mini-drag]') ||
        event.target.closest('.mini-copy') ||
        event.target.closest('#mini-chip');
      if (draggable) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  window.addEventListener('resize', () => {
    // 侧栏推开的那 180ms 里，窗口宽度每帧都在变。这里跟着每帧量一次矩形、再写一次
    // left/top，等于每帧强制同步布局 —— 画面正好在这时候卡。收尾补一次就够了。
    if (startNavAnimating()) return;
    if (mini.hidden) return;
    if (mini.classList.contains('is-on-start')) {
      // 启动页收起形态跟着抽屉标题行走；展开形态保持固定定位，窗口变了就重新夹紧
      if (!isMiniExpanded()) {
        positionStartMini(mini);
        return;
      }
    } else if (mini.classList.contains('is-docked')) {
      // 停靠态跟着侧栏走，窗口变化后重新贴一次，别只是夹紧在旧坐标上
      applyMiniPosition(mini);
      return;
    }
    if (!mini.hidden) {
      const rect = mini.getBoundingClientRect();
      const position = clampMiniPosition(mini, rect.left, rect.top);
      mini.style.left = `${position.x}px`;
      mini.style.top = `${position.y}px`;
      mini.style.right = 'auto';
      mini.style.bottom = 'auto';
    }
  });
}

function updateSongChrome() {
  const audio = document.querySelector('#song-audio');
  const mini = document.querySelector('#mini-player');
  const song = currentSongEntry();
  if (!audio || !mini) return;
  applyPlayModeUi();
  const playing = Boolean(audio.src && !audio.paused);
  // 总开关关掉时，就算是正在放歌也不显示（否则切一次界面它又自己冒出来）
  const visible = isMiniEnabled() && Boolean(audio.src) && state.route !== 'song';
  mini.hidden = !visible;
  if (visible) mini.style.removeProperty('display');
  else mini.style.setProperty('display', 'none', 'important');
  if (!visible) {
    // 没在放歌时把启动页形态也摘掉，免得 hidden 了窄条还挂着
    mini.classList.remove('is-start-chip');
    mini.classList.remove('is-on-start');
  }

  if (visible) {
    const onStart = state.route === 'start';
    // 收起形态统一成窄条：启动页嵌在「选择游戏」右边，其它页面停靠在侧栏上
    mini.classList.toggle('is-on-start', onStart);
    // 启动页展开形态是 body 固定定位的浮卡，不能再挂 is-start-chip（其 CSS 是 position:static）
    mini.classList.toggle('is-start-chip', onStart && !isMiniExpanded());
    mini.classList.toggle('is-chip', !isMiniExpanded());
    mini.classList.remove('is-chip');
    if (!isMiniExpanded()) mini.classList.add('is-chip');

    if (onStart) {
      // 启动页：收起形态由 positionStartMini 内嵌在抽屉标题行右侧的槽里；
      // 展开形态已经由 setMiniExpanded 挪到 body 固定定位，别再用 positionStartMini 拽回去
      mini.dataset.wasOnStart = '1';
      if (!isMiniExpanded()) {
        positionStartMini(mini);
      }
    } else {
      /*
       * 只有「真的从启动页切出来」这一次才丢弃原位锚点。
       * 之前这里无条件清空，而 updateSongChrome 每次渲染 / 每次播放状态变化都会跑，
       * 结果展开时刚记下的原位立刻被抹掉，收起只能走「按卡片中心缩」的兜底 ——
       * 表现就是「展开再收起，没回到原来的位置」。
       */
      const cameFromStart = mini.dataset.wasOnStart === '1';
      unmountStartMini(mini);
      if (cameFromStart) {
        // 离开启动页：启动页槽里的坐标不能再用于主页
        miniExpandOrigin = null;
        delete mini.dataset.draggedSinceExpand;
        delete mini.dataset.wasOnStart;
      }
      if (!mini.hidden) {
        // 离开启动页：清掉启动页留下的内联定位，交回按场景记忆的位置
        ['position', 'left', 'right', 'top', 'bottom', 'width'].forEach((prop) =>
          mini.style.removeProperty(prop)
        );
      }
    }
  }

  setupMiniPlayer();
  if (visible) requestAnimationFrame(() => applyMiniPosition(mini));
  if (visible && song) {
    const title = document.querySelector('#mini-title');
    const artist = document.querySelector('#mini-artist');
    const cover = mini.querySelector('.mini-cover');
    if (title) title.textContent = song.title || '未命名歌曲';
    if (artist) artist.textContent = song.artist || '音乐';
    if (cover) {
      const image = songCover(song);
      cover.style.backgroundImage = image ? `url("${image.replace(/"/g, '')}")` : '';
      cover.classList.toggle('has-cover', Boolean(image));
    }
    const toggle = document.querySelector('#mini-play-use');
    if (toggle) toggle.setAttribute('href', playing ? '#i-pause' : '#i-play');
    syncVolumeUi();
    const fill = document.querySelector('#mini-progress-fill');
    if (fill && Number.isFinite(audio.duration) && audio.duration > 0) {
      fill.style.width = `${Math.min(100, (audio.currentTime / audio.duration) * 100)}%`;
    }

    /* 启动页窄条：封面 + 歌名 + 播放键 */
    const chipCover = document.querySelector('#mini-chip-cover');
    if (chipCover) {
      const image = songCover(song);
      chipCover.style.backgroundImage = image ? `url("${image.replace(/"/g, '')}")` : '';
      chipCover.classList.toggle('has-cover', Boolean(image));
    }
    const chipTitle = document.querySelector('#mini-chip-title');
    if (chipTitle) chipTitle.textContent = song.title || '未命名歌曲';
    const chipArtist = document.querySelector('#mini-chip-artist');
    if (chipArtist) chipArtist.textContent = song.artist || '音乐';
    const chipPlay = document.querySelector('#mini-chip-play-use');
    if (chipPlay) chipPlay.setAttribute('href', playing ? '#i-pause' : '#i-play');
  }

  const progress = document.querySelector('#song-progress');
  if (progress && Number.isFinite(audio.duration) && audio.duration > 0) {
    progress.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  }
  const current = document.querySelector('#song-current');
  if (current) current.textContent = formatSongTime(audio.currentTime);
  const duration = document.querySelector('#song-duration');
  if (duration) duration.textContent = formatSongTime(audio.duration);
  if (song) {
    const dockTitle = document.querySelector('#dock-title');
    const dockNowTitle = document.querySelector('#dock-now-title');
    const dockArtist = document.querySelector('#dock-now-artist');
    const dockIcon = document.querySelector('#dock-play-use');
    if (dockTitle) dockTitle.textContent = song.title || '未播放';
    if (dockNowTitle) dockNowTitle.textContent = song.title || '未播放';
    if (dockArtist) dockArtist.textContent = song.artist || '';
    if (dockIcon) dockIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
  }

  /* 主页双人卡（火花 · 音乐遥控）：同步歌名和播放键图标，不用整页重绘 */
  const duoTitle = document.querySelector('#duo-song-title');
  if (duoTitle) duoTitle.textContent = song ? song.title || '未知曲目' : '队列空着，去点歌';
  document.querySelectorAll('.duo-ctrl[data-action="duo-toggle"] .duo-ic').forEach((node) => {
    const wantPlay = node.dataset.when === 'play';
    node.hidden = wantPlay === playing;
  });
}

function bindSongLyrics() {
  const audio = document.querySelector('#song-audio');
  if (!audio) return;
  if (audio.dataset.chromeBound !== '1') {
    audio.dataset.chromeBound = '1';
    audio.addEventListener('timeupdate', updateSongChrome);
    audio.addEventListener('loadedmetadata', updateSongChrome);
    audio.addEventListener('play', updateSongChrome);
    audio.addEventListener('pause', updateSongChrome);
    // 每秒记一次播放进度；暂停时立即记一次
    audio.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - (audio.dataset.progressAt || 0) < 1000) return;
      audio.dataset.progressAt = String(now);
      saveSongProgress();
    });
    audio.addEventListener('pause', saveSongProgress);
    audio.addEventListener('ended', updateSongChrome);
    audio.addEventListener('ended', () => {
      void handleSongEnded();
    });
    /*
     * 播不了（404 / 403 / 地址过期 / 音源失效）时 audio 只报 error，不会有 ended，
     * 以前这里没人管，队列就永远停在这一首。现在和超时一起走失败收口。
     */
    audio.addEventListener('error', () => {
      void handleSongFailed(describeAudioError(audio));
    });
    // 真的出声了：摘掉超时判定，清掉连续失败计数，顺手把这首的不可用标记洗掉
    audio.addEventListener('playing', () => {
      clearSongLoadWatchdog();
      songFailStreak = 0;
      const song = currentSongEntry();
      if (song?.unavailable) {
        song.unavailable = false;
        delete song.unavailableReason;
        saveSongs();
      }
    });
  }
  if (audio.dataset.fxErrorBound !== '1') {
    audio.dataset.fxErrorBound = '1';
    audio.addEventListener('error', () => {
      if (state.audioFx.preset !== 'off') disableAudioFxOnError();
    });
    audio.addEventListener('playing', () => clearFxWatchdog());
    audio.addEventListener('pause', () => clearFxWatchdog());
    audio.addEventListener('play', () => {
      if (state.audioFx.preset === 'off' || audioFxFallback) return;
      const graph = ensureAudioFxGraph(audio);
      if (graph && graph.context.state === 'suspended') graph.context.resume().catch(() => {});
      armFxWatchdog(audio);
    });
  }

  const progress = document.querySelector('#song-progress');
  if (progress) {
    progress.addEventListener('input', () => {
      if (audio.duration) audio.currentTime = (Number(progress.value) / 1000) * audio.duration;
    });
  }
  const quality = document.querySelector('#song-quality');
  if (quality) {
    quality.addEventListener('change', () => changeSongQuality(quality.value));
  }
  const dockQuality = document.querySelector('#dock-quality');
  if (dockQuality) {
    dockQuality.addEventListener('change', () => changeSongQuality(dockQuality.value));
  }
  const songMode = document.querySelector('#song-mode');
  if (songMode) {
    songMode.addEventListener('change', () => setPlayMode(songMode.value));
  }
  const dockMode = document.querySelector('#dock-play-mode');
  if (dockMode) {
    dockMode.addEventListener('change', () => setPlayMode(dockMode.value));
  }
  const box = document.querySelector('#song-lyrics');
  if (!box) {
    updateSongChrome();
    return;
  }
  const lines = [...box.querySelectorAll('.song-lyric-line')];
  /*
   * 重绘前用户是不是关掉了自动跟随（手动滚过歌词）。
   * 这是跨 render 保留的状态，否则每切一次界面就又自动滚了。
   */
  if (lyricFollowPaused && box.dataset.followPaused !== '1') {
    box.dataset.followPaused = '1';
  }
  let lastIndex = -1;
  const setActive = () => {
    const current = audio.currentTime || 0;
    let index = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (Number(lines[i].dataset.time) <= current) index = i;
      else break;
    }
    if (index !== lastIndex) {
      lines.forEach((line, i) => line.classList.toggle('active', i === index));
      lastIndex = index;
      /*
       * 只在「当前行变了」并且用户没手动滚过时才跟随。
       * 之前用 behavior:'smooth'，timeupdate 每 ~250ms 触发一次，
       * 平滑动画不断被打断重来，看起来就是歌词一直在滚。
       */
      if (index >= 0 && box.dataset.followPaused !== '1') {
        const line = lines[index];
        const top = line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2;
        box.scrollTop = Math.max(0, top);
      }
    }
  };
  /*
   * 用户自己滚歌词时暂停自动跟随，滚回底部附近再恢复。
   * 之前代码只读了 dataset.userScroll 却从没写过，所以这个功能从来没生效过。
   */
  let resumeTimer = 0;
  const markPaused = () => {
    box.dataset.followPaused = '1';
    lyricFollowPaused = true;
    window.clearTimeout(resumeTimer);
  };
  const onScroll = () => {
    // 滚到底部附近说明用户想回到跟播状态
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 24) {
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        delete box.dataset.followPaused;
        lyricFollowPaused = false;
      }, 1500);
    }
  };
  box.addEventListener('wheel', markPaused, { passive: true });
  box.addEventListener('touchmove', markPaused, { passive: true });
  box.addEventListener('scroll', onScroll, { passive: true });
  /*
   * #song-audio 可能在多次重绘之间复用，直接 addEventListener 会让
   * timeupdate 监听越积越多（每 250ms 跑好几遍 setActive）。
   * 先把上一次挂的摘掉，保证任何时候只有一份。
   */
  if (bindSongLyrics._audio && bindSongLyrics._setActive) {
    bindSongLyrics._audio.removeEventListener('timeupdate', bindSongLyrics._setActive);
    bindSongLyrics._audio.removeEventListener('loadedmetadata', bindSongLyrics._setActive);
  }
  bindSongLyrics._audio = audio;
  bindSongLyrics._setActive = setActive;
  audio.addEventListener('timeupdate', setActive);
  audio.addEventListener('loadedmetadata', setActive);
  setActive();
  updateSongChrome();
}

async function hydrateSong(song) {
  if (!song) return;
  // 网易云曲目走本地 API 补歌手/封面/歌词；别的平台的曲目用跨平台搜索补歌词
  if (song.neteaseId) {
    if (song.metaChecked || (song.lyric && song.cover && song.artist)) return;
    try {
      const meta = await api.netease.songMeta({
        apiBase: localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100',
        id: song.neteaseId,
      });
      song.metaChecked = true;
      if (!meta) return;
      if (meta.artist) song.artist = meta.artist;
      if (meta.cover && !song.cover) song.cover = meta.cover;
      if (meta.lyric) song.lyric = meta.lyric;
      saveSongs();
    } catch {
      /* local service may be offline */
    }
    return;
  }
  // 非网易云：没有原生歌词接口时去酷我 / QQ 找 LRC
  if (song.lyric || song.lyricChecked) return;
  try {
    const result = await api.musicLyric({
      song: {
        title: song.title,
        artist: song.artist,
        album: song.album,
        platform: song.platform || song.source || '',
        mid: song.mid,
        hash: song.hash,
        neteaseId: song.neteaseId,
      },
      apiBase: localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100',
    });
    song.lyricChecked = true;
    if (result?.ok && result.lyric) {
      song.lyric = result.lyric;
      saveSongs();
    }
  } catch {
    song.lyricChecked = true;
    /* 拉不到歌词就拉不到，不阻断播放 */
  }
}

/**
 * 按 bilibili 房间号找到对应的卡片房间对象（app 内部 id 与 B 站房间号不是同一个，
 * 主进程回传的事件里带的是 B 站房间号，所以要用 roomId 反查）。
 */
function findBiliRoom(biliRoomId) {
  return state.liveRooms.find((r) => r.platform === 'bilibili' && String(r.roomId) === String(biliRoomId));
}

/** 点歌页才重绘卡片，避免别的页面无谓刷新。 */
function renderLiveIfNeeded() {
  if (state.route === 'song') render({ preserveScroll: true });
}

/**
 * 主进程转发过来的弹幕事件统一在这里落地到 UI。
 * 全部连接逻辑（建连 / 鉴权 / 心跳 / 断线重连 / 服务器轮换）都在主进程，
 * 这里只把事件翻译成卡片状态 + 把弹幕喂给点歌匹配。
 */
function handleBiliDanmuEvent(payload) {
  if (!payload || !payload.roomId) return;
  const room = findBiliRoom(payload.roomId);
  if (!room) return;
  switch (payload.type) {
    case 'pushing':
      // 服务器对 auth 包回了确认：从这刻起才真的在推弹幕（之前"已连接"只是 TCP 握手）
      room.status = '弹幕推送中';
      renderLiveIfNeeded();
      break;
    case 'danmu': {
      // 捕获数直接用主进程累计值；卡片上数字动 = 服务器真的在推，否则是连接没活
      room.captured = payload.captured || (room.captured || 0) + 1;
      const node = document.querySelector(`#live-captured-${room.id} b`);
      if (node) node.textContent = String(room.captured);
      handleLiveDanmaku(payload.message, payload.user);
      break;
    }
    case 'open':
      room.connected = true;
      room.connecting = false;
      if (room.lastRetryAt && Date.now() - room.lastRetryAt > 5 * 60 * 1000) room.retryCount = 0;
      room.status = payload.status || '已连接';
      // 只在第一次连上弹提示，换服务器 / 自动重连成功不重复弹
      if (!room.toastedLive) {
        room.toastedLive = true;
        toast(`已连接直播间：${room.roomTitle}`, 'success');
      }
      renderLiveIfNeeded();
      break;
    case 'status':
      room.status = payload.status || room.status;
      renderLiveIfNeeded();
      break;
    case 'reconnecting':
      room.connecting = false;
      room.connected = false;
      room.status = `连接中断（code ${payload.code ?? '未知'}），3 秒后自动重连 ${payload.tries}/3…`;
      renderLiveIfNeeded();
      break;
    case 'closed':
      room.connected = false;
      room.connecting = false;
      if (payload.code != null) room.lastCloseCode = payload.code;
      room.status = payload.status || '已断开';
      renderLiveIfNeeded();
      break;
    default:
      break;
  }
}


/*
 * decodeBiliFrame 已删除：弹幕帧的解码（zlib/brotli 解压 + DANMU_MSG 提取）现在
 * 全部在主进程用 Node 栈完成，主进程解出来后只把 {type:'danmu',message,user,captured}
 * 通过 live:danmu-event 回传，渲染层不再碰原始二进制帧。
 */

/** 关掉一个房间的运行时链路（B 站 WebSocket / 其它平台的轮询与隐藏窗口）。 */
function closeLiveRuntime(room) {
  const rt = liveRuntimes.get(room.id);
  if (rt) {
    liveRuntimes.delete(room.id);
    if (rt.heartbeat) clearInterval(rt.heartbeat);
    if (rt.timer) clearInterval(rt.timer);
    if (rt.socket) {
      // 标记是用户主动关的：close 事件据此判断要不要自动重连
      rt.closedByUser = true;
      try {
        rt.socket.close();
      } catch {
        /* ignore */
      }
    }
  }
  if (room.danmaku === 'bridge') {
    try {
      api.live.danmakuStop(room.id);
    } catch {
      /* 主进程没起来时忽略 */
    }
  }
  // B 站弹幕连接现在在主进程：主动断开要通知主进程，否则主进程还在重连 / 继续推弹幕。
  // 这里会把它在 biliDanmuConnections 里的连接标记为 closedByUser 并 close，
  // 主进程回一个 closed 事件，但房间卡片已经先被摘掉了，handleBiliDanmuEvent 会 no-op。
  if (room.platform === 'bilibili' && room.roomId) {
    try {
      api.live.danmuDisconnect(room.roomId);
    } catch {
      /* 主进程没起来时忽略 */
    }
  }
}

/** 从列表里摘掉一个房间并关链路（卡片上的「断开」按钮）。 */
function disconnectLiveRoom(id) {
  const idx = state.liveRooms.findIndex((r) => r.id === id);
  if (idx < 0) return;
  const [room] = state.liveRooms.splice(idx, 1);
  closeLiveRuntime(room);
  toast(`已断开：${room.roomTitle || room.platformLabel || '直播间'}`, 'info');
  if (state.route === 'song') render({ preserveScroll: true });
}

/** 兼容旧调用：断开全部（app 退出等场景）。 */
function disconnectBiliLive() {
  for (const room of state.liveRooms.splice(0)) closeLiveRuntime(room);
  if (state.route === 'song') render({ preserveScroll: true });
}

/*
 * buildBiliWsUrls 已删除：弹幕服务器候选地址（每 host 先 443 再自报端口、末尾补
 * broadcastlv:443）现在由主进程的 biliBuildWsUrls 负责，渲染层不再拼 WebSocket URL。
 */

/*
 * connectBiliWs / reconnectBiliRoom 已删除：B 站弹幕的建连、鉴权、心跳、断线重连、
 * 服务器轮换、token 刷新现在全部在主进程（electron/main.js 的 biliOpenWs /
 * biliReconnect）完成。渲染层只通过 api.live.danmuConnect({roomId,token,hosts}) 发起，
 * 再由 handleBiliDanmuEvent 接收主进程回传的 open/pushing/danmu/status/closed/
 * reconnecting 事件来更新卡片与喂点歌。这样长连接跑在 Node 栈上，不再受 Chromium
 * 出站长连接约 70 秒被本机网络层掐断的限制（实测 ≥95 秒稳定）。
 */


/**
 * 连接直播间（可同时连多个：B站+抖音+斗鱼…并存，弹幕汇进同一个点歌处理）。
 *
 * B站：官方 WebSocket，auth 带弹幕鉴权 token（见下方说明）。
 * 其它平台：主进程隐藏窗口抓聊天区（见 electron/live-danmaku.js）。
 */
async function connectLiveRoom(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return;
  // 同一个链接重复连接：先把旧的顶掉；这个链接还在连接中就直接忽略（防连点重复建卡）
  const dup = state.liveRooms.find((r) => r.url === url);
  if (dup) {
    if (dup.connecting) return;
    disconnectLiveRoom(dup.id);
  }

  state.live.roomUrl = url;
  localStorage.setItem('vela:live-room-url', url);
  const room = {
    id: `room-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    url,
    connected: false,
    connecting: true,
    roomTitle: '',
    roomId: '',
    platform: '',
    platformLabel: '',
    danmaku: '',
    status: '连接直播间…',
    captured: 0,
  };
  state.liveRooms.push(room);
  /*
   * 之前这里把全局 state.live.connecting 锁成 true 且只有"解析房间失败"才解锁，
   * 导致连过一次后表单永远显示"连接中"、输入框废掉（断开也不恢复）。
   * 多房间并存后每个房间卡自己显示"连接中"，表单不该被全局锁死——常保持可填可点。
   */
  state.live.connecting = false;
  render({ preserveScroll: true });
  try {
    const info = await api.live.room(url);
    room.platform = info.platform || '';
    room.platformLabel = info.platformLabel || '';
    room.roomId = info.roomId;
    room.roomTitle = info.title || `房间 ${info.roomId}`;
    room.danmaku = info.danmaku || '';
    room.status = info.note || '';
    // 连接成功就记进历史（去重、最新在前、最多 5 个），重启后一键重连
    state.liveHistory = [url, ...(state.liveHistory || []).filter((item) => item !== url)].slice(0, 5);
    localStorage.setItem('vela:live-room-history', JSON.stringify(state.liveHistory));

    if (room.platform !== 'bilibili') {
      await startBridgeLive(room);
      return;
    }

    /*
     * 先拿弹幕鉴权：官方 WS 的 auth 包必须带 getDanmuInfo 发的 token（key），
     * 不带 key 服务器接受连接但一条弹幕都不推——"已连接却收不到点歌"的根因。
     * 顺便用 host_list 里的弹幕服务器，比写死的 broadcastlv 更稳。
     */
    let authKey = '';
    let hosts = [];
    try {
      const danmu = await api.live.danmuInfo(room.roomId);
      if (danmu?.token) authKey = String(danmu.token);
      hosts = Array.isArray(danmu?.hosts) ? danmu.hosts : [];
      // 存一份：断线重连时 5 分钟内直接复用，不用每次都重新请求鉴权
      room.danmuToken = authKey;
      room.danmuHosts = hosts;
      room.danmuAt = Date.now();
    } catch (error) {
      /*
       * 拿不到鉴权就直接不连：B 站服务器对空 key 的连接"接受但一条弹幕都不推"，
       * 以前这里静默继续，用户看到"已连接"却永远收不到点歌，还以为是自己房间没开播的问题。
       * 现在把失败原因亮在卡片上（-352 = B站风控），用户能自己判断要不要重试。
       */
      room.connecting = false;
      room.connected = false;
      room.status = `弹幕鉴权失败：${error.message}`;
      if (state.route === 'song') render({ preserveScroll: true });
      toast(`B站弹幕鉴权失败：${error.message}`, 'error');
      return;
    }

    /*
     * 弹幕长连接已迁到主进程：这里只把鉴权 token + hosts 交给主进程，
     * 真正的建连 / 心跳 / 断线重连 / 服务器轮换全由主进程（Node 栈）负责，
     * 根治渲染层出站长连接约 70 秒被本机网络层掐断的问题。
     * 卡片先置成"连接中"，主进程回 open 事件再改"已连接"，避免一瞬间状态跳变。
     */
    room.connecting = true;
    room.connected = false;
    room.status = '连接直播间…';
    renderLiveIfNeeded();
    api.live.danmuConnect({ roomId: room.roomId, token: authKey, hosts });
  } catch (error) {
    // 房间信息都解析不出来：从列表里摘掉，别留一张永远转圈的卡
    const idx = state.liveRooms.indexOf(room);
    if (idx >= 0) state.liveRooms.splice(idx, 1);
    state.live.connecting = false;
    toast(`直播间连接失败：${error.message}`, 'error');
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

/**
 * 斗鱼 / 虎牙 / 抖音 / 快手：后台隐藏窗口抓聊天区（每路房间一个窗口）。
 *
 * 这几个平台没有公开弹幕协议（斗鱼 TCP、虎牙 Tars、抖音/快手要签名），
 * 硬啃私有协议平台一改版就废。这里让主进程开一个隐藏窗口真的把直播间网页
 * 加载出来，只读聊天区的文字；视频流在请求阶段就被拦掉，不会真的把流拉下来。
 * captured 计数会显示在卡片上：观众发了弹幕但计数不动 = 这个站抓取失效。
 */
async function startBridgeLive(room) {
  const label = room.platformLabel || '该平台';
  try {
    const started = await api.live.danmakuStart({ url: room.url, platform: room.platform, id: room.id });
    room.connected = true;
    room.connecting = false;
    room.danmaku = 'bridge';
    room.status = started?.status || '已连接';
    if (started?.pageTitle && !room.roomTitle) room.roomTitle = started.pageTitle;
    toast(`已连接${label}直播间：${room.roomTitle}`, 'success');
    if (state.route === 'song') render({ preserveScroll: true });

    const rt = liveRuntimes.get(room.id) || {};
    liveRuntimes.set(room.id, rt);
    rt.timer = setInterval(async () => {
      let payload = null;
      try {
        payload = await api.live.danmakuPoll(room.id);
      } catch {
        return;
      }
      if (!payload) return;
      room.captured = payload.captured ?? room.captured;
      if (payload.status && payload.status !== room.status) {
        room.status = payload.status;
        if (state.route === 'song') render({ preserveScroll: true });
      }
      if (!payload.alive) {
        disconnectLiveRoom(room.id);
        toast(`${label}弹幕已断开：${payload.status || '连接失效'}`, 'info');
        return;
      }
      for (const item of payload.messages || []) {
        handleLiveDanmaku(item.text, item.user);
      }
    }, 900);
  } catch (error) {
    const idx = state.liveRooms.indexOf(room);
    if (idx >= 0) state.liveRooms.splice(idx, 1);
    // 起窗口过程中失败时别把隐藏窗口留成孤儿
    try {
      api.live.danmakuStop(room.id);
    } catch {
      /* ignore */
    }
    toast(`${label}弹幕连接失败：${error.message}`, 'error');
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

let liveRequestBusy = false;
/**
 * 把榜单曲目转成点歌台可以播放的网易云条目。
 * 找不到可播版本时返回 false，不打断批量导入。
 */
/**
 * 登录成功后统一同步歌单。
 *
 * 以前登录完只拉「当前选中平台」那一个列表，而且写的是 state.myPlaylists.list，
 * 把分组结构 groups 整个冲掉，切到「我的歌单」还是空的，得手动点一次刷新。
 * 现在改成：清缓存 → 三个平台一起读 → 用 toast 报一下各自读到多少。
 */
async function syncPlaylistsAfterLogin(platform) {
  invalidateAllPlaylists();
  if (state.route === 'song') render({ preserveScroll: true });
  await loadAllPlaylists(true);
  if (!platform) return;
  const label = platform === 'netease' ? '网易云' : platform === 'qq' ? 'QQ 音乐' : platform === 'kuwo' ? '酷我' : '酷狗';
  const group = (state.myPlaylists.groups || []).find((item) => item.platform === platform);
  const count = (group?.list || []).length;
  if (group?.error) {
    toast(`${label} 已登录，歌单没读到：${group.error}`, 'info');
  } else {
    toast(count ? `${label} 歌单已同步 · ${count} 个` : `${label} 账号下还没有歌单`, count ? 'success' : 'info');
  }
}

/**
 * 某个平台是不是已登录。
 *
 * 网易云有两处状态（本地 API 的 neteaseLogin 和 musicStatus 里的 netease），
 * 哪边先读到都算登录，不然「我的歌单」会因为读错那一处而漏掉网易云。
 */
function musicLoggedIn(platform) {
  if (platform === 'netease') {
    return Boolean(state.musicLogin?.netease?.loggedIn || state.neteaseLogin?.loggedIn);
  }
  return Boolean(state.musicLogin?.[platform]?.loggedIn);
}

/* ---------- 歌单广场（公开热门歌单，免登录） ---------- */

/** 广场单个平台的缓存：{ loading, list, page, error, done }。 */
function plazaState(platform) {
  const plaza = state.myPlaylists.plaza || (state.myPlaylists.plaza = {});
  return plaza[platform] || (plaza[platform] = { loading: false, list: [], page: 0, error: '', done: false });
}

/** 播放量格式化：过万就折算成「x.x万」。 */
function formatPlaycount(n) {
  const num = Number(n) || 0;
  if (num >= 100000000) return (num / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(num);
}

/** 确保某个平台的广场第一页已经加载。 */
async function ensurePlaza(platform, force = false) {
  const plaza = plazaState(platform);
  if (plaza.loading) return;
  if (!force && (plaza.list.length || plaza.done)) return;
  plaza.loading = true;
  plaza.error = '';
  if (state.route === 'song') render({ preserveScroll: true });
  try {
    const result = await api.musicPlaza(platform, 1);
    if (result?.ok && Array.isArray(result.lists)) {
      plaza.list = result.lists;
      plaza.page = 1;
      plaza.done = result.lists.length < 10;
    } else {
      plaza.error = result?.reason || '读取歌单广场失败';
    }
  } catch (error) {
    plaza.error = humanError(error);
  } finally {
    plaza.loading = false;
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

/** 广场翻页：下一页追加，按 id 去重。 */
async function plazaMore(platform) {
  const plaza = plazaState(platform);
  if (plaza.loading || plaza.done) return;
  const next = (plaza.page || 1) + 1;
  plaza.loading = true;
  if (state.route === 'song') render({ preserveScroll: true });
  try {
    const result = await api.musicPlaza(platform, next);
    if (result?.ok && Array.isArray(result.lists)) {
      const seen = new Set(plaza.list.map((item) => item.id));
      const fresh = result.lists.filter((item) => !seen.has(item.id));
      plaza.list.push(...fresh);
      plaza.page = next;
      plaza.done = fresh.length === 0;
    } else {
      plaza.error = result?.reason || plaza.error;
      plaza.done = true;
    }
  } catch (error) {
    plaza.error = humanError(error);
    plaza.done = true;
  } finally {
    plaza.loading = false;
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

/** 广场分区：平台切换 + 卡片网格 + 加载更多。 */
function plazaSectionMarkup() {
  const platforms = [
    ['netease', '网易云'],
    ['qq', 'QQ 音乐'],
    ['kugou', '酷狗'],
    ['kuwo', '酷我'],
  ];
  const active = state.myPlaylists.plazaPlatform || 'netease';
  const plaza = plazaState(active);
  const tabs = platforms
    .map(([key, label]) =>
      `<button class="song-chart-tab ${active === key ? 'active' : ''}" data-action="plaza-platform" data-value="${key}">${label}</button>`
    )
    .join('');
  let body = '';
  if (plaza.error && !plaza.list.length) {
    body = `<div class="playlists-error">${icon('alert', 'xs')}<span>${esc(plaza.error)}</span>
      <button class="link-btn" data-action="plaza-retry" data-platform="${esc(active)}">重试</button></div>`;
  } else if (!plaza.list.length) {
    body = `<p class="playlists-group-note">${plaza.loading ? '正在读取广场歌单…' : '广场暂时没有内容。'}</p>`;
  } else {
    const detail = state.myPlaylists.detail;
    body = `<div class="playlist-cards">
      ${plaza.list.map((item) => playlistCardMarkup(item, active, Boolean(detail && detail.id === item.id && detail.platform === active))).join('')}
    </div>
    ${plaza.loading ? '<p class="playlists-group-note">正在加载更多…</p>' : plaza.done ? '' : `<div class="plaza-more-wrap"><button class="playlists-chip" data-action="plaza-more" data-platform="${esc(active)}">${icon('plus', 'xs')}加载更多</button></div>`}`;
  }
  return `<section class="plaza-section">
    <div class="playlists-bar">
      <div class="playlists-bar-title"><strong>歌单广场</strong><span>热门公开歌单 · 点开看曲目，免登录</span></div>
      <div class="playlists-bar-actions"><span class="song-chart-tabs">${tabs}</span></div>
    </div>
    ${body}
  </section>`;
}

/**
 * 把一次全平台同步的结果并进现有分组。
 *
 * 为什么要合并而不是直接替换：某个平台这次读失败（登录过期、接口抽风）时，
 * 上次读到的歌单其实还能用，直接替换会把它连卡片一起抹掉。
 * 这里保留旧列表并打上 stale 标记，只把失败原因标在那一个平台上，别的平台照常。
 *
 * 顺序以后端返回的为准（主进程已经按 netease / qq / kugou / kuwo 固定排好），
 * 只有后端没返回的已登录平台才补到末尾，不在渲染层再排一次。
 */
function mergeAllPlaylistGroups(logged, incoming) {
  const prev = state.myPlaylists.groups || [];
  const list = Array.isArray(incoming) ? incoming : [];
  const keys = list.map((group) => group.platform).filter((key) => logged.includes(key));
  logged.forEach((key) => {
    if (!keys.includes(key)) keys.push(key);
  });

  return keys.map((key) => {
    const fresh = list.find((group) => group.platform === key);
    const old = prev.find((group) => group.platform === key);
    if (!fresh) {
      // 后端这次没返回这个平台（多半是登录态刚变），别把它永远停在「同步中」
      if (old) return old;
      return {
        platform: key,
        label: musicPlatformLabel(key),
        ok: false,
        list: [],
        error: '这次同步没有返回这个平台，稍后再试一次',
      };
    }
    if (fresh.ok) return fresh;
    if (old && (old.list || []).length) return { ...fresh, list: old.list, stale: true };
    return fresh;
  });
}

/**
 * 「上次同步：3 分钟前 · 耗时 1.2s」。
 *
 * 主进程返回 syncedAt / durationMs 就是给这个用的：
 * 歌单同步慢起来要几十秒，没有时间戳用户没法判断该不该再点一次。
 */
function playlistSyncSummary() {
  const at = Number(state.myPlaylists.syncedAt) || 0;
  if (!at) return '';
  const diff = Date.now() - at;
  const when = diff < 60 * 1000 ? '刚刚' : relativeDate(at);
  const ms = Number(state.myPlaylists.syncDurationMs) || 0;
  const cost = ms ? ` · 耗时 ${(ms / 1000).toFixed(1)}s` : '';
  return `上次同步：${when}${cost}`;
}

/**
 * 这个平台是不是正在同步。
 *
 * 三处地方共用：左栏平台行、主区平台分区、「同步全部」按钮的禁用态。
 * 全量同步的时候四个平台都在转，所以 loadingAll 为真一律算同步中。
 */
function playlistSyncing(platform) {
  if (state.myPlaylists.loadingAll) return true;
  const map = state.myPlaylists.syncing || (state.myPlaylists.syncing = {});
  return Boolean(map[platform]);
}

/** 某个平台自己的「上次同步」文案；没同步过就返回空串（不显示）。 */
function playlistSyncWhen(group, { withCost = false } = {}) {
  const at = Number(group?.syncedAt) || 0;
  if (!at) return '';
  const diff = Date.now() - at;
  const when = diff < 60 * 1000 ? '刚刚' : relativeDate(at);
  const ms = Number(group?.durationMs) || 0;
  return withCost && ms ? `上次同步：${when} · 耗时 ${(ms / 1000).toFixed(1)}s` : `上次同步：${when}`;
}

/**
 * 只把「一个平台」的结果并回分组，其它平台原样不动。
 *
 * 这是单平台同步的关键：库里另外三个平台的对象引用一个都不换，
 * 所以不会出现「点了酷狗，网易云的卡片闪一下重新加载」。
 * 失败时保留上次读到的列表（打 stale 标记），把原因挂在这一个平台上。
 */
function applyPlaylistGroup(platform, fresh, meta = {}) {
  const prev = state.myPlaylists.groups || [];
  const index = prev.findIndex((group) => group.platform === platform);
  const old = index >= 0 ? prev[index] : null;
  const syncedAt = Number(meta.syncedAt) || Date.now();
  const durationMs = Number(meta.durationMs) || 0;

  let next;
  if (!fresh) {
    /*
     * 后端没返回这个平台：多半是登录态在服务端已经失效（本地还留着「已登录」）。
     * 旧数据留着别抹掉，但要挂上原因，否则用户点完同步看不出任何变化，
     * 还会以为歌单没更新。
     */
    const reason = '这次没取到这个平台的歌单，可能登录已经失效了，重新登录一次试试';
    next = old
      ? { ...old, ok: false, error: reason, stale: true, syncedAt, durationMs }
      : {
          platform,
          label: musicPlatformLabel(platform),
          ok: false,
          list: [],
          error: reason,
          syncedAt,
          durationMs,
        };
  } else if (fresh.ok) {
    next = { ...fresh, syncedAt, durationMs };
  } else if (old && (old.list || []).length) {
    next = { ...fresh, list: old.list, stale: true, syncedAt, durationMs };
  } else {
    next = { ...fresh, syncedAt, durationMs };
  }

  const groups = prev.slice();
  if (index >= 0) groups[index] = next;
  else groups.push(next);
  state.myPlaylists.groups = groups;
  // 有结果就排一次落盘：下次冷启动能直接画出这面卡片墙。
  // skipCache 是「刚从磁盘读回来的」，没必要马上又写一遍。
  if (!meta.skipCache) schedulePlaylistsCacheSave();
  return next;
}

/**
 * 把「链接导入」的歌单并进「我的歌单」对应平台分组。
 *
 * 酷狗等平台的账号歌单同步已被官方关掉，链接导入是往「我的歌单」里添歌单的唯一入口，
 * 所以导入成功后要主动并进来，不然导入完在「我的歌单」里永远看不到。
 * 分组不存在就新建一个；同 id 已存在就原地覆盖（刷新名字/封面/曲目数）。
 * 歌单打上 imported 标记：缓存恢复时未登录的平台只捞回导入的歌单，
 * 账号同步出来的私有歌单不该在没登录时出现。
 */
function mergeImportedPlaylist(platform, entry) {
  const key = String(platform || '');
  const id = String(entry?.id || '');
  if (!key || !id) return null;
  const item = {
    id,
    name: String(entry?.name || '').trim() || '导入的歌单',
    cover: String(entry?.cover || ''),
    count: Number(entry?.count) || 0,
    creator: String(entry?.creator || ''),
    playcount: Number(entry?.playcount) || 0,
    imported: true,
  };
  const groups = (state.myPlaylists.groups || []).slice();
  const index = groups.findIndex((group) => group.platform === key);
  if (index < 0) {
    // 新分组不带 syncedAt：导入不是同步，「上次同步」不该显示一个假时间
    groups.push({ platform: key, label: musicPlatformLabel(key), ok: true, list: [item] });
  } else {
    const group = groups[index];
    const list = (group.list || []).slice();
    const at = list.findIndex((old) => String(old?.id) === id);
    if (at >= 0) list[at] = { ...list[at], ...item };
    else list.push(item);
    // 导入成功说明这张歌单是好的，把之前同步失败挂着的红字清掉，别让卡片墙顶着报错显示
    groups[index] = { ...group, list, ok: true, error: '', stale: false };
  }
  state.myPlaylists.groups = groups;
  // 跟账号同步一样排一次落盘，冷启动才能把导入的歌单画回来
  schedulePlaylistsCacheSave();
  return item;
}


/**
 * 一次性拉取所有已登录平台的歌单。
 * 用 loadingAll 防重入，避免每帧 render 都触发请求。
 *
 * 这是「同步全部」的入口。单个平台的同步走 loadPlaylistsFor：一次只问后端要一个平台，
 * 其它平台的歌单对象一个都不换，这样点酷狗不会连带把网易云重新拉一遍。
 * 主进程 music:all-playlists 不带参数时仍然是四家并发、按固定平台顺序返回整包。
 */
async function loadAllPlaylists(force = false) {
  const logged = ['netease', 'qq', 'kugou', 'kuwo'].filter(musicLoggedIn);
  if (!logged.length) return;
  if (state.myPlaylists.loadingAll) return;
  if (!force && state.myPlaylists.groups?.length) return;

  state.myPlaylists.loadingAll = true;
  if (state.route === 'song') render({ preserveScroll: true });
  /*
   * 兜底：主进程那边每一步都有超时，但万一整条 IPC 卡死（比如内置窗口
   * 被系统挂起），界面就会一直停在「正在读取」。这里放一个上限，
   * 到点自己收尾，至少让用户看到「读取超时」而不是无限转圈。
   * 已经读到过的平台不受影响 —— 不能因为一次超时把好好的卡片也清掉。
   */
  const guard = setTimeout(() => {
    if (!state.myPlaylists.loadingAll) return;
    state.myPlaylists.loadingAll = false;
    state.myPlaylists.groups = logged.map((key) => {
      const old = (state.myPlaylists.groups || []).find((group) => group.platform === key);
      if (old && (old.list || []).length) return old;
      return {
        platform: key,
        label: musicPlatformLabel(key),
        ok: false,
        list: [],
        error: '读取超时了，稍后再点一次同步',
      };
    });
    if (state.route === 'song') render({ preserveScroll: true });
  }, 75000);
  try {
    const result = await api.musicAllPlaylists();
    state.myPlaylists.groups = mergeAllPlaylistGroups(logged, Array.isArray(result?.groups) ? result.groups : []);
    /*
     * syncedAt / durationMs 由主进程给：四家现在全并发，一次同步的耗时和完成时刻
     * 只有后端最清楚。界面拿它显示「上次同步：x 分钟前 · 耗时 1.2s」。
     */
    state.myPlaylists.syncedAt = Number(result?.syncedAt) || Date.now();
    state.myPlaylists.syncDurationMs = Number(result?.durationMs) || 0;
    state.myPlaylists.error = '';
    // 每个平台也各记一份，左栏平台行才有自己的「x 分钟前」
    stampPlaylistGroups(logged, state.myPlaylists.syncedAt, state.myPlaylists.syncDurationMs);
    schedulePlaylistsCacheSave();
  } catch (error) {
    // 整体失败（IPC 层就挂了）时，失败原因摊到每个平台，但已经成功拿到歌单的平台保持原样
    const message = humanError(error);
    state.myPlaylists.groups = logged.map((key) => {
      const old = (state.myPlaylists.groups || []).find((group) => group.platform === key);
      if (old && old.ok && (old.list || []).length) return old;
      return {
        platform: key,
        label: musicPlatformLabel(key),
        ok: false,
        list: [],
        error: message,
      };
    });
  } finally {
    clearTimeout(guard);
    state.myPlaylists.loadingAll = false;
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

/** 给一批平台的分组统一盖上同步时间戳（全量同步共用同一个时刻）。 */
function stampPlaylistGroups(platforms, syncedAt, durationMs) {
  const at = Number(syncedAt) || Date.now();
  const ms = Number(durationMs) || 0;
  state.myPlaylists.groups = (state.myPlaylists.groups || []).map((group) =>
    platforms.includes(group.platform) ? { ...group, syncedAt: at, durationMs: ms } : group
  );
}

/**
 * 只同步一个平台。
 *
 * 后端契约：musicAllPlaylists({ platforms: ['kugou'] }) 只回这一个平台的分组。
 * 前端也只把这个平台并回去，别写成整包替换 —— 那等于又把四家重拉了一遍，
 * 正是用户抱怨的「点一次同步，全部平台都重新转」。
 *
 * 老版本 preload 会忽略参数、照旧回全部平台；这种情况我们仍然只取要的那个平台，
 * 界面行为是一致的，只是白跑了后端，不影响正确性。
 */
async function loadPlaylistsFor(platform) {
  const key = String(platform || '');
  if (!key) return null;
  if (!musicLoggedIn(key)) return null;
  if (state.myPlaylists.loadingAll) return null;
  if (playlistSyncing(key)) return null;

  const map = state.myPlaylists.syncing || (state.myPlaylists.syncing = {});
  map[key] = true;
  if (state.route === 'song') render({ preserveScroll: true });

  // 单个平台也有超时兜底，卡住时只影响它自己，别的平台的数据不动
  const guard = setTimeout(() => {
    if (!map[key]) return;
    map[key] = false;
    applyPlaylistGroup(
      key,
      { platform: key, label: musicPlatformLabel(key), ok: false, list: [], error: '读取超时了，稍后再点一次同步' },
      {}
    );
    if (state.route === 'song') render({ preserveScroll: true });
  }, 60000);

  try {
    const result = await api.musicAllPlaylists({ platforms: [key] });
    const incoming = Array.isArray(result?.groups) ? result.groups : [];
    const fresh = incoming.find((group) => group && group.platform === key) || null;
    applyPlaylistGroup(key, fresh, {
      syncedAt: Number(result?.syncedAt) || Date.now(),
      durationMs: Number(result?.durationMs) || 0,
    });
  } catch (error) {
    applyPlaylistGroup(
      key,
      { platform: key, label: musicPlatformLabel(key), ok: false, list: [], error: humanError(error) },
      {}
    );
  } finally {
    clearTimeout(guard);
    map[key] = false;
    if (state.route === 'song') render({ preserveScroll: true });
  }
  return (state.myPlaylists.groups || []).find((group) => group.platform === key) || null;
}

/**
 * 「只同步这个平台」按钮的入口：结果说清楚，失败也只在它自己身上。
 */
async function syncOnePlaylist(platform) {
  const key = String(platform || '');
  if (!key) return;
  const label = musicPlatformLabel(key);
  if (!musicLoggedIn(key)) {
    toast(`${label} 还没登录，先登录再同步`, 'info');
    openMusicAccountsModal(key);
    return;
  }
  if (state.myPlaylists.loadingAll) {
    toast('正在同步全部平台，等这一轮跑完再单独同步', 'info');
    return;
  }
  if (playlistSyncing(key)) return;

  const group = await loadPlaylistsFor(key);
  if (!group) return;
  const count = (group.list || []).length;
  if (group.ok) {
    toast(count ? `${label} 已同步，${count} 个歌单` : `${label} 已同步，这个账号下还没有歌单`, 'success');
    return;
  }
  const reason = group.error || '没读到歌单';
  toast(
    group.stale ? `${label} 这次没读到，先显示上次的结果：${reason}` : `${label} 同步失败：${reason}`,
    group.stale ? 'info' : 'error'
  );
}

/**
 * 「同步全部」：一次请求把所有已登录平台的歌单拉齐，并把结果说清楚。
 *
 * 左栏顶部的「同步全部」走这一条；各平台行里的刷新按钮走 syncOnePlaylist。
 * 两条路各管各的范围，界面上也各自标「同步中」。
 */
async function syncAllPlaylists() {
  const logged = ['netease', 'qq', 'kugou', 'kuwo'].filter(musicLoggedIn);
  if (!logged.length) {
    toast('还没有登录音乐账号，先登录一个再同步', 'info');
    openMusicAccountsModal();
    return;
  }
  if (state.myPlaylists.loadingAll) return;
  await loadAllPlaylists(true);
  const groups = state.myPlaylists.groups || [];
  const failed = groups.filter((group) => !group.ok);
  if (!failed.length) {
    toast(`已同步 ${groups.length} 个平台的歌单`, 'success');
    return;
  }
  // 失败要指名道姓：只说「同步失败」用户不知道是哪个平台出了问题
  const names = failed.map((group) => group.label || musicPlatformLabel(group.platform)).join('、');
  toast(
    failed.length === groups.length
      ? `同步失败：${names} 都没读到`
      : `${groups.length - failed.length} 个平台已同步，${names} 没读到`,
    failed.length === groups.length ? 'error' : 'info'
  );
}

/**
 * 渲染期间确保所有平台的歌单已经有着落。
 */
function ensureAllPlaylistsLoaded() {
  const logged = ['netease', 'qq', 'kugou', 'kuwo'].filter(musicLoggedIn);
  if (!logged.length) return;
  if (state.myPlaylists.loadingAll) return;
  // 正在单独同步某个平台时别再插一次全量请求，两边同时写 groups 只会互相盖
  if (Object.values(state.myPlaylists.syncing || {}).some(Boolean)) return;
  if (state.myPlaylists.groups?.length) return;
  loadAllPlaylists();
}

/**
 * 切账号 / 退出登录后，已有的歌单缓存就过期了，清掉重新拉。
 */
function invalidateAllPlaylists() {
  state.myPlaylists.groups = [];
  state.myPlaylists.loadingAll = false;
  // 各平台的同步开关也要一起复位，否则退登录后那行会一直停在「同步中」
  state.myPlaylists.syncing = { netease: false, qq: false, kugou: false, kuwo: false };
  /*
   * 歌单详情缓存一并清掉：登录状态一变（换号 / 退登录），
   * 缓存里的曲目就是上一个账号的视图了，不能再用。
   */
  state.myPlaylists.detailCache = {};
  state.myPlaylists.detailRefreshing = {};
}

/* ── 我的歌单：本地缓存（冷启动先画上次的结果，再悄悄补新的） ───────── */

/*
 * 缓存落在主进程的 userData/playlists-cache.json（见 electron/main.js 的 playlistCache）。
 * 这里只管三件事：读回来灌进 state、同步完写回去、账号对不上就丢掉。
 *
 * 三条约定：
 *  1. 已登录平台照常灌回；未登录平台只灌「链接导入」的歌单（带 imported 标记），
 *     账号同步的私有歌单没登录就不该出现。
 *  2. 缓存里的账号标识和当前登录账号不一致 = 换过号，这一组作废（顺手把盘上那份删掉）。
 *  3. 缓存超过 TTL 就先给用户看旧数据，再后台静默补一次新的，不转圈、不禁用按钮。
 */
const PLAYLIST_CACHE_TTL = 30 * 60 * 1000;
const PLAYLIST_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

/** 当前登录账号的标识；拿不到就返回空串（网易云走本地 API，没有 uin/userid）。 */
function musicAccountKey(platform) {
  if (!musicLoggedIn(platform)) return '';
  const info = state.musicLogin?.[platform] || {};
  return String(info.uin || info.userid || '');
}

let playlistsHydrating = false;

/** 把磁盘缓存灌回内存。返回是否真的灌到了东西。 */
async function hydratePlaylistsFromCache() {
  if (playlistsHydrating) return false;
  if (typeof api.musicPlaylistsCache !== 'function') return false;
  playlistsHydrating = true;
  try {
    const cache = await api.musicPlaylistsCache();
    const savedAt = Number(cache?.savedAt) || 0;
    if (!savedAt) return false;
    // 太旧的缓存不如不显示：卡片墙上挂着「上次同步 40 天前」只会让用户更困惑
    if (Date.now() - savedAt > PLAYLIST_CACHE_MAX_AGE) {
      api.musicDropPlaylistsCache({}).catch(() => {});
      return false;
    }
    const drop = [];
    let filled = 0;
    for (const key of ['netease', 'qq', 'kugou', 'kuwo']) {
      const cached = cache.groups?.[key];
      if (!cached || !Array.isArray(cached.list) || !cached.list.length) continue;
      /*
       * 未登录的平台只捞回「链接导入」的歌单（带 imported 标记）：
       * 账号同步出来的歌单是账号私有的，没登录就不该出现；
       * 而酷狗链接导入的歌单不依赖登录，重启后也得能画回来。
       */
      const list = musicLoggedIn(key) ? cached.list : cached.list.filter((item) => item && item.imported);
      if (!list.length) continue;
      const cachedAccount = String(cache.accounts?.[key] || '');
      const nowAccount = musicAccountKey(key);
      // 两边都有值还不同 = 换过号，这份歌单不是这个人的
      if (cachedAccount && nowAccount && cachedAccount !== nowAccount) {
        drop.push(key);
        continue;
      }
      // 已经有在线数据（比如刚手动同步过）就别拿旧的盖掉
      const exists = (state.myPlaylists.groups || []).some(
        (group) => group.platform === key && (group.list || []).length
      );
      if (exists) continue;
      /*
       * 酷狗的账号同步本来就被官方关了，缓存里挂着的「登录失效 / 读取失败」
       * 全是历史同步留下的死标记，对酷狗毫无意义，恢复时直接剥掉，
       * 别让「我的歌单」一直顶着一条清不掉的红字。
       */
      const clean = key === 'kugou'
        ? { error: '', stale: false, expired: false }
        : {};
      applyPlaylistGroup(
        key,
        { ...cached, ...clean, list, platform: key, label: cached.label || musicPlatformLabel(key) },
        { syncedAt: cached.syncedAt, durationMs: cached.durationMs, skipCache: true }
      );
      filled += 1;
    }
    if (drop.length) api.musicDropPlaylistsCache({ platforms: drop }).catch(() => {});
    if (!filled) return false;
    if (state.route === 'song') render({ preserveScroll: true });
    // 缓存有点旧了：后台补一次新的，界面上不转圈
    if (Date.now() - savedAt > PLAYLIST_CACHE_TTL) refreshPlaylistsSilently();
    return true;
  } catch {
    return false;
  } finally {
    playlistsHydrating = false;
  }
}

let playlistsSaveTimer = null;

/** 把当前分组写回磁盘。合并写：只传这次真有数据的平台，空列表不写。 */
function schedulePlaylistsCacheSave(delay = 800) {
  if (typeof api.musicSavePlaylistsCache !== 'function') return;
  if (playlistsSaveTimer) clearTimeout(playlistsSaveTimer);
  playlistsSaveTimer = setTimeout(() => {
    playlistsSaveTimer = null;
    const groups = (state.myPlaylists.groups || []).filter((g) => Array.isArray(g.list) && g.list.length);
    if (!groups.length) return;
    const accounts = {};
    for (const key of ['netease', 'qq', 'kugou', 'kuwo']) accounts[key] = musicAccountKey(key);
    api.musicSavePlaylistsCache({ groups, accounts }).catch(() => {});
  }, delay);
}

/**
 * 静默补一次最新数据：不动 loadingAll，所以界面不转圈、按钮不禁用。
 * 只在「缓存已经把卡片墙画出来」之后由 hydrate 触发。
 */
async function refreshPlaylistsSilently() {
  if (state.myPlaylists.bgRefreshing) return;
  if (state.myPlaylists.loadingAll) return;
  if (Object.values(state.myPlaylists.syncing || {}).some(Boolean)) return;
  if (!['netease', 'qq', 'kugou', 'kuwo'].some(musicLoggedIn)) return;
  if (typeof api.musicAllPlaylists !== 'function') return;
  state.myPlaylists.bgRefreshing = true;
  try {
    const result = await api.musicAllPlaylists();
    const groups = Array.isArray(result?.groups) ? result.groups : [];
    const syncedAt = Number(result?.syncedAt) || Date.now();
    const durationMs = Number(result?.durationMs) || 0;
    for (const group of groups) {
      if (!group || !group.platform) continue;
      applyPlaylistGroup(group.platform, group, { syncedAt, durationMs });
    }
    state.myPlaylists.syncedAt = syncedAt;
    state.myPlaylists.syncDurationMs = durationMs;
    if (state.route === 'song') render({ preserveScroll: true });
  } catch {
    // 静默刷新失败就算了：卡片墙上还留着旧数据，用户点「同步」会看到真正的报错
  } finally {
    state.myPlaylists.bgRefreshing = false;
  }
}

/** 歌单详情缓存的 TTL：10 分钟内来回点同一张歌单不重新拉取。 */
const PLAYLIST_DETAIL_TTL = 10 * 60 * 1000;

function playlistDetailCacheKey(platform, playlistId) {
  return `${platform}:${playlistId}`;
}

/**
 * 从分组（我的歌单）和广场里找出这张歌单登记的曲目数。
 * 只用来给「正在读取曲目」的占位提示估个规模，找不到就返回 0。
 */
function findPlaylistCount(platform, playlistId) {
  for (const group of state.myPlaylists.groups || []) {
    if (group.platform !== platform) continue;
    const hit = (group.list || []).find((item) => item.id === playlistId);
    if (hit) return Number(hit.count) || 0;
  }
  const plaza = (state.myPlaylists.plaza || {})[platform];
  const hit = (plaza?.list || []).find((item) => item.id === playlistId);
  return hit ? Number(hit.count) || 0 : 0;
}

/**
 * 取歌单详情（带会话缓存）。
 *
 * 命中且未过 TTL 直接回缓存；否则现取并写回缓存。
 * openMyPlaylist / playPlaylist 共用这一条路，保证两边看到的数据一致，
 * 也避免「点开看了一遍，整张播放又重新拉一遍」的重复等待。
 */
async function fetchPlaylistDetail(platform, playlistId) {
  const key = playlistDetailCacheKey(platform, playlistId);
  const cached = state.myPlaylists.detailCache[key];
  if (cached && Date.now() - cached.at < PLAYLIST_DETAIL_TTL) {
    return { ok: true, detail: cached.detail };
  }
  const result = await api.musicPlaylistSongs({ platform, playlistId });
  if (result?.ok && result.detail) {
    // platform 放在展开之后，保证分区高亮一定认得出来是哪个平台的歌单
    const detail = { ...result.detail, id: playlistId, platform };
    state.myPlaylists.detailCache[key] = { detail, at: Date.now() };
    result.detail = detail;
  }
  return result;
}

/** 缓存过期后只补数据不抢界面：先显示旧的，取到了再悄悄换上。 */
async function refreshPlaylistDetailSilently(platform, playlistId) {
  const key = playlistDetailCacheKey(platform, playlistId);
  if (state.myPlaylists.detailRefreshing[key]) return;
  state.myPlaylists.detailRefreshing[key] = true;
  try {
    const result = await api.musicPlaylistSongs({ platform, playlistId });
    if (result?.ok && result.detail) {
      const detail = { ...result.detail, id: playlistId, platform };
      state.myPlaylists.detailCache[key] = { detail, at: Date.now() };
      // 用户还停在这张歌单的详情页上时才换内容，别把别处正在看的给顶掉
      const current = state.myPlaylists.detail;
      if (current && current.id === playlistId && current.platform === platform) {
        state.myPlaylists.detail = detail;
        if (state.route === 'song') render({ preserveScroll: true });
      }
    }
  } catch {
    // 静默刷新失败就算了：界面还留着旧数据，重新点一次会走真正的报错
  } finally {
    delete state.myPlaylists.detailRefreshing[key];
  }
}

/** 打开某个自建歌单的曲目。 */
async function openMyPlaylist(platform, playlistId) {
  if (!platform || !playlistId) return;
  const key = playlistDetailCacheKey(platform, playlistId);
  const cached = state.myPlaylists.detailCache[key];
  if (cached) {
    // 命中缓存：无论新旧先把上次的详情摆出来，不转圈、不白屏。
    state.myPlaylists.detail = cached.detail;
    state.myPlaylists.error = '';
    render({ preserveScroll: true });
    // 过了 TTL 的后台悄悄补一次新的；没过期就直接用
    if (Date.now() - cached.at >= PLAYLIST_DETAIL_TTL) {
      refreshPlaylistDetailSilently(platform, playlistId);
    }
    return;
  }
  // 首次点开：loading 态先画出来（占位带上曲目数估算），取完写进缓存
  state.myPlaylists.loading = true;
  state.myPlaylists.detail = { id: playlistId, platform, loading: true };
  render({ preserveScroll: true });
  try {
    const result = await fetchPlaylistDetail(platform, playlistId);
    if (result?.ok && result.detail) {
      state.myPlaylists.detail = result.detail;
      state.myPlaylists.error = '';
    } else {
      state.myPlaylists.detail = null;
      state.myPlaylists.error = result?.reason || '读取歌单失败';
    }
  } catch (error) {
    // 读失败必须退出钻取态：否则主区会永远停在「正在读取曲目…」上
    state.myPlaylists.detail = null;
    state.myPlaylists.error = humanError(error);
  } finally {
    state.myPlaylists.loading = false;
    if (state.route === 'song') render({ preserveScroll: true });
    /*
     * 失败要让人看见。
     * 之前这个 reason 只写进 state.myPlaylists.error，没有任何地方读它，
     * 于是「点歌单没反应」变成了完全静默的失败。
     */
    if (state.myPlaylists.error) {
      toast(state.myPlaylists.error, 'error');
    }
  }
}

/**
 * 串行把一批曲目加进点歌队列，边加边报进度。
 *
 * 曲源是逐首解析的（每首都可能要走一次网易云同名曲兜底），
 * 八百首的歌单跑下来要几分钟。不报数的话，界面停在那儿跟卡死没区别，
 * 所以这里每 20 首喊一次进度，并且先告诉用户总共多少首。
 */
async function addSongsToQueue(songs, options = {}) {
  const list = Array.isArray(songs) ? songs.filter(Boolean) : [];
  if (!list.length) return 0;
  const platform = options.platform || '';
  const label = options.label || '加入点歌队列';
  // 来源标记跟着整批走：整张导入的歌单标 playlist + 歌单名，队列页按它分段
  const origin = options.origin || '';
  const from = options.from || '';
  if (list.length > 1) {
    toast(`正在${label}：共 ${list.length} 首，逐首解析需要一点时间…`, 'info');
  }
  let added = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (await addChartSongToQueue(list[i], { silent: true, platform: platform || list[i].platform || '', origin, from })) added += 1;
    const done = i + 1;
    // 最后一条不用报，紧接着就是总结的 toast
    if (done % 20 === 0 && done < list.length) {
      toast(`正在${label}… ${done}/${list.length}（已可播 ${added} 首）`, 'info');
    }
  }
  return added;
}

/**
 * 整张歌单直接开播：读取曲目 → 装进点歌队列（替换当前队列）→ 从第 1 首开始播放。
 * 这是「我的歌单点击播放」的核心：歌单卡片上的播放按钮直接走这里，
 * 不用先展开再一首首「加入点歌队列」。
 */
async function playPlaylist(platform, playlistId) {
  if (!platform || !playlistId) return;
  toast('正在准备歌单…', 'info');
  try {
    // 和「点开详情」共用同一条缓存路：刚看过的歌单直接开播，不再重拉一遍
    const result = await fetchPlaylistDetail(platform, playlistId);
    const songs = result?.detail?.songs || [];
    if (!result?.ok || !songs.length) {
      toast('这个歌单里没有可播放的曲目', 'info');
      return;
    }
    // 先清空队列再逐首解析可播版本，避免和上一首歌单的残留混在一起
    state.songs = [];
    // 整张歌单全都要：不再截 200 首，progress 由 addSongsToQueue 报
    const added = await addSongsToQueue(songs, { platform, label: '解析歌单', origin: 'playlist', from: result?.detail?.name || '歌单' });
    if (!added) {
      toast('这些曲目暂时都找不到可播放版本', 'info');
      return;
    }
    state.songIndex = 0;
    state.songTab = 'queue';
    // 开播后退出歌单钻取态：否则下次点左栏「我的歌单」还会停在这张歌单上，回不到卡片墙
    state.myPlaylists.detail = null;
    await playSongAt(0, { preserveScroll: true });
    toast(`正在播放歌单 · 已载入 ${added} 首`, 'success');
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

/** 两首歌是不是同一首：先认 neteaseId，认不出来再退回「歌名 + 歌手有交集」。 */
function sameSongKey(a, b) {
  if (!a || !b) return false;
  const idA = a.neteaseId ? String(a.neteaseId) : '';
  const idB = b.neteaseId ? String(b.neteaseId) : '';
  if (idA && idB && idA === idB) return true;
  const nameA = songCoreName(a.title);
  if (!nameA || nameA !== songCoreName(b.title)) return false;
  const artA = artistNameList(a.artist);
  const artB = artistNameList(b.artist);
  if (!artA.length || !artB.length) return true;
  return artA.some((name) => artB.includes(name));
}

/** 队列里已经有的同一首歌排在第几？没有返回 -1。 */
function queuedSongIndex(song) {
  if (!song) return -1;
  for (let i = 0; i < state.songs.length; i += 1) {
    if (sameSongKey(song, state.songs[i])) return i;
  }
  return -1;
}

/**
 * 队列的「已有哪些歌」索引：一趟建好，之后每首 O(1) 查。
 * 几百首的歌单要是每首都去扫一遍队列（还带正则归一化），主线程会直接卡住。
 */
function buildQueuedKeySet() {
  const set = new Set();
  for (const entry of state.songs) rememberQueuedKey(set, entry);
  return set;
}

function rememberQueuedKey(set, song) {
  if (!set || !song) return;
  if (song.neteaseId) set.add(`id:${song.neteaseId}`);
  const name = songCoreName(song.title);
  if (!name) return;
  set.add(`n:${name}`);
  for (const artist of artistNameList(song.artist)) set.add(`na:${name}|${artist}`);
}

function songAlreadyQueued(set, song) {
  if (!set || !song) return false;
  if (song.neteaseId && set.has(`id:${song.neteaseId}`)) return true;
  const name = songCoreName(song.title);
  if (!name) return false;
  const artists = artistNameList(song.artist);
  if (!artists.length) return set.has(`n:${name}`);
  return artists.some((artist) => set.has(`na:${name}|${artist}`));
}

/**
 * 歌单续播任务：一次只留一个，新点一首会把旧的顶掉。
 * 播放到队列末尾、而它还在往后排歌时，要用它挡住「歌单已经播放完毕」。
 */
let playlistFill = null;
let playlistFillToken = 0;

/**
 * 把歌单剩下的曲目在后台一首首插进队列（插在 cursor 这个位置，保持顺序）。
 * token 变了就立刻收手 —— 用户已经点了别的歌，这条续播作废。
 */
async function fillPlaylistQueueFrom({ songs, start, platform, fromName, cursor, token }) {
  let at = cursor;
  const total = Math.max(0, songs.length - start);
  const seen = buildQueuedKeySet();
  for (let i = start; i < songs.length; i += 1) {
    if (token !== playlistFillToken) return;
    const song = songs[i];
    if (!song) continue;
    // 队列里已经有同一首就别排第二遍：宁可少一首重复，也不要一首歌播两次
    if (songAlreadyQueued(seen, song)) continue;
    const ok = await addChartSongToQueue(song, {
      silent: true,
      platform: platform || song.platform || '',
      origin: 'playlist',
      from: fromName,
      insertAt: at,
    });
    if (ok) {
      at += 1;
      rememberQueuedKey(seen, song);
    }
    const done = i - start + 1;
    if (done % 20 === 0 && done < total) {
      toast(`正在按歌单顺序排后面… ${done}/${total}`, 'info');
    }
  }
}

/** 等续播任务把下一首补上来（最多等 ms 毫秒）。队列变长了就返回真。 */
async function waitForMoreSongs(ms) {
  const before = state.songs.length;
  const deadline = Date.now() + ms;
  while (playlistFill && Date.now() < deadline) {
    if (state.songs.length > before) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return state.songs.length > before;
}

/**
 * 同一张歌单的曲目在队列里是连着的一段。从 after 往后跳过这一段，
 * 返回新曲目该插的位置 —— 再点同一张歌单里的另一首时，
 * 新的一批要排在已经排好的那批后面，不能插到前面把顺序顶乱。
 */
function playlistBlockEnd(after, fromName) {
  let at = Math.max(0, Math.min(Number(after) || 0, state.songs.length));
  while (at < state.songs.length) {
    const entry = state.songs[at];
    if (!entry || entry.origin !== 'playlist' || (entry.from || '歌单') !== fromName) break;
    at += 1;
  }
  return at;
}

/**
 * 歌单里点某一首：这一首立刻开播，后面按歌单顺序接着往下放。
 *
 * 以前点一行只是「加入队列」，不出声，用户还得跑去队列页再点一次，
 * 这就是「点了不给放」最直接的体感问题。现在：
 *   1. 先把这一首解析出来插进队列并切过去播（点下去一两秒就出声）；
 *   2. 后面的曲目在后台一首首紧跟着插进来 ——
 *      几百首的歌单不用先全部解析完才播第一首。
 *
 * 不动队列里已有的歌：点歌队列是主播的活儿，点一首歌不该把观众点的都清掉。
 */
async function playPlaylistFromIndex(platform, playlistId, index) {
  if (!platform || !playlistId) return;
  const cached = state.myPlaylists.detail;
  let detail =
    cached && cached.platform === platform && cached.id === playlistId && !cached.loading && (cached.songs || []).length
      ? cached
      : null;
  if (!detail) {
    try {
      const result = await fetchPlaylistDetail(platform, playlistId);
      if (!result?.ok || !result.detail?.songs?.length) {
        toast('这个歌单里没有可播放的曲目', 'info');
        return;
      }
      detail = result.detail;
    } catch (error) {
      toast(humanError(error), 'error');
      return;
    }
  }
  const songs = detail.songs || [];
  const start = Math.max(0, Math.min(Number(index) || 0, songs.length - 1));
  const song = songs[start];
  if (!song) return;
  const fromName = detail.name || '歌单';

  // 上一次的续播先作废并等它收手：否则两批歌会插到同一个位置上
  playlistFillToken += 1;
  const token = playlistFillToken;
  if (playlistFill) await playlistFill.promise.catch(() => {});

  // 队列里已经有这首（比如刚点过）就直接跳过去，不再排一遍
  let target = queuedSongIndex(song);
  if (target < 0) {
    const ok = await addChartSongToQueue(song, {
      silent: true,
      platform: platform || song.platform || '',
      origin: 'playlist',
      from: fromName,
    });
    if (!ok) {
      toast(`「${song.title || '这首'}」暂时找不到可播放版本`, 'info');
      return;
    }
    target = state.songs.length - 1;
  }
  state.songIndex = target;
  // 随机模式下「接着往下放」会变成随便挑一首；点歌单里的歌就是要按顺序听
  if (state.playMode === 'shuffle') setPlayMode('order');
  await playSongAt(target, { preserveScroll: true });
  const rest = songs.length - start - 1;
  toast(
    rest > 0 ? `正在播放：${song.title} · 后面 ${rest} 首按歌单顺序接着放` : `正在播放：${song.title}`,
    'success'
  );

  if (!rest) return;
  const promise = fillPlaylistQueueFrom({
    songs,
    start: start + 1,
    platform,
    fromName,
    // 排在这张歌单已有那段之后：连续点几首时，后点的歌接在后面而不是插到前面
    cursor: playlistBlockEnd(target + 1, fromName),
    token,
  });
  playlistFill = { token, promise };
  promise
    .catch(() => {})
    .then(() => {
      if (playlistFill && playlistFill.token === token) playlistFill = null;
    });
}

/** 读取各平台登录状态，渲染到榜单面板。 */
async function refreshNeteaseLogin() {
  try {
    const status = await api.netease.status();
    state.neteaseLogin = { loggedIn: Boolean(status?.loggedIn), apiBase: status?.apiBase || '' };
  } catch {
    state.neteaseLogin = { loggedIn: false, apiBase: '' };
  }
  return state.neteaseLogin;
}

async function refreshMusicLogin() {
  try {
    const status = await api.musicStatus();
    // 网易云也一起收进来：它的会话来自本地 API，但状态同样要参与「我的歌单」
    state.musicLogin = {
      netease: status?.netease || null,
      qq: status?.qq || null,
      kugou: status?.kugou || null,
      kuwo: status?.kuwo || null,
      loading: false,
    };
  } catch {
    state.musicLogin = { netease: null, qq: null, kugou: null, kuwo: null, loading: false };
  }
  /**
   * 登录状态一变，「我的歌单」的缓存就可能不对了：
   * 换了账号要重拉，新登录一个平台要补上这个平台。
   * 这里统一清内存里的分组，再按磁盘缓存重新摆回来（账号对不上的平台会被丢掉），
   * 剩下的平台由 ensureAllPlaylistsLoaded / 静默刷新补新。
   */
  invalidateAllPlaylists();
  /*
   * 清完立刻把上次的歌单墙摆回来：冷启动时用户点进点歌台就能看到卡片，
   * 不用干等四家平台重新拉一遍（酷狗那边常常要等到超时）。
   */
  await hydratePlaylistsFromCache();
  if (state.route === 'song') render({ preserveScroll: true });
}

/**
 * 把榜单 / 歌单里的曲目变成点歌台可播放的条目。
 *
 * 走主进程的 music:resolve：它会用网易云找同名曲，
 * 内置 API 的 unblock 会自动补上免费音源，
 * 所以 QQ / 酷狗的曲目不需要会员也能听。
 */
async function addChartSongToQueue(song, options = {}) {
  if (!song) return false;
  const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
  try {
    await api.netease.startService(apiBase).catch(() => {});
    /*
     * platform 一定要带上：解析器靠它判断能不能走原生直链。
     * 不带 platform 时只能老老实实去网易云找同名曲（会员曲目多半扑空）。
     */
    const platform = song.platform || options.platform || '';
    const result = await api.musicResolve({
      song: {
        title: song.title,
        artist: song.artist,
        cover: song.cover,
        album: song.album,
        platform,
        mid: song.mid,
        hash: song.hash,
        neteaseId: song.neteaseId,
      },
      apiBase,
      level: state.songQuality,
    });
    if (!result?.ok || !result.url) {
      if (!options.silent) {
        const why = result?.reason ? `（${result.reason}）` : '';
        toast(`「${song.title || '这首'}」暂时找不到可播放版本${why}`, 'info');
      }
      return false;
    }
    const entry = {
      title: result.title || song.title,
      artist: result.artist || song.artist,
      cover: result.cover || song.cover || '',
      album: result.album || song.album || '',
      neteaseId: result.neteaseId || song.neteaseId,
      source: result.source || platform || '',
      quality: result.level || state.songQuality,
      url: result.url,
    };
    // 换源成功时来源和点的那首不同，把原生 key 一起留着，下次还能直连
    if (result.matched) entry.matched = result.matched;
    if (song.hash) entry.hash = song.hash;
    if (song.mid) entry.mid = song.mid;
    // 队列分组标记：整张导入的歌单带歌单名，其余（单点/本地/直链）都是自选
    if (options.origin === 'playlist') {
      entry.origin = 'playlist';
      entry.from = options.from || '歌单';
    } else {
      entry.origin = 'pick';
    }
    /*
     * insertAt：歌单里点某一首时，后面的曲目必须紧挨着它排队，
     * 甩到队尾的话「接着往下放」就变成了「先放完别人的歌」。
     */
    const at = Number.isFinite(options.insertAt)
      ? Math.max(0, Math.min(Number(options.insertAt), state.songs.length))
      : state.songs.length;
    state.songs.splice(at, 0, entry);
    saveSongs();
    if (!options.silent) {
      state.songIndex = state.songs.length - 1;
      render({ preserveScroll: true });
      playCurrentSong();
      toast(`已加入：${result.title || song.title}`, 'success');
    }
    return true;
  } catch (error) {
    if (!options.silent) toast(`转换失败：${humanError(error)}`, 'error');
    return false;
  }
}

/**
 * 执行一次点歌台搜索。
 * 三平台并发，任一平台失败只记进 errors，不影响其它平台的结果。
 */
async function runSongSearch() {
  const keyword = String(state.songSearch.keyword || '').trim();
  if (!keyword) {
    toast('先输入歌名或歌手', 'info');
    return;
  }
  const platform = state.songSearch.platform || 'all';
  const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
  state.songSearch = { ...state.songSearch, keyword, platform, loading: true, done: false, list: [], errors: [] };
  if (state.songTab !== 'search') state.songTab = 'search';
  render({ preserveScroll: true });
  try {
    // 网易云那一路要求本地 API 服务在跑，先尝试拉起；失败也没关系，另外两家照样能搜
    await api.netease.startService(apiBase).catch(() => {});
    const result = await api.musicSearch({ platform, keyword, apiBase, limit: 30 });
    state.songSearch = {
      keyword,
      platform,
      loading: false,
      done: true,
      list: result?.songs || [],
      errors: result?.errors || [],
    };
  } catch (error) {
    state.songSearch = { keyword, platform, loading: false, done: true, list: [], errors: [humanError(error)] };
  }
  render({ preserveScroll: true });
}

/**
 * 观众点歌的入队方式：'next'（默认）插到当前歌曲后面当"下一首"，
 * 'now' 立即切过去播放。在点歌台的弹幕点歌卡片里切换。
 */
function liveSongMode() {
  return localStorage.getItem("vela:live-song-mode") === "now" ? "now" : "next";
}

async function handleLiveDanmaku(message, user) {
  const match = String(message || '').match(/^\s*点歌\s*(.+)$/);
  if (!match || liveRequestBusy) return;
  const keyword = match[1].trim().slice(0, 60);
  if (!keyword) return;
  liveRequestBusy = true;
  console.log('[点歌] 收到弹幕点歌：', keyword, 'by', user || '观众');
  try {
    const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
    await api.netease.startService(apiBase).catch(() => {});
    let song = null;
    try {
      // 主通道：网易云独占搜索（直接带可播放地址）
      song = await api.netease.searchSong({ apiBase, keyword, level: state.songQuality });
    } catch (neteaseErr) {
      // 网易云通道失败（服务没起 / 没结果 / 会员曲扑空）：退回多平台搜索 + 解析，
      // 避免弹幕点歌整条静默失败。手动点歌也是走这条多平台路，已经验证可靠。
      console.warn('[点歌] 网易云搜索失败，退回多平台：', neteaseErr && neteaseErr.message);
      try {
        const res = await api.musicSearch({ platform: 'all', keyword, apiBase, limit: 8 });
        const first = (res && res.songs && res.songs[0]) || null;
        if (first) {
          const r = await api.musicResolve({
            song: {
              title: first.title,
              artist: first.artist,
              cover: first.cover,
              album: first.album,
              platform: first.platform,
              mid: first.mid,
              hash: first.hash,
              neteaseId: first.neteaseId,
            },
            apiBase,
            level: state.songQuality,
          });
          if (r && r.ok && r.url) {
            song = {
              title: r.title || first.title,
              artist: r.artist || first.artist,
              cover: r.cover || first.cover || '',
              neteaseId: r.neteaseId || first.neteaseId,
              quality: r.level || state.songQuality,
              url: r.url,
              source: r.source || first.platform || '',
            };
          }
        }
      } catch (fallbackErr) {
        console.error('[点歌] 多平台兜底也失败：', fallbackErr && fallbackErr.message);
      }
    }
    if (!song) {
      toast(`「${keyword}」暂时找不到可播放版本`, 'info');
      return;
    }
    const mode = liveSongMode();
    if (!state.songs.length) {
      // 队列是空的：无论什么模式都直接播这首
      state.songs.push(song);
      saveSongs();
      await playSongAt(0, {});
      toast(`${user || "观众"} 点歌：${song.title}`, "success");
    } else if (mode === "now") {
      const at = Math.min(state.songIndex + 1, state.songs.length);
      state.songs.splice(at, 0, song);
      saveSongs();
      await playSongAt(at, {});
      toast(`${user || "观众"} 点歌（立即播放）：${song.title}`, "success");
    } else {
      // 下一首播放：插在当前歌曲后面，不打断正在听的
      const at = Math.min(state.songIndex + 1, state.songs.length);
      state.songs.splice(at, 0, song);
      saveSongs();
      toast(`${user || "观众"} 点歌（下一首）：${song.title}`, "success");
      if (state.route === "song") render({ preserveScroll: true });
    }
  } catch (error) {
    console.error('[点歌] 失败：', error);
    toast(`弹幕点歌失败：${error.message}`, 'error');
  } finally {
    liveRequestBusy = false;
  }
}

async function changeSongQuality(level) {
  state.songQuality = level;
  localStorage.setItem('vela:song-quality', level);
  document.querySelectorAll('#song-quality, #dock-quality').forEach((select) => {
    select.value = level;
  });
  refreshSongPops();
  const song = currentSongEntry();
  if (!song?.neteaseId) {
    toast('本地歌曲和直链没有可切换的网易云音质', 'info');
    return;
  }
  try {
    const info = await api.netease.songUrl({
      apiBase: localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100',
      id: song.neteaseId,
      level,
      title: song.title,
      artist: song.artist,
    });
    const audio = document.querySelector('#song-audio');
    const time = audio?.currentTime || 0;
    const wasPlaying = Boolean(audio && !audio.paused);
    song.url = info.url;
    song.quality = info.level;
    saveSongs();
    if (audio) {
      audio.src = info.url;
      audio.dataset.songKey = `${state.songIndex}:${info.url}`;
      audio.load();
      audio.currentTime = time;
      if (wasPlaying) audio.play().catch(() => {});
    }
    toast(`音质已切换：${info.level}${info.br ? ` · ${Math.round(info.br / 1000)} kbps` : ''}`, 'success');
  } catch (error) {
    toast(`切换音质失败：${error.message}`, 'error');
  }
}

async function ensureSongQuality(song) {
  if (!song?.neteaseId || song.quality === state.songQuality) return;
  try {
    const info = await api.netease.songUrl({
      apiBase: localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100',
      id: song.neteaseId,
      level: state.songQuality,
      title: song.title,
      artist: song.artist,
    });
    song.url = info.url;
    song.quality = info.level;
    saveSongs();
  } catch {
    /* keep the existing playable URL */
  }
}

/* ---------- 导入歌单 / 添加歌曲：两个弹窗 ---------- */

/**
 * 从音频地址里猜一个能读的歌名：去掉域名、路径、扩展名、参数。
 * 猜不出来就返回空串，交给调用方让用户自己填。
 */
function titleFromAudioUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  const last = (url.pathname || '').split('/').filter(Boolean).pop() || '';
  let name = '';
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  name = name
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) name = url.hostname.replace(/^www\./i, '');
  return name.slice(0, 60);
}

/**
 * 「导入歌单」弹窗。
 *
 * 设计上只留一个输入框：粘链接，或者直接把 App 里「分享 → 复制链接」的整段文案贴进来。
 * 边输边识别（防抖 450ms），认出来就在下面显示平台徽标卡，主按钮才亮；
 * 认不出来给一句人话，不把后端的异常栈直接甩到脸上。
 * 网易云的本地服务地址不影响其它平台，所以收进默认折叠的「高级」里。
 */
function openImportPlaylistModal() {
  const defaultApi = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal kr-imp-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>导入歌单</h2><p>粘贴歌单链接，或者整个分享文案一起贴进来，都能认。</p></div>
          <button class="icon-btn" data-close>${icon('x')}</button>
        </div>
        <form class="modal-body kr-imp-body" id="playlist-link-form">
          <div class="kr-imp-box">
            <textarea class="kr-imp-input" name="url" rows="3" spellcheck="false" autofocus
              placeholder="https://music.163.com/#/playlist?id=…&#10;也可以粘一整段「分享文案」，多余的说明文字会自动忽略"></textarea>
            <div class="kr-imp-box-foot">
              <button type="button" class="kr-imp-paste" id="kr-imp-paste">${icon('file-text', 'xs')}从剪贴板粘贴</button>
              <span class="kr-imp-hint">网易云 / QQ 音乐 / 酷狗 / 酷我</span>
            </div>
          </div>
          <div class="kr-imp-state" id="kr-imp-state"></div>
          <p class="kr-imp-error" id="kr-imp-error" hidden></p>
          <div class="kr-imp-adv">
            <button type="button" class="kr-imp-adv-toggle" id="kr-imp-adv-toggle" aria-expanded="false">
              ${icon('chevron-down', 'xs')}<span>高级：网易云本地服务地址</span>
            </button>
            <label class="kr-imp-adv-body" id="kr-imp-adv-body" hidden>
              <span>只有导入网易云歌单时才用得上，不确定就保持默认。</span>
              <input class="text-input kr-imp-adv-input" name="apiBase" value="${esc(defaultApi)}"
                placeholder="http://127.0.0.1:3100" spellcheck="false" />
            </label>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary kr-imp-submit" type="submit" id="kr-imp-submit" disabled>导入</button>
          </div>
        </form>
      </div>
    </div>
  `);

  const form = document.querySelector('#playlist-link-form');
  if (!form) return;
  const urlInput = form.querySelector('[name="url"]');
  const apiInput = form.querySelector('[name="apiBase"]');
  const submit = form.querySelector('#kr-imp-submit');
  const stateHost = form.querySelector('#kr-imp-state');
  const errorHost = form.querySelector('#kr-imp-error');

  let parsedFor = ''; // 这份链接已经认出过结果，提交时不用再问一次后端
  let parsedData = null;
  let timer = null;
  let seq = 0;
  let busy = false;

  const showError = (message) => {
    errorHost.hidden = !message;
    errorHost.textContent = message || '';
  };
  const noteMarkup = (text, miss = false) =>
    `<p class="kr-imp-note ${miss ? 'is-miss' : ''}">${esc(text)}</p>`;

  // 识别成功后的平台徽标卡：平台名 + 歌单名/曲目数（后端给多少显示多少）
  const cardMarkup = (data) => {
    const platform = String(data?.platform || '');
    const label = data?.label || musicPlatformLabel(platform);
    const name = String(data?.name || data?.playlistName || data?.title || '').trim();
    const count = Number(data?.songCount || data?.trackCount || data?.count || 0) || 0;
    const creator = String(data?.creator || '').trim();
    const cover = String(data?.cover || '').trim();
    const id = String(data?.playlistId || data?.id || '');
    /*
     * playlistId 是不透明字符串（酷狗自建歌单是 collect:用户:…:签名），
     * 只用来原样透传给后端，不要拆不要转数字。
     * 界面上也只在它是纯数字（网易云 / QQ 那种）时才当「歌单号」露出来，
     * 免得把一长串签名糊到用户脸上。
     */
    const showId = /^\d+$/.test(id) ? id : '';
    // 有歌单名就把名字当主标题（分享短链能解析出名字），没有就退回「酷狗歌单 + 歌单号」
    const title = name || `${label}歌单`;
    const sub = [
      name ? label : showId ? `歌单号 ${showId}` : '',
      count ? `${count} 首` : '',
      creator,
    ]
      .filter(Boolean)
      .join(' · ');
    return `<div class="kr-imp-card">
        ${
          cover
            ? `<img class="kr-imp-card-cover" src="${esc(cover)}" alt="" referrerpolicy="no-referrer" />`
            : `<span class="mp-dot" data-platform="${esc(platform)}"></span>`
        }
        <span class="kr-imp-card-copy">
          <strong>${esc(title)}</strong>
          ${sub ? `<small>${esc(sub)}</small>` : ''}
        </span>
        <span class="kr-imp-card-ok">${icon('check', 'xs')}认出来了</span>
      </div>`;
  };

  /*
   * 只有真的带回了平台和歌单号才算认出来。
   * 后端偶发只回一个 ok（比如还在解析短链），这时候当成没认出来更诚实，
   * 免得界面显示「音乐歌单」这种似是而非的结果。
   */
  const recognized = (data) => Boolean(data?.ok && data?.platform && (data?.playlistId || data?.id));

  /*
   * 封面是外链，挂了就换回平台圆点 —— 否则卡片上会留一个空方块，像加载坏了。
   * 弹窗内容不经过 bindView()，所以这里自己挂一次。
   */
  const bindCardCover = (data) => {
    const img = stateHost.querySelector('.kr-imp-card-cover');
    if (!img) return;
    img.addEventListener(
      'error',
      () => {
        const dot = document.createElement('span');
        dot.className = 'mp-dot';
        if (data?.platform) dot.dataset.platform = String(data.platform);
        img.replaceWith(dot);
      },
      { once: true }
    );
  };

  const paintCard = (data) => {
    stateHost.innerHTML = cardMarkup(data);
    bindCardCover(data);
  };

  const runParse = async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    const mine = ++seq;
    stateHost.innerHTML = noteMarkup('正在识别…');
    submit.disabled = true;
    try {
      const data = await api.musicParsePlaylistLink(url);
      if (mine !== seq) return; // 用户又改了输入，这次结果作废
      if (!recognized(data)) {
        parsedFor = '';
        parsedData = null;
        stateHost.innerHTML = noteMarkup(data?.reason || '这条链接还没认出来，换一条完整链接试试', true);
        return;
      }
      parsedFor = url;
      parsedData = data;
      paintCard(data);
      submit.disabled = false;
    } catch (error) {
      if (mine !== seq) return;
      stateHost.innerHTML = noteMarkup(humanError(error), true);
    }
  };

  urlInput.addEventListener('input', () => {
    showError('');
    submit.disabled = true;
    const value = urlInput.value.trim();
    if (value !== parsedFor) {
      parsedData = null;
      parsedFor = '';
    }
    clearTimeout(timer);
    if (!value) {
      stateHost.innerHTML = '';
      return;
    }
    stateHost.innerHTML = noteMarkup('正在识别…');
    timer = setTimeout(runParse, 450);
  });

  form.querySelector('#kr-imp-paste')?.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        toast('剪贴板里没有文字', 'info');
        return;
      }
      urlInput.value = text.trim();
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    } catch {
      // 拿不到剪贴板权限时不装作成功了，直接把人送回输入框
      urlInput.focus();
      toast('读不到剪贴板，直接按 Ctrl + V 粘进来就行', 'info');
    }
  });

  const advToggle = form.querySelector('#kr-imp-adv-toggle');
  const advBody = form.querySelector('#kr-imp-adv-body');
  advToggle?.addEventListener('click', () => {
    const open = advToggle.getAttribute('aria-expanded') === 'true';
    advToggle.setAttribute('aria-expanded', String(!open));
    advToggle.classList.toggle('is-open', !open);
    advBody.hidden = open;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const url = urlInput.value.trim();
    const apiBase = String(apiInput?.value || '').trim() || defaultApi;
    if (!url) {
      showError('先把歌单链接粘进来');
      urlInput.focus();
      return;
    }
    showError('');
    localStorage.setItem('vela:netease-api', apiBase);

    const setBusy = (text) => {
      busy = Boolean(text);
      submit.disabled = busy;
      submit.textContent = text || '导入';
    };

    setBusy('正在识别…');
    try {
      const info = parsedData && parsedFor === url ? parsedData : await api.musicParsePlaylistLink(url);
      if (!recognized(info)) {
        stateHost.innerHTML = noteMarkup(info?.reason || '这条链接还没认出来，换一条完整链接试试', true);
        showError('这条链接暂时读不出来，换一条再试');
        setBusy('');
        return;
      }
      parsedFor = url;
      parsedData = info;
      paintCard(info);
      setBusy('正在读取曲目…');

      if (info.platform === 'netease') {
        // 网易云沿用原来的本地 API 流程：它直接带可播放地址回来
        const result = await api.neteasePlaylist({ apiBase, url, level: state.songQuality });
        if (!result?.songs?.length) {
          showError('没读到曲目：本地网易云服务可能没起来，或者这张歌单本身是空的');
          setBusy('');
          return;
        }
        // 链接导入的歌单也并进「我的歌单」，不然导入完在那里看不到
        mergeImportedPlaylist('netease', {
          id: info.playlistId || info.id,
          name: result.playlist || info.name || info.playlistName || info.title || '',
          cover: info.cover || '',
          count: result.songs.length,
          creator: info.creator || '',
        });
        state.songs.push(...result.songs);
        state.songIndex = Math.max(0, state.songs.length - result.songs.length);
        saveSongs();
        closeModal();
        render({ preserveScroll: true });
        toast(
          `已导入「${result.playlist}」${result.songs.length} 首${result.skipped ? `，跳过 ${result.skipped} 首没有版权的` : ''}，已加入我的歌单`,
          'success'
        );
        playCurrentSong();
        return;
      }

      // QQ 音乐 / 酷狗 / 酷我：走各自的公开详情
      const result = await api.musicPlaylistSongs({ platform: info.platform, playlistId: info.playlistId });
      const songs = result?.detail?.songs || [];
      if (!result?.ok || !songs.length) {
        showError(result?.reason || '这张歌单里没有读到曲目，换一张试试');
        setBusy('');
        return;
      }
      // 链接导入的歌单也并进「我的歌单」：酷狗账号同步已被官方关掉，导入是唯一入口
      mergeImportedPlaylist(info.platform, {
        id: info.playlistId || info.id,
        name: result.detail.name || info.name || info.playlistName || info.title || '',
        cover: result.detail.cover || info.cover || '',
        count: songs.length,
        creator: info.creator || result.detail.creator || '',
      });
      closeModal();
      render({ preserveScroll: true });
      // 曲源逐首解析（每首都要找回可播版本），大歌单要跑一会儿，进度由这里报
      const added = await addSongsToQueue(songs, {
        platform: info.platform,
        label: `导入「${result.detail.name || info.label}歌单」`,
      });
      if (!added) {
        toast('这些曲目暂时都找不到可播放版本', 'info');
        return;
      }
      state.songIndex = Math.max(0, state.songs.length - added);
      saveSongs();
      render({ preserveScroll: true });
      toast(`已导入 ${added} 首${added < songs.length ? `（${songs.length - added} 首没有可播放版本）` : ''}，已加入我的歌单`, 'success');
      playCurrentSong();
    } catch (error) {
      // 失败不关弹窗：留在原地改链接就能重试
      showError(`导入失败：${humanError(error)}`);
      setBusy('');
    }
  });
}

/**
 * 「添加歌曲链接」弹窗。
 *
 * 一个地址输入框为主，歌名跟着地址自动填（可改），旁边直接给一个「选本地文件」。
 * 地址不对就在弹窗里说清楚哪儿不对，不再点了按钮毫无反应。
 */
function openAddSongLinkModal() {
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal kr-imp-modal is-narrow" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>添加歌曲</h2><p>贴一个音频直链就行，歌名会自动填好。</p></div>
          <button class="icon-btn" data-close>${icon('x')}</button>
        </div>
        <form class="modal-body kr-imp-body" id="song-link-form">
          <label class="kr-imp-field">
            <span class="kr-imp-field-label">音频地址</span>
            <input class="text-input kr-imp-url" name="url" placeholder="https://.../song.mp3" spellcheck="false" autofocus />
          </label>
          <p class="kr-imp-error" id="song-link-error" hidden></p>
          <label class="kr-imp-field">
            <span class="kr-imp-field-label">歌名<em>可选，自动填好后还能改</em></span>
            <input class="text-input" name="title" placeholder="夜航星" />
          </label>
          <div class="kr-imp-foot-row">
            <button type="button" class="kr-imp-file" data-action="add-song-file">${icon('folder', 'xs')}选本地文件</button>
            <span class="kr-imp-hint">支持 mp3 / flac / m4a / wav</span>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary" type="submit">加入歌单</button>
          </div>
        </form>
      </div>
    </div>
  `);

  const form = document.querySelector('#song-link-form');
  if (!form) return;
  const urlInput = form.querySelector('[name="url"]');
  const titleInput = form.querySelector('[name="title"]');
  const errorHost = form.querySelector('#song-link-error');

  const showError = (message) => {
    errorHost.hidden = !message;
    errorHost.textContent = message || '';
  };

  // 只有用户没自己动过歌名时才跟着地址改，别把人家改好的名字覆盖掉
  let titleTouched = false;
  titleInput.addEventListener('input', () => {
    titleTouched = Boolean(titleInput.value.trim());
  });

  urlInput.addEventListener('input', () => {
    showError('');
    const guess = titleFromAudioUrl(urlInput.value);
    if (!titleTouched && guess) titleInput.value = guess;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = String(urlInput.value || '').trim();
    if (!url) {
      showError('先把音频地址粘进来');
      urlInput.focus();
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      showError('这个地址要以 http:// 或 https:// 开头，复制完整链接再试');
      urlInput.focus();
      return;
    }
    const title = String(titleInput.value || '').trim() || titleFromAudioUrl(url) || '未命名音频';
    state.songs.push({ title, url });
    state.songIndex = state.songs.length - 1;
    saveSongs();
    closeModal();
    render({ preserveScroll: true });
    playCurrentSong();
  });
}

/**
 * 点歌台整体布局。
 *
 * 视图层组件分散在 song-ui.js（每块都是纯函数、可单独复用），本函数只负责把它们拼起来：
 *   顶部操作区（账号 / 添加歌曲）
 *   中间 左栏「曲库导航 + 歌单同步」+ 主区（标题条 / 搜索一条 / 队列或歌单或榜单）+ 右侧栏（歌词/音效/设置/弹幕）
 *   底部播放条
 *
 * 为什么把分页放到左栏：「我的歌单」原来跟队列挤在同一列里，还得滚到底才看得见，
 * 等于把人挡在门外。改成常驻左栏后，进歌单只要一次点击；窄屏（<1100px）由 CSS 把它折成顶部横向 tab。
 */
/* ── 点歌台「音源」卡片：内置音源勾选 + 第三方音源导入 ──────────
 * 内置五家里酷狗 / QQ 的匿名接口对付费曲目一律要会员，酷我常把人往手机端引，
 * 所以默认只开网易云和咪咕；用户想开哪家自己点 chip。
 * 第三方音源是一份 JSON，描述「怎么搜」和「怎么取地址」两个接口，
 * 可以从文件导入，也可以用订阅地址导入。
 */

const MUSIC_SOURCE_LABELS = [
  ['netease', '网易云'],
  ['migu', '咪咕'],
  ['kuwo', '酷我'],
  ['kugou', '酷狗'],
  ['qq', 'QQ 音乐'],
];
const MUSIC_SOURCE_DEFAULTS = { netease: true, migu: true, kuwo: false, kugou: false, qq: false };

function musicSourceFlags() {
  return Object.assign({}, MUSIC_SOURCE_DEFAULTS, (state.settings && state.settings.musicSources) || {});
}

function musicCustomSources() {
  const list = state.settings?.musicCustomSources;
  return Array.isArray(list) ? list : [];
}

/** 音源开关里被停用的平台，点歌台里的平台标签也跟着隐藏（酷我停了就不再显示酷我 tab）。 */
function musicPlatformEnabled(key) {
  return musicSourceFlags()[key] !== false;
}

function musicSourceCardMarkup() {
  const flags = musicSourceFlags();
  const customs = musicCustomSources();
  const on = customs.filter((def) => def.enabled !== false).length;
  /*
   * 音源卡只显示启用的内置音源；停用的（如酷我）不在界面上留任何入口。
   * 数据里的开关仍然生效：换源竞速、搜索、回退解析都会跳过停用的源。
   */
  const enabledLabels = MUSIC_SOURCE_LABELS.filter(([key]) => flags[key] !== false);
  const chips = enabledLabels
    .map(
      ([key, label]) =>
        `<button class="song-source-chip active" data-action="toggle-music-source" data-id="${key}" title="点击停用">${esc(label)}</button>`
    )
    .join('');
  const list = customs.length
    ? customs
        .map(
          (def) => `
        <span class="song-source-item ${def.enabled === false ? 'is-off' : ''}">
          <button class="song-source-name" data-action="toggle-music-custom" data-id="${esc(def.id)}" title="启用 / 停用">${esc(def.name || def.id)}</button>
          <button class="song-source-del" data-action="music-source-remove" data-id="${esc(def.id)}" title="删除">${icon('x', 'xs')}</button>
        </span>`
        )
        .join('')
    : '<p class="song-source-empty">还没有导入第三方音源</p>';
  return `
    <section class="song-rail-card is-source">
      <div class="song-rail-head">
        <span>音源</span>
        <small>${on ? `已启用 ${on} 个第三方` : '点标签切换'}</small>
      </div>
      <div class="song-source-chips">${chips}</div>
      <div class="song-source-custom">${list}</div>
      <div class="song-source-url" id="song-source-url-row" hidden>
        <input class="song-source-input" id="music-source-url" type="text" placeholder="粘贴音源 JSON 的订阅地址" />
        <button class="song-rail-more" data-action="music-source-url-go">导入</button>
      </div>
      <div class="song-source-actions">
        <button class="song-rail-more" data-action="music-source-pick" title="导入本地音源文件">${icon('download', 'xs')}导入文件</button>
        <button class="song-rail-more" data-action="music-source-subscribe" title="用订阅地址导入">${icon('link', 'xs')}订阅地址</button>
      </div>
      <input type="file" id="music-source-file" accept=".json,application/json" hidden />
    </section>`;
}

/** 把一份音源内容交给主进程校验入库（本地文本或订阅地址二选一）。 */
async function importMusicSource(input) {
  if (typeof api.musicImportSources !== 'function') {
    toast('当前版本还不支持导入音源', 'error');
    return;
  }
  const result = await api.musicImportSources(input).catch((error) => ({ ok: false, reason: humanError(error) }));
  if (!result?.ok) {
    toast(result?.reason || '导入失败', 'error');
    return;
  }
  state.settings.musicCustomSources = result.sources || [];
  render({ preserveScroll: true });
  const extra = (result.rejected || []).length ? `（${result.rejected.length} 个不合格已跳过）` : '';
  toast(`已导入 ${result.added} 个音源${extra}`, 'success');
}

function musicSourceFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('文件读不出来'));
    reader.readAsText(file);
  });
}

function karaokeViewMarkup() {
  const current = state.songs[state.songIndex] || null;
  const playing = Boolean(current?.url);
  const tab = state.songTab || 'queue';
  const cover = songCover(current);
  const qualitySelect = (id, cls) =>
    `<select id="${id}" class="${cls}" title="音质">${QUALITY_LEVELS.map(
      ([value, label]) => `<option value="${value}" ${state.songQuality === value ? 'selected' : ''}>${label}</option>`
    ).join('')}</select>`;

  return `
    <div class="page song-page song-app">
      <header class="song-app-head">
        <div class="song-app-title">
          <!-- 和别的页统一：eyebrow 小标题 + 36px 主标题 + 计数跟在标题后 -->
          <div class="eyebrow">${PAGE_META.song.eyebrow}</div>
          <h1>音乐${state.liveRooms.some((r) => r.connected) ? '<span class="count">弹幕已连接</span>' : ''}</h1>
        </div>
        <!-- 说明独占一整排：在标题下方铺满一行，不挤进标题行 -->
        <p class="song-app-desc">本地歌曲、榜单和歌单都在这儿；登录音乐账号能读自己的歌单，直播间连上之后观众还能点歌。</p>
        <div class="song-app-accounts">
          ${musicAccountEntryMarkup()}
        </div>
        <div class="song-app-actions">
          <button class="song-app-btn" data-action="add-song-file" title="添加本地歌曲">${icon('plus')}</button>
          <button class="song-app-btn" data-action="import-playlist-link" title="导入歌单链接（网易云 / QQ音乐 / 酷狗）">${icon('download')}</button>
          <button class="song-app-btn is-primary" data-action="add-song-link" title="添加音频链接">${icon('link')}</button>
        </div>
      </header>

      <div class="song-app-body kr-body">
        ${krNavMarkup()}

        <main class="song-app-main">
          ${krSectionHeadMarkup()}
          <div class="song-app-searchbar">
            ${songSearchMarkup()}
          </div>
          <div class="song-app-scroll">
            ${tab === 'charts' ? chartPanelMarkup() : tab === 'mine' ? songMineMarkup() : tab === 'search' ? songSearchPanel() : songQueueList()}
          </div>
        </main>

        <aside class="song-app-rail">
          <section class="song-rail-card is-now">
            <div class="song-rail-head">
              <span>${icon('headphones', 'xs')} 正在播放</span>
              <small>${state.songs.length ? `队列 ${state.songs.length} 首` : '暂无曲目'}</small>
            </div>
            <div class="song-rail-now">
              <span class="song-rail-cover ${cover ? 'has-cover' : ''}">${cover ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer" />` : icon('music')}</span>
              <span class="song-rail-now-copy">
                <strong id="rail-now-title">${esc(current?.title || '还没有点歌')}</strong>
                <small id="rail-now-artist">${esc(current?.artist || '音乐')}</small>
              </span>
            </div>
          </section>

          <section class="song-rail-card is-lyrics">
            <div class="song-rail-head">
              <span>歌词</span>
              <small>${current?.lyric ? '同步中' : current?.neteaseId ? '播放时获取' : '暂无'}</small>
            </div>
            <div class="song-lyrics song-rail-lyrics" id="song-lyrics">
              ${
                current?.lyric
                  ? parseLrc(current.lyric)
                      .map((line) => `<p class="song-lyric-line" data-time="${line.time}">${esc(line.text)}</p>`)
                      .join('')
                  : `<div class="song-lyric-empty">${icon('music')}<span>${current?.neteaseId ? '播放时自动获取歌词' : '本地或直链歌曲没有歌词'}</span></div>`
              }
            </div>
          </section>

          <section class="song-rail-card is-fx">
            <div class="song-rail-head">
              <span>音效</span>
              <button class="song-rail-more" data-action="open-audio-fx" title="完整音效面板">${icon('settings', 'xs')}更多</button>
            </div>
            <div class="song-fx-row">
              ${AUDIO_FX_PRESETS.map(
                (item) => `<button class="song-fx-chip ${state.audioFx.preset === item.key ? 'active' : ''}"
                  data-action="fx-preset" data-value="${item.key}" title="${esc(item.desc)}">${esc(item.label)}</button>`
              ).join('')}
            </div>
          </section>

          <section class="song-rail-card is-settings">
            <div class="song-rail-head">
              <span>播放设置</span>
            </div>
            <div class="song-rail-row">
              <span>音量</span>
              <input class="song-rail-range" id="song-volume-main" type="range" min="0" max="100" step="1" value="${state.songVolume}" aria-label="歌曲音量" data-no-sound />
              <small id="song-volume-main-value">${state.songMuted ? '静音' : `${state.songVolume}%`}</small>
            </div>
            <div class="song-rail-row">
              <span>默认音质</span>
              ${qualitySelect('song-quality', 'song-rail-select')}
            </div>
            <div class="song-rail-row is-split">
              <span class="song-rail-pair">
                <span>开机续播</span>
                <button class="switch ${state.autoResumeSong ? 'on' : ''}" role="switch" aria-checked="${Boolean(state.autoResumeSong)}" data-action="toggle-auto-resume"></button>
              </span>
              <span class="song-rail-pair">
                <span>小播放器</span>
                <button class="switch ${isMiniEnabled() ? 'on' : ''}" role="switch" aria-checked="${Boolean(isMiniEnabled())}" data-action="toggle-mini-player"></button>
              </span>
            </div>
          </section>

          ${musicSourceCardMarkup()}

          <section class="song-rail-card is-live">
            <div class="song-rail-head">
              <span>弹幕点歌</span>
              ${state.liveRooms.length ? `<button class="song-rail-more" data-action="live-disconnect-all">全部断开</button>` : ''}
            </div>
            ${state.liveRooms.length
              ? `<div class="song-live-mode">
                  <span class="song-live-mode-label">观众点歌</span>
                  <button class="song-live-chip ${liveSongMode() === 'next' ? 'on' : ''}" data-action="live-song-mode" data-id="next">下一首播放</button>
                  <button class="song-live-chip ${liveSongMode() === 'now' ? 'on' : ''}" data-action="live-song-mode" data-id="now">立即播放</button>
                </div>`
              : ''}
            ${state.liveRooms
              .map((room) => {
                const label = esc(room.platformLabel || '直播间');
                const statusLine = room.status ? `<p class="song-live-status">${esc(room.status)}</p>` : '';
                // 拿不到鉴权时给一个登录入口（B站偶尔对未登录会话加码）。
                // -352 是接口签名问题，登录解决不了，别再把用户往死路上引。
                const failedText = String(room.status || '');
                const needBiliLogin = /鉴权失败/.test(failedText) && !/-352/.test(failedText);
                const captured =
                  room.connected
                    ? `<p class="song-live-captured" id="live-captured-${esc(room.id)}">已捕获 <b>${room.captured || 0}</b> 条弹幕${
                        room.danmaku === 'bridge'
                          ? '（观众发弹幕后数字不动 = 该站抓取失效）'
                          : '（发条弹幕试试：数字不动 = 服务器没推送，看状态行的原因）'
                      }</p>`
                    : '';
                return `<div class="song-live-room">
                  <div class="song-live-room-head">
                    <span class="song-live-room-title">${label} · ${esc(room.roomTitle || `房间 ${room.roomId || ''}`)}</span>
                    <button class="song-rail-more" data-action="live-disconnect" data-id="${esc(room.id)}">断开</button>
                  </div>
                  <div class="song-live-on ${room.connected ? 'is-native' : 'is-status'}">
                    ${room.connecting || room.connected ? icon(room.connected ? 'check' : 'info') : icon('info')}
                    <span>${esc(room.connecting ? '连接中…' : room.connected ? '等待「点歌 歌名」' : room.status || '已断开')}</span>
                  </div>
                  ${statusLine}
                  ${captured}
                  ${needBiliLogin ? `<button class="song-live-btn" data-action="bili-login" style="width:100%;margin-top:8px">登录B站账号</button>` : ''}
                </div>`;
              })
              .join('')}
            <div class="song-live-form">
              <input class="song-live-input" id="live-room-input" placeholder="B站 / 斗鱼 / 虎牙 / 抖音 / 快手 / YY 等直播间链接" title="支持 B站、斗鱼、虎牙、抖音、快手、YY、网易CC、花椒、酷狗直播、小红书、淘宝直播、Twitch、YouTube，其它站点会尝试通用抓取。可同时连接多个直播间" value="${esc(state.live.roomUrl || '')}" spellcheck="false" />
              <button class="song-live-btn" data-action="live-connect" ${state.live.connecting ? 'disabled' : ''}>${state.live.connecting ? '连接中' : '连接'}</button>
            </div>
            ${
              state.liveHistory?.length
                ? `<div class="song-live-history"><span class="song-live-history-label">最近连接</span>${state.liveHistory
                    .map(
                      (item) =>
                        `<button class="song-live-history-btn" data-action="live-connect" data-url="${esc(item)}" title="点击直接重连：${esc(item)}">${esc(
                          String(item).replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 30)
                        )}</button>`
                    )
                    .join('')}</div>`
                : ''
            }
          </section>
        </aside>
      </div>

      <footer class="song-bar">
        <div class="song-bar-now">
          <span class="song-bar-cover">${cover ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer" />` : icon('music')}</span>
          <span class="song-bar-copy">
            <strong id="dock-title">${esc(current?.title || '还没有点歌')}</strong>
            <small id="dock-now-artist">${esc(current?.artist || '音乐')}</small>
          </span>
        </div>

        <div class="song-bar-center">
          <div class="song-bar-controls">
            <button class="song-bar-btn" data-action="song-prev" title="上一首">${icon('chevron-left')}</button>
            <button class="song-bar-play ${playing ? 'is-ready' : ''}" data-action="song-play" title="播放 / 暂停">
              <svg class="icon"><use id="dock-play-use" href="#i-play"></use></svg>
            </button>
            <button class="song-bar-btn" data-action="song-next" title="下一首">${icon('chevron-right')}</button>
          </div>
          <div class="song-bar-progress">
            <span id="song-current">0:00</span>
            <input type="range" id="song-progress" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
            <span id="song-duration">0:00</span>
          </div>
        </div>

        <div class="song-bar-right">
          ${playModePopMarkup('dock-play-mode', 'song-bar-pop')}
          ${qualityPopMarkup('dock-quality', 'song-bar-pop')}
          <button class="song-bar-btn" data-action="song-mute" title="静音">
            <svg class="icon"><use id="dock-volume-use" href="${state.songMuted ? '#i-volume-x' : '#i-volume'}"></use></svg>
          </button>
          <input class="song-bar-volume" id="dock-volume" type="range" min="0" max="100" step="1" value="${state.songVolume}" aria-label="音量" data-no-sound />
          <button class="song-bar-btn" data-action="dock-open-list" title="歌曲列表">${icon('library')}</button>
        </div>
      </footer>

      <svg hidden style="display:none"><use id="song-mute-use" href="${state.songMuted ? '#i-volume-x' : '#i-volume'}"></use></svg>
    </div>`;
}

function songView() {
  return karaokeViewMarkup();
}

/* ── 我的歌单：按平台分区，登录统一走「音乐账号」面板 ─────────────── */

const MUSIC_PLATFORM_LABELS = { netease: '网易云', qq: 'QQ 音乐', kugou: '酷狗', kuwo: '酷我' };

function musicPlatformLabel(platform) {
  return MUSIC_PLATFORM_LABELS[platform] || '音乐';
}

/** 一张歌单卡片：封面 + 名字 + 曲目数。 */
function playlistCardMarkup(item, platform, active) {
  const cover = item.cover
    ? `<img src="${esc(item.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : icon('music');
  const pid = esc(item.id);
  const pplatform = esc(platform);
  return `
    <div class="playlist-card ${active ? 'is-open' : ''}" data-id="${pid}" data-platform="${pplatform}">
      <span class="playlist-card-cover">
        <button class="playlist-card-body" data-action="my-playlist-open" data-platform="${pplatform}" data-id="${pid}" title="${esc(item.name)}">
          ${cover}
          <span class="playlist-card-count">${item.count ? `${item.count} 首` : '歌单'}</span>
        </button>
        <button class="playlist-card-play" data-action="my-playlist-play" data-platform="${pplatform}" data-id="${pid}" title="播放歌单" aria-label="播放歌单">${icon('play')}</button>
      </span>
      <span class="playlist-card-name">${esc(item.name)}</span>
      <span class="playlist-card-sub">${
        item.plaza
          ? [item.creator, item.playcount ? formatPlaycount(item.playcount) + '次播放' : ''].filter(Boolean).join(' · ') || '公开歌单'
          : item.imported ? '链接导入' : item.subscribed ? '收藏歌单' : '自建歌单'
      }</span>
    </div>`;
}

/**
 * 点开的某张歌单：整块主区换成「返回 / 标题 / 整张播放 / 加入队列 + 全量曲目」。
 *
 * 以前曲目详情是挂在卡片墙下面的，歌单多的时候要一路滑到底才看得到曲目，
 * 用户反馈「点进去没反应」。现在改成钻取：点卡片 → 主区只剩这张歌单，
 * 头部常驻四个动作，进来第一眼就能整张播放。
 *
 * 曲目不再截断：整张歌单多少首就渲染多少首（历史上截过 100 首，用户以为是歌单缺歌）。
 */
function playlistDetailMarkup(detail, platform) {
  if (!detail) return '';
  const songs = detail.songs || [];
  const label = musicPlatformLabel(platform);
  const head = `
      <div class="kr-detail-bar">
        <button class="kr-detail-back" data-action="my-playlist-close">${icon('chevron-left', 'xs')}返回歌单</button>
        <div class="kr-detail-title">
          <strong>${esc(detail.name || '歌单')}</strong>
          <small>${detail.loading ? '正在读取…' : `${songs.length} 首 · ${esc(label)}`}</small>
        </div>
        <div class="kr-detail-actions">
          <button class="kr-detail-play" data-action="my-playlist-play" data-platform="${esc(platform)}" data-id="${esc(detail.id || '')}" ${songs.length ? '' : 'disabled'}>${icon('play', 'xs')}整张播放</button>
          <button class="playlists-chip" data-action="my-playlist-import" data-platform="${esc(platform)}" title="整张追加到队列末尾，不打断正在放的那首" ${songs.length ? '' : 'disabled'}>${icon('plus', 'xs')}整张入队</button>
        </div>
      </div>`;

  if (detail.loading) {
    /*
     * 首次点开的读取占位：把卡片上登记的曲目数亮出来（网易云大歌单退本地
     * API 全量解析时可能要几十秒），再垫几行骨架，别整页只有一句话。
     */
    const count = findPlaylistCount(platform, detail.id);
    const hint = count ? `正在读取曲目（共 ${count} 首，大歌单解析需要一些时间）` : '正在读取曲目…';
    const skeleton = Array.from({ length: 6 }, () => '<span class="kr-detail-skeleton-row"></span>').join('');
    return `<div class="kr-detail">${head}<p class="playlists-group-note">${esc(hint)}</p><div class="kr-detail-skeleton">${skeleton}</div></div>`;
  }
  if (!songs.length) {
    return `<div class="kr-detail">${head}<p class="playlists-group-note">这个歌单里没有读到曲目。</p></div>`;
  }
  const current = state.songs[state.songIndex] || null;
  return `
    <div class="kr-detail">${head}
      <p class="kr-detail-hint">点任意一首就直接开播，后面按歌单顺序接着往下放。队列里已有的歌不会被动。</p>
      <div class="playlist-songs kr-detail-songs">
        ${songs
          .map((song, index) => {
            const playing = sameSongKey(song, current);
            return `
          <button class="song-chart-song kr-detail-song${playing ? ' is-current' : ''}" data-action="my-playlist-song" data-platform="${esc(platform)}" data-index="${index}" title="${playing ? '正在播放这一首' : '播放这首，后面按歌单顺序接着放'}">
            <span class="song-chart-index">${playing ? '♪' : index + 1}</span>
            <span class="song-chart-cover">${song.cover ? `<img src="${esc(song.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : icon('music')}</span>
            <span class="song-chart-copy">
              <strong>${esc(song.title)}</strong>
              <small>${esc(song.artist || '未知歌手')}</small>
            </span>
            ${icon('play', 'xs')}
          </button>`;
          })
          .join('')}
      </div>
    </div>`;
}

/** 单个平台分区。 */
function myPlaylistGroupMarkup(group) {
  const { platform, list = [], error = '', loading = false } = group;
  const label = group.label || musicPlatformLabel(platform);
  // 只有这个平台自己在同步时才转圈；别的平台同步不影响这一行
  const syncing = playlistSyncing(platform) || loading;
  const when = playlistSyncWhen(group, { withCost: true });
  /*
   * 酷狗的报错一概不显示：账号同步被官方关掉，同步失败的标记永远挂在那，
   * 把它当「登录失效」让用户反复重登只会误导。它有导入的歌单就显示个数。
   */
  const showError = error && platform !== 'kugou';
  const meta = syncing
    ? '同步中…'
    : showError
      ? group.stale
        ? '读取失败 · 显示上次结果'
        : group.expired
          ? '登录失效'
          : '读取失败'
      : `${list.length} 个歌单${when ? ` · ${when.replace('上次同步：', '')}` : ''}`;

  const head = `<div class="playlists-group-head">
      <span class="playlists-group-name"><span class="mp-dot" data-platform="${esc(platform)}"></span>${esc(label)}</span>
      <span class="playlists-group-tail">
        <span class="playlists-group-meta">${meta}</span>
        <button class="kr-group-sync" data-action="music-sync-one" data-platform="${esc(platform)}"
          title="${syncing ? `正在同步 ${esc(label)}…` : `只同步 ${esc(label)}，其它平台不动`}" ${syncing ? 'disabled' : ''}>${icon('refresh', 'xs')}</button>
      </span>
    </div>`;

  if (loading && !list.length) {
    return `<section class="playlists-group">${head}<p class="playlists-group-note">正在读取 ${esc(label)} 账号里的歌单…</p></section>`;
  }
  /*
   * 酷狗分组空态：账号歌单接口官方已关，这里不再复述原因，
   * 只留一个「链接导入」入口（导入的歌单同样落在这个分组）。
   * 有歌单（哪怕只是导入的）就照常走下面的卡片墙。
   */
  if (platform === 'kugou' && !list.length) {
    return `<section class="playlists-group">${head}
      <div class="playlists-group-actions">
        <button class="playlists-chip" data-action="import-playlist-link">${icon('download', 'xs')}链接导入</button>
      </div>
    </section>`;
  }
  if (error && !list.length && platform !== 'kugou') {
    /*
     * 分类处理：登录态过期（QQ 音乐 500003、酷狗 Access Deny）时，
     * 用户真正要做的是重新登录，不是「再读一次」。
     * 所以这种情况直接把登录按钮递到手上，别让他反复刷新对着报错看。
     */
    const expired = Boolean(group.expired);
    const reloginAction = platform === 'netease' ? 'netease-login' : 'music-account-login';
    return `<section class="playlists-group is-expired">${head}
      <p class="playlists-group-note">${expired ? `${esc(label)} 的登录已经失效了，重新登录一次就能读歌单。` : esc(error)}</p>
      ${
        expired
          ? `<div class="playlists-group-actions">
              <button class="btn btn-primary btn-sm" data-action="${reloginAction}" data-platform="${esc(platform)}">${icon('login')}重新登录</button>
              <button class="playlists-chip" data-action="music-sync-one" data-platform="${esc(platform)}">${icon('refresh', 'xs')}再试一次</button>
            </div>`
          : `<button class="playlists-chip" data-action="music-sync-one" data-platform="${esc(platform)}">${icon('refresh', 'xs')}重新读取</button>`
      }
      ${expired ? `<details class="playlists-group-detail"><summary>看看具体原因</summary><p>${esc(error)}</p></details>` : ''}
    </section>`;
  }
  if (!list.length) {
    return `<section class="playlists-group">${head}<p class="playlists-group-note">这个账号下还没有歌单。</p></section>`;
  }

  return `<section class="playlists-group">${head}
    ${
      // 这次读失败但留着上次的卡片时，把原因挂在卡片上方，别让人以为是最新的
      showError ? `<p class="playlists-group-note is-stale">${esc(error)}</p>` : ''
    }
    <div class="playlist-cards">
      ${list.map((item) => playlistCardMarkup(item, platform, false)).join('')}
    </div>
  </section>`;
}

/**
 * 「我的歌单」总面板：所有已登录平台的歌单一起列。
 *
 * 登录入口只在右上角「账号」这一处（和「音乐账号」弹窗是同一个），
 * 不再在每个平台旁边各放一套「扫码登录」，避免和账号面板重复。
 */
function allPlaylistsMarkup() {
  const groups = state.myPlaylists.groups || [];
  const logged = ['netease', 'qq', 'kugou', 'kuwo'].filter(musicLoggedIn);

  /*
   * 钻取态：点开某张歌单后整块主区只显示这张歌单的曲目。
   * 放在最前面判断，未登录时点开的广场歌单也走这里。
   */
  const detail = state.myPlaylists.detail;
  if (detail) return playlistDetailMarkup(detail, detail.platform);

  if (!logged.length) {
    /*
     * 没登录也照常显示广场：热门公开歌单不用登录就能看曲目。
     * 登录提示收窄成一条横幅，别再占整屏。
     */
    return `<div class="playlists-panel">
      <div class="playlists-error">${icon('login', 'xs')}<span>登录后这里会列出你账号里的歌单；广场歌单不用登录，点开就能看。</span>
        <button class="link-btn" data-action="music-accounts">去登录</button>
      </div>
      ${plazaSectionMarkup()}
    </div>`;
  }

  /*
   * 酷狗账号歌单同步已被官方关掉，导入的歌单可能落在未登录（或没同步成功）的分组里。
   * 已登录平台照常显示；没登录但分组里有歌单（只可能是链接导入的）也要画出来，
   * 不然导入完一刷新歌单就「消失」，用户会以为导入失败了。
   */
  const extra = groups.filter(
    (group) => group.platform && !logged.includes(group.platform) && (group.list || []).length
  );
  const shown = [...logged, ...extra.map((group) => group.platform)]
    .filter(musicPlatformEnabled)
    .map((key) => {
      const found = groups.find((group) => group.platform === key);
      if (found) return found;
      return { platform: key, label: musicPlatformLabel(key), list: [], error: '', loading: true };
    });
  const total = shown.reduce((sum, group) => sum + (group.list || []).length, 0);
  const syncing = Boolean(state.myPlaylists.loadingAll) || shown.some((group) => playlistSyncing(group.platform) || group.loading);
  const idle = ['netease', 'qq', 'kugou', 'kuwo'].filter((key) => !logged.includes(key) && musicPlatformEnabled(key));

  /*
   * 平台 tab：登录的平台多了以后，四组卡片纵向堆叠要把页面滚很久。
   * 改成一次只看一个平台（和下面歌单广场同一套 tab 交互），
   * 默认停在有歌单的第一个平台上，切过的选择记在会话里。
   */
  const activeTab = shown.some((group) => group.platform === state.myPlaylists.activeTab)
    ? state.myPlaylists.activeTab
    : (shown.find((group) => (group.list || []).length)?.platform || shown[0]?.platform || '');
  const activeGroup = shown.find((group) => group.platform === activeTab);
  const tabCounts = new Map(shown.map((group) => [group.platform, (group.list || []).length]));

  return `<div class="playlists-panel">
    <div class="playlists-bar">
      <div class="playlists-bar-title">
        <strong>我的歌单</strong>
        <span>${shown.length} 个平台 · ${syncing ? '同步中…' : `${total} 个歌单`}</span>
      </div>
      <div class="playlists-bar-actions">
        <button class="playlists-chip" data-action="music-sync-all" ${state.myPlaylists.loadingAll ? 'disabled' : ''}>${icon('refresh', 'xs')}${state.myPlaylists.loadingAll ? '同步中' : '同步全部'}</button>
        <button class="playlists-chip" data-action="music-accounts">${icon('settings', 'xs')}账号</button>
      </div>
    </div>
    ${
      state.myPlaylists.error
        ? `<div class="playlists-error">${icon('alert', 'xs')}<span>${esc(state.myPlaylists.error)}</span>
            <button class="link-btn" data-action="music-sync-all">重试</button>
          </div>`
        : ''
    }
    <div class="song-chart-tabs playlists-platform-tabs">
      ${shown
        .map(
          (group) =>
            `<button class="song-chart-tab ${group.platform === activeTab ? 'active' : ''}" data-action="my-playlist-tab" data-value="${esc(group.platform)}">${esc(group.label || musicPlatformLabel(group.platform))}${tabCounts.get(group.platform) ? `<small>${tabCounts.get(group.platform)}</small>` : ''}</button>`
        )
        .join('')}
      ${
        idle.length
          ? idle
              .map(
                (key) =>
                  `<button class="song-chart-tab is-idle" data-action="music-accounts" title="去音乐账号里登录">${esc(musicPlatformLabel(key))}＋</button>`
              )
              .join('')
          : ''
      }
    </div>
    ${activeGroup ? myPlaylistGroupMarkup(activeGroup) : ''}
    ${plazaSectionMarkup()}
  </div>`;
}

function chartPanelMarkup() {
  const c = state.charts;
  const platforms = [
    ['all', '全部榜单'],
    ['qq', 'QQ 音乐'],
    ['kugou', '酷狗'],
    ['netease', '网易云'],
  ];
  const chartList = c.list || [];
  return `
    <section class="song-charts">
      <div class="song-panel-head">
        <span>${icon('star')}榜单 <em>${chartList.length}</em>${
          c.counts && Number.isFinite(c.counts.merged)
            ? `<small>QQ ${c.counts.qq || 0} · 酷狗 ${c.counts.kugou || 0} · 网易云 ${c.counts.netease || 0}，去重后 ${c.counts.merged}</small>`
            : ''
        }</span>
        <span class="song-chart-tabs">
          ${platforms
            .map(
              ([key, label]) =>
                `<button class="song-chart-tab ${c.platform === key ? 'active' : ''}" data-action="chart-platform" data-value="${key}">${label}</button>`
            )
            .join('')}
        </span>
      </div>
      ${
        c.error
          ? `<div class="notice-error">${icon('info', 'xs')} ${esc(c.error)}</div>`
          : ''
      }
      ${
        c.loading
          ? `<p class="gacha-empty-line">正在读取榜单…</p>`
          : chartList.length
            ? `<div class="song-chart-list">
                ${chartList
                  .map(
                    (chart) => `
                  <button class="song-chart-row ${c.detail && c.detail.id === chart.id ? 'active' : ''}"
                    data-action="chart-open" data-platform="${esc(c.platform)}" data-id="${esc(chart.id)}"
                    title="${esc(chart.sourceLabel || '')}">
                    <span class="song-chart-name">${esc(chart.name)}</span>
                    ${
                      chart.sourceLabel
                        ? `<span class="song-chart-source">${esc(chart.sourceLabel)}</span>`
                        : ''
                    }
                    <span class="song-chart-meta">${esc(chart.updateKey || '')}</span>
                    ${icon('chevron-right', 'xs')}
                  </button>`
                  )
                  .join('')}
              </div>`
            : `<p class="gacha-empty-line">选一个平台读取榜单</p>`
      }
      ${
        c.detail && c.detail.songs && c.detail.songs.length
          ? `<div class="song-chart-detail">
              <div class="song-chart-detail-head">
                <strong>${esc(c.detail.name)}</strong>
                <button class="link-btn" data-action="chart-import" data-platform="${esc(c.platform)}">
                  ${icon('plus', 'xs')}全部转到网易云
                </button>
              </div>
              ${c.detail.songs
                .slice(0, 20)
                .map(
                  (song, index) => `
                <button class="song-chart-song" data-action="chart-to-netease" data-platform="${esc(c.platform)}" data-index="${index}">
                  <span class="song-chart-index">${index + 1}</span>
                  <span class="song-chart-cover">${song.cover ? `<img src="${esc(song.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : icon('music')}</span>
                  <span class="song-chart-copy">
                    <strong>${esc(song.title)}</strong>
                    <small>${esc(song.artist || '未知歌手')}</small>
                  </span>
                  ${icon('search', 'xs')}
                </button>`
                )
                .join('')}
            </div>`
          : ''
      }
      <p class="song-chart-note">榜单是公开数据，不用登录也能看。要读自己账号里的歌单，去右上角「账号」里的音乐账号面板登录一次就够了，登录后会一直记着。</p>
    </section>`;
}

/** 分类标签：角色池的记录不带标签，其他都标出来 */
function gachaKindLabel(kind) {
  return { weapon: '武器', bangboo: '邦布', standard: '常驻' }[kind] || '';
}

/** 五星记录里「不是角色」的兜底名 */
function gachaKindFallback(kind) {
  return { weapon: '未命名武器', bangboo: '未命名邦布' }[kind] || '未命名角色';
}

/** 五星头像：记录带 icon 就画圆形头像（Starward 风格），没有就回落到字牌 */
function gachaAvatarHtml(item) {
  const isWeapon = item.itemType === 'weapon';
  if (item.icon) {
    return `<span class="gacha-avatar"><img data-gacha-avatar src="${esc(item.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  }
  const label = isWeapon ? '武' : item.itemType === 'bangboo' ? '邦' : '角';
  return `<span class="gacha-avatar is-blank ${isWeapon ? 'is-weapon' : ''}">${label}</span>`;
}

/**
 * 五星图块：大立绘 + 右上角抽数角标（欧金非红），下方小字日期，完整信息悬停可看。
 * 全部顺序铺成一面图墙，不按月份分段。
 */
function gachaTileHtml(item, { cap = 90 } = {}) {
  const pity = Number(item.pity) || 0;
  const ratio = cap > 0 ? pity / cap : 0;
  const luck = pity ? (ratio <= 0.35 ? ' is-lucky' : ratio >= 0.75 ? ' is-unlucky' : '') : '';
  const isWeapon = item.itemType === 'weapon';
  const kindLabel = gachaKindLabel(item.itemType);
  const name = item.name || gachaKindFallback(item.itemType);
  const date = esc(String(item.time).slice(0, 10));
  const sub = `${name}${kindLabel ? ` · ${kindLabel}` : ''} · ${esc(item.banner)} · ${date}${pity ? ` · ${pity} 抽` : ''}`;
  const inner = item.icon
    ? `<img data-gacha-avatar src="${esc(item.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="gacha-tile-blank ${isWeapon ? 'is-weapon' : ''}">${isWeapon ? '武' : item.itemType === 'bangboo' ? '邦' : '角'}</span>`;
  return `
    <div class="gacha-tile-item" title="${sub}">
      <div class="gacha-tile${item.icon ? '' : ' is-blank'}">
        ${inner}
        ${pity ? `<span class="gacha-tile-pity${luck}">${pity}</span>` : ''}
      </div>
      <small>${date}</small>
    </div>`;
}

/**
 * 概览即全部：没有「查看全部」的二次入口。
 * 下面把角色/武器/常驻/邦布各一张统计卡同页并排，不再按池子切换——
 * 每张卡是该池的 5★ 平均、5★/4★/低星统计，和可切换的 5★/4★ 条形列表；
 * 选了具体分类时只显示对应那一张卡。
 */

// 各游戏常驻池的五星名单：限定池里抽到名单外的 = 命中 UP（标 up），名单里的 = 歪了。
// 只用来加「up」小标；认不出的游戏不给标，宁可少标不标错。
const GACHA_STANDARD_FIVE = {
  genshin: [
    '迪卢克', '琴', '莫娜', '七七', '刻晴', '提纳里', '迪希雅',
    '天空之刃', '天空之傲', '天空之卷', '天空之翼', '天空之脊',
    '阿莫斯之弓', '四风原典', '狼的末路', '和璞鸢', '风鹰剑',
  ],
  starrail: [
    '姬子', '瓦尔特', '布洛妮娅', '克拉拉', '杰帕德', '白露', '彦卿',
    '银河铁道之夜', '无可取代的东西', '但战斗还未结束', '以世界之名',
    '时节不居', '如泥酣眠', '于夜色中',
  ],
  zzz: ['猫又', '丽娜', '11号', '格莉丝', '珂蕾妲', '莱卡恩'],
};

/** 这条五星是否命中 UP：常驻/邦布池不标；名单里（含别名包含）没有它才标 */
function gachaIsUp(name, pool, standardNames) {
  if (!standardNames || !standardNames.size) return false;
  if (pool === 'standard' || pool === 'bangboo' || !name) return false;
  if (standardNames.has(name)) return false;
  for (const known of standardNames) {
    if (name.includes(known) || known.includes(name)) return false;
  }
  return true;
}

/** 一张池子统计卡：头部（池名 + 日期范围 + 总抽数）、四行统计、5★/4★ 切换、条形列表 */
function gachaPoolCard(pool, label, poolData, game, standardNames) {
  const cap = gachaPityCap(game);
  const high = gachaHighLabel(game);
  const mid = gachaMidLabel(game);
  const lowLabel = game.key === 'endfield' ? '4★' : game.key === 'zzz' ? 'B级' : '3★';
  const midLetter = mid.replace('★', '') || '4';
  const total = poolData.total || 0;
  const five = poolData.five || 0;
  const four = poolData.four || 0;
  const low = poolData.low !== undefined ? poolData.low : Math.max(0, total - five - four);
  const pct = (part) => (total ? ((part / total) * 100).toFixed(2) : '0.00');
  const isWeapon = pool === 'weapon';
  // 吃到保底的红条阈值：角色/常驻离保底 16 抽内算顶满，武器池机制不同放宽 18 抽
  const hotAt = Math.max(1, cap - (isWeapon ? 18 : 16));
  const pityCur = poolData.currentPity || 0;
  const avg = Number(poolData.averagePity) || 0;
  const range = poolData.firstTime
    ? `${esc(String(poolData.firstTime).slice(0, 10).replace(/-/g, '/'))} - ${esc(String(poolData.lastTime || poolData.firstTime).slice(0, 10).replace(/-/g, '/'))}`
    : '暂无记录';

  // —— 5★ 列表：最上面一条是当前已垫，往下是每次出金（条长 = 该次垫抽，红条 = 吃到保底）——
  const rows5 = [];
  if (pityCur) {
    rows5.push(`
      <div class="gacha-prow">
        <span class="gacha-prow-av is-pity">垫</span>
        <span class="gacha-prow-name is-muted">已垫</span>
        <span class="gacha-prow-count">${pityCur}</span>
        <span class="gacha-prow-bar"><i class="is-soft" style="width:${Math.min(100, (pityCur / cap) * 100).toFixed(1)}%"></i></span>
      </div>`);
  }
  for (const item of poolData.fiveHistory || []) {
    const pity = Number(item.pity) || 0;
    const name = item.name || gachaKindFallback(item.itemType);
    const up = gachaIsUp(name, pool, standardNames) ? '<em class="gacha-prow-up">up</em>' : '';
    rows5.push(`
      <div class="gacha-prow" title="${esc(name)} · ${esc(item.banner || '')} · ${esc(String(item.time).slice(0, 10))} · ${pity} 抽">
        ${gachaAvatarHtml(item)}
        <span class="gacha-prow-name">${esc(name)}${up}</span>
        <span class="gacha-prow-count">${pity}</span>
        <span class="gacha-prow-bar"><i${pity >= hotAt ? ' class="is-hot"' : ''} style="width:${Math.min(100, (pity / cap) * 100).toFixed(1)}%"></i></span>
      </div>`);
  }
  const list5 = rows5.join('') || `<p class="gacha-empty-line">这个池子还没有出过${esc(high)}</p>`;

  // —— 4★ 列表：按名字聚合次数，条长 = 次数占比，取前 8；头像用真图，缺图回落字牌 ——
  const fourCount = new Map();
  for (const item of poolData.fourHistory || []) {
    const name = item.name || gachaKindFallback(pool === 'weapon' ? 'weapon' : '');
    const hit = fourCount.get(name);
    if (hit) {
      hit.count += 1;
      if (!hit.icon) hit.icon = item.icon || null;
    } else {
      fourCount.set(name, { count: 1, icon: item.icon || null, itemType: item.itemType });
    }
  }
  const fourTop = [...fourCount.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  const maxFour = fourTop.length ? fourTop[0][1].count : 0;
  const list4 = fourTop.length
    ? fourTop
        .map(([name, hit]) => {
          const avatar = hit.icon
            ? gachaAvatarHtml({ icon: hit.icon, itemType: hit.itemType })
            : `<span class="gacha-prow-av is-four">${esc(midLetter)}</span>`;
          return `
      <div class="gacha-prow">
        ${avatar}
        <span class="gacha-prow-name">${esc(name)}</span>
        <span class="gacha-prow-count">${hit.count}</span>
        <span class="gacha-prow-bar"><i class="is-four" style="width:${((hit.count / maxFour) * 100).toFixed(1)}%"></i></span>
      </div>`;
        })
        .join('')
    : `<p class="gacha-empty-line">这个池子还没有${esc(mid)}记录</p>`;

  return `
    <section class="gacha-pool-card" data-pool="${esc(pool)}">
      <header class="gacha-pool-head">
        <div class="gacha-pool-title">
          <strong>${esc(label)}</strong>
          <small>${range}</small>
        </div>
        <div class="gacha-pool-total">${total}<small>抽</small></div>
      </header>
      <div class="gacha-pool-stats">
        <div class="gacha-pstat"><span class="k is-high">${esc(high)} 平均</span><span class="v">${avg || '—'}${avg ? ` <em>/ 最快 ${poolData.luckiest || '—'} 抽</em>` : ''}</span></div>
        <div class="gacha-pstat"><span class="k is-high">${esc(high)} 统计</span><span class="v">${five} <em>[${pct(five)}%]</em></span></div>
        <div class="gacha-pstat"><span class="k is-mid">${esc(mid)} 统计</span><span class="v">${four} <em>[${pct(four)}%]</em></span></div>
        <div class="gacha-pstat"><span class="k is-low">${esc(lowLabel)} 统计</span><span class="v">${low} <em>[${pct(low)}%]</em></span></div>
      </div>
      <div class="gacha-pool-switch">
        <button class="gacha-pool-tab active" data-action="gacha-pool-tab" data-tier="5">${esc(high)}</button>
        <button class="gacha-pool-tab" data-action="gacha-pool-tab" data-tier="4">${esc(mid)}</button>
      </div>
      <div class="gacha-pool-rows is-on" data-tier="5">${list5}</div>
      <div class="gacha-pool-rows" data-tier="4">${list4}</div>
    </section>`;
}

function gachaOverview(user, game, scope = 'all') {
  const high = gachaHighLabel(game);
  const mid = gachaMidLabel(game);
  const fourRate = user.fourRate !== undefined
    ? user.fourRate
    : user.total
      ? (user.four / user.total) * 100
      : 0;
  const average = Number(user.averagePity) || 0;
  const luckiest = Number(user.luckiest) || 0;

  // 常驻五星名单 = 内置名单 + 这份记录里真从常驻池抽到过的五星（数据自校准）
  const bucket = user.breakdown || null;
  const standardNames = new Set(GACHA_STANDARD_FIVE[game.key] || []);
  if (bucket && bucket.standard) {
    for (const item of bucket.standard.fiveHistory || []) {
      if (item.name) standardNames.add(item.name);
    }
  }

  // 概览直接并排铺：角色 / 武器 / 常驻 / 邦布各一张卡，一眼看完
  const POOLS = [
    ['character', '角色池'],
    ['weapon', '武器池'],
    ['standard', '常驻池'],
    ['bangboo', '邦布池'],
  ];
  const cardHtml = ([key, label]) =>
    bucket[key] && bucket[key].total > 0 ? gachaPoolCard(key, label, bucket[key], game, standardNames) : '';
  const cards = bucket
    ? scope === 'all'
      ? POOLS.map(cardHtml).filter(Boolean).join('')
      : cardHtml(POOLS.find(([key]) => key === scope) || ['standard', '当前卡池'])
    : gachaPoolCard('all', '全部记录', user, game, null);
  // 一个池子都铺不出来时给一句提示，别让 KPI 下面空着
  const body = cards
    ? `<div class="gacha-pools">${cards}</div>`
    : `<p class="gacha-empty-line">还没有出过${esc(high)}，出了会自动出现在这里。</p>`;

  return `
    <div class="gacha-dashboard">
      <div class="gacha-kpi-grid">
        <div class="gacha-kpi">
          <span>总抽数</span>
          <strong>${user.total}</strong>
          <small>${user.firstTime ? `始于 ${formatDate(user.firstTime)}` : '全部记录'}</small>
        </div>
        <div class="gacha-kpi accent-high">
          <span>${high}</span>
          <strong>${user.five}</strong>
          <small>${user.fiveRate.toFixed(2)}% 出率</small>
        </div>
        <div class="gacha-kpi">
          <span>${mid}</span>
          <strong>${user.four}</strong>
          <small>${fourRate.toFixed(1)}% 出率</small>
        </div>
        <div class="gacha-kpi">
          <span>平均出金</span>
          <strong>${average || '—'}</strong>
          <small>${average ? `最快 ${luckiest} 抽` : '还没有出金记录'}</small>
        </div>
        ${
          user.weaponFive || user.bangbooFive
            ? `<div class="gacha-kpi">
                <span>${user.bangbooFive ? '角色 / 武器 / 邦布' : '角色 / 武器'}</span>
                <strong>${user.charFive || 0}<em> / ${user.weaponFive || 0}${user.bangbooFive ? ` / ${user.bangbooFive}` : ''}</em></strong>
                <small>出金拆分</small>
              </div>`
            : ''
        }
      </div>
    </div>
    ${
      user.pityExact === false
        ? '<p class="gacha-pity-note">这份记录里没有三星抽卡，抽数会把四星也算进去，只能当参考。</p>'
        : ''
    }
    ${body}`;
}

/**
 * 渠道资源预下载进度窗：花筱灵按官方清单下载缺的文件，实时进度、可取消。
 * B服/官服共用（切服后官方链路都可能要补几十 M），channel 决定文案。
 * 完成后弹窗留在原地展示结果，用户手动关。
 */
function openNtePredownloadModal(serverId, channel = 'bilibili') {
  const isB = channel === 'bilibili';
  const label = isB ? 'B服' : '官服';
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>下载 ${label}资源</h2><p>按官方清单补齐本机缺的文件，已有的一律跳过。</p></div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="nte-predl-status" id="nte-predl-status">正在读取版本清单…</div>
          <div class="nte-predl-bar"><span id="nte-predl-fill" style="width:0%"></span></div>
          <p class="form-hint" id="nte-predl-detail"></p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="nte-predl-cancel">取消</button>
        </div>
      </div>
    </div>
  `);
  const status = document.querySelector('#nte-predl-status');
  const fill = document.querySelector('#nte-predl-fill');
  const detail = document.querySelector('#nte-predl-detail');
  const cancelBtn = document.querySelector('#nte-predl-cancel');
  let settled = false;

  const unbind = api.neverness.onPredownload?.((progress) => {
    if (settled || !progress) return;
    if (progress.phase === 'download' && progress.total) {
      const percent = Math.round((progress.current / progress.total) * 100);
      fill.style.width = `${percent}%`;
      status.textContent = `正在下载 ${progress.current}/${progress.total}`;
      detail.textContent = progress.file || '';
    } else if (progress.message) {
      status.textContent = progress.message;
    }
  });

  cancelBtn?.addEventListener('click', async () => {
    if (settled) {
      dom.modalRoot.innerHTML = '';
      document.body.classList.remove('modal-open');
      return;
    }
    cancelBtn.disabled = true;
    cancelBtn.textContent = '正在取消…';
    await api.neverness.predownloadCancel().catch(() => {});
  });

  api.neverness
    .predownload({ channel, serverId })
    .then((result) => {
      settled = true;
      cancelBtn.textContent = '完成';
      if (result?.failed?.length) {
        status.textContent = `完成，但有 ${result.failed.length} 个文件失败`;
        detail.textContent = result.failed
          .slice(0, 3)
          .map((item) => item.path)
          .join('  ');
        toast(`${label}资源下载完成，${result.failed.length} 个文件失败，可重试`, 'error');
      } else {
        fill.style.width = '100%';
        fill.parentElement.classList.add('is-done');
        status.textContent = `下载完成：新增 ${result?.downloaded ?? 0} 个文件，跳过 ${result?.skipped ?? 0} 个（本来就有）`;
        detail.textContent = `${result?.version ? `官方版本 ${result.version} · ` : ''}现在从花筱灵点「启动」就能直接进${isB ? ' B服' : '游戏'}。`;
        toast(`${label}资源已就绪，点「启动」直接开玩`, 'success');
      }
    })
    .catch((error) => {
      settled = true;
      cancelBtn.textContent = '关闭';
      status.textContent = /取消/.test(String(error)) ? '已取消下载' : `下载失败：${humanError(error)}`;
    })
    .finally(() => {
      if (typeof unbind === 'function') unbind();
    });
}

// 异环：显示识别到的账号 + 自动导入目录入口 + 自动抓取
function renderNteCapture() {  const box = document.querySelector('#nte-capture-status');
  if (!box) return;
  const capture = state.nteCapture || {};
  const running = !!capture.running;
  box.classList.toggle('is-running', running);
  box.innerHTML = running
    ? `${icon('refresh')}<span>${esc(capture.message || '抓取中…')}</span>`
    : capture.message
      ? `${icon('info')}<span>${esc(capture.message)}</span>`
      : '';
  box.hidden = !running && !capture.message;
  const startBtn = document.querySelector('[data-action="nte-capture"]');
  const stopBtn = document.querySelector('[data-action="nte-capture-stop"]');
  if (startBtn) startBtn.disabled = running;
  if (stopBtn) stopBtn.hidden = !running;
}

function nteSyncPanel() {
  const account = state.nteAccount || null;
  const server = account ? String(account.serverName || '').trim() : '';
  const who = account
    ? [server, account.roleName || account.roleId].filter(Boolean).join(' · ')
    : '';
  const meta = account
    ? [account.level ? `Lv.${account.level}` : '', account.roleId ? `UID ${account.roleId}` : '']
        .filter(Boolean)
        .join(' · ')
    : '';
  const capture = state.nteCapture || {};
  const running = !!capture.running;
  const autoPage = state.nteAutoPage !== false;
  return `
    <div class="nte-sync-panel ${account ? 'is-ready' : ''}">
      <span class="nte-sync-dot"></span>
      <div class="nte-sync-copy">
        <strong>${account ? esc(who || '已识别账号') : '还没识别到异环账号'}</strong>
        <small>${
          account
            ? `${esc(meta)} · 抓取会自动导入；也可以把导出工具生成的 JSON 放进导出目录`
            : '先用官方启动器登录一次异环，启动器会从日志里认出账号'
        }</small>
      </div>
      <div class="nte-sync-actions">
        <button class="btn btn-primary" data-action="nte-capture" ${running ? 'disabled' : ''}>${icon('download')}自动抓取</button>
        <button class="btn btn-ghost" data-action="nte-capture-stop" ${running ? '' : 'hidden'}>${icon('x')}结束</button>
        <button class="btn btn-ghost" data-action="nte-capture-auto-page" title="抓取时自动翻页（需要游戏窗口在前台）">
          <span class="nte-auto-page-dot ${autoPage ? 'is-on' : ''}"></span>自动翻页
        </button>
        <button class="btn btn-ghost" data-action="nte-folder">${icon('folder')}导出目录</button>
        <button class="btn btn-ghost" data-action="nte-refresh">${icon('refresh')}立即检查</button>
      </div>
    </div>
    <div class="nte-capture-status" id="nte-capture-status" ${running || capture.message ? '' : 'hidden'}>
      ${running ? `${icon('refresh')}<span>${esc(capture.message || '抓取中…')}</span>` : capture.message ? `${icon('info')}<span>${esc(capture.message)}</span>` : ''}
    </div>
    <p class="nte-capture-hint">自动抓取会调用异环抓包组件（管理员权限），并读取游戏发出的抽卡封包；抓取完成后自动导入。不读取账号密码。</p>`;
}

function gachaView2() {
  const dbPath = state.settings.starwardDbPath || '';
  const head = `
    ${toolsBackBar()}
    <div class="page-head">
      <div>
        <div class="eyebrow">${PAGE_META.gacha.eyebrow}</div>
        <h1>抽卡记录</h1>
        <p class="sub">从官方增量同步，或导入 UIGF / SRGF；不读取账号密码，只保存在本机。</p>
      </div>
      <div class="page-head-actions">
        <button class="btn btn-primary" data-action="sync-gacha">${icon('refresh')}同步</button>
        <button class="btn btn-ghost" data-action="import-gacha">${icon('download')}导入</button>

      </div>
    </div>`;

  if (state.gachaLoading) {
    return `<div class="page">${head}<div class="empty"><div class="empty-icon">${icon('gacha')}</div><h3>获取抽卡数据中…</h3><p>首次读取需要一点时间，请稍候。</p></div></div>`;
  }
  if (state.gachaError) {
    return `<div class="page">${head}<div class="empty"><div class="empty-icon">${icon('alert')}</div><h3>读取失败</h3><p>${esc(state.gachaError)}</p><button class="btn btn-ghost" data-action="refresh-gacha">重新读取</button></div></div>`;
  }
  if (!state.gacha) {
    return `<div class="page">${head}<div class="empty"><div class="empty-icon">${icon('gacha')}</div><h3>还没有抽卡记录</h3><p>启动器会自动读取本机的抽卡数据；也可以用 UIGF 或异环导出 JSON 导入。</p><div class="empty-actions"><button class="btn btn-primary" data-action="import-gacha">${icon('download')}导入记录</button><button class="btn btn-ghost" data-action="sync-gacha">${icon('refresh')}在线同步</button></div></div></div>`;
  }

  const selection = gachaEnsureSelection();
  if (!selection) {
    return `<div class="page">${head}<div class="empty"><div class="empty-icon">${icon('gacha')}</div><h3>还没有抽卡记录</h3><p>可以导入 UIGF / SRGF / 异环导出 JSON；终末地可以直接网页登录同步。</p><div class="empty-actions"><button class="btn btn-ghost" data-action="import-gacha">导入 UIGF / 异环</button><button class="btn btn-ghost" data-action="gacha-source" data-value="endfield">终末地同步</button></div></div></div>`;
  }
  const { games, game, user } = selection;

  // 这条记录源没有数据：五个标签照样显示，内容区给导入引导
  if (!user) {
    return `
      <div class="page">
        ${head}
        <div class="gacha-account-bar">
          <div class="gacha-game-tabs">
            ${games
              .map(
                (item) =>
                  `<button class="gacha-game-tab ${item.key === game.key ? 'active' : ''}" data-action="gacha-game" data-value="${esc(item.key)}">
                    <span>${esc(item.name)}</span><small>${(item.users || []).reduce((sum, u) => sum + u.total, 0) || '—'} 抽</small>
                  </button>`
              )
              .join('')}
          </div>
        </div>
        <div class="empty">
          <div class="empty-icon">${icon('gacha')}</div>
          <h3>${esc(game.name)} 还没有抽卡记录</h3>
          <p>${
            game.key === 'endfield'
              ? '终末地可以在游戏里打开一次抽卡记录页面，然后点「同步」自动读取。'
              : game.key === 'neverness'
                ? '异环没有公开接口，需要先用 NTE_Gacha_Exporter 导出 JSON 再导入。'
                : '同步过之后这里会自动出现；也可以直接导入 UIGF。'
          }</p>
          <div class="empty-actions">
            ${
              game.key === 'neverness'
                ? `<button class="btn btn-primary" data-action="import-gacha">${icon('download')}导入 JSON</button>`
                : `<button class="btn btn-primary" data-action="sync-gacha">${icon('refresh')}在线同步</button>
                   <button class="btn btn-ghost" data-action="import-gacha">${icon('download')}导入 UIGF</button>`
            }
          </div>
        </div>
        <p class="gacha-footnote">抽卡记录归游戏官方所有，统计只在本机计算。</p>
      </div>`;
  }

  const high = gachaHighLabel(game);
  const mid = gachaMidLabel(game);
  // 角色池 / 武器池 / 常驻池：统计口径全部跟随当前分类
  const bucket = user.breakdown || null;
  const scope = state.gachaScope || 'all';
  const view = scope === 'all' ? user : (bucket && bucket[scope]) || user;
  const scopes = bucket
    ? [
        ['all', '全部', user.total],
        ['character', '角色池', (bucket.character && bucket.character.total) || 0],
        ['weapon', '武器池', (bucket.weapon && bucket.weapon.total) || 0],
        ['standard', '常驻池', (bucket.standard && bucket.standard.total) || 0],
        ['bangboo', '邦布池', (bucket.bangboo && bucket.bangboo.total) || 0],
      ].filter(([key, , total]) => key === 'all' || total > 0)
    : [];
  const scopeTabs =
    scopes.length > 2
      ? `<div class="gacha-scope-tabs">${scopes
          .map(
            ([key, label, total]) =>
              `<button class="${key === scope ? 'active' : ''}" data-action="gacha-scope" data-value="${key}">${label}<em>${total}</em></button>`
          )
          .join('')}</div>`
      : '';
  const content = gachaOverview(view, game, scope);

  return `
    <div class="page">
      ${head}
      ${game.key === 'neverness' ? nteSyncPanel() : ''}
      <div class="gacha-account-bar">
        <div class="gacha-game-tabs">
          ${games
            .map(
              (item) =>
                `<button class="gacha-game-tab ${item.key === game.key ? 'active' : ''}" data-action="gacha-game" data-value="${esc(item.key)}">
                  <span>${esc(item.name)}</span><small>${(item.users || []).reduce((sum, u) => sum + u.total, 0)} 抽</small>
                </button>`
            )
            .join('')}
        </div>
        <div class="gacha-account-meta">
          <span>${esc(game.name)} · UID ${esc(user.uid)}</span>
          <small>${user.firstTime ? `记录始于 ${formatDate(user.firstTime)}` : '本地记录'} · ${user.total} 抽 · ${user.fivePulls || user.five} 次出金</small>
        </div>
        ${(() => {
          const ALL_SOURCES = [
            ['genshin', '原神'],
            ['starrail', '星穹铁道'],
            ['zzz', '绝区零'],
            ['endfield', '终末地'],
            ['neverness', '异环'],
          ];
          const missing = ALL_SOURCES.filter(([key]) => !games.some((item) => item.key === key));
          if (!missing.length) return '';
          // 只显示前两个，避免一行挤满；其余在导入弹窗里都能选
          return `<div class="gacha-missing-sources">${missing
            .slice(0, 2)
            .map(
              ([key, label]) =>
                `<button class="gacha-source-chip" data-action="gacha-source" data-value="${key}" title="导入或同步 ${label} 的抽卡记录">${icon('plus')}${label}</button>`
            )
            .join('')}</div>`;
        })()}
        <label class="gacha-account-select">
          <span>账号</span>
          <select id="gacha-account-select" class="select">
            ${(game.users || [])
              .map(
                (item) =>
                  `<option value="${esc(item.uid)}" ${item.uid === user.uid ? 'selected' : ''}>UID ${esc(item.uid)} · ${item.total} 抽</option>`
              )
              .join('')}
          </select>
        </label>
      </div>
      ${scopeTabs ? `<div class="gacha-subtabs">${scopeTabs}</div>` : ''}
      <div class="gacha-content">${content}</div>
      <div class="gacha-footnote-bar">
        <p class="gacha-footnote">抽卡记录归游戏官方所有，统计只在本机计算，不会上传。</p>
        <div class="gacha-meta-line">
          <span>
            ${icon('database')}
            图鉴 ${state.gacha.gachaMetaUpdatedAt ? formatDate(state.gacha.gachaMetaUpdatedAt) : '未同步'} · 角色名与立绘自动更新
          </span>
          <button class="link-btn" data-action="refresh-gacha-meta">${icon('refresh')}更新图鉴</button>
        </div>
      </div>
    </div>`;
}

function openEndfieldPackModal() {
  const settings = state.settings || {};
  openModal(`
    <div class="modal-head">
      <div><h2>终末地更新</h2><p>渠道包已内置；只有首次生成或官方发版时才需要下载。</p></div>
      <button class="icon-btn" data-close>${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="update-options">
        <button class="update-option" data-action="update-endfield-packs">
          <strong>官方渠道包</strong>
          <span>检查并更新 B服 / 国际服 / Play 的渠道 SDK，只下载变化文件。</span>
        </button>
        <button class="update-option" data-action="update-endfield-game">
          <strong>游戏本体</strong>
          <span>按官方完整清单对比，只下载缺失或变化的文件；首次可能较大。</span>
        </button>
        <button class="update-option" data-action="import-endfield-packs">
          <strong>从 XelLauncher 导入</strong>
          <span>只做一次本地复制，之后运行和更新都不再需要 XelLauncher。</span>
        </button>
        <button class="update-option" data-action="change-endfield-pack-root">
          <strong>更改渠道包目录</strong>
          <span>当前：${esc(settings.endfieldPackRoot || '未设置')}</span>
        </button>
      </div>
      <p class="form-hint">游戏本体更新不会删除官方清单以外的旧文件；更新前请先退出游戏。</p>
      <div class="modal-actions"><button class="btn btn-ghost" data-close>关闭</button></div>
    </div>
  `);
}

/* 各游戏的导入说明，弹窗里按选中项动态展示 */
const GACHA_IMPORT_GUIDES = {
  genshin: {
    name: '原神',
    format: 'UIGF 3.0 / 4.0 JSON',
    tool: '可以用任意 UIGF 导出工具生成 JSON。',
  },
  starrail: {
    name: '崩坏：星穹铁道',
    format: 'UIGF / SRGF JSON',
    tool: '可以从游戏内抽卡记录页导出，或用导出工具生成 JSON。',
  },
  zzz: {
    name: '绝区零',
    format: 'UIGF 4.0 JSON',
    tool: '从游戏内抽卡记录页导出，或选择现成的 JSON。',
  },
  endfield: {
    name: '明日方舟：终末地',
    format: '终末地导出 JSON',
    tool: '推荐直接用「同步」按钮网页登录拉取；也可以导入社区工具导出的记录。',
  },
  neverness: {
    name: '异环',
    format: 'NTE_Gacha_Exporter 导出的 JSON',
    tool: '异环官方没有公开抽卡记录接口（日志加密），在线同步做不到，只能先用社区抓包工具导出 JSON 再导入。',
    repo: 'https://github.com/Anong0u0/NTE_Gacha_Exporter',
    steps: [
      '启动异环，进游戏后按 F3 打开抽卡页面，游戏窗口保持前台可见（别最小化，16:9 分辨率可自动翻页）。',
      '点下方「下载导出工具」，启动器会自动查 GitHub 最新版并下载（连不上会自动换加速镜像），解压到你的下载目录。',
      '右键 nte-gacha-exporter.exe →「以管理员身份运行」（抓包需要管理员权限；提示缺 WebView2 就先按提示安装）。',
      '工具里语言选 zh-CN，点右上角「更新数据」——工具会自动操作游戏翻页抓包（默认增量，只抓新记录；期间别碰游戏窗口，按 Esc 中止）。',
      '抓完后在工具里点「导出」存成 JSON（默认 nte.list 格式，启动器直接认）。',
      '回到本弹窗，游戏选「异环」，选择刚导出的 JSON 导入。之后想补记录：重复第 1、4、5、6 步即可，导入永远只增不删。',
    ],
  },
};

function openGachaImportModal(presetGame = '') {
  const selected = presetGame || '';
  const guide = GACHA_IMPORT_GUIDES[selected] || null;
  const chips = [
    ['', '自动判断'],
    ['genshin', '原神'],
    ['starrail', '星穹铁道'],
    ['zzz', '绝区零'],
    ['endfield', '终末地'],
    ['neverness', '异环'],
  ]
    .map(
      ([value, label]) =>
        `<button type="button" class="gacha-import-chip ${selected === value ? 'active' : ''}" data-import-game="${value}">${label}</button>`
    )
    .join('');

  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>导入抽卡记录</h2>
            <p>支持 UIGF / SRGF，以及异环 NTE_Gacha_Exporter 的 JSON。导入后和本地记录自动去重合并。</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="gacha-import-step">
            <span class="gacha-import-index">1</span>
            <div class="gacha-import-step-main">
              <strong>选择记录来自哪个游戏</strong>
              <small>不确定时可以留空，启动器会按文件名和内容自动判断。</small>
            </div>
          </div>
          <div class="gacha-import-chips" id="gacha-import-chips">${chips}</div>

          <div class="gacha-import-step">
            <span class="gacha-import-index">2</span>
            <div class="gacha-import-step-main">
              <strong>选择导出的 JSON 文件</strong>
              <small id="gacha-import-guide">${esc(guide ? `${guide.name}：${guide.format}` : 'UIGF / SRGF / 异环导出 JSON')}</small>
            </div>
          </div>
          <div class="gacha-import-source" id="gacha-import-source">
            <div class="gacha-import-drop">
              ${icon('database')}
              <span>还没有选择文件</span>
            </div>
            <button class="btn btn-primary" id="gacha-import-pick">${icon('download')}选择 JSON 文件</button>
          </div>

          ${
            guide?.steps
              ? `<ol class="gacha-import-steps">${guide.steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>
          <div class="gacha-import-toolrow">
            <button class="btn btn-primary" id="nte-tool-download">${icon('download')}下载导出工具</button>
            <button class="btn btn-ghost" data-action="open-external" data-url="${esc(guide.repo || '')}">${icon('external')}打开发布页</button>
          </div>
          <div class="nte-tool-progress" id="nte-tool-progress" hidden>
            <div class="nte-predl-bar"><span id="nte-tool-fill" style="width:0%"></span></div>
            <div class="nte-tool-row">
              <p class="form-hint" id="nte-tool-status">准备下载…</p>
              <button class="link-btn" id="nte-tool-cancel" hidden>取消</button>
            </div>
          </div>`
              : guide
                ? `<div class="form-note">${icon('info')}<span>${esc(guide.tool)}</span></div>`
                : ''
          }

          <div class="gacha-import-result" id="gacha-import-result" hidden></div>
          <div class="field-error" id="gacha-import-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
          ${
            /* 异环没有公开接口、做不了在线同步，这条按钮对它没有意义；其他游戏跟随当前选择 */
            selected !== 'neverness'
              ? `<button class="btn btn-ghost" data-action="gacha-source" data-value="${selected || 'endfield'}">${icon('refresh')}改用在线同步</button>`
              : ''
          }
        </div>
      </div>
    </div>
  `);

  const pick = document.querySelector('#gacha-import-pick');
  const error = document.querySelector('#gacha-import-error');
  const resultBox = document.querySelector('#gacha-import-result');
  const chipsRoot = document.querySelector('#gacha-import-chips');
  if (!pick) return;

  // 异环：一键下载导出工具（GitHub 直连 + 镜像加速，解压到系统下载目录后自动打开）
  const toolBtn = document.querySelector('#nte-tool-download');
  // 取消按钮只在弹窗生命周期内绑一次，放外面防止重复下载时叠加 handler
  document.querySelector('#nte-tool-cancel')?.addEventListener('click', async function onCancel() {
    this.disabled = true;
    await api.gacha.nteToolCancel?.().catch(() => {});
  });
  toolBtn?.addEventListener('click', async () => {
    const fill = document.querySelector('#nte-tool-fill');
    const status = document.querySelector('#nte-tool-status');
    const cancelBtn = document.querySelector('#nte-tool-cancel');
    const box = document.querySelector('#nte-tool-progress');
    if (!box || !status) return;
    toolBtn.disabled = true;
    box.hidden = false;
    if (cancelBtn) {
      cancelBtn.hidden = false;
      cancelBtn.disabled = false;
    }
    status.textContent = '正在查询最新版本…';
    const unbind = api.gacha.onNteTool?.((progress) => {
      if (!progress) return;
      if (progress.phase === 'meta' && progress.version) {
        status.textContent = `最新版本 v${progress.version}，开始下载…`;
      } else if (progress.phase === 'download' && progress.total) {
        if (fill) fill.style.width = `${Math.round((progress.received / progress.total) * 100)}%`;
        status.textContent = `正在下载 ${(progress.received / 1048576).toFixed(1)} / ${(progress.total / 1048576).toFixed(1)} MB`;
      } else if (progress.phase === 'unzip') {
        if (fill) fill.style.width = '100%';
        status.textContent = '正在解压到下载目录…';
      }
    });
    try {
      const result = await api.gacha.nteToolDownload();
      if (fill) fill.style.width = '100%';
      if (cancelBtn) cancelBtn.hidden = true;
      status.textContent = `已下载并解压 v${result?.version || ''} 到 ${result?.dir || '下载目录'}，文件夹已打开`;
      toast('导出工具已就绪：解压文件夹里右键 nte-gacha-exporter.exe 以管理员身份运行', 'success');
    } catch (error) {
      status.textContent = `下载失败：${humanError(error)}，可以点「打开发布页」手动下载`;
    } finally {
      if (typeof unbind === 'function') unbind();
      toolBtn.disabled = false;
    }
  });

  chipsRoot?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-import-game]');
    if (!button) return;
    const key = button.dataset.importGame;
    if (key !== selected) openGachaImportModal(key);
  });

  pick.addEventListener('click', async () => {
    const game = chipsRoot?.querySelector('.gacha-import-chip.active')?.dataset.importGame || '';
    error.textContent = '';
    resultBox.hidden = true;
    const original = pick.innerHTML;
    pick.disabled = true;
    pick.innerHTML = '正在读取…';
    let done = false;
    try {
      const result = await api.gacha.import(game);
      if (!result || result.cancelled) return;
      state.gacha = null;
      await loadGacha(true);
      const fileName = String(result.filePath || '').split(/[\\/]/).pop();
      resultBox.hidden = false;
      resultBox.innerHTML = `
        <span class="gacha-import-ok">${icon('check')}导入成功</span>
        <strong>${result.imported} 条新记录</strong>
        <small>${esc(fileName)} · 当前共 ${result.total} 条 · UID ${esc((result.uids || []).join('、') || '—')}</small>
      `;
      pick.innerHTML = `${icon('plus')}再导入一个`;
      done = true;
      toast(`已导入 ${result.imported} 条记录`, 'success');
    } catch (err) {
      error.textContent = humanError(err);
    } finally {
      pick.disabled = false;
      if (!done) pick.innerHTML = original;
    }
  });
}

function openGachaSyncModal() {
  const installed = (state.games || []).filter(
    (game) =>
      ['genshin', 'starrail', 'zzz', 'endfield'].includes(game.builtinKey) &&
      (game.servers || []).some((server) => server.active && server.exists)
  );
  if (!installed.length) {
    toast('先配置原神、星铁、绝区零或终末地的客户端路径', 'error');
    return;
  }
  const defaultGame =
    installed.find((game) => game.builtinKey === state.gachaGameKey) || installed[0];
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>获取抽卡数据</h2><p>自动读取本机已有的记录，只拉取还没有的新数据。</p></div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <label class="field">
            <span>从哪个游戏同步</span>
            <select id="gacha-sync-game">
              ${installed
                .map(
                  (game) =>
                    `<option value="${esc(game.id)}" ${game.id === defaultGame.id ? 'selected' : ''}>${esc(game.name)}</option>`
                )
                .join('')}
            </select>
          </label>
          <div class="form-note">${icon('info')}<span id="gacha-sync-hint">原神 / 星铁 / 绝区零：先在游戏里打开一次抽卡记录页面。终末地：同样打开一次抽卡记录即可自动读取；只有确实读不到时才会提示网页登录。</span></div>
          <p class="form-hint">同步只会新增记录，不会覆盖或删除本地已有的数据。</p>
          <div class="field-error" id="gacha-sync-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>取消</button>
          <button class="btn btn-ghost" data-action="import-gacha">${icon('download')}改用导入</button>
          <button class="btn btn-primary" id="gacha-sync-start">${icon('refresh')}开始增量同步</button>
        </div>
      </div>
    </div>
  `);
  const start = document.querySelector('#gacha-sync-start');
  if (!start) return;
  start.addEventListener('click', async () => {
    const gameId = document.querySelector('#gacha-sync-game')?.value;
    const syncGame = state.games.find((game) => game.id === gameId);
    const errorBox = document.querySelector('#gacha-sync-error');
    if (errorBox) errorBox.textContent = '';
    start.disabled = true;
    start.textContent = '获取抽卡数据中…';
    try {
      let result = await api.gacha.sync(gameId);

      // 只有主进程明确说「需要登录」才弹网页窗口；
      // 其他失败（网络、接口变更）直接报错，不再无故弹窗。
      if (syncGame?.builtinKey === 'endfield' && result && result.needLogin) {
        start.textContent = '等待网页登录…';
        const auth = await api.endfieldLogin();
        start.textContent = '获取抽卡数据中…';
        result = await api.gacha.sync(gameId, auth);
      }

      if (result && result.ok === false) {
        // 仍然拿不到凭据：留在弹窗里给说明，不关窗、不弹第二个窗口
        if (errorBox) errorBox.textContent = result.error || '同步失败';
        start.disabled = false;
        start.innerHTML = `${icon('refresh')}重试`;
        return;
      }

      closeModal();
      state.gacha = null;
      await loadGacha(true);
      toast(
        result.imported
          ? `同步完成：新增 ${result.imported} 条，UID ${result.uid}`
          : `没有新记录（UID ${result.uid}）`,
        'success'
      );
    } catch (error) {
      if (errorBox) errorBox.textContent = humanError(error);
      toast(humanError(error), 'error');
      start.disabled = false;
      start.innerHTML = `${icon('refresh')}重试`;
    }
  });
}

async function loadGacha(force = false) {
  if (state.gachaLoading) return;
  if (state.gacha && !force) return;
  state.gachaLoading = true;
  state.gachaError = '';
  render({ preserveScroll: true });
  try {
    state.gacha = await api.gacha.load(force);
    startGachaRefresh();
  } catch (error) {
    state.gachaError = humanError(error);
    stopGachaRefresh();
  } finally {
    state.gachaLoading = false;
    if (state.route === 'gacha') render({ preserveScroll: true });
  }
}

function stopGachaRefresh() {
  if (gachaRefreshTimer) {
    clearInterval(gachaRefreshTimer);
    gachaRefreshTimer = null;
  }
}

function startGachaRefresh() {
  stopGachaRefresh();
  gachaRefreshTimer = setInterval(async () => {
    if (state.route !== 'gacha' || state.gachaLoading || !state.gacha) return;
    try {
      const next = await api.gacha.load();
      if (JSON.stringify(next) !== JSON.stringify(state.gacha)) {
        state.gacha = next;
        render({ preserveScroll: true });
      }
    } catch {
      /* keep the last successful snapshot */
    }
  }, 15000);
}


/* ------------------------------------------------------------------ */
/* downloads                                                           */
/* ------------------------------------------------------------------ */

function statusInfo(item) {
  switch (item.status) {
    case 'downloading':
      return { label: '下载中', cls: 'downloading' };
    case 'queued':
      return { label: '排队中', cls: 'paused' };
    case 'paused':
      return { label: '已暂停', cls: 'paused' };
    case 'completed':
      return { label: '已完成', cls: 'completed' };
    case 'error':
      return { label: '失败', cls: 'error' };
    case 'cancelled':
      return { label: '已取消', cls: 'paused' };
    default:
      return { label: '等待中', cls: '' };
  }
}

function downloadRow(item) {
  const status = statusInfo(item);
  const pct = item.total > 0 ? Math.min(100, (item.received / item.total) * 100) : 0;
  const indeterminate = item.status === 'downloading' && !item.total;
  const ext = (item.fileName.split('.').pop() || 'file').slice(0, 4);
  let subtitle = item.status === 'completed' ? '已保存到下载文件夹' : esc(item.url);
  try {
    subtitle = item.status === 'completed' ? item.filePath : new URL(item.url).hostname;
  } catch {
    /* keep */
  }
  const speedText =
    item.status === 'downloading'
      ? `${fmtSpeed(item.speed)}${etaText(item) ? ` · 剩余 ${etaText(item)}` : ''}`
      : item.status === 'completed'
        ? `${fmtBytes(item.received)} · ${relativeDate(item.completedAt)}`
        : item.status === 'paused'
          ? '已保留未完成的片段'
          : item.status === 'error'
            ? item.error || '下载失败'
            : item.status === 'cancelled'
              ? '文件片段已清理'
              : '等待开始';

  const actions = [];
  if (item.status === 'downloading' || item.status === 'queued') {
    actions.push(`<button class="btn-icon" data-action="pause-download" data-id="${esc(item.id)}" title="暂停">${icon('pause')}</button>`);
    actions.push(`<button class="btn-icon danger" data-action="cancel-download" data-id="${esc(item.id)}" title="取消">${icon('x')}</button>`);
  } else if (item.status === 'completed') {
    actions.push(`<button class="btn-icon" data-action="open-download" data-id="${esc(item.id)}" title="打开文件">${icon('play')}</button>`);
    actions.push(`<button class="btn-icon" data-action="open-download-folder" data-id="${esc(item.id)}" title="打开所在文件夹">${icon('folder-open')}</button>`);
    actions.push(`<button class="btn-icon danger" data-action="remove-download" data-id="${esc(item.id)}" title="移除记录">${icon('trash')}</button>`);
  } else {
    actions.push(`<button class="btn-icon" data-action="resume-download" data-id="${esc(item.id)}" title="继续">${icon('refresh')}</button>`);
    actions.push(`<button class="btn-icon danger" data-action="remove-download" data-id="${esc(item.id)}" title="移除">${icon('trash')}</button>`);
  }

  return `
    <div class="dl-row" data-dl-id="${esc(item.id)}">
      <div class="dl-file">
        <div class="file-icon">${esc(ext)}</div>
        <div style="min-width:0">
          <div class="dl-name" title="${esc(item.fileName)}">${esc(item.fileName)}</div>
          <div class="dl-url" title="${esc(subtitle)}">${esc(subtitle)}</div>
        </div>
      </div>
      <div class="dl-progress">
        <div class="progress-top">
          <strong data-dl-bytes>${fmtBytes(item.received)}${item.total ? ` / ${fmtBytes(item.total)}` : ''}</strong>
          <span>${item.total ? `${pct.toFixed(0)}%` : ''}</span>
        </div>
        <div class="progress-bar ${indeterminate ? 'indeterminate' : ''}">
          <span style="width:${pct}%"></span>
        </div>
      </div>
      <div class="dl-status">
        <span class="status-chip ${status.cls}">${status.label}</span>
        <div class="speed" data-dl-speed>${esc(speedText)}</div>
      </div>
      <div class="dl-actions">${actions.join('')}</div>
    </div>`;
}

function downloadsView() {
  const downloads = state.downloads;
  const active = activeDownloads();
  const paused = downloads.filter((d) => d.status === 'paused' || d.status === 'error').length;
  const completed = downloads.filter((d) => d.status === 'completed');
  const totalSpeed = active.reduce((sum, d) => sum + (d.speed || 0), 0);
  return `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">${PAGE_META.downloads.eyebrow}</div>
          <h1>下载 <span class="count">${active.length ? `${active.length} 个进行中` : '空闲'}</span></h1>
          <p class="sub">管理 http / https 直链下载，支持暂停、继续和断点续传。</p>
        </div>
        <div class="page-head-actions">
          <button class="btn btn-ghost" data-action="pause-all-downloads">暂停全部</button>
          <button class="btn btn-ghost" data-action="resume-all-downloads">继续全部</button>
          <button class="btn btn-primary" data-action="add-download">${icon('plus')}新建下载</button>
        </div>
      </div>
      <div class="dl-summary">
        <div class="dl-stat">
          <div class="label">${icon('download')}进行中</div>
          <div class="value" id="dl-active-count">${active.length}</div>
          <div class="hint">${paused ? `${paused} 个任务已暂停或失败` : '队列运行正常'}</div>
        </div>
        <div class="dl-stat">
          <div class="label">${icon('sparkle')}当前速度</div>
          <div class="value" id="dl-total-speed">${fmtSpeed(totalSpeed)}</div>
          <div class="hint">所有任务合计</div>
        </div>
        <div class="dl-stat">
          <div class="label">${icon('check')}已完成</div>
          <div class="value">${completed.length}</div>
          <div class="hint">保存在 ${esc(state.settings.downloadDir || '下载文件夹')}</div>
        </div>
      </div>
      <div class="dl-panel">
        <div class="dl-panel-head">
          <div>
            <h2>任务队列</h2>
            <div class="hint">${downloads.length ? `${downloads.length} 条记录` : '还没有下载任务'}</div>
          </div>
          <button class="link-btn" data-action="open-download-folder">${icon('folder-open')}打开下载文件夹</button>
        </div>
        ${
          downloads.length
            ? `<div class="dl-list">${downloads.map(downloadRow).join('')}</div>`
            : `<div class="empty" style="border:0;border-radius:0;background:transparent">
                <div class="empty-icon">${icon('download')}</div>
                <h3>队列是空的</h3>
                <p>把一个下载链接交给花筱灵。它会显示速度、进度和剩余时间，也可以随时暂停。</p>
                <button class="btn btn-primary" data-action="add-download">${icon('plus')}新建下载</button>
              </div>`
        }
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */
/*
 * 「工具」页完全由主进程的 electron/game-features.js 驱动：
 * 想加新游戏 / 新功能，只改那个文件，这里自动跟着变，不用动前端。
 */

/**
 * 读取能力注册表。
 * 注意：调用方负责在拿到数据后重绘，这里不自己 render——
 * 因为 navigate() 里调用它时 state.route 还没切成 'tools'。
 */
async function loadFeatures(force = false) {
  if (state.features && !force) return state.features;
  if (state.featuresLoading) return state.features;
  state.featuresLoading = true;
  try {
    if (!window.launcher?.features?.all) throw new Error('当前版本不支持能力列表');
    // byCategory 返回的是 [{category, items}] 数组，features/games 是平铺数组
    const [data, byCategory] = await Promise.all([
      window.launcher.features.all(),
      window.launcher.features.byCategory(),
    ]);
    state.features = {
      ...(data && typeof data === 'object' ? data : {}),
      byCategory: Array.isArray(byCategory) ? byCategory : [],
    };
  } catch (error) {
    state.features = { error: humanError(error) || '读取功能列表失败' };
  } finally {
    state.featuresLoading = false;
  }
  // 战绩页也靠这份矩阵决定标签行显示哪些游戏
  if (state.route === 'tools' || state.route === 'record') render({ preserveScroll: true });
  // 侧栏「工具」子项依赖这份数据，拿到后立刻补上
  renderNavToolsSub();
  return state.features;
}

/* ------------------------------------------------------------------ */
/* 米游社 / HoYoLAB 登录                                                */
/* ------------------------------------------------------------------ */

/*
 * 米家四款游戏共用一套米游社登录：
 * 打开内嵌窗口让用户自己扫码 / 输手机号 / 输密码（参考 Starward），
 * 登录成功后主进程会立刻拿到 cookie 并核对角色，这里只负责把结果画出来。
 */

/** 哪些游戏用米游社那套登录。 */
const MIYOUSHE_GAMES = ['genshin', 'starrail', 'zzz', 'bh3'];

async function refreshHoyolabStatus(provider = 'miyoushe', force = false, accountId = '') {
  const cacheKey = `hoyolab-${provider}`;
  if (!force && !accountId && state.hoyolab?.[cacheKey]) return state.hoyolab[cacheKey];
  state.hoyolab = state.hoyolab || {};
  const previous = state.hoyolab[cacheKey] || {};
  state.hoyolab[cacheKey] = { ...previous, loading: true, roles: previous.roles || [] };
  try {
    if (!window.launcher?.hoyolab?.status) throw new Error('当前版本不支持米游社登录');
    const result = await window.launcher.hoyolab.status({
      provider,
      accountId: accountId || undefined,
    });
    const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
    const activeId = String(result?.activeId || '');
    state.hoyolab[cacheKey] = {
      loading: false,
      loggedIn: Boolean(result?.loggedIn),
      roles: Array.isArray(result?.roles) ? result.roles : [],
      accounts,
      activeId,
      savedAt: result?.savedAt || 0,
      reason: result?.reason || '',
    };
    // 战绩页选中的账号如果已经不在了，回到当前激活的账号
    if (state.record.account && accounts.length && !accounts.some((item) => item.id === state.record.account)) {
      state.record.account = '';
    }
    if (!state.record.account && activeId) state.record.account = activeId;
  } catch (error) {
    state.hoyolab[cacheKey] = {
      loading: false,
      loggedIn: false,
      roles: [],
      accounts: [],
      activeId: '',
      reason: humanError(error),
    };
  }
  return state.hoyolab[cacheKey];
}

async function doHoyolabLogin(provider = 'miyoushe', game = 'genshin', addAccount = false) {
  if (!window.launcher?.hoyolab?.login) {
    toast('当前版本不支持米游社登录', 'error');
    return;
  }
  toast(
    addAccount ? '登录窗口已打开，登录完成后会追加成一个新账号' : '已打开登录窗口，扫码或输入手机号即可',
    'info'
  );
  try {
    const result = await window.launcher.hoyolab.login({ provider, game, addAccount });
    if (!result?.ok) {
      if (!result?.cancelled) toast(result?.reason || '登录失败', 'error');
      return;
    }
    const accounts = Array.isArray(result.accounts) ? result.accounts : [];
    const activeId = String(result.activeId || result.accountId || '');
    state.hoyolab = state.hoyolab || {};
    state.hoyolab[`hoyolab-${provider}`] = {
      loading: false,
      loggedIn: true,
      roles: Array.isArray(result.roles) ? result.roles : [],
      accounts,
      activeId,
      savedAt: Date.now(),
    };
    /*
     * 换了账号，上一个账号的战绩缓存和选中的角色都不能再用了 ——
     * 缓存键里没有账号维度，不清就会拿别人的数据冒充这个账号的。
     */
    state.record.account = activeId;
    state.record.role = {};
    state.record.cache = {};
    const count = state.hoyolab[`hoyolab-${provider}`].roles.length;
    const extra = accounts.length > 1 ? `，当前共 ${accounts.length} 个账号` : '';
    toast(`登录成功，读到 ${count} 个角色${extra}`, 'success');
    render({ preserveScroll: true });
  } catch (error) {
    toast(humanError(error) || '登录失败', 'error');
  }
}

async function doHoyolabLogout(provider = 'miyoushe', accountId = '') {
  try {
    const result = await window.launcher.hoyolab.logout({ provider, id: accountId || undefined });
    const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
    const activeId = String(result?.activeId || '');
    state.hoyolab = state.hoyolab || {};
    state.hoyolab[`hoyolab-${provider}`] = {
      loading: false,
      loggedIn: accounts.length > 0,
      roles: [],
      accounts,
      activeId,
    };
    state.record.role = {};
    state.record.cache = {};
    state.record.account = activeId;
    // 还有别的账号时，把当前账号的角色列表顺手拉回来
    if (accounts.length) await refreshHoyolabStatus(provider, true);
    toast(accountId ? '已移除这个米游社账号' : '已退出米游社登录', 'info');
    render({ preserveScroll: true });
    if (state.route === 'record' && accounts.length) {
      await loadRecord(true);
      render({ preserveScroll: true });
    }
  } catch (error) {
    toast(humanError(error) || '退出失败', 'error');
  }
}

/** 切换当前米游社账号：工具页的账号卡片和战绩页的账号条共用。 */
async function doHoyolabSwitch(provider = 'miyoushe', accountId = '') {
  if (!window.launcher?.hoyolab?.switchAccount) {
    toast('当前版本不支持切换账号', 'error');
    return;
  }
  try {
    const result = await window.launcher.hoyolab.switchAccount({ provider, accountId });
    if (!result?.ok) {
      toast(result?.reason || '切换账号失败', 'error');
      return;
    }
    const accounts = Array.isArray(result.accounts) ? result.accounts : [];
    const activeId = String(result.activeId || '');
    state.hoyolab = state.hoyolab || {};
    state.hoyolab[`hoyolab-${provider}`] = {
      loading: false,
      loggedIn: Boolean(result.loggedIn),
      roles: Array.isArray(result.roles) ? result.roles : [],
      accounts,
      activeId,
      reason: result.reason || '',
    };
    state.record.account = activeId;
    state.record.role = {};
    state.record.cache = {};
    const label = accounts.find((item) => item.id === activeId)?.label || '这个账号';
    toast(`已切到 ${label}`, 'success');
    render({ preserveScroll: true });
    if (state.route === 'record') {
      await loadRecord(true);
      render({ preserveScroll: true });
    }
  } catch (error) {
    toast(humanError(error) || '切换账号失败', 'error');
  }
}

/** 米游社登录卡片：一个面板覆盖四款米家游戏，可以挂多个通行证账号。 */
function hoyolabLoginCard() {
  const status = state.hoyolab?.['hoyolab-miyoushe'] || { loading: true, roles: [], accounts: [] };
  const accounts = Array.isArray(status.accounts) ? status.accounts : [];
  const activeId = String(status.activeId || '');
  const roleChips = (status.roles || [])
    .filter((role) => MIYOUSHE_GAMES.includes(role.game))
    .map(
      (role) => `<span class="miyo-role" title="${esc(role.gameBiz)} ${esc(role.regionName)}">
        ${esc(shotGameLabel(role.game))} · ${esc(role.nickname || role.uid)}
        <em>${esc(role.uid)}</em>
      </span>`
    )
    .join('');

  const accountRows = accounts
    .map((account) => {
      const isActive = account.id === activeId;
      return `<div class="miyo-account ${isActive ? 'is-active' : ''}">
        <div class="miyo-account-main">
          <span class="miyo-account-name">${esc(account.label || account.id)}</span>
          <span class="miyo-account-meta">${account.roles.length} 个角色${isActive ? ' · 使用中' : ''}</span>
        </div>
        <div class="miyo-account-actions">
          ${
            isActive
              ? ''
              : `<button class="btn ghost xs" data-action="hoyolab-switch" data-value="${esc(account.id)}">切换</button>`
          }
          <button class="btn ghost xs" data-action="hoyolab-remove" data-value="${esc(account.id)}" title="移除这个账号">${icon('trash', 'xs')}</button>
        </div>
      </div>`;
    })
    .join('');

  return `<div class="page glass-panel miyo-card">
    <div class="miyo-head">
      <div>
        <div class="eyebrow">MIYOUSHE</div>
        <h2>米游社账号</h2>
        <p class="page-desc">原神 / 星穹铁道 / 绝区零 / 崩坏3 共用一套登录。可以挂多个通行证账号，战绩页按账号分开查。在弹出窗口里扫码或输手机号，登录完成会自动关闭。</p>
      </div>
      <div class="miyo-actions">
        ${
          status.loggedIn
            ? `<span class="miyo-state is-on">${icon('check', 'xs')}已登录${
                accounts.length > 1 ? ` ${accounts.length} 个账号` : ''
              }</span>
               <button class="btn accent" data-action="hoyolab-login" data-value="miyoushe" data-mode="add">${icon('plus', 'xs')}添加账号</button>
               <button class="btn ghost" data-action="hoyolab-logout" data-value="miyoushe">全部退出</button>`
            : `<span class="miyo-state">${status.loading ? '读取中' : '未登录'}</span>
               <button class="btn accent" data-action="hoyolab-login" data-value="miyoushe">${icon('link', 'xs')}打开米游社登录</button>`
        }
      </div>
    </div>
    <div class="miyo-methods">
      <span>${icon('login', 'xs')}扫码</span>
      <span>${icon('news', 'xs')}手机验证码</span>
      <span>${icon('shield', 'xs')}账号密码</span>
      <em>登录态只保存在本机，不会上传</em>
    </div>
    ${accountRows ? `<div class="miyo-accounts">${accountRows}</div>` : ''}
    ${roleChips ? `<div class="miyo-roles">${roleChips}</div>` : ''}
    ${status.reason && !status.loggedIn ? `<p class="miyo-hint">${esc(status.reason)}</p>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* 截图管理 / 画质配置                                                  */
/* ------------------------------------------------------------------ */

const SHOT_GAME_LABEL = {
  genshin: '原神',
  starrail: '崩坏：星穹铁道',
  zzz: '绝区零',
  bh3: '崩坏3',
  endfield: '明日方舟：终末地',
  neverness: '异环',
  arknights: '明日方舟',
  other: '其他截图',
};

function shotGameLabel(key) {
  return SHOT_GAME_LABEL[key] || key || '其他截图';
}

/**
 * 缩略图按需装载。
 * 页面在 file:// 下，<img src="hxl-shot://..."> 会被跨源拦截，
 * 所以走 IPC 拿 data URL，并且只装载视口附近的那些，避免一次解 269 张图。
 */
const shotThumbs = new Map();

function ensureShotThumbs(list) {
  if (!window.launcher?.screenshots?.thumb) return;
  const limit = 60;
  for (const item of list.slice(0, limit)) {
    if (shotThumbs.has(item.path)) continue;
    shotThumbs.set(item.path, { status: 'loading' });
    window.launcher.screenshots
      .thumb(item.path)
      .then((result) => {
        shotThumbs.set(item.path, result?.ok ? { status: 'ok', dataUrl: result.dataUrl } : { status: 'fail', reason: result?.reason || '' });
      })
      .catch((error) => {
        shotThumbs.set(item.path, { status: 'fail', reason: String(error.message || '') });
      })
      .finally(() => {
        if (state.route === 'screenshots') scheduleShotRepaint();
      });
  }
}

// 缩略图陆续到位，不能整页重绘（会把滚动位置和正在播放的音频打断）。
// 注意：占位时 DOM 里是 <div class="shot-placeholder">，不是 <img>，
// 所以这里必须「替换节点」而不是「改已有 <img> 的 src」。
let shotRepaintTimer = 0;
function scheduleShotRepaint() {
  if (shotRepaintTimer) return;
  shotRepaintTimer = setTimeout(() => {
    shotRepaintTimer = 0;
    for (const cell of document.querySelectorAll('.shot-cell[data-path]')) {
      const entry = shotThumbs.get(cell.dataset.path);
      if (!entry || entry.status === 'loading') continue;
      if (cell.dataset.ready === '1') continue;
      const holder = cell.querySelector('.shot-placeholder');
      if (!holder) continue;
      const replaced = document.createElement('template');
      replaced.innerHTML = shotThumbMarkup({ path: cell.dataset.path, name: cell.dataset.name || '' }).trim();
      const node = replaced.content.firstElementChild;
      if (!node) continue;
      holder.replaceWith(node);
      cell.dataset.ready = '1';
      cell.classList.remove('is-pending');
      if (entry.status === 'fail') cell.classList.add('is-failed');
    }
  }, 120);
}

function shotThumbMarkup(item) {
  const entry = shotThumbs.get(item.path);
  if (entry?.status === 'ok') {
    return `<img src="${entry.dataUrl}" alt="${esc(item.name)}" decoding="async" data-filled="1" />`;
  }
  const failed = entry?.status === 'fail';
  return `<div class="shot-placeholder${failed ? ' is-failed' : ''}">${failed ? icon('image') : icon('image', 'xs')}<span>${failed ? '无法预览' : '载入中'}</span></div>`;
}

function shotUrl(filePath) {
  return `hxl-shot://local/?p=${encodeURIComponent(filePath)}`;
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function loadScreenshots(force = false) {
  if (state.shots && !force) return state.shots;
  if (state.shotsLoading) return state.shots;
  state.shotsLoading = true;
  state.shotsError = '';
  render({ preserveScroll: true });
  try {
    if (!window.launcher?.screenshots?.list) throw new Error('当前版本不支持截图扫描');
    const result = await window.launcher.screenshots.list();
    if (result && result.ok === false) throw new Error(result.reason || '扫描失败');
    const groups = result?.groups && typeof result.groups === 'object' ? result.groups : {};
    state.shots = {
      total: Number(result?.total) || 0,
      groups,
    };
    // 默认选中截图最多的那个游戏
    const keys = Object.keys(groups).sort((a, b) => (groups[b]?.length || 0) - (groups[a]?.length || 0));
    if (!keys.includes(state.shotsGame)) state.shotsGame = keys[0] || '';
  } catch (error) {
    state.shots = null;
    state.shotsError = humanError(error) || '扫描截图失败';
  } finally {
    state.shotsLoading = false;
    if (state.route === 'screenshots') render({ preserveScroll: true });
  }
  return state.shots;
}

function shotsView() {
  const data = state.shots;
  const groups = data?.groups || {};
  const keys = Object.keys(groups || {}).sort((a, b) => (groups[b]?.length || 0) - (groups[a]?.length || 0));
  const active = keys.includes(state.shotsGame) ? state.shotsGame : keys[0] || '';
  const list = groups[active] || data?.list || [];

  let body = '';
  if (state.shotsLoading && !data) {
    body = `<div class="tools-empty">${icon('refresh')}<strong>正在扫描截图目录</strong><p>第一次扫描会遍历图片文件夹，稍等一下。</p></div>`;
  } else if (state.shotsError) {
    body = `<div class="tools-empty">${icon('info')}<strong>${esc(state.shotsError)}</strong><p>可以在设置里手动补充截图目录。</p><button class="btn ghost" data-action="shots-refresh">${icon('refresh', 'xs')}重新扫描</button></div>`;
  } else if (!data || !data.total) {
    body = `<div class="tools-empty">${icon('image')}<strong>没有找到截图</strong><p>把游戏截图放在图片文件夹里，或在设置里添加自定义目录。</p><button class="btn ghost" data-action="shots-refresh">${icon('refresh', 'xs')}重新扫描</button></div>`;
  } else {
    body = `
      <div class="shots-tabs">
        ${keys
          .map(
            (key) => `<button class="shots-tab${key === active ? ' active' : ''}" data-action="shots-game" data-value="${esc(key)}">
              ${esc(shotGameLabel(key))}<em>${groups[key].length}</em>
            </button>`
          )
          .join('')}
      </div>
      <div class="shots-grid">
        ${list
          .map(
            (item) => `
          <figure class="shot-cell is-pending" data-action="shots-open" data-path="${esc(item.path)}">
            ${shotThumbMarkup(item)}
            <figcaption>
              <span>${esc(formatShotTime(item.time))}</span>
              <em>${esc(formatBytes(item.size))}</em>
            </figcaption>
            <button class="shot-reveal" data-action="shots-reveal" data-path="${esc(item.path)}" title="在资源管理器中显示">${icon('folder', 'xs')}</button>
          </figure>`
          )
          .join('')}
      </div>
      <p class="shots-note">点击缩略图用系统看图工具打开；右侧按钮在文件夹中定位。共 ${data.total} 张，只读扫描，不会移动或删除文件。</p>
    `;
  }

  // 必须放在 if/else 之外：只有 total>0 时才列出缩略图，
  // 但即便空列表也要走一遍，用于清掉上一轮留下的待装载状态。
  if (list.length) ensureShotThumbs(list);

  return `<div class="page">
    ${toolsBackBar()}
    <div class="page-head">
      <div>
        <div class="eyebrow">${PAGE_META.screenshots.eyebrow}</div>
        <h1>截图管理</h1>
        <p class="page-desc">各游戏的截图统一浏览，按游戏分组、按时间倒序。</p>
      </div>
      <button class="btn ghost" data-action="shots-refresh">${icon('refresh', 'xs')}重新扫描</button>
    </div>
      ${body}
    </div>`;
}

/* ------------------------------ 插件（.hxl） ------------------------------ */

/*
 * 插件页的三个角色分得很清楚：
 *
 * - 主进程（electron/plugin-host.js）只管文件：列出、读出源码、导入、删除、存配置。
 * - window.HXLPlugin.Render 只管把插件给的视图数据变成 HTML，它是纯函数。
 * - window.HXLPlugin.Host 管 Worker：读源码 → 加沙箱前置代码 → 跑起来 → 仲裁权限。
 *
 * 这一层只做界面：拉列表、画卡片、把 Host 的状态记进 state 供重绘使用。
 * 插件是用户手写的第三方代码，凡是它给的字符串都必须经 esc() 再进 DOM。
 */

/** 权限中文说明。要和 electron/plugin-host.js 的 PERMISSIONS 一一对应。 */
const PLUGIN_PERMISSION_TEXT = {
  ui: { label: '显示面板', desc: '把自己的内容画在插件页上' },
  notify: { label: '弹出提示', desc: '在启动器右下角弹消息' },
  state: { label: '读取启动器状态', desc: '只读游戏名、游玩时长、抽卡记录条数，拿不到账号和文件路径' },
  storage: { label: '保存自己的配置', desc: '读写本插件自己的一份配置，上限 128 KB' },
};

/** 插件图标对应到 svg sprite 里的名字；插件写了个不认识的就回落到拼图块。 */
const PLUGIN_ICON_MAP = {
  sparkle: 'sparkle',
  star: 'star',
  clock: 'clock',
  gamepad: 'gamepad',
  chart: 'star',
  list: 'type',
  database: 'database',
  music: 'music',
  news: 'news',
  image: 'image',
  shield: 'shield',
  wrench: 'wrench',
  play: 'play',
  folder: 'folder',
  bolt: 'sparkle',
};

function pluginRuntime() {
  return window.HXLPlugin && window.HXLPlugin.Host ? window.HXLPlugin : null;
}

/** 插件列表里挑一个能用的 id：优先上次看的，否则第一个没坏的。 */
function pickPluginId() {
  const list = state.plugins.list?.plugins || [];
  const usable = list.filter((plugin) => !plugin.error);
  const wanted = state.plugins.active;
  if (wanted && usable.some((plugin) => plugin.id === wanted)) return wanted;
  return usable[0]?.id || '';
}

function pluginById(id) {
  return (state.plugins.list?.plugins || []).find((plugin) => plugin.id === id) || null;
}

/**
 * 把一个插件跑起来。
 *
 * 权限要先塞进 Host（它拿不到 list() 的结果），再 start()。
 * 失败只记错误，不抛 —— 一个坏插件不能让整页白掉。
 */
async function startPlugin(plugin) {
  const runtime = pluginRuntime();
  if (!runtime) {
    state.plugins.errors[plugin.id] = '插件运行时没有加载（plugin-runtime.js 缺失）';
    return false;
  }
  runtime.Host.setPermissions(plugin.id, plugin.permissions || []);
  let result;
  try {
    result = await runtime.Host.start(plugin.id);
  } catch (error) {
    result = { ok: false, error: humanError(error) || '插件启动失败' };
  }
  if (!result || result.ok === false) {
    state.plugins.errors[plugin.id] = result?.error || '插件启动失败';
    return false;
  }
  state.plugins.running[plugin.id] = true;
  return true;
}

/** 把 Host 的两个回调接到 state 上：插件更新了视图 / 插件出错了，都要重绘。 */
function wirePluginHost() {
  const runtime = pluginRuntime();
  if (!runtime || runtime.Host.__hxlWired) return;
  runtime.Host.__hxlWired = true;
  runtime.Host.attach({
    // Host 只读这里面的白名单字段，账号、路径、设置项都不会传出去
    state: () => state,
    notify: (pluginId, message) => {
      const plugin = pluginById(pluginId);
      toast(`${plugin?.name || '插件'}：${message}`, 'info');
    },
  });
  runtime.Host.onUpdate((pluginId, view) => {
    if (view) state.plugins.views[pluginId] = view;
    else delete state.plugins.views[pluginId];
    if (state.route === 'plugins') render({ preserveScroll: true });
  });
  runtime.Host.onError((pluginId, message) => {
    state.plugins.errors[pluginId] = String(message || '插件出错了');
    if (state.route === 'plugins') render({ preserveScroll: true });
  });
}

/** 读插件列表。force 为真时强制重读（「刷新」按钮）。 */
async function loadPlugins(force = false) {
  if (state.plugins.loading && !force) return state.plugins.list;
  const api = window.launcher?.plugins;
  if (!api || typeof api.list !== 'function') {
    state.plugins.error = '当前版本没有插件接口，请更新启动器';
    state.plugins.list = { plugins: [] };
    if (state.route === 'plugins') render({ preserveScroll: true });
    return null;
  }

  state.plugins.loading = true;
  if (force) state.plugins.error = '';
  if (state.route === 'plugins') render({ preserveScroll: true });

  try {
    const result = await api.list();
    if (!result || result.ok === false) throw new Error(result?.error || '读取插件列表失败');
    state.plugins.list = { dir: result.dir || '', plugins: Array.isArray(result.plugins) ? result.plugins : [] };
    state.plugins.error = '';
    wirePluginHost();
    // 坏掉的插件没有 id 或有 error，直接跳过；其余的按需启动
    const runtime = pluginRuntime();
    if (runtime) runtime.Host.reconcile(state.plugins.list.plugins.filter((p) => !p.error).map((p) => p.id));
    state.plugins.active = pickPluginId();
  } catch (error) {
    state.plugins.error = humanError(error) || '读取插件列表失败';
    state.plugins.list = { dir: '', plugins: [] };
  } finally {
    state.plugins.loading = false;
  }

  // 列表到手后把当前插件跑起来，视图会通过 onUpdate 回来
  const activePlugin = pluginById(state.plugins.active);
  if (activePlugin && !state.plugins.running[activePlugin.id] && state.route === 'plugins') {
    await startPlugin(activePlugin);
  }
  if (state.route === 'plugins') render({ preserveScroll: true });
  return state.plugins.list;
}

function stopAllPlugins() {
  const runtime = pluginRuntime();
  if (runtime) runtime.Host.stopAll();
  state.plugins.running = {};
  state.plugins.views = {};
}

/** 插件空状态里的示例代码。用 <pre> 显示，要经 esc() 转义。 */
const PLUGIN_SAMPLE_SOURCE = `/* @hxl
{
  "id": "com.example.hello",
  "name": "你好插件",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "一个最小的示例插件",
  "icon": "sparkle",
  "permissions": ["ui", "state"]
}
*/

// ---- 清单必须写在 /* @hxl ... */ 注释块里，JS 直接跟在后面，同一个文件 ----
hxl.ready(async function (api) {
  const data = await api.state.get();
  await api.render('list', {
    title: '本机游戏',
    items: data.games.map(function (game) {
      return {
        title: game.name,
        desc: '已玩 ' + Math.round(game.playSeconds / 60) + ' 分钟',
        value: game.id,
      };
    }),
  });
});`;

/** 单个插件卡片。坏掉的插件走红条 + 删除，不显示权限和按钮。 */
function pluginCardMarkup(plugin) {
  const broken = Boolean(plugin.error);
  const selected = plugin.id === state.plugins.active && !broken;
  if (broken) {
    return `<div class="plugin-card is-broken">
      <div class="plugin-card-main">
        <div class="plugin-broken-title">${icon('alert', 'xs')}已损坏</div>
        <div class="plugin-broken-file">${esc(plugin.file || '未知文件')}</div>
        <p class="plugin-broken-why">${esc(plugin.error)}</p>
      </div>
      <button class="btn ghost plugin-broken-remove" data-action="plugin-remove" data-file="${esc(plugin.file || '')}" data-id="${esc(plugin.id || '')}">
        ${icon('trash', 'xs')}删除
      </button>
    </div>`;
  }

  const running = Boolean(state.plugins.running[plugin.id]);
  const failed = Boolean(state.plugins.errors[plugin.id]);
  const statusText = failed ? '运行出错' : running ? '运行中' : '未运行';
  const statusClass = failed ? 'bad' : running ? 'ok' : '';
  const iconName = PLUGIN_ICON_MAP[String(plugin.icon || '').toLowerCase()] || 'grip';
  const chips = (plugin.permissions || [])
    .map((name) => {
      const meta = PLUGIN_PERMISSION_TEXT[name];
      return meta ? `<span class="plugin-chip" title="${esc(meta.desc)}">${esc(meta.label)}</span>` : '';
    })
    .join('');

  return `<button class="plugin-card${selected ? ' is-active' : ''}" data-action="plugin-select" data-id="${esc(plugin.id)}">
    <div class="plugin-card-top">
      <span class="plugin-icon">${icon(iconName)}</span>
      <div class="plugin-card-id">
        <div class="plugin-card-name">${esc(plugin.name || plugin.id)}</div>
        <div class="plugin-card-meta">v${esc(plugin.version || '0.0.0')}${plugin.author ? ` · ${esc(plugin.author)}` : ''}</div>
      </div>
      <span class="plugin-status${statusClass ? ` is-${statusClass}` : ''}"><i></i>${esc(statusText)}</span>
    </div>
    ${plugin.desc ? `<p class="plugin-card-desc">${esc(plugin.desc)}</p>` : ''}
    <div class="plugin-card-foot">
      ${chips || '<span class="plugin-chip is-plain">没有申请权限</span>'}
      <span class="plugin-size">${esc(formatBytes(plugin.size || 0))}</span>
    </div>
  </button>`;
}

/** 右侧面板：当前插件的视图（已经在 Host 里渲染成 HTML 了）。 */
function pluginPanelMarkup(plugin) {
  if (!plugin) {
    return `<div class="plugin-panel-empty">
      ${icon('grip')}
      <p>从左边选一个插件</p>
    </div>`;
  }
  const error = state.plugins.errors[plugin.id];
  const view = state.plugins.views[plugin.id];
  const head = `<div class="plugin-panel-head">
    <div>
      <div class="plugin-panel-name">${esc(plugin.name || plugin.id)}</div>
      <div class="plugin-panel-meta">${esc(plugin.file || plugin.id)} · 权限 ${(plugin.permissions || []).length} 项</div>
    </div>
    <button class="btn ghost" data-action="plugin-reload" data-id="${esc(plugin.id)}">${icon('refresh', 'xs')}重新运行</button>
  </div>`;

  let body = '';
  if (error) {
    body = `<div class="plugin-error">${icon('alert', 'xs')}<div><strong>插件运行出错</strong><p>${esc(error)}</p></div></div>`;
  }
  if (view && view.html) {
    // view.html 由 HXLPlugin.Render 生成，里面所有插件内容都已转义
    body += `<div class="plugin-view-host">${view.html}</div>`;
  } else if (!error) {
    body += `<div class="plugin-panel-empty">${icon('refresh')}<p>插件正在运行，还没有输出内容</p></div>`;
  }
  return `<div class="plugin-panel">${head}${body}</div>`;
}

function pluginsView() {
  const meta = PAGE_META.plugins;
  const plugins = state.plugins.list?.plugins || [];
  const broken = plugins.filter((plugin) => plugin.error);
  const good = plugins.filter((plugin) => !plugin.error);

  let listBody = '';
  if (state.plugins.error) {
    listBody = `<div class="tools-empty">${icon('alert')}<strong>${esc(state.plugins.error)}</strong><p>插件目录可能被占用或没有权限。</p></div>`;
  } else if (!state.plugins.list) {
    listBody = `<div class="plugin-loading">${icon('refresh')}<span>正在读取插件目录…</span></div>`;
  } else if (!plugins.length) {
    listBody = `<div class="plugin-guide">
      ${icon('grip')}
      <h2>还没有安装任何插件</h2>
      <p>插件是单个 <code>.hxl</code> 文件，前半段是 JSON 清单，后半段是 JavaScript。
         它在隔离的 Worker 里运行，读不到你的文件，也上不了网，只能调用启动器开放的接口。</p>
      <p>把下面这段存成 <code>hello.hxl</code>，然后点右上角「导入插件」。</p>
      <pre class="plugin-code">${esc(PLUGIN_SAMPLE_SOURCE)}</pre>
      <button class="btn btn-primary" data-action="plugin-import">${icon('plus', 'xs')}导入插件</button>
    </div>`;
  } else {
    listBody = good.map(pluginCardMarkup).join('');
    if (broken.length) {
      listBody += `<div class="plugin-broken-group-title">已损坏（${broken.length}）</div>`;
      listBody += broken.map(pluginCardMarkup).join('');
    }
  }

  const active = pluginById(pickPluginId());
  return `<div class="page page-plugins">
    <div class="page-head">
      <div>
        <div class="eyebrow">${esc(meta.eyebrow)}</div>
        <h1>插件</h1>
        <p class="page-desc">插件是单个 .hxl 文件，在隔离的 Worker 里运行，只能调用启动器提供的接口。</p>
      </div>
      <div class="plugin-actions">
        <button class="btn btn-primary" data-action="plugin-import">${icon('plus', 'xs')}导入插件</button>
        <button class="btn ghost" data-action="plugin-open-dir">${icon('folder', 'xs')}打开插件目录</button>
        <button class="btn ghost" data-action="plugin-refresh">${icon('refresh', 'xs')}刷新</button>
        <button class="btn ghost" data-action="plugin-doc" title="打开插件开发说明">${icon('info', 'xs')}开发说明</button>
      </div>
    </div>
    <div class="plugin-layout">
      <div class="plugin-list">
        ${state.plugins.loading && state.plugins.list ? `<div class="plugin-loading">${icon('refresh')}<span>刷新中…</span></div>` : ''}
        ${listBody}
      </div>
      ${plugins.length ? `<div class="plugin-detail">${pluginPanelMarkup(active)}</div>` : ''}
    </div>
    ${state.plugins.list?.dir ? `<p class="plugin-dir-note">插件目录：${esc(state.plugins.list.dir)}</p>` : ''}
  </div>`;
}

/** 导入后的权限确认。用户点「确认安装」才真正跑起来，取消就把刚落盘的文件删掉。 */
function openPluginPermissionDialog(plugin) {
  const permissions = Array.isArray(plugin.permissions) ? plugin.permissions : [];
  const rows = permissions.length
    ? permissions
        .map((name) => {
          const meta = PLUGIN_PERMISSION_TEXT[name];
          return `<li class="plugin-perm-row">
            <span class="plugin-perm-name">${esc(meta?.label || name)}</span>
            <span class="plugin-perm-desc">${esc(meta?.desc || '未识别的权限，插件将无法使用它')}</span>
          </li>`;
        })
        .join('')
    : '<li class="plugin-perm-row"><span class="plugin-perm-name">没有申请任何权限</span><span class="plugin-perm-desc">它什么都做不了，只会显示一段固定的内容</span></li>';

  openModal(`<div class="modal-backdrop" data-backdrop>
    <div class="modal narrow" role="alertdialog" aria-modal="true">
      <div class="modal-head">
        <div><h2>安装「${esc(plugin.name || plugin.id)}」？</h2></div>
        <button class="modal-close" data-close title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <p class="confirm-copy">这个插件要申请下面这些能力。确认后它会在一个隔离的 Worker 里运行，读不到你的文件和密码，也连不上网。</p>
        <ul class="plugin-perm-list">${rows}</ul>
        ${plugin.file ? `<p class="plugin-perm-file">文件：${esc(plugin.file)}</p>` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-action="plugin-cancel-install">取消并撤销</button>
        <button class="btn btn-primary" data-action="plugin-confirm-install">确认安装</button>
      </div>
    </div>
  </div>`, {
    onBackdrop: () => handleAction('plugin-cancel-install', undefined, modalPlaceholder),
  });
}


/* ------------------------------ 画质配置 ------------------------------ */

/**
 * 画质页里「一个游戏」的统一描述。
 *
 * gameKey 是 gameFeatures 的 key（genshin/starrail/zzz/bh3/endfield/neverness/arknights，
 * 以后新加的内置游戏也在这里）；state.games 里的一条游戏靠 builtinKey 对到它上面，
 * **不是** id（id 是 `builtin-genshin` 这种，自定义游戏则是 uuid）。
 *
 * 自定义游戏（手动添加的那种）没有 builtinKey，仍然给它一个 key：
 * 用 `custom:<id>`，主进程 normalizeKey 认不出来就当未知游戏，走自动探测。
 */
function graphicsGameOf(entry) {
  if (!entry) return null;
  const key = entry.builtinKey || entry.gameKey || `custom:${entry.id || entry.name || ''}`;
  return {
    gameKey: key,
    name: entry.name || shotGameLabel(entry.builtinKey) || key,
    // target 是启动器里配的可执行文件 / 安装目录；servers 里第一条可用的也行
    path: entry.target || (Array.isArray(entry.servers) && entry.servers[0] && entry.servers[0].path) || '',
    exe: entry.exe || '',
    installed: entry.installed !== false,
  };
}

/** 按 gameKey 找到 state.games 里对应的游戏；找不到就退化成「只知道 key」。 */
function graphicsGameEntry(gameKey) {
  const key = String(gameKey || '');
  const games = Array.isArray(state.games) ? state.games : [];
  const hit = games.find((game) => game.builtinKey === key) || games.find((game) => game.id === key);
  if (hit) return graphicsGameOf(hit);
  return { gameKey: key, name: shotGameLabel(key), path: '', exe: '', installed: false };
}

/**
 * 画质页顶部能选哪些游戏。
 *
 * 规则与主进程一致：
 *   1. game-features 里带 graphics trait 的（四个米哈游游戏）—— 一定能读；
 *   2. 启动器里装了、且有可执行路径的其它游戏 —— 交给主进程自动探测注册表项。
 * 探测不到的只在页面上显示一句原因，不报错，也不会写坏别的东西。
 * 以后 game-features 新加游戏（哪怕没写 graphics trait），这里自动就带出来了，
 * 不需要再回来改这行代码。
 */
function graphicsGames() {
  const list = [];
  const seen = new Set();
  const push = (gameKey, name, path = '', installed = false) => {
    const key = String(gameKey || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push({ gameKey: key, name: name || shotGameLabel(key), path, exe: '', installed });
  };

  const known = Array.isArray(state.games) ? state.games : [];
  const matrix = state.features?.matrix || null;
  const graphicsCapable = (key) => (Array.isArray(matrix?.[key]) ? matrix[key].includes('graphics') : false);

  // 先放 trait 里明确支持画质的（顺序跟 game-features 的登记顺序）
  const featureKeys = Object.keys(matrix || {});
  for (const key of featureKeys) {
    if (!graphicsCapable(key)) continue;
    const entry = known.find((game) => game.builtinKey === key);
    push(key, entry?.name || shotGameLabel(key), entry?.target || '', Boolean(entry?.installed));
  }
  // 没有 trait 的：只有装好了才可能探测到，没装就不给空标签
  for (const entry of known) {
    const game = graphicsGameOf(entry);
    if (!game) continue;
    if (graphicsCapable(game.gameKey)) continue;
    if (!entry.builtinKey) {
      // 自定义游戏：装了就给个标签，靠路径去探测
      if (game.installed && game.path) push(game.gameKey, game.name, game.path, true);
      continue;
    }
    if (game.installed && game.path) push(game.gameKey, game.name, game.path, true);
  }
  // 一个也没有时至少保证页面上有个标签，不至于空白
  if (!list.length) push('starrail', shotGameLabel('starrail'));
  return list;
}

/**
 * 画质页的数据缓存，按 gameKey 存。
 *
 * 用户的原话是「终末读取配置时间过长，第一次读取完成后如果没有变动就不二次读取了」。
 * 一次自动探测 + 读值实测 1.2~3.3 秒，前端以前每次进画质页都重新 IPC，用户来回点
 * 两下标签就要重新等一遍。现在分两层：
 *
 *   1. 本次会话里已经读成功过、并且没被写过（dirty=false）→ 直接复用，连 IPC 都不发；
 *   2. 有旧数据但已经过期（超过 GRAPHICS_CACHE_TTL）→ 先把旧数据画出来，后台再读一遍，
 *      回来之后静默替换 —— 前台不闪、不转圈、不丢滚动位置。
 *
 * 用户点「重新读取」时走 loadGraphics(key, { force: true })：显式刷新，绕过缓存。
 */
const GRAPHICS_CACHE_TTL = 10 * 60 * 1000;
/** 刚进来就判定「不用再读过」的时长：短，但足够吃掉同一屏幕内的重复触发。 */
const GRAPHICS_CACHE_FRESH = 60 * 1000;
/** 后台刷新的去重表：同一个 gameKey 同时只有一个后台请求在飞。 */
const graphicsRefreshing = new Set();
/** 已经排进「延迟刷新」队列的游戏，避免排队期间被反复排。 */
const graphicsPendingRefresh = new Set();
/** 后台核对的延时：先让用户点击后的首帧画完，再去打主进程（同步读注册表，很重）。 */
const GRAPHICS_REFRESH_IDLE_DELAY = 800;

/** 缓存里的一条，没有就是 undefined。 */
function graphicsCacheEntry(gameKey) {
  const key = gameKey || '';
  if (!key) return null;
  return (state.graphicsCache && state.graphicsCache[key]) || null;
}

/** 缓存里的结果能不能直接显示：读过、没报错、也没被写入弄脏。 */
function graphicsCacheFresh(entry, maxAge) {
  if (!entry || !entry.result || entry.result.ok === false) return false;
  if (entry.dirty) return false;
  return Date.now() - (Number(entry.at) || 0) < maxAge;
}

/**
 * 结果有没有变化。只比内容，不比取回来的时间：主进程每次都会带新的 timestamp，
 * 拿整串 JSON 去比会永远「不相等」，页面上就等于每次都在重画。
 */
function graphicsResultSignature(result) {
  if (!result) return '';
  try {
    return JSON.stringify({
      ok: result.ok,
      source: result.source,
      detectKey: result.detectKey,
      reason: result.reason,
      key: result.key,
      fields: result.fields,
    });
  } catch {
    return String(Date.now());
  }
}

/** 把一份读回来的结果写进缓存（成功才留，失败不留）。 */
function rememberGraphics(gameKey, result) {
  if (!gameKey || !state.graphicsCache) return;
  if (result && result.ok !== false) {
    state.graphicsCache[gameKey] = { at: Date.now(), result, dirty: false };
    return;
  }
  // 读失败 / 探测失败的结论不缓存：下次进来要能重新试一次
  delete state.graphicsCache[gameKey];
}

/**
 * 把一份结果套到 state 上。当前看的是别的游戏时什么都不做 ——
 * 后台刷新回来晚了不能把用户正在看的页面换掉。
 */
function applyGraphicsResult(gameKey, result) {
  if (state.graphicsGame !== gameKey) return false;
  if (result && result.ok !== false) {
    state.graphics = result;
    state.graphicsError = '';
  } else {
    state.graphics = null;
    state.graphicsError = (result && result.reason) || '读取失败';
  }
  state.graphicsSource = (result && result.source) || '';
  state.graphicsDetectKey = (result && result.detectKey) || '';
  return true;
}

/**
 * 静默读一次：只负责把结果读回来写进缓存（顺带更新 state），
 * 不置 loading、不弹提示、也不自己 render —— 是否重画由调用方决定。
 */
async function loadGraphicsSilently(gameKey, force = false) {
  const key = gameKey || '';
  if (!key || !window.launcher?.graphics?.read) return state.graphics;
  try {
    const game = graphicsGameEntry(key);
    const result = await window.launcher.graphics.read({
      gameKey: game.gameKey,
      name: game.name,
      path: game.path,
      exe: game.exe,
      force: Boolean(force),
    });
    if (!result || result.ok === false) return null;
    rememberGraphics(key, result);
    if (state.graphicsGame === key) applyGraphicsResult(key, result);
    return result;
  } catch {
    // 静默模式吞掉异常，界面保持原样
    return null;
  }
}

/**
 * 后台读一遍并静默替换。全程不置 loading、不弹提示；
 * 内容和缓存里完全一样就直接跳过 render（避免无意义的 DOM 重建把滚动位置弄丢）。
 *
 * 另外两个「不添乱」的保证：
 *   1. 读回来时如果用户已经切到别的游戏，loadGraphicsSilently 里
 *      `state.graphicsGame === key` 和这里的 applyGraphicsResult / route 判断
 *      会拦住，绝不会把别的游戏的卡片摆到当前屏幕上；
 *   2. 内容没变就完全不 render，滚动位置和输入框焦点都不动。
 */
/**
 * 开机把画质配置拉进前端缓存。
 *
 * 主进程那边窗口建好后会串行预读（primeGraphicsCache），这里只是把结果取回来
 * 塞进 state.graphicsCache，这样点进画质页走的是「命中新鲜缓存」分支：
 *   - 不发 IPC、不置 loading、不闪「正在读取注册表」，首帧直接是数据。
 *
 * 顺序有讲究：先读用户上次停在的那款（或者启动页正显示的），再读其它。
 * 用 silent 方式读，绝不打断当前页面；哪个游戏失败就跳过，点进去时会自己重试。
 */
async function primeGraphicsFrontend() {
  const order = [];
  if (state.graphicsGame) order.push(state.graphicsGame);
  for (const item of graphicsGames()) {
    if (item && item.gameKey && !order.includes(item.gameKey)) order.push(item.gameKey);
  }
  for (const gameKey of order) {
    try {
      // 已经有新鲜缓存就别重复读
      const entry = graphicsCacheEntry(gameKey);
      if (entry && Date.now() - (Number(entry.at) || 0) < GRAPHICS_CACHE_TTL) continue;
      const result = await loadGraphicsSilently(gameKey, false);
      if (!result || result.ok === false) continue;
      // 不重画：此时用户多半停在别的页面，数据进缓存就够
      state.graphicsCache[gameKey] = { at: Date.now(), result, dirty: false };
    } catch {
      // 预读失败无所谓
    }
  }
}


function refreshGraphicsInBackground(gameKey, force) {
  const key = gameKey || '';
  if (!key || graphicsRefreshing.has(key)) return null;
  graphicsRefreshing.add(key);
  const task = (async () => {
    try {
      const before = graphicsResultSignature((graphicsCacheEntry(key) || {}).result);
      const result = await loadGraphicsSilently(key, force);
      if (!result) return null;
      if (before === graphicsResultSignature(result)) return result;
      if (!applyGraphicsResult(key, result)) return result;
      if (state.route === 'graphics') render({ preserveScroll: true });
      return result;
    } finally {
      graphicsRefreshing.delete(key);
    }
  })();
  return task;
}

/**
 * 把「确实需要刷新」的后台核对推迟到用户点完这一下之后再做。
 *
 * 主进程读注册表是同步阻塞的（execFileSync 调 reg.exe），原神实测约 0.4 秒、
 * 终末地约 1.5 秒，这期间主进程被占住，紧接着的下一次交互要排在它后面。
 * 所以缓存命中时绝不「顺手」就发一次 IPC，而是：
 *
 *   - 立刻把 deferred 标记挂上，让同一款游戏在等待期内不会被重复排队；
 *   - 用 requestIdleCallback（没有就退回 setTimeout）把真正的读放到
 *     浏览器空闲 / 短暂延时之后，保证点击后的首帧先画出来；
 *   - 用户在这期间切走了也没关系：结果回来时 applyGraphicsResult 的
 *     `state.graphicsGame !== gameKey` 守卫会丢掉它，界面不会被换掉。
 */
function scheduleGraphicsRefresh(gameKey, force) {
  const key = gameKey || '';
  if (!key || graphicsRefreshing.has(key) || graphicsPendingRefresh.has(key)) return null;
  graphicsPendingRefresh.add(key);

  const run = () => {
    graphicsPendingRefresh.delete(key);
    // 排队期间用户已经切走：这次核对没必要做了，等下次真的切回来再说
    if (state.graphicsGame !== key) return null;
    const entry = graphicsCacheEntry(key);
    if (!entry || !force) {
      // 非强制刷新时再确认一次「确实过期了」，避免排队期间已经被别处刷新过
      const age = Date.now() - (Number((entry || {}).at) || 0);
      if (entry && !entry.dirty && age < GRAPHICS_CACHE_TTL) return null;
    }
    return refreshGraphicsInBackground(key, force);
  };

  // 延迟优先级：能等浏览器空闲就等空闲，等不到最多 GRAPHICS_REFRESH_IDLE_DELAY
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => run(), { timeout: GRAPHICS_REFRESH_IDLE_DELAY * 2 });
  } else {
    setTimeout(run, GRAPHICS_REFRESH_IDLE_DELAY);
  }
  return null;
}

/** 页面框架已经画出来了吗：拿到 #view 容器说明启动流程走过 render 了。 */
function graphicsPagePainted() {
  return Boolean(dom.view && dom.view.isConnected);
}

/**
 * 读画质。options：
 *   force   —— 用户点了「重新读取」，绕过缓存、显示 loading、主进程也重新探测
 *   silent  —— 内部用：只更新缓存 / 数据，绝不置 loading、不做任何前台切换
 *
 * 三个分支：
 *   命中新鲜缓存 → 什么都不发，直接返回；
 *   命中旧缓存   → 先把旧数据摆上去（不置 loading），后台静默刷新；
 *   没有缓存     → 走原来的流程：置 loading、渲染「正在读取注册表」、读到后渲染。
 */
async function loadGraphics(gameKey, options = {}) {
  const { force = false, silent = false } = options || {};
  const key = gameKey || state.graphicsGame || 'starrail';
  // 用户切了标签：上一个游戏的读取结果不要再套到当前页面上
  const switched = state.graphicsGame !== key;
  state.graphicsGame = key;

  const entry = graphicsCacheEntry(key);

  if (silent) {
    // 静默模式只负责把数据读回来，界面由调用方决定要不要重画
    return loadGraphicsSilently(key, Boolean(force));
  }

  if (!force && entry) {
    /*
     * 有缓存：先把旧数据直接画出来，前台不转圈。
     * 只有「用户刚切到这个游戏」时才需要重画一次；同一屏内的重复调用什么也不用做。
     */
    const age = Date.now() - (Number(entry.at) || 0);
    const stale = entry.dirty || !(age < GRAPHICS_CACHE_TTL);
    /*
     * 上一次摆到画质页上的不是这款游戏（含页面重载后 oldGraphicsGame 已重置）：
     * 把缓存里的这份结果套上去并重画一次，让卡片换成这款游戏的。
     *
     * 注意这里**不能 early return**：以前这里在画完之后直接 return，后面的
     * 「新鲜度判断 / 后台刷新」永远走不到，于是缓存既不会被复用也不会被刷新；
     * 又因为每次切换都会走到这条分支以外的路径去重读注册表，rememberGraphics
     * 把 at 重置成当前时间，缓存看起来「每次都失效」。画完继续往下走，
     * 让新鲜度判断决定要不要静默刷新（不 await）。
     */
    if (oldGraphicsGame !== key) {
      oldGraphicsGame = key;
      /*
       * 刚打开画质页 / 刚切到这个游戏：画质页原来可能显示的是别的游戏，
       * 先把缓存内容摆上去再重画一次，避免「数据换了但界面没动」。
       * 这里不置 loading，所以不会闪「正在读取注册表」。
       *
       * 判断依据只能是「页面真的画出来了没有」：以前这里用的是
       * state.hasRenderedPage，而那个字段整个 app.js 里**从来没有任何地方赋值**，
       * 永远是 undefined —— 于是这条分支永远走 else，只 loadGraphicsSilently
       * 就 return：既不重画（卡片停在上一款游戏），又因为 return 得早，
       * 后面的新鲜度判断永远走不到，缓存也就永远不复用。
       */
      applyGraphicsResult(key, entry.result);
      state.graphicsLoading = false;
      if (graphicsPagePainted()) {
        if (state.route === 'graphics') render({ preserveScroll: true });
      } else {
        // 页面还没画出来（启动直接落到画质页）：先把内容备好再让首屏渲染
        return loadGraphicsSilently(key, stale);
      }
    } else if (switched) {
      applyGraphicsResult(key, entry.result);
      state.graphicsLoading = false;
    }
    /*
     * 新鲜度判断（注意：走到这里说明上面没 return，缓存一定被评估过）：
     *
     *   < GRAPHICS_CACHE_FRESH（60 秒）        → 直接复用，连 IPC 都不发；
     *   60 秒 ~ GRAPHICS_CACHE_TTL（10 分钟）  → **也直接复用**，不打任何 IPC。
     *     以前这里会「后台悄悄核对一遍」，结果几乎每切一次都在后台打一次注册表
     *     （主进程同步 reg.exe，原神 0.4 秒 / 终末地 1.5 秒），把下一次交互挤慢。
     *     画质设置本来就是「用户改了才会变」的东西，10 分钟内没有理由怀疑它变了。
     *   > TTL 或者 dirty（写入过）           → 先把旧数据留在屏幕上，
     *     再延时到浏览器空闲时后台重读一遍，await 不等它。
     */
    if (graphicsCacheFresh(entry, GRAPHICS_CACHE_FRESH)) return entry.result;
    if (graphicsCacheFresh(entry, GRAPHICS_CACHE_TTL)) return entry.result;
    // 记录太旧（或者被写入弄脏了）：后台重读一遍，前台继续显示旧数据
    scheduleGraphicsRefresh(key, true);
    return entry.result;
  }

  /*
   * 用户强制刷新（「重新读取」）。
   *
   * 已经有这一屏的数据时也要**先把它留在屏幕上**、且不置 loading：
   * 写入画质项之后 handleAction 的 finally 就是走这条路重读来拿新值，
   * 以前这里会先把 state.graphics 清空、置 loading 再 await，
   * 页面上就是一整屏「正在读取注册表」的转圈，读回来才重画。
   * 现在画面保持不动，结果回来再一次性重画（真没变就连重画都省了）。
   */
  if (force && entry && graphicsPagePainted()) {
    const before = graphicsResultSignature(entry.result);
    oldGraphicsGame = key;
    const result = await loadGraphicsSilently(key, true);
    // 写坏了 / 读失败：缓存里那份已经没了，按真实结果显示，别硬留着旧值
    if (!result && !graphicsCacheEntry(key)) applyGraphicsResult(key, null);
    if (state.route === 'graphics' && before !== graphicsResultSignature((graphicsCacheEntry(key) || {}).result)) {
      render({ preserveScroll: true });
    }
    return (graphicsCacheEntry(key) || {}).result || result || state.graphics;
  }

  // 没有缓存（或用户强制刷新）：走原来的「先转圈再出结果」流程
  oldGraphicsGame = key;
  state.graphics = null;
  state.graphicsError = '';
  state.graphicsSource = '';
  state.graphicsDetectKey = '';
  state.graphicsLoading = true;
  render({ preserveScroll: true });
  try {
    if (!window.launcher?.graphics?.read) throw new Error('当前版本不支持读取画质配置');
    // 新入参：把整个游戏对象传给主进程，trait 里没写注册表项的游戏靠它自动探测
    const game = graphicsGameEntry(key);
    const result = await window.launcher.graphics.read({
      gameKey: game.gameKey,
      name: game.name,
      path: game.path,
      exe: game.exe,
      force: Boolean(force),
    });
    rememberGraphics(key, result);
    // 探测失败不是异常：主进程会带着 reason 回来，这里照样把它显示在页面里，
    // 不抛错（抛错会让整个画质页变成一条红色错误）
    if (result && result.ok === false) {
      state.graphics = null;
      state.graphicsError = result.reason || '读取失败';
      state.graphicsDetectKey = result.detectKey || '';
      return null;
    }
    state.graphics = result;
    state.graphicsSource = result?.source || '';
    state.graphicsDetectKey = result?.detectKey || '';
  } catch (error) {
    state.graphics = null;
    state.graphicsError = humanError(error) || '读取画质配置失败';
    state.graphicsDetectKey = '';
  } finally {
    state.graphicsLoading = false;
    if (state.route === 'graphics') render({ preserveScroll: true });
  }
  return state.graphics;
}

/** 上一次真正摆到画质页上的是哪款游戏（用来判断「切标签」还是「同屏重复调用」）。 */
let oldGraphicsGame = '';


/* 旧版在这里做过滤（graphicsEntries）。现在主进程读注册表时就只取画质相关的键，
   并把键名翻译成中文（electron/graphics-schema.js），前端不再重复判断。 */

/**
 * 星铁帧率：画质页唯一一处会**写**注册表的地方。
 *
 * 帧率本身也是写在 `GraphicsSettings_Model_*` 里的一个字段（`FPS`），
 * 所以它天然属于画质页，放在设置页里反而要用户两头跑。
 * 其它游戏的画质仍然只读，避免把游戏配置写坏。
 *
 * 主进程写帧率时会顺带把画质档位改成「自定义」——星铁的 FPS 只在自定义档位下生效。
 */
function starrailFpsCard() {
  if (state.graphicsGame !== 'starrail') return '';
  const current = Number(state.starrailFps) || 60;
  return `
    <article class="gfx-card gfx-card-writable">
      <header>
        <strong>星穹铁道帧率</strong>
        <em>这一项可以改</em>
      </header>
      <ul>
        <li class="gfx-row">
          <span class="gfx-label">当前帧率上限</span>
          <span class="gfx-value">${current} FPS</span>
          <span class="gfx-range">30 / 60 / 120</span>
        </li>
      </ul>
      <div class="gfx-actions">
        <div class="segmented">
          ${[30, 60, 120]
            .map(
              (fps) =>
                `<button class="${current === fps ? 'active' : ''}" data-action="set-starrail-fps" data-value="${fps}">${fps} FPS</button>`
            )
            .join('')}
        </div>
        <p class="gfx-hint">
          改 120 前请先退出游戏。写入会把游戏内的画质预设改成「自定义」，其余画质项保持原样。
        </p>
      </div>
    </article>`;
}

/**
 * 一项设置的可选档位 → 下拉项。
 *
 * 三个来源按优先级取：
 *   options —— 预设枚举（0-4 的质量档、30/60/120 帧率、OFF/Low/High…）
 *   choices —— 数值类字段的候选（分辨率给常见分辨率，其它给 min..max）
 *   都没有 —— 不提供下拉，只有数字输入框
 */
function gfxOptionsOf(field) {
  if (Array.isArray(field.options) && field.options.length) {
    return field.options.map((value, index) => ({
      value,
      label: gfxOptionLabel(field, value, index),
    }));
  }
  if (Array.isArray(field.choices) && field.choices.length) {
    /*
     * 候选值太多就不做下拉。
     *
     * 主进程给数值字段的 choices 是 `min..max 每 1 取一个`，终末地的四个分辨率字段
     * schema 里没写 min/max，于是这里是 640..7680、360..4320，一个字段就能生成
     * 7041 个 <option>：整页 HTML 83 万字符、2.2 万个 DOM 节点，
     * 光布局就要 230ms，切到终末地必然卡。这种「连续区间」本来就不该做成下拉，
     * 下面 gfxControl 会退回数字输入框（本来就能手填，功能一点没少）。
     */
    if (field.choices.length <= GFX_SELECT_MAX_OPTIONS) {
      return field.choices.map((value) => ({
        value,
        label: field.unit ? `${value} ${field.unit}` : String(value),
      }));
    }
  }
  return [];
}

/**
 * 一个数值字段最多给多少个下拉档位。
 *
 * 超过这个数就说明它是连续区间（分辨率宽度 640..7680 之类），
 * 下拉里列出几千个档位对用户也没意义，交给数字输入框。
 * 正常枚举（画质档 0-4、帧率 30/60/120、常见分辨率 12 个）远小于这个数。
 */
const GFX_SELECT_MAX_OPTIONS = 40;

/** 单个档位的中文说明：数值档给「4 · 高」，文本档给「高（High）」。 */
function gfxOptionLabel(field, value, index) {
  const levels = Array.isArray(field.levels) ? field.levels : null;
  const at = typeof index === 'number' ? index : (field.options || []).indexOf(value);
  const word = levels && at >= 0 ? levels[at] || '' : '';
  const unit = field.unit ? ` ${field.unit}` : '';
  // 只显示中文档位名，不带括号里的原始值（「高（3）」→「高」）。
  // 中文档位自带单位时（「60 fps」）不再重复拼单位；没有中文名时才退回原始值。
  if (word) return word;
  if (typeof value === 'string') return value;
  return `${value}${unit}`;
}

/**
 * 一项设置的控件。
 *
 * 所有控件都带 data-action="graphics-set"，把「哪条注册表值 / 哪个字段 / 写什么」
 * 全塞进 data-* 里，由 handleAction 统一走 graphics:write。
 * 布尔项直接渲染两个按钮，比下拉更少一次点击。
 */
function gfxControl(group, field) {
  // data-field 要的是 JSON 里的字段名（field.key），不是 "值名.字段名" 的全名
  const base = `data-game="${esc(state.graphicsGame)}" data-entry="${esc(group.name)}" data-field="${esc(field.key)}"`;
  const current = field.value;

  if (field.type === 'bool' || typeof current === 'boolean') {
    const on = current === true || current === 'True' || current === 'true';
    return `<div class="gfx-switch">
      <button class="${on ? 'active' : ''}" data-action="graphics-set" ${base} data-value="true">开启</button>
      <button class="${on ? '' : 'active'}" data-action="graphics-set" ${base} data-value="false">关闭</button>
    </div>`;
  }

  const options = gfxOptionsOf(field);
  // 当前值缺失时不能拼进 HTML —— 否则会出现 value="undefined" 这种假选项，用户点了必然写入失败。
  // 崩坏3 在没启用对应画质档时，会往 JSON 里写字面量字符串 "undefined" / "null"，同样当无值处理。
  const rawText = current === undefined || current === null ? '' : String(current);
  const hasCurrent = rawText !== '' && rawText !== 'undefined' && rawText !== 'null';
  if (options.length) {
    const items = options
      .map((item) => {
        const active = hasCurrent && String(item.value) === String(current) ? ' selected' : '';
        return `<option value="${esc(String(item.value))}"${active}>${esc(item.label)}</option>`;
      })
      .join('');
    // 当前值不在预设里（游戏更新加了新档位）时补一条，免得下拉显示成第一个档位。
    // 这种值我们没有中文名，直接显示原始数字，不加任何前缀。
    const missing = hasCurrent && !options.some((item) => String(item.value) === String(current));
    const extra = missing
      ? `<option value="${esc(String(current))}" selected>${esc(String(current))}</option>`
      : '';
    return `<select class="gfx-select" data-action="graphics-set" ${base}>${extra}${items}</select>`;
  }

  if (!hasCurrent) {
    return `<span class="gfx-missing" title="没读到这一项的值，点右上角「重新读取」">未读取到</span>`;
  }

  return `<input class="gfx-input" type="number" step="any" value="${esc(String(current))}"
    data-action="graphics-set" ${base} data-manual="1" />`;
}

function graphicsView() {
  const result = state.graphics;
  // 游戏标签不再是写死的四个：trait 里带画质的 + 装好且有路径的（靠自动探测），
  // 以后 game-features 加游戏这里自动就有了。
  const games = graphicsGames();
  const gameKeys = games.map((game) => game.gameKey);
  const currentGame = games.find((game) => game.gameKey === state.graphicsGame) || null;
  // 主进程已经把注册表项翻译成 fields（中文名 + 显示值 + 类型 + 可选项），
  // 这里只管排版与控件，不再自己猜哪些键有用。
  const groups = result && Array.isArray(result.fields) ? result.fields : [];
  const pending = state.graphicsPending || null;
  /*
   * 页面上不再显示注册表路径 / 原始值名。
   *
   * 以前这里会挂一行「自动检测到画质设置位置：HKEY_CURRENT_USER\...」，
   * 卡片头部那行小字也直接是 `WINDOWS_HDR_ON_h3132281285` 这种带哈希的原始值名。
   * 对普通用户全是噪音，按要求整段去掉；结果里仍然保留 source / detectKey 字段，
   * 排查问题时从调试脚本里读得到。 */

  let body = '';
  if (state.graphicsLoading) {
    body = `<div class="tools-empty">${icon('refresh')}<strong>正在读取注册表</strong><p>稍等一下。</p></div>`;
  } else if (state.graphicsError) {
    // 探测失败也走这里：主进程会把具体原因带回来，页面上只显示这句话，不报错
    const hint = currentGame && !currentGame.path
      ? '先在启动器里添加这个游戏、确认安装路径，再回来点「重新读取」。'
      : '游戏启动过一次之后才会有画质配置。';
    body = `<div class="tools-empty">${icon('info')}<strong>${esc(state.graphicsError)}</strong><p>${esc(hint)}</p></div>`;
  } else if (result) {
    const cards = groups
      .map((group) => {
        const rows = (group.fields || [])
          .map((field) => {
            const busy = pending && pending.name === field.name ? ' is-pending' : '';
            return `
              <li class="gfx-row gfx-row-edit${busy}">
                <span class="gfx-label">${esc(field.label)}</span>
                <span class="gfx-control">${gfxControl(group, field)}</span>
              </li>`;
          })
          .join('');
        // 字段多的卡片（星铁「画质细节」有 17 项）单独占满整行
        const wide = (group.fields || []).length > 4 ? ' is-wide' : '';
        return `
          <article class="gfx-card gfx-card-writable${wide}">
            <header>
              <strong>${esc(group.title)}</strong>
              <em>${(group.fields || []).length} 项</em>
            </header>
            <ul>${rows || '<li class="gfx-row"><span class="gfx-label">（没有可读字段）</span></li>'}</ul>
          </article>`;
      })
      .join('');

    body = `
      ${cards ? `<div class="gfx-grid">${cards}</div>` : `<p class="page-desc">这个游戏的画质配置还没有可读字段。</p>`}
      <p class="shots-note">
        每一项都直接改游戏写进注册表里的画质设置，改完启动游戏即可生效；每次写入前都会把旧值备份到
        userData/registry-backup.json。数值项可以直接填数字，带下拉的项选一个档位就会立刻写入。
      </p>
    `;
  }

  return `<div class="page">
    ${toolsBackBar()}
    <div class="page-head">
      <div>
        <div class="eyebrow">${PAGE_META.graphics.eyebrow}</div>
        <h1>画质配置</h1>
        <p class="page-desc">读写游戏写在注册表里的画质 / 分辨率设置，每一项都可以直接改。</p>
      </div>
      <button class="btn ghost" data-action="graphics-refresh">${icon('refresh', 'xs')}重新读取</button>
    </div>
      <div class="shots-tabs">
        ${games
          .map(
            (game) => `<button class="shots-tab${game.gameKey === state.graphicsGame ? ' active' : ''}" data-action="graphics-game" data-value="${esc(game.gameKey)}">
              ${esc(game.name)}
            </button>`
          )
          .join('')}
      </div>
      ${body}
    </div>`;
}

function toolsCategoryLabel(key) {
  return {
    record: '战绩查询',
    gacha: '抽卡记录',
    local: '本地工具',
    system: '系统设置',
    info: '公告资讯',
  }[key] || key;
}

function toolsCategoryHint(key) {
  return {
    record: '查每日委托、深渊、体力，需要先登录对应账号',
    gacha: '读取本机抽卡数据库或官方接口',
    local: '截图、游戏时长等本机数据',
    system: '读写游戏配置文件，改动前会备份',
    info: '游戏公告与更新提醒',
  }[key] || '';
}

function toolsSupportedMark(supported) {
  return supported
    ? `<span class="tools-badge ok">${icon('check', 'xs')}可用</span>`
    : `<span class="tools-badge">未支持</span>`;
}

/* ── 2.4.0 合并自对方分支：工具页 · 游戏 Wiki ────────────────────────── */

/**
 * 每个游戏的 Wiki 站。
 *
 * 优先选官方维护的：米家四款都在米游社体系下（观测枢、开拓者笔记、绳网情报站、
 * 圣芙蕾雅档案馆），崩坏3 的 bbs.mihoyo.com/bh3/wiki/ 会 301 到 baike 下的同一份，
 * 这里直接写最终地址，少一跳。
 *
 * 鹰角自己没有做图鉴站，明日方舟和终末地都用 PRTS —— 玩家维护、鹰角资助，
 * 是目前中文社区公认最全的。《终末地》在 PRTS 上是独立词条页，不是独立站点。
 *
 * 异环用 B 站的 BWIKI：官方没有图鉴站，BWIKI 是内容最完整的中文站。
 */
const GAME_WIKI_SITES = {
  genshin: {
    name: '观测枢',
    url: 'https://baike.mihoyo.com/ys/obc/',
    desc: '原神官方图鉴：角色、武器、圣遗物、任务与活动',
    /* intro 是收进游戏卡后的展开介绍：一句话说清游戏类型，再说明 wiki 能查什么 */
    intro:
      '《原神》是一款开放世界冒险 RPG。观测枢是米游社体系的官方百科，收录全部角色、武器、圣遗物与敌人的详细图鉴，主线与世界任务、限时活动的攻略，以及每个版本更新的内容说明都能在这里查到。',
    official: true,
  },
  starrail: {
    name: '开拓者笔记',
    url: 'https://bbs.mihoyo.com/sr/wiki/',
    desc: '星穹铁道官方 Wiki：角色、光锥、遗器、模拟宇宙',
    intro:
      '《崩坏：星穹铁道》是回合制 RPG。开拓者笔记是官方 Wiki，可以查角色、光锥、遗器的完整图鉴与育成材料，模拟宇宙等玩法说明和新版本角色攻略也会随版本同步更新。',
    official: true,
  },
  zzz: {
    name: '绳网情报站',
    url: 'https://baike.mihoyo.com/zzz/wiki/',
    desc: '绝区零官方 Wiki：代理人、音擎、驱动盘与空洞情报',
    intro:
      '《绝区零》是一款都市题材动作游戏。绳网情报站是官方 Wiki，收录代理人、音擎、驱动盘的完整图鉴与配装参考，空洞作战的机制说明和各版本活动情报也在这里整理。',
    official: true,
  },
  bh3: {
    name: '圣芙蕾雅档案馆',
    url: 'https://baike.mihoyo.com/bh3/wiki/',
    desc: '崩坏3 官方 Wiki：女武神、圣痕、武器与剧情档案',
    intro:
      '《崩坏3》是经典的动作游戏。圣芙蕾雅档案馆是官方 Wiki，可以查女武神、圣痕、武器的图鉴与推荐搭配，长线剧情的角色档案和版本活动资料也归档在内。',
    official: true,
  },
  arknights: {
    name: 'PRTS',
    url: 'https://prts.wiki/w/%E9%A6%96%E9%A1%B5',
    desc: '明日方舟中文 Wiki：干员、关卡、基建与剧情资料',
    intro:
      '《明日方舟》是策略塔防手游。PRTS 是玩家社区维护、鹰角官方资助的中文 Wiki，干员、敌人、关卡、基建与剧情资料公认最全，养成材料的掉落与效率查询也主要靠它。',
    official: false,
  },
  endfield: {
    name: 'PRTS · 终末地',
    url: 'https://prts.wiki/w/%E6%98%8E%E6%97%A5%E6%96%B9%E8%88%9F%EF%BC%9A%E7%BB%88%E6%9C%AB%E5%9C%B0',
    desc: '终末地在 PRTS 上的词条：干员、设施与剧情总览',
    intro:
      '《明日方舟：终末地》是鹰角旗下的 3D 策略 RPG。PRTS 为它开设了独立词条页，汇总已公开的干员、设施与世界观设定，内容随测试与版本推进持续更新，适合跟进最新情报。',
    official: false,
  },
  neverness: {
    name: 'BWIKI 异环',
    url: 'https://wiki.biligame.com/yh/%E9%A6%96%E9%A1%B5',
    desc: '异环中文 Wiki：角色图鉴、载具改装与配队攻略',
    intro:
      '《异环》是一款超自然都市开放世界游戏。BWIKI 异环站收录角色图鉴、载具改装与配队攻略，由 B 站 wiki 体系维护，是目前中文社区内容最完整的异环资料站。',
    official: false,
  },
};

/** 游戏 key 是 builtinKey，但用户自建的游戏没有，只能退回按名字猜。 */
function wikiSiteOf(game) {
  const key = String(game?.key || game?.builtinKey || '');
  if (GAME_WIKI_SITES[key]) return GAME_WIKI_SITES[key];
  const name = String(game?.name || '');
  if (/星穹铁道/.test(name)) return GAME_WIKI_SITES.starrail;
  if (/原神/.test(name)) return GAME_WIKI_SITES.genshin;
  if (/绝区零/.test(name)) return GAME_WIKI_SITES.zzz;
  if (/崩坏3/.test(name)) return GAME_WIKI_SITES.bh3;
  if (/终末地/.test(name)) return GAME_WIKI_SITES.endfield;
  if (/明日方舟/.test(name)) return GAME_WIKI_SITES.arknights;
  if (/异环/.test(name)) return GAME_WIKI_SITES.neverness;
  return null;
}

/**
 * 游戏卡内的 Wiki 收缩框。
 *
 * wiki 不再是工具页底部的独立面板：每个游戏的资料站跟着游戏卡走，
 * 展开游戏卡后在这里看到一段介绍和「在浏览器打开」的入口。
 * 用原生 <details> 做折叠，不占 state——整卡重绘后会收回，
 * 但对一个低频入口来说无伤大雅，换来的是零事件绑定。
 * 打开行为仍是 data-action="tools-wiki"，case 里做 https 校验后走 openExternal。
 */
function gameWikiGroup(game) {
  const site = wikiSiteOf(game);
  if (!site) return '';
  return `<details class="tg-wiki">
    <summary>
      ${icon('database', 'xs')}
      <span>Wiki 资料</span>
      <span class="tools-wiki-tag${site.official ? ' is-official' : ''}">${site.official ? '官方' : '社区'}</span>
      <span class="tg-wiki-chevron">${icon('chevron-down', 'xs')}</span>
    </summary>
    <p class="tg-wiki-intro">${esc(site.intro || site.desc || '')}</p>
    <div class="tg-wiki-row">
      <span class="tg-wiki-site">${esc(site.name)}</span>
      <button class="btn ghost" data-action="tools-wiki" data-url="${esc(site.url)}">
        ${icon('external', 'xs')}在浏览器打开
      </button>
    </div>
  </details>`;
}

/**
 * matrix 的结构是 { [gameKey]: [featureKey, ...] }，只列出该游戏支持的项。
 * 所有功能清单在 data.features 里，两者交叉就能拼出每行的可用状态。
 */
function toolsSupportOf(data) {
  const matrix = data.matrix || {};
  const allFeatures = data.features || [];
  return (gameKey) => {
    const supportedKeys = Array.isArray(matrix[gameKey]) ? matrix[gameKey] : [];
    return allFeatures.map((feature) => ({
      ...feature,
      supported: supportedKeys.includes(feature.key),
    }));
  };
}

function toolsFeatureName(data, key) {
  const feature = (data.features || []).find((item) => item.key === key);
  return feature ? feature.name : key;
}

/* ------------------------------------------------------------------ */
/* 侧栏「工具」分组                                                     */
/* ------------------------------------------------------------------ */

/*
 * 战绩类功能：全部进战绩页，具体看哪个游戏哪个面板由 data-feature 决定。
 * 顺序和 game-features.js 里 FEATURES 的登记顺序一致。
 */
const RECORD_FEATURES = [
  'daily-note',
  'abyss',
  'theater',
  'stygian',
  'ultra-endless',
  'battle-field',
  'forgotten-hall',
  'pure-fiction',
  'apocalyptic-shadow',
  'simulated-universe',
  'shiyu-defense',
  'deadly-assault',
];

/** 战绩功能各自的图标，工具页「按游戏查看」里跟着功能名一起显示。 */
const RECORD_ICON = {
  'daily-note': 'clock',
  abyss: 'star',
  theater: 'sparkle',
  stygian: 'shield',
  'ultra-endless': 'star',
  'battle-field': 'shield',
  'forgotten-hall': 'gamepad',
  'pure-fiction': 'sparkle',
  'apocalyptic-shadow': 'moon',
  'simulated-universe': 'repeat',
  'shiyu-defense': 'shield',
  'deadly-assault': 'sparkle',
};

/** 哪些功能已经在界面上有独立页面，点侧栏能真的跳过去。 */
const TOOLS_NAV_TARGET = {
  ...Object.fromEntries(RECORD_FEATURES.map((key) => [key, 'record'])),
  gacha: 'gacha',
  'play-time': 'home',
  screenshot: 'screenshots',
  graphics: 'graphics',
  'install-manager': 'start',
  notice: 'news',
};

/**
 * 把工具页那堆小卡片搬进侧栏的「工具」折叠项里。
 *
 * 数据全部来自 game-features.js 的 byCategory + matrix，
 * 所以以后加功能 / 加游戏，侧栏自动跟着变，不用改这里。
 *
 * 没有独立页面的功能（每日便笺、深渊这些还没做界面的）不带 action，
 * 只用灰点表示「暂未开放」，避免点进去一片空白。
 */
function renderNavToolsSub() {
  const sub = dom.navToolsSub;
  if (!sub) return;
  /*
   * 侧栏不再展开工具的子项。
   *
   * 工具页自己已经是「左导航 + 右侧面板」的结构，战绩 12 个功能、插件入口、
   * 各分类都在页内列得清清楚楚；侧栏再铺一遍会让整条侧栏长到要滚动，
   * 反而不好找。点「工具」直接进工具页即可。
   */
  sub.innerHTML = '';
  syncNavToolsOpen();
}

/** 把折叠状态同步到 DOM：显隐、箭头方向、aria。 */
function syncNavToolsOpen() {
  const sub = dom.navToolsSub;
  const parent = dom.navToolsGroup?.querySelector('.nav-item-parent');
  if (!sub || !parent) return;
  // 侧栏不再挂子项，这个折叠区永远收起、点「工具」直接进页面
  sub.hidden = true;
  parent.setAttribute('aria-expanded', 'false');
  dom.navToolsGroup.classList.remove('is-open');
}

/** 侧栏的纵向滚动容器（新 DOM 是 .sidebar-scroll，老 DOM 回落到 .nav 自己）。 */
function sidebarScroller() {
  const scroller = document.querySelector('#sidebar-scroll');
  if (scroller) return scroller;
  const nav = document.querySelector('#nav');
  return nav && nav.scrollHeight > nav.clientHeight + 1 ? nav : null;
}

/**
 * 让侧栏里的某个元素滚进视野。
 *
 * 「工具」子项展开后会把下面的「应用 / 设置」推出可视区，
 * 这里把父项和它的子项一起收进窗口，用户不会看到「设置」突然消失。
 * 已经完整在视野里的元素不动，免得只是点了个本来就看得见的菜单项、侧栏却自己跳一下。
 *
 * 注意判方向：矮窗口里「工具」组本身就在视口下方（还没滚到），
 * 这时必须往下滚把它拉上来；只按 box.top 判断会算出一个负的位移，
 * 被 clamp 到 0 之后看起来就是「点了没反应」。
 */
function revealInSidebar(element, { smooth = true } = {}) {
  const scroller = sidebarScroller();
  if (!scroller || !element) return;
  const scrollerBox = scroller.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  const pad = 8;
  const top = scrollerBox.top + pad;
  const bottom = scrollerBox.bottom - pad;
  let delta = 0;
  if (box.top >= bottom) {
    // 整个在视口下方：把它的底部拉齐到视口底部
    delta = box.bottom - bottom;
  } else if (box.bottom <= top) {
    // 整个在视口上方：把它的顶部拉到视口顶部
    delta = box.top - top;
  } else if (box.top < top) {
    delta = box.top - top;
  } else if (box.bottom > bottom) {
    // 比视口还高时优先露头，别为了对齐底部把标题顶出去
    delta = Math.min(box.bottom - bottom, box.top - top);
  }
  if (!delta) return;
  const target = Math.max(0, Math.min(scroller.scrollTop + delta, scroller.scrollHeight - scroller.clientHeight));
  scrollSidebarTo(scroller, target, smooth);
}

/**
 * 侧栏滚动。优先平滑，但平滑滚动在窗口隐藏 / 刚重建布局 / 系统关了动画时会静默失败，
 * 所以用一次定时检查兜底：过一会儿位置没变就直接跳到目标，别让「展开工具」看起来毫无反应。
 * 这里不用 requestAnimationFrame——窗口不可见时 rAF 根本不跑，兜底会永远等不到。
 */
function scrollSidebarTo(scroller, target, smooth) {
  const from = scroller.scrollTop;
  if (!smooth || Math.abs(target - from) < 1) {
    scroller.scrollTop = target;
    return;
  }
  scroller.scrollTo({ top: target, behavior: 'smooth' });
  setTimeout(() => {
    if (Math.abs(scroller.scrollTop - from) < 1 && Math.abs(scroller.scrollTop - target) > 1) {
      scroller.scrollTop = target;
    }
  }, 220);
}

/**
 * 滚动中给容器挂 is-scrolling，配合 CSS 让滚动条滑块只在操作时显形。
 * 侧栏常驻一条灰杠很扎眼，但完全不给滑块又不知道能滚——折中成「动的时候才亮」。
 */
function initSidebarScroll() {
  const scroller = sidebarScroller();
  if (!scroller || scroller.dataset.scrollBound === '1') return;
  scroller.dataset.scrollBound = '1';
  let hideTimer = 0;
  const markScrolling = () => {
    scroller.classList.add('is-scrolling');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => scroller.classList.remove('is-scrolling'), 700);
  };
  scroller.addEventListener('scroll', markScrolling, { passive: true });
  scroller.addEventListener(
    'wheel',
    () => {
      // 窗口足够高、根本滚不动的时候，别在滚动条区点亮一条没用的杠
      if (scroller.scrollHeight > scroller.clientHeight + 1) markScrolling();
    },
    { passive: true }
  );

  /*
   * 滚轮转发：侧栏里真正能滚的只有导航这一块，但顶部品牌区、底部立绘、
   * 「收起侧栏」和个人资料都盖在它上面/下面。鼠标停在那些地方滚轮毫无反应，
   * 用起来就是「侧栏滑不动」。这里把侧栏范围内的滚轮统一喂给导航容器，
   * 手感与直接滚列表一致（行模式的 deltaY 按 16px 一行换算）。
   */
  const sidebar = document.querySelector('.sidebar');
  if (sidebar && sidebar.dataset.wheelRelay !== '1') {
    sidebar.dataset.wheelRelay = '1';
    sidebar.addEventListener(
      'wheel',
      (event) => {
        // Ctrl + 滚轮是缩放，Alt/Shift 有可能是横向，都别抢
        if (event.ctrlKey || event.altKey) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target && target.closest('#sidebar-scroll')) return;
        const max = scroller.scrollHeight - scroller.clientHeight;
        if (max <= 1) return;
        const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
        const next = Math.max(0, Math.min(scroller.scrollTop + event.deltaY * step, max));
        if (next === scroller.scrollTop) return;
        event.preventDefault();
        scroller.scrollTop = next;
        markScrolling();
      },
      { passive: false }
    );
  }
}

/** 游戏卡内部的分类分组顺序与短标签。 */
const TOOLS_CATEGORY_ORDER = ['record', 'gacha', 'local', 'system', 'info'];

/**
 * 二级页面顶部的「返回工具页」条。
 *
 * 只有从工具页点功能入口进来时（state.fromTools）才渲染，
 * 从侧栏直接进 record / gacha 这些页面不会多出按钮，原有返回行为不变。
 * 放在 page-head 之前独立成一条，不挤占各页原本的头部操作区。
 */
function toolsBackBar() {
  if (!state.fromTools || state.route === 'tools') return '';
  return `<div class="tools-back-bar">
    <button class="btn ghost" data-action="nav-tools">${icon('chevron-left', 'xs')}返回工具页</button>
  </div>`;
}
const TOOLS_CATEGORY_SHORT = {
  record: '战绩',
  gacha: '抽卡',
  local: '本机',
  system: '设置',
  info: '资讯',
};

/**
 * 「按游戏查看」的单个游戏能力卡（重做版）。
 *
 * - 只列这个游戏**真正支持**的功能，按分类成组，全部可点直达；
 * - 默认全部展开，点卡片头折叠 / 展开（折叠状态存 state.toolsCollapsed）；
 * - 顶部一条游戏主题色（game.accent）光带，便于一眼区分游戏。
 */
/**
 * 一个游戏的能力内容：按分类分组的功能标签 + wiki 折叠块。
 * 只产出「内容」，不带卡片外壳——右侧能力面板直接铺它。
 */
function toolsGameBody(game, supportOf) {
  const features = supportOf(game.key);
  const supported = features.filter((item) => item.supported);

  const featButton = (item) => {
    const isRecord = RECORD_FEATURE_SET.has(item.key);
    const target = TOOLS_NAV_TARGET[item.key];
    const cls = `tg-feat${isRecord ? ' is-record' : ''}${item.needsLogin ? ' needs-login' : ''}`;
    const dataGame = isRecord ? ` data-game="${esc(game.key)}"` : '';
    const ico = isRecord ? RECORD_ICON[item.key] || 'star' : TOOLS_CATEGORY_ICONS[item.category] || 'wrench';
    /* 没有直达页面的能力（理论上当前都有）降级成静态标记，不做假按钮 */
    if (!target) {
      return `<span class="${cls} is-static" title="${esc(item.desc || '')}">${icon(ico, 'xs')}<span>${esc(item.name)}</span></span>`;
    }
    return `<button class="${cls}" data-action="tools-open" data-feature="${esc(item.key)}"${dataGame} title="${esc(item.desc || '')}">
      ${icon(ico, 'xs')}<span>${esc(item.name)}</span>
    </button>`;
  };

  const groups = TOOLS_CATEGORY_ORDER.map((category) => {
    const items = supported.filter((item) => item.category === category);
    if (!items.length) return '';
    return `<div class="tg-group">
      <span class="tg-group-label">${esc(TOOLS_CATEGORY_SHORT[category] || toolsCategoryLabel(category))}</span>
      <div class="tg-feats">${items.map(featButton).join('')}</div>
    </div>`;
  }).join('');

  /* wiki 收进内容区底部（3.x 改版：替代底部独立 wiki 面板） */
  const wikiBlock = gameWikiGroup(game);
  if (!groups && !wikiBlock) return `<p class="tools-game-empty">这款游戏暂无可接入的能力。</p>`;
  return `${groups}${wikiBlock}`;
}

/** 左侧游戏条目：主题色小光带 + 游戏名 + 副标题 + 能力数。 */
function toolsRailItem(game, supportOf, active) {
  const count = supportOf(game.key).filter((item) => item.supported).length;
  return `<button class="tg-rail-item${active ? ' is-active' : ''}" style="--tg-accent:${esc(game.accent || '#f0c674')}"
    data-action="tools-game-pick" data-value="${esc(game.key)}" role="tab" aria-selected="${active ? 'true' : 'false'}"
    title="${esc(game.name)}：${count} 项能力">
    <span class="tg-bar" aria-hidden="true"></span>
    <span class="tg-rail-copy">
      <strong>${esc(game.name)}</strong>
      <small>${esc(game.subtitle || '')}</small>
    </span>
    <span class="tg-rail-count">${count} 项</span>
  </button>`;
}

/** 右侧能力面板：一次只铺一个游戏，高度自然撑满，不再有卡片高低参差。 */
function toolsPanel(game, supportOf) {
  const count = supportOf(game.key).filter((item) => item.supported).length;
  return `<div class="tg-panel-head">
      <strong>${esc(game.name)}</strong>
      <small>${esc(game.subtitle || '')}</small>
      <span class="tg-count">${count} 项能力</span>
    </div>
    <div class="tg-panel-groups">${toolsGameBody(game, supportOf)}</div>`;
}

/**
 * 工具页里「需要登录」的提示。
 *
 * 以前这里是写死的一句「需要先登录账号」，登录成功后也不变，
 * 看起来像「明明登录了却说我未登录」。
 * 现在按真实的米游社登录态分三种显示：读取中 / 已登录 / 未登录。
 */
function miyouLoginNote() {
  const status = state.hoyolab?.['hoyolab-miyoushe'];
  if (!status || status.loading) {
    return `<p class="tools-feature-note">${icon('login', 'xs')}正在读取米游社登录状态…</p>`;
  }
  if (status.loggedIn) {
    const count = Array.isArray(status.roles) ? status.roles.length : 0;
    return `<p class="tools-feature-note is-on">${icon('check', 'xs')}已登录米游社${count ? `（${count} 个角色）` : ''}</p>`;
  }
  return `<p class="tools-feature-note">${icon('login', 'xs')}需要先登录账号</p>`;
}

const TOOLS_CATEGORY_ICONS = {
  record: 'star',
  gacha: 'sparkle',
  local: 'image',
  system: 'settings',
  info: 'news',
  account: 'login',
  games: 'gamepad',
  plugins: 'sparkle',
};

/** 工具页左侧的分组顺序：按游戏查看排第一（也是默认选中的），功能分类随后，账号登录收尾。 */
function toolsTabs(groups) {
  return [
    ['games', '按游戏查看', 'gamepad', '每个游戏支持哪些能力，点开就能直接进对应的战绩页'],
    ...groups.map((group) => [
      group.category,
      toolsCategoryLabel(group.category),
      TOOLS_CATEGORY_ICONS[group.category] || 'wrench',
      toolsCategoryHint(group.category),
    ]),
    ['account', '账号登录', 'login', '战绩类功能要先登录；抽卡记录走各自游戏的独立通道'],
    /*
     * 插件是独立页面，不在 game-features 的能力矩阵里，所以由这里手工挂一项。
     * 没有这一项的话，插件页就只剩代码里的 navigate('plugins') 能进，
     * 用户根本找不到入口（侧栏「工具」现在直接跳工具页，不再展开子项）。
     */
    ['plugins', '自定义插件', 'sparkle', '单个 .hxl 文件，在隔离的 Worker 里运行'],
  ];
}

function toolsTab(tabs) {
  const key = state.toolsTab;
  return tabs.some((tab) => tab[0] === key) ? key : tabs[0][0];
}

function toolsView() {
  const data = state.features;
  if (!data) {
    return `<div class="page"><div class="page-head"><div><div class="eyebrow">${PAGE_META.tools.eyebrow}</div><h1>工具</h1></div></div>
      <div class="empty"><div class="empty-icon">${icon('wrench')}</div><h3>正在读取支持列表</h3><p>稍等一下。</p></div></div>`;
  }
  if (data.error) {
    return `<div class="page"><div class="page-head"><div><div class="eyebrow">${PAGE_META.tools.eyebrow}</div><h1>工具</h1></div></div>
      <div class="empty"><div class="empty-icon">${icon('alert')}</div><h3>读取失败</h3><p>${esc(data.error)}</p></div></div>`;
  }

  const games = data.games || [];
  const supportOf = toolsSupportOf(data);
  const totalGames = games.length;
  const totalFeatures = (data.features || []).length;

  /*
   * 工具页不再放左侧功能分类导航：每张游戏卡内部已经按
   * 战绩 / 抽卡 / 本机 / 设置 / 资讯分好组、标签直达，左栏再放一遍同样的
   * 功能分类只是重复维度。现在整页就是一面全宽的游戏能力卡墙；
   * 不按游戏走的两件事——账号登录、自定义插件——收进右上角。
   */
  /*
   * 布局：左边一条游戏列表，右边是选中游戏的能力面板。
   * 以前是一面可折叠的卡片墙，点开一张、其余仍收起，同一行里高矮不齐、
   * 看着像没对齐的半成品；主从布局一次只铺一个游戏，右侧自然填满，
   * 选谁看谁，也不会把整页拉得很长。
   */
  const activeKey =
    games.some((game) => game.key === state.toolsGame) ? state.toolsGame : (games[0] && games[0].key) || '';
  const activeGame = games.find((game) => game.key === activeKey) || games[0] || null;
  const rail = games.map((game) => toolsRailItem(game, supportOf, game.key === activeKey)).join('');

  return `<div class="page page-tools">
    <div class="page-head">
      <div>
        <div class="eyebrow">${PAGE_META.tools.eyebrow}</div>
        <h1>工具</h1>
        <p class="page-desc">${totalGames} 个游戏 · ${totalFeatures} 项能力，左边选游戏，右边直接进对应功能</p>
      </div>
      <div class="tools-head-actions">
        <button class="btn ghost" data-action="tools-accounts">${icon('login', 'xs')}账号登录</button>
        <button class="btn ghost" data-action="nav-plugins">${icon('sparkle', 'xs')}自定义插件</button>
        <button class="btn ghost" data-action="tools-refresh">${icon('refresh', 'xs')}重新读取</button>
      </div>
    </div>

    <div class="tg-shell">
      <aside class="tg-rail" role="tablist" aria-label="按游戏查看能力">${rail}</aside>
      <section class="tg-panel" style="--tg-accent:${esc((activeGame && activeGame.accent) || '#f0c674')}">
        ${activeGame ? toolsPanel(activeGame, supportOf) : '<p class="tools-game-empty">暂时没有读取到游戏能力。</p>'}
      </section>
    </div>
  </div>`;
}

/* 工具页右上角「账号登录」弹窗：米游社一套号带四款米家游戏，其余发行方各自一卡。 */
function openToolsAccountsModal() {
  const games = (state.features && state.features.games) || [];
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal tools-accounts-modal" role="dialog" aria-modal="true" aria-labelledby="tools-accounts-title">
        <div class="modal-head">
          <div>
            <h2 id="tools-accounts-title">账号登录</h2>
            <p>战绩类功能要先登录；抽卡记录走各自游戏的独立通道。登录态只保存在本机，不会上传。</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="tools-accounts-body">
            ${hoyolabLoginCard()}
            ${otherLoginCards(games)}
          </div>
        </div>
        <div class="modal-foot">
          <span style="flex:1"></span>
          <button class="btn ghost" data-close>关闭</button>
        </div>
      </div>
    </div>`);
}

/* ------------------------------------------------------------------ */
/* 战绩页                                                              */
/* ------------------------------------------------------------------ */

/**
 * 这些接口的模板里带 {schedule}，所以页面上要能切本期/上期。
 * 其余功能（便笺、剧场、幽境危战、超弦空间、记忆战场）只有当期一份数据。
 */
const RECORD_SCHEDULE_FEATURES = [
  'abyss',
  'forgotten-hall',
  'pure-fiction',
  'apocalyptic-shadow',
  'shiyu-defense',
  'deadly-assault',
];

/**
 * 战绩页只认这 13 个功能。
 *
 * 工具页里同一个游戏下面还挂着抽卡记录、截图管理、画质配置、公告、游玩时长，
 * 它们各自有独立页面，不属于战绩。标签栏必须按这个集合过滤 ——
 * 否则会把这些也列进战绩页，看着像塞了一堆不相干的东西。
 */
const RECORD_FEATURE_SET = new Set(RECORD_FEATURES);

/**
 * 米哈游的「账号异常」错误码家族（源：Starward GameRecordPage.HandleMiHoYoApiException）。
 * 1034 需要人机验证，5003 是设备指纹或高频请求，其余几个是同一族的变体。
 * 遇到这些码不该显示「请求失败」，而要说清楚该怎么恢复。
 */
const RECORD_VERIFY_RETCODES = [1034, 5003, 10035, 10041, 10053];

/** 官方战绩页，用户需要人工验证时用它兜底（米游社网页版，带登录态就能看）。 */
const RECORD_WEB_URL = 'https://webstatic.mihoyo.com/app/community-game-records/index.html';

/*
 * 缓存键要带账号：多账号下同一个人可能有多个通行证，
 * 不同账号的原神 uid 完全不同，只用「游戏/功能/期数」做键会串号。
 */
function recordCacheKey(game, feature, schedule) {
  const account =
    state.record.account || state.hoyolab?.['hoyolab-miyoushe']?.activeId || 'active';
  return `${account}/${game}/${feature}/${Number(schedule) === 2 ? 2 : 1}`;
}

/** 只取路径部分显示在角色行末尾，方便核对打的是哪个接口；URL 非法就留空。 */
function recordUrlPath(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return '';
  }
}

/** 米游社那个账号在指定游戏下的角色；优先用户手动选过的那个。 */
function recordRoleOf(game) {
  const roles = state.hoyolab?.['hoyolab-miyoushe']?.roles || [];
  const owned = roles.filter((role) => role && role.game === game && role.uid);
  const manual = state.record.role?.[game];
  if (manual?.uid) {
    const hit = owned.find((role) => String(role.uid) === String(manual.uid));
    return hit || manual;
  }
  return owned[0] || null;
}

/** 同一个账号在某款游戏下的全部角色（可以是多个 uid，比如三个崩3服务器）。 */
function recordRolesOf(game) {
  const roles = state.hoyolab?.['hoyolab-miyoushe']?.roles || [];
  return roles.filter((role) => role && role.game === game && role.uid);
}

/** 战绩页当前选中的通行证账号；state.record.account 为空时跟随激活账号。 */
function recordAccountOf() {
  const status = state.hoyolab?.['hoyolab-miyoushe'];
  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  const wanted = String(state.record.account || status?.activeId || '');
  return (
    accounts.find((item) => item.id === wanted) ||
    accounts.find((item) => item.id === status?.activeId) ||
    accounts[0] ||
    null
  );
}

/**
 * 账号条：只有挂了一个以上的通行证账号才显示。
 * 单账号时这一行没有信息量，只会让页面显得啰嗦。
 */
function recordAccountLineHtml() {
  const status = state.hoyolab?.['hoyolab-miyoushe'];
  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  if (accounts.length < 2) return '';
  const current = recordAccountOf();
  const chips = accounts
    .map((account) => {
      const active = current && String(account.id) === String(current.id);
      return `<button class="record-account-chip${active ? ' is-active' : ''}" data-action="record-account" data-value="${esc(account.id)}" title="${esc(account.roles.length)} 个角色">
        ${esc(account.label || account.id)}
      </button>`;
    })
    .join('');
  return `<div class="record-account-line">
    <span class="record-account-caption">${icon('shield', 'xs')}账号</span>
    ${chips}
  </div>`;
}

/**
 * 角色（UID）行。
 * 同一款游戏有多个角色时列成可点的胶囊 —— 崩3 一个账号经常挂着三台服务器。
 */
function recordRoleLineHtml(game, role, cache) {
  if (!role) return '';
  const owned = recordRolesOf(game);
  const meta = (item) =>
    `${esc(item.regionName || item.region || '')}${item.level ? ` · Lv.${esc(item.level)}` : ''}`;
  const url = cache?.url
    ? `<span class="record-role-url" title="${esc(cache.url)}">${esc(recordUrlPath(cache.url))}</span>`
    : '';

  if (owned.length > 1) {
    const chips = owned
      .map((item) => {
        const active = String(item.uid) === String(role.uid);
        /*
         * 崩3 的昵称往往就是「玩家<uid>」，再补一个 uid 徽标纯属重复，
         * 这种情况直接用 uid 当名字。
         */
        const nickname = String(item.nickname || '');
        const label = nickname && !nickname.includes(String(item.uid)) ? nickname : `UID ${item.uid}`;
        return `<button class="record-role-chip${active ? ' is-active' : ''}" data-action="record-role" data-value="${esc(item.uid)}" title="${esc(item.regionName || item.region || '')}">
          ${esc(label)}
        </button>`;
      })
      .join('');
    return `<div class="record-role-line">
      <span class="record-role-caption">${icon('gamepad', 'xs')}角色</span>
      ${chips}
      <span class="record-role-meta">${meta(role)}</span>
      ${url}
    </div>`;
  }

  const gameMeta = (state.features?.games || []).find((item) => item.key === game) || {};
  return `<div class="record-role-line">
    <span class="record-role-name">${esc(role.nickname || '未命名')}</span>
    <span class="record-role-meta">${esc(gameMeta.name || '')} · UID ${esc(role.uid || '')}${
      role.regionName ? ` · ${esc(role.regionName)}` : ''
    }${role.level ? ` · Lv.${esc(role.level)}` : ''}</span>
    ${url}
  </div>`;
}

/** 某个游戏支持的战绩功能（按 FEATURES 的声明顺序，每日便笺永远在第一个）。 */
function recordFeaturesOf(game) {
  const matrix = state.features?.matrix || {};
  return (matrix[game] || []).filter((key) => RECORD_FEATURE_SET.has(key));
}

/** 至少有一个战绩功能的游戏。只有抽卡/截图这类功能的游戏根本不进战绩页。 */
function recordGames() {
  return (state.features?.games || [])
    .map((game) => game.key)
    .filter((key) => recordFeaturesOf(key).length > 0);
}

/** 从工具页点进来时挑一个「有角色、且支持这个功能」的游戏。 */
function pickRecordGame(feature) {
  const matrix = state.features?.matrix || {};
  const games = recordGames();
  const candidates = games.filter((key) => Array.isArray(matrix[key]) && matrix[key].includes(feature));
  if (!candidates.length) return state.record.game || 'genshin';
  const roles = state.hoyolab?.['hoyolab-miyoushe']?.roles || [];
  const loggedIn = new Set(roles.filter((role) => role?.uid).map((role) => role.game));
  return candidates.find((key) => loggedIn.has(key)) || candidates[0];
}

/**
 * 拉一次战绩数据。
 *
 * 同一个 (游戏, 功能, 期数) 只请求一次，结果存在 state.record.cache 里。
 * 没登录、或这个游戏下没角色时直接返回、不发请求 —— 页面显示登录提示，
 * 而不是弹「请求失败」让用户以为接口坏了。
 */
async function loadRecord(force = false) {
  const game = state.record.game;
  const feature = state.record.feature;
  const schedule = state.record.schedule;
  const key = recordCacheKey(game, feature, schedule);
  const cached = state.record.cache[key];
  if (!force && cached && !cached.loading) return cached;

  const role = recordRoleOf(game);
  if (!role) return { skipped: true };

  const entry = { loading: true, error: '', view: null, url: '', at: Date.now() };
  state.record.cache[key] = entry;
  try {
    if (!window.launcher?.hoyolab?.record) throw new Error('当前版本不支持战绩查询');
    const result = await window.launcher.hoyolab.record({
      provider: 'miyoushe',
      // 指定账号：不然主进程会用「当前激活的那个」，和界面上选的可能不是同一个
      accountId: state.record.account || undefined,
      game,
      feature,
      uid: role.uid,
      region: role.region,
      schedule,
    });
    /*
     * 主进程现在把接口报错当成返回值（ok:false）带回来，而不是 throw ——
     * Electron 的 IPC 在 throw 时只保留 message，实际请求地址和 retcode 都会丢。
     */
    if (result && result.ok === false) {
      entry.error = result.error || '请求失败';
      entry.url = result.url || '';
      entry.retcode = typeof result.retcode === 'number' ? result.retcode : null;
      entry.debug = result.debug || null;
      /*
       * 1034 / 5003 / 10035 / 10041 / 10053 是米哈游的「账号异常」家族
       * （Starward 把这一组统一提示成「账号异常，需要验证账号」）。
       * 光把 retcode 甩给用户没有任何意义，这里翻译成能照着做的说明。
       *
       * 但这一族里其实是两种完全不同的情况：
       *   1034 / 5003 —— 查得太频繁，或者请求的身份不干净。等一会儿能自愈。
       *   10035 / 10041 / 10053 —— 接口本身对当前角色不开放（同一套请求
       *     有时候能读到别的功能，说明不是登录或风控问题），等也没用。
       */
      if (RECORD_VERIFY_RETCODES.includes(entry.retcode)) {
        entry.error =
          entry.retcode === 1034 || entry.retcode === 5003
            ? `米哈游把这次查询当成了异常请求（retcode ${entry.retcode}）。` +
              '大多是短时间内查得太频繁，等几分钟点「刷新」就好；' +
              '如果一直这样，点下面的「打开官方战绩页」在网页里看一次，完成它要求的验证后再回来刷新。'
            : `米哈游拒绝了这个角色的这条战绩（retcode ${entry.retcode}）。` +
              '这个错误码不是查询太频繁，而是接口对当前角色没有开放这条数据 —— ' +
              '换个功能或换个游戏看看，也可以点下面的「打开官方战绩页」去网页上确认一下。';
        entry.needVerify = true;
      }
      entry.at = Date.now();
      return entry;
    }
    entry.view = window.HXLRecord ? window.HXLRecord.parse(game, feature, result?.data) : null;
    entry.url = result?.url || '';
    entry.at = Date.now();
  } catch (error) {
    entry.error = humanError(error) || '请求失败';
  } finally {
    entry.loading = false;
  }
  return entry;
}

/** 用户点刷新 / 切游戏 / 切期数时走这里：先把格子标成加载中，再请求、再重绘。 */
async function reloadRecord() {
  /*
   * 先占位成 loading 再重绘：否则切游戏/切功能时用户盯着旧数据看一两秒，
   * 分不清是「点了没反应」还是「真的在加载」。
   */
  const key = recordCacheKey(state.record.game, state.record.feature, state.record.schedule);
  state.record.cache[key] = { loading: true, error: '', view: null, url: '', at: Date.now() };
  if (state.route === 'record') render({ preserveScroll: true });
  await loadRecord(true);
  if (state.route === 'record') render({ preserveScroll: true });
}

/* --------------------------- 渲染小件 --------------------------- */

function recordStarsHtml(stars, max) {
  if (stars === null || stars === undefined) return '';
  const full = Math.max(0, Math.min(Number(stars) || 0, 9));
  const total = Math.max(full, Math.min(Number(max) || full, 9));
  return `<span class="record-stars" title="${full}/${total}">${'★'.repeat(full)}<em>${'☆'.repeat(total - full)}</em></span>`;
}

function recordAvatarHtml(avatar) {
  const name = String(avatar?.name || '');
  const icon = String(avatar?.icon || '');
  const value = String(avatar?.value || '');
  const img = icon
    ? `<img data-record-avatar src="${esc(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '<span class="record-avatar-blank"></span>';
  return `<span class="record-avatar" title="${esc([name, value].filter(Boolean).join(' · '))}">${img}${
    value ? `<em>${esc(value)}</em>` : ''
  }</span>`;
}

function recordMetricHtml(metric) {
  const tone = metric.tone ? ` is-${esc(metric.tone)}` : '';
  return `<div class="record-metric${tone}">
    <span class="record-metric-label">${esc(metric.label)}</span>
    <strong class="record-metric-value">${esc(metric.value)}${metric.unit ? `<em>${esc(metric.unit)}</em>` : ''}</strong>
    ${metric.note ? `<span class="record-metric-note">${esc(metric.note)}</span>` : ''}
  </div>`;
}

function recordBarHtml(bar) {
  const value = Number(bar.value) || 0;
  const max = Number(bar.max) || 0;
  const percent = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  const tone = bar.tone ? ` is-${esc(bar.tone)}` : '';
  return `<div class="record-bar${tone}">
    <div class="record-bar-head">
      <span>${esc(bar.label)}</span>
      <strong>${value}/${max}</strong>
    </div>
    <div class="record-bar-track"><i style="width:${percent}%"></i></div>
    ${bar.note ? `<div class="record-bar-note">${esc(bar.note)}</div>` : ''}
  </div>`;
}

function recordItemHtml(item) {
  const tone = item.tone ? ` is-${esc(item.tone)}` : '';
  const stars = recordStarsHtml(item.stars, item.starsMax);
  const meta = (item.meta || []).filter(Boolean);
  const avatars = (item.avatars || []).filter(Boolean);
  return `<div class="record-item${tone}">
    <div class="record-item-main">
      <div class="record-item-title">${esc(item.title || '')}${stars}</div>
      ${item.subtitle ? `<div class="record-item-sub">${esc(item.subtitle)}</div>` : ''}
      ${
        meta.length
          ? `<div class="record-item-meta">${meta.map((tag) => `<span>${esc(tag)}</span>`).join('')}</div>`
          : ''
      }
    </div>
    ${
      avatars.length
        ? `<div class="record-item-avatars">${avatars.map(recordAvatarHtml).join('')}</div>`
        : ''
    }
  </div>`;
}

function recordSectionHtml(section) {
  const items = (section.items || []).filter(Boolean);
  if (!items.length) return '';
  return `<section class="record-section">
    <div class="record-section-head">
      <h2>${esc(section.title)}</h2>
      ${section.hint ? `<span>${esc(section.hint)}</span>` : ''}
    </div>
    <div class="record-section-body is-${esc(section.layout || 'rows')}">
      ${items.map(recordItemHtml).join('')}
    </div>
  </section>`;
}

function recordBodyHtml(view) {
  if (!view) {
    return `<div class="empty"><div class="empty-icon">${icon('alert')}</div><h3>数据格式不认识</h3>
      <p>解析器返回了空结果，可能是接口改版了。</p></div>`;
  }
  if (view.empty) {
    return `<div class="empty"><div class="empty-icon">${icon('info')}</div><h3>还没有数据</h3>
      <p>${esc(view.empty)}</p></div>`;
  }

  const hero = view.headline
    ? `<div class="record-hero">
        <span class="record-hero-label">${esc(view.headline.label)}</span>
        <strong class="record-hero-value">${esc(view.headline.value)}</strong>
        ${view.headline.note ? `<span class="record-hero-note">${esc(view.headline.note)}</span>` : ''}
      </div>`
    : '';

  const bars = (view.bars || []).length
    ? `<div class="record-bars">${view.bars.map(recordBarHtml).join('')}</div>`
    : '';

  const metrics = (view.metrics || []).length
    ? `<div class="record-metrics">${view.metrics.map(recordMetricHtml).join('')}</div>`
    : '';

  const sections = (view.sections || []).map(recordSectionHtml).join('');

  return `${hero}${bars}${metrics}${sections}`;
}

/* --------------------------- 页面主体 --------------------------- */

function recordTabsHtml(data, feature, game) {
  const matrix = data?.matrix || {};
  /*
   * 游戏栏永远列出「有战绩功能」的全部游戏，而不是只列支持当前功能的那些。
   * 理由是功能标签的集合本来就随游戏变（原神没有忘却之庭），如果游戏栏也跟着缩，
   * 用户点一下「深境螺旋」就只剩原神一个游戏，想换到星铁得先退回每日便笺，
   * 等于每次换游戏都要多走一步。留着四个游戏，切换时由 record-game 落回该游戏支持的功能。
   * data.matrix 是工具页的全量能力表（含抽卡、截图、画质、公告），
   * 不过滤就会把「这款游戏只有抽卡记录」也画成一个战绩标签。
   */
  const games = (data?.games || []).filter((item) => (matrix[item.key] || []).some((key) => RECORD_FEATURE_SET.has(key)));
  const roles = state.hoyolab?.['hoyolab-miyoushe']?.roles || [];
  const owned = new Set(roles.filter((role) => role?.uid).map((role) => role.game));

  const gameTabs = games
    .map((item) => {
      const active = item.key === game;
      return `<button class="record-tab${active ? ' is-active' : ''}" data-action="record-game" data-value="${esc(item.key)}">
        ${esc(item.name)}${owned.has(item.key) ? '<span class="record-tab-dot is-on"></span>' : ''}
      </button>`;
    })
    .join('');

  const features = (data?.features || []).filter(
    (item) => item.category === 'record' && (matrix[game] || []).includes(item.key),
  );
  const featureTabs = features
    .map((item) => {
      const active = item.key === feature;
      return `<button class="record-tab record-tab-feature${active ? ' is-active' : ''}" data-action="record-feature" data-value="${esc(item.key)}">
        ${esc(item.name)}
      </button>`;
    })
    .join('');

  const scheduleTabs = RECORD_SCHEDULE_FEATURES.includes(feature)
    ? `<span class="record-tabs-sep"></span>
       <button class="record-tab${state.record.schedule === 1 ? ' is-active' : ''}" data-action="record-schedule" data-value="1">本期</button>
       <button class="record-tab${state.record.schedule === 2 ? ' is-active' : ''}" data-action="record-schedule" data-value="2">上期</button>`
    : '';

  return `
    ${gameTabs ? `<div class="record-tabs record-tabs-game">${gameTabs}</div>` : ''}
    ${
      featureTabs || scheduleTabs
        ? `<div class="record-tabs record-tabs-feature">${featureTabs}${scheduleTabs}</div>`
        : ''
    }`;
}

function recordView() {
  const feature = state.record.feature;
  const game = state.record.game;
  const data = state.features;
  const status = state.hoyolab?.['hoyolab-miyoushe'];
  const role = recordRoleOf(game);
  const cache = state.record.cache[recordCacheKey(game, feature, state.record.schedule)] || null;
  const featureMeta = (data?.features || []).find((item) => item.key === feature) || {};
  const gameMeta = (data?.games || []).find((item) => item.key === game) || {};

  let body = '';
  if (status?.loading || (!status && data)) {
    body = `<div class="empty"><div class="empty-icon">${icon('login')}</div><h3>正在读取米游社登录状态</h3>
      <p>第一次打开战绩页会多等一会儿。</p></div>`;
  } else if (!status?.loggedIn) {
    body = `${hoyolabLoginCard()}
      <div class="record-hint">
        <p>${icon('info', 'xs')}战绩数据来自米游社公开的战绩接口，需要先登录一次；登录态会被保存，下次不用再扫。</p>
      </div>`;
  } else if (!role) {
    body = `<div class="empty"><div class="empty-icon">${icon('alert')}</div><h3>这个账号下没有${esc(gameMeta.name || '这个游戏')}的角色</h3>
      <p>换一个游戏看看，或者用另一个米游社账号登录。</p></div>`;
  } else if (cache?.loading) {
    body = `<div class="empty"><div class="empty-icon">${icon('refresh')}</div><h3>正在读取${esc(featureMeta.name || '战绩')}</h3>
      <p>${esc(role.nickname || '')}${role.uid ? ` · ${esc(role.uid)}` : ''}</p></div>`;
  } else if (cache?.error) {
    body = `<div class="empty"><div class="empty-icon">${icon('alert')}</div><h3>读取失败</h3>
      <p>${esc(cache.error)}</p>
      <p class="record-url">${esc(cache.url || '')}</p>
      <div class="record-error-actions">
        <button class="btn ghost" data-action="record-refresh">${icon('refresh', 'xs')}重试</button>
        ${
          cache.needVerify
            ? `<button class="btn ghost" data-action="record-open-web">${icon('external', 'xs')}打开官方战绩页</button>`
            : ''
        }
      </div></div>`;
  } else if (cache?.view) {
    body = recordBodyHtml(cache.view);
  } else {
    body = `<div class="empty"><div class="empty-icon">${icon('info')}</div><h3>还没有数据</h3>
      <p>点右侧「刷新」读一次。</p></div>`;
  }

  const rawJson = cache?.view?.raw
    ? JSON.stringify(cache.view.raw, null, 2)
    : cache?.view
      ? ''
      : '';

  return `<div class="page record-page">
    ${toolsBackBar()}
    <div class="page-head">
      <div>
        <div class="eyebrow">${PAGE_META.record.eyebrow}</div>
        <h1>战绩</h1>
        <p class="page-desc">${esc(featureMeta.desc || '米游社账号在各游戏里的实时进度与周期玩法成绩。')}</p>
      </div>
      <div class="record-head-actions">
        <button class="btn ghost" data-action="record-refresh">${icon('refresh', 'xs')}刷新</button>
      </div>
    </div>

    ${recordTabsHtml(data, feature, game)}

    ${recordAccountLineHtml()}
    ${recordRoleLineHtml(game, role, cache)}

    <div class="record-body">${body}</div>

    ${
      rawJson
        ? `<details class="record-raw">
            <summary>原始返回（排查字段用）</summary>
            <pre>${esc(rawJson)}</pre>
          </details>`
        : ''
    }
  </div>`;
}

/**
 * 非米游社的通行证登录卡片（鹰角 / 完美世界 / 库街区）。
 *
 * 每个 provider 一张卡，带真实的「打开登录」按钮 ——
 * 走 electron/passport-login.js 的统一网页登录通道。
 * 这几家官方都没有「列出我绑定的角色」接口，所以登录后只保存凭据，
 * 不假装能显示角色，避免用户登上了却看不到东西还以为坏了。
 */
function passportLoginCard(providerId, games) {
  const provider = state.features?.providers?.[providerId] || {};
  const status = state.passport?.[providerId];
  const label = provider.label || providerId;
  const gameNames = games
    .filter((game) => game.login && game.login.provider === providerId)
    .map((game) => game.name);
  const methodLabels = provider.methodLabels || [];
  const methodChips = methodLabels.map((text) => `<span>${esc(text)}</span>`).join('');

  /*
   * 卡片自己负责触发一次状态读取。
   * 之前靠在 enterRoute 里预先取，但首屏 state.features 还没回来后取不到 id 列表，
   * 结果卡片永远停在「读取中」。放在渲染路径里由卡片自己兜底就没有这个竞态。
   */
  if (!status) {
    refreshPassportStatus(providerId).then(() => {
      if (state.route === 'tools') render({ preserveScroll: true });
    });
  }
  const view = status || { loading: true };

  const stateChip = view.loading
    ? `<span class="miyo-state">读取中</span>`
    : view.loggedIn
      ? `<span class="miyo-state is-on">${icon('check', 'xs')}已登录</span>`
      : `<span class="miyo-state">未登录</span>`;

  const actions = view.loggedIn
    ? `<button class="btn ghost" data-action="passport-login" data-value="${esc(providerId)}">${icon('refresh', 'xs')}重新登录</button>
       <button class="btn ghost" data-action="passport-logout" data-value="${esc(providerId)}">退出</button>`
    : `<button class="btn accent" data-action="passport-login" data-value="${esc(providerId)}">${icon('link', 'xs')}打开${esc(label)}登录</button>`;

  /* 用实际支持的登录方式写描述，别给扫码没有的渠道吹「扫码」 */
  const mention = methodLabels.length ? methodLabels.join('、').replace(/登录/g, '') : '账号';
  const howTo = `在弹出窗口里用${mention}登录，登录完成会自动关闭并把凭据保存到本机。`;

  return `<div class="page glass-panel miyo-card miyo-alt">
    <div class="miyo-head">
      <div>
        <div class="eyebrow">${esc(String(providerId).toUpperCase())}</div>
        <h2>${esc(label)}</h2>
        ${gameNames.length ? `<p class="miyo-games">${gameNames.map((name) => `<span>${esc(name)}</span>`).join('')}</p>` : ''}
        <p class="page-desc">${esc(howTo)}</p>
      </div>
      <div class="miyo-actions">${stateChip}${actions}</div>
    </div>
    <div class="miyo-methods">
      ${methodChips}
      <em>登录态只保存在本机，不会上传</em>
    </div>
    ${
      view.loggedIn
        ? `<p class="miyo-hint">已保存登录凭据（${new Date(view.savedAt || Date.now()).toLocaleString('zh-CN')}）。${esc(label)}目前没有开放战绩查询接口，凭据会留给之后新增的功能使用。</p>`
        : ''
    }
    ${view.error ? `<p class="miyo-hint">${esc(view.error)}</p>` : ''}
  </div>`;
}

function otherLoginCards(games) {
  const providerIds = [
    ...new Set(
      games
        .filter((game) => game.login && game.login.provider !== 'miyoushe')
        .map((game) => game.login.provider)
    ),
  ].filter((id) => id !== 'hoyolab');
  if (!providerIds.length) return '';
  return providerIds.map((id) => passportLoginCard(id, games)).join('');
}

/** 当前选中渠道 + 上次选过的渠道；登录面板需要知道登完显示谁。 */
async function refreshPassportStatus(providerId, force = false) {
  state.passport = state.passport || {};
  if (!force && state.passport[providerId]) return state.passport[providerId];
  state.passport[providerId] = { loading: true };
  try {
    if (!window.launcher?.passport?.status) throw new Error('当前版本不支持通行证登录');
    const result = await window.launcher.passport.status({ provider: providerId });
    state.passport[providerId] = {
      loading: false,
      loggedIn: Boolean(result?.loggedIn),
      savedAt: result?.savedAt || 0,
      error: result?.reason || '',
    };
  } catch (error) {
    state.passport[providerId] = { loading: false, loggedIn: false, error: humanError(error) };
  }
  return state.passport[providerId];
}

async function doPassportLogin(providerId) {
  if (!window.launcher?.passport?.login) {
    toast('当前版本不支持通行证登录', 'error');
    return;
  }
  const label = state.features?.providers?.[providerId]?.label || providerId;
  toast(`已打开${label}登录窗口，扫码或输手机号即可`, 'info');
  try {
    const result = await window.launcher.passport.login({ provider: providerId });
    if (!result?.ok) {
      if (!result?.cancelled) toast(result?.reason || '登录失败', 'error');
      return;
    }
    state.passport = state.passport || {};
    state.passport[providerId] = {
      loading: false,
      loggedIn: true,
      savedAt: Date.now(),
    };
    toast(`${label}登录成功，凭据已保存到本机`, 'success');
    render({ preserveScroll: true });
  } catch (error) {
    toast(humanError(error) || '登录失败', 'error');
  }
}

async function doPassportLogout(providerId) {
  try {
    await window.launcher.passport.logout({ provider: providerId });
    state.passport = state.passport || {};
    state.passport[providerId] = { loading: false, loggedIn: false };
    toast('已退出登录', 'info');
    render({ preserveScroll: true });
  } catch (error) {
    toast(humanError(error) || '退出失败', 'error');
  }
}

/* ------------------------------------------------------------------ */
/* news                                                                */
/* ------------------------------------------------------------------ */

/* 动态页的分类：更新日志 / 使用指南。指南靠 tag 区分，其余都算版本更新。 */
const NEWS_TABS = [
  { key: 'all', label: '全部' },
  { key: 'release', label: '更新日志' },
  { key: 'guide', label: '使用指南' },
];

function isGuidePost(post) {
  return String(post && post.tag) === '指南';
}

function newsTabsMarkup() {
  const current = state.newsFilter || 'all';
  return `<div class="segmented nd-tabs">${NEWS_TABS.map(
    (tab) =>
      `<button type="button" class="${current === tab.key ? 'active' : ''}" data-action="news-tab" data-value="${tab.key}">${tab.label}</button>`
  ).join('')}</div>`;
}

/* 一条版本更新，做成左侧带版本章的时间线节点。最新的两条（当前大版本）高亮。 */
function newsTimelineItem(post, highlight) {
  const version = String(post.version || '').replace(/^v/i, '');
  return `
    <button class="nd-tl-item${highlight ? ' is-latest' : ''}" data-action="open-news" data-id="${esc(post.id)}">
      <span class="nd-tl-node">
        ${version ? `<strong>v${esc(version)}</strong>` : icon('news', 'xs')}
      </span>
      <span class="nd-tl-body">
        <span class="nd-tl-head">
          <h4>${esc(post.title)}</h4>
          <span class="nd-tl-date">${formatDate(post.date)}</span>
        </span>
        <p>${esc(post.excerpt || '')}</p>
        <span class="nd-tl-foot">
          <span class="nd-tl-tag">${esc(post.tag)}</span>
          ${post.readTime ? `<span class="nd-tl-read">${esc(post.readTime)} 阅读</span>` : ''}
          <span class="nd-tl-go">阅读全文 ${icon('chevron-right', 'xs')}</span>
        </span>
      </span>
    </button>`;
}

/* 更新日志默认只展开最新的几个版本，更早的折叠起来，避免长列表把使用指南挤下去。 */
const NEWS_VISIBLE_RELEASES = 2;

function newsTimeline(releases, opts = {}) {
  if (!releases.length) return '';
  // 最新的两个版本号点亮，提示「这就是你手里这一版」
  const latestIds = new Set(releases.slice(0, 2).map((item) => item.id));
  const collapsible = opts.collapsed && releases.length > NEWS_VISIBLE_RELEASES;
  const hiddenCount = releases.length - NEWS_VISIBLE_RELEASES;
  const shown = collapsible && !state.newsReleasesExpanded ? releases.slice(0, NEWS_VISIBLE_RELEASES) : releases;
  const isCollapsed = collapsible && !state.newsReleasesExpanded;
  const isExpanded = collapsible && state.newsReleasesExpanded;
  return `
    <div class="nd-timeline">
      ${shown.map((post) => newsTimelineItem(post, latestIds.has(post.id))).join('')}
    </div>
    ${
      isCollapsed
        ? `<button type="button" class="nd-more-btn" data-action="news-toggle-releases">${icon('chevron-down', 'xs')} 查看更早的 ${hiddenCount} 个版本</button>`
        : ''
    }
    ${
      isExpanded
        ? `<button type="button" class="nd-more-btn nd-more-btn--up" data-action="news-toggle-releases">${icon('chevron-up', 'xs')} 收起早期版本</button>`
        : ''
    }`;
}

function newsGuideGrid(guides) {
  if (!guides.length) return '';
  return `
    <div class="nd-guide-grid">
      ${guides
        .map(
          (post) => `
        <button class="nd-guide-card" data-action="open-news" data-id="${esc(post.id)}">
          <span class="nd-guide-icon">${icon('news')}</span>
          <span class="nd-guide-text">
            <h4>${esc(post.title)}</h4>
            <p>${esc(post.excerpt || '')}</p>
          </span>
          ${icon('chevron-right', 'xs')}
        </button>`
        )
        .join('')}
    </div>`;
}

function newsSectionHead(title, sub) {
  return `
    <div class="nd-section-head">
      <span class="nd-section-spark"></span>
      <div>
        <h3>${title}</h3>
        ${sub ? `<p>${sub}</p>` : ''}
      </div>
    </div>`;
}

/** 兜底大框：没有官方动态可置顶时，回落为原来的「最新发布帖」。 */
function newsFeatureRelease(feature) {
  return `
    <button class="news-feature" data-action="open-news" data-id="${esc(feature.id)}" style="text-align:left">
      <div class="news-feature-main">
        <span class="news-tag" style="align-self:flex-start">${esc(feature.tag)}</span>
        <h2>${esc(feature.title)}</h2>
        <p>${esc(feature.excerpt)}</p>
        <div class="news-feature-meta">
          <span>${formatDate(feature.date)}</span>
          <span style="width:2px;height:2px;border-radius:50%;background:currentColor"></span>
          <span>${esc(feature.readTime || '')}</span>
          <span style="margin-left:auto;color:var(--accent)">阅读全文 ${icon('chevron-right', 'xs')}</span>
        </div>
      </div>
      <div class="news-feature-art" aria-hidden="true">
        ${
          feature.image
            ? `<img src="${esc(feature.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
            : `<svg class="glyph" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="52" />
          <circle cx="60" cy="60" r="34" opacity=".55" />
          <path d="M60 8v104M8 60h104" opacity=".35" />
          <path d="M60 26c6 22 12 28 34 34-22 6-28 12-34 34-6-22-12-28-34-34 22-6 28-12 34-34Z" />
        </svg>`
        }
      </div>
    </button>`;
}

/** 公告条目上要挂的游戏点缀色内联变量；accent 缺省时不输出，CSS 回落 var(--accent)。 */
function noticeAccentStyle(game, extra = '') {
  const accent = String(game?.accent || '').trim();
  const parts = [extra.replace(/;\s*$/, ''), accent ? `--notice-accent:${accent}` : ''].filter(Boolean);
  return parts.length ? ` style="${esc(parts.join(';'))}"` : '';
}

/** 置顶行列表的同步骨架。 */
function newsPinnedSkeletonList() {
  return `
    <div class="news-pinned-list">
      <div class="news-pinned-row news-pinned-row--skeleton"><span class="notice-skeleton"></span><span class="notice-skeleton short"></span></div>
      <div class="news-pinned-row news-pinned-row--skeleton"><span class="notice-skeleton"></span><span class="notice-skeleton short"></span></div>
    </div>`;
}

/**
 * 大框轮换池：最新 8 条里按「公告 > 活动 > 资讯」排（同类型按时间新→旧）。
 * 只在最近 8 条里挑，不全文扫 —— 池子稳定，翻页键的位置不会因为
 * 远处一条旧公告突然插队而跳。
 */
function noticeFeaturePool(entries) {
  const priority = { 公告: 0, 活动: 1, 资讯: 2 };
  return entries
    .slice(0, 8)
    .sort((a, b) => {
      const pa = priority[noticeTypeLabel(a.notice)] ?? 3;
      const pb = priority[noticeTypeLabel(b.notice)] ?? 3;
      if (pa !== pb) return pa - pb;
      return noticeSortTime(b.notice) - noticeSortTime(a.notice);
    });
}

/** 置顶区：最新官方动态大框 + 置顶动态行列表。 */
function newsPinnedMarkup(entries) {
  /*
   * 大框不再是「只有最新那一条」：公告一多，最新那条常常是条无关的资讯，
   * 真正要看的版本更新 / 活动公告被压在列表里。这里把最近 8 条拎出来，
   * 按「公告 > 活动 > 资讯」稳定排一遍（同类型仍按时间），
   * 大框只在池子里轮，配上一组首页式翻页键。
   */
  const pool = noticeFeaturePool(entries);
  const total = pool.length;
  const index = total ? Math.min(Math.max(state.newsFeatureIndex || 0, 0), total - 1) : 0;
  const head = pool[index] || entries[0];
  const { notice, game } = head;
  const typeLabel = noticeTypeLabel(notice);
  const cover = game.startCoverUrl || game.coverUrl || '';
  // 动态页做减法：置顶行列表只留 3 条，再往下都是折叠区，避免"滑不停"
  const rest = entries.filter((entry) => entry !== head).slice(0, 3);
  const nav =
    total > 1
      ? `<span class="news-feature-nav">
          <button class="news-feature-step" data-action="news-feature-prev" title="上一条公告" aria-label="上一条公告">${icon('chevron-left', 'xs')}</button>
          <span class="news-feature-pos"><strong>${index + 1}</strong> / ${total}</span>
          <button class="news-feature-step" data-action="news-feature-next" title="下一条公告" aria-label="下一条公告">${icon('chevron-right', 'xs')}</button>
        </span>`
      : '';
  return `
    <div class="news-pinned">
      ${
        state.noticeBoardError
          ? `<div class="notice-error">${icon('info', 'xs')} ${esc(state.noticeBoardError)}</div>`
          : ''
      }
      <div class="news-feature-wrap">
      <button class="news-feature news-feature--notice" data-action="open-external" data-url="${esc(notice.link)}"${noticeAccentStyle(game, 'text-align:left')} title="${esc(notice.title)}">
        <div class="news-feature-main">
          <span class="news-pinned-tags">
            <span class="news-pinned-game">${esc(game.name)}</span>
            ${typeLabel ? `<span class="news-pinned-type">${esc(typeLabel)}</span>` : ''}
          </span>
          <h2>${esc(notice.title)}</h2>
          <div class="news-feature-meta">
            <span>${esc(game.name)}</span>
            <span style="width:2px;height:2px;border-radius:50%;background:currentColor"></span>
            <span>${esc(noticeDate(notice.date) || '官方')}</span>
            <span style="width:2px;height:2px;border-radius:50%;background:currentColor"></span>
            <span>官方</span>
            <span style="margin-left:auto;color:var(--notice-accent, var(--accent))">阅读原文 ${icon('chevron-right', 'xs')}</span>
          </div>
        </div>
        <div class="news-feature-art" aria-hidden="true">
          ${
            cover
              ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
              : `<svg class="glyph" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="52" />
            <circle cx="60" cy="60" r="34" opacity=".55" />
            <path d="M60 8v104M8 60h104" opacity=".35" />
            <path d="M60 26c6 22 12 28 34 34-22 6-28 12-34 34-6-22-12-28-34-34 22-6 28-12 34-34Z" />
          </svg>`
          }
        </div>
      </button>
      ${nav}
      </div>
      ${
        rest.length
          ? `<div class="news-pinned-list">
              ${rest
                .map(
                  (entry, index) => `
                <button class="notice-item news-pinned-row" data-action="open-external" data-url="${esc(entry.notice.link)}"${noticeAccentStyle(entry.game)} title="${esc(entry.notice.title)}">
                  <span class="notice-item-dot"></span>
                  <span class="news-pinned-chip">${esc(entry.game.name)}</span>
                  ${noticeTypeLabel(entry.notice) ? `<span class="news-pinned-type">${esc(noticeTypeLabel(entry.notice))}</span>` : ''}
                  <span class="news-pinned-title"><strong>${esc(entry.notice.title)}</strong></span>
                  <span class="news-pinned-date">${esc(noticeDate(entry.notice.date) || '官方')}</span>
                  ${index < 2 ? `<span class="news-pinned-badge">置顶</span>` : ''}
                  ${icon('external', 'xs')}
                </button>`
                )
                .join('')}
            </div>`
          : state.noticeBoardLoading
            ? newsPinnedSkeletonList()
            : ''
      }
    </div>`;
}

function newsView() {
  if (!state.news.length) {
    return `<div class="page"><div class="page-head"><div><div class="eyebrow">${PAGE_META.news.eyebrow}</div><h1>动态</h1></div></div><div class="empty"><div class="empty-icon">${icon('news')}</div><h3>暂时没有内容</h3><p>稍后再来看看。</p></div></div>`;
  }
  const filter = state.newsFilter || 'all';
  const releases = state.news.filter((post) => !isGuidePost(post));
  const guides = state.news.filter(isGuidePost);
  const feature = releases[0];

  let body = '';
  if (filter === 'guide') {
    body = newsGuideGrid(guides);
  } else if (filter === 'release') {
    body = newsTimeline(releases, { collapsed: true }) + newsUpdateSection();
  } else {
    const entries = noticeEntries();
    body = `
      ${
        entries.length
          ? newsPinnedMarkup(entries)
          : newsFeatureRelease(feature) + (state.noticeBoardLoading ? newsPinnedSkeletonList() : '')
      }
      ${newsNoticeSection()}
      ${newsSectionHead('使用指南', '上手、各页面与设置开关，点开看详情')}
      ${newsGuideGrid(guides)}
      ${newsSectionHead('版本更新日志', '每一版改了什么，旧版本可展开')}
      ${newsTimeline(releases.slice(1), { collapsed: true })}`;
  }

  return `
    <div class="page nd-page">
      <div class="page-head nd-head">
        <div>
          <div class="eyebrow">${PAGE_META.news.eyebrow}</div>
          <h1>动态</h1>
          <p class="sub">各游戏官方公告置顶更新，往下是公告面板、使用指南和版本更新日志。</p>
        </div>
        ${newsTabsMarkup()}
      </div>
      ${body}
    </div>`;
}

/**
 * 动态页上的「更新公告」：最新一版改了什么。
 * 原来是设置页里软更新面板下的一小段，移到这里后设置页更短，
 * 更新内容也和新版资讯放在一起看更顺。
 */
function newsUpdateSection() {
  const notes = state.update && state.update.notes;
  if (!notes || !notes.length) return '';
  return `
    <section class="news-update">
      <div class="section-head">
        <div>
          <h3>${icon('download', 'xs')}这一版改了什么 · v${esc(state.update.latest)}</h3>
          <p>最近一次更新到这里的内容</p>
        </div>
      </div>
      <div class="update-notes">${notesMarkup(notes)}</div>
    </section>`;
}


/**
 * 动态页的「各游戏动态面板」：想按游戏浏览全量公告时展开。
 * 默认折叠成一行——置顶区已经露出最新动态，全量卡片只在需要时打开，
 * 不然整页要滑很久。
 */
function newsNoticeSection() {
  const games = state.games.filter((game) => game.builtinKey);
  if (!games.length) return '';
  const updated = state.noticeBoardUpdatedAt
    ? `同步于 ${new Date(state.noticeBoardUpdatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : '等待首次同步';
  return `
    <details class="news-notices-box">
      <summary>
        <span class="news-notices-summary-main">${icon('news', 'xs')} 各游戏公告 · ${games.length} 款游戏</span>
        <span class="news-notices-summary-side">${esc(updated)} · 展开按游戏浏览 ${icon('chevron-down', 'xs')}</span>
      </summary>
      <div class="news-notices-body">
        ${
          state.noticeBoardError
            ? `<div class="notice-error">${icon('info', 'xs')} ${esc(state.noticeBoardError)}</div>`
            : ''
        }
        <div class="news-notice-actions">
          <span class="notice-sync-status"><span class="notice-sync-dot"></span>${esc(updated)} · 每 10 分钟自动同步</span>
          <button class="link-btn" data-action="refresh-notices" ${state.noticeBoardLoading ? 'disabled' : ''}>
            ${icon('refresh', 'xs')}${state.noticeBoardLoading ? '同步中' : '刷新'}
          </button>
        </div>
        <div class="notice-grid compact">${games.map((game) => noticeGameCard(game)).join('')}</div>
        <p class="notice-footnote">公告来自各游戏官方网站，仅作浏览入口；内容与时间以官方页面为准。</p>
      </div>
    </details>`;
}
/* ------------------------------------------------------------------ */
/* official announcements                                              */
/* ------------------------------------------------------------------ */

const NOTICE_SITES = {
  genshin: 'https://ys.mihoyo.com/',
  starrail: 'https://sr.mihoyo.com/',
  zzz: 'https://zzz.mihoyo.com/',
  endfield: 'https://endfield.hypergryph.com/',
  neverness: 'https://yh.wanmei.com/',
};

const NOTICE_TYPE_LABELS = {
  POST_TYPE_ANNOUNCE: '公告',
  POST_TYPE_ACTIVITY: '活动',
  POST_TYPE_INFO: '资讯',
  POST_TYPE_POST: '资讯',
};

function noticeDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (match) {
    return `${match[1]}.${String(match[2]).padStart(2, '0')}.${String(match[3]).padStart(2, '0')}`;
  }
  const timestamp = Number(text);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const date = new Date(timestamp < 10000000000 ? timestamp * 1000 : timestamp);
    if (!Number.isNaN(date.getTime())) {
      return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
    }
  }
  return '';
}

function noticeMeta(notice) {
  const date = noticeDate(notice.date);
  if (date) return date;
  const type = String(notice.type || '').trim();
  return NOTICE_TYPE_LABELS[type] || (type && !type.startsWith('POST_TYPE_') ? type : '官方公告');
}

/** 公告的类型中文标签：POST_TYPE_* 走映射表，主进程已翻成中文的直接用。 */
function noticeTypeLabel(notice) {
  const type = String(notice?.type || '').trim();
  return NOTICE_TYPE_LABELS[type] || (type && !type.startsWith('POST_TYPE_') ? type : '');
}

/** 公告可排序时间戳：date 形如 YYYY-MM-DD / YYYY.MM.DD；解析不出返回 0（排最后）。 */
function noticeSortTime(notice) {
  const match = String(notice?.date || '').match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (!match) return 0;
  const time = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** 把 noticeBoard 摊平成带游戏信息的公告条目，按日期倒序（缺日期排最后）。 */
function noticeEntries() {
  const entries = [];
  for (const game of state.games.filter((item) => item.builtinKey)) {
    const notices = Array.isArray(state.noticeBoard[game.builtinKey]) ? state.noticeBoard[game.builtinKey] : [];
    for (const notice of notices) {
      if (notice?.title && notice?.link) entries.push({ notice, game });
    }
  }
  return entries.sort((a, b) => noticeSortTime(b.notice) - noticeSortTime(a.notice));
}

function noticeSite(game) {
  const value = String(game?.siteUrl || '');
  if (/^https?:\/\//i.test(value)) return value;
  return NOTICE_SITES[game?.builtinKey] || '';
}

function noticeGameCard(game) {
  const notices = Array.isArray(state.noticeBoard[game.builtinKey]) ? state.noticeBoard[game.builtinKey] : [];
  const site = noticeSite(game);
  const items = notices.slice(0, 5);
  return `
    <article class="notice-card" style="--notice-accent: ${esc(game.accent || 'var(--accent)')}">
      <div class="notice-card-head">
        <span class="notice-card-icon">${icon('news')}</span>
        <div class="notice-card-title">
          <h3>${esc(game.name)}</h3>
          <span>${game.builtinKey === 'neverness' ? '官方公告' : '官方最新'}</span>
        </div>
        <span class="notice-card-count">${state.noticeBoardLoading && !notices.length ? '···' : String(notices.length).padStart(2, '0')}</span>
      </div>
      ${
        items.length
          ? `<div class="notice-list">${items
              .map(
                (notice) => `
              <button class="notice-item" data-action="open-external" data-url="${esc(notice.link)}" title="${esc(notice.title)}">
                <span class="notice-item-dot"></span>
                <span class="notice-item-text">
                  <strong>${esc(notice.title)}</strong>
                  <small>${esc(noticeMeta(notice))}</small>
                </span>
                ${icon('external', 'xs')}
              </button>`
              )
              .join('')}</div>`
          : `<div class="notice-card-empty">${
              state.noticeBoardLoading
                ? '<span class="notice-skeleton"></span><span class="notice-skeleton short"></span><span class="notice-skeleton"></span>'
                : '暂时没有读取到公告'
            }</div>`
      }
      <div class="notice-card-foot">
        <span>${items.length ? `显示最近 ${items.length} 条` : '等待官方站点'}</span>
        ${
          site
            ? `<button class="link-btn" data-action="open-external" data-url="${esc(site)}">前往官网 ${icon('external', 'xs')}</button>`
            : ''
        }
      </div>
    </article>`;
}

function announcementsView() {
  const games = state.games.filter((game) => game.builtinKey);
  const updated = state.noticeBoardUpdatedAt
    ? `更新于 ${new Date(state.noticeBoardUpdatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : '等待首次同步';
  return `
    <div class="page">
      <div class="page-head notice-page-head">
        <div>
          <div class="eyebrow">${PAGE_META.announcements.eyebrow}</div>
          <h1>官方公告</h1>
          <p class="sub">自动同步各游戏官网的最新公告，每 10 分钟更新一次。</p>
        </div>
        <div class="notice-page-actions">
          <span class="notice-sync-status"><span class="notice-sync-dot"></span>${updated} · 自动更新</span>
          <button class="btn btn-ghost" data-action="refresh-notices" ${state.noticeBoardLoading ? 'disabled' : ''}>
            ${icon('refresh')}${state.noticeBoardLoading ? '同步中' : '刷新'}
          </button>
        </div>
      </div>
      ${
        state.noticeBoardError
          ? `<div class="notice-error">${icon('info', 'xs')} ${esc(state.noticeBoardError)}</div>`
          : ''
      }
      ${
        games.length
          ? `<div class="notice-grid">${games.map((game) => noticeGameCard(game)).join('')}</div>`
          : `<div class="empty"><div class="empty-icon">${icon('info')}</div><h3>还没有内置游戏</h3><p>添加游戏后，这里会显示对应的官方公告。</p></div>`
      }
      <p class="notice-footnote">公告来自各游戏官方网站，仅作浏览入口；内容与时间以官方页面为准。</p>
    </div>`;
}

async function loadNoticeBoard(force = false) {
  if (state.noticeBoardLoading) return;
  state.noticeBoardLoading = true;
  state.noticeBoardError = '';
  if (state.route === 'news') render({ preserveScroll: true });
  try {
    if (typeof api.allGameNotices !== 'function') throw new Error('当前版本不支持公告同步');
    const payload = await api.allGameNotices(force);
    if (payload && typeof payload === 'object') {
      state.noticeBoard = { ...state.noticeBoard, ...payload };
      state.noticeBoardUpdatedAt = Date.now();
      // 数据换了，页码跟着归位：新公告永远从第一条看起
      state.newsFeatureIndex = 0;
    }
  } catch (error) {
    state.noticeBoardError = error?.message || '官方公告同步失败';
  } finally {
    state.noticeBoardLoading = false;
    if (state.route === 'news') render({ preserveScroll: true });
  }
}

function startNoticeBoardTimer() {
  stopNoticeBoardTimer();
  noticeBoardTimer = window.setInterval(() => loadNoticeBoard(true), 10 * 60 * 1000);
}

function stopNoticeBoardTimer() {
  if (noticeBoardTimer) {
    window.clearInterval(noticeBoardTimer);
    noticeBoardTimer = null;
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function switchMarkup(key, value) {
  return `<button class="switch ${value ? 'on' : ''}" role="switch" aria-checked="${Boolean(value)}" data-action="toggle-setting" data-key="${key}" title="${value ? '关闭' : '开启'}"></button>`;
}

function soundSwitchMarkup(key, value) {
  return `<button class="switch ${value ? 'on' : ''}" role="switch" aria-checked="${Boolean(value)}" data-action="toggle-sound" data-key="${key}" title="${value ? '关闭' : '开启'}"></button>`;
}

/**
 * 就地刷新一个开关的视觉和语义状态。
 *
 * 以前点开关走的是「改状态 → 等主进程回推 state → onState 整页 innerHTML 重绘」：
 * 重绘出来的按钮从出生起就是新状态，CSS transition 没有起点，滑块只会瞬移，
 * 用户看着就是「点了没反应」。这里改成直接在原节点上切 on / aria-checked，
 * 位移过渡才真的跑得起来。
 */
function paintSwitch(element, on) {
  if (!element) return;
  const next = Boolean(on);
  element.classList.toggle('on', next);
  element.setAttribute('aria-checked', next ? 'true' : 'false');
  element.title = next ? '关闭' : '开启';
}

/** 同一个开关可能在界面上出现两处（设置页 / 点歌台），一起就地刷新。 */
function paintSwitches(action, on) {
  document.querySelectorAll(`[data-action="${action}"]`).forEach((node) => paintSwitch(node, on));
}

/** 设置对象的内容指纹：键名排序后再比，免得两边插入顺序不同就对不上。 */
function settingsSignature(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return JSON.stringify(Object.keys(source).sort().map((key) => [key, source[key]]));
}

/*
 * 开关就地改完之后，主进程会回推一份内容相同的设置。那份回推如果触发整页
 * 重绘，刚跑起来的滑块动画会被掐断（新节点一出生就是终态），所以这里先记下
 * 「这份设置是我自己改的」，onState 收到就用不着重绘了。
 */
let settingsEcho = null;

function expectSettingsEcho(settings) {
  settingsEcho = { signature: settingsSignature(settings), at: Date.now() };
}

function consumeSettingsEcho(settings) {
  if (!settingsEcho) return false;
  // 过期了就丢掉，别让一次登记长期压着重绘
  if (Date.now() - settingsEcho.at >= 4000) {
    settingsEcho = null;
    return false;
  }
  // 不是这次的回推（例如下载进度的例行推送）：指纹留着，等真正那份回来
  if (settingsEcho.signature !== settingsSignature(settings)) return false;
  settingsEcho = null;
  return true;
}

/** 真正落地一个缩放比例：写设置、写本地记忆、通知主进程。 */
async function setUiScale(value, options = {}) {
  const scale = normalizeUiScale(value);
  state.settings.uiScale = scale;
  try {
    localStorage.setItem('vela:ui-scale', String(scale));
  } catch {
    /* 可选本地记忆 */
  }
  applyUiScaleClass(scale);
  if (typeof api.setUiScale === 'function') {
    await api.setUiScale(scale).catch(() => {});
  }
  if (options.render !== false) render({ preserveScroll: true });
  if (options.toast !== false) toast(`界面已缩放到 ${scale}%`, 'success');
  return scale;
}

/** 往上一个 / 下一个档位走。 */
function stepUiScale(direction) {
  const current = currentUiScale();
  const up = direction > 0;
  const next = up
    ? UI_SCALE_STEPS.find((step) => step > current)
    : [...UI_SCALE_STEPS].reverse().find((step) => step < current);
  if (!next) return;
  setUiScale(next);
}

/* 主题 / 强调色的候选值：界面渲染和点击校验共用同一份，
 * 免得两边列表不一致时出现「点得动但存不进去」。 */
const THEME_OPTIONS = [
  ['dark', '深色'],
  ['light', '浅色'],
  ['system', '跟随系统'],
];
const ACCENT_OPTIONS = [
  ['spark', '花火', '#e8435a'],
  ['gold', '金箔', '#f0c674'],
  ['sakura', '夜樱', '#f29ab2'],
  ['cyan', '青焰', '#6fe0d2'],
  ['rose', '玫瑰', '#f08ba6'],
  ['jade', '翡翠', '#5fd3a4'],
  ['violet', '紫罗兰', '#a98bf5'],
  ['amber', '琥珀', '#f5a35c'],
];

/* 设置页分组：左侧导航 + 右侧只渲染当前分组，避免一长条往下翻 */
const SETTINGS_TABS = [
  ['appearance', '外观', 'sparkle', '主题、强调色、称呼、头像和界面缩放'],
  ['window', '窗口', 'image', '窗口材质、自定义背景与透明度'],
  ['sound', '音效', 'volume', '界面反馈音、试听与音乐行为'],
  ['behavior', '行为', 'settings', '托盘、开机自启与自动同步'],
  ['storage', '存储', 'folder-open', '下载目录、运行时与终末地渠道包'],
  ['update', '更新', 'download', '更新源、自动检查与手动更新'],
  ['community', '社区', 'link', '项目主页、发布页与问题反馈'],
  ['about', '关于', 'info', '版本信息与相关链接'],
];

/** 把 process.platform 翻成人看的名字，写进反馈用的那段环境信息里。 */
function platformText() {
  const key = String((state.app && state.app.platform) || '').toLowerCase();
  const map = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  return map[key] || key || '未知';
}

function settingsTab() {
  let key = state.settingsTab;
  if (!key) {
    try {
      key = localStorage.getItem('vela:settings-tab') || '';
    } catch (error) {
      key = '';
    }
  }
  return SETTINGS_TABS.some((tab) => tab[0] === key) ? key : 'appearance';
}

/*
 * 米哈游系游戏（原神 / 星穹铁道 / 绝区零 / 崩坏3）的语音包语言，顺序固定
 * （和 electron/sophon.js 的 AUDIO_LANGUAGES 一致）。每种配音都要好几个 GB，
 * 默认只要中文，想听其它配音再勾。
 * 注意：终末地不适用这项设置——它的语音在 Unity bundle 里，官方清单没给可裁剪
 * 粒度（实测 EndOfficial 清单 1688 个文件 / 63.58GB 全是 VFS .chk），只能整包下载。
 */
const AUDIO_LANGUAGE_LABELS = [
  ['zh-cn', '中文'],
  ['en-us', '英语'],
  ['ja-jp', '日语'],
  ['ko-kr', '韩语'],
];

function audioLanguagesOf() {
  const raw = state.settings?.audioLanguages;
  const list = Array.isArray(raw) ? raw.map((item) => String(item || '').toLowerCase()) : [];
  const picked = AUDIO_LANGUAGE_LABELS.map(([key]) => key).filter((key) => list.includes(key));
  // 没勾过或勾了不认识的，退回只要中文
  return picked.length ? picked : ['zh-cn'];
}

function settingsView() {
  const settings = state.settings;
  const demos = state.games.filter((g) => g.demo).length;
  const themeOptions = THEME_OPTIONS;
  const accents = ACCENT_OPTIONS;
  const tab = settingsTab();
  const group = (key, span) =>
    `settings-panel${key === tab ? ' is-active' : ''}${span ? ' settings-span' : ''}`;
  const groupAttr = (key) => `data-settings-group="${key}"`;
  const activeMeta = SETTINGS_TABS.find((item) => item[0] === tab) || SETTINGS_TABS[0];
  return `
    <div class="page page-settings">
      <div class="page-head">
        <div>
          <div class="eyebrow">${PAGE_META.settings.eyebrow}</div>
          <h1>设置</h1>
          <p class="sub">常用设置集中在这里，修改后立即保存。</p>
        </div>
      </div>
      <div class="settings-shell">
        <nav class="settings-nav" aria-label="设置分组">
          ${SETTINGS_TABS.map(
            ([key, label, ico]) =>
              `<button class="settings-nav-item ${key === tab ? 'active' : ''}" data-action="settings-tab" data-value="${key}" title="${label}">
                 ${icon(ico)}<span>${label}</span>
               </button>`
          ).join('')}
          <p class="settings-nav-hint">${activeMeta[3]}</p>
        </nav>
        <div class="settings-grid">
        <section class="${group('appearance')}" ${groupAttr('appearance')}>
          <h2>${icon('sparkle')}外观</h2>
          <p class="desc">主题、强调色和个人称呼。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>界面主题</strong><span>深色适合夜晚，浅色更适合白天。</span></div>
            <div class="setting-control">
              <div class="segmented">
                ${themeOptions
                  .map(
                    ([key, label]) =>
                      `<button class="${settings.theme === key ? 'active' : ''}" data-action="set-theme" data-value="${key}">${label}</button>`
                  )
                  .join('')}
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>强调色</strong><span>只出现在按钮、进度和少量细节上。</span></div>
            <div class="setting-control">
              <div class="swatches">
                ${accents
                  .map(
                    ([key, label, color]) =>
                      `<button class="swatch ${settings.accent === key ? 'active' : ''}" style="--swatch:${color}" data-action="set-accent" data-value="${key}" title="${label}" aria-label="${label}"></button>`
                  )
                  .join('')}
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>你的称呼</strong><span>显示在主页问候和左下角的个人资料中，也可以直接输入自定义称呼。</span></div>
            <div class="setting-control" style="flex-direction:column;align-items:flex-end;gap:6px">
              <input class="text-input" id="profile-name-input" maxlength="24" value="${esc(settings.profileName || '大小姐')}" style="width:150px" spellcheck="false" />
              <div class="salutation-chips">
                <button class="mini-chip ${settings.profileName === '大小姐' ? 'active' : ''}" data-action="set-salutation" data-value="大小姐">大小姐</button>
                <button class="mini-chip ${settings.profileName === '主人' ? 'active' : ''}" data-action="set-salutation" data-value="主人">主人</button>
                <button class="mini-chip ${settings.profileName === '大少爷' ? 'active' : ''}" data-action="set-salutation" data-value="大少爷">大少爷</button>
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>头像</strong><span>显示在左下角的个人资料中。支持 PNG、JPG、WebP、GIF 和 SVG。</span></div>
            <div class="setting-control">
              <span class="avatar avatar-preview">${avatarContent(settings)}</span>
              <button class="btn btn-ghost" data-action="change-avatar">${icon('image')}更换</button>
              ${settings.avatar ? `<button class="btn btn-quiet" data-action="reset-avatar">恢复默认</button>` : ''}
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>页面装饰挂饰</strong><span>在启动页以外的页面，角落悬挂花火狐面、火花礼帽，并漂浮烟花 / 火焰 / 星空小精灵。</span></div>
            <div class="setting-control">
              <button class="switch ${state.settings.charms !== false ? 'on' : ''}" role="switch" aria-checked="${state.settings.charms !== false}" data-action="toggle-charms" title="${state.settings.charms !== false ? '关闭' : '开启'}"></button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>角色背景水印</strong><span>在页面右下角铺一层淡淡的火花角色立绘水印，很淡、不挡阅读；可单独关闭。</span></div>
            <div class="setting-control">
              <button class="switch ${state.settings.charBg !== false ? 'on' : ''}" role="switch" aria-checked="${state.settings.charBg !== false}" data-action="toggle-charbg" title="${state.settings.charBg !== false ? '关闭' : '开启'}"></button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>侧栏立绘</strong><span>展开侧栏时，底部显示火花立绘。关掉后这一块不占高度，导航能一次显示更多项，不用滚。</span></div>
            <div class="setting-control">
              <button class="switch ${state.settings.sidebarChar !== false ? 'on' : ''}" role="switch" aria-checked="${state.settings.sidebarChar !== false}" data-action="toggle-sidebar-char" title="${state.settings.sidebarChar !== false ? '关闭' : '开启'}"></button>
            </div>
          </div>
        </section>

        <section class="${group('window', true)} material-panel" ${groupAttr('window')}>
          <h2>${icon('sparkle')}窗口材质与背景</h2>
          <p class="desc">复用系统合成层，或铺一张自己的背景图。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>窗口材质</strong><span>亚克力 / 云母需要 Windows 11 并开启「透明效果」；云母会自动关掉半透明底色。</span></div>
            <div class="setting-control">
              <div class="segmented">
                ${MATERIAL_OPTIONS.map(
                  (key) =>
                    `<button class="${(settings.material || 'none') === key ? 'active' : ''}" data-action="set-material" data-value="${key}">${MATERIAL_LABEL[key]}</button>`
                ).join('')}
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自定义背景</strong><span>PNG / JPG / WebP / GIF，最大 40 MB，铺在内容下面。</span></div>
            <div class="setting-control">
              ${
                settings.customBackground
                  ? `<span class="bg-preview" style="background-image:url('${esc(toFileUrl(settings.customBackground) || '')}')"></span>`
                  : ''
              }
              <button class="btn btn-ghost" data-action="pick-background">${icon('image')}${settings.customBackground ? '更换' : '选择图片'}</button>
              ${settings.customBackground ? `<button class="btn btn-quiet" data-action="reset-background">移除</button>` : ''}
            </div>
          </div>
          <div class="setting-row-pair">
            <div class="setting-row">
              <div class="setting-copy"><strong>背景不透明度</strong><span>调低后背景变淡，能看见更多窗口材质。</span></div>
              <div class="setting-control volume-control">
                <input class="volume-range" id="bg-opacity" type="range" min="0" max="100" step="1" value="${Number(settings.backgroundOpacity ?? 100)}" aria-label="背景不透明度" ${settings.customBackground ? '' : 'disabled'} />
                <span class="volume-value" id="bg-opacity-value">${Number(settings.backgroundOpacity ?? 100)}%</span>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-copy"><strong>背景清晰度</strong><span>往左越模糊，画面花的时候文字更好读。</span></div>
              <div class="setting-control volume-control">
                <input class="volume-range" id="bg-blur" type="range" min="0" max="60" step="1" value="${100 - Number(settings.backgroundBlur ?? 0)}" aria-label="背景清晰度" ${settings.customBackground ? '' : 'disabled'} />
                <span class="volume-value" id="bg-blur-value">${Number(settings.backgroundBlur ?? 0) ? `模糊 ${Number(settings.backgroundBlur)}` : '原图'}</span>
              </div>
            </div>
          </div>
          <p class="material-note">${icon('alert', 'xs')}「透明效果」在 设置 → 个性化 → 颜色；关掉后所有材质失效。</p>
        </section>

        <section class="${group('appearance')} ui-scale-panel" ${groupAttr('appearance')}>
          <h2>${icon('type')}界面缩放</h2>
          <p class="desc">调整整个启动器的字号和布局大小，适配不同分辨率的屏幕。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>缩放比例</strong><span>100% 是默认大小。放大后所有文字、按钮和图标一起等比变化，不会错位。</span></div>
            <div class="setting-control ui-scale-control">
              <div class="segmented ui-scale-steps">
                ${UI_SCALE_STEPS.map(
                  (step) =>
                    `<button class="${currentUiScale() === step ? 'active' : ''}" data-action="set-ui-scale" data-value="${step}">${step}%</button>`
                ).join('')}
              </div>
              <span class="volume-value" id="ui-scale-value">${currentUiScale()}%</span>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>预览</strong><span>下面这段文字会跟着缩放一起变化，方便确认大小是否合适。</span></div>
            <div class="setting-control ui-scale-preview">
              <span class="ui-scale-sample">Aaa 大小姐 1234</span>
            </div>
          </div>
        </section>

        <section class="${group('sound')} sound-settings-panel" ${groupAttr('sound')}>
          <h2>${icon('volume')}界面音效</h2>
          <p class="desc">按钮、导航和通知的反馈音，独立于歌曲音量；歌曲音量与 3D 音效在音乐页里调整。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>界面音效</strong><span>按钮、导航和开关操作时播放轻量反馈音；关闭后完全静音。</span></div>
            <div class="setting-control">${soundSwitchMarkup('enabled', state.sound.enabled)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>界面音量</strong><span>只影响点击、通知和启动提示音，不会改变歌曲音量。</span></div>
            <div class="setting-control volume-control">
              <input class="volume-range" id="sound-volume" type="range" min="0" max="100" step="1" value="${state.sound.volume}" aria-label="界面音效音量" />
              <span class="volume-value" id="sound-volume-value">${state.sound.volume}%</span>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>点击音效</strong><span>打开页面、按钮和切换开关时发出的短音。</span></div>
            <div class="setting-control">${soundSwitchMarkup('click', state.sound.click)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>通知音效</strong><span>成功、失败和系统消息弹出时播放的双音提示。</span></div>
            <div class="setting-control">${soundSwitchMarkup('notify', state.sound.notify)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>启动游戏音效</strong><span>游戏真正开始启动时播放的上升音；启动失败不会播放。</span></div>
            <div class="setting-control">${soundSwitchMarkup('launch', state.sound.launch)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>试听</strong><span>用当前音量预览三种音效。</span></div>
            <div class="setting-control sound-preview">
              <button class="btn btn-quiet" data-action="preview-sound" data-value="click" data-no-sound ${state.sound.enabled ? '' : 'disabled'}>点击</button>
              <button class="btn btn-quiet" data-action="preview-sound" data-value="notify" data-no-sound ${state.sound.enabled ? '' : 'disabled'}>通知</button>
              <button class="btn btn-quiet" data-action="preview-sound" data-value="launch" data-no-sound ${state.sound.enabled ? '' : 'disabled'}>启动</button>
            </div>
          </div>
        </section>

        <section class="${group('sound')}" ${groupAttr('sound')}>
          <h2>${icon('music')}音乐</h2>
          <p class="desc">决定启动器打开后音乐的行为。</p>
          <div class="setting-row setting-row-split">
            <div class="setting-pair">
              <strong>打开时继续上次的音乐</strong>
              <button class="switch ${state.autoResumeSong ? 'on' : ''}" role="switch" aria-checked="${Boolean(state.autoResumeSong)}" data-action="toggle-auto-resume" title="${state.autoResumeSong ? '关闭' : '开启'}"></button>
            </div>
            <div class="setting-pair">
              <strong>显示小播放器</strong>
              <button class="switch ${isMiniEnabled() ? 'on' : ''}" role="switch" aria-checked="${Boolean(isMiniEnabled())}" data-action="toggle-mini-player" title="${isMiniEnabled() ? '关闭' : '开启'}"></button>
            </div>
          </div>
          <p class="setting-hint">继续播放：启动器一打开就自动播放上次听到的那首歌，关掉后要手动点播放键。小播放器：放歌时在侧栏旁挂一个可拖动的小窗，关掉后即使还在放歌、来回切界面也不再出现。</p>
        </section>

        <section class="${group('behavior', true)}" ${groupAttr('behavior')}>
          <h2>${icon('settings')}行为</h2>
          <p class="desc">托盘、开机自启、自动同步等。游戏帧率请到「工具 → 对应游戏 → 画质配置」调整。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>关闭时收进托盘</strong><span>点击关闭按钮后继续在后台运行，双击托盘图标可以回来。</span></div>
            <div class="setting-control">${switchMarkup('closeToTray', settings.closeToTray)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>开机时启动</strong><span>登录 Windows 后自动打开启动器。</span></div>
            <div class="setting-control">${switchMarkup('launchAtLogin', settings.launchAtLogin)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>启动游戏后最小化</strong><span>把舞台让给游戏，启动器安静地退到后面。</span></div>
            <div class="setting-control">${switchMarkup('minimizeOnLaunch', settings.minimizeOnLaunch)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>异环通过官方启动器启动</strong><span>默认点击后打开 NTELauncher.exe，由官方处理版本更新和登录；关闭后直接启动 HTGame.exe。</span></div>
            <div class="setting-control">${switchMarkup('nevernessUseOfficialLauncher', settings.nevernessUseOfficialLauncher !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>检测已安装的游戏</strong><span>重新扫描注册表和常见安装目录，自动填入原神、崩坏3、星穹铁道、绝区零、异环、终末地的启动程序。</span></div>
            <div class="setting-control"><button class="btn btn-ghost" data-action="detect-all">${icon('refresh')}立即检测</button></div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动同步官网版本与封面</strong><span>启动时检查内置游戏的官网；发现新版本时自动更新版本号和封面，6 小时内只检查一次。</span></div>
            <div class="setting-control">${switchMarkup('autoSyncOfficial', settings.autoSyncOfficial !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动获取终末地抽卡记录</strong><span>打开游戏内抽卡记录后，自动读取 HGWebview 日志并同步；异环仍需其导出工具生成 JSON。</span></div>
            <div class="setting-control">${switchMarkup('autoGacha', settings.autoGacha !== false)}</div>
          </div>
        </section>

        <section class="${group('storage', true)}" ${groupAttr('storage')}>
          <h2>${icon('folder-open')}存储</h2>
          <p class="desc">下载、运行时、终末地渠道包与管理员权限。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>语音包语言</strong><span>只下载勾中的配音，默认只要中文；改完下次更新或安装时生效，已经下好的不会立刻删。仅对原神 / 星穹铁道 / 绝区零 / 崩坏3 生效——终末地的语音藏在 Unity 资源包里，官方没有拆分粒度，只能跟着整包一起下。</span></div>
            <div class="setting-control">
              <div class="segmented">
                ${(() => {
                  const on = audioLanguagesOf();
                  return AUDIO_LANGUAGE_LABELS
                    .map(([key, label]) => `<button class="${on.includes(key) ? 'active' : ''}" data-action="toggle-audio-language" data-value="${key}">${label}</button>`)
                    .join('');
                })()}
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>剧情资源 / 主线动画（绝区零约 19.7GB）</strong>
              <span>预下载和安装时把主线剧情、个人线、影像档案这些分类包一起下。<strong>不勾只是缺剧情动画，不影响进游戏</strong>；勾上要多占近 20GB。只对绝区零有意义——原神和星穹铁道的官方清单里实测分类包数为 0，这个开关对它们没有作用。</span>
            </div>
            <div class="setting-control">${switchMarkup('includeStoryResources', settings.includeStoryResources === true)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>更新时用本地补丁省流（LDIFF）</strong>
              <span>原神 / 星穹铁道更新时，官方会额外给一份「从你当前版本到新版本」的差分补丁。开启后先用补丁就地修补本地文件，剩下的才走分块下载——实测原神 7.0.0 → 7.1.0 能省约 75% 流量。代价是它会在更新过程中直接改写游戏文件，如果中途断网会留下「补了一半」的状态，重新更新一次能自动接上，也可以用「检查完整资源」修复。绝区零官方没开这个能力，对它无效。</span>
            </div>
            <div class="setting-control">${switchMarkup('enableLdiff', settings.enableLdiff !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>下载文件夹</strong><span class="path-text" title="${esc(settings.downloadDir || '')}">${esc(settings.downloadDir || '')}</span></div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="change-download-dir">更改</button>
              <button class="btn btn-icon btn-ghost" data-action="open-download-folder" title="打开下载文件夹">${icon('external')}</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>始终以管理员身份启动</strong><span>终末地通过官方登录流程启动时需要管理员权限。开启后，下次启动会直接请求 Windows UAC，不再重复弹出应用内提示；UAC 被拒绝或新实例没起来时会自动退回普通权限，不会出现双击打不开的情况。</span></div>
            <div class="setting-control">${switchMarkup('alwaysAdmin', settings.alwaysAdmin)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>管理员权限</strong><span>终末地通过官方登录流程启动时需要管理员权限；重启后会弹出 Windows UAC 确认。</span></div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="relaunch-admin">以管理员身份重启</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>应用数据</strong>
              <span class="path-text" title="${esc(state.app.userData || '')}">${esc(state.app.userData || '')}</span>
              <span class="hint">${state.app.portable ? '便携模式：数据、缓存与下载都在启动器文件夹内，不占 C 盘用户目录；整个文件夹拷走即可搬家。' : '当前使用系统 AppData 目录。'}</span>
            </div>
            <div class="setting-control">
              <button class="btn btn-icon btn-ghost" data-action="open-data-folder" title="打开数据目录">${icon('external')}</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>运行时目录</strong><span>B服 / 国际服的硬链接目录。留空时使用「游戏盘:\\VelaRuntimes」，必须和游戏同盘。</span></div>
            <div class="setting-control">
              <span class="path-text" title="${esc(settings.runtimeRoot || '')}">${esc(settings.runtimeRoot || '自动：游戏盘:\\VelaRuntimes')}</span>
              <button class="btn btn-ghost" data-action="change-runtime-root">更改</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动更新终末地渠道包</strong><span>启动后检查官方渠道 SDK，发现新版本时自动替换本机渠道包。关闭只停止后台自动更新，不影响手动更新、切换服务器和启动游戏。</span></div>
            <div class="setting-control">${switchMarkup('autoUpdateEndfieldPacks', settings.autoUpdateEndfieldPacks !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>终末地渠道包</strong>
              <span>${settings.endfieldPackRoot ? '已就绪，官方更新时会自动同步。' : '首次启动会自动下载，不需要手动准备。'}</span>
            </div>
            <div class="setting-control">
              <span class="auto-badge ${settings.endfieldPackRoot ? 'is-ready' : 'is-pending'}">${settings.endfieldPackRoot ? '已内置' : '待下载'}</span>
              <button class="btn btn-ghost" data-action="update-endfield-packs">${icon('refresh')}立即更新</button>
            </div>
          </div>

          ${
            demos
              ? `<div class="setting-row">
                  <div class="setting-copy"><strong>示例条目</strong><span>库中还有 ${demos} 个示例，只用于展示界面。</span></div>
                  <div class="setting-control"><button class="btn btn-ghost" data-action="clear-demo">清空示例</button></div>
                </div>`
              : ''
          }
        </section>

        <section class="${group('update', true)}" ${groupAttr('update')}>
          <h2>${icon('download')}软件更新</h2>
          <p class="desc">更新源已经内置：先看启动器目录里那份 <code>latest.json</code>，没有就去官方 Release 取，装完就能自己升级。下载失败会自动换国内镜像重试并做 sha256 校验，裸连也能装；开着 Steam++ 这类加速器也不会再因为证书检查失败。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>更新源</strong><span>留空就用内置的官方源；也可以填自己的 https 地址、局域网共享（\\NAS\share\latest.json）或本地路径。ZIP 地址写在清单里，相对路径以清单所在目录为准。一直卡在「检查更新」或下载不动时，点右边「用国内镜像源」换成 Gitee 上的清单试一次。</span></div>
            <div class="setting-control update-source-control">
              <input class="text-input" id="update-manifest" value="${esc(settings.updateManifest || '')}" placeholder="留空 = 内置官方源" spellcheck="false" />
              <button class="btn btn-ghost" data-action="save-update-source">保存</button>
              <button class="btn btn-ghost" data-action="fill-mirror-source" title="${GITEE_MANIFEST_URL}">${icon('server')}用国内镜像源</button>
              <button class="btn btn-ghost" data-action="pick-update-source">${icon('folder')}选择文件</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动检查更新</strong><span>启动 15 秒后检查一次，之后每 6 小时一次；发现新版本会弹提示。</span></div>
            <div class="setting-control">${switchMarkup('autoCheckUpdate', settings.autoCheckUpdate !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>立即检查</strong><span>${esc(updateStatusText())}</span></div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="check-update" ${state.update && state.update.downloading ? 'disabled' : ''}>${icon('refresh')}检查更新</button>
              ${state.update && state.update.hasUpdate ? `<button class="btn btn-primary" data-action="apply-update" ${state.update.downloading ? 'disabled' : ''}>${icon('download')}更新到 v${esc(state.update.latest)}</button>` : ''}
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>覆盖安装日志</strong>
              <span>覆盖脚本在后台单独运行，界面看不到它的输出。更新卡住或没重启时，把这里的日志发回来就能定位是哪一步出的问题（这不是版本更新日志，版本更新内容在「动态」页）。</span>
            </div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="view-update-log">${icon('file-text')}查看日志</button>
              <button class="btn btn-ghost" data-action="open-update-log">${icon('folder')}打开文件</button>
            </div>
          </div>
          ${
            state.update && state.update.backup && state.update.backup.ok
              ? `<div class="setting-row">
                  <div class="setting-copy"><strong>回到上一个版本</strong><span>上一次升级前的程序文件还留着备份（v${esc(state.update.backup.version || '?')} → v${esc(state.update.backup.target || '?')}）。新版本有问题时，可以一键还原回去。</span></div>
                  <div class="setting-control update-action-control">
                    <button class="btn btn-ghost" data-action="rollback-update">${icon('refresh')}回滚到 v${esc(state.update.backup.version || '?')}</button>
                  </div>
                </div>`
              : ''
          }
          <div class="setting-row">
            <div class="setting-copy">
              <strong>手动更新</strong>
              <span>不想等弹窗时，可以到 GitHub 自己下新版 ZIP。解压后覆盖程序文件即可，<code>data</code> 文件夹里的游戏、账号、抽卡记录和设置都不会被覆盖。</span>
            </div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_RELEASES_URL}">${icon('external')}打开发布页</button>
              <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_URL}">${icon('external')}仓库</button>
            </div>
          </div>
          ${state.update && state.update.downloading ? `<div class="update-progress"><div class="update-progress-bar"><span style="width:${Number(state.update.percent) || 0}%"></span></div><small>${updateProgressText(Number(state.update.percent) || 0, '')}</small></div>` : ''}
        </section>

        <section class="${group('community')}" ${groupAttr('community')}>
          <h2>${icon('link')}项目主页与反馈</h2>
          <p class="desc">源码、版本说明、已知问题都放在项目仓库里；有 bug 或者想要新功能，从下面的「问题反馈」进去写，会直接带上你现在用的版本号。</p>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>项目主页</strong>
              <span>GitHub 仓库，README 里有上手说明，发版页能翻到每一个版本的更新内容。</span>
            </div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_URL}" title="${REPO_URL}">${icon('external')}打开项目主页</button>
              <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_RELEASES_URL}" title="${REPO_RELEASES_URL}">${icon('external')}打开发布页</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>问题反馈</strong>
              <span>写一个 issue：说清楚哪一步出的问题、期望是什么、实际是什么。带上启动器的版本和系统版本，定位会快很多。</span>
            </div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_FEEDBACK_URL()}" title="${REPO_NEW_ISSUE_URL}">${icon('external')}提交问题</button>
            </div>
          </div>
          <div class="setting-row" style="border-bottom:0">
            <div class="setting-copy">
              <strong>反馈时附上这些信息</strong>
              <span>启动器版本 <code>${esc((state.app && state.app.version) || '未知')}</code> · Electron <code>${esc((state.app && state.app.electron) || '未知')}</code> · 系统 <code>${esc(platformText())}</code>。上面那段可以直接复制进 issue 里。</span>
            </div>
          </div>
        </section>

        <section class="${group('about', true)}" ${groupAttr('about')}>
          <h2>${icon('info')}关于</h2>
          <p class="desc">一个本地优先的桌面游戏书架，会自己管更新，外加一台能放歌的音乐台。</p>
          <div class="setting-row" style="border-bottom:0;padding-bottom:0">
            <div class="about-block">
              <div class="about-name">花筱灵启动器</div>
              <div class="about-version">VERSION ${esc(state.app.version || '1.0.0')} · ELECTRON ${esc(state.app.electron || '')}</div>
              <div class="about-note">
                内置原神、崩坏：星穹铁道、绝区零、崩坏3、明日方舟、异环、明日方舟：终末地的启动入口，也支持添加任意本地游戏；装在哪、切哪个服、缺不缺资源，启动器都会自己认，游戏有官方更新时「开始游戏」会直接变成「更新游戏」，点了就下、下完自动就位。
                切服不用重下：多渠道游戏（官服 / B服 / 国际服）共用一份客户端，运行时按渠道自动组装，更新一次全服通用。
                抽卡记录三池一页看完：条形图带真头像、红条 = 吃到保底，自动算平均出金和当前垫数。
                另带一台音乐台：网易云 / QQ / 酷狗 / 酷我多平台搜歌、歌单链接导入、队列分组与过滤、音效与歌词，直播间连上后还能听观众弹幕点歌。
                界面与代码为原创实现；启动页与部分界面使用了《崩坏：星穹铁道》花火、火花等官方立绘素材，仅作爱好者桌面美化用途，版权归米哈游及各游戏官方所有。
                游戏版本号与封面会在联网时从官网同步并缓存，版权归各游戏官方所有。
                功能设计参考了 Starward（MIT）等开源启动器，不包含它们的代码或素材。
                游戏列表、设置、歌单和时长都保存在本地，不会上传。
              </div>
              <div class="about-links">
                <button class="link-btn" data-action="open-changelog">${icon('file-text')}版本更新日志</button>
                <button class="link-btn" data-action="install-update">${icon('download')}导入更新包</button>
                <button class="link-btn" data-action="open-external" data-url="https://github.com/Scighost/Starward">Starward · MIT ${icon('external')}</button>
                <button class="link-btn" data-action="quit-app">退出启动器</button>
              </div>
            </div>
          </div>
        </section>
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* view bindings                                                       */
/* ------------------------------------------------------------------ */

function bindCoverFallbacks(root = document) {
  root.querySelectorAll('img[data-cover]').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        img.style.display = 'none';
        const cover = img.closest('.game-cover');
        if (cover) cover.classList.add('no-img');
      },
      { once: true }
    );
  });
}

function bindView() {
  bindCoverFallbacks();
  document.querySelectorAll('.avatar img').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        const holder = img.closest('.avatar');
        if (holder) holder.textContent = initial(state.settings.profileName || '大小姐');
      },
      { once: true }
    );
  });
  // 战绩页的角色头像是外链，挂掉时留一个占位方块而不是显示破图标
  document.querySelectorAll('img[data-record-avatar]').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        img.classList.add('is-broken');
        img.removeAttribute('src');
      },
      { once: true }
    );
  });
  // 抽卡记录的五星头像同样是外链，挂掉时隐藏图片，露出底下的字牌
  document.querySelectorAll('img[data-gacha-avatar]').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        const holder = img.closest('.gacha-avatar') || img.closest('.gacha-tile');
        if (!holder) return;
        if (holder.classList.contains('gacha-tile')) {
          holder.classList.add('is-blank');
          holder.innerHTML = '<span class="gacha-tile-blank">星</span>';
        } else {
          holder.classList.add('is-blank');
          holder.textContent = '星';
        }
      },
      { once: true }
    );
  });

  const search = document.querySelector('#game-search');
  if (search) {
    search.addEventListener('input', () => {
      state.search = search.value;
      const results = document.querySelector('#library-results');
      if (results) {
        results.innerHTML = libraryResultsMarkup();
        bindCoverFallbacks(results);
      }
      const clear = document.querySelector('.search-clear');
      if (clear) clear.style.display = search.value ? 'grid' : 'none';
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        search.value = '';
        state.search = '';
        const results = document.querySelector('#library-results');
        if (results) {
          results.innerHTML = libraryResultsMarkup();
          bindCoverFallbacks(results);
        }
        const clear = document.querySelector('.search-clear');
        if (clear) clear.style.display = 'none';
      }
    });
  }

  const songSearchInput = document.querySelector('#song-search-input');
  if (songSearchInput) {
    songSearchInput.addEventListener('input', () => {
      // 只记关键字，不重渲染，否则输入框会丢焦点
      state.songSearch.keyword = songSearchInput.value;
    });
    songSearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runSongSearch();
      }
    });
  }

  /*
   * 队列过滤框：输入即过滤。这里只重绘 .song-list 这一小块，
   * 输入框和焦点原地不动；折叠状态在过滤时会被忽略（一律全展开）。
   */
  const queueFilterInput = document.querySelector('#song-queue-filter');
  if (queueFilterInput) {
    queueFilterInput.addEventListener('input', () => {
      state.queueFilter = queueFilterInput.value;
      const list = document.querySelector('#song-queue .song-list');
      if (list) {
        list.innerHTML = songQueueRowsMarkup() ||
          `<div class="song-empty">${icon('search')}<strong>没有匹配的队列歌曲</strong><span>换个关键字，或者点右侧的 × 清空过滤。</span></div>`;
        bindCoverFallbacks(list);
      }
      // 过滤词出现/消失会切换清除按钮，重绘过滤条之外不动输入框
      const wrap = document.querySelector('#song-queue');
      const clearBtn = wrap?.querySelector('.song-queue-filter-clear');
      if (clearBtn) clearBtn.hidden = !state.queueFilter;
    });
  }
  const songSearchPlatform = document.querySelector('#song-search-platform');
  if (songSearchPlatform) {
    songSearchPlatform.addEventListener('change', () => {
      state.songSearch.platform = songSearchPlatform.value;
      // 已经搜过一次的话，换平台直接重搜
      if (state.songSearch.done) runSongSearch();
    });
  }

  const sort = document.querySelector('#sort-select');
  if (sort) {
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      const results = document.querySelector('#library-results');
      if (results) {
        results.innerHTML = libraryResultsMarkup();
        bindCoverFallbacks(results);
      }
    });
  }

  const profile = document.querySelector('#profile-name-input');
  if (profile) {
    const save = () => {
      const value = profile.value.trim();
      if (!value || value === state.settings.profileName) return;
      api.updateSettings({ profileName: value }).catch((error) => toast(humanError(error), 'error'));
    };
    profile.addEventListener('change', save);
    profile.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        profile.blur();
      }
    });
  }

  const accountSelect = document.querySelector('#gacha-account-select');
  if (accountSelect) {
    accountSelect.addEventListener('change', () => {
      state.gachaUid = accountSelect.value;
      state.gachaScope = 'all';
      render({ preserveScroll: true });
    });
  }

  // 背景不透明度 / 清晰度：拖动时实时改 CSS 变量，松手才落盘。
  // 注意：不能直接用滑块 DOM 上的 value 回写——页面可能是在设置变化前渲染的，
  // 那样会把别的途径刚写进去的值覆盖掉。记下渲染时的初值，只提交真正的改动。
  const bgOpacity = document.querySelector('#bg-opacity');
  if (bgOpacity) {
    const label = document.querySelector('#bg-opacity-value');
    const initial = bgOpacity.value;
    bgOpacity.addEventListener('input', () => {
      const value = Number(bgOpacity.value) || 0;
      if (label) label.textContent = `${value}%`;
      document.documentElement.style.setProperty('--bg-opacity', String(value / 100));
      // 内容底跟着变：背景图拉淡时让位给材质，拉实时才加厚，否则文字读不清
      document.documentElement.style.setProperty(
        '--bg-veil',
        `${Math.round(34 + (value / 100) * 34)}%`
      );
    });
    bgOpacity.addEventListener('change', async () => {
      if (bgOpacity.value === initial) return;
      const value = Number(bgOpacity.value) || 0;
      // 先把本地值跟上，免得落盘期间的回推把滑到一半的位置弹回去
      state.settings = { ...(state.settings || {}), backgroundOpacity: value };
      const saved = await api.updateSettings({ backgroundOpacity: value });
      if (saved?.settings) state.settings = saved.settings;
      applySettings();
    });
  }

  const bgBlur = document.querySelector('#bg-blur');
  if (bgBlur) {
    const label = document.querySelector('#bg-blur-value');
    const initial = bgBlur.value;
    bgBlur.addEventListener('input', () => {
      // 滑杆是「清晰度」，模糊半径是它的补数
      const clarity = Number(bgBlur.value) || 0;
      const blur = 100 - clarity;
      if (label) label.textContent = blur ? `模糊 ${blur}` : '原图';
      document.documentElement.style.setProperty('--bg-blur', `${blur}px`);
    });
    bgBlur.addEventListener('change', async () => {
      if (bgBlur.value === initial) return;
      const clarity = Number(bgBlur.value) || 0;
      const blur = 100 - clarity;
      state.settings = { ...(state.settings || {}), backgroundBlur: blur };
      const saved = await api.updateSettings({ backgroundBlur: blur });
      if (saved?.settings) state.settings = saved.settings;
      applySettings();
    });
  }

  const soundVolume = document.querySelector('#sound-volume');
  if (soundVolume) {
    const label = document.querySelector('#sound-volume-value');
    soundVolume.addEventListener('input', () => {
      state.sound.volume = Number(soundVolume.value) || 0;
      if (label) label.textContent = `${state.sound.volume}%`;
    });
    soundVolume.addEventListener('change', () => {
      saveSoundSettings();
      playUiSound('click', true);
    });
  }

  const songVolume = document.querySelector('#song-volume');
  if (songVolume) {
    songVolume.value = String(state.songVolume);
    songVolume.addEventListener('input', () => setSongVolume(songVolume.value));
  }

  const mainVolume = document.querySelector('#song-volume-main');
  if (mainVolume) {
    mainVolume.value = String(state.songVolume);
    mainVolume.addEventListener('input', () => setSongVolume(mainVolume.value));
  }

  const fxSetting = document.querySelector('#fx-intensity-setting');
  if (fxSetting) {
    const label = document.querySelector('#fx-intensity-setting-value');
    fxSetting.addEventListener('input', () => {
      const value = setAudioFxIntensity(fxSetting.value);
      if (label) label.textContent = `${value}%`;
    });
  }

  const dockVolume = document.querySelector('#dock-volume');
  if (dockVolume) {
    dockVolume.value = String(state.songVolume);
    dockVolume.addEventListener('input', () => setSongVolume(dockVolume.value));
  }

  syncVolumeUi();
  applyAudioFx();
  restoreStartVideoState();
  startStartRunningTimer();
  bindSongLyrics();
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

async function toggleFavorite(id) {
  const game = state.games.find((g) => g.id === id);
  if (!game) return;
  await api.games.update(id, {
    name: game.name,
    subtitle: game.subtitle,
    description: game.description,
    version: game.version,
    tags: game.tags,
    target: game.target,
    args: game.args,
    workDir: game.workDir,
    cover: game.cover,
    accent: game.accent,
    favorite: !game.favorite,
  });
  toast(game.favorite ? '已取消收藏' : '已加入收藏', 'success');
}

async function handleAction(action, id, element, event = null) {
  switch (action) {
    case 'music-accounts':
      openMusicAccountsModal(element.dataset.platform || '');
      break;
    case 'song-pop-toggle': {
      const id = element.dataset.pop || '';
      const wrap = element.closest('.song-pop');
      const wasOpen = wrap ? wrap.classList.contains('is-open') : false;
      closeSongPops();
      if (wrap && !wasOpen) wrap.classList.add('is-open');
      break;
    }
    case 'song-pop-pick': {
      const id = element.dataset.pop || '';
      const value = element.dataset.value || '';
      closeSongPops();
      if (id.indexOf('mode') >= 0) setPlayMode(value);
      else changeSongQuality(value);
      break;
    }
    case 'song-tab': {
      const next = element.dataset.value || 'queue';
      state.songTab = next;
      localStorage.setItem('vela:song-tab', next);
      // 离开「我的歌单」时退出钻取态：再切回来应该看到卡片墙，而不是上次那张歌单
      if (next !== 'mine') state.myPlaylists.detail = null;
      render({ preserveScroll: true });
      if (next === 'charts' && !(state.charts.list || []).length && !state.charts.loading) {
        handleAction('chart-platform', { dataset: { value: state.charts.platform || 'all' } });
      }
      if (next === 'mine') {
        // 「我的歌单」按平台分区显示所有已登录平台的歌单，不再只挑一个平台。
        // 已经有缓存就别重新拉：切走再切回还触发一次全量读取，卡顿又浪费。
        // 登录成功或手动点「同步全部」会自己重拉（见 syncPlaylistsAfterLogin / syncAllPlaylists）。
        if (!state.myPlaylists.groups?.length) {
          /*
           * 内存空有两种情况：第一次用（盘上也没缓存），或者 refreshMusicLogin 还没跑完
           * 把磁盘缓存灌进来。先问一次缓存，真没有才去拉四家平台。
           */
          hydratePlaylistsFromCache().then((filled) => {
            if (!filled) loadAllPlaylists();
          });
        }
      }
      break;
    }
    case 'music-account-login': {
      const platform = element.dataset.platform || 'qq';
      const label = platform === 'qq' ? 'QQ 音乐' : platform === 'kuwo' ? '酷我' : '酷狗';
      closeModal();
      toast(`${label} 登录窗口已打开，扫码后会自动保存`, 'info');
      try {
        const result = await api.musicLogin(platform);
        if (!result || result.cancelled) break;
        if (!result.ok) {
          toast(
            result.error ? `${label} 登录没有完成：${result.error}` : `${label} 登录没有完成`,
            result.error ? 'error' : 'info'
          );
          break;
        }
        await refreshMusicLogin();
        toast(`${label} 登录成功`, 'success');
        if (state.route === 'song') render({ preserveScroll: true });
        await syncPlaylistsAfterLogin(platform);
      } catch (error) {
        toast(`${label} 登录失败：${humanError(error)}`, 'error');
      }
      break;
    }
    case 'music-account-logout': {
      const platform = element.dataset.platform || 'qq';
      const label = platform === 'netease' ? '网易云' : platform === 'qq' ? 'QQ 音乐' : platform === 'kuwo' ? '酷我' : '酷狗';
      try {
        await api.musicLogout(platform);
        await refreshMusicLogin();
        invalidateAllPlaylists();
        toast(`已退出 ${label}`, 'success');
        if (state.route === 'song') render({ preserveScroll: true });
        // 账号弹窗还开着的话，把它刷回最新状态（否则那一行还写着「已登录」）
        refreshMusicAccountsModal();
      } catch (error) {
        toast(humanError(error), 'error');
      }
      break;
    }
    case 'netease-login':
      openMusicAccountsModal('netease');
      break;
    case 'import-playlist-link': {
      // 从别的弹窗（比如酷狗登录面板那条兜底说明）点进来时，先把那层收掉，别叠两个
      if (document.body.classList.contains('modal-open')) closeModal();
      openImportPlaylistModal();
      break;
    }
    case 'add-song-file': {
      // 从「添加歌曲」弹窗里点进来的，先把弹窗收掉，别让选文件对话框和弹窗叠在一起
      if (document.body.classList.contains('modal-open')) closeModal();
      const source = await api.pick.audio();
      if (!source) break;
      const url = await api.mediaUrl(source);
      state.songs.push({ title: source.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''), url });
      state.songIndex = state.songs.length - 1;
      saveSongs();
      render({ preserveScroll: true });
      playCurrentSong();
      break;
    }
    case 'add-song-link': {
      openAddSongLinkModal();
      break;
    }
    case 'my-playlist-open': {
      await openMyPlaylist(element.dataset.platform || '', element.dataset.id || '');
      break;
    }
    case 'my-playlist-tab': {
      state.myPlaylists.activeTab = element.dataset.value || '';
      render({ preserveScroll: true });
      break;
    }
    case 'my-playlist-play': {
      await playPlaylist(element.dataset.platform || '', element.dataset.id || '');
      break;
    }
    case 'my-playlist-close': {
      state.myPlaylists.detail = null;
      render({ preserveScroll: true });
      break;
    }
    case 'my-playlist-song': {
      // 点一行 = 点歌：这首立刻开播，后面按歌单顺序接着放（以前只入队、不出声）
      const index = Number(element.dataset.index) || 0;
      const detail = state.myPlaylists.detail;
      const song = (detail?.songs || [])[index];
      if (!song || !detail) break;
      await playPlaylistFromIndex(element.dataset.platform || detail.platform || '', detail.id, index);
      break;
    }
    case 'my-playlist-import': {
      const groupPlatform = element.dataset.platform || '';
      const songs = state.myPlaylists.detail?.songs || [];
      if (!songs.length) break;
      const added = await addSongsToQueue(songs, {
        platform: groupPlatform,
        label: '加入点歌队列',
        origin: 'playlist',
        from: state.myPlaylists.detail?.name || '歌单',
      });
      toast(
        added ? `已加入 ${added} 首（其余在网易云没有可播版本）` : '这些曲目在网易云没有可播版本',
        added ? 'success' : 'info'
      );
      break;
    }
    /* 语音包语言：多选，但至少留一种 —— 一种都不下游戏里就是哑的 */
    case 'toggle-audio-language': {
      const lang = String(element?.dataset?.value || '').toLowerCase();
      if (!lang) break;
      const on = audioLanguagesOf();
      let next;
      if (on.includes(lang)) {
        if (on.length === 1) {
          toast('至少要留一种语音包', 'info');
          break;
        }
        next = on.filter((item) => item !== lang);
      } else {
        // 按固定顺序排回去，免得数组顺序随点击变、界面上按钮跳来跳去
        next = AUDIO_LANGUAGE_LABELS.map(([key]) => key).filter((key) => key === lang || on.includes(key));
      }
      state.settings.audioLanguages = next;
      await api.updateSettings({ audioLanguages: next });
      if (state.route === 'settings') render({ preserveScroll: true });
      break;
    }
    /* 点歌台音源：内置音源开关 / 第三方音源启停与删除
     * 点击委托只把 data-action 和 data-id 解出来传进来，所以这里一律用 data-id。 */
    case 'toggle-music-source': {
      const sourceKey = String(id || '');
      const next = Object.assign({}, musicSourceFlags());
      next[sourceKey] = !next[sourceKey];
      await applySettingLocally({ musicSources: next });
      if (state.route === 'song') render({ preserveScroll: true });
      const label = (MUSIC_SOURCE_LABELS.find((item) => item[0] === sourceKey) || [sourceKey, sourceKey])[1];
      toast(next[sourceKey] ? `已启用 ${label} 音源` : `已停用 ${label} 音源`, 'success');
      break;
    }
    case 'toggle-music-custom': {
      const customId = String(id || '');
      const list = musicCustomSources().map((def) =>
        def.id === customId ? { ...def, enabled: def.enabled === false } : def
      );
      await applySettingLocally({ musicCustomSources: list });
      if (state.route === 'song') render({ preserveScroll: true });
      break;
    }
    case 'music-source-remove': {
      const removeId = String(id || '');
      const list = musicCustomSources().filter((def) => def.id !== removeId);
      await applySettingLocally({ musicCustomSources: list });
      if (state.route === 'song') render({ preserveScroll: true });
      toast('已删除这个音源', 'success');
      break;
    }
    case 'music-source-pick': {
      const picker = document.querySelector('#music-source-file');
      if (picker) picker.click();
      else toast('找不到文件选择框，刷新一下音乐页', 'error');
      break;
    }
    case 'music-source-subscribe': {
      const row = document.querySelector('#song-source-url-row');
      if (!row) break;
      row.hidden = false;
      const field = row.querySelector('#music-source-url');
      if (field) field.focus();
      break;
    }
    case 'music-source-url-go': {
      const field = document.querySelector('#music-source-url');
      const url = String(field?.value || '').trim();
      if (!url) {
        toast('先填订阅地址', 'info');
        break;
      }
      await importMusicSource({ url });
      break;
    }
    case 'toggle-auto-resume': {
      state.autoResumeSong = !state.autoResumeSong;
      try {
        localStorage.setItem('vela:auto-resume-song', state.autoResumeSong ? '1' : '0');
      } catch {
        /* 可选记忆 */
      }
      // 就地切状态：整页重绘会让滑块直接从终点出现，看不到位移过程
      paintSwitches('toggle-auto-resume', state.autoResumeSong);
      toast(
        state.autoResumeSong
          ? '已开启：打开启动器会自动继续上次的音乐'
          : '已关闭：需要手动点播放才会继续',
        'success'
      );
      break;
    }
    case 'my-playlists-reload': {
      // 老按钮走同一条路：一次请求拉全部平台，不再只刷某一个
      await syncAllPlaylists();
      break;
    }
    case 'music-sync-one': {
      // 只同步按钮所在的那一个平台，其它平台的数据一动不动
      await syncOnePlaylist(element.dataset.platform || '');
      break;
    }
    case 'music-sync-all': {
      await syncAllPlaylists();
      break;
    }
    case 'plaza-platform': {
      state.myPlaylists.plazaPlatform = element.dataset.value || 'netease';
      await ensurePlaza(state.myPlaylists.plazaPlatform);
      break;
    }
    case 'plaza-more': {
      await plazaMore(element.dataset.platform || state.myPlaylists.plazaPlatform || 'netease');
      break;
    }
    case 'plaza-retry': {
      await ensurePlaza(element.dataset.platform || state.myPlaylists.plazaPlatform || 'netease', true);
      break;
    }
    case 'chart-platform': {
      const platform = element.dataset.value || 'all';
      const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
      state.charts = { platform, loading: true, list: [], detail: null, error: '', counts: null };
      render({ preserveScroll: true });
      try {
        await api.netease.startService(apiBase).catch(() => {});
        const payload = await api.musicCharts({ platform, apiBase });
        // 合并模式返回 { charts, counts }；单平台是数组
        if (Array.isArray(payload)) {
          state.charts.list = payload;
        } else if (payload && Array.isArray(payload.charts)) {
          state.charts.list = payload.charts;
          state.charts.counts = payload.counts || null;
        } else {
          state.charts.list = [];
        }
        if (!state.charts.list.length) state.charts.error = '没有读取到榜单';
      } catch (error) {
        state.charts.error = humanError(error);
      } finally {
        state.charts.loading = false;
        if (state.route === 'song') render({ preserveScroll: true });
      }
      break;
    }
    case 'chart-open': {
      const chartId = element.dataset.id || '';
      if (!chartId) break;
      const chart = (state.charts.list || []).find((item) => item.id === chartId);
      if (!chart) break;
      const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
      state.charts.loading = true;
      state.charts.error = '';
      render({ preserveScroll: true });
      try {
        const detail = await api.musicChartSongs({ chart, apiBase, limit: 20 });
        state.charts.detail = { id: chartId, ...detail };
      } catch (error) {
        // 不要把整片列表清空，只在弹窗里提示这一条读不到
        state.charts.error = humanError(error);
      } finally {
        state.charts.loading = false;
        if (state.route === 'song') render({ preserveScroll: true });
      }
      break;
    }
    case 'chart-to-netease': {
      const chartPlatform = state.charts.platform && state.charts.platform !== 'all' ? state.charts.platform : (state.charts.detail?.platform || element.dataset.platform || '');
      const index = Number(element.dataset.index) || 0;
      const chartSongs = state.charts.detail?.songs || [];
      const song = chartSongs[index];
      if (!song) break;
      // 点榜单里的一首 = 从这首开始，把榜单剩下的歌一起排进队列：
      // 这样播完一首会自动接下一首（原来只加被点的那一首，播完就停）。
      const rest = chartSongs.slice(index);
      const base = state.songs.length;
      let added = 0;
      for (const item of rest) {
        if (await addChartSongToQueue(item, { silent: true, platform: item.platform || chartPlatform })) added += 1;
      }
      if (added) {
        state.songIndex = base;
        render({ preserveScroll: true });
        playCurrentSong();
        toast(
          added > 1
            ? `已从「${song.title || '这首'}」开始连播 ${added} 首`
            : `已加入：${song.title || '这首'}`,
          'success'
        );
      } else {
        toast(`「${song.title || '这首'}」暂时找不到可播放版本`, 'info');
      }
      break;
    }
    case 'chart-import': {
      const songs = state.charts.detail?.songs || [];
      if (!songs.length) break;
      const added = await addSongsToQueue(songs, { label: '转成网易云曲目' });
      toast(added ? `已加入 ${added} 首（其余在网易云没有可播版本）` : '这些曲目在网易云没有可播版本', added ? 'success' : 'info');
      break;
    }
    case 'live-connect': {
      // 历史芯片自带 data-url（点击直接重连）；普通「连接」按钮读输入框
      const url = element.dataset.url || document.querySelector('#live-room-input')?.value?.trim() || '';
      if (!url) {
        toast('先粘贴直播间链接或房间号（B站 / 斗鱼 / 虎牙 / 抖音 / 快手等）', 'info');
        break;
      }
      await connectLiveRoom(url);
      break;
    }
    case 'live-disconnect':
      // 卡片上的「断开」：只关这一路（房间 id 放在 data-id 上）
      disconnectLiveRoom(id);
      break;
    case 'bili-login': {
      // B站登录窗口：登录 cookie 落在主会话里，弹幕鉴权马上能用；成功后重连即可
      const loginResult = await api.live.biliLogin().catch((error) => ({ ok: false, reason: humanError(error) }));
      if (loginResult?.ok) {
        toast('B站账号已登录，重新连接直播间即可', 'success');
      } else if (loginResult?.reason && loginResult.reason !== '窗口已关闭') {
        toast(loginResult.reason, 'info');
      }
      if (state.route === 'song') render({ preserveScroll: true });
      break;
    }
    case 'live-disconnect-all':
      disconnectBiliLive();
      break;
    case 'live-song-mode':
      localStorage.setItem('vela:live-song-mode', id === 'now' ? 'now' : 'next');
      toast(`观众点歌将${id === 'now' ? '立即切过去播放' : '排在当前歌曲后面当下一个放'}`, 'info');
      render({ preserveScroll: true });
      break;
    case 'mini-expand':
      setMiniExpanded(true);
      break;
    case 'mini-collapse':
      setMiniExpanded(false);
      break;
    case 'mini-open':
      navigate('song');
      break;
    case 'mini-toggle':
      playCurrentSong(true);
      break;
    case 'mini-mute':
    case 'song-search-run': {
      await runSongSearch();
      break;
    }
    case 'song-search-add': {
      const item = state.songSearch.list?.[Number(element.dataset.index)];
      if (!item) break;
      element.disabled = true;
      const ok = await addChartSongToQueue(item, { silent: true });
      element.disabled = false;
      toast(ok ? `已加入：${item.title}` : `「${item.title}」暂时找不到可播放版本`, ok ? 'success' : 'info');
      break;
    }
    case 'song-mute':
      toggleSongMute();
      break;
    case 'open-audio-fx':
      openAudioFxModal();
      break;
    case 'fx-preset': {
      const next = setAudioFxPreset(element.dataset.value || 'off');
      document.querySelectorAll('.fx-card').forEach((card) => {
        card.classList.toggle('active', card.dataset.value === next);
      });
      if (state.route === 'settings') render({ preserveScroll: true });
      break;
    }
    case 'mini-close': {
      const audio = document.querySelector('#song-audio');
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio.dataset.songKey = '';
        updateSongChrome();
      }
      // 关掉就等于关掉总开关：不然切一趟点歌台再回来，它又会自己冒出来
      setMiniEnabled(false);
      // 总开关被关了，界面上的小播放器开关也要跟着回到关位
      paintSwitches('toggle-mini-player', false);
      toast('小播放器已关闭，可在「设置 → 声音」或音乐页重新打开', 'info');
      break;
    }
    case 'toggle-mini-player': {
      const next = !isMiniEnabled();
      setMiniEnabled(next);
      // 就地切状态：整页重绘会让滑块直接从终点出现，看不到位移过程
      paintSwitches('toggle-mini-player', next);
      toast(next ? '小播放器已打开' : '小播放器已关闭', next ? 'success' : 'info');
      break;
    }
    case 'mini-list':
      navigate('song');
      setTimeout(() => {
        document.querySelector('#song-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
      break;
    case 'dock-open-list':
      if ((state.songTab || 'queue') !== 'queue') {
        state.songTab = 'queue';
        localStorage.setItem('vela:song-tab', 'queue');
        render({ preserveScroll: true });
      }
      setTimeout(() => {
        document.querySelector('#song-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
      break;
    case 'song-select': {
      state.songIndex = Number(element.dataset.index) || 0;
      await hydrateSong(state.songs[state.songIndex]);
      await ensureSongQuality(state.songs[state.songIndex]);
      render({ preserveScroll: true });
      playCurrentSong();
      break;
    }
    /* queue-seg-toggle 已删：队列段的展开/收起砍掉了，列表平铺 */
    case 'queue-filter-clear': {
      state.queueFilter = '';
      render({ preserveScroll: true });
      break;
    }
    case 'song-play': {
      playCurrentSong(true);
      break;
    }
    case 'mini-next':
    case 'mini-prev':
    case 'song-next':
    case 'song-prev': {
      if (!state.songs.length) break;
      const forward = action === 'song-next' || action === 'mini-next';
      const options = { skipRender: state.route !== 'song' };
      if (forward && state.playMode === 'shuffle') {
        await playSongAt(randomSongIndex(), options);
        break;
      }
      const step = forward ? 1 : -1;
      const next = (state.songIndex + step + state.songs.length) % state.songs.length;
      await playSongAt(next, options);
      break;
    }
    case 'cycle-play-mode':
      cyclePlayMode();
      break;
    case 'song-remove': {
      const index = Number(element.dataset.index) || 0;
      state.songs.splice(index, 1);
      state.songIndex = Math.max(0, Math.min(state.songIndex, state.songs.length - 1));
      saveSongs();
      render({ preserveScroll: true });
      break;
    }
    case 'song-clear': {
      state.songs = [];
      state.songIndex = 0;
      saveSongs();
      render({ preserveScroll: true });
      break;
    }
    case 'start-select': {
      state.startGameId = id;
      localStorage.setItem('vela:start-game', id);
      render({ preserveScroll: false });
      loadGameNotices(id);
      break;
    }
    case 'start-selected': {
      let game = state.games.find((item) => item.id === id);
      if (!game) break;
      if (!game.installed) {
        // 渲染层的状态可能比主进程旧（比如刚切过服务器 / 盘符刚接上）：
        // 先跟主进程核对一次，别动不动就把好好的游戏当成「没装」。
        try {
          const fresh = await api.getState();
          if (fresh) {
            state.games = fresh.games || state.games;
            state.settings = fresh.settings || state.settings;
            state.stats = fresh.stats || state.stats;
            applySettings();
            updateChrome();
            render({ preserveScroll: true });
            game = state.games.find((item) => item.id === id);
          }
        } catch {
          /* 取不到就按原来的判断走 */
        }
        if (!game) break;
      }
      if (!game.installed) {
        if (game.builtin) await handleAction('detect-game', id, element);
        else openGameModal(id);
        break;
      }
      const result = await api.games.launch(id);
      if (!result.ok) toast(result.error, 'error');
      else playUiSound('launch');
      break;
    }
    case 'start-server':
      // 服务器胶囊：切换 + 直接启动（快速进游戏，和下拉里的「只切换」区分开）
      await switchServerProfile(element.dataset.game, element.dataset.server, { launch: true });
      break;
    case 'start-update-game': {
      // dock 主按钮的「更新游戏」：直接应用官方更新，完成/失败后按钮都会变回去。
      // 进度显示靠全局 onPredownloadProgress 订阅直接改按钮文字，不整页重绘。
      const game = state.games.find((item) => item.id === id);
      if (!game) break;
      if (state.gameUpdate) {
        toast('已经有更新在进行中了', 'info');
        break;
      }
      const server = (game.servers || []).find((item) => item.active) || (game.servers || [])[0];
      if (!server) break;
      const jobId = `dock-update-${game.id}-${Date.now()}`;
      state.gameUpdate = { gameId: game.id, jobId, label: '正在准备更新…' };
      render({ preserveScroll: true });
      try {
        const result = await api.predownload.apply({ gameId: game.id, serverId: server.id, jobId });
        if (result && result.cancelled) toast('更新已取消', 'info');
        else if (result && result.ok === false) toast('更新没有完成，部分文件校验失败', 'error');
        else {
          const version = String(result?.tag || result?.version || '');
          toast(version ? `已更新到 ${version}，可以开始游戏了` : '更新完成，可以开始游戏了', 'success');
          if (game.builtinKey === 'neverness' && version) {
            toast(`启动器资源已更新到 ${version}；游戏本体如有新版本，打开异环启动器时会自动补`, 'info');
          }
        }
      } catch (error) {
        toast(`更新失败：${humanError(error)}`, 'error');
      } finally {
        state.gameUpdate = null;
        render({ preserveScroll: true });
      }
      break;
    }
    case 'start-server-menu': {
      /*
       * 面板开合只切 DOM 类名，不再整页重绘：
       * 之前每展开一次就重建 .start-art，<video> 从零加载，
       * 于是先闪一下静态版本图，看起来像重新打开启动页。
       */
      const dock = document.querySelector('.start-dock');
      if (!dock) break;
      const screen = document.querySelector('.start-screen');
      const next = !dock.classList.contains('is-menu-open');
      state.startServerMenu = next;
      dock.classList.toggle('is-menu-open', next);
      screen?.classList.toggle('dock-open', next);
      dock
        .querySelector('.start-server-pick')
        ?.setAttribute('aria-expanded', next ? 'true' : 'false');
      break;
    }
    case 'start-server-pick':
      // 下拉里点服务器 = 只切换（启动交给「开始游戏」，比「切完顺手把游戏拉起来」清楚）
      await switchServerProfile(element.dataset.game, element.dataset.server, { launch: false });
      break;
    case 'start-server-setup':
      // 这个服还没装好：先问「怎么补上」，别直接把人扔进一个几十分钟的安装
      closeStartServerMenu();
      openServerSetupDialog(element.dataset.game, element.dataset.server);
      break;
    case 'start-server-guide':
      // 从管理面板进来的：关掉说明卡后回到管理面板
      openServerSwitchGuide({ returnToManager: element.dataset.game || '' });
      break;
    case 'start-server-manage':
      closeStartServerMenu();
      openStartServerManager(element.dataset.game);
      break;
    case 'export-start-video': {
      const game = state.games.find((item) => item.id === (state.startGameId || ''));
      const target = game || state.games.find((item) => item.backgroundVideo);
      if (!target) {
        toast('这个游戏还没有动态背景', 'info');
        break;
      }
      const label = element.querySelector('span');
      const originalLabel = label ? label.textContent : '';
      if (label) label.textContent = '保存中…';
      element.disabled = true;
      try {
        const result = await api.exportStartVideo(target.id);
        if (!result || result.cancelled) break;
        toast(`动图已保存（${fmtBytes(result.bytes || 0)}）`, 'success');
      } catch (error) {
        toast(humanError(error), 'error');
      } finally {
        if (label) label.textContent = originalLabel || '保存动图';
        element.disabled = false;
      }
      break;
    }
    case 'toggle-start-video': {
      const video = liveStartVideo();
      if (!video) break;
      if (video.paused) {
        // 用户主动恢复播放
        video.dataset.userPaused = '0';
        video.play().catch(() => {});
      } else {
        // 用户主动暂停：打标记，才允许被记住
        video.dataset.userPaused = '1';
        video.pause();
      }
      updateStartVideoToggle(video.paused);
      rememberStartVideoPaused(state.startGameId || '', video.paused);
      break;
    }
    case 'start-server-done':
      closeModal();
      break;
    case 'start-detect': {
      // 从启动页进来时先收起菜单：检测完页面会重绘，菜单留着会挡住新的服务器列表
      closeStartServerMenu();
      const result = await api.games.detect(element.dataset.game || undefined);
      if (result.ok) toast('检测完成，服务器路径已更新', 'success');
      else toast(result.error || '没有检测到新的客户端', 'info');
      break;
    }
    case 'start-link': {
      const gameId = element.dataset.game;
      if (!gameId) break;
      closeStartServerMenu();
      openLinkModal(gameId);
      break;
    }
    case 'back-home':
      navigate('home');
      break;
    /* 启动页唤出原生侧栏：窗口态把窗口向左外扩一块放它，扩不出去就浮在上面 */
    case 'toggle-start-nav':
      setStartNavOpen(!state.startNavOpen).catch(() => {});
      break;
    case 'close-start-nav':
      setStartNavOpen(false).catch(() => {});
      break;
    /* 主页 hero「启动页」按钮升级：直接回到该游戏的启动页 */
    case 'continue-game':
      state.startGameId = id;
      navigate('start');
      break;
    case 'minimize-window':
      await api.minimizeWindow();
      break;
    case 'window-minimize':
      await api.minimizeWindow();
      break;
    case 'window-maximize':
      // 侧栏外扩着时最大化：先把窗口收回原宽，否则还原窗口会多留一条侧栏的宽度
      if (state.startNavExpanded) await setStartNavOpen(false, { instant: true }).catch(() => {});
      await api.toggleMaximize();
      break;
    case 'window-close':
      await api.closeWindow();
      break;
    case 'scroll-library': {
      const scroll = () => {
        const section = document.querySelector('#home-library');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      if (state.route !== 'home') {
        navigate('home', { silent: true });
        window.setTimeout(scroll, 80);
      } else {
        scroll();
      }
      break;
    }
    case 'add-game':
      openGameModal();
      break;
    case 'create-desktop-shortcut': {
      try {
        const result = await api.createDesktopShortcut();
        toast(result.existed ? '桌面快捷方式已更新' : '桌面快捷方式已创建', 'success');
      } catch (error) {
        toast(`创建快捷方式失败：${error.message}`, 'error');
      }
      break;
    }
    case 'edit-game':
      openGameModal(id);
      break;
    case 'detect-game': {
      const game = state.games.find((g) => g.id === id);
      const result = await api.games.detect(id);
      if (result.ok) {
        toast(`已找到 ${game ? game.name : '游戏'} 的安装位置`, 'success');
      } else {
        toast(`${result.error || '没有自动检测到'}，可以手动选择启动程序`, 'info');
        if (game) openGameModal(id);
      }
      break;
    }
    // 启动页「下载游戏」：打开一键下载弹窗（渠道 / 目录 / 空间预估 / 进度）
    case 'download-game':
      closeStartServerMenu();
      openGameDownloadModal(id);
      break;
    // 启动页「路径选择」：复用服务器编辑弹窗，给当前（或第一个）服务器指启动程序
    case 'start-pick-path': {
      const game = state.games.find((item) => item.id === id);
      const servers = (game && game.servers) || [];
      const server = servers.find((item) => item.id === game.activeServerId) || servers[0];
      if (!game || !server) break;
      closeStartServerMenu();
      openServerModal(game.id, server.id);
      break;
    }
    case 'detect-all': {
      const result = await api.games.detect();
      if (result.ok) {
        toast(`检测完成，${result.updated.length} 个游戏已就绪`, 'success');
      } else {
        toast(result.error, 'info');
      }
      break;
    }
    case 'sync-official': {
      toast('正在从官网同步版本与封面…', 'info');
      const results = await api.games.syncOfficial();
      const ok = results.filter((item) => item.ok);
      if (ok.length) {
        const versions = ok
          .filter((item) => item.version || item.versionName)
          .map((item) => `${item.name} ${item.version || item.versionName}`)
          .join(' · ');
        toast(`官网同步完成${versions ? `：${versions}` : ''}`, 'success');
      } else {
        toast('暂时没有获取到新的版本信息，请检查网络后重试', 'error');
      }
      break;
    }
    case 'gacha-source': {
      const source = element.dataset.value;
      if (source === 'endfield') {
        state.gachaGameKey = 'endfield';
        openGachaSyncModal();
      } else if (source && source !== 'all') {
        // 从具体游戏的「+」芯片进来，直接预选该游戏，导入教程立即可见
        state.gachaGameKey = source;
        openGachaImportModal(source);
      } else {
        openGachaImportModal();
      }
      break;
    }
    case 'sync-gacha':
      openGachaSyncModal();
      break;
    case 'import-gacha':
      openGachaImportModal();
      break;
    case 'nte-folder': {
      try {
        const dir = await api.gacha.nteFolder();
        toast(`导出目录：${dir}`, 'info');
      } catch (error) {
        toast(error.message || '打不开导出目录', 'error');
      }
      break;
    }
    case 'nte-refresh': {
      try {
        const result = await api.gacha.nteRefresh();
        if (result?.account) {
          state.nteAccount = result.account;
        }
        await loadGacha(true);
        toast(result?.imported ? `已导入 ${result.imported} 条异环记录` : '已检查，没有新的导出文件', 'info');
      } catch (error) {
        toast(error.message || '检查失败', 'error');
      }
      break;
    }
    case 'nte-capture': {
      if (state.nteCapture?.running) {
        toast('正在抓取中，请先在游戏里打开抽卡记录', 'info');
        break;
      }
      try {
        state.nteCapture = { running: true, phase: 'progress', message: '正在准备抓取组件…' };
        renderNteCapture();
        const result = await api.gacha.nteCaptureStart(state.nteAutoPage !== false);
        state.nteCapture = {
          running: true,
          phase: 'capturing',
          message: state.nteAutoPage !== false
            ? '请在游戏里按 F3 打开抽卡记录，工具会自动翻页'
            : '请在游戏里按 F3 打开抽卡记录',
          jsonPath: result?.jsonPath || '',
        };
        renderNteCapture();
      } catch (error) {
        state.nteCapture = { running: false, phase: 'error', message: error.message || '抓取启动失败' };
        renderNteCapture();
        toast(error.message || '抓取启动失败', 'error');
      }
      break;
    }
    case 'nte-capture-stop': {
      try {
        const result = await api.gacha.nteCaptureStop();
        state.nteCapture = { running: false, phase: 'stopped', message: result?.message || '' };
        renderNteCapture();
        toast(result?.stopped ? '已结束抓取' : result?.message || '抓取已结束', 'info');
      } catch (error) {
        toast(error.message || '结束抓取失败', 'error');
      }
      break;
    }
    case 'nte-capture-auto-page': {
      state.nteAutoPage = !(state.nteAutoPage !== false);
      try {
        localStorage.setItem('vela:nte-auto-page', state.nteAutoPage ? '1' : '0');
      } catch {
        /* ignore */
      }
      render();
      break;
    }
    case 'refresh-gacha':
      await loadGacha(true);
      break;
    case 'refresh-gacha-meta': {
      toast('正在从官网拉取最新角色与武器图鉴…', 'info');
      try {
        await api.gacha.refreshMeta();
        await loadGacha(true);
        toast('图鉴已更新，新版本角色会自动出现在列表里', 'success');
      } catch (error) {
        toast(`图鉴更新失败：${error.message}`, 'error');
      }
      break;
    }
    case 'gacha-game':
      state.gachaGameKey = element.dataset.value;
      state.gachaUid = '';
      state.gachaScope = 'all';
      gachaEnsureSelection();
      render({ preserveScroll: true });
      break;
    case 'gacha-scope':
      state.gachaScope = element.dataset.value || 'all';
      render({ preserveScroll: true });
      break;
    case 'gacha-pool-tab': {
      // 池子卡片里的 5★/4★ 切换是纯本地显隐，不动全局状态、不重渲染
      const card = element.closest('.gacha-pool-card');
      if (card) {
        const tier = element.dataset.tier;
        card.querySelectorAll('.gacha-pool-tab').forEach((tab) => tab.classList.toggle('active', tab === element));
        card.querySelectorAll('.gacha-pool-rows').forEach((list) => list.classList.toggle('is-on', list.dataset.tier === tier));
      }
      break;
    }
    case 'choose-gacha-db': {
      const dbPath = await api.gacha.pickDatabase();
      if (dbPath) {
        state.gacha = null;
        await loadGacha(true);
      }
      break;
    }
    case 'add-server':
      openServerModal(element.dataset.game);
      break;
    case 'edit-server':
      openServerModal(element.dataset.game, element.dataset.server);
      break;
    case 'rebuild-server': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server = game && (game.servers || []).find((item) => item.id === element.dataset.server);
      if (!game || !server) break;
      if (game.builtinKey === 'endfield' && server.channel !== 'official') {
        // 终末地：只有非官服渠道才「生成」运行时（官服直接指定官服客户端即可，见下）
        await handleAction('prepare-endfield', element.dataset.server, element);
      } else {
        /*
         * 其余情况统一先问一句「怎么补上这份客户端」（硬链接 / 选路径 / 扫描）。
         * 以前这里替用户猜：有别的渠道就直接开硬链接安装，没有就开文件选择框 ——
         * 猜错的代价是白等一场安装，或者对着文件框不知道要选什么。
         */
        openServerSetupDialog(game.id, server.id);
      }
      break;
    }
    /**
     * 同一游戏里，除了自己之外，还有没有别的渠道客户端（文件真的还在）可当硬链接基础。
     *
     * 这里必须用 exists 而不是「path 字符串非空」：B服 的目录被删掉之后
     * path 还留在配置里，按老写法会以为还有个可用基础，于是官服点「重建」
     * 直接进硬链接生成 —— 用户看到的就是「我明明有官服，怎么还让我重建」。
     */
    function hasOtherInstalledServer(game, server) {
      return (game.servers || []).some(
        (item) => item.id !== server.id && item.exists && item.channel !== server.channel
      );
    }
    case 'activate-server':
      // 服务器行上的「切换」= 只换服（切完按钮会变成「启动」）。以前这里点一下
      // 游戏自己就起来了，而启动页下拉里点同一行只切换，两处手感对不上。
      await switchServerProfile(element.dataset.game, element.dataset.server, { launch: false });
      break;
    case 'prepare-endfield': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server = game && (game.servers || []).find((item) => item.id === element.dataset.server);
      // 和「切换服务器」用同一条提示：进度可见，别让人对着一条不会动的 toast 等几十秒
      const busy = beginBusyToast(`正在为 ${server ? server.name : '渠道'}生成运行时…`);
      const offProgress =
        typeof api.onEndfieldProgress === 'function'
          ? api.onEndfieldProgress((progress) => {
              if (!progress) return;
              busy.update(endfieldProgressText({ ...progress, serverName: progress.serverName || server?.name }));
            })
          : null;
      try {
        const result = await api.servers.prepareEndfield({
          gameId: element.dataset.game,
          serverId: element.dataset.server,
        });
        busy.done(
          `「${server ? server.name : '新服务器'}」运行时已就绪：链接 ${result.linked} 个文件，覆盖 ${result.overlay} 个差异文件`,
          'success'
        );
      } catch (error) {
        busy.done(humanError(error), 'error');
      } finally {
        if (offProgress) offProgress();
      }
      break;
    }
    case 'prepare-sophon':
      openSophonModal(element.dataset.game, element.dataset.server, 'prepare');
      break;
    case 'update-sophon':
      openSophonModal(element.dataset.game, element.dataset.server, 'update');
      break;
    /* ── 预下载 ───────────────────────────────────────────────── */
    case 'open-predownload': {
      const game = state.games.find((item) => item.id === id);
      const server = game && (game.servers || []).find((item) => item.id === game.activeServerId);
      if (!game || !server) {
        toast('这个游戏还没有可用的服务器', 'info');
        break;
      }
      openPredownloadModal(game.id, server.id);
      break;
    }
    case 'predownload-open':
      openPredownloadModal(element.dataset.game, element.dataset.server);
      break;
    case 'predownload-check':
      await runPredownloadCheck(element.dataset.game, element.dataset.server);
      break;
    case 'predownload-clear': {
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const game = state.games.find((item) => item.id === gameId);
      const server = game && (game.servers || []).find((item) => item.id === serverId);
      if (!game || !server) break;
      const ok = await confirmDialog({
        title: '清除预下载内容',
        message: `会删掉「${server.name}」已经下好的预下载内容（${predownloadSizeText(predownloadInfo(server)) || '预下载目录'}），游戏文件不受影响。清掉后要重新下载。`,
        confirmText: '清除',
        danger: true,
      });
      if (!ok) break;
      try {
        await predownloadApi().clear({ gameId, serverId });
        toast('预下载内容已清除', 'success');
      } catch (error) {
        toast(humanError(error), 'error');
      }
      repaintServerRows();
      if (pdModalRepaint) pdModalRepaint();
      break;
    }
    /*
     * 单个服务器覆盖「剧情分类资源包」。
     * 就地切开关（paintSwitch）而不是整页重绘：重绘出的按钮一出生就是终态，
     * 滑块没有起点，看着就像点了没反应。
     */
    case 'toggle-pd-story': {
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const game = state.games.find((item) => item.id === gameId);
      const server = game && (game.servers || []).find((item) => item.id === serverId);
      if (!game || !server) break;
      const override = storyOverride(server);
      const on = override === null ? state.settings.includeStoryResources === true : override;
      const next = !on;
      paintSwitch(element, next);
      try {
        await predownloadApi().setStoryResources({ gameId, serverId, enabled: next });
      } catch (error) {
        paintSwitch(element, on);
        toast(humanError(error), 'error');
        break;
      }
      // 标签和「跟随全局」按钮就地显隐，不重建开关节点
      const story = element.closest('.pd-story');
      const tag = story ? story.querySelector('.pd-story-tag') : null;
      if (tag) {
        tag.textContent = '已单独设置';
        tag.classList.add('is-over');
      }
      const reset = story ? story.querySelector('[data-action="reset-pd-story"]') : null;
      if (reset) reset.hidden = false;
      if (pdModalRepaint) pdModalRepaint();
      break;
    }
    case 'reset-pd-story': {
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      try {
        await predownloadApi().setStoryResources({ gameId, serverId, enabled: null });
        toast('已改回跟随全局设置', 'info');
      } catch (error) {
        toast(humanError(error), 'error');
        break;
      }
      // 点的是按钮不是开关，这里整块重建没问题；重建后开关落在终态，下次点仍有动画
      if (pdModalStoryRepaint) pdModalStoryRepaint();
      if (pdModalRepaint) pdModalRepaint();
      break;
    }
    /*
     * 异环官服 / B服：切到 B服之前必须弹一次确认，把流程四步原样摆出来，不默默切。
     */
    case 'nte-set-channel': {
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const channel = element.dataset.channel || 'official';
      const game = state.games.find((item) => item.id === gameId);
      const server = game && (game.servers || []).find((item) => item.id === serverId);
      if (!server) break;
      /*
       * 异环的「渠道卡片」和「服务器行的切换」是同一件事：改 Config.ini 之后还要把
       * activeServerId 指过去、路径跟着走。以前这里只调 set-channel，于是点完卡片
       * 渠道变了、当前服务器还停在原来那行，和点服务器行切换的结果不一样。
       * 现在统一交给 switchServerProfile。
       */
      const target = (game.servers || []).find((item) => item.channel === channel);
      if (target) await switchServerProfile(gameId, target.id, { launch: false });
      else await switchNteChannel(game, server, channel);
      refreshNtePanel();
      break;
    }
    case 'focus-sophon': {
      const jobId = element.dataset.id;
      const job = sophonJobs.find((item) => item.id === jobId);
      if (!job) break;
      if (job.status === 'queued') {
        toast(`「${job.serverName}」还在排队，前面的任务结束后会自动开始`, 'info');
        break;
      }
      if (job.status === 'starting' || job.status === 'running') {
        // 收起来过：原样挂回去（进度条、阶段条、监听都还在）
        if (restoreTaskModal()) break;
        // 没收起说明弹窗就在眼前；真找不到 DOM 才提示一句
        if (!document.querySelector('#sophon-progress, #dl-stages')) {
          toast('任务正在后台进行，先看任务条上的进度', 'info');
        }
        break;
      }
      // 结束态：重新打开这个界面，让用户还能回来看结果或再操作一次
      if (sophonJobs.some((item) => ['starting', 'running'].includes(item.status))) {
        toast('还有任务在跑，等它结束再打开这个界面', 'info');
        break;
      }
      // 下载任务走下载界面，硬链接 / 更新走硬链接界面，别把两种界面串了
      if (job.mode === 'download') openGameDownloadModal(job.gameId);
      else openSophonModal(job.gameId, job.serverId, job.mode);
      break;
    }
    case 'dismiss-sophon-job': {
      const jobId = element.dataset.id;
      sophonJobs = sophonJobs.filter((item) => item.id !== jobId);
      renderTaskDock();
      break;
    }
    case 'restore-sophon':
      if (!restoreTaskModal() && sophonUi) sophonUi.restore();
      break;
    case 'cancel-sophon-dock': {
      if (sophonUi) {
        sophonUi.cancel();
        break;
      }
      /*
       * 弹窗还开在前台时 sophonUi 是空的，以前点任务条上的 ✕ 完全没反应。
       * 这里兜底：直接按 jobId 取消，并把这一条收进「已停止」。
       */
      const jobId = element.dataset.id;
      const job = sophonJobs.find((item) => item.id === jobId);
      if (!job) break;
      api.servers.cancelSophon(jobId).catch(() => {});
      job.status = 'cancelled';
      pruneSophonHistory();
      renderTaskDock();
      toast('已停止任务', 'info');
      break;
    }
    case 'remove-sophon-queue': {
      const queueId = element.dataset.id;
      sophonJobs = sophonJobs.filter((job) => job.id !== queueId);
      renderTaskDock();
      toast('已移出硬链接队列', 'info');
      break;
    }
    case 'clear-server-path': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server = game && (game.servers || []).find((item) => item.id === element.dataset.server);
      if (!game || !server) break;
      /*
       * 用户点这个垃圾桶，多半是想「把 B服 删掉」。
       * 但官服和 B服 常常共用同一个安装目录 —— 他转头去资源管理器删文件夹，
       * 官服就一起没了。所以只要存在共用关系，就先把这层说破。
       */
      const shared = sharedRootWith(game, server);
      const message = shared
        ? `只会清除「${server.name}」的路径记录，不会删除任何文件，也不会移除这张服务器卡片。\n\n注意：「${shared.name}」用的是同一个安装目录（${server.root}）。如果你想彻底卸载这个渠道，删掉这个文件夹会连「${shared.name}」一起失效 —— 要删文件请先确认另一个渠道换到了别的目录。`
        : `只会清除「${server.name}」的路径记录，不会删除客户端文件，也不会移除这张服务器卡片。`;
      const ok = await confirmDialog({
        title: '清除服务器路径',
        message,
        confirmText: '清除路径',
        danger: true,
      });
      if (ok) {
        await api.servers.clearPath({
          gameId: element.dataset.game,
          serverId: element.dataset.server,
        });
        toast('路径已清除，服务器卡片保留', 'success');
      }
      break;
    }
    case 'remove-server': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server = game && (game.servers || []).find((item) => item.id === element.dataset.server);
      if (!server) break;
      const ok = await confirmDialog({
        title: '移除服务器配置',
        message: `确定要移除「${server.name}」吗？只会删除启动器中的路径记录，不会删除客户端文件。`,
        confirmText: '移除配置',
        danger: true,
      });
      if (ok) {
        await api.servers.remove({ gameId: element.dataset.game, serverId: element.dataset.server });
        toast('服务器配置已移除', 'success');
      }
      break;
    }
    case 'uninstall-server': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server =
        game && (game.servers || []).find((item) => item.id === element.dataset.server);
      if (!game || !server) break;
      // 老版本主进程没有这两个方法：这里先拦住，别让它变成一句看不懂的英文报错
      if (typeof api.servers?.uninstall !== 'function') {
        toast('启动器本体和界面版本不一致，重启一次启动器再试', 'error');
        break;
      }
      // 游戏开着的时候文件被占着，问了也白问：先给一句能照着做的话
      if (game.running) {
        toast('游戏正在运行，先关掉游戏再卸载客户端', 'error');
        break;
      }
      /*
       * 卸载 = 真删文件，和「清除路径」是两件事，所以先问主进程能不能删：
       * 共用同一目录的（官服 / B服 常见）、盘符根目录、游戏正开着，都会被挡回来。
       */
      let plan;
      try {
        plan = await api.servers.uninstallPlan({ gameId: game.id, serverId: server.id });
      } catch (error) {
        toast(error?.message || '读不到这个服务器的安装目录', 'error');
        break;
      }
      if (!plan?.ok) {
        /*
         * 共用目录是最常见的拦路虎：官服/B服、异环官服/B服 很多时候压根就是同一个
         * 文件夹，删谁都是两边一起没。不能硬来，但也不能只丢一句「删不了」就完事 ——
         * 用户真实的诉求往往是「让这个服从列表里消失」，那就把这条路给出来。
         */
        if (plan?.shared?.length) {
          const removeOnly = await confirmDialog({
            title: '这个目录和别的服共用',
            message: `「${server.name}」和「${plan.shared.join(
              '」「'
            )}」用的是同一个文件夹：\n\n${plan.root}\n\n删掉它，这几边会一起失效，所以卸载被拦下来了。\n\n可以只把「${server.name}」从列表里去掉（客户端文件一个都不动）；想让两边都能删，得先去服务器管理里给它们各指一个独立目录。`,
            confirmText: '只移出列表',
          });
          if (removeOnly) {
            await api.servers.remove({ gameId: game.id, serverId: server.id });
            toast(`「${server.name}」已移出列表，客户端文件没有动`, 'success');
            repaintServerRows();
          }
          break;
        }
        toast(plan?.reason || '这个服务器暂时不能卸载', 'error');
        break;
      }
      if (plan.running) {
        toast('游戏还开着，先关掉游戏再卸载', 'error');
        break;
      }
      const choice = await uninstallDialog({
        title: `卸载「${server.name}」`,
        message: plan.exists
          ? `会把下面这个文件夹整个删掉，只动这一个目录，其它服务器的客户端不受影响。启动器里的「${server.name}」卡片会留着，之后可以重新下载。`
          : `「${server.name}」记录的目录已经不在了，这一步只会清掉启动器里的路径记录。`,
        root: plan.exists ? plan.root : '',
        exists: Boolean(plan.exists),
      });
      if (!choice) break;
      /*
       * 主进程现在返回结果对象而不是抛异常：失败原因分得清（占用 / 回收站不可用 /
       * 其它），文案也是中文的。选了回收站但系统不给用，再问一次要不要改成永久删除。
       */
      const runUninstall = async (force) => {
        try {
          return await api.servers.uninstall({
            gameId: game.id,
            serverId: server.id,
            force: force === true,
          });
        } catch (error) {
          return { ok: false, code: 'OTHER', reason: humanError(error) };
        }
      };
      let result = await runUninstall(choice === 'force');
      if (!result?.ok && result?.code === 'TRASH') {
        const forceIt = await confirmDialog({
          title: '回收站用不了',
          message: `系统不让把文件挪进回收站：${result.reason || ''}\n\n改成「永久删除」吗？这一步删掉就找不回来了。`,
          confirmText: '永久删除',
          danger: true,
        });
        if (!forceIt) {
          toast('已取消，文件没有动', 'info');
          break;
        }
        result = await runUninstall(true);
      }
      if (!result?.ok) {
        toast(result?.reason || '卸载没成功', 'error');
        break;
      }
      toast(
        plan.exists
          ? result.forced || choice === 'force'
            ? '客户端已永久删除'
            : '客户端已移到回收站'
          : '路径记录已清除',
        'success'
      );
      repaintServerRows();
      break;
    }
    case 'open-server-folder':
      await api.servers.openFolder({
        gameId: element.dataset.game,
        serverId: element.dataset.server,
      });
      break;
    case 'link-servers':
      openLinkModal(element.dataset.game);
      break;
    case 'toggle-fav':
      await toggleFavorite(id);
      break;
    case 'duo-game': {
      // 花火卡：直接开「最近在玩」那一场
      const target = state.games.find((item) => item.id === element.dataset.game);
      if (!target) {
        toast('还没有开场记录，先在游戏库里挑一个吧', 'info');
        navigate('home');
        break;
      }
      const started = await api.games.launch(target.id);
      if (started.ok) {
        playUiSound('launch');
        if (!target.demo) toast(`正在启动 ${target.name}`, 'info');
      } else if (started.elevationRequired) {
        toast('需要管理员权限，请到游戏卡片上用启动按钮', 'error');
      } else {
        toast(started.error, 'error');
      }
      break;
    }
    case 'duo-song':
      // 火花卡：去点歌台
      navigate('song');
      break;
    case 'duo-toggle':
      // 火花卡上的播放/暂停键：点击落在键上，不会再冒泡去开点歌台
      playCurrentSong(true);
      break;
    case 'duo-next':
    case 'duo-prev': {
      // 火花卡上的上一首/下一首：复用点歌台的切歌逻辑，但不整页重绘
      if (!state.songs.length) break;
      const forward = action === 'duo-next';
      const options = { skipRender: state.route !== 'song' };
      if (forward && state.playMode === 'shuffle') {
        await playSongAt(randomSongIndex(), options);
        break;
      }
      const step = forward ? 1 : -1;
      const next = (state.songIndex + step + state.songs.length) % state.songs.length;
      await playSongAt(next, options);
      break;
    }
    case 'launch-game': {
      const game = state.games.find((g) => g.id === id);
      const result = await api.games.launch(id);
      if (result.ok) playUiSound('launch');
      if (!result.ok) {
        if (result.elevationRequired) {
          const restart = await confirmDialog({
            title: '需要管理员权限',
            message: `${result.error}\n\n选择“记住并重启”后，启动器会保存这个兼容设置；以后启动会直接请求 Windows UAC。`,
            confirmText: '记住并重启',
          });
          if (restart) {
            await api.updateSettings({ alwaysAdmin: true });
            await api.relaunchAdmin();
          }
        } else {
          toast(result.error, 'error');
        }
      } else if (game && !game.demo) {
        toast(`正在启动 ${game.name}`, 'info');
      }
      break;
    }
    case 'stop-game': {
      const game = state.games.find((g) => g.id === id);
      const ok = await confirmDialog({
        title: '结束游戏进程',
        message: `确定要结束「${game ? game.name : '这个游戏'}」吗？未保存的进度可能会丢失。`,
        confirmText: '结束进程',
        danger: true,
      });
      if (ok) {
        const result = await api.games.stop(id);
        if (!result.ok) toast(result.error, 'error');
        else toast('已结束游戏进程', 'info');
      }
      break;
    }
    case 'delete-game': {
      const game = state.games.find((g) => g.id === id);
      if (!game) break;
      const ok = await confirmDialog({
        title: '从库中移除',
        message: `确定要移除「${game.name}」吗？这只会删除启动器中的条目，不会删除游戏文件。`,
        confirmText: '移除',
        danger: true,
      });
      if (ok) {
        const removed = await api.games.remove(id);
        if (!removed) {
          toast('这个条目已经不在游戏库里了', 'info');
          return;
        }
        state.games = state.games.filter((item) => item.id !== id);
        closeModal();
        render({ preserveScroll: true });
        toast('已从游戏库移除', 'success');
      } else if (editingId) {
        openGameModal(id);
      }
      break;
    }
    case 'clear-demo': {
      const count = state.games.filter((g) => g.demo).length;
      const ok = await confirmDialog({
        title: '清空示例条目',
        message: `将移除 ${count} 个示例条目。你添加的游戏不会受影响。`,
        confirmText: '清空示例',
        danger: true,
      });
      if (ok) {
        await api.games.clearDemo();
        toast('示例条目已清空', 'success');
      }
      break;
    }
    case 'set-filter':
      state.filter = element.dataset.value || 'all';
      render({ preserveScroll: true });
      break;
    case 'clear-search':
      state.search = '';
      render({ preserveScroll: true });
      break;
    case 'clear-filters':
      state.filter = 'all';
      state.search = '';
      state.sort = 'recent';
      render({ preserveScroll: true });
      break;
    case 'add-download':
      openDownloadModal();
      break;
    case 'pause-download':
      await api.downloads.pause(id);
      break;
    case 'pause-all-downloads':
      await Promise.all(
        state.downloads
          .filter((item) => item.status === 'downloading' || item.status === 'queued')
          .map((item) => api.downloads.pause(item.id))
      );
      toast('已暂停当前下载', 'info');
      break;
    case 'resume-all-downloads':
      await Promise.all(
        state.downloads
          .filter((item) => item.status === 'paused' || item.status === 'error')
          .map((item) => api.downloads.resume(item.id))
      );
      toast('已继续暂停的下载', 'info');
      break;
    case 'resume-download':
      await api.downloads.resume(id);
      break;
    case 'cancel-download': {
      const ok = await confirmDialog({
        title: '取消下载',
        message: '已经下载的片段会被清理，确定要取消吗？',
        confirmText: '取消下载',
        danger: true,
      });
      if (ok) await api.downloads.cancel(id);
      break;
    }
    case 'remove-download':
      await api.downloads.remove(id);
      break;
    case 'open-download':
      await api.downloads.open(id);
      break;
    case 'open-download-folder':
      if (id) await api.downloads.openFolder(id);
      else await api.openDownloadFolder();
      break;
    case 'toggle-quick':
      quickOpen = !quickOpen;
      if (!quickOpen && state.settings.quickPanelPinned) {
        await api.updateSettings({ quickPanelPinned: false });
      }
      renderQuickPanel();
      break;
    case 'toggle-quick-pin': {
      const pinned = !(state.settings.quickPanelPinned === true);
      state.settings.quickPanelPinned = pinned;
      quickOpen = pinned ? true : quickOpen;
      await api.updateSettings({ quickPanelPinned: pinned });
      renderQuickPanel();
      break;
    }
    case 'quick-launch': {
      // 快捷面板的语义是「一键进游戏」：切换 + 启动，走和别处同一条切换流程
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const switched = await switchServerProfile(gameId, serverId, { launch: true });
      // 用户在确认框里点了取消：面板留着，让他接着选
      if (!switched.cancelled && !state.settings.quickPanelPinned) quickOpen = false;
      renderQuickPanel();
      break;
    }
    case 'toggle-sidebar': {
      /*
       * 启动页抽屉开着的时候，侧栏底下那颗「收起侧栏」= 把抽屉收回去。
       *
       * 以前这里不分场合，直接走全局的「侧栏收成 72px 图标条」：抽屉是露出一条
       * 238px 的面板，缩成 72 之后窗口还停在展开后的宽度，左边空出一大条 —— 看着
       * 就像侧栏被搞掉了。抽屉里的收起，语义本来就该是收抽屉。
       */
      if (state.startNavOpen) {
        setStartNavOpen(false).catch(() => {});
        break;
      }
      /*
       * 启动页、抽屉关着：这颗 chevron 的含义是「展开大侧栏」。
       * 之前这里直接落到下面的全局分支，变成把小侧栏再收一格 ——
       * 大侧栏永远出不来。启动页没有「收成 72px 图标条」这个语义，
       * 开关都归抽屉管。
       */
      if (state.route === 'start') {
        setStartNavOpen(true).catch(() => {});
        break;
      }
      const collapsed = !(state.settings.sidebarCollapsed === true);
      state.settings.sidebarCollapsed = collapsed;
      applySettings();
      updateChrome();
      repositionDockedMini();
      await api.updateSettings({ sidebarCollapsed: collapsed });
      break;
    }
    case 'open-data-folder':
      await api.openDataFolder();
      break;
    /*
     * 「查看日志 / 打开文件」这两个按钮以前完全没有处理分支——
     * markup 里写了 data-action，switch 里没有 case，点下去一点反应都没有，
     * 而设置项文案还写着「把这里的日志发回来就能定位」，等于承诺了一个不存在的功能。
     * 主进程侧 app:open-update-log / app:read-update-log 早就写好了，缺的只是这一层接线。
     */
    case 'open-update-log':
      await api.openUpdateLog();
      break;
    case 'view-update-log': {
      let payload = null;
      try {
        payload = await api.readUpdateLog();
      } catch (error) {
        toast(`读取更新日志失败：${humanError(error)}`, 'error');
        break;
      }
      const sections = [
        ['update-log.txt', payload?.log],
        ['self-heal.log', payload?.selfHeal],
        ['update-error.json', payload?.error],
      ].filter(([, text]) => String(text || '').trim());
      const logBody = sections.length
        ? sections
            .map(
              ([name, text]) =>
                `<section class="ulog-block"><h3>${esc(name)}</h3><pre class="ulog-pre">${esc(String(text).trim())}</pre></section>`
            )
            .join('')
        : '<p class="ulog-empty">还没有日志。只有真正跑过一次自更新（检查到新版本并覆盖过程序文件）才会有内容。</p>';
      openModal(`
        <div class="modal-backdrop" data-backdrop>
          <div class="modal ulog-modal" role="dialog" aria-modal="true">
            <div class="modal-head">
              <div>
                <h2>更新日志</h2>
                <p class="ulog-path" title="${esc(payload?.dir || '')}">${esc(payload?.dir || '')}</p>
              </div>
              <button class="modal-close" data-close title="关闭">${icon('x')}</button>
            </div>
            <div class="modal-body ulog-body">${logBody}</div>
            <div class="modal-foot">
              <button class="btn btn-ghost" data-action="open-update-log">${icon('folder')}打开所在文件夹</button>
              <button class="btn btn-primary" data-close>关闭</button>
            </div>
          </div>
        </div>`);
      break;
    }
    case 'check-update': {
      try {
        toast('正在检查更新…', 'info');
        const result = await api.checkUpdate();
        if (result && result.hasUpdate) {
          openUpdateModal(result);
        } else if (result && result.ok) {
          toast('已经是最新版本', 'success');
        } else {
          toast(result && result.error ? `检查失败：${result.error}` : '检查失败', 'error');
        }
      } catch (error) {
        toast(`检查失败：${humanError(error)}`, 'error');
      }
      break;
    }
    case 'apply-update': {
      const info = state.update || {};
      const ok = await confirmDialog({
        title: `更新到 v${info.latest || ''}`,
        message: '会关闭启动器、用更新包覆盖程序文件，然后自动重新打开。\n\n游戏、账号、抽卡记录、歌单和设置都在数据目录里，不会被覆盖。',
        confirmText: '开始更新',
      });
      if (!ok) break;
      try {
        toast('开始下载更新包…', 'info');
        const result = await api.applyUpdate();
        if (result && result.ok) {
          closeModal();
          toast('正在覆盖更新，启动器即将重新打开…', 'success');
        } else if (result && result.message) {
          toast(result.message, 'info');
        }
      } catch (error) {
        toast(`更新失败：${humanError(error)}`, 'error');
      }
      break;
    }
    case 'save-update-source': {
      const input = document.querySelector('#update-manifest');
      const value = (input ? input.value : '').trim();
      await api.updateSettings({ updateManifest: value });
      toast(value ? '更新源已保存，正在检查…' : '已改回内置的官方源', 'success');
      if (value) {
        try {
          const result = await api.checkUpdate();
          if (result && result.hasUpdate) openUpdateModal(result);
        } catch (error) {
          toast(`检查失败：${humanError(error)}`, 'error');
        }
      } else {
        try {
          const result = await api.checkUpdate();
          if (result && result.hasUpdate) openUpdateModal(result);
        } catch {
          /* 内置源读不到时不打扰用户 */
        }
      }
      state.settings.updateManifest = value;
      render();
      break;
    }
    case 'fill-mirror-source': {
      const input = document.querySelector('#update-manifest');
      if (input) input.value = GITEE_MANIFEST_URL;
      await api.updateSettings({ updateManifest: GITEE_MANIFEST_URL });
      toast('已换成国内镜像源，正在检查…', 'success');
      try {
        const result = await api.checkUpdate();
        if (result && result.hasUpdate) openUpdateModal(result);
        else if (result && result.ok) toast('已经是最新版本', 'success');
        else toast((result && result.error) || '检查失败', 'error');
      } catch (error) {
        toast(`检查失败：${humanError(error)}`, 'error');
      }
      render();
      break;
    }
    case 'rollback-update': {
      const backup = state.update && state.update.backup;
      const target = backup && backup.version ? `v${backup.version}` : '上一个版本';
      const ok = await confirmDialog({
        title: '回到上一个版本',
        message: `会把程序文件还原到升级前的 ${target}，游戏、账号、抽卡记录和设置都不受影响。还原完成后自动重启。`,
        confirmText: '还原并重启',
      });
      if (!ok) break;
      try {
        const result = await api.rollbackUpdate();
        if (result && result.ok) toast('正在还原并重启…', 'success');
        else toast((result && result.message) || '没有找到可回滚的备份', 'error');
      } catch (error) {
        toast(`回滚失败：${humanError(error)}`, 'error');
      }
      break;
    }
    case 'open-changelog': {
      navigate('news');
      break;
    }
    case 'pick-update-source': {
      try {
        const result = await api.pickUpdateSource();
        if (!result || result.cancelled) break;
        const status = result.status || {};
        toast(status.hasUpdate ? `发现新版本 v${status.latest}` : '更新源已设置', 'success');
        if (status.hasUpdate) openUpdateModal(status);
        render();
      } catch (error) {
        toast(`选择失败：${humanError(error)}`, 'error');
      }
      break;
    }
    case 'install-update': {
      const ok = await confirmDialog({
        title: '导入启动器更新包',
        message:
          '会关闭启动器，用 ZIP 中的文件覆盖程序目录，然后重新打开。\n\n游戏、账号、设置和封面数据保存在独立的数据目录，不会被覆盖。',
        confirmText: '覆盖并重启',
      });
      if (!ok) break;
      try {
        const result = await api.installUpdate();
        if (result?.ok) toast('正在覆盖更新，启动器即将重新打开…', 'success');
      } catch (error) {
        toast(`更新失败：${error.message}`, 'error');
      }
      break;
    }
    case 'relaunch-admin': {
      const ok = await confirmDialog({
        title: '以管理员身份重启',
        message: 'Windows 会弹出 UAC 确认。重启后当前页面会关闭，请重新打开启动器。',
        confirmText: '重启',
      });
      if (ok) {
        const result = await api.relaunchAdmin();
        if (!result.ok) toast(result.error, 'error');
      }
      break;
    }
    case 'change-download-dir': {
      const dir = await api.pick.directory();
      if (dir) {
        await api.updateSettings({ downloadDir: dir });
        toast('下载文件夹已更新', 'success');
      }
      break;
    }
    case 'update-endfield-packs': {
      toast('正在检查终末地官方渠道包…', 'info');
      try {
        const result = await api.endfield.updateOfficial();
        const updated = (result.results || []).filter((item) => !item.skipped && item.updated);
        toast(
          updated.length
            ? `官方渠道包已更新：${updated.map((item) => item.iconName).join('、')}`
            : '官方渠道包已是最新版本',
          'success'
        );
      } catch (error) {
        toast(`官方渠道包更新失败：${error.message}`, 'error');
      }
      break;
    }
    case 'manage-endfield-packs':
      openEndfieldPackModal();
      break;
    case 'update-endfield-game': {
      const game = (state.games || []).find((item) => item.builtinKey === 'endfield');
      const server = game?.servers.find((item) => item.active);
      if (!game || !server?.exists) {
        toast('先配置终末地客户端路径', 'error');
        break;
      }
      const ok = await confirmDialog({
        title: '更新终末地游戏本体',
        message: `将从官方接口对比完整游戏清单，只下载有差异的文件。\n\n当前客户端：${server.root || server.path}\n\n首次对比可能读取大量文件，更新期间请勿启动游戏。`,
        confirmText: '开始更新',
      });
      if (!ok) break;
      toast('正在检查终末地游戏版本…', 'info');
      try {
        const result = await api.endfield.updateGame();
        toast(
          result.skipped
            ? `终末地已是最新版本（${result.version}）`
            : `终末地已更新到 ${result.version}：${result.updated} 个文件`,
          'success'
        );
        await api.getState().then(onState);
      } catch (error) {
        toast(`终末地本体更新失败：${error.message}`, 'error');
      }
      break;
    }
    case 'sync-endfield-packs': {
      const result = await api.endfield.syncPacks();
      if (result?.ok) {
        toast(
          result.updated.length
            ? `渠道包已更新：${result.updated.join('、')}`
            : '渠道包已是最新版本',
          'success'
        );
      }
      break;
    }
    case 'import-endfield-packs': {
      const result = await api.endfield.importPacks();
      if (result?.ok) {
        toast(`已导入 ${result.imported.length} 个渠道包，之后不再需要 XelLauncher`, 'success');
      }
      break;
    }
    case 'change-endfield-pack-root': {
      const dir = await api.pick.directory();
      if (dir) {
        await api.updateSettings({ endfieldPackRoot: dir });
        toast('终末地渠道包目录已更新', 'success');
      }
      break;
    }
    case 'change-runtime-root': {
      const dir = await api.pick.directory();
      if (dir) {
        await api.updateSettings({ runtimeRoot: dir });
        toast('运行时目录已更新', 'success');
      }
      break;
    }
    case 'settings-tab': {
      const key = element.dataset.value;
      if (!key || !SETTINGS_TABS.some(([id]) => id === key)) break;
      if (key === settingsTab()) break;
      state.settingsTab = key;
      try {
        localStorage.setItem('vela:settings-tab', key);
      } catch (error) {
        /* 本地存储不可用时只在本次会话生效 */
      }
      render();
      break;
    }
    case 'set-theme': {
      const theme = element.dataset.value;
      if (!theme || !THEME_OPTIONS.some(([key]) => key === theme)) break;
      await applySettingLocally({ theme });
      render({ preserveScroll: true });
      break;
    }
    case 'set-accent': {
      const accent = element.dataset.value;
      if (!accent || !ACCENT_OPTIONS.some(([key]) => key === accent)) break;
      await applySettingLocally({ accent });
      render({ preserveScroll: true });
      break;
    }
    case 'set-material': {
      const material = element.dataset.value || 'none';
      if (!MATERIAL_OPTIONS.includes(material)) break;
      // 先动窗口（主进程控制透明度 + DWM 材质），再存设置。
      const applied = await window.launcher.windowMaterial.apply(material);
      if (!applied?.ok) {
        // 系统不支持这个材质时不要在界面上假装生效，否则用户会以为点了有效
        toast(applied?.reason || '这个材质在当前系统上不可用', 'error');
        break;
      }

      // 关键：必须在 applySettings 之前写好本地 settings。
      // updateSettings 会经 state:patch → applySettings 重跑一遍，那时如果
      // state.settings.material 还是旧值，就会把 data-material 覆盖回 none，
      // 表现为「点了按钮没反应」。
      await applySettingLocally({ material });
      render({ preserveScroll: true });

      if (material !== 'none' && applied.transparency === false) {
        toast('系统的「透明效果」是关闭的，材质不会显示。在 设置 → 个性化 → 颜色 里打开它。', 'info');
      } else if (material !== 'none') {
        toast(`已切换到${MATERIAL_LABEL[material] || material}材质`, 'success');
      }
      break;
    }
    case 'pick-background': {
      const source = await api.pick.image();
      if (!source) break;
      try {
        const imported = await window.launcher.importBackground(source);
        await api.updateSettings({ customBackground: imported });
        toast('背景已更新', 'success');
      } catch (error) {
        toast(humanError(error), 'error');
      }
      break;
    }
    case 'reset-background':
      await api.updateSettings({ customBackground: '' });
      toast('已恢复纯色背景', 'success');
      break;
    case 'set-ui-scale': {
      const scale = normalizeUiScale(element.dataset.value);
      if (scale === currentUiScale()) break;
      await setUiScale(scale);
      break;
    }
    case 'toggle-sound': {
      const key = element.dataset.key;
      if (!key || !(key in state.sound)) break;
      state.sound[key] = !state.sound[key];
      saveSoundSettings();
      // 就地切状态：整页重绘出来的按钮一出生就是终态，滑块看不到位移过程
      paintSwitch(element, state.sound[key]);
      // 总开关关掉后「试听」三个按钮要一起置灰，同样只改这几个节点
      if (key === 'enabled') {
        document.querySelectorAll('[data-action="preview-sound"]').forEach((button) => {
          button.disabled = !state.sound.enabled;
        });
      }
      if (key === 'enabled' && state.sound.enabled) {
        // 总开关是在「音效还关着」的状态下按下的，按下那一刻没有声音，这里补一声
        playUiSound('toggle', true);
      }
      // 其余开关：pointerdown 已经出过 toggle 音，这里不再补第二声
      break;
    }
    case 'preview-sound': {
      if (!state.sound.enabled) {
        toast('先开启界面音效再试听', 'info');
        break;
      }
      playUiSound(element.dataset.value || 'click', true);
      break;
    }
    case 'set-salutation':
      await api.updateSettings({ profileName: element.dataset.value });
      toast(`称呼已改为「${element.dataset.value}」`, 'success');
      break;
    case 'set-starrail-fps': {
      const fps = Number(element.dataset.value) || 60;
      try {
        const result = await api.starrail.setFps(fps);
        state.starrailFps = result.fps;
        render({ preserveScroll: true });
        toast(`星穹铁道帧率已设为 ${result.fps} FPS，启动游戏后生效`, 'success');
      } catch (error) {
        toast(`写入星铁帧率失败：${error.message}`, 'error');
      }
      break;
    }
    case 'change-cover': {
      const source = await api.pick.image();
      if (!source) break;
      const imported = await api.importCover(source);
      await api.games.setCover(id, imported);
      toast('游戏封面已更新', 'success');
      break;
    }
    case 'change-avatar': {
      const source = await api.pick.image();
      if (!source) break;
      const imported = await api.importAvatar(source);
      await api.updateSettings({ avatar: imported });
      toast('头像已更新', 'success');
      break;
    }
    case 'reset-avatar':
      await api.updateSettings({ avatar: '' });
      toast('已恢复默认头像', 'success');
      break;
    case 'toggle-setting': {
      const key = element.dataset.key;
      if (!key) break;
      const next = !state.settings[key];
      state.settings = { ...state.settings, [key]: next };
      /*
       * 先就地切状态，再记下这份设置的指纹。主进程随后回推的同内容设置
       * 就不整页重绘了——重绘会把刚跑起来的滑块动画掐断（新节点一出生就是终态）。
       */
      paintSwitch(element, next);
      expectSettingsEcho(state.settings);
      await api.updateSettings({ [key]: next });
      if (key === 'autoUpdateEndfieldPacks' && !next) {
        toast('已关闭后台自动更新；手动更新、切换服务器和启动游戏仍然可用', 'info');
      }
      break;
    }
    case 'toggle-charms': {
      const next = !(state.settings.charms !== false);
      paintSwitch(element, next);
      expectSettingsEcho({ ...state.settings, charms: next });
      await applySettingLocally({ charms: next });
      toast(next ? '装饰挂饰已开启' : '装饰挂饰已关闭', next ? 'success' : 'info');
      break;
    }
    case 'toggle-charbg': {
      const next = !(state.settings.charBg !== false);
      paintSwitch(element, next);
      expectSettingsEcho({ ...state.settings, charBg: next });
      await applySettingLocally({ charBg: next });
      toast(next ? '角色背景水印已开启' : '角色背景水印已关闭', next ? 'success' : 'info');
      break;
    }
    case 'toggle-sidebar-char': {
      const next = !(state.settings.sidebarChar !== false);
      paintSwitch(element, next);
      expectSettingsEcho({ ...state.settings, sidebarChar: next });
      await applySettingLocally({ sidebarChar: next });
      toast(next ? '侧栏立绘已开启' : '侧栏立绘已关闭', next ? 'success' : 'info');
      break;
    }
    case 'news-tab': {
      const next = element.dataset.value || 'all';
      if (next !== state.newsFilter) {
        state.newsFilter = next;
        render({ preserveScroll: false });
      }
      break;
    }
    case 'news-feature-prev':
    case 'news-feature-next': {
      // 循环翻页：到尾再点回到第一条，按钮永远有响应
      const total = noticeFeaturePool(noticeEntries()).length;
      if (total < 2) break;
      const cur = Math.min(Math.max(state.newsFeatureIndex || 0, 0), total - 1);
      const delta = element.dataset.action === 'news-feature-next' ? 1 : -1;
      state.newsFeatureIndex = (cur + delta + total) % total;
      render({ preserveScroll: true });
      break;
    }
    case 'news-toggle-releases': {
      state.newsReleasesExpanded = !state.newsReleasesExpanded;
      render({ preserveScroll: true });
      break;
    }
    case 'open-news':
      openNewsModal(id);
      break;
    case 'open-external':
      if (element.dataset.url) await api.openExternal(element.dataset.url);
      break;
    case 'refresh-notices':
      await loadNoticeBoard(true);
      break;
    case 'record-refresh':
      await reloadRecord();
      break;
    case 'record-game': {
      const next = element.dataset.value || '';
      if (!next || next === state.record.game) break;
      state.record.game = next;
      // 换游戏时回本期：上期切换只对深渊类功能有意义，换了游戏容易迷路
      state.record.schedule = 1;
      /*
       * 换到的游戏不一定有当前这个功能（星铁没有深境螺旋、崩3没有忘却之庭），
       * 停在一个不存在的组合上只会看到空页，落到它自己的第一个战绩功能。
       */
      const supported = recordFeaturesOf(next);
      if (supported.length && !supported.includes(state.record.feature)) {
        state.record.feature = supported[0];
      }
      await reloadRecord();
      break;
    }
    case 'record-feature': {
      const next = element.dataset.value || '';
      // 只有 13 个战绩功能能进这里；别的键一律忽略
      if (!next || next === state.record.feature || !RECORD_FEATURE_SET.has(next)) break;
      state.record.feature = next;
      state.record.schedule = 1;
      await reloadRecord();
      break;
    }
    case 'record-schedule': {
      const next = Number(element.dataset.value) === 2 ? 2 : 1;
      if (next === state.record.schedule) break;
      state.record.schedule = next;
      await reloadRecord();
      break;
    }
    /*
     * 同一款游戏里换角色（uid）。
     * 崩3 一个账号经常挂着三台服务器，原神也有人一个通行证两个号 ——
     * 换 uid 等于换一整套数据，缓存必须一起作废。
     */
    case 'record-role': {
      const uid = element.dataset.value || '';
      if (!uid) break;
      const game = state.record.game;
      const role = recordRolesOf(game).find((item) => String(item.uid) === String(uid));
      if (!role) break;
      state.record.role[game] = {
        game,
        uid: role.uid,
        region: role.region,
        nickname: role.nickname,
        level: role.level,
        regionName: role.regionName,
      };
      state.record.cache = {};
      await reloadRecord();
      break;
    }
    /* 换通行证账号：交给 doHoyolabSwitch，它会同时刷新登录态和战绩。 */
    case 'record-account':
      await doHoyolabSwitch('miyoushe', element.dataset.value || '');
      break;
    /*
     * 接口一直报 1034/5003 时，官方网页往往还能打开 —— 让用户在网页里
     * 完成一次人机验证（米游社的风控是跟着账号走的），回来刷新就通了。
     */
    case 'record-open-web':
      if (!window.launcher?.openExternal) {
        toast('当前版本不能打开外部链接', 'error');
        break;
      }
      await window.launcher.openExternal(RECORD_WEB_URL);
      break;
    case 'tools-refresh':
      await loadFeatures(true);
      if (!state.features?.error) toast('功能列表已刷新');
      break;
    /* 2.4.0 合并自对方分支：游戏 Wiki 卡片点击，https 校验后走外部浏览器 */
    case 'tools-wiki': {
      const url = String(element.dataset.url || '');
      if (!/^https:\/\//i.test(url)) {
        toast('这个 Wiki 地址不可用', 'error');
        break;
      }
      if (!window.launcher?.openExternal) {
        toast('当前环境打不开外部浏览器', 'error');
        break;
      }
      await window.launcher.openExternal(url);
      break;
    }
    case 'tools-open': {
      const key = element.dataset.feature || '';
      /*
       * 功能 → 现有页面的映射统一放在 TOOLS_NAV_TARGET（侧栏也用同一张表），
       * 避免出现「侧栏能跳、工具页点不动」这种两处不一致。
       */
      const target = TOOLS_NAV_TARGET[key];
      if (!target) {
        toast('这个能力需要在游戏里或官方平台查看', 'info');
        break;
      }
      /*
       * 所有跳转都带上 fromTools：目标二级页的 page-head 之前会渲染
       * 「返回工具页」条，用户不用再回侧栏找「工具」。
       */
      if (target === 'record') {
        /*
         * 战绩页要知道具体看哪个功能；看哪款游戏由 navigate 里按登录态自动挑。
         * 工具页「按游戏查看」点进来时带了 data-game，就按那个游戏开，
         * 否则按游戏分别收起的分组点了也没用，还是会跳回上次的游戏。
         */
        const picked = element?.dataset?.game || '';
        navigate('record', picked ? { feature: key, game: picked, fromTools: true } : { feature: key, fromTools: true });
        break;
      }
      navigate(target, { fromTools: true });
      if (target === 'screenshots') loadScreenshots(false);
      if (target === 'graphics') loadGraphics(state.graphicsGame);
      break;
    }
    /* 二级页顶部「返回工具页」条的入口 */
    case 'nav-tools':
      navigate('tools');
      break;
    case 'install-open-miyoushe': {
      const result = await window.launcher.install.open({ what: 'miyoushe' });
      if (!result?.ok) toast(result?.reason || '打开失败');
      break;
    }
    case 'shots-refresh':
      await loadScreenshots(true);
      break;
    case 'hoyolab-login':
      await doHoyolabLogin(
        element.dataset.value || 'miyoushe',
        'genshin',
        element.dataset.mode === 'add'
      );
      break;
    case 'hoyolab-switch':
      await doHoyolabSwitch('miyoushe', element.dataset.value || '');
      break;
    case 'hoyolab-remove':
      await doHoyolabLogout('miyoushe', element.dataset.value || '');
      break;
    case 'hoyolab-logout':
      await doHoyolabLogout(element.dataset.value || 'miyoushe');
      break;
    case 'passport-login':
      await doPassportLogin(element.dataset.value || '');
      break;
    case 'passport-logout':
      await doPassportLogout(element.dataset.value || '');
      break;
    case 'shots-game':
      state.shotsGame = element.dataset.value || '';
      render({ preserveScroll: true });
      break;
    case 'shots-open': {
      const target = element.dataset.path || '';
      if (target) await api.screenshots.open(target);
      break;
    }
    case 'shots-reveal': {
      // 缩略图本身也带 data-action，点「显示在文件夹」时不要连带打开图片
      if (event) event.stopPropagation();
      const target = element.dataset.path || '';
      if (target) await api.screenshots.reveal(target);
      break;
    }
    /*
     * 画质页改一项设置。
     *
     * 数据全在 data-* 里：data-entry 是注册表值名，data-field 是 JSON 里的字段名
     * （单值项时两者相同），data-value 是要写入的新值。
     * 布尔项是按钮（data-value="true"），下拉在 change 时触发，
     * 数字输入框先在本地记下（data-manual），按回车或离开输入框才写。
     */
    case 'graphics-set': {
      const game = element.dataset.game || state.graphicsGame;
      const entry = element.dataset.entry || '';
      const field = element.dataset.field || '';
      // 下拉框选完新值后，DOM 上的 value 变了但 data-value 还是渲染时的旧值，
      // 所以 SELECT 必须读 element.value，其余控件才读 data-value。
      const raw = element.tagName === 'SELECT' ? element.value : element.dataset.value;
      if (!entry || !field) break;
      /*
       * 兜底：按钮是上一款游戏渲染出来的，而页面已经切到别的游戏了。
       * 这条路径曾经把原神的注册表项名写进终末地的注册表项里 —— 卡片还留在 DOM 上
       * （比如异步刷新回来晚了一拍），用户点下去就会跨游戏误写，必须直接拦掉。
       */
      if (element.dataset.game && element.dataset.game !== state.graphicsGame) {
        toast('页面已切换，请重新点击', 'info');
        break;
      }
      if (raw === undefined || raw === null || raw === '') {
        toast('没有读到要写入的值，请重试', 'error');
        break;
      }

      let value = raw;
      if (element.tagName === 'SELECT') {
        // 下拉的 option.value 是字符串，按字段原本的类型还原成数字 / 布尔
        value = raw;
        if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
        else if (raw === 'true') value = true;
        else if (raw === 'false') value = false;
      } else if (element.type === 'number') {
        const typed = Number(element.value);
        if (!Number.isFinite(typed)) {
          toast('这一项要填数字', 'error');
          break;
        }
        value = typed;
      } else if (raw === 'true') {
        value = true;
      } else if (raw === 'false') {
        value = false;
      }

      // 给人看的名字：单值项时 field 就是注册表值名，JSON 项要翻成中文
      const hit = (() => {
        const groups = state.graphics && Array.isArray(state.graphics.fields) ? state.graphics.fields : [];
        const group = groups.find((item) => item.name === entry);
        return (group?.fields || []).find((item) => item.key === field) || null;
      })();
      const shown = hit?.label || field;
      // 提示里说中文档位名，不说注册表原始数字（「超分方式 已设为 DLSS」而不是「已设为 3000」）
      const spoken = hit ? gfxOptionLabel(hit, value) : String(value);

      /*
       * 下拉框不能在这里立刻 render。
       *
       * change 事件是在用户点完选项、原生下拉刚要收起的瞬间触发的，
       * 此时同步 render 会把整个 DOM 换掉，下拉被销毁 → 看起来「一点开就关掉」；
       * 更糟的是写入的 await 回来后状态已被重绘覆盖。
       * 所以先把「正在写入」的标记记下来，写入与重读都完成后再统一重画一次。
       */
      state.graphicsPending = { name: field, value };
      // 只给当前这一行挂个「写入中」的样式，不重建 DOM（重建会把下拉/焦点全弄没）
      const pendingRow = element.closest('.gfx-row');
      if (pendingRow) pendingRow.classList.add('is-pending');
      try {
        // 与读取同源：把游戏对象一起传过去，主进程才知道该往哪个注册表项写
        // （trait 里没写 key 的游戏要靠 path 自动探测；探测不到主进程会拒绝写）
        const target = graphicsGameEntry(game);
        const result = await api.graphics.write({
          gameKey: target.gameKey,
          name: target.name,
          path: target.path,
          exe: target.exe,
          entry,
          field,
          value,
        });
        if (!result || result.ok === false) throw new Error(result?.reason || '写入失败');
        if (result.unchanged) {
          toast(`${shown} 已经是「${spoken}」了`, 'info');
        } else {
          toast(`${shown} 已设为 ${spoken}，启动游戏后生效`, 'success');
        }
      } catch (error) {
        toast(`写入失败：${error.message}`, 'error');
      } finally {
        state.graphicsPending = null;
        if (pendingRow) pendingRow.classList.remove('is-pending');
        /*
         * 重新读一遍注册表，界面上显示的就是游戏里真实的当前值。
         *
         * 必须 force：写入成功后缓存里的那份就是旧值，而它在 60 秒新鲜期内
         * 会被 loadGraphics 直接复用 —— 用户会看到「刚点完的开关自己弹回去了」。
         * force 路径在 loadGraphics 里走的是「保留旧画面、不置 loading、读完再按
         * 签名比对决定要不要重画」，所以这里既拿得到新值，也不会闪「正在读取注册表」。
         */
        if (state.route === 'graphics') await loadGraphics(game, { force: true });
      }
      break;
    }

    /*
     * 插件页。
     *
     * 导入是个两步流程：主进程先弹系统选择框、把文件拷进插件目录，
     * 然后这里再弹一次权限确认；用户取消的话要把刚落盘的文件删掉，
     * 不能留下一份「已安装但从没被允许运行」的孤儿文件。
     */
    case 'plugin-refresh':
      await loadPlugins(true);
      if (!state.plugins.error) toast('插件列表已刷新');
      break;
    case 'plugin-open-dir':
      // 只读一层：没有 reveal(dir) 接口，先开数据目录，插件都在它的 plugins 子目录里
      await api.openDataFolder();
      break;
    case 'plugin-doc': {
      const result = await api.plugins.openDoc();
      // 系统里没关联 .md 的打开方式时会失败，这时退回打开插件目录，别让用户卡住
      if (!result || !result.ok) {
        toast('系统没有关联 .md 文件，已帮你打开插件目录', 'info');
        await api.openDataFolder();
      }
      break;
    }
    case 'plugin-select': {
      const target = element?.dataset?.id || '';
      if (!target) break;
      state.plugins.active = target;
      delete state.plugins.errors[target];
      render({ preserveScroll: true });
      await startPlugin(pluginById(target) || { id: target, permissions: [] });
      break;
    }
    case 'plugin-reload': {
      const target = element?.dataset?.id || state.plugins.active;
      const plugin = pluginById(target);
      if (!plugin) break;
      const runtime = pluginRuntime();
      if (runtime) runtime.Host.stop(target);
      delete state.plugins.errors[target];
      delete state.plugins.views[target];
      state.plugins.running[target] = false;
      render({ preserveScroll: true });
      await startPlugin(plugin);
      break;
    }
    case 'plugin-import': {
      let result;
      try {
        result = await window.launcher.plugins.importFile();
      } catch (error) {
        toast(humanError(error) || '导入失败', 'error');
        break;
      }
      // 用户自己点了取消，不算出错，也不用提示
      if (!result || (result.ok === false && result.cancelled)) break;
      if (!result.ok) {
        toast(result.error || '导入失败', 'error');
        break;
      }
      state.plugins.pending = result.id || result.file || '';
      await loadPlugins(true);
      const imported =
        pluginById(result.id) ||
        (state.plugins.list?.plugins || []).find((plugin) => plugin.file === result.file) ||
        { id: '', file: result.file, name: result.name, permissions: [] };
      openPluginPermissionDialog(imported);
      break;
    }
    case 'plugin-confirm-install': {
      state.plugins.pending = '';
      closeModal();
      const activeNow = state.plugins.active;
      await loadPlugins(true);
      state.plugins.active = activeNow;
      const plugin = pluginById(activeNow) || pluginById(pickPluginId());
      if (plugin) {
        state.plugins.active = plugin.id;
        await startPlugin(plugin);
        toast(`「${plugin.name || plugin.id}」已启用`, 'success');
      }
      if (state.route === 'plugins') render({ preserveScroll: true });
      break;
    }
    case 'plugin-cancel-install': {
      // 取消 = 撤销这次导入：文件刚写进插件目录，还没被允许运行，删掉最干净
      const target = state.plugins.pending || '';
      state.plugins.pending = '';
      closeModal();
      if (!target) break;
      const plugin = (state.plugins.list?.plugins || []).find(
        (item) => item.id === target || item.file === target
      );
      try {
        if (plugin?.id) {
          await window.launcher.plugins.remove(plugin.id);
        } else if (plugin?.file) {
          await window.launcher.plugins.remove(plugin.file);
        }
        toast('已撤销导入');
      } catch (error) {
        toast(humanError(error) || '撤销导入失败', 'error');
      }
      await loadPlugins(true);
      break;
    }
    case 'plugin-remove': {
      const pluginId = element?.dataset?.id || '';
      const fileName = element?.dataset?.file || '';
      const target = pluginId || fileName;
      if (!target) break;
      const ok = await confirmDialog({
        title: '删除这个插件？',
        message: '插件文件会从插件目录里删掉，它保存的配置也会一起清空，这一步不能撤销。',
        confirmText: '删除',
        danger: true,
      });
      if (!ok) break;
      try {
        const result = await window.launcher.plugins.remove(target);
        if (!result || result.ok === false) throw new Error(result?.error || '删除失败');
        const runtime = pluginRuntime();
        if (runtime) runtime.Host.stop(pluginId || target);
        delete state.plugins.running[pluginId];
        delete state.plugins.views[pluginId];
        delete state.plugins.errors[pluginId];
        if (state.plugins.active === pluginId) state.plugins.active = '';
        toast('插件已删除');
      } catch (error) {
        toast(humanError(error) || '删除失败', 'error');
      }
      await loadPlugins(true);
      break;
    }

    case 'tools-tab': {
      const key = element.dataset.value || '';
      if (!key || key === state.toolsTab) break;
      state.toolsTab = key;
      render({ preserveScroll: true });
      break;
    }
    /* 工具页右上角：账号登录弹窗（米游社 + 其它发行方通行证） */
    case 'tools-accounts':
      openToolsAccountsModal();
      break;
    /* 工具页里的「自定义插件」是独立页面，直接跳过去 */
    case 'nav-plugins':
      navigate('plugins');
      break;
    /*
     * 「按游戏查看」里点游戏名：默认全部收起，点谁展开谁，再点一次收回去。
     * 不用 <details> 是因为卡片结构里还有「其它已接入」列表，收起来时要连它一起收，
     * 状态放在 state 里才能在 render 后保留。
     */
    case 'tools-game-pick':
    case 'tools-game-toggle': {
      // tools-game-toggle 是旧卡片墙的 action 名，留着兼容没重载的旧 DOM
      const key = element.dataset.value || '';
      if (!key) break;
      state.toolsGame = key;
      render({ preserveScroll: true });
      break;
    }

    case 'graphics-refresh':
      await loadGraphics(state.graphicsGame);
      break;
    case 'graphics-game':
      state.graphicsGame = element.dataset.value || 'starrail';
      await loadGraphics(state.graphicsGame);
      break;
    case 'quit-app':
      await api.quit();
      break;
    case 'close-modal':
      closeModal();
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* modals                                                              */
/* ------------------------------------------------------------------ */

function openModal(html, options = {}) {
  modalOnClose = options.onClose || null;
  dom.modalRoot.innerHTML = html;
  document.body.classList.add('modal-open');
  const backdrop = dom.modalRoot.querySelector('.modal-backdrop');
  const focusTarget =
    dom.modalRoot.querySelector('[autofocus]') ||
    dom.modalRoot.querySelector('input, textarea, button:not([data-close])');
  window.setTimeout(() => focusTarget && focusTarget.focus(), 60);
  if (backdrop) {
    backdrop.addEventListener('click', (event) => {
      if (event.target !== backdrop) return;
      if (options.onBackdrop) {
        options.onBackdrop();
        return;
      }
      closeModal();
    });
  }
}

function closeModal() {
  const callback = modalOnClose;
  modalOnClose = null;
  /*
   * 跑着的任务弹窗被关掉（Esc / ✕ / 点遮罩都走这里）时，先把它的 DOM 收进任务坞，
   * 再走正常的清空流程 —— 否则 #modal-root 一清空，任务条就再也回不到这个界面了。
   * 守卫只对「当前就在 #modal-root 里的那个任务弹窗」生效，不误伤别的弹窗。
   */
  if (taskModalGuard) {
    const guard = taskModalGuard;
    taskModalGuard = null;
    try {
      guard();
    } catch {
      /* 守卫只是尽力保住界面，失败也照常关 */
    }
  }
  dom.modalRoot.innerHTML = '';
  document.body.classList.remove('modal-open');
  if (callback) callback(false);
  if (state.app.version && state.route) {
    render({ preserveScroll: true });
  }
}

function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    openModal(
      `<div class="modal-backdrop" data-backdrop>
        <div class="modal narrow" role="alertdialog" aria-modal="true">
          <div class="modal-head">
            <div><h2>${esc(title)}</h2></div>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body"><p class="confirm-copy">${esc(message)}</p></div>
          <div class="modal-foot">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-yes">${esc(confirmText)}</button>
          </div>
        </div>
      </div>`,
      {
        onClose: () => resolve(false),
      }
    );
    const yes = document.querySelector('#confirm-yes');
    if (yes) {
      yes.addEventListener('click', () => {
        modalOnClose = null;
        dom.modalRoot.innerHTML = '';
        document.body.classList.remove('modal-open');
        resolve(true);
      });
    }
  });
}

/**
 * 卸载前让用户在「回收站」和「永久删除」之间自己选。
 *
 * 不塞进 confirmDialog：那边只有一个「确定」，而这两条路的代价完全不同 ——
 * 一条还能捞回来，一条删了就没了。放在同一个按钮里，用户会默认点下去然后后悔。
 * 返回 'trash' / 'force' / null（取消）。
 */
function uninstallDialog({ title, message, root, exists }) {
  return new Promise((resolve) => {
    if (!exists) {
      // 目录本来就不在了：没有删文件这回事，只剩清记录
      confirmDialog({
        title,
        message,
        confirmText: '清除记录',
        danger: true,
      }).then((ok) => resolve(ok ? 'force' : null));
      return;
    }
    openModal(
      `<div class="modal-backdrop" data-backdrop>
        <div class="modal narrow" role="alertdialog" aria-modal="true">
          <div class="modal-head">
            <div><h2>${esc(title)}</h2></div>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            <p class="confirm-copy">${esc(message)}</p>
            ${
              root
                ? `<p class="uninstall-path" title="${esc(root)}">${esc(root)}</p>`
                : ''
            }
            <ul class="uninstall-pick">
              <li>
                <strong>移到回收站</strong>
                <span>推荐。删错了还能从回收站拖回来。</span>
              </li>
              <li>
                <strong>永久删除</strong>
                <span>不进回收站，删完就找不回来了。回收站用不了时选这个。</span>
              </li>
            </ul>
          </div>
          <div class="modal-foot uninstall-foot">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-danger" data-uninstall-choice="force">永久删除</button>
            <button class="btn btn-primary" data-uninstall-choice="trash">移到回收站</button>
          </div>
        </div>
      </div>`,
      { onClose: () => resolve(null) }
    );
    dom.modalRoot.querySelectorAll('[data-uninstall-choice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.uninstallChoice;
        modalOnClose = null;
        dom.modalRoot.innerHTML = '';
        document.body.classList.remove('modal-open');
        resolve(value);
      });
    });
  });
}

function field(label, input, hint = '', required = false) {  return `<div class="field">
    <label>${esc(label)}${required ? '<span class="req">*</span>' : ''}</label>
    ${input}
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </div>`;
}

function openGameModal(id = null) {
  editingId = id || null;
  const game = id ? state.games.find((g) => g.id === id) : null;
  editingCover = game ? game.cover : null;
  editingCoverUrl = game ? game.coverUrl : null;
  const title = game ? '编辑游戏' : '添加游戏';
  const subtitle = game ? '修改资料不会影响游戏文件。' : '只需要一个启动程序，其他都可以以后慢慢补。';

  const cover = editingCoverUrl
    ? `<img id="cover-preview-img" src="${esc(editingCoverUrl)}" alt="封面预览" data-cover />`
    : `<div class="placeholder">${icon('image')}<span>横版封面 · 16:9</span></div>`;

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true">
        <form id="game-form" novalidate>
          <div class="modal-head">
            <div><h2>${title}</h2><p>${subtitle}</p></div>
            <button type="button" class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            ${game && game.demo ? `<div class="form-note">${icon('info')}<span>这是一个示例条目。选择启动程序并保存后，它就会变成真正的游戏。</span></div>` : ''}
            <div class="form-grid">
              <div class="cover-editor">
                <div class="cover-preview" id="cover-preview">${cover}</div>
                <div class="cover-editor-actions">
                  <button type="button" class="btn btn-ghost" id="pick-cover">${icon('image')}选择封面</button>
                  ${
                    editingCover
                      ? `<button type="button" class="btn btn-quiet" id="remove-cover" title="移除封面">${icon('trash')}</button>`
                      : ''
                  }
                </div>
                <span class="hint">图片会被复制到应用数据目录，原图移动不受影响。</span>
              </div>
              <div>
                ${field(
                  '游戏名称',
                  `<input name="name" id="game-name" maxlength="80" value="${esc(game ? game.name : '')}" placeholder="例如：Aurora Drift" autofocus />`,
                  '',
                  true
                )}
                ${field('副标题', `<input name="subtitle" maxlength="80" value="${esc(game ? game.subtitle : '')}" placeholder="一句短描述，可选" />`)}
                <div class="field-row">
                  ${field('版本', `<input name="version" maxlength="32" value="${esc(game ? game.version : '')}" placeholder="1.0.0" />`)}
                  ${field('标签', `<input name="tags" maxlength="120" value="${esc(game && game.tags ? game.tags.join(', ') : '')}" placeholder="竞速, 单人" />`)}
                </div>
                ${field(
                  '启动程序',
                  `<div class="input-group">
                    <input name="target" id="game-target" value="${esc(game ? game.target : '')}" placeholder="选择 .exe / .lnk / .url，或直接填写" spellcheck="false" />
                    <button type="button" class="btn btn-ghost" id="pick-exe">${icon('folder')}浏览</button>
                  </div>`,
                  '也可以填写 steam:// 这样的协议链接。示例条目暂时留空即可。'
                )}
                ${field('启动参数', `<input name="args" maxlength="1000" value="${esc(game ? game.args : '')}" placeholder='例如：--windowed --profile "My Profile"' spellcheck="false" />`, '带空格的参数请用英文引号包起来。')}
                ${field(
                  '工作目录',
                  `<div class="input-group">
                    <input name="workDir" id="game-workdir" value="${esc(game ? game.workDir : '')}" placeholder="默认使用启动程序所在目录" spellcheck="false" />
                    <button type="button" class="btn btn-ghost" id="pick-workdir">${icon('folder')}浏览</button>
                  </div>`,
                  '少数游戏需要从特定目录启动才能读取资源。'
                )}
                ${field('简介', `<textarea name="description" maxlength="600" placeholder="写下一点关于这个游戏的记忆或说明…">${esc(game ? game.description : '')}</textarea>`)}
                <label class="check-line">
                  <input type="checkbox" id="game-favorite" ${game && game.favorite ? 'checked' : ''} />
                  <span>加入收藏，让它在首页更靠前</span>
                </label>
                <div class="field-error" id="form-error"></div>
              </div>
            </div>
          </div>
        </form>
        <div class="modal-foot">
          ${game ? `<button type="button" class="btn btn-danger left" data-action="delete-game" data-id="${esc(game.id)}">${icon('trash')}移除</button>` : ''}
          <button type="button" class="btn btn-ghost" data-close>取消</button>
          <button type="submit" form="game-form" class="btn btn-primary" id="save-game">${game ? '保存修改' : '添加到游戏库'}</button>
        </div>
      </div>
    </div>`;
  openModal(html);

  const form = document.querySelector('#game-form');
  const error = document.querySelector('#form-error');
  const nameInput = document.querySelector('#game-name');
  const targetInput = document.querySelector('#game-target');
  const modalRemove = document.querySelector('.modal-foot [data-action="delete-game"]');
  if (modalRemove) {
    modalRemove.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleAction('delete-game', modalRemove.dataset.id, modalRemove);
      },
      true
    );
  }

  document.querySelector('#pick-cover').addEventListener('click', async () => {
    try {
      const source = await api.pick.image();
      if (!source) return;
      const imported = await api.importCover(source);
      editingCover = imported;
      editingCoverUrl = toFileUrl(imported);
      const preview = document.querySelector('#cover-preview');
      preview.innerHTML = `<img id="cover-preview-img" src="${esc(editingCoverUrl)}" alt="封面预览" data-cover />`;
      const remove = document.querySelector('#remove-cover');
      if (!remove) {
        const actions = document.querySelector('.cover-editor-actions');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-quiet';
        button.id = 'remove-cover';
        button.title = '移除封面';
        button.innerHTML = icon('trash');
        actions.appendChild(button);
        button.addEventListener('click', removeCover);
      }
    } catch (err) {
      toast(humanError(err), 'error');
    }
  });

  function removeCover() {
    editingCover = null;
    editingCoverUrl = null;
    document.querySelector('#cover-preview').innerHTML = `<div class="placeholder">${icon('image')}<span>横版封面 · 16:9</span></div>`;
    const button = document.querySelector('#remove-cover');
    if (button) button.remove();
  }

  const removeButton = document.querySelector('#remove-cover');
  if (removeButton) removeButton.addEventListener('click', removeCover);

  document.querySelector('#pick-exe').addEventListener('click', async () => {
    const target = await api.pick.executable();
    if (!target) return;
    targetInput.value = target;
    if (!nameInput.value.trim()) {
      nameInput.value = target.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    }
    const dirInput = document.querySelector('#game-workdir');
    if (dirInput && !dirInput.value.trim()) {
      dirInput.placeholder = target.replace(/[\\/][^\\/]+$/, '');
    }
  });

  document.querySelector('#pick-workdir').addEventListener('click', async () => {
    const dir = await api.pick.directory();
    if (dir) document.querySelector('#game-workdir').value = dir;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = {
      name: String(data.get('name') || '').trim(),
      subtitle: String(data.get('subtitle') || '').trim(),
      version: String(data.get('version') || '').trim(),
      tags: String(data.get('tags') || '')
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 5),
      target: String(data.get('target') || '').trim(),
      args: String(data.get('args') || '').trim(),
      workDir: String(data.get('workDir') || '').trim(),
      description: String(data.get('description') || '').trim(),
      cover: editingCover || '',
      accent: game ? game.accent : '#f08ba6',
      favorite: document.querySelector('#game-favorite').checked,
    };
    if (!payload.name) {
      error.textContent = '请先给它起一个名字。';
      nameInput.focus();
      return;
    }
    error.textContent = '';
    const save = document.querySelector('#save-game');
    save.disabled = true;
    save.textContent = '保存中…';
    try {
      if (editingId) {
        await api.games.update(editingId, payload);
        toast('游戏资料已更新', 'success');
      } else {
        await api.games.add(payload);
        toast('已添加到游戏库', 'success');
      }
      closeModal();
    } catch (err) {
      error.textContent = humanError(err);
      save.disabled = false;
      save.textContent = game ? '保存修改' : '添加到游戏库';
    }
  });
}

function openDownloadModal() {
  const dir = state.settings.downloadDir || '';
  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" role="dialog" aria-modal="true">
        <form id="download-form" novalidate>
          <div class="modal-head">
            <div><h2>新建下载</h2><p>支持 http / https 直链，暂停后可断点续传。</p></div>
            <button type="button" class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            ${field('下载链接', `<input name="url" id="download-url" placeholder="https://example.com/file.zip" spellcheck="false" autofocus />`, '', true)}
            ${field('保存为', `<input name="fileName" placeholder="留空则使用链接中的文件名" />`, '文件名中的非法字符会被自动替换。')}
            <div class="form-note">${icon('folder')}<span>保存到：${esc(dir)}<br />可以在设置里更改下载文件夹。</span></div>
            <div class="field-error" id="download-error"></div>
          </div>
          <div class="modal-foot">
            <button type="button" class="btn btn-ghost" data-close>取消</button>
            <button type="submit" class="btn btn-primary" id="start-download">${icon('download')}开始下载</button>
          </div>
        </form>
      </div>
    </div>`;
  openModal(html);

  const form = document.querySelector('#download-form');
  const error = document.querySelector('#download-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const url = String(data.get('url') || '').trim();
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http 或 https 链接');
    } catch {
      error.textContent = '请输入有效的 http 或 https 下载链接。';
      return;
    }
    error.textContent = '';
    const button = document.querySelector('#start-download');
    button.disabled = true;
    button.textContent = '正在创建…';
    try {
      await api.downloads.add({
        url,
        fileName: String(data.get('fileName') || '').trim(),
      });
      closeModal();
      if (state.route !== 'downloads') navigate('downloads');
      toast('下载任务已创建', 'success');
    } catch (err) {
      error.textContent = humanError(err);
      button.disabled = false;
      button.innerHTML = `${icon('download')}开始下载`;
    }
  });
}

function openServerModal(gameId, serverId = null) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;
  const server = serverId ? (game.servers || []).find((item) => item.id === serverId) : null;
  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" role="dialog" aria-modal="true">
        <form id="server-form" novalidate>
          <div class="modal-head">
            <div>
              <h2>${server ? '编辑服务器' : '添加服务器'}</h2>
              <p>${esc(game.name)} · 为这个服务器的客户端指定启动程序。</p>
            </div>
            <button type="button" class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            <div class="form-note">${icon('info')}<span>启动器会用启动程序所在的文件夹作为这个服务器的根目录，硬链接只会在两个服务器的根目录之间比较文件。</span></div>
            ${field(
              '服务器名称',
              `<input name="name" maxlength="40" value="${esc(server ? server.name : '')}" placeholder="例如：B服、国际服" autofocus />`,
              '',
              true
            )}
            ${field(
              '启动程序',
              `<div class="input-group">
                <input name="path" id="server-path" value="${esc(server ? server.path : '')}" placeholder="选择这个服务器的 .exe" spellcheck="false" />
                <button type="button" class="btn btn-ghost" id="pick-server-exe">${icon('folder')}浏览</button>
              </div>`,
              '不同服务器的客户端通常安装在不同目录，请选择对应客户端的启动程序。'
            )}
            <div class="field">
              <label>根目录（安装目录）</label>
              <div class="path-box">
                <input id="server-root" value="${esc(server && server.root ? server.root : '')}" placeholder="留空时自动使用启动程序所在文件夹" spellcheck="false" style="flex:1;min-width:0" />
                <button type="button" class="btn btn-ghost" id="pick-server-root">${icon('folder')}浏览</button>
              </div>
              <span class="hint">硬链接会在两个服务器的根目录之间比较文件。有些客户端把游戏文件放在启动程序的上一级目录，可以在这里手动指定。</span>
            </div>
            <div class="field-error" id="server-error"></div>
          </div>
          <div class="modal-foot">
            <button type="button" class="btn btn-ghost" data-close>取消</button>
            <button type="submit" class="btn btn-primary" id="save-server">${server ? '保存修改' : '添加服务器'}</button>
          </div>
        </form>
      </div>
    </div>`;
  openModal(html);

  const form = document.querySelector('#server-form');
  const pathInput = document.querySelector('#server-path');
  const rootInput = document.querySelector('#server-root');
  const error = document.querySelector('#server-error');

  function syncRootFromPath() {
    if (rootInput.dataset.manual === '1') return;
    const value = pathInput.value.trim();
    rootInput.value = value ? value.replace(/[\\/][^\\/]+$/, '') : '';
  }
  pathInput.addEventListener('input', syncRootFromPath);
  rootInput.addEventListener('input', () => { rootInput.dataset.manual = '1'; });
  syncRootFromPath();

  document.querySelector('#pick-server-exe').addEventListener('click', async () => {
    const picked = await api.pick.executable();
    if (!picked) return;
    pathInput.value = picked;
    rootInput.dataset.manual = '0';
    syncRootFromPath();
    const name = form.querySelector('[name="name"]');
    if (!name.value.trim()) {
      name.value = game.builtin ? '另一个服务器' : '默认';
      name.select();
    }
  });

  document.querySelector('#pick-server-root').addEventListener('click', async () => {
    const picked = await api.pick.directory();
    if (!picked) return;
    rootInput.value = picked;
    rootInput.dataset.manual = '1';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const serverPath = String(data.get('path') || '').trim();
    const serverRoot = String(data.get('root') || '').trim();
    const name = String(data.get('name') || '').trim();
    if (!name) {
      error.textContent = '先给这个服务器起一个名字。';
      return;
    }
    if (!serverPath) {
      error.textContent = '请选择这个服务器的启动程序。';
      return;
    }
    const button = document.querySelector('#save-server');
    button.disabled = true;
    try {
      if (server) {
        await api.servers.update({ gameId, serverId: server.id, name, path: serverPath, root: serverRoot });
        toast('服务器配置已更新', 'success');
      } else {
        await api.servers.add({ gameId, name, path: serverPath, root: serverRoot });
        toast('服务器已添加', 'success');
      }
      closeModal();
    } catch (err) {
      error.textContent = humanError(err);
      button.disabled = false;
    }
  });
}

/*
 * ── 一键下载弹窗（未安装游戏） ─────────────────────────────────────────
 * 启动页「下载游戏」按钮走这里：选渠道 → 选目录 → 空间预估 → 开始下载。
 * 进度复用 sophon:progress 通道，任务面板 / 暂停 / 停止 / 最小化都和硬链接任务同一套。
 */
/** 支持一键下载的内置游戏 → 下载引擎（与主进程 DOWNLOADABLE_KEYS 保持一致）。 */
const DOWNLOAD_GAME_ENGINES = {
  genshin: 'sophon',
  starrail: 'sophon',
  zzz: 'sophon',
  bh3: 'sophon',
  endfield: 'endfield',
  arknights: 'endfield',
};

/** 暂不支持自动下载的游戏 → 官网入口（弹窗里如实说明后跳转）。 */
const DOWNLOAD_UNSUPPORTED_SITES = {
  neverness: 'https://yh.wanmei.com/',
};

/*
 * 接入了一键下载、但只实测过部分渠道的游戏 → 允许下载的渠道白名单。
 * 崩坏3 只有官服在 HoYoPlay 分发体系里（B服走 B 站自有启动器、国际服 game_id
 * 无法唯一定位）；明日方舟只实测了官服分发接口。渠道行本身还在，只是下载弹窗
 * 里不列出，避免用户选了才在 estimate 阶段报错。
 */
const DOWNLOAD_CHANNELS_OK = {
  bh3: ['official'],
  arknights: ['official'],
};

/**
 * 未安装游戏的默认安装目录：跟随现有游戏安装盘。
 * 哪个内置游戏已经装好了，就把它的安装盘借过来（比如原神装在 D 盘，新游戏默认
 * D:\HuaXiaoLingGames\<builtinKey>）；一个都没装时退回 C 盘。
 * 目录名用 builtinKey 而不是中文名，避免个别老游戏对中文路径的兼容问题。
 */
function defaultDownloadDir(game) {
  const installedRoot = ((state.games || []).map((item) =>
    (item.servers || []).find((server) => server.exists && server.root)
  ).find(Boolean) || {}).root || '';
  // 盘符必须用正则整体取出（含冒号），再一次性拼接。
  // 之前 slice(0,2)+' 截取后重新拼 ':' 的写法会拼出 "G:\:\..." 这种坏路径，
  // 直接导致 mkdir ENOENT、空间预估失败。
  const m = /^([a-zA-Z]:)[\\/]/.exec(installedRoot);
  const drive = m ? m[1] : 'C:';
  return `${drive}\\HuaXiaoLingGames\\${game.builtinKey || 'game'}`;
}

function openGameDownloadModal(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;

  // 没接入下载管线的游戏（异环）：如实说明 + 官网入口，不假装能下
  if (!DOWNLOAD_GAME_ENGINES[game.builtinKey]) {
    const site = DOWNLOAD_UNSUPPORTED_SITES[game.builtinKey] || '';
    openModal(`
      <div class="modal-backdrop" data-backdrop>
        <div class="modal narrow" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h2>暂不支持自动下载</h2>
              <p>${esc(game.name)} 还没有接入一键下载。</p>
            </div>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            <p class="sw-note">${icon('info', 'xs')}<span>这款游戏暂时不能在启动器里直接下载安装：官方没有开放的版本清单接口。请先前往官网下载安装，装好后再用启动页的「自动检测」或「路径选择」把客户端指进来。</span></p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" data-close>关闭</button>
            ${site ? `<button class="btn btn-primary" data-action="open-external" data-url="${esc(site)}">${icon('external')}打开官网</button>` : ''}
          </div>
        </div>
      </div>`);
    return;
  }

  // 已有硬链接 / 更新 / 下载任务在跑时不再叠加：下载队列和硬链接队列共用一套任务面板，
  // 这里不排队，避免排到的下载任务被 openSophonModal 顶成硬链接弹窗。
  if (activeSophonJob || sophonJobs.some((job) => ['starting', 'running', 'queued'].includes(job.status))) {
    toast('已有下载 / 硬链接任务在进行，请先等它完成再下载新游戏', 'info');
    return;
  }

  const servers = (game.servers || []).filter((server) => !server.exists || server.incomplete);
  const allChoices = servers.length ? servers : game.servers || [];
  // 只实测过的渠道才列进下载弹窗（崩坏3 / 明日方舟只有官服），其余渠道不出现
  const allowedChannels = DOWNLOAD_CHANNELS_OK[game.builtinKey];
  const choices = allowedChannels ? allChoices.filter((server) => allowedChannels.includes(server.channel)) : allChoices;
  if (!choices.length) {
    toast('这个游戏还没有可用的服务器渠道', 'error');
    return;
  }
  // 新任务开始：把上一次收在坞里的旧弹窗丢掉，免得点任务条时挂回来的是上一单的界面
  dropStashedTaskModal();
  const jobId = `dl-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const channelOptions = choices
    .map(
      (server, index) => `
      <label class="dl-channel${index === 0 ? ' is-active' : ''}">
        <input type="radio" name="dl-channel" value="${esc(server.channel)}" ${index === 0 ? 'checked' : ''} />
        <span class="dl-channel-dot"></span>
        <span class="dl-channel-copy">
          <strong>${esc(server.name)}</strong>
          <small>${esc(serverChannelTag(game, server) || server.channel)}</small>
        </span>
      </label>`
    )
    .join('');

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>下载游戏 · ${esc(game.name)}</h2>
            <p>从官方清单完整下载安装，装完自动填好服务器路径。</p>
          </div>
          <div class="modal-head-actions">
            <button class="modal-close" id="dl-minimize" style="display:none" title="最小化到任务面板">−</button>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
        </div>
        <div class="modal-body">
          <p class="sw-note">${icon('info', 'xs')}<span>下载使用官方渠道的版本清单与分块，逐文件校验后落盘；整个过程保持游戏关闭。</span></p>
          <div class="field">
            <label>下载渠道</label>
            <div class="dl-channels">${channelOptions}</div>
          </div>
          <div class="field">
            <label>安装目录</label>
            <div class="input-group">
              <input id="dl-dir" value="${esc(defaultDownloadDir(game))}" spellcheck="false" />
              <button type="button" class="btn btn-ghost" id="dl-detect" title="扫描注册表和常见目录，找已经装好的客户端">${icon('refresh')}自动检测</button>
              <button type="button" class="btn btn-ghost" id="dl-browse" title="选择安装目录">${icon('folder')}浏览</button>
            </div>
            <span class="hint">默认跟随现有游戏的安装盘；也可以直接输入一个不存在的目录，下载时会自动创建。</span>
          </div>
          <div class="sw-sum">
            <div class="sw-sum-row">
              <span class="sw-sum-k">目标版本</span>
              <span class="sw-sum-v" id="dl-sum-tag">统计中…</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">需要下载</span>
              <span class="sw-sum-v" id="dl-sum-size">统计中…</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">目标盘剩余</span>
              <span class="sw-sum-v" id="dl-sum-free">统计中…</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">空间判断</span>
              <span class="sw-sum-v" id="dl-sum-space">统计中…</span>
            </div>
            <p class="sw-sum-hint" id="dl-sum-hint">体积来自官方清单，语音包按设置里勾选的语言计算。</p>
          </div>
          <ol class="sw-stages" id="dl-stages">
            ${SOPHON_STAGES.map(
              (stage, index) => `
              <li class="sw-stage" data-index="${index}">
                <span class="sw-stage-dot">${index + 1}</span>
                <span class="sw-stage-label">${esc(stage.label)}</span>
              </li>`
            ).join('')}
          </ol>
          <div class="link-progress" id="dl-progress" style="display:none">
            <div class="link-progress-head">
              <strong id="dl-phase">准备中…</strong>
              <span id="dl-count"></span>
            </div>
            <div class="progress-bar"><span id="dl-bar" style="width:0%"></span></div>
            <div class="link-progress-meta">
              <span id="dl-stats"></span>
              <span id="dl-current"></span>
            </div>
          </div>
          <div class="sw-result" id="dl-result" hidden>
            <strong class="sw-result-title">下载完成</strong>
            <div class="sw-result-grid" id="dl-result-grid"></div>
            <p class="sw-result-note" id="dl-result-note"></p>
          </div>
          <div class="field-error" id="dl-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
          <button class="btn btn-ghost" id="dl-pause" style="display:none">暂停</button>
          <button class="btn btn-ghost" id="dl-cancel" style="display:none">停止</button>
          <button class="btn btn-primary" id="dl-start">${icon('download')}开始下载</button>
        </div>
      </div>
    </div>`;

  /* 关窗回调单独拿个名字：任务收进任务坞再从任务条挂回来时，要把它一起装回去 */
  const taskOnClose = () => {
    if (running) {
      // 窗口在跑任务时被关掉：不取消下载，缩进任务面板继续跑
      minimized();
    } else {
      // 完成 / 失败的那一条留在坞里，用户回头看还能点回来
      pruneSophonHistory();
      renderTaskDock();
    }
    if (finishedOk) {
      // 关窗后按最新状态重绘启动页：已装好的游戏这里会变回「开始游戏」
      render({ preserveScroll: true });
    }
  };
  openModal(html, {
    onClose: taskOnClose,
    onBackdrop: () => {
      if (running) minimized();
      else closeModal();
    },
  });

  const start = document.querySelector('#dl-start');
  const cancel = document.querySelector('#dl-cancel');
  const pause = document.querySelector('#dl-pause');
  const minimizeBtn = document.querySelector('#dl-minimize');
  const progress = document.querySelector('#dl-progress');
  const errorBox = document.querySelector('#dl-error');
  const dirInput = document.querySelector('#dl-dir');
  const backdrop = document.querySelector('.modal-backdrop');

  const job = {
    id: jobId,
    gameId,
    serverId: choices[0].id,
    gameName: game.name,
    serverName: choices[0].name,
    mode: 'download',
    status: 'starting',
    percent: 0,
    phase: '准备中…',
    stats: '',
  };
  // 任务面板立刻可见：打开弹窗就算挂上任务，最小化后左下角能看到它
  sophonJobs.push(job);
  renderTaskDock();

  let running = false;
  let paused = false;
  let cancelled = false;
  let finishedOk = false;
  let unsubscribe = null;

  const hideDock = () => {
    if (activeSophonJob === job) activeSophonJob = null;
    sophonUi = null;
    taskModalGuard = null;
    document.body.classList.remove('sophon-minimized');
    renderTaskDock();
  };

  // 跑着的时候被关窗（✕ / Esc / 点遮罩）→ 收进任务坞，而不是把界面销毁
  taskModalGuard = () => {
    if (!running || !backdrop || !dom.modalRoot.contains(backdrop)) return false;
    hiddenTaskModalClose = taskOnClose;
    stashTaskModal(backdrop);
    return true;
  };

  // 最小化：弹窗藏起来，任务留在左下角任务面板里继续跑
  const minimized = () => {
    if (!running) return;
    // 整块 DOM 拔下来存着：中途开别的弹窗也不会把它冲掉，点任务条能原样挂回去
    hiddenTaskModalClose = taskOnClose;
    stashTaskModal(backdrop);
    document.body.classList.add('sophon-minimized');
    job.status = 'running';
    activeSophonJob = job;
    renderTaskDock();
    sophonUi = {
      restore: () => {
        restoreTaskModal();
      },
      cancel: () => {
        cancelled = true;
        running = false;
        job.status = 'cancelled';
        api.servers.cancelSophon(jobId).catch(() => {});
        dropStashedTaskModal();
        closeModal();
        hideDock();
        pruneSophonHistory();
      },
    };
  };

  minimizeBtn.addEventListener('click', minimized);

  // 右上角 ✕ 在跑任务时改成最小化，别让人误触把窗口关了以为任务没了
  const closeX = document.querySelector('.modal-head [data-close]');
  if (closeX) {
    closeX.addEventListener(
      'click',
      (event) => {
        if (running) {
          event.preventDefault();
          event.stopPropagation();
          minimized();
        }
      },
      true
    );
  }

  const updateDock = (phaseLabel, percent, stats, current, stage) => {
    job.phase = phaseLabel;
    job.percent = Math.max(0, Math.min(100, percent));
    job.stats = stats;
    job.current = current || '';
    if (stage !== undefined) job.stage = stage;
    if (activeSophonJob === job) renderTaskDock();
  };

  /* 阶段条只往前走：复用硬链接弹窗那套 SOPHON_STAGES，两处说法保持一致 */
  const stageBox = document.querySelector('#dl-stages');
  let stageIndex = -1;
  const paintStages = (index) => {
    if (!stageBox) return;
    if (index >= 0) stageIndex = Math.max(stageIndex, index);
    const finishedAll = stageIndex >= SOPHON_STAGES.length - 1;
    [...stageBox.querySelectorAll('.sw-stage')].forEach((node, i) => {
      const isDone = finishedAll || i < stageIndex;
      node.classList.toggle('is-done', isDone);
      node.classList.toggle('is-active', !finishedAll && i === stageIndex);
      node.querySelector('.sw-stage-dot').textContent = isDone ? '✓' : String(i + 1);
    });
  };

  const sumTag = document.querySelector('#dl-sum-tag');
  const sumSize = document.querySelector('#dl-sum-size');
  const sumFree = document.querySelector('#dl-sum-free');
  const sumSpace = document.querySelector('#dl-sum-space');
  const resultBox = document.querySelector('#dl-result');

  const selectedChannel = () => {
    const checked = document.querySelector('input[name="dl-channel"]:checked');
    return checked ? checked.value : choices[0].channel;
  };

  const restoreStart = () => {
    if (running || finishedOk) return;
    start.disabled = false;
    start.innerHTML = `${icon('download')}开始下载`;
  };

  /*
   * 空间预估：读官方清单拿全量体积，和目标盘剩余空间对比。
   * 换渠道或换目录都要重算 —— 渠道清单可能不同，目录换盘后剩余空间也变了。
   */
  const refreshEstimate = async () => {
    sumTag.textContent = '统计中…';
    sumSize.textContent = '统计中…';
    sumFree.textContent = '统计中…';
    sumSpace.textContent = '统计中…';
    sumSpace.classList.remove('is-warn', 'is-ok');
    errorBox.textContent = '';
    try {
      const result = await api.servers.downloadEstimate({
        gameId,
        channel: selectedChannel(),
        installDir: dirInput.value.trim(),
      });
      sumTag.textContent = result.version || '未知';
      sumSize.textContent = Number(result.totalBytes)
        ? `约 ${formatSize(result.totalBytes)}${result.storyResources?.count ? `（含可选剧情资源 ${formatSize(result.storyResources.bytes)}）` : ''}`
        : '未知';
      const free = Number(result.freeBytes) || 0;
      const need = Number(result.totalBytes) || 0;
      sumFree.textContent = free ? `${formatSize(free)}` : '读不到磁盘信息';
      if (!free || !need) {
        sumSpace.textContent = '判断不了，先按默认目录继续也可以';
      } else if (need > free) {
        sumSpace.textContent = '不够：请换个安装目录或先清理空间';
        sumSpace.classList.add('is-warn');
      } else {
        sumSpace.textContent = '够用';
        sumSpace.classList.add('is-ok');
      }
      restoreStart();
    } catch (error) {
      sumTag.textContent = '未知';
      sumSize.textContent = '未知';
      sumFree.textContent = '未知';
      sumSpace.textContent = humanError(error);
      sumSpace.classList.add('is-warn');
      errorBox.textContent = humanError(error);
      if (!running && !finishedOk) {
        start.disabled = true;
        start.textContent = '先按提示处理再开始';
      }
    }
  };

  document.querySelectorAll('input[name="dl-channel"]').forEach((input) => {
    input.addEventListener('change', () => {
      document.querySelectorAll('.dl-channel').forEach((node) => node.classList.remove('is-active'));
      input.closest('.dl-channel')?.classList.add('is-active');
      // 换渠道后 job 面板显示的名字也跟着换
      const server = choices.find((item) => item.channel === input.value);
      if (server) {
        job.serverId = server.id;
        job.serverName = server.name;
      }
      refreshEstimate();
    });
  });

  // 打开弹窗先算一遍：默认目录 + 第一个未安装渠道
  refreshEstimate();

  document.querySelector('#dl-browse').addEventListener('click', async () => {
    if (running) return;
    const dir = await api.pick.directory();
    if (!dir) return;
    dirInput.value = dir;
    refreshEstimate();
  });

  document.querySelector('#dl-detect').addEventListener('click', async () => {
    if (running) return;
    const result = await api.games.detect(gameId);
    if (result.ok) {
      toast('已找到已安装的客户端，路径已填进对应服务器', 'success');
      // 主进程已把路径写回服务器并回推状态；这里同步一份，关窗后启动页直接可开始
      await api.getState().then(onState).catch(() => {});
      closeModal();
      // 弹窗开着时 onState 不重绘，检测成功后手动刷一次启动页（变回「开始游戏」）
      render({ preserveScroll: true });
    } else {
      toast(result.error || '没有自动检测到，可以手动选目录后点「开始下载」', 'info');
    }
  });

  pause.addEventListener('click', async () => {
    paused = !paused;
    await api.servers.pauseSophon({ jobId, paused }).catch(() => {});
    pause.textContent = paused ? '继续' : '暂停';
    const phase = document.querySelector('#dl-phase');
    if (phase) phase.textContent = paused ? '已暂停（点继续恢复）' : '恢复中…';
    if (paused) updateDock('已暂停', job.percent, '点任务条恢复窗口');
  });

  const finishClose = () => {
    // onClose（openModal 的回调）里已经负责关窗后重绘，这里只关窗
    closeModal();
  };

  start.addEventListener('click', async () => {
    // 跑完之后这个按钮就是「完成」：关窗并重绘启动页
    if (finishedOk) {
      finishClose();
      return;
    }
    const channel = selectedChannel();
    const installDir = dirInput.value.trim();
    if (!installDir) {
      errorBox.textContent = '请先填写或选择安装目录。';
      return;
    }
    running = true;
    cancelled = false;
    job.status = 'running';
    activeSophonJob = job;
    sophonUi = {
      restore: () => {
        if (backdrop) backdrop.style.display = '';
        document.body.classList.add('modal-open');
        document.body.classList.remove('sophon-minimized');
        renderTaskDock();
      },
      cancel: () => {
        cancelled = true;
        running = false;
        job.status = 'cancelled';
        api.servers.cancelSophon(jobId).catch(() => {});
        closeModal();
        hideDock();
      },
    };
    renderTaskDock();
    start.disabled = true;
    start.textContent = '正在下载…';
    cancel.style.display = '';
    minimizeBtn.style.display = '';
    pause.style.display = '';
    progress.style.display = 'block';
    errorBox.textContent = '';
    paintStages(0);
    unsubscribe = api.onSophonProgress((event) => {
      if (event.jobId !== jobId) return;
      const total = Number(event.total) || 0;
      const processed = Number(event.processed) || 0;
      const percent = total ? Math.min(100, (processed / total) * 100) : 0;
      const stage = SOPHON_PHASE_STAGE[event.phase] ?? 2;
      const phases = {
        start: '读取官方清单',
        version: `目标版本 ${event.tag || ''}`,
        manifest: '读取清单与分块索引',
        install: '写入文件',
        download: '下载分块',
        done: '完成',
      };
      if (event.tag && sumTag) sumTag.textContent = event.tag;
      paintStages(percent >= 100 && stage === 2 ? 3 : stage);
      document.querySelector('#dl-phase').textContent = phases[event.phase] || '处理中…';
      document.querySelector('#dl-count').textContent = total ? `${processed} / ${total}` : '';
      document.querySelector('#dl-bar').style.width = `${event.phase === 'done' ? 100 : percent}%`;
      const stats = sophonProgressStats(event);
      document.querySelector('#dl-stats').textContent = stats;
      document.querySelector('#dl-current').textContent = event.current || '';
      updateDock(
        phases[event.phase] || '处理中…',
        event.phase === 'done' ? 100 : percent,
        sophonProgressStats(event, true),
        event.current || '',
        stage
      );
    });

    try {
      const result = await api.servers.downloadGame({ gameId, channel, installDir, jobId });
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (result.cancelled || cancelled) {
        job.status = 'cancelled';
        pruneSophonHistory();
        toast('下载已取消', 'info');
        closeModal();
        hideDock();
        return;
      }
      if (!result.ok) throw new Error(result.error || '下载失败');
      finishedOk = true;
      running = false;
      job.status = 'done';
      job.percent = 100;
      pruneSophonHistory();
      // 最小化到任务面板时完成的：先把窗口恢复出来给用户看结果
      if (document.body.classList.contains('sophon-minimized') && sophonUi) sophonUi.restore();
      hideDock();
      if (cancel) cancel.style.display = 'none';
      if (pause) pause.style.display = 'none';
      if (minimizeBtn) minimizeBtn.style.display = 'none';
      start.disabled = false;
      start.textContent = '完成';
      paintStages(SOPHON_STAGES.length - 1);
      if (resultBox) {
        resultBox.hidden = false;
        resultBox.querySelector('#dl-result-grid').innerHTML = [
          { k: '目标版本', v: result.version || '—' },
          { k: '安装目录', v: result.targetRoot || installDir },
          { k: '启动程序', v: result.path || '—' },
        ]
          .map(
            (item) =>
              `<div class="sw-result-item"><span>${esc(item.k)}</span><strong>${esc(item.v)}</strong></div>`
          )
          .join('');
        resultBox.querySelector('#dl-result-note').textContent = '服务器路径已写好，回到启动页就能直接开始游戏。';
      }
      toast(`${game.name} 下载完成`, 'success');
      // 主进程在完成时已 pushState；弹窗开着时 onState 不重绘，这里主动同步一份最新状态
      await api.getState().then(onState).catch(() => {});
    } catch (error) {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      running = false;
      job.status = cancelled ? 'cancelled' : 'error';
      pruneSophonHistory();
      // 最小化状态下出错的：先恢复窗口，错误信息才看得见
      if (document.body.classList.contains('sophon-minimized') && sophonUi) sophonUi.restore();
      hideDock();
      if (cancelled) {
        toast('下载已取消', 'info');
        closeModal();
        return;
      }
      errorBox.textContent = humanError(error);
      start.disabled = false;
      start.innerHTML = `${icon('download')}重新开始`;
      cancel.style.display = 'none';
      pause.style.display = 'none';
      minimizeBtn.style.display = 'none';
    }
  });
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(value / 1024))} KB`;
}

/*
 * 硬链接安装 / 更新的阶段表。
 *
 * 任务坞和弹窗共用这一份：以前两处各写一套文案（「写入文件」对「处理中…」），
 * 用户在弹窗里看到的和缩到角落时看到的不是同一句话，会以为任务被换掉了。
 */
const SOPHON_STAGES = [
  { key: 'manifest', label: '读清单' },
  { key: 'ldiff', label: '补丁修补' },
  { key: 'write', label: '写入 / 下载' },
  { key: 'verify', label: '校验收尾' },
  { key: 'done', label: '完成' },
];

/** 主进程推的 phase → 阶段下标。B服 走的 'link' 也是纯硬链接复用，归到写入阶段。 */
const SOPHON_PHASE_STAGE = {
  start: 0,
  version: 0,
  manifest: 0,
  ldiff: 1,
  install: 2,
  download: 2,
  patch: 2,
  link: 2,
  done: 4,
};

/** 阶段下标 → 「第 N/5 步 · 阶段名」，弹窗与任务坞都从这里取。 */
function sophonStageText(index) {
  const clamped = Math.max(0, Math.min(SOPHON_STAGES.length - 1, Number(index) || 0));
  return `第 ${clamped + 1}/${SOPHON_STAGES.length} 步 · ${SOPHON_STAGES[clamped].label}`;
}

/**
 * 进度事件 → 一行数字。
 *
 * ldiff 阶段没有 linked / bytesDone，套统一模板会显示成「硬链接 0 · 下载 0 · 0 B」，
 * 看着像卡死；这里单独给它一句「已修补 N 个 · 省流 X」。
 */
function sophonProgressStats(event, compact = false) {
  if (!event) return '';
  if (event.phase === 'ldiff') {
    // 任务坞里前面已经有「第 2/5 步 · 补丁修补」，再带一次前缀就成了复读
    const head = compact ? '' : '本地补丁修补：';
    return `${head}已修补 ${event.applied || 0} 个 · 省流 ${formatSize(event.saveBytes || 0)}${
      event.failed ? ` · ${event.failed} 个改用下载` : ''
    }`;
  }
  if (event.phase === 'done') return '';
  return `硬链接 ${event.linked || 0} · 下载 ${event.downloaded || 0} · ${formatSize(
    event.bytesDone
  )} / ${formatSize(event.totalBytes)}`;
}

/*
 * 任务弹窗的「最小化 / 恢复」。
 *
 * 以前最小化只是把 backdrop 设成 display:none。只要中途打开任何别的弹窗
 * （openModal 会直接清空 #modal-root），任务弹窗的 DOM 就被销毁了；
 * 再点任务坞条目只会给 body 加一个 modal-open —— 界面灰着、什么也没有，
 * 于是「点任务条再也回不到硬链接界面」。
 * 现在最小化时把整块 DOM 拔出来存着，恢复时原样挂回去：
 * 进度条、阶段条、事件监听、滚动位置都还在。
 */
let hiddenTaskModal = null;
/**
 * 任务弹窗自己的 onClose。
 *
 * 恢复时要把它一起装回去：中途用户可能开过设置别的弹窗，modalOnClose 已经被
 * 那个弹窗接管了。只把 DOM 挂回来而不管它，关任务窗时会去跑别人的关闭回调。
 */
let hiddenTaskModalClose = null;

/** 把任务弹窗从 DOM 里拔下来存好（不是删掉），留着自己能原样挂回去。 */
function stashTaskModal(backdrop) {
  if (!backdrop || !backdrop.parentNode) return;
  backdrop.parentNode.removeChild(backdrop);
  hiddenTaskModal = backdrop;
  if (!dom.modalRoot.querySelector('.modal-backdrop')) {
    document.body.classList.remove('modal-open');
  }
}

/**
 * 把收起来的任务弹窗挂回前台。返回是否真的挂回去了。
 *
 * 先清空 #modal-root：这时用户可能正开着别的弹窗（设置 / 确认框），
 * 他点任务条就是要回到任务界面，旧的留在下面只会叠成两层。
 */
function restoreTaskModal() {
  const node = hiddenTaskModal;
  if (!node) return false;
  hiddenTaskModal = null;
  dom.modalRoot.innerHTML = '';
  dom.modalRoot.appendChild(node);
  modalOnClose = hiddenTaskModalClose || null;
  hiddenTaskModalClose = null;
  document.body.classList.add('modal-open');
  document.body.classList.remove('sophon-minimized');
  renderTaskDock();
  return true;
}

/**
 * 任务弹窗的关闭守卫：跑着的时候被关窗，先把 DOM 收进任务坞。
 * closeModal() 会调它，返回真表示「这次关窗已经被拦成了最小化」。
 */
let taskModalGuard = null;

/** 丢掉收起来的任务弹窗（任务被停止 / 已结束时用，避免留着僵尸节点）。 */
function dropStashedTaskModal() {
  hiddenTaskModal = null;
  hiddenTaskModalClose = null;
  taskModalGuard = null;
}

function renderTaskDock() {
  // 一键下载的任务也走这个坞：mode=download 显示「下载」，别混进「生成」
  const dock = document.querySelector('#task-dock');
  const list = document.querySelector('#task-dock-list');
  if (!dock || !list) return;
  /*
   * 坞里只放「还在跑 / 排队」的任务。
   *
   * 以前结束的任务会留两条在这儿，理由是「跑完想再看一眼」；实际用起来它就一直
   * 赖在左下角，96% 的空间和时间都没人点它。结果那一屏本来就留在前台，关掉之后
   * 也没必要再从坞里捡回来。
   */
  const visible = sophonJobs.filter((job) => ['queued', 'starting', 'running'].includes(job.status));
  if (!visible.length) {
    dock.hidden = true;
    document.body.classList.remove('sophon-minimized');
    return;
  }
  dock.hidden = false;
  const jobTitle = (job) =>
    `${job.mode === 'update' ? '更新' : job.mode === 'download' ? '下载' : '生成'} ${job.serverName}`;
  list.innerHTML = `
    <div class="task-dock-head"><strong>硬链接任务</strong><span>${visible.length} 个进行中</span></div>
    ${visible
      .map((job) => {
        if (job.status === 'queued') {
          return `
            <div class="task-dock-item task-dock-queued">
              <button class="task-dock-main" data-action="focus-sophon" data-id="${esc(job.id)}" title="排队中，前面的任务结束后自动开始">
                <span class="task-dock-icon">${icon('clock')}</span>
                <span class="task-dock-copy"><strong>${esc(job.serverName)}</strong><small>排队中 · ${esc(job.gameName)}</small></span>
              </button>
              <button class="task-dock-stop" data-action="remove-sophon-queue" data-id="${esc(job.id)}" title="取消排队">✕</button>
            </div>`;
        }
        if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
          const label =
            job.status === 'done' ? '已完成' : job.status === 'cancelled' ? '已停止' : '失败了';
          const glyph = job.status === 'done' ? 'check' : job.status === 'cancelled' ? 'clock' : 'alert';
          return `
            <div class="task-dock-item task-dock-ended is-${job.status}">
              <button class="task-dock-main" data-action="focus-sophon" data-id="${esc(job.id)}" title="重新打开这个界面">
                <span class="task-dock-icon">${icon(glyph)}</span>
                <span class="task-dock-copy">
                  <strong>${jobTitle(job)}</strong>
                  <small>${label}${job.percent >= 100 && job.status === 'done' ? ' · 100%' : ''}${
                    job.stats ? ` · ${esc(job.stats)}` : ''
                  }</small>
                </span>
              </button>
              <button class="task-dock-stop" data-action="dismiss-sophon-job" data-id="${esc(job.id)}" title="从列表里移除">✕</button>
            </div>`;
        }
        // 阶段文案和弹窗里的阶段条同源，缩到任务坞里也不会换一套说法
        const stepText = job.stage === undefined ? '' : `${sophonStageText(job.stage)}`;
        const phaseText = job.percent >= 100 ? '完成' : stepText || job.phase || '准备中…';
        return `
          <div class="task-dock-item">
            <button class="task-dock-main" data-action="focus-sophon" data-id="${esc(job.id)}" title="打开任务界面">
              <span class="task-dock-icon">${icon('download')}</span>
              <span class="task-dock-copy">
                <strong>${jobTitle(job)}</strong>
                <small>${esc(phaseText)}${job.stats ? ` · ${esc(job.stats)}` : ''}</small>
                <span class="task-dock-bar"><span style="width:${Math.max(0, Math.min(100, job.percent || 0))}%"></span></span>
              </span>
            </button>
            <button class="task-dock-stop" data-action="cancel-sophon-dock" data-id="${esc(job.id)}" title="停止">✕</button>
          </div>`;
      })
      .join('')}`;
}

/** 结束态的历史只留最近两条，否则坞会越堆越长。 */
function pruneSophonHistory() {
  const ended = sophonJobs.filter((job) =>
    ['done', 'error', 'cancelled'].includes(job.status)
  );
  if (ended.length <= 2) return;
  const dropped = new Set(ended.slice(0, ended.length - 2));
  sophonJobs = sophonJobs.filter((job) => !dropped.has(job));
}

function startNextSophonJob() {
  if (activeSophonJob) return;
  const next = sophonJobs.find((job) => job.status === 'queued');
  if (!next) {
    renderTaskDock();
    return;
  }
  sophonJobs = sophonJobs.filter((job) => job !== next);
  setTimeout(() => openSophonModal(next.gameId, next.serverId, next.mode, { autoStart: true }), 450);
}

function openSophonModal(gameId, serverId, mode = 'prepare', options = {}) {
  const game = state.games.find((item) => item.id === gameId);
  const server = game && (game.servers || []).find((item) => item.id === serverId);
  if (!game || !server) return;
  const isUpdate = mode === 'update';
  const jobId = `sophon-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  /*
   * 生成中不再允许再开一个（以前是往后排队）。
   *
   * 排队这个设计在「硬链接」这种一跑几十分钟、又要占着客户端目录的操作上只会
   * 让人误会：点下去以为又要开始了，实际在后面排队，界面还停在原地。
   * 现在直接拦住，并把正在跑的那个界面捧回前台 —— 想看进度、想停，都在那一屏里。
   */
  if (!options.job) {
    const busy = activeSophonJob || sophonJobs.find((item) => ['starting', 'running'].includes(item.status));
    if (busy) {
      const same = busy.gameId === gameId && busy.serverId === serverId;
      if (same) restoreTaskModal();
      toast(
        same
          ? `${server.name} 正在生成，这一屏已经给你调回来了`
          : `「${busy.serverName}」正在生成，等它跑完再开下一个`,
        'info'
      );
      return;
    }
  }
  // 新任务开始：把上一次收在坞里的旧弹窗丢掉，免得点任务条时挂回来的是上一单的界面
  dropStashedTaskModal();
  const job = {
    id: jobId,
    gameId,
    serverId,
    gameName: game.name,
    serverName: server.name,
    mode,
    status: 'starting',
    percent: 0,
    phase: '准备中…',
    stats: '',
  };
  sophonJobs.push(job);
  renderTaskDock();
  let running = false;
  let cancelled = false;
  // 跑成功之后按钮会变成「完成」，finally 里不能再用「重新尝试」把它改回去
  let finishedOk = false;
  let unsubscribe = null;

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal modal-sophon" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>${isUpdate ? '更新' : '硬链接安装'} ${esc(server.name)} 客户端</h2>
            <p>${esc(game.name)} · ${isUpdate ? '检查并安装官方更新' : '以你已安装的客户端为源，硬链接相同文件，只下载差异分块'}</p>
          </div>
          <div class="modal-head-actions">
            <button class="modal-close" id="sophon-minimize" style="display:none" title="最小化">−</button>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
        </div>
        <div class="modal-body">
          <p class="sw-note">${icon('info', 'xs')}<span>${
            isUpdate
              ? '只下载和当前版本不一样的分块，其余文件就地校验保留。'
              : '内容相同的文件直接复用，只下载差异分块。'
          }</span></p>
          <details class="sw-note-more">
            <summary>这一步具体会做什么</summary>
            <p>${
              isUpdate
                ? '会对现有客户端逐文件校验，只下载版本不同或缺失的分块；官方清单之外的删除项不会动。有本地补丁的渠道会先就地修补，再补齐剩下的分块。'
                : '先和你已有的客户端逐文件比较：完全相同的文件建立硬链接复用，只下载不同或缺失的分块，所以实际新增占用通常远小于客户端总体积。'
            }整个过程都要保持游戏关闭。</p>
          </details>
          <div class="sw-sum">
            <div class="sw-sum-row">
              <span class="sw-sum-k">目标版本</span>
              <span class="sw-sum-v" id="sw-sum-tag">读清单后确定</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">可复用上限</span>
              <span class="sw-sum-v" id="sw-sum-reuse">统计中…</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">目标盘剩余</span>
              <span class="sw-sum-v" id="sw-sum-free">统计中…</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">空间判断</span>
              <span class="sw-sum-v" id="sw-sum-space">统计中…</span>
            </div>
            <p class="sw-sum-hint" id="sw-sum-hint">
              要下载多少得等读完官方清单才知道，进度区会边跑边显示；「可复用上限」是基础客户端的体积，内容一致的部分不用再下一遍。
            </p>
          </div>
          <div class="sophon-target">
            <span>目标目录</span>
            <code id="sophon-target-dir">正在确定…</code>
            <button type="button" class="btn btn-ghost btn-sm" id="sophon-pick-dir" title="选一个目录当运行时根目录，启动器会在里面按 游戏\\渠道 建子目录">选择目录</button>
          </div>
          <ol class="sw-stages" id="sophon-stages">
            ${SOPHON_STAGES.map(
              (stage, index) => `
              <li class="sw-stage" data-index="${index}">
                <span class="sw-stage-dot">${index + 1}</span>
                <span class="sw-stage-label">${esc(stage.label)}</span>
              </li>`
            ).join('')}
          </ol>
          <div class="link-progress" id="sophon-progress" style="display:none">
            <div class="link-progress-head">
              <strong id="sophon-phase">准备中…</strong>
              <span id="sophon-count"></span>
            </div>
            <div class="progress-bar"><span id="sophon-bar" style="width:0%"></span></div>
            <div class="link-progress-meta">
              <span id="sophon-stats"></span>
              <span id="sophon-current"></span>
            </div>
          </div>
          <p class="sw-ldiff" id="sophon-ldiff" hidden></p>
          <div class="sw-result" id="sophon-result" hidden>
            <strong class="sw-result-title" id="sophon-result-title">已完成</strong>
            <div class="sw-result-grid" id="sophon-result-grid"></div>
            <p class="sw-result-note" id="sophon-result-note"></p>
          </div>
          <div class="field-error" id="sophon-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
          <button class="btn btn-ghost" id="sophon-pause" style="display:none">暂停</button>
          <button class="btn btn-ghost" id="sophon-cancel" style="display:none">停止</button>
          <button class="btn btn-primary" id="sophon-start">${icon(isUpdate ? 'refresh' : 'download')}${isUpdate ? '开始更新' : '开始硬链接安装'}</button>
        </div>
      </div>
    </div>`;

  /* 关窗回调单独拿个名字：任务收进任务坞再从任务条挂回来时，要把它一起装回去 */
  const taskOnClose = () => {
    if (running) {
      /*
       * 跑着的时候关窗 = 收进任务坞继续跑，和下载弹窗同一套语义。
       * 以前这里是「关窗即取消」：误点一下 ✕ 几十秒的硬链接就白做了，
       * 而且任务条上再也点不回这个界面。真要停，界面里有「停止」。
       */
      minimizeTask();
    } else {
      // 完成 / 失败的那一条留在坞里，用户回头看还能点回来
      pruneSophonHistory();
      renderTaskDock();
    }
    // 队列在「完成」时没有被放行（那时窗口还开着看结果），关窗这一步才轮到下一个
    if (finishedOk) startNextSophonJob();
  };
  openModal(html, {
    onClose: taskOnClose,
    onBackdrop: () => {
      if (running) minimizeTask();
      else closeModal();
    },
  });

  const start = document.querySelector('#sophon-start');
  const cancel = document.querySelector('#sophon-cancel');
  const progress = document.querySelector('#sophon-progress');
  const errorBox = document.querySelector('#sophon-error');
  const minimize = document.querySelector('#sophon-minimize');
  const pause = document.querySelector('#sophon-pause');
  let paused = false;
  let selectedRuntimeRoot = '';
  const backdrop = document.querySelector('.modal-backdrop');
  const dock = document.querySelector('#task-dock');

  const hideDock = () => {
    if (activeSophonJob === job) activeSophonJob = null;
    sophonUi = null;
    taskModalGuard = null;
    document.body.classList.remove('sophon-minimized');
    renderTaskDock();
  };

  // 跑着的时候被关窗（✕ / Esc / 点遮罩）→ 收进任务坞，而不是把界面销毁
  taskModalGuard = () => {
    if (!running || !backdrop || !dom.modalRoot.contains(backdrop)) return false;
    hiddenTaskModalClose = taskOnClose;
    stashTaskModal(backdrop);
    return true;
  };

  const minimizeTask = () => {
    if (!running) return;
    // 整块 DOM 拔下来存着：中途开别的弹窗也不会把它冲掉，点任务条能原样挂回去
    hiddenTaskModalClose = taskOnClose;
    stashTaskModal(backdrop);
    document.body.classList.add('sophon-minimized');
    job.status = 'running';
    activeSophonJob = job;
    renderTaskDock();
    sophonUi = {
      restore: () => {
        restoreTaskModal();
      },
      cancel: () => {
        cancelled = true;
        running = false;
        job.status = 'cancelled';
        api.servers.cancelSophon(jobId).catch(() => {});
        dropStashedTaskModal();
        closeModal();
        hideDock();
        pruneSophonHistory();
        startNextSophonJob();
      },
    };
  };

  const updateDock = (phaseLabel, percent, stats, current, stage) => {
    job.phase = phaseLabel;
    job.percent = Math.max(0, Math.min(100, percent));
    job.stats = stats;
    job.current = current || '';
    // stage 只在真正拿到进度事件时写，暂停 / 排队这类状态不该把阶段条往回退
    if (stage !== undefined) job.stage = stage;
    if (activeSophonJob === job) renderTaskDock();
  };

  minimize.addEventListener('click', minimizeTask);

  // 开始按钮带了图标，恢复默认态必须还原 innerHTML，直接写 textContent 会把图标弄丢
  const startIdleHtml = start.innerHTML;
  const restoreStart = () => {
    if (running || finishedOk) return;
    start.disabled = false;
    start.innerHTML = startIdleHtml;
  };

  /* 阶段条：只往前走，不往回退。中途重试也从当前阶段继续，免得看着像回到原点。 */
  const stageBox = document.querySelector('#sophon-stages');
  let stageIndex = -1;
  let ldiffSeen = false;
  const paintStages = (index) => {
    if (!stageBox) return;
    if (index >= 0) stageIndex = Math.max(stageIndex, index);
    const finishedAll = stageIndex >= SOPHON_STAGES.length - 1;
    [...stageBox.querySelectorAll('.sw-stage')].forEach((node, i) => {
      const isDone = finishedAll || i < stageIndex;
      // 走到写入阶段还没见过 ldiff 事件，说明这个渠道没有本地补丁，第 2 步标成「跳过」而不是让它一直空着
      const isSkipped = !ldiffSeen && i === 1 && stageIndex > 1;
      node.classList.toggle('is-done', isDone && !isSkipped);
      node.classList.toggle('is-active', !finishedAll && i === stageIndex);
      node.classList.toggle('is-skipped', isSkipped);
      node.querySelector('.sw-stage-dot').textContent = isDone && !isSkipped ? '✓' : String(i + 1);
      node.querySelector('.sw-stage-label').textContent = isSkipped
        ? `${SOPHON_STAGES[i].label}（跳过）`
        : SOPHON_STAGES[i].label;
    });
  };

  const sumTag = document.querySelector('#sw-sum-tag');
  const sumReuse = document.querySelector('#sw-sum-reuse');
  const sumFree = document.querySelector('#sw-sum-free');
  const sumSpace = document.querySelector('#sw-sum-space');
  const ldiffLine = document.querySelector('#sophon-ldiff');
  const resultBox = document.querySelector('#sophon-result');

  /*
   * 结果卡：把「省了多少、哪些没走补丁」摆出来。
   *
   * 主进程只回数量（applied / failed / downloaded），没有失败文件的路径清单，
   * 所以这里如实写「N 个改用下载」，不假装能列出文件名。
   */
  const showResult = (result) => {
    if (!resultBox) return;
    const ldiff = result.ldiff || null;
    const items = [
      { k: '目标版本', v: result.tag || '—' },
      { k: '硬链接复用', v: `${result.linked || 0} 个文件` },
      { k: '实际下载', v: `${result.downloaded || 0} 个文件` },
    ];
    if (ldiff && ldiff.applied > 0) {
      items.push({ k: '本地补丁修补', v: `${ldiff.applied} 个 · 省流 ${formatSize(ldiff.saveBytes || 0)}` });
    }
    resultBox.querySelector('#sophon-result-title').textContent = isUpdate ? '更新完成' : '生成完成';
    resultBox.querySelector('#sophon-result-grid').innerHTML = items
      .map(
        (item) =>
          `<div class="sw-result-item"><span>${esc(item.k)}</span><strong>${esc(item.v)}</strong></div>`
      )
      .join('');
    const notes = [];
    if (result.targetRoot) notes.push(`目录：${result.targetRoot}`);
    if (ldiff && ldiff.failed) {
      notes.push(`${ldiff.failed} 个文件的补丁没能应用（可能被占用或校验不通过），已改走下载补齐。`);
    }
    if (!ldiff) {
      notes.push('这次没有走本地补丁（这个渠道没有启用，或没有对应的旧版本补丁），全部按分块校验补齐。');
    }
    resultBox.querySelector('#sophon-result-note').textContent = notes.join(' ');
    resultBox.hidden = false;
  };

  /*
   * 结论卡：安装前先回答四个问题 —— 装哪个版本、能复用多少、目标盘还剩多少、够不够。
   *
   * 数据全部来自 prepareSophon 的 estimate 分支（freeBytes / baseBytes / drive / partial）。
   * 那个分支不返回「这次要下载多少字节」，所以这里不编数字：复用上限用基础客户端体积
   * 表述，下载量交给进度区边跑边显示。
   */
  const refreshEstimate = async () => {
    if (!sumReuse) return;
    sumReuse.textContent = '统计中…';
    sumFree.textContent = '统计中…';
    sumSpace.textContent = '统计中…';
    sumSpace.classList.remove('is-warn', 'is-ok');
    try {
      const result = await api.servers.prepareSophon({
        gameId,
        serverId,
        estimate: true,
        runtimeRoot: selectedRuntimeRoot || undefined,
      });
      if (!result || !result.ok) {
        const reason = (result && result.error) || '拿不到空间信息';
        sumReuse.textContent = '未知';
        sumFree.textContent = '未知';
        sumSpace.textContent = reason;
        sumSpace.classList.add('is-warn');
        // 这些前置条件（基础客户端、同盘运行时）不满足时真跑也会立刻失败，不如当场拦住
        if (errorBox) errorBox.textContent = reason;
        if (!running && !finishedOk) {
          start.disabled = true;
          start.textContent = '先按提示处理再开始';
        }
        return;
      }
      if (result.targetRoot) {
        const label = document.querySelector('#sophon-target-dir');
        if (label) label.textContent = result.targetRoot;
      }
      const free = Number(result.freeBytes) || 0;
      const base = Number(result.baseBytes) || 0;
      sumFree.textContent = free ? `${formatSize(free)}（${result.drive || '目标盘'}）` : '读不到磁盘信息';
      sumReuse.textContent = base
        ? `约 ${formatSize(base)}${result.partial ? '（还在统计）' : ''}`
        : '没有可复用的基础客户端';
      if (!free) {
        sumSpace.textContent = '判断不了，先按默认目录继续也可以';
      } else if (!base) {
        sumSpace.textContent = '没有基础客户端，全部要下载';
        sumSpace.classList.add('is-warn');
      } else if (base > free) {
        // 硬链接只是省掉「内容相同」的那部分，不能承诺一定装得下
        sumSpace.textContent = '可能不够：基础客户端比剩余空间大，相同文件会复用，仍建议先腾些空间';
        sumSpace.classList.add('is-warn');
      } else {
        sumSpace.textContent = '够用';
        sumSpace.classList.add('is-ok');
      }
      // 上一次可能因为缺基础客户端被拦住，条件补齐后要把按钮还回去
      if (errorBox) errorBox.textContent = '';
      restoreStart();
    } catch (error) {
      /*
       * estimate 遇到「没有基础客户端」「运行时目录不在同一个盘」这类硬性条件会直接抛错，
       * 那不是「读不到空间」，而是根本装不了 —— 原文透出，别糊成一句「直接开始也可以」。
       */
      sumReuse.textContent = '未知';
      sumFree.textContent = '未知';
      sumSpace.textContent = humanError(error);
      sumSpace.classList.add('is-warn');
      if (errorBox) errorBox.textContent = humanError(error);
      if (!running && !finishedOk) {
        start.disabled = true;
        start.textContent = '先按提示处理再开始';
      }
    }
  };
  refreshEstimate();

  const closeX = document.querySelector('.modal-head [data-close]');
  if (closeX) {
    closeX.addEventListener(
      'click',
      (event) => {
        if (running) {
          event.preventDefault();
          event.stopPropagation();
          minimizeTask();
        }
      },
      true
    );
  }
  const pickDir = document.querySelector('#sophon-pick-dir');
  if (pickDir) {
    pickDir.addEventListener('click', async () => {
      const dir = await api.pick.directory();
      if (!dir) return;
      selectedRuntimeRoot = dir;
      // 选的是「运行时根目录」，真正的客户端目录是 根目录\游戏\渠道，由主进程补全，
      // 所以这里先显示占位，等预估回来再写真实路径
      const label = document.querySelector('#sophon-target-dir');
      if (label) label.textContent = `${dir}（根目录，正在确定子目录…）`;
      // 换了目标盘，剩余空间就变了，预估得跟着重算
      refreshEstimate();
    });
  }
  pause.addEventListener('click', async () => {
    paused = !paused;
    await api.servers.pauseSophon({ jobId, paused }).catch(() => {});
    pause.textContent = paused ? '继续' : '暂停';
    const phase = document.querySelector('#sophon-phase');
    if (phase) phase.textContent = paused ? '已暂停（点继续恢复）' : '恢复中…';
    if (paused) updateDock('已暂停', 0, '点任务条恢复窗口');
  });

  start.addEventListener('click', async () => {
    // 跑完之后这个按钮变成「完成」：只负责关窗并放行队列里的下一个任务
    if (finishedOk) {
      closeModal();
      return;
    }
    running = true;
    cancelled = false;
    job.status = 'running';
    activeSophonJob = job;
    sophonUi = {
      restore: () => {
        if (backdrop) backdrop.style.display = '';
        document.body.classList.add('modal-open');
        document.body.classList.remove('sophon-minimized');
        renderTaskDock();
      },
      cancel: () => {
        cancelled = true;
        running = false;
        job.status = 'cancelled';
        api.servers.cancelSophon(jobId).catch(() => {});
        closeModal();
        hideDock();
        startNextSophonJob();
      },
    };
    renderTaskDock();
    start.disabled = true;
    start.textContent = '正在生成…';
    cancel.style.display = '';
    minimize.style.display = '';
    pause.style.display = '';
    progress.style.display = 'block';
    errorBox.textContent = '';
    paintStages(0);
    unsubscribe = api.onSophonProgress((event) => {
      if (event.jobId !== jobId) return;
      const total = Number(event.total) || 0;
      const processed = Number(event.processed) || 0;
      const percent = total ? Math.min(100, (processed / total) * 100) : 0;
      const stage = SOPHON_PHASE_STAGE[event.phase] ?? 2;
      const phases = {
        start: '读取官方清单',
        version: `目标版本 ${event.tag || ''}`,
        manifest: '读取清单与分块索引',
        install: '写入文件',
        download: '下载分块',
        patch: '应用补丁',
        // ldiff 预修补阶段：先把能就地补的文件补掉，再进 chunk 校验，界面上要能看出这一步在干什么
        ldiff: '本地补丁修补（省流）',
        link: '硬链接复用文件',
        done: '完成',
      };
      // 目标版本一读出来就填进结论卡，别让用户猜这次要装哪个版本
      if (event.tag && sumTag) sumTag.textContent = event.tag;
      if (event.phase === 'ldiff') {
        ldiffSeen = true;
        if (ldiffLine) {
          ldiffLine.hidden = false;
          ldiffLine.textContent = sophonProgressStats(event);
        }
      }
      // 文件都写完了但还没收到 done，说明在收尾校验，阶段条前进一格
      paintStages(percent >= 100 && stage === 2 ? 3 : stage);
      document.querySelector('#sophon-phase').textContent = phases[event.phase] || '处理中…';
      document.querySelector('#sophon-count').textContent = total ? `${processed} / ${total}` : '';
      document.querySelector('#sophon-bar').style.width = `${event.phase === 'done' ? 100 : percent}%`;
      const stats = sophonProgressStats(event);
      document.querySelector('#sophon-stats').textContent = stats;
      document.querySelector('#sophon-current').textContent = event.current || '';
      updateDock(
        phases[event.phase] || '处理中…',
        event.phase === 'done' ? 100 : percent,
        sophonProgressStats(event, true),
        event.current || '',
        stage
      );
    });

    try {
      const result = await (isUpdate
        ? api.servers.updateSophon({ gameId, serverId, jobId })
        : api.servers.prepareSophon({
            gameId,
            serverId,
            jobId,
            runtimeRoot: selectedRuntimeRoot || undefined,
          }));
      if (result.cancelled || cancelled) {
        // 停了就是停了：坞里不留残影，免得左下角一直挂着一条什么都没有的条目
        job.status = 'cancelled';
        sophonJobs = sophonJobs.filter((item) => item !== job);
        hideDock();
        toast('已停止生成，可以下次继续', 'info');
        return;
      }
      running = false;
      job.status = 'done';
      job.percent = 100;
      // 任务结束就从坞里摘掉：坞只负责「还在跑的」，结果这一屏本来就在前台开着，
      // 再挂一条「已完成」只会一直赖在那个角落
      sophonJobs = sophonJobs.filter((item) => item !== job);
      hideDock();
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      /*
       * 完成后不自动关窗：这一屏里有「省了多少、哪些文件没走补丁」，
       * 只发一条几秒就消失的 toast 等于让用户自己猜。改成留在弹窗里，
       * 用户点「完成」再关，关的时候才放行队列里的下一个任务。
       */
      finishedOk = true;
      paintStages(SOPHON_STAGES.length - 1);
      showResult(result);
      const ldiffNote =
        result.ldiff && result.ldiff.applied > 0
          ? `，其中 ${result.ldiff.applied} 个由本地补丁修好、省流 ${formatSize(result.ldiff.saveBytes || 0)}`
          : '';
      toast(
        `${isUpdate ? '更新' : '生成'}完成（${result.tag}）：硬链接 ${result.linked} 个 · 下载 ${result.downloaded} 个${ldiffNote}`,
        'success'
      );
    } catch (error) {
      job.status = cancelled ? 'cancelled' : 'error';
      // 失败 / 停止同样不在坞里留残影：错误就写在这一屏上，坞只放还在跑的任务
      sophonJobs = sophonJobs.filter((item) => item !== job);
      hideDock();
      if (cancelled) toast('已停止生成', 'info');
      else {
        errorBox.textContent = humanError(error);
        toast(humanError(error), 'error');
      }
      startNextSophonJob();
    } finally {
      running = false;
      hideDock();
      start.disabled = false;
      start.textContent = finishedOk ? '完成' : '重新尝试';
      cancel.style.display = 'none';
      minimize.style.display = 'none';
      pause.style.display = 'none';
      pause.textContent = '暂停';
      paused = false;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    }
  });

  cancel.addEventListener('click', () => {
    cancelled = true;
    cancel.disabled = true;
    api.servers.cancelSophon(jobId).catch(() => {});
  });

  if (options.autoStart) {
    setTimeout(() => start.click(), 180);
  }
}

/** 两个服务器是否共用同一个安装目录（官服/B服 常见）。 */
function sameRoot(a, b) {
  if (!a || !b) return false;
  const left = String(a.root || '').replace(/[\\/]+$/, '').toLowerCase();
  const right = String(b.root || '').replace(/[\\/]+$/, '').toLowerCase();
  return Boolean(left) && left === right;
}

function openLinkModal(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;
  const servers = game.servers || [];
  const usable = servers.filter((server) => server.exists);
  /*
   * 这里不再拿「至少两个已配置的服务器」当门槛。
   * 玩家没有官服客户端、但本机有完整游戏目录时，靠自定义文件夹照样能合并；
   * 以前那种「还需要两个客户端」的空状态会把人直接挡在门外。
   */
  const option = (server) =>
    `<option value="${esc(server.id)}">${esc(server.name)}${
      server.exists ? '' : ' · 未配置启动程序'
    }</option>`;
  const defaultSource = usable.find((server) => server.active) || usable[0] || servers[0] || null;
  /*
   * 官服和 B 服常常装在同一目录（只是启动程序不同），这种组合压根没法建硬链接。
   * 默认目标优先挑一个目录不同的，免得用户一打开就撞上「源目录和目标目录相同」。
   */
  const defaultTarget =
    servers.find(
      (server) =>
        server.id !== (defaultSource && defaultSource.id) &&
        server.exists &&
        !sameRoot(server, defaultSource)
    ) ||
    servers.find((server) => server.id !== (defaultSource && defaultSource.id)) ||
    null;

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal sw-link-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>硬链接去重</h2>
            <p>${esc(game.name)} · 把两个客户端里完全相同的文件合成同一份，不多删、不改内容。</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          ${
            servers.length
              ? `<ol class="sw-steps" id="sw-link-steps">
                  <li class="sw-step is-active"><span>1</span><strong>选对象</strong></li>
                  <li class="sw-step"><span>2</span><strong>预检</strong></li>
                  <li class="sw-step"><span>3</span><strong>执行</strong></li>
                </ol>
                <p class="sw-note">${icon(
                  'alert',
                  'xs'
                )}<span>开工前关掉游戏和官方启动器。只合并两边<b>大小和内容都相同</b>的文件；内容不同、目标端独有、游戏存档都不会被改动。</span></p>
                <details class="sw-note-more">
                  <summary>注意</summary>
                  <p>终末地的 <code>U8Data</code> 与 <code>sdkdata</code> 存的是渠道登录态，会自动跳过——合并了会让一边登录改写另一边的配置。第一次用建议选「完整校验」，确认没问题后再用快速比较。</p>
                </details>
                <section class="sw-link-step" id="link-step-1">
                  <div class="link-pair">
                    <div class="field" style="margin-bottom:0">
                      <label>源客户端（文件从这里复用）</label>
                      <select class="select" id="link-source" style="width:100%">${servers
                        .map(option)
                        .join('')}</select>
                    </div>
                    <button type="button" class="link-swap" id="link-swap" title="交换源和目标" aria-label="交换源和目标">${icon(
                      'shuffle'
                    )}</button>
                    <div class="field" style="margin-bottom:0">
                      <label>目标客户端（被合并的一方）</label>
                      <select class="select" id="link-target" style="width:100%">${servers
                        .map(option)
                        .join('')}</select>
                    </div>
                  </div>
                  <p class="sw-link-dirs" id="link-dirs" hidden></p>
                  <p class="sw-link-same" id="link-same" hidden></p>
                  <div class="sw-link-custom">
                    <div class="sw-link-custom-head">自定义文件夹（可选）· 没有对应渠道的 exe 也能用</div>
                    <div class="field-row">
                      <div class="field" style="margin-bottom:0">
                        <label>源目录</label>
                        <div class="input-group">
                          <input id="link-source-root" placeholder="留空则用源客户端的安装目录" spellcheck="false" />
                          <button type="button" class="btn btn-ghost" id="pick-link-source-root">${icon(
                            'folder'
                          )}浏览</button>
                        </div>
                      </div>
                      <div class="field" style="margin-bottom:0">
                        <label>目标目录</label>
                        <div class="input-group">
                          <input id="link-target-root" placeholder="留空则用目标客户端的安装目录" spellcheck="false" />
                          <button type="button" class="btn btn-ghost" id="pick-link-target-root">${icon(
                            'folder'
                          )}浏览</button>
                        </div>
                      </div>
                    </div>
                    <p class="hint">两个目录要么都填、要么都留空。填了就只比较这两个文件夹，不再要求服务器配好 exe。</p>
                  </div>
                  <div class="field">
                    <label>比对方式</label>
                    <div class="mode-options">
                      <label class="mode-card">
                        <input type="radio" name="link-mode" value="full" checked />
                        <span><strong>完整校验</strong><small>逐文件比对 SHA-256，最可靠；大客户端会慢一些。</small></span>
                      </label>
                      <label class="mode-card">
                        <input type="radio" name="link-mode" value="fast" />
                        <span><strong>快速比较</strong><small>大小 + 首尾各 1MB，快很多，适合先试跑。</small></span>
                      </label>
                    </div>
                  </div>
                </section>
                <section class="sw-link-step" id="link-step-2" hidden>
                  <div class="link-preview" id="link-preview" style="display:none"></div>
                </section>
                <section class="sw-link-step" id="link-step-3" hidden>
                  <div class="sw-result" id="link-result" hidden></div>
                </section>
                <div class="link-progress" id="link-progress" style="display:none">
                  <div class="link-progress-head">
                    <strong id="link-phase">准备中…</strong>
                    <span id="link-count"></span>
                  </div>
                  <div class="progress-bar"><span id="link-bar" style="width:0%"></span></div>
                  <div class="link-progress-meta">
                    <span id="link-saved"></span>
                    <span id="link-current"></span>
                  </div>
                </div>
                <div class="field-error" id="link-error"></div>`
              : `<div class="empty" style="padding:38px 20px">
                  <div class="empty-icon">${icon('link')}</div>
                  <h3>这个游戏还没有服务器</h3>
                  <p>先去服务器管理里添加一个客户端；如果你只是想让两个目录合并，也可以先添加任意一个再回来用自定义文件夹。</p>
                  <button class="btn btn-ghost" data-close>知道了</button>
                </div>`
          }
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="link-back" style="display:none">上一步</button>
          <button class="btn btn-ghost" data-close>关闭</button>
          ${
            servers.length
              ? `<button class="btn btn-ghost" id="link-cancel" style="display:none">停止</button>
                 <button class="btn btn-primary" id="link-start">${icon('search')}下一步：预检</button>`
              : ''
          }
        </div>
      </div>
    </div>`;

  let step = 1;
  let running = false;
  // 预检和真正的合共用同一个进度区，靠这个标记区分事件归属
  let previewing = false;
  // 两步流程：先检测出可合并的文件，用户确认后才真的建链接
  let previewResult = null;
  let currentJobId = null;
  let merged = false;
  let unsubProgress = null;
  let unsubPreview = null;

  openModal(html, {
    onClose: () => {
      if (unsubProgress) unsubProgress();
      if (unsubPreview) unsubPreview();
      if (running && currentJobId) api.servers.cancelLink(currentJobId).catch(() => {});
    },
  });

  if (!servers.length) return;

  const sourceSelect = document.querySelector('#link-source');
  const targetSelect = document.querySelector('#link-target');
  const startButton = document.querySelector('#link-start');
  const cancelButton = document.querySelector('#link-cancel');
  const progress = document.querySelector('#link-progress');
  const phase = document.querySelector('#link-phase');
  const count = document.querySelector('#link-count');
  const bar = document.querySelector('#link-bar');
  const saved = document.querySelector('#link-saved');
  const current = document.querySelector('#link-current');
  const error = document.querySelector('#link-error');
  const previewBox = document.querySelector('#link-preview');
  const resultBox = document.querySelector('#link-result');
  const sameNote = document.querySelector('#link-same');
  const dirsNote = document.querySelector('#link-dirs');
  const backButton = document.querySelector('#link-back');
  const stepNodes = [1, 2, 3].map((index) => document.querySelector(`#link-step-${index}`));
  const stepDots = [...document.querySelectorAll('#sw-link-steps .sw-step')];
  const linkSourceRoot = document.querySelector('#link-source-root');
  const linkTargetRoot = document.querySelector('#link-target-root');

  if (defaultSource) sourceSelect.value = defaultSource.id;
  if (defaultTarget) targetSelect.value = defaultTarget.id;

  const modeOf = () => document.querySelector('input[name="link-mode"]:checked').value;

  /* 路径比较统一走「正斜杠转反斜杠 + 去尾斜杠 + 小写」，否则 G:/X 和 G:\X\ 会被当成两个目录 */
  const normalizeDir = (dir) =>
    String(dir || '')
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .trim()
      .toLowerCase();
  const driveOf = (dir) => {
    const matched = String(dir || '')
      .replace(/\//g, '\\')
      .match(/^([a-zA-Z]):/);
    return matched ? matched[1].toUpperCase() : '';
  };

  /*
   * 第一步就在本地判一次能不能合并。
   *
   * 以前是点到最后一步才由后端抛「源目录和目标目录相同」，用户要重来一遍；
   * 官服和 B 服装在同一文件夹又是最常见的情况，所以这里当场说清楚并禁用下一步。
   */
  function checkDirs() {
    const customSource = linkSourceRoot.value.trim();
    const customTarget = linkTargetRoot.value.trim();
    const source = servers.find((item) => item.id === sourceSelect.value) || null;
    const target = servers.find((item) => item.id === targetSelect.value) || null;

    if (customSource || customTarget) {
      if (!customSource || !customTarget) {
        return { problem: '自定义文件夹需要同时指定源目录和目标目录。' };
      }
      if (normalizeDir(customSource) === normalizeDir(customTarget)) {
        return { problem: '源目录和目标目录填的是同一个文件夹，没有可合并的内容。' };
      }
      if (driveOf(customSource) && driveOf(customTarget) && driveOf(customSource) !== driveOf(customTarget)) {
        return { problem: '两个目录不在同一个磁盘分区，Windows 无法创建硬链接。' };
      }
      return { ok: true, custom: true, sourceRoot: customSource, targetRoot: customTarget, source, target };
    }

    if (!source || !target) return { problem: '请选择源客户端和目标客户端。' };
    if (source.id === target.id) {
      // 只有一行服务器的游戏（自建游戏常见）拿自己和自己比没有意义，直接把人引到自定义文件夹
      return {
        problem:
          servers.length < 2
            ? '这个游戏只有一行服务器，没法拿它和自己比。请在下面「自定义文件夹」里分别填源目录和目标目录。'
            : '源客户端和目标客户端不能是同一个。',
      };
    }
    const missing = [source, target].find((item) => !item.exists);
    if (missing) {
      return {
        problem: `${missing.name} 还没有配置启动程序（.exe）。可以先去服务器管理里选好，或者直接在下面的「自定义文件夹」里填两个完整目录。`,
      };
    }
    if (!source.root || !target.root) {
      return { problem: '读不到安装目录，请在「自定义文件夹」里手动填两个目录。' };
    }
    if (normalizeDir(source.root) === normalizeDir(target.root)) {
      return {
        problem:
          '这两个客户端装在同一个文件夹里（官服和 B 服常常是这样），没有可合并的内容。换一个目录不同的客户端，或者在下面「自定义文件夹」里分别填两个目录。',
      };
    }
    if (driveOf(source.root) !== driveOf(target.root)) {
      return { problem: '两个目录不在同一个磁盘分区，Windows 无法创建硬链接。' };
    }
    return { ok: true, custom: false, sourceRoot: source.root, targetRoot: target.root, source, target };
  }

  /* 第一步的实时反馈：能合并就把两个真实目录摊开给用户看，不能就说明原因并禁用下一步 */
  function paintStep1() {
    if (!startButton) return;
    const check = checkDirs();
    if (dirsNote) {
      dirsNote.hidden = !check.ok;
      dirsNote.textContent = check.ok ? `将比较：${check.sourceRoot} → ${check.targetRoot}` : '';
    }
    if (sameNote) {
      sameNote.hidden = Boolean(check.ok);
      sameNote.textContent = check.ok ? '' : check.problem;
    }
    if (step === 1) {
      startButton.disabled = !check.ok;
      startButton.textContent = '下一步：预检';
    }
    return check;
  }

  function paintStep() {
    stepNodes.forEach((node, index) => {
      if (node) node.hidden = index + 1 !== step;
    });
    stepDots.forEach((node, index) => {
      node.classList.toggle('is-active', index + 1 === step);
      node.classList.toggle('is-done', index + 1 < step);
      node.querySelector('span').textContent = index + 1 < step ? '✓' : String(index + 1);
    });
    if (backButton) backButton.style.display = step > 1 && !running && !merged ? '' : 'none';
    if (step === 1) {
      paintStep1();
    } else if (step === 2) {
      startButton.disabled = running || !previewResult || !previewResult.matchable;
      startButton.textContent =
        previewResult && previewResult.matchable
          ? `开始合并（省 ${fmtBytes(previewResult.matchableBytes || 0)}）`
          : '重新预检';
    } else {
      startButton.disabled = running;
      startButton.textContent = merged ? '完成' : '正在合并…';
    }
  }

  /* 交换源 / 目标：常用操作，别让用户把两个下拉各点一遍 */
  document.querySelector('#link-swap').addEventListener('click', () => {
    if (running) return;
    const sourceId = sourceSelect.value;
    sourceSelect.value = targetSelect.value;
    targetSelect.value = sourceId;
    const sourceDir = linkSourceRoot.value;
    linkSourceRoot.value = linkTargetRoot.value;
    linkTargetRoot.value = sourceDir;
    resetPreview();
    paintStep1();
  });

  function setProgress(p) {
    progress.style.display = 'block';
    const percent = p.total > 0 ? Math.min(100, (p.processed / p.total) * 100) : 0;
    bar.style.width = `${p.phase === 'done' ? 100 : percent}%`;
    count.textContent = p.total > 0 ? `${p.processed} / ${p.total} 个候选` : '';
    saved.textContent = `已合并 ${p.linked || 0} 个 · 节省 ${fmtBytes(p.savedBytes || 0)}`;
    current.textContent = p.current || '';
    if (p.phase === 'scan') phase.textContent = '正在扫描两个目录…';
    else if (p.phase === 'compare') phase.textContent = '正在比对文件内容…';
    else if (p.phase === 'link') phase.textContent = '正在建立硬链接…';
    else if (p.phase === 'done') phase.textContent = p.cancelled ? '已停止' : '正在收尾…';
  }

  unsubProgress = api.onLinkProgress((payload) => {
    // 预检和合并共用同一个进度区，previewing 期间不能让合并事件串进来
    if (!payload || payload.gameId !== gameId || previewing) return;
    if (running) {
      currentJobId = payload.jobId || currentJobId;
      cancelButton.style.display = '';
    }
    setProgress(payload);
  });

  /* 每个游戏各自记住上次选的自定义目录，下次打开自动填回 */
  const linkRootsKey = `vela:link-roots:${gameId}`;
  try {
    const savedRoots = JSON.parse(localStorage.getItem(linkRootsKey) || 'null');
    if (savedRoots && typeof savedRoots === 'object') {
      if (savedRoots.source) linkSourceRoot.value = savedRoots.source;
      if (savedRoots.target) linkTargetRoot.value = savedRoots.target;
    }
  } catch {
    /* optional recollection */
  }

  function rememberLinkRoots() {
    try {
      localStorage.setItem(
        linkRootsKey,
        JSON.stringify({
          source: linkSourceRoot.value.trim(),
          target: linkTargetRoot.value.trim(),
        })
      );
    } catch {
      /* optional recollection */
    }
  }

  document.querySelector('#pick-link-source-root').addEventListener('click', async () => {
    const picked = await api.pick.directory();
    if (picked) {
      linkSourceRoot.value = picked;
      resetPreview();
      paintStep1();
    }
  });
  document.querySelector('#pick-link-target-root').addEventListener('click', async () => {
    const picked = await api.pick.directory();
    if (picked) {
      linkTargetRoot.value = picked;
      resetPreview();
      paintStep1();
    }
  });

  /* 预检结果：先说人话（能合并多少、省多少、哪些不动），再看数字 */
  function renderPreview(result, mode) {
    // 几百 MB 摊在 100 多 GB 上四舍五入就成了 0%，显示「<1%」比「0%」诚实
    const raw = result.targetBytes ? (result.matchableBytes / result.targetBytes) * 100 : 0;
    const percent = raw > 0 && raw < 1 ? '<1' : Math.round(raw);
    previewBox.innerHTML = `
      <div class="link-preview-head">
        <strong>预检完成</strong>
        <span>${mode === 'fast' ? '快速比较' : '完整校验'}</span>
      </div>
      <p class="sw-preview-line">
        完全相同的文件 <b>${result.matchable || 0}</b> 个可以合并，省下约 <b>${fmtBytes(
          result.matchableBytes || 0
        )}</b>；内容不同的 <b>${result.different || 0}</b> 个、只在目标端存在的 <b>${
          result.targetOnly || 0
        }</b> 个会原样保留。
      </p>
      <div class="link-preview-grid">
        <div class="link-stat is-accent">
          <span class="link-stat-num">${fmtBytes(result.matchableBytes || 0)}</span>
          <span class="link-stat-label">可以合并 · ${result.matchable || 0} 个文件</span>
        </div>
        <div class="link-stat">
          <span class="link-stat-num">${fmtBytes(result.alreadyLinkedBytes || 0)}</span>
          <span class="link-stat-label">已经合并过 · ${result.alreadyLinked || 0} 个</span>
        </div>
        <div class="link-stat">
          <span class="link-stat-num">${fmtBytes(result.differentBytes || 0)}</span>
          <span class="link-stat-label">内容不同（不动）· ${result.different || 0} 个</span>
        </div>
        <div class="link-stat">
          <span class="link-stat-num">${fmtBytes(result.targetOnlyBytes || 0)}</span>
          <span class="link-stat-label">目标端独有（保留）· ${result.targetOnly || 0} 个</span>
        </div>
      </div>
      <p class="link-preview-note">目标目录共 ${fmtBytes(result.targetBytes || 0)}，合并后大约省下 ${percent}%。</p>
    `;
    previewBox.style.display = 'block';
  }

  /* 换了源/目标/比对方式，之前的预检结果就作废，得重新检一遍 */
  function resetPreview() {
    previewResult = null;
    previewBox.style.display = 'none';
    previewBox.innerHTML = '';
    if (resultBox) resultBox.hidden = true;
  }

  [sourceSelect, targetSelect].forEach((select) =>
    select.addEventListener('change', () => {
      if (running) return;
      resetPreview();
      paintStep1();
    })
  );
  document.querySelectorAll('input[name="link-mode"]').forEach((input) =>
    input.addEventListener('change', () => {
      if (running) return;
      resetPreview();
      paintStep1();
    })
  );
  [linkSourceRoot, linkTargetRoot].forEach((input) =>
    input.addEventListener('input', () => {
      if (running) return;
      resetPreview();
      paintStep1();
    })
  );

  unsubPreview = api.onLinkPreviewProgress((payload) => {
    if (!payload || payload.gameId !== gameId || !previewing) return;
    currentJobId = payload.jobId || currentJobId;
    progress.style.display = 'block';
    const percent = payload.total > 0 ? Math.min(100, (payload.processed / payload.total) * 100) : 0;
    bar.style.width = `${percent}%`;
    phase.textContent = payload.phase === 'scan' ? '正在扫描两个目录…' : '正在比对文件内容…';
    count.textContent = payload.total > 0 ? `${payload.processed} / ${payload.total} 个候选` : '';
    saved.textContent = `已找到 ${payload.matchable || 0} 个可合并 · ${fmtBytes(payload.matchableBytes || 0)}`;
    current.textContent = payload.current || '';
  });

  /*
   * 后端约定：sourceRoot / targetRoot 要么同时给、要么同时不给。
   * 只给一个会被直接抛「自定义文件夹需要同时指定源目录和目标目录」，
   * 所以这里按 check.custom 统一决定传还是传空串。
   */
  function buildPayload(check) {
    return {
      gameId,
      sourceId: sourceSelect.value,
      targetId: targetSelect.value,
      mode: modeOf(),
      sourceRoot: check.custom ? check.sourceRoot : '',
      targetRoot: check.custom ? check.targetRoot : '',
    };
  }

  /* 第 2 步：只读检测，不改任何文件 */
  async function runPreview(check) {
    running = true;
    previewing = true;
    error.textContent = '';
    progress.style.display = 'block';
    bar.style.width = '0%';
    count.textContent = '';
    saved.textContent = '';
    current.textContent = '';
    phase.textContent = '正在准备…';
    cancelButton.style.display = '';
    cancelButton.disabled = false;
    startButton.disabled = true;
    startButton.textContent = '正在预检…';
    try {
      const result = await api.servers.linkPreview(buildPayload(check));
      currentJobId = result.jobId || currentJobId;
      if (result.cancelled) {
        phase.textContent = '已停止预检';
        startButton.disabled = false;
        startButton.textContent = '重新预检';
        return;
      }
      previewResult = result;
      renderPreview(result, modeOf());
      progress.style.display = 'none';
      if (!result.matchable) {
        startButton.disabled = true;
        startButton.textContent = '没有可合并的文件';
        error.textContent =
          '这两个目录里没有内容完全相同的文件：要么之前已经合并过，要么两边的文件都不一样。换一组目录再试。';
        return;
      }
      startButton.disabled = false;
      startButton.textContent = `开始合并（省 ${fmtBytes(result.matchableBytes || 0)}）`;
      toast(`预检完成：可合并 ${result.matchable} 个文件`, 'info');
    } catch (err) {
      // 后端的中文错误原样透出（同盘校验、启动程序不存在、目录相同……），不自己改写成模糊说法
      error.textContent = humanError(err);
      phase.textContent = '预检没完成';
      startButton.disabled = false;
      startButton.textContent = '重新预检';
    } finally {
      running = false;
      previewing = false;
      currentJobId = null;
      cancelButton.style.display = 'none';
    }
  }

  function showLinkResult(result, cancelled) {
    if (!resultBox) return;
    resultBox.hidden = false;
    resultBox.innerHTML = `
      <strong class="sw-result-title">${cancelled ? '已停止合并' : '合并完成'}</strong>
      <div class="sw-result-grid">
        <div class="sw-result-item"><span>合并文件</span><strong>${result.linked || 0} 个</strong></div>
        <div class="sw-result-item"><span>节省空间</span><strong>${fmtBytes(result.savedBytes || 0)}</strong></div>
        <div class="sw-result-item"><span>跳过</span><strong>${result.skipped || 0} 个</strong></div>
      </div>
      <p class="sw-result-note">检查了 ${result.total || 0} 个候选${
        result.errors && result.errors.length
          ? `；${result.errors.length} 个文件被占用或读取失败，已跳过`
          : ''
      }。${cancelled ? '已经合并的文件保持合并状态，不会回退。' : '两边的游戏存档和不同文件都没有改动。'}</p>`;
  }

  /* 第 3 步：真的建立硬链接 */
  async function runLink() {
    const check = checkDirs();
    if (!check.ok) {
      error.textContent = check.problem;
      return;
    }
    running = true;
    merged = false;
    error.textContent = '';
    progress.style.display = 'block';
    bar.style.width = '0%';
    count.textContent = '';
    saved.textContent = '';
    current.textContent = '';
    phase.textContent = '正在准备…';
    cancelButton.style.display = '';
    cancelButton.disabled = false;
    startButton.disabled = true;
    startButton.textContent = '正在合并…';
    try {
      const result = await api.servers.link(buildPayload(check));
      merged = true;
      showLinkResult(result, Boolean(result.cancelled));
      startButton.disabled = false;
      startButton.textContent = '完成';
      if (result.cancelled) {
        toast('已停止合并，已经合并的文件保持不变', 'info');
      } else {
        toast(`合并完成：${result.linked || 0} 个文件，省下 ${fmtBytes(result.savedBytes || 0)}`, 'success');
      }
    } catch (err) {
      error.textContent = humanError(err);
      phase.textContent = '合并没能完成';
      startButton.disabled = false;
      startButton.textContent = '重试合并';
    } finally {
      running = false;
      currentJobId = null;
      cancelButton.style.display = 'none';
      // 失败时保留「上一步」，让用户回去改目录或换客户端，而不是只剩一个重试按钮
      if (merged && backButton) backButton.style.display = 'none';
    }
  }

  startButton.addEventListener('click', async () => {
    if (step === 1) {
      const check = checkDirs();
      if (!check.ok) {
        error.textContent = check.problem;
        paintStep1();
        return;
      }
      error.textContent = '';
      rememberLinkRoots();
      previewResult = null;
      resetPreview();
      step = 2;
      paintStep();
      await runPreview(check);
      return;
    }
    if (step === 2) {
      if (running) return;
      const check = checkDirs();
      if (!check.ok) {
        error.textContent = check.problem;
        step = 1;
        paintStep();
        return;
      }
      if (!previewResult || !previewResult.matchable) {
        await runPreview(check);
        return;
      }
      step = 3;
      paintStep();
      await runLink();
      return;
    }
    if (step === 3) {
      if (running) return;
      // 失败后停在第三步，按钮是「重试合并」，别把它当成「完成」直接关窗
      if (!merged) {
        await runLink();
        return;
      }
      closeModal();
    }
  });

  if (backButton) {
    backButton.addEventListener('click', () => {
      if (running || merged) return;
      step = 1;
      error.textContent = '';
      progress.style.display = 'none';
      resetPreview();
      paintStep();
    });
  }

  cancelButton.addEventListener('click', async () => {
    if (!currentJobId) return;
    cancelButton.disabled = true;
    phase.textContent = '正在停止…';
    await api.servers.cancelLink(currentJobId).catch(() => {});
    cancelButton.disabled = false;
  });

  paintStep();
}

function openNewsModal(id) {
  const post = state.news.find((item) => item.id === id);
  if (!post) return;
  const body = (post.body || [])
    .map((line, index) => {
      if (line.startsWith('## ')) return `<h3>${esc(line.slice(3))}</h3>`;
      return `<p class="${index === 0 ? 'lead' : ''}">${esc(line)}</p>`;
    })
    .join('');
  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal article" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <div class="eyebrow" style="margin-bottom:8px">${esc(post.tag)}</div>
            <h2>${esc(post.title)}</h2>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="article-body">
          <div class="meta">
            <span>${formatDate(post.date)}</span>
            <span style="width:2px;height:2px;border-radius:50%;background:currentColor"></span>
            <span>${esc(post.readTime || '')}</span>
          </div>
          ${newsFigure(post)}
          ${body}
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
        </div>
      </div>
    </div>`;
  openModal(html);
}

/* ------------------------------------------------------------------ */
/* toasts & state subscription                                         */
/* ------------------------------------------------------------------ */

function toast(message, type = 'info') {
  if (!dom.toastRoot) return;
  // 后端偶尔会返回一个没有 error 字段的结果对象，直接 toast(undefined) 会弹一个空提示；
  // 这里兜底成一句能看懂的话，避免「点了没反应」。
  if (message === undefined || message === null || message === '') message = '操作失败，请重试';
  // 主进程抛回来的错误常带着「Error invoking remote method 'xxx': Error:」这层壳，
  // 直接弹出去就是一句英文开头的提示。这里统一剥掉，只留人话。
  if (type === 'error') message = humanError(message);
  playUiSound(type === 'error' ? 'error' : 'notify');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  const iconName = type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info';
  node.innerHTML = `${icon(iconName)}<span>${esc(message)}</span>`;
  dom.toastRoot.appendChild(node);
  window.setTimeout(() => {
    node.classList.add('leaving');
    window.setTimeout(() => node.remove(), 240);
  }, 4200);
}

function canPatchDownloads(previous, next) {
  return (
    state.route === 'downloads' &&
    previous.downloads.length === next.downloads.length &&
    previous.downloads.every(
      (item, index) =>
        next.downloads[index] &&
        item.id === next.downloads[index].id &&
        item.status === next.downloads[index].status
    )
  );
}

function patchDownloads() {
  for (const item of state.downloads) {
    const row = document.querySelector(`[data-dl-id="${item.id}"]`);
    if (!row) continue;
    const pct = item.total > 0 ? Math.min(100, (item.received / item.total) * 100) : 0;
    const bar = row.querySelector('.progress-bar');
    if (bar) {
      bar.classList.toggle('indeterminate', item.status === 'downloading' && !item.total);
      const fill = bar.querySelector('span');
      if (fill) fill.style.width = `${pct}%`;
    }
    const bytes = row.querySelector('[data-dl-bytes]');
    if (bytes) {
      bytes.textContent = `${fmtBytes(item.received)}${item.total ? ` / ${fmtBytes(item.total)}` : ''}`;
    }
    const speed = row.querySelector('[data-dl-speed]');
    if (speed && item.status === 'downloading') {
      const eta = etaText(item);
      speed.textContent = `${fmtSpeed(item.speed)}${eta ? ` · 剩余 ${eta}` : ''}`;
    }
  }
  const totalSpeed = activeDownloads().reduce((sum, item) => sum + (item.speed || 0), 0);
  const speedNode = document.querySelector('#dl-total-speed');
  if (speedNode) speedNode.textContent = fmtSpeed(totalSpeed);
}

function onState(next) {
  // 这里原来写的是 `data`，那个变量根本不存在，每次状态回推都会抛
  // ReferenceError，后面的 applySettings() 直接不执行——改设置时界面
  // 刷不动、主题还停在旧色，都是它先炸掉导致的。快照里的更新状态就叫 update。
  if (next && next.update) state.update = next.update;
  const previous = {
    downloads: state.downloads,
    games: state.games,
    settings: state.settings,
    stats: state.stats,
  };
  /*
   * charms / charBg 是渲染进程自己用的两个开关，主进程的设置白名单里没有这两个键，
   * 每次状态回推都会把它们抹掉——开关刚点下去就被刷回旧值，看着也像「点了不动」。
   * 覆盖 state.settings 之前先把这两个值捞回来。
   */
  const incomingSettings = keepRendererSettings(next.settings, state.settings);
  const gamesChanged = JSON.stringify(previous.games) !== JSON.stringify(next.games || []);
  const settingsChanged = JSON.stringify(previous.settings) !== JSON.stringify(incomingSettings);
  const statsChanged = JSON.stringify(previous.stats) !== JSON.stringify(next.stats || {});
  const structuralChanged = gamesChanged || settingsChanged || statsChanged;

  state.games = next.games || [];
  state.settings = incomingSettings;
  state.stats = next.stats || state.stats;
  state.nteAccount = next.nteAccount || null;
  state.downloads = next.downloads || [];
  state.app = next.app || state.app;
  applySettings();
  updateChrome();

  if (canPatchDownloads(previous, next)) {
    patchDownloads();
    return;
  }

  // 弹窗打开时先不重绘背景页面，避免添加游戏/保存资料时出现明显卡顿。
  // 下载进度最小化到任务条时不算弹窗，仍然允许切换页面。
  if (dom.modalRoot.childElementCount && !document.body.classList.contains('sophon-minimized')) return;

  // 只有下载进度变化时，不重绘其他页面，避免闪烁和打断输入。
  if (!structuralChanged && state.route !== 'downloads') return;

  /*
   * 开关是就地切状态的（见 paintSwitch）：点完之后主进程会回推一份内容相同的
   * 设置，这次重绘只会把刚跑起来的滑块动画掐断，内容一致就跳过它。
   */
  if (!gamesChanged && !statsChanged && consumeSettingsEcho(incomingSettings)) return;

  const focus = captureFocus();
  render({ preserveScroll: true });
  restoreFocus(focus);
}

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
  '.btn, .btn-primary, .btn-ghost, .btn-quiet, .btn-danger, .mini-chip, .chip, .segmented button, .fx-card, .tg-rail-item';

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


