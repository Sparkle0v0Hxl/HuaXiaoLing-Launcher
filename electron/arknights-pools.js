'use strict';

/**
 * 明日方舟卡池元数据。
 *
 * 寻访记录接口只给 poolId（像 LIMITED_79_0_1）和一个池子名，不给「这个池子 UP 的是谁」。
 * 但 UP 名单是判断欧非的唯一依据 —— 不认 UP，抽到塔露拉和抽到阿米娅看起来一样。
 *
 * 数据源用社区维护的官方拆包（Kengxxiao/ArknightsGameData），里面 gacha_table.json
 * 的 gachaPoolClient 是官方客户端原样数据，每个池子都带 UP 字段：
 *   LIMITED      -> limitParam.limitedCharId
 *   LINKAGE      -> linkageParam.guaranteeTarget6Char
 *   CLASSIC 系   -> dynMeta.main6RarityCharId / sub6RarityCharId
 *   ATTAIN 系    -> dynMeta.attainRare6CharList
 *   甄选（自选） -> dynMeta.rarityPickCharDict.TIER_6
 *   NORMAL/常驻  -> 没有 UP（本来就不存在「当期 UP」这回事）
 *
 * character_table.json 有 15MB，但真正要的只是 id -> 中文名，
 * 所以缓存只存精简表，别把整包 15MB 塞进 userData 里。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* 同一份数据两个源，raw.githubusercontent 在部分网络下会挂，jsDelivr 兜底 */
const MIRRORS = [
  'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/',
  'https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/',
];

const POOL_FILE = 'arknights-pools.json';
const TTL = 24 * 60 * 60 * 1000;
const TIMEOUT = 30000;

let memory = null;

function request(url, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) });
        });
      }
    );
    req.on('error', (error) => resolve({ status: 0, body: Buffer.from(String(error.message || error)) }));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve({ status: 0, body: Buffer.from('timeout') });
    });
    req.end();
  });
}

async function fetchJson(name) {
  let last = '未知错误';
  for (const mirror of MIRRORS) {
    const res = await request(mirror + name);
    if (res.status !== 200 || !res.body.length) {
      last = 'HTTP ' + res.status;
      continue;
    }
    try {
      return JSON.parse(res.body.toString('utf8'));
    } catch (error) {
      last = '解析失败：' + error.message;
    }
  }
  throw new Error('拉取 ' + name + ' 失败（' + last + '）');
}

/**
 * 从一个 gachaPoolClient 条目里抠出 6★ / 5★ 的 UP 干员 id。
 *
 * 不同池型的字段完全不一样，而且是历史演进出来的（一代池没有 dynMeta，
 * 新池又加了自选）。宁可漏判也不要错判 —— 认不出的池型返回空数组，
 * 界面上就不打 UP 标，而不是把所有人都标成歪了。
 */
function pickUp(pool) {
  const up6 = [];
  const up5 = [];
  const push = (list, value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) if (item && !list.includes(item)) list.push(String(item));
      return;
    }
    if (typeof value === 'string' && !list.includes(value)) list.push(value);
  };

  if (pool && pool.limitParam) push(up6, pool.limitParam.limitedCharId);
  if (pool && pool.linkageParam) push(up6, pool.linkageParam.guaranteeTarget6Char);

  const meta = pool && pool.dynMeta;
  if (meta) {
    push(up6, meta.main6RarityCharId);
    push(up6, meta.sub6RarityCharId);
    push(up6, meta.attainRare6CharList);
    push(up6, meta.charIdList);
    push(up5, meta.rare5CharList);
    if (meta.rarityPickCharDict) {
      push(up6, meta.rarityPickCharDict.TIER_6);
      push(up5, meta.rarityPickCharDict.TIER_5);
    }
  }
  return { up6, up5 };
}

/** 池型归类：只是给界面上的「限定 / 常驻 / 中坚」用，不参与记录去重。 */
function ruleKind(rule) {
  const text = String(rule || '').toUpperCase();
  if (!text) return 'normal';
  if (text.indexOf('CLASSIC') === 0 || text === 'FESCLASSIC') return 'classic';
  if (text === 'NORMAL' || text === 'SINGLE' || text === 'DOUBLE') return 'normal';
  if (text === 'BACKFLOW') return 'normal';
  return 'limited';
}

