'use strict';

/**
 * 明日方舟：终末地 预下载（鹰角 Hypergryph 协议）。
 *
 * 协议来源：Hi3Helper.Plugin.Endfield（Xel-Launcher 用的就是它）。
 * 请求是 POST batch_proxy 的 get_latest_game，带本地版本号去问，服务端才会给
 * patch（正式增量）和 pre_patch（预下载增量）。
 *
 * 与米哈游那边最大的三点不同：
 *   1. 预下载单位是 zip 分包，落到 <安装目录>/Diffs/<URL 最后一段文件名>，
 *      必须原样存、不能改名、不能分片、也不能解压 —— 正式更新靠「同名 + 同 size + 同 md5」
 *      命中来跳过下载，动了名字就白下了。
 *   2. 预下载完成**没有任何落盘标记**，完成状态只能靠文件 size+md5 重算，
 *      所以启动器必须自己把 {安装路径, 目标版本} 记下来（存到 server.predownload）。
 *   3. 更新完必须把「预下载已完成」清掉，否则界面会一直显示旧的完成态。
 *
 * Steam 渠道官方就没有 GameInstaller（只能启动），直接不给预下载入口。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const { PROFILES, findSevenZip, decryptManifest, encryptManifest } = require('./endfield-packs');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 预下载 / 增量包缓存目录名（固定，鹰角官方启动器也认这个）。 */
const DIFFS_DIR = 'Diffs';

const CHANNEL_DIRECTORY = {
  official: 'EndOfficial',
  bilibili: 'EndBilibili',
  global: 'EndGlobal',
  play: 'EndPlay',
  steam: 'EndSteam',
};

/** 包内不属于游戏内容的清单类文件，应用时不能直接搬进安装目录。 */
const PATCH_META_FILES = new Set(['patch.json', 'deletefiles.txt', 'delete_files.txt', 'hdifffiles.txt', 'config.ini']);

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

function profileFor(channel) {
  const directory = CHANNEL_DIRECTORY[String(channel || '')];
  if (!directory) return null;
  return PROFILES.find((item) => item.directory === directory) || null;
}

function supported(channel) {
  // Steam 渠道官方没有 GameInstaller，只能启动，协议层面就没有预下载包。
  return String(channel || '') !== 'steam' && Boolean(profileFor(channel));
}

function throwIfCancelled(signal) {
  if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
}

async function waitIfPaused(signal) {
  while (signal?.paused && !signal?.cancelled) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throwIfCancelled(signal);
}

