'use strict';

/**
 * SToken 登录（米游社 / HoYoLAB）
 * ================================
 *
 * 为什么需要它
 * ------------
 * 现在的抽卡同步（gacha-sync.js）走的是「扫游戏自己的网页缓存，抠出那条
 * getGachaLog 链接」的老办法。这条路有三个硬伤：
 *
 *   1. 那条链接里的 authkey 大约 24 小时就废，用户必须每次都在游戏里
 *      重新打开一次抽卡记录页，否则下次同步直接报「抽卡链接已过期」。
 *   2. 不认国际服（HoYoLAB 那套）。
 *   3. 链接里没有任何账号身份，一旦换了号，扫到的是别人/旧号的缓存。
 *
 * SToken 是米游社「长期登录」用的凭据，由 stoken（本体）和 mid 两部分组成。
 * 它不随时间过期，登录一次可以吃很久。拿 SToken 去换成 LTuid + LToken
 * （v2 条目是 ltuid_v2 / ltoken_v2），再用这一对实时申请新的 authkey，
 * 就能把「必须开一次游戏」这个前提彻底去掉。
 *
 * 换算分两步，缺一不可
 * --------------------
 *   第一步 SToken → ltoken：POST passport-api/account/auth/api/getLTokenBySToken
 *           body 里带 stoken 与 mid；返回里拿到 ltoken / ltuid（v2 是 ltoken_v2 / ltuid_v2）。
 *           这一步用的是 stoken**本体**。
 *   第二步 ltoken → authkey：POST 抽卡接口的 getAuthkeyBySToken
 *           body 里带 authkey_ver / sign_type / uid / game_biz / game_uid 以及
 *           **拼接后的完整 SToken 串**（stoken=xxx;mid=yyy）。接口名带 SToken，
 *           但它要的其实是上一步换出来的 ltoken，详见 authkeyBody() 上面的注释。
 *
 * 为什么要拆成两个文件
 * --------------------
 * 网络交互全在这里（可替换），数据结构与格式化全在 stoken-store.js（可单测）。
 *
 * 所有请求都带 DS2 以外的额外签名（sign），算法见 createStokenSign()。
 * 这个签名和战绩接口用的 DS2 不是一回事：SToken 这组接口验的是
 * md5(`salt=${salt}&t=${t}&r=${r}`)，不掺 query。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const miyoushe = require('./miyoushe-login');

/**
 * 两套服务器的差异全部收在这两张表里。
 *
 * host 是 passport 域名；salt 是这两步接口各自的签名盐值。
 * 国服与国际服不通用 —— 拿国服的盐去签国际服的请求只会得到 -100。
 */
