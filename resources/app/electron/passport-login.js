'use strict';

/**
 * 通用「网页登录抓凭据」通道。
 *
 * 为什么统一成这一套
 * ------------------
 * 第三方启动器想拿玩家的账号数据，唯一稳的路子是：
 *   开内嵌浏览器 → 用户在官方网页里自己登录 → 掌握会话 cookie。
 * 各家的登录风控（device_fp、二次验证、行为参数）天天变，
 * 直接模拟密码登录的代码过几周就废，而网页登录永远跟着官方走。
 *
 * 各家差异只在三件事上：
 *   1. 打开哪个网址；
 *   2. 登录成功在 cookie 里长什么样（哪些域名 + 哪些键算登录成功）；
 *   3. 登录之后能用什么接口换出角色列表（有的能，有的官方不给）。
 *
 * 所以这里做成声明式的 PROVIDERS 表，加新发行方只加一条。
 */

const crypto = require('node:crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* 发行方声明表                                                         */
/* ------------------------------------------------------------------ */

const PROVIDERS = {
  /**
   * 鹰角通行证：终末地 / 明日方舟。
   *
   * 网页 https://user.hypergryph.com/ 实有三种登录方式（扫码 / 短信 / 密码），
   * 全部在同一个页面里，所以只要把页面打开就够了。
   *
   * 登录成功判定：会话 cookie 里出现 `u8_token` 或 `HG_TOKEN`。
   * 这两个键是鹰角网页 SDK 种下来的，未登录时不存在。
   */
  hypergryph: {
    id: 'hypergryph',
    label: '鹰角通行证',
    home: 'https://user.hypergryph.com/',
    methods: ['qrcode', 'sms', 'password'],
    cookieDomains: ['hypergryph.com', 'gryphline.com', 'hycdn.cn'],
    /** 只要出现其中任意一个键就算已登录 */
    loginKeys: ['u8_token', 'HG_TOKEN', 'hg_token'],
    /*
     * 鹰角没有开放「列出我绑定的角色」的网页接口，
     * 所以登录后不返回角色列表，只存 cookie ——
     * 它的用处是：以后加战绩抓取时直接复用同一袋 cookie。
     * 抽卡记录另走 endfield-gacha.js 的 oauth/binding 链路，不受影响。
     */
    roleApi: null,
    openDialogScript: '',
  },

  /**
   * 完美世界通行证：异环。
   *
   * 异环官网 https://yh.wanmei.com/ 点「登录」弹出完美通行证弹窗，
   * 支持手机验证码 + 账号密码。跨域登录页在 passport.wanmei.com。
   */
  perfectworld: {
    id: 'perfectworld',
    label: '完美世界通行证',
    home: 'https://yh.wanmei.com/',
    methods: ['sms', 'password'],
    cookieDomains: ['wanmei.com', 'perfectworld.com'],
    loginKeys: ['passport', 'accessToken', 'wwwtoken', 'atoken', 'login_uid'],
    /*
     * 完美世界没有给第三方用的角色列表接口，
     * 完成后只保存 cookie，供将来可能的战绩抓取使用。
     */
    roleApi: null,
    /*
     * 异环官网首页的登录按钮没有稳定 class，
     * 用文本匹配兜，兜不到也不报错（用户自己点一下就行）。
     */
    openDialogScript: `
      (function () {
        var tries = 0;
        var id = setInterval(function () {
          tries += 1;
          if (tries > 60) { clearInterval(id); return; }
          var nodes = document.querySelectorAll('a, button, span, div');
          for (var i = 0; i < nodes.length; i++) {
            var t = (nodes[i].textContent || '').trim();
            if (t === '登录' || t === '立即登录') {
              var el = nodes[i];
              if (el.offsetParent !== null) { el.click(); clearInterval(id); return; }
            }
          }
        }, 500);
      })();
    `,
  },

  /**
   * 库街区（库洛）：鸣潮 / 战双。目前没有内置游戏，
   * 先把 provider 备好，加游戏时直接引用。
   */
  kuro: {
    id: 'kuro',
    label: '库街区',
    home: 'https://www.kurobbs.com/',
    methods: ['qrcode', 'sms', 'password'],
    cookieDomains: ['kurobbs.com', 'kurogame.com'],
    loginKeys: ['userToken', 'token', 'kuro_token'],
    roleApi: null,
    openDialogScript: '',
  },
};

/* ------------------------------------------------------------------ */
/* cookie 工具                                                         */
/* ------------------------------------------------------------------ */

/** 把 Electron 的 cookies.get() 结果拼成请求头能用的 `k=v; k=v`。 */
function cookieHeader(items) {
  return items.map((item) => `${item.name}=${item.value}`).join('; ');
}

/** 只保留目标域名下的 cookie，避免把无关站点的东西带进请求。 */
function filterCookies(items, domains = []) {
  if (!domains.length) return items;
  return items.filter((item) =>
    domains.some((domain) => {
      const host = String(item.domain || '').replace(/^\./, '');
      return host === domain || host.endsWith(`.${domain}`);
    })
  );
}

/**
 * 判断这一袋 cookie 算不算登录成功。
 * 只认登录后才出现的会话键，避免被游客 cookie 误判成已登录。
 */
function hasLoginCookie(items, loginKeys = []) {
  if (!loginKeys.length) return items.length > 0;
  const names = new Set(items.map((item) => item.name));
  return loginKeys.some((key) => names.has(key));
}

/** 从 cookie 里直接抠一个值（优先用已保存的 header 字符串，省一次网络）。 */
function pickFromHeader(header, names = []) {
  for (const name of names) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(header || ''));
    if (match) return match[1];
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 角色列表（目前只有米家有公开接口，留函数位给以后）                     */
/* ------------------------------------------------------------------ */

/**
 * 有些发行方（米哈游）有「按 cookie 列角色」的公开接口，
 * 鹰角 / 完美 / 库洛都没有。这里返回 null 表示「该渠道不支持」，
 * 调用方据此只保存 cookie，不再询问角色。
 */
async function fetchRoles(providerId, cookieStr) {
  const provider = PROVIDERS[providerId];
  if (!provider || !provider.roleApi) return null;
  try {
    const response = await fetch(provider.roleApi, {
      headers: { Cookie: cookieStr, 'User-Agent': UA },
    });
    const json = await response.json();
    return Array.isArray(json?.data?.list) ? json.data.list : [];
  } catch {
    return null;
  }
}

module.exports = {
  PROVIDERS,
  UA,
  cookieHeader,
  filterCookies,
  hasLoginCookie,
  pickFromHeader,
  fetchRoles,
  createDs2: (url, salt2) => {
    // 只有米系接口要 DS2，这里保留是为了让调用方少引一个模块
    const t = Math.floor(Date.now() / 1000);
    const r = String(Math.floor(Math.random() * 100000) + 100000);
    const b = '';
    const q = '';
    const raw = `salt=${salt2}&t=${t}&r=${r}&b=${b}&q=${q}`;
    const sign = crypto.createHash('md5').update(raw).digest('hex');
    return `${t},${r},${sign}`;
  },
};
