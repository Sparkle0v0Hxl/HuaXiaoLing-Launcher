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
  // 游戏能力注册表（主进程 game-features.js 提供），tools 页据此渲染
  features: null,
  // 侧栏「工具」分组的展开状态
  navToolsOpen: false,
  hoyolab: null,
  // 鹰角 / 完美世界 / 库街区等通行证的登录态，key 是 provider id
  passport: null,
  // 截图管理：按游戏分组，组内按时间倒序
  shots: null,
  shotsLoading: false,
  shotsError: '',
  shotsGame: '',
  // 画质配置：读的是注册表，只读展示 + 备份后写回
  graphics: null,
  graphicsLoading: false,
  graphicsError: '',
  graphicsGame: 'starrail',
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
  gachaTab: 'overview',
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
  nteAutoPage: localStorage.getItem('vela:nte-auto-page') !== '0',
  songs: [],
  songIndex: 0,
  startGameId: '',
  startServerMenu: false,
  starrailFps: 60,
  notices: [],
  noticesGameId: '',
  noticesLoading: false,
  live: { connected: false, connecting: false, roomTitle: '', roomId: '', liveStatus: 0, status: '' },
  charts: { platform: 'all', loading: false, list: [], detail: null, error: '' },
  musicLogin: { qq: null, kugou: null, loading: false },
  neteaseLogin: { loggedIn: false, apiBase: '' },
  songTab: localStorage.getItem('vela:song-tab') || 'queue',
  // 点歌台搜索：无状态输入放在 input 里，结果只在内存
  songSearch: { keyword: '', platform: 'all', loading: false, list: [], errors: [], done: false },
  myPlaylists: { platform: '', loading: false, list: [], error: '', detail: null, groups: [], loadingAll: false },
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
};
let liveSocket = null;
let liveHeartbeat = null;
let liveBridgeTimer = null;

try {
  const savedSongs = JSON.parse(localStorage.getItem('vela:songs') || '[]');
  if (Array.isArray(savedSongs)) state.songs = savedSongs;
} catch {
  state.songs = [];
}

