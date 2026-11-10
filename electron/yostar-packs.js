'use strict';

/**
 * 明日方舟 Yostar（EN / JP / KR 三个海外区服）**只读协议层**。
 *
 * 这个模块是「阶段①」：只负责把官方启动器的协议**读**明白 —— 鉴权头、三组只读 API、
 * 远端清单、CRC64、本地元数据（game-launcher-config.json / manifest.json）与更新计划。
 *
 * 三条铁律（改这个文件的人请先读）：
 *
 * 1. **不写盘、不删文件、不装不更**。`installGame` / `updateGame` / `downloadFile`
 *    是阶段②③的事，本文件一个都不实现、也不导出。唯一会落盘的函数是
 *    `writeMetadata`，它只按调用方给的目录写两个 json —— 阶段①的自测只往 %TEMP% 写。
 * 2. **不 require Electron**（不碰 `app` / `ipcMain`）。路径一律由调用方传进来，
 *    这样纯 node 下就能 `node --check` 和跑自测，不需要起主进程。
 * 3. **不引第三方 npm 依赖**。只有 `node:` 内置 + 仓库已有的 `./http-fetch`
 *    （它的 `segmentFetch` 只走 `node:https`，并自带代理选路兜底）。
 *    刻意**不** require `./disk-space`：空间校验是阶段②的事，提前引只会让阶段①
 *    多一个「不打包就崩」的入口。
 *
 * 协议事实全部来自上游 Hi3Helper.Hypergryph.Yostar 的 C# 源码（见各处注释里的文件名
 * 与行号）与本机实网抓取。凡是我方与官方行为**有意不同**的地方，注释里都写了原因。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { segmentFetch } = require('./http-fetch');

// ── 常量 ─────────────────────────────────────────────────────────────────────

/**
 * 官方启动器的版本号。**它参与鉴权签名**（sign = MD5(head + salt)，head 里带
 * `"version":"1.8.1"`），所以这不是「随手写的字符串」——改错一个字符，三个区服
 * 立刻全部 100400。
 *
 * 出处：`Hi3Helper.Hypergryph.Yostar__YostarLauncherOptions.cs` 里
 * `LauncherVersion = "1.8.1"` 的默认值（不是服务端下发，是硬编码默认值）。
 */
const LAUNCHER_VERSION = '1.8.1';

/**
 * 鉴权盐。同样来自 `YostarLauncherOptions.cs` 的默认值，同样**参与签名**。
 *
 * 这是本模块最脆的一处：上游换盐 = 我们三区全挂（服务端会回 100400 Sign有误）。
 * 所以盐只允许出现在这一处常量里，并且允许 `profile.authorizationSalt` 临时覆盖
 * （仅给自测/排查用，**不给 UI 暴露**）。
 */
const AUTHORIZATION_SALT = 'DE7108E9B2842FD460F4777702727869';

/**
 * CRC64 多项式（CRC-64/XZ，也叫 ECMA-182 的反射写法）。
 * 出处：`Hi3Helper.Hypergryph.Yostar__Utility__YostarCrc64.cs` 的
 * `Polynomial = 0xC96C5795D7870F42UL`。
 *
 * 用 BigInt 只是为了**建表时**不手抄高低 32 位（手抄必错）；热路径上完全不用 BigInt，
 * 见 crc64Buffer 的注释。
 */
const CRC64_POLYNOMIAL = 0xC96C5795D7870F42n;

/** 接口超时。对齐官方 `_apiHttpClient.Timeout = TimeSpan.FromSeconds(30)`。 */
const API_TIMEOUT_MS = 30 * 1000;

/**
 * 清单下载超时。官方下载用 10 分钟（`_downloadHttpClient.Timeout = TimeSpan.FromMinutes(10)`）。
 * 清单本身只有几 MB，但海外 CDN 在部分网络下确实会慢到分钟级。
 */
const MANIFEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 下载时的**文件级**并发。对齐官方 `MaxDegreeOfParallelism`。
 * 阶段①用不到，但这个数字是「照抄官方」的结论，放在协议层比散落在调用方更好找。
 */
const DOWNLOAD_CONCURRENCY = 4;

/** 单次更新的删除条数上限，超过就要二次确认（阶段③的闸门，阶段①只定常量）。 */
const DELETE_GUARD_MAX = 200;

/**
 * 三个海外区服。`tag` 同时是鉴权里的 `game_tag` 和本地元数据里的 `name`/`tag`。
 *
 * `apiBase` 与 `directory` 都取自官方 preset（`ArknightsGlobalPresetConfig.cs` 等）。
 * `defaultExe` 用于「接口没给 exe 名」时兜底，见 executionNameOf。
 */
const YOSTAR_PROFILES = {
  'global-en': {
    channel: 'global-en',
    tag: 'Arknights_EN',
    apiBase: 'https://api-launcher-en.yo-star.com',
    directory: 'Arknights_EN',
    defaultExe: 'Arknights.exe',
  },
  'global-jp': {
    channel: 'global-jp',
    tag: 'Arknights_JP',
    apiBase: 'https://api-launcher-jp.yo-star.com',
    directory: 'Arknights_JP',
    defaultExe: 'Arknights.exe',
  },
  'global-kr': {
    channel: 'global-kr',
    tag: 'Arknights_KR',
    apiBase: 'https://api-launcher-kr.yo-star.com',
    directory: 'Arknights_KR',
    defaultExe: 'Arknights.exe',
  },
};

/** 本地元数据文件名。**必须与官方逐字一致**，否则官方启动器看不到我们的目录。 */
const CONFIG_FILE_NAME = 'game-launcher-config.json';
const MANIFEST_FILE_NAME = 'manifest.json';

/**
 * 请求的 UA。服务端**不校验**它（实测换成任意字符串都能通），签名也只覆盖 head，
 * 所以这里老实写我们自己的标识即可，不必伪装成官方启动器。
 */
const USER_AGENT = 'HXL-Yostar/1.8.1';

// ── 渠道 ─────────────────────────────────────────────────────────────────────

/** 只认这三个 channel。`'global'` 是国服的，**不要**让进来。 */
function isYostarChannel(channel) {
  return Object.prototype.hasOwnProperty.call(YOSTAR_PROFILES, String(channel || ''));
}

/** channel → profile。认不出来返回 null（调用方自己决定报什么错）。 */
function profileFor(channel) {
  const key = String(channel || '');
  return Object.prototype.hasOwnProperty.call(YOSTAR_PROFILES, key) ? YOSTAR_PROFILES[key] : null;
}

// ── 通用小工具 ───────────────────────────────────────────────────────────────

/**
 * C# `string.Join(';', values)` + MD5 + Base64。
 *
 * 这是本地元数据里所有 `vc` 的算法（**base64**），和鉴权头的 sign（**hex**）不是一回事，
 * 别混。出处：`YostarLocalStorage.cs` 的 `HashJoinedValues`。
 */
function hashJoinedValues(values) {
  const text = (values || []).map((value) => String(value == null ? '' : value)).join(';');
  return crypto.createHash('md5').update(text, 'utf8').digest('base64');
}

/**
 * 清单里的相对路径统一成 `/` 分隔、去掉开头的 `/`。
 * 出处：`YostarGameInstaller.cs` 的 `NormalizeManifestPath`（`Replace('\\','/').TrimStart('/')`）。
 */
