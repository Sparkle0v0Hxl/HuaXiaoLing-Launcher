'use strict';

const crypto = require('node:crypto');

/**
 * 登录账号的歌单：QQ 音乐 / 酷狗。
 *
 * 这两家的歌单接口都要求带上登录 cookie，且返回结构不稳定，
 * 所以这里做两件事：
 *   1. 从已保存的会话里取 uin / userid 与 cookie；
 *   2. 用多组候选接口依次尝试，任何一组成功就返回标准化后的歌单。
 *
 * 拿不到时返回空数组 + 明确的 reason，界面据此提示，
 * 而不是让用户看到一片空白。
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TIMEOUT = 15000;

function withTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * 给任意 Promise 套一个硬上限。
 *
 * 抓包这条路要等网页自己把请求发出去：页面被墙、登录跳转、或者请求半路卡住时，
 * await 会永远不落地，界面上就一直是「正在读取」。所有会碰网络的等待都套这层，
 * 到点直接抛，交给上层当失败处理——绝不能无限挂着。
 */
function withDeadline(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label || '读取'}超时（${Math.round(ms / 1000)} 秒没有响应）`));
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function fetchText(url, headers) {
  const { signal, done } = withTimeout();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json, text/plain, */*', ...headers },
      signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    /*
     * QQ 音乐的 splcloud 接口声明 charset=gb2312，直接 response.text() 会按 UTF-8
     * 解码出乱码。按 Content-Type 里的 charset 重新解码一次，没有就按原样返回。
     */
    const buffer = await response.arrayBuffer();
    const charset = String(response.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1] || '';
    if (/^gb/i.test(charset)) {
      return new TextDecoder('gb18030').decode(buffer);
    }
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } finally {
    done();
  }
}

async function fetchJson(url, headers) {
  const text = await fetchText(url, headers);
  try {
    return JSON.parse(text);
  } catch {
    // 有些接口返回 jsonp，剥掉包裹
    const match = text.match(/^[\w$.]+\((.*)\)\s*;?\s*$/s);
    if (match) return JSON.parse(match[1]);
    throw new Error('返回内容不是 JSON');
  }
}

function httpsify(url) {
  let out = String(url || '').replace(/^http:/i, 'https:');
  // 酷我图片的 kwcdn 子域不提供 https（实测 img1.kwcdn.kuwo.cn 的 https 直接握手失败，
  // 但同资源在 img1.kuwo.cn 的 https 上是 200）。把 imgN.kwcdn.kuwo.cn 主机换回 imgN.kuwo.cn。
  out = out.replace(/\/\/(img\d+)\.kwcdn\.kuwo\.cn\//i, '//$1.kuwo.cn/');
  return out;
}

/** 把 cookie 头拆成 [name, value] 对。 */
function cookiePairs(header) {
  const out = [];
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out.push([name, value]);
  }
  return out;
}

/**
 * 两家平台真正认的 cookie 名，和我们从登录窗口里存下来的名字经常对不上：
 *   QQ 音乐：网页写 qqmusic_key，接口只认 qm_keyst；网页写 p_uin(o123…)，接口要纯数字 uin
 *   酷狗   ：网页写 KgUserToken / T，接口只认 token；网页写 KugouID / UserId，接口只认 userid
 * 名字对不上，服务端一律当没登录（QQ 回 500003，酷狗回 Access Deny）。
 * 所以发请求前先按平台补齐别名，缺哪个补哪个，原来有的不动。
 */
function canonicalCookieHeader(platform, session) {
  const bag = session || {};
  const map = new Map();
  for (const [name, value] of cookiePairs(bag.__cookieHeader)) if (!map.has(name)) map.set(name, value);
  for (const [key, value] of Object.entries(bag)) {
    if (key === '__cookieHeader' || key === 'savedAt') continue;
    if (value == null || value === '') continue;
    if (!map.has(key)) map.set(key, String(value));
  }

  const digits = (v) => String(v).trim().replace(/^o/i, '').replace(/\D/g, '');
  const alias = (target, sources, transform) => {
    const current = map.get(target);
    if (current != null && current !== '') return;
    for (const name of sources) {
      const value = map.get(name);
      if (value == null || value === '') continue;
      map.set(target, transform ? transform(value) : value);
      return;
    }
  };

  if (platform === 'qq') {
    alias('uin', ['p_uin', 'ptui_loginuin', 'luin'], digits);
    alias('p_uin', ['uin', 'ptui_loginuin', 'luin'], (v) => 'o' + digits(v));
    alias('ptui_loginuin', ['uin', 'p_uin', 'luin'], digits);
    alias('luin', ['uin', 'p_uin', 'ptui_loginuin'], digits);
    alias('qm_keyst', ['qqmusic_key', 'p_tk'], (v) => String(v).trim());
    alias('qqmusic_key', ['qm_keyst', 'p_tk'], (v) => String(v).trim());
  } else if (platform === 'kugou') {
    // 酷狗网页登录实际写的名字是：t（token）、KugooID（uid），
    // 外加一个复合 cookie KuGoo（形如 uid=...&token=...&username=...）。
    // 之前按 KgUserToken / KugouID 去找，一个都对不上，于是永远「没有用户 ID」。
    const getCI = (name) => {
      const lower = String(name).toLowerCase();
      for (const [key, value] of map.entries()) {
        if (key.toLowerCase() === lower && value) return String(value);
      }
      return '';
    };
    let composite = getCI('KuGoo');
    if (composite) {
      // KuGoo 的值整体是 URL 编码的（uid%3D...%26token%3D...），先解码再拆
      try {
        composite = decodeURIComponent(composite);
      } catch {
        /* 原样使用 */
      }
      const parsed = {};
      for (const seg of composite.split(/[&;|]/)) {
        const eq = seg.indexOf('=');
        if (eq <= 0) continue;
        const key = seg.slice(0, eq).trim().toLowerCase();
        let value = seg.slice(eq + 1).trim();
        try {
          value = decodeURIComponent(value);
        } catch {
          /* 原样保留 */
        }
        if (key) parsed[key] = value;
      }
      const push = (target, value) => {
        if (value && !map.has(target)) map.set(target, String(value));
      };
      push('token', parsed.token);
      push('userid', parsed.uid || parsed.userid);
      push('username', parsed.username || parsed.nickname);
      push('mid', parsed.mid);
    }
    alias('token', ['t', 'T', 'KgUserToken', 'KugouToken', 'kg_token', 'KgToken'], (v) => String(v).trim());
    alias(
      'userid',
      ['KugooID', 'KugouID', 'KgUserID', 'KgUid', 'kugouid', 'KUGOUID', 'user_id', 'uid'],
      digits
    );
    if (!map.get('token') && getCI('t')) map.set('token', getCI('t'));
    if (!map.get('userid') && getCI('KugooID')) map.set('userid', digits(getCI('KugooID')));
  } else if (platform === 'kuwo') {
    alias('userid', ['t3kwid', 'UserId', 'uid'], digits);
  }

  return [...map.entries()].map(([name, value]) => name + '=' + value).join('; ');
}

/**
 * 出错时给界面看的会话摘要：只报 cookie 名字和尾号，不泄露值。
 * 用户把这段发回来，就能判断是「没登录」还是「名字对不上」。
 */
function describeSession(platform, session) {
  const pairs = cookiePairs(canonicalCookieHeader(platform, session));
  const names = pairs.map(([name]) => name);
  const tail = (name) => {
    const found = pairs.find(([n]) => n === name);
    if (!found) return '无';
    const value = String(found[1]);
    return value ? '有(' + value.slice(-2) + ')' : '空';
  };
  const parts = ['cookie 名 ' + (names.join(',') || '空')];
  if (platform === 'qq') parts.push('uin ' + tail('uin'), 'qm_keyst ' + tail('qm_keyst'));
  else parts.push('userid ' + tail('userid'), 'token ' + tail('token'));
  return parts.join('；');
}

/**
 * 酷狗移动站（m.kugou.com）只对手机 UA 返回 JSON，
 * 用桌面 UA 会拿到整页 HTML 或干脆 Access Deny。
 */
const KUGOU_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

/*
 * 两组请求头，酷狗这两套域名都认「来源 + 手机 UA」，缺一样就回 Access Deny：
 *   m.kugou.com      —— 走 https
 *   mobilecdn        —— 只走 http（实测 https 握手失败，直接 fetch failed）
 * 每次请求必须整套带上，不能只给 UA 不给 referer。
 */
const KUGOU_M_HEADERS = { referer: 'https://m.kugou.com/', 'user-agent': KUGOU_MOBILE_UA };
const KUGOU_CDN_HEADERS = { referer: 'http://m.kugou.com/', 'user-agent': KUGOU_MOBILE_UA };

/** mobilecdn 的曲目接口每页上限 500，实测生效（pagesize=100 只会返回 100 条）。 */
const KUGOU_SONG_PAGE_SIZE = 500;
/** 翻页保护：500×20 = 一万首，正常歌单到不了，纯粹防止接口异常时无限翻。 */
const KUGOU_SONG_MAX_PAGES = 20;

/** QQ 公开详情每页写死 30 条（song_num 调大也没用）， */
const QQ_SONG_PAGE_SIZE = 30;
/** 同样给个保险：30×400 = 1.2 万首。每页小、页数多，所以翻得比酷狗慢。 */
const QQ_SONG_MAX_PAGES = 400;

/**
 * 酷狗未登录时会在 JSON 前面糊一句 "Access Deny ! No Actions !"，
 * 直接 JSON.parse 必炸。这里先找到第一个 { 或 [，再解析。
 */
function parseKugouJson(text) {
  const raw = String(text || '').trim();
  const start = raw.search(/[[{]/);
  if (start < 0) throw new Error(raw.slice(0, 60) || '返回内容为空');
  const body = raw.slice(start);
  try {
    return JSON.parse(body);
  } catch {
    const match = body.match(/^[\w$.]+\((.*)\)\s*;?\s*$/s);
    if (match) return JSON.parse(match[1]);
    throw new Error('返回内容不是 JSON');
  }
}

/**
 * 在酷狗返回的任意结构里挖「歌单数组」。
 * 它的字段名换过很多次，所以不写死路径，按特征递归找：
 * 数组里的对象带 specialid / listid / global_collection_id 之一，且带名字。
 */
function pickKugouPlaylists(json) {
  const out = [];
  const seen = new Set();
  const nameOf = (item) =>
    String(item.specialname || item.listname || item.name || item.title || '').trim();
  const idOf = (item) =>
    String(item.specialid || item.listid || item.global_collection_id || item.id || '').trim();
  const isList = (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item && typeof item === 'object' && idOf(item) && nameOf(item));
  const walk = (node, depth) => {
    if (!node || depth > 5) return;
    if (isList(node)) {
      for (const item of node) {
        const id = idOf(item);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          name: nameOf(item),
          cover: httpsify(String(item.imgurl || item.img || item.cover || '').replace('{size}', '240')),
          count: Number(item.songcount || item.song_count || item.count || 0),
          creator: String(item.nickname || item.username || ''),
        });
      }
      return;
    }
    if (Array.isArray(node) || typeof node !== 'object') return;
    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };
  walk(json, 0);
  return out;
}

/** 酷狗「我的歌单」JSON 接口：登录态下返回自己的歌单，未登录返回 Access Deny。 */
const KUGOU_MYLIST_URL = 'https://m.kugou.com/plist/mylist?json=true';

/**
 * 把底层的英文报错翻成人话。
 * 界面上直接显示这些 reason，用户看到 `Unexpected token 'A', "Access Deny !!!"…`
 * 只会一头雾水，所以统一在这里收拾一遍。
 */
function humanizeError(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '未知原因';
  const lower = text.toLowerCase();
  /*
   * QQ 音乐的 500003 = 服务端认为这次请求没有登录态。
   * 直接显示 code 用户看不懂，翻成「登录过期，重新登录」。
   */
  if (text.includes('500003')) return '对方认为还没有登录（登录已过期），请重新登录';
  if (lower.includes('access deny')) return '对方服务器拒绝了这次请求（多为登录已过期）';
  if (lower.includes('unexpected token') || lower.includes('not valid json') || text.includes('不是 JSON')) {
    return '对方服务器返回的不是有效数据（可能被当成未登录）';
  }
  if (lower.includes('http 404')) return '接口地址已经失效（对方改版了）';
  if (lower.includes('http 403')) return '对方拒绝了访问（登录状态可能已过期）';
  if (lower.includes('http 5')) return '对方服务器暂时出错，稍后再试';
  if (lower.includes('timeout') || lower.includes('abort')) return '请求超时，可能是网络不通';
  if (lower.includes('fetch failed') || lower.includes('enotfound')) return '网络连接失败，请检查网络';
  return text;
}

/**
 * QQ 音乐登录态里，歌单接口不只要 uin + cookie：
 * musicu.fcg 的 comm 里还要带上 qm_keyst（= qqmusic_key），否则一律 500003。
 */
function qqLoginKeys(session) {
  const bag = session || {};
  // 扫码后浏览器会同时写 qqmusic_key 和 qm_keyst。接口 comm.authst 认的是
  // 新鲜的 qm_keyst；之前优先取 qqmusic_key，实际拿到旧值，于是永远 500003。
  for (const name of ['qm_keyst', 'qqmusic_key']) {
    const cached = String(bag[name] || '').trim();
    if (cached) return cached;
  }
  const header = String(bag.__cookieHeader || '');
  const match = header.match(/(?:^|;\s*)(?:qm_keyst|qqmusic_key)=([^;]+)/);
  return match ? decodeURIComponent(match[1]).trim() : '';
}

/* ------------------------------------------------------------------ */
/* QQ 音乐                                                             */
/* ------------------------------------------------------------------ */

/**
 * QQ 的 uin 有多种写法：cookie 里是 o开头/纯数字，接口要纯数字。
 * 这里统一成纯数字字符串。
 */
function normalizeQqUin(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const digits = text.replace(/^o/i, '').replace(/\D/g, '');
  // p_uin 是 o0123456789 这种，去掉前导 0，接口只认真实 QQ 号
  return digits.replace(/^0+(?=\d)/, '');
}

/**
 * QQ 音乐现在的 comm 由页面统一补两个 hash：
 *   g_tk                = hash33(skey || qqmusic_key)
 *   g_tk_new_20200303   = hash33(qqmusic_key || p_skey || skey || p_lskey || lskey)
 * 之前误把 qm_keyst 当 hash 种子，服务端于是一律回 500003，看起来像没登录。
 */
function qqHash33(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0x7fffffff;
  }
  return hash & 0x7fffffff;
}

function qqCookieValue(session, names) {
  const pairs = cookiePairs(canonicalCookieHeader('qq', session));
  for (const name of names) {
    const hit = pairs.find(([n]) => n.toLowerCase() === String(name).toLowerCase());
    if (hit && String(hit[1] || '').trim()) return String(hit[1]).trim();
  }
  return '';
}

function qqGtkOld(session) {
  return qqHash33(qqCookieValue(session, ['skey', 'qqmusic_key']));
}

function qqGtkNew(session) {
  return qqHash33(qqCookieValue(session, ['qqmusic_key', 'p_skey', 'skey', 'p_lskey', 'lskey']));
}

function qqComm(session, uin) {
  return {
    ct: 24,
    cv: 4747474,
    uin: Number(uin) || 0,
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 1,
    g_tk: qqGtkOld(session),
    g_tk_new_20200303: qqGtkNew(session),
  };
}

async function qqMyPlaylists(session) {
  // uin 以补齐别名后的 cookie 头为准：网页常常只写 p_uin(o123…)
  const cookie = canonicalCookieHeader('qq', session);
  const headerUin = (cookiePairs(cookie).find(([n]) => n === 'uin') || [])[1] || '';
  const uin = normalizeQqUin(
    headerUin || session.uin || session.p_uin || session.ptui_loginuin || session.luin || ''
  );
  if (!uin) throw new Error('登录信息里没有 QQ 号，请重新登录（' + describeSession('qq', session) + '）');

  const headers = {
    referer: 'https://y.qq.com/',
    origin: 'https://y.qq.com',
    cookie,
  };
  const gtk = qqGtkOld(session);

  // 依次尝试；每一组都把失败原因带上，界面直接显示，方便一眼看出是
  // cookie 不全（服务端当未登录）还是接口改版（返回结构变了）。
  // 顺序：先用 musicu.fcg（现代接口，带网页同款 g_tk），再退回老公开接口。
  const candidates = [
    {
      name: 'musicu.mine',
      url: () =>
        'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&g_tk=' + gtk + '&data=' +
        encodeURIComponent(
          JSON.stringify({
            comm: qqComm(session, uin),
            req_1: {
              module: 'music.mine.PlaylistAssembleServer',
              method: 'get_mine_playlist',
              param: { uin, offset: 0, limit: 100, only_self: 1 },
            },
            req_2: {
              module: 'music.mine.PlaylistAssembleServer',
              method: 'get_collect_playlist',
              param: { uin, offset: 0, limit: 100 },
            },
          })
        ),
      pick: (json) => {
        const out = [];
        for (const node of ['req_1', 'req_2']) {
          const data = json?.[node]?.data || {};
          for (const key of ['v_playlist', 'list', 'v_list', 'playlist']) {
            if (Array.isArray(data[key])) out.push(...data[key]);
          }
        }
        return out;
      },
      map: (item) => ({
        id: String(item.tid || item.dissid || item.id || ''),
        name: String(item.dirName || item.dissname || item.name || item.title || ''),
        cover: httpsify(item.picUrl || item.diss_cover || item.logo || item.cover || ''),
        count: Number(item.songNum || item.song_count || item.songnum || item.total || 0),
        creator: String(item.nick || item.creator?.nick || ''),
      }),
    },
    {
      name: 'musicu.PlaylistInfoServer',
      url: () =>
        'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&g_tk=' + gtk + '&data=' +
        encodeURIComponent(
          JSON.stringify({
            comm: qqComm(session, uin),
            req_0: {
              module: 'music.playlist.PlaylistInfoServer',
              method: 'Get',
              param: { uin, offset: 0, size: 50, sort: 1 },
            },
          })
        ),
      pick: (json) => {
        const data = json?.req_0?.data;
        const list = data?.v_playlist || data?.list || data?.disslist || [];
        return list;
      },
      map: (item) => ({
        id: String(item.dissid || item.tid || item.id || ''),
        name: String(item.dissname || item.name || item.title || ''),
        cover: httpsify(item.diss_cover || item.logo || item.cover || ''),
        count: Number(item.song_count || item.songnum || item.total || 0),
        creator: String(item.nick || item.creator?.nick || ''),
      }),
    },
    {
      // 老 c.y.qq.com 公开接口：只要 uin 就能读「我创建的歌单」，
      // 但对新版登录态常常返回空 disslist，所以排最后兜底。
      name: 'fcg_user_created_diss',
      url: () =>
        'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?hostuin=' +
        encodeURIComponent(uin) +
        '&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0',
      pick: (json) => json?.data?.disslist || json?.disslist || [],
      map: (item) => ({
        id: String(item.dissid || ''),
        name: String(item.diss_name || item.dissname || ''),
        cover: httpsify(item.diss_cover || ''),
        count: Number(item.song_cnt || item.songnum || 0),
        creator: String(item.nick || ''),
      }),
    },
  ];

  const errors = [];
  for (const candidate of candidates) {
    try {
      const target = candidate.url();
      const withGtk =
        target.includes('musicu.fcg') && !target.includes('g_tk=')
          ? target + '&g_tk=' + gtk
          : target;
      const json = await fetchJson(withGtk, headers);
      const list = candidate.pick(json);
      if (Array.isArray(list) && list.length) {
        const mapped = list.map(candidate.map).filter((item) => item.id && item.name);
        if (mapped.length) return mapped;
      }
      // 结构对但列表为空：记下来，别让它被后面的网络错误顶掉
      // musicu 的回包按 req_0/req_1/req_2 分片，逐个看，别只盯 req_0
      const code = json?.req_1?.code || json?.req_2?.code || json?.req_0?.code || json?.code || '';
      const subcode =
        json?.req_1?.subcode || json?.req_2?.subcode || json?.req_0?.subcode || '';
      if (String(code || '') === '500003') {
        errors.push(`${candidate.name}: 服务端认为还没登录（code 500003）`);
      } else {
        errors.push(
          `${candidate.name}: 返回空歌单${code ? `（code ${code}${subcode ? '/' + subcode : ''}）` : ''}`
        );
      }
    } catch (error) {
      errors.push(`${candidate.name}: ${humanizeError(error.message)}`);
    }
  }
  throw new Error(
    (errors.join('；') || '没有读取到歌单') + '（' + describeSession('qq', session) + '）'
  );
}

async function qqPlaylistSongs(session, dissId) {
  const cookie = canonicalCookieHeader('qq', session);
  const headers = { referer: 'https://y.qq.com/', cookie };
  const headerUin = (cookiePairs(cookie).find(([n]) => n === 'uin') || [])[1] || '';
  const uin = normalizeQqUin(
    headerUin || session.uin || session.p_uin || session.ptui_loginuin || session.luin || ''
  );
  const url =
    'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=' +
    encodeURIComponent(dissId) +
    '&format=json&g_tk=' +
    qqGtkOld(session) +
    '&loginUin=' +
    encodeURIComponent(uin || '0') +
    '&hostUin=' +
    encodeURIComponent(uin || '0') +
    '&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
  const json = await fetchJson(url, headers);
  const cd = json?.cdlist?.[0] || json?.data?.cdlist?.[0];
  if (!cd) throw new Error('没有读取到这个歌单');
  const songs = cd.songlist || cd.song || [];
  return {
    name: String(cd.dissname || cd.diss_name || ''),
    cover: httpsify(cd.logo || cd.diss_cover || ''),
    songs: songs.map((item) => ({
      title: String(item.songname || item.name || ''),
      artist: (item.singer || []).map((s) => s.name).filter(Boolean).join(' / '),
      cover: httpsify(item.album?.picUrl || ''),
      album: String(item.album?.name || ''),
      mid: String(item.songmid || item.mid || ''),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 酷狗                                                                */
/* ------------------------------------------------------------------ */

/**
 * 从酷狗登录会话里取出用户 ID。
 *
 * 酷狗在不同版本写不同的 cookie 名（实测出现过 userid / UserId / KUGOUID /
 * KugouID / user_id / kg_user_id），登录时我们把整袋 cookie 都存进了 session，
 * 但接口和网页脚本都只认 session.userid 这一个键，一旦那袋里写的是别的名字，
 * 就会报「登录信息里没有酷狗用户 ID」——即使明明已经登录了。
 * 这里按候选名逐个找，命中第一个非空值。
 */
function kugouUserId(session) {
  const names = ['userid', 'UserId', 'KUGOUID', 'KugouID', 'kg_user_id', 'user_id', 'KgUserID'];
  for (const name of names) {
    const value = session?.[name];
    if (value != null && String(value).trim()) return String(value).replace(/\D/g, '');
  }
  return '';
}

/**
 * 酷狗网页版登录后未必会写 userid 这条 cookie（实测只写 token 等），
 * 这时再用「用户信息」接口按 cookie 反查一次用户 ID。
 * 查不到才算真的没登录。
 */
async function resolveKugouUserId(session) {
  const direct = kugouUserId(session);
  if (direct) return direct;
  const cookie = String(session?.__cookieHeader || '');
  if (!cookie) return '';
  /*
   * 老的 y.y/index.php?r=user/info 系列已经全线废弃（统一回 Access Deny），
   * 所以改成从移动站「我的歌单」接口的返回里挖 userid。
   */
  const urls = [KUGOU_MYLIST_URL, 'https://m.kugou.com/plist/index?json=true'];
  for (const url of urls) {
    try {
      const text = await fetchText(url, { ...KUGOU_M_HEADERS, cookie });
      const json = parseKugouJson(text);
      const found = [];
      const walk = (node, depth) => {
        if (!node || depth > 5 || typeof node !== 'object') return;
        for (const key of Object.keys(node)) {
          const value = node[key];
          if (/^(userid|user_id|userId|kugouid|kugou_id)$/i.test(key)) {
            const clean = String(value ?? '').replace(/\D/g, '');
            if (clean && clean !== '0') found.push(clean);
          } else if (value && typeof value === 'object') {
            walk(value, depth + 1);
          }
        }
      };
      walk(json, 0);
      if (found.length) return found[0];
    } catch {
      /* 换下一个候选 */
    }
  }
  return '';
}

async function kugouMyPlaylists(session) {
  const cookie = canonicalCookieHeader('kugou', session);
  const headers = {
    referer: 'https://m.kugou.com/',
    origin: 'https://m.kugou.com',
    cookie,
    'user-agent': KUGOU_MOBILE_UA,
  };

  /*
   * 先打移动站的「我的歌单」接口 —— 它只要 cookie，不要 userid。
   * 以前第一步就要 userid，而酷狗网页登录根本不写 userid 那条 cookie，
   * 于是永远卡在「登录信息里没有酷狗用户 ID」。
   */
  const mobileErrors = [];
  try {
    const text = await fetchText(KUGOU_MYLIST_URL, headers);
    // 未登录 / 登录过期时它在 JSON 前面糊一句 "Access Deny ! No Actions !"，
    // parseKugouJson 会把这句话剥掉当正常 JSON 解析，结果就成了「返回空歌单」。
    // 先认出来，后面的提示才知道该说「登录失效」还是「接口下线」。
    if (/Access Deny/i.test(text)) throw new Error('Access Deny');
    const list = pickKugouPlaylists(parseKugouJson(text));
    if (list.length) return list;
    mobileErrors.push('移动站返回空歌单');
  } catch (error) {
    mobileErrors.push(humanizeError(error.message));
  }

  const userid = await resolveKugouUserId(session);
  const errors = [];

  /*
   * 网页版那两个地址（/yy/index.php?r=playlist/user 和 r=playlist/info）
   * 现在统一回 "Access Deny !!!"，留着只会让失败路径白白多等一个请求，已移除。
   * 剩下的候选只有一个 mobilecdn 的 user/playlist —— 它也基本读不到东西，
   * 所以连 userid 都拿不到时直接跳过，别再做无意义的尝试。
   */
  if (userid) {
    try {
      const url = `http://mobilecdn.kugou.com/api/v3/user/playlist?userid=${encodeURIComponent(userid)}&page=1&pagesize=50&type=0`;
      const json = await fetchJson(url, KUGOU_CDN_HEADERS);
      const rows = Array.isArray(json?.data?.info) ? json.data.info : [];
      const mapped = rows
        .map((item) => ({
          id: String(item.specialid || item.listid || ''),
          name: String(item.specialname || item.name || ''),
          cover: httpsify(String(item.imgurl || '').replace('{size}', '240')),
          count: Number(item.songcount || item.song_count || 0),
          creator: String(item.nickname || ''),
        }))
        .filter((item) => item.id && item.name);
      if (mapped.length) return mapped;
      errors.push('账户接口：返回空歌单');
    } catch (error) {
      errors.push('账户接口：' + humanizeError(error.message));
    }
  } else {
    errors.push('账户接口：登录信息里没有用户 ID，已跳过');
  }

  /*
   * 三条路都走不通时，给用户一句能看懂的话。
   * 酷狗已经把网页端的「我的歌单」整套接口下线了（Access Deny），
   * 这时候让用户对着一串英文报错毫无意义，直接告诉他下一步该干什么。
   */
  throw new Error(
    '酷狗的「我的歌单」暂时读不到（' +
      [mobileErrors[0], errors[0]].filter(Boolean).join('；') +
      '）。酷狗已经下线了网页端的个人歌单接口，' +
      '建议直接用下面的「歌单广场」挑一张公开歌单来听。' +
      '（' + describeSession('kugou', session) + '）'
  );
}

