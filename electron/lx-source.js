'use strict';

/**
 * 第三方音源脚本运行时（兼容常见脚本接口格式）。
 *
 * 音源脚本是跑在沙箱里的 JS：从注入的全局对象上取接口，
 * 用 `on(EVENT_NAMES.request, handler)` 注册处理器，用
 * `send(EVENT_NAMES.inited, { status, sources })` 声明自己支持哪些平台。
 * 它本身**不做歌名搜索**，只负责「平台 ID/歌名 → 可播放直链」的聚合换链，
 * 所以这里只实现 `action === 'musicUrl'` 这一条路径。
 *
 * 设计要点：
 *   · 每个脚本单独一个 vm 上下文，加载失败只影响它自己，不影响别的脚本；
 *   · 目录里 `.json` 后缀的文件内容其实是纯 JS（以块注释开头），一律按源码文本跑，
 *     不要 JSON.parse；
 *   · 脚本交回来的 URL 未必真能播（错误页 / 失效 CDN / 试听片段），统一用
 *     audio-probe 只读头部验一次身份，按「脚本加载顺序 → 平台顺序」取第一条通过的；
 *   · 任何内部异常都收敛成一句「导入的音源没拿到可播放的链接」，绝不把主进程搞崩。
 *
 * 注意：这里不要 require('./music-source')，那会形成循环依赖。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

// 播放前探测由 audio-probe 提供（只读头部十几 KB）；拿不到就退回本文件里的极简探测。
let probeAudioUrl = null;
try {
  ({ probeAudioUrl } = require('./audio-probe'));
} catch {
  probeAudioUrl = null;
}

const PLATFORM_ORDER = ['wy', 'kw', 'tx', 'mg', 'kg'];
const DEFAULT_TIMEOUT = 12000;
const PROBE_TIMEOUT = 2500;
const REQUEST_TIMEOUT = 8000;
const SCRIPT_RUN_TIMEOUT = 3000;
const SLOW_SETTLE_MS = 800;
const MAX_REDIRECTS = 5;
const PRIORITY_GRACE_MS = 150;
const MAX_PARALLEL_PROBES = 6;
const DEFAULT_QUALITY = '320k';
const SCRIPT_API_VERSION = '2.11.0';
const DEBUG = !!process.env.HXL_LX_DEBUG;

/** 已加载缓存：{ dir, scripts, loadedAt, settled } */
let CACHE = null;
/** setLxSourceDir() 显式指定的脚本目录，优先级最高 */
let EXPLICIT_DIR = '';

// ---------------------------------------------------------------- 基础工具

function debugLog(...args) {
  if (!DEBUG) return;
  try {
    console.log('[音源脚本]', ...args);
  } catch { /* ignore */ }
}

function toBuffer(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value.length === 'number') {
    try {
      return Buffer.from(value);
    } catch {
      return Buffer.alloc(0);
    }
  }
  return Buffer.alloc(0);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function looksTextual(contentType) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!ct) return true;
  if (ct.startsWith('text/')) return true;
  return /(json|xml|javascript|ecmascript|html|x-www-form-urlencoded|graphql)/.test(ct);
}