const REGIONS = {
  cn: {
    id: 'cn',
    label: '国服',
    // 第一步 SToken -> ltoken。实测只接受 GET，参数走 query，凭据走 Cookie。
    ltoken: {
      host: 'https://passport-api.mihoyo.com',
      path: '/account/auth/api/getLTokenBySToken',
      method: 'GET',
      salt: 'JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS',
    },
    // 第二步 ltoken -> authkey。整条 authkey 由它现签。
    authkey: {
      host: 'https://api-takumi.mihoyo.com',
      path: '/binding/api/genAuthKey',
      // 胡桃重制版 SaltConstants.CNLK2 —— genAuthKey 就是用它签的
      salt: 'sidQFEglajEz7FA0Aj7HQPV88zpf17SO',
    },
    api: {
      genshin: {
        name: '原神',
        gameBiz: 'hk4e_cn',
        region: 'cn_gf01',
        host: 'https://public-operation-hk4e.mihoyo.com',
        path: '/gacha_info/api/getGachaLog',
      },
      starrail: {
        name: '崩坏：星穹铁道',
        gameBiz: 'hkrpg_cn',
        region: 'prod_gf_cn',
        host: 'https://public-operation-hkrpg.mihoyo.com',
        path: '/common/gacha_record/api/getGachaLog',
      },
      zzz: {
        name: '绝区零',
        gameBiz: 'nap_cn',
        region: 'prod_gf_cn',
        host: 'https://public-operation-nap.mihoyo.com',
        path: '/common/gacha_record/api/getGachaLog',
      },
    },
  },
  os: {
    id: 'os',
    label: '国际服',
    // 国际服这一条实测要 POST（GET 直接 405）。
    ltoken: {
      host: 'https://sg-public-api.hoyoverse.com',
      path: '/account/auth/api/getLTokenBySToken',
      method: 'POST',
      salt: 'TS8p9N4bY0cLQKzLZ7nOgF6RwV0FhQxO',
    },
    authkey: {
      host: 'https://api-account-os.hoyoverse.com',
      path: '/binding/api/genAuthKey',
      // 国际服对应胡桃的 OSLK2
      salt: 'rk4xg2hakoi26nljpr099fv9fck1ah10',
    },
    api: {
      genshin: {
        name: '原神',
        gameBiz: 'hk4e_global',
        region: 'os_usa',
        host: 'https://public-operation-hk4e-sg.hoyoverse.com',
        path: '/gacha_info/api/getGachaLog',
      },
      starrail: {
        name: '崩坏：星穹铁道',
        gameBiz: 'hkrpg_global',
        region: 'prod_official_usa',
        host: 'https://public-operation-hkrpg-sg.hoyoverse.com',
        path: '/common/gacha_record/api/getGachaLog',
      },
      zzz: {
        name: '绝区零',
        gameBiz: 'nap_global',
        region: 'prod_official_usa',
        host: 'https://public-operation-nap-sg.hoyoverse.com',
        path: '/common/gacha_record/api/getGachaLog',
      },
    },
  },
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/*
 * 米游社 App 的 UA。
 *
 * 拉角色 / 战绩这类接口认这个，换成桌面浏览器 UA 会被风控挡（retcode 5003）。
 * miyoushe-login 里那份 RECORD_UA 是同一路子，这边自己写一份免得又依赖它。
 */
const APP_UA_BBS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/2.95.1';

/** SToken 这组接口的 x-rpc-app_version，和战绩接口用的版本不一样。 */
const APP_VERSION = '2.11.1';

/* ------------------------------------------------------------------ */
/* 凭据解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从用户贴进来的东西里抠出 stoken 与 mid。
 *
 * 用户手上可能是三种形态，都要认：
 *   1. 整串 cookie —— `ltuid=1;stoken=xxx;mid=yyy;...`（最常见，直接从浏览器复制）
 *   2. 单独的 SToken 值 —— `stoken v2 那个以 v2 开头的一长串`
 *   3. 已经拼好的授权串 —— `stoken=xxx;mid=yyy`
 *
 * stoken 的形态：老的是 `xxxxx`，新的是 `v2_xxxxx`。两段之间用 `;` 或 `\n`
 * 分隔的情况都有，mid 也可能写成 `mid_v2`。
 */
function parseStokenInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: '还没有填写 SToken' };

  let stoken = '';
  let mid = '';
  /* stuid 就是米游社 aid，genAuthKey 的 cookie 需要它，账号 id 也用它 */
  let stuid = '';

  // 形态 1 / 3：带 key=value
  if (/stoken\s*[=:]/i.test(text)) {
    for (const part of text.split(/[;\n\r]+/)) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      const key = part.slice(0, index).trim().toLowerCase();
      const value = part.slice(index + 1).trim();
      if (!value) continue;
      if (key === 'stoken' || key === 'stoken_v2') stoken = value;
      if (key === 'mid' || key === 'account_mid' || key === 'account_mid_v2') mid = value;
      if (key === 'stuid') stuid = value;
    }
  }

  // 形态 2：只贴了值。这时第一段是 stoken，第二段（如果有）是 mid
  if (!stoken) {
    const parts = text.split(/[;\s\n\r]+/).filter(Boolean);
    const looksLikeStoken = (value) => /^v2_/.test(value) || /^[A-Za-z0-9]{20,}$/.test(value);
    const first = parts.find(looksLikeStoken);
    if (first) {
      stoken = first;
      const after = parts.slice(parts.indexOf(first) + 1).find((value) => /^[A-Za-z0-9]{6,}$/.test(value));
      if (after) mid = after;
    }
  }

  if (!stoken) return { ok: false, error: '没认出 SToken。整串 cookie 或 SToken 本身都行' };
  if (!mid) return { ok: false, error: '缺少 mid（账号 ID）。把整串 cookie 粘进来就自动带上了' };
  return { ok: true, stoken, mid, stuid, combined: `stoken=${stoken};mid=${mid}` };
}

/* ------------------------------------------------------------------ */
/* 签名                                                                */
/* ------------------------------------------------------------------ */

