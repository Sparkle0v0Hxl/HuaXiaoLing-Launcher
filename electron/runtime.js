'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function shouldSkipDir(name) {
  return ['.git', 'node_modules', '.vela-linked-runtime', 'crashsightlog', 'sdklogs'].includes(
    name.toLowerCase()
  );
}

async function walkFiles(root, signal) {
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
      if (entry.isSymbolicLink()) continue;
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        await walk(full, rel);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = await fsp.stat(full);
        } catch {
          continue;
        }
        files.push({ rel, full, size: stat.size });
      }
    }
  }
  await walk(root, '');
  return files;
}

async function hardlinkTree({ sourceRoot, targetRoot, onProgress = () => {}, signal }) {
  const files = await walkFiles(sourceRoot, signal);
  let processed = 0;
  let linked = 0;
  let copied = 0;
  let lastEmit = 0;
  for (const file of files) {
    if (signal && signal.cancelled) break;
    const destination = path.join(targetRoot, file.rel);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fsp.link(file.full, destination);
      linked += 1;
    } catch {
      try {
        await fsp.copyFile(file.full, destination);
        copied += 1;
      } catch (error) {
        throw new Error(`无法创建 ${file.rel}：${error.message}`);
      }
    }
    processed += 1;
    const now = Date.now();
    if (now - lastEmit > 160) {
      lastEmit = now;
      onProgress({
        phase: 'link',
        processed,
        total: files.length,
        linked,
        copied,
        current: file.rel,
      });
    }
  }
  return { total: files.length, processed, linked, copied };
}

async function overlayDirectory({ packRoot, targetRoot, onProgress = () => {}, signal }) {
  const files = await walkFiles(packRoot, signal);
  let processed = 0;
  let lastEmit = 0;
  for (const file of files) {
    if (signal && signal.cancelled) break;
    const destination = path.join(targetRoot, file.rel);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fsp.copyFile(file.full, destination);
    } catch (error) {
      throw new Error(`无法写入渠道文件 ${file.rel}：${error.message}`);
    }
    processed += 1;
    const now = Date.now();
    if (now - lastEmit > 160) {
      lastEmit = now;
      onProgress({
        phase: 'overlay',
        processed,
        total: files.length,
        current: file.rel,
      });
    }
  }
  return { total: files.length, processed };
}

async function prepareLinkedRuntime({ baseRoot, packRoot, targetRoot, onProgress, signal }) {
  if (!baseRoot || !fs.existsSync(baseRoot)) throw new Error('找不到基础客户端目录');
  if (!packRoot || !fs.existsSync(packRoot)) throw new Error('找不到渠道差异文件目录');
  const baseStat = await fsp.stat(baseRoot);
  const packStat = await fsp.stat(packRoot);
  if (!baseStat.isDirectory() || !packStat.isDirectory()) throw new Error('客户端或渠道目录无效');
  if (path.parse(baseRoot).root.toLowerCase() !== path.parse(targetRoot).root.toLowerCase()) {
    throw new Error('链接运行时必须和基础客户端在同一个磁盘分区');
  }

  await fsp.rm(targetRoot, { recursive: true, force: true });
  await fsp.mkdir(targetRoot, { recursive: true });
  const linkResult = await hardlinkTree({ sourceRoot: baseRoot, targetRoot, onProgress, signal });
  if (signal && signal.cancelled) return { cancelled: true, ...linkResult };
  const overlayResult = await overlayDirectory({ packRoot, targetRoot, onProgress, signal });
  return {
    cancelled: Boolean(signal && signal.cancelled),
    ...linkResult,
    overlay: overlayResult,
    targetRoot,
  };
}

module.exports = { prepareLinkedRuntime, walkFiles, hardlinkTree };
