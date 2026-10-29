'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { CHANNELS, pickManifests } = require('./sophon');

const API = {
  cn: 'https://downloader-api.mihoyo.com/downloader/sophon_chunk/api/getPatchBuild',
  global: 'https://sg-downloader-api.hoyoverse.com/downloader/sophon_chunk/api/getPatchBuild',
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

function fields(buffer) {
  const list = [];
  let position = 0;
  while (position < buffer.length) {
    let tag;
    [tag, position] = readVarint(buffer, position);
    const number = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let value;
      [value, position] = readVarint(buffer, position);
      list.push({ number, wire, value });
    } else if (wire === 2) {
      let length;
      [length, position] = readVarint(buffer, position);
      const value = buffer.subarray(position, position + length);
      position += length;
      list.push({ number, wire, value });
    } else if (wire === 1) {
      list.push({ number, wire, value: buffer.subarray(position, position + 8) });
      position += 8;
    } else if (wire === 5) {
      list.push({ number, wire, value: buffer.subarray(position, position + 4) });
      position += 4;
    } else {
      throw new Error(`不支持的 protobuf wire type ${wire}`);
    }
  }
  return list;
}

const text = (field) => (field && field.wire === 2 ? field.value.toString('utf8') : '');
const number = (field) => Number(field?.value || 0);

function decodePatch(buffer) {
  const item = fields(buffer);
  const get = (n) => item.find((field) => field.number === n);
  return {
    id: text(get(1)),
    tag: text(get(2)),
    buildId: text(get(3)),
    patchFileSize: number(get(4)),
    patchFileMd5: text(get(5)),
    patchOffset: number(get(6)),
    patchLength: number(get(7)),
    originalFileName: text(get(8)),
    originalFileSize: number(get(9)),
    originalFileMd5: text(get(10)),
  };
}

function decodePatchManifest(buffer) {
  const files = [];
  const deleteTags = [];
  for (const field of fields(buffer)) {
    if (field.number === 1 && field.wire === 2) {
      const item = fields(field.value);
      const get = (n) => item.find((entry) => entry.number === n);
      const patches = [];
      for (const entry of item.filter((entry) => entry.number === 4 && entry.wire === 2)) {
        const info = fields(entry.value);
        const tag = text(info.find((part) => part.number === 1));
        const patchField = info.find((part) => part.number === 2);
        if (patchField) patches.push({ tag, patch: decodePatch(patchField.value) });
      }
      files.push({
        file: text(get(1)),
        size: number(get(2)),
        md5: text(get(3)),
        patches,
      });
    } else if (field.number === 2 && field.wire === 2) {
      // delete_tags: nested collection of files; only paths are needed.
      const tags = fields(field.value);
      for (const tagField of tags) {
        if (tagField.number !== 2 || tagField.wire !== 2) continue;
        const collection = fields(tagField.value);
        for (const fileField of collection) {
          if (fileField.number !== 1 || fileField.wire !== 2) continue;
          const file = fields(fileField.value);
          const name = text(file.find((entry) => entry.number === 1));
          if (name) deleteTags.push(name);
        }
      }
    }
  }
  return { files, deleteTags };
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readLocalVersion(root) {
  try {
    const content = fs.readFileSync(path.join(root, 'config.ini'), 'utf8');
    return (content.match(/game_version\s*=\s*([^\r\n]+)/i) || [])[1]?.trim() || '';
  } catch {
    return '';
  }
}

async function fetchPatchBuild(info, branchPackage) {
  const base = info.server === 'global' ? API.global : API.cn;
  const query = `branch=${encodeURIComponent(branchPackage.branch)}&package_id=${encodeURIComponent(
    branchPackage.package_id
  )}&password=${encodeURIComponent(branchPackage.password)}`;
  const response = await fetch(`${base}?${query}`, {
    method: 'POST',
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`补丁接口 HTTP ${response.status}`);
  const json = await response.json();
  if (json.retcode !== 0) throw new Error(json.message || '补丁接口返回错误');
  return json.data;
}

async function loadPatchManifest(manifest, cacheDir) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, manifest.manifest.id);
  let compressed;
  try {
    compressed = await fsp.readFile(file);
  } catch {
    compressed = null;
  }
  if (!compressed) {
    const url = `${manifest.manifest_download.url_prefix.replace(/\/$/, '')}/${manifest.manifest.id}`;
    const response = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`下载补丁清单失败 HTTP ${response.status}`);
    compressed = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(file, compressed);
  }
  const raw = zlib.zstdDecompressSync(compressed);
  if (manifest.manifest.checksum && md5(raw) !== manifest.manifest.checksum.toLowerCase()) {
    throw new Error('补丁清单校验失败');
  }
  return decodePatchManifest(raw);
}

