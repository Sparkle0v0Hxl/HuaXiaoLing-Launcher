'use strict';

/**
 * 榜单 / 歌单曲目的可播放地址解析。
 *
 * 背景（实测结论）：
 * - QQ 音乐：免登录 CgiGetVkey 返回 result=104003，服务端明确要求付费/登录；
 * - 酷狗：getSongInfo 直接返回「需要付费」，wwwapi 返回 30020。
 * 两家的音频地址都由服务端强制校验会员，客户端无法绕过，也不应该绕过。
 *
 * 所以这里走的是「**用网易云找同名曲**」这条路：
 * 内置的 NeteaseCloudMusicApi 自带 unblockmusic-utils，
 * 遇到 fee=1/4 或无 url 的曲子会自动匹配其他平台的免费音源，
 * 返回一个可以直接播放的地址。这样三家来源的曲目都能听到，
 * 也不需要用户给 QQ/酷狗充会员。
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function neteaseGet(apiBase, route, params = {}, timeout = 20000) {
  const base = String(apiBase || 'http://127.0.0.1:3100').replace(/\/+$/, '');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const { signal, done } = withTimeout(timeout);
  try {
    const response = await fetch(`${base}${route}?${query.toString()}`, {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
      signal,
    });
    if (!response.ok) throw new Error(`网易云服务 HTTP ${response.status}`);
    return await response.json();
  } finally {
    done();
  }
}

/** 把歌名 + 歌手拼成搜索词，去掉括号里的噪声。 */
function searchKeyword(song) {
  const title = String(song?.title || song?.name || '')
    .replace(/[（(【\[].*?[)）】\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const artist = String(song?.artist || '')
    .split(/[\/、,&]/)[0]
    .trim();
  return `${title} ${artist}`.trim();
}

/**
 * 在一组候选结果里挑最像的那首：
 * 歌名包含 + 歌手匹配优先，其次取第一条有播放地址的。
 */
function pickBest(candidates, song) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const wantTitle = String(song?.title || '').toLowerCase();
  const wantArtist = String(song?.artist || '').toLowerCase();

  const scored = candidates.map((item) => {
    const title = String(item.name || '').toLowerCase();
    const artist = (item.ar || item.artists || [])
      .map((a) => a.name)
      .join(' ')
      .toLowerCase();
    let score = 0;
    if (wantTitle && title.includes(wantTitle.slice(0, 6))) score += 2;
    if (wantArtist && artist.includes(wantArtist.split(' ')[0])) score += 3;
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.item || candidates[0];
}

/**
 * 解析一首歌的可播放地址。
 * 返回 { url, title, artist, cover, neteaseId, level } 或 null。
 */
async function resolvePlayableUrl(apiBase, song, level = 'exhigh') {
  const keyword = searchKeyword(song);
  if (!keyword) return null;

  const search = await neteaseGet(apiBase, '/search', { keywords: keyword, limit: 8, type: 1 });
  const songs = search?.result?.songs || [];
  if (!songs.length) return null;

  const best = pickBest(songs, song);
  if (!best?.id) return null;

  // /song/url/v1 内部会自动触发 unblock（fee 1/4 或没有 url 时）
  let urlJson = null;
  try {
    urlJson = await neteaseGet(apiBase, '/song/url/v1', { id: best.id, level });
  } catch {
    urlJson = null;
  }
  if (!urlJson?.data?.[0]?.url) {
    try {
      urlJson = await neteaseGet(apiBase, '/song/url', { id: best.id });
    } catch {
      urlJson = null;
    }
  }
  const info = urlJson?.data?.[0];
  const url = info?.url || info?.proxyUrl;
  if (!url) return null;

  return {
    url: String(url).replace(/^http:/i, 'https:'),
    title: String(best.name || song.title || ''),
    artist: (best.ar || best.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
    cover: String(best.al?.picUrl || best.album?.picUrl || song.cover || '').replace(/^http:/i, 'https:'),
    neteaseId: best.id,
    level: info.level || level,
    br: info.br || 0,
  };
}

module.exports = { resolvePlayableUrl, searchKeyword, pickBest };
