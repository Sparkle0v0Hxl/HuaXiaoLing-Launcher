'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { mergeGroups, saveImportGroups, readImportGroups, importsPath } = require('./gacha-import');

const GAMES = {
  genshin: {
    name: '原神',
    types: [100, 200, 301, 302, 400, 500],
    cache: ['YuanShen_Data/webCaches', 'GenshinImpact_Data/webCaches'],
    prefixes: [
      ['https://webstatic.mihoyo.com/hk4e/event/e20190909gacha', 'https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog'],
      ['https://gs.hoyoverse.com/genshin/event/e20190909gacha', 'https://public-operation-hk4e-sg.hoyoverse.com/gacha_info/api/getGachaLog'],
    ],
  },
  starrail: {
    name: '崩坏：星穹铁道',
    types: [1, 2, 11, 12],
    cache: ['StarRail_Data/webCaches'],
    prefixes: [
      ['https://webstatic.mihoyo.com/hkrpg/event/e20211215gacha', 'https://public-operation-hkrpg.mihoyo.com/common/hkrpg_gacha_record/api/getGachaLog'],
      ['https://gs.hoyoverse.com/hkrpg/event/e20211215gacha', 'https://public-operation-hkrpg-sg.hoyoverse.com/common/hkrpg_gacha_record/api/getGachaLog'],
    ],
  },
  zzz: {
    name: '绝区零',
    types: [1, 2, 3, 5, 102, 103],
    cache: ['ZenlessZoneZero_Data/webCaches'],
    prefixes: [
      ['https://webstatic.mihoyo.com/nap/event/e20230424gacha', 'https://public-operation-nap.mihoyo.com/common/gacha_record/api/getGachaLog'],
      ['https://gs.hoyoverse.com/nap/event/e20230424gacha', 'https://public-operation-nap-sg.hoyoverse.com/common/gacha_record/api/getGachaLog'],
    ],
  },
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function apiUrlFromWebUrl(game, webUrl) {
  for (const [webPrefix, api] of GAMES[game].prefixes) {
    if (webUrl.startsWith(webPrefix)) {
      const rest = webUrl.slice(webPrefix.length);
      const query = rest.indexOf('?');
      if (query >= 0) return api + rest.slice(query);
    }
  }
  if (webUrl.includes('/api/getGachaLog')) return webUrl;
  return '';
}

function cacheFiles(installRoot, game) {
  const files = [];
  for (const relative of GAMES[game].cache) {
    const root = path.join(installRoot, relative);
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'Cache', 'Cache_Data', 'data_2');
      try {
        files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function extractUrlFromCache(installRoot, game) {
  const files = cacheFiles(installRoot, game);
  if (!files.length) throw new Error('没有找到游戏网页缓存，请先在游戏里打开一次抽卡记录页面');
  for (const item of files) {
    let buffer;
    try {
      buffer = fs.readFileSync(item.file);
    } catch {
      continue;
    }
    let best = null;
    for (const [prefix] of GAMES[game].prefixes) {
      const needle = Buffer.from(prefix, 'utf8');
      const index = buffer.lastIndexOf(needle);
      if (index < 0) continue;
      let end = index;
      while (end < buffer.length) {
        const byte = buffer[end];
        if (byte === 0 || byte === 0x22 || byte === 0x0a || byte === 0x0d) break;
        end += 1;
      }
      const url = buffer.subarray(index, end).toString('utf8');
      if (!best || index > best.index) best = { index, url };
    }
    if (!best) continue;
    const api = apiUrlFromWebUrl(game, best.url);
    if (api) return api;
  }
  throw new Error('缓存里没有找到抽卡链接，请重新打开游戏抽卡记录页面');
}

function cleanApiUrl(raw) {
  const url = new URL(raw);
  url.searchParams.delete('gacha_type');
  url.searchParams.delete('real_gacha_type');
  url.searchParams.delete('page');
  url.searchParams.delete('size');
  url.searchParams.delete('end_id');
  return url;
}

async function fetchPage(api, game, type, page, endId) {
  const url = new URL(api);
  if (game === 'zzz') url.searchParams.set('real_gacha_type', String(type));
  else url.searchParams.set('gacha_type', String(type));
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', '20');
  url.searchParams.set('end_id', String(endId));
  const response = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://webstatic.mihoyo.com/' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`抽卡接口 HTTP ${response.status}`);
  const json = await response.json();
  if (json.retcode !== 0) {
    if ([-100, -101, 10001].includes(Number(json.retcode))) {
      throw new Error('抽卡链接已过期，请重新打开一次游戏内的抽卡记录页面');
    }
    throw new Error(json.message || `抽卡接口错误 ${json.retcode}`);
  }
  return json.data?.list || [];
}

async function syncGacha({ game, installRoot, userData, onProgress }) {
  if (!GAMES[game]) throw new Error('不支持这个游戏的抽卡同步');
  const api = extractUrlFromCache(installRoot, game);
  const clean = cleanApiUrl(api);
  const first = await fetchPage(clean.toString(), game, GAMES[game].types[0], 1, 0);
  const uid = first[0]?.uid;
  if (!uid) throw new Error('最近六个月内没有抽卡记录，或抽卡链接已过期');
  const existing = readImportGroups(importsPath(userData)).find(
    (group) => group.game === game && String(group.uid) === String(uid)
  );
  const known = new Set((existing?.records || []).map((record) => String(record.Id)));
  const maxKnown = (existing?.records || []).reduce((max, record) => {
    try {
      const value = BigInt(record.Id);
      return value > max ? value : max;
    } catch {
      return max;
    }
  }, 0n);
  const records = [];
  for (const type of GAMES[game].types) {
    let endId = '0';
    for (let page = 1; page <= 200; page += 1) {
      const list = await fetchPage(clean.toString(), game, type, page, endId);
      if (!list.length) break;
      let added = 0;
      for (const item of list) {
        const id = String(item.id);
        if (known.has(id)) continue;
        known.add(id);
        records.push({
          Uid: String(item.uid || uid),
          Id: id,
          Name: String(item.name || ''),
          Time: String(item.time || '').replace('T', ' ').replace(/Z$/, ''),
          ItemId: String(item.item_id || ''),
          ItemType: String(item.item_type || ''),
          RankType: Number(item.rank_type) || 0,
          GachaType: Number(item.gacha_type) || type,
        });
        added += 1;
      }
      onProgress?.({ game, type, page, added, total: records.length });
      const lastId = list[list.length - 1]?.id;
      if (list.length < 20) break;
      if (!lastId) break;
      endId = String(lastId);
      try {
        if (BigInt(endId) <= maxKnown) break;
      } catch {
        /* ignore malformed id */
      }
      if (!added && page > 1) break;
    }
  }
  if (!records.length) {
    return { ok: true, game, uid: String(uid), imported: 0, total: existing?.records.length || 0 };
  }
  const file = importsPath(userData);
  const groups = mergeGroups(readImportGroups(file), [{ game, uid: String(uid), records }]);
  await saveImportGroups(file, groups);
  return {
    ok: true,
    game,
    uid: String(uid),
    imported: records.length,
    total: groups.find((group) => group.game === game && group.uid === String(uid))?.records.length || 0,
  };
}

module.exports = { syncGacha, extractUrlFromCache, GAMES };
