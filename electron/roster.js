'use strict';

/*
 * 角色图鉴：把三款米哈游游戏的角色数据抓下来、归一成同一套字段。
 *
 * 为什么放在主进程：
 *   1. 要读登录态里的 cookie（渲染进程拿不到明文 cookie）；
 *   2. 一次请求几百 KB，缓存落盘比每次重抓省事；
 *   3. 归一化逻辑（元素中文名、圣遗物主副词条）放在这里，前端只管画。
 *
 * 三款游戏的接口差异（都实测过）：
 *   原神   POST /game_record/app/genshin/api/character/list
 *          → list[]，每条有 base 字段（等级/命座/好感）+ weapon
 *          → 但列表里 **没有圣遗物**，要再打 character/detail（支持批量 ids）
 *   星铁   GET  /game_record/app/hkrpg/api/avatar/info?role_id=&server=&need_wiki=false
 *          → avatar_list[]，一次就带齐光锥、遗器、属性、技能，不需要第二次请求
 *   绝区零 GET  /event/game_record_zzz/api/zzz/index?server=&role_id=
 *          → avatar_list[]（等级/命座/稀有度/阵营/职业/元素）+ buddy_list[]（邦布）
 *          → avatar/info 恒回 -400005「网页异常」，官方没开这个接口，
 *            所以绝区零拿不到音擎和驱动盘，只有基础练度
 */

const fs = require('node:fs');
const path = require('node:path');

const CACHE_FILE = 'roster-cache.json';
/*
 * 缓存版本：归一化输出结构变了就 +1。
 * 不加这个的话，改了字段之后老缓存还会被当成有效数据返回，
 * 界面上就永远是旧样子（踩过一次：补了词条名，缓存里还是旧结构）。
 */
const CACHE_VERSION = 2;
/* 角色数据不像抽卡记录那样每分钟都在变，半小时足够新 */
const TTL = 30 * 60 * 1000;

const GAMES = {
  genshin: {
    key: 'genshin',
    name: '原神',
    listPath: '/game_record/app/genshin/api/character/list',
    listMethod: 'POST',
    detailPath: '/game_record/app/genshin/api/character/detail',
    /* 原神列表不含圣遗物，详情必须单独请求 */
    needsDetail: true,
  },
  starrail: {
    key: 'starrail',
    name: '崩坏：星穹铁道',
    listPath: '/game_record/app/hkrpg/api/avatar/info',
    listMethod: 'GET',
    detailPath: '',
    needsDetail: false,
  },
  zzz: {
    key: 'zzz',
    name: '绝区零',
    listPath: '/event/game_record_zzz/api/zzz/index',
    listMethod: 'GET',
    detailPath: '',
    needsDetail: false,
  },
};

const ELEMENT_CN = {
  /* 原神 */
  Cryo: '冰',
  Hydro: '水',
  Pyro: '火',
  Electro: '雷',
  Anemo: '风',
  Geo: '岩',
  Dendro: '草',
  /* 星铁 */
  ice: '冰',
  fire: '火',
  wind: '风',
  lightning: '雷',
  physical: '物理',
  quantum: '量子',
  imaginary: '虚数',
};

/* 绝区零的属性是数字枚举，202=冰 是拿艾莲（冰属性）实测对上的 */
const ZZZ_ELEMENT_CN = {
  200: '物理',
  201: '火',
  202: '冰',
  203: '电',
  204: '风',
  205: '以太',
};

const ZZZ_PROFESSION_CN = {
  1: '强攻',
  2: '击破',
  3: '支援',
  4: '防护',
  5: '异常',
  6: '命破',
};

/*
 * 原神圣遗物 / 武器的词条 id → 中文名。
 * 数字来自游戏内 FIGHT_PROP_* 枚举，对照实测数据逐条核过。
 */
const GENSHIN_PROP_CN = {
  1: '基础生命值',
  2: '生命值',
  3: '生命值',
  4: '基础攻击力',
  5: '攻击力',
  6: '攻击力',
  7: '基础防御力',
  8: '防御力',
  9: '防御力',
  20: '暴击率',
  22: '暴击伤害',
  23: '元素充能效率',
  26: '治疗加成',
  27: '受治疗加成',
  28: '元素精通',
  30: '物理伤害加成',
  40: '火元素伤害加成',
  41: '雷元素伤害加成',
  42: '水元素伤害加成',
  43: '草元素伤害加成',
  44: '风元素伤害加成',
  45: '岩元素伤害加成',
  46: '冰元素伤害加成',
};