function hasHeader(headers, name) {
  const lower = String(name).toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

// ---------------------------------------------------------------- 脚本沙箱

/** 把响应体按 content-type 转成脚本能直接用的形态：JSON → 已解析对象，其它 → string / Buffer */
function buildResponseBody(buf, contentType) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  const text = buf.toString('utf8');
  if (!ct) {
    // 没有 content-type 时试着按 JSON 解析，失败就给文本。
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (ct.includes('json') || ct.includes('javascript') || ct.includes('xml') || ct.includes('text/')) {
    if (ct.includes('json') || ct.includes('javascript')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }
  return buf;
}

/**
 * callback 风格 HTTP 请求，对齐脚本常见的 request 语义。
 * 关键契约：响应是 JSON 时 `resp.body` 必须是**已解析的 JS 对象**
 * （屿溪 / 长青 / 独家音源-v5 直接读 `resp.body.code`，给 Buffer/string 会让它们全部失效）。
 */
function lxRequest(rawUrl, options, callback) {
  let opts = options;
  let cb = callback;
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  opts = opts || {};
  const hook = typeof cb === 'function' ? cb : () => {};
  let settled = false;
  const finish = (err, resp) => {
    if (settled) return;
    settled = true;
    try {
      hook(err, resp);
    } catch (error) {
      debugLog('request callback threw', error && error.message);
    }
  };

  let target;
  try {
    target = new URL(String(rawUrl || ''));
  } catch (error) {
    setImmediate(() => finish(error instanceof Error ? error : new Error('请求地址不合法')));
    return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    setImmediate(() => finish(new Error('只支持 http/https 请求')));
    return;
  }

  const headers = {};
  for (const [key, value] of Object.entries(opts.headers || {})) {
    if (value === undefined || value === null) continue;
    headers[key] = String(value);
  }

  let bodyBuf = null;
  if (opts.form && typeof opts.form === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.form)) params.append(key, value == null ? '' : String(value));
    bodyBuf = Buffer.from(params.toString(), 'utf8');
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  } else {
    const rawBody = opts.body !== undefined && opts.body !== null ? opts.body : opts.data;
    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody === 'string' || Buffer.isBuffer(rawBody)) {
        bodyBuf = toBuffer(rawBody);
      } else {
        // 对象必须 JSON.stringify，String(obj) 会变成 "[object Object]" 被后端拒。
        try {
          const json = JSON.stringify(rawBody);
          bodyBuf = Buffer.from(json === undefined ? '' : json, 'utf8');
          if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json; charset=UTF-8';
        } catch {
          bodyBuf = Buffer.from(String(rawBody), 'utf8');
        }
      }
    }
  }
  if (bodyBuf) headers['Content-Length'] = String(bodyBuf.length);

  const method = String(opts.method || (bodyBuf ? 'POST' : 'GET')).toUpperCase();
  const timeoutMs = Number(opts.timeout) > 0 ? Number(opts.timeout) : REQUEST_TIMEOUT;

  const sendOnce = (current, finalUrl, redirectsLeft) => {
    const lib = current.protocol === 'https:' ? https : http;
    let req;
    try {
      req = lib.request(
        {
          protocol: current.protocol,
          hostname: current.hostname,
          port: current.port || undefined,
          path: `${current.pathname || '/'}${current.search || ''}`,
          method,
          headers,
        },
        (res) => {
          const status = res.statusCode || 0;
          const location = res.headers && res.headers.location;
          if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
            // 跟随重定向（玉宁熙靠 resp.finalUrl 取真实地址）。
            let next;
            try {
              next = new URL(String(location), current.href);
            } catch {
              next = null;
            }
            try {
              res.resume();
            } catch { /* ignore */ }
            if (next && (next.protocol === 'http:' || next.protocol === 'https:')) {
              sendOnce(next, next.href, redirectsLeft - 1);
              return;
            }
          }
          const chunks = [];
          res.on('data', (chunk) => {
            chunks.push(toBuffer(chunk));
          });
          res.on('end', () => {
            let buf = Buffer.concat(chunks);
            const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
            if (buf.length && encoding) {
              try {
                if (encoding.includes('gzip')) buf = zlib.gunzipSync(buf);
                else if (encoding.includes('deflate')) {
                  try {
                    buf = zlib.inflateSync(buf);
                  } catch {
                    buf = zlib.inflateRawSync(buf);
                  }
                } else if (encoding.includes('br') && typeof zlib.brotliDecompressSync === 'function') {
                  buf = zlib.brotliDecompressSync(buf);
                }
              } catch (error) {
                debugLog('decode response failed', error && error.message);
              }
            }
            const contentType = res.headers['content-type'];
            const body = buildResponseBody(buf, contentType);
            finish(null, {
              statusCode: status,
              headers: res.headers,
              body,
              finalUrl: finalUrl || current.href,
              raw: buf,
            });
          });
          res.on('error', (error) => finish(error));
        },
      );
    } catch (error) {
      setImmediate(() => finish(error));
      return;
    }

    const timer = setTimeout(() => {
      try {
        req.destroy(new Error('request timeout'));
      } catch { /* ignore */ }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const clear = () => clearTimeout(timer);
    req.on('close', clear);
    req.on('error', (error) => {
      clear();
      finish(error);
    });
    try {
      if (bodyBuf && bodyBuf.length && redirectsLeft === MAX_REDIRECTS) req.write(bodyBuf);
      req.end();
    } catch (error) {
      clear();
      finish(error);
    }
  };

  sendOnce(target, target.href, MAX_REDIRECTS);
}