function normalizeManifestPath(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * 相对路径 → 绝对路径，并**挡住路径穿越**。
 *
 * 为什么必须挡：清单是远端给的，一个 `../../Windows/System32/xxx` 就能让阶段②的
 * 下载/阶段③的删除跑出安装目录。官方同样在 `GetTargetFilePath` 里做这件事，
 * 报错文案我照抄了（`Manifest path escapes the game directory: …`），
 * 将来对日志时能一眼对上。
 *
 * 比较用大小写不敏感：这是 Windows 的语义（.NET 那边是 `StringComparison.OrdinalIgnoreCase`）。
 * 本项目只发 Windows 包，所以不做跨平台分支。
 */
function resolveInside(root, relativePath) {
  const rel = normalizeManifestPath(relativePath);
  if (!rel) throw new Error('Manifest path is empty.');
  const base = path.resolve(String(root));
  const rootWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  const target = path.resolve(rootWithSep, rel.replace(/\//g, path.sep));
  // 末尾补分隔符，这样 `…\Arknights_EN2` 不会被误判成在 `…\Arknights_EN` 里面
  const normalizedTarget = target.endsWith(path.sep) ? target : target + path.sep;
  if (!normalizedTarget.toLowerCase().startsWith(rootWithSep.toLowerCase())) {
    throw new Error(`Manifest path escapes the game directory: ${relativePath}`);
  }
  return target;
}

/**
 * 拼下载直链。出处：`YostarGameInstaller.BuildDownloadUri:325-336`。
 *
 * 两个坑：
 * - `source`（清单里的顶层 source）与 `file.path` 各自 trim 掉首尾 `/` 后再用 `/` 拼，
 *   中间的重复分隔符要去干净；
 * - **只有最后一段**做 `encodeURIComponent(decodeURIComponent(seg))`。先 decode 再
 *   encode 是为了避免「已经编码过的文件名」被二次编码（%20 → %2520）。
 */
function buildDownloadUri(domain, source, filePath) {
  const base = String(domain == null ? '' : domain).trim();
  if (!base) throw new Error('Yostar 没有给出可用的 CDN 域名');
  const parts = [source, filePath]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().replace(/^\/+|\/+$/g, ''));
  const segments = parts.join('/').split('/').filter(Boolean);
  if (!segments.length) throw new Error('Yostar 清单给了空的下载路径');
  const last = segments[segments.length - 1];
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // 文件名里本来就有裸 `%`：decode 会抛。这时按原样 encode，至少链接还是合法的。
    decoded = last;
  }
  segments[segments.length - 1] = encodeURIComponent(decoded);
  return base.replace(/\/+$/, '') + '/' + segments.join('/');
}

// ── CRC64 ────────────────────────────────────────────────────────────────────

/**
 * 建表 + 拆成高/低两张 32 位表。
 *
 * 为什么拆半字：BigInt 逐字节实测只有 14.5 MiB/s（3.7GB 要 245 秒），而把 64 位
 * 状态拆成两个 uint32 用普通 number 运算能到 427 MiB/s（3.7GB 约 8.3 秒）。
 * 差 30 倍，这个优化不是洁癖。
 *
 * 表本身仍用 BigInt 从多项式生成（一次性的 256×8 次循环），再把结果切半 ——
 * 这样我不用手抄任何 32 位常量，也就不存在抄错的可能。
 */
const CRC64_HALF = (() => {
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let value = BigInt(i);
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1n) !== 0n ? (value >> 1n) ^ CRC64_POLYNOMIAL : value >> 1n;
    }
    table[i] = value;
  }
  const low = new Uint32Array(256);
  const high = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    low[i] = Number(table[i] & 0xffffffffn);
    high[i] = Number((table[i] >> 32n) & 0xffffffffn);
  }
  return { low, high };
})();

/**
 * 一个可增量喂数据的 CRC64 状态机（crc64File 要跨 4MB 分块接着算）。
 *
 * 初值全 1、末尾全取反 —— 与 `YostarCrc64.cs` 完全一致（这也是标准 CRC-64/XZ，
 * 所以「123456789」的校验值必须等于 0x995DC9BBDF1939FA）。
 */
function createCrc64State() {
  const { low: LOW, high: HIGH } = CRC64_HALF;
  let lo = 0xffffffff;
  let hi = 0xffffffff;
  return {
    update(buffer) {
      for (let i = 0; i < buffer.length; i++) {
        const index = (lo ^ buffer[i]) & 0xff; // (byte)(crc ^ value) 只看 crc 的低 8 位
        const nextHi = (hi >>> 8) ^ HIGH[index];
        // crc >> 8 的 32 位低位 = lo 右移 8 位 + hi 的低 8 位顶到最高位
        const nextLo = ((lo >>> 8) | (hi << 24)) ^ LOW[index];
        lo = nextLo >>> 0;
        hi = nextHi >>> 0;
      }
      return this;
    },
    digest() {
      // 取反后再转十进制。BigInt 只在这一刻出现一次，摊到 3.7GB 上等于免费。
      const value = ((BigInt((hi ^ 0xffffffff) >>> 0) << 32n) | BigInt((lo ^ 0xffffffff) >>> 0));
      return value.toString(10);
    },
  };
}

/**
 * 一段内存 buffer 的 CRC64，返回**十进制字符串**。
 *
 * 为什么是字符串：官方清单里 `hash` 就是十进制 CRC64 的字符串，而且 64 位无符号
 * 数超出 JS 安全整数范围 —— 转成 number 会悄悄丢精度，比对就变成随机通过。
 */
function crc64Buffer(buffer) {
  const state = createCrc64State();
  state.update(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  return state.digest();
}

/**
 * 文件的 CRC64。4MB 分块顺序读（不是整文件读进内存 —— 游戏里有单个 1GB+ 的包）。
 *
 * `onChunk(done, total)` 给调用方做进度；`signal` 支持取消（`throwIfAborted` 会抛
 * AbortError，调用方按取消处理即可）。
 */
async function crc64File(filePath, { signal, onChunk } = {}) {
  if (signal) signal.throwIfAborted();
  const handle = await fsp.open(filePath, 'r');
  try {
    const total = (await handle.stat()).size;
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
    const state = createCrc64State();
    let done = 0;
    while (done < total) {
      if (signal) signal.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, total - done), done);
      if (!bytesRead) break; // 文件被外部截断：按已读到的部分算，交给上层做 size 校验
      state.update(chunk.subarray(0, bytesRead));
      done += bytesRead;
      if (typeof onChunk === 'function') onChunk(done, total);
    }
    return state.digest();
  } finally {
    await handle.close();
  }
}

// ── 鉴权 ─────────────────────────────────────────────────────────────────────

/**
 * 生成 Authorization 头的**完整字符串**：`{"head":{...},"sign":"<md5 hex 小写>"}`。
 *
 * 出处：`YostarApiClient.CreateAuthorizationHeader:119-126`。三个细节都是语义：
 * - head 是**手拼的 JSON 文本**（不是对象序列化），键序必须是 game_tag / time / version，
 *   且**不能有空格** —— 签名签的就是这段原文，多一个空格 sign 就对不上；
 * - `time` 是**秒**（不是毫秒）；
 * - sign = MD5(head 原文 + salt)，hex 小写。
 *
 * 实测服务端真校验：不带这个头 → 100400 `参数有误:Authorization不能为空`；
 * 改一个字符 → 100400 `参数有误:Sign有误`。
 */
