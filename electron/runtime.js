'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function shouldSkipDir(name) {
  return ['.git', 'node_modules', '.vela-linked-runtime', 'crashsightlog', 'sdklogs'].includes(
    name.toLowerCase()
  );
}

async function walkFiles(root, signal, onProgress) {
  const files = [];
  let lastScan = 0;
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
        /*
         * 扫描本身也要报进度。一万三千个文件挨个 stat，冷缓存下就是几十秒，
         * 这段时间一个事件都不发，界面会停在「读取官方清单…」不动，看着像卡死。
         */
        const now = Date.now();
        if (onProgress && now - lastScan > 400) {
          lastScan = now;
          onProgress({ scanned: files.length, current: rel });
        }
      }
    }
  }
  await walk(root, '');
  return files;
}

async function hardlinkTree({ sourceRoot, targetRoot, onProgress = () => {}, signal, copyDirs = [] }) {
  const files = await walkFiles(sourceRoot, signal, (progress) =>
    onProgress({
      phase: 'scan',
      processed: progress.scanned,
      total: 0,
      current: `扫描基础客户端：${progress.current}`,
    })
  );
  let processed = 0;
  let linked = 0;
  let copied = 0;
  let lastEmit = 0;
  const copyPrefixes = copyDirs.map((dir) => dir.toLowerCase());
  for (const file of files) {
    if (signal && signal.cancelled) break;
    const destination = path.join(targetRoot, file.rel);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const slash = file.rel.indexOf('/');
    const backslash = file.rel.indexOf('\\');
    let end = slash;
    if (end < 0 || (backslash >= 0 && backslash < end)) end = backslash;
    const topDir = (end < 0 ? file.rel : file.rel.slice(0, end)).toLowerCase();
    const shouldCopy = copyPrefixes.indexOf(topDir) >= 0;
    try {
      if (shouldCopy) {
        await fsp.copyFile(file.full, destination);
        copied += 1;
      } else {
        await fsp.link(file.full, destination);
        linked += 1;
      }
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
    // 目标可能是从基础客户端硬链接过来的同 inode 文件。直接 copyFile 会原地覆盖，
    // 把基础客户端/别的渠道一起改掉；先删除链接，再写成独立文件。
    await fsp.rm(destination, { force: true });
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

/**
 * 删一棵目录树，删不掉就让旧目录「让路」。
 *
 * 运行时目录里的文件都是从基础客户端硬链接过来的，其中内嵌 Chromium 的缓存目录
 * （原神是 YuanShen_Data\webCaches\<版本>\Service Worker，星铁/绝区零同理）经常
 * 被残留句柄或只读属性咬住。以前直接 fsp.rm({ recursive, force }) 一句，rmdir
 * 一失败整个任务就抛异常，而界面上进度条还停在「读取官方清单」—— 看着像卡死，
 * 其实任务早就挂了。
 *
 * 三档处理：带重试的整树删除 → 逐项删除只看真正删不掉的 → 整体改名让路
 * （同卷 rename 只要求父目录可写，子目录里的句柄不挡路）。只有改名也失败才抛错，
 * 且抛的是看得懂的中文。
 */
async function removeTreeResilient(root) {
  if (!fs.existsSync(root)) return '';
  try {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return '';
  } catch {
    /* 落到逐项删 */
  }
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const stuck = [];
  for (const entry of entries) {
    try {
      await fsp.rm(path.join(root, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 6,
        retryDelay: 200,
      });
    } catch {
      stuck.push(entry.name);
    }
  }
  if (!stuck.length) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    return '';
  }
  const stalePath = `${root}.stale-${Date.now()}`;
  try {
    await fsp.rename(root, stalePath);
    return stalePath;
  } catch {
    throw new Error(
      `清理残留目录失败：${stuck.slice(0, 3).join('、')}${
        stuck.length > 3 ? ' 等' : ''
      } 正被其它程序占用。请先关闭正在运行的游戏、等杀毒软件扫描结束后再重新尝试。`
    );
  }
}

async function prepareLinkedRuntime({ baseRoot, packRoot, targetRoot, onProgress, signal, copyDirs = [] }) {
  if (!baseRoot || !fs.existsSync(baseRoot)) throw new Error('找不到基础客户端目录');
  if (!packRoot || !fs.existsSync(packRoot)) throw new Error('找不到渠道差异文件目录');
  const baseStat = await fsp.stat(baseRoot);
  const packStat = await fsp.stat(packRoot);
  if (!baseStat.isDirectory() || !packStat.isDirectory()) throw new Error('客户端或渠道目录无效');
  // 老数据里的基础路径可能带正斜杠（"G:/Arknights Endfield"），
  // path.parse('G:/x').root 是 "G:/"，跟 "G:\\" 比永远不相等，会误报「不在同一个磁盘」。
  const normalizedBase = path.normalize(baseRoot);
  const normalizedTarget = path.normalize(targetRoot);
  if (path.parse(normalizedBase).root.toLowerCase() !== path.parse(normalizedTarget).root.toLowerCase()) {
    throw new Error('链接运行时必须和基础客户端在同一个磁盘分区');
  }

  const stalePath = await removeTreeResilient(targetRoot);
  if (stalePath) {
    onProgress?.({
      phase: 'clean',
      current: `旧目录删不干净，已改名放行：${path.basename(stalePath)}`,
    });
  }
  await fsp.mkdir(targetRoot, { recursive: true });
  const linkResult = await hardlinkTree({ sourceRoot: baseRoot, targetRoot, onProgress, signal, copyDirs });
  if (signal && signal.cancelled) return { cancelled: true, ...linkResult };
  const overlayResult = await overlayDirectory({ packRoot, targetRoot, onProgress, signal });
  return {
    cancelled: Boolean(signal && signal.cancelled),
    ...linkResult,
    overlay: overlayResult,
    targetRoot,
  };
}

/**
 * 把一棵目录完整复制过去（不做硬链接）。
 *
 * 渠道包是长期缓存，往运行时里铺的时候必须复制：用硬链接的话，用户哪天在设置里
 * 「清理渠道包」就等于把游戏文件一起删了。
 */
async function copyTree(sourceRoot, targetRoot) {
  const files = await walkFiles(sourceRoot);
  for (const file of files) {
    const target = path.join(targetRoot, file.rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(file.full, target);
  }
}

module.exports = { prepareLinkedRuntime, walkFiles, hardlinkTree, copyTree, removeTreeResilient };
