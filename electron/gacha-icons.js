'use strict';

/**
 * 原神抽卡记录的头像 / 立绘图鉴。
 *
 * 为什么需要这个模块：
 *   getGachaLog 返回的 item_id 永远是空串（实测 1273 条全是 ''），
 *   所以只靠抽卡接口本身拿不到任何图标。要画头像只能另找一份
 *   「名字 -> 图片」的对照表。
 *
 * 数据来源选了米游社观测枢（api-takumi-static.mihoyo.com）：
 *   1. 官方站点，不用第三方 CDN，也不依赖 GitHub（国内经常被挡）；
 *   2. 返回结构里每个条目都同时带 title（角色名）和 icon（图片直链）；
 *   3. channel_id=25 是角色（138 条），channel_id=5 是武器（253 条）。
 *
 * 缓存策略跟 gacha-meta.js 一致：落盘 + TTL，抓取失败就退回上一次缓存，
 * 绝不让抽卡页因为图鉴接口挂了而打不开。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 图鉴一天拉一次就够 —— 新角色上线当天重开一次就会带上。 */
const ICON_TTL = 24 * 60 * 60 * 1000;

const OBS_HOST = 'https://api-takumi-static.mihoyo.com';
const CHANNELS = {
  character: 25,
  weapon: 5,
};

/** 观测枢里角色名不一定和抽卡记录里的名字逐字相同，这里补几个已知别名。 */
const NAME_ALIAS = {
  旅行者: '空',
  流浪者: '散兵',
  雷电将军: '雷电影',
  枫原万叶: '枫原万叶',
  神里绫华: '神里绫华',
};

async function fetchJson(url, timeout = 20000) {
  const response = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * 拉一个通道的全部条目，返回 { 名字: 图标URL }。
 *
 * 观测枢的返回是 data.list[0].list，但外层还套了 children，
 * 所以这里递归收一遍 —— 通道结构改版时不会直接失效。
 */
function collectEntries(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectEntries(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof node.title === 'string' && typeof node.icon === 'string' && node.icon) {
    const name = node.title.trim();
    if (name && !out[name]) out[name] = node.icon;
  }
  if (Array.isArray(node.list)) collectEntries(node.list, out);
  if (Array.isArray(node.children)) collectEntries(node.children, out);
}

async function fetchChannel(channelId) {
  const url = `${OBS_HOST}/common/blackboard/ys_obc/v1/home/content/list?app_sn=ys_obc&channel_id=${channelId}`;
  const json = await fetchJson(url);
  if (json.retcode !== 0) throw new Error(json.message || `retcode ${json.retcode}`);
  const out = {};
  collectEntries(json.data && json.data.list, out);
  return out;
}

function emptyIcons() {
  return { character: {}, weapon: {}, updatedAt: 0, errors: [] };
}

async function readCache(cachePath) {
  try {
    const raw = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return {
      ...emptyIcons(),
      ...raw,
      character: { ...(raw.character || {}) },
      weapon: { ...(raw.weapon || {}) },
    };
  } catch {
    return null;
  }
}

async function refresh(cachePath) {
  const icons = emptyIcons();
  const [characters, weapons] = await Promise.all([
    fetchChannel(CHANNELS.character).catch((error) => {
      icons.errors.push(`角色：${error.message}`);
      return null;
    }),
    fetchChannel(CHANNELS.weapon).catch((error) => {
      icons.errors.push(`武器：${error.message}`);
      return null;
    }),
  ]);

  if (characters) icons.character = characters;
  if (weapons) icons.weapon = weapons;
  icons.updatedAt = Date.now();

  // 一个都没拉到就别覆盖旧缓存 —— 网络抖一下不该把头像全清空
  if (!characters && !weapons) {
    const cached = await readCache(cachePath);
    if (cached) return cached;
    return icons;
  }
  if (!characters || !weapons) {
    const cached = await readCache(cachePath);
    if (cached) {
      if (!characters) icons.character = cached.character;
      if (!weapons) icons.weapon = cached.weapon;
    }
  }

  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, JSON.stringify(icons), 'utf8');
  } catch {
    /* 写缓存失败不影响本次使用 */
  }
  return icons;
}

let memory = null;

/**
 * 取图鉴。返回 { character: {...}, weapon: {...} }。
 * 全部失败也要返回一个空表而不是抛错 —— 没有头像只是难看，不该报错。
 */
async function loadIcons(cachePath, force = false) {
  if (memory && !force && Date.now() - memory.updatedAt < ICON_TTL) return memory;

  const cached = await readCache(cachePath);
  if (cached && !force && Date.now() - cached.updatedAt < ICON_TTL) {
    memory = cached;
    return cached;
  }
  if (cached && !force && cached.updatedAt) {
    // 过期了先把旧的交出去，后台再刷
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

/**
 * 给一批抽卡记录补 icon 字段。
 *
 * 只补不改：记录里本来就有 icon 的（比如导入的 UIGF）保持原样。
 * itemType 用来决定查角色表还是武器表，认不出来就两边都查一遍。
 */
function decorateRecords(records, icons) {
  if (!icons) return records;
  const character = icons.character || {};
  const weapon = icons.weapon || {};
  return records.map((record) => {
    if (record.icon) return record;
    const name = (record.Name || record.name || '').trim();
    if (!name) return record;
    const alias = NAME_ALIAS[name];
    const type = String(record.ItemType || record.itemType || '');
    const isWeapon = type === '武器' || type === 'weapon';
    const icon = isWeapon
      ? weapon[name] || character[alias || name] || ''
      : character[name] || character[alias] || weapon[name] || '';
    if (!icon) return record;
    return { ...record, icon };
  });
}

module.exports = {
  loadIcons,
  decorateRecords,
  fetchChannel,
  collectEntries,
  ICON_TTL,
  CHANNELS,
  NAME_ALIAS,
};
