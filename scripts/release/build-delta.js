'use strict';

/*
 * 关掉 Electron 的 asar 虚拟层。
 * 这个脚本会被 pack.js 用 process.execPath 拉起（本机没有独立 node），此时 fs 仍带着
 * asar 补丁：`resources/app.asar` 会被 statSync 认成「目录」，遍历时当成目录往下走，
 * 读它时直接 EISDIR（2.7.2 打包时就是这样失败的）。置 noAsar 后 asar 当普通文件处理。
 */
process.noAsar = true;

/**
 * 生成增量更新包 delta-<from>-to-<to>.zip（HDiffPatch 逐文件二进制差分）。
 *
 * 为什么必须做逐文件二进制差分：
 *   · 完整包 188 MB，其中 238 MB 的主程序 exe（Electron 运行时）几乎不变，
 *     但 electron-builder 会把「asar 完整性哈希 + 版本资源」写进 exe，
 *     所以只要 app.asar 变，exe 的字节也会变。若按「文件是否变化」直接整文件传，
 *     exe 会被当成变了 → 又一次传 238 MB，等于没省。
 *   · 对 exe 做 hdiffz 差分，实测 238 MB 只出 226 字节补丁、2.5 秒。
 *
 * 产物结构（zip 内）：
 *   delta.json         清单：{ format, from, to, files:[{path,mode,size,sha256,baseSize,baseSha256,patch|src}], removed }
 *   p/<n>.hdiff        改动文件的补丁（mode=patch）
 *   f/<n>              新增/强制整传文件（mode=full）
 *
 * 用法（发布机执行，不随启动器分发）：
 *   node scripts/release/build-delta.js \
 *        --from <旧 win-unpacked 目录> --to <新 win-unpacked 目录> \
 *        --from-version 2.7.0 --to-version 2.7.1 \
 *        --out <输出目录> [--hdiffz <hdiffz.exe 路径>] [--level 9]
 *
 * 输出：
 *   <out>/delta-2.7.0-to-2.7.1.zip
 *   <out>/delta-2.7.0-to-2.7.1.json   清单片段（含 zip 的 sha256/size，供写入 latest.json 的 deltas）
 *
 * 退出码：0 成功；非 0 失败（stderr 有原因）。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DEFAULT_HDIFFZ = 'H:/HXL-pack/tools/hdiffz.exe';

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const die = (msg) => {
  console.error(`[build-delta][error] ${msg}`);
  process.exit(1);
};

/* ---------------- 小工具 ---------------- */

function norm(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

/** 和客户端一致的「用户数据/临时文件」过滤，避免把 data、.bak 打进增量。 */
function isProtectedRel(rel) {
  const r = norm(rel);
  const top = r.split('/')[0];
  if (top === 'data' || top === 'downloads') return true;
  if (/\.bak(-\S+)?$/i.test(r)) return true;
  if (/\.(tmp|temp|part|download|crdownload)$/i.test(r)) return true;
  if (/(^|\/)\.DS_Store$/i.test(r)) return true;
  return false;
}

async function listFiles(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await walk(root, '');
  return out;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function statSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return -1;
  }
}

