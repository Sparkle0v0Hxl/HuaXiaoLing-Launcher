'use strict';

/**
 * 账号中心 —— 侧栏左下角头像点开的浮层。
 *
 * 为什么要单独做这一块：
 *   以前点左下角那个「头像 + 名字」是直接跳设置页，米游社 / HoYoLAB 账号、
 *   抽卡 SToken 账号散在「工具」页和「抽卡」页的弹窗里，找起来费劲。
 *   这里把三类账号收进一个浮层：左边切换分区，右边看账号和角色，跟胡桃
 *   那个账号面板的用法一致。
 *
 * 编写约定（和这个仓库其它视图文件一样）：
 *   · 普通 <script>，共享全局词法作用域，不是 ESM
 *   · 一律用单引号字符串数组 + join('\n') 拼 HTML，不用模板字面量 ——
 *     这个仓库在模板字面量上反复踩过引号打架的坑
 *   · 按钮全部走事件委托，重绘后监听不会丢
 */

/*
 * 角色胶囊上显示的游戏名。
 * 崩坏3 已经整块从抽卡里摘掉了（官方没有补给记录接口），
 * 所以这里也不再列它 —— 老存档里残留的 bh3 角色会被下面兜底成原样的 key。
 */
const GACHA_TOKEN_GAME_NAMES = {
  genshin: '原神',
  starrail: '崩坏：星穹铁道',
  zzz: '绝区零',
};

const ACCT_TABS = [
  { id: 'miyoushe', label: '米游社', icon: 'login', hint: '国服通行证' },
  { id: 'hoyolab', label: 'HoYoLAB', icon: 'gamepad', hint: '国际服通行证' },
  { id: 'hypergryph', label: '鹰角账号', icon: 'server', hint: '明日方舟' },
  { id: 'perfectworld', label: '完美通行证', icon: 'shield', hint: '异环' },
  { id: 'gacha', label: '抽卡账号', icon: 'gacha', hint: 'SToken 账号' },
];

/* 弹窗状态（模块级的，重绘时靠它决定画什么） */
const acctState = {
  tab: 'miyoushe',
  loading: false,
  miyoushe: null,
  hoyolab: null,
  hypergryph: null,
  perfectworld: null,
  gacha: null,
  profiles: {},
  busy: '',
  error: '',
};

function acctReset() {
  acctState.tab = 'miyoushe';
  acctState.loading = false;
  acctState.miyoushe = null;
  acctState.hoyolab = null;
  acctState.hypergryph = null;
  acctState.perfectworld = null;
  acctState.gacha = null;
  acctState.profiles = {};
  acctState.busy = '';
  acctState.error = '';
}

/** 昵称首字做文字头像 —— 拿不到社区头像时的退路。 */
function acctInitial(name) {
  const text = String(name || '').trim();
  return text ? text.slice(0, 1) : '?';
}

/**
 * 头像：有 url 就上图，没有就是文字圆标。
 * referrerpolicy 必须带 —— 米哈游图床会校验来源，不带就是 403。
 * 图片加载失败时靠 CSS 兜底（圆标底色 + 首字在 ::after），不写内联 onerror：
 * 内联事件在 CSP 收紧后会直接被拦，而且拼字符串时还要再转义一层引号，很脆。
 */
function acctAvatarHtml(url, name, size) {
  const cls = 'acct-avatar' + (size === 'sm' ? ' is-sm' : '');
  const initial = esc(acctInitial(name));
  if (url) {
    return (
      '<span class="' + cls + ' has-img">' +
      '<img src="' + esc(url) + '" alt="" referrerpolicy="no-referrer">' +
      '<i aria-hidden="true">' + initial + '</i>' +
      '</span>'
    );
  }
  return '<span class="' + cls + '"><i aria-hidden="true">' + initial + '</i></span>';
}

/** 通行证分区要用的数据（米游社 / HoYoLAB 共用一套结构，鹰角单独一份）。 */
function acctProviderData(tab) {
  if (tab === 'hypergryph') return acctState.hypergryph;
  if (tab === 'perfectworld') return acctState.perfectworld;
  return tab === 'hoyolab' ? acctState.hoyolab : acctState.miyoushe;
}

/** 哪些分区是「启动器自己维护登录态」的那种（有 roles、能切能删）。 */
const ACCT_PROVIDER_TABS = ['miyoushe', 'hoyolab'];

/** 当前激活账号的社区资料（头像 / 昵称）。 */
function acctProfileOf(providerId, accountId) {
  return acctState.profiles[providerId + ':' + accountId] || null;
}

