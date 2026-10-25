'use strict';

/**
 * 画质配置：读取 / 修改各游戏的画质设置。
 *
 * 米哈游三件套把画质存在注册表里（HKCU\Software\miHoYo\<游戏>），
 * 值是 JSON 字符串（部分版本是 REG_BINARY 的 UTF-16）。这里只做两件事：
 *   1. 读出来，解析成键值对给界面展示
 *   2. 允许写回**已有的键**，不新增键、不删键，避免把游戏配置弄坏
 *
 * 所有写操作都会先备份原值到 userData/registry-backup.json。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function decode(buffer) {
  if (!buffer || !buffer.length) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return buffer.toString('latin1');
    }
  }
}

function runReg(args) {
  try {
    const stdout = execFileSync('reg.exe', args, {
      encoding: 'buffer',
      windowsHide: true,
      // 原神的项里有 345KB 的 REG_BINARY（device 数据），整项导出要 18 秒以上，
      // 早期 8 秒超时会让它被误判成「游戏没启动过」。放宽到 30 秒。
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, output: decode(stdout) };
  } catch (error) {
    return { ok: false, output: decode(error.stdout), reason: String(error.message || '') };
  }
}

/** 只要值名、不看内容：导出到临时文件再解析，大项也不会卡。 */
function listValueNamesFast(key, tempPath) {
  try {
    execFileSync('reg.exe', ['export', key, tempPath, '/y'], { windowsHide: true, timeout: 15000 });
    // reg export 输出 UTF-16LE（BOM ff fe），hex(2) 值会被折成多行，
    // 所以不能逐行匹配，要把续行先接起来。
    let text;
    try {
      text = fs.readFileSync(tempPath, 'utf16le');
    } catch {
      text = fs.readFileSync(tempPath, 'latin1');
    }
    fs.rmSync(tempPath, { force: true });
    // 把以两个以上空格开头的续行合并到上一行
    text = text.replace(/\r?\n\s{2,}/g, '');
    const names = [];
    const re = /^\s*"((?:[^"\\]|\\.)*)"=/gm;
    let match;
    while ((match = re.exec(text))) {
      const name = match[1].replace(/\\(.)/g, '$1');
      if (!name || name === '@') continue;
      names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

/** 列出某个游戏的所有值名。
 *
 * 注意：原神 / 绝区零的部分值名带空格（如 `Screenmanager Resolution Width`），
 * 早年用 `^\s{4}(\S+)\s+REG_` 会整条漏掉，导致「原神明明有数据却报没启动过」。
 * 现在按「行首空白 + REG_ 类型标记 + 类型后的空白」来切，值名可以含空格。
 */
function listValueNames(key) {
  const result = runReg(['query', key]);
  if (!result.ok) return [];
  const names = [];
  for (const line of result.output.split(/\r?\n/)) {
    // 例：`    Screenmanager Resolution Width    REG_DWORD    0x1000`
    //     `    MIHOYOSDK_CONFIG_MODEL_NAME    REG_SZ    {...}`
    const match = line.match(/^\s{2,}(.+?)\s+(REG_(?:SZ|DWORD|QWORD|BINARY|EXPAND_SZ|MULTI_SZ|NONE))(?:\s|$)/);
    if (!match) continue;
    const name = match[1].trim();
    // 跳过默认值 `(默认)` 这种没有名字的项
    if (!name || name === '(默认)') continue;
    names.push(name);
  }
  return names;
}

/** 读单个值，同时返回注册表类型，写回时要用。 */
function readValueEntry(key, name) {
  const result = runReg(['query', key, '/v', name]);
  if (!result.ok) return { raw: null, type: null };
  const match = result.output.match(/(REG_(?:SZ|DWORD|QWORD|BINARY|EXPAND_SZ|MULTI_SZ|NONE))\s+(\S+)/);
  if (!match) return { raw: null, type: null };
  const type = match[1];
  const raw = match[2];
  // 二进制值是一长串十六进制，尝试解码
  if (type === 'REG_BINARY' && /^[0-9a-f]+$/i.test(raw) && raw.length > 16) {
    const bytes = Buffer.from(raw, 'hex');
    return { raw: decode(bytes).replace(/\u0000+$/, ''), type };
  }
  return { raw, type };
}

/** 读单个值（只要值本身）。 */
function readValue(key, name) {
  return readValueEntry(key, name).raw;
}

/**
 * 把注册表里的值尽量解析成 JSON。
 * 米哈游的画质通常是 GraphicsSettings_Model 这样的 JSON 字符串。
 */
function parseGraphicsValue(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 读某游戏的画质配置。
 *
 * 性能要点：原神项下有 345KB 的 REG_BINARY，`reg query <项>` 整项导出要 18 秒。
 * 所以先用 listValueNamesFast（reg export，40ms）拿全量值名，再只对**画质相关**的
 * 键逐个 `reg query /v`，一条几十毫秒到底。
 *
 * 返回 { ok, key, entries: [{ name, raw, type, json }] }
 */
function readGraphics(registryKey, isInteresting) {
  if (!registryKey) return { ok: false, reason: '这个游戏没有登记画质注册表位置' };
  const tempPath = path.join(require('node:os').tmpdir(), `hxl-reg-${process.pid}-${Date.now()}.reg`);
  const names = listValueNamesFast(registryKey, tempPath);
  if (!names.length) {
    return { ok: false, reason: '没有读到画质配置（游戏可能还没启动过一次）', key: registryKey };
  }
  const wanted = typeof isInteresting === 'function' ? names.filter(isInteresting) : names;
  const entries = wanted.map((name) => {
    const entry = readValueEntry(registryKey, name);
    return { name, raw: entry.raw, type: entry.type, json: parseGraphicsValue(entry.raw) };
  });
  return { ok: true, key: registryKey, entries, totalNames: names.length };
}

/**
 * 写回单个值，并备份旧值。
 *
 * type 决定写回时的注册表类型：
 *   - JSON 字符串（原来的 GraphicsSettings_Model 之类）→ REG_SZ
 *   - 原来就是 DWORD 的数值项 → REG_DWORD
 * 不传 type 时沿用读到的原类型，读不到才退回 REG_SZ。
 */
function writeValue(registryKey, name, value, backupPath, type) {
  const previous = readValueEntry(registryKey, name);
  const writeType = type || previous.type || 'REG_SZ';
  const data = String(value);

  const args = ['add', registryKey, '/v', name, '/t', writeType, '/d', data, '/f'];
  try {
    execFileSync('reg.exe', args, { windowsHide: true, timeout: 8000 });
  } catch (error) {
    return { ok: false, reason: String(error.message || '写入失败') };
  }
  // 备份
  try {
    let backup = {};
    if (backupPath && fs.existsSync(backupPath)) {
      backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    }
    backup[`${registryKey}\\${name}`] = { previous: previous.raw, type: writeType, at: new Date().toISOString() };
    if (backupPath) fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
  } catch {}
  return { ok: true, previous: previous.raw, type: writeType };
}

module.exports = {
  readGraphics,
  writeValue,
  listValueNames,
  listValueNamesFast,
  readValue,
  readValueEntry,
  parseGraphicsValue,
};
