'use strict';

/**
 * 点歌台的「音源 + 歌词」层。
 *
 * 背景（实测结论，2026-10）：
 * - 酷我 antiserver 免登录就能换出可流式播放的 MP3（连 VIP 曲目都有）；
 * - 酷狗 m.kugou.com/app/i/getSongInfo.php 对免费曲目直返 url + backup_url；
 * - QQ 音乐匿名 CgiGetVkey 只有免费曲目给 purl，会员曲目 result=104003；
 * - 网易云走本地 NeteaseCloudMusicApi，unblock 能补一部分。
 *
 * 所以解析顺序是「哪个平台能出声就用哪个」：
 *   原生平台直链 → 酷我搜索换源 → 酷狗搜索换源 → QQ → 网易云同名曲兜底。
 * 歌词同理，按平台各自的公开接口取，不用登录。
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpsify(url) {
  let out = String(url || '').replace(/^http:/i, 'https:');
  // 酷我图片的 kwcdn 子域不提供 https（实测 img1.kwcdn.kuwo.cn 的 https 直接握手失败，
  // 但同资源在 img1.kuwo.cn 的 https 上是 200）。把 imgN.kwcdn.kuwo.cn 主机换回 imgN.kuwo.cn。
  out = out.replace(/\/\/(img\d+)\.kwcdn\.kuwo\.cn\//i, '//$1.kuwo.cn/');
  return out;
}

async function fetchText(url, options = {}) {
  const { headers = {}, timeout = 15000, method = 'GET', body = null } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      body,
      headers: { 'user-agent': BROWSER_UA, ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  const result = await fetchText(url, options);
  const raw = String(result.text || '').trim();
  if (!raw) throw new Error('接口返回空内容');
  try {
    return JSON.parse(raw);
  } catch {
    // 有些接口会包一层 jsonp，把首尾剥掉再试一次
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
    throw new Error(`返回的不是 JSON（${raw.slice(0, 60)}）`);
  }
}

/* ── 匹配打分 ─────────────────────────────────────────────── */

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(【\[].*?[)）】\]]/g, ' ')
    .replace(/[\s\-_/、,.·'"!?]+/g, '')
    .trim();
}

function firstArtist(artist) {
  return String(artist || '')
    .split(/[/、,&;]/)[0]
    .trim();
}

/**
 * 在一组候选里挑最像的一首。
 * 歌名完全一致 +3，互相包含 +2，歌手对得上 +3。
 */
function pickBest(candidates, want) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const wantTitle = normalize(want?.title);
  const wantArtist = normalize(firstArtist(want?.artist));
  let best = null;
  let bestScore = -1;
  for (const item of candidates) {
    const title = normalize(item.title);
    const artist = normalize(item.artist);
    let score = 0;
    if (wantTitle && title === wantTitle) score += 3;
    else if (wantTitle && (title.includes(wantTitle) || wantTitle.includes(title))) score += 2;
    if (wantArtist && artist && (artist.includes(wantArtist) || wantArtist.includes(artist))) score += 3;
    // 同分时优先带播放能力的
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function searchKeyword(song) {
  const title = String(song?.title || '').replace(/[（(【\[].*?[)）】\]]/g, ' ').trim();
  const artist = firstArtist(song?.artist);
  return `${title} ${artist}`.trim();
}

/* ── 酷我 ─────────────────────────────────────────────────── */

/** 酷我搜索：免登录，返回带 MUSICRID 的候选。 */
async function kuwoSearch(keyword, limit = 10) {
  const url =
    'https://search.kuwo.cn/r.s?client=kt&all=' +
    encodeURIComponent(keyword) +
    '&pn=0&rn=' +
    Math.min(limit, 30) +
    '&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1' +
    '&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1';
  const json = await fetchJson(url, { headers: { referer: 'https://www.kuwo.cn/' } });
  const list = json?.abslist || [];
  return list
    .map((item) => {
      const rid = String(item.MUSICRID || item.DC_TARGETID || '').replace(/^MUSIC_/i, '');
      const name = String(item.SONGNAME || item.NAME || '').replace(/&nbsp;/g, ' ').trim();
      const artist = String(item.ARTIST || item.FARTIST || '')
        .replace(/&nbsp;/g, ' ')
        .trim();
      return {
        rid,
        title: name,
        artist,
        album: String(item.ALBUM || '').replace(/&nbsp;/g, ' ').trim(),
        duration: Number(item.DURATION) || 0,
      };
    })
    .filter((item) => item.rid && item.title);
}

/**
 * 酷我换直链。
 * antiserver 只认数字 rid（MUSIC_ 前缀要剥掉），返回的就是一条 mp3 地址。
 */
async function kuwoSongUrl(rid) {
  const id = String(rid || '').replace(/^MUSIC_/i, '').trim();
  if (!/^\d+$/.test(id)) throw new Error('酷我没有合法的 rid');
  const url =
    'http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_' + id;
  const result = await fetchText(url, { headers: { referer: 'https://www.kuwo.cn/' }, timeout: 12000 });
  const text = String(result.text || '').trim();
  if (!/^https?:\/\//i.test(text)) throw new Error(`酷我没有给播放地址（${text.slice(0, 40) || '空响应'}）`);
  return { url: httpsify(text), br: 0, source: 'kuwo', id };
}

/** 酷我歌词：必须用数字 musicId，带 MUSIC_ 前缀会返回 status 301。 */
async function kuwoLyric(rid) {
  const id = String(rid || '').replace(/^MUSIC_/i, '').trim();
  if (!/^\d+$/.test(id)) return '';
  const json = await fetchJson(`https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${id}`, {
    headers: { referer: 'https://m.kuwo.cn/' },
    timeout: 12000,
  });
  const lines = json?.data?.lrclist || [];
  if (!lines.length) return '';
  return lines
    .map((line) => {
      const at = Number(line.time) || 0;
      const mm = Math.floor(at / 60);
      const ss = (at % 60).toFixed(2).padStart(5, '0');
      return `[${String(mm).padStart(2, '0')}:${ss}]${String(line.lineLyric || '')}`;
    })
    .join('\n');
}

/* ── 酷狗 ─────────────────────────────────────────────────── */

const KUGOU_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

/** 酷狗搜索：songsearch.kugou.com 免登录，FileHash 就是换地址要用的 key。 */
async function kugouSearch(keyword, limit = 10) {
  const url =
    'https://songsearch.kugou.com/song_search_v2?keyword=' +
    encodeURIComponent(keyword) +
    '&page=1&pagesize=' +
    Math.min(limit, 30) +
    '&userid=-1&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0';
  const json = await fetchJson(url, { headers: { referer: 'https://www.kugou.com/' } });
  const list = json?.data?.lists || [];
  const strip = (text) => String(text || '').replace(/<[^>]+>/g, '').trim();
  return list
    .map((item) => ({
      hash: String(item.FileHash || ''),
      title: strip(item.SongName),
      artist: strip(item.SingerName),
      album: strip(item.AlbumName),
      duration: Number(item.Duration) || 0,
    }))
    .filter((item) => item.hash && item.title);
}

/** 酷狗换直链：免费曲目直接给 url，会员曲目只有 error 文案。 */
async function kugouSongUrl(hash) {
  const key = String(hash || '').trim();
  if (!key) throw new Error('酷狗没有 hash');
  const json = await fetchJson(
    `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(key)}`,
    { headers: { referer: 'https://m.kugou.com/', 'user-agent': KUGOU_MOBILE_UA }, timeout: 12000 }
  );
  const url = String(json?.url || '');
  if (!url) throw new Error(String(json?.error || '酷狗没有给播放地址（多半是会员曲目）'));
  return {
    url: httpsify(url),
    backup: httpsify(json?.backup_url?.[0] || ''),
    br: Number(json?.bitRate) * 1000 || 0,
    source: 'kugou',
    hash: key,
  };
}

/** 酷狗歌词：先按 hash 搜候选，再按 id + accesskey 下载 LRC。 */
async function kugouLyric(hash) {
  const key = String(hash || '').trim();
  if (!key) return '';
  const search = await fetchJson(
    `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&hash=${encodeURIComponent(key)}`,
    { headers: { referer: 'https://www.kugou.com/' }, timeout: 12000 }
  );
  const candidate = search?.candidates?.[0];
  if (!candidate?.id || !candidate?.accesskey) return '';
  const json = await fetchJson(
    `https://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(candidate.id)}&accesskey=${encodeURIComponent(candidate.accesskey)}&fmt=lrc&charset=utf8`,
    { headers: { referer: 'https://www.kugou.com/' }, timeout: 12000 }
  );
  const content = String(json?.content || '');
  if (!content) return '';
  try {
    return Buffer.from(content, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/* ── QQ 音乐 ──────────────────────────────────────────────── */

/** QQ 搜索：musicu 的 DoSearchForQQMusicDesktop，songmid 是换地址的 key。 */
async function qqSearch(keyword, limit = 10) {
  const payload = {
    comm: { ct: '19', cv: '1859', uin: '0' },
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { query: keyword, num_per_page: Math.min(limit, 30), page_num: 1, search_type: 0 },
    },
  };
  const json = await fetchJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { referer: 'https://y.qq.com/', origin: 'https://y.qq.com', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 12000,
  });
  const list = json?.req?.data?.body?.song?.list || [];
  return list
    .map((item) => ({
      mid: String(item.mid || item.songmid || ''),
      title: String(item.name || item.title || ''),
      artist: (item.singer || []).map((s) => s.name).filter(Boolean).join(' / '),
      album: String(item.album?.name || ''),
      albumMid: String(item.album?.mid || ''),
    }))
    .filter((item) => item.mid && item.title);
}

/** QQ 换直链：匿名只有免费曲目给 purl。 */
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
  const json = await fetchJson('https://u.y.qq.com/cgi-bin/musicu.fcg?format=json', {
    method: 'POST',
    headers: { referer: 'https://y.qq.com/', origin: 'https://y.qq.com', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 12000,
  });
  const info = json?.req_0?.data?.midurlinfo?.[0];
  const purl = String(info?.purl || '');
  if (!purl) {
    const code = info?.result;
    throw new Error(
      code === 104003 ? 'QQ 音乐要求会员或登录，匿名拿不到这条地址' : 'QQ 音乐没有给播放地址'
    );
  }
  const sip = String(json?.req_0?.data?.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/');
  return { url: sip + purl, br: 0, source: 'qq', mid: key };
}

/** QQ 歌词：fcg_query_lyric_new 免登录返回带时间轴的 LRC。 */
async function qqLyric(mid) {
  const key = String(mid || '').trim();
  if (!key) return '';
  const json = await fetchJson(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(key)}&format=json&nobase64=1&g_tk=5381`,
    { headers: { referer: 'https://y.qq.com/' }, timeout: 12000 }
  );
  return String(json?.lyric || '');
}

/* ── 网易云（走本地 API 服务） ────────────────────────────── */

function neteaseBase(apiBase) {
  return String(apiBase || 'http://127.0.0.1:3100').replace(/\/+$/, '');
}

async function neteaseSearch(apiBase, keyword, limit = 10) {
  const json = await fetchJson(
    `${neteaseBase(apiBase)}/search?keywords=${encodeURIComponent(keyword)}&limit=${Math.min(limit, 30)}&type=1`,
    { headers: { accept: 'application/json' }, timeout: 12000 }
  );
  const list = json?.result?.songs || [];
  return list.map((item) => ({
    id: item.id,
    title: String(item.name || ''),
    artist: (item.ar || item.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
    album: String(item.al?.name || ''),
    cover: httpsify(item.al?.picUrl || ''),
  }));
}

async function neteaseLyric(apiBase, id) {
  if (!id) return '';
  const json = await fetchJson(`${neteaseBase(apiBase)}/lyric?id=${encodeURIComponent(id)}`, {
    headers: { accept: 'application/json' },
    timeout: 12000,
  });
  return String(json?.lrc?.lyric || '');
}

/* ── 统一入口 ─────────────────────────────────────────────── */

/* ── 咪咕 ─────────────────────────────────────────────────── */

const MIGU_UA =
  'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const MIGU_HEADERS = { 'user-agent': MIGU_UA, referer: 'https://music.migu.cn/', channel: '0' };

/** 咪咕搜索：pd.musicapp 的 search_all 免登录，返回里带 contentId / copyrightId。 */
async function miguSearch(keyword, limit = 10) {
  const url =
    'https://pd.musicapp.migu.cn/MIGUM3.0/v1.0/content/search_all.do?text=' +
    encodeURIComponent(keyword) +
    '&pageNo=1&pageSize=' +
    Math.min(limit, 20) +
    '&isCopyright=1&searchSwitch={"song":1}';
  const json = await fetchJson(url, { headers: MIGU_HEADERS, timeout: 10000 });
  const list = json?.songResultData?.result || [];
  return list
    .map((item) => ({
      id: String(item.id || ''),
      contentId: String(item.contentId || ''),
      copyrightId: String(item.copyrightId || ''),
      title: String(item.name || '').trim(),
      artist: (item.singers || []).map((s) => s.name).filter(Boolean).join(' / '),
      album: String(item.albums?.[0]?.name || ''),
      cover: String(item.imgItems?.[0]?.img || ''),
      duration: 0,
    }))
    .filter((item) => item.contentId && item.title);
}

/**
 * 咪咕换直链。
 *
 * 实测（2026-10）：app.pd.nf.migu.cn 的 listen-url 现在普遍回 201007 / 299996，
 * 这里保留多个版本一起试，接口一旦恢复就自动接上；整条失败时由并发竞速淘汰，
 * 不会拖住别的音源（这也是把它放进竞速而不是串行的原因）。
 */
async function miguSongUrl(item) {
  const songId = String(item?.id || item?.contentId || '').trim();
  if (!songId) throw new Error('咪咕没有 songId');
  const tries = [
    `https://app.pd.nf.migu.cn/MIGUM2.0/strategy/listen-url/v2.4?lowerQualityContentId=&qualityType=PQ&resourceType=2&songId=${encodeURIComponent(songId)}&netType=01&mediaType=01&toneFlag=PQ`,
    `https://app.pd.nf.migu.cn/MIGUM2.0/strategy/listen-url/v2.4?lowerQualityContentId=&qualityType=HQ&resourceType=2&songId=${encodeURIComponent(songId)}&netType=01&mediaType=01&toneFlag=HQ`,
  ];
  let last = '咪咕没有给播放地址';
  for (const url of tries) {
    try {
      const json = await fetchJson(url, { headers: MIGU_HEADERS, timeout: 8000 });
      const play = json?.data?.playUrl || json?.playUrl || json?.url || json?.data?.url;
      if (play) {
        return {
          url: httpsify(play),
          br: 0,
          source: 'migu',
          id: String(item.contentId || songId),
          contentId: String(item.contentId || ''),
        };
      }
      last = String(json?.info || json?.code || last);
    } catch (error) {
      last = error.message;
    }
  }
  throw new Error(last);
}

/* ── 同名换源的小包装 ─────────────────────────────────────── */

/**
 * 网易云取地址：音质优先，换源兜底。
 *
 * 用户要的是「完整听到 + 音质高」，所以顺序是：
 *   ① /song/url/v1 按请求音质（exhigh=320k，可选 higher/lossless）；
 *   ② 再退 standard 试一次；
 *   ③ /song/url/match 换源 —— VIP / 无地址的曲子由它匹配其它平台的免费音源，
 *      音质不一定最好，但保证是完整曲而不是几十秒试听；
 *   ④ /song/url 最后兜底。
 * 任何一级带 freeTrialInfo（只有试听片段）都不算数，继续往下走。
 */
async function neteaseUrlById(apiBase, id, level, flags) {
  const base = neteaseBase(apiBase);
  const jsonHeaders = { accept: 'application/json' };
  const want = String(level || 'exhigh');
  // 同一首歌按「请求音质 → 更高 → 标准」依次试，拿到完整曲就收
  const levels = want === 'standard' ? ['standard'] : [want, 'standard'];
  const tried = [];

  for (const lv of levels) {
    try {
      const json = await fetchJson(
        `${base}/song/url/v1?id=${encodeURIComponent(id)}&level=${encodeURIComponent(lv)}`,
        { headers: jsonHeaders, timeout: 12000 }
      );
      const info = json?.data?.[0];
      // unblock 可能把地址换成别的平台的直链，撞上停用的音源不算拿到
      if (info?.url && !info.freeTrialInfo && !disabledSourceOfUrl(info.url, flags)) {
        return {
          url: httpsify(info.url),
          br: Number(info.br) || 0,
          source: 'netease',
          neteaseId: String(id),
          level: info.level || lv,
          via: 'v1',
        };
      }
      tried.push(info?.freeTrialInfo ? `${lv}：只有试听片段` : `${lv}：没有地址`);
    } catch (error) {
      tried.push(`${lv}：${error.message}`);
    }
  }

  // 换源：保证能完整听（match 内部按酷我等平台匹配，这里按开关过滤）
  try {
    const match = await fetchJson(`${base}/song/url/match?id=${encodeURIComponent(id)}`, {
      headers: jsonHeaders,
      timeout: 12000,
    });
    const candidate = typeof match?.data === 'string' ? match.data : match?.data?.url;
    if (candidate && /^https?:/i.test(candidate) && !disabledSourceOfUrl(candidate, flags)) {
      return {
        url: httpsify(candidate),
        br: 0,
        source: 'netease',
        neteaseId: String(id),
        unblocked: true,
        via: 'match',
      };
    }
    tried.push('换源：没有匹配到');
  } catch (error) {
    tried.push(`换源：${error.message}`);
  }

  // 兜底
  try {
    const json = await fetchJson(`${base}/song/url?id=${encodeURIComponent(id)}`, {
      headers: jsonHeaders,
      timeout: 12000,
    });
    const info = json?.data?.[0];
    const url = info?.url || info?.proxyUrl;
    if (url && !disabledSourceOfUrl(url, flags)) {
      return {
        url: httpsify(url),
        br: Number(info.br) || 0,
        source: 'netease',
        neteaseId: String(id),
        level: info.level || 'standard',
        via: 'url',
        trial: Boolean(info?.freeTrialInfo),
      };
    }
  } catch (error) {
    tried.push(`兜底：${error.message}`);
  }

  throw new Error(tried.join('；') || '网易云没有可播放地址');
}

async function byKeyword(provider, keyword, song, extra) {
  const candidates = await provider.search(keyword, 8, extra);
  const best = pickBest(candidates, song);
  if (!best) throw new Error('没搜到同名曲');
  const url = await provider.url(best, extra);
  return {
    ...url,
    matched: `${best.title} - ${best.artist}`,
    runtime: best,
    cover: best.cover || url.cover || '',
  };
}

const KEYWORD_PROVIDERS = {
  kuwo: { search: kuwoSearch, url: (best) => kuwoSongUrl(best.rid) },
  kugou: { search: kugouSearch, url: (best) => kugouSongUrl(best.hash) },
  qq: { search: qqSearch, url: (best) => qqSongUrl(best.mid) },
  migu: { search: miguSearch, url: (best) => miguSongUrl(best) },
  netease: {
    search: (keyword, limit, extra) =>
      neteaseSearch(extra?.apiBase || 'http://127.0.0.1:3100', keyword, limit),
    url: (best, extra) =>
      neteaseUrlById(extra?.apiBase || 'http://127.0.0.1:3100', best.id, extra?.level, extra?.flags),
  },
};

/* ── 自定义第三方音源 ─────────────────────────────────────────
 * 用户在设置里导入的音源：一份 JSON 描述两个接口（搜索 + 取链），
 * 用 {keyword} / {limit} / {id} 占位符拼 URL，再用点号路径取字段。
 * 这样任何公开的第三方音源都能接进来，不用改代码。
 */

function pathGet(target, path) {
  if (!path) return target;
  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? acc : acc[key]), target);
}

function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) =>
    encodeURIComponent(String(vars[key] ?? ''))
  );
}

