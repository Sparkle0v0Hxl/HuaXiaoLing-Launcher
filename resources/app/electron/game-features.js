'use strict';

/**
 * 游戏能力注册表 —— 全启动器唯一的「游戏 × 功能」真源。
 *
 * 设计目标
 * --------
 * 1. **加一个游戏只改这里**：在 GAMES 里加一条，各模块自动知道自己该不该出现。
 * 2. **加一个功能只改这里**：在 FEATURES 里加一条，再实现 traits 里对应的探测器，
 *    各页面自己按 featureOf() 决定显示什么，不需要到处写 if (game === 'genshin')。
 * 3. **能力探测可异步、可失败**：探测失败一律当作「暂不支持」，绝不抛到 UI。
 *
 * 三类描述符
 * ----------
 * - GAMES     游戏本体元数据（和 seed.js 的 builtinKey 对齐）
 * - FEATURES  功能清单（每日便笺、深渊、抽卡记录…）
 * - TRAITS    每个游戏对每个功能的支持方式与依赖（能力矩阵）
 *
 * 能力矩阵的取值
 * ------------
 * - { kind: 'db',        table: '...' }        读本地 SQLite 数据库
 * - { kind: 'game-record', api: '...' }        调米哈游 game_record 接口（要登录）
 * - { kind: 'self-query', table: '...' }       读米游社自助查询数据库
 * - { kind: 'log',        paths: [...] }       读游戏日志
 * - { kind: 'local' }                           纯本地计算（游玩时长、截图等）
 * - { kind: 'pack',      id: '...' }            基于游戏资源包（endfield-packs）
 * - null                                        明确不支持
 */

/* ------------------------------------------------------------------ */
/* 功能清单                                                            */
/* ------------------------------------------------------------------ */

const FEATURES = [
  {
    key: 'daily-note',
    name: '每日便笺',
    eyebrow: 'DAILY NOTE',
    desc: '体力、派遣、每日委托、周本等实时状态',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    key: 'gacha',
    name: '抽卡记录',
    eyebrow: 'WISHES',
    desc: '官方增量同步、卡池分类、出货统计',
    category: 'gacha',
    needsLogin: false,
  },
  {
    key: 'abyss',
    name: '深境螺旋',
    eyebrow: 'SPIRAL ABYSS',
    desc: '本期深境螺旋层数、队伍与用时',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    key: 'theater',
    name: '幻想真境剧诗',
    eyebrow: 'IMAGINARIUM',
    desc: '幕间挑战、祝福与角色使用情况',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    key: 'stygian',
    name: '幽境危战',
    eyebrow: 'STYGIAN',
    desc: '幽境危战关卡与得分',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    // 崩坏3 的「深渊」= 超弦空间；旧版的量子奇点已并入超弦空间
    key: 'ultra-endless',
    name: '超弦空间',
    eyebrow: 'ABYSS',
    desc: '本期深渊分组、扰动值与结算成绩',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    // 记忆战场：崩坏3 的周常 BOSS 挑战
    key: 'battle-field',
    name: '记忆战场',
    eyebrow: 'BATTLE FIELD',
    desc: '本周记忆战场 BOSS 与最高得分',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    key: 'forgotten-hall',
    name: '忘却之庭',
    eyebrow: 'FORGOTTEN HALL',
    desc: '本期忘却之庭层数与星级',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    key: 'pure-fiction',
    name: '虚构叙事',
    eyebrow: 'PURE FICTION',
    desc: '虚构叙事得分与队伍',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    key: 'apocalyptic-shadow',
    name: '末日幻影',
    eyebrow: 'APOCALYPTIC',
    desc: '末日幻影分数与队伍',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    // 模拟宇宙：星穹铁道的周常肉鸽，接口为 /hkrpg/api/rogue
    key: 'simulated-universe',
    name: '模拟宇宙',
    eyebrow: 'SIMULATED UNIVERSE',
    desc: '本期模拟宇宙进度、祝福与角色使用',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    key: 'shiyu-defense',
    name: '式舆防卫战',
    eyebrow: 'SHIYU',
    desc: '式舆防卫战层数、评级与用时',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    key: 'deadly-assault',
    name: '危局强袭战',
    eyebrow: 'DEADLY ASSAULT',
    desc: '危局强袭战分数与队伍',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    // 阈限模拟：绝区零的高难关卡，接口为 /zzz/void_front_battle_*
    key: 'threshold-simulation',
    name: '阈限模拟',
    eyebrow: 'THRESHOLD',
    desc: '阈限模拟主挑战与子挑战记录',
    category: 'record',
    needsLogin: true,
    site: 'game-record',
  },
  {
    key: 'play-time',
    name: '游玩时长',
    eyebrow: 'PLAY TIME',
    desc: '本机累计时长、启动次数与日程',
    category: 'local',
    needsLogin: false,
  },
  {
    key: 'screenshot',
    name: '截图管理',
    eyebrow: 'SCREENSHOT',
    desc: '扫描游戏截图目录，按时间归档浏览',
    category: 'local',
    needsLogin: false,
  },
  {
    key: 'graphics',
    name: '画质配置',
    eyebrow: 'GRAPHICS',
    desc: '读取并修改游戏内画质设置（注册表）',
    category: 'local',
    needsLogin: false,
  },
  {
    key: 'install-manager',
    name: '安装与更新',
    eyebrow: 'INSTALL',
    desc: '检测已安装版本、增量更新与校验',
    category: 'system',
    needsLogin: false,
  },
  {
    key: 'notice',
    name: '游戏公告',
    eyebrow: 'NOTICE',
    desc: '官方公告与活动信息',
    category: 'info',
    needsLogin: false,
  },
];

