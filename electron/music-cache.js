'use strict';

/*
 * 播放过的音频字节缓存。
 *
 * 之前每次点播放都要重新解析 + 重新下载一整首：music-source.js 里的
 * RESOLVE_CACHE 只是内存 Map，存的还只是 URL 字符串（20 分钟就过期），
 * 音频字节从来没落过盘。这里把真正的文件缓存在
 *   <userData>/music-cache/<sha1>.<ext>  +  <sha1>.json (sidecar)
 * 并用 hxl-audio:// 自定义协议喂给 <audio>。
 *
 * 为什么用自定义协议而不是裸 file://：
 *   services/audio-fx.js 会在切音效时给 <audio> 动态加 crossorigin="anonymous"，
 *   然后 createMediaElementSource 取样本。裸 file:// 没有 CORS 头，音效链
 *   必定回退「当前音源不支持跨域读取」。协议 handler 自己回 ACAO:* 即可两全，
 *   而且 URL 稳定（不随第三方 CDN 的临时签名变化），guardKey 也不会误挡。
 *
 * 注意：electron 的 app / protocol / ipcMain 一律延迟到函数内部取用，
 * 这样父流程在纯 node 下 require 本模块做静态自检时不会炸。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONFIG = { musicCache: true, musicCacheLimitMB: 2048 };
const CONFIG_FILE = 'config.json';
const KNOWN_EXT = ['mp3', 'flac', 'ogg', 'wav', 'm4a', 'aac', 'wma', 'ape', 'opus', 'webm'];

function electronApp() {
  try {
    const mod = require('electron');
    return mod && mod.app ? mod.app : null;
  } catch {
    return null;
  }
}

function musicCacheDir() {
  const app = electronApp();
  let base;
  try {
    base = app && app.getPath ? app.getPath('userData') : path.join(process.cwd(), 'data');
  } catch {
    base = path.join(process.cwd(), 'data');
  }
  const dir = path.join(base, 'music-cache');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录建不了就交给上层 fs 调用自己报错 */
  }
  return dir;
}

/*
 * 设置页的开关存在 JsonStore 的 settings 里（musicCache / musicCacheLimitMB）。
 * 主进程启动时用 setSettingsProvider 把 store 注入进来，readConfig 以它为准，
 * config.json 只作纯 node 环境 / 老数据兜底，保证开关与 UI 显示的是同一个值。
 */
let settingsProvider = null;

function setSettingsProvider(fn) {
  settingsProvider = typeof fn === 'function' ? fn : null;
}

