'use strict';

/**
 * 异环 启动器侧资源预下载（官服 / B服 通用）。
 *
 * 体系逆向自官方 CDN 并已实测验证（2026-10-29）：
 *   1. Config.ini [VERSION] VersionInfoFileURL = .../publish_ob[_B]/launcher/Version.ini
 *   2. Version.ini → Version / Build / FileListURL（.../launcher/<版本>_N/AllFiles.xml）
 *   3. AllFiles.xml（约 130KB）→ <File Checksum Path Size ZipChecksum ZipSize/> 逐文件清单
 *   4. 文件实体 = <FileListURL 所在目录>/<Path>.zip —— 标准 zip 单条目，
 *      zip 本身 MD5 = ZipChecksum，解压后 MD5 = Checksum，落盘到 <安装根>/NTELauncher/<Path>。
 * 全部铺好后，官方启动器启动时没有"下载"环节（游戏本体两服共用 Client 目录，不在此列；
 * 本体更新走 Patcher 机制，仍由官方启动器正常拉，属于普通游戏更新）。
 *
 * 安全边界：只新增/覆盖清单里列出的文件，绝不删除任何本地文件；路径带 .. 直接拒绝。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 找 Config.ini（复用 neverness-channels 的查找逻辑，避免两份实现）。 */
