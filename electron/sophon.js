'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { hardlinkTree, removeTreeResilient } = require('./runtime');
const { httpFetch, nodeRequest, directFetch, segmentFetch } = require('./http-fetch');
const { multiDownload } = require('./multi-download');
const linkSource = require('./link-source');
const clientChannel = require('./client-channel');
const netThrottle = require('./net-throttle');
const diskSpace = require('./disk-space');

const API = {
  cn: 'https://hyp-api.mihoyo.com/hyp/hyp-connect/api',
  global: 'https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api',
  buildCn: 'https://downloader-api.mihoyo.com/downloader/sophon_chunk/api/getBuild',
  buildGlobal: 'https://sg-downloader-api.hoyoverse.com/downloader/sophon_chunk/api/getBuild',
};

const CHANNELS = {
  genshin: {
    official: { launcher: 'jGHBHlcOq1', game: '1Z8W5NHUQb', server: 'cn' },
    bilibili: { launcher: 'umfgRO5gh5', game: 'T2S0Gz4Dr2', server: 'cn' },
    global: { launcher: 'VYTpXlbWo8', game: 'gopR6Cufr3', server: 'global' },
  },
  starrail: {
    official: { launcher: 'jGHBHlcOq1', game: '64kMb5iAWu', server: 'cn' },
    bilibili: { launcher: '6P5gHMNyK3', game: 'EdtUqXfCHh', server: 'cn' },
    global: { launcher: 'VYTpXlbWo8', game: '4ziysqXOQ8', server: 'global' },
  },
  zzz: {
    official: { launcher: 'jGHBHlcOq1', game: 'x6znKlJ0xK', server: 'cn' },
    bilibili: { launcher: 'xV0f4r1GT0', game: 'HXAFlmYa17', server: 'cn' },
    global: { launcher: 'VYTpXlbWo8', game: 'U5hbdsT9W7', server: 'global' },
  },
  /*
   * 崩坏3 官服：同一个 HoYoPlay 启动器接口体系，game_id 从
   * getAllGameBasicInfo(launcher_id=jGHBHlcOq1) 的 biz=bh3_cn 条目实测拿到。
   * B服不在 HoYoPlay 分发体系里（走 B 站自有启动器），国际服 game_id 在
   * sg-hyp-api 里有多条 bh3_global 无法唯一定位 —— 一键下载只接官服。
   */
  bh3: {
    official: { launcher: 'jGHBHlcOq1', game: 'osvnlOc0S8', server: 'cn' },
  },
};

const EXE_NAMES = {
  genshin: ['YuanShen.exe', 'GenshinImpact.exe'],
  starrail: ['StarRail.exe'],
  zzz: ['ZenlessZoneZero.exe'],
  bh3: ['BH3.exe'],
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function readVarint(buffer, position) {
  let value = 0;
  let shift = 0;
  let index = position;
  while (index < buffer.length) {
    const byte = buffer[index];
    index += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, index];
    shift += 7;
  }
  throw new Error('protobuf varint 越界');
}

function readFields(buffer) {
  const fields = [];
  let position = 0;
  while (position < buffer.length) {
    let tag;
    [tag, position] = readVarint(buffer, position);
    const number = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let value;
      [value, position] = readVarint(buffer, position);
      fields.push({ number, wire, value });
    } else if (wire === 2) {
      let length;
      [length, position] = readVarint(buffer, position);
      const value = buffer.subarray(position, position + length);
      position += length;
      fields.push({ number, wire, value });
    } else if (wire === 1) {
      fields.push({ number, wire, value: buffer.subarray(position, position + 8) });
      position += 8;
    } else if (wire === 5) {
      fields.push({ number, wire, value: buffer.subarray(position, position + 4) });
      position += 4;
    } else {
      throw new Error(`不支持的 protobuf wire type ${wire}`);
    }
  }
  return fields;
}

function asText(field) {
  return field && field.wire === 2 ? field.value.toString('utf8') : '';
}

function decodeChunk(buffer) {
  const fields = readFields(buffer);
  const get = (number) => fields.find((field) => field.number === number);
  return {
    id: asText(get(1)),
    uncompressedMd5: asText(get(2)),
    offset: Number(get(3)?.value || 0),
    compressedSize: Number(get(4)?.value || 0),
    uncompressedSize: Number(get(5)?.value || 0),
    compressedMd5: asText(get(7)),
  };
}

function decodeManifest(buffer) {
  const files = [];
  for (const field of readFields(buffer)) {
    if (field.number !== 1 || field.wire !== 2) continue;
    const item = readFields(field.value);
    const get = (number) => item.find((entry) => entry.number === number);
    files.push({
      file: asText(get(1)),
      isFolder: Boolean(get(3)?.value),
      size: Number(get(4)?.value || 0),
      md5: asText(get(5)),
      chunks: item
        .filter((entry) => entry.number === 2 && entry.wire === 2)
        .map((entry) => decodeChunk(entry.value)),
    });
  }
  return files;
}

function md5Buffer(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/*
 * ── 官方「这些资源不用下」的黑名单 ─────────────────────────────────────────
 *
 * 官方客户端自己会在一份清单里写明「这次更新不要下这些文件」，米哈游那边是
 * 「剔除旧资源」，鹰角那边是分卷整包用不上。我们以前完全不看这份清单——
 * 官方主动说别下的东西，我们照下不误，白白多占流量和磁盘。
 *
 * 两份黑名单的格式完全不同，必须分开处理：
 *   星穹铁道：<安装目录>\StarRail_Data\Persistent\DownloadBlacklist.json
 *             JSON Lines，每行一个对象，取其中 "fileName":"..." 的路径；
 *             这些路径同时对应 StreamingAssets\ 与 Persistent\ 两个前缀。
 *   绝区零：  <安装目录>\ZenlessZoneZero_Data\Persistent\KDelResource
 *             纯文本，一行一项，但匹配的是清单里的 matching_field（分类名，
 *             比如 10108），不是路径。
 *
 * 关键设计：这份东西只用来「少下一部分文件」，一旦读不懂就必须当作没有，
 * 绝不能因为黑名单格式变了就漏下该下的文件把游戏弄坏。所以整个函数
 * try/catch 包死，任何异常/空文件/格式不符都返回 active: false。
 */
function loadDeletedAssets(installRoot, gameKey) {
  const inactive = { active: false, paths: null, fields: null, count: 0, source: '' };
  try {
    if (!installRoot) return inactive;

    if (gameKey === 'starrail') {
      const file = path.join(installRoot, 'StarRail_Data', 'Persistent', 'DownloadBlacklist.json');
      if (!fs.existsSync(file)) return inactive;
      const text = fs.readFileSync(file, 'utf8');
      if (!text.trim()) return inactive;
      const names = new Set();
      for (const line of text.split(/\r?\n/)) {
        const at = line.indexOf('"fileName":"');
        if (at === -1) continue;
        const rest = line.slice(at + '"fileName":"'.length);
        const end = rest.indexOf('"');
        if (end <= 0) continue;
        const name = rest.slice(0, end).replace(/\\\\/g, '/').replace(/^\/+/, '');
        if (!name) continue;
        // 同一条记录要在两个根目录下都算数
        names.add(`StarRail_Data/StreamingAssets/${name}`);
        names.add(`StarRail_Data/Persistent/${name}`);
      }
      if (!names.size) return inactive;
      return { active: true, paths: names, fields: null, count: names.size, source: file };
    }

    if (gameKey === 'zzz') {
      const dir = path.join(installRoot, 'ZenlessZoneZero_Data', 'Persistent');
      const file = path.join(dir, 'KDelResource');
      if (!fs.existsSync(file)) return inactive;
      const text = fs.readFileSync(file, 'utf8').trim();
      if (!text) return inactive;
      // 官方这是 JSON（{"version":2,"delete":[],"download":[]}），但旧版本是纯文本。
      // 两种都认；认不出来就当没有。
      const fields = new Set();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object') {
        const list = Array.isArray(parsed.delete) ? parsed.delete : null;
        if (!list) return inactive;
        for (const entry of list) {
          const value = typeof entry === 'object' && entry ? entry.field || entry.matchingField || entry.name : entry;
          const text2 = String(value ?? '').trim();
          if (text2) fields.add(text2);
        }
      } else {
        for (const line of text.split(/\r?\n/)) {
          const value = line.trim();
          if (value) fields.add(value);
        }
      }
      if (!fields.size) return inactive;
      return { active: true, paths: null, fields, count: fields.size, source: file };
    }

    return inactive;
  } catch {
    // 读不动就当没有：宁可多下几个文件，也不能漏下
    return inactive;
  }
}

