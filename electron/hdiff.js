'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { CHANNELS, pickManifests, loadDeletedAssets, isDeletedAsset } = require('./sophon');
const linkSource = require('./link-source');
const clientChannel = require('./client-channel');
const netThrottle = require('./net-throttle');

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

/*
 * 读本地客户端版本号。
 *
 * 必须编码自适应：国际服的 config.ini 有 UTF-16 写法，用 utf8 直读拿到的是乱码，
 * 版本号读不出来 → 这一层 ldiff 直接以 no-local-version 退出，等于整条省钱预处理
 * 在国际服上从来没生效过（用户看到的就是「国际服更新还是老老实实下增量包」）。
 */
function readLocalVersion(root) {
  const config = clientChannel.readClientConfig(root);
  if (config) return String(config.fields.get('game_version') || '').trim();
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
    compressed = await netThrottle.toBuffer(response);
    await fsp.writeFile(file, compressed);
  }
  const raw = zlib.zstdDecompressSync(compressed);
  if (manifest.manifest.checksum && md5(raw) !== manifest.manifest.checksum.toLowerCase()) {
    throw new Error('补丁清单校验失败');
  }
  return decodePatchManifest(raw);
}

/*
 * 补丁包落盘位置。
 *
 * patchRoot 是「预下载先存起来、等正式更新再打」的那份（<安装目录>/ldiff/），
 * cacheDir 是以前就有的临时缓存目录（用户数据目录下）。两个都查：预下载存过的包
 * 在正式更新时能直接复用，不必再下一次。
 *
 * 文件名统一带 ldiff- 前缀，两边同一套命名，才不会出现「这里存了、那里认不出」。
 */
function patchPackageFile(dir, patch) {
  return path.join(dir, `ldiff-${patch.id}`);
}

/*
 * 按「内容」而不是「文件名」找已经下过的补丁包。
 *
 * 为什么需要这一层：预下载阶段是从 pre_download 分支的清单里拿 patch.id，
 * 正式更新时是从 main 分支的清单里拿。官方这两份清单里的 patch.id 是同一套
 * 内容寻址命名，正常情况下一致；但一旦官方改了命名口径（或者我们哪天用错了分支），
 * 按文件名找就会全部落空 —— 用户会发现「预下载明明下完了，更新又下一遍」，
 * 也就是我们这次要根治的那个毛病。
 *
 * 先按 size 过滤再算 md5，目录里通常也就几十个文件，开销可以忽略。
 * 只认 ldiff- 前缀，避免误吃 cacheDir 里别的东西。
 */
async function findByContent(dir, patch, requirePrefix = true) {
  const size = Number(patch.patchFileSize) || 0;
  const want = String(patch.patchFileMd5 || '').toLowerCase();
  if (!dir || !size || !want) return '';
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    /*
     * 自己的目录（ldiff/、缓存目录）只认 ldiff- 前缀，避免误吃别的东西。
     * 别家启动器留下的目录整个都是补丁包，文件名不可预期，只能靠内容认。
     */
    if (requirePrefix && !entry.name.startsWith('ldiff-')) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = await fsp.stat(file);
      if (stat.size !== size) continue;
      if ((await md5File(file)) === want) return file;
    } catch {
      /* 单个文件读不动就跳过，继续找下一个 */
    }
  }
  return '';
}

/*
 * 别的启动器留下的补丁包目录。
 *
 * Collapse 自己的历史版本把补丁包存在安装目录的 chunk_collapse/ 下，
 * 现在的版本存在 ldiff/ 下（它的查找顺序也是 ldiff → chunk_collapse）。
 * 用户很可能先用 Collapse 预下载过，那批包就躺在那里；我们直接认出来
 * 就不必再下一遍 5.63GB。
 *
 * 这两个目录里的文件名是 Collapse 自己的 PatchNameSource，不可预期，
 * 所以只能按「尺寸 + md5」认内容，不能按文件名。
 */
