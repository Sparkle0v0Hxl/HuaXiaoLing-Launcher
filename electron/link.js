'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'crashpad',
  'logs',
  'log',
  'webcaches',
  'browsercache',
  'cache',
  'temp',
  'tmp',
  '.xel-linked-runtime',
  '.vela-linked-runtime',
  'velaruntimes',
  '__store',
  /*
   * 渠道登录态目录，绝不能硬链接。
   *
   * 终末地的 U8Data/config 存渠道登录态，sdkdata 存 SDK 渠道配置。
   * 两个渠道共用同一份硬链接时，一边登录就会原地改写另一边的配置 ——
   * 表现是「切回官服登录页消失/卡死」和「B服启动仍是官服账号」。
   * 这两个目录本来就该各渠道一份独立副本，所以硬链接阶段直接跳过。
   */
  'u8data',
  'sdkdata',
]);

const SKIP_EXT = new Set(['.log', '.tmp', '.part', '.lock', '.pid']);

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name.toLowerCase());
}

function shouldSkipFile(name) {
  return SKIP_EXT.has(path.extname(name).toLowerCase());
}

async function collectFiles(root, signal) {
  const files = [];
  async function walk(dir, relative) {
    if (signal && signal.cancelled) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (signal && signal.cancelled) return;
      const rel = relative ? `${relative}\\${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        await walk(full, rel);
      } else if (entry.isFile()) {
        if (shouldSkipFile(entry.name)) continue;
        let stat;
        try {
          stat = await fsp.stat(full);
        } catch {
          continue;
        }
        if (stat.size > 0) files.push({ rel, full, size: stat.size });
      }
    }
  }
  await walk(root, '');
  return files;
}

/*
 * 按偏移读一块。
 *
 * 这里必须用 FileHandle 的 Promise 形式：原来写的是 fs.read 那套
 * `handle.read(buf, 0, len, pos, callback)`，实测在 Electron 的 Node 模式下
 * 回调根本不触发，Promise 永远悬着 —— 表现是「点开始比较就一直停在 0%」，
 * 既不报错也不返回。改成 await 拿 { bytesRead } 就没有这个问题。
 */
async function readSlice(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/*
 * 快速比较的采样参数。
 *
 * 原来固定只比「头 / 中 / 尾」各 1MB：256MB 的文件只覆盖 3MB（1.2%）。这个密度下
 * 「头尾一样、中间某一段不同」的大文件会被判成相同，硬链接一建就等于用源文件的内容
 * 顶掉目标文件 —— 那是数据损坏，不是节省空间。
 *
 * 现在改成按固定步长均匀取点，覆盖密度从 1.2% 提到 25%（256MB 时约 65 个点）：
 *   - 8MB 以下直接全量算，采样没有意义；
 *   - 8MB ~ 256MB 每 4MB 取一个 1MB 的块，另加末尾一个块覆盖不足 4MB 的尾巴；
 *   - 超过 256MB 仍然全量 —— 这种量级下省下的读盘时间抵不上一次误判的代价。
 * 快速模式仍然只是「先试跑看看大概能省多少」的选项，默认走完整校验。
 */
const SAMPLE_BLOCK = 1024 * 1024;
const SAMPLE_STEP = 4 * 1024 * 1024;
const SAMPLE_FULL_BELOW = 8 * 1024 * 1024;
const SAMPLE_FULL_ABOVE = 256 * 1024 * 1024;

/**
 * 采样偏移表；返回 null 表示「这个大小不该采样，直接全量算」。
 * 纯函数，便于单测：偏移必须落在文件内、互不重叠、且首点是 0、末点贴住文件尾。
 */
function sampleOffsets(size) {
  const total = Number(size) || 0;
  if (total <= SAMPLE_FULL_BELOW || total > SAMPLE_FULL_ABOVE) return null;
  const offsets = [];
  for (let pos = 0; pos + SAMPLE_BLOCK <= total; pos += SAMPLE_STEP) offsets.push(pos);
  const tail = total - SAMPLE_BLOCK;
  if (tail > 0 && (offsets.length === 0 || offsets[offsets.length - 1] !== tail)) offsets.push(tail);
  return offsets;
}

async function sampleDigest(file, size) {
  const offsets = sampleOffsets(size);
  if (!offsets) return fullDigest(file);
  const handle = await fsp.open(file, 'r');
  try {
    const hash = crypto.createHash('sha256').update(String(size));
    for (const offset of offsets) {
      const slice = await readSlice(handle, offset, SAMPLE_BLOCK);
      hash.update(slice);
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function fullDigest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function sameInode(a, b) {
  try {
    const [left, right] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
    return left.dev === right.dev && left.ino === right.ino && left.ino !== 0;
  } catch {
    return false;
  }
}

async function replaceWithLink(source, target) {
  const tmp = `${target}.hxlink-${process.pid}-${Date.now()}`;
  await fsp.link(source, tmp);
  try {
    await fsp.rename(tmp, target);
  } catch (error) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/**
 * 解析两个待比较的根目录，顺便做同盘校验。
 *
 * linkTrees 和 previewTrees 用的是同一套规则，抽出来免得两边改漏一处。
 */
function resolveRoots(sourceRoot, targetRoot) {
  if (!sourceRoot || !targetRoot) throw new Error('需要源目录和目标目录');
  /*
   * 先 normalize 再取盘符：手填的路径可能是 "G:/Arknights Endfield"（正斜杠），
   * path.parse('G:/x').root 得到 "G:/"，和目标盘符 "G:\\" 永远不相等，
   * 用户就会看到「两个目录不在同一个磁盘分区」——其实是同一块盘。
   */
  const sourceDrive = path.parse(path.normalize(sourceRoot)).root.toLowerCase();
  const targetDrive = path.parse(path.normalize(targetRoot)).root.toLowerCase();
  if (sourceDrive !== targetDrive) {
    throw new Error('两个目录不在同一个磁盘分区，Windows 无法创建硬链接');
  }
  if (path.resolve(sourceRoot).toLowerCase() === path.resolve(targetRoot).toLowerCase()) {
    throw new Error('源目录和目标目录相同');
  }
  return { sourceRoot, targetRoot };
}

async function buildCandidates(sourceRoot, targetRoot, signal) {
  const sourceFiles = await collectFiles(sourceRoot, signal);
  const sourceMap = new Map(sourceFiles.map((file) => [file.rel.toLowerCase(), file]));
  const targetFiles = await collectFiles(targetRoot, signal);

  const candidates = [];
  let targetOnly = 0;
  let targetOnlyBytes = 0;
  let sizeMismatch = 0;

  for (const target of targetFiles) {
    if (signal && signal.cancelled) break;
    const source = sourceMap.get(target.rel.toLowerCase());
    if (!source) {
      targetOnly += 1;
      targetOnlyBytes += target.size;
      continue;
    }
    if (source.size !== target.size) {
      sizeMismatch += 1;
      continue;
    }
    candidates.push({ source, target });
  }

  const targetBytes = targetFiles.reduce((sum, file) => sum + file.size, 0);
  return {
    candidates,
    stats: {
      sourceFiles: sourceFiles.length,
      targetFiles: targetFiles.length,
      targetBytes,
      targetOnly,
      targetOnlyBytes,
      sizeMismatch,
    },
  };
}

/**
 * 只检测、不改动任何文件。
 *
 * 建立硬链接是不可逆的写操作，让用户在动手前先看清楚「能合并多少、能省多少」，
 * 确认之后再走 linkTrees。这一步不会创建、删除或替换任何文件。
 */
async function previewTrees({
  sourceRoot,
  targetRoot,
  mode = 'full',
  onProgress = () => {},
  signal = { cancelled: false },
}) {
  const roots = resolveRoots(sourceRoot, targetRoot);
  const sourceStat = await fsp.stat(roots.sourceRoot);
  const targetStat = await fsp.stat(roots.targetRoot);
  if (!sourceStat.isDirectory() || !targetStat.isDirectory()) {
    throw new Error('源目录或目标目录不存在');
  }

  onProgress({ phase: 'scan', processed: 0, total: 0, current: '正在扫描两个客户端…' });
  const { candidates, stats } = await buildCandidates(roots.sourceRoot, roots.targetRoot, signal);

  const total = candidates.length;
  let processed = 0;
  let matchable = 0;
  let matchableBytes = 0;
  let alreadyLinked = 0;
  let alreadyLinkedBytes = 0;
  let different = 0;
  let differentBytes = 0;
  const errors = [];
  let lastEmit = 0;

  const emit = (current = '') => {
    const now = Date.now();
    if (now - lastEmit < 180) return;
    lastEmit = now;
    onProgress({
      phase: 'compare',
      processed,
      total,
      matchable,
      matchableBytes,
      alreadyLinked,
      different,
      current,
    });
  };

  for (const pair of candidates) {
    if (signal.cancelled) break;
    const { source, target } = pair;
    processed += 1;
    try {
      if (await sameInode(source.full, target.full)) {
        alreadyLinked += 1;
        alreadyLinkedBytes += target.size;
        emit(target.rel);
        continue;
      }
      const [left, right] =
        mode === 'fast'
          ? await Promise.all([sampleDigest(source.full, source.size), sampleDigest(target.full, target.size)])
          : await Promise.all([fullDigest(source.full), fullDigest(target.full)]);
      if (left === right) {
        matchable += 1;
        matchableBytes += target.size;
      } else {
        different += 1;
        differentBytes += target.size;
      }
      emit(target.rel);
    } catch (error) {
      errors.push({ file: target.rel, message: error.message });
      emit(target.rel);
    }
  }

  const result = {
    ok: true,
    cancelled: Boolean(signal.cancelled),
    total,
    processed,
    matchable,
    matchableBytes,
    alreadyLinked,
    alreadyLinkedBytes,
    different,
    differentBytes,
    errors,
    ...stats,
  };
  onProgress({ ...result, phase: 'done', current: '' });
  return result;
}

/**
 * 把 targetRoot 中与 sourceRoot 字节完全相同的文件替换为硬链接。
 * 只处理两个目录中都存在且大小相同的文件，绝不删除内容不同的文件。
 */
async function linkTrees({
  sourceRoot,
  targetRoot,
  mode = 'full',
  onProgress = () => {},
  signal = { cancelled: false },
}) {
  const roots = resolveRoots(sourceRoot, targetRoot);
  const sourceStat = await fsp.stat(roots.sourceRoot);
  const targetStat = await fsp.stat(roots.targetRoot);
  if (!sourceStat.isDirectory() || !targetStat.isDirectory()) {
    throw new Error('源目录或目标目录不存在');
  }

  const { candidates } = await buildCandidates(roots.sourceRoot, roots.targetRoot, signal);

  const total = candidates.length;
  let processed = 0;
  let linked = 0;
  let savedBytes = 0;
  let skipped = 0;
  const errors = [];
  let lastEmit = 0;

  const emit = (phase, current = '') => {
    const now = Date.now();
    if (phase !== 'done' && now - lastEmit < 180) return;
    lastEmit = now;
    onProgress({
      phase,
      processed,
      total,
      linked,
      savedBytes,
      skipped,
      current,
    });
  };

  emit('compare');
  for (const pair of candidates) {
    if (signal.cancelled) break;
    const { source, target } = pair;
    processed += 1;
    try {
      if (await sameInode(source.full, target.full)) {
        skipped += 1;
        emit('compare', target.rel);
        continue;
      }
      /*
       * 执行阶段一律完整校验，不接受抽样。
       *
       * 抽样（哪怕把覆盖密度提到 25%）本质上仍是概率判定：两个「采样点相同、
       * 其余部分不同」的文件被判成一样，紧接着 replaceWithLink 就会把目标文件
       * 换成源文件的 inode —— 目标文件的内容被直接顶掉，是数据损坏，不是省空间。
       * 预览阶段只统计、不落地，抽样用来估算没问题；真正动手时多读一遍盘，
       * 换的是「绝不会链错」，这个代价必须付。
       */
      const [left, right] = await Promise.all([fullDigest(source.full), fullDigest(target.full)]);
      if (left !== right) {
        skipped += 1;
        emit('compare', target.rel);
        continue;
      }
      await replaceWithLink(source.full, target.full);
      linked += 1;
      savedBytes += target.size;
      emit('link', target.rel);
    } catch (error) {
      errors.push({ file: target.rel, message: error.message });
      skipped += 1;
      emit('compare', target.rel);
    }
  }

  const result = {
    ok: true,
    cancelled: Boolean(signal.cancelled),
    total,
    processed,
    linked,
    skipped,
    savedBytes,
    // 执行阶段固定完整校验，与调用方传进来的 mode 无关（原因见循环内注释）
    verifiedMode: 'full',
    // 调用方可能仍传了 fast；这里显式声明已忽略，避免读代码的人以为它生效了
    requestedMode: String(mode || 'full'),
    errors,
  };
  onProgress({ ...result, phase: 'done', current: '' });
  return result;
}

module.exports = {
  linkTrees,
  previewTrees,
  collectFiles,
  // 采样策略对外暴露，便于自测直接验「偏移是否覆盖均匀、是否越界」
  sampleOffsets,
  sampleDigest,
  SAMPLE_BLOCK,
  SAMPLE_STEP,
  SAMPLE_FULL_BELOW,
  SAMPLE_FULL_ABOVE,
};
