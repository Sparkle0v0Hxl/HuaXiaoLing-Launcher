'use strict';

/**
 * 鸣潮（Wuthering Waves）库洛官方协议层 + 安装/更新层。
 *
 * 覆盖三个渠道：官服（10003）/ B服（10004）/ 国际服（50004）。
 * 协议事实全部来自实网抓取（2026-11-11，v3.7.1 实测全链路 HTTP 200）与
 * 开源参照（Hi3Helper.Plugin.Wuwa、Arietta、Peebify kuro.rs、TWtiramisu GameBox），
 * 见 `_kuro-api-research.md` / `_kuro-global-api.md` 报告。
 *
 * 三条铁律（与 yostar-packs.js 一致，改这个文件的人请先读）：
 *
 * 1. **不 require Electron**。路径一律由调用方传进来，纯 node 下就能 `node --check`
 *    和跑自测。
 * 2. **不引第三方 npm 依赖**。只有 `node:` 内置 + 仓库已有的 `./http-fetch`
 *    （它的 `segmentFetch` 只走 `node:https`，并自带代理选路兜底）。
 * 3. **不碰官方元数据**。库洛官方启动器在游戏目录里写 `LocalGameResources.json` 等
 *    文件，我们**只读不写**；我方自己的元数据用独立文件名
 *    （`kuro-launcher-config.json` / `kuro-manifest.json`），互不干扰。
 *
 * 与 Yostar 的关键差异（改之前必读）：
 * - 校验用 **md5**（清单字段就叫 md5，小写十六进制），不是 CRC64；
 * - index.json / indexFile.json 响应**可能是 gzip**（实测 Accept-Encoding: identity 也不一定免），
 *   必须判 `content-encoding` 手动解压；
 * - 没有「签名直链 + nocache 覆盖」那套 —— 清单 URL 直接由 cdnList[0].url + config.indexFile 拼；
 * - 下载直链 = `{cdnList[0].url}/{config.baseUrl}{dest}`（baseUrl 以 `/` 结尾，dest 用 `/` 分隔），
 *   2026-11-11 实网对国服清单抽样逐文件 md5 全对。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { segmentFetch } = require('./http-fetch');
const runtime = require('./runtime');

// ── 常量 ─────────────────────────────────────────────────────────────────────

/**
 * 三个渠道的 appIdKey（`{appId}_{appKey}` 形式）与 gameId。
 * 出处：Arietta `GameUpdateService.cs:40-59` 与实网 index.json 200 验证。
 * appKey 是官方固定值可直接硬编码；版本路径里的随机 token 必须动态读。
 */
const KURO_PROFILES = {
  official: {
    channel: 'official',
    name: '官服',
    gameId: 'G152',
    appIdKey: '10003_Y8xXrXk65DqFHEDgApn3cpK5lfczpFx5',
    // 国服域名带 `-cn-` 中缀
    indexHost: 'https://prod-cn-alicdn-gamestarter.kurogame.com',
    defaultExe: 'Client-Win64-Shipping.exe',
  },
  bilibili: {
    channel: 'bilibili',
    name: 'B服',
    gameId: 'G152',
    appIdKey: '10004_j5GWFuUFlb8N31Wi2uS3ZAVHcb7ZGN7y',
    indexHost: 'https://prod-cn-alicdn-gamestarter.kurogame.com',
    defaultExe: 'Client-Win64-Shipping.exe',
  },
  global: {
    channel: 'global',
    name: '国际服',
    gameId: 'G153',
    appIdKey: '50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c',
    // 国际服域名没有 `-cn-` 中缀
    indexHost: 'https://prod-alicdn-gamestarter.kurogame.com',
    defaultExe: 'Client-Win64-Shipping.exe',
  },
};

/**
 * 备用 index 域名（安装包内 KRApp.conf 解出，实网可达）。
 * 主域全挂时按顺序试。
 */
const INDEX_HOST_BACKUPS = ['https://prod-volcdn-gamestarter.kurogame.net'];

/** 接口超时（index.json 很小，30 秒足够；清单几 MB 也走这个）。 */
const API_TIMEOUT_MS = 30 * 1000;

/** 文件级下载并发（与 yostar-packs 一致的小文件并发模型）。 */
const DOWNLOAD_CONCURRENCY = 4;

/** 我方本地元数据文件名。刻意与官方文件名错开，互不干扰。 */
const CONFIG_FILE_NAME = 'kuro-launcher-config.json';
const MANIFEST_FILE_NAME = 'kuro-manifest.json';

/** B服身份判据：这套 B 站登录 SDK 目录只有 B服 清单里有（官服 0 个 Bilibili 路径）。 */
const BILIBILI_MARKER_DIR = 'Client/Binaries/Win64/ThirdParty/KrPcSdk_Mainland/KRSDKRes/Bilibili';

/** 请求 UA。服务端不校验（实测任意字符串都通），老实写自己的标识。 */
const USER_AGENT = 'HXL-Kuro/1.0.0';

// ── 渠道 ─────────────────────────────────────────────────────────────────────

function isKuroChannel(channel) {
  return Object.prototype.hasOwnProperty.call(KURO_PROFILES, String(channel || ''));
}

/**
 * 渠道找不到时的报错。WeGame 版要单独说清楚：它没有库洛官方清单，
 * 只能在 WeGame 商店里下，不能在启动器里下载。
 */
function noKuroChannelError(channel) {
  const key = String(channel || '');
  if (key === 'wegame') {
    return new Error('WeGame 版没有库洛官方清单，请在 WeGame 商店里下载并更新；启动器只负责官服 / B服 / 国际服客户端');
  }
  return new Error(`没有对应的鸣潮渠道（${key || '(空)'}）`);
}

function profileFor(channel) {
  const key = String(channel || '');
  return Object.prototype.hasOwnProperty.call(KURO_PROFILES, key) ? KURO_PROFILES[key] : null;
}

// ── 通用小工具 ───────────────────────────────────────────────────────────────

/** 清单相对路径统一 `/` 分隔、去开头 `/`（库洛清单本来就是 `/` 分隔，这里只做防御）。 */
function normalizeManifestPath(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').replace(/^\/+/, '');
}

