'use strict';

const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('./vendor/sql-wasm.js');
const { readImportGroups } = require('./gacha-import');
const { loadGachaMeta, ENDFIELD_SLUG_ALIAS } = require('./gacha-meta');

const GAME_DEFS = [
  {
    key: 'genshin',
    name: '原神',
    table: 'GenshinGachaItem',
    infoTable: 'GenshinGachaInfo',
    infoId: 'Id',
    infoName: 'Name',
    infoIcon: 'Icon',
    fiveRank: 5,
    fourRank: 4,
    banners: {
      100: '新手祈愿',
      200: '常驻祈愿',
      301: '角色活动祈愿',
      302: '武器活动祈愿',
      400: '集录祈愿',
    },
    // 常驻池（算进「常驻池」分类）、「不是 ItemType=weapon 但确实是武器池」的卡池类型、
    // 以及独立的邦布池（目前只有绝区零的邦布频段）
    standard: [200],
    weaponBanners: [302],
  },
  {
    key: 'starrail',
    name: '崩坏：星穹铁道',
    table: 'StarRailGachaItem',
    infoTable: 'StarRailGachaInfo',
    infoId: 'ItemId',
    infoName: 'ItemName',
    infoIcon: 'IconUrl',
    fiveRank: 5,
    fourRank: 4,
    banners: {
      1: '常驻跃迁',
      2: '角色活动跃迁',
      11: '角色活动跃迁',
      12: '光锥活动跃迁',
    },
    standard: [1],
    weaponBanners: [12],
  },
  {
    key: 'zzz',
    name: '绝区零',
    table: 'ZZZGachaItem',
    infoTable: 'ZZZGachaInfo',
    infoId: 'Id',
    infoName: 'Name',
    infoIcon: 'Icon',
    fiveRank: 4,
    fourRank: 3,
    banners: {
      1: '常驻频段',
      2: '独家频段',
      3: '音擎频段',
      4: '邦布频段',
      5: '邦布频段',
    },
    standard: [1],
    weaponBanners: [3],
    bangbooBanners: [5],
  },
  {
    key: 'endfield',
    name: '明日方舟：终末地',
    table: '',
    infoTable: '',
    infoId: 'Id',
    infoName: 'Name',
    infoIcon: 'Icon',
    fiveRank: 6,
    fourRank: 5,
    banners: {
      1: '特许寻访',
      2: '重构寻访',
      3: '辉光庆典',
      4: '基础寻访',
      5: '启程寻访',
      101: '限定申领',
      102: '常驻申领',
      103: '重构申领',
    },
    standard: [4, 102],
    weaponBanners: [],
  },
  {
    key: 'neverness',
    name: '异环',
    table: '',
    infoTable: '',
    infoId: 'Id',
    infoName: 'Name',
    infoIcon: 'Icon',
    fiveRank: 5,
    fourRank: 4,
    banners: {
      1: '限定棋盘',
      2: '标准棋盘',
      3: '弧盘研募',
    },
    standard: [2],
    weaponBanners: [],
  },
];

let sqlModule = null;
let cache = { path: '', mtime: 0, metaAt: 0, data: null };

const META_TTL = 2 * 60 * 60 * 1000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function getSql() {
  if (!sqlModule) {
    sqlModule = await initSqlJs({
      locateFile: (file) => path.join(__dirname, 'vendor', file),
    });
  }
  return sqlModule;
}

function normalizeIcon(icon) {
  if (!icon) return null;
  return String(icon).replace(/^http:/i, 'https:');
}

function addEntry(map, id, name, icon) {
  if (id === undefined || id === null) return;
  map.set(String(id), { name: String(name || ''), icon: normalizeIcon(icon) });
}

async function fetchGenshinMeta() {
  const response = await fetch(
    'https://api-takumi.mihoyo.com/event/platsimulator/config?gids=2&game=hk4e',
    { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15000) }
  );
  if (!response.ok) throw new Error(`原神元数据 HTTP ${response.status}`);
  const json = await response.json();
  if (json.retcode !== 0) throw new Error(json.message || '原神元数据返回错误');
  const map = new Map();
  for (const item of json.data?.all_avatar || []) addEntry(map, item.id, item.name, item.icon);
  for (const item of json.data?.all_weapon || []) addEntry(map, item.id, item.name, item.icon);
  return map;
}