/* 星铁的遗器部位 1..6（内圈两个是位面球 / 连结绳，跟外圈四件不是一套说法） */
const STARRAIL_POS_CN = {
  1: '头部',
  2: '手部',
  3: '躯干',
  4: '脚部',
  5: '位面球',
  6: '连结绳',
};

/* 原神的命座叫「命之座」，星铁叫「星魂」，绝区零叫「影画」 */
const RANK_LABEL = {
  genshin: '命座',
  starrail: '星魂',
  zzz: '影画',
};

function cachePath(userData) {
  return path.join(userData, CACHE_FILE);
}

function readCache(userData) {
  try {
    const raw = fs.readFileSync(cachePath(userData), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeCache(userData, cache) {
  try {
    fs.writeFileSync(cachePath(userData), JSON.stringify(cache), 'utf8');
  } catch {
    /* 缓存写不进去不影响功能，下次重抓而已 */
  }
}

/* ---------- 归一化 ---------- */

function normGenshin(item) {
  const base = item.base || item;
  const weapon = item.weapon || base.weapon || null;
  return {
    id: base.id,
    name: base.name || '',
    icon: base.icon || base.image || '',
    image: base.image || '',
    rarity: base.rarity || 0,
    level: base.level || 0,
    element: base.element || '',
    elementName: ELEMENT_CN[base.element] || base.element || '',
    rank: base.actived_constellation_num || 0,
    fetter: base.fetter || 0,
    weapon: weapon
      ? {
          name: weapon.name || '',
          icon: weapon.icon || '',
          rarity: weapon.rarity || 0,
          level: weapon.level || 0,
          refine: weapon.affix_level || 0,
          typeName: weapon.type_name || '',
          main: weapon.main_property
            ? {
                type: weapon.main_property.property_type,
                name: GENSHIN_PROP_CN[weapon.main_property.property_type] || '',
                value: weapon.main_property.final,
              }
            : null,
          sub: weapon.sub_property
            ? {
                type: weapon.sub_property.property_type,
                name: GENSHIN_PROP_CN[weapon.sub_property.property_type] || '',
                value: weapon.sub_property.final,
              }
            : null,
        }
      : null,
    relics: (item.relics || []).map((relic) => ({
      name: relic.name || '',
      icon: relic.icon || '',
      rarity: relic.rarity || 0,
      level: relic.level || 0,
      pos: relic.pos || 0,
      posName: relic.pos_name || '',
      set: relic.set ? relic.set.name : '',
      main: relic.main_property
        ? {
            type: relic.main_property.property_type,
            name: GENSHIN_PROP_CN[relic.main_property.property_type] || '',
            value: relic.main_property.value,
          }
        : null,
      subs: (relic.sub_property_list || []).map((sub) => ({
        type: sub.property_type,
        name: GENSHIN_PROP_CN[sub.property_type] || '',
        value: sub.value,
      })),
    })),
    properties: (item.selected_properties || []).map((prop) => ({
      name: prop.property_name || '',
      value: prop.final || '',
    })),
    skills: (item.skills || []).map((skill) => ({
      name: skill.skill_name || '',
      level: skill.level || 0,
      icon: skill.icon || '',
    })),
    hasDetail: Array.isArray(item.relics) && item.relics.length > 0,
  };
}

function normStarrail(item, propMap) {
  const equip = item.equip || null;
  const nameOf = (type) => (propMap && propMap[type]) || '';
  return {
    id: item.id,
    name: item.name || '',
    icon: item.icon || '',
    image: item.image || '',
    rarity: item.rarity || 0,
    level: item.level || 0,
    element: item.element || '',
    elementName: ELEMENT_CN[item.element] || item.element || '',
    rank: item.rank || 0,
    fetter: 0,
    weapon: equip
      ? {
          name: equip.name || '',
          icon: equip.icon || '',
          rarity: equip.rarity || 0,
          level: equip.level || 0,
          refine: equip.rank || 0,
          typeName: '光锥',
          main: null,
          sub: null,
        }
      : null,
    /* 星铁的遗器和内圈饰品是两个字段，合并展示 */
    relics: [...(item.relics || []), ...(item.ornaments || [])].map((relic) => ({
      name: relic.name || '',
      icon: relic.icon || '',
      rarity: relic.rarity || 0,
      level: relic.level || 0,
      pos: relic.pos || 0,
      posName: STARRAIL_POS_CN[relic.pos] || (relic.pos ? `部位 ${relic.pos}` : ''),
      set: relic.set && relic.set.name ? relic.set.name : '',
      main: relic.main_property
        ? {
            type: relic.main_property.property_type,
            name: nameOf(relic.main_property.property_type),
            value: relic.main_property.value,
          }
        : null,
      subs: (relic.properties || []).map((prop) => ({
        type: prop.property_type,
        name: nameOf(prop.property_type),
        value: prop.value,
      })),
    })),
    properties: (item.properties || []).map((prop) => ({
      name: prop.property_name || '',
      value: prop.final || '',
    })),
    skills: (item.skills || []).map((skill) => ({
      name: skill.name || '',
      level: skill.level || 0,
      icon: skill.icon || '',
    })),
    hasDetail: true,
  };
}

function normZzz(item) {
  return {
    id: item.id,
    name: item.full_name_mi18n || item.name_mi18n || '',
    icon: item.role_square_url || item.group_icon_path || '',
    image: item.hollow_icon_path || '',
    rarity: item.rarity === 'S' ? 5 : item.rarity === 'A' ? 4 : 3,
    level: item.level || 0,
    element: String(item.element_type || ''),
    elementName: ZZZ_ELEMENT_CN[item.element_type] || '',
    rank: item.rank || 0,
    fetter: 0,
    /* 绝区零的音擎 / 驱动盘接口没开，这两个字段恒空 */
    weapon: null,
    relics: [],
    properties: [],
    skills: [],
    hasDetail: false,
    camp: item.camp_name_mi18n || '',
    profession: ZZZ_PROFESSION_CN[item.avatar_profession] || '',
    shortName: item.name_mi18n || '',
  };
}

function normOne(game, item, propMap) {
  if (game === 'genshin') return normGenshin(item);
  if (game === 'starrail') return normStarrail(item, propMap);
  if (game === 'zzz') return normZzz(item);
  return null;
}

/* ---------- 请求 ---------- */

/*
 * 统一走 miyoushe.fetchRecord：它会补 DS 签名、设备指纹和 x-rpc 头，
 * 自己拼请求很容易被风控挡成 5003。
 */
async function callRecord(miyoushe, cookie, providerId, game, api, method, body) {
  const data = await miyoushe.fetchRecord(api, cookie, providerId, {
    referer: 'record',
    method,
    body,
  });
  return data || {};
}

async function fetchList(miyoushe, { game, uid, server, cookie, providerId }) {
  const def = GAMES[game];
  if (!def) throw new Error('不认识的游戏：' + game);
  if (def.listMethod === 'POST') {
    const api = def.listPath;
    const data = await callRecord(miyoushe, cookie, providerId, game, api, 'POST', {
      server,
      role_id: String(uid),
    });
    return { items: Array.isArray(data.list) ? data.list : [], propMap: {} };
  }
  const api = `${def.listPath}?role_id=${encodeURIComponent(uid)}&server=${encodeURIComponent(server)}&need_wiki=false`;
  const data = await callRecord(miyoushe, cookie, providerId, game, api, 'GET');
  /*
   * 星铁的 avatar/info 顺带回了 property_info（56 条词条定义），
   * 拿它把遗器里那些数字 type 翻成名字，比在代码里抄一张表可靠。
   */
  const propMap = {};
  if (game === 'starrail' && data.property_info && typeof data.property_info === 'object') {
    for (const entry of Object.values(data.property_info)) {
      if (entry && entry.property_type && entry.name) propMap[entry.property_type] = entry.name;
    }
  }
  return {
    items: Array.isArray(data.avatar_list) ? data.avatar_list : [],
    propMap,
  };
}

/* 原神专有：一次最多传一批 ids 拿详情（含圣遗物） */
async function fetchGenshinDetail(miyoushe, { uid, server, cookie, providerId, ids }) {
  if (!ids.length) return {};
  const data = await callRecord(
    miyoushe,
    cookie,
    providerId,
    'genshin',
    '/game_record/app/genshin/api/character/detail',
    'POST',
    { server, role_id: String(uid), character_ids: ids },
  );
  const map = {};
  for (const item of data.list || []) {
    const base = item.base || {};
    if (base.id) map[base.id] = item;
  }
  return map;
}

/* ---------- 对外 ---------- */

/*
 * 拉整份图鉴。
 * options: { userData, game, uid, server, providerId, cookie, force }
 * 返回 { ok, game, uid, server, characters[], buddies[], updatedAt, fromCache }
 */
async function loadRoster(miyoushe, options) {
  const { userData, game, uid, server, providerId = 'miyoushe', cookie, force = false } = options;
  if (!GAMES[game]) return { ok: false, error: '不认识的游戏：' + game };
  if (!uid) return { ok: false, error: '缺少 UID' };
  if (!cookie) return { ok: false, error: '这个游戏还没登录，先去账号中心登录米游社' };

  const cache = readCache(userData);
  const key = `${game}:${uid}`;
  const hit = cache[key];
  if (!force && hit && hit.version === CACHE_VERSION && Date.now() - Number(hit.updatedAt || 0) < TTL) {
    return { ...hit, ok: true, fromCache: true };
  }

  try {
    const fetched = await fetchList(miyoushe, { game, uid, server, cookie, providerId });
    const raw = fetched.items;
    const propMap = fetched.propMap;

    /*
     * 原神的圣遗物只能靠详情接口拿。一次请求带上所有 5 星角色的 id
     * （96 个角色里五星只有十几个，其余四星角色本来也没什么人练），
     * 既不漏主力，也不会把请求撑爆。
     */
    let detailMap = {};
    if (game === 'genshin') {
      const ids = raw
        .filter((item) => {
          const base = item.base || item;
          return (base.rarity || 0) === 5 || (base.level || 0) >= 70;
        })
        .map((item) => (item.base || item).id)
        .filter(Boolean);
      if (ids.length) {
        detailMap = await fetchGenshinDetail(miyoushe, { uid, server, cookie, providerId, ids }).catch(() => ({}));
      }
    }

    const characters = raw
      .map((item) => {
        const base = item.base || item;
        const merged = detailMap[base.id] ? { ...item, ...detailMap[base.id] } : item;
        return normOne(game, merged, propMap);
      })
      .filter(Boolean)
      .sort((a, b) => b.rarity - a.rarity || b.level - a.level || String(a.name).localeCompare(String(b.name)));

    const payload = {
      ok: true,
      version: CACHE_VERSION,
      game,
      uid: String(uid),
      server,
      characters,
      updatedAt: Date.now(),
      fromCache: false,
    };
    cache[key] = payload;
    writeCache(userData, cache);
    return payload;
  } catch (error) {
    /* 网络抖动时宁可给旧数据，也不要让界面空着 */
    if (hit && hit.version === CACHE_VERSION) {
      return { ...hit, ok: true, fromCache: true, stale: true, error: String(error && error.message) };
    }
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/* 单个角色的详情（原神用得上：列表里没圣遗物） */
async function loadCharacterDetail(miyoushe, options) {
  const { game, uid, server, providerId = 'miyoushe', cookie, characterId } = options;
  if (game !== 'genshin') return { ok: false, error: '这个游戏不需要单独取详情' };
  if (!cookie) return { ok: false, error: '这个游戏还没登录' };
  try {
    const map = await fetchGenshinDetail(miyoushe, { uid, server, cookie, providerId, ids: [characterId] });
    const item = map[characterId];
    if (!item) return { ok: false, error: '没取到这个角色的详情' };
    return { ok: true, character: normGenshin(item) };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

module.exports = {
  GAMES,
  ELEMENT_CN,
  ZZZ_ELEMENT_CN,
  ZZZ_PROFESSION_CN,
  RANK_LABEL,
  GENSHIN_PROP_CN,
  STARRAIL_POS_CN,
  CACHE_FILE,
  CACHE_VERSION,
  TTL,
  cachePath,
  loadRoster,
  loadCharacterDetail,
  normOne,
  normGenshin,
  normStarrail,
  normZzz,
};
