'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { hardlinkTree } = require('./runtime');

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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}：${url}`);
  const json = await response.json();
  if (json.retcode !== 0) throw new Error(json.message || `接口返回 ${json.retcode}`);
  return json.data;
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

async function ensureManifest(manifest, cacheDir, onProgress) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, manifest.manifest.id);
  let compressed = null;
  try {
    compressed = await fsp.readFile(cacheFile);
  } catch {
    compressed = null;
  }
  if (!compressed) {
    onProgress?.({ phase: 'manifest', current: manifest.manifest.id });
    const url = `${manifest.manifest_download.url_prefix.replace(/\/$/, '')}/${manifest.manifest.id}`;
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`下载清单失败：HTTP ${response.status}`);
    compressed = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(cacheFile, compressed);
  }
  const raw = zlib.zstdDecompressSync(compressed);
  const checksum = md5Buffer(raw);
  if (manifest.manifest.checksum && checksum.toLowerCase() !== manifest.manifest.checksum.toLowerCase()) {
    throw new Error('清单校验失败，缓存可能损坏');
  }
  return decodeManifest(raw);
}

async function waitIfPaused(signal) {
  while (signal?.paused && !signal.cancelled) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
}

async function loadLocalChunkIndex({
  gameKey,
  info,
  branchPackage,
  baseRoot,
  cacheDir,
  onProgress,
  signal,
  audioLanguages,
  includeStory = false,
}) {
  const version = readGameVersion(baseRoot);
  if (!version) return new Map();
  let localBuild;
  try {
    const localChannel = detectLocalChannel(baseRoot);
    const local = await fetchBranch(gameKey, localChannel);
    localBuild = await fetchBuild(local.info, local.branch.main, version);
  } catch {
    return new Map();
  }
  // 本地版本清单必须和目标版本清单用同一个 includeStory 取值，否则两边的文件集合对不上，
  // chunk 级别的去重就会错位（该复用的 chunk 找不到源，白白重下）。
  const manifests = pickManifests(localBuild, audioLanguages, { includeStory });
  const index = new Map();
  for (const manifest of manifests) {
    if (signal?.cancelled) break;
    const files = await ensureManifest(manifest, cacheDir, onProgress);
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
  return index;
}

async function readLocalChunk(baseRoot, entry, chunk, handles) {
  if (!entry || entry.size !== chunk.uncompressedSize) return null;
  const localPath = safeJoin(baseRoot, entry.file);
  let handle = handles.get(localPath);
  if (!handle) {
    try {
      handle = await fsp.open(localPath, 'r');
      handles.set(localPath, handle);
    } catch {
      return null;
    }
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
      const response = await fetch(url, {
        headers: { 'user-agent': UA, accept: '*/*' },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const compressed = Buffer.from(await response.arrayBuffer());
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
    const response = await fetch(pkg.url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`渠道 SDK 下载失败：HTTP ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
    if (pkg.md5 && md5Buffer(buffer) !== String(pkg.md5).toLowerCase()) {
      throw new Error('渠道 SDK 校验失败');
    }
    await fsp.writeFile(cacheFile, buffer);
  }
  if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
  const script = `Expand-Archive -LiteralPath '${cacheFile.replace(/'/g, "''")}' -DestinationPath '${targetRoot.replace(
    /'/g,
    "''"
  )}' -Force`;
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

function readGameVersion(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'config.ini'), 'utf8');
    return (text.match(/game_version\s*=\s*([^\r\n]+)/i) || [])[1]?.trim() || '';
  } catch {
    return '';
  }
}

