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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

/*
 * 接口 UA 和登录窗口 UA 必须分开。
 *
 * 登录窗口要让用户看到正常的桌面版米游社页面，所以用桌面 Chrome UA；
 * 但米游社的 OpenAPI 明确认「移动端 wv + miHoYoBBS/<版本>」这个 UA，
 * 用桌面 UA 调战绩接口会被风控直接挡掉（retcode 5003），
 * 报错只有一句「战绩接口返回 5003」，用户完全看不出是 UA 的问题。
 */
const RECORD_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 5 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36 miHoYoBBS/2.90.1';

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

/*
 * 米游社网页自己会带一组 x-rpc-* 头，其中 device_id 是浏览器生成的 GUID，
 * 生成一次就长期不变。少这几个头时战绩接口经常直接返回 5003（风控拒绝），
 * 而报错信息只有一句「战绩接口返回 5003」，用户完全看不出该怎么办。
 *
 * 这里按 userData 目录 + 主机名派生一个稳定的 GUID：
 * 每次启动都随机换一个反而更像机器人，固定下来才和真实浏览器一致。
 */
let cachedDeviceId = '';
function deviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  let seed = os.hostname();
  try {
    const { app } = require('electron');
    seed = `${app.getPath('userData')}|${os.hostname()}`;
  } catch {
    /* 非 Electron 环境（单测）下只用主机名 */
  }
  const hex = crypto.createHash('md5').update(seed, 'utf8').digest('hex');
  cachedDeviceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return cachedDeviceId;
}

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
          'User-Agent': RECORD_UA,
          'x-rpc-app_version': '2.90.1',
          'x-rpc-client_type': '5',
          'x-rpc-device_id': deviceId(),
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
 *
 * path 可以是相对路径，例如
 *   '/game_record/app/genshin/api/dailyNote?server=cn_gf01&role_id=xxx'
 * 也可以是完整 URL —— 崩坏3 的便笺在 act-api-takumi 上，和默认的
 * api-takumi-record 不是同一个宿主，所以允许直接传绝对地址。
 *
 * options.referer —— 覆盖 Referer。绝区零/崩坏3 走 act.mihoyo.com，
 *   原神/星铁走 webstatic.mihoyo.com，Referer 不对会被风控拦。
 * options.ds —— 是否带 DS2 头，默认带（服务器对多余头是忽略的）。
 */
/**
 * 从 cookie 串里取某一项的值（找不到返回空串）。
 *
 * 米游社网页会把设备指纹一起写进 cookie：`DEVICEFP`（指纹本体）、
 * `_MHYUUID`（网页的 device_id）。这两个值服务端会跟请求头交叉校验，
 * 头部自己编造一个对不上的指纹会被风控挡掉（retcode 5003）。
 */
function cookieValue(cookieStr, name) {
  for (const part of String(cookieStr || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

/**
 * 向米哈游的公共接口申领一个 device_fp（设备指纹）。
 *
 * 为什么必须做这件事：战绩接口（api-takumi-record）从 2024 年起校验
 * 「合法设备信息」，头部里塞 `0000000000000` 或随便编一个指纹会被直接
 * 打成 retcode 5003（原神）/ 10053（星铁）。Starward 就是这么解决的
 * （Scighost/Starward#669，commit f1d8b3a "device info and fingerprint"）。
 *
 * 申领流程（与 Starward 的 HyperionClient.GetDeviceFpAsync 一致）：
 *   POST https://public-data-api.mihoyo.com/device-fp/api/getFp
 *   body {device_id, seed_id, seed_time, platform, device_fp, app_name, ext_fields, bbs_device_id}
 *   返回 {code, msg, device_fp}
 * 拿到的 device_fp 直接塞进 x-rpc-device_fp，bbs_device_id 用同一个 device_id。
 */
let cachedDeviceFp = '';

/**
 * 指纹文件放在 userData 下：申领到的 device_fp 要长期复用。
 * 每次启动都重新申领一个新指纹，在米哈游风控看来就是「一天换八台手机」，
 * 反而更容易被判成异常账号（1034）。
 */
function deviceFpFile() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'device-fp.json');
  } catch {
    return '';
  }
}

function readSavedDeviceFp() {
  const file = deviceFpFile();
  if (!file) return '';
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof json.fp === 'string' ? json.fp : '';
  } catch {
    return '';
  }
}

function saveDeviceFp(fp) {
  const file = deviceFpFile();
  if (!file || !fp) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ fp, savedAt: Date.now() }), 'utf8');
  } catch {
    /* 写不进去就只留在内存里，下次启动重新申领 */
  }
}

