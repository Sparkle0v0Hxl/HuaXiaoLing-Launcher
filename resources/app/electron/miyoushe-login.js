'use strict';

/**
 * 米游社 / HoYoLAB 登录 —— 参考 Scighost/Starward 的 GameRecord/LoginPage 实现。
 *
 * 为什么不用账号密码模拟登录
 * --------------------------
 * 米哈游的 passport 接口有风控（需要 device_fp、行为参数、二次验证），
 * 各第三方启动器（Starward、Snap Hutao、Collapse）都放弃了直接调接口，
 * 改成「内嵌浏览器让用户自己在网页里登录，然后把 cookie 拿走」。
 * 好处是扫码、短信、密码三种方式都天然可用，且用户看得见每一步。
 *
 * 关键点（Starward 原文思路）
 * --------------------------
 * 1. 打开 https://www.miyoushe.com/ ，导航完成后注入脚本轮询
 *    .header__avatarwrp（国际服是 .header-avatar），出现就点一下唤出登录弹窗；
 * 2. 用户自己扫码 / 输手机号 / 输密码；
 * 3. 用户点「完成」后，取该站点的**全部** cookie，拼成 `k=v; k=v`；
 * 4. 角色列表走 passport-api 的 getUserGameRolesByCookieToken，**不需要 DS 签名**；
 * 5. 其余战绩接口要 DS2 = md5(`salt=${salt2}&t=${t}&r=${r}&b=${b}&q=${q}`)。
 */

const crypto = require('node:crypto');

const PROVIDERS = {
  miyoushe: {
    id: 'miyoushe',
    label: '米游社',
    home: 'https://www.miyoushe.com/',
    site: {
      genshin: 'https://www.miyoushe.com/ys/',
      starrail: 'https://www.miyoushe.com/sr/',
      zzz: 'https://www.miyoushe.com/zzz/',
      bh3: 'https://www.miyoushe.com/bh3/',
    },
    cookieDomains: ['miyoushe.com', 'mihoyo.com'],
    /*
     * 打开登录弹窗。
     *
     * 一定要幂等：这段脚本可能在同一个窗口里被执行多次（页面刷新、SPA 路由变化）。
     * 每次执行都去 click() 头像，会把已经打开的登录 iframe 关掉再重开，
     * 于是「登录框一直弹出、永远转圈」——这个 bug 就是这么来的。
     *
     * 所以这里用 window.__hxlLoginClicked 做一次性锁：
     * - 每个加载出来的文档里最多点一次；
     * - 从 DOMContentLoaded 之后延迟 600ms 再点，等头部的 React 渲染完；
     * - 头像不存在就直接放弃，不再轮询（轮询本身也会在弹窗打开后重复触发点击）。
     */
    openDialogScript: `
      (function () {
        if (window.__hxlLoginClicked) return 'already';
        window.__hxlLoginClicked = true;
        var host = window.location.host;
        var cls = host === 'www.hoyolab.com' ? 'header-avatar' : 'header__avatarwrp';
        if (host !== 'www.miyoushe.com' && host !== 'www.hoyolab.com') return 'skip-host';
        var click = function () {
          var ele = document.getElementsByClassName(cls);
          if (!ele.length) return 'no-avatar';
          try { ele[0].click(); } catch (e) { return 'click-failed'; }
          return 'clicked';
        };
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function () { setTimeout(click, 600); }, { once: true });
        } else {
          setTimeout(click, 600);
        }
        return 'scheduled';
      })();
    `,
    api: {
      roleList: 'https://passport-api.mihoyo.com/binding/api/getUserGameRolesByCookieToken',
      record: 'https://api-takumi-record.mihoyo.com',
      salt2: 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs',
      refererRecord: 'https://webstatic.mihoyo.com/',
      refererAct: 'https://act.mihoyo.com/',
    },
    gameBiz: { genshin: 'hk4e_cn', starrail: 'hkrpg_cn', zzz: 'nap_cn', bh3: 'bh3_cn' },
  },
  hoyolab: {
    id: 'hoyolab',
    label: 'HoYoLAB',
    home: 'https://www.hoyolab.com/home',
    site: {},
    cookieDomains: ['hoyolab.com', 'mihoyo.com'],
    /** 与 miyoushe 同一套幂等逻辑，只是头像的类名不同。 */
    openDialogScript: `
      (function () {
        if (window.__hxlLoginClicked) return 'already';
        window.__hxlLoginClicked = true;
        var host = window.location.host;
        if (host !== 'www.hoyolab.com') return 'skip-host';
        var click = function () {
          var ele = document.getElementsByClassName('header-avatar');
          if (!ele.length) return 'no-avatar';
          try { ele[0].click(); } catch (e) { return 'click-failed'; }
          return 'clicked';
        };
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function () { setTimeout(click, 600); }, { once: true });
        } else {
          setTimeout(click, 600);
        }
        return 'scheduled';
      })();
    `,
    api: {
      roleList: 'https://sg-public-api.hoyolab.com/binding/api/getUserGameRolesByCookieToken',
      record: 'https://sg-public-api.hoyolab.com',
      salt2: 'okr4obncj8bw5a65hbnn5oo6ixjc3l9w',
      refererRecord: 'https://act.hoyolab.com/',
      refererAct: 'https://act.hoyolab.com/',
    },
    gameBiz: { genshin: 'hk4e_global', starrail: 'hkrpg_global', zzz: 'nap_global', bh3: 'bh3_global' },
  },
};