/**
 * SToken 这组接口的 sign：md5(`salt=${salt}&t=${t}&r=${r}`)。
 *
 * 注意和 DS2 的区别 —— DS2 要把 query 排好序拼进 `q`，这里不要。
 * 以前把两个搞混过，表现是接口一律返回 -100「登录失效」，
 * 看着像 stoken 输了，其实是签名算错。
 */
/**
 * 米哈游的 DS 签名。
 *
 * 两种形态，别混：
 *   网页端 / 游戏接口：md5(`salt=${salt}&t=${t}&r=${r}`)
 *   passport 接口    ：md5(`salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`)
 * 后者少了 b / q 一段，服务器直接当签名非法（就是之前 createQRLogin 一直
 * -3005 参数不合法的原因之一）。body、query 不传时退化成前者。
 */
function createStokenSign(salt, body = '', query = '') {
  const t = Math.floor(Date.now() / 1000);
  const r = Math.floor(Math.random() * 900000) + 100000;
  const payload = body || query
    ? `salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`
    : `salt=${salt}&t=${t}&r=${r}`;
  const check = crypto.createHash('md5').update(payload, 'utf8').digest('hex');
  return `${t},${r},${check}`;
}

function requestHeaders(salt) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'x-rpc-app_id': 'bll49fl6ksof',
    'x-rpc-client_type': '3',
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-lang': 'zh-cn',
    Sign: createStokenSign(salt),
    Referer: 'https://app.mihoyo.com/',
  };
}

/**
 * GET 请求：参数走 query，凭据走 Cookie。
 *
 * getLTokenBySToken 就是这一种 —— 实测 POST 它一律 405。
 */
async function getJson(url, salt, cookie, timeout = 30000) {
  const response = await fetch(url, {
    method: 'GET',
    headers: addCookie(requestHeaders(salt), cookie),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      '接口返回的不是 JSON（HTTP ' + response.status + '）：' + text.slice(0, 80)
    );
  }
  return json;
}

/** 有 cookie 就并进请求头，没有就原样返回。 */
function addCookie(headers, cookie) {
  return cookie ? Object.assign({}, headers, { Cookie: cookie }) : headers;
}