function createAuthorizationHeader(profile, { now = Date.now() } = {}) {
  const tag = String((profile && profile.tag) || '');
  if (!tag) throw new Error('Yostar profile 缺少 tag，无法生成鉴权头');
  const version = String((profile && profile.launcherVersion) || LAUNCHER_VERSION);
  const salt = String((profile && profile.authorizationSalt) || AUTHORIZATION_SALT);
  const time = Math.floor(now / 1000);
  const head = `{"game_tag":"${tag}","time":${time},"version":"${version}"}`;
  const sign = crypto.createHash('md5').update(head + salt, 'utf8').digest('hex');
  return `{"head":${head},"sign":"${sign}"}`;
}

// ── 只读 API ─────────────────────────────────────────────────────────────────

/**
 * GET 一个 `api/launcher/*` 接口，返回 `body.data`。
 *
 * 为什么不能只看 `res.ok`：Yostar 的业务错误**恒为 HTTP 200**，错误码在 body.code 里
 * （实测 100400 = 参数/签名错，100606 = 游戏标识不合法）。只判 HTTP 状态会把
 * 「三区全挂」显示成「版本获取成功，但版本号是 undefined」。
 *
 * `code === 100400` 单独出一句人话：那是「盐或启动器版本过期」的典型信号，
 * 用户看到 `参数有误:Sign有误` 只会以为是我们崩了。
 */
async function apiGet(profile, operation, query = {}, { timeoutMs = API_TIMEOUT_MS } = {}) {
  if (!profile || !profile.apiBase) throw new Error('Yostar profile 缺少 apiBase');
  const op = String(operation || '').replace(/^\/+/, '');
  if (!op) throw new Error('Yostar 接口操作名为空');
  let url = String(profile.apiBase).replace(/\/+$/, '') + '/' + op;
  const pairs = Object.entries(query || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  if (pairs.length) url += (url.includes('?') ? '&' : '?') + pairs.join('&');

  const signal = AbortSignal.timeout(timeoutMs);
  const response = await segmentFetch(url, {
    method: 'GET', // 协议层只有 GET：Yostar 的 launcher 接口没有任何写操作
    headers: {
      Authorization: createAuthorizationHeader(profile),
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    signal,
  });

  const raw = Buffer.from(await response.arrayBuffer()).toString('utf8');
  if (!response.ok) {
    const error = new Error(
      `Yostar ${op} 请求失败：HTTP ${response.status} ${response.statusText || ''}`.trim()
    );
    error.code = 'YOSTAR_HTTP_ERROR';
    error.operation = op;
    error.status = response.status;
    error.bodyPreview = raw.slice(0, 300);
    throw error;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    // 走到这里多半是被劫持/被门户页拦了（返回了一坨 HTML）。带上前 200 字方便排查。
    const error = new Error(`Yostar ${op} 返回的不是 JSON：${raw.slice(0, 200)}`);
    error.code = 'YOSTAR_BAD_JSON';
    error.operation = op;
    throw error;
  }

  const code = Number(body && body.code);
  const message = String((body && (body.msg || body.message)) || '');
  if (code === 100400) {
    const error = new Error(
      'Yostar 接口拒绝了这个请求（签名/版本可能过期），请更新启动器'
    );
    error.code = 'YOSTAR_AUTH_REJECTED';
    error.operation = op;
    error.apiCode = code;
    error.apiMessage = message;
    throw error;
  }
  if (code !== 200) {
    const error = new Error(`Yostar ${op} 返回错误码 ${code}${message ? '：' + message : ''}`);
    error.code = 'YOSTAR_API_ERROR';
    error.operation = op;
    error.apiCode = Number.isFinite(code) ? code : null;
    error.apiMessage = message;
    throw error;
  }
  if (body.data === null || body.data === undefined) {
    const error = new Error(`Yostar ${op} 返回了空的 data`);
    error.code = 'YOSTAR_EMPTY_DATA';
    error.operation = op;
    throw error;
  }
  return body.data;
}

/** 字符串字段容错读取：非字符串一律当空串（照 C# `GetString` 的语义）。 */
function stringOf(value) {
  return typeof value === 'string' ? value : '';
}

/** 清单里的 size 是**字符串**；解析不出来按 0（照 `YostarManifestFile.SizeValue`）。 */
function sizeOf(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * `api/launcher/game/config` → 版本信息。
 *
 * ⚠️ `decompression_size` **不可信**：EN 实测报 22GB，而清单总和只有 3.73GB。
 * 我这里照样返回（诊断用），但**任何空间预估都必须用清单的 totalBytes**。
 */
async function loadRemoteGameConfig(profile) {
  const data = await apiGet(profile, 'api/launcher/game/config');
  const params = Array.isArray(data.game_start_params)
    ? data.game_start_params.filter((item) => typeof item === 'string')
    : [];
  return {
    version: stringOf(data.game_latest_version),
    lowestVersion: stringOf(data.game_lowest_version),
    // basis 就是「清单放在哪个目录下」的那一段（本地 manifest.json 里也叫 basis）
    basis: stringOf(data.game_latest_file_path),
    exeName: stringOf(data.game_start_exe_name),
    params,
    decompressionSize: sizeOf(data.decompression_size),
    raw: data,
  };
}

/** `api/launcher/advanced/game/download/cdn` → 主 / 备 CDN 域名。 */
async function loadRemoteCdn(profile) {
  const data = await apiGet(profile, 'api/launcher/advanced/game/download/cdn');
  return {
    primaryCdn: stringOf(data.primary_cdn),
    backUpCdn: stringOf(data.back_up_cdn),
  };
}

/**
 * 清单直链（已带 nocache）。
 *
 * 坑：签名直链**不能直接 GET**。官方是把整个 query **覆盖**成 `nocache=<毫秒>`
 * （`YostarApiClient.GetManifestAsync` 里 `UriBuilder.Query = "nocache=" + ...`），
 * 实测直接请求原 url 会拿到 HTTP 404 + HTML。所以这里必须 `search = ...`，
 * 而不是 `+= '&nocache='`。
 */
async function loadRemoteManifestUrl(profile, version, basis) {
  const data = await apiGet(profile, 'api/launcher/game/config/json', {
    version: version,
    file_path: basis,
  });
  const signed = stringOf(data.url);
  if (!signed) throw new Error('Yostar 没有返回清单直链');
  let parsed;
  try {
    parsed = new URL(signed);
  } catch {
    throw new Error(`Yostar 返回了非法的清单直链：${signed.slice(0, 200)}`);
  }
  parsed.search = 'nocache=' + Date.now(); // 覆盖，不是追加
  return parsed.href;
}

/**
 * 远端清单：`{ source, files: [{ path, hash, size }], totalBytes }`。
 *
 * 注意两处键名差异（混了就会「清单解析成功但 0 个文件」）：
 * - **远端** JSON 顶层是 `file`（单数），不是 `files`；
 * - 我方写出的**本地** manifest.json 顶层才是 `files`。
 *
 * `size` 在远端是字符串，这里统一成 Number 交出去（hash 保持字符串，见 crc64Buffer 的注释）。
 */
async function loadRemoteManifest(profile, { version, basis } = {}) {
  let targetVersion = version;
  let targetBasis = basis;
  if (!targetVersion || !targetBasis) {
    const config = await loadRemoteGameConfig(profile);
    targetVersion = targetVersion || config.version;
    targetBasis = targetBasis || config.basis;
  }
  if (!targetVersion || !targetBasis) {
    throw new Error('Yostar 的 game config 里没有目标版本号或清单路径');
  }

  const url = await loadRemoteManifestUrl(profile, targetVersion, targetBasis);
  const response = await segmentFetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Yostar 清单下载失败：HTTP ${response.status} ${url}`);
  }
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Yostar 清单不是 JSON（可能被拦成门户页）：${text.slice(0, 200)}`);
  }

  const list = Array.isArray(body.file) ? body.file : Array.isArray(body.files) ? body.files : [];
  const files = [];
  let totalBytes = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const filePath = stringOf(item.path);
    if (!filePath) continue;
    const size = sizeOf(item.size);
    totalBytes += size;
    files.push({ path: filePath, hash: String(item.hash == null ? '' : item.hash), size });
  }
  return { source: stringOf(body.source), files, totalBytes, version: targetVersion, basis: targetBasis };
}