async function kugouPlaylistSongs(session, listId) {
  const id = String(listId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('酷狗歌单 ID 无效（需要数字 specialid）');
  /*
   * 元数据：移动站详情页（meta 在 json.info.list，不在 json.info）。
   * 它的曲目区（json.list.list.info）固定只给 10 首，所以只用来取封面/名字，
   * 真正的曲目走 mobilecdn 的 special/song。
   */
  let meta = {};
  try {
    const text = await fetchText(`https://m.kugou.com/plist/list/${id}/?json=true`, KUGOU_M_HEADERS);
    const json = parseKugouJson(text);
    meta = (json?.info && json.info.list) || json?.info || {};
  } catch {
    /* 元数据拿不到不致命，曲目还能继续 */
  }

  const songs = [];
  const seen = new Set();
  let total = 0;
  /*
   * 翻页终止条件要三条一起看，只信 data.total 是不够的：
   *   1. 某页返回空                      —— 后面肯定没有了；
   *   2. 本页不满 pagesize                —— 这就是最后一页（total 偶发漂移，
   *                                          实测同一张歌单第 1 页报 805、第 2 页报 806）；
   *   3. 重复的行全部被去重掉              —— 有些 ID 会把同一页反复返回，
   *                                          只按前两条判断就会死循环。
   * 另外 total 缺失 / 为 0 时不能用 songs.length >= total 判断，
   * 否则第一页取完立刻就 break（0 永远成立），整张歌单只剩 500 首。
   */
  for (let page = 1; page <= KUGOU_SONG_MAX_PAGES; page += 1) {
    const url =
      `http://mobilecdn.kugou.com/api/v3/special/song?specialid=${id}` +
      `&page=${page}&pagesize=${KUGOU_SONG_PAGE_SIZE}&version=9108`;
    const json = await fetchJson(url, KUGOU_CDN_HEADERS).catch(() => null);
    const rows = Array.isArray(json?.data?.info) ? json.data.info : [];
    if (!rows.length) break;
    if (!total) total = Number(json?.data?.total) || 0;
    let added = 0;
    for (const row of rows) {
      const song = parseKugouSongRow(row);
      // 同一首歌可能跨页重复：先用 hash，没有 hash 就退回「歌名+歌手」
      const key = song.hash || `${song.title}|${song.artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      songs.push(song);
      added += 1;
    }
    if (!added) break;
    if (total > 0 && songs.length >= total) break;
    if (rows.length < KUGOU_SONG_PAGE_SIZE) break;
  }

  if (!songs.length) {
    // 最后的兜底：详情页自带的 10 条，至少让用户看到一点东西
    try {
      const text = await fetchText(`https://m.kugou.com/plist/list/${id}/?json=true`, KUGOU_M_HEADERS);
      const json = parseKugouJson(text);
      const rows = (json?.list?.list && json.list.list.info) || [];
      for (const row of rows) {
        const song = parseKugouSongRow(row);
        const key = song.hash || `${song.title}|${song.artist}`;
        if (seen.has(key)) continue;
        seen.add(key);
        songs.push(song);
      }
    } catch {
      /* 连 10 条兜底也没有，就按空歌单返回 */
    }
  }
  return {
    name: String(meta.specialname || meta.name || '酷狗歌单'),
    cover: httpsify(String(meta.imgurl || '').replace('{size}', '400')),
    songs,
  };
}

/**
 * 酷狗的曲目行非常瘦：没有 singername / album_name，歌手只能从
 * 「filename（歌手 - 歌名）」里切出来。字段全部容错，避免一行脏数据炸掉整张歌单。
 */
function parseKugouSongRow(item) {
  /*
   * 行里那个「歌手 - 歌名」字段，不同接口叫法不一样：
   * special/song 叫 filename，zlist/list 叫 name（而且只有它，没有 singername）。
   * 三个都认，谁有就用谁。
   */
  const rawName = String(item?.filename || item?.songname || item?.name || '').trim();
  let artist = '';
  let title = rawName;
  const sep = rawName.indexOf(' - ');
  if (sep > 0) {
    artist = rawName.slice(0, sep).trim();
    title = rawName.slice(sep + 3).trim();
  }
  /*
   * special/song 这一版的行里没有 album_name / album_sizable_cover：
   * 封面藏在 trans_param.union_cover 里（带 {size} 占位），专辑只给了 album_id。
   * 不补这一手，整张歌单的封面全是空白。
   */
  const coverRaw = String(
    item?.album_sizable_cover || item?.imgurl || item?.trans_param?.union_cover || ''
  );
  return {
    title,
    artist: artist || String(item?.singername || ''),
    cover: httpsify(coverRaw.replace('{size}', '400')),
    album: String(item?.album_name || item?.album?.album_name || ''),
    hash: String(item?.hash || ''),
  };
}

/* ------------------------------------------------------------------ */
/* 酷狗「自建 / 收藏歌单」分享（t1.kugou.com 短链）                    */
/* ------------------------------------------------------------------ */
/*
 * 用户从酷狗 App 点「分享 → 复制链接」拿到的是 https://t1.kugou.com/73tp91cG6V2
 * 这种短码，302 之后落到：
 *   m.kugou.com/share/zlist.html?chain=…&uid=…&listid=…&global_collection_id=…&sign=…
 * 这类歌单在酷狗内部叫「自建歌单」，URL 里**没有 specialid**，
 * 所以 /plist/list/<数字> 和 mobilecdn 的 special/song 全都读不到它
 * （这两个接口拿自建歌单的 ID 去问只会回空或者报错）。
 *
 * 真正给那个分享页供数据的是 m3ws.kugou.com/v2/zlist/list，但它有一道签名闸门：
 * 参数不全直接回「参数错误」，签名不对回「签名错误」。
 * 规则是从 staticssl.kugou.com/common/js/min/infSign.min.js 里扒出来的：
 *
 *   signature = md5(SECRET + 按 key 排序后的 "k=v" 直接串起来 + SECRET)
 *
 * 注意和 mobilecdn 那套老签名不一样：老签名每对之间用 & 隔开，
 * 这一套是**中间什么都不加**（我拿 & 拼过，服务端回「签名错误」）。
 * 另外 infSign 不管什么接口都会补 srcappid/clientver/clienttime/mid/uuid，
 * 缺了就是「参数错误」，所以这里也必须一并补上。
 *
 * 还有一条实测出来的坑：chain 和 sign 至少要带一个，而且服务端会校验它是不是
 * 这张歌单的真凭证 —— 随便编一个照样回「参数错误」。
 * 结论：解析短链时要把 chain / sign 原样留下来，塞进 opaque 的 playlistId，
 * 后面单独取曲目时才有得用（那时已经拿不到原始链接了）。
 */
const KUGOU_ZLIST_API = 'https://m3ws.kugou.com/v2/zlist/list';
/** infSign 里写死的 H5 签名密钥，换算法时这个值也会跟着变。 */
const KUGOU_SIGN_SECRET = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
/** zlist/list 的 pagesize 上限实测就是 100（传 500 也只回 100 条）。 */
const KUGOU_COLLECT_PAGE_SIZE = 100;
/** 100 × 50 = 五千首，正常自建歌单够用；纯粹防止接口抽风时无限翻页。 */
const KUGOU_COLLECT_MAX_PAGES = 50;
/** opaque ID 前缀：collect:<uid>:<listid>:<chain>:<sign>，界面不需要看懂它。 */
const KUGOU_COLLECT_PREFIX = 'collect:';
/** zlist 接口认分享页做 referer，用别的来源会被当成爬虫。 */
const KUGOU_ZLIST_HEADERS = {
  referer: 'https://m.kugou.com/share/zlist.html',
  'user-agent': KUGOU_MOBILE_UA,
};

/** 按 infSign 的 H5 规则签名，返回一份能直接拼成 query 的完整参数表。 */
function signKugouZlistParams(params) {
  const now = Date.now();
  const signed = {
    srcappid: '2919',
    clientver: '20000',
    clienttime: String(now),
    mid: String(now),
    uuid: String(now),
    dfid: '-',
    ...params,
  };
  const body = Object.keys(signed)
    .sort()
    .map((key) => `${key}=${signed[key]}`)
    .join('');
  signed.signature = crypto
    .createHash('md5')
    .update(KUGOU_SIGN_SECRET + body + KUGOU_SIGN_SECRET)
    .digest('hex');
  return signed;
}

/** 把 { uid, listid, chain, sign } 拼成前端不必理解的 opaque ID。 */
function kugouCollectPlaylistId(info) {
  return (
    KUGOU_COLLECT_PREFIX +
    [String(info?.uid || ''), String(info?.listid || ''), String(info?.chain || ''), String(info?.sign || '')].join(':')
  );
}

/** 认 opaque ID；不是 collect 前缀就返回 null，前缀对但内容残缺就报人话。 */
function parseKugouCollectPlaylistId(raw) {
  const text = String(raw || '');
  if (!text.startsWith(KUGOU_COLLECT_PREFIX)) return null;
  const [uid, listid, chain, sign] = text.slice(KUGOU_COLLECT_PREFIX.length).split(':');
  if (!/^\d+$/.test(String(uid || '')) || !/^\d+$/.test(String(listid || ''))) {
    throw new Error('这个酷狗歌单 ID 不完整，请重新粘贴一次分享链接');
  }
  return { uid, listid, chain: chain || '', sign: sign || '' };
}

/** zlist/list 的 status 不是 1 时，把它的错误翻成人话。 */
function kugouZlistErrorText(json) {
  const detail = String(json?.error || '').trim();
  if (/签名|参数/.test(detail)) {
    return '酷狗认为这次请求的凭证不对（分享链接可能已经过期或被撤回了），请在酷狗里重新分享一次再导入';
  }
  return detail || '酷狗没有返回曲目数据';
}

/** 取 zlist 的某一页。签名里有 clienttime，必须每次请求单独算。 */
async function fetchKugouCollectPage(info, page) {
  const params = signKugouZlistParams({
    listid: String(info.listid),
    uid: String(info.uid),
    type: '0',
    page: String(page),
    pagesize: String(KUGOU_COLLECT_PAGE_SIZE),
    ...(info.chain ? { chain: info.chain } : {}),
    ...(info.sign ? { sign: info.sign } : {}),
  });
  const json = await fetchJson(KUGOU_ZLIST_API + '?' + new URLSearchParams(params), KUGOU_ZLIST_HEADERS);
  if (Number(json?.status) !== 1) throw new Error(kugouZlistErrorText(json));
  return json;
}

/** 歌单本身的元信息藏在这一页的 json.info 里（是数组，取第一条）。 */
function kugouCollectMetaFrom(json) {
  const info = Array.isArray(json?.info) ? json.info[0] : json?.info;
  const meta = info && typeof info === 'object' ? info : {};
  return {
    name: String(meta.name || meta.listname || '酷狗歌单'),
    cover: httpsify(String(meta.pic || meta.imgurl || '').replace('{size}', '480')),
    creator: String(meta.list_create_username || meta.nickname || ''),
    total: Number(meta.count || json?.list?.count || 0),
  };
}

/** 只读第一页，拿歌单名 / 封面 / 曲目数 —— 解析链接时用来先给用户一个交代。 */
async function kugouCollectPlaylistMeta(info) {
  return kugouCollectMetaFrom(await fetchKugouCollectPage(info, 1));
}

/**
 * 自建歌单的曲目：按页翻 zlist/list。
 *
 * 终止条件和 special/song 那套一样看三条（空页 / 不满一页 / 已够 count），
 * 不单信 count：它是实时统计，翻页过程中有人加歌就会漂。
 */
async function kugouCollectPlaylistSongs(info) {
  const songs = [];
  const seen = new Set();
  let meta = null;
  for (let page = 1; page <= KUGOU_COLLECT_MAX_PAGES; page += 1) {
    const json = await fetchKugouCollectPage(info, page);
    if (!meta) meta = kugouCollectMetaFrom(json);
    const rows = Array.isArray(json?.list?.info) ? json.list.info : [];
    if (!rows.length) break;
    let added = 0;
    for (const row of rows) {
      const song = parseKugouSongRow(row);
      if (!song.hash && !song.title) continue;
      const key = song.hash || `${song.title}|${song.artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      songs.push(song);
      added += 1;
    }
    if (!added) break;
    if (meta.total > 0 && songs.length >= meta.total) break;
    if (rows.length < KUGOU_COLLECT_PAGE_SIZE) break;
  }
  if (!songs.length) {
    throw new Error('这个酷狗歌单里一首歌都没读到（歌单可能是空的，或者分享链接已经失效）');
  }
  return { name: meta.name, cover: meta.cover, creator: meta.creator, songs };
}

/* ------------------------------------------------------------------ */
/* 公开歌单广场（免登录）                                              */
/* ------------------------------------------------------------------ */
/*
 * 酷狗已经把「我的歌单」整套网页/移动接口下线（全部 Access Deny），
 * QQ 音乐的自建接口对新登录态也经常 500003。所以点歌台另开一条路：
 * 只取「歌单列表 + 曲目列表」这种结构数据，全部用免登录的公开接口，
 * 不碰各平台的音源（播放仍然由网易云换源解决）。
 */

function plazaCover(url) {
  return httpsify(String(url || '').replace('{size}', '400'));
}

/** 酷狗歌单广场：m.kugou.com/plist/index，按页翻（每页固定 30 条，pagesize 参数无效）。 */
async function kugouPlaza(page = 1) {
  const url = `https://m.kugou.com/plist/index?json=true&page=${Math.max(1, page | 0)}`;
  const json = await fetchJson(url, KUGOU_M_HEADERS);
  const rows =
    (json?.plist?.list && json.plist.list.info) ||
    (json?.list?.list && json.list.list.info) ||
    [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const id = String(row.specialid || '');
    // 跨页会有重复：广场卡片按 specialid 去重
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(row.specialname || ''),
      cover: plazaCover(row.imgurl),
      count: Number(row.songcount) || 0,
      playcount: Number(row.playcount) || 0,
      creator: String(row.nickname || ''),
      plaza: true,
    });
  }
  return out;
}

/** QQ 音乐歌单广场：splcloud 的老接口，按 sin/ein 翻页，返回可能是 jsonp。 */
async function qqPlaza(page = 1) {
  const size = 30;
  const current = Math.max(1, page | 0);
  const sin = (current - 1) * size;
  const url =
    `https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg` +
    `?categoryId=10000000&sortId=5&sin=${sin}&ein=${sin + size}`;
  const json = await fetchJson(url, { referer: 'https://y.qq.com/' });
  const rows = (json?.data?.list) || [];
  return rows
    .map((row) => ({
      id: String(row.dissid ?? row.diss_id ?? ''),
      name: String(row.dissname ?? row.diss_name ?? ''),
      cover: plazaCover(row.imgurl ?? row.logo ?? ''),
      count: Number(row.song_count ?? row.songcount) || 0,
      playcount: Number(row.listennum ?? row.listen_num) || 0,
      creator: String(row.creator?.name ?? row.creator_name ?? ''),
      plaza: true,
    }))
    .filter((item) => item.id);
}

/** 网易云歌单广场：music.163.com 的老 API，免登录。 */
async function neteasePlaza(page = 1) {
  const size = 30;
  const offset = (Math.max(1, page | 0) - 1) * size;
  const url =
    `https://music.163.com/api/playlist/list?cat=${encodeURIComponent('全部')}` +
    `&order=hot&offset=${offset}&total=true&limit=${size}`;
  const json = await fetchJson(url, { referer: 'https://music.163.com/' });
  const rows = Array.isArray(json?.playlists) ? json.playlists : [];
  return rows
    .map((row) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      cover: plazaCover(row.coverImgUrl ?? row.picUrl ?? ''),
      count: Number(row.trackCount) || 0,
      playcount: Number(row.playCount) || 0,
      creator: String(row.creator?.nickname ?? row.creator_name ?? ''),
      plaza: true,
    }))
    .filter((item) => item.id);
}