function randomProductName() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let index = 0; index < 6; index += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function ensureDeviceFp(cookieStr) {
  if (cachedDeviceFp) return cachedDeviceFp;
  const saved = readSavedDeviceFp();
  if (saved) {
    cachedDeviceFp = saved;
    return cachedDeviceFp;
  }
  const uuid = cookieValue(cookieStr, '_MHYUUID') || deviceId();
  const productName = randomProductName();
  const extFields = JSON.stringify({
    proxyStatus: 0,
    isRoot: 0,
    romCapacity: '512',
    deviceName: 'Pixel5',
    productName,
    romRemain: '512',
    hostname: 'db1ba5f7c000000',
    screenSize: '1080x2400',
    isTablet: 0,
    aaid: '',
    model: 'Pixel5',
    brand: 'google',
    hardware: 'windows_x86_64',
    deviceType: 'redfin',
    devId: 'REL',
    serialNumber: 'unknown',
    sdCapacity: 125943,
    buildTime: '1704316741000',
    buildUser: 'cloudtest',
    simState: 0,
    ramRemain: '124603',
    appUpdateTimeDiff: 1716369357492,
    deviceInfo: `google/${productName}/redfin:13/TQ3A.230901.001/2311.40000.5.0:user/release-keys`,
    vaid: '',
    buildType: 'user',
    sdkVersion: '33',
    ui_mode: 'UI_MODE_TYPE_NORMAL',
    isMockLocation: 0,
    cpuType: 'arm64-v8a',
    isAirMode: 0,
    ringMode: 2,
    chargeStatus: 3,
    manufacturer: 'Google',
    emulatorStatus: 0,
    appMemory: '512',
    osVersion: '13',
    vendor: 'unknown',
    accelerometer: '',
    sdRemain: 123276,
    buildTags: 'release-keys',
    packageName: 'com.mihoyo.hyperion',
    networkType: 'WiFi',
    oaid: '',
    debugStatus: 1,
    ramCapacity: '125943',
    magnetometer: '',
    display: 'TQ3A.230901.001',
    appInstallTimeDiff: 1706444666737,
    packageVersion: '2.20.2',
    gyroscope: '',
    batteryStatus: 85,
    hasKeyboard: 10,
    board: 'windows',
  });
  const body = {
    device_id: crypto.randomBytes(8).toString('hex'),
    seed_id: crypto.randomUUID(),
    seed_time: String(Date.now()),
    platform: '2',
    device_fp: '0000000000000',
    app_name: 'bbs_cn',
    ext_fields: extFields,
    bbs_device_id: uuid,
  };
  try {
    const response = await fetch('https://public-data-api.mihoyo.com/device-fp/api/getFp', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': RECORD_UA,
        Referer: 'https://www.miyoushe.com/',
      },
      body: JSON.stringify(body),
    });
    const json = await readJson(response);
    // 实际返回：{retcode:0, message:'OK', data:{device_fp, code:200, msg:'ok'}}
    const fp = json && json.data && typeof json.data.device_fp === 'string' ? json.data.device_fp : '';
    if (json && json.retcode === 0 && fp) {
      cachedDeviceFp = fp;
      saveDeviceFp(fp);
    }
  } catch {
    /* 申领失败就退回 cookie 里网页自己的指纹，不影响主流程 */
  }
  return cachedDeviceFp;
}

async function fetchRecord(path, cookieStr, providerId = 'miyoushe', options = {}) {
  const provider = PROVIDERS[providerId] || PROVIDERS.miyoushe;
  const raw = String(path || '');
  const url = /^https?:\/\//i.test(raw) ? raw : `${provider.api.record}${raw}`;
  /*
   * 请求头逐项对齐 Starward 的 HyperionClient：
   * - Referer 按接口分组（原神/星铁 webstatic，绝区零/崩3 act）
   * - User-Agent 用米游社 APP 的 UA（miHoYoBBS/2.90.1），不是桌面的 Chrome UA
   * - x-rpc-device_fp 优先用 cookie 里米游社网页自己申领到的指纹
   * 这些头少一个都可能被风控打成 5003。
   * X-Requested-With 默认不带 —— Starward 的所有便笺/战绩接口都没有这个头
   * （只有绝区零的式舆/危局例外），带上去反而会被绝区零便笺拒成 10041。
   * 需要时显式传 withXrw: true。
   */
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Cookie: cookieStr,
    Referer: options.referer || provider.api.refererRecord,
    'User-Agent': options.ua || RECORD_UA,
    'x-rpc-app_version': options.appVersion || '2.90.1',
    'x-rpc-client_type': options.clientType || '5',
    'x-rpc-device_id': options.deviceId || cookieValue(cookieStr, '_MHYUUID') || deviceId(),
    'x-rpc-device_fp':
      options.deviceFp || (await ensureDeviceFp(cookieStr)) || cookieValue(cookieStr, 'DEVICEFP') || '0000000000000',
    /* Starward 的便笺/战绩请求都不带 x-rpc-lang，带上会被绝区零便笺判 10041 */
    ...(options.lang ? { 'x-rpc-lang': options.lang } : {}),
  };
  if (options.withXrw === true) {
    headers['X-Requested-With'] = 'com.mihoyo.hyperion';
  }
  if (options.origin) {
    headers.Origin = options.origin;
  }
  if (options.ds !== false) {
    headers.DS = createDs2(url, provider.api.salt2);
  }
  const response = await fetch(url, { headers });
  const json = await readJson(response);
  if (json.retcode !== 0) {
    const error = new Error(json.message || `战绩接口返回 ${json.retcode}`);
    error.retcode = json.retcode;
    error.url = url;
    throw error;
  }
  return json.data;
}

module.exports = {
  PROVIDERS,
  REQUIRED_COOKIE_KEYS,
  LOGIN_COOKIE_GROUPS,
  UA,
  RECORD_UA,
  cookieHeader,
  filterCookies,
  hasLoginCookie,
  cookieValue,
  createDs2,
  ensureDeviceFp,
  fetchAllRoles,
  fetchRolesDetailed,
  verifyCookie,
  fetchRecord,
};