function makeCustomProvider(def) {
  const searchDef = def?.search || {};
  const urlDef = def?.url || {};
  const headers = def?.headers && typeof def.headers === 'object' ? def.headers : {};
  const label = def?.name || def?.id || '自定义音源';
  return {
    search: async (keyword, limit = 8) => {
      if (!searchDef.url) throw new Error(`${label} 没配搜索接口`);
      const json = await fetchJson(fillTemplate(searchDef.url, { keyword, limit }), {
        headers,
        timeout: 10000,
      });
      const list = pathGet(json, searchDef.list || 'data');
      if (!Array.isArray(list) || !list.length) throw new Error(`${label} 没搜到`);
      const f = searchDef.fields || {};
      return list
        .map((item) => ({
          id: String(pathGet(item, f.id || 'id') ?? ''),
          title: String(pathGet(item, f.title || 'name') ?? ''),
          artist: String(pathGet(item, f.artist || 'artist') ?? ''),
          album: String(pathGet(item, f.album || 'album') ?? ''),
          cover: String(pathGet(item, f.cover || 'cover') ?? ''),
          raw: item,
        }))
        .filter((item) => item.id && item.title);
    },
    url: async (best) => {
      if (!urlDef.url) throw new Error(`${label} 没配取链接口`);
      const vars = { id: best.id, ...(best.raw && typeof best.raw === 'object' ? best.raw : {}) };
      // 不少第三方音源（酷我 antiserver 就是）直接返回一条纯文本地址而不是 JSON，
      // 所以先按 JSON 取，取不到再看整段响应本身是不是个地址。
      const result = await fetchText(fillTemplate(urlDef.url, vars), { headers, timeout: 10000 });
      let play = '';
      try {
        play = pathGet(JSON.parse(result.text), urlDef.play || 'url');
      } catch {
        play = '';
      }
      if (!play && /^https?:\/\//i.test(String(result.text || '').trim())) {
        play = String(result.text).trim();
      }
      if (!play) throw new Error(`${label} 没给播放地址`);
      return { url: httpsify(play), br: 0, source: def?.id || 'custom' };
    },
  };
}