/*******************************************************************
 * 酷我：kuwo.cn/api/www 的每个请求都要带 Secret 头 —— 官网前端
 * （h5s.kuwo.cn/www/kw-www/dcc6cd7.js）会把名叫 Hm_Iuvt_<…> 的 cookie
 * 值用 XOR+LCG 加密后放进 Secret。这里逐字符复刻该算法：先请求首页
 * 拿到 cookie 值当令牌，再对每个接口签名。reqId 必须是 uuid 形状，
 * 随便编的 id 会让部分接口静默返回空数据。rn 上限 50，再大会触发
 * 后端代理错误（Error occured while trying to proxy）。
 ******************************************************************/

const KUWO_KEY = 'Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324';

/** 复刻官网 Secret 生成：t=cookie 值（明文），e=cookie 名（密钥）。 */
function kuwoSecret(token) {
  if (!token) return null;
  let n = '';
  for (let i = 0; i < KUWO_KEY.length; i++) n += KUWO_KEY.charCodeAt(i).toString();
  const o = Math.floor(n.length / 5);
  const r = parseInt(n.charAt(o) + n.charAt(2 * o) + n.charAt(3 * o) + n.charAt(4 * o) + n.charAt(5 * o));
  const c = Math.ceil(KUWO_KEY.length / 2);
  const l = Math.pow(2, 31) - 1;
  if (!(r >= 2)) return null;
  let d = Math.round(1e9 * Math.random()) % 1e8;
  for (n += d; n.length > 10;) n = (parseInt(n.substring(0, 10)) + parseInt(n.substring(10, n.length))).toString();
  n = (r * n + c) % l;
  let h = '';
  for (let i = 0; i < token.length; i++) {
    const fv = parseInt(token.charCodeAt(i) ^ Math.floor((n / l) * 255));
    h += fv < 16 ? `0${fv.toString(16)}` : fv.toString(16);
    n = (r * n + c) % l;
  }
  for (d = d.toString(16); d.length < 8;) d = `0${d}`;
  return h + d;
}

function kuwoUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 请求 kuwo.cn 首页拿 Hm_Iuvt cookie 值（7 天有效，这里每次现取）。 */
async function kuwoSession() {
  const { signal, done } = withTimeout();
  try {
    const res = await fetch('https://kuwo.cn/', {
      headers: { 'user-agent': BROWSER_UA },
      signal,
      redirect: 'follow',
    });
    const cookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : String(res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/);
    const hit = cookies.find((line) => line.startsWith(`${KUWO_KEY}=`)) || '';
    const token = hit.split('=')[1] ? hit.split('=')[1].split(';')[0].trim() : '';
    if (!token) throw new Error('酷我没有下发会话 cookie，接口暂时不可用');
    return token;
  } finally {
    done();
  }
}

async function kuwoApi(pathname, params, token) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://kuwo.cn/api/www${pathname}?${qs}&httpsStatus=1&reqId=${kuwoUuid()}&plat=web_www`;
  const text = await fetchText(url, {
    referer: 'https://kuwo.cn/',
    csrf: token,
    Secret: kuwoSecret(token),
    cookie: `kw_token=${token}; ${KUWO_KEY}=${token}`,
  });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('酷我返回内容不是 JSON');
  }
  if (json && typeof json.code === 'number' && json.code !== 200) {
    throw new Error(`酷我接口 ${pathname} 出错（code ${json.code}${json.msg ? `：${json.msg}` : ''}）`);
  }
  return json;
}

/** 酷我歌单广场：流行分类（曲风流派 393）下的热门歌单，免登录。 */
async function kuwoPlaza(page = 1) {
  const token = await kuwoSession();
  const json = await kuwoApi(
    '/classify/playlist/getTagPlayList',
    { id: 393, pn: Math.max(1, page | 0), rn: 30 },
    token,
  );
  const rows = Array.isArray(json?.data?.data) ? json.data.data : [];
  return rows
    .map((row) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      cover: plazaCover(row.img ?? ''),
      count: Number(row.total) || 0,
      playcount: Number(row.listencnt) || 0,
      creator: String(row.uname ?? ''),
      plaza: true,
    }))
    .filter((item) => item.id);
}

/**
 * 酷我公开歌单详情：playListInfo 按 pn/rn 翻页（响应体在 data 里嵌一层），
 * 超出末页时返回空数组不报错，按 total 估页数、遇到空页即停。
 */
async function kuwoPublicPlaylistSongs(listId) {
  const pid = String(listId || '').trim();
  if (!/^\d+$/.test(pid)) throw new Error('歌单 ID 无效');
  const token = await kuwoSession();
  const first = await kuwoApi('/playlist/playListInfo', { pid, pn: 1, rn: 30 }, token);
  const info = first?.data || {};
  const total = Number(info.total) || 0;
  const songs = [];
  const push = (rows) => {
    for (const row of rows || []) {
      const rid = row.rid ?? row.musicrid;
      if (rid === undefined || rid === null || rid === '') continue;
      songs.push({
        title: String(row.name ?? '未知曲目'),
        artist: String(row.artist ?? ''),
        cover: httpsify(row.pic ?? row.albumpic ?? ''),
        album: String(row.album ?? ''),
        mid: String(rid).replace(/^MUSIC_/i, ''),
        neteaseId: '',
        hash: '',
      });
    }
  };
  push(info.musicList);
  const pages = Math.min(Math.ceil(total / 30) || 1, 20);
  for (let pn = 2; pn <= pages; pn++) {
    let more;
    try {
      more = await kuwoApi('/playlist/playListInfo', { pid, pn, rn: 30 }, token);
    } catch {
      break; // 中间页偶发代理错误时保留已拿到的曲目
    }
    const rows = more?.data?.musicList;
    if (!Array.isArray(rows) || rows.length === 0) break;
    push(rows);
  }
  return {
    name: String(info.name ?? '酷我歌单'),
    cover: httpsify(info.img ?? ''),
    creator: String(info.uname ?? ''),
    playcount: Number(info.listencnt) || 0,
    songs,
  };
}
/* ------------------------------------------------------------------ */
/* 酷我：登录态「我的歌单」                                            */
/*                                                                    */
/* 酷我现在的网页（kuwo.cn SPA + m.kuwo.cn H5）已经把用户歌单接口全删了 */
/* （getSelfCreatePlayList / getSelfPlayList / collect/getPlayList 在  */
/* 签名通过后仍然 404）。唯一活口是老接口 nplserver.kuwo.cn/pl.svc：    */
/*   op=getuserlist  按 uid 返回用户全部歌单（含私有的默认列表/我喜欢   */
/*                   听/我的电台），每条直接内嵌分号分隔的曲目 id 串。  */
/* 该接口不要登录 cookie，知道 uid 即可；uid 来自登录后种下的           */
/* userid / t3kwid cookie。曲目元信息再用 www 的 musicInfo 逐个解析。   */
/* ------------------------------------------------------------------ */

const KUWO_NPL = 'http://nplserver.kuwo.cn/pl.svc';

function kuwoAccountUid(session) {
  const bag = session || {};
  const fromHeader = bag.__cookieHeader ? String(bag.__cookieHeader).match(/(?:^|;\s*)userid=([^;]+)/) : null;
  const raw = bag.userid ?? bag.t3kwid ?? bag.UserId ?? bag.uid ?? (fromHeader ? fromHeader[1] : '');
  return String(raw || '').trim().replace(/^o/i, '').replace(/\D/g, '');
}