/**
 * 按上面读到的黑名单判断一个清单条目要不要跳过。
 *
 * @param {object} deleted loadDeletedAssets() 的返回值
 * @param {{file?: string, matchingField?: string}} item 清单条目
 */
function isDeletedAsset(deleted, item) {
  if (!deleted || !deleted.active || !item) return false;
  if (deleted.paths && item.file) {
    const key = String(item.file).replace(/\\/g, '/').replace(/^\/+/, '');
    if (deleted.paths.has(key)) return true;
  }
  if (deleted.fields && item.matchingField != null) {
    if (deleted.fields.has(String(item.matchingField).trim())) return true;
  }
  return false;
}

async function quickFileMatches(file, filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size !== file.size) return false;
    if (!file.chunks.length) return (await md5File(filePath)) === file.md5.toLowerCase();
    const picked = [file.chunks[0], file.chunks[file.chunks.length - 1]].filter(
      (chunk, index, list) => chunk && list.findIndex((item) => item.id === chunk.id) === index
    );
    const handle = await fsp.open(filePath, 'r');
    try {
      for (const chunk of picked) {
        if (!chunk.uncompressedMd5 || !chunk.uncompressedSize) return false;
        const buffer = Buffer.alloc(chunk.uncompressedSize);
        await handle.read(buffer, 0, chunk.uncompressedSize, chunk.offset);
        if (md5Buffer(buffer) !== chunk.uncompressedMd5.toLowerCase()) return false;
      }
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 整份文件校验：size 对上之后把文件从头到尾读一遍算 md5。
 *
 * 只在「修复」这条路径上传 true。按分块清单的正常更新用 quickFileMatches 就够——
 * 那是我们上一轮自己按 chunk 写下去、md5 已经验过的文件；而修复要查的是「本来完好、
 * 后来被磁盘/杀软/半途关机弄坏了」的文件，那种损坏经常落在中间某个分块上。
 * 代价是整盘读一遍（原神 130 GB 级别），所以必须由调用方显式开启。
 */
async function fullFileMatches(file, filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size !== file.size) return false;
    const expected = String(file.md5 || '').toLowerCase();
    if (!expected) return true;
    return (await md5File(filePath)) === expected;
  } catch {
    return false;
  }
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const normalized = path.resolve(root);
  if (target !== normalized && !target.startsWith(`${normalized}${path.sep}`)) {
    throw new Error(`清单包含非法路径：${relative}`);
  }
  return target;
}

/*
 * 接口结果的短缓存。
 *
 * 一次「生成一份」里同一份分支 / build 信息会被问两三遍：界面先按 dryRun 预估体积，
 * 真正开跑又是一遍；本地分块索引还要按「本地版本」再问一遍。每次都是三百毫秒上下的
 * 往返，纯属白等。60 秒内同一个 URL 只问一次 —— 版本号不可能在一分钟内变两次。
 */
const JSON_MEMO_TTL = 60 * 1000;
const jsonMemo = new Map();

/*
 * 读官方清单的「有限重试 + 换路」。
 *
 * 为什么需要：国际服首个接口 fetchBranch 走 sg-hyp-api.hoyoverse.com，国内访问常被
 * 对端/中间设备发 TCP RST 掐断，Node 层抛 read ECONNRESET。这类故障是瞬时的——
 * 线路抖动、机场限单 IP 并发、运营商间歇重置——隔几百毫秒换条路再问一次往往就通。
 * 而 httpFetch 的单次兜底只做「Chromium net.fetch → Node nodeRequest」一跳：它不会
 * 回过头再给 Chromium 第二次机会，也不会重新问一次 proxyTunnel.routeFor(url)。
 *
 * 换路做法（刻意不改动 http-fetch.js / proxy-agent.js 一行，避免波及 16 连接分段下载）：
 *   第 1 次 httpFetch    —— 与现状逐字一致（Chromium 优先，失败退 Node），零回归；
 *   第 2 次 nodeRequest  —— 纯 Node 栈，按域名重新选路（routeFor），和 Chromium 的
 *                            系统代理/系统证书库/DNS 解析器是另一套实现，避开 Chromium
 *                            特有的失败（TLS -101、PAC 判错、MITM 证书不认）；
 *   第 3 次 httpFetch    —— 再给 Chromium net.fetch 一次干净独立的机会，它不读
 *                            proxyTunnel 的 5 分钟熔断标记，不受上面两次失败的污染。
 * 每次都新建 AbortSignal：第一次超时后旧 signal 已经废了，不能复用。
 * 全程不调用 proxyTunnel.invalidate()——它会 destroy 在途 socket，可能打断并行下载。
 *
 * 边界：次数封顶 3 次、总耗时封顶 45s（防止 30s×3 拖成 90s 才报错），且只对瞬时
 * 连接故障重试；4xx、业务 retcode、JSON 解析失败、用户取消一律立刻冒泡——重试救不
 * 回来，只会白等并放大请求量。这些接口全是轻量 GET 且成功才写 jsonMemo，天然幂等。
 *
 * 排障可见性：httpFetch 两次尝试会经 setRequestLogger 落进诊断日志，直接 nodeRequest
 * 的那一次不落请求行（它不经 httpFetch）；重试后成功的下一次 fetchJson 仍会照常记录。
 */
const JSON_MAX_ATTEMPTS = 3;
const JSON_ATTEMPT_TIMEOUT_MS = 30000;
const JSON_TOTAL_BUDGET_MS = 45000;
const JSON_RETRY_BASE_MS = 300;
const JSON_REQUEST_FNS = [httpFetch, nodeRequest, httpFetch];

function isRetryableJsonError(error) {
  if (!error) return false;
  if (error.cancelled === true) return false; // 用户主动取消
  const text = `${error.code || ''} ${error.name || ''} ${error.message || ''}`;
  if (/\bHTTP 4\d{2}\b/.test(text)) return false; // 客户端错误，重试无意义
  if (error.retryable === true) return true; // http-fetch 的 abortFailure 标记的超时
  return /\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bECONNABORTED\b|\bEPIPE\b|\bENETRESET\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bUND_ERR_SOCKET\b|\bERR_STREAM_PREMATURE_CLOSE\b|\bAbortError\b|\bTimeoutError\b|socket hang up|fetch failed|terminated|premature close|请求超时|连接被重置|HTTP 5\d{2}/i.test(
    text
  );
}

const jsonRetryDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const hit = jsonMemo.get(url);
  if (hit && Date.now() - hit.at < JSON_MEMO_TTL) return hit.data;

  const deadline = Date.now() + JSON_TOTAL_BUDGET_MS;
  let lastError = null;
  for (let attempt = 0; attempt < JSON_MAX_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const request = JSON_REQUEST_FNS[attempt % JSON_REQUEST_FNS.length];
    try {
      const response = await request(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        // 按剩余总预算收紧单次超时：即使连续超时，整体也不会突破 45s
        signal: AbortSignal.timeout(Math.min(JSON_ATTEMPT_TIMEOUT_MS, remaining)),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}：${url}`);
      const json = await response.json();
      if (json.retcode !== 0) throw new Error(json.message || `接口返回 ${json.retcode}`);
      jsonMemo.set(url, { at: Date.now(), data: json.data });
      if (jsonMemo.size > 32) jsonMemo.delete(jsonMemo.keys().next().value);
      return json.data;
    } catch (error) {
      lastError = error;
      if (!isRetryableJsonError(error)) throw error;
      if (attempt === JSON_MAX_ATTEMPTS - 1) break;
      await jsonRetryDelay(
        Math.min(JSON_RETRY_BASE_MS * (attempt + 1), Math.max(0, deadline - Date.now()))
      );
    }
  }
  throw lastError || new Error(`读取官方清单失败：${url}`);
}

async function fetchBranch(gameKey, channel) {
  const info = CHANNELS[gameKey]?.[channel];
  if (!info) throw new Error('这个游戏没有对应的官方服务器');
  const base = info.server === 'global' ? API.global : API.cn;
  const query = `getGameBranches?launcher_id=${info.launcher}&language=zh-cn&game_ids[]=${info.game}`;
  const data = await fetchJson(`${base}/${query}`);
  const branch = (data.game_branches || []).find((item) => item.game?.id === info.game);
  if (!branch || !branch.main) throw new Error('官方没有返回这个服务器的版本分支');
  return { branch, info };
}

async function fetchBuild(info, branchPackage, tag = '') {
  const base = info.server === 'global' ? API.buildGlobal : API.buildCn;
  let query = `branch=${encodeURIComponent(branchPackage.branch)}&package_id=${encodeURIComponent(
    branchPackage.package_id
  )}&password=${encodeURIComponent(branchPackage.password)}`;
  if (tag) query += `&tag=${encodeURIComponent(tag)}`;
  return fetchJson(`${base}?${query}`);
}

/*
 * launcher_config 是官方启动器自己的配置，跟 getBuild 不是同一个接口：
 *   default_download_mode —— 实测原神/星铁/绝区零九个渠道全是 DOWNLOAD_MODE_CHUNK
 *   enable_ldiff          —— 原神 6 个渠道、星铁 6 个渠道为 true，绝区零 3 个渠道为 false
 * 也就是说 ldiff 不是「另一套下载模式」，而是叠在 chunk 之上的加速层：
 * 只有 enable_ldiff 为 true 的游戏才值得在更新前跑一遍 hdiff 预处理，否则纯属白算一遍 md5。
 * 接口失败时返回 enableLdiff:false —— 拿不到配置就不冒险，退回纯 chunk 行为。
 */
async function fetchLauncherConfig(gameKey, channel) {
  const info = CHANNELS[gameKey]?.[channel];
  const fallback = { defaultDownloadMode: '', enableLdiff: false };
  if (!info) return fallback;
  const base = info.server === 'global' ? API.global : API.cn;
  try {
    const data = await fetchJson(
      `${base}/getGameConfigs?launcher_id=${info.launcher}&language=zh-cn&game_ids[]=${info.game}`
    );
    const config = (data.launch_configs || [])[0] || {};
    return {
      defaultDownloadMode: String(config.default_download_mode || ''),
      enableLdiff: config.enable_ldiff === true,
    };
  } catch {
    return fallback;
  }
}

/*
 * 官方一份 build 里带多份清单，按 matching_field 分三类：
 *   game   —— 游戏本体，必须有
 *   zh-cn / en-us / ja-jp / ko-kr —— 语音包，按语言勾选
 *   mini-zh-cn 等 —— 语音包的「登录资源小包」视图
 *   其余（绝区零那 106 份纯数字 10108/10202/30102002/10301/20101…，
 *        category_name 是「任务▶主线▶第六章」「空洞▶棋盘事件」这类）
 *        —— 按剧目分类的补充剧情资源，合计约 19.7GB
 *
 * 语音包动辄好几个 GB，四种全下就是白占空间，所以这里只取设置里勾中的那几种。
 * matching_field 是枚举值（不是任意字符串），所以直接按白名单取，不做模糊匹配。
 *
 * mini-* 永远排除：实测 mini-zh-cn 的文件 100% 就是 zh-cn 那 80 个文件（连体积都一样），
 * 包含它只会让每种语言的体积被算两遍（4.25GB 变 8.5GB），实际不会多下一份数据。
 *
 * 分类剧情资源默认排除（options.includeStory 为 false 时），保持和以前一致的安装行为。
 */
const AUDIO_LANGUAGES = [
  ['zh-cn', '中文'],
  ['en-us', '英语'],
  ['ja-jp', '日语'],
  ['ko-kr', '韩语'],
];

const AUDIO_LANGUAGE_KEYS = new Set(AUDIO_LANGUAGES.map(([key]) => key));

const MINI_PREFIX = 'mini-';

function normalizeAudioLanguages(languages) {
  const list = Array.isArray(languages) ? languages : [];
  const picked = list
    .map((item) => String(item || '').toLowerCase())
    .filter((item) => AUDIO_LANGUAGE_KEYS.has(item));
  // 一种都不勾就退回中文：完全没语音包的话游戏里是哑的，比多下几个 GB 更难受
  return picked.length ? [...new Set(picked)] : ['zh-cn'];
}

function classifyMatchingField(field) {
  const key = String(field || '').toLowerCase();
  if (key === 'game') return 'game';
  if (AUDIO_LANGUAGE_KEYS.has(key)) return 'audio';
  if (key.startsWith(MINI_PREFIX)) return 'mini';
  // 剩下的就是按剧目分类的剧情/任务资源（绝区零的纯数字清单）
  return 'story';
}

/** 分类剧情资源的份数与体积，用于界面上单独显示「剧情资源 / 主线动画 约 19.7GB」。 */
function storyResourceSummary(build) {
  let count = 0;
  let bytes = 0;
  for (const manifest of build?.manifests || []) {
    // 崩坏3 的 asb 清单是必装数据包（已在 pickManifests 里计入总量），不按可选资源重复展示
    if (manifest.matching_field === ASB_FIELD) continue;
    if (classifyMatchingField(manifest.matching_field) !== 'story') continue;
    count += 1;
    bytes += Number(manifest.stats?.uncompressed_size || 0);
  }
  return { count, bytes };
}

/*
 * 崩坏3 的 build 里只有两份清单：game（BH3.exe + 引擎，约 1.5GB）和
 * asb（BH3_Data/StreamingAssets/Asb 数据包，约 31.8GB，matching_field 是 'asb'）。
 * asb 是必装本体的一部分，不是可选的剧情资源 —— pickManifests 把它和 game
 * 一起无条件带上；storyResourceSummary 则把它排除，避免体积被算成可选资源。
 * 米哈游三游的 build 里没有 asb 清单，这条规则对它们没有影响。
 */
const ASB_FIELD = 'asb';

function pickManifests(build, languages, options = {}) {
  const manifests = build.manifests || [];
  const game = manifests.find((item) => item.matching_field === 'game');
  if (!game) throw new Error('官方清单缺少游戏资源');
  const asb = manifests.find((item) => item.matching_field === ASB_FIELD);
  const wanted = normalizeAudioLanguages(languages);
  const includeStory = options.includeStory === true;
  const audio = manifests.filter((item) => wanted.includes(String(item.matching_field || '').toLowerCase()));
  if (!includeStory) {
    return [game, ...(asb ? [asb] : []), ...audio];
  }
  const story = manifests.filter((item) => classifyMatchingField(item.matching_field) === 'story');
  return [game, ...(asb ? [asb] : []), ...story, ...audio];
}

/**
 * 一份清单最多同时拉几份。
 *
 * 绝区零的 build 里有 120 份清单（本体 + 4 个语音包 + 115 份分类剧情资源），
 * 每份单独下都要一次往返：串行跑下来光「读清单」这一步就十秒起。这些请求彼此
 * 独立、单份又都很小，并发才是正解；限 4 是为了不把对端 CDN 打出限流。
 */
const MANIFEST_CONCURRENCY = 4;

/**
 * 同一台 CDN 上能同时开多少条连接。
 *
 * 分块和清单现在都走 node 直连（不再受浏览器「同 host 6 条 socket」的限制），
 * 但 CDN 对单 IP 仍有并发上限，所以还是在「一份分多段」和「多份并发」之间分配额度：
 *   · 清单少（原神 / 星铁 5 份）→ 每份开 6 段，大清单能快好几倍；
 *   · 清单多（绝区零 113 份）→ 每份还开 6 段的话，678 个分段请求会互相抢带宽，
 *     实测比单连接还慢（37 秒 vs 4 秒）。这时候一份占一条连接、靠并发数量吃带宽。
 * 按清单份数在这两种模式之间切换（见 manifestConnectionsFor）。
 */
const MANIFEST_CONNECTION_BUDGET = 6;

/**
 * 同一个文件里同时在下载的分块数。
 *
 * 正式安装 / 更新原来是逐块串行（下完一块写一块再发下一块），速度被单连接往返
 * 延迟卡死；官方启动器一直是多连接并发拉分块。分块走的是 node 直连，不受
 * 「同 host 6 条 socket」的限制，所以这里能真的同时开 8 条。
 *
 * 上限 16：每个分块解压后常见 1~4 MB，窗口开太大只是白占内存。
 * 网络较差或想退回逐块串行的，把 HXL_CHUNK_PREFETCH 设成 1。
 */
const CHUNK_PREFETCH = Math.max(1, Math.min(16, Number(process.env.HXL_CHUNK_PREFETCH) || 8));

/**
 * 同时在组装的文件数。
 *
 * 小文件是「每文件一次往返」，串行时带宽大量闲置（原神一次更新两千多个小文件）。
 * 4 路在实测里已能把这部分尾段时间压到原来的四分之一左右；再往上加，
 * 与分块窗口相乘的总连接数会超过 CDN 的舒适区，反而变慢。
 */
const FILE_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.HXL_FILE_CONCURRENCY) || 8));

function manifestConnectionsFor(count) {
  // 清单少（本体 + 几个语音包）：每份都开到 6 段，大清单能吃满带宽 ——
  // 原神 8.6 MB 那份实测 2.3 秒，只给 3 段就要 4.9 秒。
  if (count <= 8) return MANIFEST_CONNECTION_BUDGET;
  // 清单多（绝区零带上分类剧情共 113 份）：一份一条连接，靠并发吃带宽。
  return 1;
}

/*
 * 解码结果的内存缓存。
 *
 * 同一份清单在一次操作里会被读两三遍：体积预估（dryRun）一遍、真正安装一遍，
 * 目标清单和本地清单索引还可能指向同一个 id。解码是上万条 protobuf（原神 16 MB
 * 明文要 200 多毫秒，还要先 zstd 解压），缓存下来能省掉这些重复工作。
 * 只留当前会话用得到的十几份，不落地，进程退出就没了。
 */
const manifestMemo = new Map();
const manifestInflight = new Map();
const MANIFEST_MEMO_LIMIT = 16;

function memoManifest(id, files) {
  manifestMemo.delete(id);
  manifestMemo.set(id, files);
  while (manifestMemo.size > MANIFEST_MEMO_LIMIT) {
    manifestMemo.delete(manifestMemo.keys().next().value);
  }
  return files;
}

/** 并发跑一组任务，最多 limit 个同时进行，结果按原顺序返回。 */
async function mapLimit(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function manifestUrlOf(manifest) {
  const id = manifest.manifest.id;
  const prefix = String(manifest.manifest_download?.url_prefix || '').replace(/\/$/, '');
  return `${prefix}/${id}`;
}

/**
 * 把一份清单的压缩字节拿到手。
 *
 * 先按分段并发试（清单通常几百 KB 到十几 MB，正好落在「单连接被限速、总带宽还有
 * 富余」的区间）；服务器不认 Range、文件太小、中途断了，一律退回单连接 ——
 * 退之前必须删掉半截文件，分段是按总长预分配写各自偏移的，留下的洞不能当数据。
 */
async function downloadManifestBytes(url, cacheFile, { forceSingle = false, connections = MANIFEST_CONNECTION_BUDGET } = {}) {
  const part = `${cacheFile}.part`;
  // 只分到 1 条连接时直接走单连接：分段探测本身还要多一次往返
  if (!forceSingle && connections > 1) {
    try {
      await multiDownload({
        url,
        dest: part,
        // 分段必须用独立 socket：Chromium 栈对同 host 只开 6 条，分段等于白做
        fetchImpl: segmentFetch,
        headers: { 'user-agent': UA, accept: '*/*' },
        connections,
        minSize: 400 * 1024,
        minSegmentSize: 128 * 1024,
      });
      const buffer = await fsp.readFile(part);
      await fsp.unlink(part).catch(() => {});
      return buffer;
    } catch {
      await fsp.unlink(part).catch(() => {});
    }
  }
  const response = await httpFetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`下载清单失败：HTTP ${response.status}`);
  return netThrottle.toBuffer(response);
}

/**
 * 读一份清单：磁盘缓存 → 下载 → zstd 解压 → 校验 → 解码。
 *
 * 同一份清单被多处同时要求时只下一次（单飞），拿到后进内存缓存；校验不过说明
 * 磁盘上那份坏了，删掉重下一次，第二次强制单连接（排除分段本身的嫌疑）。
 */
async function ensureManifest(manifest, cacheDir, onProgress, label = '', connections = MANIFEST_CONNECTION_BUDGET) {
  const id = manifest.manifest.id;
  const memo = manifestMemo.get(id);
  if (memo) return memo;
  const running = manifestInflight.get(id);
  if (running) return running;

  const task = (async () => {
    await fsp.mkdir(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, id);
    const url = manifestUrlOf(manifest);
    const expected = String(manifest.manifest?.checksum || '').toLowerCase();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let compressed = null;
      if (attempt === 0) {
        try {
          compressed = await fsp.readFile(cacheFile);
        } catch {
          compressed = null;
        }
      }
      if (!compressed) {
        onProgress?.({ phase: 'manifest', current: label || id });
        compressed = await downloadManifestBytes(url, cacheFile, { forceSingle: attempt > 0, connections });
        await fsp.writeFile(cacheFile, compressed).catch(() => {});
      }
      const raw = zlib.zstdDecompressSync(compressed);
      if (!expected || md5Buffer(raw).toLowerCase() === expected) {
        return memoManifest(id, decodeManifest(raw));
      }
      // 缓存可能被截断/写坏：删掉重来一次，第二次走单连接
      await fsp.unlink(cacheFile).catch(() => {});
    }
    throw new Error('清单校验失败，缓存可能损坏');
  })();

  manifestInflight.set(id, task);
  try {
    return await task;
  } finally {
    manifestInflight.delete(id);
  }
}

/**
 * 并发读一组清单，结果按传入顺序返回。
 *
 * 安装、更新、预下载、渠道运行时都要「把一个 build 里的清单全读出来」，以前各自
 * 写了一遍串行循环 —— 绝区零带分类剧情是 113 份，串行就是 113 次往返。这里统一
 * 一份实现：按份数分配连接额度（见 manifestConnectionsFor），并允许中途取消。
 */
async function ensureManifests(manifests, cacheDir, onProgress, options = {}) {
  const { label = '读取清单', signal = null } = options;
  const list = Array.from(manifests || []);
  if (!list.length) return [];
  const perManifest = manifestConnectionsFor(list.length);
  /*
   * 份数进度要一路带着走：ensureManifest 内部也会推 manifest 事件（只有 current 没有计数），
   * 前端拿到没有计数的进度会把条打回 0。所以这里包装一层，任何内部事件都补上当前份数。
   */
  let done = 0;
  const relay = (event) =>
    onProgress?.({ ...(event || {}), phase: 'manifest', processed: done, total: list.length });
  relay({ current: `${label} 0/${list.length}` });
  return mapLimit(list, MANIFEST_CONCURRENCY, async (manifest, index) => {
    if (signal?.cancelled) return [];
    const files = await ensureManifest(
      manifest,
      cacheDir,
      relay,
      `${label} ${index + 1}/${list.length}`,
      perManifest
    );
    done += 1;
    relay({ current: `${label} ${done}/${list.length}` });
    return files;
  });
}

async function waitIfPaused(signal) {
  while (signal?.paused && !signal.cancelled) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
}

/*
 * 建「本地旧版本分块索引」：把本地已装版本的清单摊平成 chunk 哈希 → 位置。
 *
 * 更新时只有靠这张表才能「没变的 chunk 直接读本地字节」，表建不起来就退化成整文件
 * 重下 —— 用户看到的就是「一次小更新像在下整个游戏」。所以失败原因必须往上报，
 * 不能像以前那样静默返回一个空 Map。
 *
 * 返回 { index, reason }：reason 为空串表示索引可用。
 */
async function loadLocalChunkIndex({
  gameKey,
  baseRoot,
  cacheDir,
  onProgress,
  signal,
  audioLanguages,
  includeStory = false,
}) {
  const version = readGameVersion(baseRoot);
  if (!version) {
    return { index: new Map(), reason: '读不到本地版本号（config.ini 里没有 game_version）' };
  }
  const localChannel = detectLocalChannel(baseRoot);
  if (!localChannel) {
    return { index: new Map(), reason: '认不出本地客户端属于哪个渠道' };
  }
  let localBuild;
  try {
    const local = await fetchBranch(gameKey, localChannel);
    localBuild = await fetchBuild(local.info, local.branch.main, version);
  } catch (error) {
    return {
      index: new Map(),
      reason: `查不到本地 ${version} 的官方清单（${error.message}）`,
    };
  }
  // 本地版本清单必须和目标版本清单用同一个 includeStory 取值，否则两边的文件集合对不上，
  // chunk 级别的去重就会错位（该复用的 chunk 找不到源，白白重下）。
  const manifests = pickManifests(localBuild, audioLanguages, { includeStory });
  let lists;
  try {
    // 本地版本这几份清单和目标版本那几份互不相干，各拉各的、并发跑（原神来一次就 5 份）
    lists = await ensureManifests(manifests, cacheDir, onProgress, {
      label: '读取本地清单',
      signal,
    });
  } catch (error) {
    // 本地清单读失败不该让整次更新失败：拿不到基准就按完整包下，但要说清为什么
    return { index: new Map(), reason: `本地 ${version} 的清单读取失败（${error.message}）` };
  }
  const index = new Map();
  for (const files of lists) {
    for (const file of files) {
      if (file.isFolder || !file.chunks?.length) continue;
      for (const chunk of file.chunks) {
        if (!chunk.uncompressedMd5) continue;
        if (!index.has(chunk.uncompressedMd5)) {
          index.set(chunk.uncompressedMd5, {
            file: file.file,
            offset: chunk.offset,
            size: chunk.uncompressedSize,
          });
        }
      }
    }
  }
  if (!index.size) {
    return { index, reason: `本地 ${version} 的清单里没有可复用的分块` };
  }
  return { index, reason: '' };
}

/*
 * 同一个本地文件只开一个读句柄。
 *
 * 缓存里存的是 Promise：分块预取会把同一个文件的多个分块同时递进来，如果按
 * 「先查再开」的写法，这几路会同时判定「没有句柄」而各开一个，既泄漏句柄，
 * 后面的分块也拿不到已打开的那个。
 */
function localHandleFor(localPath, handles) {
  const existing = handles.get(localPath);
  if (existing) return existing;
  const task = fsp.open(localPath, 'r').catch((error) => {
    handles.delete(localPath);
    throw error;
  });
  handles.set(localPath, task);
  return task;
}

async function readLocalChunk(baseRoot, entry, chunk, handles) {
  if (!entry || entry.size !== chunk.uncompressedSize) return null;
  const localPath = safeJoin(baseRoot, entry.file);
  let handle;
  try {
    handle = await localHandleFor(localPath, handles);
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(chunk.uncompressedSize);
    const { bytesRead } = await handle.read(buffer, 0, chunk.uncompressedSize, entry.offset);
    if (bytesRead !== chunk.uncompressedSize) return null;
    if (md5Buffer(buffer) !== chunk.uncompressedMd5.toLowerCase()) return null;
    return buffer;
  } catch {
    return null;
  }
}
async function downloadChunk(chunk, prefix, signal) {
  const url = `${prefix.replace(/\/$/, '')}/${chunk.id}`;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitIfPaused(signal);
    if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
    try {
      // 直连优先：Chromium 栈同 host 只有 6 条 socket，文件级并发开到 16 也只剩 6 条在跑。
      // 直连不通（靠代理出网）时 directFetch 自己退回 Chromium 栈。
      const response = await directFetch(url, {
        headers: { 'user-agent': UA, accept: '*/*' },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const compressed = await netThrottle.toBuffer(response);
      if (chunk.compressedMd5 && md5Buffer(compressed) !== chunk.compressedMd5.toLowerCase()) {
        throw new Error('分块压缩数据校验失败');
      }
      const raw = zlib.zstdDecompressSync(compressed);
      if (chunk.uncompressedMd5 && md5Buffer(raw) !== chunk.uncompressedMd5.toLowerCase()) {
        throw new Error('分块解压数据校验失败');
      }
      return raw;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw new Error(`分块下载失败 ${chunk.id}：${lastError?.message || '未知错误'}`);
}

/*
 * 带持久缓存的分块获取：先查 sophon-cache/chunks/<md5>，命中就直接读盘（跳过网络）；
 * 未命中才下载，并 best-effort 落盘进缓存（下次更新 / 跨游戏复用同一分块时零流量）。
 * 缓存写入失败不影响安装，只是少了一次复用机会。
 */
async function fetchChunk(chunk, prefix, chunkCacheDir, signal) {
  if (chunkCacheDir && chunk.uncompressedMd5) {
    const cachePath = path.join(chunkCacheDir, chunk.uncompressedMd5);
    try {
      const cached = await fsp.readFile(cachePath);
      if (md5Buffer(cached) === chunk.uncompressedMd5.toLowerCase()) {
        return { raw: cached, fromCache: true };
      }
    } catch {
      /* 缓存未命中或已损坏，走网络 */
    }
  }
  const raw = await downloadChunk(chunk, prefix, signal);
  if (chunkCacheDir && chunk.uncompressedMd5) {
    try {
      await fsp.mkdir(chunkCacheDir, { recursive: true });
      const tmp = path.join(chunkCacheDir, `${chunk.uncompressedMd5}.tmp`);
      await fsp.writeFile(tmp, raw);
      await fsp.rename(tmp, path.join(chunkCacheDir, chunk.uncompressedMd5));
    } catch {
      /* 缓存写失败不影响安装 */
    }
  }
  return { raw, fromCache: false };
}

async function installChannelSdk(info, targetRoot, cacheDir, onProgress, signal) {
  if (!info || !info.launcher || !info.game) return '';
  const query =
    `getGameChannelSDKs?launcher_id=${info.launcher}&language=zh-cn&channel=14&sub_channel=0` +
    `&game_ids[]=${info.game}`;
  const data = await fetchJson(`${API.cn}/${query}`);
  const sdk = (data.game_channel_sdks || [])[0];
  if (!sdk || !sdk.channel_sdk_pkg) return '';
  const pkg = sdk.channel_sdk_pkg;
  const fileName = path.basename(new URL(pkg.url).pathname) || 'channel-sdk.zip';
  await fsp.mkdir(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, fileName);
  let buffer = null;
  try {
    buffer = await fsp.readFile(cacheFile);
  } catch {
    buffer = null;
  }
  if (!buffer) {
    onProgress?.({ phase: 'manifest', current: '下载 B服渠道 SDK' });
    const response = await httpFetch(pkg.url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`渠道 SDK 下载失败：HTTP ${response.status}`);
    buffer = await netThrottle.toBuffer(response);
    if (pkg.md5 && md5Buffer(buffer) !== String(pkg.md5).toLowerCase()) {
      throw new Error('渠道 SDK 校验失败');
    }
    await fsp.writeFile(cacheFile, buffer);
  }
  if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
  /*
   * 解压前先把目标目录里的同名条目删掉。
   *
   * Expand-Archive -Force 是原地覆盖写：如果那份文件是上次生成时从官服客户端硬链接
   * 过来的，覆盖会顺着 inode 把官服里的同一份 SDK 也改掉（B服 SDK 打进官服目录，
   * 官服启动就会带着 B站渠道进游戏）。只删 zip 里真实存在的条目，不做整目录清理。
   */
  const zipPath = cacheFile.replace(/'/g, "''");
  const outPath = targetRoot.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath}')`,
    'try {',
    '  foreach ($entry in $zip.Entries) {',
    `    $p = Join-Path '${outPath}' $entry.FullName`,
    '    if (Test-Path -LiteralPath $p -PathType Leaf) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }',
    '  }',
    '} finally { $zip.Dispose() }',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outPath}' -Force`,
  ].join('; ');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 180000,
  });
  return String(sdk.version || '');
}

