'use strict';

/*
 * 鹰角通行证 → 森空岛凭据 → 终末地实时档案。
 *
 * 为什么单独一个模块：
 * 1. 鹰角 binding_list 的 level 是绑定时快照（实测一直停在 Lv.59，游戏里已经 60），
 *    要拿实时等级只能走森空岛的 /game/endfield/card/detail。
 * 2. 森空岛那套接口要 sign 头（hmac_sha256 + md5），跟鹰角通行证完全是两套协议，
 *    混在 arknights-gacha.js 里会让那个文件既管寻访又管签名，反而更难读。
 * 3. 同一个鹰角 ACCOUNT token 就能换森空岛凭据（grant 换 appCode + type:0），
 *    用户不需要再登录一次。
 */

const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

const GRANT_URL = 'https://as.hypergryph.com/user/oauth2/v2/grant';
const BASE = 'https://zonai.skland.com';
/* 森空岛自己的 appCode，跟鹰角官网那个（be36d44aa36bfb5b）不是同一个 */
const SKLAND_APP_CODE = '4ca99fa6b56cc2ba';
const UA = 'Skland/1.32.1 (com.hypergryph.skland; build:103201004; Android 33; ) Okhttp/4.11.0';
const TIMEOUT = 20000;
/* 凭据缓存时间：等级不会几分钟一变，半小时够用了 */
const CRED_TTL = 30 * 60 * 1000;

let credCache = { token: '', at: 0, cred: '', credToken: '', userId: '' };

function send(method, url, bodyText, headers) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const h = Object.assign({}, headers);
    if (bodyText) h['content-length'] = Buffer.byteLength(bodyText);
    const request = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: String(method || 'get').toUpperCase(),
        headers: h,
        timeout: TIMEOUT,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let buffer = Buffer.concat(chunks);
          /* 森空岛回 gzip，不解压就是一堆乱码 */
          if (String(response.headers['content-encoding'] || '').includes('gzip')) {
            try {
              buffer = zlib.gunzipSync(buffer);
            } catch {}
          }
          const text = buffer.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: response.statusCode, json, text });
        });
      },
    );
    request.on('error', (error) =>
      resolve({ status: 0, json: null, text: '', error: String(error.message) }),
    );
    request.on('timeout', () => {
      request.destroy();
      resolve({ status: 0, json: null, text: '', error: 'timeout' });
    });
    if (bodyText) request.write(bodyText);
    request.end();
  });
}

/*
 * 森空岛的签名头。
 *
 * 服务端 secret 拼法是：{path}{query}{timestamp}{紧凑 JSON 的签名头}，
 * POST 时 query 换成请求体。时间戳故意减 1 秒 —— 本地时钟比服务端快会被判成
 * 「未来请求」，官方客户端也是这么做的。
 */
function signedHeaders({ cred, token, url, method = 'get', bodyText = '' }) {
  const timestamp = Math.floor(Date.now() / 1000) - 1;
  const headerForSign = { platform: '', timestamp: String(timestamp), dId: '', vName: '' };
  const parsed = new URL(url);
  const query = method === 'post' ? bodyText : parsed.search.replace(/^\?/, '');
  const secret = parsed.pathname + query + timestamp + JSON.stringify(headerForSign);
  const hex = crypto.createHmac('sha256', String(token)).update(secret).digest('hex');
  const sign = crypto.createHash('md5').update(hex).digest('hex');
  return Object.assign({}, headerForSign, {
    cred,
    sign,
    'User-Agent': UA,
    'Accept-Encoding': 'gzip',
    Connection: 'close',
    ...(bodyText ? { 'Content-Type': 'application/json' } : {}),
  });
}