function hdiffzMake(hdiffz, oldFile, newFile, outPatch, level) {
  // -s-16：流式模式，内存占用低、速度快（238MB 主程序实测 ~2.5s）；
  // -c-zstd-<level>：合法的压缩写法是 -c-<类型>[-级别]，-c-9 这种只给级别会报 "options -c-? ERROR"。
  const zstdLevel = Math.max(1, Math.min(22, Number(level) || 19));
  const args = ['-s-16', `-c-zstd-${zstdLevel}`, oldFile, newFile, outPatch];
  const res = spawnSync(hdiffz, args, { windowsHide: true, timeout: 30 * 60 * 1000, encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`hdiffz 失败(${res.status})：${(res.stderr || res.stdout || '').slice(-300)}`);
}

/* ---------- 极简 ZIP 写入器（store，不压缩，正斜杠条目名） ----------
 * 不用 PowerShell 的 Compress-Archive：它在 Windows 上会把条目名写成反斜杠
 * （f\0.bin），与 delta.json 里的正斜杠路径对不上，其它解压器还会告警。
 * 这里自己写标准 ZIP：差分文件本身已被 zstd 压过、整传文件又很小，store 足够。 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(items, outZip) {
  // items: [{ name: 'p/0.hdiff', abs: '...' }]
  const now = new Date();
  const dosTime = (((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9 | ((now.getMonth() + 1) & 0x0f) << 5 | (now.getDate() & 0x1f)) & 0xffff;

  const parts = [];
  const central = [];
  let offset = 0;

  for (const item of items) {
    const data = fs.readFileSync(item.abs);
    const nameBuf = Buffer.from(String(item.name).replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // 0 = store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outZip, Buffer.concat([...parts, centralBuf, eocd]));
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromDir = args.from;
  const toDir = args.to;
  const fromVersion = String(args['from-version'] || '').trim().replace(/^v/i, '');
  const toVersion = String(args['to-version'] || '').trim().replace(/^v/i, '');
  const outDir = args.out || 'H:/HXL-pack/dist';
  const hdiffz = args.hdiffz || DEFAULT_HDIFFZ;
  const level = Number(args.level) || 9;

  if (!fromDir || !toDir) die('必须给 --from <旧目录> 和 --to <新目录>');
  if (!fromVersion || !toVersion) die('必须给 --from-version 和 --to-version');
  if (!fs.existsSync(fromDir)) die(`旧目录不存在：${fromDir}`);
  if (!fs.existsSync(toDir)) die(`新目录不存在：${toDir}`);
  if (!fs.existsSync(hdiffz)) die(`找不到 hdiffz：${hdiffz}（发布机工具，见 H:/HXL-pack/tools/hdiffz.exe）`);

  await fsp.mkdir(outDir, { recursive: true });
  const tempRoot = await fsp.mkdtemp(path.join(outDir, '.delta-build-'));
  const staging = path.join(tempRoot, 'staging');
  const pDir = path.join(staging, 'p');
  const fDir = path.join(staging, 'f');
  await fsp.mkdir(pDir, { recursive: true });
  await fsp.mkdir(fDir, { recursive: true });

  console.log(`[build-delta] ${fromVersion} -> ${toVersion}`);
  console.log(`  旧：${fromDir}`);
  console.log(`  新：${toDir}`);

  const fromList = (await listFiles(fromDir)).filter((rel) => !isProtectedRel(rel));
  const toList = (await listFiles(toDir)).filter((rel) => !isProtectedRel(rel));
  const fromSet = new Set(fromList);
  const toSet = new Set(toList);

  // 覆盖器脚本永远整传：保证客户端跑的是这一版最新的 apply.js（含死等自身 PID 的修复）
  const alwaysFull = (rel) => norm(rel).startsWith('resources/updater/');

  const entries = [];
  const removed = [];
  let patchBytes = 0;
  let fullBytes = 0;
  let rawBytes = 0; // 目标侧这些文件的总大小（用来算「节省」）
  let index = 0;

  for (const rel of toList) {
    const nRel = norm(rel);
    const newFile = path.join(toDir, rel);
    const newSize = await statSize(newFile);
    const oldFile = path.join(fromDir, rel);
    const oldSize = fromSet.has(rel) ? await statSize(oldFile) : -1;

    let mode = '';
    let baseSize = 0;
    let baseSha256 = '';

    if (oldSize >= 0) {
      if (oldSize === newSize && !alwaysFull(nRel)) {
        // 大小相同再比 sha256，避免全量哈希大文件
        const [oldHash, newHash] = [await sha256File(oldFile), await sha256File(newFile)];
        if (oldHash === newHash) continue; // 完全一样，跳过
      }
      mode = 'patch';
      baseSize = oldSize;
    } else {
      mode = 'full'; // 新增文件
    }

    const newSha = await sha256File(newFile);
    rawBytes += newSize;

    if (mode === 'patch') {
      baseSha256 = await sha256File(oldFile);
      const patchRel = `p/${index}.hdiff`;
      const patchAbs = path.join(staging, patchRel);
      try {
        hdiffzMake(hdiffz, oldFile, newFile, patchAbs, level);
        const patchSize = await statSize(patchAbs);
        // 补丁不比整文件小就整传，别让「增量」比完整文件还大
        if (patchSize < 0 || patchSize >= newSize * 0.98) {
          mode = 'full';
          try { fs.rmSync(patchAbs, { force: true }); } catch { /* ignore */ }
        } else {
          patchBytes += patchSize;
          entries.push({
            path: nRel,
            mode: 'patch',
            size: newSize,
            sha256: newSha,
            baseSize,
            baseSha256,
            patch: patchRel,
            patchSize,
          });
          console.log(`  ~ ${nRel}  ${newSize} -> 补丁 ${patchSize} (${((patchSize / newSize) * 100).toFixed(2)}%)`);
          index += 1;
          continue;
        }
      } catch (error) {
        console.warn(`  ! ${nRel} 差分失败，改整传：${error.message}`);
        mode = 'full';
      }
    }

    // mode === 'full'
    const fullRel = `f/${index}.bin`;
    const fullAbs = path.join(staging, fullRel);
    await fsp.copyFile(newFile, fullAbs);
    fullBytes += newSize;
    entries.push({ path: nRel, mode: 'full', size: newSize, sha256: newSha, src: fullRel });
    console.log(`  + ${nRel}  整传 ${newSize}`);
    index += 1;
  }

  for (const rel of fromList) {
    if (!toSet.has(rel)) removed.push(norm(rel));
  }

  const deltaJson = {
    format: 1,
    from: fromVersion,
    to: toVersion,
    tool: 'HDiffPatch 5.1.3',
    files: entries,
    removed,
  };
  await fsp.writeFile(path.join(staging, 'delta.json'), `${JSON.stringify(deltaJson, null, 2)}\n`, 'utf8');

  const outZip = path.join(outDir, `delta-${fromVersion}-to-${toVersion}.zip`);
  console.log(`[build-delta] 打包 ${outZip} ...`);
  const zipItems = [{ name: 'delta.json', abs: path.join(staging, 'delta.json') }];
  for (const entry of entries) {
    if (entry.mode === 'patch') zipItems.push({ name: entry.patch, abs: path.join(staging, entry.patch) });
    else zipItems.push({ name: entry.src, abs: path.join(staging, entry.src) });
  }
  zipStore(zipItems, outZip);

  const sha256 = await sha256File(outZip);
  const size = await statSize(outZip);
  const sidecar = {
    from: fromVersion,
    to: toVersion,
    file: path.basename(outZip),
    path: outZip,
    sha256,
    size,
    fileCount: entries.length,
    patchBytes,
    fullBytes,
    rawBytes,
    savedBytes: Math.max(0, rawBytes - size),
    removedCount: removed.length,
    builtAt: new Date().toISOString(),
  };
  await fsp.writeFile(outZip.replace(/\.zip$/i, '.json'), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');

  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* 清理失败不影响产物 */ }

  console.log('\n[build-delta] 完成');
  console.log(`  文件数：${entries.length}（补丁 ${entries.filter((e) => e.mode === 'patch').length} / 整传 ${entries.filter((e) => e.mode === 'full').length}）`);
  console.log(`  补丁合计：${(patchBytes / 1048576).toFixed(2)} MB；整传合计：${(fullBytes / 1048576).toFixed(2)} MB`);
  console.log(`  增量包：${(size / 1048576).toFixed(2)} MB（sha256 ${sha256}）`);
  console.log(`  目标文件原始合计：${(rawBytes / 1048576).toFixed(2)} MB；节省：${(sidecar.savedBytes / 1048576).toFixed(2)} MB`);
  console.log(`\n清单片段（写进 latest.json 的 deltas）：\n${JSON.stringify({ from: fromVersion, to: toVersion, url: path.basename(outZip), sha256, size }, null, 2)}`);
}

main().catch((error) => die(error && error.stack ? error.stack : String(error)));
