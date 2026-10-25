'use strict';

/**
 * QQ 音乐 / 酷狗的登录会话。
 *
 * 为什么不用纯接口：
 * - QQ 音乐：ptqrlogin 在我们已有的参数下仍返回 403（腾讯校验来源/指纹），
 *   CgiGetVkey 取歌地址需要已登录的 uin + qqmusic_key。
 * - 酷狗：qrcode 接口固定 20010，搜索返回 err signature。
 * 两家的签名算法都在客户端里，纯 Node 复刻不稳。
 *
 * 所以采用和终末地一样的思路：开一个**内置浏览器窗口**让用户真实登录
 * （扫码 / QQ / 微信 / 手机号验证码都由官网自己提供），
 * 登录完成后从窗口的 cookie 里取出播放凭证。
 *
 * 这条路的好处是：登录界面永远和官网一致，腾讯/酷狗改版也不需要我们适配。
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 各平台的登录页与凭证 cookie 名。 */
const PLATFORM_CONFIG = {
  qq: {
    label: 'QQ 音乐',
    /*
     * 老的 /portal/login.html 已经 404，n/ryqq_v2/login 也会 ERR_FAILED。
     * 现在的登录框是首页上一个 <a class="top_login__link">登录</a>，
     * 点开以后是 yqq-dialog，里面嵌了两个 OAuth iframe：
     *   QQ 登录  -> graph.qq.com/oauth2.0/authorize?client_id=100497308
     *   微信登录 -> open.weixin.qq.com/connect/qrconnect?appid=wx48db31d50e334801
     * 所以直接开首页，再由 LOGIN_CLICK_SCRIPT 帮用户把登录框点出来。
     */
    loginUrl: 'https://y.qq.com/',
    fallbackUrl: 'https://y.qq.com/',
    /*
     * 登录成功的判定不能只认 uin + qqmusic_key：
     * QQ 音乐的网页登录有时写的是 qm_keyst / p_tk，名字对不上就会一直认为没登录，
     * 表现为「扫完码窗口也不关」。所以分两组候选，任意一组命中就算登录。
     */
    readyAny: [
      ['qqmusic_key', 'qm_keyst', 'p_tk'],
      ['uin', 'p_uin', 'ptui_loginuin', 'luin'],
    ],
    // 兼容旧字段：需要同时命中的才叫 ready
    ready: [],
    host: ['y.qq.com', 'qq.com'],
    // 取凭证时要带回主站的 cookie
    apiBase: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
    referer: 'https://y.qq.com/',
  },
  kugou: {
    label: '酷狗音乐',
    /*
     * www.kugou.com/login/ 是 404，login-user.kugou.com 直接 403。
     * 首页右上角才有「登录」，点开是扫码框，所以开首页 + 脚本点击。
     */
    loginUrl: 'https://www.kugou.com/',
    fallbackUrl: 'https://www.kugou.com/',
    /*
     * 酷狗的 cookie 名在不同版本里不一样，实测过这些写法都出现过：
     *   KgUserToken / KugouToken / token / T   -> 令牌
     *   userid / UserId / KugouID / kugouid    -> 用户 ID
     * 所以不写死两个名字，而是分两组候选：任意一组命中就算登录。
     */
    readyAny: [
      ['KgUserToken', 'KugouToken', 'token', 'T', 'kg_token'],
      ['userid', 'UserId', 'KUGOUID', 'KugouID', 'kugouid', 'user_id'],
    ],
    // 兼容旧字段：需要同时命中的才叫 ready
    ready: [],
    host: ['kugou.com'],
    apiBase: 'https://wwwapi.kugou.com/',
    referer: 'https://www.kugou.com/',
  },
};

/**
 * 注入到登录窗口里的脚本：自动把登录框点出来。
 *
 * 两家的首页都要点一下才有二维码。用户不该自己在页面里找那个小小的「登录」。
 * 这个脚本只负责点击，真正的登录流程（扫码 / QQ / 微信）仍然走官网原生实现，
 * 所以腾讯、酷狗改版也不需要我们跟着改接口。
 */
const LOGIN_CLICK_SCRIPT = `
(() => {
  const clicked = [];
  const tryClick = (selectors, tag) => {
    for (const sel of selectors) {
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { continue; }
      if (!el) continue;
      const text = (el.textContent || '').trim();
      // 只点「登录」字样的东西，别误点到别的按钮
      if (text && !/登录|扫码|login/i.test(text)) continue;
      try {
        el.click();
        clicked.push(tag + ':' + sel);
        return true;
      } catch (_) {}
    }
    return false;
  };

  const alreadyOpen = () =>
    !!(document.querySelector('.yqq-dialog-wrap') ||
       document.querySelector('iframe[src*="graph.qq.com"]') ||
       document.querySelector('iframe[src*="open.weixin.qq.com"]'));

  const tick = () => {
    if (alreadyOpen()) return true;
    return tryClick(['.top_login__link', '.login-link', '[class*="login__link"]', 'a[class*="login"]'], 'qq') ||
           // 酷狗首页的登录入口实测是 class="cmhead1_d5 _login"
           tryClick(['._login', '.cmhead1_d5', '.header_login', '.top_login a', '[class*="login"] a'], 'kugou');
  };

  // 首页是 JS 渲染的，元素可能晚一点才出来，所以轮询而不是只试一次
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (tick() || tries > 20) clearInterval(timer);
  }, 700);

  window.__hxlLoginClicks = clicked;
  return 'installed';
})()
`;

