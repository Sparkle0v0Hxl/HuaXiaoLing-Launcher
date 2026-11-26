'use strict';

/*
 * 从官方启动器安装包（7z-SFX 内嵌 ZIP）里，取出 res/app_config.dat（192/368 字节）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 蓝原的「渠道身份」只由一个文件决定：<启动器目录>/res/app_config.dat
 *   官服 C000 = 192 字节
 *   B服  C001 = 368 字节
 * 这个文件是加密的（密钥在 napi-cutils 原生模块里，无导出），我们造不出来。
 * 而 CDN 上的 mj_sdk/res/app_config.dat 是**游戏目录那份**（1984/1392 字节），
 * 格式不同，不能拿来替换启动器目录的。
 * 所以唯一合法的获取途径就是「从官方启动器安装包里取」。
 *
 * ── 怎么做到只下几 MB 而不是 182MB ────────────────────────────────
 * 安装包 = PE 头 + 7z-SFX + 内嵌 ZIP + 中央目录。
 * 关键观察：ZIP 里 `res/app_config.dat` 的**本地头（PK\3\4）名字字段是明文**，
 * 所以可以用 HTTP Range 分块扫，找到本地头位置后，只取紧随其后的压缩数据段。
 *
 * 实测（2026-11-26）：
 *   C000 官服包 190,835,304 字节 → 提取出 192 字节，与本机完全一致
 *   C001 B服 包 190,807,144 字节 → 提取出 368 字节，与本机完全一致
 * 下载量随扫描步长变化，实测 3~15 MB。
 *
 * ── 安装包地址从哪来 ────────────────────────────────────────────
 * 官服：https://api-grp.manjuu.com/activity/web/download/info?gameId=35
 *       的 nativeLauncherDownloadUrl
 * B服 ：B站 官网详情页（https://www.biligame.com/detail/?id=111392）的下载按钮，
 *       文件名形如 lsxylyPCb_bilibili_<日期>_<hash>.exe
 *       （这个地址页面是 JS 渲染的，抓不到，需要用户自己下载后指定，或由上层传入）
 */

const zlib = require('node:zlib');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SIG_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const TARGET_NAME = 'res/app_config.dat';

/** 在一个 Buffer 里找所有 PK\3\4，返回其中名字字段等于 target 的位置。 */
function findLocalHeader(buf, baseOffset) {
  const hits = [];
  let p = 0;
  for (;;) {
    p = buf.indexOf(SIG_LOCAL, p);
    if (p < 0) break;
    if (p + 30 <= buf.length) {
      const nameLen = buf.readUInt16LE(p + 26);
      if (nameLen > 0 && nameLen < 300 && p + 30 + nameLen <= buf.length) {
        const name = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
        if (name === TARGET_NAME) hits.push({ pos: p, abs: baseOffset + p, name });
      }
    }
    p += 4;
  }
  return hits;
}

/**
 * 从一份**已下载到本地**的安装包里提取。
 * 这是最可靠的路径（用户已经下过安装包时）。
 */
function extractFromLocalFile(filePath, expectedSize) {
  const fs = require('node:fs');
  const buf = fs.readFileSync(filePath);
  const hits = findLocalHeader(buf, 0);
  if (!hits.length) return { ok: false, error: '安装包里找不到 res/app_config.dat' };
  const hit = hits[0];
  const at = hit.pos;
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const method = buf.readUInt16LE(at + 8);
  const compSize = buf.readUInt32LE(at + 18);
  const rawSize = buf.readUInt32LE(at + 22);
  if (expectedSize && rawSize !== expectedSize) {
    return { ok: false, error: `安装包里的配置是 ${rawSize} 字节，预期 ${expectedSize}` };
  }
  const dataStart = at + 30 + nameLen + extraLen;
  const data = buf.slice(dataStart, dataStart + compSize);
  let plain;
  try {
    plain = method === 0 ? data : zlib.inflateRawSync(data);
  } catch (error) {
    return { ok: false, error: '解压失败：' + error.message };
  }
  if (plain.length !== rawSize) {
    return { ok: false, error: `解压后 ${plain.length} 字节，头部声明 ${rawSize}` };
  }
  return { ok: true, data: plain, size: plain.length, downloadBytes: 0, from: 'local' };
}

/**
 * 从远程安装包提取（HTTP Range 分块扫描）。
 *
 * 扫描策略：从 100MB 起（ZIP 数据区通常在后半段），每块 2MB，找到就停。
 * 为什么要从 100MB 起：PE + 7z-SFX 占前面一大段，内嵌 ZIP 的实际文件都在后半段。
 * 实测 C000 在 161MB 处、C001 在 161MB 处。
 */
async function extractFromRemote(url, expectedSize, options = {}) {
  const stepSize = options.stepSize || 2 * 1024 * 1024;
  const startFrom = options.startFrom || 100 * 1024 * 1024;
  let downloaded = 0;

  const head = await fetch(url, { method: 'HEAD', headers: { 'user-agent': UA } });
  const totalSize = Number(head.headers.get('content-length') || 0);
  if (!totalSize) return { ok: false, error: '拿不到安装包大小' };

  const rangeFetch = async (from, to) => {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, Range: `bytes=${from}-${to}` },
      signal: AbortSignal.timeout(180000),
    });
    if (res.status !== 206 && res.status !== 200) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    downloaded += buf.length;
    return buf;
  };

  for (let from = Math.min(startFrom, Math.max(0, totalSize - stepSize)); from < totalSize; from += stepSize) {
    const to = Math.min(from + stepSize - 1, totalSize - 1);
    let buf;
    try {
      buf = await rangeFetch(from, to);
    } catch {
      continue;
    }
    const hits = findLocalHeader(buf, from);
    if (!hits.length) continue;

    const hit = hits[0];
    /* 本地头可能跨块，重取 30 字节头确保完整 */
    let header = buf.slice(hit.pos, hit.pos + 30);
    if (header.length < 30) {
      header = await rangeFetch(hit.abs, hit.abs + 29);
    }
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const method = header.readUInt16LE(8);
    const compSize = header.readUInt32LE(18);
    const rawSize = header.readUInt32LE(22);
    if (expectedSize && rawSize !== expectedSize) continue;

    const dataStart = hit.abs + 30 + nameLen + extraLen;
    let data;
    try {
      data = await rangeFetch(dataStart, dataStart + compSize - 1);
    } catch (error) {
      return { ok: false, error: '取数据段失败：' + error.message, downloadBytes: downloaded };
    }
    let plain;
    try {
      plain = method === 0 ? data : zlib.inflateRawSync(data);
    } catch (error) {
      return { ok: false, error: '解压失败：' + error.message, downloadBytes: downloaded };
    }
    if (plain.length !== rawSize) {
      return {
        ok: false,
        error: `解压后 ${plain.length} 字节，头部声明 ${rawSize}`,
        downloadBytes: downloaded,
      };
    }
    return { ok: true, data: plain, size: plain.length, downloadBytes: downloaded, from: 'remote' };
  }

  return { ok: false, error: '整个安装包里没找到 res/app_config.dat', downloadBytes: downloaded };
}

module.exports = { extractFromLocalFile, extractFromRemote, findLocalHeader };