async function postJson(url, salt, body, cookie, timeout = 30000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: addCookie(requestHeaders(salt), cookie),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 80)}`);
  }
  return json;
}

/* ------------------------------------------------------------------ */
/* 第一步：SToken → LTuid + LToken                                     */
/* ------------------------------------------------------------------ */

/**
 * 用 SToken 换 ltoken。
 *
 * 返回里同时带 v1（ltoken）和 v2（ltoken_v2）两套；新账号只有 v2，
 * 老账号只有 v1，所以两个都要存，用的时候挑非空的那个。
 * cookie_token / account_id 也一起带回来 —— 拉角色列表（getUserGameRolesByCookieToken）
 * 要的是 cookie_token 这一对，只有 ltoken 是拉不到角色列表的。
 */
async function getLtokenByStoken(region, { stoken, mid, stuid = '', ltuid: ltuidHint = '' }) {
  const conf = REGIONS[region];
  if (!conf) throw new Error(`不认识的服务器：${region}`);
  /*
   * Cookie 要用 stuid + stoken + mid 三件套。
   * 这是对照 gggssepgf/mihoyo-stoken-login 确认的写法：只给 stoken + mid 时，
   * 服务端识别不出「这是哪个账号的会话」，一律回 -100 登录状态失效。
   */
  const cookieUid = String(ltuidHint || stuid || mid || '');
  const cookie = 'stuid=' + cookieUid + ';stoken=' + stoken + ';mid=' + mid;
  const sign = createStokenSign(conf.ltoken.salt);
  const parts = sign.split(',');
  const url = conf.ltoken.host + conf.ltoken.path;
  const json =
    conf.ltoken.method === 'GET'
      ? await getJson(url + '?t=' + parts[0] + '&r=' + parts[1] + '&check=' + parts[2], conf.ltoken.salt, cookie)
      : await postJson(url, conf.ltoken.salt, { stoken, mid }, cookie);
  if (json?.retcode !== 0 || !json?.data) {
    throw new Error(json?.message || `换取 LToken 失败（${json?.retcode}）`);
  }
  const d = json.data;
  const pick = (v1, v2) => String(v2 || v1 || '');
  const ltoken = pick(d.ltoken, d.ltoken_v2);
  const ltuid = pick(d.ltuid, d.ltuid_v2);
  if (!ltoken || !ltuid) {
    throw new Error('SToken 有效，但接口没有返回 ltoken / ltuid');
  }
  return {
    ltoken,
    ltuid,
    cookieToken: pick(d.cookie_token, d.cookie_token_v2),
    accountId: ltuid,
    accountMid: String(d.mid || mid || ''),
    isV2: Boolean(d.ltoken_v2),
  };
}

/* ------------------------------------------------------------------ */
/* 第二步：LToken → authkey                                            */
/* ------------------------------------------------------------------ */

/**
 * 拼 getAuthkeyBySToken 的请求体。
 *
 * 这里有个很容易踩错的地方：接口名叫「BySToken」，但 authkey 的 body 里
 * 需要的 **stoken 字段其实是上一步换出来的 ltoken**，而且要和 mid 拼成
 * `stoken=${ltoken};mid=${mid}` 一整串。直接把原始 SToken 塞进来会被判
 * 「stoken 无效」，这是很多人第一次接这个接口时遇到的坑。
 *
 * uid 与 game_uid 传同一个游戏内 UID；authkey_ver 与 sign_type 固定为 1 / 2。
 */
function authkeyBody({ game, uid }, region = 'cn') {
  const conf = REGIONS[region] || REGIONS.cn;
  const api = conf.api[game];
  /*
   * 就这四个字段，一个都不能多。
   *
   * 照着胡桃的 GenAuthKeyData 抄：
   *   auth_appid = "webview_gacha"
   *   game_biz   = 对应游戏的 biz（原神 hk4e_cn / 星铁 hkrpg_cn / 绝区零 nap_cn）
   *   game_uid   = 游戏内 UID（int，不是字符串）
   *   region     = cn_gf01 / prod_gf_cn 这类大区号
   * 以前多塞一个 stoken 字段，服务端并不会因此认账 —— 它只读 Cookie。
   */
  return {
    auth_appid: 'webview_gacha',
    game_biz: api.gameBiz,
    game_uid: Number(uid),
    region: api.region,
  };
}
/** 实时申一个新的 authkey（这条 authkey 才几百字节，不是整条链接）。 */
async function getAuthkey({ game, ltoken, stoken, mid, uid, region, cookieToken }) {
  const conf = REGIONS[region];
  const api = conf?.api?.[game];
  if (!api) throw new Error(`这个服务器不支持${game}的抽卡记录`);

  /*
   * Cookie 必须跟凭据类型对上，这是整件事的关键。
   *
   * genAuthKey 读的是 SToken 三件套 mid + stoken + stuid —— 少一个都不认。
   * 我们手里没有真 stoken 的时候（网页登录给的只有 ltoken_v2），
   * 拿 ltoken 冒充 stoken 是没用的：服务端只看 cookie，回一句
   * 「登录状态失效，请重新登录」，看起来像过期，其实是从没对上过。
   * 所以这里优先用真 stoken，只有确实没有时才退回 ltoken 那套。
   */
  const hasStoken = Boolean(stoken);
  const v2 = /^v2_/.test(String(ltoken)) || /^v2_/.test(String(cookieToken || ''));
  const cookie = hasStoken
    ? 'mid=' + mid + ';stoken=' + stoken + ';stuid=' + mid
    : v2
      ? 'ltoken_v2=' + ltoken +
        ';ltuid_v2=' + mid +
        ';account_id_v2=' + mid +
        ';account_mid_v2=' + mid +
        ';ltmid_v2=' + mid +
        (cookieToken ? ';cookie_token_v2=' + cookieToken : '')
      : 'ltoken=' + ltoken + ';ltuid=' + mid;

  const url = conf.authkey.host + conf.authkey.path;
  const json = await postJson(url, conf.authkey.salt, authkeyBody({ game, uid }, region), cookie);
  if (json?.retcode !== 0 || !json?.data?.authkey) {
    const hint = hasStoken
      ? ''
      : '（当前用的是登录态里的 ltoken，不是 SToken。genAuthKey 需要真 SToken，请扫码绑定一次。）';
    throw new Error((json?.message || '申请 authkey 失败（' + json?.retcode + '）') + hint);
  }
  const data = json.data;
  return {
    authkey: String(data.authkey),
    region: String(data.region || ''),
    gameUid: String(data.game_uid || uid),
  };
}

/* ------------------------------------------------------------------ */
/* 角色列表                                                            */
/* ------------------------------------------------------------------ */

/**
 * 拉这个 ltoken 名下的角色。
 *
 * 复用 miyoushe-login 的 fetchRolesDetailed：它已经处理好了
 * UA / x-rpc-device_fp 那一套风控头，自己再写一份只会重复踩同样的坑。
 * 拿不到时返回空数组而不是抛错 —— 有些账号确实一个角色都没有，
 * 让它在这里炸掉，用户就只能看到一句红字。
 */
async function fetchRoles({ region, ltoken, ltuid, cookieToken, cookie: rawCookie }) {
  /*
   * 有原始 cookie 就直接用它。
   *
   * 2024 年起米哈游把凭据换成了 v2（ltoken_v2 / ltuid_v2 / cookie_token_v2），
   * 从登录态建账号时手里拿到的就是这一套。这里如果还按 v1 的键名重新拼一遍，
   * 拼出来的 cookie 里没有服务器认的字段，接口只会回一个空角色列表 ——
   * 看起来像「这个账号没角色」，其实只是登录态没带上。
   */
  const v2 = /(^|;)\s*(ltoken_v2|ltuid_v2)\s*=/.test(String(rawCookie || ''));
  const cookie = rawCookie && v2
    ? rawCookie
    : miyoushe.cookieHeader([
        { name: 'ltoken', value: ltoken },
        { name: 'ltuid', value: ltuid },
        ...(cookieToken ? [{ name: 'cookie_token', value: cookieToken }] : []),
      ]);
  const providerId = region === 'os' ? 'hoyolab' : 'miyoushe';
  try {
    const { roles } = await miyoushe.fetchRolesDetailed(cookie, providerId);
    return roles;
  } catch {
    return [];
  }
}

/*
 * 用 SToken 拉角色列表（不依赖 ltoken）。
 *
 * 为什么要单独写一条路：官方 App 扫码签发的 SToken 换不出 ltoken
 * （getLTokenBySToken 对 App 端 token 回 -100），而 fetchRoles 是以 ltoken
 * 为前提写的。结果是「扫码成功、账号也存下了，但角色列表永远是空的」——
 * 界面上就退化成让用户手填 UID，正是当初要消灭的那一步。
 *
 * 正确姿势是胡桃重制版 BindingClient 里那两条：
 *   GET /auth/api/getActionTicketBySToken?action_type=game_role&stoken=&uid=
 *   GET /binding/api/getUserGameRoles?action_ticket=&game_biz=
 * 前者拿一张一次性的 action_ticket，后者用它逐游戏换角色。
 *
 * uid 必须是 aid（米游社数字账号 id），不是 mid。传 mid 过去接口回
 * "-502 Something went wrong"，看起来像服务端抽风，其实是 id 传错了。
 */
async function fetchRolesByStoken({ region = 'cn', stoken, mid, stuid, uid }) {
  const aid = String(stuid || uid || '');
  if (!stoken || !aid) return [];
  const conf = REGIONS[region] || REGIONS.cn;
  const host = conf.ltoken.host.replace(/\/account$/, '');
  /* 国服走 api-takumi，国际服走 api-account-os（胡桃的 ApiEndpoints 里就是这么分的） */
  const takumi = region === 'os' ? 'https://api-account-os.hoyoverse.com' : 'https://api-takumi.mihoyo.com';
  const cookie = 'mid=' + mid + ';stoken=' + stoken + ';stuid=' + aid;
  const headers = {
    "user-agent": APP_UA_BBS,
    "x-rpc-app_version": "2.95.1",
    "x-rpc-client_type": "2",
    cookie,
  };

  let ticket = '';
  try {
    const url = takumi + '/auth/api/getActionTicketBySToken?action_type=game_role&stoken=' +
      encodeURIComponent(stoken) + '&uid=' + encodeURIComponent(aid);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const json = await response.json();
    ticket = String((json && json.data && json.data.ticket) || '');
  } catch {
    return [];
  }
  if (!ticket) return [];

  /* game_biz -> 我们内部的 game key，顺序固定，输出稳定 */
  const BIZ = [
    ['hk4e_cn', 'genshin'],
    ['hkrpg_cn', 'starrail'],
    ['nap_cn', 'zzz'],
  ];
  const roles = [];
  for (const [biz, game] of BIZ) {
    try {
      const url = takumi + '/binding/api/getUserGameRoles?game_biz=' + biz +
        '&action_ticket=' + encodeURIComponent(ticket);
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      const json = await response.json();
      const list = (json && json.data && json.data.list) || [];
      for (const item of list) {
        roles.push({
          game,
          gameBiz: String(item.game_biz || biz),
          uid: String(item.game_uid || ''),
          nickname: String(item.nickname || ''),
          level: Number(item.level || 0),
          region: String(item.region || ''),
          regionName: String(item.region_name || ''),
        });
      }
    } catch {
      /* 某一款游戏失败不影响其它三款 */
    }
    await new Promise((resolve) => { setTimeout(resolve, 300); });
  }
  return roles;
}

/**
 * 猜这个账号对应的服务器。
 *
 * 只看角色列表，不看用户选的服务器 —— 用户可能在设置里选国服，
 * 手上贴的却是国际服的 SToken。这里以接口实际返回为准，
 * 免得后面拿国服的盐去签国际服的请求。
 */
function detectRegionFromRoles(roles) {
  const hasGlobal = (roles || []).some((role) => /_global$/.test(String(role.gameBiz || '')));
  return hasGlobal ? 'os' : 'cn';
}

/* ------------------------------------------------------------------ */
/* 从已登录的 cookie 直接建账号                                          */
/* ------------------------------------------------------------------ */

/**
 * 从米游社 / HoYoLAB 的登录 cookie 里直接抠出可长期使用的凭据。
 *
 * 为什么不用 SToken 了
 * --------------------
 * SToken 要用户自己去浏览器 F12 里翻，还要连 mid 一起复制，门槛很高。
 * 但启动器本来就有「米游社登录」这个功能 —— 那个登录窗口拿到的 cookie 里
 * 已经有 ltoken / ltuid（有效期以月计，不是 24 小时），
 * 而申请抽卡 authkey 需要的正是这两个。也就是说：
 * 用户登录过一次通行证，之后就该一劳永逸，不该再抄什么东西。
 *
 * 只认 v2 优先、v1 兜底 —— 老账号只有 v1，新账号只有 v2。
 */
function accountFromCookie(cookieStr, providerId = 'miyoushe') {
  const cookie = String(cookieStr || '');
  const read = (names) => names.map((name) => cookieValue(cookie, name)).find(Boolean) || '';
  const ltoken = read(['ltoken_v2', 'ltoken']);
  const ltuid = read(['ltuid_v2', 'ltuid', 'account_id_v2', 'account_id']);
  const mid = read(['account_mid_v2', 'account_mid', 'mid_v2', 'ltmid_v2', 'mid', 'ltuid_v2', 'ltuid']);
  const cookieToken = read(['cookie_token_v2', 'cookie_token']);
  if (!ltoken) return { ok: false, error: '这个登录态里没有 ltoken，请重新登录一次米游社' };
  if (!ltuid) return { ok: false, error: '这个登录态里没有 ltuid，请重新登录一次米游社' };
  return {
    ok: true,
    ltoken,
    ltuid,
    mid: mid || ltuid,
    cookieToken,
    cookie,
    region: providerId === 'hoyolab' ? 'os' : 'cn',
    fromLogin: true,
  };
}

/**
 * 从用户粘进来的一大段东西里，把所有能用的凭据一次性挑出来。
 *
 * 为什么单独写一个：用户在浏览器里复制 cookie 时，拿到的往往是整段
 * `ltuid_v2=..; ltoken_v2=..; stoken=..; stuid=..; login_ticket=..; ...`，
 * 光是 stoken 不够 —— 要长期免维护，还得留住 login_ticket：
 *
 *   stoken        → 换 authkey（抽卡记录的门票），这一层能用很久
 *   login_ticket  → stoken 万一失效时，凭它重新换一套（自动续期）
 *
 * 所以这里不挑「一个值」，而是把两个层级都收下来。用户不用知道哪个是哪个。
 *
 * 容错：分隔符 ; / \n / \r 都认；值里可能带 `=`（v2 token 常见 `==` 结尾），
 * 所以只能按「第一个 = 」切键值，不能用 split('=')。
 */
function parseCredentialBundle(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: '还没有粘贴内容' };

  const bag = new Map();
  for (const part of text.split(/[;\n\r]+/)) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (!key || !value) continue;
    if (!bag.has(key)) bag.set(key, value);
  }
  const pick = (names) => names.map((name) => bag.get(name)).find(Boolean) || '';

  const stoken = pick(['stoken', 'stoken_v2']);
  const stuid = pick(['stuid', 'stuid_v2']);
  const mid = pick(['mid', 'account_mid', 'account_mid_v2', 'mid_v2', 'ltmid_v2', 'ltuid_v2', 'ltuid']);
  const loginTicket = pick(['login_ticket', 'login_ticket_v2']);
  const loginUid = pick(['login_uid', 'login_uid_v2', 'ltuid_v2', 'ltuid', 'account_id_v2', 'account_id']);
  const ltuid = pick(['ltuid_v2', 'ltuid', 'account_id_v2', 'account_id']);
  const ltoken = pick(['ltoken_v2', 'ltoken']);
  const cookieToken = pick(['cookie_token_v2', 'cookie_token']);

  /*
   * 用户也可能只贴了一个裸值（v2_xxx==.CAE= 这种），压根没有键名。
   *
   * 注意：这种串不是「没有 =」，而是值本身带 =（v2 token 结尾是 ==.CAE=），
   * 按第一个 = 切会切出一个假的键名（v2_zzz → 值 '=.CAE='）。所以判据是
   * 「bag 里没有任何一个认识的名字」，而不是「bag 是空的」。
   */
  const knownKeys = ['stoken', 'stoken_v2', 'mid', 'account_mid', 'account_mid_v2', 'mid_v2',
    'ltmid_v2', 'ltuid_v2', 'ltuid', 'account_id_v2', 'account_id', 'stuid', 'stuid_v2',
    'login_ticket', 'login_uid', 'ltoken', 'ltoken_v2', 'cookie_token', 'cookie_token_v2'];
  const bagLooksLikeCookie = knownKeys.some((name) => bag.has(name));
  if (!stoken && !bagLooksLikeCookie) {
    const parts = text.split(/[;\s\n\r]+/).filter(Boolean);
    const looksLikeStoken = (value) => /^v2_/.test(value) || /^[A-Za-z0-9]{20,}$/.test(value);
    const bare = parts.find(looksLikeStoken);
    if (bare) {
      const index = parts.indexOf(bare);
      const after = parts.slice(index + 1).find((value) => /^[A-Za-z0-9]{6,}$/.test(value));
      return {
        ok: true,
        stoken: bare,
        /*
         * 裸值贴进来就是不想管 mid。这里先留空，让调用方用 stoken 自己去换
         * —— getLTokenBySToken 的返回里带着真正的 mid 和 ltuid。
         */
        mid: after || '',
        stuid: after || '',
        loginTicket: '',
        loginUid: '',
        ltuid: '',
        ltoken: '',
        cookieToken: '',
        hasRenew: false,
        needsMid: !after,
        raw: text,
      };
    }
  }

  if (!stoken) {
    /*
     * 走到这里说明有键值对、但没有 stoken。最典型的是网页登录态：
     * 里面有 ltoken_v2 / mid，唯独没有 stoken —— 这时候不能含糊，
     * 得直接说「这段里没有 stoken」，否则用户会以为粘对了。
     */
    if (mid || ltoken) {
      return {
        ok: false,
        needStoken: true,
        error:
          '这段 cookie 里有登录态（ltoken / mid），但没有 stoken。' +
          '抽卡记录只认 stoken，所以得从带 stoken 的地方复制。',
      };
    }
    return {
      ok: false,
      error: '没在这段内容里找到 stoken。请确认复制的是整段 cookie（里面有 stoken= 这一段）。',
    };
  }

  if (!mid && !stuid) {
    return { ok: false, error: '找到了 stoken，但没找到 mid / stuid。把整段 cookie 一起粘进来就行。' };
  }

  /* genAuthKey 要的 cookie 是 mid + stoken + stuid 三件，缺 stuid 时用 mid 兜底。 */
  const realMid = mid || stuid;
  return {
    ok: true,
    stoken,
    mid: realMid,
    stuid: stuid || realMid,
    loginTicket,
    loginUid,
    ltuid,
    ltoken,
    cookieToken,
    // 有 login_ticket 才谈得上「自动续期」，界面据此决定要不要多夸一句
    hasRenew: Boolean(loginTicket),
    raw: text,
  };
}

/** 从 cookie 串里取一个键的值，取不到返回空串。 */
function cookieValue(cookieStr, name) {
  const text = String(cookieStr || '');
  for (const part of text.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim();
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 一次性完成：校验 + 整理                                             */
/* ------------------------------------------------------------------ */

/**
 * 校验一份 SToken，并把能拿到的东西全带回来，供界面立即显示。
 *
 * 返回里刻意把「哪一步失败」说清楚：
 *   - SToken 本身错（-101 / -100）→ 提示用户重新复制
 *   - 换到了 ltoken 但拉不到角色 → 不算失败，账号可能真的没有角色
 */
async function verifyStoken(input, { region = 'cn' } = {}) {
  const parsed = parseStokenInput(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  let token;
  try {
    /*
     * 换 ltoken 只是为了确认 SToken 真的有效，顺便拿 ltoken 给同步时兜底。
     * 但它失败并不等于 SToken 无效 —— 扫码拿到的 SToken 常常换不出 ltoken
     * （getLTokenBySToken 对 App 端签发的 token 也回 -100）。所以这里不抛错，
     * 只记一句，真正判定有效性交给后面的 genAuthKey（authkeyBody）。
     */
    token = await getLtokenByStoken(region, { stoken: parsed.stoken, mid: parsed.mid });
  } catch (error) {
    /*
     * 注意 ltuid 兜底用 parsed.stuid 而不是 parsed.mid。
     *
     * 两者不是一回事：mid 是 0cyjuew66u_mhy 这种带后缀的字符串，aid（stuid）是
     * 82374705 这种纯数字。以前这里写 parsed.mid，导致账号 id 被记成 mid，
     * 之后 getActionTicketBySToken 拿它当 uid 传过去一律 -502 —— 扫码明明成功，
     * 界面上却是一堆「没拉到角色 / 需要手填 UID」。
     */
    token = { ltoken: '', ltuid: parsed.stuid || '', isV2: false, error: readableError(error, 'CN') };
  }

  /*
   * 角色列表两条路，顺序有讲究。
   *
   * SToken 这条路不依赖 ltoken，扫码账号也只能走它 —— 以前只写 ltoken 那条，
   * 于是「扫码成功但角色列表永远空」，界面上就退化成让用户手填 UID。
   * ltoken 那条留着给从登录态建的账号兜底（它的 SToken 可能过期但 ltoken 还能用）。
   */
  let roles = await fetchRolesByStoken({
    region,
    stoken: parsed.stoken,
    mid: parsed.mid,
    stuid: parsed.stuid,
  });
  if (!roles.length && token.ltoken) {
    roles = await fetchRoles({ region, ...token });
  }
  const actualRegion = roles.length ? detectRegionFromRoles(roles) : region;

  return {
    ok: true,
    region: actualRegion,
    mid: parsed.mid,
    stoken: parsed.stoken,
    ltuid: token.ltuid,
    ltoken: token.ltoken,
    isV2: token.isV2,
    roles,
  };
}

/** 把接口错误翻成人话：负数 retcode 一律当成「重发一次 SToken」。 */
function readableError(error, regionLabel) {
  const message = String(error?.message || error);
  if (/(-100|-101|登录|stoken|token)/i.test(message)) {
    return `SToken 校验没通过（${message}）。请重新从米游社获取一份最新的 SToken`;
  }
  if (/40100/.test(message)) {
    return `这个 SToken 已经失效（提交时间过长会被收回），请重新获取。区域：${regionLabel}`;
  }
  return message;
}

/* ------------------------------------------------------------------ */
/* 本地文件                                                            */
/* ------------------------------------------------------------------ */

/** 存 SToken 的文件放在 userData 下，和 device-fp.json 挨着。 */
function stokenFile(userData) {
  return path.join(userData || '.', 'stoken-accounts.json');
}

function readStokenStore(userData) {
  try {
    const json = JSON.parse(fs.readFileSync(stokenFile(userData), 'utf8'));
    return {
      accounts: Array.isArray(json.accounts) ? json.accounts : [],
      activeId: String(json.activeId || ''),
    };
  } catch {
    return { accounts: [], activeId: '' };
  }
}

/** 写文件用「临时名 + 改名」，中途断电也不会留下半截 JSON。 */
function writeStokenStore(userData, store) {
  const file = stokenFile(userData);
  const temp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temp, file);
  return store;
}

module.exports = {
  REGIONS,
  accountFromCookie,
  cookieValue,
  parseCredentialBundle,
  parseStokenInput,
  createStokenSign,
  getLtokenByStoken,
  getAuthkey,
  authkeyBody,
  fetchRoles,
  fetchRolesByStoken,
  verifyStoken,
  stokenFile,
  readStokenStore,
  writeStokenStore,
  UA,
};