/**
 * 一次拿齐「配置 + CDN + 清单」——阶段②的安装预览就是先调这个。
 *
 * 清单与 CDN 并发拉（官方也是 `Task.WhenAll`），因为清单是瓶颈（几 MB），
 * CDN 那个接口 200ms 就回来了，串行纯属浪费。
 */
async function loadRemoteTargetPackage(profile) {
  const config = await loadRemoteGameConfig(profile);
  if (!config.version || !config.basis) {
    throw new Error('Yostar game config 缺少目标版本号或清单路径，无法确定要装什么');
  }
  const [manifest, cdn] = await Promise.all([
    loadRemoteManifest(profile, { version: config.version, basis: config.basis }),
    loadRemoteCdn(profile),
  ]);
  return { config, cdn, manifest, totalBytes: manifest.totalBytes, version: config.version };
}

// ── 本地元数据 ───────────────────────────────────────────────────────────────

/**
 * 启动用的 exe 名。**这里是 R2 风险的唯一实现点**。
 *
 * 实测：EN 的 `game_start_exe_name` 是 `"Arknights"`（没有 `.exe`），JP/KR 是
 * `"Arknights.exe"`。官方 `NormalizeExecutableName:128-132` 一律补扩展名，
 * 且写进 json 的 `name` 与参与 `vc` 的都是**补过扩展名**的那个值。
 *
 * 所以：绝不能把接口原文直接写进元数据 —— 否则官方启动器按自己的算法重算 vc
 * 会对不上（它认为这是别人的目录），进而重写元数据甚至重下全量。
 */
function executionNameOf(gameConfig, profile) {
  const raw = stringOf(gameConfig && gameConfig.exeName).trim();
  const fallback = (profile && profile.defaultExe) || 'Arknights.exe';
  const value = raw || fallback;
  return hasExtension(value) ? value : value + '.exe';
}

/**
 * .NET `Path.HasExtension` 的等价物：最后一个分隔符之后必须有点，且点不能是首字符。
 * 「dir.d/file」不算有扩展名，「dir/.hidden」也不算 —— 与 .NET 一致。
 */
function hasExtension(value) {
  const text = String(value == null ? '' : value);
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  const leaf = cut >= 0 ? text.slice(cut + 1) : text;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 && dot < leaf.length - 1;
}

/**
 * `game-launcher-config.json` 的 vc。
 * 值顺序（**顺序是语义，不是随便排的**）：tag, name(exe), params.join(','), version, gameUninstallScript。
 * 出处：`YostarLocalStorage.WriteConfigAsync:175-176`。
 *
 * `params` 为空数组时 join 出来是空串（C# `string.Join(',', [])` 也是空串），
 * 这一点最容易写错成 undefined/null，一错就整份元数据作废。
 */
function computeConfigHash({ tag, name, params, version, gameUninstallScript } = {}) {
  const list = Array.isArray(params) ? params.map((item) => String(item)) : [];
  return hashJoinedValues([tag, name, list.join(','), version, gameUninstallScript]);
}

/** `manifest.json` 顶层 vc：name, version, basis（顺序同样有意义）。 */
function computeManifestHash({ name, version, basis } = {}) {
  return hashJoinedValues([name, version, basis]);
}

/** 清单单项 vc：path, hash, size。size 写进 json 时是**字符串**，这里一致处理。 */
function computeFileHash({ path: filePath, hash, size } = {}) {
  return hashJoinedValues([filePath, hash, String(size == null ? '' : size)]);
}

/**
 * 复刻 `YostarLocalStorage.ValidateObjectHash:181-195`：
 * 遍历对象**全部属性（JSON 出现顺序，跳过 `vc` 自己）**，各自转成「JS 字符串」后
 * 用 `;` 连起来算 MD5+Base64，与 vc 逐字比较。
 *
 * 为什么必须复刻而不是只校验几个字段：官方写 vc 时把**整份对象**都算进去了。
 * 我们少算一个字段，自己读自己的文件可能通，官方读我们的文件就永远通不过。
 *
 * 局限：JSON.parse 会丢掉数字的原始字面量（`1.0` 变 `1`）。这些文件里唯一的数字
 * 场景是 size，而 size 我们按字符串写 —— 与官方一致，所以不受影响。
 */
function validateObjectHash(value, hashProperty = 'vc') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, hashProperty)) return false;
  const expected = value[hashProperty];
  if (typeof expected !== 'string') return false;
  const values = [];
  for (const key of Object.keys(value)) {
    if (key === hashProperty) continue;
    values.push(toJavaScriptString(value[key]));
  }
  return expected === hashJoinedValues(values);
}

/** 复刻 `YostarLocalStorage.ToJavaScriptString:197-209`（含 array 递归 `,` 连接与 object 的坑）。 */
function toJavaScriptString(value) {
  if (Array.isArray(value)) return value.map(toJavaScriptString).join(',');
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '[object Object]';
}

/**
 * 读 `game-launcher-config.json`。vc 不过 / 关键字段空 / JSON 坏 → 一律 null。
 *
 * 为什么「静默返回 null」而不是抛错：这是「判断目录是不是我方装好的」用的探针，
 * 官方启动器留的目录、用户手改坏的文件都应该走「当作没装」这条路，而不是让
 * 整个界面弹一个红框。
 */
async function readGameConfig(installRoot) {
  const filePath = path.join(String(installRoot), CONFIG_FILE_NAME);
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!validateObjectHash(body, 'vc')) return null;
  const tag = stringOf(body.tag);
  const version = stringOf(body.version);
  if (!tag.trim() || !version.trim()) return null;
  const params = Array.isArray(body.params)
    ? body.params.filter((item) => typeof item === 'string')
    : [];
  return {
    tag,
    name: stringOf(body.name),
    params,
    version,
    gameUninstallScript: stringOf(body.gameUninstallScript),
    raw: body,
  };
}

/**
 * 读 `manifest.json`。
 *
 * 两级校验，且**失败方式不同**（这是官方行为，不是我方疏漏）：
 * - 顶层 vc 不过 → 整份作废，返回 null；
 * - 单个 file 的 vc 不过 → **静默跳过这一项**（`if (!ValidateObjectHash(...)) continue;`），
 *   其余照常返回。所以「readManifest 有 3121 项」可能意味着有 1 项被丢了 ——
 *   这个静默行为在阶段③会造成「该删的没删」而不是「删错」，属于可接受方向。
 */