function detectLocalChannel(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'config.ini'), 'utf8');
    const biz = (text.match(/game_biz\s*=\s*([^\r\n]+)/i) || [])[1] || '';
    const cps = (text.match(/cps\s*=\s*([^\r\n]+)/i) || [])[1] || '';
    const channelLine = (text.match(/^channel\s*=\s*(\d+)/im) || [])[1] || '';
    // 国际服优先：biz 带 global 或 cps 是 hoyoverse
    if (/global/i.test(biz) || /hoyoverse/i.test(cps)) return 'global';
    // B服：cps=bilibili，或 channel=14（部分旧配置只改了 channel）
    if (/bilibili/i.test(biz) || /bilibili/i.test(cps) || channelLine === '14') return 'bilibili';
    if (/_cn/i.test(biz)) return 'official';
  } catch {
    /* fall through to path hints */
  }
  const lower = String(root || '').toLowerCase();
  if (lower.includes('国际服') || lower.includes('global')) return 'global';
  if (lower.includes('b服') || lower.includes('bilibili')) return 'bilibili';
  return 'official';
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
  await fsp.rm(targetRoot, { recursive: true, force: true });
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
}) {
  if (!CHANNELS[gameKey]?.[channel]) throw new Error('这个服务器没有 Sophon 清单');
  if (!fs.existsSync(baseRoot)) throw new Error('基础客户端目录不存在');
  const { branch, info } = await fetchBranch(gameKey, channel);
  const tag = branch.main.tag;
  onProgress?.({ phase: 'version', tag, current: `目标版本 ${tag}` });
  const build = await fetchBuild(info, branch.main);
  const manifests = pickManifests(build, audioLanguages, { includeStory: includeStoryResources });
  const files = new Map();
  for (const manifest of manifests) {
    const list = await ensureManifest(manifest, cacheDir, onProgress);
    const prefix = manifest.chunk_download?.url_prefix || '';
    for (const item of list) {
      if (!item.file) continue;
      if (files.has(item.file)) continue;
      files.set(item.file, { ...item, chunkPrefix: prefix });
    }
  }

  onProgress?.({ phase: 'manifest', current: '读取本地分块索引' });
  const localChunks =
    path.resolve(baseRoot) === path.resolve(targetRoot)
      ? new Map()
      : await loadLocalChunkIndex({
          gameKey,
          info: CHANNELS[gameKey]?.[detectLocalChannel(baseRoot)] || info,
          audioLanguages,
          includeStory: includeStoryResources,
          branchPackage: branch.main,
          baseRoot,
          cacheDir,
          onProgress,
          signal,
        });

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
  let bytesDone = 0;
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
      targetRoot,
    };
  }

  await fsp.mkdir(targetRoot, { recursive: true });
  for (const file of normalized) {
    if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
    await waitIfPaused(signal);
    const target = safeJoin(targetRoot, file.file);
    let source = safeJoin(baseRoot, file.file);
    processed += 1;
    if (file.isFolder) {
      await fsp.mkdir(target, { recursive: true });
      onProgress?.({ phase: 'install', processed, total, linked, downloaded, skipped, bytesDone, totalBytes, current: file.file });
      continue;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });

    let targetValid = false;
    try {
      targetValid = await quickFileMatches(file, target);
    } catch {
      targetValid = false;
    }
    if (targetValid) {
      skipped += 1;
      bytesDone += file.size;
      onProgress?.({ phase: 'install', processed, total, linked, downloaded, skipped, bytesDone, totalBytes, current: file.file });
      continue;
    }

    let sourceValid = false;
    const candidates = [source];
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
      onProgress?.({ phase: 'install', processed, total, linked, downloaded, skipped, bytesDone, totalBytes, current: file.file });
      continue;
    }

    const handle = await fsp.open(target, 'w');
    try {
      await handle.truncate(file.size);
      for (const chunk of file.chunks) {
        const localEntry = localChunks.get(chunk.uncompressedMd5);
        let raw = await readLocalChunk(baseRoot, localEntry, chunk, localHandles);
        if (raw) {
          reusedChunks += 1;
        } else {
          raw = await downloadChunk(chunk, file.chunkPrefix, signal);
        }
        await handle.write(raw, 0, raw.length, chunk.offset);
        bytesDone += chunk.uncompressedSize;
        onProgress?.({
          phase: 'download',
          processed,
          total,
          linked,
          downloaded,
          skipped,
          reusedChunks,
          bytesDone,
          totalBytes,
          current: file.file,
        });
      }
    } finally {
      await handle.close();
    }
    const actual = await md5File(target);
    if (actual !== file.md5.toLowerCase()) {
      throw new Error(`文件校验失败：${file.file}`);
    }
    downloaded += 1;
    onProgress?.({ phase: 'install', processed, total, linked, downloaded, skipped, bytesDone, totalBytes, current: file.file });
  }

  for (const handle of localHandles.values()) {
    await handle.close().catch(() => {});
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
    downloaded,
    skipped,
    reusedChunks,
    targetRoot,
    executable: exe || '',
  };
}

module.exports = {
  prepareSophon,
  prepareBilibiliRuntime,
  CHANNELS,
  decodeManifest,
  AUDIO_LANGUAGES,
  normalizeAudioLanguages,
  pickManifests,
  storyResourceSummary,
  fetchLauncherConfig,
};
