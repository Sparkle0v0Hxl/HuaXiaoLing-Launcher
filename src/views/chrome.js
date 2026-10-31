'use strict';

/**
 * 视图层：chrome（外壳状态）与路由。
 *
 * 2026-10-31 从 app.js 拆出 —— 「前后端分离」第 4 批，也是 `src/views/` 的第一块。
 *
 * 这里装的是「整个界面怎么切」的控制流，不是某个页面的内容：
 *   · 设置落地：applyBackdrop / applySettings / applySettingLocally
 *   · 外壳刷新：updateChrome（侧栏徽章、标题、播放条、账号胶囊…）
 *   · 启动页导航抽屉：startNav* 一组 + readStartNavRoom 的宽度缓存
 *   · 路由：navigate（切页 + 焦点捕获/恢复 + 滚动位置记忆）
 *   · 启动页动态背景：liveStartArt / liveStartVideo / memoStartVideo /
 *     restoreStartVideo / handoffStartArt / bindStartArtVideo / setIdleMode
 *   · 主渲染循环：render —— 全项目所有状态变更最后都汇到这里
 *
 * 加载约定：普通 script，与 app.js 共享全局词法作用域。必须排在 app.js
 * **之前**（app.js 启动时会调 render）。反向依赖（renderHome、bindView、
 * updateSongChrome 等仍留在 app.js / song-ui.js）在调用时解析，不依赖顺序。
 *
 * 顶层只有函数声明与常量数据，没有立即执行的 DOM 访问 —— 因此可以安全地
 * 排在 `dom` 定义（app.js 顶部）之前加载。
 */

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
 * 窗口最小化 / 页面不可见：停循环视频 + 停装饰动画，别白烧 GPU。
 *
 * webPreferences.backgroundThrottling 是 false（缩在后台也要继续放歌），
 * 副作用是窗口缩到任务栏后，CSS 合成动画和 <video> 解码照跑 —— 启动页那个
 * 循环背景视频加上几十个 infinite 动画，不可见时纯浪费。
 * 只停视频、不动音频：最小化后继续听歌是想要的行为。
 * 恢复时只放「本来在放」的视频；用户手动暂停过的（memo.paused）不擅自恢复。
 */
let idlePausedVideo = null;

function setIdleMode(idle) {
  document.body.classList.toggle('is-idle', !!idle);
  const video = liveStartVideo();
  if (idle) {
    if (video && !video.paused && !video.ended) {
      idlePausedVideo = video;
      video.pause();
    }
    return;
  }
  const paused = idlePausedVideo;
  idlePausedVideo = null;
  if (!paused || !paused.isConnected) return;
  const memo = startVideoMemo;
  const userPaused =
    memo && memo.src && memo.src === (paused.getAttribute('src') || '') && memo.paused;
  if (!userPaused) paused.play().catch(() => {});
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
/*
 * 用户真的滚了（滚轮 / 按键 / 触摸 / 按住滚动条）就丢掉「命令式位置记忆」，
 * 下回重绘以实时值为准 —— 否则 setViewScroll 写进去的位置会一直生效，用户自己
 * 滚到别处后只要一重绘就被拽回去。
 *
 * 注意顺序：dom 是 app.js 里的 const，而本文件排在 app.js 之前加载。以前这段
 * 写在顶层，加载到这一行就 ReferenceError（chrome.js 从这里整个中断，
 * 监听器一次都没挂上，等于这段记忆只写不清），所以推迟到 DOMContentLoaded：
 * 那时 app.js 已经跑完，dom 已经建好。
 */
function bindViewScrollMemory() {
  const view = dom.view;
  if (!view) return;
  for (const type of ['wheel', 'keydown', 'touchstart', 'mousedown']) {
    view.addEventListener(type, () => {
      appliedViewScroll = null;
    }, { passive: true });
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindViewScrollMemory, { once: true });
} else {
  bindViewScrollMemory();
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
