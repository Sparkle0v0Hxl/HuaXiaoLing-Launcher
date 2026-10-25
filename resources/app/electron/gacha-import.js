'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const GAMES = new Set(['genshin', 'starrail', 'zzz', 'endfield', 'neverness']);

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

function mergeGroups(existing, incoming) {
  const map = new Map();
  for (const group of [...existing, ...incoming]) {
    if (!GAMES.has(group.game) || !group.uid) continue;
    const key = `${group.game}:${group.uid}`;
    if (!map.has(key)) map.set(key, { game: group.game, uid: String(group.uid), records: [] });
    const target = map.get(key);
    const seen = new Set(target.records.map((record) => String(record.Id)));
    for (const record of group.records || []) {
      const id = String(record.Id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      target.records.push(record);
    }
  }
  const groups = [...map.values()];
  for (const group of groups) {
    group.records.sort((a, b) => String(a.Time).localeCompare(String(b.Time)));
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
