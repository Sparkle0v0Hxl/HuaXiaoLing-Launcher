'use strict';

/**
 * QQ 音乐 / 酷狗的「无需登录」能力。
 *
 * 这两家的登录与取音频地址都需要客户端私有签名，纯 Node 环境拿不到：
 * - QQ 音乐：ptqrlogin 需要 login_sig，CgiGetVkey 返回 retcode 405
 * - 酷狗：qrcode 接口固定返回 20010；complexsearch 返回 err signature
 *
 * 所以这里只做真正能稳定做到的事：拉公开榜单 / 歌单的**曲目列表**
 * （歌名、歌手、专辑图）。用户看到列表后可以：
 *   - 点「打开原站」在浏览器里听；
 *   - 或者把这些曲目当成点歌台的搜索关键词，交给已有的网易云服务找同名曲目。
 *
 * 这样不会出现「登录成功但放不出声」的半残体验。
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function getJson(url, headers = {}) {
  const { signal, done } = withTimeout(18000);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json', ...headers },
      signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    done();
  }
}

function httpsify(url) {
  return String(url || '').replace(/^http:/i, 'https:');
}

/* ------------------------------------------------------------------ */
/* QQ 音乐                                                             */
/* ------------------------------------------------------------------ */

/** QQ 音乐的榜单（公开数据，无需登录）。 */
async function qqToplists() {
  const data = await getJson(
    'https://u.y.qq.com/cgi-bin/musicu.fcg?data=' +
      encodeURIComponent(
        JSON.stringify({
          req_0: {
            module: 'musicToplist.ToplistInfoServer',
            method: 'GetAll',
            param: {},
          },
        })
      ),
    { referer: 'https://y.qq.com/' }
  );
  const groups = data?.req_0?.data?.group || [];
  const list = [];
  for (const group of groups) {
    for (const item of group.toplist || []) {
      list.push({
        id: String(item.topId || item.id || ''),
        name: String(item.title || item.name || ''),
        cover: httpsify(item.frontPicUrl || item.picUrl || ''),
        updateKey: String(item.updateKey || ''),
        group: String(group.groupName || ''),
      });
    }
  }
  return list.filter((item) => item.id && item.name);
}

/**
 * QQ 榜单曲目。
 * 走 musicu 的 ToplistDetailServer，返回歌名 / 歌手 / 专辑图。
 */