function findConfigRoot(startPath, levels = 8) {
  let dir = startPath;
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  } catch {
    /* keep going */
  }
  for (let level = 0; level < levels && dir; level += 1) {
    const candidate = path.join(dir, 'NTELauncher', 'Config', 'Config.ini');
    if (fs.existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

async function fetchText(url, signal) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

async function fetchBuffer(url, signal) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
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

/** 解析 AllFiles.xml 的 <File .../> 清单，只要四个属性。 */
function parseAllFiles(xml) {
  const files = [];
  const pattern = /<File\s+([^>]*?)\/>/g;
  const attr = (text, name) => {
    const hit = text.match(new RegExp(`${name}="([^"]*)"`));
    return hit ? hit[1] : '';
  };
  let match;
  while ((match = pattern.exec(xml))) {
    const text = match[1];
    const filePath = attr(text, 'Path');
    if (!filePath) continue;
    files.push({
      path: filePath,
      size: Number(attr(text, 'Size')) || 0,
      checksum: attr(text, 'Checksum').toLowerCase(),
      zipChecksum: attr(text, 'ZipChecksum').toLowerCase(),
    });
  }
  return files;
}

/**
 * 解压"单条目 zip"：找 EOCD → 中央目录 → 本地头，method 8 走 inflateRaw，0 直接截取。
 * 只有一个条目、无加密的官方 zip 用这套足够；完整性由外层 MD5 校验兜底。
 */
function unzipSingleEntry(buffer) {
  const eocdIndex = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdIndex < 0) throw new Error('zip 结构异常（找不到 EOCD）');
  const cdOffset = buffer.readUInt32LE(eocdIndex + 16);
  const entries = buffer.readUInt16LE(eocdIndex + 10);
  if (entries < 1) throw new Error('zip 里没有文件');
  // 读中央目录第一条
  if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('zip 中央目录异常');
  const method = buffer.readUInt16LE(cdOffset + 10);
  const compressedSize = buffer.readUInt32LE(cdOffset + 20);
  const nameLen = buffer.readUInt16LE(cdOffset + 28);
  const extraLen = buffer.readUInt16LE(cdOffset + 30);
  const commentLen = buffer.readUInt16LE(cdOffset + 32);
  const localOffset = buffer.readUInt32LE(cdOffset + 42);
  const localNameLen = buffer.readUInt16LE(localOffset + 26);
  const localExtraLen = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLen + localExtraLen;
  const data = buffer.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return buffer.subarray(dataStart, dataStart + compressedSize);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的 zip 压缩方式：${method}（name=${nameLen ? buffer.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen) : '?'} extra=${extraLen}）`);
}

/** 简易并发池：workers 个工人消化 tasks。 */
async function runPool(items, workers, job) {
  let index = 0;
  const runners = Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await job(current);
    }
  });
  await Promise.all(runners);
}

/**
 * 预下载一个渠道的全部启动器侧文件。
 * @param {{installRoot:string, channel?:string, versionUrl?:string, onProgress?:Function, signal?:AbortSignal, concurrency?:number}} options
 */
async function predownload({
  installRoot,
  channel = '',
  versionUrl = '',
  onProgress = () => {},
  signal = null,
  concurrency = 3,
}) {
  const root = findConfigRoot(installRoot);
  if (!root) throw new Error('没有找到异环安装目录（NTELauncher/Config/Config.ini）');

  // 1. Version.ini：优先用调用方给的地址，否则从 Config.ini 读，再否则按渠道拼
  let iniUrl = versionUrl;
  if (!iniUrl) {
    const iniPath = path.join(root, 'NTELauncher', 'Config', 'Config.ini');
    const text = await fsp.readFile(iniPath, 'utf8');
    const hit = text.match(/^VersionInfoFileURL=(.+)$/m);
    if (hit) iniUrl = hit[1].trim();
  }
  if (!iniUrl && channel) {
    iniUrl = `https://yhcdn1.wmupd.com/hd/publish_ob${channel === 'bilibili' ? '_B' : ''}/launcher/Version.ini`;
  }
  if (!iniUrl) throw new Error('没有找到版本清单地址（VersionInfoFileURL）');

  onProgress({ phase: 'manifest', message: '正在读取版本清单…' });
  const versionIni = await fetchText(iniUrl, signal);
  const fileListUrl = (versionIni.match(/^FileListURL=(.+)$/m) || [])[1]?.trim();
  const version = (versionIni.match(/^Version=(.+)$/m) || [])[1]?.trim() || '';
  if (!fileListUrl) throw new Error('版本清单里没有 FileListURL');

  const xml = await fetchText(fileListUrl, signal);
  const files = parseAllFiles(xml);
  if (!files.length) throw new Error('文件清单是空的');

  // zip 实体所在的目录 = AllFiles.xml 的目录
  const zipBase = fileListUrl.replace(/[^/]*$/, '');

  // 2. 找出本地缺的/坏的文件
  //    清单 Path 相对「NTELauncher 文件夹」（channelSdk/Patcher 等都在它下面），不是安装根
  const baseDir = path.join(root, 'NTELauncher');
  onProgress({ phase: 'scan', message: '正在比对本地文件…', total: files.length });
  const need = [];
  let skipped = 0;
  for (const file of files) {
    if (signal?.aborted) throw new Error('已取消');
    if (file.path.includes('..')) continue; // 路径穿越保护
    const target = path.join(baseDir, file.path.replace(/^[/\\]/, ''));
    let ok = false;
    try {
      const stat = await fsp.stat(target);
      if (!file.size || stat.size === file.size) {
        ok = file.checksum ? (await md5File(target)) === file.checksum : true;
      }
    } catch {
      ok = false;
    }
    if (ok) skipped += 1;
    else need.push({ ...file, target });
  }

  // 3. 并发下载缺的文件：zip → 校验 → 解压 → 校验 → 落盘
  const result = {
    version,
    channel,
    total: files.length,
    skipped,
    downloaded: 0,
    failed: [],
    bytes: 0,
  };
  if (need.length) {
    let done = 0;
    await runPool(need, concurrency, async (file) => {
      if (signal?.aborted) throw new Error('已取消');
      const zipUrl = `${zipBase}${file.path.replace(/^[/\\]/, '')}.zip`;
      try {
        const zipBuffer = await fetchBuffer(zipUrl, signal);
        if (file.zipChecksum && md5(zipBuffer) !== file.zipChecksum) {
          throw new Error('压缩包校验不符');
        }
        const raw = unzipSingleEntry(zipBuffer);
        // 官方清单有瑕疵条目：0 字节空文件却配了非空 md5，空文件跳过内容校验
        if (file.checksum && file.size > 0 && md5(raw) !== file.checksum) {
          throw new Error('解压后校验不符');
        }
        await fsp.mkdir(path.dirname(file.target), { recursive: true });
        await fsp.writeFile(file.target, raw);
        result.downloaded += 1;
        result.bytes += raw.length;
      } catch (error) {
        if (signal?.aborted) throw new Error('已取消');
        result.failed.push({ path: file.path, error: error.message });
      }
      done += 1;
      onProgress({
        phase: 'download',
        current: done,
        total: need.length,
        file: path.basename(file.path),
        downloadedBytes: result.bytes,
      });
    });
  }

  if (signal?.aborted) throw new Error('已取消');
  result.ok = result.failed.length === 0;
  return result;
}

