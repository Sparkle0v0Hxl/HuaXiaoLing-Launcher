'use strict';

/**
 * 网易云音乐客户端 + 播放地址回退链。
 *
 * 抽出来的原因：这套东西被音乐登录、歌单、播放地址解析、直播间点歌四处共用，
 * 原来全都埋在 main.js 的 installIpc() 闭包里（那个函数一度有 11300 多行），
 * 谁想用都得通过 ctx 传，容易漏。
 *
 * 搬运时逻辑未改。neteaseSession 与 neteaseServiceProcess 这两个可变状态
 * 原本是 main.js 的模块级 let，现在是本模块内部状态，通过 getter/setter 暴露。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/*
 * 下面这些原本在 main.js 作用域里，搬运时被直接引用却没在模块里引入，
 * 一调用就 ReferenceError（跨平台换源、音源开关、启动本地服务全都走不通）。
 * music-source / music-resolve 都不反向依赖本模块，直接 require 不会成环。
 */
const {
  normalizeSourceFlags,
  DEFAULT_SOURCE_FLAGS,
  disabledSourceOfUrl,
  pickBest,
  qqSearch,
  qqSongUrl,
} = require('./music-source');
const { sameSongEnough } = require('./music-resolve');

/* 音源开关要读 store，但 store 由 main.js 持有，这里用注入的方式拿 */
let storeRef = () => null;
function setStoreRef(fn) {
  if (typeof fn === 'function') storeRef = fn;
}

/* 与 main.js 同名常量保持一致 */
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let neteaseServiceProcess = null;

let neteaseSession = { apiBase: '', cookie: '' };

function normalizeNeteaseBase(value) {
  return String(value || 'http://127.0.0.1:3100').trim().replace(/\/+$/, '');
}

async function neteaseGet(apiBase, route, params = {}) {
  const base = normalizeNeteaseBase(apiBase);
  const query = new URLSearchParams({ ...params, timestamp: String(Date.now()) });
  /*
   * 把登录 cookie 带上，否则 /login/status 会返回未登录，
   * /user/playlist 就会是空列表。
   *
   * neteaseSession.apiBase 可能是空的（比如从二维码登录后没记下地址，
   * 或者地址是从 localStorage 默认值推出来的），这时只要有 cookie
   * 就应该带上 —— 之前这里要求两个地址完全相等，
   * 结果地址对不上时 cookie 被丢掉，表现就是「歌单是空的」。
   */
  if (neteaseSession.cookie) {
    const saved = normalizeNeteaseBase(neteaseSession.apiBase);
    if (!neteaseSession.apiBase || saved === base) {
      query.set('cookie', neteaseSession.cookie);
    }
  }
  const response = await fetch(`${base}${route}?${query.toString()}`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`本地网易云 API HTTP ${response.status}`);
  const json = await response.json();
  // 拿到不属于网易云 API 的响应时早点报错，别让界面显示成「歌单是空的」
  if (!looksLikeNeteaseApi(json)) {
    throw new Error(
      `本地 API 地址 ${base} 上跑的不是网易云服务（可能是别的程序占用了这个端口），请在登录窗口里换一个端口`
    );
  }
  return json;
}

function looksLikeNeteaseApi(json) {
  if (!json || typeof json !== 'object') return false;
  // snowluma 之类的失败响应
  if (json.status === 'failed' || json.retcode !== undefined) return false;

  // 典型形状：data.code + data.account
  const data = json.data;
  if (data && typeof data === 'object') {
    const code = Number(data.code);
    if (Number.isFinite(code)) {
      // 未登录时 account 为空、只有 code
      const account = data.account;
      if (!account) return code === 200 || code === 301;
      if (typeof account !== 'object') return false;
      // 账号对象必须带网易云特征字段
      return (
        account.id !== undefined &&
        ('anonimousUser' in account ||
          'whitelistAuthority' in account ||
          'tokenVersion' in account ||
          'baoyueVersion' in account)
      );
    }
  }

  /*
   * 其余接口（playlist / search 等）直接返回顶层 code。
   * 这里故意不接受「顶层 code + 顶层 account」：
   * /login/status 的真响应一定有 data 包装，而没有 data 包装、
   * 却带着顶层 account 的，正是 snowluma 那一类冒牌服务。
   */
  const topCode = Number(json.code);
  if (Number.isFinite(topCode) && !('account' in json)) return true;

  return false;
}