async function kuwoNpl(op, uid) {
  const url = KUWO_NPL + '?op=' + encodeURIComponent(op) + '&uid=' + encodeURIComponent(uid) + '&pn=0&rn=200&encode=utf-8';
  const text = await fetchText(url, {
    referer: 'http://www.kuwo.cn/',
    'user-agent': BROWSER_UA,
  });
  let json;
  try {
    // 老接口偶尔会包一层 try{var jsondata=...}catch(e){}
    const start = text.search(/[\[{]/);
    let body = start >= 0 ? text.slice(start) : text;
    const cut = body.lastIndexOf('}') >= 0 ? body.lastIndexOf('}') + 1 : body.length;
    body = body.slice(0, cut);
    json = JSON.parse(body);
  } catch {
    throw new Error('酷我返回内容不是 JSON');
  }
  if (json && json.result && json.result !== 'ok') {
    throw new Error('酷我歌单服务返回 ' + (json.reason || json.result));
  }
  return json;
}

/** 登录用户的全部歌单（getuserlist：公开+私有，内嵌曲目 id）。 */
async function kuwoMyPlaylists(session) {
  const uid = kuwoAccountUid(session);
  if (!uid) throw new Error('登录信息里没有酷我用户 ID');
  const json = await kuwoNpl('getuserlist', uid);
  const rows = Array.isArray(json.plist) ? json.plist : [];
  // 空标题的是 ORDER/TAG/ARTIST 这类系统容器，不是歌单；零首的也不显示
  return rows
    .filter((row) => String(row.title || '').trim() && Number(row.musicnum) > 0)
    .map((row) => ({
      id: String(row.id),
      name: String(row.title).trim(),
      cover: plazaCover(row.pic),
      count: Number(row.musicnum) || 0,
      playcount: Number(row.playnum) || 0,
      creator: '',
      own: true,
    }));
}

/** 单个登录歌单的曲目：从内嵌 id 串取 id，再用 www musicInfo 补元信息。 */
async function kuwoMyPlaylistSongs(session, playlistId) {
  const uid = kuwoAccountUid(session);
  if (!uid) throw new Error('登录信息里没有酷我用户 ID');
  if (!/^\d+$/.test(String(playlistId))) throw new Error('酷我歌单 ID 必须是数字');
  const json = await kuwoNpl('getuserlist', uid);
  const row = (json.plist || []).find((item) => String(item.id) === String(playlistId));
  if (!row) throw new Error('酷我歌单服务里没有这个歌单（可能已被删除）');
  const ids = String(row.songs || '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value));
  const token = await kuwoSession();
  const songs = [];
  const queue = ids.slice(0, 500);
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const mid = queue.shift();
      try {
        const info = await kuwoApi('/music/musicInfo', { mid }, token);
        const data = info && info.data ? info.data : {};
        if (!data.name && !data.artist) continue;
        songs.push({
          title: String(data.name || data.songName || '').trim(),
          artist: String(data.artist || '').trim(),
          cover: httpsify(data.pic || data.albumpic),
          album: String(data.album || '').trim(),
          mid: String(data.rid || data.musicrid || mid).replace(/^MUSIC_/i, ''),
          neteaseId: '',
          hash: '',
        });
      } catch {
        // 单曲下架/区域限制时跳过，不影响整单
      }
    }
  });
  await Promise.all(workers);
  return {
    name: String(row.title || '歌单').trim(),
    cover: plazaCover(row.pic),
    creator: '',
    playcount: Number(row.playnum) || 0,
    songs,
  };
}
/** 公开歌单广场统一入口。 */
async function publicPlaza(platform, page = 1) {
  if (platform === 'qq') return qqPlaza(page);
  if (platform === 'kugou') return kugouPlaza(page);
  if (platform === 'netease') return neteasePlaza(page);
  if (platform === 'kuwo') return kuwoPlaza(page);
  throw new Error('不支持的平台');
}

/**
 * 网易云公开歌单详情：直连 music.163.com 的 v6 接口，免登录，
 * 不依赖本地 NeteaseCloudMusicApi 服务有没有启动。
 */
/**
 * 网易云公开歌单详情（免登录）。
 *
 * 坑：v6 /playlist/detail 的 playlist.tracks 现在只内嵌前 10 首（实测，
 * n=1000 参数早已失效），完整曲目 ID 在 playlist.trackIds 里。
 * 所以这里分两步：detail 只拿元信息 + trackIds，再用 /api/v3/song/detail
 * 按 200 个一批把每首歌的名字/歌手/封面补出来（实测 60/60 全回）。
 * trackIds 为空或补全失败时退回内嵌 tracks，宁可少几首也不空手而归。
 */
async function neteasePublicPlaylistSongs(listId) {
  const id = String(listId || '').trim();
  const headers = { referer: 'https://music.163.com/' };
  let playlist = null;
  try {
    const json = await fetchJson(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=1000`, headers);
    playlist = json?.playlist || null;
  } catch {
    /* 退回老接口再试一次 */
    const json = await fetchJson(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`, headers);
    playlist = json?.result || json?.playlist || null;
  }
  const embedded = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
  const trackIds = Array.isArray(playlist?.trackIds)
    ? playlist.trackIds.map((item) => Number(item?.id)).filter((num) => Number.isFinite(num) && num > 0)
    : [];

  const toSong = (song) => ({
    title: String(song.name || ''),
    artist: String((song.ar || song.artists || []).map((a) => a.name || '').filter(Boolean).join(' / ')),
    cover: String(song.al?.picUrl || song.album?.picUrl || '').replace(/^http:/i, 'https:'),
    neteaseId: String(song.id || ''),
    mid: String(song.id || ''),
    hash: '',
  });

  let tracks = embedded;
  if (trackIds.length > embedded.length) {
    const filled = [];
    for (let start = 0; start < trackIds.length; start += 200) {
      const batch = trackIds.slice(start, start + 200).map((sid) => ({ id: sid }));
      try {
        const detail = await fetchJson(
          `https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify(batch))}`,
          headers
        );
        // 注意：这里只收集原始 song 对象，统一留给末尾那次 toSong 映射。
        // 之前在这里就 push 了 toSong(song)，末尾又对整列再 map 一遍 toSong，
        // 第二次拿到的是已映射的 {title,artist,cover}，取 song.name/song.ar 全是
        // undefined —— 整张歌单 137 首的歌名/歌手/封面全部被清空（用户报的
        // 「不显示歌名、封面」就是这个）。
        for (const song of Array.isArray(detail?.songs) ? detail.songs : []) filled.push(song);
      } catch {
        /* 一批失败就跳过这批，剩下的批次继续，尽量多带几首回来 */
      }
    }
    if (filled.length > embedded.length) tracks = filled;
  }

  const songs = tracks.map(toSong);
  return {
    name: String(playlist?.name || '网易云歌单'),
    cover: String(playlist?.coverImgUrl || '').replace(/^http:/i, 'https:'),
    songs,
  };
}

/**
 * QQ 公开歌单详情（免登录）。
 *
 * 老接口（fcg_ucc_getcdinfo_byids_cp / music.srfDissInfo.ui.DissInfo CgiGetDiss）
 * 匿名访问都会被 privacy 挡回「check privacy error!」或 500003，
 * 但桌面官网 playlist 页自己用的
 * music.srfDissInfo.aiDissInfo / uniform_get_Dissinfo 免登录可用
 * （实测 code 0，dirinfo + songlist 完整返回）。
 * 单页最多 30 条且 song_num 调到再大也没用（服务端写死），只能靠 song_begin 翻页。
 */
async function qqPublicPlaylistSongs(dissId) {
  const id = String(dissId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('歌单 ID 不合法');
  const reqUrl = (begin) =>
    'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' +
    encodeURIComponent(JSON.stringify({
      req_1: {
        module: 'music.srfDissInfo.aiDissInfo',
        method: 'uniform_get_Dissinfo',
        param: {
          disstid: Number(id),
          userinfo: 1,
          tag: 1,
          orderlist: 1,
          song_begin: begin,
          song_num: QQ_SONG_PAGE_SIZE,
          onlysonglist: 0,
          enc_host_uin: '',
        },
      },
    }));
  const headers = { referer: 'https://y.qq.com/' };
  const first = await fetchJson(reqUrl(0), headers);
  const body = first?.req_1?.data;
  if (!body || body.code !== 0 || !body.dirinfo) {
    const code = first?.req_1?.code ?? first?.code ?? '';
    throw new Error('QQ 公开详情不可用（code ' + code + '）');
  }
  const dirinfo = body.dirinfo;
  const total = Number(dirinfo.songnum || 0);
  /*
   * 一直翻到「取满 total」或「某页返回空」为止，和酷狗那套保持一致。
   *
   * 以前这里写的是 begin < 300，一张 1284 首的真歌单就被截成正好 300 首。
   * 每页写死 30 条（song_num 调大服务端也不给），所以页数会比较多：
   * 这里给一个保险上限（30×400 = 1.2 万首），纯粹防异常歌单无限翻，
   * 正常歌单摸不到。去重按 mid —— 同一首歌跨页重复会被跳掉，
   * 整页重复时也能及时停，不会一直打下去。
   */
  const rows = [];
  const seen = new Set();
  const keyOf = (item) => String(item?.mid || item?.songmid || item?.id || '');
  const collect = (list) => {
    let added = 0;
    for (const item of list) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(item);
      added += 1;
    }
    return added;
  };
  collect(body.songlist || []);
  // 首页就不满，说明没有第二页，别再白打一次请求
  let lastPageShort = (body.songlist || []).length < QQ_SONG_PAGE_SIZE;
  for (let begin = QQ_SONG_PAGE_SIZE; begin < QQ_SONG_PAGE_SIZE * QQ_SONG_MAX_PAGES; begin += QQ_SONG_PAGE_SIZE) {
    if (lastPageShort) break;
    if (total > 0 && rows.length >= total) break;
    const page = await fetchJson(reqUrl(begin), headers);
    const list = page?.req_1?.data?.songlist || [];
    if (!list.length) break;
    const added = collect(list);
    if (!added) break;
    lastPageShort = list.length < QQ_SONG_PAGE_SIZE;
  }
  return {
    name: String(dirinfo.title || dirinfo.dissname || ''),
    cover: httpsify(String(dirinfo.picurl || dirinfo.picurl2 || '')),
    creator: String(dirinfo.host_nick || ''),
    playcount: Number(dirinfo.listennum || 0),
    songs: rows.map((item) => {
      const albumMid = String(item.album?.pmid || item.album?.mid || '');
      return {
        title: String(item.name || item.title || ''),
        artist: (item.singer || []).map((s) => s.name).filter(Boolean).join(' / '),
        cover: albumMid ? httpsify('https://y.gtimg.cn/music/photo_new/T002R500x500M000' + albumMid + '.jpg') : '',
        album: String(item.album?.name || ''),
        mid: String(item.mid || item.songmid || item.id || ''),
      };
    }),
  };
}

/**
 * 公开歌单详情统一入口：不走登录态，任何平台都只拿「歌单 + 曲目列表」。
 */
/**
 * 从一条歌单分享链接里认出平台和歌单 ID。
 *
 * 三家各有好几种链接形态，而且用户经常把整段分享文案粘进来
 * （「分享XX的歌单《…》https://…（来自@网易云音乐）」），
 * 所以先把第一个 http(s) 链接抠出来，再按域名分派规则。
 *
 * 认不出来一律抛「人话」错误：
 * 带上该平台该去哪儿换链接，不要抛一堆技术细节让用户猜。
 *
 * 为什么要 async：酷狗 App 分享出来的是 t1.kugou.com/<短码> 这种短链，
 * 歌单号全在 302 后面的地址里，必须先跟一次跳转才认得出（详见上面那段注释）。
 * 其余两家还是纯字符串解析，不产生任何网络请求，粘贴完立刻就有结果。
 *
 * @returns {Promise<{platform: 'netease'|'qq'|'kugou'|'kuwo', playlistId: string, label: string,
 *   shareKind?: 'collect'|'special', name?: string, cover?: string, trackCount?: number}>}
 */
