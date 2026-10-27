'use strict';

/**
 * 终末地 / 异环的抽卡图鉴元数据。
 *
 * 这两款游戏没有 Starward 那种现成图鉴接口，所以这里从官方站点和公开的社区
 * 资源里抓「id / 名称 / 图标」，缓存到本机，并按 TTL 自动刷新。
 * 每次新版本上线新角色、新武器时，下一次刷新就会自动带上，不需要改代码。
 *
 * 抓取失败时一律回退到上一次的缓存，绝不让抽卡页因为网络问题打不开。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 元数据最多存一天；版本更新当天重新打开就会拉到新角色。 */
const META_TTL = 24 * 60 * 60 * 1000;

const ENDFIELD_OPERATOR_PAGE = 'https://endfield.hypergryph.com/operator';
const NTE_MAIN_PAGE = 'https://yh.wanmei.com/main.html';
const NTE_MAPS_BASE =
  'https://cdn.jsdelivr.net/gh/Anong0u0/NTE_Gacha_Exporter@main/crates/nte-assets/resources/maps/';

/** 终末地抽卡记录的 charId 是 chr_0009_azrila，其中 azrila 与官网 slug 并不总一致。 */
const ENDFIELD_SLUG_ALIAS = {
  azrila: 'alesh',
  aglina: 'gilberta',
  laevat: 'laevatain',
  wulfa: 'wulfgard',
  pograni: 'pogranichnik',
};

async function fetchText(url, timeout = 30000) {
  const response = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.text();
}

async function fetchJson(url, timeout = 30000) {
  const response = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

/** 带一次重试的抓取，GitHub raw 偶尔会慢一下。 */
async function withRetry(task, label) {
  try {
    return await task();
  } catch (first) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      return await task();
    } catch (second) {
      throw new Error(`${label}：${second.message || second}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 终末地：官网干员页（名称 + 官方立绘图标 + 稀有度）                   */
/* ------------------------------------------------------------------ */

const ENDFIELD_OPERATOR_RE =
  /OperatorItem_image__[A-Za-z0-9_]+" data-key="([^"]+)" style="background-image:url\((https:\/\/[^)]+)\)"><\/div><div class="OperatorItem_contentBlock__[A-Za-z0-9_]+" data-rarity="(\d)"><div class="OperatorItem_name__[A-Za-z0-9_]+"><span class="OperatorItem_nameText__[A-Za-z0-9_]+"[^>]*>([^<]+)</g;

async function fetchEndfieldCharacters() {
  const html = await withRetry(() => fetchText(ENDFIELD_OPERATOR_PAGE), '终末地官网');
  const bySlug = {};
  let match;
  while ((match = ENDFIELD_OPERATOR_RE.exec(html))) {
    bySlug[match[1]] = {
      name: match[4].trim(),
      icon: match[2],
      rarity: Number(match[3]) || 0,
    };
  }
  if (!Object.keys(bySlug).length) throw new Error('终末地官网干员页没有解析到数据');

  // 同时生成两份索引：一份按 chrId 后缀，一份按中文名（导入记录只有名字时用得上）
  const byCharId = {};
  for (const [slug, item] of Object.entries(bySlug)) {
    byCharId[`chr_slug_${slug}`] = item;
  }
  const byName = {};
  for (const item of Object.values(bySlug)) {
    if (item.name) byName[item.name] = item;
  }
  return { bySlug, byCharId, byName };
}

/* ------------------------------------------------------------------ */
/* 异环：官方站点角色立绘 + 导出工具的名称表                            */
/* ------------------------------------------------------------------ */

/**
 * 异环官网用拼音 slug 命名角色立绘，导出记录里只有中文名。
 * 这份对照表把两者接起来；新版本加角色时，只要官网出现新 slug，
 * 下方逻辑仍会尝试用「立绘 + 名称表」自动补，补不上就退化成文字头像。
 */
const NTE_SLUG_NAMES = {
  mingyin: '明音凛',
  heiyu: '黑羽',
  'zero-male': '伊洛伊',
  'zero-female': '伊洛伊',
  canhong: '残虹',
  lingke: '灵可',
  zhenhong: '真红',
  yi: '翳',
  an: '安魂曲',
  ka: '卡厄斯',
  xun: '浔',
  nanally: '娜娜莉',
  mint: '薄荷',
  xiaozhi: '小吱',
  jiuyuan: '九原',
  hasuoer: '哈索尔',
  baicang: '白藏',
  fadiya: '法帝娅',
  dfde: '达芙蒂尔',
  zaowu: '早雾',
};

/**
 * 收集异环官网的角色素材。
 *
 * 注意：role-poster 是 2560×1440 的竖构图大图，塞进 38px 的头像框里完全看不到脸，
 * 所以优先用 CSS 里的 role-tab —— 那是一张 138×278 的圆形头像精灵图，
 * 上半帧正好是正脸圆框，前端用 object-position:top 裁出来即可。
 */
function nteRoleAssets(html, css) {
  const posters = {};
  const names = {};
  for (const match of html.matchAll(/(?:role-poster|role-name)-([a-z0-9-]+)\.(png|jpg|jpeg|webp)/g)) {
    const [raw, slug] = match;
    if (raw.startsWith('role-poster')) {
      if (!posters[slug]) {
        const found = html.match(
          new RegExp(`https://[^"'\\s)]*role-poster-${slug}\\.(?:png|jpg|jpeg|webp)`)
        );
        if (found) posters[slug] = found[0];
      }
    } else if (raw.startsWith('role-name')) {
      if (!names[slug]) {
        const found = html.match(
          new RegExp(`https://[^"'\\s)]*role-name-${slug}\\.(?:png|jpg|jpeg|webp)`)
        );
        if (found) names[slug] = found[0];
      }
    }
  }

  // 圆形头像来自样式表：.role-tab-<slug> p{background:url(...)}
  const tabs = {};
  if (css) {
    const re = /\.role-tab-([a-z0-9-]+)\s+p\s*\{[^}]*url\((https:\/\/[^)]+)\)/g;
    let match;
    while ((match = re.exec(css))) {
      if (!tabs[match[1]]) tabs[match[1]] = match[2];
    }
  }
  return { posters, names, tabs };
}