const FEATURE_MAP = new Map(FEATURES.map((item) => [item.key, item]));

/* ------------------------------------------------------------------ */
/* 游戏清单                                                            */
/* ------------------------------------------------------------------ */

/**
 * builtinKey 与 seed.js 的 BUILTIN_GAMES[].builtinKey 一一对应。
 * vendor / launcher 决定「这个游戏属于哪个发行方」，用来归类凭证与站点。
 */
const GAMES = [
  {
    key: 'genshin',
    name: '原神',
    subtitle: 'Genshin Impact',
    vendor: 'mihoyo',
    launcher: 'hyp',
    accent: '#7dd3c7',
    lastPage: 'gacha',
    login: {
      provider: 'miyoushe',
      methods: ['qrcode', 'sms', 'password'],
      note: '在米游社弹窗里扫码或输入手机号；登录后 cookie 同时可用于战绩查询',
    },
  },
  {
    key: 'starrail',
    name: '崩坏：星穹铁道',
    subtitle: 'Honkai: Star Rail',
    vendor: 'mihoyo',
    launcher: 'hyp',
    accent: '#b49bff',
    login: {
      provider: 'miyoushe',
      methods: ['qrcode', 'sms', 'password'],
      note: '同原神，一套米游社登录覆盖四款米家游戏',
    },
  },
  {
    key: 'zzz',
    name: '绝区零',
    subtitle: 'Zenless Zone Zero',
    vendor: 'mihoyo',
    launcher: 'hyp',
    accent: '#ffb347',
    login: {
      provider: 'miyoushe',
      methods: ['qrcode', 'sms', 'password'],
      note: '同原神',
    },
  },
  {
    key: 'bh3',
    name: '崩坏3',
    subtitle: 'Honkai Impact 3rd',
    vendor: 'mihoyo',
    launcher: 'hyp',
    accent: '#7db2ff',
    login: {
      provider: 'miyoushe',
      methods: ['qrcode', 'sms', 'password'],
      note: '同原神；崩坏3 的战绩接口托管在 act-api-takumi，走同一套 DS2 签名',
    },
  },
  {
    key: 'endfield',
    name: '明日方舟：终末地',
    subtitle: 'Arknights: Endfield',
    vendor: 'hypergryph',
    launcher: 'endfield',
    accent: '#f0c674',
    login: {
      provider: 'hypergryph',
      methods: ['qrcode', 'sms', 'password'],
      note: '走鹰角通行证网页登录，抓 loginToken 后换 u8_token；抽卡记录靠它',
    },
  },
  {
    key: 'neverness',
    name: '异环',
    subtitle: 'Neverness to Everness',
    vendor: 'perfectworld',
    launcher: 'nte',
    accent: '#89c2a8',
    login: {
      provider: 'perfectworld',
      methods: ['password'],
      note: '完美世界通行证；目前只用于启动游戏，官方暂无对外战绩接口',
    },
  },
  {
    key: 'arknights',
    name: '明日方舟',
    subtitle: 'Arknights',
    vendor: 'hypergryph',
    launcher: 'endfield',
    accent: '#c9d1d9',
    /*
     * PC 端 2026-02-10 技术性开放测试、2026-09-14 正式上线，
     * 和终末地共用鹰角启动器（GRYPHLINK）；账号是鹰角通行证或 bilibili。
     *
     * 安装目录默认在 <盘>\Arknights（游戏本体，Unity + ACE 反作弊），
     * 入口是 Arknights.exe。分发和终末地同构：<base>/game_files 是加密逐文件
     * 清单（实测 13749 个文件 / 23.66GB），另外还给 20 卷 43.7GB 整包 ZIP 兜底。
     */
    exeNames: ['Arknights.exe'],
    installDirs: ['Arknights', 'Arknights\\games\\Arknights Game'],
    login: {
      provider: 'hypergryph',
      methods: ['qrcode', 'sms', 'password'],
      note: '鹰角通行证；也可用 bilibili 账号（仅限 bilibili 渠道的鹰角启动器）',
    },
  },
];

