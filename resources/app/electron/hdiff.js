'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { CHANNELS } = require('./sophon');

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

async function applyHdiffUpdate({ gameKey, channel, installRoot, cacheDir, onProgress, signal }) {
  const info = CHANNELS[gameKey]?.[channel];
  if (!info) throw new Error('没有对应的补丁渠道');
  const localVersion = readLocalVersion(installRoot);
  if (!localVersion) throw new Error('本地 config.ini 没有版本号');
  // Branch is fetched through the same public API as the chunk installer.
  const branchUrl = `https://${
    info.server === 'global' ? 'sg-hyp-api.hoyoverse.com' : 'hyp-api.mihoyo.com'
  }/hyp/hyp-connect/api/getGameBranches?launcher_id=${info.launcher}&language=zh-cn&game_ids[]=${info.game}`;
  const branchResponse = await fetch(branchUrl, { headers: { 'user-agent': UA } });
  const branchJson = await branchResponse.json();
  const branchData = (branchJson.data?.game_branches || []).find((item) => item.game?.id === info.game);
  if (!branchData?.main) throw new Error('没有找到补丁分支');
  const patchBuild = await fetchPatchBuild(info, branchData.main);
  const gameManifest = (patchBuild.manifests || []).find((item) => item.matching_field === 'game');
  const audioManifest = (patchBuild.manifests || []).find((item) => item.matching_field === 'zh-cn');
  const manifests = [gameManifest, audioManifest].filter(Boolean);
  if (!manifests.length) throw new Error('没有补丁清单');

  const files = new Map();
  for (const manifest of manifests) {
    const parsed = await loadPatchManifest(manifest, cacheDir);
    for (const file of parsed.files) {
      if (!files.has(file.file)) files.set(file.file, { ...file, prefix: manifest.diff_download?.url_prefix });
    }
    for (const file of parsed.deleteTags) deleteTags.add(file);
  }
  const list = [...files.values()];
  let applied = 0;
  let skipped = 0;
  const deleteTags = new Set();

  for (let index = 0; index < list.length; index += 1) {
    const file = list[index];
    if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
    const target = path.resolve(installRoot, file.file);
    if (!target.startsWith(path.resolve(installRoot) + path.sep)) throw new Error('补丁清单路径非法');
    try {
      if (fs.existsSync(target) && (await md5File(target)) === file.md5.toLowerCase()) {
        skipped += 1;
        continue;
      }
    } catch {
      /* continue */
    }
    const patchInfo = file.patches.find((item) => item.tag === localVersion);
    if (!patchInfo) continue;
    const patch = patchInfo.patch;
    const originalPath = patch.originalFileName
      ? path.resolve(installRoot, patch.originalFileName)
      : target;
    if (patch.originalFileMd5 && fs.existsSync(originalPath)) {
      const actual = await md5File(originalPath);
      if (actual !== patch.originalFileMd5.toLowerCase()) {
        continue;
      }
    }
    const packageFile = await ensurePatchPackage(file.prefix, patch, cacheDir);
    const slice = await readSlice(packageFile, patch.patchOffset, patch.patchLength);
    const patchFile = path.join(cacheDir, `slice-${patch.id}-${index}.hdiff`);
    const output = `${target}_hdiff`;
    await fsp.writeFile(patchFile, slice);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const oldArgument =
      patch.originalFileName && fs.existsSync(originalPath) ? originalPath : '';
    await execFileAsync(
      path.join(__dirname, 'vendor', 'hpatchz.exe'),
      [oldArgument, patchFile, output],
      { windowsHide: true, timeout: 120000 }
    );
    const actualTarget = await md5File(output);
    if (actualTarget !== file.md5.toLowerCase()) {
      await fsp.rm(output, { force: true });
      throw new Error(`补丁结果校验失败：${file.file}`);
    }
    await fsp.rm(target, { force: true });
    await fsp.rename(output, target);
    await fsp.rm(patchFile, { force: true });
    applied += 1;
    onProgress?.({
      phase: 'patch',
      current: file.file,
      processed: index + 1,
      total: list.length,
      linked: 0,
      downloaded: applied,
      skipped,
    });
  }
  for (const relative of deleteTags) {
    const target = path.resolve(installRoot, relative);
    if (target.startsWith(path.resolve(installRoot) + path.sep)) {
      await fsp.rm(target, { force: true, recursive: true }).catch(() => {});
    }
  }
  return { applied, skipped, deleteTags: [...deleteTags], tag: patchBuild.tag };
}

module.exports = { applyHdiffUpdate, fetchPatchBuild, decodePatchManifest };