async function fetchStarRailMeta() {
  const response = await fetch(
    'https://api-takumi.mihoyo.com/event/rpgsimulator/config?game=hkrpg',
    { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15000) }
  );
  if (!response.ok) throw new Error(`星穹铁道元数据 HTTP ${response.status}`);
  const json = await response.json();
  if (json.retcode !== 0) throw new Error(json.message || '星穹铁道元数据返回错误');
  const map = new Map();
  for (const item of json.data?.avatar || [])
    addEntry(map, item.item_id, item.item_name, item.new_icon_url || item.icon_url);
  for (const item of json.data?.equipment || [])
    addEntry(map, item.item_id, item.item_name, item.new_icon_url || item.icon_url);
  return map;
}

async function fetchZzzMeta() {
  const response = await fetch(
    'https://starward-static.scighost.com/metadata/v1/zzz/ZZZGachaInfo.nap_cn.zh-cn.json',
    { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15000) }
  );
  if (!response.ok) throw new Error(`绝区零元数据 HTTP ${response.status}`);
  const json = await response.json();
  if (json.retcode !== 0) throw new Error(json.message || '绝区零元数据返回错误');
  const map = new Map();
  for (const item of json.data?.list || []) addEntry(map, item.id, item.name, item.icon);
  return map;
}

const META_FETCHERS = {
  genshin: fetchGenshinMeta,
  starrail: fetchStarRailMeta,
  zzz: fetchZzzMeta,
};

/**
 * 终末地 / 异环没有官方图鉴接口，用导入记录自身补一份 id -> 名称 的映射，
 * 至少保证不同渠道包改名时能显示记录里的原始名称。
 */
function metaFromImports(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = String(row.ItemId || '');
    if (!id || map.has(id)) continue;
    map.set(id, { name: String(row.Name || ''), icon: null });
  }
  return map;
}

function serializeMeta(maps) {
  const games = {};
  for (const [key, map] of Object.entries(maps)) {
    games[key] = Object.fromEntries(map);
  }
  return games;
}

function deserializeMeta(games) {
  const result = {};
  for (const key of Object.keys(META_FETCHERS)) {
    const map = new Map();
    for (const [id, item] of Object.entries(games?.[key] || {})) {
      if (item && item.name) map.set(String(id), { name: item.name, icon: normalizeIcon(item.icon) });
    }
    result[key] = map;
  }
  return result;
}

async function loadOfficialMeta(cachePath, force = false) {
  let stored = null;
  try {
    stored = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
  } catch {
    stored = null;
  }
  if (!force && stored && Date.now() - Number(stored.updatedAt || 0) < META_TTL) {
    return { maps: deserializeMeta(stored.games), updatedAt: stored.updatedAt };
  }

  const maps = stored ? deserializeMeta(stored.games) : {};
  await Promise.all(
    Object.entries(META_FETCHERS).map(async ([key, fetcher]) => {
      try {
        maps[key] = await fetcher();
      } catch (error) {
        console.warn('更新抽卡元数据失败：', key, error.message);
        if (!maps[key]) maps[key] = new Map();
      }
    })
  );
  const updatedAt = Date.now();
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.promises.writeFile(
      cachePath,
      JSON.stringify({ updatedAt, games: serializeMeta(maps) }),
      'utf8'
    );
  } catch {
    /* cache write is best-effort */
  }
  return { maps, updatedAt };
}

function bannerName(def, type) {
  return def.banners[type] || `卡池 ${type}`;
}

// 抽卡分类：角色池 / 武器池 / 常驻池 / 邦布池
// 只按「记录本身」判断，不依赖卡池名字，卡池改名也不影响分类。
// 绝区零是本地化中文名：邦布=/邦布/，音擎=/音擎/，代理人算角色。
function itemKind(def, row) {
  // 只有终末地 / 异环把武器记录放在 101+ 的 gachaType 里；
  // 原神的 100/200/301/302 是「卡池类型」，不能当成武器。
  const usesWeaponTypeRange = def.key === 'endfield' || def.key === 'neverness';
  const gachaType = Number(row.GachaType);
  const itemType = String(row.ItemType || '').toLowerCase();
  if (/邦布|bangboo/.test(itemType)) return 'bangboo';
  if (itemType === 'weapon' || /音擎|w-?engine/.test(itemType)) return 'weapon';
  return usesWeaponTypeRange && gachaType >= 100 ? 'weapon' : 'character';
}

