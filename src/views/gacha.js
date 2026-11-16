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

/** 抽卡页固定展示这几款，缺数据时给导入引导，而不是让标签消失。 */
const GACHA_GAMES = [
  { key: 'genshin', name: '原神' },
  { key: 'starrail', name: '崩坏：星穹铁道' },
  { key: 'zzz', name: '绝区零' },
  { key: 'endfield', name: '明日方舟：终末地' },
  { key: 'wutheringwaves', name: '鸣潮' },
  { key: 'arknights', name: '明日方舟' },
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
  /* 方舟是六星制，最高档写 6★ */
  if (game.key === 'arknights') return '6★';
  if (game.key === 'endfield') return '6★';
  if (game.key === 'neverness') return '5★';
  return game.key === 'zzz' ? 'S级' : '5★';
}

function gachaMidLabel(game) {
  if (game.key === 'arknights') return '5★';
  if (game.key === 'endfield') return '5★';
  if (game.key === 'neverness') return '4★';
  return game.key === 'zzz' ? 'A级' : '4★';
}

/** 每个游戏的保底上限，用于垫数进度条；没有官方保底的按 90 兜底。 */
function gachaPityCap(game) {
  /* 方舟六星保底 99 抽（官方规则），别套米哈游那套 90。 */
  if (game.key === 'arknights') return 99;
  /* 鸣潮限定角色 80 抽硬保底 */
  if (game.key === 'wutheringwaves') return 80;
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
/*
 * 欧非 / 首次获得标签。
 *
 * up === true  命中当期 UP（欧）
 * up === false 歪了（非）
 * up === null  这个池子没有 UP 概念（常驻/中坚），不打标 ——
 *              宁可不说，也不要给常驻池出金打个「非」，那是误导。
 *
 * isNew 用的是鹰角自己标的「首次获得」，比自己拿历史比更准。
 */
function gachaJudgeBadges(item) {
  const out = [];
  if (item && item.isNew === true) out.push('<em class="gacha-badge is-new">NEW</em>');
  if (item && item.up === true) out.push('<em class="gacha-badge is-up">UP</em>');
  else if (item && item.up === false) out.push('<em class="gacha-badge is-off">歪</em>');
  return out.join('');
}

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
    /*
     * 方舟的 up / isNew 是服务端判定好的，直接用；
     * 其它游戏没有权威 UP 名单，退回「名字不在常驻名单里就算 up」这套估算。
     */
    const badges = game.key === 'arknights'
      ? gachaJudgeBadges(item)
      : gachaIsUp(name, pool, standardNames)
        ? '<em class="gacha-prow-up">up</em>'
        : '';
    rows5.push(`
      <div class="gacha-prow" title="${esc(name)} · ${esc(item.banner || '')} · ${esc(String(item.time).slice(0, 10))} · ${pity} 抽">
        ${gachaAvatarHtml(item)}
        <span class="gacha-prow-name">${esc(name)}${badges}</span>
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

/* ------------------------------------------------------------------ */
/* 数据看板：三张静态图                                                 */
/* ------------------------------------------------------------------ */

/**
 * 抽卡数据的三张图：出率结构、每金抽数、累计出金。
 *
 * 为什么手写 SVG 而不引图表库：启动器是零运行时依赖的，为三张不会交互的静态图
 * 引一个几百 KB 的库不划算。数据在渲染时算一次就固定了，SVG 比 canvas 省事，
 * 还能直接吃到主题的 CSS 变量（深浅色、强调色跟着走）。
 */

/** 当前 scope 对应的数据：单池看 breakdown 里的那份，全部看整体 */
function gachaChartDataSource(user, scope) {
  if (scope && scope !== 'all') {
    const hit = user.breakdown && user.breakdown[scope];
    if (hit && hit.total) return hit;
  }
  return user;
}

/** 环形：五星 / 四星 / 其余 的占比 */
function gachaDonutSvg({ five, four, low }) {
  const total = five + four + low;
  if (!total) return '';
  const R = 52;
  const C = 2 * Math.PI * R;
  const segs = [
    { value: five, cls: 'is-five' },
    { value: four, cls: 'is-four' },
    { value: low, cls: 'is-low' },
  ];
  let passed = 0;
  const rings = segs
    .filter((seg) => seg.value > 0)
    .map((seg) => {
      const len = (seg.value / total) * C;
      const circle = `<circle class="gacha-donut-seg ${seg.cls}" cx="70" cy="70" r="${R}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-passed).toFixed(2)}" />`;
      passed += len;
      return circle;
    })
    .join('');
  return `
    <svg class="gacha-donut" viewBox="0 0 140 140" role="img" aria-label="出率结构">
      <g transform="rotate(-90 70 70)">${rings}</g>
      <text class="gacha-donut-total" x="70" y="68">${total}</text>
      <text class="gacha-donut-unit" x="70" y="84">抽</text>
    </svg>`;
}

/** 折线：每次出金花了多少抽（时间正序），虚线是平均值 */
function gachaPitySvg(items, cap) {
  const values = items.map((item) => Number(item.pity) || 0);
  if (!values.length) return '';
  const W = 480;
  const H = 152;
  const L = 30;
  const R = 10;
  const T = 14;
  const B = 20;
  const maxV = Math.max(...values, cap || 0, 10);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const n = values.length;
  const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R));
  const y = (value) => H - B - (value / maxV) * (H - T - B);
  const line = values.map((value, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(value).toFixed(1)}`).join(' ');
  const dots = values
    .map((value, i) => `<circle class="gacha-line-dot" cx="${x(i).toFixed(1)}" cy="${y(value).toFixed(1)}" r="2.3" />`)
    .join('');
  const avgY = y(avg).toFixed(1);
  return `
    <svg class="gacha-line" viewBox="0 0 ${W} ${H}" role="img" aria-label="每次出金抽数">
      <line class="gacha-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" />
      <text class="gacha-axis-text" x="${L - 6}" y="${H - B + 4}" text-anchor="end">0</text>
      <text class="gacha-axis-text" x="${L - 6}" y="${T + 4}" text-anchor="end">${maxV}</text>
      <line class="gacha-avg" x1="${L}" y1="${avgY}" x2="${W - R}" y2="${avgY}" />
      <text class="gacha-avg-text" x="${W - R}" y="${Number(avgY) - 4}" text-anchor="end">平均 ${avg.toFixed(1)}</text>
      <path class="gacha-line-path" d="${line}" />
      ${dots}
    </svg>`;
}

/** 阶梯：横轴累计抽数，纵轴第几个五星 */
function gachaCumulativeSvg(items) {
  const values = items.map((item) => Number(item.pity) || 0);
  if (!values.length) return '';
  const W = 480;
  const H = 152;
  const L = 26;
  const R = 12;
  const T = 14;
  const B = 20;
  let cum = 0;
  const points = [[0, 0]];
  values.forEach((value, index) => {
    cum += value;
    // 先竖着上升一格，再水平走到下一次出金的位置
    points.push([cum, index]);
    points.push([cum, index + 1]);
  });
  const maxCum = Math.max(cum, 1);
  const maxN = values.length;
  const x = (value) => L + (value / maxCum) * (W - L - R);
  const y = (value) => H - B - (value / maxN) * (H - T - B);
  const path = points
    .map(([cx, cy], i) => `${i ? 'L' : 'M'}${x(cx).toFixed(1)} ${y(cy).toFixed(1)}`)
    .join(' ');
  return `
    <svg class="gacha-step" viewBox="0 0 ${W} ${H}" role="img" aria-label="累计出金">
      <line class="gacha-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" />
      <line class="gacha-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" />
      <text class="gacha-axis-text" x="${W - R}" y="${H - B + 15}" text-anchor="end">${maxCum} 抽</text>
      <text class="gacha-axis-text" x="${L - 4}" y="${T + 4}" text-anchor="end">${maxN}</text>
      <path class="gacha-step-path" d="${path}" />
    </svg>`;
}

/**
 * 三张图拼成一块。没有五星记录时只留环形——另外两张图没有意义，
 * 硬画出来是两条空白轴，反而像坏了。
 */