const GAME_MAP = new Map(GAMES.map((item) => [item.key, item]));

/* ------------------------------------------------------------------ */
/* 能力矩阵：游戏 × 功能                                                */
/* ------------------------------------------------------------------ */

/**
 * 只写「这个游戏支持什么」，不支持的一律省略。
 * module 探测器读完能力矩阵后，会自动把没写的键补成 null。
 */
const TRAITS = {
  genshin: {
    'daily-note': { kind: 'game-record', api: '/game_record/genshin/api/dailyNote' },
    gacha: { kind: 'db', table: 'GenshinGachaItem' },
    abyss: { kind: 'game-record', api: '/game_record/genshin/api/spiralAbyss' },
    theater: { kind: 'game-record', api: '/game_record/genshin/api/role_combat' },
    stygian: { kind: 'game-record', api: '/game_record/genshin/api/stygian_onslaught' },
    'play-time': { kind: 'local' },
    screenshot: { kind: 'local' },
    graphics: { kind: 'registry', key: 'HKCU\\Software\\miHoYo\\原神' },
    'install-manager': { kind: 'hyp' },
    notice: { kind: 'notice', api: 'genshin' },
  },
  starrail: {
    'daily-note': { kind: 'game-record', api: '/game_record/starrail/api/dailyNote' },
    gacha: { kind: 'db', table: 'StarRailGachaItem' },
    'forgotten-hall': { kind: 'game-record', api: '/game_record/starrail/api/challenge' },
    'pure-fiction': { kind: 'game-record', api: '/game_record/starrail/api/challenge_story' },
    'apocalyptic-shadow': { kind: 'game-record', api: '/game_record/starrail/api/challenge_boss' },
    'simulated-universe': { kind: 'game-record', api: '/game_record/starrail/api/rogue' },
    'play-time': { kind: 'local' },
    screenshot: { kind: 'local' },
    graphics: { kind: 'registry', key: 'HKCU\\Software\\miHoYo\\崩坏：星穹铁道' },
    'install-manager': { kind: 'hyp' },
    notice: { kind: 'notice', api: 'starrail' },
  },
  zzz: {
    'daily-note': { kind: 'game-record', api: '/game_record/zzz/api/dailyNote' },
    gacha: { kind: 'db', table: 'ZZZGachaItem' },
    'shiyu-defense': { kind: 'game-record', api: '/game_record/zzz/api/challenge' },
    'deadly-assault': { kind: 'game-record', api: '/game_record/zzz/api/deadly_assault' },
    'threshold-simulation': { kind: 'game-record', api: '/game_record/zzz/api/void_front_battle_abstract_info' },
    'play-time': { kind: 'local' },
    screenshot: { kind: 'local' },
    graphics: { kind: 'registry', key: 'HKCU\\Software\\miHoYo\\绝区零' },
    'install-manager': { kind: 'hyp' },
    notice: { kind: 'notice', api: 'zzz' },
  },
  bh3: {
    'daily-note': { kind: 'game-record', api: '/game_record/bh3/api/note' },
    'ultra-endless': { kind: 'game-record', api: '/game_record/bh3/api/super_abyss' },
    'battle-field': { kind: 'game-record', api: '/game_record/bh3/api/battle_field' },
    'play-time': { kind: 'local' },
    screenshot: { kind: 'local' },
    graphics: { kind: 'registry', key: 'HKCU\\Software\\miHoYo\\崩坏3' },
    'install-manager': { kind: 'hyp' },
    notice: { kind: 'notice', api: 'bh3' },
  },
  endfield: {
    gacha: { kind: 'db', table: 'GachaImport' },
    'play-time': { kind: 'local' },
    screenshot: { kind: 'local' },
    'install-manager': { kind: 'pack', id: 'endfield' },
    notice: { kind: 'notice', api: 'endfield' },
  },
  neverness: {
    gacha: { kind: 'db', table: 'GachaImport' },
    'play-time': { kind: 'local' },
    screenshot: { kind: 'local' },
    'install-manager': { kind: 'pack', id: 'neverness' },
    notice: { kind: 'notice', api: 'neverness' },
  },
  arknights: {
    'play-time': { kind: 'local' },
    screenshot: { kind: 'local' },
    'install-manager': { kind: 'pack', id: 'arknights' },
    notice: { kind: 'notice', api: 'arknights' },
  },
};

