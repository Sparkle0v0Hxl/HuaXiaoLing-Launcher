'use strict';

/*
 * 鸣潮抽卡记录同步（库洛）。
 *
 * 数据源与流程（接口研究见工作区 _wuwa-gacha-api.md，2026-11-12）：
 *   1. 游戏内「抽卡记录 → 分享」会把一条带签名的记录页链接写进
 *      Client\Saved\Logs\Client*.log（ELog XOR 加密）。
 *   2. 解密日志、提取链接、解析 query（player_id/resources_id/svr_id/lang/record_id）。
 *   3. 对 11 个卡池各 POST 一次 /gacha/record/query（纯 body 鉴权，无翻页，空数组即无记录）。
 *   4. 合成记录 ID（鸣潮没有官方记录 ID），复用 gacha-import 入库模型。
 *
 * 铁律：只读自家客户端日志 + 调官方分享链接同源接口，无抓包、无逆向二进制；
 *       与 Haiyu（原 WutheringWavesTool）同等性质。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { mergeGroups, saveImportGroups, readImportGroups, importsPath } = require('./gacha-import');

const QUERY_API = 'https://gmserver-api.aki-game2.com/gacha/record/query';
// 国际服网关域名不同（-oversea.aki-game.net 的记录页 → aki-gm-resources-oversea）。
const QUERY_API_OVERSEA = 'https://gmserver-api-oversea.aki-game.net/gacha/record/query';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 卡池 1..11（1角色活动/2武器活动/3角色常驻/4武器常驻/5新手/6新手自选/7感恩定向/8角色新旅/9武器新旅/10角色联动/11武器联动）
const POOL_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const POOL_NAMES = {
  1: '角色活动',
  2: '武器活动',
  3: '角色常驻',
  4: '武器常驻',
  5: '新手唤取',
  6: '新手自选',
  7: '感恩定向唤取',
  8: '角色新旅',
  9: '武器新旅',
  10: '角色联动唤取',
  11: '武器联动唤取',
};

// ELog XOR key（明文侧：偶字节 0xA5 / 奇字节 0xEF）。游戏大版本更新可能换 key，
// 解密校验失败（解出来不是合法 UTF-8）时提示用户反馈，不要硬编码死第二个值。
const ELOG_KEY_EVEN = 0xa5;
const ELOG_KEY_ODD = 0xef;

// 分享链接正则：国服 .com、国际服 .net 两种域名都收（Haiyu 同款写法）
const LINK_RE =
  /https:\/\/aki-gm-resources(?:-oversea)?\.aki-game\.(?:net|com)\/aki\/gacha\/index\.html#\/record[^\s"']*/g;

const REQUEST_GAP = 400; // 每池之间 400ms，11 池共 ~4.4s，别打太快

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── 日志定位与解密 ─────────────────────────────────────────── */

function logsDir(installRoot) {
  return path.join(installRoot, 'Client', 'Saved', 'Logs');
}

function isEncrypted(buffer) {
  // 官方日志非 BOM 开头即加密（明文日志以 EF BB BF 开头）
  return !(buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf);
}

function decryptElog(buffer) {
  const out = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) {
    // 按密文字节奇偶反查：XOR 翻转奇偶，明文偶字节用 0xA5 加密 → 密文奇偶看明文
    out[i] = buffer[i] ^ ((buffer[i] & 1) === 0 ? ELOG_KEY_ODD : ELOG_KEY_EVEN);
  }
  return out;
}

/**
 * 解密 logs 目录下全部 Client*.log，拼接成一个大文本。
 * 解密结果不是合法 UTF-8 的话说明 key 换了，抛出可读错误。
 */
async function readLogsText(installRoot) {
  const dir = logsDir(installRoot);
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    throw new Error('没有找到鸣潮客户端日志目录（先在游戏里打开一次「抽卡记录」页面）');
  }
  const logs = entries.filter((name) => /^Client.*\.log$/i.test(name)).sort();
  if (!logs.length) throw new Error('鸣潮日志目录里没有 Client 日志文件');
  const parts = [];
  for (const name of logs) {
    const raw = await fsp.readFile(path.join(dir, name));
    let text;
    if (isEncrypted(raw)) {
      const plain = decryptElog(raw);
      // 解密失败（key 变了）会让 UTF-8 序列碎掉
      text = plain.toString('utf8');
      if (text.includes('\uFFFD')) {
        text = plain.toString('latin1');
      }
    } else {
      text = raw.toString('utf8');
    }
    parts.push(text);
  }
  return parts.join('\n');
}

/* ── 链接提取与解析 ─────────────────────────────────────────── */

function extractRecordLinks(text) {
  const found = [];
  for (const match of String(text || '').matchAll(LINK_RE)) {
    found.push(match[0]);
  }
  return found;
}

function parseLinkParams(url) {
  const hashIndex = url.indexOf('#');
  if (hashIndex < 0) return null;
  const query = url.slice(hashIndex + 1).replace(/^\/record\??/, '');
  const params = new URLSearchParams(query);
  const playerId = params.get('player_id');
  const cardPoolId = params.get('resources_id');
  const serverId = params.get('svr_id');
  const recordId = params.get('record_id');
  const languageCode = params.get('lang') || 'zh-Hans';
  if (!playerId || !cardPoolId || !serverId || !recordId) return null;
  return {
    playerId,
    cardPoolId,
    serverId,
    languageCode,
    recordId,
    oversea: url.includes('-oversea.aki-game.net'),
  };
}