/** 让进行中的预下载尽快中止（下载间与每次 fetch 都会检查）。 */
function makeAbort() {
  const controller = new AbortController();
  return controller;
}

/**
 * 异环更新检测（只查版本，不下载）。
 *
 * 数据源（都实测过）：
 *   本地启动器版本 → <安装根>/NTELauncher/Config/Config.ini 的 [VERSION] Version
 *   远程启动器版本 → VersionInfoFileURL 指到的 Version.ini（官服/B服 CDN 各一份）
 * 两边不一致 = 启动器侧资源有更新（channelSdk / Patcher / 配置等）。
 *
 * ⚠️ 覆盖范围说明：这套清单只管 NTELauncher 文件夹，游戏本体（Client）走
 * PatcherSDK 的 .sig 差分机制，远程路径未公开、sig 是二进制私有格式，
 * 本体的下载/校验暂时做不了，仍由官方启动器在启动时接管。
 * 所以检测到「有更新」时，能自动更新的只是启动器侧资源。
 */
async function checkUpdate({ installRoot, channel = '', versionUrl = '', signal }) {
  const root = findConfigRoot(installRoot);
  if (!root) {
    return {
      kind: 'nte',
      state: 'not-installed',
      localVersion: '',
      latestVersion: '',
      reason: '没有找到异环安装目录（NTELauncher/Config/Config.ini）',
    };
  }

  let iniUrl = versionUrl;
  if (!iniUrl) {
    const iniPath = path.join(root, 'NTELauncher', 'Config', 'Config.ini');
    try {
      const text = await fsp.readFile(iniPath, 'utf8');
      const hit = text.match(/^VersionInfoFileURL=(.+)$/m);
      if (hit) iniUrl = hit[1].trim();
    } catch {
      /* 下面按渠道兜底 */
    }
  }
  if (!iniUrl && channel) {
    iniUrl = `https://yhcdn1.wmupd.com/hd/publish_ob${channel === 'bilibili' ? '_B' : ''}/launcher/Version.ini`;
  }
  if (!iniUrl) {
    return {
      kind: 'nte',
      state: 'none',
      localVersion: '',
      latestVersion: '',
      reason: '没有找到版本清单地址（VersionInfoFileURL）',
    };
  }

  let localVersion = '';
  try {
    const text = await fsp.readFile(path.join(root, 'NTELauncher', 'Config', 'Config.ini'), 'utf8');
    localVersion = (text.match(/^\[VERSION\][\s\S]*?^Version=(.+)$/m) || [])[1]?.trim() || '';
  } catch {
    /* 读不到就当空 */
  }

  try {
    const ini = await fetchText(iniUrl, signal);
    const latestVersion = (ini.match(/^Version=(.+)$/m) || [])[1]?.trim() || '';
    const state = latestVersion && localVersion && latestVersion !== localVersion ? 'update' : 'none';
    return {
      kind: 'nte',
      state,
      localVersion,
      latestVersion,
      targetVersion: latestVersion,
      versionUrl: iniUrl,
      installRoot: root,
    };
  } catch (error) {
    return {
      kind: 'nte',
      state: 'error',
      localVersion,
      latestVersion: '',
      error: `读取异环版本清单失败：${error.message}`,
    };
  }
}

/** 更新启动器侧资源（就是预下载那套：AllFiles 清单 → zip → 校验 → 落盘）。 */
async function updateLauncherFiles(options) {
  return predownload(options);
}

module.exports = {
  findConfigRoot,
  parseAllFiles,
  unzipSingleEntry,
  predownload,
  makeAbort,
  checkUpdate,
  updateLauncherFiles,
};