async function parseSharedPlaylistLink(rawInput) {
  const text = String(rawInput || '').trim();
  if (!text) throw new Error('请先粘贴歌单链接');
  /*
   * 分享文案里的链接后面经常紧跟中文标点，例如
   *   …https://t1.kugou.com/73tp91cG6V2（来自@酷狗音乐）
   * 只挡右括号是不够的：正则会把「（来自…」一起吞进 URL，
   * 拼出来的地址打不开，用户看到的就是「链接失效」。
   * 所以中文的成对括号全部当成链接边界。
   */
  const link = String(text.match(/https?:\/\/[^\s"'（）《》【】「」]+/i)?.[0] || '');
  if (!link) throw new Error('这段文字里没有找到链接，请粘贴完整的歌单分享地址（带 https:// 那种）');

  let url = null;
  try {
    url = new URL(link);
  } catch {
    throw new Error('这个链接看起来不完整，请重新复制一次完整的歌单链接');
  }
  const host = url.hostname.toLowerCase();
  // 网易云的 playlist?id= 写在 hash 里，必须连 hash 一起找
  const haystack = decodeURIComponent(url.pathname + url.search + url.hash);
  const query = new URLSearchParams(url.search);
  const firstParam = (...names) => {
    for (const name of names) {
      const value = String(query.get(name) || '');
      if (value) return value;
    }
    return '';
  };
  const digits = (value) => String(value || '').match(/\d{3,}/)?.[0] || '';

  /* ---------------- 网易云 ---------------- */
  if (/(^|\.)163\.com$/.test(host) || /(^|\.)163cn\.tv$/.test(host) || /(^|\.)music\.163$/i.test(host)) {
    if (/(^|\.)163cn\.tv$/.test(host)) {
      throw new Error('这是网易云的短链（163cn.tv），短链里没有歌单号。请在网易云里打开歌单，复制链接地址栏那种带 playlist?id= 的完整链接再来。');
    }
    if (/\/song(\/|\?)/.test(url.pathname) || /[?&]id=/i.test(haystack) && /\/song/i.test(haystack)) {
      if (!/playlist/i.test(haystack)) {
        throw new Error('这是一首单曲的分享链接，这里只支持歌单。请到歌单页面重新分享一个歌单链接。');
      }
    }
    const id =
      digits(haystack.match(/playlist\?id=(\d+)/i)?.[1]) ||
      digits(haystack.match(/\/playlist\/(\d+)/i)?.[1]) ||
      digits(haystack.match(/[?&]id=(\d+)/i)?.[1]);
    if (!id) throw new Error('这个网易云链接里没有识别出歌单 ID，请打开歌单后复制链接栏里带 playlist?id= 的地址');
    return { platform: 'netease', playlistId: id, label: '网易云' };
  }

  /* ---------------- QQ 音乐 ---------------- */
  if (/(^|\.)qq\.com$/.test(host) || /(^|\.)y\.qq\.com$/.test(host)) {
    const id =
      digits(haystack.match(/\/playlist\/(\d+)/i)?.[1]) ||
      digits(haystack.match(/\/taoge\/(\d+)/i)?.[1]) ||
      digits(firstParam('id', 'dissid', 'playlistid'));
    if (!id) throw new Error('这个 QQ 音乐链接里没有识别出歌单 ID，请打开歌单后复制链接栏里带 /playlist/ 或 ?id= 的地址');
    return { platform: 'qq', playlistId: id, label: 'QQ 音乐' };
  }

  /* ---------------- 酷狗 ---------------- */
  if (/(^|\.)kugou\.com$/.test(host)) {
    /*
     * 酷狗这边有两类歌单，读法完全不一样：
     *
     * ① 公开歌单（specialid）—— 一直能读，URL 自己就带号：
     *      m.kugou.com/plist/list/3823475/?json=true
     *      www.kugou.com/yy/special/single/3823475.html
     *      ....?specialid=3823475
     *
     * ② 自建 / 收藏歌单 —— App 里分享出来是 t1.kugou.com/<短码>，
     *      302 到 m.kugou.com/share/zlist.html?chain=…&uid=…&listid=…
     *      URL 里没有 specialid，只能走 zlist/list 那套签名接口。
     *      这类链接必须先把跳转跟完才能解析，所以放在下面单独处理。
     */
    let target = url;
    let info = pickKugouShareInfo(target);
    // 「有号」的判定：认出 specialid，或者认出 uid+listid 且手里有 chain/sign 当凭证
    const hasDirect = info.specialid || (info.listid && info.uid && (info.chain || info.sign));
    if (!hasDirect) {
      // 短链（或者只有 chain 的半截分享页）：跟一次跳转，从落地地址里再认一遍
      let followed = '';
      try {
        followed = await followKugouShareLinkWithRetry(url.href);
      } catch (error) {
        throw new Error(
          '这条酷狗分享链接打不开（' + humanizeError(error.message) + '）。请确认链接没有过期，或者改用「歌单广场」挑一张。'
        );
      }
      target = new URL(followed);
      info = pickKugouShareInfo(target);
    }

    if (info.specialid) {
      return { platform: 'kugou', playlistId: info.specialid, label: '酷狗', shareKind: 'special' };
    }

    if (info.listid && info.uid && (info.chain || info.sign)) {
      const collect = { uid: info.uid, listid: info.listid, chain: info.chain, sign: info.sign };
      /*
       * 顺手把歌单名 / 封面 / 曲目数读回来（只读第一页，几百毫秒）。
       * 好处有两个：界面上能立刻显示「识别为《古明地恋喜欢的音乐》· 1943 首」；
       * 凭证过期这种事在这一步就炸出来，不用等用户以为导入成功了再白屏。
       * 读不到不算失败 —— 名字是锦上添花，别为了它把整个导入拦下来。
       */
      const meta = await withDeadline(kugouCollectPlaylistMeta(collect), 6000, '读取酷狗歌单信息').catch(() => null);
      return {
        platform: 'kugou',
        playlistId: kugouCollectPlaylistId(collect),
        label: '酷狗',
        shareKind: 'collect',
        name: meta?.name || '',
        cover: meta?.cover || '',
        trackCount: Number(meta?.total) || 0,
        creator: meta?.creator || '',
      };
    }

    if (info.listid && info.uid) {
      throw new Error(
        '这条酷狗链接里只有 uid / listid，缺了打开歌单要用的凭证（chain 或 sign）。请在酷狗里重新「分享 → 复制链接」，用 t1.kugou.com 开头的那种短链再来。'
      );
    }

    /*
     * 短链跟完了还是没号，基本就是短码本身失效了（酷狗分享链接有时效）。
     * 这时候不能再劝用户「用短链」，他手上那条就是短链，只会让人更懵。
     */
    const originalHasPlaylistParam =
      /[?&](specialid|listid|uid|id)=/i.test(url.search) || /\/(plist|special)\//i.test(url.pathname);
    throw new Error(
      originalHasPlaylistParam
        ? '这个酷狗链接里没有识别出歌单号。请在酷狗 App 里打开歌单，点「分享 → 复制链接」，粘 t1.kugou.com/… 这种短链进来；也可以直接用「歌单广场」挑一张。'
        : '这条酷狗短链没有指向一张能读的歌单（短码可能已经过期或被撤回了）。请在酷狗里重新「分享 → 复制链接」拿一条新的 t1.kugou.com 短链。'
    );
  }

  throw new Error('这个链接不属于网易云 / QQ 音乐 / 酷狗，暂时没法导入。请复制这三家的歌单链接。');
}

/**
 * 从酷狗地址里把「歌单号那一套参数」抠出来。
 *
 * 分享页落地后的 query 长这样：
 *   ?chain=…&uid=…&listid=…&global_collection_id=collection_3_<uid>_<listid>_0&sign=…&share_type=collect&type=0
 * 老版本只认 specialid，结果把 listid=2 当成 specialid 去请求，
 * 读回来的是一张完全不相干的歌单 —— 所以这里按用途分开，别混着用。
 */
function pickKugouShareInfo(target) {
  const query = new URLSearchParams(target.search);
  const get = (...names) => {
    for (const name of names) {
      const value = String(query.get(name) || '');
      if (value) return value;
    }
    return '';
  };
  const path = target.pathname;
  const globalCollectionId = get('global_collection_id');
  // collection_3_66261955_2_0 → uid=66261955、listid=2，缺参数时拿它兜底
  const uidFromCollection = globalCollectionId.match(/^collection_\d+_(\d+)_\d+/)?.[1] || '';
  const listidFromCollection = globalCollectionId.match(/^collection_\d+_\d+_(\d+)_/)?.[1] || '';
  const specialid =
    String(get('specialid') || '').match(/\d{3,}/)?.[0] ||
    path.match(/\/plist\/list\/(\d+)/i)?.[1] ||
    path.match(/\/special\/(?:single\/)?(\d+)/i)?.[1] ||
    // 只有老的 share.html?id=<数字> 是公开歌单；zlist 页面的 id 不能这么认
    (/share\.html/i.test(path) ? String(get('id') || '').match(/\d{3,}/)?.[0] || '' : '');
  return {
    specialid: String(specialid),
    uid: get('uid') || uidFromCollection,
    listid: get('listid') || listidFromCollection,
    chain: get('chain'),
    sign: get('sign'),
    shareType: get('share_type'),
    globalCollectionId,
  };
}

/**
 * 酷狗分享短链：一跳一跳把 302 跟完，只拿落地地址，不下载页面正文。
 *
 * 为什么不直接 fetch(redirect:'follow')：那个会把整个分享页（十几 KB，
 * 内联了十几张 base64 图标）全下下来，用户粘贴完要干等。手动模式只读
 * Location 头，实测一跳就到，150ms 左右。
 *
 * 超时 12 秒（用户从粘贴到看到结果就指望这一下），失败由调用方重试一次。
 */
async function followKugouShareLink(link, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = link;
    // 正常一跳就够；给 4 跳是防酷狗以后多加一层中转域名
    for (let hop = 0; hop < 4; hop += 1) {
      const response = await fetch(current, {
        headers: { 'user-agent': KUGOU_MOBILE_UA, referer: 'https://m.kugou.com/' },
        redirect: 'manual',
        signal: controller.signal,
      });
      // 手动模式下正文不会自动读，但也不能就这么扔着，否则连接不释放
      try {
        await response.body?.cancel();
      } catch {
        /* 已经关掉就算了 */
      }
      const location = response.headers.get('location') || '';
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current).href;
        continue;
      }
      return current;
    }
    return current;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 短链解析只重试一次：酷狗那边偶发 502/连接重置，重试能救回来大半；
 * 再多用户就该觉得「点一下卡半天」了。
 */
async function followKugouShareLinkWithRetry(link) {
  try {
    return await followKugouShareLink(link);
  } catch {
    return followKugouShareLink(link);
  }
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

async function publicPlaylistSongs(platform, playlistId) {
  /*
   * 酷狗自建歌单的 ID 是 opaque 的（collect:uid:listid:chain:sign），
   * 里面自带了读取它需要的全部凭证，跟平台参数无关，先单独认掉。
   * 不先认的话它会被当成 specialid 送进 /plist/list/<数字>，白跑一趟还读错歌单。
   */
  const kugouCollect = parseKugouCollectPlaylistId(playlistId);
  if (kugouCollect) return kugouCollectPlaylistSongs(kugouCollect);
  if (platform === 'netease') return neteasePublicPlaylistSongs(playlistId);
  if (platform === 'qq') return qqPublicPlaylistSongs(playlistId);
  if (platform === 'kugou') return kugouPlaylistSongs({}, playlistId);
  if (platform === 'kuwo') return kuwoPublicPlaylistSongs(playlistId);
  throw new Error('不支持的平台');
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

async function accountPlaylists(platform, session) {
  if (!session) throw new Error('还没有登录');
  if (platform === 'qq') return qqMyPlaylists(session);
  if (platform === 'kugou') return kugouMyPlaylists(session);
  if (platform === 'kuwo') return kuwoMyPlaylists(session);
  throw new Error('不支持的平台');
}

async function accountPlaylistSongs(platform, session, playlistId) {
  if (!session) throw new Error('还没有登录');
  if (platform === 'qq') return qqPlaylistSongs(session, playlistId);
  if (platform === 'kugou') return kugouPlaylistSongs(session, playlistId);
  if (platform === 'kuwo') return kuwoMyPlaylistSongs(session, playlistId);
  throw new Error('不支持的平台');
}

module.exports = { accountPlaylists, accountPlaylistSongs, normalizeQqUin, resolveKugouUserId, humanizeError, publicPlaza, publicPlaylistSongs, qqPublicPlaylistSongs };

/* ------------------------------------------------------------------ */
/* 网页获取：在已登录的内置窗口里，用页面自己的环境请求接口             */
/* ------------------------------------------------------------------ */
/*
 * 为什么不在 Node 里直接请求：
 * 腾讯/酷狗把自己的接口锁在「同源 + 登录态 + 客户端签名」三重条件后面。
 * 我们在 Node 里硬拼 cookie，经常被当成未登录（空的 200），
 * 而且签名算法在它们自己的 JS 包里，复刻不稳。
 *
 * 换个思路：开一个用 persist:music-<platform>-login 分区的窗口，
 * 先加载同源页面（这样 cookie / Referer / 签名上下文全是天然的），
 * 再用 executeJavaScript 让**页面自己去 fetch**。
 * 对服务端来说这就是一次正常的站内请求，没有理由拒绝。
 *
 * 拿到的仍然是我们熟悉的 JSON，所以解析逻辑可以复用，
 * 不依赖任何 DOM 类名，也就不会被改版打崩。
 */

/** 网页模式下每个平台要加载的「起点页」，用来建立同源上下文。 */
const WEB_ORIGIN = {
  qq: 'https://y.qq.com/',
  kugou: 'https://www.kugou.com/',
};

/**
 * 「我的歌单」页面：接口全挂时退到读页面里的链接。
 *
 * 每个平台给多个候选：站点改版时老地址会 404，依次试到能出歌单为止。
 * 注意酷狗必须用网页版个人中心 —— 移动站那几个 ?json=true 地址现在统一回
 * 「Access Deny」，当页面打开只会得到一段错误文本。
 */
const WEB_MINE_PAGE = {
  qq: [
    'https://y.qq.com/n/ryqq_v2/profile/create',
    'https://y.qq.com/n/ryqq_v2/profile',
    'https://y.qq.com/n/ryqq_v2/profile/like/song',
  ],
  // 酷狗的 yy/html/user.html 回 "Access Deny"、mix/mine.html 404、
  // m.kugou.com/user/index 回 "No Action Found!"。
  // 唯一能用的「我的歌单」就是移动站那个 JSON 接口 ——
  // 直接让窗口导航过去，页面本身就是 JSON，省得抓包。
  kugou: [
    'https://m.kugou.com/plist/mylist?json=true',
  ],
};

/**
 * 「我喜欢的音乐」不在歌单接口的返回里 —— 它是页面上的固定入口，不是用户
 * 创建的歌单，所以接口翻遍也翻不到。这里单独造一条虚拟歌单排在最前面，
 * 点进去时用同样的抓包方式打开「我喜欢」页面，把页面自己发出的歌曲请求抄回来。
 */
const LIKED_ID = '__liked__';
const LIKED_NAME = '我喜欢的音乐';
const LIKED_PAGE = {
  qq: ['https://y.qq.com/n/ryqq_v2/profile/like/song', 'https://y.qq.com/n/ryqq_v2/profile'],
  kugou: ['https://www.kugou.com/yy/html/user.html', 'https://www.kugou.com/mix/mine.html'],
};

/** 给歌单列表补一条「我喜欢的音乐」（网易云的接口自带，不用补）。 */
function withLikedPlaylist(platform, list) {
  if (platform !== 'qq' && platform !== 'kugou') return list;
  const rows = Array.isArray(list) ? list.slice() : [];
  if (rows.some((item) => item && (item.id === LIKED_ID || item.liked))) return rows;
  rows.unshift({ id: LIKED_ID, name: LIKED_NAME, cover: '', count: 0, creator: '', liked: true });
  return rows;
}

/**
 * 从任意 JSON 里捞出「一组歌」。
 *
 * 三个平台的字段名各不相同（songname/name/filename、singer/author/singername…），
 * 而站点随时改接口名。所以这里不认接口，只认「长得像歌的对象」：
 * 只要有标题字段 + 歌手字段，连续 3 个以上就当成一组歌。
 */
function pickSongsFromJson(root) {
  const out = [];
  const seen = new Set();
  const titleKeys = ['songname', 'song_name', 'songName', 'filename', 'title', 'name'];
  const artistKeys = ['singername', 'singer_name', 'singers', 'singer', 'artist', 'author_name', 'author'];
  const rowsFrom = (node) => {
    const rows = [];
    for (const item of node) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      let title = '';
      for (const k of titleKeys) {
        const v = item[k];
        if (typeof v === 'string' && v.trim()) { title = v.trim(); break; }
      }
      if (!title) continue;
      let artistRaw = null;
      for (const k of artistKeys) {
        if (item[k]) { artistRaw = item[k]; break; }
      }
      if (!artistRaw) continue;
      let artist = '';
      if (typeof artistRaw === 'string') artist = artistRaw;
      else if (Array.isArray(artistRaw)) {
        artist = artistRaw
          .map((s) => (s && (s.name || s.singer_name || s.nick)) || '')
          .filter(Boolean)
          .join(' / ');
      } else if (typeof artistRaw === 'object') {
        artist = String(artistRaw.name || artistRaw.singer_name || '');
      }
      const albumObj = item.album && typeof item.album === 'object' ? item.album : {};
      let cover = String(item.albummid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + item.albummid + '.jpg' : '');
      if (!cover) cover = String(albumObj.picUrl || item.img || item.cover || item.albumimg || item.album_pic || '');
      rows.push({
        title,
        artist,
        album: String(item.albumname || albumObj.name || item.album_name || ''),
        cover: httpsify(cover),
        mid: String(item.songmid || item.mid || item.hash || item.filehash || item.audio_id || item.id || ''),
      });
    }
    return rows;
  };
  const visit = (node, depth) => {
    if (!node || depth > 9 || out.length > 500) return;
    if (Array.isArray(node)) {
      const rows = rowsFrom(node);
      if (rows.length >= 3) {
        for (const row of rows) {
          const key = row.mid + '|' + row.title;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(row);
        }
        return;
      }
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) visit(node[key], depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

/**
 * 最后的兜底：把「我的歌单」页面加载出来，直接读页面上的歌单链接。
 *
 * 接口签名 / 字段随时会变，但「我创建的歌单」在页面上一定是一堆链接，
 * 所以这条路的寿命反而更长。只取 id、名字、封面和曲目数，不碰 DOM 结构。
 */
async function webPlaylistsFromDom(platform, win) {
  const pages = Array.isArray(WEB_MINE_PAGE[platform]) ? WEB_MINE_PAGE[platform] : [WEB_MINE_PAGE[platform]];
  if (!pages.length) return { ok: false, list: [], error: '没有这个平台的页面' };
  for (const page of pages) {
  try {
    await win.loadURL(page);
    // 歌单卡片是异步渲染的，给它一点时间
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const result = await win.webContents.executeJavaScript(
      `(() => {
        const out = { ok: false, list: [], error: '' };
        const seen = new Set();
        const idOf = (href) => {
          const patterns = [/disstid=(\\d+)/i, /dissid=(\\d+)/i, /taoge\\/(\\d+)/i, /playlist\\/(\\d+)/i, /plist\\/list\\/(\\d+)/i, /special\\/(\\d+)/i, /specialid=(\\d+)/i];
          for (const re of patterns) {
            const m = href.match(re);
            if (m) return m[1];
          }
          return '';
        };
        document.querySelectorAll('a[href]').forEach((a) => {
          const href = a.getAttribute('href') || '';
          const id = idOf(href);
          if (!id || seen.has(id)) return;
          const box = a.closest('li, div');
          const img = a.querySelector('img') || (box && box.querySelector('img'));
          const name =
            (a.getAttribute('title') || '').trim() ||
            (img && (img.getAttribute('alt') || '').trim()) ||
            (a.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!name || name.length > 60) return;
          const countMatch = (box ? box.textContent : '').match(/(\\d+)\\s*(首|曲)/);
          seen.add(id);
          out.list.push({
            id,
            name,
            cover: img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '',
            count: countMatch ? Number(countMatch[1]) : 0,
            creator: '',
          });
        });
        out.ok = out.list.length > 0;
        if (!out.ok) out.error = '页面里没有找到歌单链接（可能需要先登录）';
        return out;
      })()`,
      true
    );
    if (result && result.ok && result.list.length) return result;
  } catch (error) {
    // 单个候选页面失败就换下一个
  }
  return { ok: false, list: [], error: '页面里没有找到歌单链接（可能需要先登录）' };
  }
}

/**
 * 组装拿「我的歌单」的页面内脚本。
 * 返回一个表达式字符串，窗口执行后得到 { ok, list, error, tried }。
 */
function qqPlaylistsScript(session) {
  /*
   * 这里也走补齐别名后的 cookie：网页里跑的 fetch 带的是浏览器自己的 cookie，
   * 但 comm 里的 uin / qm_keyst 是我们自己填的，填错就一样回 500003。
   */
  const canonical = cookiePairs(canonicalCookieHeader('qq', session));
  const pick = (name) => (canonical.find(([n]) => n === name) || [])[1] || '';
  const uin = normalizeQqUin(pick('uin') || session.uin || session.p_uin || '');
  // 网页 fetch 自动带 cookie，但 comm 必须和页面自己的请求一样补 g_tk。
  const gtk = qqGtkOld(session);
  const req = {
    comm: qqComm(session, uin),
    req_1: {
      module: 'music.mine.PlaylistAssembleServer',
      method: 'get_mine_playlist',
      param: { uin, offset: 0, limit: 100, only_self: 1 },
    },
    req_2: {
      module: 'music.mine.PlaylistAssembleServer',
      method: 'get_collect_playlist',
      param: { uin, offset: 0, limit: 100 },
    },
  };
  const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&g_tk=' + gtk + '&data=' + encodeURIComponent(JSON.stringify(req));
  return `(async () => {
    const out = { ok: false, list: [], error: '', tried: 'web:musicu.mine' };
    try {
      const res = await fetch(${JSON.stringify(url)}, { credentials: 'include', cache: 'no-store' });
      const json = await res.json();
      const pick = [];
      for (const node of ['req_1', 'req_2']) {
        const data = (json && json[node] && json[node].data) || {};
        for (const key of ['v_playlist', 'list', 'v_list', 'playlist']) {
          if (Array.isArray(data[key])) pick.push(...data[key]);
        }
      }
      const codes = ['req_1', 'req_2'].map((n) => (json && json[n] ? json[n].code : null)).filter((c) => c !== null);
      out.list = pick.map((item) => ({
        id: String(item.tid || item.dissid || item.id || ''),
        name: String(item.dirName || item.dissname || item.name || item.title || ''),
        cover: String(item.picUrl || item.diss_cover || item.logo || item.cover || ''),
        count: Number(item.songNum || item.song_count || item.songnum || item.total || 0),
        creator: String(item.nick || (item.creator && item.creator.nick) || ''),
      })).filter((x) => x.id && x.name);
      out.ok = out.list.length > 0;
      if (!out.ok) out.error = '接口返回空列表（code ' + JSON.stringify(codes) + '）';
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  })()`;
}

function kugouPlaylistsScript(session) {
  // 和 kugouMyPlaylists 用同一个规范化查找，避免 web 脚本读不到 userid
  const userid = kugouUserId(session);
  /*
   * 只有 mobilecdn 这一条剩下：网页版 /yy/index.php?r=playlist/user 已经
   * 统一回 "Access Deny !!!"，留着只是白等一次超时。
   * 注意页面是 https，这里只能发 https 的同站兼容地址。
   */
  const urls = [
    `https://mobilecdn.kugou.com/api/v3/user/playlist?userid=${encodeURIComponent(userid)}&page=1&pagesize=50&type=0`,
  ];
  return `(async () => {
    const out = { ok: false, list: [], error: '', tried: '' };
    const urls = ${JSON.stringify(urls)};
    for (const url of urls) {
      out.tried = 'web:' + url.replace(/\\?.*$/, '');
      try {
        const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
        const json = await res.json();
        const arr = (json && json.data && (json.data.info || json.data.list)) || [];
        const list = arr.map((item) => ({
          id: String(item.specialid || item.listid || ''),
          name: String(item.specialname || item.name || ''),
          cover: String(item.imgurl || item.img || ''),
          count: Number(item.songcount || item.song_count || 0),
          creator: String(item.nickname || ''),
        })).filter((x) => x.id && x.name);
        if (list.length) { out.ok = true; out.list = list; out.error = ''; break; }
        out.error = '返回空列表';
      } catch (e) {
        out.error = String((e && e.message) || e);
      }
    }
    return out;
  })()`;
}

/**
 * 从任意 JSON 里挖「歌单数组」。
 *
 * 站点回包的字段名五花八门（dissid/specialid/listid/dirId…），但一定有
 * 「id + 名字」这一对。这里递归扫一遍，凡是同时带 id 和名字的对象就当歌单。
 */
function pickPlaylistsFromJson(root) {
  const out = [];
  const seen = new Set();
  const idKeys = ['dissid', 'tid', 'specialid', 'listid', 'dirId', 'diss_id'];
  const nameKeys = ['dissname', 'diss_name', 'specialname', 'name', 'dirName', 'title', 'listname'];
  const visit = (node, depth) => {
    if (!node || depth > 9) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object') {
          const idKey = idKeys.find((k) => item[k] != null && String(item[k]).trim());
          const nameKey = nameKeys.find((k) => item[k] != null && String(item[k]).trim());
          if (idKey && nameKey) {
            const id = String(item[idKey]).trim();
            if (!seen.has(id)) {
              seen.add(id);
              out.push({
                id,
                name: String(item[nameKey]).trim(),
                cover: httpsify(
                  String(
                    item.diss_cover || item.logo || item.imgurl || item.cover || item.picUrl || item.img || ''
                  )
                ),
                count: Number(
                  item.song_cnt || item.songnum || item.songcount || item.song_count || item.total || 0
                ),
                creator: String(
                  item.nick || item.nickname || (item.creator && item.creator.nick) || ''
                ),
              });
            }
          }
        }
        visit(item, depth + 1);
      }
      return;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) visit(node[key], depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

/**
 * 最稳的一条路：让网站自己发请求，我们从旁边把回包抄下来。
 *
 * 站点的接口名和签名随时会改（QQ 那边换个模块名就回 500003，酷狗那边直接
 * Access Deny），但页面自己一定要拉「我的歌单」。所以这里挂上 DevTools 的
 * Network 监听，把它发出的 JSON 回包全抄一遍，再从里面挖歌单 —— 完全不依赖
 * 任何模块名或签名算法。
 */
async function captureMinePlaylists(platform, win) {
  const pages = WEB_MINE_PAGE[platform] || [];
  if (!pages.length) return { ok: false, list: [], error: '没有这个平台的页面' };
  const dbg = win.webContents.debugger;
  const bodies = [];
  try {
    dbg.attach('1.3');
  } catch (error) {
    return { ok: false, list: [], error: '无法监听网络：' + String((error && error.message) || error) };
  }
  const onMessage = (_event, method, params) => {
    if (method !== 'Network.responseReceived') return;
    const mime = String((params.response && params.response.mimeType) || '');
    if (!/json/i.test(mime)) return;
    dbg
      .sendCommand('Network.getResponseBody', { requestId: params.requestId })
      .then((r) => {
        const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
        if (text && text.length < 600000) bodies.push(text);
      })
      .catch(() => {});
  };
  try {
    await dbg.sendCommand('Network.enable');
    dbg.on('message', onMessage);
    for (const page of pages) {
      try {
        await withDeadline(win.loadURL(page), 10000, '打开歌单页');
        await new Promise((resolve) => setTimeout(resolve, 3500));
        try {
          await withDeadline(
            win.webContents.executeJavaScript(
              'window.scrollTo(0, document.body.scrollHeight); true',
              true
            ),
            5000,
            '滚动歌单页'
          );
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const seen = new Set();
        const list = [];
        for (const text of bodies) {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            continue;
          }
          for (const item of pickPlaylistsFromJson(json)) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            list.push(item);
          }
        }
        if (list.length) return { ok: true, list, error: '' };
      } catch {
        /* 换下一个候选页面 */
      }
    }
    return {
      ok: false,
      list: [],
      error: bodies.length
        ? `页面发了 ${bodies.length} 个 JSON 请求，但里面没有歌单（多半是登录态失效）`
        : '页面没有发出任何歌单请求',
    };
  } finally {
    try {
      dbg.removeListener('message', onMessage);
    } catch {}
    try {
      dbg.detach();
    } catch {}
  }
}

/**
 * 酷狗专用：直接导航到移动站 JSON 接口，读页面文本。
 *
 * 酷狗的网页个人页全被封了（Access Deny / 404），唯一能用的「我的歌单」
 * 就是 m.kugou.com/plist/mylist?json=true。它在登录态下直接返回 JSON，
 * 不需要抓包、不需要拼 cookie——浏览器自动带。
 */
async function captureKugouDirect(win) {
  // 移动站首页和 JSON 页都会在隐藏窗口里被自己的脚本打断成 ERR_ABORTED(-3)。
  // 先用 robots.txt 建立 m.kugou.com 同源上下文（它没有跳转脚本），
  // 再在页面里 fetch 歌单接口；cookie 由分区自动带上，不经过导航。
  const url = KUGOU_MYLIST_URL;
  try {
    win.webContents.setUserAgent(KUGOU_MOBILE_UA);
  } catch {
    /* ignore */
  }
  try {
    await withDeadline(win.loadURL('https://m.kugou.com/robots.txt'), 10000, '打开酷狗移动站');
  } catch (error) {
    return { ok: false, list: [], error: '打开移动站失败：' + String((error && error.message) || error) };
  }
  await new Promise((r) => setTimeout(r, 1000));
  let text = '';
  try {
    text = await withDeadline(
      win.webContents.executeJavaScript(
        '(async () => {' +
          'const res = await fetch(' + JSON.stringify(url) + ', {' +
          "credentials: 'include'," +
          "cache: 'no-store'," +
          "headers: { accept: 'application/json, text/plain, */*' }" +
          '});' +
          'return await res.text();' +
        '})()',
        true
      ),
      12000,
      '读取酷狗歌单接口'
    );
  } catch (error) {
    return { ok: false, list: [], error: '读取接口失败：' + String((error && error.message) || error) };
  }
  if (!text || !text.trim()) {
    return { ok: false, list: [], error: '接口没有返回内容（可能未登录）' };
  }
  if (/Access Deny/.test(text)) {
    return { ok: false, list: [], error: '登录态失效（Access Deny），请重新登录酷狗' };
  }
  const json = parseKugouJson(text);
  if (!json) {
    return { ok: false, list: [], error: '接口返回的不是有效 JSON：' + text.slice(0, 100) };
  }
  const list = pickKugouPlaylists(json);
  if (!list.length) {
    return { ok: false, list: [], error: 'JSON 里没找到歌单' };
  }
  return { ok: true, list, error: '' };
}

/**
 * 抓「我喜欢的音乐」：打开「我喜欢」页面，把页面自己发出的歌曲请求抄回来。
 * 与 captureMinePlaylists 同一套思路，区别只是最终挑的是「歌」而不是「歌单」。
 */
async function captureLikedSongs(platform, win) {
  const pages = LIKED_PAGE[platform] || [];
  if (!pages.length) return { ok: false, songs: [], error: '没有这个平台的页面' };
  const dbg = win.webContents.debugger;
  const bodies = [];
  try {
    dbg.attach('1.3');
  } catch (error) {
    return { ok: false, songs: [], error: '无法监听网络：' + String((error && error.message) || error) };
  }
  const onMessage = (_event, method, params) => {
    if (method !== 'Network.responseReceived') return;
    const mime = String((params.response && params.response.mimeType) || '');
    if (!/json/i.test(mime)) return;
    dbg
      .sendCommand('Network.getResponseBody', { requestId: params.requestId })
      .then((r) => {
        const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
        if (text && text.length < 900000) bodies.push(text);
      })
      .catch(() => {});
  };
  try {
    await dbg.sendCommand('Network.enable');
    dbg.on('message', onMessage);
    for (const page of pages) {
      try {
        await withDeadline(win.loadURL(page), 10000, '打开我喜欢');
        await new Promise((resolve) => setTimeout(resolve, 3500));
        // 「我喜欢」是长列表，多滚两次才会把后面的歌请求出来
        for (let i = 0; i < 3; i += 1) {
          try {
            await withDeadline(
              win.webContents.executeJavaScript(
                'window.scrollTo(0, document.body.scrollHeight); true',
                true
              ),
              4000,
              '滚动我喜欢'
            );
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        const songs = [];
        const seen = new Set();
        for (const text of bodies) {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            continue;
          }
          for (const row of pickSongsFromJson(json)) {
            const key = row.mid + '|' + row.title;
            if (seen.has(key)) continue;
            seen.add(key);
            songs.push(row);
          }
        }
        if (songs.length) return { ok: true, songs, error: '' };
      } catch {
        /* 换下一个候选页面 */
      }
    }
    return {
      ok: false,
      songs: [],
      error: bodies.length
        ? '页面发了 ' + bodies.length + ' 个 JSON 请求，但里面没有歌曲（多半是登录态失效）'
        : '页面没有发出任何歌曲请求',
    };
  } finally {
    try {
      dbg.removeListener('message', onMessage);
    } catch {}
    try {
      dbg.detach();
    } catch {}
  }
}

/** 网页方式取「我喜欢的音乐」。 */
async function webLikedSongs(platform, session, deps = {}) {
  const { getWindow } = deps;
  if (typeof getWindow !== 'function') throw new Error('网页获取不可用：没有拿到登录窗口');
  const { win, ownWindow } = await getWindow(platform);
  try {
    const result = await withDeadline(
      captureLikedSongs(platform, win),
      32000,
      '读取我喜欢的音乐'
    );
    if (result.ok && result.songs.length) {
      return { name: LIKED_NAME, cover: '', songs: result.songs };
    }
    throw new Error(result.error || '没有读到歌曲');
  } finally {
    if (ownWindow) {
      try {
        win.destroy();
      } catch {}
    }
  }
}

/**
 * 在网页上下文里取「我的歌单」。
 * @param {object} deps { getWindow, platform } —— 由 main.js 注入，用来拿到带登录态的内置窗口
 */
async function webMyPlaylists(platform, session, deps = {}) {
  const { getWindow } = deps;
  if (typeof getWindow !== 'function') throw new Error('网页获取不可用：没有拿到登录窗口');
  const { win, ownWindow } = await getWindow(platform);
  const script = platform === 'qq' ? qqPlaylistsScript(session) : kugouPlaylistsScript(session);
  // 酷狗移动站 m.kugou.com 只对手机 UA 返回 JSON，桌面 UA 一律回 Access Deny。
  // 抓取窗口默认是桌面 UA（main.js 里设的），这里临时切成移动 UA。
  if (platform === 'kugou') {
    try {
      win.webContents.setUserAgent(KUGOU_MOBILE_UA);
    } catch {
      /* ignore */
    }
  }
  try {
    // ① 对酷狗：直接导航到移动站 JSON 接口读页面文本。
    //    对 QQ音乐：debugger 抓包只给很短的尝试时间；隐藏窗口里它经常挂住，
    //    不能让它吃掉整个网页兜底的时间。真正主要的步骤是②的站内 fetch。
    let captured = null;
    if (platform === 'kugou') {
      try {
        captured = await withDeadline(captureKugouDirect(win), 15000, '酷狗直读');
      } catch (error) {
        captured = { ok: false, list: [], error: String((error && error.message) || error) };
      }
      if (captured && captured.ok && captured.list.length) {
        return captured.list.map((item) => ({ ...item, cover: httpsify(item.cover) }));
      }
    } else {
      try {
        captured = await withDeadline(captureMinePlaylists(platform, win), 10000, 'QQ 音乐站内抓包');
      } catch (error) {
        captured = { ok: false, list: [], error: String((error && error.message) || error) };
      }
      if (captured && captured.ok && captured.list.length) {
        return captured.list.map((item) => ({ ...item, cover: httpsify(item.cover) }));
      }
    }

    // ② 确保在平台页面，然后跑页面脚本 fetch。
    // QQ 直接打开「我创建的歌单」页：用户反馈必须切到这个 tab，页面才会真正发歌单请求。
    // /profile 默认落在「我喜欢」，隐藏窗口里还容易被路由重定向打断成 ERR_ABORTED(-3)。
    const current = win.webContents.getURL();
    const targetPage = platform === 'qq' ? 'https://y.qq.com/n/ryqq_v2/profile/create' : WEB_ORIGIN[platform];
    const already = platform === 'qq'
      ? current && current.includes('/n/ryqq_v2/profile') && current.includes('/create')
      : current && current.startsWith(targetPage);
    if (!already) {
      /*
       * 这里的 loadURL 经常以 ERR_ABORTED(-3) 失败，但页面其实是加载成功的：
       * y.qq.com 的 SPA 打开后会自己再做一次路由跳转（/ryqq_v2/profile/create
       * 会被再导航一遍），第二次导航把第一次顶掉，Electron 就把 await 抛出来。
       * 之前这里一抛，整个网页兜底直接报废，qqPlaylistsScript 根本没机会跑，
       * 用户看到的就是「网页也失败（ERR_ABORTED (-3) ...）」。
       * 所以：错误码是 -3 时当作「页面自己在跳转」，继续往下走。
       */
      try {
        await withDeadline(win.loadURL(targetPage), 15000, '打开平台页面');
      } catch (error) {
        const text = String((error && (error.message || error.code)) || error);
        if (!/ERR_ABORTED|\b-3\b/i.test(text)) throw error;
      }
      await new Promise((r) => setTimeout(r, platform === 'qq' ? 5000 : 2000));
    }
    let result = null;
    try {
      result = await withDeadline(win.webContents.executeJavaScript(script, true), 15000, '页面脚本');
    } catch (error) {
      result = { ok: false, error: String((error && error.message) || error) };
    }
    if (result && result.ok && result.list.length) {
      return result.list.map((item) => ({ ...item, cover: httpsify(item.cover) }));
    }
    const detail = humanizeError((result && (result.error || result.tried)) || '未知原因');

    // ③ 最后退到读页面链接（仅 QQ 音乐有意义）
    let dom = null;
    try {
      dom = await withDeadline(webPlaylistsFromDom(platform, win), 10000, '读页面歌单链接');
    } catch (error) {
      dom = { ok: false, list: [], error: String((error && error.message) || error) };
    }
    if (dom && dom.ok && dom.list.length) {
      return dom.list.map((item) => ({ ...item, cover: httpsify(item.cover) }));
    }
    throw new Error(
      `没有拿到歌单（${platform === 'kugou' ? '酷狗直读：' + humanizeError((captured && captured.error) || '无结果') : '接口：' + detail}；页面：${humanizeError((dom && dom.error) || '无结果')}）`
    );
  } finally {
    if (ownWindow) {
      try {
        win.destroy();
      } catch {}
    }
  }
}

module.exports.canonicalCookieHeader = canonicalCookieHeader;
module.exports.describeSession = describeSession;
module.exports.webMyPlaylists = webMyPlaylists;
module.exports.qqPlaylistsScript = qqPlaylistsScript;
module.exports.kugouPlaylistsScript = kugouPlaylistsScript;

/**
 * 判断一条错误信息是不是「登录态失效」。
 *
 * QQ 音乐不给登录态时返回 500003；酷狗直接回 Access Deny；
 * 网页兜底那边则是页面里压根找不到歌单链接。这三种在用户眼里是同一件事：
 * 该重新登录了。统一收在这里，界面就能据此给「重新登录」按钮。
 */
function looksExpired(message) {
  return /500003|access deny|没有找到歌单链接|登录态|没有酷狗用户 ID|请重新登录/i.test(String(message || ''));
}

module.exports.looksExpired = looksExpired;

module.exports.LIKED_ID = LIKED_ID;
module.exports.withLikedPlaylist = withLikedPlaylist;
module.exports.webLikedSongs = webLikedSongs;
module.exports.pickSongsFromJson = pickSongsFromJson;
module.exports.publicPlaza = publicPlaza;
module.exports.publicPlaylistSongs = publicPlaylistSongs;
module.exports.parseSharedPlaylistLink = parseSharedPlaylistLink;