/* ── 接口 ───────────────────────────────────────────────────── */

function queryPool(baseUrl, params, poolType) {
  const body = JSON.stringify({
    playerId: params.playerId,
    cardPoolId: params.cardPoolId,
    cardPoolType: poolType,
    serverId: params.serverId,
    languageCode: params.languageCode,
    recordId: params.recordId,
  });
  return new Promise((resolve, reject) => {
    const target = new URL(baseUrl);
    const request = https.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': UA,
        },
        timeout: 15000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const json = JSON.parse(text);
            resolve(json);
          } catch (error) {
            reject(new Error(`抽卡接口返回的不是合法 JSON（HTTP ${response.statusCode}）`));
          }
        });
      }
    );
    request.on('timeout', () => {
      request.destroy(new Error('抽卡接口请求超时'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

/* ── 记录 ID 合成 ───────────────────────────────────────────── */

/*
 * 鸣潮没有官方记录 ID。同一秒可能有多条同池同物品（十连撞整秒边界），
 * 所以合成键 = 时间戳数字 + 池类型 + 物品 ID + 「同一秒内序号」。
 * 序号在同一轮同步内自洽即可：入库去重靠 known 集合，同一条记录
 * 两次同步会算出同样的序号（因为每次都按全量重算）。
 */
function composeRecordId(item, seq) {
  const timeDigits = String(item.time || '').replace(/\D/g, '');
  return `${timeDigits}-${item.cardPoolType}-${item.resourceId}-${seq}`;
}

/* ── 主入口 ─────────────────────────────────────────────────── */

async function syncWuwaGacha({ installRoot, userData, onProgress, manualLink }) {
  const text = await readLogsText(installRoot);
  let links = extractRecordLinks(text);
  if (manualLink && /^https:/i.test(String(manualLink))) {
    links = [String(manualLink).trim(), ...links];
  }
  if (!links.length) {
    const error = new Error(
      '没有在日志里找到抽卡分享链接。请先打开鸣潮 → 抽卡记录 → 点右上角「分享」→ 选「复制链接」，然后回启动器点同步（也可以直接粘贴链接）。'
    );
    error.needShare = true;
    throw error;
  }
  // 取最新一条能解析的链接（日志里可能积累多条，最新的参数最可信）
  let params = null;
  for (let i = links.length - 1; i >= 0; i -= 1) {
    params = parseLinkParams(links[i]);
    if (params) break;
  }
  if (!params) throw new Error('抽卡分享链接解析失败（链接不完整），请重新在游戏里分享一次');
  const base = params.oversea ? QUERY_API_OVERSEA : QUERY_API;

  const records = [];
  const perPool = [];
  let requestCount = 0;
  for (const poolType of POOL_TYPES) {
    await sleep(REQUEST_GAP);
    let json;
    try {
      json = await queryPool(base, params, poolType);
    } catch (error) {
      throw new Error(`抽卡接口请求失败（${POOL_NAMES[poolType]}）：${error.message}`);
    }
    requestCount += 1;
    if (!json || typeof json !== 'object' || json.code !== 0) {
      // 接口对无效参数也不报错（回 code 0 空数组），真报错就是服务端问题
      throw new Error(
        `抽卡接口返回异常（${POOL_NAMES[poolType]}）：${(json && json.message) || '未知错误'}`
      );
    }
    const list = Array.isArray(json.data) ? json.data : [];
    // 同秒序号兜底：先按出现顺序计数
    const seqBySecond = new Map();
    for (const item of list) {
      const second = String(item.time || '');
      const seq = (seqBySecond.get(second) || 0) + 1;
      seqBySecond.set(second, seq);
      records.push({
        Uid: String(params.playerId),
        Id: composeRecordId(item, seq),
        Name: String(item.name || ''),
        Time: String(item.time || ''),
        ItemId: String(item.resourceId ?? ''),
        ItemType: String(item.resourceType || ''),
        RankType: Number(item.qualityLevel) || 0,
        GachaType: poolType,
      });
    }
    perPool.push({ type: poolType, name: POOL_NAMES[poolType], count: list.length });
    onProgress?.({
      pool: poolType,
      poolName: POOL_NAMES[poolType],
      count: list.length,
      total: records.length,
      requests: requestCount,
    });
  }

  const uid = String(params.playerId);
  if (!records.length) {
    // 11 池全空：链接过期 / 没抽过卡，两者不可区分（接口对无效参数也回空数组）
    return {
      ok: true,
      game: 'wutheringwaves',
      uid,
      imported: 0,
      total: 0,
      requests: requestCount,
      pools: perPool,
      warning: '11 个卡池都是空的：可能是分享链接已过期，也可能是这个账号还没有唤取记录。请重新在游戏里分享一次再试。',
    };
  }

  records.sort((a, b) => (a.Time < b.Time ? -1 : a.Time > b.Time ? 1 : 0));
  const file = importsPath(userData);
  const groups = mergeGroups(readImportGroups(file), [{ game: 'wutheringwaves', uid, records }]);
  await saveImportGroups(file, groups);
  return {
    ok: true,
    game: 'wutheringwaves',
    uid,
    imported: records.length,
    total: groups.find((group) => group.game === 'wutheringwaves' && group.uid === uid)?.records.length || 0,
    requests: requestCount,
    pools: perPool,
  };
}

module.exports = { syncWuwaGacha, extractRecordLinks, parseLinkParams, POOL_TYPES, POOL_NAMES };