function gachaCharts(user, game, scope) {
  const src = gachaChartDataSource(user, scope);
  const total = Number(src.total) || 0;
  if (!total) return '';
  const five = Number(src.five) || 0;
  const four = Number(src.four) || 0;
  const low = src.low !== undefined ? Number(src.low) || 0 : Math.max(0, total - five - four);
  // fiveHistory 是「新的在前」，画图要从左到右按时间走
  const history = (src.fiveHistory || []).slice().reverse();
  const recent = history.slice(-60);
  const cap = gachaPityCap(game);
  const high = gachaHighLabel(game);
  const mid = gachaMidLabel(game);

  const cards = [
    `<section class="gacha-chart-card">
      <header><strong>出率结构</strong><small>${total} 抽里各占多少</small></header>
      <div class="gacha-chart-flex">
        ${gachaDonutSvg({ five, four, low })}
        <ul class="gacha-legend">
          <li><i class="is-five"></i>${esc(high)}<b>${five}</b><em>${total ? ((five / total) * 100).toFixed(2) : '0.00'}%</em></li>
          <li><i class="is-four"></i>${esc(mid)}<b>${four}</b><em>${total ? ((four / total) * 100).toFixed(2) : '0.00'}%</em></li>
          <li><i class="is-low"></i>其余<b>${low}</b><em>${total ? ((low / total) * 100).toFixed(2) : '0.00'}%</em></li>
        </ul>
      </div>
    </section>`,
  ];

  if (five > 0) {
    cards.push(`<section class="gacha-chart-card">
      <header><strong>每金抽数</strong><small>最近 ${recent.length} 次${esc(high)}${recent.length < history.length ? `（共 ${history.length} 次）` : ''}</small></header>
      ${gachaPitySvg(recent, cap)}
    </section>`);
    cards.push(`<section class="gacha-chart-card">
      <header><strong>累计出金</strong><small>横轴累计抽数，纵轴${esc(high)}个数</small></header>
      ${gachaCumulativeSvg(recent)}
    </section>`);
  }

  return `<div class="gacha-charts">${cards.join('')}</div>`;
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
  /* 方舟的欧非由服务端 up 字段判定，不需要「常驻名单」这套估算 */
  const standardNames = game.key === 'arknights'
    ? null
    : new Set(GACHA_STANDARD_FIVE[game.key] || []);
  /*
   * standardNames 在方舟那里是 null（见上一行：它不做名字估算）。
   * 下面这段自校准是给米哈游那几款用的，必须先判空 ——
   * 否则方舟一旦有常驻池记录，就会撞上 null.add() 直接抛错。
   */
  if (bucket && bucket.standard && standardNames) {
    for (const item of bucket.standard.fiveHistory || []) {
      if (item.name) standardNames.add(item.name);
    }
  }

  // 概览直接并排铺：角色 / 武器 / 常驻 / 邦布各一张卡，一眼看完
  /*
   * 方舟的池子是常驻 / 限定 / 中坚三类，跟米哈游那套角色/武器/邦布完全不同，
   * 强行套用只会让「限定寻访」显示成「角色池」、常驻和限定垫数混在一起。
   */
  const POOLS = game.key === 'arknights'
    ? [
      ['limited', '限定寻访'],
      ['standard', '常驻寻访'],
      ['classic', '中坚寻访'],
    ]
    : [
      ['character', '角色池'],
      ['weapon', '武器池'],
      ['standard', '常驻池'],
      ['bangboo', '邦布池'],
    ];
  const cardHtml = ([key, label]) => {
    if (!bucket[key]) return '';
    /*
     * 方舟的三类池子必须都摆出来，哪怕某一类这号一次没抽过 ——
     * 用户看图就是要确认「常驻 / 限定 / 中坚是分开算的」，
     * 抽过的那几类孤零零立着，反而让人以为另外两类没在统计。
     */
    if (game.key === 'arknights') return gachaPoolCard(key, label, bucket[key], game, standardNames);
    return bucket[key].total > 0 ? gachaPoolCard(key, label, bucket[key], game, standardNames) : '';
  };
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
    ${gachaCharts(user, game, scope)}
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
        <button class="btn btn-ghost" data-action="open-account-center" title="账号中心：管理米游社 / HoYoLAB / 鹰角与抽卡 SToken 账号">${icon('login')}账号中心</button>

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

  /*
   * 自动同步发现链接过期时挂常驻提醒：authkey 是游戏里点开抽卡记录页时刷新的，
   * 过期后只有用户进游戏再点一次才能续上。同步成功（gacha:updated）或用户点开
   * 抽卡页让缓存刷新后，这条提醒自动消失（app.js 的订阅负责清 state）。
   */
  const expiredGames = state.gachaLinkExpired || {};
  const expiredNow = expiredGames && expiredGames[game.key];
  const expiredBanner = expiredNow
    ? `<div class="gacha-expired-banner" id="gacha-expired-banner">
        <span>${icon('alert')}${esc(expiredNow.message || '抽卡链接已过期：进游戏打开一次抽卡记录页即可重新获取')}</span>
        <button class="link-btn" data-action="gacha-expired-dismiss">${icon('close')}知道了</button>
      </div>`
    : '';

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
  /*
   * 顶部这排范围切换（全部 / 角色池 / 武器池 …）也要按游戏分口径。
   * 方舟没有角色池和武器池，它的三类是限定 / 常驻 / 中坚 —— 沿用米哈游
   * 那套标签会出现「角色池 256」这种对不上号的说法（那 256 其实是限定池）。
   */
  const scopes = bucket
    ? (game.key === 'arknights'
      ? [
        ['all', '全部', user.total],
        ['limited', '限定寻访', (bucket.limited && bucket.limited.total) || 0],
        ['standard', '常驻寻访', (bucket.standard && bucket.standard.total) || 0],
        ['classic', '中坚寻访', (bucket.classic && bucket.classic.total) || 0],
      ]
      : [
        ['all', '全部', user.total],
        ['character', '角色池', (bucket.character && bucket.character.total) || 0],
        ['weapon', '武器池', (bucket.weapon && bucket.weapon.total) || 0],
        ['standard', '常驻池', (bucket.standard && bucket.standard.total) || 0],
        ['bangboo', '邦布池', (bucket.bangboo && bucket.bangboo.total) || 0],
      ]
    ).filter(([key, , total]) => key === 'all' || total > 0)
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
      ${expiredBanner}
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

  arknights: {
    name: '明日方舟',
    format: 'UIGF / 社区工具导出的 JSON',
    /*
     * 别再写「没有公开的抽卡接口」—— 鹰角账号那条路已经打通了
     * （左下角头像 →「鹰角账号」登录一次，之后点同步就能直接取）。
     * 还留着这句会让人以为只能用第三方工具导出，白绕一大圈。
     */
    tool: '推荐直接在「同步」里用鹰角账号取（左下角头像 →「鹰角账号」登录一次即可）；也可以导入社区工具导出的 JSON。',
  },
  wutheringwaves: {
    name: '鸣潮',
    format: '官方分享链接 / 社区导出 JSON',
    tool: '推荐直接用「同步」按钮读取游戏日志里的分享链接拉取；也可以粘贴链接手动同步。',
    steps: [
      '打开鸣潮，进游戏里的「抽卡记录」页面。',
      '点右上角「分享」，随便选一种方式分享出去（复制链接就行）——游戏会把带签名的记录链接写进本地日志，启动器就是从那里读的。',
      '回到启动器点「同步」即可；如果日志里找不到链接，也可以在这里粘贴分享链接手动同步。',
      '注意：链接有时效（约一个月），过期后重新分享一次就行；同一次分享可以拉全部 11 个卡池。',
    ],
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
  /*
   * 导入支持的游戏。没接在线接口的游戏只能走这条路，
   * 所以这里必须能选到它们，否则用户连「导进来」都做不到。
   */
  const chips = [
    ['', '自动判断'],
    ['genshin', '原神'],
    ['starrail', '星穹铁道'],
    ['zzz', '绝区零'],
    ['endfield', '终末地'],
    ['wutheringwaves', '鸣潮'],
    ['arknights', '明日方舟'],
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
            /*
             * 只有真的能在线取的游戏才给这个按钮。
             * 以前写的是「不是异环就显示」，结果崩坏3 / 明日方舟这种
             * 根本没有接口的游戏也会出现「改用在线同步」，点进去必然失败。
             */
            (GACHA_SYNC_MODES[selected] || '') === 'online'
              ? `<button class="btn btn-ghost" data-action="gacha-source" data-value="${selected}">${icon('refresh')}改用在线同步</button>`
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

/* SToken 能接的游戏。和缓存路线不同，这条路线不要求本机装了这个游戏。 */
const GACHA_TOKEN_GAMES = [
  { key: 'genshin', name: '原神' },
  { key: 'starrail', name: '崩坏：星穹铁道' },
  { key: 'zzz', name: '绝区零' },
];

/*
 * 同步弹窗的游戏分组。
 *
 * 不把所有游戏塞进一个下拉，是因为它们根本不吃同一套账号：
 *   米哈游  —— 原神 / 星铁 / 绝区零，认米游社（或 HoYoLAB）账号，扫一次码长期有效；
 *   鹰角    —— 终末地读游戏自己写的抽卡日志，明日方舟目前没有公开接口；
 *   其他    —— 异环只能先用导出工具生成 JSON 再导入。
 *
 * 混在一起会让人误会「同步终末地是不是也要先扫码」，实际不用。
 * 分组之后每组自己说清楚凭据从哪来，用户不用猜。
 */
const GACHA_SYNC_GROUPS = [
  {
    id: 'mihoyo',
    name: '米哈游账号',
    note: '原神 / 星铁 / 绝区零共用米游社账号，扫一次码就能取，不用开游戏。',
    games: ['genshin', 'starrail', 'zzz'],
  },
  {
    id: 'kuro',
    name: '库洛游戏',
    note: '鸣潮不用绑账号：在游戏里点一次「抽卡记录」页的分享，启动器就能从本地日志读到带签名的链接。',
    games: ['wutheringwaves'],
  },
  {
    id: 'hypergryph',
    name: '鹰角网络',
    note: '终末地读游戏自己写的抽卡日志；明日方舟用鹰角账号 token，绑一次就能长期同步。',
    games: ['endfield', 'arknights'],
  },
  {
    id: 'other',
    name: '其他',
    note: '异环没有公开接口，先用 NTE_Gacha_Exporter 导出 JSON 再导入。',
    games: ['neverness'],
  },
];

/*
 * 每款游戏怎么拿数据：
 *   online —— 有在线接口，绑了 SToken 就能直接取（不需要本机装这个游戏）；
 *
 *   注意 starrail 虽然也算 online，但 genAuthKey 给它签的 key 服务端不认
 *   （恒 -100），实际只能读游戏缓存 —— 文案在 gachaSyncHintText 里单独处理。
 *   log    —— 读游戏自己写的日志，要求本机装了并且打开过一次抽卡记录页；
 *   import —— 没有公开接口，只能导入文件。
 */
const GACHA_SYNC_MODES = {
  genshin: 'online',
  starrail: 'online',
  zzz: 'online',
  endfield: 'log',
  wutheringwaves: 'log',
  arknights: 'online',
  neverness: 'import',
};

/*
 * online 里有两种凭据，界面上必须分开说：
 *   米哈游的 SToken（扫码一次，服务端换 authkey）
 *   鹰角的账号 token（从 web-api.hypergryph.com/account/info/hg 复制那一串）
 * 混着叫「绑定 SToken」会让方舟用户去找一个根本不存在的码。
 */
/* 菜单里当前选中的角色 UID（由 openGachaSyncMenu 写入，runGachaSync 读） */
let menuPickedUid = () => '';

const GACHA_CRED_KIND = {
  genshin: 'stoken',
  starrail: 'stoken',
  zzz: 'stoken',
  arknights: 'hyf',
};

const GACHA_SYNC_MODE_TEXT = {
  online: '在线同步',
  log: '读游戏日志',
  import: '需要用导入',
  mixed: '读游戏链接',
};

/**
 * 鹰角面板的事件绑定。
 *
 * 和 SToken 面板分开写：那边的 action 是 gacha-token-manage / gacha-token-new，
 * 这边的管理按钮是 gacha-ak-manage，账号切换是 data-gacha-ak-active。
 * 顺手把卡片也绑上 —— 方舟只有一张固定卡，但点它要能把 UID 交给同步。
 */
function bindGachaAkEvents(onSwitch) {
  const panel = document.querySelector('[data-gacha-token]');
  if (!panel) return;
  const manage = panel.querySelector('[data-action="gacha-ak-manage"]');
  /*
   * 用 onclick 而不是 addEventListener：菜单那边会用 onclick 覆盖成「重画面板」的版本，
   * 两套一起挂就会点一次弹两个窗（先弹一个被后一个替换，看起来像闪了一下）。
   */
  if (manage) manage.onclick = () => openGachaAkModal();
  const picker = panel.querySelector('[data-gacha-ak-active]');
  if (picker && typeof onSwitch === 'function') {
    picker.addEventListener('change', async () => {
      picker.disabled = true;
      try {
        await onSwitch(picker.value);
      } finally {
        picker.disabled = false;
      }
    });
  }
  /*
   * 方舟只有一张固定卡（就是当前账号的 UID），点它是为了把 UID 交给同步，
   * 和米游社那排角色卡片语义一致 —— 复用同一个 dataset 名，走同一段逻辑。
   */
  const cards = Array.from(panel.querySelectorAll('[data-gacha-token-game]'));
  for (const card of cards) {
    card.addEventListener('click', () => {
      for (const other of cards) other.classList.toggle('active', other === card);
      if (typeof panel.__onPick === 'function') {
        panel.__onPick({ game: card.dataset.gachaTokenGame, uid: card.dataset.gachaTokenUid });
      }
    });
  }
  if (cards.length && typeof panel.__onPick === 'function') cards[0].click();
}

/**
 * SToken 管理弹窗。
 *
 * 三个动作对应三个 IPC：
 *   绑定 —— 先校验再落盘，校验失败就把原因写在按钮下面
 *   刷新 —— 角色列表变了（新开服 / 换区）时用，顺带验证 SToken 还有效
 *   解绑 —— 只删本地记录，不影响米游社账号本身
 * 操作完就地重画，不关弹窗，方便连着弄。
 */

/**
 * 「用已登录账号」区块。
 *
 * 抽卡链接本身只有 24 小时寿命，但它的上游凭据（登录态里的 ltoken）能以月计。
 * 启动器本来就能登录米游社，所以正常人根本不该看见 SToken 这个名词 ——
 * 只有没登录过、又不想登录的人，才需要往下展开手填一条。
 */
/**
 * 扫码登录区。
 *
 * 手机米游社扫一下游戏二维码，主进程拿到 game_token 后自己换 SToken，
 * 顺带把 UID 也带回来了 —— 所以这里一个输入框都没有。
 * 二维码两分钟就过期，过期由主进程自动换新，界面只管跟着 status 变。
 */
function gachaTokenScanSection(onBound) {
  const box = document.createElement('div');
  box.className = 'gacha-token-scan';

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = '用米游社 App 扫一下，扫完在手机上点确认。' +
    '这一步走的是官方 App 登录，扫一次就能长期取抽卡记录 —— 不用开游戏，也不用填 UID。';

  const row = document.createElement('div');
  row.className = 'gacha-token-scan-row';

  const startBtn = document.createElement('button');
  startBtn.className = 'btn btn-primary btn-mini';
  startBtn.textContent = '显示二维码';

  /*
   * 不再让用户选游戏：官方 App 扫码登录拿到的是账号级会话，
   * 一个 stoken 就能同步原神 / 星铁 / 绝区零所有角色，选哪个都一样。
   */
  row.append(startBtn);

  const qrBox = document.createElement('div');
  qrBox.className = 'gacha-token-scan-qr';
  qrBox.hidden = true;
  const qrImg = document.createElement('img');
  qrImg.alt = '米游社扫码';
  const qrNote = document.createElement('p');
  qrNote.className = 'form-hint';
  qrBox.append(qrImg, qrNote);

  box.append(hint, row, qrBox);

  let off = null;
  let busy = false;

  function stopWatch() {
    if (off) {
      off();
      off = null;
    }
  }

  function showQr(state) {
    qrBox.hidden = false;
    if (state.qr) qrImg.src = state.qr;
    qrNote.textContent = state.message || '';
    if (state.status === 'success') {
      qrImg.removeAttribute('src');
      qrBox.hidden = true;
      toast(state.message || '扫码成功');
      stopWatch();
      if (onBound) onBound();
    }
    if (state.status === 'failed') {
      qrBox.hidden = true;
      stopWatch();
      toast(state.message || '扫码失败', 'error');
    }
  }

  startBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    startBtn.disabled = true;
    startBtn.textContent = '正在取码…';
    stopWatch();
    try {
      off = api.gacha.onStokenScan(showQr);
      const result = await api.gacha.stokenScanStart({ game: 'genshin' });
      if (!result || !result.ok) {
        qrNote.textContent = (result && result.error) || '发起扫码失败';
        qrBox.hidden = false;
      }
    } catch (error) {
      toast('发起扫码失败：' + (error && error.message ? error.message : error), 'error');
    } finally {
      busy = false;
      startBtn.disabled = false;
      startBtn.textContent = '换一张二维码';
    }
  });

  // 弹窗关掉就把会话停了，免得后台一直换码
  box.addEventListener('gacha-scan-dispose', () => {
    stopWatch();
    api.gacha.stokenScanStop().catch(() => {});
  });

  return box;
}
function gachaTokenLoginSection(onBound) {
  const box = document.createElement('div');
  box.className = 'gacha-token-login';

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  /*
   * 老实说清楚这条路的局限。
   *
   * 网页登录拿到的登录态里只有 ltoken_v2，而申请抽卡 authkey 的 genAuthKey
   * 只认真 SToken —— 实测这条路无论如何签名都回 -100。所以它现在只能
   * 用来「认账号、拉角色列表」，真正同步还得靠上面扫码。
   * 与其含糊其辞让用户以为没生效，不如直接写明。
   */
  hint.textContent = '已经登录过的话，这里能直接认出账号和角色 UID（同步仍需要上面的扫码凭据）。';

  const row = document.createElement('div');
  row.className = 'gacha-token-login-row';

  const provider = document.createElement('select');
  provider.id = 'gacha-token-provider';
  const cnOption = document.createElement('option');
  cnOption.value = 'miyoushe';
  cnOption.textContent = '米游社（国服）';
  const osOption = document.createElement('option');
  osOption.value = 'hoyolab';
  osOption.textContent = 'HoYoLAB（国际服）';
  provider.append(cnOption, osOption);

  const account = document.createElement('select');
  account.id = 'gacha-token-login-account';

  const useBtn = document.createElement('button');
  useBtn.className = 'btn btn-primary btn-mini';
  useBtn.textContent = '用这个账号';

  const loginBtn = document.createElement('button');
  loginBtn.className = 'btn btn-ghost btn-mini';
  loginBtn.innerHTML = icon('user') + '去登录';

  row.append(provider, account, useBtn, loginBtn);

  const note = document.createElement('p');
  note.className = 'form-hint gacha-token-feedback';

  box.append(hint, row, note);

  /** 拉一次登录态，填下拉框；没有登录过就只留「去登录」。 */
  async function refreshProviders() {
    let state = null;
    try {
      state = await api.gacha.stokenLoginState();
    } catch (error) {
      note.textContent = '读不到登录态：' + (error && error.message ? error.message : error);
      return;
    }
    const providers = (state && state.providers) || [];
    account.textContent = '';
    const wanted = provider.value === 'hoyolab' ? 'hoyolab' : 'miyoushe';
    const target = providers.find((item) => item.providerId === wanted);
    const accounts = (target && target.accounts) || [];
    if (!accounts.length) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = wanted === 'hoyolab' ? '还没登录 HoYoLAB' : '还没登录米游社';
      account.append(empty);
      useBtn.disabled = true;
    } else {
      for (const item of accounts) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label + (item.roles ? '' : '（角色未读取）');
        if (target.activeId && item.id === target.activeId) option.selected = true;
        account.append(option);
      }
      useBtn.disabled = false;
    }
  }

  provider.addEventListener('change', () => {
    note.textContent = '';
    refreshProviders();
  });

  useBtn.addEventListener('click', async () => {
    if (!account.value) {
      note.textContent = '这个服务器还没有登录过的账号，先点右边「去登录」。';
      return;
    }
    useBtn.disabled = true;
    useBtn.textContent = '读取中…';
    note.textContent = '';
    try {
      const result = await api.gacha.stokenBindLogin({
        providerId: provider.value,
        accountId: account.value,
      });
      if (result && result.ok) {
        toast('好了，以后同步直接用这个登录态');
        if (result.warning) toast(result.warning, 'error');
        if (onBound) onBound();
      } else {
        note.textContent = (result && result.error) || '绑定失败';
      }
    } catch (error) {
      note.textContent = '绑定失败：' + (error && error.message ? error.message : error);
    } finally {
      useBtn.disabled = false;
      useBtn.textContent = '用这个账号';
    }
  });

  loginBtn.addEventListener('click', async () => {
    loginBtn.disabled = true;
    loginBtn.textContent = '登录窗口已打开…';
    note.textContent = '';
    try {
      const result = await api.hoyolab.login({ provider: provider.value });
      if (result && result.ok) {
        toast('登录好了，点「用这个账号」就行');
      } else if (result && result.reason) {
        note.textContent = result.reason;
      }
    } catch (error) {
      note.textContent = '登录失败：' + (error && error.message ? error.message : error);
    } finally {
      loginBtn.disabled = false;
      loginBtn.innerHTML = icon('user') + '去登录';
      refreshProviders();
    }
  });

  refreshProviders();
  return box;
}
/**
 * onChanged：账号库变了就回调一次，让外层（同步弹窗）重画面板。
 */