/**
 * 找出登录框里的 OAuth 登录帧。
 * 渲染层用它告诉用户「现在弹的是 QQ 登录还是微信登录」。
 */
const LOGIN_IFRAME_SCRIPT = `
(() => {
  for (const frame of document.querySelectorAll('iframe')) {
    const src = frame.getAttribute('src') || '';
    if (src.indexOf('graph.qq.com/oauth2.0/authorize') !== -1) return { kind: 'qq', src: src };
    if (src.indexOf('open.weixin.qq.com/connect/qrconnect') !== -1) return { kind: 'wechat', src: src };
  }
  return null;
})()
`;

/**
 * 判断某个平台是否已登录。
 * - 有 readyAny：每组候选各取第一个命中的值，全组命中才算登录。
 * - 有 ready：所有名字都必须命中。
 * 同时返回实际取到的 cookie 值，供上层拼请求头。
 */
function checkLogin(config, bag) {
  if (Array.isArray(config.readyAny) && config.readyAny.length) {
    const picked = {};
    for (const group of config.readyAny) {
      const hit = group.find((name) => bag[name] !== undefined && bag[name] !== '');
      if (!hit) return { ok: false, cookies: {} };
      picked[hit] = bag[hit];
    }
    return { ok: true, cookies: picked };
  }
  if (Array.isArray(config.ready) && config.ready.length) {
    const ok = config.ready.every((name) => bag[name] !== undefined && bag[name] !== '');
    return ok
      ? { ok: true, cookies: Object.fromEntries(config.ready.map((n) => [n, bag[n]])) }
      : { ok: false, cookies: {} };
  }
  return { ok: false, cookies: {} };
}

function platformConfig(platform) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) throw new Error(`不支持的平台：${platform}`);
  return config;
}

/** 在 cookie 列表里找需要的键。 */
function pickCookies(cookies, names) {
  const bag = {};
  for (const cookie of cookies || []) {
    const name = cookie?.name;
    if (!name) continue;
    if (names.includes(name)) bag[name] = cookie.value;
  }
  return bag;
}

function hasAll(bag, names) {
  return names.every((name) => bag[name] !== undefined && bag[name] !== '');
}

/**
 * 读取会话：从加密存储里取之前保存的 cookie。
 * 返回 { platform, cookies: {...}, savedAt } 或 null。
 */
async function loadMusicSession(platform, loadSecret) {
  const config = platformConfig(platform);
  try {
    const raw = await loadSecret(`music-${platform}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    // 老版本按 ready 判定，新版本按 readyAny；两者都要能读出来
    const checked = checkLogin(config, parsed);
    if (checked.ok) return parsed;
    // 老版本存的数据里只有 __cookieHeader 也算数，别让升级把登录弄丢
    if (parsed.__cookieHeader || Object.keys(parsed).some((k) => k !== 'savedAt' && k !== '__cookieHeader')) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** 把 cookie 对象拼成请求头。 */
function cookieHeader(bag) {
  return Object.entries(bag)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * 用已保存的会话去验证一次是否仍然有效。
 * 各平台用一个最轻量的「需要登录」接口探测。
 */
async function verifyMusicSession(platform, session, timeoutMs = 12000) {
  const config = platformConfig(platform);
  const headers = {
    'user-agent': BROWSER_UA,
    referer: config.referer,
    cookie: cookieHeader(session),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (platform === 'qq') {
      // 需要登录的接口：拿自己的歌单，未登录会返回 code -1
      const response = await fetch(
        'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?hostuin=' +
          encodeURIComponent(session.uin || '') +
          '&format=json',
        { headers, signal: controller.signal }
      );
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const text = await response.text();
      if (/login":"on\*\*"|"code":-1|"code":-100/.test(text)) {
        return { ok: false, error: '登录已失效' };
      }
      return { ok: true };
    }

    // 酷狗：用户信息接口
    const response = await fetch('https://www.kugou.com/yy/index.php?r=user/info', {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const json = await response.json().catch(() => null);
    if (!json || json.status !== 1) return { ok: false, error: '登录已失效' };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || '网络错误' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  BROWSER_UA,
  PLATFORM_CONFIG,
  platformConfig,
  pickCookies,
  hasAll,
  checkLogin,
  loadMusicSession,
  cookieHeader,
  verifyMusicSession,
  LOGIN_CLICK_SCRIPT,
  LOGIN_IFRAME_SCRIPT,
};