async function ensurePatchPackage(prefix, patch, cacheDir) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `ldiff-${patch.id}`);
  let valid = false;
  try {
    const stat = await fsp.stat(file);
    if (stat.size === patch.patchFileSize) {
      valid = (await md5File(file)) === patch.patchFileMd5.toLowerCase();
    }
  } catch {
    valid = false;
  }
  if (!valid) {
    const url = `${prefix.replace(/\/$/, '')}/${patch.id}`;
    const response = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) throw new Error(`下载补丁包失败 HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (patch.patchFileMd5 && md5(buffer) !== patch.patchFileMd5.toLowerCase()) {
      throw new Error('补丁包校验失败');
    }
    await fsp.writeFile(file, buffer);
  }
  return file;
}

async function readSlice(file, offset, length) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error('补丁切片读取不完整');
    return buffer;
  } finally {
    await handle.close();
  }
}

/*
 * LDIFF（ldiff / hdiff）预修补层。
 *
 * 定位很重要：它**不是**一次独立的完整更新，而是「chunk 下载之前的省钱预处理」。
 *   1. 官方 build 的 default_download_mode 依旧是 DOWNLOAD_MODE_CHUNK，
 *      原神 / 星铁额外开了 launcher_config.enable_ldiff（绝区零是 false），
 *      ldiff 只是叠在 chunk 之上的加速层，不是另一套传输方式；
 *   2. 所以这里的职责只有一件：把「本地已有旧文件 + 官方给了对应版本补丁」的那部分
 *      文件就地改成新内容，剩下的（没补丁的、补丁失败的一律不碰）留给 prepareSophon
 *      走 chunk 下载。prepareSophon 每个文件先做 quickFileMatches，被这里改对的文件
 *      会直接 skipped，不会重复下载；
 *   3. 绝不能像以前那样「patch 完就宣布更新完成」——补丁清单只覆盖有差分的文件，
 *      没有差分条目的文件并不在清单里，那样会漏更新却报成功。
 *
 * 每个文件都是「写临时文件 → md5 校验通过 → rename 覆盖」，
 * 任何一步失败只记 failed 并跳过该文件，不影响其它文件，也不会留下半成品。
 */
async function applyHdiffPrepass({
  gameKey,
  channel,
  installRoot,
  cacheDir,
  audioLanguages,
  includeStory = false,
  onProgress,
  signal,
}) {
  const empty = { ok: false, applied: 0, skipped: 0, failed: 0, patchBytes: 0, saveBytes: 0, candidates: 0, deleteTags: [] };
  const info = CHANNELS[gameKey]?.[channel];
  if (!info) throw new Error('没有对应的补丁渠道');
  const localVersion = readLocalVersion(installRoot);
  if (!localVersion) return { ...empty, reason: 'no-local-version' };

  const branchUrl = `https://${
    info.server === 'global' ? 'sg-hyp-api.hoyoverse.com' : 'hyp-api.mihoyo.com'
  }/hyp/hyp-connect/api/getGameBranches?launcher_id=${info.launcher}&language=zh-cn&game_ids[]=${info.game}`;
  const branchResponse = await fetch(branchUrl, { headers: { 'user-agent': UA } });
  const branchJson = await branchResponse.json();
  const branchData = (branchJson.data?.game_branches || []).find((item) => item.game?.id === info.game);
  if (!branchData?.main) return { ...empty, reason: 'no-branch', localVersion };

  // 官方只对 diff_tags 里列出的版本出补丁，不在列表里就说明这次没法用 ldiff，直接退出。
  const diffTags = Array.isArray(branchData.main.diff_tags) ? branchData.main.diff_tags : [];
  if (diffTags.length && !diffTags.includes(localVersion)) {
    return { ...empty, reason: 'version-not-patchable', localVersion, diffTags, tag: branchData.main.tag || '' };
  }

  const patchBuild = await fetchPatchBuild(info, branchData.main);
  let manifests;
  try {
    // 必须和安装/更新用同一套清单口径，否则语音包、剧情资源的取舍会对不上。
    manifests = pickManifests(patchBuild, audioLanguages, { includeStory });
  } catch {
    manifests = patchBuild.manifests || [];
  }
  if (!manifests.length) return { ...empty, reason: 'no-patch-manifest', localVersion };

  const files = new Map();
  const deleteTags = new Set();
  for (const manifest of manifests) {
    const parsed = await loadPatchManifest(manifest, cacheDir);
    for (const item of parsed.files) {
      if (!files.has(item.file)) {
        files.set(item.file, { ...item, prefix: manifest.diff_download?.url_prefix || '' });
      }
    }
    for (const name of parsed.deleteTags) deleteTags.add(name);
  }

  const root = path.resolve(installRoot);
  /*
   * 只处理「官方给了本版本补丁」的文件。
   * 原神 7.0.0→7.1.0 的目标清单有 2921 个文件，但带 7.0.0 补丁条目的只有约 1151 个；
   * 如果拿 2921 当进度分母，进度条会在大量「压根不用碰」的文件上慢慢爬，用户以为卡住了。
   * 顺带省掉一两千次无意义的 stat。
   */
  const candidates = [...files.values()].filter((item) =>
    item.patches.some((part) => part.tag === localVersion)
  );
  const total = candidates.length;
  const packages = new Map(); // id → 已下载的补丁包，避免同一个包被反复 md5 校验
  const usedPackages = new Set();
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  let patchBytes = 0;
  let saveBytes = 0;
  let processed = 0;

  const ensurePackage = async (prefix, patch) => {
    if (packages.has(patch.id)) return packages.get(patch.id);
    if (!prefix) throw new Error('补丁清单没有下载地址');
    const file = await ensurePatchPackage(prefix, patch, cacheDir);
    packages.set(patch.id, file);
    usedPackages.add(file);
    return file;
  };

  for (const item of candidates) {
    if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
    processed += 1;
    const target = path.resolve(root, item.file);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('补丁清单路径非法');

    let alreadyNew = false;
    try {
      const stat = await fsp.stat(target);
      if (stat.size === item.size) alreadyNew = (await md5File(target)) === item.md5.toLowerCase();
    } catch {
      alreadyNew = false;
    }
    if (alreadyNew) {
      skipped += 1;
      continue;
    }

    const entry = item.patches.find((part) => part.tag === localVersion);
    // 官方没给「本地版本 → 新版本」的差分，这个文件交给 chunk 下载，这里不碰。
    if (!entry) continue;

    const patch = entry.patch;
    const sourcePath = patch.originalFileName ? path.resolve(root, patch.originalFileName) : target;
    if (!sourcePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(sourcePath)) continue;

    const tempDiff = path.join(cacheDir, `ldiff-slice-${patch.id}-${processed}.hdiff`);
    const tempOut = `${target}.hpatch-tmp`;
    try {
      // 补丁是针对「某个确切旧内容」做的；本地文件 md5 对不上就说明用户改过或已更新，
      // 强行套用只会产出错误内容，直接放弃交给 chunk。
      if (patch.originalFileMd5) {
        const actual = await md5File(sourcePath);
        if (actual !== patch.originalFileMd5.toLowerCase()) continue;
      }
      const packageFile = await ensurePackage(item.prefix, patch);
      const slice = await readSlice(packageFile, patch.patchOffset, patch.patchLength);
      await fsp.writeFile(tempDiff, slice);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await execFileAsync(
        path.join(__dirname, 'vendor', 'hpatchz.exe'),
        [sourcePath, tempDiff, tempOut],
        { windowsHide: true, timeout: 180000 }
      );
      const actualTarget = await md5File(tempOut);
      if (actualTarget !== item.md5.toLowerCase()) {
        throw new Error(`补丁结果校验失败：${item.file}`);
      }
      // Windows 上 fs.rename 底层是 MoveFileExW + MOVEFILE_REPLACE_EXISTING，
      // 可以直接覆盖已存在的目标，不需要先删（少一个「删了还没改名」的丢文件窗口）。
      try {
        await fsp.rename(tempOut, target);
      } catch {
        await fsp.rm(target, { force: true });
        await fsp.rename(tempOut, target);
      }
      applied += 1;
      patchBytes += patch.patchLength;
      saveBytes += Math.max(0, item.size - patch.patchLength);
      onProgress?.({
        phase: 'ldiff',
        current: item.file,
        processed,
        total,
        applied,
        failed,
        skipped,
        patchBytes,
        saveBytes,
      });
    } catch (error) {
      // 单个文件失败不影响整体：删掉临时产物，后面 chunk 下载会把这个文件补全。
      failed += 1;
      await fsp.rm(tempOut, { force: true }).catch(() => {});
      onProgress?.({
        phase: 'ldiff',
        current: item.file,
        processed,
        total,
        applied,
        failed,
        skipped,
        patchBytes,
        saveBytes,
        note: error.message,
      });
    } finally {
      await fsp.rm(tempDiff, { force: true }).catch(() => {});
    }
  }

  if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });

  // 新版本里已经删掉的文件，等所有补丁写完再删，避免中途失败留下残缺目录。
  let removed = 0;
  for (const relative of deleteTags) {
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`)) continue;
    try {
      await fsp.rm(target, { force: true, recursive: true });
      removed += 1;
    } catch {
      /* 删不掉不影响：chunk 阶段会按新清单重建 */
    }
  }

  // 补丁包单个几十 MB、合计可达数 GB，用完就清，别长期占用户盘。
  for (const file of usedPackages) {
    await fsp.rm(file, { force: true }).catch(() => {});
  }

  return {
    ok: true,
    tag: patchBuild.tag || branchData.main.tag || '',
    localVersion,
    candidates: total,
    applied,
    skipped,
    failed,
    removed,
    patchBytes,
    saveBytes,
    deleteTags: [...deleteTags],
  };
}

module.exports = { applyHdiffPrepass, fetchPatchBuild, decodePatchManifest };
