'use strict';

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
    return await response.text();
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
  return String(url || '').replace(/^http:/i, 'https:');
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
  const cached = String(bag.qqmusic_key || '').trim();
  if (cached) return cached;
  // 有些版本只留了 __cookieHeader，从里面捞一次
  const header = String(bag.__cookieHeader || '');
  const match = header.match(/(?:^|;\s*)(?:qqmusic_key|qm_keyst)=([^;]+)/);
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
 * QQ 音乐的 musicu.fcg 还要求带 g_tk（由 qm_keyst 用 hash33 算出来）。
 * 只带 cookie 不带 g_tk 时，服务端一律回 500003，看起来像没登录。
 */
function qqGtk(keyst) {
  const text = String(keyst || '').trim();
  if (!text) return 0;
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0x7fffffff;
  }
  return hash & 0x7fffffff;
}

async function qqMyPlaylists(session) {
  // uin 以补齐别名后的 cookie 头为准：网页常常只写 p_uin(o123…)
  const cookie = canonicalCookieHeader('qq', session);
  const headerUin = (cookiePairs(cookie).find(([n]) => n === 'uin') || [])[1] || '';
  const uin = normalizeQqUin(
    headerUin || session.uin || session.p_uin || session.ptui_loginuin || session.luin || ''
  );
  if (!uin) throw new Error('登录信息里没有 QQ 号，请重新登录（' + describeSession('qq', session) + '）');

  const headers = { referer: 'https://y.qq.com/', cookie };
  const keyst = qqLoginKeys(session);
  const gtk = qqGtk(keyst);

  // 依次尝试；每一组都把失败原因带上，界面直接显示，方便一眼看出是
  // cookie 不全（服务端当未登录）还是接口改版（返回结构变了）。
  const candidates = [
    {
      // 老 c.y.qq.com 公开接口：只要 uin 就能读「我创建的歌单」，
      // 实测匿名也回 code 0，所以排第一 —— 登录态再怎么抽风它都能出点东西。
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
    {
      name: 'musicu.mine',
      url: () =>
        'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' +
        encodeURIComponent(
          JSON.stringify({
            comm: { ct: 24, cv: 0, uin: Number(uin) || 0, format: 'json', ...(keyst ? { qm_keyst: keyst, authst: keyst } : {}), tmeAppID: 'qqmusic' },
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
        'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' +
        encodeURIComponent(
          JSON.stringify({
            comm: { ct: 24, cv: 0, uin: Number(uin) || 0, format: 'json', ...(keyst ? { qm_keyst: keyst, authst: keyst } : {}), tmeAppID: 'qqmusic' },
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
    (errors[0] || '没有读取到歌单') + '（' + describeSession('qq', session) + '）'
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
    qqGtk(qqLoginKeys(session)) +
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
      const text = await fetchText(url, { referer: 'https://m.kugou.com/', cookie, 'user-agent': KUGOU_MOBILE_UA });
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
  const headers = { referer: 'https://www.kugou.com/yy/html/user.html', cookie };

  /*
   * 先打移动站的「我的歌单」接口 —— 它只要 cookie，不要 userid。
   * 以前第一步就要 userid，而酷狗网页登录根本不写 userid 那条 cookie，
   * 于是永远卡在「登录信息里没有酷狗用户 ID」。
   */
  try {
    const text = await fetchText(KUGOU_MYLIST_URL, { ...headers, 'user-agent': KUGOU_MOBILE_UA });
    const list = pickKugouPlaylists(parseKugouJson(text));
    if (list.length) return list;
  } catch {
    /* 落到下面的旧接口 */
  }

  const userid = await resolveKugouUserId(session);

  const candidates = [
    {
      name: 'user/playlist',
      url: `https://mobilecdn.kugou.com/api/v3/user/playlist?userid=${userid}&page=1&pagesize=50&type=0`,
      pick: (json) => json?.data?.info || [],
      map: (item) => ({
        id: String(item.specialid || item.listid || ''),
        name: String(item.specialname || item.name || ''),
        cover: httpsify((item.imgurl || '').replace('{size}', '240')),
        count: Number(item.songcount || item.song_count || 0),
        creator: String(item.nickname || ''),
      }),
    },
    {
      name: 'kugou web user list',
      url: `https://www.kugou.com/yy/index.php?r=playlist/user&userid=${userid}&page=1&pagesize=50`,
      pick: (json) => json?.data?.list || json?.data?.info || [],
      map: (item) => ({
        id: String(item.listid || item.specialid || ''),
        name: String(item.name || item.specialname || ''),
        cover: httpsify(item.imgurl || item.img || ''),
        count: Number(item.songcount || 0),
        creator: String(item.nickname || ''),
      }),
    },
  ];

  const errors = [];
  for (const candidate of candidates) {
    try {
      const json = await fetchJson(candidate.url, headers);
      const list = candidate.pick(json);
      if (Array.isArray(list) && list.length) {
        const mapped = list.map(candidate.map).filter((item) => item.id && item.name);
        if (mapped.length) return mapped;
      }
    } catch (error) {
      errors.push(`${candidate.name}: ${humanizeError(error.message)}`);
    }
  }
  throw new Error(
    (errors[0] || '没有读取到歌单') + '（' + describeSession('kugou', session) + '）'
  );
}

async function kugouPlaylistSongs(session, listId) {
  const cookie = canonicalCookieHeader('kugou', session);
  const headers = { referer: 'https://www.kugou.com/', cookie };
  const url = `https://m.kugou.com/plist/list/${encodeURIComponent(listId)}?json=true`;
  const text = await fetchText(url, { ...headers, 'user-agent': KUGOU_MOBILE_UA });
  const json = parseKugouJson(text);
  const info = json?.info || {};
  const songs = json?.list?.list || json?.songs?.list || [];
  return {
    name: String(info.specialname || info.name || info.listname || ''),
    cover: httpsify((info.imgurl || '').replace('{size}', '400')),
    songs: songs.map((item) => {
      const authors = (item.authors || []).map((a) => a.author_name).filter(Boolean);
      return {
        title: String(item.filename || item.songname || ''),
        artist: authors.join(' / '),
        cover: httpsify((item.album_sizable_cover || '').replace('{size}', '400')),
        album: String(item.album_name || ''),
        hash: String(item.hash || ''),
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

async function accountPlaylists(platform, session) {
  if (!session) throw new Error('还没有登录');
  if (platform === 'qq') return qqMyPlaylists(session);
  if (platform === 'kugou') return kugouMyPlaylists(session);
  throw new Error('不支持的平台');
}

async function accountPlaylistSongs(platform, session, playlistId) {
  if (!session) throw new Error('还没有登录');
  if (platform === 'qq') return qqPlaylistSongs(session, playlistId);
  if (platform === 'kugou') return kugouPlaylistSongs(session, playlistId);
  throw new Error('不支持的平台');
}

module.exports = { accountPlaylists, accountPlaylistSongs, normalizeQqUin, resolveKugouUserId, humanizeError };

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
    'https://y.qq.com/n/ryqq/profile',
    'https://y.qq.com/n/ryqq/mylike',
    'https://y.qq.com/portal/profile.html',
  ],
  kugou: [
    'https://www.kugou.com/yy/html/user.html',
    'https://www.kugou.com/mix/mine.html',
    'https://m.kugou.com/user/index',
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
  qq: ['https://y.qq.com/n/ryqq/mylike', 'https://y.qq.com/n/ryqq/profile'],
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
  const page = WEB_MINE_PAGE[platform];
  if (!page) return { ok: false, list: [], error: '没有这个平台的页面' };
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
    return result || { ok: false, list: [], error: '页面没有返回结果' };
  } catch (error) {
    return { ok: false, list: [], error: String((error && error.message) || error) };
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
  const keyst = String(pick('qm_keyst') || qqLoginKeys(session) || '').trim();
  const req = {
    comm: { ct: 24, cv: 0, uin: Number(uin) || 0, format: 'json', ...(keyst ? { qm_keyst: keyst, authst: keyst } : {}), tmeAppID: 'qqmusic' },
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
  const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' + encodeURIComponent(JSON.stringify(req));
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
  const urls = [
    `https://mobilecdn.kugou.com/api/v3/user/playlist?userid=${userid}&page=1&pagesize=50&type=0`,
    `https://www.kugou.com/yy/index.php?r=playlist/user&userid=${userid}&page=1&pagesize=50`,
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
  try {
    // ① 先让网站自己发请求，我们抄回包（不依赖接口名，最不容易坏）
    let captured = null;
    try {
      captured = await withDeadline(captureMinePlaylists(platform, win), 30000, '抓包');
    } catch (error) {
      captured = { ok: false, list: [], error: String((error && error.message) || error) };
    }
    if (captured && captured.ok && captured.list.length) {
      return captured.list.map((item) => ({ ...item, cover: httpsify(item.cover) }));
    }

    // ② 再自己按老接口问一次
    const current = win.webContents.getURL();
    if (!current || !current.startsWith(WEB_ORIGIN[platform])) {
      await withDeadline(win.loadURL(WEB_ORIGIN[platform]), 12000, '打开平台首页');
    }
    let result = null;
    try {
      result = await withDeadline(win.webContents.executeJavaScript(script, true), 12000, '页面脚本');
    } catch (error) {
      result = { ok: false, error: String((error && error.message) || error) };
    }
    if (result && result.ok && result.list.length) {
      return result.list.map((item) => ({ ...item, cover: httpsify(item.cover) }));
    }
    const detail = humanizeError((result && (result.error || result.tried)) || '未知原因');

    // ③ 最后退到读页面链接
    let dom = null;
    try {
      dom = await withDeadline(webPlaylistsFromDom(platform, win), 12000, '读页面歌单链接');
    } catch (error) {
      dom = { ok: false, list: [], error: String((error && error.message) || error) };
    }
    if (dom && dom.ok && dom.list.length) {
      return dom.list.map((item) => ({ ...item, cover: httpsify(item.cover) }));
    }
    throw new Error(
      `没有拿到歌单（抓包：${humanizeError(
        (captured && captured.error) || '无结果'
      )}；接口：${detail}；页面：${humanizeError((dom && dom.error) || '无结果')}）`
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
