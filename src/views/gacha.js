'use strict';

/**
 * 视图层：抽卡记录页（gacha）。
 *
 * 2026-10-31 从 app.js 拆出 —— 「前后端分离」第 8 批。
 *
 * 内容（在 app.js 里被 NTE 预下载窗、终末地打包弹窗打断成 4 段，这里按顺序合回一处）：
 *   · 固定展示表：GACHA_GAMES / gachaAllGames / gachaEnsureSelection
 *   · 稀有度与保底：gachaHighLabel / gachaMidLabel / gachaPityCap
 *   · 卡片组件：gachaKindLabel / gachaKindFallback / gachaAvatarHtml /
 *     gachaTileHtml / GACHA_STANDARD_FIVE / gachaIsUp / gachaPoolCard / gachaOverview
 *   · 整页：gachaView2（chrome.js 的视图表里 `gacha` 指向它）
 *   · 导入与同步：GACHA_IMPORT_GUIDES / openGachaImportModal / openGachaSyncModal /
 *     loadGacha / startGachaRefresh / stopGachaRefresh
 *
 * 加载约定：普通 script，共享全局词法作用域，必须排在 app.js 之前。
 * 依赖 state / dom / icon / esc / api 等，均在调用时解析；顶层无立即求值。
 * 注意 gachaView2 会调 nteSyncPanel（NTE 域，仍留在 app.js），跨文件靠全局解析。
 */

/** 抽卡页固定展示这五款，缺数据时给导入引导，而不是让标签消失。 */
const GACHA_GAMES = [
  { key: 'genshin', name: '原神' },
  { key: 'starrail', name: '崩坏：星穹铁道' },
  { key: 'zzz', name: '绝区零' },
  { key: 'bh3', name: '崩坏3' },
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
            ['bh3', '崩坏3'],
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