/** 鹰角 ACCOUNT token -> 森空岛 cred（带缓存）。 */
async function credOf(accountToken, force = false) {
  const token = String(accountToken || '').trim();
  if (!token) return { ok: false, reason: '没有账号 token' };
  if (!force && credCache.token === token && Date.now() - credCache.at < CRED_TTL && credCache.cred) {
    return { ok: true, cred: credCache.cred, token: credCache.credToken, userId: credCache.userId };
  }

  const grantBody = JSON.stringify({ token, appCode: SKLAND_APP_CODE, type: 0 });
  const grant = await send('POST', GRANT_URL, grantBody, {
    'user-agent': UA,
    'content-type': 'application/json',
    accept: 'application/json',
  });
  const grantCode = grant.json?.data?.code || grant.json?.data?.token;
  if (!grantCode) {
    return {
      ok: false,
      reason:
        '森空岛授权失败：' + (grant.json?.msg || grant.json?.message || grant.error || '未知原因'),
    };
  }

  const credBody = JSON.stringify({ code: grantCode, kind: 1 });
  const credRes = await send('POST', BASE + '/api/v1/user/auth/generate_cred_by_code', credBody, {
    'user-agent': UA,
    'content-type': 'application/json',
    accept: 'application/json',
  });
  const data = credRes.json?.data || {};
  if (!data.cred) {
    return {
      ok: false,
      reason: '换森空岛凭据失败：' + (credRes.json?.message || credRes.error || '未知原因'),
    };
  }

  credCache = {
    token,
    at: Date.now(),
    cred: String(data.cred),
    credToken: String(data.token || ''),
    userId: String(data.userId || ''),
  };
  return { ok: true, cred: credCache.cred, token: credCache.credToken, userId: credCache.userId };
}

/** 森空岛 GET（自动签名）。 */
async function sklandGet(pathAndQuery, credInfo) {
  const url = BASE + pathAndQuery;
  const headers = signedHeaders({
    cred: credInfo.cred,
    token: credInfo.token,
    url,
    method: 'get',
  });
  return send('GET', url, '', headers);
}

/*
 * 终末地角色档案。
 *
 * 返回里挑出界面要用的那几项：实时等级、世界等级、角色数、武器数、上次登录。
 * 拿不到就返回 null —— 调用方保留 binding_list 里的快照值，不要让整条链失败。
 */
async function endfieldCard(accountToken, { roleId, serverId = '1' }) {
  const id = String(roleId || '');
  if (!id) return null;
  const credInfo = await credOf(accountToken);
  if (!credInfo.ok) return null;
  const query =
    '?roleId=' + encodeURIComponent(id) + '&serverId=' + encodeURIComponent(String(serverId || '1'));
  const res = await sklandGet('/api/v1/game/endfield/card/detail' + query, credInfo);
  const base = res.json?.data?.detail?.base;
  if (!base) return null;
  return {
    level: Number(base.level) || 0,
    worldLevel: Number(base.worldLevel) || 0,
    exp: Number(base.exp) || 0,
    charNum: Number(base.charNum) || 0,
    weaponNum: Number(base.weaponNum) || 0,
    name: String(base.name || ''),
    avatarUrl: String(base.avatarUrl || ''),
    lastLoginTime: Number(base.lastLoginTime) || 0,
  };
}

/**
 * 给 binding_list 的每个终末地角色补上实时档案。
 *
 * 只补终末地：明日方舟那边的等级不在这套接口里，硬套反而会显示错。
 */
async function enrichBindings(accountToken, bindings) {
  const list = Array.isArray(bindings) ? bindings : [];
  const out = [];
  for (const binding of list) {
    const isEndfield = /终末地|endfield/i.test(
      String(binding.appName || '') + ' ' + String(binding.appCode || ''),
    );
    if (!isEndfield || !(binding.roles || []).length) {
      out.push(binding);
      continue;
    }
    const roles = [];
    for (const role of binding.roles) {
      const card = await endfieldCard(accountToken, {
        roleId: role.roleId,
        serverId: role.serverId,
      }).catch(() => null);
      if (!card) {
        roles.push(role);
        continue;
      }
      roles.push(
        Object.assign({}, role, {
          level: card.level || role.level,
          /* 这两个是快照里没有的，界面可以用它说明「实时」 */
          worldLevel: card.worldLevel,
          charNum: card.charNum,
          weaponNum: card.weaponNum,
          liveLevel: true,
          avatarUrl: card.avatarUrl || '',
        }),
      );
    }
    out.push(Object.assign({}, binding, { roles }));
  }
  return out;
}

module.exports = { credOf, endfieldCard, enrichBindings, signedHeaders, SKLAND_APP_CODE };