/**
 * 把 gacha_table + character_table 压成两张小表落盘：
 *   pools：poolId -> { name, rule, kind, up6: [名字], up5: [名字] }
 *   chars：charId -> 名字（给四星榜之类的地方兜底用）
 *
 * 只存名字不存 id，因为界面上只认名字；id 换了池子名也不会变。
 */
async function refresh(cachePath) {
  const gacha = await fetchJson('gacha_table.json');
  const chars = await fetchJson('character_table.json');

  const nameOf = new Map();
  for (const [id, item] of Object.entries(chars || {})) {
    if (item && item.name) nameOf.set(id, String(item.name));
  }

  const pools = {};
  const list = Array.isArray(gacha.gachaPoolClient) ? gacha.gachaPoolClient : [];
  for (const entry of list) {
    const id = String(entry.gachaPoolId || '');
    if (!id) continue;
    const up = pickUp(entry);
    const rule = String(entry.gachaRuleType || '');
    pools[id] = {
      name: String(entry.gachaPoolName || ''),
      rule,
      kind: ruleKind(rule),
      openTime: Number(entry.openTime) || 0,
      endTime: Number(entry.endTime) || 0,
      up6: up.up6.map((charId) => nameOf.get(charId) || charId),
      up5: up.up5.map((charId) => nameOf.get(charId) || charId),
    };
  }

  const payload = {
    updatedAt: Date.now(),
    poolCount: Object.keys(pools).length,
    charCount: nameOf.size,
    pools,
  };
  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, JSON.stringify(payload), 'utf8');
  } catch {
    /* 缓存写不进去不影响本次使用 */
  }
  return payload;
}

function readCache(cachePath) {
  try {
    const text = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && parsed.pools) return parsed;
  } catch {
    /* 没有缓存或者坏了，都当没有 */
  }
  return null;
}

/**
 * 拿卡池表。force 只影响是否立刻重下；拿不到网络时永远用旧缓存，
 * 因为「UP 名单旧一天」比「整个抽卡页打不开」好得多。
 */
async function loadPools(cachePath, force = false) {
  const hit = memory && memory.path === cachePath ? memory.data : null;
  if (!force && hit && Date.now() - hit.updatedAt < TTL) return hit;

  const cached = readCache(cachePath);
  if (!force && cached && Date.now() - Number(cached.updatedAt || 0) < TTL) {
    memory = { path: cachePath, data: cached };
    return cached;
  }

  try {
    const fresh = await refresh(cachePath);
    memory = { path: cachePath, data: fresh };
    return fresh;
  } catch (error) {
    /*
     * 网络挂了就用旧表。旧表没有也要给个空结构 —— 调用方按「没有 UP 数据」处理，
     * 不能因为拉不到卡池表就让整个同步失败。
     */
    if (cached) {
      memory = { path: cachePath, data: cached };
      return cached;
    }
    return { updatedAt: 0, pools: {}, error: String(error.message || error) };
  }
}

function poolInfo(table, poolId) {
  if (!table || !table.pools) return null;
  return table.pools[poolId] || null;
}

/** 这一抽是不是命中了当期 UP。没有 UP 名单（常驻池/未知池）时返回 null，别当成歪了。 */
function judgeUp(table, poolId, charId, charName) {
  const info = poolInfo(table, poolId);
  if (!info) return null;
  const up6 = Array.isArray(info.up6) ? info.up6 : [];
  const up5 = Array.isArray(info.up5) ? info.up5 : [];
  if (!up6.length && !up5.length) return null;
  if (up6.indexOf(charName) >= 0 || up5.indexOf(charName) >= 0) return true;
  if (charId && (up6.indexOf(charId) >= 0 || up5.indexOf(charId) >= 0)) return true;
  return false;
}

module.exports = {
  loadPools,
  poolInfo,
  judgeUp,
  refresh,
  pickUp,
  ruleKind,
  POOL_FILE,
  TTL,
};