async function readManifest(installRoot) {
  const filePath = path.join(String(installRoot), MANIFEST_FILE_NAME);
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const name = stringOf(body.name);
  const version = stringOf(body.version);
  const basis = stringOf(body.basis);
  const expected = stringOf(body.vc);
  if (!expected || expected !== computeManifestHash({ name, version, basis })) return null;

  const list = Array.isArray(body.files) ? body.files : [];
  const files = [];
  for (const item of list) {
    if (!validateObjectHash(item, 'vc')) continue;
    const filePathValue = stringOf(item.path);
    if (!filePathValue.trim()) continue;
    files.push({ path: filePathValue, hash: stringOf(item.hash), size: sizeOf(item.size) });
  }
  return { name, version, basis, files, raw: body };
}

/**
 * 写两个元数据文件，**事务式**：两个 `.tmp` 都写成功才 rename，且**先 manifest 后 config**。
 *
 * 为什么顺序和事务这么讲究：官方 `WriteMetadataAsync:108-126` 就是这么做的。
 * 这两个文件是「这个目录已经装好了」的唯一凭证；如果先改名 config 再失败，
 * 官方启动器会看到一个「版本很新但清单缺失」的目录，行为不可预测。
 * 先写清单，最坏情况也只是「清单新、配置旧」——两个 vc 各自自洽，都能被重写修好。
 *
 * 键序必须照 §1.3：JSON 键序参与 vc 计算（ValidateObjectHash 按出现顺序取值），
 * 所以这里用对象字面量的插入顺序来固定顺序，**不要**改成先建空对象再乱赋值。
 */
async function writeMetadata(installRoot, { config, manifest } = {}) {
  const root = String(installRoot);
  if (!config || !manifest) throw new Error('writeMetadata 需要同时提供 config 与 manifest');
  await fsp.mkdir(root, { recursive: true });

  const manifestBody = {
    name: stringOf(manifest.name),
    version: stringOf(manifest.version),
    basis: stringOf(manifest.basis),
    vc: computeManifestHash({
      name: stringOf(manifest.name),
      version: stringOf(manifest.version),
      basis: stringOf(manifest.basis),
    }),
    files: (Array.isArray(manifest.files) ? manifest.files : []).map((file) => ({
      path: stringOf(file.path),
      hash: stringOf(file.hash),
      // size 按官方写成**字符串**（远端清单里本来就是字符串，照抄不走样）
      size: String(file.size == null ? '' : file.size),
      vc: computeFileHash({ path: file.path, hash: file.hash, size: file.size }),
    })),
  };

  const params = Array.isArray(config.params) ? config.params.map((item) => String(item)) : [];
  const configBody = {
    tag: stringOf(config.tag),
    name: stringOf(config.name),
    params,
    version: stringOf(config.version),
    gameUninstallScript: stringOf(config.gameUninstallScript),
    vc: computeConfigHash({
      tag: config.tag,
      name: config.name,
      params,
      version: config.version,
      gameUninstallScript: config.gameUninstallScript,
    }),
  };

  const manifestTarget = path.join(root, MANIFEST_FILE_NAME);
  const configTarget = path.join(root, CONFIG_FILE_NAME);
  const manifestTemp = manifestTarget + '.tmp';
  const configTemp = configTarget + '.tmp';

  await fsp.writeFile(manifestTemp, JSON.stringify(manifestBody, null, 2), 'utf8');
  await fsp.writeFile(configTemp, JSON.stringify(configBody, null, 2), 'utf8');
  // 两个 tmp 都落盘后再改名：rename 是同目录的原子替换，中途断电不会留下半个文件
  await fsp.rename(manifestTemp, manifestTarget);
  await fsp.rename(configTemp, configTarget);
}

// ── 更新计划（纯函数，绝不写盘） ─────────────────────────────────────────────

/**
 * 比对本地/远端清单，算出要下载什么、要删什么。
 *
 * **本函数不下载、不删除、不写盘**——它只把「官方 `CreatePlanAsync:179-220` 会怎么做」
 * 翻译成一份数据，让阶段②③在执行前能先给用户看数字（N 个要下、M 个要删）。
 *
 * 逐条规则（照抄官方，顺序不能变）：
 * 1. 目标文件不存在，或**大小不等** → download；
 * 2. 否则若 `fullVerify` → 需要现算 CRC64 才能定夺；
 * 3. 否则本地清单里没有这一项 → 同样需要现算 CRC64；
 * 4. 否则本地与远端的 hash 不同 → download；相同 → reuse。
 *
 * 第 2/3 条我**不在这里算 CRC64**：这是个同步纯函数，而全量校验动辄 8 秒、还会读盘。
 * 我把它们记进 `needsVerify` 交回调用方（阶段③的 `updateGame` 在那里逐个算）。
 * 这一点与官方「在 CreatePlan 里直接 await 算完」不同，是**为了保持纯函数可测**，
 * 语义完全等价（最终都会算），注释写在这里防止后人误以为漏了。
 *
 * `delete` 只从**本地清单**取（`localFiles.keys - remoteFiles.keys`），绝不扫盘 ——
 * 扫盘会把用户自己塞的 mod、启动器的日志全算成「多余文件」，那是灾难。
 *
 * @param {object} options
 * @param {string} options.installRoot 安装根目录（用于算 absPath 与默认的磁盘探测）
 * @param {{files:Array, source?:string}} options.remoteManifest 远端清单（loadRemoteManifest 的返回）
 * @param {{files:Array}|null} options.localManifest 本地清单（readManifest 的返回），没有就传 null
 * @param {boolean} [options.fullVerify] 是否要求逐个现算 CRC64（宁可慢，不要信任清单）
 * @param {Function} [options.localExists] 注入的磁盘探测：(relPath) => {exists, size} | boolean
 * @param {string|{primaryCdn?:string,backUpCdn?:string}} [options.cdn] 可选。给了才会填 download[].url
 */