function foreignPatchDirs(installRoot) {
  if (!installRoot) return [];
  return [
    path.join(installRoot, 'chunk_collapse'),
    path.join(installRoot, 'ldiff'),
  ];
}

async function ensurePatchPackage(prefix, patch, cacheDir, patchRoot = '', installRoot = '') {
  const candidates = [];
  if (patchRoot) candidates.push(patchPackageFile(patchRoot, patch));
  candidates.push(patchPackageFile(cacheDir, patch));
  for (const file of candidates) {
    let valid = false;
    try {
      const stat = await fsp.stat(file);
      if (stat.size === patch.patchFileSize) {
        valid = (await md5File(file)) === patch.patchFileMd5.toLowerCase();
      }
    } catch {
      valid = false;
    }
    // 命中就直接用，不打任何标记——预下载存的那份打完补丁仍然有效（内容没变）
    if (valid) return file;
  }
  /*
   * 名字对不上时再按内容找一遍：预下载用 pre_download 清单、正式更新用 main 清单，
   * 两者的 patch.id 万一不同，这里能把预下载下过的那份认出来，不重复下。
   */
  for (const dir of [patchRoot, cacheDir]) {
    if (!dir) continue;
    const hit = await findByContent(dir, patch);
    if (hit) return hit;
  }
  /*
   * 最后看别的启动器（Collapse）留下的目录。整个目录都是补丁包，文件名不可预期，
   * 所以 requirePrefix=false 放开前缀限制，纯靠「尺寸 + md5」认。
   * 这是零成本的：目录不存在就 readdir 失败直接返回空。
   */
  for (const dir of foreignPatchDirs(installRoot)) {
    const hit = await findByContent(dir, patch, false);
    if (hit) return hit;
  }
  // 一处都没有：下到第一个候选位置（有 patchRoot 就落 patchRoot，预下载的语义）
  const file = candidates[0];
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const url = `${prefix.replace(/\/$/, '')}/${patch.id}`;
  const response = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`下载补丁包失败 HTTP ${response.status}`);
  /*
   * 补丁包单个几 MB 到几十 MB，是 ldiff 路线的主要流量。这里必须限速：
   * 走限速版 toBuffer，不限速时内部退回 arrayBuffer()，与原来等价。
   */
  const buffer = await netThrottle.toBuffer(response);
  if (patch.patchFileMd5 && md5(buffer) !== patch.patchFileMd5.toLowerCase()) {
    throw new Error('补丁包校验失败');
  }
  await fsp.writeFile(file, buffer);
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
/*
 * 一个补丁条目能不能从「已经在目标版本的其它渠道客户端」直接硬链接过来。
 *
 * 判定口径必须和补丁清单一致：size + 整份 md5。ldiff 的条目本来就只有 md5、没有分块
 * 信息，凑不出 quickFileMatches 那套首尾分块判定，用整份 md5 反而是最准的。
 * 单独抽出来是为了能直接对着真实文件跑断言（见 .tmp/test-ldiff-link.js）。
 */
async function linkFromReadySources({ item, target, gameKey, readySources }) {
  if (!readySources || !readySources.length) return { ok: false };
  return linkSource.reuseFromSources({
    file: { file: item.file },
    target,
    gameKey,
    sources: readySources,
    match: async (candidate) => {
      const stat = await fsp.stat(candidate);
      if (stat.size !== item.size) return false;
      return (await md5File(candidate)) === String(item.md5).toLowerCase();
    },
  });
}

/*
 * 预下载侧的「只下不打」：把补丁包存到 <安装目录>/ldiff/，等正式更新再应用。
 *
 * 为什么预下载不能就地打补丁：预下载发生在正式版上线之前，游戏本体还在跑，
 * 就地改文件等于边走边拆轮胎。官方自己的做法也是「下载目录与安装目录分开」，
 * 我们照样把补丁先存起来。
 *
 * 返回值带上包数/总字节，界面直接显示「补丁包 X 个 · Y GB」，不必再去遍历清单。
 */
