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
  const digits = text.replace(/^o/, '').replace(/\D/g, '');
  return digits;
}

async function qqMyPlaylists(session) {
  const uin = normalizeQqUin(session.uin || session.p_uin || session.ptui_loginuin || session.luin || '');
  if (!uin) throw new Error('登录信息里没有 QQ 号，请重新登录');

  const cookie = session.__cookieHeader || '';
  const headers = { referer: 'https://y.qq.com/', cookie };
  const keyst = qqLoginKeys(session);

  // 依次尝试；每一组都把失败原因带上，界面直接显示，方便一眼看出是
  // cookie 不全（服务端当未登录）还是接口改版（返回结构变了）。
  const candidates = [
    {
      name: 'musicu.mine',
      url: () =>
        'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' +
        encodeURIComponent(
          JSON.stringify({
            comm: { ct: 24, cv: 0, uin: Number(uin) || 0, format: 'json', ...(keyst ? { qm_keyst: keyst } : {}) },
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
            comm: { ct: 24, cv: 0, uin: Number(uin) || 0, format: 'json', ...(keyst ? { qm_keyst: keyst } : {}) },
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
      const json = await fetchJson(candidate.url(), headers);
      const list = candidate.pick(json);
      if (Array.isArray(list) && list.length) {
        const mapped = list.map(candidate.map).filter((item) => item.id && item.name);
        if (mapped.length) return mapped;
      }
      // 结构对但列表为空：记下来，别让它被后面的网络错误顶掉
      const code = json?.req_0?.code || json?.code;
      errors.push(`${candidate.name}: 返回空歌单${code ? `（code ${code}）` : ''}`);
    } catch (error) {
      errors.push(`${candidate.name}: ${error.message}`);
    }
  }
  throw new Error(errors[0] || '没有读取到歌单');
}

async function qqPlaylistSongs(session, dissId) {
  const cookie = session.__cookieHeader || '';
  const headers = { referer: 'https://y.qq.com/', cookie };
  const uin = normalizeQqUin(session.uin || session.p_uin || session.ptui_loginuin || session.luin || '');
  const url =
    'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=' +
    encodeURIComponent(dissId) +
    '&format=json&g_tk=5381&loginUin=' +
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

async function kugouMyPlaylists(session) {
  const userid = String(session.userid || '').replace(/\D/g, '');
  if (!userid) throw new Error('登录信息里没有酷狗用户 ID，请重新登录');
  const cookie = session.__cookieHeader || '';
  const headers = { referer: 'https://www.kugou.com/yy/html/user.html', cookie };

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
      errors.push(`${candidate.name}: ${error.message}`);
    }
  }
  throw new Error(errors[0] || '没有读取到歌单');
}

async function kugouPlaylistSongs(session, listId) {
  const cookie = session.__cookieHeader || '';
  const headers = { referer: 'https://www.kugou.com/', cookie };
  const url = `https://m.kugou.com/plist/list/${encodeURIComponent(listId)}?json=true`;
  const json = await fetchJson(url, headers);
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

module.exports = { accountPlaylists, accountPlaylistSongs, normalizeQqUin };

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
 * 组装拿「我的歌单」的页面内脚本。
 * 返回一个表达式字符串，窗口执行后得到 { ok, list, error, tried }。
 */
function qqPlaylistsScript(session) {
  const uin = normalizeQqUin(session.uin || session.p_uin || session.ptui_loginuin || session.luin || '');
  const keyst = qqLoginKeys(session);
  const req = {
    comm: { ct: 24, cv: 0, uin: Number(uin) || 0, format: 'json', ...(keyst ? { qm_keyst: keyst } : {}) },
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
  const userid = String(session.userid || '').replace(/\D/g, '');
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
 * 在网页上下文里取「我的歌单」。
 * @param {object} deps { getWindow, platform } —— 由 main.js 注入，用来拿到带登录态的内置窗口
 */
async function webMyPlaylists(platform, session, deps = {}) {
  const { getWindow } = deps;
  if (typeof getWindow !== 'function') throw new Error('网页获取不可用：没有拿到登录窗口');
  const { win, ownWindow } = await getWindow(platform);
  const script = platform === 'qq' ? qqPlaylistsScript(session) : kugouPlaylistsScript(session);
  try {
    // 先落到同源页面，确保 fetch 带的是本站 cookie、Referer 也正确
    const current = win.webContents.getURL();
    if (!current || !current.startsWith(WEB_ORIGIN[platform])) {
      await win.loadURL(WEB_ORIGIN[platform]);
    }
    const result = await win.webContents.executeJavaScript(script, true);
    if (result && result.ok && result.list.length) {
      return result.list.map((item) => ({ ...item, cover: httpsify(item.cover) }));
    }
    const detail = (result && (result.error || result.tried)) || '未知原因';
    throw new Error(`网页方式没有拿到歌单（${detail}）`);
  } finally {
    if (ownWindow) {
      try {
        win.destroy();
      } catch {}
    }
  }
}

module.exports.webMyPlaylists = webMyPlaylists;
module.exports.qqPlaylistsScript = qqPlaylistsScript;
module.exports.kugouPlaylistsScript = kugouPlaylistsScript;

