'use strict';

/*
 * 升级后自动清理「历史版本遗留的分块缓存」。
 *
 * 背景：
 *
 * 本机实测：`userData/sophon-cache/chunks` 堆了 10.99 GB / 10588 个文件，
 * 全是旧版本下载残留 —— 旧版的 sophon 分块缓存只写不删，装一次涨一次。
 * 别的用户机器是同一个量级（同一个客户端、同一份清单）。
 *
 * 分块缓存只对「同一次安装 / 更新过程中复用同一分块」有意义，跨版本 / 跨游戏
 * 复用率极低，所以升级之后旧的那堆没有任何保留价值。
 *
 * 第 1 步（task-9，已完成）已经在 electron/sophon.js 里做了「边下边清」：
 * prepareSophon 收口时会把本次用到的 cacheDir/chunks 清掉，所以**新版不会再堆积**。
 * 这个模块只管一件事：把**老版本已经堆出来的那份**在新版第一次启动时清掉，
 * 让用户不需要手动点清理。
 *
 * ⚠ 清理目标**硬编码只算一个目录**：userData/sophon-cache/chunks。
 *   绝不能改成删 sophon-cache 根目录 —— 根目录上还放着：
 *     · B服渠道 SDK 的压缩包（sophon.js:996/999 installChannelSdk 写 path.join(cacheDir, fileName)，
 *       下次安装要 readFile 复用）
 *     · manifest 前缀的清单缓存 json
 *   另外终末地语音包备份目录（userData 下的 endfield 持久化备份）删了要重下 3.7 GB，
 *   这个模块从头到尾都不引用那个路径 —— 全文件只有一个 rm 调用，目标就是 chunks。
 *
 * 整个函数是「尽力而为」：任何异常只记日志、不抛，绝不影响启动。
 */

const path = require('node:path');
const fsp = require('node:fs/promises');

/** 缓存根目录名（相对 userData）。chunks 是它下面唯一允许删的子目录。 */
const CACHE_DIR_NAME = 'sophon-cache';
const CHUNK_DIR_NAME = 'chunks';

/** 标记文件名。存在且内容与当前版本一致 ⇒ 这一版已经处理过，直接返回。 */
const MARKER_NAME = '.purged';

/** 读不到版本号时的兜底标记内容。 */
const FALLBACK_VERSION = '2.12.5';

/**
 * 把字节数格式化成人类可读的 GB（日志里用）。
 * @param {number} bytes
 * @returns {string}
 */
function formatGb(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 0.01 ? `${gb.toFixed(2)} GB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 递归统计目录下的文件数量与总字节数。
 *
 * 用显式栈而不是递归函数：10588 个文件的目录没问题，但别的用户机器上
 * 可能更深/更多，递归容易把调用栈打穿。任何一层读失败都只是少算一点，
 * 量不出来就记 0（只影响日志里的数字，不影响删不删）。
 *
 * @param {string} dir
 * @returns {Promise<{ bytes: number, files: number }>}
 */
async function measureDirectory(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      files += 1;
      try {
        const stat = await fsp.stat(full);
        bytes += stat.size || 0;
      } catch {
        /* 单个文件 stat 失败就按 0 算，不影响整体 */
      }
    }
  }
  return { bytes, files };
}

/**
 * 读标记文件内容；不存在 / 读失败都返回空串。
 * @param {string} markerPath
 * @returns {Promise<string>}
 */
async function readMarker(markerPath) {
  try {
    return String(await fsp.readFile(markerPath, 'utf8')).trim();
  } catch {
    return '';
  }
}

/**
 * 写标记文件（所在目录不存在就先建）。
 * @param {string} markerPath
 * @param {string} version
 * @returns {Promise<boolean>}
 */
async function writeMarker(markerPath, version) {
  try {
    await fsp.mkdir(path.dirname(markerPath), { recursive: true });
    await fsp.writeFile(markerPath, `${version}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 升级后清掉旧版本遗留的 sophon 分块缓存。
 *
 * @param {object} options
 * @param {string} options.userData       app.getPath('userData')
 * @param {string} [options.version]      当前启动器版本（写进标记文件）
 * @param {() => boolean} [options.isBusy] 有活跃下载/更新时返回 true —— 那时不能删
 * @param {(message: string) => void} [options.log] 日志回调（main.js 传 writeLaunchLog）
 * @returns {Promise<{ removed: boolean, skipped: string, bytes: number, files: number }>}
 */
async function purgeLegacyChunkCache(options = {}) {
  const result = { removed: false, skipped: '', bytes: 0, files: 0 };
  const userData = options && options.userData ? String(options.userData) : '';
  if (!userData) {
    result.skipped = 'no-user-data';
    return result;
  }
  const log = typeof options.log === 'function' ? options.log : () => {};
  const version = String(options.version || '').trim() || FALLBACK_VERSION;

  // 目标路径硬编码：userData/sophon-cache/chunks。除了这三个常量，不接受任何外部拼接。
  const cacheRoot = path.join(userData, CACHE_DIR_NAME);
  const target = path.join(cacheRoot, CHUNK_DIR_NAME);
  const markerPath = path.join(cacheRoot, MARKER_NAME);

  // 防御：万一将来有人改了常量导致 target 跑偏，这里直接放弃，宁可不清。
  if (path.dirname(target) !== cacheRoot || path.basename(target) !== CHUNK_DIR_NAME) {
    result.skipped = 'unsafe-target';
    return result;
  }

  try {
    // ① 标记命中 ⇒ 这一版已经处理过，零开销返回（不 readdir、不 stat）。
    if ((await readMarker(markerPath)) === version) {
      result.skipped = 'marker';
      return result;
    }

    // ② 有活跃下载 / 更新时不动手，也不写标记 —— 下次启动再试。
    //    正在装的包可能正靠这份分块缓存续传/复用。
    let busy = false;
    try {
      busy = typeof options.isBusy === 'function' ? options.isBusy() === true : false;
    } catch {
      busy = false;
    }
    if (busy) {
      result.skipped = 'busy';
      return result;
    }

    // ③ 先量一下，日志里能告诉用户到底省了多少盘。
    const measured = await measureDirectory(target);
    result.bytes = measured.bytes;
    result.files = measured.files;

    // ④ 删。force + recursive：目录不存在也当成功。
    try {
      await fsp.rm(target, { recursive: true, force: true });
    } catch (error) {
      result.skipped = 'remove-failed';
      log(`分块缓存清理失败（不影响使用）：${error && error.message ? error.message : error}`);
      return result;
    }

    // ⑤ 写标记。写失败也照样算删成功，只是下次启动会再量一遍（那时目录已空，成本极低）。
    await writeMarker(markerPath, version);

    result.removed = true;
    if (result.files > 0) {
      log(
        `分块缓存已清理：${formatGb(result.bytes)} / ${result.files} 个文件（旧版本遗留）`
      );
    }
    return result;
  } catch (error) {
    // 兜底：整个流程任何意外都不许往外抛，启动流程不能被它拖垮。
    result.skipped = 'error';
    try {
      log(`分块缓存清理异常（已忽略）：${error && error.message ? error.message : error}`);
    } catch {
      /* ignore */
    }
    return result;
  }
}

module.exports = { purgeLegacyChunkCache };