/** 官网样式表地址会随版本变化，从首页里现取，取不到就退回已知的那份。 */
async function nteStylesheetUrl(html) {
  const links = [...html.matchAll(/<link[^>]*href="(https:\/\/yh\.wanmei\.com\/style\/[^"]+\.css)"/g)];
  const main = links.map((m) => m[1]).find((url) => /\/style\/main\d+\.css$/.test(url));
  return main || 'https://yh.wanmei.com/style/main261015.css';
}

async function fetchNevernessItems() {
  const [core, locale, mainHtml] = await Promise.all([
    withRetry(() => fetchJson(`${NTE_MAPS_BASE}core.json`), '异环名称表'),
    withRetry(() => fetchJson(`${NTE_MAPS_BASE}locales/zh-CN.json`), '异环本地化表'),
    withRetry(() => fetchText(NTE_MAIN_PAGE), '异环官网'),
  ]);

  const localeItems = locale.items || {};
  const items = {};
  for (const [id, item] of Object.entries(core.items || {})) {
    // 名称形如「角色·娜娜莉」，去掉前缀只留人名/物名
    const name = String(localeItems[id]?.name || '').replace(/^[^·]*·/, '').trim();
    if (!name) continue;
    items[id] = {
      name,
      rarity: Number(item.rarity) || 0,
      category: String(item.category || ''),
      icon: '',
      color: String(item.color || ''),
    };
  }
  if (!Object.keys(items).length) throw new Error('异环名称表为空');

  const cssUrl = await nteStylesheetUrl(mainHtml).catch(() => '');
  const css = cssUrl
    ? await withRetry(() => fetchText(cssUrl), '异环样式表').catch(() => '')
    : '';
  const { posters, tabs } = nteRoleAssets(mainHtml, css);
  const byName = {};
  for (const item of Object.values(items)) {
    if (item.name) byName[item.name] = item;
  }

  // 圆形头像优先；没有 tab 头像时退回立绘，保证至少有图可看
  let matched = 0;
  for (const [slug, name] of Object.entries(NTE_SLUG_NAMES)) {
    const target = byName[name];
    if (!target || target.icon) continue;
    const icon = tabs[slug] || posters[slug];
    if (!icon) continue;
    target.icon = icon;
    matched += 1;
  }

  return {
    items,
    byName,
    matched,
    posters: Object.keys(posters).length,
    tabs: Object.keys(tabs).length,
  };
}

/* ------------------------------------------------------------------ */
/* 缓存与刷新                                                          */
/* ------------------------------------------------------------------ */

let memory = null;

function emptyMeta() {
  return {
    updatedAt: 0,
    endfield: { bySlug: {}, byCharId: {}, byName: {} },
    neverness: { items: {}, byName: {}, matched: 0 },
    errors: [],
  };
}

async function readCache(cachePath) {
  try {
    const raw = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const base = emptyMeta();
    return {
      ...base,
      ...raw,
      endfield: { ...base.endfield, ...(raw.endfield || {}) },
      neverness: { ...base.neverness, ...(raw.neverness || {}) },
    };
  } catch {
    return null;
  }
}

async function refresh(cachePath) {
  const meta = emptyMeta();
  const errors = [];

  const [endfield, neverness] = await Promise.all([
    fetchEndfieldCharacters().catch((error) => {
      errors.push(`终末地：${error.message}`);
      return null;
    }),
    fetchNevernessItems().catch((error) => {
      errors.push(`异环：${error.message}`);
      return null;
    }),
  ]);

  if (endfield) meta.endfield = endfield;
  if (neverness) meta.neverness = neverness;
  meta.errors = errors;
  meta.updatedAt = Date.now();

  // 一个都没抓到就别覆盖旧缓存
  if (!endfield && !neverness) {
    const cached = await readCache(cachePath);
    if (cached) return cached;
    return meta;
  }

  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, JSON.stringify(meta), 'utf8');
  } catch {
    /* 写缓存失败不影响本次使用 */
  }
  return meta;
}

/**
 * 取图鉴元数据。默认走缓存；过期或 force 时后台刷新。
 * 刷新失败时返回旧缓存，抽卡页永远不会因此报错。
 */
async function loadGachaMeta(cachePath, force = false) {
  if (memory && !force && Date.now() - memory.updatedAt < META_TTL) return memory;

  const cached = await readCache(cachePath);
  if (cached && !force && Date.now() - cached.updatedAt < META_TTL) {
    memory = cached;
    return cached;
  }
  if (cached && !force && cached.updatedAt) {
    // 已过期：先把旧数据交出去，后台再刷新，避免阻塞界面
    memory = cached;
    refresh(cachePath)
      .then((fresh) => {
        memory = fresh;
      })
      .catch(() => {});
    return cached;
  }

  const fresh = await refresh(cachePath);
  memory = fresh;
  return fresh;
}

module.exports = {
  loadGachaMeta,
  ENDFIELD_SLUG_ALIAS,
  META_TTL,
};
