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
  let out = String(url || '').replace(/^http:/i, 'https:');
  // 酷我图片的 kwcdn 子域不提供 https（实测 img1.kwcdn.kuwo.cn 的 https 直接握手失败，
  // 但同资源在 img1.kuwo.cn 的 https 上是 200）。把 imgN.kwcdn.kuwo.cn 主机换回 imgN.kuwo.cn。
  out = out.replace(/\/\/(img\d+)\.kwcdn\.kuwo\.cn\//i, '//$1.kuwo.cn/');
  return out;
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
/**
 * 酷我搜索（search.kuwo.cn 免登录）。
 * 它的 rid 就是后面换直链要用的 key，所以这里映射成 mid。
 */
async function kuwoSearchSongs(keyword, limit = 30) {
  const list = await kuwoSearch(keyword, limit);
  return list.map((item) => ({
    title: item.title,
    artist: item.artist,
    album: item.album,
    cover: '',
    mid: item.rid,
    platform: 'kuwo',
    sourceLabel: '酷我',
  }));
}

async function searchSongs(platform, keyword, apiBase, limit = 30) {
  const query = String(keyword || '').trim();
  if (!query) return { keyword: '', songs: [], errors: [] };

  const sources = [];
  if (platform === 'all' || !platform) {
    sources.push(['QQ 音乐', () => qqSearch(query, limit)]);
    sources.push(['酷狗', () => kugouSearch(query, limit)]);
    sources.push(['网易云', () => neteaseSearch(apiBase, query, limit)]);
    sources.push(['酷我', () => kuwoSearchSongs(query, limit)]);
  } else if (platform === 'qq') {
    sources.push(['QQ 音乐', () => qqSearch(query, limit)]);
  } else if (platform === 'kugou') {
    sources.push(['酷狗', () => kugouSearch(query, limit)]);
  } else if (platform === 'netease') {
    sources.push(['网易云', () => neteaseSearch(apiBase, query, limit)]);
  } else if (platform === 'kuwo') {
    sources.push(['酷我', () => kuwoSearchSongs(query, limit)]);
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

async function musicCharts(platform, apiBase) {
  if (platform === 'qq') return qqToplists();
  if (platform === 'kugou') return kugouRankList();
  // 网易云榜单一直走内置 API 服务，之前漏了这一支，界面选「网易云」就报「未知平台」
  if (platform === 'netease') return neteaseToplists(apiBase);
  throw new Error('未知平台');
}

async function chartSongs(platform, chartId, limit, apiBase) {
  let detail;
  if (platform === 'qq') detail = await qqToplistSongs(chartId, limit);
  else if (platform === 'kugou') detail = await kugouRankSongs(chartId, limit);
  else if (platform === 'netease') detail = await neteaseChartSongs(apiBase, chartId, limit);
  else throw new Error('未知平台');
  /*
   * 给每首标上来源：解析播放地址时要靠 platform 决定能不能直连原生接口，
   * 少了这个字段，会员曲目就只能去网易云碰运气。
   */
  detail.songs = (detail.songs || []).map((song) => ({ ...song, platform }));
  return detail;
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

const { kuwoSearch } = require('./music-source');
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

/* ------------------------------------------------------------------ */
/* 播放地址回退                                                        */
/* ------------------------------------------------------------------ */

/**
 * 酷狗：拿 hash 换播放地址。
 *
 * 免费曲目直接给完整 http 地址；会员曲目会返回 `error: 需要付费`，
 * 这时只能换一家再试，不能硬来。
 */
async function kugouSongUrl(hash) {
  const key = String(hash || '').trim();
  if (!key) throw new Error('酷狗没有 hash');
  const data = await getJson(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${key}`, {
    referer: 'https://m.kugou.com/',
  });
  const url = String(data?.url || '');
  if (!url) throw new Error(String(data?.error || '酷狗没有给播放地址'));
  return { url: httpsify(url), br: Number(data?.bitRate) * 1000 || 0, source: 'kugou' };
}

/**
 * QQ 音乐：songmid 换 vkey 播放地址。
 *
 * uin 传 0（游客）时只有免费曲目会拿到 purl，会员曲目 purl 为空、result 104003。
 */
async function qqSongUrl(mid) {
  const key = String(mid || '').trim();
  if (!key) throw new Error('QQ 音乐没有 songmid');
  const payload = {
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: { guid: '10000', songmid: [key], songtype: [0], uin: '0', loginflag: 1, platform: '20' },
    },
    comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
  };
  const { signal, done } = withTimeout(15000);
  let json = null;
  try {
    const response = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg?format=json', {
      method: 'POST',
      headers: {
        'user-agent': BROWSER_UA,
        'content-type': 'application/json',
        referer: 'https://y.qq.com/',
        origin: 'https://y.qq.com',
      },
      body: JSON.stringify(payload),
      signal,
    });
    json = await response.json();
  } finally {
    done();
  }
  const info = json?.req_0?.data?.midurlinfo?.[0];
  const purl = String(info?.purl || '');
  if (!purl) throw new Error('QQ 音乐没有给播放地址（多半是会员曲目）');
  const sip = String(json?.req_0?.data?.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/');
  return { url: `${sip}${purl}`, br: 0, source: 'qq' };
}

/**
 * 网易云拿不到地址时的兜底：用「歌名 + 歌手」去酷狗和 QQ 音乐找同一首。
 *
 * 只找**免费**的那一份。两家都要求付费时如实报错，
 * 不绕会员、不接第三方音源。
 */
async function resolveFallbackUrl({ title, artist } = {}) {
  const name = String(title || '').trim();
  if (!name) throw new Error('没有歌名，无法换源');
  const keyword = `${name} ${String(artist || '').split('/')[0].trim()}`.trim();
  const tried = [];

  try {
    const list = await kugouSearch(keyword, 5);
    const hit = list[0];
    if (hit?.hash) {
      const info = await kugouSongUrl(hit.hash);
      return { ...info, matched: `${hit.title} - ${hit.artist}`, keyword };
    }
    tried.push('酷狗无结果');
  } catch (error) {
    tried.push(`酷狗：${error.message}`);
  }

  try {
    const list = await qqSearch(keyword, 5);
    const hit = list[0];
    if (hit?.mid) {
      const info = await qqSongUrl(hit.mid);
      return { ...info, matched: `${hit.title} - ${hit.artist}`, keyword };
    }
    tried.push('QQ 音乐无结果');
  } catch (error) {
    tried.push(`QQ 音乐：${error.message}`);
  }

  throw new Error(tried.join('；') || '没有可用的替代音源');
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
  kugouSongUrl,
  qqSongUrl,
  resolveFallbackUrl,
};