/**
 * 生成 config.ini。
 *
 * 关键：cps 决定服务端把客户端算到哪个渠道。
 * 之前 B服也写 hyp_mihoyo，导致用 B服 SDK 登录后仍被识别成官服，必须分开：
 *   - 官服 cn  ：cps=hyp_mihoyo,      channel=1
 *   - B服      ：cps=bilibili,        channel=14, sub_channel=0
 *   - 国际服   ：cps=hyp_hoyoverse,   channel=1
 */
/*
 * 往运行时目录写文件时要先删再写。
 * 运行时里的文件多半是 hardlinkTree 从基础客户端硬链接过来的（同一个 inode），
 * 直接 writeFile 会原地截断，把玩家的基础客户端也改掉。
 */
async function writeFileIsolated(target, content) {
  await fsp.rm(target, { force: true });
  await fsp.writeFile(target, content, 'utf8');
}

/**
 * 覆盖写之前先把硬链接断开。
 *
 * 运行时目录里的文件绝大多数是从基础客户端硬链接过来的**同一个 inode**。
 * 直接 open(target, 'w') + truncate 会顺着 inode 把基础客户端那一份一起截断改写 ——
 * 现实里的表现是「更新过国际服之后，官服的文件变成了国际服的版本」，官服一启动
 * 就校验失败，而用户完全想不到是更新另一个服造成的。
 *
 * 先 unlink 再新建：两边从此各持一份，谁更新都不影响对方。
 * 只读属性的包体（从压缩包解出来的）先去掉只读，否则 Windows 上 unlink 会 EPERM。
 */