/** 校验一份音源描述够不够跑；返回 { ok, reason }。 */
function validateCustomSource(def) {
  if (!def || typeof def !== 'object') return { ok: false, reason: '不是一份 JSON 音源' };
  if (!def.name && !def.id) return { ok: false, reason: '缺少 name / id' };
  if (!def?.search?.url) return { ok: false, reason: '缺少 search.url（搜索接口）' };
  if (!def?.url?.url) return { ok: false, reason: '缺少 url.url（取链接口）' };
  return { ok: true };
}

/* ── 并发竞速 + 结果缓存 ─────────────────────────────────── */

const RESOLVE_CACHE = new Map();
const RESOLVE_FAIL = new Map();
const RESOLVE_CACHE_TTL = 20 * 60 * 1000;
const RESOLVE_FAIL_TTL = 2 * 60 * 1000;
const RESOLVE_RACE_TIMEOUT = 12000;

/**
 * 默认音源开关。
 *
 * 用户明确要求「不走官方音源」：酷狗匿名接口对付费曲目一律回「需要付费」，
 * QQ 匿名 CgiGetVkey 对会员曲目回 104003，酷我的 antiserver 又经常把人往
 * 「去手机端收听」上引 —— 三家都不进默认链路，只在用户自己在设置里打开时才参与。
 * 主力是第三方音源：本地 NeteaseCloudMusicApi（127.0.0.1:3100）+ 咪咕。
 */