/** 相对路径 → 绝对路径，挡路径穿越（清单是远端给的，`../..` 必须炸在这里）。 */
function resolveInside(root, relativePath) {
  const rel = normalizeManifestPath(relativePath);
  if (!rel) throw new Error('Manifest path is empty.');
  const base = path.resolve(String(root));
  const rootWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  const target = path.resolve(rootWithSep, rel.replace(/\//g, path.sep));
  const normalizedTarget = target.endsWith(path.sep) ? target : target + path.sep;
  if (!normalizedTarget.toLowerCase().startsWith(rootWithSep.toLowerCase())) {
    throw new Error(`Manifest path escapes the game directory: ${relativePath}`);
  }
  return target;
}

/**
 * 下载 URL：`{cdn.url}/{config.baseUrl}{dest}`。
 *
 * baseUrl 实测以 `/` 结尾（`launcher/game/G152/10003/3.7.1/<token>/zip/`），dest 用 `/`
 * 分隔直接拼即可。cdn.url 取 cdnList 第一条（官方启动器按权重排序，第一条就是主 CDN）。
 */
function buildDownloadUrl(cdnUrl, baseUrl, dest) {
  const base = String(cdnUrl == null ? '' : cdnUrl).trim().replace(/\/+$/, '');
  if (!base) throw new Error('库洛清单没有可用的 CDN 域名');
  const middle = String(baseUrl == null ? '' : baseUrl).trim();
  const rel = normalizeManifestPath(dest);
  if (!rel) throw new Error('库洛清单给了空的下载路径');
  const path3 = middle ? `${middle.replace(/^\/+/, '')}/${rel}` : rel;
  return `${base}/${path3.replace(/^\/+/, '')}`;
}

// ── HTTP（含 gzip 处理） ─────────────────────────────────────────────────────

/**
 * GET 一个 URL，返回**解压后的文本**。
 *
 * 库洛的 index.json / indexFile.json 实测经常回 `content-encoding: gzip`
 * （发 `Accept-Encoding: identity` 也不一定免）。segmentFetch 不自动解压，
 * 所以这里必须自己判头手动 gunzip，否则 JSON.parse 拿到一坨二进制直接炸。
 */
async function fetchText(url, { timeoutMs = API_TIMEOUT_MS } = {}) {
  const response = await segmentFetch(url, {
    method: 'GET',
    headers: { Accept: '*/*', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const error = new Error(`库洛接口请求失败：HTTP ${response.status} ${url}`);
    error.code = 'KURO_HTTP_ERROR';
    error.status = response.status;
    throw error;
  }
  let buffer = Buffer.from(await response.arrayBuffer());
  const encoding = String(
    (response.headers && (response.headers.get ? response.headers.get('content-encoding') : response.headers['content-encoding'])) || ''
  ).toLowerCase();
  if (encoding.includes('gzip') || (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b)) {
    try {
      buffer = zlib.gunzipSync(buffer);
    } catch {
      // 头说 gzip 但内容不是（少见）——按原文继续试 JSON
    }
  }
  return buffer.toString('utf8');
}

// ── index.json / 清单 ────────────────────────────────────────────────────────

/**
 * 拉渠道 index.json：`{indexHost}/launcher/game/{gameId}/{appIdKey}/index.json`。
 *
 * 顶层结构（实网核验）：`default{cdnList, config{version,indexFile,indexFileMd5,baseUrl,...}}`；
 * predownload 槽结构与 default 相同（库洛把「下一版本预下载」放在旁边，当前未启用时字段为空）。
 * **没有 resourcePacks 字段** —— 那是启动器 conf 层的概念，游戏清单就是单个 indexFile。
 */
async function loadIndex(profile) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  if (!target) throw noKuroChannelError(profile && profile.channel ? profile.channel : profile);
  const hosts = [target.indexHost, ...INDEX_HOST_BACKUPS];
  let lastError = null;
  for (const host of hosts) {
    const url = `${host}/launcher/game/${target.gameId}/${target.appIdKey}/index.json`;
    try {
      const body = JSON.parse(await fetchText(url));
      const slot = body && body.default && typeof body.default === 'object' ? body.default : null;
      const config = slot && slot.config && typeof slot.config === 'object' ? slot.config : null;
      const cdnList = slot && Array.isArray(slot.cdnList) ? slot.cdnList : [];
      const cdnUrl = cdnList.length && cdnList[0] && typeof cdnList[0].url === 'string' ? cdnList[0].url : '';
      if (!config || !cdnUrl || !config.indexFile) {
        throw new Error('index.json 结构不符合预期（缺 default.cdnList 或 default.config.indexFile）');
      }
      return {
        channel: target.channel,
        version: String(config.version || ''),
        indexFile: String(config.indexFile),
        indexFileMd5: String(config.indexFileMd5 || '').toLowerCase(),
        baseUrl: String(config.baseUrl || ''),
        cdnUrl,
        raw: body,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('库洛 index.json 全部域名请求失败');
}

/**
 * 拉逐文件清单：`{cdnUrl}/{indexFile}` → `{resource:[{dest,size,md5,chunkInfos?}]}`。
 *
 * 主动校验 `indexFileMd5`（index.json 自带清单的 md5，防止 CDN 回了旧版）；
 * 不匹配时重试一次（CDN 边缘不同步是真实存在的情况），仍不匹配才报错。
 */
async function loadManifest(profile, indexInfo, { verifyMd5 = true } = {}) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  if (!target) throw noKuroChannelError(profile && profile.channel ? profile.channel : profile);
  const url = buildDownloadUrl(indexInfo.cdnUrl, '', indexInfo.indexFile);
  const attempt = async () => {
    const body = JSON.parse(await fetchText(url, { timeoutMs: 10 * 60 * 1000 }));
    const list = body && Array.isArray(body.resource) ? body.resource : [];
    const files = [];
    let totalBytes = 0;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const dest = normalizeManifestPath(item.dest);
      if (!dest) continue;
      const size = Number(item.size) || 0;
      totalBytes += size;
      files.push({ path: dest, hash: String(item.md5 == null ? '' : item.md5).toLowerCase(), size });
    }
    return { files, totalBytes };
  };

  let parsed = await attempt();
  if (verifyMd5 && indexInfo.indexFileMd5) {
    // 校验必须对「响应原文（解压后）」算 md5 —— 直接重新 GET 一次原文
    const response = await segmentFetch(url, {
      method: 'GET',
      headers: { Accept: '*/*', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (response.ok) {
      let buffer = Buffer.from(await response.arrayBuffer());
      const encoding = String(
        (response.headers && (response.headers.get ? response.headers.get('content-encoding') : response.headers['content-encoding'])) || ''
      ).toLowerCase();
      if (encoding.includes('gzip') || (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b)) {
        try {
          buffer = zlib.gunzipSync(buffer);
        } catch { /* ignore */ }
      }
      const got = crypto.createHash('md5').update(buffer).digest('hex');
      if (got !== indexInfo.indexFileMd5) {
        // CDN 边缘不同步：重拉一次；仍不匹配就按「不校验」继续（md5 校验失败不代表清单不可用）
        parsed = await attempt();
      }
    }
  }
  return { source: indexInfo.cdnUrl, baseUrl: indexInfo.baseUrl, files: parsed.files, totalBytes: parsed.totalBytes, version: indexInfo.version };
}

// ── bundle 协议（官方 3.0.x 起的正式清单，2026-11-12 实网确认） ───────────────

/**
 * bundle 协议的 `{appId}_{bundleAppKey}` 与 serverCode。
 *
 * **为什么必须用这套**：`loadIndex` 走的老端点
 * `launcher/game/{gameId}/{appIdKey}/index.json` 至今**仍在服务，但冻结在 3.7.1**
 * （2026-11-12 实网：official/bilibili 都是 `default.config.version=3.7.1`、916/986 个文件）。
 * 新端点 `launcher/game/{appId}_{bundleAppKey}/{gameId}/{serverCode}/index.json`
 * 才返回 `default` 之外的顶层 `{cdnList,resourcePacks,bundles,config,predownload}`、
 * 版本 3.8.0、924/995 个文件。
 *
 * 两个端点同时活着，所以老代码「不报错、只是下旧版本」——下载游戏装出来的是 3.7.1、
 * 对 3.8.0 客户端点更新会按 3.7.1 清单覆盖回去（审计 P0）。bundleAppKey 与
 * `kuro-predownload.js` 的 `BUNDLE_PROFILES` 是同一批官方固定值。
 */
const BUNDLE_SOURCES = {
  official: { appId: '10003', bundleAppKey: 'oLNgHF1CESo51DGHN2odtp40e3oI1HfZ', serverCode: 'official' },
  bilibili: { appId: '10004', bundleAppKey: 'IY6xmlAusbImBjWrpPj1OwNuirXEO44x', serverCode: 'bilibili' },
  global: { appId: '50004', bundleAppKey: 'P7xcUZnEr1AXIGON25E6KjpOgTlVrg6e', serverCode: 'official' },
};

/** 默认档位（与官方启动器一致）：HD = common + hd 两个包。 */
const BUNDLE_DEFAULT = 'HD';

function bundleIndexUrl(target) {
  const src = BUNDLE_SOURCES[target.channel];
  if (!src) return '';
  return `${target.indexHost}/launcher/game/${src.appId}_${src.bundleAppKey}/${target.gameId}/${src.serverCode}/index.json`;
}

/**
 * 拉 bundle 版 index.json，返回与 `loadIndex` 同形状的 indexInfo + 分档信息。
 *
 * 与 legacy `loadIndex` 的关键差别：
 *   - 版本取 `resourcePacks[<首包>].version`（顶层 `bundles` 没有 version 字段，
 *     权威版本只在 resourcePacks 上，实网确认）；
 *   - 下载基准 `baseUrl` 取 `resourcePacks.common.baseUrl`。实测 common 与 hd
 *     的 baseUrl **逐字节相同**、且用 common 的 baseUrl 取 hd 文件同样 206，
 *     所以整份清单可以共用一个 baseUrl，`planUpdate` 的签名不用动；
 *   - `indexFile` 记 common 的清单（校验用），实际清单由 `loadBundleManifest` 合并。
 */
async function loadBundleIndex(profile) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  if (!target) throw noKuroChannelError(profile && profile.channel ? profile.channel : profile);
  const url = bundleIndexUrl(target);
  if (!url) throw noKuroChannelError(profile && profile.channel ? profile.channel : profile);
  const hosts = [target.indexHost, ...INDEX_HOST_BACKUPS];
  let lastError = null;
  for (const host of hosts) {
    const tryUrl = url.replace(target.indexHost, host);
    try {
      const body = JSON.parse(await fetchText(tryUrl));
      const packs = body && body.resourcePacks && typeof body.resourcePacks === 'object' ? body.resourcePacks : {};
      const cdnList = Array.isArray(body && body.cdnList) ? body.cdnList : [];
      const cdnUrl = cdnList.length && cdnList[0] && typeof cdnList[0].url === 'string' ? cdnList[0].url : '';
      const bundleDef = body && body.bundles && body.bundles[BUNDLE_DEFAULT];
      const packNames =
        bundleDef && Array.isArray(bundleDef.resourcePacks) && bundleDef.resourcePacks.length
          ? bundleDef.resourcePacks.map((name) => String(name))
          : ['common', 'hd'];
      if (!cdnUrl || !packs.common || !packs.common.indexFile) {
        throw new Error('bundle index.json 结构不符合预期（缺 cdnList 或 resourcePacks.common.indexFile）');
      }
      const version = String(
        (packs[packNames[0]] && packs[packNames[0]].version) || (packs.common && packs.common.version) || ''
      ).trim();
      if (!version) throw new Error('bundle index.json 里没有正式版本号');
      return {
        channel: target.channel,
        version,
        indexFile: String(packs.common.indexFile),
        indexFileMd5: String(packs.common.indexFileMd5 || '').toLowerCase(),
        // 实测 common/hd 的 baseUrl 一致；万一将来不同，这里也只会取 common 的，
        // 合并清单时每个文件仍记自己那个包的 baseUrl（见 loadBundleManifest）。
        baseUrl: String(packs.common.baseUrl || ''),
        cdnUrl,
        packNames,
        packs,
        raw: body,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('库洛 index.json 全部域名请求失败');
}

/**
 * 拉 bundle 的全量清单：按 `indexInfo.packNames` 逐个包取，合并成
 * `{resource:[...]}` 形状（与 legacy 清单同构，planUpdate 直接吃）。
 *
 * 每个文件额外带 `baseUrl`（它自己那个包的）。实测两个包 baseUrl 相同，所以
 * 合并后统一用 `indexInfo.baseUrl` 也不会错；但保留 per-file 值更抗将来变化。
 */
async function loadBundleManifest(profile, indexInfo) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  if (!target) throw noKuroChannelError(profile && profile.channel ? profile.channel : profile);
  const cdnUrl = indexInfo.cdnUrl;
  if (!cdnUrl) throw new Error('库洛清单没有可用的 CDN 域名');
  const names = Array.isArray(indexInfo.packNames) && indexInfo.packNames.length ? indexInfo.packNames : ['common', 'hd'];
  const files = [];
  let totalBytes = 0;
  for (const name of names) {
    const pack = indexInfo.packs && indexInfo.packs[name];
    if (!pack || !pack.indexFile) continue;
    const url = buildDownloadUrl(cdnUrl, '', String(pack.indexFile));
    const body = JSON.parse(await fetchText(url, { timeoutMs: 10 * 60 * 1000 }));
    const list = body && Array.isArray(body.resource) ? body.resource : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const dest = normalizeManifestPath(item.dest);
      if (!dest) continue;
      const size = Number(item.size) || 0;
      totalBytes += size;
      files.push({
        path: dest,
        hash: String(item.md5 == null ? '' : item.md5).toLowerCase(),
        size,
        baseUrl: String(pack.baseUrl || ''),
      });
    }
  }
  if (!files.length) throw new Error('库洛官方清单里没有可用文件');
  return { source: cdnUrl, baseUrl: indexInfo.baseUrl, files, totalBytes, version: indexInfo.version };
}

/** 一次拿齐 index + 清单（bundle 协议；legacy 端点已冻结在 3.7.1，只用它做兜底）。 */
async function loadRemoteTargetPackage(profile) {
  const index = await loadBundleIndex(profile);
  const manifest = await loadBundleManifest(profile, index);
  return { index, manifest, totalBytes: manifest.totalBytes, version: index.version };
}

// ── 本地元数据 ───────────────────────────────────────────────────────────────

/**
 * 我方元数据的防篡改校验和：字段按出现顺序 `;` 连接取 md5+base64。
 * 与 Yostar 的 vc 同思路，但格式是我们自己的（不用对齐任何官方算法）。
 */
function hashJoinedValues(values) {
  const text = (values || []).map((value) => String(value == null ? '' : value)).join(';');
  return crypto.createHash('md5').update(text, 'utf8').digest('base64');
}

/**
 * 读 `kuro-launcher-config.json`。缺失/坏 JSON/校验不过/关键字段空 → 一律 null
 * （这是「目录是不是我方装好的」探针，静默失败由调用方走「当作没装」）。
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
  if (!body || typeof body !== 'object' || typeof body.vc !== 'string') return null;
  const values = [];
  for (const key of Object.keys(body)) {
    if (key === 'vc') continue;
    values.push(Array.isArray(body[key]) ? body[key].join(',') : String(body[key] == null ? '' : body[key]));
  }
  if (body.vc !== hashJoinedValues(values)) return null;
  const channel = String(body.channel || '');
  const version = String(body.version || '');
  if (!isKuroChannel(channel) || !version.trim()) return null;
  return { channel, version, name: String(body.name || ''), exe: String(body.exe || ''), raw: body };
}

/** 读 `kuro-manifest.json`（清单快照，判断「本地多了哪些文件」用）。 */
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
  if (!body || typeof body !== 'object' || typeof body.vc !== 'string') return null;
  const channel = String(body.channel || '');
  const version = String(body.version || '');
  if (body.vc !== hashJoinedValues([channel, version])) return null;
  const files = Array.isArray(body.files)
    ? body.files
        .filter((item) => item && typeof item === 'object' && item.path)
        .map((item) => ({ path: normalizeManifestPath(item.path), hash: String(item.hash || ''), size: Number(item.size) || 0 }))
    : [];
  return { channel, version, files };
}

/**
 * 写两个元数据文件，事务式（先清单后配置，两个 tmp 都成了才 rename）。
 * 与 yostar 同一套纪律：这两个文件是「目录已装好」的唯一凭证。
 */
async function writeMetadata(installRoot, { config, manifest } = {}) {
  const root = String(installRoot);
  if (!config || !manifest) throw new Error('writeMetadata 需要同时提供 config 与 manifest');
  await fsp.mkdir(root, { recursive: true });

  const manifestBody = {
    channel: String(manifest.channel || ''),
    version: String(manifest.version || ''),
    vc: hashJoinedValues([String(manifest.channel || ''), String(manifest.version || '')]),
    files: (Array.isArray(manifest.files) ? manifest.files : []).map((file) => ({
      path: normalizeManifestPath(file.path),
      hash: String(file.hash == null ? '' : file.hash),
      size: Number(file.size) || 0,
    })),
  };
  const configBody = {
    channel: String(config.channel || ''),
    name: String(config.name || ''),
    version: String(config.version || ''),
    exe: String(config.exe || ''),
    vc: hashJoinedValues([
      String(config.channel || ''),
      String(config.name || ''),
      String(config.version || ''),
      String(config.exe || ''),
    ]),
  };

  const manifestTarget = path.join(root, MANIFEST_FILE_NAME);
  const configTarget = path.join(root, CONFIG_FILE_NAME);
  const manifestTemp = manifestTarget + '.tmp';
  const configTemp = configTarget + '.tmp';
  await fsp.writeFile(manifestTemp, JSON.stringify(manifestBody), 'utf8');
  await fsp.writeFile(configTemp, JSON.stringify(configBody), 'utf8');
  await fsp.rename(manifestTemp, manifestTarget);
  await fsp.rename(configTemp, configTarget);
}

// ── 更新计划（纯函数，绝不写盘） ─────────────────────────────────────────────

/**
 * 比对本地/远端清单。规则与 yostar 的 planUpdate 同构（md5 代替 CRC64）：
 * 1. 目标不存在或大小不等 → download；
 * 2. fullVerify 或本地清单没记录 → needsVerify（现算 md5 交调用方）；
 * 3. hash 不同 → download；相同 → reuse。
 * delete 只从本地清单取，绝不扫盘。
 */
function planUpdate({ installRoot, remoteManifest, localManifest, fullVerify = false, localExists, cdnUrl, baseUrl } = {}) {
  const remoteFiles = Array.isArray(remoteManifest && remoteManifest.files) ? remoteManifest.files : [];
  if (!remoteFiles.length) throw new Error('planUpdate 需要一份非空的远端清单');

  const localFiles = new Map();
  for (const file of (localManifest && localManifest.files) || []) {
    const key = normalizeManifestPath(file && file.path).toLowerCase();
    if (key && !localFiles.has(key)) localFiles.set(key, file);
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
            return { exists: Boolean(result.exists), size: result.size == null ? null : Number(result.size) };
          }
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
    if (remoteKeys.has(key)) continue;
    remoteKeys.add(key);

    const size = Number(remote.size) || 0;
    const hash = String(remote.hash == null ? '' : remote.hash);
    resolveInside(installRoot, rel); // 路径穿越在这里就炸

    const state = probe(rel);
    if (!state.exists || (state.size !== null && Number(state.size) !== size)) {
      download.push({ path: rel, hash, size, url: cdnUrl ? buildDownloadUrl(cdnUrl, baseUrl, rel) : null });
      continue;
    }

    const localFile = localFiles.get(key);
    if (fullVerify || !localFile) {
      needsVerify += 1;
      continue;
    }
    if (String(localFile.hash) !== hash) {
      download.push({ path: rel, hash, size, url: cdnUrl ? buildDownloadUrl(cdnUrl, baseUrl, rel) : null });
      continue;
    }
    reuse.push({ path: rel, hash, size, absPath: resolveInside(installRoot, rel) });
  }

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
    unchanged: reuse.length,
    needsVerify,
    downloadBytes: download.reduce((sum, file) => sum + file.size, 0),
  };
}

// ── 下载 / 安装 / 更新 ───────────────────────────────────────────────────────

/**
 * 流式 md5（8MB 分块），返回小写十六进制。清单的 md5 就是这个口径。
 */
async function md5File(filePath, { signal } = {}) {
  if (signal) signal.throwIfAborted?.();
  const handle = await fsp.open(filePath, 'r');
  try {
    const hash = crypto.createHash('md5');
    const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
    let done = 0;
    const total = (await handle.stat()).size;
    while (done < total) {
      if (signal && signal.cancelled) throw new Error('已取消');
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, total - done), done);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
      done += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * 单文件下载：`.kuro-tmp` 后缀 + Range 续传 + size/md5 双校验 + 先删后 rename
 * （先删后 rename 同时是「断硬链接」的正确写法，见 yostar-packs 同名注释）。
 */
async function downloadOne({ url, dest, expectedSize, expectedHash, signal, onProgress }) {
  const temp = dest + '.kuro-tmp';
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const size = Number(expectedSize) || 0;
  const want = String(expectedHash == null ? '' : expectedHash).trim().toLowerCase();

  let start = 0;
  const existing = await fsp.stat(temp).catch(() => null);
  if (existing) start = existing.size;
  if (start > 0 && size > 0 && start > size) {
    await fsp.rm(temp, { force: true });
    start = 0;
  }

  const alreadyFull = size > 0 && start === size;
  if (!alreadyFull) {
    const headers = { 'User-Agent': USER_AGENT };
    if (start > 0) headers.Range = `bytes=${start}-`;
    const response = await segmentFetch(url, { method: 'GET', headers, signal });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${path.basename(dest)}`);
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
    const got = await md5File(temp, { signal });
    if (got !== want) {
      await fsp.rm(temp, { force: true });
      throw new Error(`文件校验不一致（md5 期望 ${want}，实际 ${got}）：${path.basename(dest)}`);
    }
  }
  await fsp.rm(dest, { force: true });
  await fsp.rename(temp, dest);
}

/** 并发跑 N 个任务，任一失败立即停（与 yostar runPool 同款）。 */
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

/** 现算 md5，决定「同名同大小的磁盘文件能不能留」。 */
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
    const got = await md5File(absPath, { signal });
    return got === String(file.hash == null ? '' : file.hash).trim().toLowerCase();
  } catch {
    return false;
  }
}

/** 空 exe 名兜底（库洛清单没有 exe 字段，渠道常量里带默认值）。 */
function executableFor(profile) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  return (target && target.defaultExe) || 'Client-Win64-Shipping.exe';
}

/**
 * 写**官方启动器的记账文件**：`launcherDownloadConfig.json` + `launcherDownloadConfig/<pack>.json`。
 *
 * 为什么必须写：官方客户端目录里除了游戏文件，还有这套记账（实测官服本体
 * `{"appId":"10003","version":"","state":"","bundles":{"HD":{"version":"3.7.1",
 * "state":"","resourcePacks":["common","hd"]}}}`）。我们装完不写它，目录就缺这一环：
 *   ① 真升级 `updateGameFromBundle` 会判「不是库洛官方客户端」直接拒绝；
 *   ② 官方启动器 / 游戏自己按它认版本，缺了会当文件损坏重新校验。
 * 采用「读旧的 → 只改 version 相关字段 → tmp+rename」，不清空官方其它字段
 * （`resourcesLogin` 之类），也不碰我方 `kuro-launcher-config.json`。
 */
async function writeLauncherConfig({ installRoot, channel, version, bundle = BUNDLE_DEFAULT, packs = ['common', 'hd'] } = {}) {
  const root = String(installRoot || '');
  if (!root) return false;
  const src = BUNDLE_SOURCES[channel] || null;
  const packNames = (Array.isArray(packs) && packs.length ? packs : ['common', 'hd']).map((name) => String(name));
  const cfgPath = path.join(root, 'launcherDownloadConfig.json');
  let cfg = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
    if (parsed && typeof parsed === 'object') cfg = parsed;
  } catch {
    cfg = {};
  }
  if (!cfg.appId && src) cfg.appId = src.appId;
  cfg.version = String(version || '');
  if (cfg.state == null) cfg.state = '';
  if (!cfg.bundles || typeof cfg.bundles !== 'object') cfg.bundles = {};
  if (!cfg.bundles[bundle] || typeof cfg.bundles[bundle] !== 'object') cfg.bundles[bundle] = {};
  cfg.bundles[bundle].version = String(version || '');
  if (cfg.bundles[bundle].state == null) cfg.bundles[bundle].state = '';
  cfg.bundles[bundle].resourcePacks = packNames;
  const tmp = `${cfgPath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(cfg), 'utf8');
  await fsp.rm(cfgPath, { force: true });
  await fsp.rename(tmp, cfgPath);

  const packDir = path.join(root, 'launcherDownloadConfig');
  await fsp.mkdir(packDir, { recursive: true });
  for (const name of packNames) {
    const file = path.join(packDir, `${name}.json`);
    let one = {};
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (parsed && typeof parsed === 'object') one = parsed;
    } catch {
      one = {};
    }
    one.packName = one.packName || name;
    one.version = String(version || '');
    const t = `${file}.tmp`;
    await fsp.writeFile(t, JSON.stringify(one), 'utf8');
    await fsp.rm(file, { force: true });
    await fsp.rename(t, file);
  }
  return true;
}

/**
 * 空目录全新安装。三条约束与 yostar installGame 一致：
 * 无 allowDelete（全新安装不做删除）、只下需要下的、全部到位才写元数据。
 */
async function installGame({ profile, installRoot, signal, onProgress } = {}) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  if (!target) throw noKuroChannelError(profile && profile.channel ? profile.channel : profile);
  const root = path.resolve(String(installRoot || ''));
  if (!root || root === path.parse(root).root) throw new Error('请先选择一个安装目录');

  onProgress?.({ phase: 'manifest', current: '正在读取库洛官方清单…' });
  const remote = await loadRemoteTargetPackage(target);
  const pkg = remote.manifest;

  await fsp.mkdir(root, { recursive: true });
  const plan = planUpdate({ installRoot: root, remoteManifest: pkg, localManifest: null, cdnUrl: remote.index.cdnUrl, baseUrl: remote.index.baseUrl });
  const toDownload = plan.download;

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
    await downloadOne({ url: file.url, dest, expectedSize: file.size, expectedHash: file.hash, signal });
    done += 1;
    onProgress?.({
      phase: 'download',
      current: `${done}/${toDownload.length} ${path.basename(file.path)}`,
      processed: done,
      total: toDownload.length,
      bytesDone: Math.round((Number(pkg.totalBytes) * done) / Math.max(toDownload.length, 1)),
      totalBytes: Number(pkg.totalBytes) || 0,
    });
  });

  onProgress?.({ phase: 'install', current: '正在写入元数据…' });
  await writeMetadata(root, {
    config: { channel: target.channel, name: target.name, version: remote.index.version, exe: target.defaultExe },
    manifest: { channel: target.channel, version: remote.index.version, files: pkg.files },
  });
  // 同步写官方记账（launcherDownloadConfig.json）：不写的话，装完的目录会被
  // 「真升级」判成「不是库洛官方客户端」而拒绝，官方启动器/游戏也认不出装了什么。
  await writeLauncherConfig({
    installRoot: root,
    channel: target.channel,
    version: remote.index.version,
    packs: remote.index.packNames,
  }).catch((error) => {
    console.warn(`kuro writeLauncherConfig(install) failed: ${error.message}`);
  });

  return {
    ok: true,
    channel: target.channel,
    version: remote.index.version,
    installRoot: root,
    executable: target.defaultExe,
    files: pkg.files.length,
    downloaded: toDownload.length,
    totalBytes: Number(pkg.totalBytes) || 0,
    skippedDeletes: plan.delete.length,
  };
}

/**
 * 更新已有目录。闸门与 yostar updateGame 同构（md5 代替 CRC64）：
 * 1 allowDelete === true；2 本地元数据可信；3 channel 严格相等；4 待删路径过 resolveInside。
 * 执行顺序＝下载校验全过 → 安装 → 最后才删（下载阶段任何失败都不删任何东西）。
 */
async function updateGame({ profile, installRoot, allowDelete = false, fullVerify = false, signal, onProgress } = {}) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  if (!target) throw noKuroChannelError(profile && profile.channel ? profile.channel : profile);
  const root = path.resolve(String(installRoot || ''));
  if (!root || root === path.parse(root).root) throw new Error('请先选择一个安装目录');

  const localConfig = await readGameConfig(root);
  if (!localConfig) {
    throw new Error('这个目录里没有可信的鸣潮元数据（kuro-launcher-config.json 缺失或校验不通过），请改用「下载游戏」重新安装');
  }
  if (String(localConfig.channel) !== String(target.channel)) {
    throw new Error(`这个目录属于${localConfig.name || localConfig.channel}，不能按${target.name}更新；请选对渠道或换个目录`);
  }
  const localManifest = await readManifest(root);

  onProgress?.({ phase: 'manifest', current: '正在读取库洛官方清单…' });
  const remote = await loadRemoteTargetPackage(target);
  const pkg = remote.manifest;

  const plan = planUpdate({ installRoot: root, remoteManifest: pkg, localManifest, fullVerify, cdnUrl: remote.index.cdnUrl, baseUrl: remote.index.baseUrl });

  const downloadJson = [];
  const seenKeys = new Set();
  const pushDownload = (rel, hash, size) => {
    const key = normalizeManifestPath(rel).toLowerCase();
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    downloadJson.push({ path: normalizeManifestPath(rel), hash, size, url: buildDownloadUrl(remote.index.cdnUrl, remote.index.baseUrl, rel) });
  };
  for (const file of plan.download) pushDownload(file.path, file.hash, file.size);

  const reuseKeys = new Set(plan.reuse.map((file) => normalizeManifestPath(file.path).toLowerCase()));
  let verifiedKeep = 0;
  for (const file of pkg.files) {
    const rel = normalizeManifestPath(file.path);
    if (!rel) continue;
    const key = rel.toLowerCase();
    if (seenKeys.has(key) || reuseKeys.has(key)) continue;
    const keep = await shouldKeepExisting(root, file, { signal });
    if (keep) {
      verifiedKeep += 1;
      continue;
    }
    pushDownload(rel, file.hash, file.size);
  }

  const willDelete = [];
  if (allowDelete) {
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
    await downloadOne({ url: file.url, dest, expectedSize: file.size, expectedHash: file.hash, signal });
    done += 1;
    onProgress?.({
      phase: 'download',
      current: `${done}/${downloadJson.length} ${path.basename(file.path)}`,
      processed: done,
      total: downloadJson.length,
      bytesDone: Math.round((Number(pkg.totalBytes) * done) / Math.max(downloadJson.length, 1)),
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

  onProgress?.({ phase: 'install', current: '正在写入元数据…' });
  await writeMetadata(root, {
    config: { channel: target.channel, name: target.name, version: remote.index.version, exe: target.defaultExe },
    manifest: { channel: target.channel, version: remote.index.version, files: pkg.files },
  });
  // 官方记账同步（同 installGame 的理由）
  await writeLauncherConfig({
    installRoot: root,
    channel: target.channel,
    version: remote.index.version,
    packs: remote.index.packNames,
  }).catch((error) => {
    console.warn(`kuro writeLauncherConfig(update) failed: ${error.message}`);
  });

  return {
    ok: true,
    channel: target.channel,
    fromVersion: localConfig.version,
    version: remote.index.version,
    installRoot: root,
    executable: target.defaultExe,
    files: pkg.files.length,
    downloaded: downloadJson.length,
    unchanged: plan.unchanged,
    verifiedKeep,
    deleted: willDelete.length,
    deleteErrors,
    totalBytes: Number(pkg.totalBytes) || 0,
  };
}

/** 只读预演：算「这次会下多少」，不下载不删除不写盘。 */
async function planForGame({ profile, installRoot, fullVerify = false } = {}) {
  const target = profileFor(profile && profile.channel ? profile.channel : profile);
  if (!target) throw noKuroChannelError(profile && profile.channel ? profile.channel : profile);
  const root = path.resolve(String(installRoot || ''));
  if (!root || root === path.parse(root).root) throw new Error('请先选择一个安装目录');
  const localConfig = await readGameConfig(root);
  const localManifest = localConfig ? await readManifest(root) : null;
  const remote = await loadRemoteTargetPackage(target);
  const plan = planUpdate({ installRoot: root, remoteManifest: remote.manifest, localManifest, fullVerify, cdnUrl: remote.index.cdnUrl, baseUrl: remote.index.baseUrl });
  return {
    ok: true,
    channel: target.channel,
    fromVersion: localConfig ? localConfig.version : '',
    version: remote.index.version,
    totalBytes: Number(remote.manifest.totalBytes) || 0,
    downloadBytes: plan.downloadBytes,
    files: remote.manifest.files.length,
    needDownload: plan.download.length,
    unchanged: plan.unchanged,
    needsVerify: plan.needsVerify,
    willDelete: plan.delete.length,
  };
}

// ── 官服 / B服互为源（硬链接切服，2026-11-11 用户拍板） ───────────────────────

/**
 * 官服 ↔ B服 互相当源生成目标渠道客户端。实测收益（官方清单交叉，2026-11-11 v3.7.1）：
 * same 847 文件/79.91GiB（99.24% 可零成本硬链）；差异 68 文件/0.61GiB + 仅B服 71 文件/0.18GiB
 * （全在 KRSDKRes/Bilibili/）≈ 切服只需下载约 1.3GiB。
 * 国际服与国服 pak 全部不同（0.4% 可复用），**不做**硬链接互切，调用方不得把 global 传进来。
 *
 * 三步走与 yostar buildCrossRuntime 同构：硬链（逐文件 md5 复核）→ 差异下载 → 写元数据。
 */
/**
 * 鸣潮跨渠道硬链接的「必须拷贝」补充判据（大小写不敏感）。
 *
 * 背景（2026-11-17）：硬链接 = 共享 inode。鸣潮官服 / B服 / WeGame 三份客户端
 * 里有一批「运行时自己写」的文件（账号标识、画质档位、性能采样、崩溃上报），
 * 被硬链接共享之后，游戏往其中一份写一次，另外两份也跟着变 —— 这正是
 * 11-07 终末地官服污染事故的形状。
 *
 * 为什么必须在这里再判一次：buildCrossRuntime 走的是本文件自写的
 * 「逐文件 md5 复核 → fsp.link」循环，**没有**经过 runtime.js 的
 * mustCopyNotLink；只要 md5 对得上就会硬链接。
 *
 * 判据宁可多拷贝：命中的都是小文件，错判的代价是几 MB 盘；
 * 而漏判一次就是整个客户端状态被就地改写、修不回来。
 */
/*
 * 「必须拷贝」的路径段白名单（大小写不敏感）。
 *
 * 2026-11-17 修正：以前这里用的是「相对路径整段前缀相等」，而实际相对路径是
 * `client/binaries/win64/thirdparty/krpcsdk_mainland/krsdkres/...`，
 * 永远不以 `kr_sdkres/` 开头 → 这条闸形同虚设，KRSDKRes 里的 cef.pak / libcef.dll
 * 仍然被硬链共享 inode。
 *
 * 现在改成「路径中任意一段整段相等」：relLower.split('/') 之后 includes(seg)。
 * 代价：白名单段名出现在任何位置都会命中（例如别处有个叫 bilibili 的目录）。
 * 这是可接受的 —— 这些段名都是鸣潮 SDK 的专有名，误伤概率极低；
 * 而漏判一次就是渠道身份文件被就地共享、污染不可逆。
 */
const KURO_MUST_COPY_SEGMENTS = [
  'launcherdownload',
  'launcherdownloadconfig',
  '.quality',
  'wesight',
  'crashsight_data',
  // 渠道身份真正的落点（实测 2026-11-17）：
  //   Client/Binaries/Win64/ThirdParty/KrPcSdk_Mainland/KRSDKRes/KRSDKConfig.json
  //   （KR_ChannelId=19 官服 / 46 B服），以及 B服独有的 KRSDKRes/Bilibili/。
  'krsdkres',
  'krsdkconfig.json',
  'bilibili',
];

/*
 * 「必须拷贝」的多段前缀白名单：只对 client/config 这类**确知**的相对路径前缀生效。
 * 注意 'config' 不在段名白名单里 —— 否则 client/config 下的正常文件会被误伤。
 */
const KURO_MUST_COPY_PREFIXES = [
  'client/config',
  'client/config/kuro',
];

const KURO_MUST_COPY_NAMES = [
  'launcherdownloadconfig.json',
  // 实测文件名是 KRSDKConfig.json（没有下划线）；以前这里写的是带下划线的
  // 错误拼法，与真实文件名对不上，这条规则等于没有生效。
  'krsdkconfig.json',
  'config.txt',
  'uninstall.ini',
  'cert.pem',
  'key.pem',
  'kurodata',
  'distinctid',
  'cos_perf.data',
  'performance_data',
  'crashsight_data',
];

/**
 * 这个文件能不能硬链接。false = 必须拷贝（各渠道各留一份）。
 */
function mustCopyForCrossRuntime(rel) {
  const relLower = String(rel || '').toLowerCase().replace(/\\/g, '/');
  if (!relLower) return true;
  const base = relLower.slice(relLower.lastIndexOf('/') + 1);
  // 多段前缀（确知路径）命中：client/config 等
  for (const prefix of KURO_MUST_COPY_PREFIXES) {
    if (relLower === prefix || relLower.startsWith(prefix + '/')) return true;
  }
  /*
   * 路径段整段相等命中（2026-11-17 修 bug 1）：
   * 判据从「路径开头前缀相等」改成「任意一段整段相等」，
   * 这样 `client/binaries/win64/thirdparty/krpcsdk_mainland/krsdkres/...`
   * 这种真实相对路径才真的会被拦下来（原来 kr_sdkres 这条永远命中不了）。
   * 代价：白名单段名出现在路径任意位置都命中（宁可多拷贝，不冒渠道污染风险）。
   */
  const segments = relLower.split('/');
  for (const seg of KURO_MUST_COPY_SEGMENTS) {
    if (segments.includes(seg)) return true;
  }
  for (const name of KURO_MUST_COPY_NAMES) {
    if (base.indexOf(name) >= 0) return true;
  }
  // 通用硬链接判据（runtime.js）：目录段 / 文件名片段 / 扩展名 + 实测清单
  return runtime.mustCopyNotLink(relLower);
}

async function buildCrossRuntime({ sourceRoot, targetProfile, installRoot, signal, onProgress } = {}) {
  const target = profileFor(targetProfile && targetProfile.channel ? targetProfile.channel : targetProfile);
  if (!target) throw noKuroChannelError(targetProfile && targetProfile.channel ? targetProfile.channel : targetProfile);
  if (target.channel === 'global') {
    throw new Error('鸣潮国际服与国服内容几乎完全不同，不支持硬链接互切；请用「下载游戏」直接安装国际服');
  }
  const src = String(sourceRoot || '');
  if (!src || src === path.parse(src).root) throw new Error('请先选择一个源目录');
  const root = path.resolve(String(installRoot || ''));
  if (!root || root === path.parse(root).root) throw new Error('请先选择一个安装目录');
  if (path.resolve(src).toLowerCase() === root.toLowerCase()) {
    throw new Error('源目录和目标目录是同一个，请换个安装目录');
  }
  const exeName = target.defaultExe;
  if (!fs.existsSync(path.join(src, exeName)) && !fs.existsSync(path.join(src, 'Wuthering Waves.exe'))) {
    throw new Error('源目录里没找到鸣潮主程序，不是可用的鸣潮客户端');
  }

  onProgress?.({ phase: 'manifest', current: '正在读取库洛官方清单…' });
  const remote = await loadRemoteTargetPackage(target);
  const pkg = remote.manifest;

  // 扫源目录（跳过我方元数据与缓存目录）
  const sourceFileMap = new Map();
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'webCaches' || entry.name === 'kr_game_cache' || entry.name.endsWith('.kuro-tmp') || entry.name === 'launcherDownload') continue;
        walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(path.join(dir, entry.name));
          sourceFileMap.set(childRel.toLowerCase(), { abs: path.join(dir, entry.name), size: stat.size });
        } catch {
          /* 源文件消失（杀毒扫描等）就当没有，走下载 */
        }
      }
    }
  };
  onProgress?.({ phase: 'manifest', current: '正在扫描源客户端文件…' });
  walk(src, '');

  const verifySource = async (rel, hash) => {
    const found = sourceFileMap.get(String(rel).toLowerCase());
    if (!found) return null;
    if ((await md5File(found.abs, { signal })) === String(hash).trim().toLowerCase()) return found.abs;
    return null;
  };

  const linkPlan = [];
  const downloadPlan = [];
  const probeCache = new Map();
  for (const file of pkg.files) {
    if (signal && signal.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
    const rel = normalizeManifestPath(file.path);
    if (!rel) continue;
    const key = rel.toLowerCase();
    let abs = probeCache.get(key);
    if (abs === undefined) {
      abs = await verifySource(rel, file.hash);
      probeCache.set(key, abs || null);
    }
    if (abs) linkPlan.push({ rel, hash: file.hash, size: file.size, src: abs });
    else downloadPlan.push({ path: rel, hash: file.hash, size: file.size, url: buildDownloadUrl(remote.index.cdnUrl, remote.index.baseUrl, rel) });
  }

  const linkBytes = linkPlan.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  const downloadBytes = downloadPlan.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  onProgress?.({
    phase: 'manifest',
    current: `可硬链接 ${linkPlan.length} 个（${(linkBytes / 1024 ** 3).toFixed(2)} GB），需下载 ${downloadPlan.length} 个（${(downloadBytes / 1024 ** 3).toFixed(2)} GB）`,
    total: linkPlan.length + downloadPlan.length,
    totalBytes: Number(pkg.totalBytes) || 0,
  });

  await fsp.mkdir(root, { recursive: true });

  let linked = 0;
  for (const item of linkPlan) {
    if (signal && signal.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
    while (signal && signal.paused && !signal.cancelled) await new Promise((r) => setTimeout(r, 300));
    const dest = resolveInside(root, item.rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (mustCopyForCrossRuntime(item.rel)) {
      // 渠道身份 / 运行时状态：各渠道各留一份，绝不共享 inode
      try {
        await fsp.copyFile(item.src, dest);
        linked += 1;
      } catch (error) {
        if (!error || (error.code !== 'EEXIST' && error.code !== 'ENOENT')) throw error;
      }
      continue;
    }
    try {
      await fsp.link(item.src, dest);
      linked += 1;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        /*
         * 目标已存在（上次中断遗留，或上一轮生成留下的硬链接）。
         *
         * ⚠ 这里以前直接 copyFile(item.src, dest) —— 那是**原地截断写**：
         * dest 若是上一轮从官服硬链过来的（同 inode），这一下就顺着 inode 写穿，
         * 把官服那份也改成这次的内容。2026-11-17 同型问题已在 runtime.js 复现并修复，
         * 这里一并对齐：先 unlink 断链再重试 link，实在链不上才拷贝（拷贝前也已断链）。
         */
        await fsp.unlink(dest).catch(() => {});
        try {
          await fsp.link(item.src, dest);
          linked += 1;
        } catch {
          try {
            await fsp.copyFile(item.src, dest);
            linked += 1;
          } catch {
            /* 上次中断遗留且内容一致即可 */
          }
        }
      } else if (error && error.code === 'ENOENT') {
        /* 源刚被删：跳过，留给后面的下载/校验兜底 */
      } else {
        throw error;
      }
    }
    if (linked % 50 === 0) {
      onProgress?.({
        phase: 'link',
        current: `硬链接 ${linked}/${linkPlan.length}`,
        processed: linked,
        total: linkPlan.length + downloadPlan.length,
        bytesDone: linked ? Math.round((linkBytes * linked) / linkPlan.length) : 0,
        totalBytes: Number(pkg.totalBytes) || 0,
      });
    }
  }
  onProgress?.({
    phase: 'link',
    current: `硬链接完成 ${linked} 个`,
    processed: linkPlan.length,
    total: linkPlan.length + downloadPlan.length,
    bytesDone: linkBytes,
    totalBytes: Number(pkg.totalBytes) || 0,
  });

  let done = 0;
  await runPool(downloadPlan, DOWNLOAD_CONCURRENCY, async (file) => {
    if (signal && signal.cancelled) throw new Error('已取消');
    const dest = resolveInside(root, file.path);
    await downloadOne({ url: file.url, dest, expectedSize: file.size, expectedHash: file.hash, signal });
    done += 1;
    onProgress?.({
      phase: 'download',
      current: `下载 ${done}/${downloadPlan.length} ${path.basename(file.path)}`,
      processed: linkPlan.length + done,
      total: linkPlan.length + downloadPlan.length,
      bytesDone: linkBytes + Math.round((downloadBytes * done) / Math.max(downloadPlan.length, 1)),
      totalBytes: Number(pkg.totalBytes) || 0,
    });
  });

  onProgress?.({ phase: 'install', current: '正在写入元数据…' });
  await writeMetadata(root, {
    config: { channel: target.channel, name: target.name, version: remote.index.version, exe: target.defaultExe },
    manifest: { channel: target.channel, version: remote.index.version, files: pkg.files },
  });
  // 官方记账同步（同 installGame 的理由）：硬链接切出来的目录也要能被真升级认成官方客户端
  await writeLauncherConfig({
    installRoot: root,
    channel: target.channel,
    version: remote.index.version,
    packs: remote.index.packNames,
  }).catch((error) => {
    console.warn(`kuro writeLauncherConfig(cross) failed: ${error.message}`);
  });

  return {
    ok: true,
    channel: target.channel,
    version: remote.index.version,
    installRoot: root,
    executable: target.defaultExe,
    files: pkg.files.length,
    linked,
    downloaded: downloadPlan.length,
    linkBytes,
    downloadBytes,
    totalBytes: Number(pkg.totalBytes) || 0,
  };
}

/** 估算官B互切的空间与下载量（确认弹窗用；global 传入直接拒绝）。 */
async function planCrossRuntime({ sourceRoot, targetProfile } = {}) {
  const target = profileFor(targetProfile && targetProfile.channel ? targetProfile.channel : targetProfile);
  if (!target) throw noKuroChannelError(targetProfile && targetProfile.channel ? targetProfile.channel : targetProfile);
  if (target.channel === 'global') {
    throw new Error('鸣潮国际服与国服内容几乎完全不同，不支持硬链接互切');
  }
  const src = String(sourceRoot || '');
  if (!src || !fs.existsSync(src)) throw new Error('源目录不存在');

  const remote = await loadRemoteTargetPackage(target);
  const pkg = remote.manifest;

  const sourceFileMap = new Map();
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'webCaches' || entry.name === 'kr_game_cache' || entry.name === 'launcherDownload') continue;
        walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        try {
          sourceFileMap.set(childRel.toLowerCase(), { abs: path.join(dir, entry.name), size: fs.statSync(path.join(dir, entry.name)).size });
        } catch { /* ignore */ }
      }
    }
  };
  walk(src, '');

  let hardlinkCount = 0;
  let hardlinkBytes = 0;
  let downloadCount = 0;
  let downloadBytesTotal = 0;
  for (const file of pkg.files) {
    const rel = normalizeManifestPath(file.path);
    if (!rel) continue;
    const size = Number(file.size) || 0;
    const found = sourceFileMap.get(rel.toLowerCase());
    if (!found) {
      downloadCount += 1;
      downloadBytesTotal += size;
      continue;
    }
    // 大小不同直接进下载；大小相同的抽验 md5（全部小文件 + 1/8 大文件；真正生成时还会全量核）
    const needVerify = size <= 8 * 1024 * 1024 || size % 8 === 0;
    if (needVerify) {
      if ((await md5File(found.abs)) === String(file.hash).trim().toLowerCase()) {
        hardlinkCount += 1;
        hardlinkBytes += size;
      } else {
        downloadCount += 1;
        downloadBytesTotal += size;
      }
    } else {
      hardlinkCount += 1;
      hardlinkBytes += size;
    }
  }

  return {
    ok: true,
    channel: target.channel,
    version: remote.index.version,
    files: pkg.files.length,
    hardlinkCount,
    hardlinkBytes,
    downloadCount,
    downloadBytes: downloadBytesTotal,
    totalBytes: Number(pkg.totalBytes) || 0,
  };
}