async function downloadPatchPackages({
  gameKey,
  channel,
  installRoot,
  cacheDir,
  audioLanguages,
  includeStory = false,
  patchRoot,
  maxPatches = 0,
  onProgress,
  signal,
}) {
  const info = CHANNELS[gameKey]?.[channel];
  if (!info) throw new Error('没有对应的补丁渠道');
  const localVersion = readLocalVersion(installRoot);
  if (!localVersion) return { ok: false, reason: 'no-local-version', localVersion: '' };

  const branchUrl = `https://${
    info.server === 'global' ? 'sg-hyp-api.hoyoverse.com' : 'hyp-api.mihoyo.com'
  }/hyp/hyp-connect/api/getGameBranches?launcher_id=${info.launcher}&language=zh-cn&game_ids[]=${info.game}`;
  const branchResponse = await fetch(branchUrl, { headers: { 'user-agent': UA } });
  const branchJson = await branchResponse.json();
  const branchData = (branchJson.data?.game_branches || []).find((item) => item.game?.id === info.game);
  const pre = branchData?.pre_download;
  if (!pre) return { ok: false, reason: 'no-predownload', localVersion };

  // 预下载分支自己的 diff_tags：拿本地版本去问，才有「本地版本 → 预下载版本」的差分。
  const diffTags = Array.isArray(pre.diff_tags) ? pre.diff_tags : [];
  if (!diffTags.includes(localVersion)) {
    return { ok: false, reason: 'version-not-patchable', localVersion, diffTags, tag: pre.tag || '' };
  }

  const patchBuild = await fetchPatchBuild(info, pre);
  let manifests;
  try {
    manifests = pickManifests(patchBuild, audioLanguages, { includeStory });
  } catch {
    manifests = patchBuild.manifests || [];
  }
  if (!manifests.length) return { ok: false, reason: 'no-patch-manifest', localVersion };

  const root = path.resolve(patchRoot || path.join(installRoot, 'ldiff'));
  await fsp.mkdir(root, { recursive: true });

  const files = new Map();
  // 官方黑名单：被标为「本次不用下」的文件，它的补丁也不用下
  const deletedAssets = loadDeletedAssets(installRoot, gameKey);
  let deletedSkipped = 0;
  for (const manifest of manifests) {
    const parsed = await loadPatchManifest(manifest, cacheDir);
    const matchingField = manifest.matching_field;
    for (const item of parsed.files) {
      if (files.has(item.file)) continue;
      if (isDeletedAsset(deletedAssets, { file: item.file, matchingField })) {
        deletedSkipped += 1;
        continue;
      }
      files.set(item.file, { ...item, prefix: manifest.diff_download?.url_prefix || '' });
    }
  }
  if (deletedSkipped > 0) {
    onProgress?.({
      phase: 'predownload',
      current: `官方清单标了 ${deletedSkipped} 个资源本次不用下，它们的补丁包也跳过`,
      deletedSkipped,
    });
  }

  /*
   * 按补丁包 id 去重：同一个包里装着多个文件的差分切片，只该下一次。
   * 这也是「体积比 chunk 路线小一半」的真正原因 —— 一个 60MB 的包里
   * 可能装着上百个小文件的差分，而 chunk 路线要为每个变了的块各下一份。
   */
  const patches = new Map();
  for (const item of files.values()) {
    const entry = item.patches.find((part) => part.tag === localVersion);
    if (!entry) continue;
    const patch = entry.patch;
    if (!patch?.id) continue;
    if (!patches.has(patch.id)) {
      patches.set(patch.id, { patch, prefix: item.prefix || '' });
    }
  }
  if (!patches.size) return { ok: false, reason: 'no-patch-entry', localVersion, tag: pre.tag || '' };

  const list = [...patches.values()];
  /*
   * maxPatches 只给本机验证脚本用（只下前几个包确认链路通不通），
   * 产品调用一律不传 = 0 = 下全部。不是给界面用的限速开关。
   */
  const queue = maxPatches > 0 ? list.slice(0, maxPatches) : list;
  // totalBytes 永远报全量真值（界面上「这次预下载一共多大」），只有真正下多少由 queue 决定
  const totalBytes = list.reduce((sum, item) => sum + (item.patch.patchFileSize || 0), 0);
  const queueBytes = queue.reduce((sum, item) => sum + (item.patch.patchFileSize || 0), 0);
  let doneBytes = 0;
  let index = 0;
  for (const entry of queue) {
    if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
    if (!entry.prefix) throw new Error('补丁清单没有下载地址');
    // ensurePatchPackage 会先查 patchRoot 里已有的包，命中就不再下（断点续传）；
    // 也会去 Collapse 留下的 chunk_collapse/ 与 ldiff/ 里按内容找一遍
    const before = doneBytes;
    await ensurePatchPackage(entry.prefix, entry.patch, cacheDir, root, installRoot);
    doneBytes += entry.patch.patchFileSize || 0;
    index += 1;
    onProgress?.({
      phase: 'predownload',
      current: `补丁包 ${index}/${queue.length}`,
      downloaded: doneBytes,
      total: queueBytes,
      index,
      count: queue.length,
      delta: doneBytes - before,
    });
  }

  return {
    ok: true,
    mode: 'ldiff',
    tag: patchBuild.tag || pre.tag || '',
    localVersion,
    targetVersion: String(pre.tag || ''),
    patchCount: list.length,
    totalBytes,
  };
}