const DEFAULT_SOURCE_FLAGS = { netease: true, migu: true, kuwo: false, kugou: false, qq: false };

function normalizeSourceFlags(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const key of Object.keys(DEFAULT_SOURCE_FLAGS)) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  return Object.keys(out).length ? out : null;
}

/*
 * 各音源返回的播放地址的宿主特征。网易云 API 的 unblock（/song/url/v1、
 * /song/url/match）会在服务端偷偷换成别的平台的直链（酷我优先），返回里
 * 只标 source: 'netease'——这是「酷我停用了还在用酷我」的隐藏通道。
 * 用 URL 宿主反查它真正来自哪家，撞上被停用的音源就当这次尝试失败。
 */
const SOURCE_HOST_PATTERNS = {
  kuwo: /kuwo\.cn|kwcdn/i,
  kugou: /kugou|kgimg|kglink/i,
  qq: /qq\.com|qqmusic/i,
  migu: /migu/i,
  netease: /music\.126\.net|music\.163\.com|netease/i,
};

/** 返回这段 URL 实际来自的、但被用户停用的音源 id；没撞上就返回空串。 */
function disabledSourceOfUrl(url, flags) {
  const text = String(url || '');
  if (!text || !flags || typeof flags !== 'object') return '';
  for (const [id, pattern] of Object.entries(SOURCE_HOST_PATTERNS)) {
    if (flags[id] === false && pattern.test(text)) return id;
  }
  return '';
}

