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
};

const EXE_NAMES = {
  genshin: ['YuanShen.exe', 'GenshinImpact.exe'],
  starrail: ['StarRail.exe'],
  zzz: ['ZenlessZoneZero.exe'],
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

function pickManifests(build) {
  const manifests = build.manifests || [];
  const game = manifests.find((item) => item.matching_field === 'game');
  const audio = manifests.find((item) => item.matching_field === 'zh-cn');
  if (!game) throw new Error('官方清单缺少游戏资源');
  return [game, audio].filter(Boolean);
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
  const manifests = pickManifests(localBuild);
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
function channelConfig(gameKey, channel, tag, sdkVersion = '') {
  const biz = {
    genshin: channel === 'global' ? 'hk4e_global' : 'hk4e_cn',
    starrail: channel === 'global' ? 'hkrpg_global' : 'hkrpg_cn',
    zzz: channel === 'global' ? 'nap_global' : 'nap_cn',
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
  if (!fs.existsSync(baseRoot)) throw new Error('官服目录不存在');
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
  await fsp.writeFile(
    path.join(targetRoot, 'config.ini'),
    channelConfig(gameKey, 'bilibili', tag, sdkVersion),
    'utf8'
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
}) {
  if (!CHANNELS[gameKey]?.[channel]) throw new Error('这个服务器没有 Sophon 清单');
  if (!fs.existsSync(baseRoot)) throw new Error('基础客户端目录不存在');
  const { branch, info } = await fetchBranch(gameKey, channel);
  const tag = branch.main.tag;
  onProgress?.({ phase: 'version', tag, current: `目标版本 ${tag}` });
  const build = await fetchBuild(info, branch.main);
  const manifests = pickManifests(build);
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
    return { ok: true, dryRun: true, tag, files: total, totalBytes, targetRoot };
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
  await fsp.writeFile(
    path.join(targetRoot, 'config.ini'),
    channelConfig(gameKey, channel, tag, sdkVersion),
    'utf8'
  );
  const exe = EXE_NAMES[gameKey].map((name) => path.join(targetRoot, name)).find((file) => fs.existsSync(file));
  return {
    ok: true,
    tag,
    files: total,
    totalBytes,
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
};
