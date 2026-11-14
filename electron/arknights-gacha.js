'use strict';

/**
 * 明日方舟（鹰角）寻访记录同步。
 *
 * 和米哈游四款不是一套东西：
 *   米哈游 = SToken → genAuthKey → authkey → getGachaLog
 *   鹰角   = 账号 token → OAuth → 绑定列表 → U8 token → 角色登录 → ak-user-center Cookie
 *            → /user/api/inquiry/gacha/cate + /gacha/history
 *
 * 账号 token 的拿法（官方给的，用户自己粘一次就行）：
 *   1. 浏览器登录 https://user.hypergryph.com/userInfo
 *   2. 打开 https://web-api.hypergryph.com/account/info/hg ，把页面里的 content 整段复制过来
 *
 * 关键坑（都实测过）：
 *   - 旧的 `GET ak.hypergryph.com/user/api/inquiry/gacha?token=&page=` 已经下线了，
 *     现在会被前端路由兜成 HTML 外壳，所以必须走上面这条新链路。
 *   - `gacha/cate` 和 `gacha/history` 除了 x-account-token / x-role-token 两个头，
 *     还必须带 `ak-user-center` Cookie —— 少了它服务端直接回 {"message":"未登录","reason":"UN_LOGIN"}，
 *     而这个 Cookie 只能靠 role/login 那句 POST 换出来，所以顺序不能乱。
 *   - rarity 是 0 基（0=一星），写进库前要 +1。
 *   - 分页不是 page 而是 pos + gachaTs 游标，取上一页最后一条的这两个字段。
 */

const https = require('https');
/* 卡池元数据：poolId -> UP 名单。没有它判断不了欧非。 */
const arknightsPools = require('./arknights-pools');
const hypergryphSkland = require('./hypergryph-skland');
const fs = require('fs');
const path = require('path');

const ACCOUNT_API = 'https://as.hypergryph.com';
const BINDING_API = 'https://binding-api-account-prod.hypergryph.com';
const AK_API = 'https://ak.hypergryph.com';
const APP_CODE = 'be36d44aa36bfb5b';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;
const TIMEOUT = 20000;
const PAGE_GAP = 220;
/*
 * 干员头像。鹰角官方没给头像地址，干员表里也没有图片字段，
 * 只能用 PRTS 的静态资源镜像：/assets/char_avatar/<charId>.png。
 * 实测本地记录里出现过的 81 个干员 100% 都能取到，
 * 取不到时前端会回落到字牌，所以这里不做存在性预检（省 81 次请求）。
 */
const AVATAR_BASE = 'https://torappu.prts.wiki/assets/char_avatar/';

const GAME = 'arknights';
const GAME_NAME = '明日方舟';

function storePath(userData) {
  return path.join(userData, 'hypergryph-accounts.json');
}

function readStore(userData) {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(userData), 'utf8'));
    const accounts = Array.isArray(data.accounts)
      ? data.accounts.filter((item) => item && item.token && item.uid)
      : [];
    const activeId = typeof data.activeId === 'string' ? data.activeId : '';
    return { accounts, activeId: accounts.some((item) => item.id === activeId) ? activeId : (accounts[0]?.id || '') };
  } catch {
    return { accounts: [], activeId: '' };
  }
}