function resolveCacheKey(song, level) {
  return `${normalize(song?.title)}|${normalize(song?.artist)}|${String(level || '')}`;
}

/** 多个音源同时开跑，谁先给出可播放地址就用谁；全灭才抛错。 */
function raceFirst(tasks, timeout = RESOLVE_RACE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let pending = tasks.length;
    const errors = [];
    let settled = false;
    const finish = () => {
      pending -= 1;
      if (pending <= 0 && !settled) {
        settled = true;
        reject(new Error(errors.join('；') || '所有音源都没有给出播放地址'));
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(errors.length ? `${errors.join('；')}（整轮超时）` : '整轮音源超时'));
    }, timeout);
    for (const task of tasks) {
      Promise.resolve()
        .then(() => task.run())
        .then((result) => {
          if (settled) return;
          if (result && result.url) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
            return;
          }
          errors.push(`${task.id}：没有地址`);
          finish();
        })
        .catch((error) => {
          if (settled) return;
          errors.push(`${task.id}：${String(error?.message || error).slice(0, 40)}`);
          finish();
        });
    }
  });
}

/**
 * 把一首歌解析成能直接喂给 <audio> 的地址。
 *
 * song 里可能带这些线索：
 *   source: netease | qq | kugou | kuwo | migu
 *   neteaseId / mid / hash / contentId（各家自己的 key）
 *
 * 走法：所有启用的音源**同时**开跑，谁先出地址用谁，命中结果缓存 20 分钟。
 * 以前是「原生 → 酷我 → 酷狗 → QQ → 网易云」一条条串行等，每源自带
 * 12~15 秒超时，最坏要等一分多钟界面才有反应（点歌台卡顿的主因之一）。
 */