function makeConsole(scriptName) {
  const prefix = `[脚本:${scriptName}]`;
  const emit = (level) => (...args) => debugLog(level, prefix, ...args);
  return {
    log: emit('log'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    debug: emit('debug'),
    trace: emit('trace'),
    dir: emit('dir'),
    table: emit('table'),
    group: () => {},
    groupEnd: () => {},
    time: () => {},
    timeEnd: () => {},
    assert: () => {},
  };
}

function makeBufferUtils() {
  return {
    from: (value, encoding) => Buffer.from(value, encoding || 'utf8'),
    bufToString: (value, encoding) => {
      const enc = encoding || 'utf8';
      if (value == null) return '';
      if (typeof value === 'string') return value;
      try {
        return toBuffer(value).toString(enc);
      } catch {
        try {
          return String(value);
        } catch {
          return '';
        }
      }
    },
    alloc: (size) => Buffer.alloc(Number(size) > 0 ? Number(size) : 0),
    concat: (list) => Buffer.concat(Array.isArray(list) ? list.map(toBuffer) : []),
  };
}

function stubCipher(label) {
  return (...args) => {
    debugLog(`utils.crypto.${label} 是桩实现，跳过（参数 ${args.length} 个）`);
    return '';
  };
}

function makeCryptoUtils() {
  return {
    md5: (input) => {
      try {
        return crypto.createHash('md5').update(toBuffer(input)).digest('hex');
      } catch {
        return '';
      }
    },
    randomBytes: (size) => {
      const n = Number(size) > 0 ? Math.floor(Number(size)) : 0;
      try {
        return crypto.randomBytes(n);
      } catch {
        return Buffer.alloc(n);
      }
    },
    // 签名不确定，做成不抛异常的 best-effort 桩：抛出去会拖垮整个脚本。
    aesEncrypt: stubCipher('aesEncrypt'),
    aesDecrypt: stubCipher('aesDecrypt'),
    rsaEncrypt: stubCipher('rsaEncrypt'),
    rsaDecrypt: stubCipher('rsaDecrypt'),
  };
}

function makeZlibUtils() {
  const wrap = (fn) => (input, options) => {
    try {
      return fn(toBuffer(input), options);
    } catch (error) {
      debugLog('utils.zlib 失败', error && error.message);
      throw error;
    }
  };
  return {
    inflate: wrap(zlib.inflateSync),
    deflate: wrap(zlib.deflateSync),
    inflateRaw: wrap(zlib.inflateRawSync),
    deflateRaw: wrap(zlib.deflateRawSync),
    gunzip: wrap(zlib.gunzipSync),
    gzip: wrap(zlib.gzipSync),
  };
}

/**
 * 造一个脚本沙箱，并返回事件收集器。
 * @returns {{sandbox: object, state: {handlers: Function[], sources: string[], inited: boolean, meta: object}}}
 */
function createLxSandbox(scriptName) {
  const state = {
    handlers: [],
    sources: [],
    inited: false,
    meta: null,
    name: scriptName,
  };

  const EVENT_NAMES = new Proxy(
    {},
    {
      get: (_target, key) => String(key),
      has: () => true,
    },
  );

  const lx = {
    EVENT_NAMES,
    request: (url, options, callback) => lxRequest(url, options, callback),
    on: (event, handler) => {
      if (String(event) !== 'request') return;
      if (typeof handler === 'function') state.handlers.push(handler);
    },
    send: (event, payload) => {
      if (String(event) !== 'inited') return;
      state.inited = true;
      try {
        if (payload && payload.meta && typeof payload.meta === 'object') state.meta = payload.meta;
        const sources = payload && payload.sources;
        if (sources && typeof sources === 'object') {
          state.sources = Object.keys(sources).map((key) => String(key));
        }
      } catch { /* ignore */ }
    },
    env: { platform: process.platform, lang: 'zh_cn', version: SCRIPT_API_VERSION },
    version: SCRIPT_API_VERSION,
    currentScriptInfo: { name: scriptName, version: '' },
    utils: {
      buffer: makeBufferUtils(),
      crypto: makeCryptoUtils(),
      zlib: makeZlibUtils(),
    },
  };

  const sandbox = {};
  sandbox.console = makeConsole(scriptName);
  sandbox.setTimeout = (fn, ms, ...args) => setTimeout(fn, ms, ...args);
  sandbox.setInterval = (fn, ms, ...args) => setInterval(fn, ms, ...args);
  sandbox.clearTimeout = (id) => clearTimeout(id);
  sandbox.clearInterval = (id) => clearInterval(id);
  sandbox.setImmediate = (fn, ...args) => setImmediate(fn, ...args);
  sandbox.queueMicrotask = (fn) => queueMicrotask(fn);
  sandbox.Buffer = Buffer;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.URL = URL;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.atob = (input) => Buffer.from(String(input), 'base64').toString('latin1');
  sandbox.btoa = (input) => Buffer.from(String(input), 'latin1').toString('base64');
  sandbox.fetch = (...args) => globalThis.fetch(...args);
  sandbox.AbortController = AbortController;
  sandbox.AbortSignal = AbortSignal;
  // 只给最小 process：脚本靠它判平台，不能让它碰 exit / binding。
  sandbox.process = { platform: process.platform, version: process.version, env: {} };
  sandbox.lx = lx;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  return { sandbox, state };
}

// ---------------------------------------------------------------- 目录与加载

/**
 * 音源脚本目录。优先级：显式指定 > 环境变量 > 用户数据目录下的脚本目录。
 *
 * 安装包里不带任何音源脚本，目录落在用户数据目录下，由用户自己往里放。
 * 目录不存在时 ensureLoaded() 里已经有 try/catch，只是空列表，不会抛错。
 */
function resolveDir() {
  if (EXPLICIT_DIR) return EXPLICIT_DIR;
  const fromEnv = process.env.HXL_LX_SOURCE_DIR;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  let base = '';
  try {
    // 懒取 electron.app：本模块在单元测试/纯 Node 环境下也可能被 require
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') base = app.getPath('userData');
  } catch {
    base = '';
  }
  if (!base) base = process.resourcesPath || path.join(__dirname, '..');
  return path.join(base, 'lx-sources');
}

function looksLikeScript(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.js' || ext === '.json';
}

function loadOneScript(dir, file) {
  const full = path.join(dir, file);
  const name = path.basename(file, path.extname(file));
  const entry = { name, file, dir: full, loaded: false, sources: [], handlers: 0, error: null, state: null };
  let code;
  try {
    // .json 后缀只是伪装，内容是纯 JS 源码，一律按文本读，不 JSON.parse。
    code = fs.readFileSync(full, 'utf8');
  } catch (error) {
    entry.error = `读取失败：${String(error && error.message).slice(0, 160)}`;
    return entry;
  }
  code = String(code).replace(/^\uFEFF/, '');

  const { sandbox, state } = createLxSandbox(name);
  try {
    const context = vm.createContext(sandbox);
    vm.runInContext(code, context, { timeout: SCRIPT_RUN_TIMEOUT, filename: file });
    entry.loaded = true;
  } catch (error) {
    entry.error = `执行失败：${String((error && error.message) || error).slice(0, 200)}`;
  }
  entry.sources = state.sources.slice();
  entry.handlers = state.handlers.length;
  entry.state = state;
  // 不少脚本把 on() 放在异步 IIFE 里（要先联网拿配置才注册），
  // 这里只记个标记，等真要用时再看有没有补上，不要在这一步就判死。
  entry.deferred = entry.loaded && !entry.handlers;
  return entry;
}

/** 实时读取某个脚本已注册的处理器数量（延迟注册的脚本会随时间变化） */
function handlerCount(script) {
  const state = script && script.state;
  return state && Array.isArray(state.handlers) ? state.handlers.length : 0;
}

/** 已执行成功、但还没注册处理器的脚本数（这类脚本通常要先联网拿配置才 on()） */
function pendingScripts(cache) {
  return cache.scripts.filter((script) => script.loaded && !handlerCount(script)).length;
}

/**
 * 等到所有脚本都注册完处理器，或等到截止时间。
 * 两段式：已经有脚本就绪时只再等一个短窗口（让稍慢的补上），
 * 一个都没就绪时才用满 deadline（这类脚本通常要先联网拿配置才 on()）。
 */
async function settleHandlers(cache, budgetMs) {
  if (cache.settled) return;
  const started = Date.now();
  const deadline = started + Math.max(0, budgetMs);
  let ready = cache.scripts.filter((script) => script.loaded && handlerCount(script) > 0).length;
  while (pendingScripts(cache) > 0 && Date.now() < deadline) {
    // 已有脚本能干活时，别再为「还没初始化完」的脚本干等太久。
    if (ready > 0 && Date.now() - started >= SLOW_SETTLE_MS) break;
    await sleep(60);
    ready = cache.scripts.filter((script) => script.loaded && handlerCount(script) > 0).length;
  }
  cache.settled = true;
  debugLog('handler 结算完成', `ready=${ready}`, `pending=${pendingScripts(cache)}`, `used=${Date.now() - started}ms`);
}

/** 同步加载（只会真正扫盘一次），失败不影响其它脚本 */
function ensureLoaded(force = false) {
  const dir = resolveDir();
  if (!force && CACHE && CACHE.dir === dir) return CACHE;

  const scripts = [];
  let dirError = null;
  let files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    files = entries
      .filter((item) => item.isFile() && looksLikeScript(item.name))
      .map((item) => item.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  } catch (error) {
    dirError = String((error && error.message) || error).slice(0, 200);
    debugLog('音源目录不可用', dir, dirError);
  }

  for (const file of files) {
    const entry = loadOneScript(dir, file);
    scripts.push(entry);
    debugLog('loaded?', file, entry.loaded, entry.sources.join(',') || '-', entry.error || '');
  }

  CACHE = {
    dir,
    dirError,
    scripts,
    loadedAt: Date.now(),
    settled: false,
    failed: scripts.filter((item) => !item.loaded || !item.handlers).length,
  };
  return CACHE;
}

// ---------------------------------------------------------------- 换链

function qualityFromLevel(level) {
  const value = String(level || '').trim().toLowerCase();
  if (!value) return DEFAULT_QUALITY;
  if (value === 'lossless' || value === 'hires' || value === 'flac' || value === 'flac24bit') return 'flac';
  if (value === 'exhigh' || value === 'higher' || value === '320' || value === '320k') return '320k';
  if (value === 'standard' || value === '128k' || value === '128') return '128k';
  // 直接把音质名透传（master / atmos / hires 等脚本自己认）
  if (['master', 'atmos', 'atmos_plus', '192k', '192', 'sky', 'jymaster', 'dolby'].includes(value)) return value;
  return '128k';
}

function buildMusicInfo(song) {
  const src = song && typeof song === 'object' ? song : {};
  const text = (value) => (value === undefined || value === null ? '' : String(value));
  const neteaseId = text(src.neteaseId);
  const genericId = text(src.id);
  const album = text(src.album);
  return {
    name: text(src.title) || text(src.name),
    singer: text(src.artist) || text(src.singer),
    songmid: neteaseId || text(src.mid) || genericId,
    id: neteaseId || genericId,
    hash: text(src.hash),
    rid: text(src.rid),
    interval: '',
    albumName: album,
    album: album,
    albumId: '',
    _types: {},
    source: 'wy',
  };
}

function invokeHandler(handler, payload) {
  // 延到微任务里执行，避免同步 throw 变成未捕获 rejection。
  return Promise.resolve().then(() => handler(payload));
}

function extractUrl(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    // 独家音源-v5 的 musicUrl 返回对象 { url, play_url, src, level, ... }，不是字符串。
    // 优先挑 http(s) 开头的那个，其次再退到任意非空字符串。
    const keys = ['url', 'play_url', 'src', 'link', 'data', 'musicUrl', 'href'];
    let fallback = '';
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      if (!fallback) fallback = trimmed;
    }
    return fallback;
  }
  return '';
}