async function probeNeteaseApi(base, timeout = 1200) {
  try {
    const response = await fetch(`${base}/login/status`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return false;
    const json = await response.json().catch(() => null);
    return looksLikeNeteaseApi(json);
  } catch {
    return false;
  }
}

async function startNeteaseService(apiBase) {
  const base = normalizeNeteaseBase(apiBase);
  if (await probeNeteaseApi(base)) return { started: false, apiBase: base, running: true };
  const candidates = [
    path.join(app.getPath('userData'), 'NeteaseCloudMusicApi'),
    path.join(app.getPath('userData'), 'netease-api'),
    path.join(process.env.USERPROFILE || '', 'NeteaseCloudMusicApi'),
    path.join(process.cwd(), 'NeteaseCloudMusicApi'),
    path.join(process.resourcesPath || '', 'NeteaseCloudMusicApi'),
    path.join(process.resourcesPath || '', 'netease-api'),
    path.join(app.getAppPath(), 'netease-api'),
  ];
  for (const dir of candidates) {
    const entry = ['app.js', 'server.js', 'index.js']
      .map((name) => path.join(dir, name))
      .find((file) => fs.existsSync(file));
    if (!entry) continue;
    const port = new URL(base).port || '3000';
    neteaseServiceProcess = spawn(process.execPath, [entry], {
      cwd: dir,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: port,
        HOST: '127.0.0.1',
      },
    });
    neteaseServiceProcess.unref();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await probeNeteaseApi(base, 1000)) return { started: true, apiBase: base, running: true };
    }
    throw new Error(
      `本地服务已启动，但还没有响应（端口 ${port}）。如果这个端口被其它程序占用，请换一个端口再试`
    );
  }
  throw new Error(
    '没有找到 NeteaseCloudMusicApi。请把它下载到启动器数据目录下的 NeteaseCloudMusicApi 文件夹，或手动运行后填写地址。'
  );
}

const NETEASE_URL_BATCH = 200;

function currentMusicSourceFlags() {
  /* 用 music-source 里那份 DEFAULT_SOURCE_FLAGS，别再抄一份硬编码的默认值 —— 抄了就会各改各的 */
  return Object.assign(
    {},
    DEFAULT_SOURCE_FLAGS,
    normalizeSourceFlags(storeRef()?.data?.settings?.musicSources) || {}
  );
}

async function crossSourceFallbackUrl(title, artist, flags) {
  const name = String(title || '').trim();
  if (!name) throw new Error('没有歌名，无法换源');
  const keyword = `${name} ${String(artist || '').split('/')[0].trim()}`.trim();
  const tried = [];
  const wants = { title: name, artist: String(artist || '') };
  const tries = [];
  /* 酷狗音源已整体移除（不再搜、不再取链），跨平台兜底只剩 QQ 音乐一家 */
  if (flags.qq !== false) {
    tries.push([
      'QQ 音乐',
      async () => {
        const best = pickBest(await qqSearch(keyword, 5), wants);
        if (!best) throw new Error('没搜到同名曲');
        if (!sameSongEnough(name, artist, best.title, best.artist)) throw new Error('搜到的不是同一首歌');
        const info = await qqSongUrl(best.mid);
        return { ...info, title: best.title, artist: best.artist, matched: `${best.title} - ${best.artist}` };
      },
    ]);
  }
  if (!tries.length) throw new Error('QQ 音乐音源已被停用');
  for (const [label, run] of tries) {
    try {
      return await run();
    } catch (error) {
      tried.push(`${label}：${error.message}`);
    }
  }
  throw new Error(tried.join('；') || '没有可用的替代音源');
}

async function neteaseMatchUrl(apiBase, id) {
  try {
    const json = await neteaseGet(apiBase, '/song/url/match', { id });
    const url = typeof json?.data === 'string' ? json.data : '';
    return url ? String(url).replace(/^http:/i, 'https:') : '';
  } catch {
    return '';
  }
}