async function resolveSourceUrl(song, options = {}) {
  const apiBase = options.apiBase || 'http://127.0.0.1:3100';
  const level = options.level || 'exhigh';
  const flags = Object.assign({}, DEFAULT_SOURCE_FLAGS, normalizeSourceFlags(options.sources) || {});
  const source = String(song?.source || '').trim();
  const keyword = searchKeyword(song);
  const key = resolveCacheKey(song, level);
  const now = Date.now();

  const cached = RESOLVE_CACHE.get(key);
  if (cached && now - cached.at < RESOLVE_CACHE_TTL) return { ...cached.result, cached: true };
  const failedAt = RESOLVE_FAIL.get(key);
  if (failedAt && now - failedAt < RESOLVE_FAIL_TTL) {
    throw new Error('所有音源刚试过一次都没出地址，稍后再试');
  }

  const tasks = [];
  const push = (id, run) => {
    if (flags[id] === false) return;
    tasks.push({ id, run });
  };

  // ① 原生直链：歌曲本来就是这一家、且这一家被启用时才走
  if (source === 'kuwo' && song.mid) {
    push('kuwo', async () => ({ ...(await kuwoSongUrl(song.mid)), matched: '原生' }));
  }
  if (source === 'kugou' && song.hash) {
    push('kugou', async () => ({ ...(await kugouSongUrl(song.hash)), matched: '原生' }));
  }
  if (source === 'qq' && song.mid) {
    push('qq', async () => ({ ...(await qqSongUrl(song.mid)), matched: '原生' }));
  }
  if (source === 'netease' && song.neteaseId) {
    push('netease', async () => ({
      ...(await neteaseUrlById(apiBase, song.neteaseId, level, flags)),
      matched: '原生',
    }));
  }
  if (source === 'migu' && song.contentId) {
    push('migu', async () => ({ ...(await miguSongUrl(song)), matched: '原生' }));
  }

  // ② 同名换源：所有启用的音源并发竞速
  if (keyword) {
    for (const id of ['netease', 'migu', 'kuwo', 'kugou', 'qq']) {
      const provider = KEYWORD_PROVIDERS[id];
      if (!provider) continue;
      push(id, () => byKeyword(provider, keyword, song, { apiBase, level, flags }));
    }

    // ③ 用户在点歌台里自己导入的第三方音源
    const customs = Array.isArray(options.customSources) ? options.customSources : [];
    for (const def of customs) {
      if (!def || def.enabled === false) continue;
      if (!validateCustomSource(def).ok) continue;
      const provider = makeCustomProvider(def);
      push(def.id || def.name, () => byKeyword(provider, keyword, song, {}));
    }
  }

  if (!tasks.length) throw new Error('没有可用的音源（设置里至少要开一个）');

  try {
    const winner = await raceFirst(tasks);
    RESOLVE_CACHE.set(key, { at: now, result: winner });
    return winner;
  } catch (error) {
    RESOLVE_FAIL.set(key, now);
    throw error;
  }
}

