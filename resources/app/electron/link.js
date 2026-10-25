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
  '__store',
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

function readSlice(handle, position, length) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(length);
    handle.read(buffer, 0, length, position, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(buffer.subarray(0, bytesRead));
    });
  });
}

async function sampleDigest(file, size) {
  if (size <= 2 * 1024 * 1024) return fullDigest(file);
  const handle = await fsp.open(file, 'r');
  try {
    const head = await readSlice(handle, 0, 1024 * 1024);
    const tail = await readSlice(handle, Math.max(0, size - 1024 * 1024), 1024 * 1024);
    return crypto.createHash('sha256').update(String(size)).update(head).update(tail).digest('hex');
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
  if (!sourceRoot || !targetRoot) throw new Error('需要源目录和目标目录');
  const sourceDrive = path.parse(sourceRoot).root.toLowerCase();
  const targetDrive = path.parse(targetRoot).root.toLowerCase();
  if (sourceDrive !== targetDrive) {
    throw new Error('两个目录不在同一个磁盘分区，Windows 无法创建硬链接');
  }
  if (path.resolve(sourceRoot).toLowerCase() === path.resolve(targetRoot).toLowerCase()) {
    throw new Error('源目录和目标目录相同');
  }

  const sourceStat = await fsp.stat(sourceRoot);
  const targetStat = await fsp.stat(targetRoot);
  if (!sourceStat.isDirectory() || !targetStat.isDirectory()) {
    throw new Error('源目录或目标目录不存在');
  }

  const sourceFiles = await collectFiles(sourceRoot, signal);
  const sourceMap = new Map(sourceFiles.map((file) => [file.rel.toLowerCase(), file]));
  const targetFiles = await collectFiles(targetRoot, signal);

  const candidates = [];
  for (const target of targetFiles) {
    if (signal.cancelled) break;
    const source = sourceMap.get(target.rel.toLowerCase());
    if (!source || source.size !== target.size) continue;
    candidates.push({ source, target });
  }

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
      const [left, right] =
        mode === 'fast'
          ? await Promise.all([sampleDigest(source.full, source.size), sampleDigest(target.full, target.size)])
          : await Promise.all([fullDigest(source.full), fullDigest(target.full)]);
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
    errors,
  };
  onProgress({ ...result, phase: 'done', current: '' });
  return result;
}

module.exports = { linkTrees, collectFiles };