async function fetchNeteaseSongUrl(apiBase, id, level = 'exhigh', meta = {}) {
  const allowed = new Set(['standard', 'higher', 'exhigh', 'lossless', 'hires']);
  const wanted = allowed.has(String(level)) ? String(level) : 'exhigh';
  const ladder = [...new Set([wanted, 'exhigh', 'higher', 'standard'])];
  let trial = null;
  // 音源开关：网易云被停用时，原生直链和 unblock 换源都不走，只留跨平台兜底
  const flags = meta.flags || currentMusicSourceFlags();
  const neteaseAllowed = flags.netease !== false;

  for (const quality of neteaseAllowed ? ladder : []) {
    let json = null;
    try {
      json = await neteaseGet(apiBase, '/song/url/v1', { id, level: quality });
    } catch {
      try {
        json = await neteaseGet(apiBase, '/song/url', { id });
      } catch {
        json = null;
      }
    }
    const item = json?.data?.[0];
    if (!item?.url) continue;
    // unblock 可能把地址换成被停用平台的直链，撞上就当这条音质没拿到
    if (disabledSourceOfUrl(item.url, flags)) continue;
    const payload = {
      url: String(item.url),
      level: String(item.level || quality),
      br: Number(item.br) || 0,
      size: Number(item.size) || 0,
      type: String(item.type || ''),
    };
    // 会员曲目在非会员账号下只会给一段试听，先留着当兜底
    if (item.freeTrialInfo) {
      if (!trial) trial = { ...payload, trial: true };
      continue;
    }
    return payload;
  }

  // 2) 换源：拿到完整音源就不必再降级（match 结果同样按开关过滤）
  if (neteaseAllowed) {
    const matched = await neteaseMatchUrl(apiBase, id);
    if (matched && !disabledSourceOfUrl(matched, flags)) {
      return { url: matched, level: 'standard', br: 0, size: 0, type: 'flac', unblocked: true };
    }
  }

  const title = String(meta.title || '').trim();
  const artist = String(meta.artist || '').trim();

  /*
   * 3) 同一个歌名的其它版本（重制 / 现场 / 翻唱）通常没有版权限制。
   *    只按歌名搜出来的列表里混着同名不同曲和别人的翻唱，以前是「第一个能播的就用」，
   *    于是会出现「点了这首、放的是另一首」还毫无提示。先按同歌名 + 同歌手筛一遍。
   */
  if (neteaseAllowed && title) {
    try {
      const search = await neteaseGet(apiBase, '/search', { keywords: `${title} ${artist}`.trim(), limit: 8, type: 1 });
      const list = (search?.result?.songs || []).filter(
        (song) =>
          song?.id &&
          String(song.id) !== String(id) &&
          sameSongEnough(
            title,
            artist,
            song.name,
            (song.ar || song.artists || []).map((a) => a.name).filter(Boolean).join(' / ')
          )
      );
      for (const song of list) {
        if (!song?.id || String(song.id) === String(id)) continue;
        try {
          const alt = await neteaseGet(apiBase, '/song/url/v1', { id: song.id, level: 'standard' });
          const item = alt?.data?.[0];
          if (!item?.url || item.freeTrialInfo || disabledSourceOfUrl(item.url, flags)) continue;
          return {
            url: String(item.url),
            level: String(item.level || 'standard'),
            br: Number(item.br) || 0,
            size: Number(item.size) || 0,
            type: String(item.type || ''),
            // 带上实际用的这份的歌名 / 歌手：渲染层换源后还要再核一次身份
            // （用 matchedTitle/Artist，别覆盖 title/artist，否则队列里的歌名会被换掉）
            matchedTitle: String(song.name || title),
            matchedArtist: (song.ar || song.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
            altOf: {
              id: song.id,
              title: String(song.name || ''),
              artist: (song.ar || song.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
            },
          };
        } catch {
          /* 换下一个版本 */
        }
      }
    } catch {
      /* 搜索失败就走跨平台 */
    }
  }

  // 4) QQ 音乐上免费的那一份（被停用就跳过）
  if (title) {
    try {
      const alt = await crossSourceFallbackUrl(title, artist, flags);
      return {
        url: alt.url,
        level: 'standard',
        br: alt.br || 0,
        size: 0,
        type: '',
        // 换到 QQ 的那份：歌名歌手单独放 matched* 上，渲染层据此核「还是不是这首」
        matchedTitle: alt.title || title,
        matchedArtist: alt.artist || artist,
        otherSource: { source: alt.source, matched: alt.matched || '' },
      };
    } catch {
      /* QQ 那份也没拿到（付费或被停用），落到最后统一报错 */
    }
  }

  // 5) 实在没有完整音源，就把 30 秒试听给他，别让播放器干站着
  if (neteaseAllowed && trial) return trial;

  throw new Error('这首歌是会员专享，暂时没有可播放的音源；登录有会员的账号后即可完整播放');
}

/** 退出时杀掉可能还挂着的本地网易云服务进程。 */
function killNeteaseService() {
  try {
    if (neteaseServiceProcess) {
      neteaseServiceProcess.kill();
      neteaseServiceProcess = null;
    }
  } catch {
    /* 进程可能已经自己退了 */
  }
}

module.exports = {
  normalizeNeteaseBase,
  neteaseGet,
  looksLikeNeteaseApi,
  probeNeteaseApi,
  startNeteaseService,
  currentMusicSourceFlags,
  crossSourceFallbackUrl,
  neteaseMatchUrl,
  fetchNeteaseSongUrl,
  NETEASE_URL_BATCH,
  getNeteaseSession: () => neteaseSession,
  setNeteaseSession: (value) => { neteaseSession = value; },
  killNeteaseService,
  setStoreRef,
};