async function openForWrite(target) {
  try {
    await fsp.unlink(target);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      await fsp.chmod(target, 0o666).catch(() => {});
      await fsp.unlink(target).catch(() => {});
    }
  }
  return fsp.open(target, 'w');
}

function channelConfig(gameKey, channel, tag, sdkVersion = '') {
  const biz = {
    genshin: channel === 'global' ? 'hk4e_global' : 'hk4e_cn',
    starrail: channel === 'global' ? 'hkrpg_global' : 'hkrpg_cn',
    zzz: channel === 'global' ? 'nap_global' : 'nap_cn',
    // 崩坏3 一键下载只接官服，固定 bh3_cn
    bh3: 'bh3_cn',
  }[gameKey];

  let cps = 'hyp_mihoyo';
  let sub = 1;
  let out = 1;
  if (channel === 'global') {
    cps = 'hyp_hoyoverse';
    sub = 0;
    out = 1;
  } else if (channel === 'bilibili') {
    cps = 'bilibili';
    sub = 0;
    out = 14;
  }

  return `[General]\nsub_channel=${sub}\nsdk_version=${sdkVersion}\npredownload=\ngame_version=${tag}\ngame_biz=${biz}\ncps=${cps}\nchannel=${out}\n`;
}

/*
 * 读本地客户端的 game_version。
 *
 * 必须编码自适应：国际服的 config.ini 有 UTF-16 的版本，用 utf8 直读拿到的是乱码，
 * 版本号匹配不上，就等于「不知道本地装的是哪个版本」—— 更新时建不出本地分块索引，
 * 没变的分块也得整份重下，表现出来就是「更新像在下整个游戏」。
 */
