'use strict';

/**
 * 鸣潮 krpdiff（DirHDiff）应用器 —— 纯 Node 解析 + 仓库自带 hpatchz 执行。
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────────────────
 * 官方从 3.0.1.0 起改用 bundle 协议，正式更新的「差量包」由两层组成：
 *   ① `resource[]` 里 `.krpdiff` 结尾的目录差分文件（约 10.2GiB）
 *   ② `resource[]` 里普通整文件（约 1.8GiB）
 * 两层相加恰好等于 `patchConfig[].size`（官服 HD 档 = 12,968,784,393B ≈ 12.1GiB）。
 * 我方原先只做整文件级 size/md5 复用，实测要下 81.38GiB —— 就是没吃这层差分。
 *
 * ── 为什么不能直接把 krpdiff 丢给 hpatchz ────────────────────────────────────
 * 库洛的 krpdiff 在 headData 的列表段里**比开源 HDiffPatch 多插了一个
 * `oldRefSizeList`**，顺序是：
 *   paths → oldRefList → newRefList → **oldRefSizeList** → **newRefSizeList**
 *         → samePairList → newExecuteList → 私有保留区
 * 开源版 `dir_patch.c` 少读这一个 list，后面的 newRefSizeList / samePairList /
 * newExecuteList 全部错位，于是 leave 也对不上 `privateReservedDataSize`，
 * 表现为 exit=109（`_TStreamCacheClip_leaveSize(...)`）、exit=108（`!isFinish`）、
 * exit=106（`_isNewRefDataChecksumError`）。**9 个开源版本、三颗 exe 全都一样失败，
 * 不是因为版本不兼容，是这个结构性差异。**
 *
 * ── 我们的做法 ──────────────────────────────────────────────────────────────
 * 完全绕开 hpatchz 的 dir 模式，只把它当成单文件 HDiff 执行器：
 *   1. 纯 JS 解出头部 + headData（zstd 解压后按上面的七段顺序解析）；
 *   2. 按 `oldRefList` 的真实顺序把旧文件**流式拼接**成一个 `old.cat`；
 *   3. 把 `hdiffDataOffset` 起的内嵌段单独写成 `seg.hdiff`（嵌入段是标准 HDiff，
 *      任何版本 hpatchz 都认得 —— 实测 kuro 自带 / v4.8.0 / v5.1.3 三颗全 OK）；
 *   4. `hpatchz old.cat seg.hdiff new.bin`；
 *   5. 按 `newRefSizeList` 把 `new.bin` **流式切分**写回 `newRefList` 指向的路径。
 * 实测 official / bilibili / global 三渠道共 227 个 group，头部与 headData 全部
 * 可解析、paths 与清单完全对应、尺寸求和与头部声明逐字节相等（0 异常）；
 * 抽样 4 组（含 dir 模式曾经全失败的 group_24 / group_16 / group_9）实跑
 * hpatchz + md5 校验，**4/4 组全部精确 MATCH**。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────────
 * · 只读旧文件，绝不原地改；所有产物先写临时目录，校验通过后才落位。
 * · 临时目录必须能容纳「最大一组旧文件 + 新文件」，用完即删。
 * · 只认 `official` / `bilibili` / `global` 三渠道的清单，WeGame 不走这里。
 * · 新增顶层 require 已在 `
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

/** 单个流式读写的块大小（4MiB 与 kuro-packs.md5File / 账本脚本保持一致）。 */
const IO_CHUNK = 4 * 1024 * 1024;
/** hpatchz 单组最长执行时间。最大的组新旧各约 4.4GB，机械盘上也就几分钟。 */
const HPATCHZ_TIMEOUT_MS = 60 * 60 * 1000;

function warn(...args) {
  console.warn('[kuro-krpdiff]', ...args);
}

/** 仓库自带的 hpatchz（v5.1.3）。只当单文件执行器用，见文件头说明。 */
function hpatchzPath() {
  return path.join(__dirname, 'vendor', 'hpatchz.exe');
}

// ── 头部 / headData 解析 ─────────────────────────────────────────────────────

/**
 * 读一个 hdiffpatch 变长无符号整数。
 * 编码是**大端**：首字节 bit7 表示「还有后续」，低 7 位是最高位组；
 * 读取端 `value = (value << 7) | (code & 0x7f)`，与 `patch.c` 的
 * `hpatch_unpackUIntWithTag(kTagBit=0)` 一致。写成小端会直接错位。
 */