function isStandardRow(def, row) {
  return (def.standard || []).includes(Number(row.GachaType));
}

function categoryOf(def, row) {
  const type = Number(row.GachaType);
  if (isStandardRow(def, row)) return 'standard';
  // 邦布频段是独立抽卡池，优先于武器判断
  if ((def.bangbooBanners || []).includes(type) || itemKind(def, row) === 'bangboo') return 'bangboo';
  if (itemKind(def, row) === 'weapon') return 'weapon';
  if ((def.weaponBanners || []).includes(type)) return 'weapon';
  return 'character';
}

// 分类统计：对每个子集复用 summarize，避免两套口径。
// 注意 withBreakdown=false，防止递归。
function buildBreakdown(def, list, infoMap) {
  const pick = (kind) =>
    summarize(def, list.filter((row) => categoryOf(def, row) === kind), infoMap, false)[0] || null;
  return {
    character: pick('character'),
    weapon: pick('weapon'),
    standard: pick('standard'),
    bangboo: pick('bangboo'),
  };
}

function readRows(db, def) {
  const exists = db.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${def.table}'`
  );
  if (!exists.length) return [];
  const stmt = db.prepare(
    `SELECT Uid, Id, Name, Time, ItemId, ItemType, RankType, GachaType FROM ${def.table} ORDER BY Time ASC, Id ASC`
  );
  const rows = [];
  const seen = new Set();
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const key = `${row.Uid}:${row.Id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function readInfoMap(db, def) {
  const map = new Map();
  try {
    const exists = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${def.infoTable}'`
    );
    if (!exists.length) return map;
    const stmt = db.prepare(
      `SELECT ${def.infoId} AS ItemId, ${def.infoName} AS Name, ${def.infoIcon} AS Icon FROM ${def.infoTable}`
    );
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const icon = row.Icon ? String(row.Icon).replace(/^http:/i, 'https:') : null;
      map.set(String(row.ItemId), { name: row.Name, icon });
    }
    stmt.free();
  } catch {
    /* icon metadata is optional */
  }
  return map;
}