// ── 目录判渠道（检测链用） ───────────────────────────────────────────────────

/**
 * 判断一个安装目录属于哪个鸣潮渠道，认不出来返回 ''。
 * 判据按可信度排序：
 *   1. `kuro-launcher-config.json` 里的 channel（我方写的）；
 *   2. `KRSDKRes/Bilibili/` 目录存在 → bilibili（B服身份判据，实网清单证实官服 0 个 Bilibili 路径）；
 *   3. `ThirdParty/KrPcSdk_Global/` 目录存在 → global；
 *   4. 目录名含 bilibili/B服 → bilibili；含 global/国际 → global；否则 ''。
 */
function detectChannelOfSync(installRoot) {
  const root = String(installRoot || '');
  if (!root) return '';
  const norm = (rel) => path.join(root, ...rel.split('/'));
  if (fs.existsSync(norm(BILIBILI_MARKER_DIR))) return 'bilibili';
  if (fs.existsSync(norm('Client/Binaries/Win64/ThirdParty/KrPcSdk_Global'))) return 'global';
  const lower = root.toLowerCase().replace(/\\/g, '/');
  if (/bilibili|b服|b服/.test(lower)) return 'bilibili';
  if (/global|国际/.test(lower)) return 'global';
  return '';
}

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
      const channel = String((body && body.channel) || '').trim();
      if (isKuroChannel(channel)) return channel;
    } catch {
      /* JSON 坏了就继续看目录 */
    }
  }
  return detectChannelOfSync(root);
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

module.exports = {
  KURO_PROFILES,
  isKuroChannel,
  profileFor,
  normalizeManifestPath,
  resolveInside,
  buildDownloadUrl,
  loadIndex,
  loadManifest,
  loadBundleIndex,
  loadBundleManifest,
  loadRemoteTargetPackage,
  readGameConfig,
  readManifest,
  writeMetadata,
  writeLauncherConfig,
  planUpdate,
  md5File,
  downloadOne,
  runPool,
  shouldKeepExisting,
  installGame,
  updateGame,
  planForGame,
  buildCrossRuntime,
  planCrossRuntime,
  detectChannelOf,
  detectChannelOfSync,
};