function readVarUInt(buf, pos, end) {
  if (pos >= end) throw new Error('krpdiff 头部越界（变长整数）');
  let code = buf[pos];
  pos += 1;
  let value = code & 0x7f;
  if (code & 0x80) {
    do {
      if (pos >= end) throw new Error('krpdiff 头部越界（变长整数续读）');
      code = buf[pos];
      pos += 1;
      // 必须用乘法，不能用 `value << 7`：JS 的位运算是 32 位有符号，超过
      // 2GiB 的尺寸（pakchunk 常见 2~7GiB）会溢出成负数，导致大组的
      // savedOldRefSize 被读成 -1.9e9，差分被误判「旧文件拼接尺寸不符」
      // 而整文件重下。乘以 128 在 Number 安全整数范围内无截断。
      value = value * 128 + (code & 0x7f);
    } while (code & 0x80);
  }
  return { value, pos };
}

/**
 * 解析 `_TDirDiffHead`。字段顺序照 `dir_patch.c:107-124` 与
 * `_read_dirdiff_head`（`dir_patch.c:74-183`）逐字对应。
 */
function parseHeader(buf) {
  const end = buf.length;
  let pos = 0;
  const readType = (terminator) => {
    const start = pos;
    while (pos < end && buf[pos] !== terminator) pos += 1;
    if (pos >= end) throw new Error('krpdiff 头部缺少类型分隔符');
    const value = buf.toString('utf8', start, pos);
    pos += 1;
    return value;
  };
  const head = {};
  head.versionType = readType(0x26);      // '&'
  head.compressType = readType(0x26);     // '&'
  head.checksumType = readType(0x00);     // '\0'
  if (head.versionType !== 'HDIFF19') {
    throw new Error(`不是 krpdiff（版本类型是 ${JSON.stringify(head.versionType)}）`);
  }
  const readField = (name) => {
    const r = readVarUInt(buf, pos, end);
    pos = r.pos;
    head[name] = r.value;
  };
  readField('oldPathIsDir');
  readField('newPathIsDir');
  readField('oldPathCount');
  readField('oldPathSumSize');
  readField('newPathCount');
  readField('newPathSumSize');
  readField('oldRefFileCount');
  readField('savedOldRefSize');
  readField('newRefFileCount');
  readField('savedNewRefSize');
  readField('sameFilePairCount');
  readField('sameFileSize');
  readField('newExecuteCount');
  readField('privateReservedDataSize');
  readField('privateExternDataSize');
  readField('externDataSize');
  readField('headDataSize');
  readField('headDataCompressedSize');
  readField('checksumByteSize');
  head.checksumOffset = pos;
  if (head.checksumByteSize > 0) pos += head.checksumByteSize * 4;
  if (pos > end) throw new Error('krpdiff 头部越界（checksum 段）');
  head.headDataOffset = pos;
  const headDataStored = head.headDataCompressedSize > 0 ? head.headDataCompressedSize : head.headDataSize;
  head.headDataStoredSize = headDataStored;
  pos += headDataStored;
  head.privateExternDataOffset = pos;
  pos += head.privateExternDataSize;
  head.externDataOffset = pos;
  pos += head.externDataSize;
  head.hdiffDataOffset = pos;
  head.hdiffDataSize = end - pos;
  return head;
}

/**
 * 解出 headData 并按其内部七段顺序解析。
 *
 * 与开源 `TDirPatcher_loadDirData`（`dir_patch.c:320-403`）的唯一差别，
 * 也是本模块存在的原因：**在 newRefList 之后多读一个 oldRefSizeList**。
 */