async function acctLoadProfile(providerId, accountId) {
  if (!api?.hoyolab?.profile) return null;
  const key = providerId + ':' + accountId;
  if (acctState.profiles[key]) return acctState.profiles[key];
  try {
    const result = await api.hoyolab.profile({ provider: providerId, uid: accountId });
    acctState.profiles[key] = result || null;
    return acctState.profiles[key];
  } catch {
    acctState.profiles[key] = null;
    return null;
  }
}


/** 拉三份数据（并发），顺便把每个账号的社区资料也拉一遍。 */
async function acctRefreshAll() {
  acctState.loading = true;
  acctState.error = '';
  acctRender();
  try {
    const [miyoushe, hoyolab, hypergryph, perfectworld, gacha] = await Promise.all([
      api.hoyolab.status({ provider: 'miyoushe' }).catch(() => null),
      api.hoyolab.status({ provider: 'hoyolab' }).catch(() => null),
      api.gacha?.akList ? api.gacha.akList().catch(() => null) : Promise.resolve(null),
      api.passport?.status ? api.passport.status({ provider: 'perfectworld' }).catch(() => null) : Promise.resolve(null),
      api.gacha?.stokenList ? api.gacha.stokenList().catch(() => null) : Promise.resolve(null),
    ]);
    acctState.miyoushe = miyoushe;
    acctState.hoyolab = hoyolab;
    acctState.hypergryph = hypergryph;
    acctState.perfectworld = perfectworld;
    acctState.gacha = gacha;

    // 账号资料一个个拉，失败也不影响主流程
    const jobs = [];
    for (const [providerId, store] of [['miyoushe', miyoushe], ['hoyolab', hoyolab]]) {
      for (const account of (store?.accounts || [])) {
        jobs.push(acctLoadProfile(providerId, account.id));
      }
    }
    await Promise.all(jobs);
    /*
     * 账号中心里换号 / 新登录 / 移除账号之后，侧栏那个头像要跟着变。
     * 放在这里而不是每个动作后面各加一次，是因为所有动作最后都走 acctRefreshAll。
     */
    /* 把当前所在的栏传过去：用户在鹰角那栏操作时，侧栏就该显示鹰角账号 */
    if (typeof refreshSidebarAccount === 'function') {
      await refreshSidebarAccount(true, acctState.tab).catch(() => null);
    }
  } catch (error) {
    acctState.error = humanError(error);
  }
  acctState.loading = false;
  acctRender();
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function acctNavHeadHtml() {
  const data = acctState.tab === 'gacha' ? null : acctProviderData(acctState.tab);
  const account = (data?.accounts || []).find((item) => item.id === data?.activeId) || (data?.accounts || [])[0] || null;

  if (acctState.tab === 'hypergryph') {
    const store = acctState.hypergryph;
    const list = Array.isArray(store?.accounts) ? store.accounts : [];
    const active = list.find((item) => item.id === store?.activeId) || list[0] || null;
    return [
      '<div class="acct-brand">',
      acctAvatarHtml('', active?.nickname || '鹰角账号'),
      '  <div class="acct-brand-text">',
      '    <strong>' + esc(active?.nickname || '还没有登录') + '</strong>',
      '    <small>' + esc(active ? (active.channel || '官服') + ' · 鹰角通行证' : '登录一次就能取寻访记录') + '</small>',
      '  </div>',
      '</div>',
    ].join('\n');
  }

  if (acctState.tab === 'perfectworld') {
    const store = acctState.perfectworld;
    const loggedIn = store && store.loggedIn === true;
    return [
      '<div class="acct-brand">',
      acctAvatarHtml('', loggedIn ? '完美通行证' : '完美通行证'),
      '  <div class="acct-brand-text">',
      '    <strong>' + esc(loggedIn ? '完美通行证' : '还没有登录') + '</strong>',
      '    <small>' + esc(loggedIn ? '异环 · 完美世界' : '登录一次就能记住') + '</small>',
      '  </div>',
      '</div>',
    ].join('\n');
  }

  if (acctState.tab === 'gacha') {
    const gacha = acctState.gacha;
    const active = (gacha?.accounts || []).find((item) => item.id === gacha?.activeId) || (gacha?.accounts || [])[0] || null;
    return [
      '<div class="acct-brand">',
      acctAvatarHtml('', active?.nickname || '抽卡账号'),
      '  <div class="acct-brand-text">',
      '    <strong>' + esc(active?.nickname || '还没有绑定') + '</strong>',
      '    <small>' + esc(active ? (active.region === 'os' ? '国际服' : '国服') : '扫一次码就能用') + '</small>',
      '  </div>',
      '</div>',
    ].join('\n');
  }

  const profile = account ? acctProfileOf(acctState.tab, account.id) : null;
  const name = profile?.nickname || account?.label || '还没有登录';
  return [
    '<div class="acct-brand">',
    acctAvatarHtml(profile?.avatarUrl || '', name),
    '  <div class="acct-brand-text">',
    '    <strong>' + esc(name) + '</strong>',
    '    <small>' + esc(account ? (acctState.tab === 'hoyolab' ? 'HoYoLAB 账号' : '米游社账号') : '点右边登录一个') + '</small>',
    '  </div>',
    '</div>',
  ].join('\n');
}

function acctNavHtml() {
  const tabs = ACCT_TABS.map((tab) => {
    const active = acctState.tab === tab.id ? ' is-active' : '';
    return (
      '<button class="acct-tab' + active + '" data-action="acct-tab" data-value="' + tab.id + '">' +
      icon(tab.icon) +
      '<span>' + esc(tab.label) + '</span>' +
      '<em>' + esc(tab.hint) + '</em>' +
      '</button>'
    );
  }).join('\n');

  const busy = acctState.busy === 'refresh' ? ' is-busy' : '';
  return [
    '<aside class="acct-nav">',
    acctNavHeadHtml(),
    '  <nav class="acct-tabs">',
    tabs,
    '    <button class="acct-tab' + busy + '" data-action="acct-refresh">' + icon('refresh') + '<span>刷新登录态</span></button>',
    '    <div class="acct-sep"></div>',
    '    <button class="acct-tab" data-action="acct-open-settings">' + icon('settings') + '<span>打开设置</span></button>',
    '  </nav>',
    '  <p class="acct-foot">登录态只保存在本机</p>',
    '</aside>',
  ].join('\n');
}

/*
 * 一张游戏卡片。
 *
 * 通行证下面是「这款游戏在这个账号上是什么样」：UID、角色名、抽卡能不能同步。
 * 以前这些全挤在一行小字里，既看不出哪款能同步，也没法针对某一款单独操作。
 */
function acctGameCardHtml(game) {
  const lines = (game.lines || []).filter(Boolean);
  return [
    '<div class="acct-game' + (game.muted ? ' is-muted' : '') + '">',
    '  <div class="acct-game-top">',
    '    <strong>' + esc(game.name || '') + '</strong>',
    game.tag ? '    <span class="acct-game-tag">' + esc(game.tag) + '</span>' : '',
    game.uid ? '    <span class="acct-game-uid">UID ' + esc(game.uid) + '</span>' : '',
    '  </div>',
    lines.length
      ? '  <div class="acct-game-lines">' + lines.map((line) => '<span>' + esc(line) + '</span>').join('') + '</div>'
      : '',
    game.note ? '  <p class="acct-game-note">' + esc(game.note) + '</p>' : '',
    game.actions ? '  <div class="acct-game-actions">' + game.actions + '</div>' : '',
    '</div>',
  ].join('\n');
}

/*
 * 一个抽屉：一张通行证账号。
 *
 * 用原生 <details>：折叠状态浏览器自己管，不用维护 open 状态，
 * acctRender 换 innerHTML 之后也不会丢。
 * summary 里放了按钮，点击时 acctHandleClick 会 preventDefault，
 * 否则点「切换」会顺带把抽屉收起来。
 */
function acctDrawerHtml(spec) {
  const cards = spec.cards || '<p class="acct-empty-line">这个账号下面还没有可用数据</p>';
  return [
    '<details class="acct-drawer"' + (spec.open ? ' open' : '') + '>',
    '  <summary class="acct-drawer-head">',
    '    <span class="acct-drawer-caret">' + icon('chevron-right') + '</span>',
    acctAvatarHtml(spec.avatarUrl || '', spec.avatarName || spec.title || '', 'sm'),
    '    <span class="acct-drawer-title">',
    '      <strong>' + esc(spec.title || '') + '</strong>',
    '      <small>' + esc(spec.subtitle || '') + '</small>',
    '    </span>',
    spec.badge ? '    <span class="acct-badge">' + esc(spec.badge) + '</span>' : '',
    '    <span class="acct-drawer-actions">' + (spec.actions || '') + '</span>',
    '  </summary>',
    '  <div class="acct-drawer-body">',
    cards,
    '  </div>',
    '</details>',
  ].join('\n');
}

/** 一张通行证账号卡片。 */


function acctProviderBodyHtml(providerId) {
  const data = acctProviderData(providerId);
  const isHoyolab = providerId === 'hoyolab';
  const accounts = data?.accounts || [];
  const activeId = data?.activeId || '';
  const title = isHoyolab ? 'HoYoLAB 账号' : '米游社账号';
  const desc = isHoyolab
    ? '国际服（美 / 欧 / 亚 / 台）共用一套 HoYoLAB 登录，可以挂多个账号。展开一个账号，下面每款游戏一张卡片。'
    : '原神 / 星穹铁道 / 绝区零 共用一套米游社登录，可以挂多个账号。展开一个账号，下面每款游戏一张卡片。';

  const head = [
    '<header class="acct-head">',
    '  <div>',
    '    <h2>' + esc(title) + '</h2>',
    '    <p>' + esc(desc) + '</p>',
    '  </div>',
    '  <div class="acct-head-actions">',
    accounts.length
      ? '<button class="btn btn-primary btn-mini" data-action="acct-add" data-provider="' + esc(providerId) + '">' + icon('plus') + '添加账号</button>'
      : '',
    accounts.length
      ? '<button class="btn btn-ghost btn-mini" data-action="acct-logout-all" data-provider="' + esc(providerId) + '">全部退出</button>'
      : '',
    '  </div>',
    '</header>',
  ].join('\n');

  const reason = data && data.reason ? '<p class="acct-warn">' + esc(data.reason) + '</p>' : '';

  if (!accounts.length) {
    return (
      head +
      [
        '<div class="acct-empty">',
        icon('login', 'lg'),
        '  <strong>还没登录</strong>',
        '  <p>登录一次就能看战绩、取每日便笺，也能顺手把抽卡账号建起来。</p>',
        '  <button class="btn btn-primary" data-action="acct-add" data-provider="' + esc(providerId) + '">打开登录</button>',
        '</div>',
        reason,
      ].join('\n')
    );
  }

  const drawers = accounts
    .map((account) => {
      const profile = acctProfileOf(providerId, account.id);
      const name = profile?.nickname || account.label || '米游社账号';
      const isActive = account.id === activeId;
      /* 只列抽卡还支持的这几款；崩坏3 之类已摘掉的旧角色数据不画 */
      const roles = (account.roles || []).filter((role) => GACHA_TOKEN_GAME_NAMES[role.game]);
      const cards = roles.length
        ? roles
            .map((role) =>
              acctGameCardHtml({
                name: GACHA_TOKEN_GAME_NAMES[role.game] || role.game,
                uid: role.uid,
                tag: role.level ? 'Lv.' + role.level : (role.regionName || ''),
                lines: [role.nickname || '', role.regionName || ''],
              }),
            )
            .join('\n')
        : '<p class="acct-empty-line">这个账号还没读到游戏角色</p>';
      return acctDrawerHtml({
        open: isActive || accounts.length === 1,
        title: name,
        subtitle: 'UID ' + account.id + ' · ' + roles.length + ' 款游戏',
        avatarUrl: profile?.avatarUrl || '',
        avatarName: name,
        badge: isActive ? '使用中' : '',
        actions:
          (isActive
            ? ''
            : '<button class="btn btn-ghost btn-mini" data-action="acct-switch" data-provider="' + esc(providerId) + '" data-value="' + esc(account.id) + '">切换</button>') +
          '<button class="acct-icon-btn" title="移除这个账号" data-action="acct-remove" data-provider="' + esc(providerId) + '" data-value="' + esc(account.id) + '">' + icon('trash') + '</button>',
        cards,
      });
    })
    .join('\n');

  return head + drawers + reason;
}

/** 鹰角账号一张卡片。 */
/*
 * 鹰角通行证下一款游戏一条胶囊。
 *
 * 以前只显示明日方舟的 UID，同一通行证下的《终末地》完全看不见 ——
 * 用户会以为「只绑上了方舟」。binding_list 其实一次就返回了全部游戏。
 */




/** 时间戳 -> 「9月4日」这种短文本，账号卡片里够用了。 */
function acctTimeText(value) {
  const stamp = Number(value || 0);
  if (!stamp) return '';
  try {
    const date = new Date(stamp);
    return (date.getMonth() + 1) + '月' + date.getDate() + '日';
  } catch {
    return '';
  }
}

function acctHypergryphBodyHtml() {
  const store = acctState.hypergryph;
  const accounts = Array.isArray(store?.accounts) ? store.accounts : [];
  const activeId = store?.activeId || '';
  const head = [
    '<header class="acct-head">',
    '  <div>',
    '    <h2>鹰角账号</h2>',
    '    <p>鹰角通行证是独立的一套账号，跟米游社不通用。登录一次，同一通行证下绑过的游戏都会列出来；抽卡记录目前只支持明日方舟。</p>',
    '  </div>',
    '  <div class="acct-head-actions">',
    '    <button class="btn btn-primary btn-mini" data-action="acct-ak-add">' + icon('plus') + '登录账号</button>',
    '  </div>',
    '</header>',
  ].join('\n');

  if (!accounts.length) {
    return (
      head +
      [
        '<div class="acct-empty">',
        icon('server', 'lg'),
        '  <strong>还没登录鹰角账号</strong>',
        '  <p>点上面的「登录账号」会打开鹰角官网，登录完自动绑定，不用自己复制任何东西。</p>',
        '  <button class="btn btn-primary" data-action="acct-ak-add">打开登录</button>',
        '</div>',
      ].join('\n')
    );
  }

  const drawers = accounts
    .map((account) => {
      const isActive = account.id === activeId;
      const name = account.nickname || account.uid || '鹰角账号';
      const bindings = (Array.isArray(account.bindings) ? account.bindings : []).filter((item) => item && item.uid);
      const cards = bindings.length
        ? bindings
            .map((binding) => {
              const isAk = binding.appCode === 'arknights';
              const roleLines = (binding.roles || []).map((role) => {
                const head = (role.nickName || '') + (role.level ? ' Lv.' + role.level : '');
                /*
                 * liveLevel 是森空岛 card/detail 补出来的实时值；
                 * 世界等级 / 角色数 / 武器数也只有那条路能拿到。
                 */
                const extra = [];
                if (role.liveLevel && role.worldLevel) extra.push('世界等级 ' + role.worldLevel);
                if (role.liveLevel && role.charNum) extra.push(role.charNum + ' 角色');
                if (role.liveLevel && role.weaponNum) extra.push(role.weaponNum + ' 武器');
                if (role.serverName) extra.push(role.serverName);
                return extra.length ? head + ' · ' + extra.join(' · ') : head;
              });
              return acctGameCardHtml({
                name: binding.appName || binding.appCode || '游戏',
                uid: binding.uid,
                tag: binding.channelName || '',
                lines: roleLines.length ? roleLines : [binding.nickName || ''],
                note: isAk
                  ? ''
                  : (binding.roles || []).some((role) => role.liveLevel)
                    ? '等级 / 世界等级来自森空岛实时档案；抽卡记录还没接这款游戏。'
                    : '抽卡记录还没接这款游戏，暂时只能看绑定信息。',
                muted: !isAk,
              });
            })
            .join('\n')
        : '<p class="acct-empty-line">这个通行证下还没有读到游戏绑定</p>';
      const meta = [
        account.channel || '官服',
        account.lastSyncAt ? '上次同步 ' + acctTimeText(account.lastSyncAt) : '还没同步过',
      ]
        .filter(Boolean)
        .join(' · ');
      return acctDrawerHtml({
        open: isActive || accounts.length === 1,
        title: name,
        subtitle: meta + ' · ' + bindings.length + ' 款游戏',
        avatarName: name,
        badge: isActive ? '使用中' : '',
        actions:
          (isActive
            ? ''
            : '<button class="btn btn-ghost btn-mini" data-action="acct-ak-switch" data-value="' + esc(account.id) + '">切换</button>') +
          '<button class="acct-icon-btn" title="移除这个账号" data-action="acct-ak-remove" data-value="' + esc(account.id) + '">' + icon('trash') + '</button>',
        cards,
      });
    })
    .join('\n');

  return head + drawers;
}
/*
 * 完美世界通行证。
 *
 * 官方没给第三方角色列表接口（passport-login.js 里的 roleApi 是 null），
 * 所以这里只能报「登没登录 / 什么时候登的」，不能编角色 UID 出来。
 * 形态跟鹰角那栏一致：header + 空态或抽屉卡片。
 */
function acctPerfectBodyHtml() {
  const store = acctState.perfectworld;
  const loggedIn = Boolean(store && store.loggedIn === true);
  const reason = store && store.reason ? String(store.reason) : '';

  const head = [
    '<header class="acct-head">',
    '  <div>',
    '    <h2>完美通行证</h2>',
    '    <p>异环（NTE）走的是完美世界通行证，跟米游社、鹰角都不是一套账号。登录一次会把凭据存在本机，之后打开游戏详情不用再登。</p>',
    '  </div>',
    '  <div class="acct-head-actions">',
    loggedIn
      ? '<button class="btn btn-primary btn-mini" data-action="acct-pw-login">' + icon('refresh') + '重新登录</button>'
      : '<button class="btn btn-primary btn-mini" data-action="acct-pw-login">' + icon('plus') + '登录账号</button>',
    loggedIn
      ? '<button class="btn btn-ghost btn-mini" data-action="acct-pw-logout">退出</button>'
      : '',
    '  </div>',
    '</header>',
  ].join('\n');

  if (!loggedIn) {
    return (
      head +
      [
        '<div class="acct-empty">',
        icon('shield', 'lg'),
        '  <strong>还没登录完美通行证</strong>',
        '  <p>点上面的「登录账号」会打开异环官网，在弹窗里用手机验证码或账号密码登录，登录完自动保存，不用复制任何东西。</p>',
        '  <button class="btn btn-primary" data-action="acct-pw-login">打开登录</button>',
        '</div>',
        reason ? '<p class="acct-warn">' + esc(reason) + '</p>' : '',
      ].join('\n')
    );
  }

  const savedAt = Number(store.savedAt || 0);
  const games = ['neverness'];
  const nameOf = { neverness: '异环' };
  const cards = games
    .map((key) =>
      acctGameCardHtml({
        name: nameOf[key] || key,
        tag: '凭据已保存',
        lines: [savedAt ? '登录于 ' + acctTimeText(savedAt) : ''],
        note: '完美世界没有开放角色列表接口，所以这里看不到 UID 和角色；启动器要用这个登录态时会直接复用。',
      })
    )
    .join('\n');

  return (
    head +
    acctDrawerHtml({
      open: true,
      title: '完美通行证',
      subtitle: (savedAt ? '上次登录 ' + acctTimeText(savedAt) : '已保存凭据') + ' · 1 款游戏',
      avatarName: '完美通行证',
      badge: '使用中',
      actions: '<button class="acct-icon-btn" title="退出登录" data-action="acct-pw-logout">' + icon('trash') + '</button>',
      cards,
    })
  );
}
/** 抽卡账号一张卡片。 */


function acctGachaBodyHtml() {
  const gacha = acctState.gacha;
  const accounts = gacha?.accounts || [];
  const activeId = gacha?.activeId || '';

  const head = [
    '<header class="acct-head">',
    '  <div>',
    '    <h2>抽卡账号</h2>',
    '    <p>用手机米游社扫一次码，之后原神 / 星铁 / 绝区零的抽卡记录都能直接取，不用开游戏。展开一个账号，下面每款游戏一张卡片。</p>',
    '  </div>',
    '  <div class="acct-head-actions">',
    '    <button class="btn btn-primary btn-mini" data-action="acct-gacha-manage">' + icon('key') + '扫码绑定</button>',
    '  </div>',
    '</header>',
  ].join('\n');

  if (!accounts.length) {
    return (
      head +
      [
        '<div class="acct-empty">',
        icon('gacha', 'lg'),
        '  <strong>还没有抽卡账号</strong>',
        '  <p>扫一次码就能长期同步抽卡记录，不用再开游戏刷那条 24 小时过期的链接。</p>',
        '  <button class="btn btn-primary" data-action="acct-gacha-manage">扫码绑定</button>',
        '</div>',
      ].join('\n')
    );
  }

  const drawers = accounts
    .map((account) => {
      const isActive = account.id === activeId;
      const roles = account.roles || [];
      const tokenOk = account.hasStoken === true;
      const cards = roles.length
        ? roles
            .map((role) =>
              acctGameCardHtml({
                name: GACHA_TOKEN_GAME_NAMES[role.game] || role.game,
                uid: role.uid,
                tag: tokenOk ? '可同步' : '缺 SToken',
                lines: [role.nickname || ''],
                muted: !tokenOk,
              }),
            )
            .join('\n')
        : '<p class="acct-empty-line">这个账号还没读到角色</p>';
      const meta = [
        tokenOk ? '已绑定 SToken' : '未绑定 SToken',
        account.region === 'os' ? '国际服' : '国服',
        account.canRenew ? '可自动续期' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return acctDrawerHtml({
        open: isActive || accounts.length === 1,
        title: account.nickname || '米游社账号',
        subtitle: meta + ' · ' + roles.length + ' 款游戏',
        avatarName: account.nickname || '抽卡账号',
        badge: isActive ? '使用中' : '',
        actions: isActive
          ? ''
          : '<button class="btn btn-ghost btn-mini" data-action="acct-gacha-switch" data-value="' + esc(account.id) + '">切换</button>',
        cards,
      });
    })
    .join('\n');

  return head + drawers;
}

function acctBodyHtml() {
  if (acctState.loading) {
    return '<div class="acct-loading"><span class="acct-spinner"></span>正在读取账号…</div>';
  }
  if (acctState.error) {
    return [
      '<div class="acct-empty">',
      icon('alert', 'lg'),
      '  <strong>读取账号失败</strong>',
      '  <p>' + esc(acctState.error) + '</p>',
      '  <button class="btn btn-primary" data-action="acct-refresh">重试</button>',
      '</div>',
    ].join('\n');
  }
  if (acctState.tab === 'hypergryph') return acctHypergryphBodyHtml();
  if (acctState.tab === 'perfectworld') return acctPerfectBodyHtml();
  if (acctState.tab === 'gacha') return acctGachaBodyHtml();
  return acctProviderBodyHtml(acctState.tab === 'hoyolab' ? 'hoyolab' : 'miyoushe');
}

function acctShellHtml() {
  return [
    '<div class="modal-backdrop" data-backdrop>',
    '  <div class="modal acct-modal" role="dialog" aria-modal="true" aria-label="账号中心">',
    acctNavHtml(),
    '    <section class="acct-body">',
    acctBodyHtml(),
    '    </section>',
    '    <button class="modal-close acct-close" data-close title="关闭">' + icon('x') + '</button>',
    '  </div>',
    '</div>',
  ].join('\n');
}

/**
 * 图片加载失败就把 <img> 摘掉，露出底下那个文字圆标。
 *
 * 不写成内联 onerror：内联事件要求 CSP 放行 inline script，这个仓库的
 * index.html 里 script-src 是 'self'，内联处理器会被直接拦掉、静默失效。
 * 挂在 JS 里绑则不受这条约束。
 */
function acctBindImages(root) {
  if (!root) return;
  for (const img of root.querySelectorAll('.acct-avatar img')) {
    if (img.dataset.acctBound === '1') continue;
    img.dataset.acctBound = '1';
    img.addEventListener('error', () => img.remove(), { once: true });
  }
}

/** 只重画，不重开 —— 重开会闪一下，切换分区时很难看。 */
function acctRender() {
  const root = document.querySelector('.acct-modal');
  if (!root) return;
  /*
   * 只换 innerHTML，不动 .acct-modal 这个元素本身 ——
   * 事件委托挂在它身上，元素留着监听就一直在，重绘多少次都不用重绑。
   */
  root.innerHTML = [
    acctNavHtml(),
    '<section class="acct-body">',
    acctBodyHtml(),
    '</section>',
    '<button class="modal-close acct-close" data-close title="关闭">' + icon('x') + '</button>',
  ].join('\n');
  acctBindImages(root);
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

async function acctSwitchTab(id) {
  if (acctState.tab === id) return;
  acctState.tab = id;
  acctRender();
  /*
   * 切到哪个通行证，侧栏头像就跟着换成那家当前选中的账号。
   * 只传 tab，不带 force —— 这里的账号多半刚拉过，没必要再打一次资料接口。
   */
  if (id !== 'gacha' && typeof refreshSidebarAccount === 'function') {
    refreshSidebarAccount(false, id).catch(() => null);
  }
}

async function acctDoRefresh() {
  acctState.busy = 'refresh';
  acctRender();
  try {
    // 强制重查一次，绕过主进程的短缓存
    acctState.profiles = {};
    await acctRefreshAll();
    toast('登录态已刷新', 'success');
  } catch (error) {
    toast(humanError(error), 'error');
  } finally {
    acctState.busy = '';
    acctRender();
  }
}

async function acctSwitchAccount(providerId, accountId) {
  try {
    const result = await api.hoyolab.switchAccount({ provider: providerId, accountId });
    if (result && result.ok === false) {
      toast(result.reason || '切换失败', 'error');
      return;
    }
    toast('已切换账号', 'success');
    await acctRefreshAll();
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

async function acctRemoveAccount(providerId, accountId) {
  const yes = await confirmDialog({
    title: '移除账号',
    message: '移除后需要重新登录才能再用这个账号，确定吗？',
    confirmText: '移除',
    danger: true,
  });
  if (!yes) return;
  try {
    await api.hoyolab.logout({ provider: providerId, id: accountId });
    toast('已移除', 'success');
    await acctRefreshAll();
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

async function acctLogoutAll(providerId) {
  const yes = await confirmDialog({
    title: '全部退出',
    message: '会移除这个渠道下的所有账号，确定吗？',
    confirmText: '全部退出',
    danger: true,
  });
  if (!yes) return;
  try {
    await api.hoyolab.logout({ provider: providerId });
    toast('已全部退出', 'success');
    await acctRefreshAll();
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

async function acctAddAccount(providerId) {
  try {
    const result = await api.hoyolab.login({ provider: providerId });
    if (result && result.ok === false) {
      toast(result.reason || '登录没有完成', 'info');
      return;
    }
    toast('登录成功', 'success');
    acctState.profiles = {};
    await acctRefreshAll();
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

async function acctAkSwitch(accountId) {
  try {
    const result = await api.gacha.akActive(accountId);
    if (result && result.ok === false) {
      toast(result.error || '切换失败', 'error');
      return;
    }
    toast('已切换鹰角账号', 'success');
    await acctRefreshAll();
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

async function acctAkAdd() {
  try {
    const result = await api.gacha.akLogin();
    if (result && result.ok === false) {
      toast(result.error || '登录没有完成', 'info');
      return;
    }
    toast('鹰角账号已绑定', 'success');
    await acctRefreshAll();
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

async function acctAkRemove(accountId) {
  const yes = await confirmDialog({
    title: '移除鹰角账号',
    message: '移除后需要重新登录才能再取寻访记录，确定吗？',
    confirmText: '移除',
    danger: true,
  });
  if (!yes) return;
  try {
    await api.gacha.akRemove(accountId);
    toast('已移除', 'success');
    await acctRefreshAll();
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

async function acctPerfectLogin() {
  if (!api?.passport?.login) {
    toast('当前版本不支持完美通行证登录', 'error');
    return;
  }
  try {
    const result = await api.passport.login({ provider: 'perfectworld' });
    if (result && result.ok === false) {
      if (!result.cancelled) toast(result.reason || '登录没有完成', 'info');
      return;
    }
    toast('完美通行证已登录，凭据存到本机了', 'success');
    await acctRefreshAll();
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

async function acctPerfectLogout() {
  const yes = await confirmDialog({
    title: '退出完美通行证',
    message: '退出后需要重新登录才能再用，确定吗？',
    confirmText: '退出',
    danger: true,
  });
  if (!yes) return;
  try {
    await api.passport.logout({ provider: 'perfectworld' });
    toast('已退出', 'success');
    await acctRefreshAll();
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

async function acctGachaSwitch(accountId) {
  try {
    await api.gacha.stokenActive(accountId);
    toast('已切换抽卡账号', 'success');
    await acctRefreshAll();
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

function acctOpenGachaManage() {
  if (typeof openGachaTokenModal === 'function') {
    openGachaTokenModal(() => acctRefreshAll());
  } else {
    toast('这个版本没有带上抽卡账号模块', 'info');
  }
}

function acctHandleClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  /*
   * 抽屉头里的按钮：不拦的话点「切换」会顺带把抽屉收起来。
   * summary 的默认行为就是切换展开状态，所以这里必须 preventDefault。
   */
  if (button.closest('summary')) event.preventDefault();
  const action = button.dataset.action;
  const value = button.dataset.value || '';
  const provider = button.dataset.provider || 'miyoushe';

  if (action === 'acct-tab') {
    acctSwitchTab(value);
    return;
  }
  if (action === 'acct-refresh') {
    acctDoRefresh();
    return;
  }
  if (action === 'acct-open-settings') {
    closeModal();
    navigate('settings');
    return;
  }
  if (action === 'acct-switch') {
    acctSwitchAccount(provider, value);
    return;
  }
  if (action === 'acct-remove') {
    acctRemoveAccount(provider, value);
    return;
  }
  if (action === 'acct-logout-all') {
    acctLogoutAll(provider);
    return;
  }
  if (action === 'acct-add') {
    acctAddAccount(provider);
    return;
  }
  if (action === 'acct-ak-switch') {
    acctAkSwitch(value);
    return;
  }
  if (action === 'acct-ak-add') {
    acctAkAdd();
    return;
  }
  if (action === 'acct-ak-remove') {
    acctAkRemove(value);
    return;
  }
  if (action === 'acct-pw-login') {
    acctPerfectLogin();
    return;
  }
  if (action === 'acct-pw-logout') {
    acctPerfectLogout();
    return;
  }
  if (action === 'acct-gacha-switch') {
    acctGachaSwitch(value);
    return;
  }
  if (action === 'acct-gacha-manage') {
    acctOpenGachaManage();
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 打开账号中心。
 * 侧栏左下角那个「头像 + 名字」现在点它 —— 以前是直接跳设置页，
 * 但账号相关的操作都在这里，跳设置页等于让人再找一次。
 */
function openAccountCenter() {
  acctReset();
  openModal(acctShellHtml());
  const root = document.querySelector('.acct-modal');
  if (root) root.addEventListener('click', acctHandleClick);
  acctBindImages(root);
  acctRefreshAll();
}
