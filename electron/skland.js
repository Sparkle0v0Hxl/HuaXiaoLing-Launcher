'use strict';

/**
 * 森空岛（鹰角自家社区 App）接口客户端 —— 终末地 / 明日方舟的官方数据源。
 *
 * 为什么需要这一层
 * ----------------
 * 米哈游有公开的 game_record 接口，所以原神 / 星铁 / 绝区零 / 崩坏3 能直接读
 * 便笺和深渊。鹰角没有对外的战绩站，唯一稳定的官方数据出口是森空岛：
 * 玩家在 App / 网页里能看到的「便笺、理智、干员、帝江号、地区建设、战争回响」，
 * 底层都是 zonai.skland.com 这一套接口。
 *
 * 鉴权链路（与第三方开源实现一致，实现在这里是为了不引依赖）
 * ---------------------------------------------------------
 *   1. 用户登录鹰角通行证，得到一个账号级 token（网页 cookie 里的 u8_token/HG_TOKEN）
 *   2. POST as.hypergryph.com/user/oauth2/v2/grant  { appCode: 森空岛, token }  → code
 *   3. POST zonai.skland.com/api/v1/user/auth/generate_cred_by_code { code }    → { cred, token, userId }
 *   4. 之后每个请求带 cred 头，并对 path + query + timestamp + 头 JSON 做
 *        sign = md5(hex(hmac_sha256(token, secret)))
 *      —— 算法是服务端定的，这里逐行照抄，不要"优化"成别的顺序。
 *
 * 注意：cred 和 token 都是账号凭据，只走 safeStorage 加密存储，绝不落到明文配置里。
 */

const crypto = require('node:crypto');

const UA =
  'Skland/1.32.1 (com.hypergryph.skland; build:103201004; Android 33; ) Okhttp/4.11.0';

/** 森空岛 App 的 appCode（用于把账号 token 换成森空岛 code）。 */
const SKLAND_APP_CODE = '4ca99fa6b56cc2ba';
/** 官网通行证的 appCode，换网页 token 时用。 */
const WEB_APP_CODE = 'be36d44aa36bfb5b';

const SKLAND_BASE = 'https://zonai.skland.com';
const GRANT_URL = 'https://as.hypergryph.com/user/oauth2/v2/grant';

/** 终末地在绑定列表里的 appCode；不同版本用过 endfield / exastris 两种写法。 */
const ENDFIELD_APP_CODES = ['endfield', 'exastris'];

class SklandError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'SklandError';
    this.code = code;
    /**
     * 业务错误码（响应体里的 code）。
     *
     * 光有 HTTP 状态码不够用：同样是 403，带 `code:10001` 的是「这个请求参数
     * 对应不到数据」（比如角色 ID 不对），带 `code:10000` 的才是「你不像登录了」。
     * 上层要据此决定「重换凭据」还是「别白试了」，所以两个都留着。
     */
    this.bizCode = null;
    this.bizMessage = '';
  }
}

/* ------------------------------------------------------------------ */
/* 签名                                                                */
/* ------------------------------------------------------------------ */

/**
 * 生成带 sign 的请求头。
 *
 * 服务端的 secret 拼法是：`{path}{query}{timestamp}{紧凑 JSON 的签名头}`，
 * 其中 POST 的 query 用请求体 JSON 代替（GET 用真实 query string）。
 * 时间戳故意减 1 秒 —— 客户端时钟比服务端快时会被判成"未来请求"，
 * 官方客户端也是这么做的。
 */