/* ------------------------------------------------------------------ */
/* 登录方式                                                            */
/* ------------------------------------------------------------------ */

/**
 * 每个发行方一套登录协议，游戏级只决定进哪个站点。
 *
 * 参考 Starward（Scighost/Starward）的 GameRecord/LoginPage：
 * - 内嵌 WebView 打开米游社（国服）/ HoYoLAB（国际服）主页，
 *   注入脚本自动点右上角头像唤出登录框，
 *   用户在网页里扫码或输账号密码，登录完点「完成」；
 * - 取该站点的全部 cookie 拼成 `k=v; k=v` 交给后续接口；
 * - 角色列表走 `passport-api.mihoyo.com/binding/api/getUserGameRolesByCookieToken`，
 *   这个接口**不需要 DS 签名**；其余 game_record 接口要 DS2
 *   = md5(`salt=${salt2}&t=${t}&r=${r}&b=${b}&q=${q}`)，salt2 为 xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs。
 *
 * 各游戏在本启动器里的登录入口是哪个，见 GAMES[].login。
 */
const LOGIN_PROVIDERS = {
  /** 米游社（国服）：扫码 / 手机验证码 / 账号密码 都在弹出框里 */
  miyoushe: {
    id: 'miyoushe',
    label: '米游社',
    home: 'https://www.miyoushe.com/',
    // 各游戏专区页，登录后 cookie 域更完整
    site: {
      genshin: 'https://www.miyoushe.com/ys/',
      starrail: 'https://www.miyoushe.com/sr/',
      zzz: 'https://www.miyoushe.com/zzz/',
      bh3: 'https://www.miyoushe.com/bh3/',
    },
    cookieDomains: ['miyoushe.com', 'mihoyo.com', 'hoyolab.com'],
    // Starward 用的就是这套：等 header__avatarwrp 出现就点它
    openDialogScript: `
      if (window.location.host === 'www.miyoushe.com') {
        var id = setInterval(function () {
          var ele = document.getElementsByClassName('header__avatarwrp');
          if (ele.length > 0) { clearInterval(id); ele[0].click(); }
        }, 100);
      } else if (window.location.host === 'www.hoyolab.com') {
        var id2 = setInterval(function () {
          var ele = document.getElementsByClassName('header-avatar');
          if (ele.length > 0) { clearInterval(id2); ele[0].click(); }
        }, 100);
      }
    `,
    // 除了点头像，直接开登录弹窗页更稳（用户不点也能出二维码）
    directLogin: {
      url: 'https://user.mihoyo.com/#/login/password',
      note: '二维码登录请用米游社首页右上角头像',
    },
    methods: ['qrcode', 'sms', 'password'],
    api: {
      roleList: 'https://passport-api.mihoyo.com/binding/api/getUserGameRolesByCookieToken',
      record: 'https://api-takumi-record.mihoyo.com',
      salt2: 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs',
      refererRecord: 'https://webstatic.mihoyo.com/',
      refererAct: 'https://act.mihoyo.com/',
    },
    gameBiz: { genshin: 'hk4e_cn', starrail: 'hkrpg_cn', zzz: 'nap_cn', bh3: 'bh3_cn' },
  },
  /** HoYoLAB（国际服） */
  hoyolab: {
    id: 'hoyolab',
    label: 'HoYoLAB',
    home: 'https://www.hoyolab.com/home',
    site: {},
    cookieDomains: ['hoyolab.com', 'mihoyo.com'],
    openDialogScript: `
      if (window.location.host === 'www.hoyolab.com') {
        var id = setInterval(function () {
          var ele = document.getElementsByClassName('header-avatar');
          if (ele.length > 0) { clearInterval(id); ele[0].click(); }
        }, 100);
      }
    `,
    methods: ['qrcode', 'sms', 'password'],
    api: {
      roleList: 'https://sg-public-api.hoyolab.com/binding/api/getUserGameRolesByCookieToken',
      record: 'https://sg-public-api.hoyolab.com',
      salt2: 'okr4obncj8bw5a65hbnn5oo6ixjc3l9w',
      refererRecord: 'https://act.hoyolab.com/',
      refererAct: 'https://act.hoyolab.com/',
    },
    gameBiz: { genshin: 'hk4e_global', starrail: 'hkrpg_global', zzz: 'nap_global', bh3: 'bh3_global' },
  },
  /**
   * 鹰角通行证：终末地 / 明日方舟。
   * 没有公开的米哈游式 cookie 体系，本启动器用的是「网页登录抓 loginToken →
   * as.hypergryph.com/user/oauth2/v2/grant 换 oauth → binding → u8_token」，
   * 实现在 electron/endfield-gacha.js。
   */
  hypergryph: {
    id: 'hypergryph',
    label: '鹰角通行证',
    home: 'https://user.hypergryph.com/',
    cookieDomains: ['hypergryph.com', 'gryphline.com'],
    openDialogScript: '',
    methods: ['qrcode', 'sms', 'password'],
    api: {
      grant: 'https://as.hypergryph.com/user/oauth2/v2/grant',
      binding: 'https://binding-api-account-prod.hypergryph.com/account/binding/v1',
    },
    gameBiz: { endfield: 'endfield', arknights: 'arknights' },
  },
  /** 完美世界通行证：异环（2026-10 公测，官方无战绩接口） */
  perfectworld: {
    id: 'perfectworld',
    label: '完美世界通行证',
    home: 'https://yh.wanmei.com/',
    cookieDomains: ['perfectworld.com', 'wanmei.com'],
    /* 官网的登录弹窗是「获取验证码」+ 账号密码两套入口 */
    openDialogScript: '',
    methods: ['sms', 'password'],
    api: {},
    gameBiz: { neverness: 'nte_cn' },
  },
  /** 库街区（库洛）：鸣潮 / 战双，未内置，留给后续扩展 */
  kuro: {
    id: 'kuro',
    label: '库街区',
    home: 'https://www.kurobbs.com/',
    cookieDomains: ['kurobbs.com', 'kurogame.com'],
    openDialogScript: '',
    methods: ['qrcode', 'sms', 'password'],
    api: { roleList: 'https://api.kurobbs.com/user/role/list' },
    gameBiz: { wuthering: 'mc', punishi: 'pgr' },
  },
};

