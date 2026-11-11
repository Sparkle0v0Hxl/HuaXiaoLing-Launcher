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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * 米哈游抽卡接口有限流：连发几百个请求会回 retcode 2001 / message「visit too
 * frequently」，接着几分钟内谁都进不来（用户手动点同步也是这个提示）。
 *
 * 一次全量同步到底要多少次请求？星铁 4 个类型（1/2/11/12）× 每类几十到上百页
 * = 几百次。以前这里是 while 循环全速连发，第一次导入必然撞墙；更糟的是它把
 * 限流当普通错误抛出，上层 5 分钟后重试，再撞一次，看起来就是「永远不同步」。
 *
 * 两道闸：
 *  1) 每次请求之间留 REQUEST_GAP 毫秒（默认 400ms ≈ 每秒 2.5 次）。
 *  2) 一旦识别到限流，立刻停止本轮（不再继续打），把「已被限流」这个事实
 *     带回去，让上层按更长冷却处理，而不是当成一般网络错误。
 */
const REQUEST_GAP = 400;
const RATE_LIMIT_MIN_COOLDOWN = 10 * 60 * 1000;

/*
 * 同一个游戏同一时间只允许一条同步在跑。
 *
 * 2026-11-11 用户手动点同步拿到「visit too frequently」，一部分原因就在这里：
 * 后台自动同步（20 秒一轮）刚打过一轮，用户又点了一次手动同步，两条链同时
 * 翻页 → 请求数翻倍 → 直接被限流。加锁后第二条会明确告诉用户「正在同步」，
 * 而不是一起去撞限流。
 */
const runningSyncs = new Map();

function syncInFlight(game) {
  return runningSyncs.has(game);
}

function isRateLimited(json) {
  const code = Number(json?.retcode);
  const message = String(json?.message || '');
  // 2001 是米哈游的通用限流码；消息文案各接口略有差异，两种都认
  return code === 2001 || /visit too frequently|too many requests|请求过于频繁/i.test(message);
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
    if (isRateLimited(json)) {
      // 单独的错误类型：上层要据此拉长冷却、并且不要再继续打后面的分页
      const error = new Error(
        '抽卡接口被限流了（visit too frequently）。米哈游限制查询频率，等十来分钟再点同步；' +
          '这段时间里重复点只会让冷却更长。'
      );
      error.rateLimited = true;
      error.cooldownMs = RATE_LIMIT_MIN_COOLDOWN;
      throw error;
    }
    if ([-100, -101, 10001].includes(Number(json.retcode))) {
      throw new Error('抽卡链接已过期，请重新打开一次游戏内的抽卡记录页面');
    }
    throw new Error(json.message || `抽卡接口错误 ${json.retcode}`);
  }
  return json.data?.list || [];
}


async function syncGacha({ game, installRoot, userData, onProgress, api: providedApi }) {
  if (!GAMES[game]) throw new Error('不支持这个游戏的抽卡同步');
  if (runningSyncs.has(game)) {
    const error = new Error(
      '这个游戏的抽卡记录正在同步中，等它跑完就行（不用重复点，重复点只会让接口限流更久）。'
    );
    error.busy = true;
    throw error;
  }
  runningSyncs.set(game, Date.now());
  try {
    return await syncGachaLocked({ game, installRoot, userData, onProgress, providedApi });
  } finally {
    runningSyncs.delete(game);
  }
}

async function syncGachaLocked({ game, installRoot, userData, onProgress, providedApi }) {
  const api = providedApi || extractUrlFromCache(installRoot, game);
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
  /*
   * 第一页已经拿过一次了（就是上面探测 uid 那一次），后面从第二页接着往下翻，
   * 省掉重复请求 —— 限流是按次数算的，能省一次是一次。
   */
  const types = GAMES[game].types;
  let requestCount = 1;
  let rateLimited = false;
  for (let index = 0; index < types.length; index += 1) {
    const type = types[index];
    let endId = '0';
    const startPage = type === types[0] ? 2 : 1;
    // 第一个类型的第一页已经在探测时取过，直接用它判断要不要继续
    if (type === types[0]) {
      const seeded = first;
      let seededAdded = 0;
      for (const item of seeded) {
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
        seededAdded += 1;
      }
      onProgress?.({ game, type, page: 1, added: seededAdded, total: records.length, requests: requestCount });
      const lastSeeded = seeded[seeded.length - 1]?.id;
      if (seeded.length < 20 || !lastSeeded) continue; // 这个类型只有一页，下一个类型
      endId = String(lastSeeded);
    }
    for (let page = startPage; page <= 200; page += 1) {
      /*
       * 每次请求之间留出间隔。以前这里是不间断连发，星铁全量要几百次请求，
       * 第一次导入 100% 撞限流（用户 2026-11-11 报的「visit too frequently」）。
       */
      await sleep(REQUEST_GAP);
      let list;
      try {
        list = await fetchPage(clean.toString(), game, type, page, endId);
      } catch (error) {
        if (error?.rateLimited) {
          rateLimited = true;
          // 已经抓到的先存下来：下次不用从头再翻，直接把这次当「部分成功」
          break;
        }
        throw error;
      }
      requestCount += 1;
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
      onProgress?.({ game, type, page, added, total: records.length, requests: requestCount });
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
    if (rateLimited) break; // 被限流了就别再去打剩下的类型，越打冷却越长
  }
  /*
   * 被限流时只要已经拿到了一部分就照常入库（聊胜于无），但要在结果里说清楚
   * 「这次没抓完」，界面能提示用户过多久再试，而不是假装同步成功。
   */
  if (!records.length) {
    if (rateLimited) {
      const error = new Error(
        '抽卡接口被限流了（visit too frequently）。米哈游限制查询频率，等十来分钟再点同步；这段时间里重复点只会让冷却更长。'
      );
      error.rateLimited = true;
      error.cooldownMs = RATE_LIMIT_MIN_COOLDOWN;
      throw error;
    }
    return { ok: true, game, uid: String(uid), imported: 0, total: existing?.records.length || 0, requests: requestCount };
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
    requests: requestCount,
    partial: rateLimited,
    ...(rateLimited
      ? { warning: '这次只同步了一部分：抽卡接口被限流了。等十来分钟再点同步就能接着抓（已抓到的已保存，不会重抓）。' }
      : {}),
  };
}

module.exports = { syncGacha, extractUrlFromCache, cacheFiles, GAMES };
