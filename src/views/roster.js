'use strict';

/*
 * 角色图鉴：把米游社登录态里三款游戏的角色拉下来，看练度 / 武器 / 圣遗物。
 *
 * 加载约定：普通 script，共享全局词法作用域，必须排在 app.js 之前。
 * 依赖 state / dom / icon / esc / api / openModal 等，均在调用时解析；顶层无立即求值。
 *
 * 三款游戏能拿到的深度不一样（后端 roster.js 里写明了原因）：
 *   原神   等级 / 命座 / 好感 / 武器 / 圣遗物（主词条 + 4 条副词条）/ 天赋
 *   星铁   等级 / 星魂 / 光锥 / 遗器 + 内圈饰品 / 面板属性 / 技能
 *   绝区零 等级 / 影画 / 稀有度 / 阵营 / 职业 —— 音擎和驱动盘接口官方没开
 * 所以界面不假设「每张卡都有装备」，缺的部分直接不画，而不是画个空框。
 */

const ROSTER_GAMES = [
  { key: 'genshin', name: '原神', accent: '#f0c674' },
  { key: 'starrail', name: '崩坏：星穹铁道', accent: '#9d8cf5' },
  { key: 'zzz', name: '绝区零', accent: '#5ec8d8' },
];

/* 元素 → 颜色，卡片左侧那条光带用 */
const ROSTER_ELEMENT_COLOR = {
  火: '#f08a6a',
  水: '#5aa9f0',
  风: '#6fd8b0',
  雷: '#b98cf0',
  冰: '#7fd4ea',
  岩: '#e0b357',
  草: '#8fd05a',
  物理: '#b9c2cf',
  量子: '#8f7ce0',
  虚数: '#f0d35a',
  电: '#b98cf0',
  以太: '#c98cf0',
};

const ROSTER_POS_NAME = {
  1: '生之花',
  2: '死之羽',
  3: '时之沙',
  4: '空之杯',
  5: '理之冠',
};

const rosterState = {
  game: 'genshin',
  loading: false,
  data: {},
  error: '',
  picked: '',
  /* 筛选：元素（空串=全部）、星级（0=全部）、排序（level/rarity/name） */
  filterElement: '',
  filterRarity: 0,
  sortBy: 'level',
  /* 原神列表接口不带圣遗物，详情要单独取，这里记住哪些角色已经补过详情 */
  details: {},
};

function rosterReset() {
  rosterState.loading = false;
  rosterState.data = {};
  rosterState.error = '';
  rosterState.picked = '';
  rosterState.details = {};
  rosterState.filterElement = '';
  rosterState.filterRarity = 0;
  rosterState.sortBy = 'level';
}

/* 当前游戏的角色列表按筛选条件过滤 + 排序 */
function rosterVisibleList(list) {
  const element = rosterState.filterElement;
  const rarity = Number(rosterState.filterRarity) || 0;
  const rows = list.filter((item) => {
    if (element && item.elementName !== element) return false;
    if (rarity && Number(item.rarity) !== rarity) return false;
    return true;
  });
  const sortBy = rosterState.sortBy;
  rows.sort((a, b) => {
    if (sortBy === 'rarity') {
      if (Number(b.rarity) !== Number(a.rarity)) return Number(b.rarity) - Number(a.rarity);
      return Number(b.level || 0) - Number(a.level || 0);
    }
    if (sortBy === 'name') {
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    }
    /* 默认按等级 */
    if (Number(b.level || 0) !== Number(a.level || 0)) return Number(b.level || 0) - Number(a.level || 0);
    return Number(b.rarity || 0) - Number(a.rarity || 0);
  });
  return rows;
}

