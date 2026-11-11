'use strict';

/*
 * settings —— 第 14 批从 app.js 搬出（原 app.js 711–1343 行，633 行逐行原样，逻辑零改动）。
 *
 * 按原顺序分五块：
 *   · 开关组件：switchMarkup / soundSwitchMarkup / paintSwitch / paintSwitches
 *     （就地切 class 与 aria-checked，不走整页重绘，滑块过渡才跑得起来）
 *   · 设置回显：settingsSignature / expectSettingsEcho / consumeSettingsEcho
 *     （主进程回推 state 时判断「这次回推是不是我自己刚点的」，避免打架）
 *   · 界面缩放：setUiScale / stepUiScale（写设置 + 通知主进程 + 提示条）
 *   · 候选值表：THEME_OPTIONS / ACCENT_OPTIONS / SETTINGS_TABS / AUDIO_LANGUAGE_LABELS
 *   · 设置页：platformText / settingsTab / audioLanguagesOf / settingsView
 *     （左侧导航 + 右侧只渲染当前分组，避免一长条往下翻）
 *
 * 跨文件：本文件在 index.html 里排在 app.js 之前。顶层只有一组纯字面量常量表
 * 和 settingsEcho（初值 null），没有任何 DOM 读取或立即执行的副作用；
 * 函数体内读的 state / dom / api / render / toast 都在 app.js，调用时才解析名字。
 */

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
  ['games', '游戏', 'gamepad', '语音包、剧情资源、渠道包与运行时目录'],
  ['download', '下载', 'download', '下载目录、速度上限与网络代理'],
  ['data', '数据', 'database', '应用数据、设置备份与抽卡云备份'],
  ['files', '文件管理', 'trash', '分类查看占用，自己决定清掉哪些缓存'],
  ['update', '更新', 'refresh', '更新源、自动检查与手动更新'],
  ['system', '系统', 'shield', '管理员权限与提权启动'],
  ['community', '社区', 'link', '项目主页、发布页与问题反馈'],
  ['about', '关于', 'info', '版本信息与相关链接'],
];

/* ------------------------------------------------------------------ */
/* 网络代理：系统代理导入 + 连通性测试                                  */
/* ------------------------------------------------------------------ */

/*
 * 测试结果放在模块级变量里，不放 DOM。设置页每次重绘都会重建这段 HTML，
 * 存在 DOM 里的话一点开关就消失了；存在这里，重绘时还能照原样贴回去。
 */
let proxyProbe = null; // { state:'running'|'done', ok:boolean, text:string }

function proxyTestText() {
  if (!proxyProbe) return '';
  if (proxyProbe.state === 'running') return '正在测试，最多等 10 秒…';
  return proxyProbe.text || '';
}

/** 更新结果行；节点不在（用户切到别的分组）时只存内存，下次渲染自然带上 */
function setProxyProbe(next) {
  proxyProbe = next;
  const node = document.querySelector('#proxy-test-result');
  if (!node) return;
  node.textContent = proxyTestText();
  node.classList.toggle('is-ok', Boolean(next && next.state === 'done' && next.ok));
  node.classList.toggle('is-bad', Boolean(next && next.state === 'done' && !next.ok));
}

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

/* ------------------------------------------------------------------ */
/* 抽卡记录云备份                                                       */
/* ------------------------------------------------------------------ */

/*
 * 网盘预设：只放「官方自带 WebDAV」的那几家。
 * 百度网盘要走开放平台 OAuth，等于要求每个用户去注册开发者；夸克没有任何对外
 * API（私有协议 + 设备指纹，逆向既违规又随时失效）。这两家不给预设，
 * 用户确实有别的 WebDAV 服务就用「自定义」自己填。
 *
 * 第 3 项是点选后自动填进地址栏的模板，第 4 项是开通指引，
 * keywords 用来「从已填地址反推预设」——用户改过地址之后回来，
 * 高亮的仍然是对应的那一家，不会永远停在「自定义」。
 */