function readGameVersion(root) {
  const config = clientChannel.readClientConfig(root);
  if (!config) return '';
  return String(config.fields.get('game_version') || '').trim();
}

/*
 * 判本地客户端属于哪个渠道，口径交给 client-channel，和界面上的渠道判定同源。
 *
 * 以前这里自带一份正则、兜底硬猜 'official'：国际服 ini 读不出来 → 猜成官服 →
 * 拿官服的分支参数去找国际服的版本 tag → 查不到 → 本地索引为空 → 全量下载。
 * 现在判不出就返回 ''，调用方保留原渠道，不硬猜。
 */
function detectLocalChannel(root) {
  const config = clientChannel.readClientConfig(root);
  if (config) {
    const byIni = clientChannel.classifyIni(config.fields);
    if (byIni) return byIni;
  }
  return clientChannel.pathChannelHint(String(root || ''));
}

async function prepareBilibiliRuntime({
  gameKey,
  baseRoot,
  targetRoot,
  cacheDir,
  onProgress,
  signal,
}) {
  if (!fs.existsSync(baseRoot)) throw new Error('基础客户端目录不存在');
  onProgress?.({ phase: 'clean', current: '清理上次残留的运行时目录…' });
  const stalePath = await removeTreeResilient(targetRoot);
  if (stalePath) {
    onProgress?.({
      phase: 'clean',
      current: `旧目录删不干净，已改名放行：${path.basename(stalePath)}`,
    });
  }
  await fsp.mkdir(targetRoot, { recursive: true });
  const linked = await hardlinkTree({
    sourceRoot: baseRoot,
    targetRoot,
    signal,
    onProgress: (progress) =>
      onProgress?.({
        phase: 'link',
        processed: progress.processed,
        total: progress.total,
        linked: progress.linked,
        copied: progress.copied,
        current: progress.current,
      }),
  });
  const info = CHANNELS[gameKey].bilibili;
  const sdkVersion = await installChannelSdk(info, targetRoot, cacheDir, onProgress, signal);
  const tag = readGameVersion(baseRoot) || '0.0.0';
  await writeFileIsolated(
    path.join(targetRoot, 'config.ini'),
    channelConfig(gameKey, 'bilibili', tag, sdkVersion)
  );
  const executable = EXE_NAMES[gameKey]
    .map((name) => path.join(targetRoot, name))
    .find((file) => fs.existsSync(file));
  return {
    ok: true,
    tag,
    files: linked.total,
    totalBytes: 0,
    linked: linked.linked,
    downloaded: 0,
    skipped: linked.copied,
    targetRoot,
    executable: executable || '',
  };
}

