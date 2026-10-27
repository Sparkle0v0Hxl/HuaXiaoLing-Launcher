'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { mergeGroups, saveImportGroups, readImportGroups, importsPath } = require('./gacha-import');

const LOG_PATHS = [
  ['hypergryph', 'AppData/LocalLow/Hypergryph/Endfield/sdklogs/HGWebview.log'],
  ['gryphline', 'AppData/LocalLow/Gryphline/Endfield/sdklogs/HGWebview.log'],
];

const CHAR_POOLS = [
  ['E_CharacterGachaPoolType_Special', '特许寻访'],
  ['E_CharacterGachaPoolType_Rerun', '重构寻访'],
  ['E_CharacterGachaPoolType_Joint', '辉光庆典'],
  ['E_CharacterGachaPoolType_Standard', '基础寻访'],
  ['E_CharacterGachaPoolType_Beginner', '启程寻访'],
];

/** 武器（申领）记录走 /api/record/weapon，池类型与角色不同。 */
const WEAPON_POOLS = [
  ['E_WeaponGachaPoolType_Special', '限定申领'],
  ['E_WeaponGachaPoolType_Standard', '常驻申领'],
  ['E_WeaponGachaPoolType_Rerun', '重构申领'],
];

/** 武器记录在界面里用 gacha_type 101+ 区分，不会和角色池混在一起。 */
const WEAPON_GACHA_TYPE_BASE = 100;

function readTokenFromLog() {
  for (const [provider, relative] of LOG_PATHS) {
    const file = path.join(os.homedir(), relative);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).reverse();
    for (const line of lines) {
      const match = line.match(/https:\/\/ef-webview\.(?:hypergryph|gryphline)\.com\/page\/gacha_[^\s]+/);
      if (!match) continue;
      try {
        const url = new URL(match[0]);
        const token = url.searchParams.get('u8_token');
        if (!token) continue;
        const serverId = url.searchParams.get('server') || url.searchParams.get('server_id') || '1';
        return { provider, token, serverId };
      } catch {
        /* next line */
      }
    }
  }
  return null;
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`终末地接口 HTTP ${response.status}`);
  const json = await response.json();
  if (json.code !== 0) throw new Error(json.msg || `终末地接口错误 ${json.code}`);
  return json;
}

async function queryUid(auth) {
  try {
    const response = await fetch(`https://u8.${auth.provider}.com/game/role/v1/query_role_list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify({ token: auth.token, serverId: auth.serverId }),
      signal: AbortSignal.timeout(20000),
    });
    const json = await response.json();
    if (json?.status === 0 && json.data?.uid) {
      return {
        uid: String(json.data.uid),
        roleId: String(json.data.roles?.[0]?.roleId || ''),
      };
    }
  } catch {
    /* fall through */
  }
  return { uid: `endfield-${auth.serverId}`, roleId: '' };
}

async function fetchPool(auth, type, poolName, index, mode = 'char') {
  const records = [];
  const isWeapon = mode === 'weapon';
  const endpoint = isWeapon ? 'weapon' : 'char';
  let seqId = '';
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({
      lang: 'zh-cn',
      token: auth.token,
      server_id: auth.serverId,
      pool_type: type,
    });
    if (seqId) query.set('seq_id', seqId);
    const json = await getJson(
      `https://ef-webview.${auth.provider}.com/api/record/${endpoint}?${query.toString()}`
    );
    const list = json.data?.list || [];
    if (!list.length) break;
    for (const item of list) {
      if (String(item.kind || '').startsWith('gift')) continue;
      records.push({
        Id: String(item.seqId || ''),
        // 角色用 charName/charId，武器用 weaponName/weaponId；名字为空时交给图鉴补
        Name: String((isWeapon ? item.weaponName : item.charName) || ''),
        Time: String(item.gachaTs || '').replace('T', ' ').replace(/Z$/, ''),
        ItemId: String((isWeapon ? item.weaponId : item.charId) || ''),
        ItemType: isWeapon ? 'weapon' : String(item.poolType || type),
        RankType: Number(item.rarity) || 0,
        GachaType: isWeapon ? WEAPON_GACHA_TYPE_BASE + index + 1 : index + 1,
        poolName,
      });
    }
    if (!json.data?.hasMore) break;
    seqId = String(list[list.length - 1]?.seqId || '');
    if (!seqId) break;
  }
  return records;
}

async function syncEndfieldGacha({ userData, auth: providedAuth }) {
  const auth = providedAuth && providedAuth.token ? providedAuth : readTokenFromLog();
  if (!auth) {
    throw new Error('没有找到终末地抽卡 Token。请先在游戏里打开一次抽卡记录页面，再同步。');
  }
  const { uid } = await queryUid(auth);
  const all = [];
  const poolErrors = [];
  for (let index = 0; index < CHAR_POOLS.length; index += 1) {
    const [type, poolName] = CHAR_POOLS[index];
    try {
      const records = await fetchPool(auth, type, poolName, index, 'char');
      all.push(...records);
    } catch (error) {
      poolErrors.push(`${poolName}: ${error.message}`);
    }
  }
  // 武器池单独拉；没有权限或没有记录时静默跳过，不影响角色同步
  for (let index = 0; index < WEAPON_POOLS.length; index += 1) {
    const [type, poolName] = WEAPON_POOLS[index];
    try {
      const records = await fetchPool(auth, type, poolName, index, 'weapon');
      all.push(...records);
    } catch (error) {
      poolErrors.push(`${poolName}: ${error.message}`);
    }
  }
  const rows = all
    .filter((row) => row.Id && row.Time)
    .map((row) => ({ Uid: uid, ...row }));
  if (!rows.length) {
    throw new Error(
      poolErrors.length ? `终末地抽卡同步失败：${poolErrors.join('；')}` : 'Token 可用，但最近没有可读取的终末地寻访记录'
    );
  }
  const groups = mergeGroups(readImportGroups(importsPath(userData)), [
    { game: 'endfield', uid, records: rows },
  ]);
  await saveImportGroups(importsPath(userData), groups);
  return { ok: true, game: 'endfield', uid, imported: rows.length };
}

module.exports = { syncEndfieldGacha, readTokenFromLog };