/**
 * 明日方舟的账号面板。
 *
 * 它不是 SToken 那套 —— 方舟用的是鹰角自己的账号 token（从
 * web-api.hypergryph.com/account/info/hg 复制那一串）。所以要单独一块，
 * 不能复用 gachaTokenSectionHtml 的扫码 UI。
 */
function gachaAkSectionHtml(store) {
  const accounts = Array.isArray(store && store.accounts) ? store.accounts : [];
  const active = accounts.find((item) => item.id === store.activeId) || accounts[0] || null;
  const head = [
    '<div class="gacha-token-head">',
    '  <span class="gacha-token-title">' + icon('key') + '<strong>鹰角账号</strong></span>',
    '  <button class="btn btn-ghost btn-mini" data-action="gacha-ak-manage">' + icon('settings') + '管理</button>',
    '</div>',
  ].join('\n');

  if (!active) {
    return [
      '<section class="gacha-token" data-gacha-token>',
      head,
      '  <p class="form-hint">还没绑鹰角账号。把账号 token 粘进来一次，之后寻访记录就能直接取，不受 30 天限制。</p>',
      '  <button class="btn btn-primary btn-mini" data-action="gacha-ak-manage">' + icon('key') + '绑定账号 token</button>',
      '</section>',
    ].join('\n');
  }

  const body = [];
  if (accounts.length > 1) {
    body.push(
      '  <label class="field gacha-token-pick">',
      '    <span>用哪个账号</span>',
      '    <select data-gacha-ak-active>',
      ...accounts.map((item) =>
        '      <option value="' + esc(item.id) + '"' + (item.id === active.id ? ' selected' : '') + '>' +
          esc((item.nickname || item.uid) + (item.channel === 'bilibili' ? '（B服）' : '（官服）')) +
          '</option>'
      ),
      '    </select>',
      '  </label>',
    );
  }
  const roles = [];
  if (active.uid) {
    roles.push(
      '  <button class="gacha-token-role active" data-gacha-token-game="arknights" data-gacha-token-uid="' + esc(active.uid) + '">',
      '    <strong>明日方舟</strong>',
      '    <small>UID ' + esc(active.uid) + (active.nickname ? ' · ' + esc(active.nickname) : '') + '</small>',
      '  </button>',
    );
  }
  return [
    '<section class="gacha-token" data-gacha-token>',
    head,
    ...body,
    '  <div class="gacha-token-who">',
    '    <span class="gacha-token-name">' + esc(active.nickname || active.uid || '鹰角账号') + '</span>',
    '    <small>' + esc(active.channel === 'bilibili' ? 'B服' : '官服') + ' · UID ' + esc(active.uid || '-') + '</small>',
    '  </div>',
    roles.length ? '  <div class="gacha-token-roles">' + roles.join('') + '</div>' : '',
    '  <p class="form-hint">用鹰角账号直接取寻访记录，随时可同步。</p>',
    '</section>',
  ].join('\n');
}

/**
 * 绑定 / 解绑鹰角账号。
 *
 * token 的拿法固定写在说明里：登录 user.hypergryph.com，再打开
 * web-api.hypergryph.com/account/info/hg，页面里那一串就是。
 */
