'use strict';

/*
 * tools / news / official announcements —— 第 13 批从 app.js 搬出
 * （原 app.js 707–3994 行，3288 行逐行原样，逻辑零改动）。
 *
 * 按原顺序分六块：
 *   · 能力注册表：loadFeatures（读 electron/game-features.js 的 byCategory）
 *   · 米游社 / HoYoLAB：账号卡 / 登录 / 登出 / 切换（一套号带四款米家游戏）
 *   · 截图管理：缩略图按需装载（file:// 下走 IPC 取 data URL）+ 截图列表页
 *   · 插件（.hxl）：运行时装配 / 启动与停止 / 卡片 / 权限弹窗 / 插件页
 *   · 画质配置：缓存与静默刷新 / 各项控件 / 整页
 *   · 工具页：分类标签 / 侧栏「工具」分组 / Wiki 站点表 / 游戏分组面板 / 标签页
 *   · 战绩页：record 能力表 / 账号与角色行 / 指标与小件 / 标签页
 *   · 动态页：更新日志时间线 / 使用指南 / 置顶公告
 *   · 官方公告：站点表 / 公告卡片 / 整页 / 十分钟自动刷新
 *
 * 跨文件：本文件在 index.html 里排在 app.js 之前，函数体内读的 state / dom /
 * openModal / render 都在 app.js，运行时才有值。本文件顶层只有纯字面量常量
 * 与函数声明，没有任何 DOM 读取或立即执行的副作用。
 */

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