/* 这款游戏列表里实际出现过的元素（按当前列表动态生成，绝区零没有草/岩） */
function rosterElementsOf(list) {
  const seen = [];
  for (const item of list) {
    const name = item.elementName;
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/* 从米游社登录态里找这款游戏的 uid + region，找不到返回 null */
function rosterRoleOf(gameKey) {
  const status = state.hoyolab && state.hoyolab['hoyolab-miyoushe'];
  const roles = (status && status.roles) || [];
  return roles.find((role) => role.game === gameKey) || null;
}

function rosterStars(rarity) {
  const n = Math.max(0, Math.min(5, Number(rarity) || 0));
  return n ? '★'.repeat(n) : '';
}

function rosterAvatarHtml(item) {
  const url = item.icon || item.image || '';
  const initial = esc(String(item.name || '?').slice(0, 1));
  if (!url) return `<span class="roster-avatar"><i>${initial}</i></span>`;
  return `<span class="roster-avatar"><img src="${esc(url)}" referrerpolicy="no-referrer" alt=""><i>${initial}</i></span>`;
}

/* 一张角色卡：头像 + 名字 + 等级 + 命座 + 稀有度光带 */
function rosterCardHtml(item) {
  const color = ROSTER_ELEMENT_COLOR[item.elementName] || '#8b93a1';
  const picked = rosterState.picked === String(item.id) ? ' is-picked' : '';
  const rankWord = rosterState.game === 'starrail' ? '星魂' : rosterState.game === 'zzz' ? '影画' : '命';
  const rankLabel = item.rank
    ? `<span class="roster-rank">${esc(String(item.rank))} ${esc(rankWord)}</span>`
    : '';
  const sub = [item.elementName, item.weapon ? item.weapon.name : ''].filter(Boolean).join(' · ');
  return `<button class="roster-card${picked}" data-action="roster-pick" data-value="${esc(String(item.id))}"
    style="--rc:${esc(color)}">
    ${rosterAvatarHtml(item)}
    <span class="roster-card-copy">
      <strong>${esc(item.name)}</strong>
      <small>${esc(sub || '—')}</small>
    </span>
    <span class="roster-card-meta">
      <em>Lv.${esc(String(item.level || 0))}</em>
      <span class="roster-star">${esc(rosterStars(item.rarity))}</span>
      ${rankLabel}
    </span>
  </button>`;
}

/* 一条词条：有名字就「名字 数值」，没名字（新词条没进表）就只显示数值 */
function rosterPropText(prop) {
  if (!prop) return '';
  const name = prop.name ? String(prop.name) + ' ' : '';
  return name + String(prop.value == null ? '' : prop.value);
}

function rosterRelicHtml(relic) {
  const posName = relic.posName || ROSTER_POS_NAME[relic.pos] || '';
  const mainText = rosterPropText(relic.main);
  const subs = (relic.subs || [])
    .map((sub) => `<span class="roster-sub">${esc(rosterPropText(sub))}</span>`)
    .join('');
  return `<div class="roster-relic">
    ${relic.icon ? `<img src="${esc(relic.icon)}" referrerpolicy="no-referrer" alt="">` : '<span class="roster-relic-blank"></span>'}
    <div class="roster-relic-copy">
      <strong>${esc(relic.name)}${relic.level ? ` <em>+${esc(String(relic.level))}</em>` : ''}</strong>
      <small>${esc(posName)}${relic.set ? ' · ' + esc(relic.set) : ''}</small>
      ${mainText ? `<div class="roster-main">${esc(mainText)}</div>` : ''}
      <div class="roster-subs">${subs}</div>
    </div>
  </div>`;
}

function rosterWeaponHtml(weapon) {
  if (!weapon) return '';
  const extra = [weapon.typeName, weapon.refine ? `精${weapon.refine}` : ''].filter(Boolean).join(' · ');
  return `<div class="roster-weapon">
    ${weapon.icon ? `<img src="${esc(weapon.icon)}" referrerpolicy="no-referrer" alt="">` : ''}
    <div class="roster-weapon-copy">
      <strong>${esc(weapon.name)}</strong>
      <small>${esc(extra)}${weapon.level ? ` · Lv.${esc(String(weapon.level))}` : ''}</small>
      ${weapon.main || weapon.sub
        ? `<div class="roster-subs">${
            weapon.main ? `<span class="roster-sub">${esc(rosterPropText(weapon.main))}</span>` : ''
          }${
            weapon.sub ? `<span class="roster-sub">${esc(rosterPropText(weapon.sub))}</span>` : ''
          }</div>`
        : ''}
    </div>
  </div>`;
}

/* 右侧详情：选中角色之后才有 */
function rosterDetailHtml() {
  const list = (rosterState.data[rosterState.game] || {}).characters || [];
  const item = list.find((one) => String(one.id) === rosterState.picked);
  if (!item) {
    return `<div class="roster-empty">${icon('info', 'xs')}<span>点左边任意角色，这里显示武器和圣遗物。</span></div>`;
  }
  const relics = item.relics || [];
  const detailNote =
    rosterState.game === 'zzz'
      ? '绝区零的音擎 / 驱动盘接口官方没开放，只能看到基础练度。'
      : rosterState.game === 'genshin' && !relics.length
        ? '这个角色还没有圣遗物，或者等级太低没进详情请求。'
        : '';

  return `<div class="roster-detail-head">
      ${rosterAvatarHtml(item)}
      <div>
        <strong>${esc(item.name)}</strong>
        <small>Lv.${esc(String(item.level || 0))} · ${esc(item.elementName || '—')}${
          item.rank
            ? ` · ${esc(String(item.rank))} ${esc(
                rosterState.game === 'starrail' ? '星魂' : rosterState.game === 'zzz' ? '影画' : '命'
              )}`
            : ''
        }</small>
      </div>
    </div>
    ${rosterWeaponHtml(item.weapon)}
    ${relics.length ? `<div class="roster-relics">${relics.map(rosterRelicHtml).join('')}</div>` : ''}
    ${(item.properties || []).length
      ? `<div class="roster-props">${item.properties
          .slice(0, 8)
          .map((prop) => `<span><em>${esc(prop.name)}</em>${esc(String(prop.value))}</span>`)
          .join('')}</div>`
      : ''}
    ${detailNote ? `<p class="roster-note">${esc(detailNote)}</p>` : ''}`;
}

function rosterShellHtml() {
  const game = ROSTER_GAMES.find((one) => one.key === rosterState.game) || ROSTER_GAMES[0];
  const payload = rosterState.data[rosterState.game] || {};
  const list = payload.characters || [];
  const tabs = ROSTER_GAMES.map((one) => {
    const count = ((rosterState.data[one.key] || {}).characters || []).length;
    const active = one.key === rosterState.game ? ' is-active' : '';
    return `<button class="roster-tab${active}" data-action="roster-game" data-value="${esc(one.key)}"
      style="--rc:${esc(one.accent)}">
      <span>${esc(one.name)}</span>
      ${count ? `<em>${count}</em>` : ''}
    </button>`;
  }).join('');

  const visible = rosterVisibleList(list);
  const elements = rosterElementsOf(list);
  const rarities = [...new Set(list.map((item) => Number(item.rarity) || 0).filter(Boolean))].sort((a, b) => b - a);
  const filterBar = list.length
    ? `<div class="roster-filter">
        <div class="roster-filter-group">
          <button class="roster-chip${rosterState.filterElement ? '' : ' is-on'}" data-action="roster-element" data-value="">全部</button>
          ${elements
            .map(
              (name) => `<button class="roster-chip${rosterState.filterElement === name ? ' is-on' : ''}"
                data-action="roster-element" data-value="${esc(name)}"
                style="--rc:${esc(ROSTER_ELEMENT_COLOR[name] || '#8b93a1')}">${esc(name)}</button>`
            )
            .join('')}
        </div>
        <div class="roster-filter-group">
          ${rarities
            .map(
              (n) => `<button class="roster-chip${Number(rosterState.filterRarity) === n ? ' is-on' : ''}"
                data-action="roster-rarity" data-value="${n}">${esc(rosterStars(n))}</button>`
            )
            .join('')}
        </div>
        <div class="roster-filter-group">
          ${[
            ['level', '按等级'],
            ['rarity', '按星级'],
            ['name', '按名字'],
          ]
            .map(
              ([key, label]) => `<button class="roster-chip${rosterState.sortBy === key ? ' is-on' : ''}"
                data-action="roster-sort" data-value="${key}">${esc(label)}</button>`
            )
            .join('')}
        </div>
        <span class="roster-count">${visible.length} / ${list.length}</span>
      </div>`
    : '';

  const body = rosterState.loading
    ? `<div class="roster-loading"><span class="roster-spinner"></span><span>正在读取角色数据…</span></div>`
    : rosterState.error
      ? `<div class="roster-empty">${icon('alert', 'xs')}<span>${esc(rosterState.error)}</span></div>`
      : !list.length
        ? `<div class="roster-empty">${icon('info', 'xs')}<span>这个账号还没有读取到角色数据。</span></div>`
        : `<div class="roster-body">
            <div class="roster-grid">${
              visible.length
                ? visible.map(rosterCardHtml).join('')
                : `<div class="roster-empty">${icon('info', 'xs')}<span>这个筛选条件下没有角色。</span></div>`
            }</div>
            <aside class="roster-side">${rosterDetailHtml()}</aside>
          </div>`;

  return `<div class="modal-backdrop" data-backdrop>
    <div class="modal roster-modal" role="dialog" aria-modal="true" aria-labelledby="roster-title">
      <div class="modal-head">
        <div>
          <h2 id="roster-title">角色图鉴</h2>
          <p>读的是米游社登录态里的角色数据，等级 / 命座 / 武器 / 圣遗物都在这里；数据缓存半小时。</p>
        </div>
        <button class="modal-close" data-close title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="roster-tabs">${tabs}</div>
        ${filterBar}
        <div class="roster-main" style="--rc:${esc(game.accent)}">${body}</div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-action="roster-refresh">${icon('refresh', 'xs')}重新读取</button>
        <span style="flex:1"></span>
        <button class="btn ghost" data-close>关闭</button>
      </div>
    </div>
  </div>`;
}

function rosterRender() {
  const host = document.querySelector('#roster-root');
  if (!host) return;
  host.innerHTML = rosterShellHtml();
}

async function rosterLoad(gameKey, force) {
  const game = gameKey || rosterState.game;
  if (game !== rosterState.game) {
    /* 换游戏就把筛选清掉：原神有岩/草，绝区零没有，留着会筛出空列表 */
    rosterState.filterElement = '';
    rosterState.filterRarity = 0;
  }
  rosterState.game = game;
  const role = rosterRoleOf(game);
  if (!role) {
    rosterState.error = '这个米游社账号下没有这款游戏的角色，换个账号或先在游戏里登录一次。';
    rosterState.loading = false;
    rosterRender();
    return;
  }
  rosterState.loading = true;
  rosterState.error = '';
  rosterState.picked = '';
  rosterRender();
  try {
    const result = await api.hoyolab.roster({
      game,
      uid: role.uid,
      server: role.region,
      force: force === true,
    });
    if (!result || result.ok !== true) {
      rosterState.error = (result && result.error) || '读取失败';
    } else {
      rosterState.data[game] = result;
      /* 默认选第一个，右侧不至于空着 */
      const first = (result.characters || [])[0];
      rosterState.picked = first ? String(first.id) : '';
    }
  } catch (error) {
    rosterState.error = humanError(error);
  } finally {
    rosterState.loading = false;
    rosterRender();
  }
}

function openRosterModal(gameKey) {
  rosterReset();
  const game = ROSTER_GAMES.some((one) => one.key === gameKey) ? gameKey : 'genshin';
  rosterState.game = game;
  openModal('<div id="roster-root"></div>');
  rosterLoad(game, false);
}
