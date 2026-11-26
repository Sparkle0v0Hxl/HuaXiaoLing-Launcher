'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/*
 * 能导入的游戏。
 *
 * 明日方舟没有公开的抽卡接口，只能靠第三方工具导出 ——
 * 所以这里必须认它，否则导入时会被 GAMES.has 挡掉，用户看到的是
 * 「无法判断这是哪个游戏的抽卡记录」，而其实他只是选了明日方舟。
 *
 * 崩坏3 已整块移除（官方从未开放补给记录接口，公共 API 域名都不存在）。
 */
const GAMES = new Set(['genshin', 'starrail', 'zzz', 'endfield', 'arknights', 'neverness', 'wutheringwaves']);

function importsPath(userData) {
  return path.join(userData, 'gacha-imports.json');
}

function readImportGroups(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    return groups.filter(
      (group) =>
        GAMES.has(group?.game) &&
        group.uid &&
        Array.isArray(group.records) &&
        group.records.length
    );
  } catch {
    return [];
  }
}

function unwrapDocument(data) {
  if (Array.isArray(data?.list)) return { list: data.list, info: data.info || {} };
  for (const [key, game] of [
    ['hk4e', 'genshin'],
    ['hkrpg', 'starrail'],
    ['nap', 'zzz'],
    ['endfield', 'endfield'],
    ['arknights', 'arknights'],
    ['nte', 'neverness'],
  ]) {
    if (Array.isArray(data?.[key])) return { list: data[key], info: data.info || {}, game };
    if (Array.isArray(data?.[key]?.list)) {
      return { list: data[key].list, info: data[key].info || data.info || {}, game };
    }
  }
  if (Array.isArray(data?.records)) return { list: data.records, info: data.info || {} };
  return { list: [], info: data?.info || {} };
}

function detectGame(document, fileName = '') {
  if (document.game && GAMES.has(document.game)) return document.game;
  const list = document.list || [];
  const types = new Set(list.map((item) => Number(item.gacha_type)));
  const text = list
    .slice(0, 200)
    .map((item) => `${item.item_type || ''} ${item.name || ''}`)
    .join(' ');
  if (/光锥/.test(text) || types.has(11) || types.has(12)) return 'starrail';
  if (/音擎|邦布/.test(text)) return 'zzz';
  if (/终末地|endfield/i.test(fileName)) return 'endfield';
  if (/异环|neverness|nte/i.test(fileName)) return 'neverness';
  if (list.some((item) => /^E_.*PoolType_/.test(String(item.pool_type || item.poolType || '')))) {
    return 'endfield';
  }
  if (list.some((item) => /^CardPool_|^Lottery_/.test(String(item.pool_id || '')))) {
    return 'neverness';
  }
  if (types.has(3) || types.has(4)) {
    const ranks = list.map((item) => Number(item.rank_type)).filter(Boolean);
    if (ranks.length && Math.max(...ranks) <= 4) return 'zzz';
  }
  if ([100, 200, 301, 302, 400, 500].some((type) => types.has(type))) return 'genshin';
  /*
   * 崩坏3 的抽卡类型是 1-5 / 20，和星铁的 1/2/11/12 有重叠，
   * 所以只能靠文件名和道具名区分 —— 上面那几条内容判定要保持在前面。
   */
  if (/明日方舟|arknights|prts/i.test(fileName)) return 'arknights';
  if (/星铁|starrail|hkrpg/i.test(fileName)) return 'starrail';
  if (/绝区零|zenless|zzz|nap/i.test(fileName)) return 'zzz';
  if (/原神|genshin|hk4e/i.test(fileName)) return 'genshin';
  return '';
}

function normalizeTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace('T', ' ').replace(/Z$/, '');
}

function mapGachaType(game, item) {
  const direct = Number(item.gacha_type);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const pool = String(item.pool_type || item.poolType || item.pool_id || item.poolId || '').toLowerCase();
  if (game === 'endfield') {
    if (pool.includes('weapon')) return 101;
    if (pool.includes('special')) return 1;
    if (pool.includes('rerun')) return 2;
    if (pool.includes('joint')) return 3;
    if (pool.includes('standard')) return 4;
    if (pool.includes('beginner')) return 5;
  }
  if (game === 'neverness') {
    if (pool.includes('arc')) return 3;
    if (pool.includes('standard')) return 2;
    return 1;
  }
  /* 明日方舟的导出文件不一定带 gacha_type，按池子名归到 1-3 即可。 */
  if (game === 'arknights') {
    if (pool.includes('limited') || pool.includes('limit')) return 2;
    if (pool.includes('link')) return 3;
    return 1;
  }
  return 0;
}