function openGachaAkModal(onChanged) {
  const body = document.createElement('div');
  body.className = 'gacha-token-modal';

  const intro = document.createElement('p');
  intro.className = 'form-hint';
  /*
   * 文案先讲一键登录：那才是主路径。手填只在自动拿不到时用，
   * 所以放在下面的折叠区里，别一上来就让人去翻页面源码。
   */
  intro.innerHTML =
    '点下面的按钮会打开鹰角官网登录窗口，登录完这里会自动绑定，不用复制任何东西。<br>' +
    '官网只保留最近 30 天的寻访记录，绑好之后建议隔一段时间同步一次。';

  const field = document.createElement('label');
  field.className = 'field';
  const fieldTitle = document.createElement('span');
  fieldTitle.textContent = '账号 token';
  const input = document.createElement('textarea');
  input.id = 'gacha-ak-input';
  input.rows = 3;
  input.placeholder = '把 web-api.hypergryph.com/account/info/hg 页面里的那一整串粘进来';
  input.autocomplete = 'off';
  input.spellcheck = false;
  field.append(fieldTitle, input);

  /*
   * 主路径：直接开官网登录窗口，登录完自动拿 token。
   * 手填那条降级成备用 —— 让用户去 F12 里找 base64 是最劝退的一步。
   */
  const loginBtn = document.createElement('button');
  loginBtn.className = 'btn btn-primary';
  loginBtn.innerHTML = icon('login') + '直接登录鹰角账号';
  loginBtn.addEventListener('click', async () => {
    if (!api.gacha.akLogin) return;
    loginBtn.disabled = true;
    loginBtn.textContent = '登录窗口已打开…';
    feedback.textContent = '';
    try {
      const result = await api.gacha.akLogin();
      if (result && result.ok) {
        toast('绑好了' + ((result.account && result.account.nickname) ? '（' + result.account.nickname + '）' : ''));
        await reload();
      } else {
        feedback.textContent = (result && result.error) || '登录没有完成';
      }
    } catch (error) {
      feedback.textContent = '登录失败：' + ((error && error.message) || error);
    } finally {
      loginBtn.disabled = false;
      loginBtn.innerHTML = icon('login') + '直接登录鹰角账号';
    }
  });

  const bindBtn = document.createElement('button');
  bindBtn.className = 'btn btn-ghost';
  bindBtn.innerHTML = icon('key') + '校验并绑定';

  const feedback = document.createElement('p');
  feedback.className = 'form-hint gacha-token-feedback';

  const listBox = document.createElement('div');
  listBox.className = 'gacha-token-accounts';

  async function reload() {
    try {
      const store = await api.gacha.akList();
      listBox.textContent = '';
      const accounts = Array.isArray(store && store.accounts) ? store.accounts : [];
      if (!accounts.length) {
        const empty = document.createElement('p');
        empty.className = 'form-hint';
        empty.textContent = '还没有绑定任何账号。';
        listBox.append(empty);
      } else {
        for (const account of accounts) {
          const row = document.createElement('div');
          row.className = 'gacha-token-account' + (account.id === store.activeId ? ' active' : '');
          const info = document.createElement('div');
          info.className = 'gacha-token-account-info';
          const name = document.createElement('strong');
          name.textContent = account.nickname || account.uid;
          const meta = document.createElement('small');
          meta.textContent = (account.channel === 'bilibili' ? 'B服' : '官服') + ' · UID ' + (account.uid || '-');
          info.append(name, meta);
          const actions = document.createElement('div');
          actions.className = 'gacha-token-account-actions';
          const useBtn = document.createElement('button');
          useBtn.className = 'btn btn-ghost btn-mini';
          useBtn.textContent = account.id === store.activeId ? '使用中' : '设为默认';
          useBtn.disabled = account.id === store.activeId;
          useBtn.addEventListener('click', async () => {
            await api.gacha.akActive(account.id);
            await reload();
            if (onChanged) onChanged();
          });
          const removeBtn = document.createElement('button');
          removeBtn.className = 'btn btn-ghost btn-mini';
          removeBtn.textContent = '解绑';
          removeBtn.addEventListener('click', async () => {
            await api.gacha.akRemove(account.id);
            await reload();
            if (onChanged) onChanged();
          });
          actions.append(useBtn, removeBtn);
          row.append(info, actions);
          listBox.append(row);
        }
      }
      if (onChanged) onChanged();
    } catch (error) {
      feedback.textContent = '读取账号失败：' + ((error && error.message) || error);
    }
  }

  bindBtn.addEventListener('click', async () => {
    const value = (input.value || '').trim();
    if (!value) {
      feedback.textContent = '先把账号 token 粘进来';
      return;
    }
    bindBtn.disabled = true;
    bindBtn.textContent = '校验中…';
    feedback.textContent = '';
    try {
      const result = await api.gacha.akBind(value);
      if (result && result.ok) {
        input.value = '';
        toast('绑好了，现在可以同步明日方舟的寻访记录' + ((result.account && result.account.nickname) ? '（' + result.account.nickname + '）' : ''));
        await reload();
      } else {
        feedback.textContent = (result && result.error) || '绑定失败';
      }
    } catch (error) {
      feedback.textContent = '绑定失败：' + ((error && error.message) || error);
    } finally {
      bindBtn.disabled = false;
      bindBtn.innerHTML = icon('key') + '校验并绑定';
    }
  });

  const shell = [
    '<div class="modal-backdrop" data-backdrop>',
    '  <div class="modal narrow" role="dialog" aria-modal="true">',
    '    <div class="modal-head">',
    '      <div><h2>鹰角账号</h2><p>绑定一次，寻访记录随时同步。</p></div>',
    '      <button class="modal-close" data-close title="关闭">' + icon('x') + '</button>',
    '    </div>',
    '    <div class="modal-body" id="gacha-ak-body"></div>',
    '    <div class="modal-foot">',
    '      <button class="btn btn-ghost" data-close>关闭</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('\n');
  openModal(shell);
  const modalBody = document.querySelector('#gacha-ak-body');
  if (modalBody) {
    /*
     * 手填那一整块收进 details：绝大多数用户点「直接登录」就够了，
     * 摆一个大输入框在正中反而像是必须自己填。
     */
    const manual = document.createElement('details');
    manual.className = 'gacha-token-manual';
    const summary = document.createElement('summary');
    summary.textContent = '手里已经有 token？手动填一条';
    manual.append(summary, field, bindBtn);
    modalBody.append(intro, loginBtn, manual, feedback, listBox);
  }
  reload();
}
function openGachaTokenModal(onChanged) {
  const body = document.createElement('div');
  body.className = 'gacha-token-modal';

  const intro = document.createElement('p');
  intro.className = 'form-hint';
  /*
   * 别再写「登录过就能同步」—— 实测网页登录只给 ltoken_v2，
   * 而 genAuthKey 只认真 SToken，登录态认得出账号、拉得到角色，
   * 却申不了 authkey。这里必须写清楚分工，否则用户会以为已经好了。
   */
  intro.innerHTML =
    '想长期同步抽卡记录，扫一次码就够了 —— 用下面的「显示二维码」。' +
    '<br>已经登录过米游社 / HoYoLAB 的话，「直接用已经登录的账号」能认出角色 UID。';

  const field = document.createElement('label');
  field.className = 'field';
  const fieldTitle = document.createElement('span');
  fieldTitle.textContent = 'cookie（整段粘贴）';
  /*
   * 用 textarea 而不是 input：用户粘的是整段 cookie，一行放不下，
   * 也看不见自己粘了什么，容易粘漏。
   */
  const input = document.createElement('textarea');
  input.id = 'gacha-token-input';
  /* 5 行起：一整段 cookie 一般 3~4 行，留一行余量，免得用户以为粘贴被截断 */
  input.rows = 5;
  /* 粘贴后自动撑高，直到触到 max-height 为止 —— 不用用户自己拖 */
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, 180) + 'px';
  });
  input.placeholder = '把整段 cookie 粘进来就行（里面要有 stoken=）。' +
    '只粘一个 stoken 值也可以，但那样认不出是哪个账号。';
  input.autocomplete = 'off';
  input.spellcheck = false;
  field.append(fieldTitle, input);

  const regionField = document.createElement('label');
  regionField.className = 'field';
  const regionTitle = document.createElement('span');
  regionTitle.textContent = '所在服务器';
  const regionSelect = document.createElement('select');
  const cnOption = document.createElement('option');
  cnOption.value = 'cn';
  cnOption.textContent = '国服';
  const osOption = document.createElement('option');
  osOption.value = 'os';
  osOption.textContent = '国际服';
  regionSelect.append(cnOption, osOption);
  regionField.append(regionTitle, regionSelect);

  const bindBtn = document.createElement('button');
  bindBtn.className = 'btn btn-ghost';
  bindBtn.innerHTML = icon('key') + '识别并绑定';

  const feedback = document.createElement('p');
  feedback.className = 'form-hint gacha-token-feedback';

  const listBox = document.createElement('div');
  listBox.className = 'gacha-token-accounts';

  // 手填 SToken 收进折叠区：没登录过、又不想登录的人才会用到
  const manual = document.createElement('details');
  manual.className = 'gacha-token-manual';
  const manualHead = document.createElement('summary');
  manualHead.textContent = '粘一次就长期可用（推荐）：把浏览器里的 cookie 整段复制过来';
  manual.append(manualHead, field, regionField, bindBtn);

  const changed = () => {
    reload();
    if (onChanged) onChanged();
  };
  const scanSection = gachaTokenScanSection(changed);
  body.append(intro, scanSection, gachaTokenLoginSection(changed), manual, feedback, listBox);

  function accountRow(account, store) {
    const row = document.createElement('div');
    row.className = 'gacha-token-account' + (account.id === store.activeId ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'gacha-token-account-info';
    const name = document.createElement('strong');
    name.textContent = account.nickname || 'mid ' + account.mid;
    const meta = document.createElement('small');
    meta.textContent = (account.region === 'os' ? '国际服' : '国服')
      + ' · ' + (account.stokenMasked || '未绑定 SToken');
    const roleText = (account.roles || [])
      .map((role) => {
        const game = GACHA_TOKEN_GAMES.find((item) => item.key === role.game);
        return (game ? game.name : role.game) + ' ' + role.uid;
      })
      .join(' · ');
    const roles = document.createElement('small');
    /*
     * 角色列表为空时别写「可以手动填 UID」。
     *
     * UID 只是用来选「同步哪个号」，真正的门槛是 SToken；没有 SToken 时
     * 填了 UID 照样申不到 authkey。这里只说眼下缺的东西。
     */
    roles.textContent = roleText || (account.hasStoken
      ? '还没读到角色，可以手动填 UID'
      : '还没绑 SToken，扫一次码就好');
    info.append(name, meta, roles);

    const actions = document.createElement('div');
    actions.className = 'gacha-token-account-actions';

    const useBtn = document.createElement('button');
    useBtn.className = 'btn btn-ghost btn-mini';
    useBtn.textContent = account.id === store.activeId ? '使用中' : '设为默认';
    useBtn.disabled = account.id === store.activeId;
    useBtn.addEventListener('click', async () => {
      await api.gacha.stokenActive({ id: account.id });
      await reload();
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-ghost btn-mini';
    refreshBtn.textContent = '刷新角色';
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '刷新中…';
      try {
        const result = await api.gacha.stokenRefresh({ id: account.id });
        if (result && result.ok) toast('角色列表已更新');
        else toast((result && result.error) || '刷新失败', 'error');
      } catch (error) {
        toast('刷新失败：' + (error && error.message ? error.message : error), 'error');
      } finally {
        await reload();
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-ghost btn-mini';
    removeBtn.textContent = '解绑';
    removeBtn.addEventListener('click', async () => {
      await api.gacha.stokenRemove({ id: account.id });
      await reload();
    });

    actions.append(useBtn, refreshBtn, removeBtn);
    row.append(info, actions);
    return row;
  }

  async function reload() {
    try {
      const store = await api.gacha.stokenList();
      listBox.textContent = '';
      const accounts = Array.isArray(store && store.accounts) ? store.accounts : [];
      if (!accounts.length) {
        const empty = document.createElement('p');
        empty.className = 'form-hint';
        empty.textContent = '还没有绑定任何账号。';
        listBox.append(empty);
        return;
      }
      for (const account of accounts) listBox.append(accountRow(account, store));
      if (onChanged) onChanged();
    } catch (error) {
      feedback.textContent = '读取账号失败：' + (error && error.message ? error.message : error);
    }
  }

  bindBtn.addEventListener('click', async () => {
    const value = (input.value || '').trim();
    if (!value) {
      feedback.textContent = '先把 SToken 粘进来';
      return;
    }
    bindBtn.disabled = true;
    bindBtn.textContent = '校验中…';
    feedback.textContent = '';
    try {
      const result = await api.gacha.stokenBindBundle({
        raw: value,
        region: regionSelect.value,
      });
      if (result && result.ok) {
        input.value = '';
        /*
         * 有 login_ticket 才能承诺「以后不用再管」：SToken 过期时能自己换回来。
         * 没有的话只能说「绑定成功」，不要给做不到的承诺。
         */
        toast(result.canRenew
          ? '绑定好了。以后同步全自动，SToken 过期也会自己续。'
          : '绑定好了，现在能直接取抽卡记录。');
        if (result.warning) toast(result.warning, 'error');
        await reload();
      } else {
        feedback.textContent = (result && result.error) || '绑定失败';
      }
    } catch (error) {
      feedback.textContent = '绑定失败：' + (error && error.message ? error.message : error);
    } finally {
      bindBtn.disabled = false;
      bindBtn.innerHTML = icon('key') + '识别并绑定';
    }
  });

  // STOKEN-PATCH-V1
  /* 只用单引号拼，别换成反引号 —— 这里的字符串会被原样写进 gacha.js */
  const shell = [
    '<div class="modal-backdrop" data-backdrop>',
    '  <div class="modal narrow" role="dialog" aria-modal="true">',
    '    <div class="modal-head">',
    '      <div><h2>SToken 账号</h2><p>绑定一次，抽卡记录随时同步。</p></div>',
    '      <button class="modal-close" data-close title="关闭">' + icon('x') + '</button>',
    '    </div>',
    '    <div class="modal-body" id="gacha-token-body"></div>',
    '    <div class="modal-foot">',
    '      <button class="btn btn-ghost" data-close>关闭</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('\n');
  openModal(shell, {
    /*
     * 关掉弹窗就把扫码会话停掉。
     * 主进程那边是每 2 秒查一次、每 2 分钟换一张码，留着不管会一直打接口。
     * 注意 closeModal 会先清空 DOM 再回调，所以这里不能靠查 DOM，
     * 直接无条件发一次停止。
     */
    onClose: () => {
      if (api.gacha.stokenScanStop) api.gacha.stokenScanStop().catch(() => {});
    },
  });
  const modalBody = document.querySelector('#gacha-token-body');
  if (modalBody) modalBody.append(body);
  reload();
}

/**
 * 把分好组的游戏渲染成 optgroup。
 *
 * 用原生 optgroup 而不是自己画一排按钮：下拉本身是可访问的，
 * 键盘能走、读屏能读，optgroup 的 label 也天然是分组标题。
 */
function gachaSyncOptionsHtml(candidates, defaultGame) {
  const parts = [];
  for (const entry of candidates) {
    /*
     * 整组都是「只能导入」的游戏时仍然列出来 —— 用户点进来是想知道
     * 这个游戏怎么办，藏掉反而要再翻一次导入弹窗。
     */
    parts.push('<optgroup label="' + esc(entry.group.name) + '">');
    for (const game of entry.games) {
      const mode = GACHA_SYNC_MODES[game.builtinKey] || 'import';
      /*
       * 星铁的标签单独写。它虽然算 online，但绑了 SToken 也取不到，
       * 下拉里写「在线同步」就是在骗人 —— 选中之后下面的说明又翻案，
       * 两句话互相打架，用户只会觉得这功能坏了。
       */
      const tail = game.builtinKey === 'starrail' ? GACHA_SYNC_MODE_TEXT.mixed : GACHA_SYNC_MODE_TEXT[mode];
      const selected = game.id === defaultGame.id ? ' selected' : '';
      parts.push(
        '<option value="' + esc(game.id) + '"' + selected + '>' +
        esc(game.name) + '（' + esc(tail) + '）</option>'
      );
    }
    parts.push('</optgroup>');
  }
  return parts.join('\n              ');
}

/**
 * 选中某款游戏后，在下方说清楚「这次同步到底靠什么拿数据」。
 *
 * 三句话对应三种机制，别让用户从失败提示里反推。
 */
function gachaSyncModeHtml(builtinKey) {
  const mode = GACHA_SYNC_MODES[builtinKey] || 'import';
  if (mode === 'online') {
    /*
     * 星铁虽然也走同一条米游社在线接口，但 genAuthKey 给它签的 key
     * 服务端不认（恒 -100），实际只能读游戏缓存里那条链接。
     * 这句说明必须和下面那句提示说同一件事，不然界面上会互相打架。
     */
    if (builtinKey === 'starrail') {
      return icon('file') + '<span>星铁要读游戏里的链接：在星铁里打开一次抽卡记录，再回来点同步。</span>';
    }
    if (builtinKey === 'arknights') {
      /*
       * 方舟走的是鹰角自己的账号体系，跟米游社完全无关。
       * 写「米游社账号」会让用户跑去找一个不存在的扫码入口。
       */
      return icon('key') + '<span>这款用鹰角账号 token：粘一次就能长期同步，不用开游戏。</span>';
    }
    return icon('key') + '<span>这款走米游社账号，绑了 SToken 直接取，不用开游戏。</span>';
  }
  if (mode === 'log') {
    /*
     * 鸣潮的日志是「分享」动作才写进去的，和终末地「打开页面就读」不是一回事，
     * 所以说清楚要点一次分享，否则用户打开记录页就回来点同步，必然失败。
     */
    if (builtinKey === 'wutheringwaves') {
      return icon('file') + '<span>这款读游戏日志里的分享链接：在鸣潮里打开抽卡记录页，点右上角「分享」一次，再回来点同步。</span>';
    }
    return icon('file') + '<span>这款读游戏自己写的抽卡日志：在游戏里打开一次抽卡记录，再回来点同步。</span>';
  }
  return icon('download') + '<span>这款没有公开接口，得先用导出工具生成 JSON，再点「改用导入」。</span>';
}

/** 这个账号到底能不能申 authkey。hasStoken 是新字段，老数据只有 stokenMasked。 */
function gachaHasToken(account) {
  if (!account) return false;
  return account.hasStoken === undefined ? Boolean(account.stokenMasked) : account.hasStoken === true;
}

/**
 * 底部那句提示，按「当前选的游戏 + 账号状态」拼。
 *
 * 说人话的要点：只讲这款游戏要怎么办，不要把另外两套机制的说明一起塞过来 ——
 * 用户只关心眼前这个游戏。
 */
function gachaSyncHintText(builtinKey, ready) {
  const mode = GACHA_SYNC_MODES[builtinKey] || 'import';
  if (mode === 'log') {
    if (builtinKey === 'wutheringwaves') {
      return '鸣潮要先用游戏里的「分享」把链接写进本地日志：打开抽卡记录页 → 右上角「分享」→ 随便选一种完成一次 → 回来点同步。';
    }
    return '这款读游戏自己写的抽卡日志：在游戏里打开一次抽卡记录，再回来点同步就行。';
  }
  if (mode === 'import') {
    return '这款没有公开接口，点左下角「改用导入」，选导出工具生成的 JSON 文件。';
  }
  /*
   * 星铁单独说清楚：SToken 这条路它走不通。
   *
   * genAuthKey 给原神 / 绝区零签的 key 服务端都认，唯独星铁恒回
   * -100 authkey error（详见交接文档 §6.2）。所以星铁实际上只能读
   * 游戏缓存里那条 24 小时有效的链接 —— 与其让用户点完看到报错，
   * 不如提前把该做的事说清楚。
   */
  if (builtinKey === 'starrail') {
    return ready
      ? '星铁这条得读游戏里的链接：先在星铁里打开一次抽卡记录，再回来点同步。'
      : '先在星铁里打开一次抽卡记录页面（网页版那个），再回来点同步。';
  }
  if (builtinKey === 'arknights') {
    return ready
      ? '已经绑了鹰角账号，点开始就能取寻访记录。'
      : '还没绑鹰角账号。点下面「鹰角账号」把账号 token 粘进来，绑一次就长期可用。';
  }
  return ready
    ? '这台机器已经绑了 SToken，点开始就能取，不用开游戏。'
    : '还没绑 SToken。点左下角头像 →「抽卡账号」扫一次码，以后一直能用。';
}

/*
 * 四项同步菜单（点抽卡页「同步」按钮弹出的那个窗）。
 *
 * 参考胡桃的交互：不先问「从哪个游戏同步」，而是直接按当前页面选中的游戏
 * 给出四条取数路径，弹窗里没有任何下拉 / 选项让用户重选游戏。四条路：
 *
 *   stoken —— 从 SToken 获取：强制用已绑定账号申 authkey，不读缓存。
 *   cache  —— 从网页缓存获取：强制读游戏写进本地的抽卡链接，不碰 SToken。
 *   full   —— 全量刷新：忽略本地已有记录，完整重拉（来源用默认：SToken 优先、缓存兜底）。
 *   import —— 导入记录：从 UIGF / SRGF / 异环导出 JSON 等本地文件导入。
 *
 * 前两项定「凭据从哪来」，第三项定「拉多少」，第四项是本地文件导入。
 * 底部按钮另有「增量刷新」（只补新记录）和「手动输入 URL」，以及账号中心入口。
 * 用户要求「导入和增量更新互换位置」后就是这个布局。
 *
 * 游戏是页面当前选中的那款，所以这里不再摆下拉 —— 以前那个下拉会让用户
 * 以为「要同步哪个游戏得在弹窗里重新选」，跟正在看的页面脱节。
 */
function openGachaSyncMenu() {
  /*
   * 空态（第一次进来、还没读出记录）时 gachaEnsureSelection() 会因为
   * state.gacha 为 null 直接返回 null。以前四项菜单没人调用所以没暴露，
   * 现在「同步」直接接过来，必须兜底：按当前页面选中的 key，再没有就
   * 默认原神，保证菜单永远能显示当前游戏、四项不会一起变灰。
   */
  let selection = gachaEnsureSelection();
  let key = selection?.game?.key || state.gachaGameKey || "genshin";
  if (!GACHA_SYNC_MODES[key]) key = "genshin";
  const mode = GACHA_SYNC_MODES[key] || "import";
  const gameName =
    selection?.game?.name || GACHA_GAMES.find((item) => item.key === key)?.name || "当前游戏";
  const uid = selection?.user?.uid || "";

  /*
   * 四项的可用性：没有在线接口的游戏（崩坏3 / 明日方舟 / 异环）只留导入，
   * 其余三项点了必然失败，不如直接灰掉并写明原因。
   *
   * 星铁单独处理：它的 mode 虽然是 online，但服务端只认游戏客户端签的
   * authkey，我们签的一律 -100。主进程里星铁那条分支也是直接读缓存，
   * 所以这里必须把「SToken 刷新」灰掉 —— 留成可用会让人以为点了就是走
   * SToken，实际偷偷读缓存，等于骗用户。
   */
  /*
   * 凭据种类：米哈游走 SToken（扫码换 authkey），鹰角走账号 token。
   * 但方舟的「登录」发生在左下角账号中心里，这个菜单只负责取数 ——
   * 所以下面会把方舟那条「鹰角账号同步」整个去掉。
   */
  const credential = GACHA_CRED_KIND[key] || "stoken";
  const onlineOk = mode === "online" && key !== "starrail";
  /*
   * 方舟既不写网页缓存，也没有可以粘的 URL —— 它只有一条路：
   * 用左下角账号中心里登录的鹰角账号去取。所以这里把缓存和手动都关掉，
   * 只留「全量刷新」这一项能点。
   */
  const isHyf = credential === "hyf";
  const cacheOk = (mode === "online" || mode === "log") && !isHyf;
  /*
   * 异环没有任何在线取数路径，菜单四条全灰。
   * 不提一句「只能导入」的话，用户看着四个灰按钮会以为启动器坏了。
   */
  const onlyImport = key === "neverness";

  /*
   * 四项主菜单：SToken / 网页缓存 / 全量 / 导入。
   * 「增量刷新」和「手动输入 URL」挪到底部按钮组（用户要求导入与增量互换位置）。
   */
  const items = [
    {
      id: "stoken",
      icon: "key",
      title: credential === "hyf" ? "从鹰角账号获取" : "从 SToken 获取",
      note:
        credential === "hyf"
          ? "用左下角账号中心里登录的鹰角账号直接取寻访记录，只补新增。"
          : onlineOk
            ? "用绑定的 SToken 直接申 authkey 取记录，只补新增，不用开游戏、不受缓存 24 小时限制。"
            : key === "starrail"
              ? "星铁不支持这条路 —— 它的抽卡 key 只发给游戏客户端本身。"
              : "这款没有在线抽卡接口，只能读缓存或导入。",
      enabled: onlineOk,
    },
    {
      id: "cache",
      icon: "file-text",
      title: "从网页缓存获取",
      note: credential === "hyf"
        ? "明日方舟不写抽卡缓存 —— 用上面那条「从鹰角账号获取」。"
        : cacheOk
          ? "读游戏写进本地缓存的抽卡链接，只补新增。星铁请先在游戏里打开一次跃迁记录。"
          : "这款游戏不写抽卡缓存。",
      enabled: cacheOk,
    },
    {
      id: "full",
      icon: "refresh",
      title: "全量刷新",
      note: credential === "hyf"
        ? "用绑定的鹰角账号把寻访记录完整重取一遍，忽略本地已有记录。"
        : "忽略本地已有记录，把完整历史重新拉一遍，补上缺的部分。会多花一些时间。",
      enabled: cacheOk || onlineOk,
    },
    {
      id: "import",
      icon: "download",
      title: "导入记录",
      note: "从 UIGF / SRGF / 异环导出 JSON 等本地文件导入抽卡记录，不联网。",
      enabled: true,
    },
  ];
  /*
   * 手动粘 URL 挪进列表、跟在「导入记录」后面。
   *
   * 它原来在底部按钮组里，和「账号中心 / 增量刷新」挤在一起；但它的性质
   * 其实是第五种取数方式（缓存读不到、SToken 又签不出时唯一的活路），
   * 和上面四项是并列关系，放进列表里用户才看得懂它是「换一条路拿数据」，
   * 而不是一个次要开关。
   *
   * 异环（只能导入）和鹰角（没有可粘的链接）不显示这一项。
   */
  if (mode !== "import" && credential !== "hyf") {
    items.push({
      id: "manual",
      icon: "type",
      title: "手动输入 URL",
      note: "把游戏里「抽卡记录」页面复制出来的链接粘进来，按这条链接取一次。",
      enabled: true,
    });
  }

  openModal(
    [
      '<div class="modal-backdrop" data-backdrop>',
      '  <div class="modal narrow" role="dialog" aria-modal="true">',
      '    <div class="modal-head">',
      '      <div><h2>同步抽卡记录</h2><p>' +
        esc(gameName) +
        (uid ? " · UID " + esc(uid) : "") +
        '</p></div>',
      '      <button class="modal-close" data-close title="关闭">' + icon("x") + "</button>",
      "    </div>",
      '    <div class="modal-body">',
      '      <div class="sync-menu">',
      items
        .map((item) =>
          [
            '        <button class="sync-menu-item gacha-sync-choice' +
              (item.enabled ? '' : ' is-disabled') +
              '" data-action="gacha-sync-run" data-value="' +
              esc(item.id) +
              '"' +
              (item.enabled ? '' : ' disabled') +
              '>',
            '          <span class="sync-menu-icon">' + icon(item.icon) + '</span>',
            '          <span class="sync-menu-copy"><strong>' + esc(item.title) +
              '</strong><small>' + esc(item.note) + '</small></span>',
            '          <span class="sync-menu-arrow">' + icon('chevron-right') + '</span>',
            '        </button>',
          ].join('')
        )
        .join(''),
      "      </div>",
      onlyImport
        ? '      <div class="sync-menu-note">' +
          icon("info") +
          '<span>异环没有公开的抽卡接口（日志是加密的），在线取数三条路都走不通。要统计只能先用社区抓包工具导出 JSON，再点上面那条「导入记录」。</span>' +
          "</div>"
        : "",
      /*
       * 凭据面板：四项菜单只决定「怎么取数」，但取数前用户得先有凭据。
       * 以前这块只在旧弹窗里，菜单改版后漏掉了，于是方舟点进来没有任何绑定入口。
       */
      '<div data-gacha-token-slot></div>',
      '      <p class="form-hint" id="gacha-sync-hint"></p>',
      '      <p class="form-hint">SToken / 网页缓存 / 底部「增量刷新」只补新记录；「全量刷新」会忽略本地已有记录重拉一遍，但都不会覆盖或删除本地数据。</p>',
      '      <div class="field-error" id="gacha-sync-menu-error"></div>',
      "    </div>",
      '    <div class="modal-foot">',
      '      <button class="btn btn-ghost" data-close>取消</button>',
      /*
       * 所有通行证（米游社 / HoYoLAB / 鹰角）的账号管理都收进了左下角头像里的
       * 账号中心。点「账号中心」登录后回来，四项同步按钮直接就能点 ——
       * 菜单每次打开都会重读账号状态，不用重启、不用再进一次这个弹窗。
       */
      '      <button class="btn btn-ghost" data-action="open-account-center">' +
        icon("user") +
        "账号中心</button>",
      /*
       * 增量刷新：和四项主菜单里的「导入记录」互换位置后挪到这里。
       * 只补新记录，来源用默认（SToken 优先、缓存兜底）。
       */
      '      <button class="btn btn-ghost" data-action="gacha-sync-run" data-value="incremental">' +
        icon("refresh") +
        "增量刷新</button>",
      /*
       * 「手动输入 URL」已经挪到上面四项列表里，跟在「导入记录」后面
       * （用户要求：放到导入记录下面）。这里不再重复摆一个按钮。
       */
      "    </div>",
      "  </div>",
      "</div>",
    ].join(""),
  );

  /*
   * 菜单弹窗自己维护一份状态：它不继承 openGachaSyncModal 里那几个闭包变量。
   * 拉两套账号各画各的，按当前游戏决定显示哪一块。
   */
  const menuState = { tokenStore: { accounts: [], activeId: '' }, akStore: { accounts: [], activeId: '' } };
  /* 菜单里点的角色卡片，同步时优先用它带的 UID */
  let pickedInMenu = null;
  /*
   * 菜单里点的卡片要能被 runGachaSync 读到。
   * 它们在同一个函数作用域里，直接挂一个读函数上去最省事，
   * 不用为了一个 uid 再往全局塞状态。
   */
  menuPickedUid = () => (pickedInMenu && pickedInMenu.uid) || '';
  const isAk = key === 'arknights';
  const slot = document.querySelector('[data-gacha-token-slot]');
  const hintEl = document.querySelector('#gacha-sync-hint');

  function paint() {
    if (!slot) return;
    /*
     * 只有 online 的游戏才需要凭据面板。崩坏3 / 异环这种只能导入的，
     * 摆一个「绑定 SToken」在那里纯属误导 —— 绑了也取不到记录。
     */
    if (mode !== 'online') {
      slot.hidden = true;
      slot.innerHTML = '';
      if (hintEl) hintEl.textContent = '';
      return;
    }
    /*
     * 这个弹窗只管「用哪种方式取数」，不再摆任何账号面板。
     *
     * 米哈游的 SToken 账号、鹰角的账号，全都在左下角头像里的账号中心
     * （「抽卡账号」「鹰角账号」两栏）。同一个东西摆在两个地方，用户永远
     * 不知道该点哪个，改了这边那边不跟着变。
     */
    slot.hidden = true;
    slot.innerHTML = '';
    if (hintEl) {
      if (isAk) {
        const list = (menuState.akStore && menuState.akStore.accounts) || [];
        const active = list.find((item) => item.id === ((menuState.akStore && menuState.akStore.activeId) || list[0]?.id));
        hintEl.textContent = active
          ? '点「全量重取」用绑定的鹰角账号取寻访记录。换账号去左下角头像 →「鹰角账号」。'
          : '还没登录鹰角账号。点左下角头像 →「鹰角账号」登录一次，回来就能取。';
      } else if (mode === 'log') {
        /* 终末地读游戏自己写的日志，不需要账号，只提醒去游戏里开一次 */
        hintEl.textContent = '先在游戏里打开一次抽卡记录页面，再回来点同步。';
      } else {
        const hasAny = ((menuState.tokenStore && menuState.tokenStore.accounts) || []).length > 0;
        hintEl.textContent = hasAny
          ? '抽卡账号在左下角头像 →「抽卡账号」里切换。'
          : '还没绑 SToken。点左下角头像 →「抽卡账号」扫一次码，以后就不用开游戏了。';
      }
    }
  }

  paint();
  if (isAk) {
    if (api.gacha.akList) api.gacha.akList().then((store) => { if (store) menuState.akStore = store; paint(); }).catch(() => {});
  } else if (api.gacha.stokenList) {
    /* 只要「有没有绑过」这一个信息，用来决定指路文案，不画卡片 */
    api.gacha.stokenList().then((store) => { if (store) menuState.tokenStore = store; paint(); }).catch(() => {});
  }
}

/*
 * 手动 URL 输入框。粘一条完整的抽卡链接进来就行 ——
 * 浏览器里对着抽卡记录页按 F12，从 Network 里复制那条 getGachaLog 即可。
 */
function gachaManualUrlModal(gameKey) {
  const selection = gachaEnsureSelection();
  const gameName = selection?.game?.name || gameKey || "当前游戏";
  openModal(
    [
      '<div class="modal-backdrop" data-backdrop>',
      '  <div class="modal narrow" role="dialog" aria-modal="true">',
      '    <div class="modal-head">',
      '      <div><h2>手动输入抽卡链接</h2><p>' +
        esc(gameName) +
        " · 直接把整条 URL 粘进来</p></div>",
      '      <button class="modal-close" data-close title="关闭">' + icon("x") + "</button>",
      "    </div>",
      '    <div class="modal-body">',
      '      <label class="field">',
      '        <span>抽卡链接</span>',
      '        <textarea id="gacha-manual-url" rows="4" placeholder="https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog?authkey_ver=1&amp;..." style="font-family:var(--font-mono, ui-monospace, monospace);font-size:12px;word-break:break-all"></textarea>',
      "      </label>",
      '      <p class="form-hint">在浏览器里打开官方抽卡记录页，按 F12 → Network → 找 getGachaLog 请求 → 右键 Copy → Copy link address。</p>',
      '      <div class="field-error" id="gacha-manual-error"></div>',
      "    </div>",
      '    <div class="modal-foot">',
      '      <button class="btn btn-ghost" data-close>取消</button>',
      '      <button class="btn btn-primary" id="gacha-manual-start">' +
        icon("refresh") +
        "开始同步</button>",
      "    </div>",
      "  </div>",
      "</div>",
    ].join(""),
  );
  const input = document.querySelector("#gacha-manual-url");
  const start = document.querySelector("#gacha-manual-start");
  const errorBox = document.querySelector("#gacha-manual-error");
  if (!input || !start) return;
  input.focus();
  start.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) {
      errorBox.textContent = "先把抽卡链接粘进来";
      return;
    }
    if (!/^https?:\/\//i.test(value) || !value.includes("authkey=")) {
      errorBox.textContent = "这不是一条抽卡链接 —— 里面应该带 authkey= 参数";
      return;
    }
    start.disabled = true;
    start.textContent = "同步中…";
    try {
      const game = (state.games || []).find((item) => item.builtinKey === gameKey);
      const result = await api.gacha.sync(game?.id, undefined, { manualUrl: value, allowCache: false });
      if (result && result.ok === false) {
        errorBox.textContent = result.error || "同步失败";
        return;
      }
      closeModal();
      await loadGacha(true);
      toast("同步完成：" + (result.imported || 0) + " 条新记录", "success");
    } catch (error) {
      errorBox.textContent = humanError(error);
    } finally {
      start.disabled = false;
      start.innerHTML = icon("refresh") + "开始同步";
    }
  });
}

/*
 * 真正跑同步。四种入口最终都收到这里 ——
 * 这样「走哪条路」的判断只有一处，不用在四个地方各写一遍。
 */
async function runGachaSync(kind) {
  const selection = gachaEnsureSelection();
  /* 和 openGachaSyncMenu 用同一套兜底：空态时也能定位到当前游戏 */
  let key = selection?.game?.key || state.gachaGameKey || "genshin";
  if (!GACHA_SYNC_MODES[key]) key = "genshin";
  const game = (state.games || []).find((item) => item.builtinKey === key);
  if (!game) {
    toast("没找到这款游戏的配置", "error");
    return;
  }
  const errorBox = document.querySelector("#gacha-sync-menu-error");
  /*
   * 四条主菜单 + 底部的「增量刷新」都算同步入口，跑的时候一起禁掉
   * （以前只禁 .gacha-sync-choice，底部那颗还能连点，等于并发触发两次同步）。
   */
  const buttons = Array.from(document.querySelectorAll('[data-action="gacha-sync-run"]'));
  const disable = (flag) => buttons.forEach((btn) => { btn.disabled = flag; });
  /*
   * 同步期间的可见反馈。
   *
   * 鹰角那条链没有「一次拿完」的接口：要先走一遍完整认证
   * （OAuth → 绑定列表 → U8 token → 角色登录 → ak-user-center），
   * 实测光认证就要 8~9 秒，之后三个寻访类别各翻一遍才出结果。
   * 以前这段时间只做了 disable(true)，按钮全灰、文字一个都不变，
   * 用户完全看不出来是在跑还是死了 —— 这就是「点了没反应」。
   *
   * 所以：被点的那一条换成「正在同步…」+ 一句进度说明，同步结束再换回来。
   */
  const clicked = buttons.find((btn) => btn.dataset.value === kind) || null;
  /*
   * 只改这一条里的 title / note，别整块 innerHTML 重写 ——
   * 那会把图标和右侧箭头一起冲掉，按钮宽度跳一下很像界面坏了。
   * 底部那颗「增量刷新」没有 strong / small，拿不到就跳过，不算错。
   */
  const clickedTitle = clicked ? clicked.querySelector('strong') : null;
  const clickedNote = clicked ? clicked.querySelector('small') : null;
  const originalTitle = clickedTitle ? clickedTitle.textContent : '';
  const originalNote = clickedNote ? clickedNote.textContent : '';
  const progressTitle = '正在同步…';
  const progressNote =
    key === 'arknights'
      ? '要先登录一次鹰角，通常十几秒，别关窗口。'
      : kind === 'cache'
        ? '正在读游戏写下的抽卡缓存…'
        : '正在向服务器取抽卡记录，请稍等…';
  const setBusy = (busy) => {
    disable(busy);
    if (clickedTitle) clickedTitle.textContent = busy ? progressTitle : originalTitle;
    if (clickedNote) clickedNote.textContent = busy ? progressNote : originalNote;
  };

  /*
   * 主菜单四项：stoken / cache 定「凭据从哪来」（互斥），full 定「拉多少」，
   * import 是本地文件导入。底部按钮的 incremental 只补新记录，来源统一走
   * 后端默认（SToken 优先、缓存兜底）。星铁后端本来就直接读缓存，不经过
   * SToken 段，四项都不会走错路。
   */
  /*
   * 导入和手动输入都不是「再跑一次同步」，而是换一个弹窗 ——
   * 直接在这里打开对应弹窗并返回，别走到下面的 api.gacha.sync。
   */
  if (kind === "import") {
    closeModal();
    openGachaImportModal(key);
    return;
  }
  if (kind === "manual") {
    gachaManualUrlModal(key);
    return;
  }

  const options = {};
  if (kind === "stoken") {
    /* 强制只用 SToken，不读缓存；后端 stokenOnly=true 保证不偷偷兜底 */
    options.stokenOnly = true;
    options.allowCache = false;
  } else if (kind === "cache") {
    /* 强制只读网页缓存，不碰 SToken；绑了账号也一样 */
    options.cacheOnly = true;
    options.allowCache = true;
  } else if (kind === "full") {
    /* 全量重拉，来源用默认：SToken 优先、失败兜底读缓存 */
    options.allowCache = true;
    options.full = true;
  } else if (kind === "incremental") {
    /* 只补新增，来源同样用默认 */
    options.allowCache = true;
  }
  /*
   * UID 的优先级：菜单里点过的角色卡 > 当前抽卡页选中的角色。
   * 方舟和米哈游的 uid 来源不同，但这里语义一致，都是「取哪个号的数据」。
   */
  const menuUid = (typeof menuPickedUid === 'function' ? menuPickedUid() : '') || '';
  if (menuUid) options.uid = menuUid;
  else if (selection?.user?.uid) options.uid = selection.user.uid;

  setBusy(true);
  if (errorBox) errorBox.textContent = "";
  try {
    const result = await api.gacha.sync(game.id, undefined, options);
    if (result && result.ok === false) {
      /*
       * 方舟没绑账号时后端会带 needToken —— 这里直接把绑定弹窗顶出来，
       * 别只丢一句「还没绑」。用户已经点到这里了，离绑好只差一步。
       */
      if (result.needToken && typeof openGachaAkModal === 'function') {
        closeModal();
        openGachaAkModal(() => {
          toast('绑好了，再点一次同步就行', 'success');
        });
        return;
      }
      if (errorBox) errorBox.textContent = result.error || "同步失败";
      return;
    }
    closeModal();
    await loadGacha(true);
    const added = result?.imported || 0;
    toast(added ? "同步完成：" + added + " 条新记录" : "已经是最新的了，没有新记录", "success");
  } catch (error) {
    if (errorBox) errorBox.textContent = humanError(error);
  } finally {
    setBusy(false);
  }
}

function openGachaSyncModal() {
  /*
   * 列出所有接入了同步的游戏，按账号体系分组。
   *
   * 以前这里要求「客户端已经装好并且配了路径」，但原神 / 星铁 / 绝区零
   * 走的是在线接口 —— 只要有 SToken，机器上没装这个游戏也能取记录。
   * 那个条件把没装的游戏整个藏掉了，用户会以为「不支持」。
   */
  const candidates = GACHA_SYNC_GROUPS.map((group) => ({
    group,
    games: group.games
      .map((key) => (state.games || []).find((game) => game.builtinKey === key))
      .filter(Boolean),
  })).filter((entry) => entry.games.length);
  if (!candidates.length) {
    toast('这个版本没有可同步的游戏', 'error');
    return;
  }
  const allGames = candidates.reduce((list, entry) => list.concat(entry.games), []);
  const pickable = allGames.filter((game) => GACHA_SYNC_MODES[game.builtinKey] !== 'import');
  const listed = pickable.length ? pickable : allGames;
  const defaultGame =
    listed.find((game) => game.builtinKey === state.gachaGameKey) || listed[0];
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
              ${gachaSyncOptionsHtml(candidates, defaultGame)}
            </select>
          </label>
          <div class="gacha-sync-mode" id="gacha-sync-mode"></div>
          <div data-gacha-token-slot></div>
          <!--
            手动填 UID 的入口（可留空）。

            为什么需要它：SToken 能申到 authkey，但有些账号的角色列表拉不出来
            （新号、被风控、接口改版），此时不知道 uid 就同步不了。用户自己知道
            UID，填一次就能取 —— stoken-sync.js:549 的注释也写了这条路径。
            默认隐藏，只有「米游社三款 + online 模式」才露出来（方舟走鹰角 token，
            UID 由鹰角账号带出来，不需要手填）。
          -->
          <label class="field" id="gacha-sync-uid-field" hidden>
            <span>游戏 UID（可留空）</span>
            <input id="gacha-sync-uid" placeholder="留空时用账号里记的角色 UID" spellcheck="false" inputmode="numeric" autocomplete="off" />
            <span class="hint">角色列表拉不出来（新号 / 被风控）时，填上 UID 也能同步。</span>
          </label>
          <div class="form-note">${icon('info')}<span id="gacha-sync-hint"></span></div>
          <p class="form-hint">同步只会新增记录，不会覆盖或删除本地已有的数据。</p>
          <div class="field-error" id="gacha-sync-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>取消</button>
          <button class="btn btn-ghost" data-action="open-account-center">${icon('user')}账号中心</button>
          <button class="btn btn-ghost" data-action="import-gacha">${icon('download')}改用导入</button>
          <button class="btn btn-primary" id="gacha-sync-start">${icon('refresh')}开始增量同步</button>
        </div>
      </div>
    </div>
  `);
  const start = document.querySelector('#gacha-sync-start');
  if (!start) return;

  /** 当前下拉选中的游戏（builtinKey）。 */
  function currentKey() {
    const id = document.querySelector('#gacha-sync-game')?.value;
    const game = state.games.find((item) => item.id === id);
    return (game && game.builtinKey) || '';
  }

  /**
   * 按当前游戏的取数方式调整这一屏：
   *
   *   online —— 显示 SToken 面板；按钮叫「开始增量同步」
   *   log    —— 不需要 SToken，收起面板；按钮还是同步
   *   import —— 这条路线根本没有在线接口，按钮改成「改用导入」并直接打开导入框
   *
   * 以前三种情况长得一模一样，用户点「开始同步」只会拿到一句看不懂的报错。
   */
  function applySyncMode() {
    const key = currentKey();
    const mode = GACHA_SYNC_MODES[key] || 'import';
    const modeBox = document.querySelector('#gacha-sync-mode');
    if (modeBox) modeBox.innerHTML = gachaSyncModeHtml(key);
    const tokenSlot = document.querySelector('[data-gacha-token-slot]');
    /*
     * 星铁不看 SToken 的面板：它绑不绑都只能读缓存，摆一排用不上的账号卡片
     * 只会让人以为「这里能取到」。等星铁那条路真的通了再放出来。
     */
    if (tokenSlot) {
      /*
       * 米哈游三款的 SToken 面板已经统一收进左下角头像里的账号中心，
       * 这里不再重复画账号卡片和切换下拉 —— 同一个东西摆两处只会让人犹豫点哪个。
       * 只有方舟的鹰角账号面板还留在这个槽位里（那是另一套凭据）。
       */
      const want = key === 'arknights' ? 'ak' : 'stoken';
      tokenSlot.hidden = mode !== 'online' || want !== 'ak';
      if (!tokenSlot.hidden) {
        if (tokenSlot.dataset.kind !== want) {
          tokenSlot.dataset.kind = want;
          tokenSlot.innerHTML = gachaAkSectionHtml(akStore);
          /*
           * 换完内容必须立刻绑事件。之前只有 refreshTokenPanel 会绑，
           * 于是「切到方舟」这条路径上的按钮和卡片全都是死的。
           */
          const panelEl = document.querySelector('[data-gacha-token]');
          if (panelEl) panelEl.__onPick = (value) => { picked = value; };
          bindGachaAkEvents(switchAkAccount);
        }
      }
    }
    /*
     * 手填 UID 的输入框：只有米游社三款（genshin/starrail/zzz）在 online 模式下露出来。
     *
     * 方舟虽然也是 online，但走的是鹰角账号 token，UID 由账号自己带出来，
     * 这里再让人手填一遍只会困惑「填哪个」。log / import 模式根本不走 SToken，
     * 更用不上。用 hidden 属性而不是 display，是因为样式表里有全局
     * `[hidden] { display: none !important; }`（styles.css:15053）兜底。
     */
    const uidField = document.querySelector('#gacha-sync-uid-field');
    if (uidField) {
      uidField.hidden = !(mode === 'online' && key !== 'arknights');
    }
    const hint = document.querySelector('#gacha-sync-hint');
    if (hint) {
      const isAk = key === 'arknights';
      const store = isAk ? akStore : tokenStore;
      const list = (store && store.accounts) || [];
      const activeAccount = list.find((item) => item.id === ((store && store.activeId) || list[0]?.id));
      if (!isAk && mode === 'online') {
        /* 米哈游：这里没有面板了，明确告诉人去哪儿切账号 */
        hint.textContent = gachaHasToken(activeAccount)
          ? '抽卡账号在左下角头像 →「抽卡账号」里切换。'
          : '还没绑 SToken。点左下角头像 →「抽卡账号」扫一次码，以后就不用开游戏了。';
      } else {
        hint.textContent = gachaSyncHintText(key, isAk ? Boolean(activeAccount) : gachaHasToken(activeAccount));
      }
    }
    /*
     * import 模式下把主按钮藏起来。
     *
     * 底部原本就有一个「改用导入」（data-action="import-gacha"），这里再把主按钮
     * 也改成同样的字，就会并排出现两个一样的按钮 —— 用户截图里已经看到了。
     * 这个模式下主按钮没有意义，留左边那个次要按钮就够。
     */
    if (mode === 'import') {
      start.style.display = 'none';
    } else {
      start.style.display = '';
      start.innerHTML = icon('refresh') + '开始增量同步';
    }
  }

  const gameSelect = document.querySelector('#gacha-sync-game');
  if (gameSelect) gameSelect.addEventListener('change', applySyncMode);

  /*
   * SToken 面板是异步来的（要读账号文件），先留空位再填。
   * 拿不到账号也照常继续 —— 这时就是原来那条缓存路线，功能不受影响。
   */
  let tokenStore = { accounts: [], activeId: '' };
  /* 方舟的账号库和米游社完全分开，各存一份，别互相污染 */
  let akStore = { accounts: [], activeId: '' };
  let picked = null;

  /*
   * 先画一遍：默认游戏可能是终末地（读日志）或异环（只能导入），
   * 不先画的话下面那句提示会停在空白。
   *
   * 必须放在 tokenStore 声明之后 —— applySyncMode 里要读它算「绑没绑」，
   * 提前调会撞上 TDZ 报 Cannot access 'tokenStore' before initialization。
   */
  applySyncMode();
  /*
   * 方舟账号单独拉一条链，不和米游社那条掺在一起。
   * 两者是不同的账号体系，任一失败都不该拖垮另一个。
   * 拿到之后补一次 applySyncMode，否则切到方舟时面板还空着。
   */
  if (api.gacha.akList) {
    api.gacha
      .akList()
      .then((store) => {
        if (store) akStore = store;
        if (currentKey() === 'arknights') applySyncMode();
      })
      .catch(() => {});
  }
  api.gacha
    .stokenList()
    .then((store) => {
      tokenStore = store || tokenStore;
      /*
       * 米哈游的面板已经搬去账号中心，这里只在方舟时才往槽位里写东西。
       * 仍然要把 tokenStore 存下来：提示文案要靠它判断「绑没绑」。
       */
      const slot = document.querySelector('[data-gacha-token-slot]');
      if (slot && slot.dataset.kind === 'ak') slot.innerHTML = gachaAkSectionHtml(akStore);
      /*
       * 读回来之后必须重画一次这一屏：初次 applySyncMode 跑在
       * 账号数据到位之前，那时只能显示「还没绑」。不重画的话，
       * 明明绑了 SToken，提示却一直写着没绑 —— 用户会以为绑定丢了。
       */
      applySyncMode();
    })
    .catch(() => {});

  /**
   * 重读一次账号库并重画面板。
   *
   * 管理弹窗里刚扫完码 / 刚解绑之后必须立刻反映到这里，
   * 否则面板还写着「还没绑 SToken」，用户会以为扫码没成功。
   */
  async function refreshTokenPanel() {
    try {
      const key = currentKey();
      const isAk = key === 'arknights';
      const slot = document.querySelector('[data-gacha-token-slot]');
      if (slot) {
        /*
         * 只画方舟的鹰角账号面板。米哈游的 SToken 面板已经统一收进
         * 左下角头像里的账号中心，这个弹窗里不再重复一份。
         * 仍然记下 dataset.kind，applySyncMode 下次靠它判断要不要重画。
         */
        slot.dataset.kind = isAk ? 'ak' : 'stoken';
        slot.innerHTML = isAk ? gachaAkSectionHtml(akStore) : '';
      }
      /*
       * 提示块跟着账号状态走：没绑的时候别再让用户去开游戏，
       * 那条缓存链接只有 24 小时寿命，正是当初要解决的东西。
       */
      const hint = document.querySelector('#gacha-sync-hint');
      if (hint) {
        const store = isAk ? akStore : tokenStore;
        const list = (store && store.accounts) || [];
        const active = list.find(
          (item) => item.id === ((store && store.activeId) || list[0]?.id)
        );
        const ready = isAk ? Boolean(active) : gachaHasToken(active);
        if (!isAk) {
          hint.textContent = ready
            ? '抽卡账号在左下角头像 →「抽卡账号」里切换。'
            : '还没绑 SToken。点左下角头像 →「抽卡账号」扫一次码，以后就不用开游戏了。';
        } else {
          hint.textContent = gachaSyncHintText(key, ready);
        }
      }
      if (isAk) bindGachaAkEvents(switchAkAccount);
    } catch {
      /* 读不到就保持原样 */
    }
  }

  /**
   * 切换当前账号。
   *
   * 只做两件事：把 activeId 落盘、把 store 换成本地最新的一份。
   * 之后统一走 refreshTokenPanel —— 昵称、角色卡片、有没有 SToken 都得跟着换，
   * 只改下拉的 selected 会让下面还挂着上一个人的号。
   */
  async function switchAccount(id) {
    if (!id) return;
    try {
      const result = await api.gacha.stokenActive({ id });
      if (result && result.ok === false) {
        toast((result && result.error) || '切不过去', 'error');
        return;
      }
      const store = await api.gacha.stokenList();
      tokenStore = store || tokenStore;
      picked = null;
      await refreshTokenPanel();
      applySyncMode();
    } catch (error) {
      toast('切换失败：' + ((error && error.message) || error), 'error');
    }
  }

  /**
   * 切换鹰角账号。
   *
   * 和 switchAccount 分开：那边写的是米游社的 stoken-accounts.json，
   * 这边写 hypergryph-accounts.json，两套 id 空间互不相干。
   */
  async function switchAkAccount(id) {
    if (!id) return;
    try {
      const result = await api.gacha.akActive(id);
      if (result && result.ok === false) {
        toast((result && result.error) || '切不过去', 'error');
        return;
      }
      const store = await api.gacha.akList();
      if (store) akStore = store;
      await refreshTokenPanel();
      applySyncMode();
    } catch (error) {
      toast('切换失败：' + ((error && error.message) || error), 'error');
    }
  }

  /*
   * 底部按钮：米哈游跳账号中心（SToken 统一收在那儿），方舟打开鹰角账号弹窗。
   * 以前这里一个按钮两种含义，现在两个 action 各管一件事。
   */
  const tokenEntry = document.querySelector('.modal-foot [data-action="gacha-token-new"], .modal-foot [data-action="gacha-ak-new"]');
  if (tokenEntry) {
    tokenEntry.addEventListener('click', () => {
      if (currentKey() === 'arknights') openGachaAkModal(refreshTokenPanel);
      else if (typeof openAccountCenter === 'function') openAccountCenter();
    });
  }
  start.addEventListener('click', async () => {
    const gameId = document.querySelector('#gacha-sync-game')?.value;
    const syncGame = state.games.find((game) => game.id === gameId);
    /*
     * 没有公开接口的游戏，「开始同步」这句话本身就不成立。
     * 直接把它导到导入弹窗 —— 比先失败一次再让用户猜要友好。
     */
    if ((GACHA_SYNC_MODES[syncGame?.builtinKey] || 'import') === 'import') {
      openGachaImportModal(syncGame?.builtinKey);
      return;
    }
    const errorBox = document.querySelector('#gacha-sync-error');
    if (errorBox) errorBox.textContent = '';
    start.disabled = true;
    start.textContent = '获取抽卡数据中…';
    try {
      /*
       * SToken 优先：有账号就让主进程直接申 authkey，完全不碰游戏缓存。
       * allowCache 表示「SToken 失败也别立刻报错，先试试老的缓存路线」；
       * 两条路都断了才把 SToken 的失败原因给用户看。
       */
      const tokenOptions = {};
      if (tokenStore.activeId || tokenStore.accounts.length) {
        tokenOptions.accountId = tokenStore.activeId || tokenStore.accounts[0].id;
        tokenOptions.allowCache = true;
        const uidInput = document.querySelector('#gacha-sync-uid');
        const uidField = document.querySelector('#gacha-sync-uid-field');
        /*
         * 输入框被藏起来时不读它的值。
         *
         * 不然会出现这种串味：用户先在原神填了 UID，再切到终末地（log 模式，
         * 输入框隐藏），DOM 里那个值还留着，就会被当成终末地的 uid 传给主进程。
         * hidden 是唯一判据 —— 显隐逻辑全在 applySyncMode 里，两边必须一致。
         */
        const claimed = uidInput && uidField && !uidField.hidden ? uidInput.value.trim() : '';
        const claimedOk = picked && picked.game === (syncGame.builtinKey || '') ? picked.uid : '';
        const uid = claimed || claimedOk;
        if (uid) tokenOptions.uid = uid;
      }
      let result = await api.gacha.sync(gameId, undefined, tokenOptions);
      if (result && result.warning) toast(result.warning, 'error');

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
        // 没绑 SToken 的时候，真实原因往往是「游戏里的链接过期了」，
        // 但把这句话抛给用户等于让他一遍遍去开游戏 —— 直接告诉他该扫码。
        if (errorBox) {
          /*
           * 三层原因，说法必须分开：
           *   needStoken  —— 主进程明确告知「这个账号没有 SToken」，最准确；
           *   noToken     —— 连账号都没有，按没绑处理；
           *   其它        —— 网络 / 接口变更，原样转述。
           * 最不该出现的是把「没凭据」说成「链接过期」——那会让用户一遍遍去开游戏。
           */
          const activeAccount = (tokenStore.accounts || []).find(
            (item) => item.id === (tokenStore.activeId || (tokenStore.accounts || [])[0]?.id)
          );
          const hasToken = activeAccount
            ? (activeAccount.hasStoken === undefined
              ? Boolean(activeAccount.stokenMasked)
              : activeAccount.hasStoken === true)
            : false;
          if (result.needStoken || !hasToken) {
            errorBox.textContent = result.needStoken
              ? (result.error || '这个账号还没绑 SToken。点左下角头像 →「抽卡账号」扫一次码。')
              : '还没绑 SToken。点左下角头像 →「抽卡账号」扫一次码，以后就不用开游戏了。';
          } else if (syncGame?.builtinKey === 'wutheringwaves' && result.needShare) {
            /* 鸣潮：日志里没有分享链接（用户没点过分享）——不关窗，给引导文案 */
            errorBox.textContent =
              '还没找到分享链接：请先在游戏里打开「抽卡记录」页，点右上角「分享」随便分享一次（复制链接就行），再回这里点重试。';
          } else {
            /* 被限流时带上「等多久」，比只说「稍后再试」有用 */
            const waitText = result.rateLimited && result.retryAfterMs
              ? `（约 ${Math.round(result.retryAfterMs / 60000)} 分钟后再试）`
              : '';
            errorBox.textContent = (result.error || '同步失败') + waitText;
          }
        }
        start.disabled = false;
        start.innerHTML = `${icon('refresh')}重试`;
        return;
      }

      closeModal();
      state.gacha = null;
      await loadGacha(true);
      /* 部分成功（被限流提前收尾）：已抓到的已入库，说清楚还差多少 */
      if (result.partial) {
        toast(
          `已同步 ${result.imported} 条，但接口限流提前停了。等十来分钟再点同步会接着抓（已抓到的不会重抓）。`,
          'info'
        );
        return;
      }
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