/** audio-probe 缺席时的极简兜底：只读头部，看状态码与类型/魔数 */
async function fallbackProbe(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let target;
    try {
      target = new URL(url);
    } catch {
      done({ ok: false, reason: '地址不合法' });
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname || '/'}${target.search || ''}`,
        method: 'GET',
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          range: 'bytes=0-16383',
        },
        timeout: PROBE_TIMEOUT,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status !== 200 && status !== 206) {
          res.destroy();
          done({ ok: false, reason: `HTTP ${status}` });
          return;
        }
        const ct = String(res.headers['content-type'] || '').toLowerCase();
        res.once('data', (chunk) => {
          const head = toBuffer(chunk);
          res.destroy();
          if (ct.startsWith('text/') || ct.includes('json')) {
            done({ ok: false, reason: `不是音频（${ct}）` });
            return;
          }
          done({ ok: true, contentType: ct, bytes: head.length });
        });
        res.once('end', () => done({ ok: false, reason: '响应为空' }));
      },
    );
    req.on('error', (error) => done({ ok: false, reason: String((error && error.message) || error).slice(0, 60) }));
    req.on('timeout', () => {
      try {
        req.destroy(new Error('探测超时'));
      } catch { /* ignore */ }
    });
    req.end();
  });
}

async function probeOne(url) {
  try {
    if (typeof probeAudioUrl === 'function') return await probeAudioUrl(url, PROBE_TIMEOUT);
    return await fallbackProbe(url);
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error).slice(0, 60) };
  }
}

/**
 * 派发「脚本 × 平台」任务，返回带优先级的任务列表。
 * 处理器实时从 state 里读：延迟注册的脚本（先联网拿配置再 on()）也能赶上。
 * `order` 越小优先级越高，即「脚本加载顺序 → 平台顺序 → handler 顺序」。
 */
function dispatchTasks(cache, musicInfo, quality) {
  const tasks = [];
  for (const script of cache.scripts) {
    if (!script.loaded || !script.state) continue;
    const handlers = Array.isArray(script.state.handlers) ? script.state.handlers.slice() : [];
    if (!handlers.length) continue;
    const declared = script.state.sources || [];
    let platforms = PLATFORM_ORDER.filter((platform) => declared.includes(platform));
    if (!platforms.length) platforms = PLATFORM_ORDER.slice();
    for (const platform of platforms) {
      for (const handler of handlers) {
        tasks.push({
          order: tasks.length,
          script: script.name,
          platform,
          promise: invokeHandler(handler, {
            action: 'musicUrl',
            source: platform,
            info: { musicInfo, type: quality },
          }).catch((error) => {
            debugLog(`任务失败 ${script.name}/${platform}`, error && (error.message || error));
            return null;
          }),
        });
      }
    }
  }
  return tasks;
}

/**
 * 流式换链：谁先交回一条能播的 URL 就用谁，不再等全军到齐。
 *
 * 旧实现用 Promise.allSettled 等所有脚本 × 平台，只要有一两个慢的就整轮拖到
 * timeout，脚本源排最高优先级反而几乎不可能被主链的 3 秒宽限窗口选中。
 * 现在每个任务一交回 URL 就立刻探测；第一个探测通过的立即结束。
 *
 * 排序保护：极短的批处理窗口（PRIORITY_GRACE_MS）内到达的候选，
 * 仍按「脚本加载顺序 → 平台顺序」排序后再逐个探测；窗口外的按到达顺序探测。
 * 探测通过本身已经保证「是能放的音频文件」。
 *
 * @returns {Promise<{candidate: object|null, timeoutFallback: boolean}>}
 */
function streamFirstPlayable(tasks, deadline) {
  return new Promise((resolve) => {
    const seen = new Set();
    const arrived = [];
    const pendingProbes = new Set();
    let probeCursor = 0;
    let finished = false;
    let graceTimer = null;
    let firstCandidateAt = 0;

    const done = (candidate, timeoutFallback) => {
      if (finished) return;
      finished = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ candidate, timeoutFallback: !!timeoutFallback });
    };

    // 按「优先级顺序（窗口内）/ 到达顺序（窗口外）」逐个探测，命中即止。
    const drain = () => {
      if (finished) return;
      const sorted = arrived.slice().sort((a, b) => {
        if (a.inGrace !== b.inGrace) return a.inGrace ? -1 : 1; // 窗口内候选优先
        if (a.inGrace) return a.order - b.order;
        return a.arrival - b.arrival;
      });
      while (probeCursor < sorted.length) {
        const item = sorted[probeCursor];
        probeCursor += 1;
        if (item.probed) continue;
        item.probed = true;
        const job = probeOne(item.url)
          .then((probe) => {
            if (finished) return;
            if (probe && probe.ok) {
              debugLog(`探测通过 ${item.script}/${item.platform}`, item.url.slice(0, 100));
              done(item, false);
            } else {
              debugLog(`探测未通过 ${item.script}/${item.platform}`, probe && probe.reason);
            }
          })
          .catch((error) => debugLog('探测异常', error && error.message))
          .finally(() => {
            pendingProbes.delete(job);
            drain(); // 腾出槽位后继续发后面的候选
          });
        pendingProbes.add(job);
        // 一次只往下发有限个，避免几十条 URL 同时探测把带宽打满。
        if (pendingProbes.size >= MAX_PARALLEL_PROBES) break;
      }
    };

    const accept = (task, rawUrl) => {
      if (finished) return;
      const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
      if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
      seen.add(url);
      const now = Date.now();
      if (!firstCandidateAt) firstCandidateAt = now;
      const candidate = {
        url,
        script: task.script,
        platform: task.platform,
        order: task.order,
        arrival: arrived.length,
        inGrace: now - firstCandidateAt <= PRIORITY_GRACE_MS,
        probed: false,
      };
      arrived.push(candidate);
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          drain();
        }, PRIORITY_GRACE_MS);
        if (typeof graceTimer.unref === 'function') graceTimer.unref();
      }
      drain();
    };

    // 超时兜底：还有「拿到 URL 但没探测完」的候选时，直接交出优先级最高的一条，
    // 不整轮白跑；调用方会在返回对象里标注这一点。
    const timeLeft = Math.max(0, deadline - Date.now());
    const timeoutTimer = setTimeout(() => {
      if (finished) return;
      const unprobed = arrived
        .filter((item) => !item.probed)
        .sort((a, b) => (a.inGrace === b.inGrace ? a.order - b.order : a.inGrace ? -1 : 1));
      const best = unprobed[0] || arrived.slice().sort((a, b) => a.order - b.order)[0];
      if (best) {
        debugLog('超时兜底：交出未探测完的最高优先级候选', best.script, best.platform);
        done(best, true);
      } else {
        done(null, false);
      }
    }, timeLeft);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

    // 所有任务挂 catch，绝不泄漏未捕获 rejection。
    for (const task of tasks) {
      task.promise
        .then((value) => {
          if (finished) return;
          const url = extractUrl(value);
          if (url) accept(task, url);
        })
        .catch((error) => debugLog('任务 promise 异常', error && error.message));
    }
    if (!tasks.length) {
      clearTimeout(timeoutTimer);
      done(null, false);
    }
  });
}

/**
 * 走导入的第三方音源拿一条能播的直链。
 * @param {object} song 主进程的歌曲对象（title / artist / neteaseId / id / hash / rid / album / cover）
 * @param {{quality?: string, timeout?: number}} [options]
 * @returns {Promise<{url: string, source: 'script', matchedTitle: string, matchedArtist: string, matched: string, runtime: string, cover: string}>}
 */
async function resolveViaLx(song, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_TIMEOUT;
  const quality = String(opts.quality || DEFAULT_QUALITY);
  const deadline = Date.now() + timeout;

  try {
    const cache = ensureLoaded();
    const musicInfo = buildMusicInfo(song);

    // 先给「延迟注册」的脚本一个初始化窗口：有的脚本要先联网拿远程配置，
    // 在回调里才 on() + send()，同步执行完时一个 handler 都没有。
    // 窗口不超过总预算的 1/3；目录里啥都没有就不等。
    if (cache.scripts.some((script) => script.loaded)) {
      await settleHandlers(cache, Math.min(2500, Math.max(600, Math.floor(timeout / 3))));
    }

    // 过了初始化窗口再实时读一次 handler 列表（延迟注册的这时已经补上了）。
    const tasks = dispatchTasks(cache, musicInfo, quality);
    if (!tasks.length) throw new Error('导入的音源没拿到可播放的链接');

    const { candidate, timeoutFallback } = await streamFirstPlayable(tasks, deadline);
    if (!candidate) throw new Error('导入的音源没拿到可播放的链接');
    const result = {
      url: candidate.url,
      source: 'script',
      matchedTitle: (song && (song.title || song.name)) || '',
      matchedArtist: (song && (song.artist || song.singer)) || '',
      // 标签用「具体脚本名」：导入的每个脚本都算一个音源
      matched: candidate.script || '第三方音源',
      runtime: candidate.script,
      cover: (song && song.cover) || '',
    };
    // 超时兜底交出的候选没走完探测，标一下，方便主链自己再验。
    if (timeoutFallback) result.probePending = true;
    return result;
  } catch (error) {
    if (DEBUG) debugLog('脚本换源失败', error && error.message);
    throw new Error('导入的音源没拿到可播放的链接');
  }
}

// ---------------------------------------------------------------- 对外状态

/**
 * 当前音源目录的加载情况（不会抛异常，内部按需同步加载一次）。
 * `loaded` 表示脚本本身跑通了；`ready` 表示它已经注册了 request 处理器、能真的换链。
 * 有的脚本要先联网拿配置才 on()，这类会出现 loaded=true / ready=false。
 * @returns {{available: boolean, dir: string, scripts: Array<{name: string, loaded: boolean, ready: boolean, sources: string[], error?: string}>}}
 */
function lxSourceInfo() {
  try {
    const cache = ensureLoaded();
    const scripts = cache.scripts.map((script) => {
      const handlers = handlerCount(script);
      const ready = !!script.loaded && handlers > 0;
      const item = {
        name: script.name,
        loaded: !!script.loaded,
        ready,
        sources: Array.isArray(script.sources) ? script.sources.slice() : [],
        handlers,
      };
      if (script.file) item.file = script.file;
      if (script.error) item.error = String(script.error);
      else if (!ready && script.loaded) item.error = '尚未注册处理器（可能还在等联网初始化）';
      return item;
    });
    return {
      available: scripts.some((item) => item.ready),
      dir: cache.dir,
      scripts,
    };
  } catch (error) {
    return {
      available: false,
      dir: resolveDir(),
      scripts: [],
      error: String((error && error.message) || error).slice(0, 200),
    };
  }
}

/** 覆盖脚本目录并清空已加载缓存 */
function setLxSourceDir(dir) {
  EXPLICIT_DIR = dir ? path.resolve(String(dir)) : '';
  CACHE = null;
  debugLog('音源目录改为', resolveDir());
  return resolveDir();
}

module.exports = { resolveViaLx, qualityFromLevel, lxSourceInfo, setLxSourceDir };