/** 登录方式的中英文说明，给 UI 直接展示。 */
const LOGIN_METHOD_LABEL = {
  qrcode: '扫码登录',
  sms: '手机验证码',
  password: '账号密码',
  cookie: '浏览器 Cookie',
  token: '令牌粘贴',
};

/* ------------------------------------------------------------------ */
/* 查询接口                                                            */
/* ------------------------------------------------------------------ */

function normalizeKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  // 兼容 'builtin-genshin' / 'Genshin' / 'endfield'
  const stripped = value.replace(/^builtin-/i, '');
  const lower = stripped.toLowerCase();
  if (GAME_MAP.has(lower)) return lower;
  const byBuiltin = GAMES.find((game) => game.key.toLowerCase() === lower || game.subtitle.toLowerCase() === lower);
  return byBuiltin ? byBuiltin.key : lower;
}

function listFeatures() {
  return FEATURES.map((item) => ({ ...item }));
}

function listGames() {
  return GAMES.map((item) => ({ ...item }));
}

/** 某个游戏对某个功能的支持描述；不支持返回 null。 */
function traitOf(gameKey, featureKey) {
  const key = normalizeKey(gameKey);
  const table = TRAITS[key];
  if (!table) return null;
  return table[featureKey] || null;
}

/** 某游戏支持的全部功能键。 */
function featuresOf(gameKey) {
  const key = normalizeKey(gameKey);
  const table = TRAITS[key] || {};
  return FEATURES.filter((feature) => table[feature.key]).map((feature) => feature.key);
}