const GACHA_BACKUP_PRESETS = [
  [
    'custom',
    '自定义',
    '',
    '任何支持 WebDAV 的网盘 / NAS 都行，把完整地址填进来。优先用 https；只有在你自己内网的 NAS 上才填 http——http 的账号密码是明文上网的。',
    [],
  ],
  [
    '123pan',
    '123 云盘',
    'https://webdav.123pan.cn/webdav',
    '网页「工具中心 → 第三方挂载 → WebDAV 授权管理 → 添加应用」，勾上读写权限。应用密码只显示一次，记得当场存下来；地址以网页给出那串（webdav-xxx.pd1.123pan.cn/webdav）为准，账号就是手机号。需要会员。',
    ['123pan'],
  ],
  [
    'alipan',
    '阿里云盘',
    'https://openapi.alipan.com/dav',
    '网页「设置 → 第三方应用」授权后拿到第三方密码。账号填手机号，密码填那串第三方密码（不是登录密码）。需要会员。',
    ['alipan'],
  ],
  [
    'jianguo',
    '坚果云',
    'https://dav.jianguoyun.com/dav/',
    '网页「账户信息 → 安全选项 → 添加应用密码」，账号填登录邮箱，密码填那串应用密码。免费版每月 1GB 上传流量，抽卡记录这点体积完全够。',
    ['jianguoyun'],
  ],
  [
    'synology',
    '群晖 NAS',
    'https://你的域名:5006/',
    '群晖「控制面板 → 文件服务 → WebDAV」里开启 HTTPS（默认 5006，HTTP 是 5005）；账号密码就是 NAS 的账号。家里局域网可以直接填内网 IP。',
    ['5006', ':5005', 'synology'],
  ],
  [
    'nextcloud',
    'Nextcloud',
    'https://你的域名/remote.php/dav/files/用户名/',
    '地址里的「用户名」要换成你自己的。Nextcloud 网页左下角「文件设置 → WebDAV 地址」可以直接复制完整地址。',
    ['nextcloud', 'remote.php/dav'],
  ],
];

/** 云备份状态；没拿到之前给一份安全默认值，免得设置页首帧报错。 */
function gachaBackupState() {
  return (
    state.gachaBackup || {
      enabled: false,
      url: '',
      username: '',
      keep: 5,
      lastAt: 0,
      lastResult: '',
      lastError: '',
      hasPassword: false,
      hasSecret: false,
      intervalDays: 7,
    }
  );
}

/** 从已填地址反推预设；认不出来就当自定义。 */
function gachaBackupPresetKey() {
  const url = String(gachaBackupState().url || '').toLowerCase();
  if (!url) return 'custom';
  for (const [key, , , , keywords] of GACHA_BACKUP_PRESETS) {
    if (key === 'custom' || !keywords.length) continue;
    if (keywords.some((word) => url.includes(word))) return key;
  }
  return 'custom';
}

function gachaBackupPresetHint() {
  const preset = GACHA_BACKUP_PRESETS.find(([key]) => key === gachaBackupPresetKey());
  return preset ? preset[3] : GACHA_BACKUP_PRESETS[0][3];
}