function planUpdate({
  installRoot,
  remoteManifest,
  localManifest,
  fullVerify = false,
  localExists,
  cdn,
} = {}) {
  const remoteFiles = Array.isArray(remoteManifest && remoteManifest.files)
    ? remoteManifest.files
    : [];
  if (!remoteFiles.length) throw new Error('planUpdate 需要一份非空的远端清单');

  // 主 CDN 缺失时退到备用：官方按 RetryUsePrimary 顺序试，我们只在拼 url 时用一次
  const domain =
    typeof cdn === 'string'
      ? cdn
      : cdn && (cdn.primaryCdn || cdn.backUpCdn || '')
        ? cdn.primaryCdn || cdn.backUpCdn || ''
        : '';

  // 大小写不敏感：Windows 上 `Data/x` 与 `data/X` 是同一个文件（官方用 OrdinalIgnoreCase）
  const localFiles = new Map();
  for (const file of (localManifest && localManifest.files) || []) {
    const key = normalizeManifestPath(file && file.path).toLowerCase();
    if (key && !localFiles.has(key)) localFiles.set(key, file); // 重复项取第一条，见下
  }
  const remoteKeys = new Set();

  const download = [];
  const reuse = [];
  let needsVerify = 0;

  const probe =
    typeof localExists === 'function'
      ? (rel) => {
          const result = localExists(rel);
          if (result && typeof result === 'object') {
            return {
              exists: Boolean(result.exists),
              size: result.size == null ? null : Number(result.size),
            };
          }
          // 只回 true/false 的场景（自测常用）：存在性有效，大小未知 → 跳过大小比较
          return { exists: Boolean(result), size: null };
        }
      : (rel) => {
          try {
            const stat = fs.statSync(resolveInside(installRoot, rel));
            return { exists: stat.isFile(), size: stat.size };
          } catch {
            return { exists: false, size: null };
          }
        };

  for (const remote of remoteFiles) {
    const rel = normalizeManifestPath(remote && remote.path);
    if (!rel) continue;
    const key = rel.toLowerCase();
    if (remoteKeys.has(key)) continue; // 官方 ToDictionary 遇重复会抛；我们跳过重复项，别让一份脏清单废掉整次更新
    remoteKeys.add(key);

    const size = sizeOf(remote.size);
    const hash = String(remote.hash == null ? '' : remote.hash);
    const absPath = resolveInside(installRoot, rel); // 路径穿越在这里就炸，别等到下载时

    const state = probe(rel);
    if (!state.exists || (state.size !== null && Number(state.size) !== size)) {
      download.push({ path: rel, hash, size, url: domain ? buildDownloadUri(domain, remoteManifest.source, rel) : null });
      continue;
    }

    const localFile = localFiles.get(key);
    if (fullVerify || !localFile) {
      needsVerify += 1; // 见函数注释第 2/3 条：CRC64 交给调用方算
      continue;
    }
    if (String(localFile.hash) !== hash) {
      download.push({ path: rel, hash, size, url: domain ? buildDownloadUri(domain, remoteManifest.source, rel) : null });
      continue;
    }
    reuse.push({ path: rel, hash, size, absPath });
  }

  // 「本地有、远端无」→ 删。唯一来源是本地清单；绝不用扫盘结果反推。
  const del = [];
  for (const [key, file] of localFiles) {
    if (remoteKeys.has(key)) continue;
    const rel = normalizeManifestPath(file && file.path);
    if (!rel) continue;
    del.push({ path: rel, absPath: resolveInside(installRoot, rel) });
  }

  return {
    download,
    delete: del,
    reuse,
    // 「已在本地且一致」的条数：进度条/日志要一个数，不想让调用方每次自己数 reuse.length
    unchanged: reuse.length,
    // 需要现算 CRC64 才能定夺的条数（fullVerify，或本地清单里没有记录）
    needsVerify,
    downloadBytes: download.reduce((sum, file) => sum + file.size, 0),
  };
}

// ── 下载 / 安装 / 更新（阶段②③） ─────────────────────────────────────────────

/**
 * 单文件下载：写 `.yostar-tmp` → 校验 size + CRC64 → **先删旧 dest 再 rename**。
 *
 * 几个决定，改之前先把理由读完：
 *
 * 1. **先删后 rename**：Windows 上 `rename` 到已存在的文件会失败；官方
 *    `YostarGameInstaller.cs:254-255` 也是先 `Delete` 再 `Move`。更重要的是——
 *    这也是「断硬链接」的正确写法：万一这个目录将来被当成某个硬链接镜像的源，
 *    原地覆盖会污染共享 inode，先删再改名只换掉本目录自己的目录项。
 * 2. **CRC64 不是 sha256/md5**：Yostar 清单里的 `hash` 是 CRC64 的**十进制字符串**。
 *    校验口径写错的话会「每次判定不一致 → 每次更新全量重下」，而且不报错、只是慢。
 * 3. **Range 续传**：`.yostar-tmp` 已有一部分就接着下；但 tmp 比目标还大说明上次写坏了
 *    （清单可能变小过），直接删掉重下，不能盲目追加。
 * 4. 校验失败必须删 tmp：否则下次续传会把错误数据接上去，hash 永远对不上。
 */