function normalizeRecords(document, game, options = {}) {
  const fallbackUid = String(
    options.fallbackUid ||
      document.info?.uid ||
      document.info?.player_id ||
      (game === 'neverness' ? 'NTE' : '') ||
      ''
  ).trim();
  const groups = new Map();
  document.list.forEach((item, index) => {
    const uid = String(item.uid || item.player_id || fallbackUid || '').trim();
    if (!uid) return;
    const time = normalizeTime(item.time || item.gacha_ts || item.gachaTs);
    if (!time) return;
    const gachaType = mapGachaType(game, item);
    const itemId = String(item.item_id || item.itemId || item.charId || '');
    const name = String(item.name || item.item_name || item.charName || item.weaponName || '');
    const id = String(
      item.id ||
        item.record_id ||
        item.seqId ||
        `${time}|${gachaType}|${itemId}|${name}|${index}`
    );
    const record = {
      Uid: uid,
      Id: id,
      Name: name,
      Time: time,
      ItemId: itemId,
      ItemType: String(item.item_type || item.record_type || item.pool_type || item.poolType || ''),
      RankType: Number(item.rank_type || item.rarity) || 0,
      GachaType: gachaType,
    };
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(record);
  });
  return [...groups.entries()].map(([uid, records]) => ({ game, uid, records }));
}

/*
 * 一次十连的 10 条记录 gachaTs 完全相同，接口是按 pos 降序（9→0）返回的，
 * 而真实抽卡顺序是 pos 升序。只按 Time 排会保留这个倒序，
 * 导致同一十连里「第几抽出货」全部算错（明日方舟的垫数就是这么错的）。
 * Id 形如 ak-<gachaTs>-<pos>-<charId>，从里面把 pos 抠出来。
 */
function recordPos(record) {
  const direct = Number(record && record.pos);
  if (Number.isFinite(direct)) return direct;
  const matched = /^ak-\d+-(\d+)-/.exec(String((record && record.Id) || ''));
  return matched ? Number(matched[1]) : NaN;
}

function mergeGroups(existing, incoming) {
  const map = new Map();
  for (const group of [...existing, ...incoming]) {
    if (!GAMES.has(group.game) || !group.uid) continue;
    const key = `${group.game}:${group.uid}`;
    if (!map.has(key)) map.set(key, { game: group.game, uid: String(group.uid), records: [] });
    const target = map.get(key);
    /*
     * 同一 Id 以后到的为准，而不是「已存在就跳过」。
     * 原来的跳过逻辑有个隐性 bug：同一批记录先以旧字段落过盘，
     * 之后代码升级给记录加了新字段（比如明日方舟的 up / isNew），
     * 重新同步时这些记录因为 Id 已存在被丢掉，字段永远补不上。
     */
    const index = new Map();
    for (let i = 0; i < target.records.length; i += 1) {
      index.set(String(target.records[i].Id || ''), i);
    }
    for (const record of group.records || []) {
      const id = String(record.Id || '');
      if (!id) continue;
      if (index.has(id)) {
        target.records[index.get(id)] = record;
        continue;
      }
      index.set(id, target.records.length);
      target.records.push(record);
    }
  }
  const groups = [...map.values()];
  for (const group of groups) {
    group.records.sort((a, b) => {
      const byTime = String(a.Time).localeCompare(String(b.Time));
      if (byTime !== 0) return byTime;
      /* 同一秒内按 pos 升序还原真实抽卡顺序，见 recordPos 注释 */
      const pa = recordPos(a);
      const pb = recordPos(b);
      if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
      return 0;
    });
    group.count = group.records.length;
  }
  return groups;
}

async function saveImportGroups(filePath, groups) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(
    filePath,
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), groups }, null, 2),
    'utf8'
  );
}

async function importUigf({ filePath, userData, game, fallbackUid }) {
  const raw = await fsp.readFile(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  const document = unwrapDocument(parsed);
  if (!document.list.length) throw new Error('文件里没有抽卡记录（list 为空）');
  const detected = game && GAMES.has(game) ? game : detectGame(document, filePath);
  if (!detected) throw new Error('无法判断这是哪个游戏的抽卡记录，请选择游戏后再导入');
  const incoming = normalizeRecords(document, detected, { fallbackUid });
  if (!incoming.length) throw new Error('没有解析到带 UID 和时间的有效记录');
  const file = importsPath(userData);
  const existing = readImportGroups(file);
  const groups = mergeGroups(existing, incoming);
  await saveImportGroups(file, groups);
  return {
    ok: true,
    game: detected,
    imported: incoming.reduce((sum, group) => sum + group.records.length, 0),
    total: groups.reduce((sum, group) => sum + group.records.length, 0),
    uids: incoming.map((group) => group.uid),
  };
}

module.exports = {
  importsPath,
  readImportGroups,
  importUigf,
  detectGame,
  normalizeRecords,
  mergeGroups,
  saveImportGroups,
};