/** 带本地版本去问，服务端才会在响应里带 patch / pre_patch。 */
async function fetchLatest(profile, version = '') {
  const body = {
    seq: profile.seq,
    proxy_reqs: [
      {
        kind: 'get_latest_game',
        get_latest_game_req: {
          appcode: profile.appcode,
          launcher_appcode: profile.launcherAppcode,
          channel: profile.channel,
          sub_channel: profile.subChannel,
          version,
        },
      },
    ],
  };
  const response = await fetch(profile.api, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${profile.iconName} 版本接口 HTTP ${response.status}`);
  const json = await response.json();
  const latest = (json.proxy_rsps || []).find(
    (item) => item.kind === 'get_latest_game' && item.get_latest_game_rsp
  )?.get_latest_game_rsp;
  if (!latest) throw new Error(`${profile.iconName} 接口没有返回版本信息`);
  return {
    action: Number(latest.action) || 0,
    version: String(latest.version || ''),
    pkg: latest.pkg || null,
    patch: latest.patch || null,
    prePatch: latest.pre_patch || null,
  };
}

/** 终末地的 config.ini 是 AES-256-CBC 加密的，version= 那一行才是本地版本。 */
function readLocalVersion(installRoot) {
  const file = path.join(installRoot, 'config.ini');
  try {
    const text = decryptManifest(fs.readFileSync(file));
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('version=')) return trimmed.slice('version='.length).trim();
    }
  } catch {
    /* 读不出来就当没装 */
  }
  return '';
}

function looksInstalled(installRoot) {
  if (!installRoot) return false;
  return fs.existsSync(path.join(installRoot, 'Endfield.exe')) && fs.existsSync(path.join(installRoot, 'config.ini'));
}

function compareVersion(a, b) {
  const left = String(a || '0.0.0')
    .split('.')
    .map((part) => Number(part) || 0);
  const right = String(b || '0.0.0')
    .split('.')
    .map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function diffsDirOf(installRoot) {
  return path.join(installRoot, DIFFS_DIR);
}

function packFileName(url) {
  return path.basename(new URL(url).pathname);
}

function normalizePack(pack) {
  return {
    url: String(pack?.url || ''),
    md5: String(pack?.md5 || '').toLowerCase(),
    size: Number(pack?.package_size) || 0,
  };
}

function packList(info) {
  return Array.isArray(info?.patches) ? info.patches.map(normalizePack).filter((pack) => pack.url) : [];
}

/**
 * 查 Diffs/ 里每个包的落地情况。
 * 命中的判定和鹰角官方一致：文件名相同 + size 相同 + md5 相同。
 */
async function scanDiffs(installRoot, packs) {
  const dir = diffsDirOf(installRoot);
  const matched = [];
  const missing = [];
  let bytesDone = 0;
  let bytesTotal = 0;
  for (const pack of packs) {
    const name = packFileName(pack.url);
    const file = path.join(dir, name);
    bytesTotal += pack.size;
    let ok = false;
    try {
      const stat = await fsp.stat(file);
      if (!pack.size || stat.size === pack.size) {
        ok = !pack.md5 || (await md5File(file)) === pack.md5;
      }
    } catch {
      ok = false;
    }
    if (ok) {
      matched.push({ name, size: pack.size, file });
      bytesDone += pack.size;
    } else {
      missing.push({ name, size: pack.size, url: pack.url, md5: pack.md5 });
    }
  }
  return { dir, matched, missing, bytesDone, bytesTotal };
}

/**
 * 查询预下载状态。
 *
 * state:
 *   unsupported   Steam 渠道 / 未知渠道
 *   not-installed 目录里没有 Endfield.exe + config.ini
 *   update        正式版已经比本地新（含 stale 修正：本地已达标的假更新会被压掉）
 *   available     有预下载包
 *   done          Diffs/ 里的包已经全部命中
 *   none          官方当前没开放预下载
 */
async function checkEndfieldPredownload({ channel, installRoot, verify = false }) {
  const profile = profileFor(channel);
  if (!profile) return { supported: false, state: 'unsupported', reason: '没有这个终末地渠道' };
  if (!supported(channel)) {
    return {
      supported: false,
      state: 'unsupported',
      reason: 'Steam 渠道的更新由 Steam 自己负责，官方协议里没有预下载包',
      installRoot,
    };
  }
  try {
    if (!looksInstalled(installRoot)) {
      return { supported: true, state: 'not-installed', installRoot, localVersion: '' };
    }
    const localVersion = readLocalVersion(installRoot);
    const latest = await fetchLatest(profile, localVersion);
    const answer = {
      supported: true,
      kind: 'endfield',
      mode: 'diffs',
      dir: diffsDirOf(installRoot),
      installRoot,
      localVersion,
      latestVersion: latest.version,
      targetVersion: String(latest.prePatch?.version || ''),
      state: 'none',
      completed: false,
    };
    // 官服 API 会残留 stale 的 action=1：本地其实已经达标，别误判成有更新。
    const hasUpdate =
      Boolean(localVersion) && compareVersion(latest.version, localVersion) > 0 && latest.action !== 0;
    if (hasUpdate) return { ...answer, state: 'update' };
    const packs = packList(latest.prePatch);
    if (!packs.length) return answer;
    const scanned = await scanDiffs(installRoot, packs);
    const done = !scanned.missing.length && scanned.matched.length > 0;
    const report = {
      ...answer,
      state: done ? 'done' : 'available',
      completed: done,
      packs: packs.length,
      matchedPacks: scanned.matched.length,
      missingPacks: scanned.missing.length,
      bytesDone: scanned.bytesDone,
      bytesTotal: scanned.bytesTotal,
      cdKey: String(latest.prePatch?.cd_key || ''),
    };
    if (!done || !verify) return report;
    // done 本来就是逐个 size+md5 比出来的，verify 只是把 md5 重算一遍确认没被改。
    let broken = 0;
    for (const item of scanned.matched) {
      const pack = packs.find((entry) => packFileName(entry.url) === item.name);
      if (pack?.md5 && (await md5File(item.file)) !== pack.md5) broken += 1;
    }
    return { ...report, verified: broken === 0, brokenFiles: broken };
  } catch (error) {
    return { supported: true, state: 'error', error: error.message, installRoot };
  }
}

/** 单个 zip 分包：.tmp + Range 续传 + MD5，通过才就位。不解压。 */
async function downloadPack(pack, target, signal, onTick) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  let offset = 0;
  try {
    const stat = await fsp.stat(tmp);
    offset = Number(stat.size) || 0;
    if (pack.size && offset > pack.size) {
      await fsp.rm(tmp, { force: true });
      offset = 0;
    }
  } catch {
    offset = 0;
  }
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfCancelled(signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    try {
      const headers = { 'user-agent': UA };
      if (offset > 0) headers.range = `bytes=${offset}-`;
      const response = await fetch(pack.url, { headers, signal: controller.signal });
      if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
      if (response.status === 206) {
        const from = Number((response.headers.get('content-range') || '').split('/')[0]?.split('-')[0]);
        if (Number.isFinite(from)) offset = from;
      } else {
        offset = 0;
      }
      let resumed = false;
      try {
        resumed = offset > 0 && (await fsp.stat(tmp)).size >= offset;
      } catch {
        resumed = false;
      }
      if (offset > 0 && !resumed) offset = 0;
      const handle = await fsp.open(tmp, resumed ? 'r+' : 'w');
      try {
        let position = offset;
        if (!response.body) throw new Error('响应没有数据体');
        for await (const piece of response.body) {
          throwIfCancelled(signal);
          await handle.write(piece, 0, piece.length, position);
          position += piece.length;
          onTick?.(piece.length);
        }
        await handle.truncate(position);
      } finally {
        await handle.close();
      }
      clearTimeout(timer);
      if (pack.size && (await fsp.stat(tmp)).size !== pack.size) {
        throw new Error(`大小不符（${(await fsp.stat(tmp)).size} ≠ ${pack.size}）`);
      }
      if (pack.md5 && (await md5File(tmp)) !== pack.md5) throw new Error(`${path.basename(target)} 校验失败（md5 不符）`);
      await fsp.rm(target, { force: true });
      await fsp.rename(tmp, target);
      return;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      await fsp.rm(tmp, { force: true }).catch(() => {});
      offset = 0;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw new Error(`预下载包下载失败 ${path.basename(target)}：${lastError?.message || '未知错误'}`);
}

async function startEndfieldPredownload({ channel, installRoot, signal, onProgress }) {
  const profile = profileFor(channel);
  if (!profile) throw new Error('没有这个终末地渠道');
  if (!supported(channel)) throw new Error('Steam 渠道的更新由 Steam 自己负责，没有预下载包');
  if (!looksInstalled(installRoot)) {
    throw new Error('这个目录里没有装好的终末地（需要 Endfield.exe + config.ini）');
  }
  const localVersion = readLocalVersion(installRoot);
  const latest = await fetchLatest(profile, localVersion);
  if (localVersion && compareVersion(latest.version, localVersion) > 0 && latest.action !== 0) {
    throw new Error(`正式版 ${latest.version} 已经上线，请直接更新，不需要预下载`);
  }
  const packs = packList(latest.prePatch);
  if (!packs.length) throw new Error('官方当前没有开放这个版本的预下载');

  const dir = diffsDirOf(installRoot);
  await fsp.mkdir(dir, { recursive: true });
  const target = String(latest.prePatch?.version || latest.version);
  const totalBytes = packs.reduce((sum, pack) => sum + pack.size, 0);
  let processed = 0;
  let downloaded = 0;
  let skipped = 0;
  let bytesDone = 0;

  for (const pack of packs) {
    await waitIfPaused(signal);
    throwIfCancelled(signal);
    processed += 1;
    const name = packFileName(pack.url);
    const file = path.join(dir, name);
    let reused = false;
    try {
      const stat = await fsp.stat(file);
      if (!pack.size || stat.size === pack.size) {
        reused = !pack.md5 || (await md5File(file)) === pack.md5;
      }
    } catch {
      reused = false;
    }
    if (reused) {
      skipped += 1;
      bytesDone += pack.size;
      onProgress?.({
        phase: 'download',
        current: name,
        processed,
        total: packs.length,
        downloaded,
        skipped,
        bytesDone,
        totalBytes,
      });
      continue;
    }
    await downloadPack(pack, file, signal, (delta) => {
      bytesDone += delta;
      onProgress?.({
        phase: 'download',
        current: name,
        processed,
        total: packs.length,
        downloaded,
        skipped,
        bytesDone,
        totalBytes,
      });
    });
    downloaded += 1;
    onProgress?.({
      phase: 'download',
      current: name,
      processed,
      total: packs.length,
      downloaded,
      skipped,
      bytesDone,
      totalBytes,
    });
  }

  return {
    ok: true,
    kind: 'endfield',
    channel,
    localVersion,
    targetVersion: target,
    dir,
    packs: packs.length,
    downloaded,
    reused: skipped,
    totalBytes,
    installRoot,
    // 预下载到此为止：不解压、不改 config.ini、不动任何游戏文件
    applied: false,
  };
}

function runSevenZip(zip, args) {
  return new Promise((resolve, reject) => {
    execFile(zip, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`解压失败：${String(stderr || stdout || error.message).slice(0, 400)}`));
      else resolve();
    });
  });
}

function hpatchzPath() {
  return path.join(__dirname, 'vendor', 'hpatchz.exe');
}

async function applyPatchNode({ installRoot, tempDir, stageDir, vfsBase, item }) {
  const name = String(item.name || '').replace(/\\/g, '/');
  if (!name || name.includes('..')) throw new Error(`patch.json 里有非法文件名：${name}`);
  const target = path.join(stageDir, name);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  // ① 包里带了完整文件：直接拷过去，按目标 md5 校验。
  if (item.local_path) {
    const source = path.join(tempDir, String(item.local_path).replace(/\\/g, '/'));
    await fsp.copyFile(source, target);
    if (item.md5 && (await md5File(target)) !== String(item.md5).toLowerCase()) {
      throw new Error(`更新包里的文件校验失败：${name}`);
    }
    return 'copy';
  }

  // ② 有差分节点：拿本地老文件 + 补丁合并。
  const nodes = Array.isArray(item.patch) ? item.patch : [];
  if (nodes.length) {
    const node = nodes[0];
    const diffFile = path.join(tempDir, String(node.patch || '').replace(/\\/g, '/'));
    if (!fs.existsSync(diffFile)) throw new Error(`diff file missing：${node.patch}`);
    const baseRelative = String(node.base_file || '').replace(/\\/g, '/');
    const basePath = baseRelative
      ? path.join(installRoot, vfsBase, baseRelative)
      : path.join(installRoot, vfsBase, name);
    if (!fs.existsSync(basePath)) throw new Error(`base file missing：${basePath}`);
    if (node.base_md5 && (await md5File(basePath)) !== String(node.base_md5).toLowerCase()) {
      throw new Error(`base file 校验失败：${baseRelative || name}`);
    }
    const output = `${target}.hpatch`;
    await execFileAsync(hpatchzPath(), [basePath, diffFile, output], {
      windowsHide: true,
      timeout: 300000,
    });
    if (item.md5 && (await md5File(output)) !== String(item.md5).toLowerCase()) {
      await fsp.rm(output, { force: true });
      throw new Error(`差分结果校验失败：${name}`);
    }
    await fsp.rm(target, { force: true });
    await fsp.rename(output, target);
    return 'patch';
  }

  // ③ 只要求文件存在且正确：不动它，只做校验（缺失就报出来，交给整包兜底）。
  const current = path.join(installRoot, vfsBase, name);
  if (fs.existsSync(current)) {
    if (item.md5 && (await md5File(current)) !== String(item.md5).toLowerCase()) {
      throw new Error(`已存在的文件校验失败：${name}`);
    }
    return 'verify';
  }
  throw new Error(`更新包里既没有完整文件也没有差分：${name}`);
}

async function mirrorDir(source, target, skip = () => false) {
  const stack = [['', '']];
  while (stack.length) {
    const [relSource, relTarget] = stack.pop();
    const from = path.join(source, relSource);
    const to = path.join(target, relTarget);
    await fsp.mkdir(to, { recursive: true });
    const entries = await fsp.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const childSource = path.join(relSource, entry.name);
      const childTarget = path.join(relTarget, entry.name);
      if (skip(childSource, entry)) continue;
      if (entry.isDirectory()) {
        stack.push([childSource, childTarget]);
      } else if (entry.isFile()) {
        await fsp.mkdir(path.dirname(path.join(target, childTarget)), { recursive: true });
        await fsp.copyFile(path.join(source, childSource), path.join(target, childTarget));
      }
    }
  }
}

async function moveDirContents(source, target) {
  const stack = [['', '']];
  while (stack.length) {
    const [relSource, relTarget] = stack.pop();
    const from = path.join(source, relSource);
    const to = path.join(target, relTarget);
    await fsp.mkdir(to, { recursive: true });
    const entries = await fsp.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const childSource = path.join(relSource, entry.name);
      const childTarget = path.join(relTarget, entry.name);
      const fromPath = path.join(source, childSource);
      const toPath = path.join(target, childTarget);
      if (entry.isDirectory()) {
        stack.push([childSource, childTarget]);
      } else if (entry.isFile()) {
        await fsp.mkdir(path.dirname(toPath), { recursive: true });
        await fsp.rm(toPath, { force: true });
        await fsp.rename(fromPath, toPath);
      }
    }
  }
}

/**
 * 正式版上线后应用预下载内容。
 *
 * 顺序和鹰角官方一致：命中已下的包 → 解压（cd_key）→ patch.json 差分 → stage → commit → 删 Diffs。
 * 所有写入都先落在临时目录，任何一步校验失败就整体中止，绝不会把半成品写进游戏目录。
 */
async function applyEndfieldPredownload({ channel, installRoot, signal, onProgress }) {
  const profile = profileFor(channel);
  if (!profile) throw new Error('没有这个终末地渠道');
  if (!supported(channel)) throw new Error('Steam 渠道的更新由 Steam 自己负责');
  if (!looksInstalled(installRoot)) throw new Error('这个目录里没有装好的终末地');

  const localVersion = readLocalVersion(installRoot);
  const latest = await fetchLatest(profile, localVersion);
  const packs = packList(latest.patch);
  if (!packs.length) {
    throw new Error(
      '官方这次没有发布增量包（只给了整包），启动器无法应用预下载内容。请在官方启动器里完成这次更新，或用启动器的「更新游戏」走逐文件校验。'
    );
  }

  const dir = diffsDirOf(installRoot);
  const scanned = await scanDiffs(installRoot, packs);
  if (scanned.missing.length) {
    throw new Error(
      `预下载内容不完整：正式更新需要 ${packs.length} 个包，Diffs/ 里只命中 ${scanned.matched.length} 个，还缺 ${scanned.missing.length} 个。请先把预下载跑完。`
    );
  }

  const zip = findSevenZip();
  if (!zip) throw new Error('没找到 7-Zip，无法解压预下载包（装一个 7-Zip 或装官方鹰角启动器）');

  const tempDir = path.join(installRoot, '_Hg_DeltaTemp');
  const stageDir = path.join(installRoot, '_Hg_ApplyStage');
  await fsp.rm(tempDir, { recursive: true, force: true });
  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(tempDir, { recursive: true });
  await fsp.mkdir(stageDir, { recursive: true });

  try {
    throwIfCancelled(signal);
    onProgress?.({ phase: 'extract', current: '解压预下载包' });
    // 分卷包：解压第一卷，7z 会自动连读 .002 / .003 …
    const ordered = [...scanned.matched].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const args = ['x', ordered[0].file, `-o${tempDir}`, '-y'];
    if (latest.patch?.cd_key) args.push(`-p${latest.patch.cd_key}`);
    await runSevenZip(zip, args);

    let manifest = null;
    const localPatchJson = path.join(tempDir, 'patch.json');
    try {
      if ((await fsp.stat(localPatchJson)).size > 0) {
        manifest = JSON.parse(await fsp.readFile(localPatchJson, 'utf8'));
      }
    } catch {
      manifest = null;
    }
    if (!manifest && latest.patch?.v2_patch_info_url) {
      const response = await fetch(latest.patch.v2_patch_info_url, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`差分清单下载失败：HTTP ${response.status}`);
      manifest = await response.json();
    }
    if (!manifest) throw new Error('更新包里没有 patch.json，服务端也没给差分清单地址，无法安全应用');

    const vfsBase = String(manifest.vfs_base_path || 'Hg_Data/StreamingAssets/VFS').replace(/\//g, path.sep);

    // 静态文件（包里带的新版非 VFS 文件）先铺到 stage
    onProgress?.({ phase: 'stage', current: '整理更新内容' });
    await mirrorDir(tempDir, stageDir, (relative) => {
      const normalized = String(relative).replace(/\\/g, '/');
      if (PATCH_META_FILES.has(normalized)) return true;
      if (normalized.startsWith('vfs_files/')) return true;
      if (normalized.startsWith('diff_')) return true;
      return false;
    });

    const items = Array.isArray(manifest.files) ? manifest.files : [];
    let patched = 0;
    let copied = 0;
    let verified = 0;
    for (let index = 0; index < items.length; index += 1) {
      throwIfCancelled(signal);
      const kind = await applyPatchNode({
        installRoot,
        tempDir,
        stageDir,
        vfsBase,
        item: items[index],
      });
      if (kind === 'patch') patched += 1;
      else if (kind === 'copy') copied += 1;
      else verified += 1;
      onProgress?.({
        phase: 'patch',
        current: items[index].name,
        processed: index + 1,
        total: items.length,
        patched,
        copied,
        verified,
      });
    }

    // 到这里所有内容都校验过了，才允许落盘
    onProgress?.({ phase: 'commit', current: '写入游戏目录' });
    await moveDirContents(stageDir, installRoot);

    const deleteList = path.join(tempDir, 'deletefiles.txt');
    let deleted = 0;
    try {
      const text = await fsp.readFile(deleteList, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const relative = line.trim().replace(/\\/g, '/');
        if (!relative || relative.includes('..')) continue;
        const target = path.join(installRoot, relative);
        if (fs.existsSync(target)) {
          await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
          deleted += 1;
        }
      }
    } catch {
      /* 没有删除清单就跳过 */
    }

    // 版本号写在包里的 config.ini 上，用它的才算真的更新完
    const packedConfig = path.join(tempDir, 'config.ini');
    if (fs.existsSync(packedConfig)) {
      await fsp.rm(path.join(installRoot, 'config.ini'), { force: true });
      await fsp.copyFile(packedConfig, path.join(installRoot, 'config.ini'));
    } else {
      await writePlainVersion(installRoot, latest.version);
    }

    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    return {
      ok: true,
      kind: 'endfield',
      channel,
      version: latest.version,
      localVersion,
      reusedPacks: scanned.matched.length,
      patched,
      copied,
      verified,
      deleted,
      installRoot,
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 包里没带 config.ini 时的兜底：把版本号写回加密的 config.ini。 */
async function writePlainVersion(installRoot, version) {
  const file = path.join(installRoot, 'config.ini');
  try {
    const text = decryptManifest(fs.readFileSync(file));
    const lines = text.split(/\r?\n/);
    let found = false;
    const next = lines.map((line) => {
      if (!line.trim().startsWith('version=')) return line;
      found = true;
      return `version=${version}`;
    });
    if (!found) next.push(`version=${version}`);
    await fsp.rm(file, { force: true });
    await fsp.writeFile(file, encryptManifest(next.join('\n')));
  } catch (error) {
    throw new Error(`写回版本号失败：${error.message}`);
  }
}

async function clearEndfieldPredownload({ installRoot }) {
  if (!installRoot) throw new Error('缺少游戏目录');
  await fsp.rm(diffsDirOf(installRoot), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(installRoot, '_Hg_DeltaTemp'), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(installRoot, '_Hg_ApplyStage'), { recursive: true, force: true }).catch(() => {});
  return { ok: true, installRoot };
}

module.exports = {
  DIFFS_DIR,
  supported,
  profileFor,
  checkEndfieldPredownload,
  startEndfieldPredownload,
  applyEndfieldPredownload,
  clearEndfieldPredownload,
  diffsDirOf,
  readLocalVersion,
  compareVersion,
};