async function prepareSophon({
  gameKey,
  channel,
  baseRoot,
  targetRoot,
  cacheDir,
  onProgress,
  signal,
  dryRun = false,
  limitFiles = 0,
  maxFileSize = 0,
  audioLanguages,
  includeStoryResources = false,
  /*
   * 同一台机器上另外几份同一款游戏的客户端根目录（官服 / B服 / 国际服 各一份）。
   * 清单里内容完全相同的文件直接从那边硬链接过来，不再下载。
   */
  linkSources = [],
  /*
   * 是否把每个文件整份读一遍算 md5（修复专用）。
   *
   * 默认的 quickFileMatches 只比首尾两个分块：原神 2795 个文件里有 1951 个是多分块
   * 大文件（平均 40 块），中间某块坏了根本看不出来，「修复」会把它当成完好的跳过。
   * 更新走快速判定没问题（版本号对得上、文件是我们自己刚写进去的），但用户点「修复」
   * 就是来查这种坏的，所以这条路径要能开全量校验。
   */
  verifyAll = false,
}) {
  if (!CHANNELS[gameKey]?.[channel]) throw new Error('这个服务器没有 Sophon 清单');
  if (!fs.existsSync(baseRoot)) throw new Error('基础客户端目录不存在');
  const { branch, info } = await fetchBranch(gameKey, channel);
  const tag = branch.main.tag;
  onProgress?.({ phase: 'version', tag, current: `目标版本 ${tag}` });
  const build = await fetchBuild(info, branch.main);
  const manifests = pickManifests(build, audioLanguages, { includeStory: includeStoryResources });
  /*
   * 目标清单和本地分块索引并行拉。
   *
   * 这两件事互相不依赖：本地索引只看「本地客户端装的是哪个版本」，跟目标版本无关。
   * 以前是先串行把目标清单全拉完、打完包，再去问一遍本地版本 —— 原神那 5 份清单
   * 加上本地那一份，等于把同样的往返走了两遍。并行之后这一步的总耗时从「两倍」
   * 降到「较慢的那一路」。
   */
  onProgress?.({ phase: 'manifest', current: `读取官方清单（${manifests.length} 份）与本地索引…` });
  /*
   * 就地更新（baseRoot === targetRoot）也要建本地分块索引：
   * 以往这里直接给空 Map，导致「更新已有客户端」会重新下载全部分块，明明没变的分块也白下。
   * 现在总是按旧版本清单建索引，写文件时未变的分块直接复用本地字节（reusedChunks），
   * 这正是 Starward 的「就地更新复用旧版 chunk」思路。索引读取失败会自动回退到空 Map（全量下载）。
   */
  const localIndexTask = loadLocalChunkIndex({
    gameKey,
    audioLanguages,
    includeStory: includeStoryResources,
    baseRoot,
    cacheDir,
    onProgress,
    signal,
  });

  // 多份清单并发下：绝区零一次 120 份，串行光排队就要十秒
  const lists = await ensureManifests(manifests, cacheDir, onProgress, { label: '读取清单' });
  /*
   * 官方黑名单（「这些资源这次不用下」）。修复路径必须豁免：用户点「修复」就是
   * 想把文件补全，这时候还按黑名单跳过，等于修不干净。
   */
  const deleted = verifyAll ? { active: false } : loadDeletedAssets(baseRoot, gameKey);
  let deletedSkipped = 0;
  const files = new Map();
  for (let index = 0; index < manifests.length; index += 1) {
    const prefix = manifests[index].chunk_download?.url_prefix || '';
    // matching_field 挂在清单上（绝区零黑名单按它匹配），不在单个文件条目里
    const matchingField = manifests[index].matching_field;
    for (const item of lists[index]) {
      if (!item.file) continue;
      if (files.has(item.file)) continue;
      if (deleted.active && isDeletedAsset(deleted, { file: item.file, matchingField })) {
        deletedSkipped += 1;
        continue;
      }
      files.set(item.file, { ...item, chunkPrefix: prefix, matchingField });
    }
  }
  if (deleted.active && deletedSkipped > 0) {
    onProgress?.({
      phase: 'manifest',
      current: `官方清单标了 ${deletedSkipped} 个资源本次不用下，已跳过`,
      deletedSkipped,
    });
  }

  const localIndex = await localIndexTask;
  const localChunks = localIndex.index;
  /*
   * 没有本地基准时明确说出来。
   * 以前这一步是静默的：索引建不起来照样跑，只是所有改动过的文件都要整份重下，
   * 用户看到几十 GB 往下走，却没有任何地方解释为什么，只能猜「是不是在下整个游戏」。
   */
  if (!localChunks.size) {
    onProgress?.({
      phase: 'manifest',
      current: `没有可复用的本地分块：${localIndex.reason}，本次按完整包下载`,
      localBaseMissing: true,
    });
  }

  let normalized = [];
  for (const file of files.values()) {
    if (!file.isFolder && !file.chunks.length) continue;
    if (maxFileSize > 0 && !file.isFolder && file.size > maxFileSize) continue;
    normalized.push(file);
  }
  normalized.sort((a, b) => a.file.localeCompare(b.file));
  if (limitFiles > 0) normalized.splice(limitFiles);
  const total = normalized.length;
  const totalBytes = normalized.reduce((sum, file) => sum + (file.isFolder ? 0 : file.size), 0);
  let processed = 0;
  let linked = 0;
  let downloaded = 0;
  let skipped = 0;
  let reusedChunks = 0;
  let cacheHits = 0;
  let externalLinked = 0;
  let externalBytes = 0;
  let bytesDone = 0;
  // 真正从网络下来的字节（压缩态）。bytesDone 是「已就位」，含跳过/硬链接/复用，
  // 两者对照才能看出「这次到底下了多少」，而不是只有一个看起来像全量的分母。
  let netBytes = 0;
  const localHandles = new Map();

  if (dryRun) {
    // storyResources 单独列出去：这部分是可选的补充剧情资源（约 19.7GB），
    // 界面要能单独显示「剧情资源 / 主线动画」，不能混进基础的 totalBytes。
    return {
      ok: true,
      dryRun: true,
      tag,
      files: total,
      totalBytes,
      storyResources: storyResourceSummary(build),
      // 预估阶段就把「有没有本地基准」带出去：没有基准等于要整包下，界面要能提前提示
      localBaseMissing: !localChunks.size,
      localBaseReason: localIndex.reason || '',
      targetRoot,
    };
  }

  await fsp.mkdir(targetRoot, { recursive: true });
  /*
   * 空间粗筛：只有「没有可复用的本地分块」时才敢按清单全量算 —— 那种情况每个字节
   * 都要从网络下来再写盘，总量是确定的。有本地基准时真实增量要逐个文件比对才知道，
   * 此时不能按全量拒绝（否则 140GB 的清单会把「其实只需几 GB」的正常更新误拦），
   * 交给下面的运行中守卫兜底。
   */
  await diskSpace.assertRoom({
    dir: targetRoot,
    needBytes: localChunks.size ? 0 : totalBytes,
    label: '游戏所在盘',
  });
  /*
   * 运行中守卫：目标盘和分块缓存盘可能不是同一个卷，两个都盯。
   * 有本地基准时是就地覆盖，占用不涨，只留安全余量；没有基准时整份文件都是新写，
   * 必须按文件大小算。检查按时间节流，两万多个文件不会产生两万次 statfs。
   */
  const spaceGuard = diskSpace.createSpaceGuard({
    // 这里不能复用下面的 chunkCacheDir 变量：它声明在更靠后的位置，
    // 写在这里会撞上暂时性死区（ReferenceError）。口径保持一致即可。
    dirs: [targetRoot, cacheDir ? path.join(cacheDir, 'chunks') : ''],
    label: '游戏所在盘',
  });
  /*
   * 跨客户端复用源：同一台机器上还装着别的渠道的同一款游戏时，
   * 官方同一个构建产物的资源包往往逐字节相同，直接硬链接过来即可，
   * 不必再下一遍（官服 7.2 + 国际服 7.1 要更新到 7.2，就是这种局面）。
   * 同卷是硬链接的硬限制，跨卷的源在这里就被筛掉了。
   */
  const externalRoots = linkSource.usableSources(linkSources, {
    targetRoot,
    excludeRoots: [baseRoot],
  });
  if (externalRoots.length) {
    onProgress?.({
      phase: 'install',
      processed: 0,
      total,
      linked,
      downloaded,
      skipped,
      reusedChunks,
      cacheHits,
      externalLinked,
      bytesDone,
      totalBytes,
      current: `发现 ${externalRoots.length} 份同款客户端，内容相同的文件直接复用`,
    });
  }
  // 持久分块缓存目录：sophon-cache/chunks/<md5>，跨版本 / 跨游戏复用同一分块时不再走网络
  const chunkCacheDir = cacheDir ? path.join(cacheDir, 'chunks') : '';
  // 需要重新组装（走网络 / 分块复用）的文件，判定阶段收集、组装阶段并发跑
  const pendingFiles = [];
  for (const file of normalized) {
    if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
    await waitIfPaused(signal);
    const target = safeJoin(targetRoot, file.file);
    let source = safeJoin(baseRoot, file.file);
    processed += 1;
    if (file.isFolder) {
      await fsp.mkdir(target, { recursive: true });
      onProgress?.({ phase: 'install', processed, total, linked, downloaded, skipped, reusedChunks, cacheHits, bytesDone, totalBytes, current: file.file });
      continue;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });

    let targetValid = false;
    try {
      targetValid = verifyAll ? await fullFileMatches(file, target) : await quickFileMatches(file, target);
    } catch {
      targetValid = false;
    }
    if (targetValid) {
      skipped += 1;
      bytesDone += file.size;
      onProgress?.({ phase: 'install', processed, total, linked, downloaded, skipped, reusedChunks, cacheHits, bytesDone, totalBytes, current: file.file });
      continue;
    }

    // 单分块文件 + 持久分块缓存命中：直接从缓存硬链接落地（同卷瞬时，跨卷退化为常规写盘）。
    // 「分块缓存 + chunk 级硬链接」的落点：跨版本 / 跨游戏复用的分块不再走网络，也不读回内存再写。
    if (file.chunks.length === 1 && chunkCacheDir) {
      const only = file.chunks[0];
      const cachePath = path.join(chunkCacheDir, only.uncompressedMd5);
      try {
        await fsp.access(cachePath);
        await fsp.unlink(target).catch(() => {});
        await fsp.link(cachePath, target);
        if (await quickFileMatches(file, target)) {
          linked += 1;
          cacheHits += 1;
          bytesDone += file.size;
          onProgress?.({ phase: 'install', processed, total, linked, downloaded, skipped, reusedChunks, cacheHits, bytesDone, totalBytes, current: file.file });
          continue;
        }
        await fsp.unlink(target).catch(() => {});
      } catch {
        /* 缓存没有该分块，或硬链接失败（跨卷 / 权限），走常规流程 */
      }
    }

    // 就地更新时 source 与 target 是同一文件，硬链接自己无意义，直接跳过这一支
    const sourceIsTarget = path.resolve(source) === path.resolve(target);
    let sourceValid = false;
    const candidates = sourceIsTarget ? [] : [source];
    if (gameKey === 'genshin') {
      if (file.file.startsWith('GenshinImpact_Data/')) {
        candidates.push(safeJoin(baseRoot, file.file.replace(/^GenshinImpact_Data/, 'YuanShen_Data')));
      } else if (file.file.startsWith('YuanShen_Data/')) {
        candidates.push(safeJoin(baseRoot, file.file.replace(/^YuanShen_Data/, 'GenshinImpact_Data')));
      }
    }
    for (const candidate of candidates) {
      try {
        if (await quickFileMatches(file, candidate)) {
          source = candidate;
          sourceValid = true;
          break;
        }
      } catch {
        /* try the next source layout */
      }
    }
    if (sourceValid) {
      try {
        await fsp.unlink(target);
      } catch {
        /* target may not exist */
      }
      try {
        await fsp.link(source, target);
      } catch {
        // 同一磁盘正常会走硬链接；跨卷或权限受限时退回复制，至少保证内容正确。
        await fsp.copyFile(source, target);
      }
      linked += 1;
      bytesDone += file.size;
      onProgress?.({ phase: 'install', processed, total, linked, downloaded, skipped, reusedChunks, cacheHits, bytesDone, totalBytes, current: file.file });
      continue;
    }

    /*
     * 基础客户端里没有对应文件，再去别的渠道客户端里找同一个文件。
     * 命中就直接硬链接 —— 这一步是「国际服 7.1 更新到 7.2」最省流的地方：
     * 官服那份 7.2 里绝大多数资源包与目标清单逐字节相同，等于零下载。
     * 校验口径复用 quickFileMatches（size + 首尾分块 md5），与 skipped 判定完全一致。
     */
    if (externalRoots.length) {
      const reused = await linkSource.reuseFromSources({
        file,
        target,
        gameKey,
        sources: externalRoots,
        match: (candidate) => quickFileMatches(file, candidate),
      });
      if (reused.ok) {
        linked += 1;
        externalLinked += 1;
        externalBytes += file.size;
        bytesDone += file.size;
        onProgress?.({
          phase: 'install',
          processed,
          total,
          linked,
          downloaded,
          skipped,
          reusedChunks,
          cacheHits,
          externalLinked,
          bytesDone,
          totalBytes,
          current: file.file,
        });
        continue;
      }
    }

    // 就地更新时，若某个分块的本地源就是当前文件自身（entry.file === 该文件），
    // 必须在截断 target 之前先把它的字节读出来，否则截断后源被清空、只能退回重新下载。
    const selfSourced = new Map();
    if (path.resolve(baseRoot) === path.resolve(targetRoot)) {
      for (const chunk of file.chunks) {
        const localEntry = localChunks.get(chunk.uncompressedMd5);
        if (localEntry && safeJoin(baseRoot, localEntry.file) === target) {
          try {
            const buf = await readLocalChunk(baseRoot, localEntry, chunk, localHandles);
            if (buf) selfSourced.set(chunk.uncompressedMd5, buf);
          } catch {
            /* 读不到就走下载 */
          }
        }
      }
    }

    // 就地更新时 target 可能也是某个分块复用源：先关掉它的读句柄，避免 Windows 共享冲突
    const targetKey = safeJoin(baseRoot, file.file);
    const pendingHandle = localHandles.get(targetKey);
    if (pendingHandle) {
      try {
        await (await pendingHandle).close();
      } catch {
        /* 句柄可能已经因为打开失败被清掉 */
      }
      localHandles.delete(targetKey);
    }
    // 前面几步（跳过 / 缓存命中 / 硬链接 / 跨客户端复用）都是本地操作，随判随做；
    // 真正要从网络组装的收集起来，交给下面的并发池。
    pendingFiles.push({ file, target, selfSourced });
  }

  /*
   * 需要重新组装的文件并发处理。
   *
   * 以前是一个文件组装完再下一个：原神一次更新有两千多个小文件，每个都要一次
   * HTTP 往返，只这一段就能拖出十几分钟，而带宽一直是闲的。官方启动器一直是
   * 多文件并发拉分块。这里开 FILE_CONCURRENCY 路，每路内部再按剩余额度开窗口
   * （总连接数维持在 CHUNK_PREFETCH 附近，不会因为并发数相乘把 CDN 打限速）。
   */
  const parallel = Math.max(1, Math.min(FILE_CONCURRENCY, pendingFiles.length));
  const chunkWindow = Math.max(1, Math.round(CHUNK_PREFETCH / parallel));
  /*
   * 并发下任何一路出错都要让其余几路收手。
   * 串行时一个文件失败就整条停了；并发后如果不管，剩下几十个文件还会继续下、
   * 继续写盘，用户看到的却是「更新失败」，白费流量也可能留下半成品。
   * 已经在跑的那几路没法中途掐断（文件要按 offset 写完），但后面排队的会立刻退出。
   */
  let fatalError = null;
  await mapLimit(pendingFiles, parallel, async ({ file, target, selfSourced }) => {
    if (fatalError) return;
    try {
      if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
      await waitIfPaused(signal);
      /*
       * 写盘前复查空间：本地有基准时是就地覆盖、占用基本不涨，只靠守卫留的余量兜底；
       * 没有基准（或索引建不起来退化成全量）时整份文件都要新写，按文件大小预留。
       * 真的不够就在这里停，而不是等系统抛 ENOSPC 到文件写到一半。
       */
      await spaceGuard.check(localChunks.size ? 0 : file.size);
      // 必须走 openForWrite：这个 target 很可能是上一次生成时从基础客户端硬链接过来的，
      // 直接 open('w') 会连带改掉基础客户端那份文件（详见 openForWrite 的注释）。
      const handle = await openForWrite(target);
      const inFlight = new Map();
      const takeChunk = (index) => {
        const chunk = file.chunks[index];
        if (!inFlight.has(index)) {
          inFlight.set(
            index,
            (async () => {
              const localEntry = localChunks.get(chunk.uncompressedMd5);
              const own = selfSourced.get(chunk.uncompressedMd5);
              if (own) return { raw: own, from: 'local' };
              const localRaw = await readLocalChunk(baseRoot, localEntry, chunk, localHandles);
              if (localRaw) return { raw: localRaw, from: 'local' };
              const fetched = await fetchChunk(chunk, file.chunkPrefix, chunkCacheDir, signal);
              return {
                raw: fetched.raw,
                from: fetched.fromCache ? 'cache' : 'net',
                netSize: chunk.compressedSize || fetched.raw.length,
              };
            })()
          );
        }
        return inFlight.get(index);
      };
      try {
        await handle.truncate(file.size);
        for (let index = 0; index < file.chunks.length; index += 1) {
          const chunk = file.chunks[index];
          const windowEnd = Math.min(index + chunkWindow, file.chunks.length);
          for (let ahead = index; ahead < windowEnd; ahead += 1) takeChunk(ahead);
          const item = await takeChunk(index);
          inFlight.delete(index);
          if (item.from === 'local') reusedChunks += 1;
          else if (item.from === 'cache') cacheHits += 1;
          else netBytes += item.netSize;
          await handle.write(item.raw, 0, item.raw.length, chunk.offset);
          bytesDone += chunk.uncompressedSize;
          onProgress?.({
            phase: 'download',
            processed,
            total,
            linked,
            downloaded,
            skipped,
            reusedChunks,
            cacheHits,
            bytesDone,
            totalBytes,
            netBytes,
            current: file.file,
          });
        }
      } finally {
        // 取消 / 出错时窗口里还有未完成的分块，先挂上 catch 再关文件，
        // 否则它们的 reject 会变成未处理的 Promise 异常
        for (const task of inFlight.values()) task.catch(() => {});
        await handle.close();
      }
      const actual = await md5File(target);
      if (actual !== file.md5.toLowerCase()) {
        throw new Error(`文件校验失败：${file.file}`);
      }
      downloaded += 1;
      onProgress?.({ phase: 'install', processed, total, linked, downloaded, skipped, bytesDone, totalBytes, current: file.file });
    } catch (error) {
      if (!fatalError) fatalError = error || new Error('组装失败');
      throw error;
    }
  });

  for (const pending of localHandles.values()) {
    try {
      await (await pending).close();
    } catch {
      /* 打不开或已关闭的句柄，忽略 */
    }
  }
  let sdkVersion = '';
  if (channel === 'bilibili') {
    sdkVersion = await installChannelSdk(info, targetRoot, cacheDir, onProgress, signal);
  }
  await writeFileIsolated(
    path.join(targetRoot, 'config.ini'),
    channelConfig(gameKey, channel, tag, sdkVersion)
  );
  const exe = EXE_NAMES[gameKey].map((name) => path.join(targetRoot, name)).find((file) => fs.existsSync(file));
  return {
    ok: true,
    tag,
    files: total,
    totalBytes,
    // 实际生效值回给调用方：界面要能显示「本服务器已单独设置」，
    // 也方便安装/更新后核对口径（预下载那边必须和这里用同一个值）。
    includeStoryResources: includeStoryResources === true,
    linked,
    // 其中有多少是从「别的渠道客户端」硬链接过来的（跨客户端复用），界面可以单独说明省了多少
    externalLinked,
    externalBytes,
    downloaded,
    skipped,
    reusedChunks,
    cacheHits,
    // 本次真正从网络下来的字节（压缩态）。界面用它回答「这次到底下了多少」
    netBytes,
    // 没有本地增量基准时，这里带着人话原因（空串表示有基准）
    localBaseMissing: !localChunks.size,
    localBaseReason: localIndex.reason || '',
    targetRoot,
    executable: exe || '',
  };
}