function parseHeadData(headRaw, head) {
  const end = headRaw.length;
  const pathSumSize = head.oldPathSumSize + head.newPathSumSize;
  if (pathSumSize > end) throw new Error('krpdiff headData 里的路径段越界');
  const rawPaths = headRaw.subarray(0, pathSumSize);
  const paths = [];
  let start = 0;
  for (let i = 0; i < rawPaths.length; i += 1) {
    if (rawPaths[i] === 0) {
      paths.push(rawPaths.toString('utf8', start, i));
      start = i + 1;
    }
  }
  const totalPathCount = head.oldPathCount + head.newPathCount;
  if (paths.length !== totalPathCount) {
    throw new Error(`krpdiff 路径数不符（解析出 ${paths.length}，头部声明 ${totalPathCount}）`);
  }

  let pos = pathSumSize;
  const readIncList = (count, upperBound) => {
    const out = [];
    let previous = -1;
    for (let i = 0; i < count; i += 1) {
      const r = readVarUInt(headRaw, pos, end);
      pos = r.pos;
      previous += 1 + r.value;
      if (previous < 0 || previous >= upperBound) throw new Error('krpdiff 增量列表索引越界');
      out.push(previous);
    }
    return out;
  };
  const readSizeList = (count) => {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const r = readVarUInt(headRaw, pos, end);
      pos = r.pos;
      out.push(r.value);
    }
    return out;
  };

  const oldRefList = readIncList(head.oldRefFileCount, head.oldPathCount);
  const newRefList = readIncList(head.newRefFileCount, head.newPathCount);
  // ★ 库洛比开源版多出来的那一个列表
  const oldRefSizeList = readSizeList(head.oldRefFileCount);
  const newRefSizeList = readSizeList(head.newRefFileCount);
  // ★ 再一段：newRefHashList（每个新引用文件的 fadler64 值，逐个 varint）。
  //   Haiyu Waves.Diff/DirData.cs:109 权威顺序＝oldRefList / newRefList /
  //   oldRefSizeList / newRefSizeList / newRefHashList / samePairs / newExec。
  //   我们以前漏读这一段，靠「samePairCount=0、newExec=0、且不校验 leave」
  //   恰好能用；实网探针（_haiyu-diff-analysis.md）三渠道 422 组按 Haiyu
  //   布局 leave 全命中、按旧布局 leave 恒 9~10≠0 → 必须补读。
  const newRefHashList = readSizeList(head.newRefFileCount);
  const samePairList = [];
  for (let i = 0; i < head.sameFilePairCount; i += 1) {
    const a = readVarUInt(headRaw, pos, end);
    pos = a.pos;
    const b = readVarUInt(headRaw, pos, end);
    pos = b.pos;
    samePairList.push([a.value, b.value]);
  }
  const newExecuteList = readIncList(head.newExecuteCount, head.newPathCount);
  const leave = end - pos;

  const oldPaths = oldRefList.map((i) => paths[i]);
  const newPaths = newRefList.map((i) => paths[head.oldPathCount + i]);
  const sumOld = oldRefSizeList.reduce((sum, v) => sum + v, 0);
  const sumNew = newRefSizeList.reduce((sum, v) => sum + v, 0);
  if (!Number.isSafeInteger(sumOld) || !Number.isSafeInteger(sumNew)) {
    throw new Error('krpdiff 尺寸合计超出安全整数范围');
  }
  return {
    paths,
    oldRefList,
    newRefList,
    oldRefSizeList,
    newRefSizeList,
    newRefHashList,
    samePairList,
    newExecuteList,
    oldPaths,
    newPaths,
    sumOld,
    sumNew,
    leave,
    consumed: pos,
  };
}

/**
 * 解析一份完整 krpdiff（Buffer）。
 * 返回 `{ head, headData, hdiffBuffer }`；`hdiffBuffer` 是内嵌的标准 HDiff 段。
 */