function writeStore(userData, store) {
  const file = storePath(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mask(text) {
  const value = String(text || '');
  if (value.length <= 10) return value ? '***' : '';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

function publicAccount(account) {
  /*
   * bindings：这个鹰角通行证下绑了哪几款游戏。
   *
   * 老记录（这个字段还没有的时候写进去的）没有 bindings，
   * 这里用明日方舟那条补一个，免得界面上突然空掉。
   */
  const bindings = Array.isArray(account.bindings) && account.bindings.length
    ? account.bindings
    : (account.uid
        ? [{
            appCode: GAME,
            appName: GAME_NAME,
            uid: String(account.uid),
            nickName: account.nickname || '',
            channelName: account.channel || '官服',
            roles: [],
          }]
        : []);
  return {
    id: account.id,
    uid: account.uid,
    nickname: account.nickname || '',
    channel: account.channel || '官服',
    tokenMasked: mask(account.token),
    boundAt: account.boundAt || 0,
    lastSyncAt: account.lastSyncAt || 0,
    bindings,
  };
}

function listAccounts(userData) {
  const store = readStore(userData);
  return { ok: true, game: GAME, activeId: store.activeId, accounts: store.accounts.map(publicAccount) };
}

/*
 * 从浏览器的会话 cookie 里换账号 token。
 *
 * 为什么需要这一步：让用户自己去 F12 或翻网页源码复制 token 是最劝退的一环。
 * 鹰角官网的登录态本身就在 cookie 里，主进程可以直接拿这份 cookie 去问
 * /account/info/hg —— 那个接口只认登录域，所以登录窗口用 user.hypergryph.com 打开就行。
 *
 * 返回 { ok:true, token } 或 { ok:false, reason }。不抛错：调用方要把它
 * 当成「自动拿不到，退回手填」的一种正常情况。
 */
async function tokenFromCookies(cookieHeaderValue) {
  const cookie = String(cookieHeaderValue || '').trim();
  if (!cookie) return { ok: false, reason: '登录窗口里还没有登录态' };
  /*
   * 先翻 cookie 本身。
   *
   * 实测：登录之后 .hypergryph.com 下会种一个 ACCOUNT cookie，它的值就是账号 token；
   * 而 /account/info/hg 返回的 data.content 里那串带下划线的值反而换不了 token
   * （basic/grant 都报 Token base64 校验失败）。所以 cookie 才是第一顺位，
   * 网页接口只当兜底 —— 顺序反过来的话，拿到的就是那条坏值。
   */
  const candidates = accountTokenCandidates(cookie);
  for (const candidate of candidates) {
    const verified = await verifyAccountToken(candidate);
    if (verified.ok) return { ok: true, token: candidate, channel: verified.channel, from: 'cookie' };
  }
  const fallback = await fetchAccountToken(cookie);
  if (fallback.ok) return fallback;
  return {
    ok: false,
    reason: candidates.length ? '登录态里的账号 token 用不了，请重新登录一次' : fallback.reason,
  };
}

/* 从 cookie 串里挑出可能是账号 token 的值（长的排前面，去掉明显不是的）。 */
function accountTokenCandidates(cookieValue) {
  const out = [];
  const push = (raw) => {
    const value = String(raw || '').trim();
    if (!value || value.length < 16) return;
    if (/^(true|false|null|undefined|\d+)$/i.test(value)) return;
    if (!out.includes(value)) out.push(value);
  };
  const pairs = String(cookieValue || '').split(';');
  const rows = [];
  for (const piece of pairs) {
    const index = piece.indexOf('=');
    if (index <= 0) continue;
    const name = piece.slice(0, index).trim();
    const value = piece.slice(index + 1).trim();
    rows.push({ name, value });
  }
  /* 名字像账号凭据的优先 */
  const tokenish = /^(ACCOUNT|HG_ACCOUNT|account_ticket|login_ticket|token)$/i;
  for (const row of rows) {
    if (!tokenish.test(row.name)) continue;
    push(row.value);
    try { push(decodeURIComponent(row.value)); } catch { /* 不是 URL 编码 */ }
  }
  /* 其余 cookie 兜底（站点改过 cookie 名，只认固定名字迟早会失效） */
  for (const row of rows) {
    if (tokenish.test(row.name)) continue;
    if (/track|uuid|device|seed|lang|sid|_ga|_gid/i.test(row.name)) continue;
    push(row.value);
  }
  return out.slice(0, 8);
}

/* 拿 basic 接口验一下这串 token 是不是真的能用。 */
async function verifyAccountToken(token) {
  const url = 'https://as.hypergryph.com/user/info/v1/basic?token=' + encodeURIComponent(token);
  const res = await new Promise((resolve) => {
    const target = new URL(url);
    const req = https.request(
      { hostname: target.hostname, path: target.pathname + target.search, method: 'GET', headers: { 'user-agent': UA, accept: 'application/json' } },
      (r) => {
        let raw = '';
        r.setEncoding('utf8');
        r.on('data', (chunk) => { raw += chunk; });
        r.on('end', () => resolve({ status: r.statusCode || 0, text: raw }));
      },
    );
    req.on('error', () => resolve({ status: 0, text: '' }));
    req.setTimeout(TIMEOUT, () => { req.destroy(); resolve({ status: 0, text: '' }); });
    req.end();
  });
  if (res.status !== 200) return { ok: false };
  try {
    const json = JSON.parse(res.text);
    if (Number(json.status) === 0 && json.data) {
      return { ok: true, channel: String(json.data.hgId || '') };
    }
  } catch { /* 不是 JSON */ }
  return { ok: false };
}

/*
 * 真正去 web-api.hypergryph.com/account/info/<channel> 拿 token。
 * 页面返回的是纯文本 token（不是 JSON），所以按 text 读。
 */
function fetchAccountToken(cookie) {
  const WEB_API = 'https://web-api.hypergryph.com';
  const channels = ['hg', 'ak-b'];
  const readOne = (channel) =>
    new Promise((resolve) => {
      const target = new URL(WEB_API + '/account/info/' + channel);
      const req = https.request(
        {
          hostname: target.hostname,
          path: target.pathname + target.search,
          method: 'GET',
          headers: {
            'user-agent': UA,
            accept: 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9',
            cookie,
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => resolve({ status: res.statusCode || 0, text: raw.trim() }));
        },
      );
      req.on('error', (error) => resolve({ status: 0, text: '', error: String(error.message || error) }));
      req.setTimeout(TIMEOUT, () => { req.destroy(); resolve({ status: 0, text: '', error: 'timeout' }); });
      req.end();
    });
  return (async () => {
    let last = '没读到登录态';
    for (const channel of channels) {
      const res = await readOne(channel);
      if (res.status === 200 && res.text && !/^\s*\{/.test(res.text)) {
        /* 正常返回就是裸 token；万一哪天包成 JSON，顺手兼容一下 */
        return { ok: true, token: res.text, channel };
      }
      if (res.status === 200 && /^\s*\{/.test(res.text)) {
        try {
          const parsed = JSON.parse(res.text);
          const token = parsed.token || parsed.data?.token || '';
          if (token) return { ok: true, token: String(token), channel };
        } catch {
          /* 不是 JSON，忽略 */
        }
      }
      last = res.status === 401 ? '登录态还没生效' : (res.error || ('HTTP ' + res.status));
    }
    return { ok: false, reason: last };
  })();
}

/*
 * 把鹰角那边的报错翻成人话。
 *
 * 它们的服务端是 Go 写的，token 格式不对时会把 validator 的原文吐出来
 * （"Key: 'InfoBasicReq.Token' Error:Field validation for 'Token' failed on the 'base64' tag"），
 * 这种字符串直接摊给用户看毫无意义，只会让人以为自己操作错了。
 */
function readable(json, fallback) {
  if (!json) return fallback;
  const msg = json.msg || json.message || json.error || '';
  if (typeof msg === 'string' && msg) {
    if (/base64|validator|Field validation|Key: '/i.test(msg)) {
      return '这一串不是有效的账号 token。要的是 /account/info/hg 页面里那一整串（通常很长），不是密码或验证码。';
    }
    if (/登录已过期|token错误|已失效/i.test(msg)) {
      return '这一串已经失效了。回浏览器重新登录一次，再打开 /account/info/hg 复制新的。';
    }
    return msg;
  }
  return fallback;
}

function statusOf(json) {
  if (!json) return NaN;
  if (typeof json.code === 'number') return json.code;
  if (typeof json.status === 'number') return json.status;
  return NaN;
}

/* ---------- HTTP + Cookie 罐 ---------- */

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: options.method || 'GET',
        headers: Object.assign(
          {
            'user-agent': UA,
            accept: 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9',
          },
          options.headers || {},
        ),
        timeout: TIMEOUT,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时了，检查一下网络')));
    req.on('error', (error) => reject(new Error('连不上鹰角的服务器：' + error.message)));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function collectCookies(headers, jar) {
  const set = headers && headers['set-cookie'];
  if (!set) return;
  for (const line of set) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => name + '=' + value).join('; ');
}

function postJson(url, payload, headers, jar) {
  return request(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json;charset=utf-8', cookie: cookieHeader(jar) }, headers || {}),
    body: JSON.stringify(payload),
  });
}

/* ---------- 认证链 ---------- */

async function authenticate(accountToken) {
  const token = String(accountToken || '').trim();
  if (!token) throw new Error('先粘一个鹰角账号 token');
  if (token.length < 20) throw new Error('这串看起来不像账号 token（太短了）');

  const jar = new Map();

  const basic = await request(ACCOUNT_API + '/user/info/v1/basic?token=' + encodeURIComponent(token), {
    headers: { cookie: cookieHeader(jar) },
  });
  collectCookies(basic.headers, jar);
  if (!basic.json) throw new Error('鹰角账号接口没返回 JSON，检查一下网络');
  if (statusOf(basic.json) !== 0) {
    throw new Error('这个账号 token 用不了：' + readable(basic.json, '已过期或复制不完整'));
  }

  const grant = await postJson(
    ACCOUNT_API + '/user/oauth2/v2/grant',
    { token, appCode: APP_CODE, type: 1 },
    null,
    jar,
  );
  collectCookies(grant.headers, jar);
  if (!grant.json) throw new Error('OAuth 授权没返回 JSON');
  if (statusOf(grant.json) !== 0) {
    throw new Error('OAuth 授权失败：' + readable(grant.json, '未知原因'));
  }
  const oauthToken = String(grant.json.data?.token || '');
  if (!oauthToken) throw new Error('OAuth 授权没有拿到 token');

  const binding = await request(
    BINDING_API + '/account/binding/v1/binding_list?token=' + encodeURIComponent(oauthToken),
    { headers: { cookie: cookieHeader(jar) } },
  );
  collectCookies(binding.headers, jar);
  if (!binding.json) throw new Error('绑定列表接口没返回 JSON');
  if (statusOf(binding.json) !== 0) {
    throw new Error('读取绑定列表失败：' + readable(binding.json, '未知原因'));
  }
  /*
   * 同一个鹰角通行证下面往往不止一款游戏：除了明日方舟，还会有《明日方舟：终末地》。
   * 以前这里只 find(appCode === 'arknights')，等于把终末地那条绑定直接扔了 ——
   * 账号中心里就只显示「明日方舟」，用户以为没绑上。
   *
   * 现在把整份 binding_list 收下来，明日方舟那条仍然当主账号（uid/昵称/渠道），
   * 其余游戏作为 bindings 一起存进账号记录，界面上逐个列出来。
   */
  const entries = (binding.json.data?.list || []).filter((item) => item && item.appCode);
  const bindings = entries.map((item) => {
    const first = Array.isArray(item.bindingList) ? item.bindingList[0] : null;
    return {
      appCode: String(item.appCode),
      appName: String(item.appName || ''),
      supportMultiServer: item.supportMultiServer === true,
      uid: first && first.uid ? String(first.uid) : '',
      nickName: first ? String(first.nickName || '') : '',
      channelName: first ? String(first.channelName || '官服') : '',
      isDeleted: first ? first.isDeleted === true : false,
      roles: first && Array.isArray(first.roles)
        ? first.roles.map((role) => ({
            serverId: String(role.serverId || ''),
            serverName: String(role.serverName || ''),
            roleId: String(role.roleId || ''),
            nickName: String(role.nickName || ''),
            level: Number(role.level) || 0,
          }))
        : [],
    };
  });
  const entry = entries.find((item) => item.appCode === GAME);
  const bound = entry && Array.isArray(entry.bindingList) ? entry.bindingList[0] : null;
  if (!bound || !bound.uid) {
    throw new Error('这个鹰角账号下没有查到《明日方舟》的角色，先在游戏里登录一次再试');
  }
  const uid = String(bound.uid);
  const nickname = String(bound.nickName || '');
  const channel = String(bound.channelName || '官服');

  const u8 = await postJson(
    BINDING_API + '/account/binding/v1/u8_token_by_uid',
    { token: oauthToken, uid },
    null,
    jar,
  );
  collectCookies(u8.headers, jar);
  if (!u8.json) throw new Error('U8 token 接口没返回 JSON');
  if (statusOf(u8.json) !== 0) {
    throw new Error('换取 U8 token 失败：' + readable(u8.json, '未知原因'));
  }
  const u8Token = String(u8.json.data?.token || '');
  if (!u8Token) throw new Error('没有拿到 U8 token');

  /* 这一句才是换 ak-user-center Cookie 的，缺了它后面全是「未登录」 */
  const login = await postJson(
    AK_API + '/user/api/role/login',
    { token: u8Token, source_from: '', share_type: '', share_by: '' },
    { referer: AK_API + '/user/gacha' },
    jar,
  );
  collectCookies(login.headers, jar);
  if (!login.json) throw new Error('角色登录没返回 JSON');
  if (statusOf(login.json) !== 0) {
    throw new Error('角色登录失败：' + readable(login.json, '未知原因'));
  }

  const info = await request(
    AK_API + '/user/api/role/info?source_from=&share_type=&share_by=',
    { headers: { 'x-role-token': u8Token, 'x-account-token': token, cookie: cookieHeader(jar) } },
  );
  collectCookies(info.headers, jar);
  if (!jar.get('ak-user-center')) {
    throw new Error('登录之后没拿到 ak-user-center 会话，鹰角那边可能改了接口');
  }

  /*
   * binding_list 里的 level 是「绑定时快照」——实测 2026/1/22 绑的终末地角色
   * 一直写着 Lv.59，游戏里早就是 60 了。真实等级要另走森空岛的 card/detail。
   *
   * 拿不到就原样返回：宁可显示快照值，也不要因为森空岛抖动导致整个绑定失败。
   */
  const liveBindings = await hypergryphSkland
    .enrichBindings(token, bindings)
    .catch(() => bindings);

  return { token, uid, nickname, channel, u8Token, jar, bindings: liveBindings };
}

async function fetchCategories(session) {
  const res = await request(AK_API + '/user/api/inquiry/gacha/cate?uid=' + encodeURIComponent(session.uid), {
    headers: {
      'x-account-token': session.token,
      'x-role-token': session.u8Token,
      cookie: cookieHeader(session.jar),
      referer: AK_API + '/user/gacha',
    },
  });
  collectCookies(res.headers, session.jar);
  if (!res.json) throw new Error('寻访类别接口没返回 JSON');
  if (statusOf(res.json) !== 0) throw new Error('读取寻访类别失败：' + readable(res.json, '未知原因'));
  const list = Array.isArray(res.json.data) ? res.json.data : [];
  return list.map((item) => ({ id: String(item.id || ''), name: String(item.name || '') })).filter((item) => item.id);
}

/*
 * 一条记录属于哪种寻访。
 *
 * 只看 category 不够用：鹰角把「限定寻访」这一类下又分了十来个子池，
 * 而 category 里往往只有 anniver_fest 这种活动名（甚至 classic），
 * 单看它会把「将雪投火」这种限定池错算成常驻池。
 *
 * 真正能分辨的是 poolId 前缀，实测样本：
 *   LIMITED_79_0_1        限定寻访
 *   LINKAGE_77_0_1        联动寻访
 *   CLASSIC_DOUBLE_78_0_2 中坚寻访
 *   NORMAL_...            普通寻访
 * 所以以 poolId 为准，category 只作兜底。
 */
/*
 * 卡池三大类，跟小黑盒那三个垫数一一对应：
 *   1 = 常驻（NORM / SINGLE / DOUBLE / ATTAIN / SPECIAL / RETURN）
 *   2 = 限定（LIMITED / LINKAGE —— 联动池也是限定，垫数跟限定不互通但用户看的是「限定」这栏）
 *   3 = 中坚（CLASSIC / FESCLASSIC / CLASSIC_ATTAIN）
 *
 * 为什么要分：三类的保底池是各自独立的 —— 在限定池垫了 50 抽，常驻池还是 0。
 * 混成一个 GachaType 算垫数，会把三个池的进度加起来，全是错的。
 */
function poolType(poolId, categoryId) {
  const pool = String(poolId || '').toUpperCase();
  if (pool.startsWith('LIMITED') || pool.startsWith('LINKAGE')) return 2;
  if (pool.startsWith('CLASSIC') || pool.startsWith('FESCLASSIC')) return 3;
  if (pool.startsWith('NORM') || pool.startsWith('SINGLE') || pool.startsWith('DOUBLE')) return 1;
  if (pool.startsWith('ATTAIN') || pool.startsWith('SPECIAL') || pool.startsWith('RETURN')) return 1;
  /* 认不出的新池型回落到 category 提示，再认不出就当常驻 */
  const text = String(categoryId || '').toLowerCase();
  if (text.includes('classic')) return 3;
  if (text.includes('limit') || text.includes('link')) return 2;
  return 1;
}

function formatTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  /* 鹰角给的是毫秒时间戳，固定按东八区落库，跟其它游戏的口径对齐 */
  const date = new Date(value + 8 * 3600 * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return (
    date.getUTCFullYear() +
    '-' + pad(date.getUTCMonth() + 1) +
    '-' + pad(date.getUTCDate()) +
    ' ' + pad(date.getUTCHours()) +
    ':' + pad(date.getUTCMinutes()) +
    ':' + pad(date.getUTCSeconds())
  );
}

function recordKey(item) {
  return 'ak-' + String(item.gachaTs || '') + '-' + String(item.pos ?? '') + '-' + String(item.charId || '');
}

async function fetchHistory(session, categoryId, options = {}) {
  const existingKeys = options.existingKeys || null;
  const stopOnExisting = options.stopOnExisting === true;
  const collected = [];
  let pos = null;
  let ts = null;

  for (let page = 0; page < 500; page += 1) {
    const params = new URLSearchParams({
      uid: session.uid,
      category: categoryId,
      size: String(options.size || PAGE_SIZE),
    });
    if (pos !== null && ts !== null) {
      params.set('pos', String(pos));
      params.set('gachaTs', String(ts));
    }
    const res = await request(AK_API + '/user/api/inquiry/gacha/history?' + params.toString(), {
      headers: {
        'x-account-token': session.token,
        'x-role-token': session.u8Token,
        cookie: cookieHeader(session.jar),
        referer: AK_API + '/user/gacha',
      },
    });
    collectCookies(res.headers, session.jar);
    if (!res.json) throw new Error('寻访记录接口没返回 JSON（可能是登录态掉了）');
    if (statusOf(res.json) !== 0) throw new Error('拉取寻访记录失败：' + readable(res.json, '未知原因'));

    const data = res.json.data || {};
    const list = Array.isArray(data.list) ? data.list : [];
    const last = list[list.length - 1];
    let stop = false;
    for (const item of list) {
      if (existingKeys && existingKeys.has(recordKey(item))) {
        if (stopOnExisting) {
          stop = true;
          break;
        }
        continue;
      }
      collected.push(item);
    }
    if (stop || data.hasMore !== true || !last) break;
    pos = last.pos;
    ts = last.gachaTs;
    if (typeof options.onProgress === 'function') {
      options.onProgress({ stage: 'page', page: page + 1, got: collected.length, category: categoryId });
    }
    await sleep(PAGE_GAP);
  }

  return collected;
}

function toRecords(items, categoryId, uid, poolTable = null) {
  const out = [];
  for (const item of items) {
    const time = formatTime(item.gachaTs);
    if (!time) continue;
    const poolId = String(item.poolId || '');
    const charId = String(item.charId || '');
    const charName = String(item.charName || item.poolName || '');
    /*
     * up：这一抽是不是当期 UP。
     *   true  = 命中 UP（欧）
     *   false = 歪了（非）
     *   null  = 这个池子没有 UP 概念（常驻/中坚），不作评价
     * 只对 6★ 判定 —— 五星也判会让人误以为「出五星不算欧」。
     */
    const isSix = Number(item.rarity) + 1 === 6;
    const up = isSix && poolTable ? arknightsPools.judgeUp(poolTable, poolId, charId, charName) : null;
    out.push({
      Uid: String(uid),
      Id: recordKey(item),
      Name: charName,
      Time: time,
      ItemId: charId,
      ItemType: poolId,
      RankType: Number(item.rarity) + 1 || 0,
      /* 逐条按 poolId 判，不再让整类共用一个 gachaType */
      GachaType: poolType(poolId, categoryId),
      poolName: String(item.poolName || ''),
      /* isNew：鹰角自己标的「首次获得」，比自己算可靠 */
      isNew: item.isNew === true,
      /* pos：同一次十连里的序号，排序时还原真实抽卡顺序用 */
      pos: Number(item.pos) || 0,
      /* icon：前端 gachaAvatarHtml / gachaTileHtml 直接认这个字段 */
      icon: charId ? AVATAR_BASE + encodeURIComponent(charId) + '.png' : '',
      up,
    });
  }
  return out;
}

function bindAccount(userData, input = {}) {
  return (async () => {
    const session = await authenticate(input.token);
    const store = readStore(userData);
    const id = String(session.uid);
    const existing = store.accounts.find((item) => item.id === id) || null;
    const record = {
      id,
      uid: session.uid,
      nickname: session.nickname || existing?.nickname || '',
      channel: session.channel || existing?.channel || '官服',
      token: session.token,
      boundAt: existing?.boundAt || Date.now(),
      lastSyncAt: existing?.lastSyncAt || 0,
      /* 同一通行证下的全部游戏绑定（明日方舟 / 终末地 …），账号中心要逐个列出来 */
      bindings: session.bindings || [],
    };
    const accounts = existing
      ? store.accounts.map((item) => (item.id === id ? record : item))
      : [...store.accounts, record];
    writeStore(userData, { accounts, activeId: id });
    return { ok: true, account: publicAccount(record), created: !existing };
  })();
}

function removeAccount(userData, id) {
  const store = readStore(userData);
  const accounts = store.accounts.filter((item) => item.id !== String(id || ''));
  writeStore(userData, {
    accounts,
    activeId: store.activeId === String(id) ? (accounts[0]?.id || '') : store.activeId,
  });
  return { ok: true };
}

function setActiveAccount(userData, id) {
  const store = readStore(userData);
  if (!store.accounts.some((item) => item.id === String(id || ''))) {
    return { ok: false, error: '没有这个账号' };
  }
  writeStore(userData, { accounts: store.accounts, activeId: String(id) });
  return { ok: true, activeId: String(id) };
}

/**
 * 拉一轮寻访记录。
 * 增量模式遇到已经存过的记录就停，全量模式会把四个类别都翻到底。
 */
async function syncAccount(userData, options = {}) {
  const store = readStore(userData);
  if (!store.accounts.length) {
    return { ok: false, needToken: true, error: '还没绑鹰角账号。点「账号 token」把那一串粘进来就能长期同步。' };
  }
  const account =
    (options.accountId && store.accounts.find((item) => item.id === String(options.accountId))) ||
    store.accounts.find((item) => item.id === store.activeId) ||
    store.accounts[0];

  const gachaImport = require('./gacha-import');
  const importsFile = options.importsPath || gachaImport.importsPath(userData);
  const existing = gachaImport.readImportGroups(importsFile);
  const knownKey = new Map();
  for (const group of existing) {
    if (group.game !== GAME || String(group.uid) !== String(account.uid)) continue;
    for (const record of group.records || []) knownKey.set(String(record.Id), true);
  }
  const before = existing.find((group) => group.game === GAME && String(group.uid) === String(account.uid));
  const beforeCount = before ? (before.records || []).length : 0;

  const session = await authenticate(account.token);
  const categories = await fetchCategories(session);
  if (!categories.length) throw new Error('这个账号下没有查到任何寻访类别');

  /*
   * 卡池表用来判断「这一抽是不是当期 UP」。拉不到就用旧缓存兜底，
   * 再拉不到就是空表 —— 那时候 up 全是 null，界面上不打欧非标，
   * 但同步本身照常完成，不能因为一个元数据源挂了就整条链失败。
   */
  const poolCache = path.join(userData, arknightsPools.POOL_FILE);
  const full = options.full === true;
  let poolTable = await arknightsPools.loadPools(poolCache, full).catch(() => null);

  /*
   * 先把原始记录全拉下来，再统一判定 UP。
   *
   * 顺序很重要：只有在拿到本轮的真实 poolId 之后，才知道卡池表里是不是
   * 缺了新池子。边拉边判的话，遇到新版本刚开的池子（表还是一天前的），
   * 整池的六星全被判成 up=null，界面上不打欧非标 —— 用户看到的就是
   * 「新池不显示 UP」，得等第二天缓存过期才自己好。
   */
  const raw = [];
  for (const category of categories) {
    const items = await fetchHistory(session, category.id, {
      existingKeys: full ? null : knownKey,
      stopOnExisting: !full,
      onProgress: options.onProgress,
    });
    for (const item of items) raw.push({ item, category });
    if (typeof options.onProgress === 'function') {
      options.onProgress({ stage: 'category', category: category.name, got: raw.length });
    }
    await sleep(PAGE_GAP);
  }

  /*
   * 卡池表缺池就强制刷一次。开源拆包仓库跟着游戏更新，新池当天就有，
   * 所以这一步能把「新池第一天不显示 UP」直接补上，不用等 TTL 过期。
   */
  const known = new Set(raw.map((entry) => String(entry.item.poolId || '')).filter(Boolean));
  const missing = [...known].filter((poolId) => !arknightsPools.poolInfo(poolTable, poolId));
  if (missing.length) {
    const refreshed = await arknightsPools.loadPools(poolCache, true).catch(() => null);
    if (refreshed) poolTable = refreshed;
  }

  const collected = [];
  for (const entry of raw) {
    const records = toRecords([entry.item], entry.category.id, account.uid, poolTable);
    collected.push(...records);
  }

  const incoming = collected.length ? [{ game: GAME, uid: String(account.uid), records: collected }] : [];
  let merged = gachaImport.mergeGroups(existing, incoming);

  /*
   * 回填：把整组记录的 up / icon 按当前卡池表重算一遍。
   *
   * 增量同步遇到已有记录就停，不会再算它们 —— 一条记录如果当初
   * 是在卡池表还没有这个池子的时候写的（up=null），之后不管同步多少次
   * 都永远是 null，界面上就永远缺 UP 标。这里纯本地重算，不发请求。
   */
  const group = merged.find((item) => item.game === GAME && String(item.uid) === String(account.uid));
  if (group && poolTable) {
    let touched = 0;
    group.records = (group.records || []).map((record) => {
      if (Number(record.RankType) !== 6) return record;
      const poolId = String(record.ItemType || '');
      const up = arknightsPools.judgeUp(poolTable, poolId, String(record.ItemId || ''), String(record.Name || ''));
      const icon = record.icon || (record.ItemId
        ? AVATAR_BASE + encodeURIComponent(String(record.ItemId)) + '.png'
        : '');
      if (up === record.up && icon === record.icon) return record;
      touched += 1;
      return Object.assign({}, record, { up, icon });
    });
    if (touched) {
      group.count = group.records.length;
      merged = merged.slice();
      gachaImport.saveImportGroups(importsFile, merged);
    }
  }

  const after = merged.find((group) => group.game === GAME && String(group.uid) === String(account.uid));
  const afterCount = after ? (after.records || []).length : 0;

  const accounts = store.accounts.map((item) =>
    item.id === account.id
      ? Object.assign({}, item, {
          lastSyncAt: Date.now(),
          /* 顺手刷新绑定列表：老记录里没有 bindings，同步一次就补齐 */
          bindings: session.bindings || item.bindings || [],
        })
      : item,
  );
  writeStore(userData, { accounts, activeId: store.activeId || account.id });

  return {
    ok: true,
    game: GAME,
    uid: String(account.uid),
    imported: Math.max(0, afterCount - beforeCount),
    total: afterCount,
    categories: categories.length,
  };
}

module.exports = {
  GAME,
  GAME_NAME,
  storePath,
  readStore,
  listAccounts,
  bindAccount,
  removeAccount,
  setActiveAccount,
  syncAccount,
  authenticate,
  tokenFromCookies,
  accountTokenCandidates,
  verifyAccountToken,
  fetchAccountToken,
  fetchCategories,
  fetchHistory,
  toRecords,
  formatTime,
  poolType,
  recordKey,
};