module.exports = {
  prepareSophon,
  // 预下载 / 渠道运行时复用同一套清单管线，避免两边各写一份串行循环
  ensureManifest,
  ensureManifests,
  mapLimit,
  manifestConnectionsFor,
  prepareBilibiliRuntime,
  CHANNELS,
  decodeManifest,
  AUDIO_LANGUAGES,
  normalizeAudioLanguages,
  pickManifests,
  storyResourceSummary,
  fetchLauncherConfig,
  // 仅供 .tmp 自测脚本按官方清单口径统计「能复用多少」，运行时不依赖这两个
  fetchBranch,
  fetchBuild,
  quickFileMatches,
  fullFileMatches,
  // 仅供 .tmp 自测脚本核对「本地版本 / 渠道判定」是否和界面同源
  readGameVersion,
  detectLocalChannel,
  loadLocalChunkIndex,
  // 预下载 apply 侧复用：按 offset 从本地旧文件里读一个没变的分块，省掉联网重下。
  // readLocalChunk 自带「size 相等 + md5 相符」双重校验，读不到或不符都返回 null，
  // 调用方退回联网下载，所以复用失败不会写坏文件。
  readLocalChunk,
  // 仅供 .tmp/test-sophon-write-isolation.js 断言「覆盖写会不会顺着硬链接改掉源文件」
  openForWrite,
  // 官方「这次不用下」的黑名单：预下载/更新/补丁三条链路共用这一套读写
  loadDeletedAssets,
  isDeletedAsset,
};