function signHeaders({ cred, token, url, method = 'get', bodyText = '', extra = {} }) {
  const timestamp = Math.floor(Date.now() / 1000) - 1;
  const headerForSign = { platform: '', timestamp: String(timestamp), dId: '', vName: '' };
  const parsed = new URL(url);
  const query = method === 'post' ? bodyText : parsed.search.replace(/^\?/, '');
  const headerCaStr = JSON.stringify(headerForSign);
  const secret = `${parsed.pathname}${query}${timestamp}${headerCaStr}`;
  const hex = crypto.createHmac('sha256', String(token)).update(secret).digest('hex');
  const sign = crypto.createHash('md5').update(hex).digest('hex');
  return {
    ...headerForSign,
    cred,
    sign,
    'User-Agent': UA,
    'Accept-Encoding': 'gzip',
    Connection: 'close',
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* 基础请求                                                            */
/* ------------------------------------------------------------------ */

function codeOf(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  if (typeof payload.code === 'number') return payload.code;
  if (typeof payload.status === 'number') return payload.status;
  return 0;
}

function messageOf(payload) {
  return String(payload?.message || payload?.msg || payload?.messgae || '');
}

/**
 * 发一个森空岛/鹰角请求。
 *
 * `signed: false` 用于 grant 这类纯 passport 接口 —— 它们不带 cred、也不需要 sign。
 */
async function requestJson(url, options = {}) {
  const method = String(options.method || 'get').toLowerCase();
  const bodyText = options.body === undefined ? '' : JSON.stringify(options.body);
  const headers = options.signed === false
    ? { 'User-Agent': UA, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) }
    : signHeaders({
        cred: options.cred,
        token: options.token,
        url,
        method,
        bodyText,
        extra: {
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.extra || {}),
        },
      });

  let response;
  try {
    response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: options.body === undefined ? undefined : bodyText,
      signal: AbortSignal.timeout(options.timeout || 20000),
    });
  } catch (error) {
    throw new SklandError(`连不上森空岛（${String(error?.message || error)}）`);
  }

  if (!response.ok) {
    /*
     * 只报一个「HTTP 403」等于没说：森空岛有十几个接口，
     * 不知道是哪个被拒就无从下手。这里把路径和响应体开头一起带上。
     * 响应体通常是网关页或一句 JSON，截断到 120 字符足够定位。
     *
     * 顺便把响应体里的业务码捞出来：403 不都是「没登录」，
     * 10001 是「参数/目标不存在」，两者要做的事完全不同。
     */
    const raw = await response.text().catch(() => '');
    let bizCode = null;
    let bizMessage = '';
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.code === 'number') {
        bizCode = parsed.code;
        bizMessage = String(parsed.message || parsed.msg || '');
      }
    } catch {
      /* 不是 JSON（网关页），保持 bizCode 为空 */
    }
    const snippet = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const where = new URL(url).pathname;
    const error = new SklandError(
      `森空岛接口 HTTP ${response.status}（${where}）${snippet ? ` ${snippet}` : ''}`,
      response.status
    );
    error.bizCode = bizCode;
    error.bizMessage = bizMessage;
    throw error;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new SklandError('森空岛返回的不是 JSON，可能被网络中间层拦了');
  }

  const code = codeOf(payload);
  if (code !== 0) {
    const message = messageOf(payload) || `森空岛错误码 ${code}`;
    const error = new SklandError(message, code);
    error.bizCode = code;
    error.bizMessage = message;
    throw error;
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* 鉴权                                                                */
/* ------------------------------------------------------------------ */

/**
 * 账号 token → 森空岛 code。
 * 有些版本要求 type=0（森空岛），有些只认 type=1（官网）；两种都试。
 */
async function grantCodeByToken(token) {
  const result = await requestJson(GRANT_URL, {
    method: 'post',
    signed: false,
    body: { appCode: SKLAND_APP_CODE, token: String(token), type: 0 },
  });
  const code = result?.data?.code;
  if (!code) throw new SklandError('鹰角没有返回森空岛授权码，登录态可能已失效');
  return String(code);
}

/** code → { cred, token, userId }。cred 是后续请求的身份，token 参与签名。 */
async function credByCode(code) {
  const result = await requestJson(`${SKLAND_BASE}/api/v1/user/auth/generate_cred_by_code`, {
    method: 'post',
    signed: false,
    body: { code: String(code), kind: 1 },
  });
  const data = result?.data || {};
  if (!data.cred || !data.token) throw new SklandError('森空岛没有返回凭据');
  return {
    cred: String(data.cred),
    token: String(data.token),
    userId: String(data.userId || ''),
  };
}

/** 用已保存的账号 token 走完整条链路，拿到可用凭据。 */
async function loginByToken(accountToken) {
  const code = await grantCodeByToken(accountToken);
  const cred = await credByCode(code);
  if (!cred.userId) {
    try {
      cred.userId = await fetchUserId(cred.cred, cred.token);
    } catch {
      /* userId 缺了也能读便笺，只是 team 相关接口用不了 */
    }
  }
  return cred;
}

/** cred 有时效，过期前可以用它换一个新的签名 token。 */
async function refreshToken(cred) {
  const payload = await requestJson(`${SKLAND_BASE}/api/v1/auth/refresh`, {
    cred,
    token: '',
    method: 'get',
  });
  const token = payload?.data?.token;
  if (!token) throw new SklandError('刷新森空岛凭据失败');
  return String(token);
}

/** 森空岛账号 ID（不是游戏 UID），card/detail 需要它。 */
async function fetchUserId(cred, token) {
  const payload = await requestJson(`${SKLAND_BASE}/api/v1/user/teenager`, { cred, token, method: 'get' });
  const userId = payload?.data?.teenager?.userId;
  if (!userId) throw new SklandError('读不到森空岛账号 ID');
  return String(userId);
}

/**
 * 绑定的游戏角色。
 *
 * 返回扁平结构，终末地的 roleId / serverId 直接取出来就能用：
 *   [{ appCode, appName, uid, roleId, serverId, nickname, serverName, level }]
 *
 * 两处坑，都是实测出来的（2026-11-03）：
 *
 * 1. **终末地的角色藏在 `bindingList[].roles[]` 里。** 绑定项本身是一条「区服」记录，
 *    它的 `uid` 是森空岛的绑定编号（例如 940752205），**不是**游戏角色 ID。
 *    把 bindingList 的 uid 当 roleId 去请求 card/detail，服务端会回
 *    `403 {"code":10001,"message":"操作失败，请稍后重试"}` —— 看起来像"账号没权限"，
 *    实际只是查了一个不存在的角色。真正的 roleId 在 roles[].roleId（与 defaultRole 一致），
 *    用它请求立刻 200。以前这里写的是 `item.roleId || item.uid`，终末地永远走到 uid 上，
 *    所以便笺/战争回响/签到全挂。
 *
 * 2. 明日方舟那边仍是扁平结构（bindingList[].uid 就是角色 uid），所以保留回退分支。
 */
async function fetchBindings(cred, token) {
  const payload = await requestJson(`${SKLAND_BASE}/api/v1/game/player/binding`, {
    cred,
    token,
    method: 'get',
  });
  const list = Array.isArray(payload?.data?.list) ? payload.data.list : [];
  const roles = [];
  for (const app of list) {
    const appCode = String(app?.appCode || '').toLowerCase();
    const appName = String(app?.appName || '');
    const bindings = Array.isArray(app?.bindingList) ? app.bindingList : [];
    for (const item of bindings) {
      if (!item || item.isDelete) continue;
      const serverName = String(item.channelName || item.serverName || '');
      const nested = Array.isArray(item.roles)
        ? item.roles.filter((role) => role && role.roleId && !role.isDelete)
        : [];
      if (nested.length) {
        for (const role of nested) {
          roles.push({
            appCode,
            appName,
            // 保留绑定编号，方便界面上区分「同一个区服下的多个角色」
            uid: String(item.uid || role.roleId),
            roleId: String(role.roleId),
            serverId: String(role.serverId || item.channelMasterId || '1'),
            nickname: String(role.nickname || item.nickName || ''),
            serverName: serverName || String(role.serverName || ''),
            level: Number(role.level) || 0,
            isDefault: Boolean(role.isDefault || item.isDefault),
          });
        }
        continue;
      }
      const roleId = String(item.roleId || item.uid || '');
      if (!roleId) continue;
      roles.push({
        appCode,
        appName,
        uid: String(item.uid || roleId),
        roleId,
        serverId: String(item.channelMasterId || item.serverId || item.server_id || '1'),
        nickname: String(item.nickName || item.nickname || ''),
        serverName,
        level: Number(item.level) || 0,
        isDefault: Boolean(item.isDefault),
      });
    }
  }
  return roles;
}

/**
 * 从绑定列表里挑终末地角色。
 *
 * appCode 是服务端给的十六进制串（不是 "endfield" 这种可读名 —— 实测 grant 接口会把
 * 非 hex 的 appCode 直接判为非法，所以拿不到真值前只能列候选），因此真正的判据是
 * appName：中文版叫「明日方舟：终末地」，国际版是 "Arknights: Endfield"，
 * 两种都得认，否则账号里只有国际服角色时会一个都筛不出来。
 */
function endfieldRolesOf(roles) {
  return (Array.isArray(roles) ? roles : []).filter((role) => {
    if (ENDFIELD_APP_CODES.includes(role.appCode)) return true;
    return /终末地|endfield/i.test(role.appName || '');
  });
}

/* ------------------------------------------------------------------ */
/* 终末地业务接口                                                      */
/* ------------------------------------------------------------------ */

/**
 * 终末地这几个接口同时存在 web 网关（/web/v1）和 App 网关（/api/v1）两份。
 *
 * 两边返回的数据一样，但鉴权严格程度不同：实测有账号在 /web/v1 上被直接
 * 打 HTTP 401（响应体是 {"code":10000,"message":"请求异常"}），同一条请求
 * 换 /api/v1 就通。反过来也遇到过（签到只有 web 有）。
 *
 * 所以这里不写死一个前缀，按顺序试；只有 401/403/404 这类「这条路径不认你」
 * 的情况才换下一个，业务码（10000/10002 等）原样抛出 —— 那说明是凭据问题，
 * 换路径没意义，交给上层的重换凭据逻辑。
 */
async function requestWithPrefixFallback(pathSuffix, options = {}) {
  const prefixes = Array.isArray(options.prefixes) && options.prefixes.length
    ? options.prefixes
    : ['/web/v1', '/api/v1'];
  let lastError = null;
  for (const prefix of prefixes) {
    const url = `${SKLAND_BASE}${prefix}${pathSuffix}`;
    try {
      return await requestJson(url, { cred: options.cred, token: options.token, method: options.method || 'get' });
    } catch (error) {
      lastError = error;
      const status = Number(error?.code);
      if (status !== 401 && status !== 403 && status !== 404) throw error;
    }
  }
  throw lastError || new SklandError('森空岛没有响应');
}

/** 便笺：等级、理智、每日/每周任务、干员、据点、帝江号、成就。 */
async function endfieldCard(cred, token, { userId, roleId, serverId }) {
  const query =
    `?roleId=${encodeURIComponent(roleId)}&serverId=${encodeURIComponent(serverId)}` +
    `&userId=${encodeURIComponent(userId)}`;
  const payload = await requestWithPrefixFallback(`/game/endfield/card/detail${query}`, { cred, token });
  return payload?.data?.detail || null;
}

/** 战争回响（终末地的周期挑战，相当于米家的深渊）。 */
async function endfieldWarEchoes(cred, token, { userId, roleId, serverId, seasonId }) {
  const query = [
    `roleId=${encodeURIComponent(roleId)}`,
    `serverId=${encodeURIComponent(serverId)}`,
    `userId=${encodeURIComponent(userId)}`,
  ];
  if (seasonId !== undefined && seasonId !== null && seasonId !== '') {
    query.push(`seasonId=${encodeURIComponent(seasonId)}`);
  }
  const payload = await requestWithPrefixFallback(`/game/endfield/card/war-echoes?${query.join('&')}`, {
    cred,
    token,
    prefixes: ['/api/v1', '/web/v1'],
  });
  return payload?.data?.warEchoes || null;
}

/**
 * 每日签到。
 *
 * 这个接口不在 /api/v1 下（是 web 版），并且靠 `sk-game-role: 3_{roleId}_{serverId}`
 * 说明"给哪个角色签"，参数不在 body 里 —— 少一个头就会签错号。
 */
async function endfieldAttendance(cred, token, { roleId, serverId }) {
  const url = `${SKLAND_BASE}/web/v1/game/endfield/attendance`;
  const payload = await requestJson(url, {
    cred,
    token,
    method: 'post',
    /*
     * 签到没有请求体，但服务端仍按 application/json 处理这个端点；
     * 少了这个头会被判成参数错误（而错误文案只会说"请求失败"，很难查）。
     */
    extra: { 'Content-Type': 'application/json', 'sk-game-role': `3_${roleId}_${serverId}` },
  });
  return payload?.data || null;
}

module.exports = {
  SklandError,
  UA,
  SKLAND_APP_CODE,
  WEB_APP_CODE,
  signHeaders,
  codeOf,
  grantCodeByToken,
  credByCode,
  loginByToken,
  refreshToken,
  fetchUserId,
  fetchBindings,
  endfieldRolesOf,
  endfieldCard,
  endfieldWarEchoes,
  endfieldAttendance,
};