function readConfig() {
  let fromSettings = {};
  if (settingsProvider) {
    try {
      const s = settingsProvider() || {};
      if (typeof s.musicCache === 'boolean') fromSettings.musicCache = s.musicCache;
      const limit = Number(s.musicCacheLimitMB);
      if (s.musicCacheLimitMB !== undefined && Number.isFinite(limit)) fromSettings.musicCacheLimitMB = limit;
    } catch {
      /* store 还没就绪就退到 config.json */
    }
  }
  try {
    const raw = fs.readFileSync(path.join(musicCacheDir(), CONFIG_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return Object.assign({}, DEFAULT_CONFIG, parsed || {}, fromSettings);
  } catch {
    return Object.assign({}, DEFAULT_CONFIG, fromSettings);
  }
}

function writeConfig(patch) {
  try {
    const next = Object.assign({}, readConfig(), patch || {});
    fs.writeFileSync(path.join(musicCacheDir(), CONFIG_FILE), JSON.stringify(next, null, 2));
    return next;
  } catch {
    return readConfig();
  }
}

/* 和 music-source.js 的 normalize 同款：削掉 (伴奏)/(Live) 这类括号后缀再比 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 键里必须带 level：同一首歌换音质不能复用低码率的旧文件 */
function hashKey(song, level) {
  const raw = `${normalize(song && song.title)}|${normalize(song && song.artist)}|${String(level || '')}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function extOf(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('flac')) return 'flac';
  if (ct.includes('ogg') || ct.includes('opus')) return 'ogg';
  if (ct.includes('wav')) return 'wav';
  if (ct.includes('mp4') || ct.includes('m4a') || ct.includes('aac')) return 'm4a';
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
  let clean = '';
  try {
    clean = new URL(String(url)).pathname;
  } catch {
    clean = String(url || '');
  }
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(clean);
  if (m && KNOWN_EXT.includes(m[1].toLowerCase())) return m[1].toLowerCase();
  return 'mp3';
}

function sidecarOf(dir, key) {
  return path.join(dir, `${key}.json`);
}

/* 命中直接返回稳定的 hxl-audio:// URL；命中不探测（sidecar 已验过完整性） */
function getCached(song, level) {
  try {
    const cfg = readConfig();
    if (cfg.musicCache === false || Number(cfg.musicCacheLimitMB) === 0) return null;
    const dir = musicCacheDir();
    const key = hashKey(song, level);
    const metaPath = sidecarOf(dir, key);
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const ext = meta.ext || extOf(meta.fallbackUrl, meta.contentType);
    const file = path.join(dir, `${key}.${ext}`);
    if (!fs.existsSync(file)) return null;
    const size = fs.statSync(file).size;
    if (!size || (Number(meta.bytes) > 0 && size !== Number(meta.bytes))) return null;
    meta.lastUsedAt = Date.now();
    try {
      fs.writeFileSync(metaPath, JSON.stringify(meta));
    } catch {
      /* 只更新不了时间也照常用 */
    }
    return `hxl-audio://${key}.${ext}`;
  } catch {
    return null;
  }
}

/* 同一个 key 的并发下载合并成一个 Promise */
const downloads = new Map();

async function downloadOne(url, song, level, key) {
  const dir = musicCacheDir();
  const partFile = path.join(dir, `${key}.part`);
  const metaPath = sidecarOf(dir, key);

  const resp = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
  const contentType = String(resp.headers.get('content-type') || '');
  /* 错误页 / JSON / 网页别当音频存下来 */
  if (/(text\/html|application\/json|text\/plain|application\/javascript|text\/javascript)/i.test(contentType)) {
    throw new Error('响应不是音频流');
  }
  const ext = extOf(url, contentType);
  const target = path.join(dir, `${key}.${ext}`);

  const { Readable } = require('stream');
  let bytes = 0;
  let head = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const node = Readable.fromWeb(resp.body);
    const ws = fs.createWriteStream(partFile);
    node.on('data', (chunk) => {
      bytes += chunk.length;
      if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)]);
    });
    node.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    node.pipe(ws);
  });
  if (!bytes) {
    try {
      fs.unlinkSync(partFile);
    } catch {
      /* ignore */
    }
    return null;
  }
  try {
    fs.renameSync(partFile, target);
  } catch (error) {
    try {
      fs.unlinkSync(partFile);
    } catch {
      /* ignore */
    }
    throw error;
  }
  const now = Date.now();
  const meta = {
    title: (song && song.title) || '',
    artist: (song && song.artist) || '',
    album: (song && song.album) || '',
    duration: (song && song.duration) || 0,
    bytes,
    magic: head.subarray(0, 16).toString('hex'),
    contentType,
    ext,
    fallbackUrl: String(url),
    lastUsedAt: now,
    createdAt: now,
  };
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  } catch {
    /* sidecar 写不了：下次 getCached 校验失败会自然重下 */
  }
  pruneToLimit();
  return `hxl-audio://${key}.${ext}`;
}

/* fire-and-forget：调用方不用 await，内部异常一律吞掉 */
function saveFromUrl(url, song, level) {
  try {
    const cfg = readConfig();
    if (cfg.musicCache === false || Number(cfg.musicCacheLimitMB) === 0) return Promise.resolve(null);
    if (!/^https?:\/\//i.test(String(url || ''))) return Promise.resolve(null);
    const key = hashKey(song, level);
    if (downloads.has(key)) return downloads.get(key);
    const job = downloadOne(url, song, level, key)
      .catch(() => null)
      .finally(() => downloads.delete(key));
    downloads.set(key, job);
    return job;
  } catch {
    return Promise.resolve(null);
  }
}

/* LRU：超过上限就删到 90% 以内，lastUsedAt 最旧的先删 */
function pruneToLimit() {
  try {
    const cfg = readConfig();
    const cap = (Number(cfg.musicCacheLimitMB) || 0) * 1024 * 1024;
    if (!cap) return;
    const dir = musicCacheDir();
    const items = [];
    let total = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name === CONFIG_FILE) continue;
      const metaPath = path.join(dir, name);
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const key = name.slice(0, -5);
        const audio = path.join(dir, `${key}.${meta.ext || 'mp3'}`);
        let size = Number(meta.bytes) || 0;
        try {
          size = fs.statSync(audio).size;
        } catch {
          /* 音频文件丢了：仍按 meta.bytes 计入，下面一起清掉 */
        }
        items.push({ audio, metaPath, size, lastUsedAt: Number(meta.lastUsedAt) || 0 });
        total += size;
      } catch {
        /* 坏 sidecar 跳过 */
      }
    }
    if (total <= cap) return;
    const target = cap * 0.9;
    items.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const item of items) {
      if (total <= target) break;
      try {
        fs.unlinkSync(item.audio);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(item.metaPath);
      } catch {
        /* ignore */
      }
      total -= item.size;
    }
  } catch {
    /* 淘汰失败不影响播放 */
  }
}