/** 手动清掉换源缓存（设置里改了音源开关时调用）。 */
function clearResolveCache() {
  RESOLVE_CACHE.clear();
  RESOLVE_FAIL.clear();
}

/** 按平台取歌词，返回 LRC 文本（失败就是空串）。 */
async function fetchLyric(song, options = {}) {
  const apiBase = options.apiBase || 'http://127.0.0.1:3100';
  const source = String(song?.source || '').trim();
  const attempts = [];

  if (song?.lyric) return { lyric: String(song.lyric), source: 'cache' };

  const run = async (label, fn) => {
    try {
      const lyric = await fn();
      if (lyric && lyric.trim()) return { lyric, source: label };
      attempts.push(`${label}：没有歌词`);
    } catch (error) {
      attempts.push(`${label}：${error.message}`);
    }
    return null;
  };

  if (song?.neteaseId) {
    const hit = await run('netease', () => neteaseLyric(apiBase, song.neteaseId));
    if (hit) return hit;
  }
  if (source === 'kugou' && song.hash) {
    const hit = await run('kugou', () => kugouLyric(song.hash));
    if (hit) return hit;
  }
  if (source === 'qq' && song.mid) {
    const hit = await run('qq', () => qqLyric(song.mid));
    if (hit) return hit;
  }
  if (source === 'kuwo' && song.mid) {
    const hit = await run('kuwo', () => kuwoLyric(song.mid));
    if (hit) return hit;
  }

  // 原生平台没词时，用「歌名 + 歌手」去酷我、QQ 各找一次
  const keyword = searchKeyword(song);
  if (keyword) {
    const hit = await run('kuwo-search', async () => {
      const best = pickBest(await kuwoSearch(keyword, 5), song);
      if (!best) throw new Error('没搜到同名曲');
      return kuwoLyric(best.rid);
    });
    if (hit) return hit;
    const qq = await run('qq-search', async () => {
      const best = pickBest(await qqSearch(keyword, 5), song);
      if (!best) throw new Error('没搜到同名曲');
      return qqLyric(best.mid);
    });
    if (qq) return qq;
  }

  return { lyric: '', source: '', attempts };
}

module.exports = {
  resolveSourceUrl,
  clearResolveCache,
  fetchLyric,
  makeCustomProvider,
  validateCustomSource,
  normalizeSourceFlags,
  disabledSourceOfUrl,
  miguSearch,
  miguSongUrl,
  kuwoSearch,
  kuwoSongUrl,
  kuwoLyric,
  kugouSearch,
  kugouSongUrl,
  kugouLyric,
  qqSearch,
  qqSongUrl,
  qqLyric,
  neteaseSearch,
  neteaseLyric,
  pickBest,
  searchKeyword,
};