async function downloadOne({ url, dest, expectedSize, expectedHash, signal, onProgress }) {
  const temp = dest + '.yostar-tmp';
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const size = Number(expectedSize) || 0;
  const want = String(expectedHash == null ? '' : expectedHash).trim();

  let start = 0;
  const existing = await fsp.stat(temp).catch(() => null);
  if (existing) start = existing.size;
  if (start > 0 && size > 0 && start > size) {
    await fsp.rm(temp, { force: true });
    start = 0;
  }

  // 已经下满就不必再发请求，直接进校验（断点续传最常见的收尾情况）
  const alreadyFull = size > 0 && start === size;
  if (!alreadyFull) {
    const headers = { 'User-Agent': USER_AGENT };
    if (start > 0) headers.Range = `bytes=${start}-`;
    const response = await segmentFetch(url, { method: 'GET', headers, signal });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${path.basename(dest)}`);
    // 服务端忽略 Range、回了完整内容 → 必须从头写，不能追加
    if (start > 0 && response.status !== 206) start = 0;
    const handle = await fsp.open(temp, start > 0 ? 'r+' : 'w');
    try {
      await handle.truncate(start);
      let position = start;
      for await (const piece of response.body) {
        if (signal && signal.cancelled) throw new Error('已取消');
        const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        await handle.write(buffer, 0, buffer.length, position);
        position += buffer.length;
      }
      onProgress?.({ path: dest, size: position });
    } finally {
      await handle.close();
    }
  }

  const stat = await fsp.stat(temp).catch(() => null);
  const actual = stat ? stat.size : 0;
  if (size > 0 && actual !== size) {
    await fsp.rm(temp, { force: true });
    throw new Error(`文件大小不符（期望 ${size}，实际 ${actual}）：${path.basename(dest)}`);
  }
  if (want) {
    const got = await crc64File(temp, { signal });
    if (got !== want) {
      await fsp.rm(temp, { force: true });
      throw new Error(`文件校验不一致（CRC64 期望 ${want}，实际 ${got}）：${path.basename(dest)}`);
    }
  }
  await fsp.rm(dest, { force: true });
  await fsp.rename(temp, dest);
}

/**
 * 并发跑 N 个任务，任一失败立即停下并抛出第一个错误。
 *
 * 为什么不用 `multi-download.js`：那是「单个大文件切 16 段」的模型。Yostar 这边是
 * 「几千个小文件、每个单流」，官方也是 4 个文件并发（`YostarGameInstaller` 的
 * `MaxDegreeOfParallelism = 4`）。两者不是一回事，混用既没提速又增加复杂度。
 */
async function runPool(items, workerCount, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  const count = Math.max(1, Math.min(Number(workerCount) || 1, list.length));
  let cursor = 0;
  let failure = null;
  await Promise.all(
    Array.from({ length: count }, async () => {
      for (;;) {
        if (failure) return;
        const index = cursor;
        cursor += 1;
        if (index >= list.length) return;
        try {
          await worker(list[index], index);
        } catch (error) {
          if (!failure) failure = error;
          return;
        }
      }
    })
  );
  if (failure) throw failure;
}

/**
 * 现算 CRC64，决定「磁盘上这个同名同大小的文件能不能留」。
 *
 * `planUpdate` 是同步纯函数（可测、不读盘），没法自己算 CRC64，所以把这类文件记进
 * `needsVerify` 交回这里补算。判据与官方一致：现算值 === 远端 hash 才保留。
 */
async function shouldKeepExisting(installRoot, file, { signal } = {}) {
  let absPath;
  try {
    absPath = resolveInside(installRoot, file.path);
  } catch {
    return false;
  }
  const stat = await fsp.stat(absPath).catch(() => null);
  if (!stat || !stat.isFile()) return false;
  if (Number(file.size) > 0 && stat.size !== Number(file.size)) return false;
  try {
    const got = await crc64File(absPath, { signal });
    return got === String(file.hash == null ? '' : file.hash).trim();
  } catch {
    return false;
  }
}

/** 远端 config → `writeMetadata` 要的 config 形状（两处安装/更新共用，避免写歪一处）。 */
function metadataConfigFor(remoteConfig, profile) {
  return {
    tag: profile.tag,
    name: executionNameOf(remoteConfig, profile),
    params: remoteConfig.params,
    version: remoteConfig.version,
    gameUninstallScript: stringOf(remoteConfig.raw?.game_uninstall_script),
  };
}

/**
 * 阶段②：**空目录全新安装**。
 *
 * 三条硬约束（改之前先读）：
 *
 * 1. **这里没有 allowDelete**。全新安装不该有「本地多余文件」，唯一可能是用户把目录
 *    指到了已有客户端（甚至别的游戏）。那种情况下删 = 灾难，所以 `plan.delete` 只报数、不执行。
 * 2. 只下需要下的；已存在且校验通过的原样保留。
 * 3. 只有全部文件到位才写两个 json —— 元数据是「这个目录装好了」的唯一凭证，
 *    提前写会让官方启动器看到一个半成品目录。
 */
async function installGame({ profile, installRoot, signal, onProgress } = {}) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  if (!target) throw new Error('没有对应的 Yostar 渠道');
  const root = path.resolve(String(installRoot || ''));
  if (!root || root === path.parse(root).root) throw new Error('请先选择一个安装目录');

  onProgress?.({ phase: 'manifest', current: '正在读取 Yostar 官方清单…' });
  const remote = await loadRemoteTargetPackage(target);
  const pkg = remote.manifest;

  await fsp.mkdir(root, { recursive: true });
  const plan = planUpdate({ installRoot: root, remoteManifest: pkg, localManifest: null, cdn: remote.cdn });
  const toDownload = [...plan.download];
  const domain = remote.cdn.primaryCdn || remote.cdn.backUpCdn || '';

  onProgress?.({
    phase: 'manifest',
    current: `清单 ${pkg.files.length} 个文件 / ${(Number(pkg.totalBytes) / 1024 ** 3).toFixed(2)} GB，需要下载 ${toDownload.length} 个`,
    total: toDownload.length,
    totalBytes: Number(pkg.totalBytes) || 0,
  });
  if (plan.delete.length) {
    onProgress?.({
      phase: 'manifest',
      current: `目录里已有 ${plan.delete.length} 个清单外文件，本次不会删除（全新安装不做删除）`,
      skippedDeletes: plan.delete.length,
    });
  }

  let done = 0;
  await runPool(toDownload, DOWNLOAD_CONCURRENCY, async (file) => {
    if (signal && signal.cancelled) throw new Error('已取消');
    const dest = resolveInside(root, file.path);
    const url = file.url || buildDownloadUri(domain, pkg.source, file.path);
    await downloadOne({ url, dest, expectedSize: file.size, expectedHash: file.hash, signal });
    done += 1;
    onProgress?.({
      phase: 'download',
      current: `${done}/${toDownload.length} ${path.basename(file.path)}`,
      processed: done,
      total: toDownload.length,
      totalBytes: Number(pkg.totalBytes) || 0,
    });
  });

  onProgress?.({ phase: 'install', current: '正在写入官方元数据…' });
  await writeMetadata(root, {
    config: metadataConfigFor(remote.config, target),
    manifest: { name: target.tag, version: remote.config.version, basis: remote.config.basis, files: pkg.files },
  });

  return {
    ok: true,
    channel: target.channel,
    tag: target.tag,
    version: remote.config.version,
    installRoot: root,
    executable: executionNameOf(remote.config, target),
    files: pkg.files.length,
    downloaded: toDownload.length,
    totalBytes: Number(pkg.totalBytes) || 0,
    skippedDeletes: plan.delete.length,
  };
}

/**
 * 阶段③：**更新已有目录**。全项目最危险的一段，四重闸门缺一不可：
 *
 * ```
 * 闸门 1  allowDelete === true —— 只有用户点「更新本体 / 修复游戏」才传 true
 * 闸门 2  本地 manifest/config 存在且 vc 通过 —— 没有可信的「上次装了什么」就不知该删什么
 * 闸门 3  本地 config.tag === 目标 tag（严格相等）—— 防止把 EN 目录当 JP 更新
 * 闸门 4  每个待删路径都过 resolveInside（挡 ../.. 穿越）
 * ```
 *
 * 执行顺序（与官方**有意不同**）：下载校验全部通过 → 安装 → **最后**才删。
 * 官方是 Download → Removing → WriteMetadata。我们挪到最后，代价是「删除失败时目录里
 * 留几个多余文件」（无害），换来「下载阶段任何失败都不删任何东西」。
 *
 * 另外两条保守措施：
 * - 删除数 > `DELETE_GUARD_MAX`（200）直接拒，不执行。清单异常/目录选错时那可能是
 *   几千个文件，宁可让用户手动处理，也不能一键清空半个游戏。
 * - 删除失败逐个记录、不中断（删不掉的多余文件不影响游戏能跑）。
 */
async function updateGame({ profile, installRoot, allowDelete = false, fullVerify = false, signal, onProgress } = {}) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  if (!target) throw new Error('没有对应的 Yostar 渠道');
  const root = path.resolve(String(installRoot || ''));
  if (!root || root === path.parse(root).root) throw new Error('请先选择一个安装目录');

  // 闸门 2
  const localConfig = await readGameConfig(root);
  if (!localConfig) {
    throw new Error(
      '这个目录里没有可信的 Yostar 元数据（game-launcher-config.json 缺失或校验不通过），请改用「下载游戏」重新安装'
    );
  }
  // 闸门 3
  if (String(localConfig.tag) !== String(target.tag)) {
    throw new Error(`这个目录属于 ${localConfig.tag}，不能按 ${target.tag} 更新；请选对渠道或换个目录`);
  }
  const localManifest = await readManifest(root);

  onProgress?.({ phase: 'manifest', current: '正在读取 Yostar 官方清单…' });
  const remote = await loadRemoteTargetPackage(target);
  const pkg = remote.manifest;
  const domain = remote.cdn.primaryCdn || remote.cdn.backUpCdn || '';

  const plan = planUpdate({ installRoot: root, remoteManifest: pkg, localManifest, fullVerify, cdn: remote.cdn });

  /*
   * 消费 planUpdate 的 needsVerify：这些是「磁盘上有同名同大小文件，但本地清单没记录 /
   * 或 fullVerify 要求重算」的项 —— 它们既不在 download 也不在 reuse 里。现算 CRC64：
   * 相同就不必下，不同才进下载队列。漏消费这个字段 = 那批文件被当成「已是最新」而静默跳过。
   */
  const downloadJson = [];
  const seenKeys = new Set();
  const pushDownload = (rel, hash, size) => {
    const key = normalizeManifestPath(rel).toLowerCase();
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    downloadJson.push({ path: normalizeManifestPath(rel), hash, size, url: buildDownloadUri(domain, pkg.source, rel) });
  };
  for (const file of plan.download) pushDownload(file.path, file.hash, file.size);

  const reuseKeys = new Set(plan.reuse.map((file) => normalizeManifestPath(file.path).toLowerCase()));
  let verifiedKeep = 0;
  for (const file of pkg.files) {
    const rel = normalizeManifestPath(file.path);
    if (!rel) continue;
    const key = rel.toLowerCase();
    if (seenKeys.has(key) || reuseKeys.has(key)) continue;
    // 剩下的就是 needsVerify 那批（planUpdate 只在「存在且大小相等但无法仅凭清单定夺」时才不计入前两类）
    const keep = await shouldKeepExisting(root, file, { signal });
    if (keep) {
      verifiedKeep += 1;
      continue;
    }
    pushDownload(rel, file.hash, file.size);
  }

  // 闸门 1 + 4
  const willDelete = [];
  if (allowDelete) {
    if (plan.delete.length > DELETE_GUARD_MAX) {
      throw new Error(
        `官方清单与本地差异过大（要删 ${plan.delete.length} 个文件，超过安全上限 ${DELETE_GUARD_MAX}），` +
          '为防止误删已中止。请确认游戏目录选对了；确需修复请用「修复游戏」'
      );
    }
    for (const item of plan.delete) {
      try {
        willDelete.push({ rel: normalizeManifestPath(item.path), abs: resolveInside(root, item.path) });
      } catch {
        onProgress?.({ phase: 'delete', current: `跳过可疑路径（不在安装目录内）：${item.path}` });
      }
    }
  }

  onProgress?.({
    phase: 'manifest',
    current:
      `清单 ${pkg.files.length} 个文件；需下载 ${downloadJson.length} 个` +
      `，可复用 ${plan.unchanged} 个` +
      (verifiedKeep ? `，现算校验后保留 ${verifiedKeep} 个` : '') +
      (allowDelete ? `，将删除 ${willDelete.length} 个` : ''),
    total: downloadJson.length,
    unchanged: plan.unchanged,
    willDelete: willDelete.length,
    totalBytes: Number(pkg.totalBytes) || 0,
  });

  let done = 0;
  await runPool(downloadJson, DOWNLOAD_CONCURRENCY, async (file) => {
    if (signal && signal.cancelled) throw new Error('已取消');
    const dest = resolveInside(root, file.path);
    const url = file.url || buildDownloadUri(domain, pkg.source, file.path);
    await downloadOne({ url, dest, expectedSize: file.size, expectedHash: file.hash, signal });
    done += 1;
    onProgress?.({
      phase: 'download',
      current: `${done}/${downloadJson.length} ${path.basename(file.path)}`,
      processed: done,
      total: downloadJson.length,
      totalBytes: Number(pkg.totalBytes) || 0,
    });
  });

  const deleteErrors = [];
  if (willDelete.length) {
    onProgress?.({ phase: 'delete', current: `正在删除 ${willDelete.length} 个官方已移除的文件…` });
    for (const item of willDelete) {
      try {
        await fsp.rm(item.abs, { force: true });
      } catch (error) {
        deleteErrors.push(`${item.rel}: ${error.message}`);
      }
    }
  }

  onProgress?.({ phase: 'install', current: '正在写入官方元数据…' });
  await writeMetadata(root, {
    config: metadataConfigFor(remote.config, target),
    manifest: { name: target.tag, version: remote.config.version, basis: remote.config.basis, files: pkg.files },
  });

  return {
    ok: true,
    channel: target.channel,
    tag: target.tag,
    fromVersion: localConfig.version,
    version: remote.config.version,
    installRoot: root,
    executable: executionNameOf(remote.config, target),
    files: pkg.files.length,
    downloaded: downloadJson.length,
    unchanged: plan.unchanged,
    verifiedKeep,
    deleted: willDelete.length,
    deleteErrors,
    totalBytes: Number(pkg.totalBytes) || 0,
  };
}

/**
 * 只读预演：算出「这次会下多少、删多少」，**不下载、不删除、不写盘**。
 *
 * 界面上的「预计下载 N GB / 将删除 M 个文件」用的就是这个。用户点确认前必须先看到
 * 这些数字 —— 尤其删除数，那是最需要人确认的一项。
 */
async function planForGame({ profile, installRoot, fullVerify = false } = {}) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  if (!target) throw new Error('没有对应的 Yostar 渠道');
  const root = path.resolve(String(installRoot || ''));
  if (!root || root === path.parse(root).root) throw new Error('请先选择一个安装目录');
  const localConfig = await readGameConfig(root);
  const localManifest = localConfig ? await readManifest(root) : null;
  const remote = await loadRemoteTargetPackage(target);
  const plan = planUpdate({ installRoot: root, remoteManifest: remote.manifest, localManifest, fullVerify, cdn: remote.cdn });
  return {
    ok: true,
    channel: target.channel,
    tag: target.tag,
    fromVersion: localConfig ? localConfig.version : '',
    version: remote.config.version,
    // 只用清单求和，**不要**用接口的 decompression_size（EN 实测报 22GB，清单实际 3.73GB）
    totalBytes: Number(remote.manifest.totalBytes) || 0,
    downloadBytes: plan.downloadBytes,
    files: remote.manifest.files.length,
    needDownload: plan.download.length,
    unchanged: plan.unchanged,
    needsVerify: plan.needsVerify,
    willDelete: plan.delete.length,
  };
}

// ── 目录判区（阶段④ 检测链用） ─────────────────────────────────────────────

/**
 * 判断一个安装目录属于哪个 Yostar 区服，认不出来返回 ''。
 *
 * 与 `readGameConfig` 的区别：这里是「目录探针」，用在自动检测（detectionChannel）
 * 与路径回填上，**不能要求 vc 校验通过** —— 官方启动器留下的目录、用户手改过
 * 元数据的目录都应该还能被认出来。判据按可信度排序：
 *   1. `game-launcher-config.json` 里的 `tag`（我方 installGame 会写，官方也写）；
 *   2. 目录名里的 Arknights_EN / _JP / _KR；
 *   3. 以上都没有 → ''（调用方回落到原有的目录名/公司名启发式）。
 * 认出来后调用方可以直接把检测结果写进对应 server 行，不用再把三个区压成
 * global-en 让用户手动改。
 */
async function detectChannelOf(installRoot) {
  const root = String(installRoot || '');
  if (!root) return '';
  let text;
  try {
    text = await fsp.readFile(path.join(root, CONFIG_FILE_NAME), 'utf8');
  } catch {
    text = '';
  }
  if (text) {
    try {
      const body = JSON.parse(text);
      const tag = stringOf(body && body.tag).trim().toLowerCase();
      for (const profile of Object.values(YOSTAR_PROFILES)) {
        if (tag === String(profile.tag).toLowerCase()) return profile.channel;
      }
    } catch {
      /* JSON 坏了就继续看目录名 */
    }
  }
  const lower = root.toLowerCase().replace(/\\/g, '/');
  for (const profile of Object.values(YOSTAR_PROFILES)) {
    if (lower.includes(String(profile.tag).toLowerCase())) return profile.channel;
  }
  return '';
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

/**
 * 阶段①②③ 的导出面。阶段④（接 UI / 启动链 / 渠道判定）在 `main.js` 里做，
 * 本文件只提供能力，不碰 Electron、不碰路径策略。
 */
module.exports = {
  YOSTAR_PROFILES,
  isYostarChannel,
  profileFor,
  crc64Buffer,
  crc64File,
  createAuthorizationHeader,
  apiGet,
  loadRemoteGameConfig,
  loadRemoteCdn,
  loadRemoteManifestUrl,
  loadRemoteManifest,
  loadRemoteTargetPackage,
  executionNameOf,
  computeConfigHash,
  computeManifestHash,
  computeFileHash,
  readGameConfig,
  readManifest,
  writeMetadata,
  planUpdate,
  // 阶段②③
  downloadOne,
  installGame,
  updateGame,
  planForGame,
  // 阶段④
  detectChannelOf,
};