function gachaBackupTimeText(ms) {
  const value = Number(ms) || 0;
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 一行状态。顺序很重要：没开启 → 配置不全 → 缺密码 → 上次失败 → 上次成功 → 等首次。
 * 「上次失败」优先于「上次成功」，否则用户看到的永远是那句成功，坏了他也不知道。
 */
function gachaBackupSummary() {
  const backup = gachaBackupState();
  const every = `每 ${Number(backup.intervalDays) || 7} 天自动一次`;
  if (!backup.enabled) return '当前未开启：抽卡记录只存在这台电脑上。';
  if (!backup.url || !backup.username) return '已开启，但网盘地址或账号还没填完。';
  if (!backup.hasPassword) return '已开启，但应用密码还没保存，跑不起来。';
  if (backup.lastError) return `上次备份没成功：${backup.lastError}`;
  if (backup.lastAt) {
    return `上次备份 ${gachaBackupTimeText(backup.lastAt)} · ${backup.lastResult || '已完成'} · ${every}`;
  }
  return `已开启，等首次自动备份（${every}）`;
}

/**
 * 读表单里用户刚填的值。保存、测试连接、点开关三处都用它，
 * 免得「点开关时刚打的地址还没保存就被重绘清空」。
 *
 * 表单不在当前分组时返回 null——那种情况下不能给主进程发空串，
 * 否则一次误调用就把已存好的地址和账号抹了。
 */
function gachaBackupFormPatch() {
  const urlInput = document.getElementById('gacha-backup-url');
  if (!urlInput) return null;
  const read = (id) => {
    const node = document.getElementById(id);
    return node ? String(node.value || '') : '';
  };
  return {
    url: read('gacha-backup-url').trim(),
    username: read('gacha-backup-user').trim(),
    // 空串＝沿用已存的那份（密码框回显不了明文，不能逼用户每次重填）
    password: read('gacha-backup-pass'),
    secret: read('gacha-backup-secret'),
  };
}

/* ------------------------------------------------------------------ */
/* 官方背景：跟随鹰角版本简报自动换的背景网格                             */
/* ------------------------------------------------------------------ */

/*
 * 和文件统计同一个套路：主进程拿列表（读目录 + manifest）不算重，但同步按钮
 * 要走网络，所以网格先渲染空态，列表回来再补画；同步走按钮自己的异步流程。
 */
let officialBgs = null;
let officialBgLoading = false;
let officialBgError = '';

function ensureOfficialBackgrounds() {
  if (officialBgs || officialBgLoading) return;
  if (!api.officialBackgroundState || typeof api.officialBackgroundState !== 'function') {
    officialBgError = '当前版本不支持官方背景';
    return;
  }
  officialBgLoading = true;
  const run = async () => {
    try {
      const state = await api.officialBackgroundState();
      officialBgs = state.backgrounds || [];
    } catch (error) {
      officialBgError = (error && error.message) || String(error);
    } finally {
      officialBgLoading = false;
      render({ preserveScroll: true });
    }
  };
  setTimeout(run, 0);
}

function officialBgGridHtml() {
  ensureOfficialBackgrounds();
  if (officialBgLoading) return '<div class="official-bg-grid"><div class="official-bg-hint">读取中…</div></div>';
  if (officialBgError) return `<div class="official-bg-grid"><div class="official-bg-hint">${esc(officialBgError)}</div></div>`;
  if (!officialBgs || !officialBgs.length) {
    return '<div class="official-bg-grid"><div class="official-bg-hint">还没有同步到官方背景，点上面的「同步官方背景」试试。</div></div>';
  }
  const active = typeof state.settings.customBackground === 'string' ? state.settings.customBackground : '';
  return `<div class="official-bg-grid">${officialBgs
    .map(
      (bg) => `
      <button class="official-bg-thumb${active === bg.relative ? ' is-active' : ''}" data-action="pick-official-bg" data-relative="${esc(bg.relative)}" title="设为背景" style="background-image:url('${esc(toFileUrl(bg.relative) || '')}')"></button>`
    )
    .join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* 文件管理：分类占用与清理                                              */
/* ------------------------------------------------------------------ */

/*
 * 分类数据来自主进程（electron/file-manager.js 的 GROUPS），前端只负责画。
 * 统计要扫几百 MB、上千个文件，不能在渲染里同步等，所以走「先渲染空态 → 拉回来再重绘」。
 */
let storageUsage = null;
let storageLoading = false;
let storageError = '';

function storageSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 统计结果回来之前不重复发请求；失败一次就不再自动重试，交给用户点「重新统计」。 */
function ensureStorageUsage() {
  if (storageUsage || storageLoading || storageError) return;
  refreshStorageUsage();
}

function refreshStorageUsage(force = false) {
  if (storageLoading && !force) return;
  if (!api.storage || typeof api.storage.usage !== 'function') {
    storageError = '当前版本不支持文件统计';
    return;
  }
  storageLoading = true;
  storageError = '';
  const run = async () => {
    try {
      storageUsage = await api.storage.usage();
    } catch (error) {
      storageError = (error && error.message) || String(error);
    } finally {
      storageLoading = false;
      render({ preserveScroll: true });
    }
  };
  // 放到下一帧：直接在这里 await 的话，会把正在进行的这次渲染挂住
  setTimeout(run, 0);
}

function storageCardHtml(group) {
  const empty = !group.bytes;
  const caution = group.risk === 'caution';
  return `
    <div class="storage-card${empty ? ' is-empty' : ''}">
      <div class="storage-card-head">
        <strong>${esc(group.label)}</strong>
        <span class="storage-size">${empty ? '0 B' : storageSize(group.bytes)}</span>
      </div>
      <p class="storage-note">${esc(group.note)}</p>
      <div class="storage-card-foot">
        <span class="storage-meta">${group.files} 个文件${caution ? ' · 清掉会影响正在进行的下载' : ''}</span>
        <button class="btn btn-ghost" data-action="clean-storage" data-id="${esc(group.id)}" ${empty ? 'disabled' : ''}>${icon('trash')}清理</button>
      </div>
    </div>`;
}

function storagePanelHtml() {
  if (storageError) {
    return `<div class="storage-state">
      <strong>统计失败</strong>
      <span>${esc(storageError)}</span>
      <button class="btn btn-ghost" data-action="refresh-storage">${icon('refresh')}重新统计</button>
    </div>`;
  }
  if (!storageUsage) {
    return `<div class="storage-state"><strong>正在统计…</strong><span>第一次打开会扫一遍数据目录，通常一两秒。</span></div>`;
  }
  const { totalBytes, cleanableBytes, safeBytes, groups } = storageUsage;
  return `
    <div class="storage-summary">
      <div class="storage-summary-copy">
        <strong>数据目录共 ${storageSize(totalBytes)}</strong>
        <span>其中可清理 ${storageSize(cleanableBytes)}，一键清理只动安全项那 ${storageSize(safeBytes)}；账号、设置、抽卡记录与你换过的封面都不在清理范围内。</span>
      </div>
      <div class="storage-summary-actions">
        <button class="btn btn-ghost" data-action="open-data-folder">${icon('external')}打开目录</button>
        <button class="btn btn-ghost" data-action="refresh-storage" title="重新统计">${icon('refresh')}</button>
        <button class="btn btn-primary" data-action="clean-storage-all" ${safeBytes ? '' : 'disabled'}>${icon('trash')}清理安全项</button>
      </div>
    </div>
    <div class="storage-list">${groups.map(storageCardHtml).join('')}</div>`;
}

/*
 * 关于页的正文原本是一整篇二十多段的小作文，密密麻麻堆在一起，
 * 想确认「某个功能到底有没有」只能通读一遍。
 * 现在改成分组要点：五组各三条短句，扫一眼就知道有没有想要的能力；
 * 版权与开源声明不属于「我能做什么」，收进底部折叠。
 */
function settingsView() {
  const settings = state.settings;
  const demos = state.games.filter((g) => g.demo).length;
  // 渠道包合并成一行之后，「就绪几个 / 一共几个」由这里一次算清（终末地 5 + 方舟 2）
  const packCount = channelPackCount(settings);
  // 云备份那几行的状态：开关、已填地址、上次结果都从这里取
  const backup = gachaBackupState();
  const backupPresetKey = gachaBackupPresetKey();
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
          <p class="desc">背景图与透明模糊效果</p>
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
          <div class="setting-row">
            <div class="setting-copy"><strong>官方背景（终末地）</strong><span>跟随鹰角官方启动器的版本简报换背景：启动器后台静默同步，官方换一期，这里就多一期。图片始终从官方 CDN 获取。</span></div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="sync-official-bg" id="sync-official-bg">${icon('refresh')}同步官方背景</button>
            </div>
          </div>
          ${officialBgGridHtml()}
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
          <div class="setting-row">
            <div class="setting-copy"><strong>背景动态效果</strong><span>缓慢运镜 + 鼠标轻微视差，背景不再是一张死图。系统开了「减少动态效果」时会自动关掉。</span></div>
            <div class="setting-control">${switchMarkup('backgroundMotion', settings.backgroundMotion !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>官方背景轮播</strong><span>只在用官方主视觉时生效：每 26 秒交叉淡入换下一张，素材来自你已经同步的官方背景。</span></div>
            <div class="setting-control">${switchMarkup('backgroundRotate', settings.backgroundRotate !== false)}</div>
          </div>
          <p class="material-note">${icon('alert', 'xs')}「透明效果」在 设置 → 个性化 → 颜色；关掉后所有材质失效。</p>
        </section>

        <section class="${group('appearance')} ui-scale-panel" ${groupAttr('appearance')}>
          <h2>${icon('type')}界面缩放</h2>
          <p class="desc">整体字号与布局缩放</p>
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
          <p class="desc">界面音效，与歌曲音量分开</p>
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
          <p class="desc">启动后音乐的行为</p>
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
          <p class="desc">托盘、开机自启与同步开关</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>关闭时收进托盘</strong><span>开启：点右上角 ✕ 只是收进托盘，画面还在后台跑，双击托盘图标可以回来。关闭：点 ✕ 直接退出启动器。第一次点 ✕ 时问过一次，之后都以这里为准。</span></div>
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
            <div class="setting-copy"><strong>自动同步抽卡记录</strong><span>打开游戏内抽卡记录后自动读取并同步；覆盖原神、星穹铁道、绝区零与终末地。</span></div>
            <div class="setting-control">${switchMarkup('autoGacha', settings.autoGacha !== false)}</div>
          </div>
        </section>

        <section class="${group('games', true)}" ${groupAttr('games')}>
          <h2>${icon('gamepad')}游戏与渠道包</h2>
          <p class="desc">语音包、剧情资源、渠道包与运行时目录</p>
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
              <strong>正式更新时用本地补丁省流（LDIFF）</strong>
              <span>只作用于「更新游戏」这一步，预下载不走它——预下载下多少，这个开关都不改变。开启后官方会给一份「从你当前版本到新版本」的差分补丁，先用它就地修补本地文件，剩下的才走分块下载，通常能省掉一半以上的下载量（具体看官方这次发了多少补丁）。代价是它会在更新过程中直接改写游戏文件，如果中途断网会留下「补了一半」的状态，重新更新一次能自动接上，也可以用「检查完整资源」修复。官方清单里 enable_ldiff 为 false 的渠道无论开关都不会生效：绝区零（全部渠道）、崩坏3。</span>
            </div>
            <div class="setting-control">${switchMarkup('enableLdiff', settings.enableLdiff !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>运行时目录</strong><span>终末地各渠道的硬链接运行时目录。留空时使用「游戏盘:\\VelaRuntimes」，必须和游戏同盘。每个渠道在其中的 endfield\\&lt;渠道&gt; 各占一个独立目录，切服从官服本体整树重建后只铺该渠道差异文件，不会删掉游戏本体和已下载的语音包。</span></div>
            <div class="setting-control">
              <span class="path-text" title="${esc(settings.runtimeRoot || '')}">${esc(settings.runtimeRoot || '自动：游戏盘:\\VelaRuntimes')}</span>
              <button class="btn btn-ghost" data-action="change-runtime-root">更改</button>
              ${settings.runtimeRoot ? `<button class="btn btn-quiet" data-action="reset-runtime-root">恢复默认</button>` : ''}
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动更新终末地渠道包</strong><span>切过终末地的服之后默认开启：启动时检查官方渠道 SDK，有新版本就替换本机已有的终末地渠道包。没切过服时保持关闭——那台机器上本来就没有包可更新，开了只会白跑一趟官方接口。</span></div>
            <div class="setting-control">${switchMarkup('autoUpdateEndfieldPacks', settings.autoUpdateEndfieldPacks === true)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动更新明日方舟渠道包</strong><span>切过明日方舟的服之后默认开启。和上面那条各管各的：只玩终末地时这边保持关闭，启动时不会去拉方舟的清单。</span></div>
            <div class="setting-control">${switchMarkup('autoUpdateArknightsPacks', settings.autoUpdateArknightsPacks === true)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>渠道包</strong>
              <span>${esc(endfieldPackSummary(settings))}</span>
              <span>${esc(arknightsPackSummary(settings))}</span>
            </div>
            <div class="setting-control">
              <span class="auto-badge ${packCount.ready ? 'is-ready' : 'is-pending'}">${packCount.ready ? `${packCount.ready} / ${packCount.total}` : '按需下载'}</span>
              <button class="btn btn-ghost" data-action="manage-endfield-packs">${icon('settings')}管理</button>
              <button class="btn btn-ghost" data-action="release-channel-packs">${icon('trash')}释放</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>明日方舟游戏本体</strong>
              <span>更新 / 修复只动游戏本体，不碰渠道包。</span>
            </div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="update-arknights-game">${icon('download')}更新游戏本体</button>
              <button class="btn btn-ghost" data-action="repair-arknights-game">${icon('refresh')}修复游戏</button>
            </div>
          </div>
        </section>
        <section class="${group('download', true)}" ${groupAttr('download')}>
          <h2>${icon('download')}下载与网络</h2>
          <p class="desc">下载目录、速度上限与网络代理</p>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>下载限速</strong>
              <span>给所有下载加一个总带宽上限，免得更新游戏时把宽带全占了、同一条网下别的设备看视频都卡。启动器自更新、原神/星穹铁道/绝区零/崩坏3 的更新与预下载、终末地的渠道包和差异包，全都算在这一个额度里（不是每个游戏各给一份）。<strong>拉到最左边＝不限速</strong>。改完立刻生效，正在跑的下载不用重开。</span>
            </div>
            <div class="setting-control volume-control">
              <input class="volume-range" id="download-limit" type="range" min="0" max="102400" step="1024" value="${(() => {
                // 滑块 0~102400 KB/s（0~100 MB/s，每档 1 MB/s），与 main.js 的夹取上限一致。
                const kb = Number(settings.downloadLimitKBps ?? 0) || 0;
                return Math.min(102400, Math.max(0, kb));
              })()}" aria-label="下载限速" />
              <span class="volume-value" id="download-limit-value">${(() => {
                const kb = Number(settings.downloadLimitKBps ?? 0) || 0;
                if (kb <= 0) return '不限速';
                return kb >= 1024 ? `${(kb / 1024).toFixed(kb % 1024 === 0 ? 0 : 1)} MB/s` : `${kb} KB/s`;
              })()}</span>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>下载文件夹</strong><span class="path-text" title="${esc(settings.downloadDir || '')}">${esc(settings.downloadDir || '')}</span></div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="change-download-dir">更改</button>
              <button class="btn btn-icon btn-ghost" data-action="open-download-folder" title="打开下载文件夹">${icon('external')}</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>网络代理</strong>
              <span>启动器自己发出去的请求（更新清单、更新包、封面、公告）走这个代理。只改程序内存里的配置，不写系统代理、不动注册表，关掉启动器对系统没有任何影响。填本地代理软件的地址即可：Clash 是 <code>http://127.0.0.1:7890</code>，v2rayN 是 <code>http://127.0.0.1:10809</code>，Socks5 写成 <code>socks5://127.0.0.1:1080</code>。<b>留空就是直连</b>——装了 Steam++ 这类工具的用户不用填，它靠改 hosts 生效，启动器会自动走。</span>
            </div>
            <div class="setting-control update-source-control">
              <input class="text-input" id="proxy-rules" value="${esc(settings.proxyRules || '')}" placeholder="留空 = 直连，例：http://127.0.0.1:7890" spellcheck="false" />
              <button class="btn btn-ghost" data-action="save-proxy-rules">保存</button>
              <button class="btn btn-ghost" data-action="import-system-proxy" title="读系统里已经配好的代理（Clash、v2rayN 开着的那个），自动填进左边的输入框">${icon('link')}用系统代理</button>
              <button class="btn btn-ghost" data-action="test-proxy" title="拿真实地址试一次，看这条代理到底通不通">${icon('refresh')}测试连接</button>
              <span class="proxy-test-result" id="proxy-test-result">${esc(proxyTestText())}</span>
            </div>
          </div>
        </section>
        <section class="${group('data', true)}" ${groupAttr('data')}>
          <h2>${icon('database')}数据与备份</h2>
          <p class="desc">应用数据、设置备份与抽卡云备份</p>
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
            <div class="setting-copy">
              <strong>启动器设置备份</strong>
              <span>把启动器设置导出成一个 JSON 文件（游戏配置、外观、云备份地址等），方便换电脑或重装前留一份；导入会按字段合并，不会覆盖本地已有的键。密码和加密口令存在另一个加密文件里，不在这份导出里。</span>
            </div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="export-settings">${icon('download')}导出</button>
              <button class="btn btn-ghost" data-action="import-settings">${icon('upload')}导入</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>抽卡记录云备份</strong>
              <span>把抽卡记录传到你自己网盘的 WebDAV 目录，${Number(backup.intervalDays) || 7} 天自动一次，也可以随时点「立即备份」。换电脑、重装系统之后用下面的「从云端恢复」找回来。只传抽卡记录本体和它的元数据缓存——账号密码、Cookie、下载记录、启动器设置一样都不传。</span>
              <span class="hint">${esc(gachaBackupSummary())}</span>
            </div>
            <div class="setting-control">
              <button class="switch ${backup.enabled ? 'on' : ''}" role="switch" aria-checked="${Boolean(backup.enabled)}" data-action="toggle-gacha-backup" title="${backup.enabled ? '关闭' : '开启'}"></button>
            </div>
          </div>
          <div class="setting-row gacha-backup-row">
            <div class="setting-copy">
              <strong>网盘类型</strong>
              <span>${esc(gachaBackupPresetHint())}</span>
              <span class="hint">百度网盘要走开放平台授权，等于要求每个用户去注册开发者；夸克没有对外接口。这两家不做预设，真要接只能自己填地址。</span>
            </div>
            <div class="setting-control">
              <div class="gacha-backup-presets">
                ${GACHA_BACKUP_PRESETS.map(
                  ([key, label]) =>
                    `<button class="btn btn-quiet ${key === backupPresetKey ? 'active' : ''}" data-action="gacha-backup-preset" data-value="${key}">${label}</button>`
                ).join('')}
              </div>
            </div>
          </div>
          <div class="setting-row gacha-backup-row">
            <div class="setting-copy">
              <strong>WebDAV 连接</strong>
              <span>应用密码和加密口令都走系统凭据加密（DPAPI）存在 sessions.enc.json 里，不会跟着配置写进明文。两项都留空＝沿用已保存的那份。</span>
            </div>
            <div class="setting-control">
              <div class="gacha-backup-form">
                <input class="text-input" id="gacha-backup-url" value="${esc(backup.url || '')}" placeholder="https://dav.jianguoyun.com/dav/" spellcheck="false" />
                <input class="text-input" id="gacha-backup-user" value="${esc(backup.username || '')}" placeholder="账号 / 邮箱" spellcheck="false" autocomplete="off" />
                <input class="text-input" id="gacha-backup-pass" type="password" placeholder="${backup.hasPassword ? '应用密码（已保存，留空不改）' : '应用密码'}" spellcheck="false" autocomplete="new-password" />
                <input class="text-input" id="gacha-backup-secret" type="password" placeholder="${backup.hasSecret ? '加密口令（已设置，留空不改）' : '加密口令（留空 = 明文上传）'}" spellcheck="false" autocomplete="new-password" />
                <div class="gacha-backup-actions">
                  <button class="btn btn-primary" data-action="save-gacha-backup">${icon('check')}保存</button>
                  <button class="btn btn-ghost" data-action="test-gacha-backup">${icon('server')}测试连接</button>
                  <button class="btn btn-ghost" data-action="gacha-backup-now" ${backup.enabled ? '' : 'disabled'}>${icon('save')}立即备份</button>
                </div>
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>从云端恢复</strong>
              <span>拉取云端最新一份，按记录 Id 去重合并进本地。只增不删：本地已有的记录一条都不会被覆盖，云端是旧机器传的也不会把新抽的卡冲掉。</span>
            </div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="gacha-backup-restore" ${backup.enabled ? '' : 'disabled'}>${icon('download')}从云端恢复</button>
            </div>
          </div>
        </section>
        <section class="${group('system', true)}" ${groupAttr('system')}>
          <h2>${icon('shield')}系统与权限</h2>
          <p class="desc">管理员权限与提权启动</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>始终以管理员身份启动</strong><span>终末地 / 明日方舟创建游戏进程时必须提权（官方客户端的限制，实测非提权直接 740）。开启后启动器自己以管理员运行，再开游戏就不会额外弹 UAC；第一次点「开始游戏」时会问你一次，选过就不再问。UAC 被拒绝或新实例没起来时会自动退回普通权限，不会出现双击打不开的情况。</span></div>
            <div class="setting-control">${switchMarkup('alwaysAdmin', settings.alwaysAdmin)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>管理员权限</strong><span>终末地启动必须提权。启动器不是管理员时会单独弹 UAC；已经是管理员（比如开了上一项）就不会再弹，这是正常的。</span></div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="relaunch-admin">以管理员身份重启</button>
            </div>
          </div>
        </section>

        <section class="${group('files', true)}" ${groupAttr('files')}>
          <h2>${icon('trash')}文件管理</h2>
          <p class="desc">按用途清缓存，不动账号与抽卡记录</p>
          ${
            tab === 'files'
              ? (() => {
                  ensureStorageUsage();
                  return storagePanelHtml();
                })()
              : ''
          }
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
          <p class="desc">内置更新源，下载后做 sha256 校验</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>更新源</strong><span>决定「检查更新」和「下载更新包」走哪条路。<b>自动</b>适合绝大多数人：按 Gitee → jsDelivr → GitHub 的顺序挨个试，哪个通用哪个。国内网络一直卡在「检查更新」或下载不动时，可以在下面锁死某一个源试试。</span></div>
            <div class="setting-control update-source-control">
              <select class="select" id="update-source-mode">
                <option value="auto"${esc(settings.updateSourceMode || 'auto') === 'auto' ? ' selected' : ''}>自动（推荐）</option>
                <option value="gitee"${settings.updateSourceMode === 'gitee' ? ' selected' : ''}>Gitee 镜像</option>
                <option value="jsdelivr"${settings.updateSourceMode === 'jsdelivr' ? ' selected' : ''}>jsDelivr</option>
                <option value="github"${settings.updateSourceMode === 'github' ? ' selected' : ''}>GitHub 直连</option>
                <option value="custom"${settings.updateSourceMode === 'custom' ? ' selected' : ''}>自定义地址</option>
              </select>
              <button class="btn btn-ghost" data-action="save-update-source-mode">保存</button>
              <button class="btn btn-ghost" data-action="pick-update-source">${icon('folder')}选择文件</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自定义地址</strong><span>只在上面选了「自定义地址」时生效。可以填自己的 https 地址、局域网共享（\\NAS\share\latest.json）或本地路径。ZIP 地址写在清单里，相对路径以清单所在目录为准。</span></div>
            <div class="setting-control update-source-control">
              <input class="text-input" id="update-manifest" value="${esc(settings.updateManifest || '')}" placeholder="留空 = 内置官方源" spellcheck="false" />
              <button class="btn btn-ghost" data-action="save-update-source">保存</button>
              <button class="btn btn-ghost" data-action="fill-mirror-source" title="${GITEE_MANIFEST_URL}">${icon('server')}填入 Gitee 镜像</button>
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
          <div class="setting-row">
            <div class="setting-copy">
              <strong>导出诊断信息</strong>
              <span>把版本、系统、代理与更新源设置、最近 240 条网络请求（只记地址、状态码、耗时，不含请求内容和任何账号密码），连同更新日志和崩溃日志，合并成一个 txt 放到桌面。遇到「更新失败」「封面不显示」这类问题时，把这个文件发回来最省事。</span>
            </div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="export-diagnostics">${icon('shield')}导出到桌面</button>
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
          <p class="desc">源码、版本说明与问题反馈</p>
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
          <p class="desc">本地优先的桌面游戏书架</p>
          <div class="setting-row" style="border-bottom:0;padding-bottom:0">
            <div class="about-block">
              <div class="about-name">花筱灵启动器</div>
              <div class="about-version">VERSION ${esc(state.app.version || '1.0.0')} · ELECTRON ${esc(state.app.electron || '')}</div>
              <div class="about-contact">
                <span class="about-contact-label">交流群</span>
                <button class="about-qq" data-action="copy-text" data-value="1018651207" title="点击复制群号">QQ 群 1018651207</button>
              </div>
              <div class="about-groups">
                ${[
                  ['更新', ['只下差异块，同盘有同内容就硬链接', '16 路并发，开跑前先算磁盘空间', '打不上自动回退完整包，清单带签名']],
                  ['游戏', ['内置 7 款入口，也能添加任意本地游戏', '切服共用客户端，启动页可切 DX11/DX12', '渠道包按服下，带进度与断点续传']],
                  ['战绩', ['米游社四款 + 终末地走森空岛', '便笺与周期玩法的星数、评级', '终末地可在页面上直接签到']],
                  ['工具', ['抽卡记录三池一页，保底与垫数', 'WebDAV 云备份，7 天一次、加密', '音乐台：多平台搜歌与弹幕点歌']],
                  ['排查', ['读系统代理并当场测速', '一键导出诊断 txt', '按七类清缓存，不动登录态']],
                ]
                  .map(
                    ([title, points]) =>
                      `<div class="about-group">
                        <h3>${esc(title)}</h3>
                        <ul>${points.map((point) => `<li>${esc(point)}</li>`).join('')}</ul>
                      </div>`
                  )
                  .join('')}
              </div>
              <details class="about-legal">
                <summary>素材版权与开源说明</summary>
                <p>界面与代码为原创实现；启动页与部分界面使用了《崩坏：星穹铁道》花火、火花等官方立绘素材，仅作爱好者桌面美化用途，版权归米哈游及各游戏官方所有。游戏版本号与封面会在联网时从官网同步并缓存，版权归各游戏官方所有。功能设计参考了 Starward（MIT）等开源启动器，不包含它们的代码或素材。</p>
                <p>游戏列表、设置、歌单、抽卡记录和时长都保存在本地，默认不上传；只有你自己打开「抽卡记录云备份」之后，抽卡记录才会加密传到你自己填的那个网盘。</p>
              </details>
              <div class="about-links">
                <button class="link-btn" data-action="open-changelog">${icon('file-text')}版本更新日志</button>
                <button class="link-btn" data-action="install-update">${icon('download')}导入更新包</button>
                <button class="link-btn" data-action="quit-app">退出启动器</button>
              </div>
            </div>
          </div>
        </section>
        </div>
      </div>
    </div>`;
}
