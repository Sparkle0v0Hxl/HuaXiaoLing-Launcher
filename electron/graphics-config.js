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
 * 一次导出，把「值名 + 值 + 类型」全部拿到。
 *
 * 早年的写法是先导出取值名、再对每个画质键各跑一次 `reg query /v`。
 * 一个进程调用约 40ms，终末地要读 31 个键 → 1.2 秒；崩3 更多。
 * 而 `reg export` 的输出本来就带值，一次 60ms 就能拿全，没必要再起进程。
 *
 * 解析要点：
 *   - 输出是 UTF-16LE（BOM ff fe），值可能是 hex(2) 的长串且折成多行，先把续行接起来；
 *   - `"name"=hex(2):68,00,65,...` 是 UTF-16 字符串，要按字节还原；
 *   - `"name"=dword:00000001` / `"name"=hex(b):...`（QWORD）；
 *   - `"name"="文本"` 是 REG_SZ，反斜杠转义要还原；
 *   - 自己的那一条 `@=hex(2):...` 是项的默认值，跳过。
 *
 * 返回 Map<name, { raw, type }>，形状与 readValueEntry 一致。
 */
function exportValues(key) {
  const tempPath = path.join(require('node:os').tmpdir(), `hxl-exp-${process.pid}-${Date.now()}.reg`);
  const out = new Map();
  try {
    execFileSync('reg.exe', ['export', key, tempPath, '/y'], { windowsHide: true, timeout: 30000 });
    let text;
    try {
      text = fs.readFileSync(tempPath, 'utf16le');
    } catch {
      text = fs.readFileSync(tempPath, 'latin1');
    }
    // hex 长串会被折行（续行以空白开头），先接回一整行
    text = text.replace(/\r?\n[ \t]{2,}/g, '');
    const re = /^\s*(?:"((?:[^"\\]|\\.)*)"|@)=([^\r\n]*)$/gm;
    let match;
    while ((match = re.exec(text))) {
      const name = match[1] ? match[1].replace(/\\(.)/g, '$1') : '';
      if (!name) continue;
      const value = match[2].trim();
      out.set(name, decodeRegValue(value));
    }
  } catch {
    // 导出失败就返回空表，调用方按「读不到」处理
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return out;
}

/** 把 reg export 右侧的 `hex(2):68,00,...` / `dword:1` / `"文本"` 还原成 { raw, type }。 */
function decodeRegValue(value) {
  // 字符串："文本"，里面有 \" 和 \\ 转义
  const str = value.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (str) return { raw: str[1].replace(/\\(.)/g, '$1'), type: 'REG_SZ' };

  const hex = value.match(/^hex(?:\(([0-9a-f]+)\))?:([\s\S]*)$/i);
  if (hex) {
    const kind = (hex[1] || '3').toLowerCase();
    const bytes = Buffer.from(hex[2].replace(/[\s\\]/g, '').split(',').filter(Boolean).map((b) => parseInt(b, 16)));
    // hex(2) = REG_EXPAND_SZ，内容是 UTF-16LE（含结尾 \0）
    if (kind === '2') {
      return { raw: new TextDecoder('utf-16le').decode(bytes).replace(/\u0000+$/, ''), type: 'REG_EXPAND_SZ' };
    }
    // hex(1) = REG_SZ
    if (kind === '1') {
      return { raw: new TextDecoder('utf-16le').decode(bytes).replace(/\u0000+$/, ''), type: 'REG_SZ' };
    }
    // hex(4) = REG_DWORD，小端
    if (kind === '4' && bytes.length >= 4) {
      return { raw: String(bytes.readUInt32LE(0)), type: 'REG_DWORD' };
    }
    // hex(b) = REG_QWORD，小端 8 字节
    if (kind === 'b' && bytes.length >= 8) {
      return { raw: String(bytes.readBigUInt64LE(0)), type: 'REG_QWORD' };
    }
    // hex(7) = REG_MULTI_SZ
    if (kind === '7') {
      return { raw: new TextDecoder('utf-16le').decode(bytes).replace(/\u0000+$/, ''), type: 'REG_MULTI_SZ' };
    }
    // 其余二进制：尽量当 UTF-16 文本解出来（米哈游有用 REG_BINARY 存 JSON 的）
    if (bytes.length > 8) {
      const decoded = decode(bytes).replace(/\u0000+$/, '');
      return { raw: decoded, type: 'REG_BINARY' };
    }
    return { raw: hex[2].trim(), type: 'REG_BINARY' };
  }

  const dword = value.match(/^dword:([0-9a-f]+)$/i);
  if (dword) return { raw: String(parseInt(dword[1], 16)), type: 'REG_DWORD' };
  return { raw: value, type: null };
}

/**
 * 读某游戏的画质配置。
 *
 * 性能要点：原神项下有 345KB 的 REG_BINARY，`reg query <项>` 整项导出要 18 秒。
 * 所以走 exportValues：一次 reg export 到临时文件（约 60ms），
 * 名、值、类型一次全拿到，不再对每个键单独起进程。
 *
 * 返回 { ok, key, entries: [{ name, raw, type, json }] }
 */