function stats() {
  const cfg = readConfig();
  let bytes = 0;
  let files = 0;
  try {
    const dir = musicCacheDir();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name === CONFIG_FILE) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        const key = name.slice(0, -5);
        const audio = path.join(dir, `${key}.${meta.ext || 'mp3'}`);
        bytes += fs.statSync(audio).size;
        files += 1;
      } catch {
        /* 孤立 sidecar 不计 */
      }
    }
  } catch {
    /* ignore */
  }
  return {
    bytes,
    files,
    limitMB: Number(cfg.musicCacheLimitMB) || 0,
    enabled: cfg.musicCache !== false,
  };
}

function clear() {
  try {
    const dir = musicCacheDir();
    for (const name of fs.readdirSync(dir)) {
      if (name === CONFIG_FILE) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* ignore */
      }
    }
    /* URL 内存缓存也一起清，否则下次解析会拿回一条已经不存在的旧直链 */
    try {
      const source = require('./music-source');
      if (source && typeof source.clearResolveCache === 'function') source.clearResolveCache();
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
  return stats();
}

/*
 * hxl-audio://<sha1>.<ext>
 * 自己实现三类 Range，返回 206 + 全套头 + ACAO:*，音效链才能取到样本。
 */
function installMusicCacheProtocol() {
  const { protocol } = require('electron');
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
  };
  protocol.handle('hxl-audio', async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const u = new URL(request.url);
      /*
       * hxl-audio://<key>.<ext> 里 <key>.<ext> 是 standard scheme 的 hostname，
       * pathname 为空；写成 hxl-audio://audio/<key>.<ext> 时则在 pathname 里。
       * 两种都认，取第一个非空段。
       */
      const raw = (u.pathname && u.pathname.replace(/^\/+/, '')) || u.hostname || '';
      const name = decodeURIComponent(raw).split('/')[0];
      /* 只认 40 位 hex，挡住 ../ 路径穿越 */
      const m = /^([a-f0-9]{40})\.([a-z0-9]{1,8})$/i.exec(name);
      if (!m) return new Response('Bad Request', { status: 400, headers: cors });
      const key = m[1];
      const ext = m[2].toLowerCase();
      const dir = musicCacheDir();
      const file = path.join(dir, `${key}.${ext}`);
      if (!fs.existsSync(file)) return new Response('Not Found', { status: 404, headers: cors });
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(sidecarOf(dir, key), 'utf8'));
      } catch {
        /* sidecar 丢了就按扩展名猜类型 */
      }
      const total = fs.statSync(file).size;
      const headers = Object.assign({
        'Content-Type': meta.contentType || (ext === 'flac' ? 'audio/flac' : 'audio/mpeg'),
        'Accept-Ranges': 'bytes',
      }, cors);
      let start = 0;
      let end = total - 1;
      let status = 200;
      const range = request.headers.get('Range') || request.headers.get('range');
      if (range && /^bytes=/i.test(range)) {
        const spec = String(range).slice(6).trim();
        let mm = /^(\d+)-(\d*)$/.exec(spec);
        if (mm) {
          start = Number(mm[1]);
          end = mm[2] ? Math.min(Number(mm[2]), total - 1) : total - 1;
        } else {
          mm = /^-(\d+)$/.exec(spec);
          if (mm) {
            const suffix = Number(mm[1]);
            start = Math.max(0, total - suffix);
            end = total - 1;
          }
        }
        if (!Number.isFinite(start) || start > end || start >= total) {
          return new Response(null, {
            status: 416,
            headers: Object.assign({}, headers, { 'Content-Range': `bytes */${total}` }),
          });
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      }
      headers['Content-Length'] = String(end - start + 1);
      if (request.method === 'HEAD') return new Response(null, { status, headers });
      const { Readable } = require('stream');
      const node = fs.createReadStream(file, { start, end });
      return new Response(Readable.toWeb(node), { status, headers });
    } catch (error) {
      return new Response(String((error && error.message) || error), { status: 500, headers: cors });
    }
  });
}

function installMusicCacheIpc(_ctx) {
  const { ipcMain, shell } = require('electron');
  const reg = (channel, fn) => {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      /* 首次注册没有旧 handler */
    }
    ipcMain.handle(channel, fn);
  };
  reg('music-cache:stats', async () => stats());
  reg('music-cache:clear', async () => clear());
  reg('music-cache:open', async () => {
    try {
      return shell.openPath(musicCacheDir());
    } catch {
      return '';
    }
  });
  /* 设置页改开关/上限时把值同步进模块自己的 config.json */
  reg('music-cache:config', async (_event, patch) => writeConfig(patch || {}));
}

module.exports = {
  musicCacheDir,
  hashKey,
  getCached,
  saveFromUrl,
  pruneToLimit,
  stats,
  clear,
  installMusicCacheProtocol,
  installMusicCacheIpc,
  readConfig,
  writeConfig,
  setSettingsProvider,
};