const PAGE_META = {
  home: { label: '主页', eyebrow: 'OVERVIEW' },
  start: { label: '开始', eyebrow: 'START' },
  library: { label: '游戏库', eyebrow: 'LIBRARY' },
  gacha: { label: '抽卡', eyebrow: 'WISHES' },
  downloads: { label: '下载', eyebrow: 'DOWNLOADS' },
  song: { label: '点歌台', eyebrow: 'KARAOKE' },
  news: { label: '动态', eyebrow: 'JOURNAL' },
  tools: { label: '工具', eyebrow: 'TOOLBOX' },
  record: { label: '战绩', eyebrow: 'RECORD' },
  screenshots: { label: '截图管理', eyebrow: 'GALLERY' },
  graphics: { label: '画质配置', eyebrow: 'GRAPHICS' },
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
  toast('当前音源不支持音效处理，已自动切回原声', 'info');
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

function setUpdateProgress(percent, label) {
  const wrap = document.querySelector('#update-modal-progress');
  if (!wrap) return;
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  if (value > 0) wrap.hidden = false;
  const bar = wrap.querySelector('.update-progress-bar span');
  const text = wrap.querySelector('small');
  if (bar) bar.style.width = `${value}%`;
  if (text) text.textContent = label || (value >= 100 ? '正在解压并覆盖文件…' : `正在下载 ${value}%`);
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
          <div><h2>音效</h2><p>给点歌台加上空间感、耳机定位或频段增强，随歌曲实时生效。</p></div>
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
          <p class="hint">音效需要浏览器支持 Web Audio。若某些直链不允许跨域读取，播放会没有声音，此时会自动切回原声并提示。</p>
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

function playUiSound(kind = 'click', force = false) {
  const settings = state.sound;
  if (!settings.enabled || (!settings[kind] && !force)) return;
  const volume = Math.max(0, Math.min(100, Number(settings.volume) || 0)) / 100;
  if (volume <= 0) return;
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    if (!uiSoundContext) uiSoundContext = new AudioCtor();
    if (uiSoundContext.state === 'suspended') uiSoundContext.resume().catch(() => {});
    const context = uiSoundContext;
    const now = context.currentTime + 0.005;
    const tone = (frequency, start, duration, endFrequency, level, type = 'sine') => {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (endFrequency) {
        oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
      }
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(level, start + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(envelope);
      envelope.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    };
    if (kind === 'notify') {
      tone(659.25, now, 0.2, 783.99, 0.014 + volume * 0.055, 'sine');
      tone(987.77, now + 0.1, 0.24, 880, 0.01 + volume * 0.04, 'sine');
    } else if (kind === 'launch') {
      tone(261.63, now, 0.3, 659.25, 0.012 + volume * 0.045, 'triangle');
      tone(523.25, now + 0.1, 0.36, 1046.5, 0.008 + volume * 0.035, 'sine');
    } else {
      tone(1046.5, now, 0.055, 740, 0.01 + volume * 0.035, 'sine');
    }
  } catch {
    /* audio feedback is optional */
  }
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
    state.settings = saved.settings;
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

function navigate(route, options = {}) {
  if (route === 'library') route = 'home';
  if (!PAGE_META[route]) route = 'home';
  const changed = route !== state.route;
  state.route = route;
  if (!document.body.classList.contains('sophon-minimized')) closeModal();
  render({ preserveScroll: false });
  if (route !== 'gacha') stopGachaRefresh();
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
      if (state.route === 'tools') render({ preserveScroll: true });
    });
  }
  if (route === 'tools') {
    // 顺带刷一次米游社登录态，拿到角色后重绘
    refreshHoyolabStatus('miyoushe').then(() => {
      if (state.route === 'tools') render({ preserveScroll: true });
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
      if (state.route === 'tools') render({ preserveScroll: true });
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

function render(options = {}) {
  if (!state.games.length && !state.app.version) return;
  document.body.classList.toggle('start-mode', state.route === 'start');
  if (state.route !== 'start' && state.startServerMenu) state.startServerMenu = false;
  applySettings();
  updateChrome();
  const scroll = dom.view.scrollTop;
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
  const videoMemo = memoStartVideo();
  const prevArt = dom.view.querySelector(`.start-screen ${START_ART_LIVE}`);
  dom.view.innerHTML = view ? view() : homeView();
  handoffStartArt(prevArt);
  if (options.preserveScroll) dom.view.scrollTop = scroll;
  else dom.view.scrollTop = 0;
  const nextLyricBox = dom.view.querySelector('#song-lyrics');
  if (nextLyricBox && lyricScroll) nextLyricBox.scrollTop = lyricScroll;
  bindView();
  restoreStartVideo(videoMemo);
  bindStartArtVideo();
  setupStartDrawerSync();
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
      <div class="hero-sparxie" aria-hidden="true"><img src="assets/sparxie.png" alt="" draggable="false" /></div>
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
          <button class="btn btn-glass hero-start-btn" data-nav="start">
            ${icon('play')}启动页
          </button>
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
        <button class="chrome-btn chrome-back" data-action="back-home" title="返回主界面（Esc）" aria-label="返回主界面">${icon('chevron-left')}</button>
        <div class="start-brand">
          <img class="start-brand-mark" src="assets/character-face.png" alt="" aria-hidden="true" />
          <span>花筱灵启动器</span>
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
        <div class="start-game-list">
          ${ordered
            .map(
              (game) => `
              <button class="start-game-thumb ${game.id === selected.id ? 'active' : ''}" data-action="start-select" data-id="${esc(game.id)}" title="${esc(game.name)}">
                <span class="start-game-media">
                  ${game.coverUrl ? `<img src="${esc(game.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover />` : `<span class="start-game-initial">${esc(initial(game.name))}</span>`}
                </span>
                <span class="start-game-copy">
                  <strong>${esc(game.name)}</strong>
                  ${game.running ? '<small>运行中</small>' : ''}
                </span>
                <span class="start-game-state ${game.running ? 'is-running' : game.installed ? 'is-ready' : ''}"></span>
              </button>`
            )
            .join('')}
        </div>
      </div>
      <button class="start-menu-scrim" data-action="start-server-menu" aria-label="关闭服务器选择"></button>
      ${startServerPanel(selected)}
    </div>`;
}

/**
 * 启动页的服务器面板：把「服务器」页的全部能力压进一行。
 *
 * - 点服务器胶囊 = 切换并启动
 * - 胶囊右侧小齿轮 = 只切换不启动
 * - 「管理」打开完整面板，重建 / 编辑 / 目录 / 清除 / 移除都在里面
 */
/**
 * 启动页的服务器选择器：参考 Starward 的做法，只保留「当前服务器」一行，
 * 点开才展开完整列表；切换、检测、硬链接、管理都在弹层里完成。
 */
/* 服务器面板是纯 DOM 开合，离开/切换时要主动把类名摘掉，否则下次进来是展开态。 */
function closeStartServerMenu() {
  state.startServerMenu = false;
  document.querySelector('.start-dock')?.classList.remove('is-menu-open');
  document.querySelector('.start-screen')?.classList.remove('dock-open');
}

function startServerPanel(game) {
  const servers = game.servers || [];
  const active =
    servers.find((server) => server.id === game.activeServerId) || servers[0] || null;
  const status = active ? serverState(active) : null;
  const fileName = active && active.path ? active.path.split(/[\\/]/).pop() : '';
  const ready = servers.filter((server) => server.exists && !server.incomplete).length;
  const open = Boolean(state.startServerMenu);

  const items = servers
    .map((server) => {
      const state_ = serverState(server);
      const file = server.path ? server.path.split(/[\\/]/).pop() : '';
      return `
        <button class="start-server-item ${server.active ? 'is-active' : ''} ${server.incomplete ? 'is-broken' : ''}"
          role="option" aria-selected="${server.active ? 'true' : 'false'}"
          data-action="start-server-pick" data-game="${esc(game.id)}" data-server="${esc(server.id)}"
          title="${esc(server.path || server.packPath || server.name)}">
          <span class="start-server-item-dot ${state_.cls}"></span>
          <span class="start-server-item-copy">
            <strong>${esc(server.name)}</strong>
            <small>${esc(file || state_.label)}</small>
          </span>
          ${server.active ? `<span class="start-server-item-tick">${icon('check')}</span>` : ''}
        </button>`;
    })
    .join('');

  return `
    <div class="start-dock${open ? ' is-menu-open' : ''}">
      <div class="start-dock-server-head">
        <span class="start-dock-label">服务器 <em>${ready} / ${servers.length}</em></span>
        <button class="start-dock-icon" data-action="start-server-manage" data-game="${esc(game.id)}" title="管理服务器、硬链接、自动检测">${icon('settings')}</button>
      </div>
      <button class="start-server-pick" data-action="start-server-menu" aria-expanded="${open ? 'true' : 'false'}" title="切换服务器">
        <span class="start-server-pick-dot ${status ? status.cls : 'missing'}"></span>
        <span class="start-server-pick-copy">
          <strong>${esc(active ? active.name : '未配置服务器')}</strong>
          <small>${esc(fileName || (status ? status.label : '还没有可用客户端'))}</small>
        </span>
        <span class="start-server-pick-caret">${icon('chevron-down')}</span>
      </button>
      <div class="start-server-menu" role="listbox" aria-label="服务器列表">
              ${items || '<p class="start-server-empty">还没有服务器</p>'}
              <div class="start-server-menu-foot">
                <button class="start-server-foot-btn" data-action="start-detect" data-game="${esc(game.id)}">${icon('refresh')}检测</button>
                <button class="start-server-foot-btn" data-action="start-link" data-game="${esc(game.id)}">${icon('link')}硬链接</button>
                <button class="start-server-foot-btn" data-action="start-server-manage" data-game="${esc(game.id)}">${icon('settings')}管理</button>
              </div>
            </div>
      <button class="start-dock-play" data-action="${game.installed ? 'start-selected' : game.builtin ? 'detect-game' : 'edit-game'}" data-id="${esc(game.id)}">
        ${icon(game.installed ? 'play' : game.builtin ? 'refresh' : 'wrench')}
        <span>${game.installed ? '开始游戏' : game.builtin ? '检测安装' : '配置游戏'}</span>
      </button>
    </div>`;
}

/** 完整的服务器管理面板：复用 servers 页的每一行操作。 */
function openStartServerManager(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;
  const servers = game.servers || [];
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>管理服务器 · ${esc(game.name)}</h2>
            <p>切换、重建、编辑目录、清除路径都在这里；操作完成会直接回到启动页。</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="server-manager-actions">
            <button class="btn btn-ghost btn-sm" data-action="start-detect" data-game="${esc(game.id)}">${icon('refresh')}自动检测</button>
            <button class="btn btn-ghost btn-sm" data-action="start-link" data-game="${esc(game.id)}">${icon('link')}硬链接去重</button>
            ${game.builtin ? '' : `<button class="btn btn-ghost btn-sm" data-action="add-server" data-game="${esc(game.id)}">${icon('plus')}添加服务器</button>`}
          </div>
          <div class="server-list">${servers.map((server) => serverRow(game, server)).join('') || '<p class="gacha-empty-line">还没有服务器</p>'}</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
          <button class="btn btn-primary" data-action="start-server-done" data-game="${esc(game.id)}">完成</button>
        </div>
      </div>
    </div>
  `);
}

/** 让暂停按钮的图标和文案跟着视频状态走。 */
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
 * 这两张卡不是纯摆设：花火盯着游戏（最近在玩 + 累计时长，点一下直接开那个游戏），
 * 火花盯着点歌台（正在播放 / 队列，点一下进点歌台）。数据都取自本机现有状态。
 *
 * 位置：homeView() 里放在最新动态之后（主页最底部），平时只露立绘，hover 才展开。
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

  const gameStat = recent
    ? `${recent.name}`
    : '还没有开过场';
  const gameSub = recent
    ? `累计 ${formatPlaytime(totalSeconds)} · 点一下接着演`
    : '在游戏库里挑一个开场吧';

  const songStat = song ? songTitle || '未知曲目' : '点歌台空着';
  const songSub = song
    ? `${playing ? '正在播放' : '已暂停'}${songArtist ? ' · ' + songArtist : ''} · 队列 ${queue} 首`
    : `队列 ${queue} 首 · 点一下去点歌`;

  return `
    <div class="char-duo">
      <button type="button" class="char-duo-card is-sparkle" data-action="duo-game"${
        recent ? ` data-game="${esc(recent.id)}"` : ''
      }>
        <img src="assets/sparkle.png" alt="花火" />
        <div class="char-duo-copy">
          <strong>花火</strong>
          <em>假面愚者。把每一场演出都当成即兴，后台的灯从不为她熄灭。</em>
          <span class="char-duo-stat"><b>${esc(gameStat)}</b><i>${esc(gameSub)}</i></span>
        </div>
      </button>
      <button type="button" class="char-duo-card is-sparxie" data-action="duo-song">
        <img src="assets/sparxie.png" alt="火花" />
        <div class="char-duo-copy">
          <strong>火花</strong>
          <em>烟花一响，后台就热闹起来。花花兔和火火菇也跟着上场。</em>
          <span class="char-duo-stat"><b>${esc(songStat)}</b><i>${esc(songSub)}</i></span>
        </div>
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
  const maxSeconds = Math.max(1, ...ordered.map((game) => game.playSeconds || 0));
  return `
    <section class="home-stats" id="home-stats">
      <div class="section-head">
        <div><h3>游玩统计</h3><p>每款游戏的本机累计时长，退出游戏后自动结算。</p></div>
        <span class="home-stats-note">${total ? `共 ${formatPlaytime(total)}` : '启动游戏后开始累计'}</span>
      </div>
      <div class="playtime-summary">
        <div class="playtime-total">
          <span>累计游玩</span>
          <strong>${formatPlaytime(total)}</strong>
          <small>${launchedLabel(launches)} · ${ordered.length} 款游戏</small>
        </div>
        <div class="playtime-kpi"><strong>${launches}</strong><span>总启动次数</span></div>
        <div class="playtime-kpi"><strong>${ordered.filter((game) => (game.playSeconds || 0) > 0).length}</strong><span>已游玩游戏</span></div>
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
    </section>`;
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
      <div class="page">
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
    <div class="page">
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
      <div class="section-head">
        <div><h3>最新动态</h3><p>使用指南、功能说明与一些想法</p></div>
        <button class="link-btn" data-nav="news">全部动态 ${icon('chevron-right')}</button>
      </div>
      <div class="news-grid">${state.news.slice(0, 3).map(newsCard).join('')}</div>
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
      <div class="section-head">
        <div>
          <h3>游戏库</h3>
          <p>所有游戏都在这里，添加、检测、整理封面和启动路径。</p>
        </div>
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
  if (server.exists) return { label: '已就绪', cls: 'ready' };
  return { label: '未配置', cls: 'missing' };
}

function serverRow(game, server) {
  const status = serverState(server);
  const usable = server.exists && !server.incomplete;
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
  return `
    <article class="server-tile ${server.active ? 'is-active' : ''}">
      <div class="server-tile-head">
        <span class="server-orb">${server.active ? icon('check') : ''}</span>
        <div class="server-tile-copy">
          <div class="server-name">
            ${esc(server.name)}
            ${server.active ? '<span class="server-badge">当前</span>' : ''}
            ${server.runtimeLinked ? '<span class="server-badge">差异运行时</span>' : ''}
          </div>
          <div class="server-path" title="${esc(server.path || server.packPath || '')}">${esc(
            server.incomplete
              ? '尚未生成完整客户端'
              : fileName || '未选择客户端'
          )}</div>
        </div>
        <span class="server-state ${status.cls}">${status.label}</span>
      </div>
      <div class="server-tile-actions">
        <button class="btn ${server.active ? 'btn-primary' : 'btn-ghost'} btn-sm server-primary" data-action="${primaryAction}" data-id="${esc(game.id)}" data-game="${esc(game.id)}" data-server="${esc(server.id)}">
          ${icon(usable ? 'play' : 'refresh')}${primaryLabel}
        </button>
        ${
          canUpdateSophon
            ? `<button class="btn-icon btn-ghost" data-action="update-sophon" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="检查官方更新">${icon('refresh')}</button>`
            : ''
        }
        ${
          canPrepare
            ? `<button class="btn-icon btn-ghost" data-action="prepare-endfield" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="重新生成运行时">${icon('link')}</button>`
            : ''
        }
        <button class="btn-icon btn-ghost" data-action="edit-server" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="编辑服务器">${icon('edit')}</button>
        ${
          usable
            ? `<button class="btn-icon btn-ghost" data-action="open-server-folder" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="打开安装目录">${icon('folder-open')}</button>`
            : ''
        }
        ${
          server.builtinServer || (game.builtin && server.channel)
            ? `<button class="btn-icon btn-ghost danger" data-action="clear-server-path" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="只清除路径，保留服务器">${icon('trash')}</button>`
            : (game.servers || []).length > 1
              ? `<button class="btn-icon btn-ghost danger" data-action="remove-server" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="移除这个服务器">${icon('trash')}</button>`
              : ''
        }
      </div>
    </article>`;
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

function saveSongs() {
  try {
    localStorage.setItem('vela:songs', JSON.stringify(state.songs.slice(0, 200)));
  } catch {
    /* local persistence is optional */
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
    audio.currentTime = 0;
    updateSongChrome();
    toast('歌单已经播放完毕', 'info');
    return;
  }
  const next =
    state.playMode === 'shuffle' ? randomSongIndex() : (state.songIndex + 1) % state.songs.length;
  await playSongAt(next, { skipRender: state.route !== 'song' });
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
  if (!audio || !song?.url) return;
  const key = `${state.songIndex}:${song.url}`;
  if (audio.dataset.songKey !== key) {
    audio.dataset.songKey = key;
    audio.src = song.url;
    audio.load();
  }
  if (toggle && !audio.paused) {
    audio.pause();
    clearFxWatchdog();
    updateSongChrome();
    return;
  }
  if (state.audioFx.preset !== 'off' && !audioFxFallback) {
    applyAudioFx();
    armFxWatchdog(audio);
  }
  audio.play().catch(() => {});
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
      const origin = miniExpandOrigin || { x: before.left, y: before.top };
      const position = clampMiniPosition(mini, origin.x, origin.y);
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
  if (!drawer || !mini || drawer.dataset.syncBound === '1') return;
  drawer.dataset.syncBound = '1';
  const sync = () => {
    const open = drawer.matches(':hover') || drawer.matches(':focus-within');
    mini.classList.toggle('drawer-open', open);
    // 展开形态已挪到 body 固定定位，别在抽屉 hover 时把它拽回槽里
    if (mini.classList.contains('is-on-start') && !isMiniExpanded()) positionStartMini(mini);
  };
  drawer.addEventListener('mouseenter', sync);
  drawer.addEventListener('mouseleave', sync);
  drawer.addEventListener('focusin', sync);
  drawer.addEventListener('focusout', () => setTimeout(sync, 60));
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
      if (!isMiniExpanded()) {
        positionStartMini(mini);
      }
    } else {
      unmountStartMini(mini);
      // 离开启动页：之前记录的原位收起锚点是启动页槽里的坐标，不能再用于主页
      miniExpandOrigin = null;
      delete mini.dataset.draggedSinceExpand;
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
    if (artist) artist.textContent = song.artist || '点歌台';
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
    if (chipArtist) chipArtist.textContent = song.artist || '点歌台';
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
  if (!song || !song.neteaseId) return;
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
}

function biliPacket(value, operation = 7) {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const buffer = new ArrayBuffer(16 + body.length);
  const view = new DataView(buffer);
  view.setUint32(0, 16 + body.length);
  view.setUint16(4, 16);
  view.setUint16(6, 1);
  view.setUint32(8, operation);
  view.setUint32(12, 1);
  new Uint8Array(buffer, 16).set(body);
  return buffer;
}

async function decodeBiliFrame(data) {
  let buffer = data;
  if (buffer instanceof Blob) buffer = await buffer.arrayBuffer();
  if (!(buffer instanceof ArrayBuffer)) return;
  const view = new DataView(buffer);
  let offset = 0;
  while (offset + 16 <= view.byteLength) {
    const total = view.getUint32(offset);
    const header = view.getUint16(offset + 4);
    const version = view.getUint16(offset + 6);
    const operation = view.getUint32(offset + 8);
    if (!total || total > view.byteLength - offset) break;
    const body = buffer.slice(offset + header, offset + total);
    if (operation === 5) {
      if (version === 2 || version === 3) {
        try {
          const stream = new DecompressionStream('deflate');
          const writer = stream.writable.getWriter();
          writer.write(new Uint8Array(body));
          writer.close();
          const inflated = await new Response(stream.readable).arrayBuffer();
          await decodeBiliFrame(inflated);
        } catch {
          /* ignore a malformed compressed frame */
        }
      } else {
        try {
          const text = new TextDecoder().decode(body);
          const json = JSON.parse(text);
          const items = Array.isArray(json) ? json : [json];
          for (const item of items) {
            if (String(item?.cmd || '').includes('DANMU_MSG')) {
              const message = String(item.info?.[1] || '');
              const user = String(item.info?.[2]?.[1] || '');
              handleLiveDanmaku(message, user);
            }
          }
        } catch {
          /* non-JSON packet */
        }
      }
    }
    offset += total;
  }
}

function disconnectBiliLive() {
  if (liveHeartbeat) clearInterval(liveHeartbeat);
  liveHeartbeat = null;
  if (liveBridgeTimer) clearInterval(liveBridgeTimer);
  liveBridgeTimer = null;
  try {
    if (state.live?.danmaku === 'bridge') api.live.danmakuStop();
  } catch {
    /* 主进程没起来时忽略 */
  }
  if (liveSocket) {
    try {
      liveSocket.close();
    } catch {
      /* ignore */
    }
  }
  liveSocket = null;
  state.live = { connected: false, connecting: false, roomTitle: '', roomId: '', liveStatus: 0, status: '' };
  if (state.route === 'song') render({ preserveScroll: true });
}

/**
 * 连接直播间。
 *
 * B站：直接建 WebSocket 收弹幕并自动点歌。
 * 斗鱼 / 虎牙 / 抖音：目前只能解析房间信息（弹幕要私有签名），
 * 连接后会在界面里明确提示「仅显示状态」，不会假装能收弹幕。
 */
async function connectLiveRoom(rawUrl) {
  // 换房间/重连前先把上一条链路（B站 WebSocket 或其它平台的隐藏窗口）关干净
  disconnectBiliLive();
  state.live = {
    connected: false,
    connecting: true,
    roomUrl: rawUrl,
    roomTitle: '',
    roomId: '',
    platform: '',
    platformLabel: '',
    danmaku: "",
    note: '',
    liveStatus: 0,
    status: '连接直播间…',
  };
  render({ preserveScroll: true });
  try {
    const room = await api.live.room(rawUrl);
    state.live.platform = room.platform || "";
    state.live.platformLabel = room.platformLabel || "";
    state.live.roomId = room.roomId;
    state.live.roomTitle = room.title || `房间 ${room.roomId}`;
    state.live.liveStatus = room.liveStatus || 0;
    state.live.danmaku = room.danmaku || "";
    state.live.note = room.note || "";

    // B 站走官方 WebSocket（更准更省）；其它平台走隐藏窗口抓聊天区
    if (room.platform !== "bilibili") {
      await startBridgeLive(room, rawUrl);
      return;
    }

    const socket = new WebSocket('wss://broadcastlv.chat.bilibili.com/sub');
    liveSocket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      socket.send(
        biliPacket({
          uid: 0,
          roomid: Number(room.roomId),
          protover: 2,
          platform: 'web',
          type: 2,
        })
      );
      liveHeartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(biliPacket({}, 2));
      }, 30000);
      state.live.connected = true;
      state.live.connecting = false;
      state.live.status = '已连接';
      toast(`已连接直播间：${state.live.roomTitle}`, "success");
      if (state.route === "song") render({ preserveScroll: true });
    });
    socket.addEventListener('message', (event) => decodeBiliFrame(event.data));
    socket.addEventListener('error', () => {
      state.live.connecting = false;
      state.live.status = '连接失败';
      if (state.route === "song") render({ preserveScroll: true });
    });
    socket.addEventListener('close', () => {
      if (liveHeartbeat) clearInterval(liveHeartbeat);
      liveHeartbeat = null;
      state.live.connected = false;
      state.live.connecting = false;
      state.live.status = '已断开';
      if (state.route === "song") render({ preserveScroll: true });
    });
  } catch (error) {
    state.live.connecting = false;
    state.live.status = error.message;
    toast(`直播间连接失败：${error.message}`, "error");
    if (state.route === "song") render({ preserveScroll: true });
  }
}

/**
 * 斗鱼 / 虎牙 / 抖音 / 快手：后台隐藏窗口抓聊天区。
 *
 * 这几个平台没有公开弹幕协议（斗鱼 TCP、虎牙 Tars、抖音/快手要签名），
 * 硬啃私有协议平台一改版就废。这里让主进程开一个隐藏窗口真的把直播间网页
 * 加载出来，只读聊天区的文字；视频流在请求阶段就被拦掉，不会真的把流拉下来。
 * 页面结构变了抓不到时，状态栏会如实说明，不会假装已连接。
 */
async function startBridgeLive(room, rawUrl) {
  const label = room.platformLabel || '该平台';
  try {
    const started = await api.live.danmakuStart({ url: rawUrl, platform: room.platform });
    state.live.connected = true;
    state.live.connecting = false;
    state.live.danmaku = 'bridge';
    state.live.status = started?.status || '已连接';
    if (started?.pageTitle && !room.title) state.live.roomTitle = started.pageTitle;
    toast(`已连接${label}直播间：${state.live.roomTitle}`, 'success');
    if (state.route === 'song') render({ preserveScroll: true });

    if (liveBridgeTimer) clearInterval(liveBridgeTimer);
    liveBridgeTimer = setInterval(async () => {
      let payload = null;
      try {
        payload = await api.live.danmakuPoll();
      } catch {
        return;
      }
      if (!payload) return;
      if (payload.status && payload.status !== state.live.status) {
        state.live.status = payload.status;
        if (state.route === 'song') render({ preserveScroll: true });
      }
      if (!payload.alive) {
        if (liveBridgeTimer) clearInterval(liveBridgeTimer);
        liveBridgeTimer = null;
        state.live.connected = false;
        state.live.status = payload.status || '已断开';
        if (state.route === 'song') render({ preserveScroll: true });
        return;
      }
      for (const item of payload.messages || []) {
        handleLiveDanmaku(item.text, item.user);
      }
    }, 900);
  } catch (error) {
    state.live.connected = false;
    state.live.connecting = false;
    state.live.status = `${label}弹幕连接失败`;
    // 起窗口过程中失败时别把隐藏窗口留成孤儿
    try {
      api.live.danmakuStop();
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
  const label = platform === 'netease' ? '网易云' : platform === 'qq' ? 'QQ 音乐' : '酷狗';
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

/**
 * 一次性拉取所有已登录平台的歌单。
 * 用 loadingAll 防重入，避免每帧 render 都触发请求。
 */
async function loadAllPlaylists(force = false) {
  const logged = ['netease', 'qq', 'kugou'].filter(musicLoggedIn);
  if (!logged.length) return;
  if (state.myPlaylists.loadingAll) return;
  if (!force && state.myPlaylists.groups?.length) return;

  state.myPlaylists.loadingAll = true;
  if (state.route === 'song') render({ preserveScroll: true });
  /*
   * 兜底：主进程那边每一步都有超时，但万一整条 IPC 卡死（比如内置窗口
   * 被系统挂起），界面就会一直停在「正在读取」。这里放一个上限，
   * 到点自己收尾，至少让用户看到「读取超时」而不是无限转圈。
   */
  const guard = setTimeout(() => {
    if (!state.myPlaylists.loadingAll) return;
    state.myPlaylists.loadingAll = false;
    state.myPlaylists.groups = logged.map((key) => ({
      platform: key,
      label: key === 'netease' ? '网易云' : key === 'qq' ? 'QQ 音乐' : '酷狗',
      ok: false,
      list: [],
      error: '读取超时了，稍后再点一次刷新',
    }));
    if (state.route === 'song') render({ preserveScroll: true });
  }, 75000);
  try {
    const result = await api.musicAllPlaylists();
    state.myPlaylists.groups = Array.isArray(result?.groups) ? result.groups : [];
  } catch (error) {
    // 整体失败时，把错误摊到每个平台上，至少能看出为什么
    state.myPlaylists.groups = logged.map((key) => ({
      platform: key,
      label: key === 'netease' ? '网易云' : key === 'qq' ? 'QQ 音乐' : '酷狗',
      ok: false,
      list: [],
      error: humanError(error),
    }));
  } finally {
    clearTimeout(guard);
    state.myPlaylists.loadingAll = false;
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

/**
 * 渲染期间确保所有平台的歌单已经有着落。
 */
function ensureAllPlaylistsLoaded() {
  const logged = ['netease', 'qq', 'kugou'].filter(musicLoggedIn);
  if (!logged.length) return;
  if (state.myPlaylists.loadingAll) return;
  if (state.myPlaylists.groups?.length) return;
  loadAllPlaylists();
}

/**
 * 切账号 / 退出登录后，已有的歌单缓存就过期了，清掉重新拉。
 */
function invalidateAllPlaylists() {
  state.myPlaylists.groups = [];
  state.myPlaylists.loadingAll = false;
}

/** 打开某个自建歌单的曲目。 */
async function openMyPlaylist(platform, playlistId) {
  if (!platform || !playlistId) return;
  state.myPlaylists.loading = true;
  state.myPlaylists.detail = { id: playlistId, platform, loading: true };
  render({ preserveScroll: true });
  try {
    const result = await api.musicPlaylistSongs({ platform, playlistId });
    if (result?.ok) {
      // platform 放在展开之后，保证分区高亮一定认得出来是哪个平台的歌单
      state.myPlaylists.detail = { ...result.detail, id: playlistId, platform };
      state.myPlaylists.error = '';
    } else {
      state.myPlaylists.detail = null;
      state.myPlaylists.error = result?.reason || '读取歌单失败';
    }
  } catch (error) {
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
      loading: false,
    };
  } catch {
    state.musicLogin = { netease: null, qq: null, kugou: null, loading: false };
  }
  /**
   * 登录状态一变，「我的歌单」的缓存就可能不对了：
   * 换了账号要重拉，新登录一个平台要补上这个平台。
   * 这里统一清缓存，界面渲染时 ensureAllPlaylistsLoaded 会自己重拉。
   */
  invalidateAllPlaylists();
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
    const result = await api.musicResolve({
      song: {
        title: song.title,
        artist: song.artist,
        cover: song.cover,
        mid: song.mid,
        hash: song.hash,
      },
      apiBase,
      level: state.songQuality,
    });
    if (!result?.ok || !result.url) {
      if (!options.silent) {
        toast(`「${song.title || '这首'}」暂时找不到可播放版本`, 'info');
      }
      return false;
    }
    state.songs.push({
      title: result.title || song.title,
      artist: result.artist || song.artist,
      cover: result.cover || song.cover || '',
      neteaseId: result.neteaseId,
      quality: result.level || state.songQuality,
      url: result.url,
    });
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

async function handleLiveDanmaku(message, user) {
  const match = String(message || '').match(/^\s*点歌\s*(.+)$/);
  if (!match || liveRequestBusy) return;
  const keyword = match[1].trim().slice(0, 60);
  if (!keyword) return;
  liveRequestBusy = true;
  try {
    const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
    await api.netease.startService(apiBase).catch(() => {});
    const song = await api.netease.searchSong({ apiBase, keyword, level: state.songQuality });
    state.songs.push(song);
    if (!state.songs[state.songIndex] || !state.songIndex) state.songIndex = state.songs.length - 1;
    saveSongs();
    toast(`${user || '观众'} 点歌：${song.title}`, 'success');
    if (state.route === 'song') render({ preserveScroll: true });
  } catch (error) {
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

function songView() {
  return songViewMarkup();
}

/* ── 我的歌单：按平台分区，登录统一走「音乐账号」面板 ─────────────── */

const MUSIC_PLATFORM_LABELS = { netease: '网易云', qq: 'QQ 音乐', kugou: '酷狗' };

function musicPlatformLabel(platform) {
  return MUSIC_PLATFORM_LABELS[platform] || '音乐';
}

/** 一张歌单卡片：封面 + 名字 + 曲目数。 */
function playlistCardMarkup(item, platform, active) {
  const cover = item.cover
    ? `<img src="${esc(item.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : icon('music');
  return `
    <button class="playlist-card ${active ? 'is-open' : ''}"
      data-action="my-playlist-open" data-platform="${esc(platform)}" data-id="${esc(item.id)}"
      title="${esc(item.name)}">
      <span class="playlist-card-cover">${cover}
        <span class="playlist-card-count">${item.count ? `${item.count} 首` : '歌单'}</span>
      </span>
      <span class="playlist-card-name">${esc(item.name)}</span>
      <span class="playlist-card-sub">${item.subscribed ? '收藏歌单' : '自建歌单'}</span>
    </button>`;
}

/** 展开的某张歌单：曲目列表 + 一键入队。 */
function playlistDetailMarkup(detail, platform) {
  if (!detail) return '';
  if (detail.loading) {
    return `<div class="playlist-detail"><p class="playlists-group-note">正在读取曲目…</p></div>`;
  }
  const songs = detail.songs || [];
  return `
    <div class="playlist-detail">
      <div class="playlist-detail-head">
        <div class="playlist-detail-title">
          <strong>${esc(detail.name || '歌单')}</strong>
          <small>${songs.length} 首 · ${esc(musicPlatformLabel(platform))}</small>
        </div>
        <div class="playlist-detail-actions">
          <button class="playlists-chip is-primary" data-action="my-playlist-import" data-platform="${esc(platform)}" ${songs.length ? '' : 'disabled'}>${icon('plus', 'xs')}加入点歌队列</button>
          <button class="playlists-chip" data-action="my-playlist-close">${icon('x', 'xs')}收起</button>
        </div>
      </div>
      ${
        songs.length
          ? `<div class="playlist-songs">
              ${songs
                .slice(0, 30)
                .map(
                  (song, index) => `
                <button class="song-chart-song" data-action="my-playlist-song" data-platform="${esc(platform)}" data-index="${index}" title="加入点歌队列">
                  <span class="song-chart-index">${index + 1}</span>
                  <span class="song-chart-cover">${song.cover ? `<img src="${esc(song.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : icon('music')}</span>
                  <span class="song-chart-copy">
                    <strong>${esc(song.title)}</strong>
                    <small>${esc(song.artist || '未知歌手')}</small>
                  </span>
                  ${icon('plus', 'xs')}
                </button>`
                )
                .join('')}
            </div>`
          : `<p class="playlists-group-note">这个歌单里没有读到曲目。</p>`
      }
    </div>`;
}

/** 单个平台分区。 */
function myPlaylistGroupMarkup(group) {
  const { platform, list = [], error = '', loading = false } = group;
  const label = group.label || musicPlatformLabel(platform);
  const detail = state.myPlaylists.detail;
  const openDetail = detail && detail.platform === platform ? detail : null;

  const head = `<div class="playlists-group-head">
      <span class="playlists-group-name"><span class="mp-dot" data-platform="${esc(platform)}"></span>${esc(label)}</span>
      <span class="playlists-group-meta">${loading ? '同步中…' : error ? (group.expired ? '登录失效' : '读取失败') : `${list.length} 个歌单`}</span>
    </div>`;

  if (loading) {
    return `<section class="playlists-group">${head}<p class="playlists-group-note">正在读取 ${esc(label)} 账号里的歌单…</p></section>`;
  }
  if (error) {
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
              <button class="playlists-chip" data-action="my-playlists-reload" data-platform="${esc(platform)}">${icon('refresh', 'xs')}再试一次</button>
            </div>`
          : `<button class="playlists-chip" data-action="my-playlists-reload" data-platform="${esc(platform)}">${icon('refresh', 'xs')}重新读取</button>`
      }
      ${expired ? `<details class="playlists-group-detail"><summary>看看具体原因</summary><p>${esc(error)}</p></details>` : ''}
    </section>`;
  }
  if (!list.length) {
    return `<section class="playlists-group">${head}<p class="playlists-group-note">这个账号下还没有歌单。</p></section>`;
  }

  return `<section class="playlists-group">${head}
    <div class="playlist-cards">
      ${list.map((item) => playlistCardMarkup(item, platform, openDetail?.id === item.id)).join('')}
    </div>
    ${playlistDetailMarkup(openDetail, platform)}
  </section>`;
}

/**
 * 「我的歌单」总面板：三个已登录平台的歌单一起列。
 *
 * 登录入口只在右上角「账号」这一处（和「音乐账号」弹窗是同一个），
 * 不再在每个平台旁边各放一套「扫码登录」，避免和账号面板重复。
 */
function allPlaylistsMarkup() {
  const groups = state.myPlaylists.groups || [];
  const logged = ['netease', 'qq', 'kugou'].filter(musicLoggedIn);

  if (!logged.length) {
    return `<div class="song-empty">${icon('login')}<strong>还没有登录音乐账号</strong><span>登录后这里会按平台列出你账号里的歌单，整张歌单也能一键加入点歌队列。</span>
      <button class="btn btn-primary btn-sm" data-action="music-accounts">${icon('login')}打开音乐账号</button></div>`;
  }

  const shown = logged.map((key) => {
    const found = groups.find((group) => group.platform === key);
    if (found) return found;
    return { platform: key, label: musicPlatformLabel(key), list: [], error: '', loading: true };
  });
  const total = shown.reduce((sum, group) => sum + (group.list || []).length, 0);
  const syncing = Boolean(state.myPlaylists.loadingAll) || shown.some((group) => group.loading);
  const idle = ['netease', 'qq', 'kugou'].filter((key) => !logged.includes(key));

  return `<div class="playlists-panel">
    <div class="playlists-bar">
      <div class="playlists-bar-title">
        <strong>我的歌单</strong>
        <span>${shown.length} 个平台 · ${syncing ? '同步中…' : `${total} 个歌单`}</span>
      </div>
      <div class="playlists-bar-actions">
        <button class="playlists-chip" data-action="my-playlists-reload" ${syncing ? 'disabled' : ''}>${icon('refresh', 'xs')}${syncing ? '同步中' : '刷新'}</button>
        <button class="playlists-chip" data-action="music-accounts">${icon('settings', 'xs')}账号</button>
      </div>
    </div>
    ${
      state.myPlaylists.error
        ? `<div class="playlists-error">${icon('alert', 'xs')}<span>${esc(state.myPlaylists.error)}</span>
            <button class="link-btn" data-action="my-playlists-reload">重试</button>
          </div>`
        : ''
    }
    <div class="playlists-groups">
      ${shown.map(myPlaylistGroupMarkup).join('')}
    </div>
    ${
      idle.length
        ? `<p class="playlists-foot">${idle.map((key) => esc(musicPlatformLabel(key))).join(' / ')} 还没登录 · <button class="link-btn" data-action="music-accounts">去音乐账号里登录</button></p>`
        : ''
    }
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

/** 武器 / 邦布没有立绘时用的占位图标 */
function gachaKindIcon(kind) {
  return kind === 'weapon' || kind === 'bangboo' ? icon('wrench') : '';
}

/** 五星记录里「不是角色」的兜底名 */
function gachaKindFallback(kind) {
  return { weapon: '未命名武器', bangboo: '未命名邦布' }[kind] || '未命名角色';
}

function gachaRecentRow(item, highLabel, gameKey = '') {
  const pity = Number(item.pity) || 0;
  const isWeapon = item.itemType === 'weapon';
  const kindLabel = gachaKindLabel(item.itemType);
  const badge = pity > 0 ? `<span class="gacha-pity-badge" title="距离上一次出金用了 ${pity} 抽">${pity} 抽</span>` : '';
  const fallback = isWeapon || item.itemType === 'bangboo' ? gachaKindIcon(item.itemType) : esc(initial(item.name));

  // 异环官网给的是 138×278 的「上圆框 + 下圆形」两帧精灵图，直接当 <img> 会挤成小图，
  // 所以用背景图按 200% 高度铺，只露出上半帧的正脸圆框。
  const sprite = gameKey === 'neverness' && item.icon;
  const iconMarkup = sprite
    ? `<span class="gacha-icon-sprite" style="background-image:url('${esc(item.icon)}')"></span>`
    : item.icon
      ? `<img src="${esc(item.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-gacha-icon />`
      : '';

  return `
    <div class="gacha-five-row">
      <span class="gacha-five-icon ${isWeapon ? 'is-weapon' : ''} ${sprite ? 'is-sprite' : ''}">
        ${iconMarkup}
        <span>${fallback}</span>
      </span>
      <span class="gacha-five-star ${isWeapon ? 'is-weapon' : ''}">${highLabel}</span>
      <div class="gacha-five-copy">
        <strong>${esc(item.name || gachaKindFallback(item.itemType))}</strong>
        <small>${kindLabel ? `${kindLabel} · ` : ''}${esc(item.banner)} · ${esc(String(item.time).slice(0, 10))}</small>
      </div>
      ${badge}
    </div>`;
}

/** Starward 风格的五星清单：按角色 / 武器 / 邦布筛，每行直接标多少抽出。 */
function gachaFiveRow(item, high, gameKey) {
  const pity = Number(item.pity) || 0;
  const isWeapon = item.itemType === 'weapon';
  const kindLabel = gachaKindLabel(item.itemType);
  const sprite = gameKey === 'neverness' && item.icon;
  const iconMarkup = sprite
    ? `<span class="gacha-icon-sprite" style="background-image:url('${esc(item.icon)}')"></span>`
    : item.icon
      ? `<img src="${esc(item.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-gacha-icon />`
      : '';
  return `
    <div class="gacha-five-row is-table">
      <span class="gacha-five-icon ${isWeapon ? 'is-weapon' : ''} ${sprite ? 'is-sprite' : ''}">
        ${iconMarkup}
        <span>${isWeapon || item.itemType === 'bangboo' ? gachaKindIcon(item.itemType) : esc(initial(item.name))}</span>
      </span>
      <div class="gacha-five-copy">
        <strong>${esc(item.name || gachaKindFallback(item.itemType))}</strong>
        <small>${esc(item.banner)} · ${esc(String(item.time).slice(0, 10))}</small>
      </div>
      <span class="gacha-five-rank-tag ${isWeapon ? 'is-weapon' : ''}">${kindLabel || high}</span>
      <span class="gacha-five-pity">
        <strong>${pity || '—'}</strong>
        <em>${pity ? '抽' : '未知'}</em>
      </span>
    </div>`;
}

function gachaFiveList(user, game) {
  const high = gachaHighLabel(game);
  const all = user.fiveHistory || user.recentFive || [];
  const filter = state.gachaFiveFilter || 'all';
  const items = all.filter((item) => filter === 'all' || item.itemType === filter);
  const charCount = all.filter((item) => item.itemType === 'character').length;
  const weaponCount = all.filter((item) => item.itemType === 'weapon').length;
  const bangbooCount = all.filter((item) => item.itemType === 'bangboo').length;
  const values = all.map((item) => Number(item.pity) || 0).filter((value) => value > 0);
  const average = values.length
    ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
    : 0;
  const best = values.length ? Math.min(...values) : 0;
  const worst = values.length ? Math.max(...values) : 0;

  // 按月分组，和 Starward 一样一眼能看出这个月出了什么
  const groups = [];
  for (const item of items) {
    const month = String(item.time || '').slice(0, 7) || '未知时间';
    let group = groups[groups.length - 1];
    if (!group || group.month !== month) {
      group = { month, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }

  const chips = [
    { key: 'all', label: '全部', count: all.length },
    { key: 'character', label: '角色', count: charCount },
    { key: 'weapon', label: '武器', count: weaponCount },
    { key: 'bangboo', label: '邦布', count: bangbooCount },
  ].filter((chip) => chip.key === 'all' || chip.count > 0);
  // 「全部」下类型一目了然，那排小分类就不占地方了；切到具体类型时再出现，方便切回去
  const showChips = filter !== 'all';

  return `
    <div class="gacha-five-toolbar">
      ${
        showChips
          ? `<div class="gacha-five-chips">
        ${chips
          .map(
            (chip) =>
              `<button class="gacha-five-chip ${filter === chip.key ? 'active' : ''}" data-action="gacha-five-filter" data-value="${chip.key}">${chip.label}<em>${chip.count}</em></button>`
          )
          .join('')}
      </div>`
          : ''
      }
      <div class="gacha-five-stats">
        <span>平均 <strong>${average || '—'}</strong> 抽</span>
        <span>最快 <strong>${best || '—'}</strong></span>
        <span>最慢 <strong>${worst || '—'}</strong></span>
      </div>
    </div>
    ${
      user.pityExact === false
        ? '<p class="gacha-pity-note">这份记录里没有三星抽卡，抽数会把四星也算进去，只能当参考。</p>'
        : ''
    }
    <div class="gacha-five-groups">
      ${
        groups.length
          ? groups
              .map(
                (group) => `
        <section class="gacha-five-group">
          <header>${esc(group.month)}<span>${group.items.length} 个</span></header>
          ${group.items.map((item) => gachaFiveRow(item, high, game.key)).join('')}
        </section>`
              )
              .join('')
          : '<p class="gacha-empty-line">这个筛选下还没有记录</p>'
      }
    </div>`;
}

function gachaBannerRows(user, game) {
  const pities = user.pities || [];
  if (!pities.length) return '<p class="gacha-empty-line">还没有卡池记录</p>';
  const cap = gachaPityCap(game);
  const high = gachaHighLabel(game);
  return pities
    .map((item) => {
      const percent = Math.min(100, (item.pity / cap) * 100);
      const rate = item.pulls ? ((item.five / item.pulls) * 100).toFixed(2) : '0.00';
      return `
      <div class="gacha-banner-row">
        <div class="gacha-banner-name">
          <strong>${esc(item.name)}</strong>
          <span>${item.pulls} 抽 · ${item.five} ${high} · 出率 ${rate}%</span>
        </div>
        <div class="gacha-banner-pity ${percent >= 80 ? 'near' : ''}">
          <span>垫</span><strong>${item.pity}</strong><em>/${cap}</em>
        </div>
        <div class="gacha-pity-bar"><span style="width:${percent}%"></span></div>
      </div>`;
    })
    .join('');
}

function gachaOverview(user, game) {
  const high = gachaHighLabel(game);
  const mid = gachaMidLabel(game);
  const cap = gachaPityCap(game);
  const pities = (user.pities || []).slice(0, 4);
  const fourRate = user.fourRate !== undefined
    ? user.fourRate
    : user.total
      ? (user.four / user.total) * 100
      : 0;
  const average = Number(user.averagePity) || 0;
  const luckiest = Number(user.luckiest) || 0;
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
      <div class="gacha-pity-panel">
        <div class="gacha-overview-head">
          <h4>卡池垫数</h4>
          <button class="link-btn" data-action="gacha-tab" data-value="banners">全部 ${icon('chevron-right')}</button>
        </div>
        ${
          pities.length
            ? pities
                .map((item) => {
                  const percent = Math.min(100, (item.pity / cap) * 100);
                  return `
                  <div class="gacha-pity-row">
                    <div class="gacha-pity-title">
                      <span>${esc(item.name)}</span>
                      <strong>${item.pity}<em>/${cap}</em></strong>
                    </div>
                    <div class="gacha-pity-bar"><span style="width:${percent}%" class="${percent >= 80 ? 'near' : ''}"></span></div>
                  </div>`;
                })
                .join('')
            : '<p class="gacha-empty-line">还没有卡池记录</p>'
        }
      </div>
    </div>
    <div class="gacha-overview-recent">
      <div class="gacha-overview-head">
        <h4>最近获得</h4>
        <button class="link-btn" data-action="gacha-tab" data-value="recent">查看全部 ${icon('chevron-right')}</button>
      </div>
      ${(user.recentFive || []).slice(0, 4).map((item) => gachaRecentRow(item, high, game.key)).join('') || '<p class="gacha-empty-line">还没有记录</p>'}
    </div>`;
}

// 异环：显示识别到的账号 + 自动导入目录入口 + 自动抓取
function renderNteCapture() {
  const box = document.querySelector('#nte-capture-status');
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
    return `<div class="page">${head}<div class="empty"><div class="empty-icon">${icon('star')}</div><h3>获取抽卡数据中…</h3><p>首次读取需要一点时间，请稍候。</p></div></div>`;
  }
  if (state.gachaError) {
    return `<div class="page">${head}<div class="empty"><div class="empty-icon">${icon('alert')}</div><h3>读取失败</h3><p>${esc(state.gachaError)}</p><button class="btn btn-ghost" data-action="refresh-gacha">重新读取</button></div></div>`;
  }
  if (!state.gacha) {
    return `<div class="page">${head}<div class="empty"><div class="empty-icon">${icon('star')}</div><h3>还没有抽卡记录</h3><p>启动器会自动读取本机的抽卡数据；也可以用 UIGF 或异环导出 JSON 导入。</p><div class="empty-actions"><button class="btn btn-primary" data-action="import-gacha">${icon('download')}导入记录</button><button class="btn btn-ghost" data-action="sync-gacha">${icon('refresh')}在线同步</button></div></div></div>`;
  }

  const selection = gachaEnsureSelection();
  if (!selection) {
    return `<div class="page">${head}<div class="empty"><div class="empty-icon">${icon('star')}</div><h3>还没有抽卡记录</h3><p>可以导入 UIGF / SRGF / 异环导出 JSON；终末地可以直接网页登录同步。</p><div class="empty-actions"><button class="btn btn-ghost" data-action="import-gacha">导入 UIGF / 异环</button><button class="btn btn-ghost" data-action="gacha-source" data-value="endfield">终末地同步</button></div></div></div>`;
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
          <div class="empty-icon">${icon('star')}</div>
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
  const tab = state.gachaTab || 'overview';
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
  const content =
    tab === 'banners'
      ? `<div class="gacha-banner-list">${gachaBannerRows(view, game)}</div>`
      : tab === 'recent'
        ? gachaFiveList(view, game)
        : gachaOverview(view, game);

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
      <div class="gacha-subtabs">
        <button class="${tab === 'overview' ? 'active' : ''}" data-action="gacha-tab" data-value="overview">概览</button>
        <button class="${tab === 'banners' ? 'active' : ''}" data-action="gacha-tab" data-value="banners">卡池统计</button>
        <button class="${tab === 'recent' ? 'active' : ''}" data-action="gacha-tab" data-value="recent">五星记录</button>

      </div>
      ${scopeTabs}
      <div class="gacha-content">${content}</div>
      <div class="gacha-footnote-bar">
        <p class="gacha-footnote">
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
    format: 'NTE_Gacha_Exporter 的 nte.list JSON',
    tool: '异环没有公开接口，需要先用 NTE_Gacha_Exporter 抓包导出，再在这里导入。',
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

          ${guide ? `<div class="form-note">${icon('info')}<span>${esc(guide.tool)}</span></div>` : ''}

          <div class="gacha-import-result" id="gacha-import-result" hidden></div>
          <div class="field-error" id="gacha-import-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
          <button class="btn btn-ghost" data-action="gacha-source" data-value="endfield">${icon('refresh')}改用在线同步</button>
        </div>
      </div>
    </div>
  `);

  const pick = document.querySelector('#gacha-import-pick');
  const error = document.querySelector('#gacha-import-error');
  const resultBox = document.querySelector('#gacha-import-result');
  const guideText = document.querySelector('#gacha-import-guide');
  const chipsRoot = document.querySelector('#gacha-import-chips');
  if (!pick) return;

  chipsRoot?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-import-game]');
    if (!button) return;
    chipsRoot.querySelectorAll('.gacha-import-chip').forEach((chip) => {
      chip.classList.toggle('active', chip === button);
    });
    const key = button.dataset.importGame;
    const next = GACHA_IMPORT_GUIDES[key];
    if (guideText) {
      guideText.textContent = next ? `${next.name}：${next.format}` : 'UIGF / SRGF / 异环导出 JSON';
    }
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

/* ------------------------------ 画质配置 ------------------------------ */

async function loadGraphics(gameKey) {
  const key = gameKey || state.graphicsGame || 'starrail';
  state.graphicsGame = key;
  state.graphicsLoading = true;
  state.graphicsError = '';
  render({ preserveScroll: true });
  try {
    if (!window.launcher?.graphics?.read) throw new Error('当前版本不支持读取画质配置');
    const result = await window.launcher.graphics.read(key);
    if (!result || result.ok === false) throw new Error(result?.reason || '读取失败');
    state.graphics = result;
  } catch (error) {
    state.graphics = null;
    state.graphicsError = humanError(error) || '读取画质配置失败';
  } finally {
    state.graphicsLoading = false;
    if (state.route === 'graphics') render({ preserveScroll: true });
  }
  return state.graphics;
}

/* 旧版在这里做过滤（graphicsEntries）。现在主进程读注册表时就只取画质相关的键，
   并把键名翻译成中文（electron/graphics-schema.js），前端不再重复判断。 */

function graphicsView() {
  const result = state.graphics;
  const games = ['genshin', 'starrail', 'zzz', 'bh3'];
  // 主进程已经把注册表项翻译成 fields（中文名 + 显示值 + 帮助文案），
  // 这里只管排版，不再自己猜哪些键有用。
  const groups = result && Array.isArray(result.fields) ? result.fields : [];

  let body = '';
  if (state.graphicsLoading) {
    body = `<div class="tools-empty">${icon('refresh')}<strong>正在读取注册表</strong><p>稍等一下。</p></div>`;
  } else if (state.graphicsError) {
    body = `<div class="tools-empty">${icon('info')}<strong>${esc(state.graphicsError)}</strong><p>游戏启动过一次之后才会有画质配置。</p></div>`;
  } else if (result) {
    const cards = groups
      .map((group) => {
        const rows = (group.fields || [])
          .map((field) => {
            // 选项型参数：值 → 中文档位，鼠标悬停给解释
            const levelText = field.type === 'enum' && Array.isArray(field.options)
              ? `${field.value} / ${field.options[field.options.length - 1]}`
              : '';
            return `
              <li class="gfx-row" title="${esc(field.help || '')}">
                <span class="gfx-label">${esc(field.label)}</span>
                <span class="gfx-value">${esc(field.display)}</span>
                ${levelText ? `<span class="gfx-range">${esc(levelText)}</span>` : ''}
              </li>`;
          })
          .join('');
        // 字段多的卡片（星铁「画质细节」有 17 项）单独占满整行
        const wide = (group.fields || []).length > 4 ? ' is-wide' : '';
        return `
          <article class="gfx-card${wide}">
            <header>
              <strong>${esc(group.title)}</strong>
              ${group.subtitle && group.subtitle !== group.title ? `<em>${esc(group.subtitle)}</em>` : ''}
            </header>
            <ul>${rows || '<li class="gfx-row"><span class="gfx-label">（没有可读字段）</span></li>'}</ul>
          </article>`;
      })
      .join('');

    body = `
      ${cards ? `<div class="gfx-grid">${cards}</div>` : `<p class="page-desc">这个游戏的画质配置还没有可读字段。</p>`}
      <p class="shots-note">
        数据读自游戏写在注册表里的画质设置，鼠标停在每一项上能看到它是什么意思。
        想改画质请进游戏内设置，启动器目前只读不写，避免把游戏配置写坏。
      </p>
    `;
  }

  return `<div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">${PAGE_META.graphics.eyebrow}</div>
        <h1>画质配置</h1>
        <p class="page-desc">读取游戏写在注册表里的画质 / 分辨率设置。</p>
      </div>
      <button class="btn ghost" data-action="graphics-refresh">${icon('refresh', 'xs')}重新读取</button>
    </div>
      <div class="shots-tabs">
        ${games
          .map(
            (key) => `<button class="shots-tab${key === state.graphicsGame ? ' active' : ''}" data-action="graphics-game" data-value="${esc(key)}">
              ${esc(shotGameLabel(key))}
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
  const data = state.features;
  if (!data || data.error || !Array.isArray(data.byCategory)) {
    sub.innerHTML = `<span class="nav-sub-hint">${data?.error ? '读取失败' : '读取中…'}</span>`;
    syncNavToolsOpen();
    return;
  }

  const groups = data.byCategory;
  const html = groups
    .map((group) => {
      const rows = group.items
        .map((feature) => {
          const target = TOOLS_NAV_TARGET[feature.key];
          // 这个功能在几款游戏上真正可用，0 就直接标灰
          const supportedCount = (data.games || []).filter((game) =>
            (data.matrix?.[game.key] || []).includes(feature.key)
          ).length;
          const chip = `<span class="nav-sub-count">${supportedCount}</span>`;
          if (!target) {
            return `<div class="nav-sub-item is-idle" title="还没有独立页面">
              <span class="nav-sub-dot"></span>
              <span class="nav-sub-name">${esc(feature.name)}</span>${chip}
            </div>`;
          }
          return `<button class="nav-sub-item" data-nav="${esc(target)}" data-feature="${esc(feature.key)}" title="${esc(feature.desc || feature.name)}">
            <span class="nav-sub-dot"></span>
            <span class="nav-sub-name">${esc(feature.name)}</span>${chip}
          </button>`;
        })
        .join('');
      return `<div class="nav-sub-group">
        <div class="nav-sub-title">${esc(toolsCategoryLabel(group.category))}</div>
        ${rows}
      </div>`;
    })
    .join('');

  sub.innerHTML = html || '<span class="nav-sub-hint">暂无功能</span>';
  syncNavToolsOpen();
}

/** 把折叠状态同步到 DOM：显隐、箭头方向、aria。 */
function syncNavToolsOpen() {
  const sub = dom.navToolsSub;
  const parent = dom.navToolsGroup?.querySelector('.nav-item-parent');
  if (!sub || !parent) return;
  const open = Boolean(state.navToolsOpen);
  sub.hidden = !open;
  parent.setAttribute('aria-expanded', open ? 'true' : 'false');
  dom.navToolsGroup.classList.toggle('is-open', open);
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
}

/**
 * 「按游戏查看」的单个游戏卡。
 *
 * 关键：只列这个游戏**真正支持**的功能。
 * 以前把 19 个功能全铺出来、只给支持的打绿点，结果崩坏3 / 终末地 / 异环
 * 的卡片里塞满了「深境螺旋 / 忘却之庭 / 式舆防卫战」这些属于别家游戏的玩法，
 * 看着像它们也支持。现在不支持的收成底部一行灰字，眼不见心不烦。
 */
function toolsGameCard(game, supportOf) {
  const features = supportOf(game.key);
  const supported = features.filter((item) => item.supported);

  const rows = supported
    .map(
      (item) => `<li class="tools-feature on">
        <span class="tools-feature-dot"></span>
        <span class="tools-feature-name">${esc(item.name)}</span>
        <span class="tools-feature-kind">${esc(toolsCategoryLabel(item.category))}</span>
      </li>`
    )
    .join('');

  return `<div class="tools-game-card">
    <div class="tools-game-head">
      <div>
        <h3>${esc(game.name)}</h3>
        <p>${esc(game.subtitle || '')}</p>
      </div>
      <div class="tools-game-count"><strong>${supported.length}</strong><span>/ ${features.length}</span></div>
    </div>
    ${
      rows
        ? `<ul class="tools-feature-list">${rows}</ul>`
        : `<p class="tools-game-empty">这个游戏还没有可用的启动器功能，只能启动和记录游玩时长。</p>`
    }
  </div>`;
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

  const groups = data.byCategory || [];
  const games = data.games || [];
  const supportOf = toolsSupportOf(data);
  const totalGames = games.length;
  const totalFeatures = (data.features || []).length;

  const summary = groups
    .map(
      (group) => `<div class="tools-summary-item">
        <span class="tools-summary-count">${group.items.length}</span>
        <span class="tools-summary-label">${esc(toolsCategoryLabel(group.category))}</span>
      </div>`
    )
    .join('');

  const featureSections = groups
    .map(
      (group) => `<section class="tools-section">
        <div class="tools-section-head">
          <h2>${esc(toolsCategoryLabel(group.category))}</h2>
          <p>${esc(toolsCategoryHint(group.category))}</p>
        </div>
        <div class="tools-feature-grid">
          ${group.items
            .map((feature) => {
              // 这个功能在哪些游戏上可用（matrix 只列已支持的）
              const supported = games.filter((game) => supportOf(game.key).some(
                (item) => item.key === feature.key && item.supported
              ));
              return `<div class="tools-feature-card">
                <div class="tools-feature-card-head">
                  <strong>${esc(feature.name)}</strong>
                  <span class="tools-eyebrow">${esc(feature.eyebrow || '')}</span>
                </div>
                <p class="tools-feature-desc">${esc(feature.desc || '')}</p>
                <div class="tools-feature-games">
                  ${supported.length
                    ? supported.map((game) => `<span class="tools-chip on">${esc(game.name)}</span>`).join('')
                    : `<span class="tools-chip">所有游戏都还没有接入</span>`}
                </div>
                ${
                  feature.needsLogin
                    ? miyouLoginNote()
                    : ''
                }
                ${
                  // 只有游戏端已支持时，才给「去看」入口；否则点了也是空页。
                  supported.length
                    ? `<div class="tools-feature-actions">
                        <button class="link-btn" data-action="tools-open" data-feature="${esc(feature.key)}">${icon('chevron-right', 'xs')}打开${esc(feature.name)}</button>
                      </div>`
                    : ''
                }
              </div>`;
            })
            .join('')}
        </div>
      </section>`
    )
    .join('');

  const gameCards = games.map((game) => toolsGameCard(game, supportOf)).join('');

  return `<div class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">${PAGE_META.tools.eyebrow}</div>
        <h1>工具</h1>
        <p class="page-desc">所有游戏能力都登记在 electron/game-features.js，加新游戏只改这一处。</p>
      </div>
      <button class="btn ghost" data-action="tools-refresh">${icon('refresh', 'xs')}重新读取</button>
    </div>

    <div class="tools-summary">${summary}
      <div class="tools-summary-item">
        <span class="tools-summary-count">${totalGames}</span>
        <span class="tools-summary-label">游戏</span>
      </div>
      <div class="tools-summary-item">
        <span class="tools-summary-count">${totalFeatures}</span>
        <span class="tools-summary-label">功能</span>
      </div>
    </div>

    ${featureSections}

    <section class="tools-section">
      <div class="tools-section-head">
        <h2>账号登录</h2>
        <p>战绩类功能要先登录；抽卡记录走各自游戏的独立通道</p>
      </div>
      ${hoyolabLoginCard()}
      ${otherLoginCards(games)}
    </section>

    <section class="tools-section">
      <div class="tools-section-head">
        <h2>按游戏查看</h2>
        <p>每个游戏支持哪些能力，一眼能看出缺什么</p>
      </div>
      <div class="tools-game-grid">${gameCards}</div>
    </section>
  </div>`;
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
    ? `<div class="record-tabs record-tabs-schedule">
        <button class="record-tab${state.record.schedule === 1 ? ' is-active' : ''}" data-action="record-schedule" data-value="1">本期</button>
        <button class="record-tab${state.record.schedule === 2 ? ' is-active' : ''}" data-action="record-schedule" data-value="2">上期</button>
      </div>`
    : '';

  return `
    ${gameTabs ? `<div class="record-tabs record-tabs-game">${gameTabs}</div>` : ''}
    ${featureTabs ? `<div class="record-tabs record-tabs-feature">${featureTabs}</div>` : ''}
    ${scheduleTabs}`;
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

function newsView() {
  if (!state.news.length) {
    return `<div class="page"><div class="page-head"><div><div class="eyebrow">${PAGE_META.news.eyebrow}</div><h1>动态</h1></div></div><div class="empty"><div class="empty-icon">${icon('news')}</div><h3>暂时没有内容</h3><p>稍后再来看看。</p></div></div>`;
  }
  const [feature, ...rest] = state.news;
  return `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">${PAGE_META.news.eyebrow}</div>
          <h1>动态</h1>
          <p class="sub">使用指南、功能说明，以及一些关于这个启动器的想法。</p>
        </div>
      </div>
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
      </button>
      <div class="news-list">
        ${rest
          .map(
            (post) => `
          <button class="news-row" data-action="open-news" data-id="${esc(post.id)}">
            <span class="news-date">${formatDate(post.date)}</span>
            <span style="min-width:0">
              <h4>${esc(post.title)}</h4>
              <p>${esc(post.excerpt)}</p>
            </span>
            <span class="read">${esc(post.readTime || '')}</span>
            ${icon('chevron-right')}
          </button>`
          )
          .join('')}
      </div>
      ${newsUpdateSection()}
      ${newsNoticeSection()}
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
 * 动态页底部内嵌的官方公告。
 * 原来是独立的一页，但两者都是「读一读最近发生了什么」，
 * 合并后少一个导航项，也不用在两个页面之间来回跳。
 */
function newsNoticeSection() {
  const games = state.games.filter((game) => game.builtinKey);
  if (!games.length) return '';
  const updated = state.noticeBoardUpdatedAt
    ? `更新于 ${new Date(state.noticeBoardUpdatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : '等待首次同步';
  return `
    <section class="news-notices">
      <div class="section-head">
        <div>
          <h3>官方公告</h3>
          <p>各游戏官网的最新公告，每 10 分钟自动同步</p>
        </div>
        <span class="news-notice-actions">
          <span class="notice-sync-status"><span class="notice-sync-dot"></span>${updated}</span>
          <button class="link-btn" data-action="refresh-notices" ${state.noticeBoardLoading ? 'disabled' : ''}>
            ${icon('refresh', 'xs')}${state.noticeBoardLoading ? '同步中' : '刷新'}
          </button>
        </span>
      </div>
      ${
        state.noticeBoardError
          ? `<div class="notice-error">${icon('info', 'xs')} ${esc(state.noticeBoardError)}</div>`
          : ''
      }
      <div class="notice-grid compact">${games.map((game) => noticeGameCard(game)).join('')}</div>
    </section>`;
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
  ['behavior', '行为', 'settings', '托盘、开机自启、帧率与自动同步'],
  ['storage', '存储', 'folder-open', '下载目录、运行时与终末地渠道包'],
  ['update', '更新', 'download', '更新源、自动检查与手动更新'],
  ['about', '关于', 'info', '版本信息与相关链接'],
];

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
          <p class="desc">按钮、导航和通知的反馈音，独立于歌曲音量；歌曲音量与 3D 音效在点歌台里调整。</p>
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
          <p class="desc">托盘、开机自启、帧率、自动同步等。</p>
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
            <div class="setting-copy"><strong>星穹铁道帧率</strong><span>写入星铁本地画质配置，可选 30 / 60 / 120 FPS。改 120 前请先退出游戏；游戏内画质预设会被改成自定义。</span></div>
            <div class="setting-control">
              <div class="segmented">
                ${[30, 60, 120]
                  .map(
                    (fps) =>
                      `<button class="${Number(state.starrailFps) === fps ? 'active' : ''}" data-action="set-starrail-fps" data-value="${fps}">${fps} FPS</button>`
                  )
                  .join('')}
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>检测已安装的游戏</strong><span>重新扫描注册表和常见安装目录，自动填入原神、星穹铁道、绝区零、终末地的启动程序。</span></div>
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
            <div class="setting-copy"><strong>下载文件夹</strong><span class="path-text" title="${esc(settings.downloadDir || '')}">${esc(settings.downloadDir || '')}</span></div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="change-download-dir">更改</button>
              <button class="btn btn-icon btn-ghost" data-action="open-download-folder" title="打开下载文件夹">${icon('external')}</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>始终以管理员身份启动</strong><span>终末地通过官方登录流程启动时需要管理员权限。开启后，下次启动会直接请求 Windows UAC，不再重复弹出应用内提示。</span></div>
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
          <p class="desc">更新源已经内置：启动器会先看启动器目录里那份 <code>latest.json</code>，没有就自动去官方 Release 取。所以装完就能自己升级，不用手动填地址。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>更新源</strong><span>留空就用内置的官方源；也可以填自己的 https 地址、局域网共享（\\NAS\share\latest.json）或本地路径。ZIP 地址写在清单里，相对路径以清单所在目录为准。</span></div>
            <div class="setting-control update-source-control">
              <input class="text-input" id="update-manifest" value="${esc(settings.updateManifest || '')}" placeholder="留空 = 内置官方源" spellcheck="false" />
              <button class="btn btn-ghost" data-action="save-update-source">保存</button>
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
              <strong>更新日志</strong>
              <span>覆盖脚本在后台单独运行，界面看不到它的输出。更新卡住或没重启时，把这里的日志发回来就能定位是哪一步出的问题。</span>
            </div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="view-update-log">${icon('file-text')}查看日志</button>
              <button class="btn btn-ghost" data-action="open-update-log">${icon('folder')}打开文件</button>
            </div>
          </div>
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
          ${state.update && state.update.downloading ? `<div class="update-progress"><div class="update-progress-bar"><span style="width:${Number(state.update.percent) || 0}%"></span></div><small>正在下载 ${Number(state.update.percent) || 0}%</small></div>` : ''}
        </section>

        <section class="${group('about', true)}" ${groupAttr('about')}>
          <h2>${icon('info')}关于</h2>
          <p class="desc">一个本地优先的桌面游戏书架。</p>
          <div class="setting-row" style="border-bottom:0;padding-bottom:0">
            <div class="about-block">
              <div class="about-name">花筱灵启动器</div>
              <div class="about-version">VERSION ${esc(state.app.version || '1.0.0')} · ELECTRON ${esc(state.app.electron || '')}</div>
              <div class="about-note">
                内置原神、崩坏：星穹铁道、绝区零、异环、明日方舟：终末地的启动入口，也支持添加任意本地游戏。
                界面与代码为原创实现，红金舞台氛围参考《崩坏：星穹铁道》的花火，但只使用原创几何图形，不内置官方立绘或标志。
                版本封面会在联网时从官网获取并缓存，版权归各游戏官方所有。
                功能设计参考了 Starward（MIT）等开源启动器，不包含它们的代码或素材。
                游戏列表、设置和时长都保存在本地，不会上传。
              </div>
              <div class="about-links">
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
  document.querySelectorAll('img[data-gacha-icon]').forEach((img) => {
    img.addEventListener('error', () => img.remove(), { once: true });
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
      state.gachaTab = 'overview';
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
      render({ preserveScroll: true });
      if (next === 'charts' && !(state.charts.list || []).length && !state.charts.loading) {
        handleAction('chart-platform', { dataset: { value: state.charts.platform || 'all' } });
      }
      if (next === 'mine') {
        // 「我的歌单」按平台分区显示所有已登录平台的歌单，不再只挑一个平台。
        // 已经有缓存就别重新拉：切走再切回还触发一次全量读取，卡顿又浪费。
        // 登录成功或手动点刷新会自己清缓存（见 syncPlaylistsAfterLogin / my-playlists-reload）。
        if (!state.myPlaylists.groups?.length) loadAllPlaylists();
      }
      break;
    }
    case 'music-account-login': {
      const platform = element.dataset.platform || 'qq';
      const label = platform === 'qq' ? 'QQ 音乐' : '酷狗';
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
      const label = platform === 'netease' ? '网易云' : platform === 'qq' ? 'QQ 音乐' : '酷狗';
      try {
        await api.musicLogout(platform);
        await refreshMusicLogin();
        invalidateAllPlaylists();
        toast(`已退出 ${label}`, 'success');
        if (state.route === 'song') render({ preserveScroll: true });
      } catch (error) {
        toast(humanError(error), 'error');
      }
      break;
    }
    case 'netease-login':
      openMusicAccountsModal('netease');
      break;
    case 'import-netease': {
      const defaultApi = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
      openModal(`
        <div class="modal-head"><div><h2>导入网易云歌单</h2><p>需要本机运行兼容 NeteaseCloudMusicApi 的本地服务，并先在服务里登录。</p></div><button class="icon-btn" data-close>${icon('x')}</button></div>
        <form class="modal-body" id="netease-form">
          <label class="field"><span>本地 API 地址</span><input class="text-input" name="apiBase" value="${esc(defaultApi)}" placeholder="http://127.0.0.1:3100" required /></label>
          <label class="field"><span>歌单链接</span><input class="text-input" name="url" placeholder="https://music.163.com/#/playlist?id=..." required /></label>
          <p class="form-hint">只读取歌单和可播放地址，不保存网易云账号密码；VIP/版权歌曲可能没有地址。</p>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" type="submit">导入</button></div>
        </form>
      `);
      const form = document.querySelector('#netease-form');
      form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const apiBase = String(data.get('apiBase') || '').trim();
        const url = String(data.get('url') || '').trim();
        const submit = form.querySelector('button[type="submit"]');
        if (submit) submit.disabled = true;
        try {
          localStorage.setItem('vela:netease-api', apiBase);
          const result = await api.neteasePlaylist({ apiBase, url, level: state.songQuality });
          state.songs.push(...result.songs);
          state.songIndex = Math.max(0, state.songs.length - result.songs.length);
          saveSongs();
          closeModal();
          render({ preserveScroll: true });
          toast(
            `已导入「${result.playlist}」${result.songs.length} 首${result.skipped ? `，跳过 ${result.skipped} 首无版权/无地址` : ''}`,
            'success'
          );
          playCurrentSong();
        } catch (error) {
          toast(`网易云歌单导入失败：${error.message}`, 'error');
          if (submit) submit.disabled = false;
        }
      });
      break;
    }
    case 'add-song-file': {
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
      openModal(`
        <div class="modal-head"><div><h2>添加歌曲链接</h2><p>支持 http / https 音频直链。</p></div><button class="icon-btn" data-close>${icon('x')}</button></div>
        <form class="modal-body" id="song-link-form">
          <label class="field"><span>歌名</span><input class="text-input" name="title" placeholder="例如：夜航星" required /></label>
          <label class="field"><span>音频地址</span><input class="text-input" name="url" placeholder="https://.../song.mp3" required /></label>
          <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" type="submit">加入歌单</button></div>
        </form>
      `);
      const form = document.querySelector('#song-link-form');
      form?.addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const title = String(data.get('title') || '').trim();
        const url = String(data.get('url') || '').trim();
        if (!title || !/^https?:\/\//i.test(url)) return;
        state.songs.push({ title, url });
        state.songIndex = state.songs.length - 1;
        saveSongs();
        closeModal();
        render({ preserveScroll: true });
        playCurrentSong();
      });
      break;
    }
    case 'my-playlist-open': {
      await openMyPlaylist(element.dataset.platform || '', element.dataset.id || '');
      break;
    }
    case 'my-playlist-close': {
      state.myPlaylists.detail = null;
      render({ preserveScroll: true });
      break;
    }
    case 'my-playlist-song': {
      const index = Number(element.dataset.index) || 0;
      const song = (state.myPlaylists.detail?.songs || [])[index];
      if (!song) break;
      const ok = await addChartSongToQueue(song, { silent: true });
      toast(ok ? `已加入：${song.title}` : `「${song.title}」暂时找不到可播放版本`, ok ? 'success' : 'info');
      break;
    }
    case 'my-playlist-import': {
      const songs = (state.myPlaylists.detail?.songs || []).slice(0, 10);
      if (!songs.length) break;
      toast(`正在把 ${songs.length} 首加进点歌队列…`, 'info');
      let added = 0;
      for (const song of songs) {
        if (await addChartSongToQueue(song, { silent: true })) added += 1;
      }
      toast(
        added ? `已加入 ${added} 首（其余在网易云没有可播版本）` : '这些曲目在网易云没有可播版本',
        added ? 'success' : 'info'
      );
      break;
    }
    case 'toggle-auto-resume': {
      state.autoResumeSong = !state.autoResumeSong;
      try {
        localStorage.setItem('vela:auto-resume-song', state.autoResumeSong ? '1' : '0');
      } catch {
        /* 可选记忆 */
      }
      render({ preserveScroll: true });
      toast(
        state.autoResumeSong
          ? '已开启：打开启动器会自动继续上次的音乐'
          : '已关闭：需要手动点播放才会继续',
        'success'
      );
      break;
    }
    case 'my-playlists-reload': {
      invalidateAllPlaylists();
      await loadAllPlaylists(true);
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
        if (await addChartSongToQueue(item, { silent: true })) added += 1;
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
      const songs = (state.charts.detail?.songs || []).slice(0, 10);
      if (!songs.length) break;
      toast(`正在把 ${songs.length} 首转成网易云曲目…`, 'info');
      let added = 0;
      for (const song of songs) {
        if (await addChartSongToQueue(song, { silent: true })) added += 1;
      }
      toast(added ? `已加入 ${added} 首（其余在网易云没有可播版本）` : '这些曲目在网易云没有可播版本', added ? 'success' : 'info');
      break;
    }
    case 'live-connect': {
      const url = document.querySelector('#live-room-input')?.value?.trim() || '';
      if (!url) {
        toast('先粘贴直播间链接或房间号（B站 / 斗鱼 / 虎牙 / 抖音 / 快手等）', 'info');
        break;
      }
      await connectLiveRoom(url);
      break;
    }
    case 'live-disconnect':
      disconnectBiliLive();
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
      toast('小播放器已关闭，可在「设置 → 声音」或点歌台重新打开', 'info');
      break;
    }
    case 'toggle-mini-player': {
      const next = !isMiniEnabled();
      setMiniEnabled(next);
      if (state.route === 'settings' || state.route === 'song') render({ preserveScroll: true });
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
    case 'start-server': {
      // 点服务器胶囊：切换并直接启动
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const game = state.games.find((item) => item.id === gameId);
      const server = game && (game.servers || []).find((item) => item.id === serverId);
      if (!game || !server) break;
      if (!server.exists || server.incomplete) {
        // 不可用时直接打开管理面板，让用户点「重建」
        openStartServerManager(gameId);
        break;
      }
      try {
        await api.servers.activate({ gameId, serverId });
        if (game.installed) {
          const launch = await api.games.launch(gameId);
          if (!launch.ok) toast(launch.error, 'error');
          else playUiSound('launch');
        }
      } catch (error) {
        toast(humanError(error), 'error');
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
    case 'start-server-pick': {
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const game = state.games.find((item) => item.id === gameId);
      const server = game && (game.servers || []).find((item) => item.id === serverId);
      closeStartServerMenu();
      if (!game || !server) {
        render({ preserveScroll: true });
        break;
      }
      if (!server.exists || server.incomplete) {
        openStartServerManager(gameId);
        break;
      }
      try {
        await api.servers.activate({ gameId, serverId });
        toast(`已切换到 ${server.name}`, 'success');
      } catch (error) {
        toast(humanError(error), 'error');
      }
      break;
    }
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
      const result = await api.games.detect(element.dataset.game || undefined);
      if (result.ok) toast('检测完成，服务器路径已更新', 'success');
      else toast(result.error || '没有检测到新的客户端', 'info');
      break;
    }
    case 'start-link': {
      const gameId = element.dataset.game;
      if (!gameId) break;
      openLinkModal(gameId);
      break;
    }
    case 'back-home':
      navigate('home');
      break;
    case 'minimize-window':
      await api.minimizeWindow();
      break;
    case 'window-minimize':
      await api.minimizeWindow();
      break;
    case 'window-maximize':
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
      state.gachaTab = 'overview';
      state.gachaScope = 'all';
      gachaEnsureSelection();
      render({ preserveScroll: true });
      break;
    case 'gacha-tab':
      state.gachaTab = element.dataset.value || 'overview';
      render({ preserveScroll: true });
      break;
    case 'gacha-scope':
      state.gachaScope = element.dataset.value || 'all';
      render({ preserveScroll: true });
      break;
    case 'gacha-five-filter':
      state.gachaFiveFilter = element.dataset.value || 'all';
      render({ preserveScroll: true });
      break;
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
        await handleAction('prepare-endfield', element.dataset.server, element);
      } else if (
        ['genshin', 'starrail', 'zzz'].includes(game.builtinKey) &&
        ['bilibili', 'global'].includes(server.channel)
      ) {
        openSophonModal(game.id, server.id, 'prepare');
      } else {
        openServerModal(game.id, server.id);
      }
      break;
    }
    case 'activate-server': {
      const result = await api.servers.activate({
        gameId: element.dataset.game,
        serverId: element.dataset.server,
      });
      const server = (result.servers || []).find((item) => item.id === result.activeServerId);
      const launch = await api.games.launch(result.id);
      if (!launch.ok) {
        if (launch.elevationRequired) {
          const restart = await confirmDialog({
            title: '需要管理员权限',
            message: launch.error,
            confirmText: '以管理员身份重启',
          });
          if (restart) await api.relaunchAdmin();
        } else {
          toast(`已切换到 ${server ? server.name : '新服务器'}，但启动失败：${launch.error}`, 'error');
        }
      } else {
        toast(`已切换到 ${server ? server.name : '新服务器'}，正在启动`, 'success');
      }
      break;
    }
    case 'prepare-endfield': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server = game && (game.servers || []).find((item) => item.id === element.dataset.server);
      toast('正在用渠道差异包创建链接运行时，请稍候…', 'info');
      const result = await api.servers.prepareEndfield({
        gameId: element.dataset.game,
        serverId: element.dataset.server,
      });
      toast(
        `已切换到 ${server ? server.name : '新服务器'}：链接 ${result.linked} 个文件，覆盖 ${result.overlay} 个差异文件`,
        'success'
      );
      break;
    }
    case 'prepare-sophon':
      openSophonModal(element.dataset.game, element.dataset.server, 'prepare');
      break;
    case 'update-sophon':
      openSophonModal(element.dataset.game, element.dataset.server, 'update');
      break;
    case 'restore-sophon':
      if (sophonUi) sophonUi.restore();
      break;
    case 'cancel-sophon-dock':
      if (sophonUi) sophonUi.cancel();
      break;
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
      const ok = await confirmDialog({
        title: '清除服务器路径',
        message: `只会清除「${server.name}」的路径记录，不会删除客户端文件，也不会移除这张服务器卡片。`,
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
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const result = await api.servers.activate({ gameId, serverId });
      const launch = await api.games.launch(gameId);
      if (!launch.ok) toast(launch.error, 'error');
      else toast(`正在启动 ${result.name}`, 'success');
      if (!state.settings.quickPanelPinned) quickOpen = false;
      renderQuickPanel();
      break;
    }
    case 'toggle-sidebar': {
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
      render({ preserveScroll: true });
      if (key === 'enabled' && state.sound.enabled) {
        playUiSound('click', true);
      } else if (key !== 'enabled' && state.sound.enabled && state.sound[key]) {
        playUiSound(key, true);
      }
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
      await api.updateSettings({ [key]: next });
      if (key === 'autoUpdateEndfieldPacks' && !next) {
        toast('已关闭后台自动更新；手动更新、切换服务器和启动游戏仍然可用', 'info');
      }
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
      if (target === 'record') {
        // 战绩页要知道具体看哪个功能；看哪款游戏由 navigate 里按登录态自动挑
        navigate('record', { feature: key });
        break;
      }
      navigate(target);
      if (target === 'screenshots') loadScreenshots(false);
      if (target === 'graphics') loadGraphics(state.graphicsGame);
      break;
    }
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

function field(label, input, hint = '', required = false) {
  return `<div class="field">
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

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(value / 1024))} KB`;
}

function renderTaskDock() {
  const dock = document.querySelector('#task-dock');
  const list = document.querySelector('#task-dock-list');
  if (!dock || !list) return;
  const visible = sophonJobs.filter((job) => ['queued', 'starting', 'running'].includes(job.status));
  if (!visible.length) {
    dock.hidden = true;
    document.body.classList.remove('sophon-minimized');
    return;
  }
  dock.hidden = false;
  list.innerHTML = `
    <div class="task-dock-head"><strong>硬链接任务</strong><span>${visible.length} 个</span></div>
    ${visible
      .map((job) => {
        const active = job.status === 'running' || job.status === 'starting';
        if (!active) {
          return `
            <div class="task-dock-item task-dock-queued">
              <span class="task-dock-icon">${icon('clock')}</span>
              <span class="task-dock-copy"><strong>${esc(job.serverName)}</strong><small>排队中 · ${esc(job.gameName)}</small></span>
              <button class="task-dock-stop" data-action="remove-sophon-queue" data-id="${esc(job.id)}" title="取消排队">✕</button>
            </div>`;
        }
        return `
          <div class="task-dock-item">
            <button class="task-dock-main" data-action="restore-sophon" title="展开任务">
              <span class="task-dock-icon">${icon('download')}</span>
              <span class="task-dock-copy">
                <strong>${job.mode === 'update' ? '更新' : '生成'} ${esc(job.serverName)}</strong>
                <small>${esc(job.percent >= 100 ? '完成' : job.phase || '准备中…')}${job.stats ? ` · ${esc(job.stats)}` : ''}</small>
                <span class="task-dock-bar"><span style="width:${Math.max(0, Math.min(100, job.percent || 0))}%"></span></span>
              </span>
            </button>
            <button class="task-dock-stop" data-action="cancel-sophon-dock" title="停止">✕</button>
          </div>`;
      })
      .join('')}`;
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
  if (!options.job && (activeSophonJob || sophonJobs.some((job) => ['starting', 'running'].includes(job.status)))) {
    sophonJobs.push({
      id: jobId,
      gameId,
      serverId,
      gameName: game.name,
      serverName: server.name,
      mode,
      status: 'queued',
      percent: 0,
      phase: '排队中',
      stats: '',
    });
    renderTaskDock();
    toast(`已加入硬链接队列：${server.name}`, 'info');
    return;
  }
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
  let unsubscribe = null;

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>${isUpdate ? '更新' : '硬链接安装'} ${esc(server.name)} 客户端</h2>
            <p>${esc(game.name)} · ${isUpdate ? '检查并安装官方更新' : '以官服为源，硬链接相同文件，只下载差异分块'}</p>
          </div>
          <div class="modal-head-actions">
            <button class="modal-close" id="sophon-minimize" style="display:none" title="最小化">−</button>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
        </div>
        <div class="modal-body">
          <div class="form-note form-note-warn">${icon('alert')}<span>${
            isUpdate
              ? '会对现有客户端逐文件校验，只下载版本不同或缺失的分块；启动器不会处理官方清单之外的删除项。更新期间不要启动游戏。'
              : '会先和官服客户端逐文件比较：完全相同的文件用硬链接复用，只下载不同或缺失的分块。目标版本可能需要数 GB 到数十 GB，请确认磁盘空间。过程中不要启动游戏。'
          }</span></div>
          <div class="sophon-target">
            <span>目标目录</span>
            <code id="sophon-target-dir">${esc(server.root || '自动：游戏盘\\VelaRuntimes')}</code>
            <button type="button" class="btn btn-ghost btn-sm" id="sophon-pick-dir">选择目录</button>
          </div>
          <div class="sophon-estimate" id="sophon-estimate">
            <span class="sophon-estimate-label">${icon('database', 'xs')}空间预估</span>
            <span class="sophon-estimate-body" id="sophon-estimate-body">正在结算磁盘和客户端体积…</span>
          </div>
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

  openModal(html, {
    onClose: () => {
      if (running) {
        cancelled = true;
        api.servers.cancelSophon(jobId).catch(() => {});
      } else {
        sophonJobs = sophonJobs.filter((item) => item !== job);
        renderTaskDock();
      }
    },
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
    document.body.classList.remove('sophon-minimized');
    renderTaskDock();
  };

  const minimizeTask = () => {
    if (!running) return;
    if (backdrop) backdrop.style.display = 'none';
    document.body.classList.remove('modal-open');
    document.body.classList.add('sophon-minimized');
    job.status = 'running';
    activeSophonJob = job;
    renderTaskDock();
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
  };

  const updateDock = (phaseLabel, percent, stats, current) => {
    job.phase = phaseLabel;
    job.percent = Math.max(0, Math.min(100, percent));
    job.stats = stats;
    job.current = current || '';
    if (activeSophonJob === job) renderTaskDock();
  };

  minimize.addEventListener('click', minimizeTask);

  /*
   * 空间预估：安装前先让用户看到「目标盘还剩多少、要装的东西有多大」，
   * 而不是等跑到一半才发现盘满了。只读本地信息，不走网络，不阻塞界面。
   */
  const estimateBody = document.querySelector('#sophon-estimate-body');
  const refreshEstimate = async () => {
    if (!estimateBody) return;
    estimateBody.textContent = '正在结算磁盘和客户端体积…';
    try {
      const result = await api.servers.prepareSophon({
        gameId,
        serverId,
        estimate: true,
        runtimeRoot: selectedRuntimeRoot || undefined,
      });
      if (!result || !result.ok) {
        estimateBody.textContent = (result && result.error) || '拿不到空间信息，直接开始也可以。';
        return;
      }
      const free = Number(result.freeBytes) || 0;
      const base = Number(result.baseBytes) || 0;
      const parts = [];
      if (free) parts.push(`目标盘（${result.drive || '未知'}）剩余 ${formatSize(free)}`);
      if (base) {
        parts.push(`官服客户端约 ${formatSize(base)}${result.partial ? '（还在继续统计）' : ''}`);
      }
      if (free && base && base > free) {
        parts.push('⚠ 客户端比剩余空间大，硬链接通常能省掉大部分，但仍建议先腾点空间');
      } else if (base) {
        parts.push('相同的文件会直接硬链接复用，实际新增占用通常远小于这个数');
      }
      estimateBody.textContent = parts.join(' · ') || '拿不到空间信息，直接开始也可以。';
    } catch (error) {
      estimateBody.textContent = '拿不到空间信息，直接开始也可以。';
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
      const label = document.querySelector('#sophon-target-dir');
      if (label) label.textContent = `${dir}（直接作为目标目录）`;
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
    unsubscribe = api.onSophonProgress((event) => {
      if (event.jobId !== jobId) return;
      const total = Number(event.total) || 0;
      const processed = Number(event.processed) || 0;
      const percent = total ? Math.min(100, (processed / total) * 100) : 0;
      const phases = {
        start: '读取官方清单',
        version: `目标版本 ${event.tag || ''}`,
        manifest: '下载清单',
        install: '写入文件',
        download: '下载分块',
        patch: '应用补丁',
        done: '完成',
      };
      document.querySelector('#sophon-phase').textContent = phases[event.phase] || '处理中…';
      document.querySelector('#sophon-count').textContent = total ? `${processed} / ${total}` : '';
      document.querySelector('#sophon-bar').style.width = `${event.phase === 'done' ? 100 : percent}%`;
      const stats = `硬链接 ${event.linked || 0} · 下载 ${event.downloaded || 0} · ${formatSize(event.bytesDone)} / ${formatSize(event.totalBytes)}`;
      document.querySelector('#sophon-stats').textContent = stats;
      document.querySelector('#sophon-current').textContent = event.current || '';
      updateDock(phases[event.phase] || '处理中…', event.phase === 'done' ? 100 : percent, stats, event.current || '');
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
        hideDock();
        toast('已停止生成，可以下次继续', 'info');
        return;
      }
      running = false;
      job.status = 'done';
      job.percent = 100;
      sophonJobs = sophonJobs.filter((item) => item !== job);
      hideDock();
      if (unsubscribe) unsubscribe();
      closeModal();
      toast(
        `${isUpdate ? '更新' : '生成'}完成（${result.tag}）→ ${result.targetRoot}：硬链接 ${result.linked}，下载 ${result.downloaded} 个文件`,
        'success'
      );
      startNextSophonJob();
    } catch (error) {
      job.status = cancelled ? 'cancelled' : 'error';
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
      start.textContent = '重新尝试';
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

function openLinkModal(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;
  const servers = game.servers || [];
  const usable = servers.filter((server) => server.exists);
  const option = (server) =>
    `<option value="${esc(server.id)}" ${server.exists ? '' : 'disabled'}>${esc(server.name)}${server.exists ? '' : ' · 未配置'}</option>`;
  const defaultSource = usable.find((server) => server.active) || usable[0];
  const defaultTarget = usable.find((server) => server.id !== (defaultSource && defaultSource.id)) || null;
  const canLink = usable.length >= 2;

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>硬链接去重</h2>
            <p>${esc(game.name)} · 把两个客户端中完全相同的文件合并为同一份数据。</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="form-note form-note-warn">${icon('alert')}<span>开始前请关闭游戏和官方启动器。只处理两边都存在、大小一致且内容哈希相同的文件；不同文件、独有文件和游戏存档都不会被修改或删除。首次建议使用“完整校验”。</span></div>
          ${
            canLink
              ? `<div class="field-row" style="margin-bottom:14px">
                  <div class="field" style="margin-bottom:0">
                    <label>源客户端 <span class="req">*</span></label>
                    <select class="select" id="link-source" style="width:100%">${usable.map(option).join('')}</select>
                  </div>
                  <div class="field" style="margin-bottom:0">
                    <label>目标客户端 <span class="req">*</span></label>
                    <select class="select" id="link-target" style="width:100%">${usable.map(option).join('')}</select>
                  </div>
                </div>
                <div class="field">
                  <label>校验方式</label>
                  <div class="mode-options">
                    <label class="mode-card">
                      <input type="radio" name="link-mode" value="full" checked />
                      <span><strong>完整校验</strong><small>逐文件 SHA-256，最可靠；大型客户端需要一些时间。</small></span>
                    </label>
                    <label class="mode-card">
                      <input type="radio" name="link-mode" value="fast" />
                      <span><strong>快速比较</strong><small>大小 + 首尾各 1MB，速度更快，适合先试跑。</small></span>
                    </label>
                  </div>
                </div>
                <details class="link-custom" style="margin-top:14px">
                  <summary><svg class="icon" aria-hidden="true"><use href="#i-folder"></use></svg> 自定义文件夹（可选）</summary>
                  <div class="field-row" style="margin-top:10px">
                    <div class="field" style="margin-bottom:0">
                      <label>源目录</label>
                      <div class="input-group">
                        <input id="link-source-root" placeholder="留空则使用源客户端的安装目录" spellcheck="false" />
                        <button type="button" class="btn btn-ghost" id="pick-link-source-root"><svg class="icon" aria-hidden="true"><use href="#i-folder"></use></svg>浏览</button>
                      </div>
                    </div>
                    <div class="field" style="margin-bottom:0">
                      <label>目标目录</label>
                      <div class="input-group">
                        <input id="link-target-root" placeholder="留空则使用目标客户端的安装目录" spellcheck="false" />
                        <button type="button" class="btn btn-ghost" id="pick-link-target-root"><svg class="icon" aria-hidden="true"><use href="#i-folder"></use></svg>浏览</button>
                      </div>
                    </div>
                  </div>
                  <p class="hint">有些客户端没有对应渠道的 .exe，但本机有完整游戏目录。指定两个目录后，硬链接只比较这两个文件夹，不受已配置服务器的限制。</p>
                </details>
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
                  <h3>还需要两个客户端</h3>
                  <p>至少配置两个服务器，并且都选择好启动程序，才能比较并建立硬链接。</p>
                  <button class="btn btn-ghost" data-close>先去配置</button>
                </div>`
          }
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
          ${
            canLink
              ? `<button class="btn btn-ghost" id="link-cancel" style="display:none">停止</button>
                 <button class="btn btn-primary" id="link-start">${icon('link')}开始建立硬链接</button>`
              : ''
          }
        </div>
      </div>
    </div>`;

  let running = false;
  let finished = false;
  let currentJobId = null;
  let unsubProgress = null;
  let unsubDone = null;

  openModal(html, {
    onClose: () => {
      if (unsubProgress) unsubProgress();
      if (unsubDone) unsubDone();
      if (running && currentJobId) api.servers.cancelLink(currentJobId).catch(() => {});
    },
  });

  if (!canLink) return;

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

  if (defaultSource) sourceSelect.value = defaultSource.id;
  if (defaultTarget) targetSelect.value = defaultTarget.id;

  function setProgress(p) {
    progress.style.display = 'block';
    const percent = p.total > 0 ? Math.min(100, (p.processed / p.total) * 100) : 0;
    bar.style.width = `${percent}%`;
    count.textContent = p.total > 0 ? `${p.processed} / ${p.total} 个候选` : '';
    saved.textContent = `已链接 ${p.linked || 0} 个 · 节省 ${fmtBytes(p.savedBytes || 0)}`;
    current.textContent = p.current || '';
    if (p.phase === 'scan') phase.textContent = '正在扫描两个客户端…';
    else if (p.phase === 'compare') phase.textContent = '正在比较文件内容…';
    else if (p.phase === 'link') phase.textContent = '正在建立硬链接…';
    else if (p.phase === 'done') phase.textContent = p.cancelled ? '已停止' : '正在收尾…';
  }

  unsubProgress = api.onLinkProgress((payload) => {
    if (!payload || payload.gameId !== gameId) return;
    if (running) {
      currentJobId = payload.jobId || currentJobId;
      cancelButton.style.display = '';
    }
    setProgress(payload);
  });

  unsubDone = api.onLinkDone((payload) => {
    if (!payload || payload.gameId !== gameId) return;
    finished = true;
    running = false;
    currentJobId = null;
    cancelButton.style.display = 'none';
    progress.style.display = 'block';
    bar.style.width = '100%';
    if (payload.ok) {
      phase.textContent = payload.cancelled ? '已停止' : '硬链接完成';
      count.textContent = `${payload.linked || 0} 个文件已合并`;
      saved.textContent = `节省约 ${fmtBytes(payload.savedBytes || 0)} 空间`;
      current.textContent = `检查 ${payload.total || 0} 个候选，跳过 ${payload.skipped || 0} 个${
        payload.errors && payload.errors.length ? `，${payload.errors.length} 个文件因占用失败` : ''
      }。`;
      startButton.textContent = '完成';
      startButton.disabled = true;
      toast(
        payload.cancelled
          ? '硬链接已停止，已经完成的文件保持合并'
          : `硬链接完成，节省约 ${fmtBytes(payload.savedBytes || 0)}`,
        'success'
      );
    } else {
      phase.textContent = '未能完成';
      current.textContent = payload.error || '未知错误';
      startButton.disabled = false;
      startButton.textContent = '重试';
    }
  });

  const linkSourceRoot = document.querySelector('#link-source-root');
  const linkTargetRoot = document.querySelector('#link-target-root');

  /* 每个游戏各自记住上次选的自定义目录，下次打开自动填回 */
  const linkRootsKey = `vela:link-roots:${gameId}`;
  try {
    const savedRoots = JSON.parse(localStorage.getItem(linkRootsKey) || 'null');
    if (savedRoots && typeof savedRoots === 'object') {
      if (savedRoots.source) linkSourceRoot.value = savedRoots.source;
      if (savedRoots.target) linkTargetRoot.value = savedRoots.target;
      if (savedRoots.source || savedRoots.target) {
        const details = document.querySelector('.link-custom');
        if (details) details.open = true;
      }
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
    if (picked) { linkSourceRoot.value = picked; }
  });
  document.querySelector('#pick-link-target-root').addEventListener('click', async () => {
    const picked = await api.pick.directory();
    if (picked) { linkTargetRoot.value = picked; }
  });

  startButton.addEventListener('click', async () => {
    if (running) return;
    if (sourceSelect.value === targetSelect.value) {
      error.textContent = '源客户端和目标客户端不能相同。';
      return;
    }
    error.textContent = '';
    running = true;
    finished = false;
    startButton.disabled = true;
    startButton.textContent = '处理中…';
    cancelButton.style.display = '';
    progress.style.display = 'block';
    phase.textContent = '正在准备…';
    rememberLinkRoots();
    try {
      const mode = document.querySelector('input[name="link-mode"]:checked').value;
      const result = await api.servers.link({
        gameId,
        sourceId: sourceSelect.value,
        targetId: targetSelect.value,
        mode,
        sourceRoot: linkSourceRoot.value.trim(),
        targetRoot: linkTargetRoot.value.trim(),
      });
      if (!finished) {
        finished = true;
        running = false;
        currentJobId = null;
        cancelButton.style.display = 'none';
        phase.textContent = result.cancelled ? '已停止' : '硬链接完成';
        current.textContent = `检查 ${result.total} 个候选，链接 ${result.linked} 个，跳过 ${result.skipped} 个。`;
        startButton.textContent = '完成';
        startButton.disabled = true;
      }
    } catch (err) {
      if (!finished) {
        running = false;
        cancelButton.style.display = 'none';
        startButton.disabled = false;
        startButton.textContent = '重试';
        phase.textContent = '未能完成';
        error.textContent = humanError(err);
      }
    }
  });

  cancelButton.addEventListener('click', async () => {
    if (!currentJobId) return;
    cancelButton.disabled = true;
    phase.textContent = '正在停止…';
    await api.servers.cancelLink(currentJobId).catch(() => {});
    cancelButton.disabled = false;
  });
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
  playUiSound('notify');
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
  const gamesChanged = JSON.stringify(previous.games) !== JSON.stringify(next.games || []);
  const settingsChanged = JSON.stringify(previous.settings) !== JSON.stringify(next.settings || {});
  const statsChanged = JSON.stringify(previous.stats) !== JSON.stringify(next.stats || {});
  const structuralChanged = gamesChanged || settingsChanged || statsChanged;

  state.games = next.games || [];
  state.settings = next.settings || {};
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

document.addEventListener('click', async (event) => {
  const feedback = event.target.closest('button, [data-nav], [data-action]');
  if (
    feedback &&
    !feedback.disabled &&
    feedback.dataset.noSound === undefined &&
    feedback.dataset.sound !== 'off'
  ) {
    playUiSound('click');
  }

  const close = event.target.closest('[data-close]');
  if (close) {
    closeModal();
    return;
  }

  /* 点在下拉外面就把它收起来 */
  if (!event.target.closest('.song-pop')) closeSongPops();

  const nav = event.target.closest('[data-nav]');
  if (nav) {
    /*
     * 「工具」父项同时是折叠开关：点它先展开/收起，
     * 并且在收起时也顺带跳到工具页（用户点「工具」多半就是想进去看看）。
     * 已展开状态下再点，只收起来，不重复跳转。
     */
    if (nav.dataset.action === 'nav-tools-toggle') {
      const opening = !state.navToolsOpen;
      state.navToolsOpen = opening;
      syncNavToolsOpen();
      if (opening) {
        /*
         * 展开后整个分组会变高，必须先等布局落地再量位置：
         * 直接读 getBoundingClientRect 会把「展开前」的旧高度算进去，
         * 结果滚动量偏小，工具组自己被顶到视口上方看不见。
         */
        const group = dom.navToolsGroup || nav;
        requestAnimationFrame(() => revealInSidebar(group));
        navigate('tools');
      }
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
  try {
    await handleAction(action, id, actionElement, event);
  } catch (error) {
    toast(humanError(error), 'error');
  }
});

document.addEventListener(
  'error',
  (event) => {
    const video = event.target.closest?.('video[data-start-video]');
    if (video) video.remove();
  },
  true
);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && dom.modalRoot.childElementCount) {
    closeModal();
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
    api.onToast((payload) => {
      if (payload && payload.message) toast(payload.message, payload.type || 'info');
    });
    api.onUpdateAvailable((info) => {
      if (!info || !info.hasUpdate) return;
      if (state.update && state.update.downloading) return;
      openUpdateModal(info);
    });

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
      state.update = { ...state.update, downloading: true, percent: Number(progress.percent) || 0 };
      setUpdateProgress(state.update.percent, progress.label);
      if (state.route === 'settings') {
        const bar = document.querySelector('.update-progress-bar span');
        if (bar) {
          bar.style.width = state.update.percent + '%';
          const label = document.querySelector('.update-progress small');
          if (label) label.textContent = progress.label || '正在下载 ' + state.update.percent + '%';
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