async function applyHdiffPrepass({
  gameKey,
  channel,
  installRoot,
  cacheDir,
  audioLanguages,
  includeStory = false,
  onProgress,
  signal,
  linkSources = [],
  // 预下载存补丁包的位置：有的话优先从这儿取，省掉重复下载
  patchRoot = '',
  // 预下载阶段只存不打，所以这里能选择「用完别删」，留给正式更新
  keepPackages = false,
}) {
  const empty = { ok: false, applied: 0, skipped: 0, failed: 0, linked: 0, patchBytes: 0, saveBytes: 0, candidates: 0, deleteTags: [] };
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
  // 两种口径都认：main（正式更新）与 pre_download（预下载）。预下载先存下的包在正式更新时
  // 就是靠这个把本地版本重新对上的 —— 少一个口径就会出现「预下载下过了、更新又要下一遍」。
  const mainTags = Array.isArray(branchData.main.diff_tags) ? branchData.main.diff_tags : [];
  const preTags = Array.isArray(branchData.pre_download?.diff_tags) ? branchData.pre_download.diff_tags : [];
  const diffTags = [...new Set([...mainTags, ...preTags])];
  if (diffTags.length && !diffTags.includes(localVersion)) {
    return { ...empty, reason: 'version-not-patchable', localVersion, diffTags, tag: branchData.main.tag || '' };
  }

  const patchBuild = await fetchPatchBuild(info, branchData.main);
  // 万一 main 这份没给出本版本的差分、而 pre_download 给了，就用预下载那份问一遍。
  // 这一步只影响「有没有补丁可打」，不会去动游戏文件。
  let effectiveBuild = patchBuild;
  if (preTags.includes(localVersion)) {
    try {
      const preBuild = await fetchPatchBuild(info, branchData.pre_download);
      const preManifests = pickManifests(preBuild, audioLanguages, { includeStory });
      if (preManifests.length) effectiveBuild = preBuild;
    } catch {
      /* 拿不到就沿用 main 的，不影响原来行为 */
    }
  }
  let manifests;
  try {
    // 必须和安装/更新用同一套清单口径，否则语音包、剧情资源的取舍会对不上。
    manifests = pickManifests(effectiveBuild, audioLanguages, { includeStory });
  } catch {
    manifests = effectiveBuild.manifests || [];
  }
  if (!manifests.length) return { ...empty, reason: 'no-patch-manifest', localVersion };

  const files = new Map();
  const deleteTags = new Set();
  // 官方黑名单：不用下的文件不参与打补丁，它的补丁包也不必再找
  const deletedAssets = loadDeletedAssets(installRoot, gameKey);
  let deletedSkipped = 0;
  for (const manifest of manifests) {
    const parsed = await loadPatchManifest(manifest, cacheDir);
    const matchingField = manifest.matching_field;
    for (const item of parsed.files) {
      if (files.has(item.file)) continue;
      if (isDeletedAsset(deletedAssets, { file: item.file, matchingField })) {
        deletedSkipped += 1;
        continue;
      }
      files.set(item.file, { ...item, prefix: manifest.diff_download?.url_prefix || '' });
    }
    for (const name of parsed.deleteTags) deleteTags.add(name);
  }
  if (deletedSkipped > 0) {
    onProgress?.({
      phase: 'ldiff',
      current: `官方清单标了 ${deletedSkipped} 个资源本次不用下，已跳过`,
      deletedSkipped,
    });
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
  /*
   * 硬链接预取源：只取「本身已经处在目标版本」的同款客户端。
   *
   * 典型场景：官服更完了 7.2，国际服还停在 7.1。官服那份里绝大多数文件与目标清单
   * 逐字节相同，本来就该直接硬链接过来；但 ldiff 跑在 prepareSophon 之前，它眼里
   * 只有补丁清单，会把这些文件按「7.1 → 7.2」再下一遍补丁包 —— 旁边摆着一份现成的，
   * 白花几十上百 GB 流量。这就是用户说的「硬链接的国际服还跑去下增量包」。
   *
   * 用版本号先筛一道很重要：源不是目标版本时，逐文件算 md5 基本全是空转（读盘白读）。
   */
  const targetTag = String(branchData.main.tag || '');
  const readySources = targetTag
    ? linkSources.filter((source) => {
        try {
          return readLocalVersion(source) === targetTag;
        } catch {
          return false;
        }
      })
    : [];
  /*
   * 跨渠道复用失效要说出来：以前这里完全静默，用户只看到「补丁包照下一整轮」，
   * 明明旁边摆着一份硬链接过来的、逐字节相同的客户端。最常见的成因就是源客户端
   * 版本号读不出来（config.ini 缺失/被改），而不是真的没有可复用源。
   */
  if (linkSources.length && !readySources.length) {
    onProgress?.({ phase: 'ldiff', current: '跨渠道复用不可用：源客户端版本号对不上，本次只打补丁包' });
  }
  const packages = new Map(); // id → 已下载的补丁包，避免同一个包被反复 md5 校验
  const usedPackages = new Set();
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  let linked = 0;
  let patchBytes = 0;
  let saveBytes = 0;
  let processed = 0;

  const ensurePackage = async (prefix, patch) => {
    if (packages.has(patch.id)) return packages.get(patch.id);
    if (!prefix) throw new Error('补丁清单没有下载地址');
    // patchRoot 里可能是预下载时存下的那份，命中就不再下；
    // 也会去 Collapse 留下的 chunk_collapse/ 与 ldiff/ 里按内容找一遍
    const file = await ensurePatchPackage(prefix, patch, cacheDir, patchRoot, root);
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

    /*
     * 别的渠道客户端已经在目标版本上：这个文件直接硬链接过来，连补丁都不用下。
     * 命中判定按清单的 size + 整份 md5 —— ldiff 的条目本来就只有 md5、没有分块信息，
     * 用整份 md5 才是与清单同口径的判定，不会出现「这里说命中、那边又说不对」。
     */
    if (readySources.length) {
      const reused = await linkFromReadySources({ item, target, gameKey, readySources });
      if (reused.ok) {
        linked += 1;
        onProgress?.({
          phase: 'ldiff',
          current: item.file,
          processed,
          total,
          applied,
          failed,
          skipped,
          linked,
          patchBytes,
          saveBytes,
        });
        continue;
      }
    }

    const entry = item.patches.find((part) => part.tag === localVersion);
    // 官方没给「本地版本 → 新版本」的差分，这个文件交给 chunk 下载，这里不碰。
    if (!entry) continue;

    const patch = entry.patch;
    const sourcePath = patch.originalFileName ? path.resolve(root, patch.originalFileName) : target;
    if (!sourcePath.startsWith(`${root}${path.sep}`)) continue;
    /*
     * 源文件不存在有两种情况，必须分开处理：
     *   - 纯新增文件（patch.originalFileMd5 为空）：补丁本身就是整文件压缩，
     *     hpatchz 传空 oldPath 就能还原出来。以前这里直接 continue，等于把
     *     「新版本新增的文件」全推给 chunk 下载 —— 而 5.63G 里有 4.39G 正是这批，
     *     不补这条支路，ldiff 路线省不到一半。
     *   - 本地文件被删/改名（有 originalFileMd5）：源都不在，打不了，交给 chunk。
     */
    const hasSource = fs.existsSync(sourcePath);
    const pureCreate = !hasSource && !patch.originalFileMd5;
    if (!hasSource && !pureCreate) continue;

    const tempDiff = path.join(cacheDir, `ldiff-slice-${patch.id}-${processed}.hdiff`);
    const tempOut = `${target}.hpatch-tmp`;
    try {
      // 补丁是针对「某个确切旧内容」做的；本地文件 md5 对不上就说明用户改过或已更新，
      // 强行套用只会产出错误内容，直接放弃交给 chunk。
      if (hasSource && patch.originalFileMd5) {
        const actual = await md5File(sourcePath);
        if (actual !== patch.originalFileMd5.toLowerCase()) continue;
      }
      const packageFile = await ensurePackage(item.prefix, patch);
      const slice = await readSlice(packageFile, patch.patchOffset, patch.patchLength);
      /*
       * 补丁片段不一定是 HDIFF 压缩，也可能是「原样字节」。
       *
       * 官方的补丁片段有两种形态（Collapse 里叫 Patch 和 CopyOver）：
       *   - HDIFF：真正的二进制差分，要用 hpatchz 配旧文件才能还原；
       *   - 裸字节：这段就是完整的新文件内容，直接写出去即可，根本不该起 hpatchz。
       *
       * 我们这批星铁 4.6.0→4.7.0 实测 2309 段全是 HDIFF（含 602 个纯新增文件），
       * 所以现有「纯新增传空 oldPath」是安全的；但这是服务端的选择，别的游戏、
       * 或以后的版本完全可能给裸字节，那时 hpatchz 会直接报错、这批文件白下。
       * 读 5 字节就能判，顺手把这个分支补上。
       */
      const isHDiff = slice.length >= 5 && slice.subarray(0, 5).toString('latin1') === 'HDIFF';
      if (!isHDiff) {
        // 裸字节：片段长度应当等于新文件大小，写完直接走下面的 md5 校验。
        if (slice.length !== item.size) {
          throw new Error(`补丁片段不是 HDIFF 且长度与清单不符：${item.file}`);
        }
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(tempOut, slice);
      } else {
        await fsp.writeFile(tempDiff, slice);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await execFileAsync(
          path.join(__dirname, 'vendor', 'hpatchz.exe'),
          // 纯新增文件：oldPath 传空串（hpatchz 的 uncompress 用法）
          [pureCreate ? '' : sourcePath, tempDiff, tempOut],
          { windowsHide: true, timeout: 180000 }
        );
      }
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
  // keepPackages 是给「预下载先存不应用」那条路用的；打完补丁后这些包就没用了，
  // 留着白占几 GB，所以默认全删（连预下载存到 ldiff/ 的那批也一起删）。
  if (!keepPackages) {
    for (const file of usedPackages) {
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  return {
    ok: true,
    tag: patchBuild.tag || branchData.main.tag || '',
    localVersion,
    candidates: total,
    applied,
    skipped,
    failed,
    // 其中有多少是「从已经更到目标版本的其它渠道客户端硬链接过来」的，一个补丁都没下
    linked,
    removed,
    patchBytes,
    saveBytes,
    deleteTags: [...deleteTags],
  };
}

module.exports = {
  applyHdiffPrepass,
  downloadPatchPackages,
  fetchPatchBuild,
  decodePatchManifest,
  linkFromReadySources,
  readLocalVersion,
};