function analyze(buffer) {
  const head = parseHeader(buffer);
  const stored = buffer.subarray(head.headDataOffset, head.headDataOffset + head.headDataStoredSize);
  if (stored.length !== head.headDataStoredSize) throw new Error('krpdiff headData 段被截断');
  const headRaw = head.headDataCompressedSize > 0 ? zlib.zstdDecompressSync(stored) : Buffer.from(stored);
  if (headRaw.length !== head.headDataSize) {
    throw new Error(`krpdiff headData 解压尺寸不符（${headRaw.length} != ${head.headDataSize}）`);
  }
  const headData = parseHeadData(headRaw, head);
  const hdiffBuffer = buffer.subarray(head.hdiffDataOffset);
  // ★ samePair 是「内容未变、从旧直接拷到新」的文件对，编码是带方向 tag 的
  //   有符号增量（Haiyu DirData.cs:129-136），且与 newRefHashList 一起参与
  //   校验。我们目前没有实现这套解码与直拷循环；一旦官方启用 samePair，
  //   绝不能静默漏产文件 —— 直接抛错让产品层回落整文件下载最安全。
  //   放在尾部对账之前，避免误解码让 leave 报出误导性的「长度不符」。
  if (head.sameFilePairCount > 0) {
    throw new Error('krpdiff 含 sameFilePair，当前实现不支持，请回落整文件下载');
  }
  // ★ 尾部对账（Haiyu Waves.Diff/DirData.cs:142-144）：任何字段错位/漏读
  //   都会让 leave 与 privateReservedDataSize 对不上，立即暴露而不是静默
  //   产出不全的文件。实网三渠道 422 组按正确布局 leave 全命中。
  if (headData.leave !== head.privateReservedDataSize) {
    throw new Error(`krpdiff headData 尾部长度不符（${headData.leave} != ${head.privateReservedDataSize}）`);
  }
  // ★ samePair 是「内容未变、从旧直接拷到新」的文件对，编码是带方向 tag 的
  //   有符号增量（Haiyu DirData.cs:129-136），且与 newRefHashList 一起参与
  //   校验。我们目前没有实现这套解码与直拷循环；一旦官方启用 samePair，
  //   绝不能静默漏产文件 —— 直接抛错让产品层回落整文件下载最安全。
  if (head.sameFilePairCount > 0) {
    throw new Error('krpdiff 含 sameFilePair，当前实现不支持，请回落整文件下载');
  }
  if (headData.sumOld !== head.savedOldRefSize) {
    throw new Error(`krpdiff 旧文件尺寸合计不符（${headData.sumOld} != ${head.savedOldRefSize}）`);
  }
  if (headData.sumNew !== head.savedNewRefSize) {
    throw new Error(`krpdiff 新文件尺寸合计不符（${headData.sumNew} != ${head.savedNewRefSize}）`);
  }
  return { head, headData, hdiffBuffer };
}

// ── 流式文件操作 ─────────────────────────────────────────────────────────────

/** 把源文件内容按顺序追加进目标句柄。 */
async function appendFileToHandle(srcPath, handle) {
  const src = await fsp.open(srcPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(IO_CHUNK);
    let position = 0;
    for (;;) {
      const { bytesRead } = await src.read(buf, 0, buf.length, position);
      if (bytesRead <= 0) break;
      await handle.write(buf, 0, bytesRead);
      position += bytesRead;
    }
  } finally {
    await src.close();
  }
}

/** 从已打开的 srcHandle 的 offset 起，把 size 字节写进 dstPath。 */
async function writeSlice(srcHandle, offset, size, dstPath) {
  await fsp.mkdir(path.dirname(dstPath), { recursive: true });
  const dst = await fsp.open(dstPath, 'w');
  try {
    const buf = Buffer.allocUnsafe(Math.min(IO_CHUNK, Math.max(1, size)));
    let remain = size;
    let at = offset;
    while (remain > 0) {
      const want = Math.min(remain, buf.length);
      const { bytesRead } = await srcHandle.read(buf, 0, want, at);
      if (bytesRead <= 0) throw new Error(`分割输出时提前遇到文件末尾（还差 ${remain} 字节）`);
      await dst.write(buf, 0, bytesRead);
      at += bytesRead;
      remain -= bytesRead;
    }
  } finally {
    await dst.close();
  }
}