/*
 * 登录后必须具备的 cookie。
 *
 * 这里踩过大坑：米游社现在扫码登录种的是 v2 系列
 * （cookie_token_v2 / account_id_v2 / ltoken_v2 / ltuid_v2 / account_mid_v2 / ltmid_v2），
 * 更老的账号才是 v1（cookie_token / account_id / ltoken / ltuid）。
 * 以前这里写死要求 'cookie_token'，而实际只拿到 cookie_token_v2，
 * 于是 hasLoginCookie 永远返回 false —— 表现就是「扫完码了但启动器一直显示未登录，
 * 登录窗口干等到 5 分钟超时」。
 *
 * 所以每组给一个候选表，命中任意一个就算有；只是「有没有登录」的粗判，
 * 真正是否有效仍然由 verifyCookie 打接口来定。
 */
const LOGIN_COOKIE_GROUPS = [
  ['cookie_token', 'cookie_token_v2'],
  ['account_id', 'account_id_v2'],
];

/** 兼容旧名字，保留导出（外部可能拿来拼提示）。 */
const REQUIRED_COOKIE_KEYS = LOGIN_COOKIE_GROUPS.map((group) => group[0]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* cookie 工具                                                         */
/* ------------------------------------------------------------------ */

/**
 * 把 cookie 数组拼成请求头。
 * 米哈游的接口认 account_id + cookie_token 这一对，
 * 但角色列表接口要 cookie_token，写 json 请求时还得带 ltoken；
 * 所以这里不做筛选，有多少带多少。
 */
function cookieHeader(items) {
  return items
    .filter((item) => item && item.name && item.value !== undefined)
    .map((item) => `${item.name}=${item.value}`)
    .join('; ');
}

/**
 * 从 cookie 数组里挑出目标域的。
 *
 * 按「域名 + 名字」去重，不是只按名字：
 * 米游社会把 cookie_token_v2 同时写在 user.miyoushe.com、passport.miyoushe.com
 * 等好几个子域上，只按名字去重会互相覆盖，拼请求头时可能拿到别的子域的值。
 * 同一个域下同名 cookie 的不同路径，保留最具体的那个（path 最长）。
 */
function filterCookies(items, domains) {
  const bag = new Map();
  for (const item of items) {
    const domain = String(item.domain || '').replace(/^\./, '');
    if (domains && !domains.some((d) => domain === d || domain.endsWith(`.${d}`))) continue;
    const key = `${domain}\u0000${item.name}`;
    const prev = bag.get(key);
    if (prev && String(prev.path || '').length >= String(item.path || '').length) continue;
    bag.set(key, item);
  }
  return [...bag.values()];
}

/**
 * 是否已经拿到可用于接口的登录态。
 * 每组候选命中一个即可（v1 / v2 都认，见上面的 LOGIN_COOKIE_GROUPS 注释）。
 */
function hasLoginCookie(items) {
  const names = new Set(items.map((item) => item.name));
  return LOGIN_COOKIE_GROUPS.every((group) => group.some((key) => names.has(key)));
}

/* ------------------------------------------------------------------ */
/* DS 签名                                                             */
/* ------------------------------------------------------------------ */

/**
 * DS2 签名（Starward 的 CreateSecret2）。
 * 查询参数要按字典序排好再拼进 q，否则服务端算出来的不一样。
 */
function createDs2(url, salt2) {
  const t = Math.floor(Date.now() / 1000);
  const r = String(Math.floor(100000 + Math.random() * 100000));
  const b = '';
  const parts = String(url || '').split('?');
  const q = parts.length === 2 ? parts[1].split('&').sort().join('&') : '';
  const raw = `salt=${salt2}&t=${t}&r=${r}&b=${b}&q=${q}`;
  const check = crypto.createHash('md5').update(raw, 'utf8').digest('hex');
  return `${t},${r},${check}`;
}

/* ------------------------------------------------------------------ */
/* 接口调用                                                            */
/* ------------------------------------------------------------------ */

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`);
  }
}

/**
 * 取这个 cookie 绑定的全部游戏角色。
 * 注意：这个接口不需要 DS，Starward 里也是注释掉的。
 *
 * 除了角色列表，这里还把每个游戏接口的 retcode 一起带回去：
 * 以前只返回 list，接口报错和「账号没角色」都表现为空数组，
 * 上层只能一律当成未登录，用户看到的就是「扫完码显示未登录」且毫无线索。
 */
async function fetchRolesDetailed(cookieStr, providerId = 'miyoushe') {
  const provider = PROVIDERS[providerId] || PROVIDERS.miyoushe;
  const list = [];
  const bizMap = provider.gameBiz;
  /** 每个游戏接口的返回：{ game, retcode, message } */
  const probes = [];
  let lastError = '';

  for (const [gameKey, biz] of Object.entries(bizMap)) {
    const url = `${provider.api.roleList}?game_biz=${encodeURIComponent(biz)}`;
    try {
      const response = await fetch(url, {
        headers: {
          Cookie: cookieStr,
          Referer: provider.api.refererAct,
          'User-Agent': UA,
        },
      });
      const json = await readJson(response);
      const retcode = typeof json?.retcode === 'number' ? json.retcode : -1;
      probes.push({ game: gameKey, retcode, message: json?.message || '' });
      if (retcode !== 0) {
        lastError = json?.message || `接口返回 ${retcode}`;
        continue;
      }
      const roles = json?.data?.list || [];
      for (const role of roles) {
        list.push({
          game: gameKey,
          gameBiz: biz,
          uid: String(role.game_uid || role.uid || ''),
          nickname: role.nickname || '',
          level: role.level ?? null,
          region: role.region || '',
          regionName: role.region_name || '',
        });
      }
    } catch (error) {
      const message = String(error?.message || error);
      lastError = message;
      probes.push({ game: gameKey, retcode: null, message });
      // 单个游戏失败不影响其它游戏，继续看下一个
    }
  }
  return { roles: list, probes, lastError };
}

/** 只要角色列表（保持旧接口）。 */
async function fetchAllRoles(cookieStr, providerId = 'miyoushe') {
  const { roles } = await fetchRolesDetailed(cookieStr, providerId);
  return roles;
}

/**
 * 校验 cookie 是否还有效，返回角色列表。
 *
 * 判定顺序很关键：
 * 1. 只要有任意一个游戏接口返回 retcode 0，就说明这袋 cookie 是登录态 ——
 *    哪怕 roles 是空的（账号确实没建角色）。
 * 2. 全部接口都是 -100 / -101（未登录 / 登录失效）才算未登录，这时要把原始 message 带出去。
 * 3. 其它错误（网络不通、接口改版、被风控）不能武断当成未登录，
 *    否则用户看到「未登录」却完全不知道原因。
 */
async function verifyCookie(cookieStr, providerId = 'miyoushe') {
  const { roles, probes, lastError } = await fetchRolesDetailed(cookieStr, providerId);
  const ok = probes.some((probe) => probe.retcode === 0);
  if (ok) return { ok: true, roles };
  const authRetcodes = [-100, -101];
  const authFailed = probes.length > 0 && probes.every((probe) => authRetcodes.includes(probe.retcode));
  return {
    ok: false,
    roles: [],
    reason: authFailed ? '登录态已失效，请重新登录' : lastError || '读取米游社账号信息失败',
  };
}

/**
 * 调一个战绩接口，自动补 DS2。
 * path 传 '/game_record/app/genshin/api/dailyNote?server=cn_gf01&role_id=xxx'。
 */
async function fetchRecord(path, cookieStr, providerId = 'miyoushe') {
  const provider = PROVIDERS[providerId] || PROVIDERS.miyoushe;
  const url = `${provider.api.record}${path}`;
  const response = await fetch(url, {
    headers: {
      Cookie: cookieStr,
      DS: createDs2(url, provider.api.salt2),
      Referer: provider.api.refererRecord,
      'User-Agent': UA,
      'X-Requested-With': 'com.mihoyo.hyperion',
    },
  });
  const json = await readJson(response);
  if (json.retcode !== 0) {
    const error = new Error(json.message || `战绩接口返回 ${json.retcode}`);
    error.retcode = json.retcode;
    throw error;
  }
  return json.data;
}

module.exports = {
  PROVIDERS,
  REQUIRED_COOKIE_KEYS,
  LOGIN_COOKIE_GROUPS,
  UA,
  cookieHeader,
  filterCookies,
  hasLoginCookie,
  createDs2,
  fetchAllRoles,
  fetchRolesDetailed,
  verifyCookie,
  fetchRecord,
};