function readGraphics(registryKey, isInteresting) {
  if (!registryKey) return { ok: false, reason: '这个游戏没有登记画质注册表位置' };
  const values = exportValues(registryKey);
  if (!values.size) {
    return { ok: false, reason: '没有读到画质配置（游戏可能还没启动过一次）', key: registryKey };
  }
  const names = [...values.keys()];
  const wanted = typeof isInteresting === 'function' ? names.filter(isInteresting) : names;
  const entries = wanted.map((name) => {
    const entry = values.get(name) || { raw: null, type: null };
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
  // JSON 这类字符串值要是被读成了 REG_BINARY 的 UTF-16，按原类型写回会变成一堆乱码，
  // 所以「内容是 JSON / 普通字符串」时一律写成 REG_SZ。
  const looksText = /^\s*[[{]/.test(String(value));
  const writeType = !type && looksText && (!previous.type || previous.type === 'REG_BINARY')
    ? 'REG_SZ'
    : type || previous.type || 'REG_SZ';

  /*
   * 布尔值必须先翻译成注册表认识的形式，否则 reg add 会直接报
   * 「无效语法：为 '/d' 指定的值无效」——界面上看就是「这一项点了没反应」。
   *   DWORD / QWORD：true → 1、false → 0
   *   字符串类：true/false 原样写，游戏自己按字符串读
   */
  let data;
  if (writeType === 'REG_DWORD' || writeType === 'REG_QWORD') {
    if (typeof value === 'boolean') data = value ? '1' : '0';
    else if (value === 'true') data = '1';
    else if (value === 'false') data = '0';
    else data = String(value);
    if (!/^-?\d+$/.test(data)) {
      return { ok: false, reason: `「${name}」是 ${writeType}，只能写整数，收到的是「${String(value)}」` };
    }
  } else if (writeType === 'REG_BINARY') {
    // 二进制值不在这个界面里改：写不好会毁掉整条配置
    return { ok: false, reason: `「${name}」是二进制值，暂时不支持在界面里修改` };
  } else {
    data = String(value);
  }

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

/**
 * 改 JSON 值里的单个字段，其余字段原样保留。
 *
 * 星铁 / 崩3 的画质是整条 JSON 存在一个注册表值里（GraphicsSettings_Model、
 * GENERAL_DATA_V2_PersonalGraphicsSettingV2…），只改其中一项时**不能**整条覆盖，
 * 否则没读到过的字段会被抹掉。所以这里：读出 JSON → 只改目标字段 → 写回。
 *
 * 返回 { ok, previous, value, type } 或 { ok:false, reason }
 */
function updateJsonField(registryKey, name, field, value, backupPath, type) {
  if (!registryKey || !name || !field) return { ok: false, reason: '缺少参数' };
  const previous = readValueEntry(registryKey, name);
  if (!previous.raw) return { ok: false, reason: `读不到 ${name} 的当前值` };
  const json = parseGraphicsValue(previous.raw);
  if (!json || typeof json !== 'object') {
    return { ok: false, reason: `${name} 不是 JSON，没法单独改其中的字段` };
  }
  if (!Object.prototype.hasOwnProperty.call(json, field)) {
    return { ok: false, reason: `${name} 里没有 ${field} 这个字段` };
  }

  // 类型跟着原值走：原来就是布尔就别写成数字，原来是数字就别写成字符串
  let next = value;
  let changed = false;
  if (typeof json[field] === 'boolean') {
    next = value === true || value === 'true' || value === 1 || value === '1';
    changed = next !== json[field];
  } else if (typeof json[field] === 'number') {
    next = Number(value);
    if (!Number.isFinite(next)) return { ok: false, reason: '这个字段要填数字' };
    changed = next !== json[field];
  } else if (typeof json[field] === 'string') {
    next = String(value);
    changed = next !== json[field];
  } else {
    changed = true;
  }

  // 值没变就别写注册表：省一次写操作，也免得把用户没动过的项反复覆盖
  if (!changed) {
    return { ok: true, unchanged: true, previous: previous.raw, value: json[field], type: 'REG_SZ', field };
  }

  json[field] = next;
  const written = writeValue(registryKey, name, JSON.stringify(json), backupPath, type || 'REG_SZ');
  if (!written.ok) return written;
  return { ok: true, unchanged: false, previous: previous.raw, value: next, type: written.type, field };
}

/**
 * 这条注册表值到底是不是「一整条 JSON 对象」。
 *
 * 用来区分两种画质项：
 *   - 单值项：`Screenmanager Resolution Width_h182942802` = REG_DWORD 1920
 *   - JSON 项：`GENERAL_DATA_V2_PersonalGraphicsSettingV2_h…` = REG_SZ '{...21 个字段...}'
 *
 * 以前主进程只看「entry 和 field 都传了」就当成 JSON 去改，
 * 单值项因此全部报「不是 JSON，没法单独改其中的字段」，界面上就是所有选项都不可用。
 * 读一次真实值来判断，读不到就当作不是 JSON（走整条改写，那条路会有自己的校验）。
 */
function looksLikeJsonObject(registryKey, name) {
  try {
    const previous = readValueEntry(registryKey, name);
    if (!previous || !previous.raw) return false;
    const text = String(previous.raw).trim();
    if (!/^[{[]/.test(text)) return false;
    const parsed = parseGraphicsValue(previous.raw);
    return Boolean(parsed) && typeof parsed === 'object';
  } catch {
    return false;
  }
}

module.exports = {
  readGraphics,
  writeValue,
  updateJsonField,
  looksLikeJsonObject,
  listValueNames,
  listValueNamesFast,
  readValue,
  readValueEntry,
  parseGraphicsValue,
};