/** 流式计算文件 md5。 */
async function md5OfFile(filePath, { signal } = {}) {
  const hash = crypto.createHash('md5');
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(IO_CHUNK);
    let position = 0;
    for (;;) {
      if (signal && signal.cancelled) throw new Error('已取消');
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

const toPosix = (value) => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');

// ── 应用一组 krpdiff ─────────────────────────────────────────────────────────

/**
 * 应用一组 krpdiff，把产物写到 `installRoot` 下。
 *
 * @param {object} options
 * @param {string} options.installRoot 游戏根目录（产物落位根）
 * @param {Buffer|string} options.krpdiff krpdiff 内容（Buffer）或其本地路径
 * @param {string} options.tempDir 可写的临时目录（需容纳最大一组新旧文件）
 * @param {{resolveInside:(root:string,rel:string)=>string}} options.pathHelper
 *        `kuro-packs` 的路径守卫，防止清单里的相对路径逃出 installRoot
 * @param {object} [options.signal]
 * @param {(size:number)=>void} [options.onBytes] 每完成一些字节就回调（进度用）
 * @returns {Promise<{ok:boolean, written:number, bytes:number, files:string[], reason:string}>}
 */
async function applyGroup({ installRoot, krpdiff, tempDir, pathHelper, signal, onBytes } = {}) {
  const result = { ok: false, written: 0, bytes: 0, files: [], reason: '' };
  const root = String(installRoot || '');
  if (!root) {
    result.reason = '没有游戏目录';
    return result;
  }
  if (!pathHelper || typeof pathHelper.resolveInside !== 'function') {
    result.reason = '缺少路径守卫';
    return result;
  }
  let buffer;
  let cleanupBuffer = false;
  if (Buffer.isBuffer(krpdiff)) {
    buffer = krpdiff;
  } else if (typeof krpdiff === 'string' && krpdiff) {
    buffer = await fsp.readFile(krpdiff);
  } else {
    result.reason = '没有 krpdiff 内容';
    return result;
  }

  let analysis;
  try {
    analysis = analyze(buffer);
  } catch (error) {
    result.reason = `解析 krpdiff 失败：${String((error && error.message) || error)}`;
    return result;
  }
  const { head, headData, hdiffBuffer } = analysis;
  if (!headData.oldPaths.length || !headData.newPaths.length) {
    result.reason = 'krpdiff 里没有可应用的路径';
    return result;
  }

  // mkdtemp 的前缀目录必须已存在，否则 ENOENT —— 调用方的 tempDir 可能是它
  // 自己刚拼出来、还没建过的路径。
  await fsp.mkdir(String(tempDir), { recursive: true });
  const work = await fsp.mkdtemp(path.join(String(tempDir), 'krpd-'));
  const oldCat = path.join(work, 'old.cat');
  const segFile = path.join(work, 'seg.hdiff');
  const newBin = path.join(work, 'new.bin');
  try {
    // ① 按 oldRefList 的真实顺序流式拼接旧文件
    const oldAbs = headData.oldPaths.map((rel) => pathHelper.resolveInside(root, toPosix(rel)));
    for (const abs of oldAbs) {
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) {
        result.reason = `旧文件缺失：${path.relative(root, abs)}`;
        return result;
      }
    }
    const catHandle = await fsp.open(oldCat, 'w');
    try {
      for (const abs of oldAbs) {
        if (signal && signal.cancelled) throw new Error('已取消');
        await appendFileToHandle(abs, catHandle);
      }
    } finally {
      await catHandle.close();
    }
    const catSize = (await fsp.stat(oldCat)).size;
    if (catSize !== head.savedOldRefSize) {
      result.reason = `旧文件拼接尺寸不符（${catSize} != ${head.savedOldRefSize}），本机这份客户端可能已被改过`;
      return result;
    }

    // ② 内嵌段单独落盘（标准 HDiff，任何版本 hpatchz 都认得）
    await fsp.writeFile(segFile, hdiffBuffer);
    if (signal && signal.cancelled) throw new Error('已取消');

    // ③ 跑 hpatchz。注意：输出路径必须不存在，否则报 outNewPath already exists
    await fsp.rm(newBin, { force: true });
    try {
      await execFileAsync(hpatchzPath(), [oldCat, segFile, newBin], {
        timeout: HPATCHZ_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const stderr = String((error && error.stderr) || '').trim();
      result.reason = `应用差分失败：${stderr || String((error && error.message) || error)}`;
      return result;
    }
    const newSize = (await fsp.stat(newBin)).size;
    if (newSize !== head.savedNewRefSize) {
      result.reason = `差分成品尺寸不符（${newSize} != ${head.savedNewRefSize}）`;
      return result;
    }

    // ④ 按 newRefSizeList 切分落位
    const newHandle = await fsp.open(newBin, 'r');
    let offset = 0;
    let written = 0;
    let bytes = 0;
    try {
      for (let i = 0; i < headData.newPaths.length; i += 1) {
        if (signal && signal.cancelled) throw new Error('已取消');
        const rel = toPosix(headData.newPaths[i]);
        const size = headData.newRefSizeList[i];
        const dst = pathHelper.resolveInside(root, rel);
        await writeSlice(newHandle, offset, size, dst);
        offset += size;
        written += 1;
        bytes += size;
        if (typeof onBytes === 'function') onBytes(size);
      }
    } finally {
      await newHandle.close();
    }
    result.ok = true;
    result.written = written;
    result.bytes = bytes;
    result.files = headData.newPaths.map((p) => toPosix(p));
    return result;
  } catch (error) {
    result.reason = String((error && error.message) || error);
    return result;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    if (cleanupBuffer) buffer = null;
  }
}

module.exports = {
  analyze,
  applyGroup,
  md5OfFile,
  hpatchzPath,
  parseHeader,
  parseHeadData,
  IO_CHUNK,
};