function summarize(def, rows, infoMap, withBreakdown = true) {
  // 只有终末地 / 异环把武器记录放在 101+ 的 gachaType 里；
  // 原神的 100/200/301/302 是「卡池类型」，不能当成武器。
  const usesWeaponTypeRange = def.key === 'endfield' || def.key === 'neverness';
  const byUid = new Map();
  for (const row of rows) {
    const uid = String(row.Uid);
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(row);
  }

  const users = [];
  for (const [uid, list] of byUid) {
    const five = list.filter((row) => Number(row.RankType) === def.fiveRank);
    const four = list.filter((row) => Number(row.RankType) === def.fourRank);
    const byType = new Map();
    for (const row of list) {
      const type = Number(row.GachaType);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(row);
    }

    const pities = [];
    for (const [type, pulls] of byType) {
      let lastFiveIndex = -1;
      for (let i = 0; i < pulls.length; i += 1) {
        if (Number(pulls[i].RankType) === def.fiveRank) lastFiveIndex = i;
      }
      const pity = pulls.length - lastFiveIndex - 1;
      const fiveList = pulls.filter((item) => Number(item.RankType) === def.fiveRank);
      pities.push({
        type,
        name: bannerName(def, type),
        category: categoryOf(def, pulls[0]),
        pulls: pulls.length,
        five: fiveList.length,
        pity: lastFiveIndex >= 0 ? pity : pulls.length,
        lastFive: lastFiveIndex >= 0 ? pulls[lastFiveIndex].Time : null,
      });
    }
    pities.sort((a, b) => b.pulls - a.pulls);

    // 逐池统计垫数：保底只在同一卡池内累计，跨池连加会算错。
    const fiveDetails = [];
    for (const [type, pulls] of byType) {
      let counter = 0;
      for (const row of pulls) {
        counter += 1;
        if (Number(row.RankType) !== def.fiveRank) continue;
        const info = infoMap.get(String(row.ItemId));
        fiveDetails.push({
          name: (info && info.name) || row.Name,
          icon: (info && info.icon) || null,
          time: row.Time,
          banner: bannerName(def, type),
          pity: counter,
          gachaType: type,
          // 与 categoryOf 保持同一口径（绝区零的邦布/音擎是中文名，直接看记录）
          itemType: categoryOf(def, row),
        });
        counter = 0;
      }
    }

    // 新的在前，供「五星记录」列表直接渲染
    fiveDetails.sort((a, b) => String(b.time).localeCompare(String(a.time)));

    // 四星明细：合并版抽卡页的「4★」一栏要按名字聚合出次数榜
    const fourDetails = [];
    for (const pulls of byType.values()) {
      for (const row of pulls) {
        if (Number(row.RankType) !== def.fourRank) continue;
        const info = infoMap.get(String(row.ItemId));
        fourDetails.push({
          name: (info && info.name) || row.Name,
          icon: (info && info.icon) || null,
          time: row.Time,
          itemType: categoryOf(def, row),
        });
      }
    }

    // 记录里没有低于四星的抽卡时（很多 UIGF 导出只存四星以上），
    // 垫数会把四星也算进去，只能当参考值。
    const pityExact = list.some((row) => Number(row.RankType) < def.fourRank);

    const pityValues = fiveDetails.map((item) => item.pity);
    const averagePity = pityValues.length
      ? Math.round((pityValues.reduce((sum, value) => sum + value, 0) / pityValues.length) * 10) / 10
      : 0;
    const luckiest = pityValues.length ? Math.min(...pityValues) : 0;

    users.push({
      uid,
      total: list.length,
      five: five.length,
      four: four.length,
      // 低于四星的抽数（绝区零是 B 级，原神/铁道是 3★）
      low: list.filter((row) => Number(row.RankType) < def.fourRank).length,
      // 这个分类里当前攒下的垫抽：各卡池类型取最大（铁道/原神的 400 集录一般没抽，主池就是它）
      currentPity: pities.length ? Math.max(...pities.map((item) => item.pity || 0)) : 0,
      fiveRate: list.length ? (five.length / list.length) * 100 : 0,
      fourRate: list.length ? (four.length / list.length) * 100 : 0,
      averagePity,
      luckiest,
      fivePulls: fiveDetails.length,
      weaponFive: fiveDetails.filter((item) => item.itemType === 'weapon').length,
      bangbooFive: fiveDetails.filter((item) => item.itemType === 'bangboo').length,
      charFive: fiveDetails.filter((item) => item.itemType === 'character').length,
      firstTime: list[0] ? list[0].Time : null,
      lastTime: list[list.length - 1] ? list[list.length - 1].Time : null,
      pities,
      pityExact,
      fiveHistory: fiveDetails.slice(0, 300),
      fourHistory: fourDetails.slice(0, 600),
      recentFive: fiveDetails.slice(0, 12),
      breakdown: withBreakdown ? buildBreakdown(def, list, infoMap) : null,
    });
  }

  users.sort((a, b) => b.total - a.total);
  return users;
}

