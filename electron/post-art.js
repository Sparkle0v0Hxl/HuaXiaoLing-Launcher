/*
 * 更新弹窗的配图：从米游社「同人图」区挑一张画师横图。
 *
 * 为什么要走米游社而不是图片搜索：
 *   - 必应图搜的接口抓不到稳定的直链（图片地址埋在脚本里的内联 JSON 里）；
 *   - 米游社的同人图帖自带「作者 + 帖子地址」，正好能当图源链接用；
 *   - 这套接口对未登录的请求会返回空列表（反爬），所以必须带上启动器里
 *     已经登录好的米游社 cookie —— 和查战绩用的是同一份登录态。
 *
 * 拿不到就什么都不返回，前端会退回官网美术图，弹窗不会开天窗。
 */
const fs = require('fs');
const path = require('path');
const { createDs2 } = require('./miyoushe-login');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BBS = 'https://bbs-api.miyoushe.com';

/*
 * 论坛号对应关系（米游社自己的分类）：
 *   29 = 原神同人图、56 = 星穹铁道同人图、59 = 绝区零同人图，
 *   39 = 大别野同人图（终末地、异环这类非米家游戏都发在这里）。
 * 大别野里游戏是混着的，所以按标题关键词再筛一遍。
 */
const TARGETS = {
  genshin: { forums: [29], site: 'ys', match: () => true },
  starrail: { forums: [56], site: 'sr', match: () => true },
  zzz: { forums: [59], site: 'zzz', match: () => true },
  endfield: { forums: [39], site: 'bbs', match: (text) => /终末地|明日方舟终末地|Endfield/i.test(text) },
  neverness: { forums: [39], site: 'bbs', match: (text) => /异环|Neverness/i.test(text) },
};

const CACHE_FILE = 'post-art.json';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

function headersFor(url, cookie) {
  const headers = {
    'user-agent': UA,
    accept: 'application/json',
    referer: 'https://www.miyoushe.com/',
    DS: createDs2(url),
    'x-rpc-app_version': '2.90.1',
    'x-rpc-client_type': '5',
    'x-rpc-language': 'zh-cn',
  };
  if (cookie) headers.cookie = cookie;
  return headers;
}

async function getJson(url, cookie) {
  const response = await fetch(url, { headers: headersFor(url, cookie) });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { retcode: -1, message: `返回的不是 JSON（HTTP ${response.status}）` };
  }
}

/** 帖子列表。列表接口不带图片字段，只用来拿 post_id 和点赞数。 */
async function listPosts(forumId, sortType, cookie) {
  const url = `${BBS}/post/wapi/getForumPostList?forum_id=${forumId}&page_size=20&sort_type=${sortType}&last_id=0`;
  const data = await getJson(url, cookie);
  const list = (data && data.data && data.data.list) || [];
  return list.map((item) => {
    const post = item.post || item;
    return {
      id: String(post.post_id || ''),
      like: Number((item.stat && item.stat.like_num) || 0),
      subject: String(post.subject || ''),
    };
  });
}

async function postDetail(postId, cookie) {
  const url = `${BBS}/post/wapi/getPostFull?post_id=${encodeURIComponent(postId)}&read=1`;
  const data = await getJson(url, cookie);
  return (data && data.data && data.data.post && data.data.post.post) || null;
}

/** 从帖子里挑一张能当横幅的横图：够宽、别太窄长。 */
function bestImage(post) {
  const images = (post && post.image_list) || [];
  const usable = images
    .map((img) => ({
      url: String(img.url || ''),
      width: Number(img.width || 0),
      height: Number(img.height || 0),
    }))
    .filter((img) => img.url && img.width >= 1200 && img.height > 0 && img.width / img.height >= 1.15);
  if (!usable.length) return null;
  usable.sort((a, b) => b.width * b.height - a.width * a.height);
  return usable[0];
}

async function pickFor(key, cookie) {
  const target = TARGETS[key];
  if (!target) return null;
  for (const forumId of target.forums) {
    let posts = [];
    for (const sortType of [2, 1]) {
      try {
        posts = posts.concat(await listPosts(forumId, sortType, cookie));
      } catch {
        /* 一个排序挂掉不影响另一个 */
      }
    }
    if (!posts.length) continue;
    const seen = new Set();
    const ordered = posts
      .filter((post) => post.id && !seen.has(post.id) && seen.add(post.id))
      .sort((a, b) => b.like - a.like)
      .slice(0, 12);
    for (const summary of ordered) {
      let detail = null;
      try {
        detail = await postDetail(summary.id, cookie);
      } catch {
        continue;
      }
      if (!detail) continue;
      const subject = `${detail.subject || ''} ${(detail.content || '').slice(0, 200)}`;
      if (!target.match(subject)) continue;
      const image = bestImage(detail);
      if (!image) continue;
      return {
        image: image.url,
        source: `https://www.miyoushe.com/${target.site}/article/${summary.id}`,
        credit: `${(detail.user && detail.user.nickname) || '米游社画师'} · 米游社`,
        width: image.width,
        height: image.height,
      };
    }
  }
  return null;
}

function cachePath(userDataDir) {
  return path.join(userDataDir, CACHE_FILE);
}

function readCache(userDataDir) {
  try {
    const raw = fs.readFileSync(cachePath(userDataDir), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.items) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(userDataDir, items) {
  const file = cachePath(userDataDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), items }, null, 2), 'utf8');
  } catch {
    /* 写不进缓存不是致命错误 */
  }
}

/**
 * 重新抓一遍五款游戏的配图。
 * @param {object} options { userDataDir, cookie, force }
 */
async function refresh(options = {}) {
  const { userDataDir, cookie = '', force = false } = options;
  if (!userDataDir) throw new Error('缺少缓存目录');
  const cached = readCache(userDataDir);
  if (!force && cached && Date.now() - Number(cached.updatedAt || 0) < CACHE_TTL) {
    return { ok: true, cached: true, items: cached.items, updatedAt: cached.updatedAt };
  }
  const items = {};
  const errors = [];
  for (const key of Object.keys(TARGETS)) {
    try {
      const picked = await pickFor(key, cookie);
      if (picked) items[key] = picked;
    } catch (error) {
      errors.push(`${key}: ${(error && error.message) || error}`);
    }
  }
  if (Object.keys(items).length) {
    /* 抓到几张就合并几张，旧的别丢 —— 米游社偶尔会限流返回空列表 */
    const merged = { ...((cached && cached.items) || {}), ...items };
    writeCache(userDataDir, merged);
    return { ok: true, cached: false, items: merged, updatedAt: Date.now(), errors };
  }
  return {
    ok: false,
    cached: false,
    items: (cached && cached.items) || {},
    updatedAt: (cached && cached.updatedAt) || 0,
    errors,
    error: cookie ? '米游社没有返回可用的同人图' : '还没有登录米游社，暂时只能用官网美术图',
  };
}

module.exports.refresh = refresh;
module.exports.readCache = readCache;
module.exports.cachePath = cachePath;
module.exports.TARGETS = TARGETS;
module.exports._internals = { listPosts, postDetail, bestImage, pickFor, headersFor };