async function qqToplistSongs(topId, limit = 30) {
  const data = await getJson(
    'https://u.y.qq.com/cgi-bin/musicu.fcg?data=' +
      encodeURIComponent(
        JSON.stringify({
          req_0: {
            module: 'musicToplist.ToplistInfoServer',
            method: 'GetDetail',
            param: { topId: Number(topId), offset: 0, num: Math.min(limit, 60), period: '' },
          },
        })
      ),
    { referer: 'https://y.qq.com/' }
  );
  const info = data?.req_0?.data?.data || {};
  const songs = info.song || info.songInfoList || [];
  return {
    name: String(info.title || info.titleDetail || info.name || ''),
    cover: httpsify(info.frontPicUrl || ''),
    songs: songs.slice(0, limit).map((item) => ({
      title: String(item.title || item.name || ''),
      // 榜单接口给的是 singerName 字符串，不是 singer 数组
      artist: String(
        item.singerName ||
          (item.singer || []).map((s) => s.name).filter(Boolean).join(' / ') ||
          ''
      ),
      cover: httpsify(item.cover || item.album?.picUrl || ''),
      album: String(item.album?.name || item.albumMid || ''),
      mid: String(item.mid || item.songMid || ''),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 酷狗                                                                */
/* ------------------------------------------------------------------ */

/** 酷狗移动版榜单列表（55 个，公开接口）。 */
async function kugouRankList() {
  const data = await getJson('https://m.kugou.com/rank/list/?json=true', {
    referer: 'https://m.kugou.com/',
  });
  const list = data?.rank?.list || [];
  return list.map((item) => ({
    id: String(item.rankid || ''),
    name: String(item.rankname || ''),
    cover: httpsify(item.imgurl || item.banner || ''),
    updateKey: String(item.update_time || ''),
    group: String(item.rank_cid || ''),
  })).filter((item) => item.id && item.name);
}

/** 酷狗榜单曲目。 */
async function kugouRankSongs(rankId, limit = 30, page = 1) {
  const data = await getJson(
    `https://m.kugou.com/rank/info/?rankid=${encodeURIComponent(rankId)}&page=${page}&json=true`,
    { referer: 'https://m.kugou.com/' }
  );
  const info = data?.info || {};
  const payload = data?.songs || {};
  const list = payload.list || [];
  return {
    name: String(info.rankname || ''),
    cover: httpsify((info.imgurl || '').replace('{size}', '400')),
    songs: list.slice(0, limit).map((item) => {
      const authors = (item.authors || []).map((a) => a.author_name).filter(Boolean);
      return {
        title: String(item.songname || item.filename || ''),
        artist: authors.join(' / '),
        cover: httpsify((item.album_sizable_cover || '').replace('{size}', '400')),
        album: String(item.album_name || ''),
        hash: String(item.hash || ''),
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

/**
 * QQ 音乐搜索（公开接口，不需要登录）。
 * 返回的 songmid 是播放和封面要用的 key，songid 只是数字 ID。
 */
async function qqSearch(keyword, limit = 30) {
  const data = await getJson(
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?t=0&aggr=1&cr=1&catZhida=1&lossless=0&flag_qc=0&p=1&n=' +
      Math.min(limit, 50) +
      '&w=' +
      encodeURIComponent(keyword) +
      '&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0',
    { referer: 'https://y.qq.com/' }
  );
  const list = data?.data?.song?.list || [];
  return list.map((item) => ({
    title: String(item.songname || ''),
    artist: (item.singer || []).map((s) => s.name).filter(Boolean).join(' / '),
    album: String(item.albumname || ''),
    cover: item.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg` : '',
    mid: String(item.songmid || ''),
    songId: String(item.songid || ''),
    platform: 'qq',
    sourceLabel: 'QQ 音乐',
  })).filter((item) => item.title && item.mid);
}

/** 酷狗图片 URL 里带 {size} 占位符，得换成实际边长才是一个能加载的图。 */
function kugouImage(url, size = 300) {
  const text = String(url || '').replace(/\{size\}/g, String(size));
  return httpsify(text);
}

/** 酷狗搜索（公开接口），playable 用的是 FileHash。 */
async function kugouSearch(keyword, limit = 30) {
  const data = await getJson(
    'https://songsearch.kugou.com/song_search_v2?keyword=' +
      encodeURIComponent(keyword) +
      '&page=1&pagesize=' +
      Math.min(limit, 50) +
      '&platform=WebFilter&tag=em&filter=2&iscorrection=1&privilege_filter=0',
    { referer: 'https://www.kugou.com/' }
  );
  const list = data?.data?.lists || [];
  const strip = (text) => String(text || '').replace(/<[^>]+>/g, '');
  return list.map((item) => ({
    title: strip(item.SongName),
    artist: strip(item.SingerName),
    album: strip(item.AlbumName),
    // 酷狗给的是 http 图 + {size} 占位，两样都得处理
    cover: kugouImage(item.Image || item.AlbumImage || ''),
    hash: String(item.FileHash || ''),
    platform: 'kugou',
    sourceLabel: '酷狗',
  })).filter((item) => item.title && item.hash);
}

/** 网易云搜索，走本地 API 服务（和榜单同一个 base）。 */
async function neteaseSearch(apiBase, keyword, limit = 30) {
  const base = String(apiBase || 'http://127.0.0.1:3100').replace(/\/+$/, '');
  const response = await fetch(
    `${base}/search?keywords=${encodeURIComponent(keyword)}&limit=${Math.min(limit, 50)}&type=1`,
    { headers: { 'user-agent': BROWSER_UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) }
  );
  if (response.status === 401) {
    // 这个端口上跑的是别的服务（比如 QQ 机器人的 OneBot），不是网易云 API
    throw new Error('接口未授权，本地服务不是网易云 API');
  }
  if (!response.ok) throw new Error(`网易云搜索 HTTP ${response.status}`);
  const json = await response.json();
  const list = json?.result?.songs || [];
  return list.map((item) => ({
    title: String(item.name || ''),
    artist: (item.ar || item.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
    album: String(item.al?.name || item.album?.name || ''),
    cover: httpsify(item.al?.picUrl || item.album?.picUrl || ''),
    neteaseId: item.id,
    platform: 'netease',
    sourceLabel: '网易云',
  })).filter((item) => item.title);
}

/**
 * 三平台并发搜索。任一平台失败不影响其它平台，
 * 只把失败原因收集到 errors 里，界面可以按需提示。
 */
async function searchSongs(platform, keyword, apiBase, limit = 30) {
  const query = String(keyword || '').trim();
  if (!query) return { keyword: '', songs: [], errors: [] };

  const sources = [];
  if (platform === 'all' || !platform) {
    sources.push(['QQ 音乐', () => qqSearch(query, limit)]);
    sources.push(['酷狗', () => kugouSearch(query, limit)]);
    sources.push(['网易云', () => neteaseSearch(apiBase, query, limit)]);
  } else if (platform === 'qq') {
    sources.push(['QQ 音乐', () => qqSearch(query, limit)]);
  } else if (platform === 'kugou') {
    sources.push(['酷狗', () => kugouSearch(query, limit)]);
  } else if (platform === 'netease') {
    sources.push(['网易云', () => neteaseSearch(apiBase, query, limit)]);
  } else {
    throw new Error('未知平台');
  }

  const settled = await Promise.allSettled(sources.map(([, run]) => run()));
  const songs = [];
  const errors = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      songs.push(...result.value);
    } else {
      // AbortError 说明是超时，给一句人话
      const reason = result.reason;
      const message =
        reason?.name === 'AbortError' || reason?.name === 'TimeoutError'
          ? '请求超时'
          : reason?.message || '未知错误';
      errors.push(`${sources[index][0]}：${message}`);
    }
  });
  return { keyword: query, songs, errors };
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

async function musicCharts(platform) {
  if (platform === 'qq') return qqToplists();
  if (platform === 'kugou') return kugouRankList();
  throw new Error('未知平台');
}

async function chartSongs(platform, chartId, limit) {
  if (platform === 'qq') return qqToplistSongs(chartId, limit);
  if (platform === 'kugou') return kugouRankSongs(chartId, limit);
  throw new Error('未知平台');
}

/* ------------------------------------------------------------------ */
/* 网易云（通过内置 API 服务）                                          */
/* ------------------------------------------------------------------ */

async function neteaseToplists(apiBase) {
  const base = String(apiBase || 'http://127.0.0.1:3100').replace(/\/+$/, '');
  const response = await fetch(`${base}/toplist`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`网易云榜单 HTTP ${response.status}`);
  const json = await response.json();
  return (json.list || []).map((item) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    cover: httpsify(item.coverImgUrl || ''),
    updateKey: String(item.updateFrequency || ''),
    group: '',
  })).filter((item) => item.id && item.name);
}

async function neteaseChartSongs(apiBase, chartId, limit = 30) {
  const base = String(apiBase || 'http://127.0.0.1:3100').replace(/\/+$/, '');
  const response = await fetch(`${base}/playlist/detail?id=${encodeURIComponent(chartId)}`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`网易云榜单详情 HTTP ${response.status}`);
  const json = await response.json();
  const playlist = json.playlist || {};
  const tracks = (playlist.tracks || []).slice(0, limit);
  return {
    name: String(playlist.name || ''),
    cover: httpsify(playlist.coverImgUrl || ''),
    songs: tracks.map((item) => ({
      title: String(item.name || ''),
      artist: (item.ar || item.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
      cover: httpsify(item.al?.picUrl || ''),
      album: String(item.al?.name || ''),
      neteaseId: item.id,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 三家合并                                                            */
/* ------------------------------------------------------------------ */

const { mergeChartsBySource, chartSourceLabel, mergeSongs } = require('./chart-merge');

/**
 * 合并榜单：QQ + 酷狗 + 网易云，同名只留一条。
 * 任一来源失败不影响其它来源，最终至少返回能拿到的部分。
 */
async function mergedCharts(apiBase) {
  const results = await Promise.allSettled([
    qqToplists(),
    kugouRankList(),
    neteaseToplists(apiBase),
  ]);
  const reasons = {};
  const take = (index, key) => {
    const r = results[index];
    if (r.status === 'fulfilled') return r.value;
    reasons[key] = String(r.reason?.message || r.reason || '请求失败');
    return [];
  };
  const payload = {
    qq: take(0, 'qq'),
    kugou: take(1, 'kugou'),
    netease: take(2, 'netease'),
  };
  const merged = mergeChartsBySource(payload).map((chart) => ({
    ...chart,
    sourceLabel: chartSourceLabel(chart),
  }));
  return {
    charts: merged,
    counts: {
      qq: payload.qq.length,
      kugou: payload.kugou.length,
      netease: payload.netease.length,
      merged: merged.length,
    },
    // 只在真的失败时出现，界面上可以提示哪个平台挂了
    failed: Object.keys(reasons).length ? reasons : undefined,
  };
}

/** 取合并榜单里某个榜单的曲目：用它的来源 ID 去对应平台拉。 */
async function mergedChartSongs(chart, apiBase, limit = 30) {
  const ids = chart?.sourceIds || {};
  const order = ['netease', 'qq', 'kugou'];
  for (const source of order) {
    const id = ids[source];
    if (!id) continue;
    try {
      if (source === 'netease') return await neteaseChartSongs(apiBase, id, limit);
      if (source === 'qq') return await qqToplistSongs(id, limit);
      if (source === 'kugou') return await kugouRankSongs(id, limit);
    } catch {
      /* 换下一个来源 */
    }
  }
  throw new Error('这个榜单暂时读取不到');
}

module.exports = {
  musicCharts,
  chartSongs,
  searchSongs,
  qqToplists,
  kugouRankList,
  neteaseToplists,
  mergedCharts,
  mergedChartSongs,
  mergeSongs,
};