async function loadGachaHistory(dbPath, metaCachePath, force = false, importsPath = '') {
  const importGroups = importsPath ? readImportGroups(importsPath) : [];
  const dbExists = Boolean(dbPath && fs.existsSync(dbPath));
  if (!dbExists && !importGroups.length) {
    throw new Error('没有找到 Starward 数据库，也没有导入过 UIGF 抽卡记录');
  }
  const stat = dbExists ? fs.statSync(dbPath) : null;
  let importMtime = 0;
  if (importsPath) {
    try {
      importMtime = fs.statSync(importsPath).mtimeMs;
    } catch {
      importMtime = 0;
    }
  }
  if (
    !force &&
    cache.path === (dbExists ? dbPath : importsPath) &&
    cache.mtime === (stat ? stat.mtimeMs : importMtime) &&
    cache.importMtime === importMtime &&
    cache.data &&
    Date.now() - cache.metaAt < META_TTL
  ) {
    return cache.data;
  }

  const meta = await loadOfficialMeta(metaCachePath, force);
  // 终末地 / 异环的图鉴（名称 + 官方立绘），失败时返回空表，不影响抽卡页
  const gachaMeta = await loadGachaMeta(
    path.join(path.dirname(metaCachePath), 'gacha-meta-ext.json'),
    force
  ).catch(() => ({ endfield: {}, neverness: {} }));
  const endfieldMeta = gachaMeta.endfield || {};
  const nevernessMeta = gachaMeta.neverness || {};
  let db = null;
  try {
    if (dbExists) {
      const SQL = await getSql();
      let buffer;
      try {
        buffer = fs.readFileSync(dbPath);
      } catch (error) {
        throw new Error(`无法读取 Starward 数据库：${error.message}`);
      }
      db = new SQL.Database(buffer);
    }
    const games = [];
    for (const def of GAME_DEFS) {
      const rows = db ? readRows(db, def) : [];
      const infoMap = db ? readInfoMap(db, def) : new Map();
      for (const [id, item] of meta.maps[def.key] || []) {
        if (item && item.name) infoMap.set(id, item);
      }
      for (const group of importGroups) {
        if (group.game !== def.key) continue;
        rows.push(...group.records);
      }
      if (!META_FETCHERS[def.key]) {
        // 先用导入记录里的原始名称兜底（保证有名字可显示）
        for (const [id, item] of metaFromImports(rows)) {
          if (item.name && !infoMap.has(id)) infoMap.set(id, item);
        }
        // 再用官网图鉴补图标和更规范的名称
        if (def.key === 'endfield') {
          for (const row of rows) {
            const id = String(row.ItemId || '');
            if (!id) continue;
            // 角色：chr_0009_azrila → 剥出 slug 查官网干员页索引；
            // 武器：wpn_lance_0004 → 直接查社区图鉴仓库的武器表
            const slug = id.replace(/^chr_\d+_/, '');
            const hit =
              endfieldMeta.bySlug?.[slug] ||
              endfieldMeta.bySlug?.[ENDFIELD_SLUG_ALIAS[slug] || ''] ||
              endfieldMeta.byName?.[String(row.Name || '')] ||
              (id.startsWith('wpn_') ? endfieldMeta.weapons?.[id] : null);
            if (!hit) continue;
            const existing = infoMap.get(id) || {};
            infoMap.set(id, {
              name: existing.name || hit.name || '',
              icon: hit.icon || existing.icon || null,
            });
          }
        } else if (def.key === 'neverness') {
          for (const row of rows) {
            const id = String(row.ItemId || '');
            const name = String(row.Name || '');
            const hit =
              nevernessMeta.items?.[id] ||
              nevernessMeta.byName?.[name];
            if (!hit) continue;
            const existing = infoMap.get(id) || {};
            infoMap.set(id, {
              name: existing.name || hit.name || '',
              icon: hit.icon || existing.icon || null,
            });
          }
        }
      }
      const seen = new Set();
      const unique = [];
      for (const row of rows) {
        const key = `${row.Uid}:${row.Id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(row);
      }
      if (!unique.length) continue;
      unique.sort((a, b) => String(a.Time).localeCompare(String(b.Time)));
      games.push({
        key: def.key,
        name: def.name,
        users: summarize(def, unique, infoMap),
      });
    }
    const data = {
      ok: true,
      path: dbExists ? dbPath : importsPath,
      source: dbExists ? 'starward' : 'uigf',
      loadedAt: new Date().toISOString(),
      metaUpdatedAt: new Date(meta.updatedAt).toISOString(),
      gachaMetaUpdatedAt: gachaMeta.updatedAt
        ? new Date(gachaMeta.updatedAt).toISOString()
        : null,
      gachaMetaErrors: gachaMeta.errors || [],
      games,
    };
    cache = {
      path: dbExists ? dbPath : importsPath,
      mtime: stat ? stat.mtimeMs : importMtime,
      importMtime,
      metaAt: meta.updatedAt,
      data,
    };
    return data;
  } finally {
    if (db) db.close();
  }
}

module.exports = { loadGachaHistory };