/** 某功能的全部支持游戏键。 */
function gamesOf(featureKey) {
  return GAMES.filter((game) => (TRAITS[game.key] || {})[featureKey]).map((game) => game.key);
}

/**
 * 供渲染层一次性拉取的完整描述符。
 * 页面据此决定「这个游戏要不要显示某个入口」，不需要自己再判断。
 */
function describe(gameKey) {
  const key = normalizeKey(gameKey);
  const game = GAME_MAP.get(key) || null;
  const table = TRAITS[key] || {};
  const features = FEATURES.map((feature) => ({
    key: feature.key,
    name: feature.name,
    eyebrow: feature.eyebrow,
    desc: feature.desc,
    category: feature.category,
    needsLogin: feature.needsLogin,
    supported: Boolean(table[feature.key]),
    trait: table[feature.key] || null,
  }));
  return {
    game,
    login: loginOf(key),
    features,
    supported: features.filter((item) => item.supported).map((item) => item.key),
  };
}

/** 全量描述符，用于前端构建导航与能力页。 */
function describeAll() {
  return {
    games: listGames(),
    features: listFeatures(),
    matrix: Object.fromEntries(GAMES.map((game) => [game.key, featuresOf(game.key)])),
    providers: Object.fromEntries(
      Object.entries(LOGIN_PROVIDERS).map(([key, provider]) => [
        key,
        {
          id: provider.id,
          label: provider.label,
          home: provider.home,
          methods: provider.methods,
          methodLabels: provider.methods.map((m) => LOGIN_METHOD_LABEL[m] || m),
          /*
           * 这套通行证背后有哪些游戏（key 用 GAMES 里的 key）。
           * 前端据此在卡片标题下写明「这套号能带哪些游戏」，
           * 加新游戏时不用再改前端。
           */
          games: GAMES.filter((game) => game.login && game.login.provider === key).map((game) => game.key),
        },
      ])
    ),
    methodLabels: { ...LOGIN_METHOD_LABEL },
  };
}

/** 某游戏的登录描述符：{ provider, providerLabel, home, methods, methodLabels, note } */
function loginOf(gameKey) {
  const game = GAME_MAP.get(normalizeKey(gameKey));
  if (!game || !game.login) return null;
  const provider = LOGIN_PROVIDERS[game.login.provider];
  if (!provider) return null;
  return {
    game: game.key,
    provider: provider.id,
    providerLabel: provider.label,
    home: provider.site?.[game.key] || provider.home,
    methods: game.login.methods || provider.methods,
    methodLabels: (game.login.methods || provider.methods).map((m) => LOGIN_METHOD_LABEL[m] || m),
    note: game.login.note || '',
  };
}

/** 按分类分组的功能，用于「功能中心」之类的页面。 */
function featuresByCategory() {
  const groups = new Map();
  for (const feature of FEATURES) {
    if (!groups.has(feature.category)) groups.set(feature.category, []);
    groups.get(feature.category).push({ ...feature });
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}

module.exports = {
  FEATURES,
  GAMES,
  TRAITS,
  LOGIN_PROVIDERS,
  LOGIN_METHOD_LABEL,
  normalizeKey,
  listFeatures,
  listGames,
  traitOf,
  featuresOf,
  gamesOf,
  loginOf,
  describe,
  describeAll,
  featuresByCategory,
  featureOf: (key) => FEATURE_MAP.get(String(key || '')) || null,
  gameOf: (key) => GAME_MAP.get(normalizeKey(key)) || null,
};
