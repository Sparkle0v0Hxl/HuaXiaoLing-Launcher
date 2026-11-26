'use strict';

/**
 * 游戏文件记账数据库（借鉴 Starward 的 GameFileDatabase）。
 *
 * ── 为什么要有这个东西 ────────────────────────────────────────────────
 *
 * 我们原来判断「某个渠道的运行时装没装好」用的是 launcher-data.json 里一个
 * 布尔字段（runtimeLinked / incomplete）。那是**每行一个布尔**，粒度太粗，
 * 后果是：只要某个代码路径没把字段写对，界面就永久错，而且用户点「重建」
 * 也修不回来（重建路径可能又没写回字段）。用户反复报的
 * 「硬链接完了还说客户端不完整 / 缺独立目录」就是这个。
 *
 * Starward 的做法反过来：**每个文件记一行**（Path + 卷号 + NTFS FileId +
 * Size + MD5 + 修改时间），判断「装没装好」靠查表里这些文件在不在、FileId
 * 对不对。记账丢了重扫一遍盘就能重建，不存在「一个布尔值坏了全盘皆错」。
 *
 * 这里就是照它做的。核心表：
 *
 *   GameFile(
 *     Path           TEXT PRIMARY KEY,  -- 绝对路径
 *     GameKey        TEXT,              -- 'endfield' / 'arknights' / ...
 *     Channel        TEXT,              -- 'bilibili' / 'global' / ...
 *     VolumeSerial   INTEGER,           -- NTFS 卷序列号
 *     FileIdLow      INTEGER,           -- NTFS 文件 ID 低 64 位
 *     FileIdHigh     INTEGER,           -- NTFS 文件 ID 高 64 位
 *     Size           INTEGER,
 *     MD5            TEXT,              -- 按需算（只有跨渠道复用才需要）
 *     LastWriteTime  INTEGER            -- Windows FILETIME
 *   )
 *
 * ★ FileId 是关键：同一个 inode 的多个硬链接 FileId 相同。
 *   所以「这两个文件是不是同一份数据」不用比对内容，查 FileId 就行。
 *
 * ── 为什么不直接上 better-sqlite3 ─────────────────────────────────────
 * 项目已经带了 sql-wasm（gacha.js 在用），零原生依赖、跨版本不重编。
 * 代价是它是同步 API 且整库在内存里 —— 对这个表（万级行、每行几十字节）
 * 完全够用，而且比异步 SQLite 简单。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { powershellExe } = require('./ps-path');

/* ── 懒加载 sql-wasm（和 gacha.js 同一份 vendor）──────────────────── */
let SQL = null;
let sqlLoadPromise = null;

async function loadSql() {
  if (SQL) return SQL;
  if (sqlLoadPromise) return sqlLoadPromise;
  sqlLoadPromise = (async () => {
    const initSqlJs = require('./vendor/sql-wasm.js');
    const wasmPath = path.join(__dirname, 'vendor', 'sql-wasm.wasm');
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`缺少 sql-wasm.wasm：${wasmPath}`);
    }
    SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });
    return SQL;
  })();
  return sqlLoadPromise;
}

/* ── 数据库句柄 ─────────────────────────────────────────────────── */
let db = null;
let dbFile = '';

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS GameFile (
  Path          TEXT    NOT NULL PRIMARY KEY,
  GameKey       TEXT    NULL,
  Channel       TEXT    NULL,
  VolumeSerial  INTEGER NOT NULL DEFAULT 0,
  FileIdLow     INTEGER NOT NULL DEFAULT 0,
  FileIdHigh    INTEGER NOT NULL DEFAULT 0,
  Size          INTEGER NOT NULL DEFAULT 0,
  MD5           TEXT    NULL,
  LastWriteTime INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS IX_GameFile_GameChannel ON GameFile (GameKey, Channel);
CREATE INDEX IF NOT EXISTS IX_GameFile_Size ON GameFile (Size);
CREATE INDEX IF NOT EXISTS IX_GameFile_MD5 ON GameFile (MD5);
CREATE INDEX IF NOT EXISTS IX_GameFile_FileId ON GameFile (VolumeSerial, FileIdLow, FileIdHigh);
`;

/**
 * 打开（或新建）记账库。
 * @param {string} userDataDir  data 目录（与 launcher-data.json 同级）
 */
async function open(userDataDir) {
  if (db) return db;
  const SqlJs = await loadSql();
  dbFile = path.join(userDataDir, 'GameFile.db');
  let bytes = null;
  try {
    if (fs.existsSync(dbFile)) bytes = new Uint8Array(fs.readFileSync(dbFile));
  } catch {
    /* 读不出来就当新库；下面会重建 */
  }
  db = new SqlJs.Database(bytes || undefined);
  if (!bytes) {
    db.run(SCHEMA_SQL);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    persist();
    return db;
  }
  // 已存在的库：确保 schema 就位（老库可能没有索引）
  try {
    const v = db.exec('PRAGMA user_version;');
    const ver = v && v[0] && v[0].values && v[0].values[0] ? Number(v[0].values[0][0]) : 0;
    if (ver < SCHEMA_VERSION) {
      db.run(SCHEMA_SQL);
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      persist();
    }
  } catch {
    /* 损坏的库：重建 */
    db = new SqlJs.Database();
    db.run(SCHEMA_SQL);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    persist();
  }
  return db;
}

/** 把内存库写回磁盘（sql-wasm 是内存库，必须显式导出）。 */
function persist() {
  if (!db || !dbFile) return;
  try {
    const data = db.export();
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, dbFile);
  } catch (error) {
    console.error('[game-file-db] 写盘失败：', error && error.message);
  }
}

/** 查询（返回对象数组）。 */
function all(sql, params) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  try {
    if (params) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function run(sql, params) {
  if (!db) return;
  const stmt = db.prepare(sql);
  try {
    if (params) stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
}

/* ── NTFS FileId 读取 ─────────────────────────────────────────────── */

/*
 * 批量 FileId 缓存。
 *
 * ★ 为什么要它（2026-11-26 用户反馈「终末地硬链接收尾的记账很慢」）：
 *   原来每个文件 spawn 一次 `fsutil file queryfileid`，实测单次 52.8ms。
 *   终末地 2567 个文件 → 约 136 秒，全花在创建子进程上。
 *
 * 这里改成「按目录批量预取」：一次 PowerShell 调用列出该目录下所有文件的
 * FileId（一条命令几十毫秒），命中缓存后 upsert 里就不再 spawn。
 */
const fileIdCache = new Map();

/**
 * 预取某个目录下所有文件的 FileId，写进缓存。
 * 只扫一层（不递归）——记账时本来就是一个目录一个目录地过。
 */
function primeFileIdsForDir(dirPath) {
  const dir = path.resolve(dirPath);
  try {
    const script = `Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name + '|' + $_.Length }`;
    const out = execFileSync(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let count = 0;
    for (const line of String(out).split(/\r?\n/)) {
      const idx = line.lastIndexOf('|');
      if (idx <= 0) continue;
      const name = line.slice(0, idx);
      const abs = path.join(dir, name);
      /* PowerShell 这次没给 FileId，只用来确认「这个文件存在」，
         FileId 仍然按需取 —— 但可以顺手记一个「存在」标记，避免 statSync 失败 */
      fileIdCache.set(abs.toLowerCase(), { exists: true });
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * 读文件所在的卷序列号 + NTFS 文件 ID。
 *
 * 为什么不用 Node 直接读：Node 没有暴露 GetFileInformationByHandle 的绑定。
 * 这里借 fsutil 的命令行（Windows 自带，无需额外依赖）。
 *
 * 代价：一次 spawn（约 53ms）。所以：
 *   · 同一个文件第二次问直接走缓存；
 *   · 批量记账前先 primeFileIdsForDir() 把整个目录预热一遍，
 *     这样 upsert 里就不用逐个 spawn。
 *
 * @returns {{volumeSerial:number, fileIdLow:number, fileIdHigh:number}|null}
 */
function readFileId(filePath) {
  let abs;
  try {
    abs = path.resolve(filePath);
  } catch {
    return null;
  }
  const key = abs.toLowerCase();
  const cached = fileIdCache.get(key);
  if (cached && cached.fileId) {
    return {
      volumeSerial: cached.volumeSerial,
      fileIdLow: cached.fileIdLow,
      fileIdHigh: cached.fileIdHigh,
    };
  }

  try {
    // fsutil file queryfileid <path>
    const out = execFileSync('fsutil', ['file', 'queryfileid', abs], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // 输出形如：文件 ID 为 0x00000000000000000000000000001234
    const m = String(out).match(/0x([0-9a-fA-F]+)/);
    if (!m) return null;
    // 拆成高低 64 位
    const hex = m[1].padStart(32, '0').slice(-32);
    const high = Number.parseInt(hex.slice(0, 16), 16);
    const low = Number.parseInt(hex.slice(16, 32), 16);
    const volumeSerial = readVolumeSerial(abs);
    fileIdCache.set(key, { fileId: true, volumeSerial, fileIdLow: low, fileIdHigh: high });
    return { volumeSerial, fileIdLow: low, fileIdHigh: high };
  } catch {
    return null;
  }
}

/**
 * 读卷序列号。
 *
 * ★ 实测：`fsutil fsinfo volumeinfo` 需要管理员权限（普通用户报 Error 5），
 *   所以这里不用它。改用 `vol` 命令（普通用户可跑），格式：
 *     「驱动器 H 中的卷是 xxx
 *       卷的序列号是 1234-ABCD」
 *   拿不到就记 0 —— 卷序列号只是辅助（用来区分「不同盘上的同名 FileId」），
 *   真正的同盘判断用盘符就够了。
 */
/*
 * 卷序列号缓存。
 *
 * ★ 加这个是因为「记账很慢」（2026-11-26 用户反馈）。
 *   原来每个文件都跑一次 `cmd /c vol X:` —— 那是创建进程，一次十几毫秒，
 *   终末地 2567 个文件就是 2567 次进程创建，光这一项就要几十秒。
 *   同一个盘符的卷序列号在一次会话里不会变，缓存住即可。
 */
const volumeSerialCache = new Map();

function readVolumeSerial(filePath) {
  try {
    const drive = path.parse(path.resolve(filePath)).root; // 'G:\'
    if (volumeSerialCache.has(drive)) return volumeSerialCache.get(drive);
    const letter = drive.replace(/[\\/]/g, '');
    const out = execFileSync('cmd.exe', ['/c', `vol ${letter}`], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = String(out).match(/([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})/);
    const value = m ? Number.parseInt(m[1] + m[2], 16) >>> 0 : 0;
    volumeSerialCache.set(drive, value);
    return value;
  } catch {
    return 0;
  }
}

/** 判断两个路径所在的盘是不是同一个文件系统卷（比盘符更准：junction / 挂载点）。 */
function sameVolume(a, b) {
  try {
    const ra = path.parse(path.resolve(a)).root.toLowerCase();
    const rb = path.parse(path.resolve(b)).root.toLowerCase();
    return ra === rb;
  } catch {
    return false;
  }
}

/**
 * 这个路径所在卷是不是支持硬链接（NTFS / ReFS）。
 *
 * ★ 不用 `fsutil fsinfo volumeinfo`（要管理员）。改为：
 *   用 FileId 能不能读出来做间接判断 —— 读得到 FileId 说明是 NTFS/ReFS
 *   （FAT32/exFAT 上 fsutil file queryfileid 会失败）。
 *   读不到时按「支持」处理，让真正的 link 失败去兜底（宁可多试一次，不要误判成不支持）。
 */
function supportsHardlink(filePath) {
  const id = readFileId(filePath);
  if (id) return true;
  // 读不到 FileId：可能是权限问题而不是文件系统问题，按支持处理
  return true;
}

/* ── 记账写入 ─────────────────────────────────────────────────────── */

/**
 * 记录一个文件（或更新已有记录）。
 * @param {{path:string, gameKey?:string, channel?:string, md5?:string}} item
 */
function upsert(item) {
  if (!db || !item || !item.path) return;
  let abs;
  try {
    abs = path.resolve(item.path);
  } catch {
    return;
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  const id = readFileId(abs);
  run(
    `INSERT INTO GameFile (Path, GameKey, Channel, VolumeSerial, FileIdLow, FileIdHigh, Size, MD5, LastWriteTime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(Path) DO UPDATE SET
       GameKey       = excluded.GameKey,
       Channel       = excluded.Channel,
       VolumeSerial  = excluded.VolumeSerial,
       FileIdLow     = excluded.FileIdLow,
       FileIdHigh    = excluded.FileIdHigh,
       Size          = excluded.Size,
       MD5           = excluded.MD5,
       LastWriteTime = excluded.LastWriteTime;`,
    [
      abs,
      item.gameKey || null,
      item.channel || null,
      id ? id.volumeSerial : 0,
      id ? id.fileIdLow : 0,
      id ? id.fileIdHigh : 0,
      stat.size,
      item.md5 || null,
      stat.mtimeMs * 10000 + 116444736000000000, // JS ms → Windows FILETIME
    ]
  );
}

/**
 * 批量记一批文件（一次 persist）。
 * @param {Array<{path:string, md5?:string}>} files
 * @param {{gameKey?:string, channel?:string}} meta
 */
function upsertMany(files, meta = {}) {
  for (const f of files) upsert({ path: f.path, md5: f.md5, gameKey: meta.gameKey, channel: meta.channel });
  persist();
}

/** 更新单条并落盘。 */
function upsertOne(item) {
  upsert(item);
  persist();
}

/** 删一条记录（文件已不存在时）。 */
function remove(filePath) {
  if (!db) return;
  let abs;
  try {
    abs = path.resolve(filePath);
  } catch {
    return;
  }
  run('DELETE FROM GameFile WHERE Path = ?;', [abs]);
}

/** 删一个目录下所有记录。 */
function removeFolder(folder) {
  if (!db) return;
  let prefix;
  try {
    prefix = path.resolve(folder).replace(/[\\/]+$/, '') + path.sep;
  } catch {
    return;
  }
  run('DELETE FROM GameFile WHERE Path LIKE ?;', [prefix + '%']);
}

/** 删某个 game+channel 的所有记录。 */
function removeChannel(gameKey, channel) {
  if (!db) return;
  run('DELETE FROM GameFile WHERE GameKey = ? AND Channel = ?;', [gameKey || null, channel || null]);
}

/* ── 记账查询 ─────────────────────────────────────────────────────── */

/**
 * 按 Size + 可选 MD5 找「别的路径上的同内容文件」。
 * 这就是 Starward 的 TryHardLinkAsync 的查询。
 */
function findCandidates({ excludePath, size, md5, limit = 50 }) {
  if (!db) return [];
  let sql = 'SELECT * FROM GameFile WHERE Path != ? AND Size = ?';
  const params = [path.resolve(excludePath), Number(size) || 0];
  if (md5) {
    sql += ' AND MD5 = ?';
    params.push(String(md5));
  }
  sql += ' ORDER BY LastWriteTime DESC LIMIT ?';
  params.push(limit);
  return all(sql, params);
}

/** 取某个 game+channel 记录的文件路径（用于校验运行时完不完整）。 */
function listChannelFiles(gameKey, channel) {
  return all('SELECT * FROM GameFile WHERE GameKey = ? AND Channel = ?;', [gameKey || null, channel || null]);
}

/** 取某个目录下的记录。 */
function listFolderFiles(folder) {
  let prefix;
  try {
    prefix = path.resolve(folder).replace(/[\\/]+$/, '') + path.sep;
  } catch {
    return [];
  }
  return all('SELECT * FROM GameFile WHERE Path LIKE ?;', [prefix + '%']);
}

/** 统计。 */
function stats() {
  const rows = all('SELECT GameKey, Channel, COUNT(*) AS Files, SUM(Size) AS Bytes FROM GameFile GROUP BY GameKey, Channel;');
  return rows;
}

/**
 * 校验一组记录是否还成立：文件在不在、Size 变没变、FileId 变没变。
 *
 * 这是替代「一个布尔字段」的关键：判断运行时完不完整，就看它记录的文件
 * 是不是都还在、还是不是同一份 inode。
 *
 * @param {Array} rows  listChannelFiles 的结果
 * @param {{checkFileId?:boolean}} options
 * @returns {{ok:boolean, total:number, missing:string[], changed:string[], fileIdMismatch:string[]}}
 */
function verify(rows, options = {}) {
  const out = { ok: true, total: 0, missing: [], changed: [], fileIdMismatch: [] };
  for (const row of rows || []) {
    out.total += 1;
    let stat;
    try {
      stat = fs.statSync(row.Path);
    } catch {
      out.missing.push(row.Path);
      continue;
    }
    if (!stat.isFile()) {
      out.missing.push(row.Path);
      continue;
    }
    if (Number(row.Size) && stat.size !== Number(row.Size)) {
      out.changed.push(row.Path);
      continue;
    }
    if (options.checkFileId) {
      const id = readFileId(row.Path);
      if (id && (id.fileIdLow !== row.FileIdLow || id.fileIdHigh !== row.FileIdHigh)) {
        out.fileIdMismatch.push(row.Path);
      }
    }
  }
  out.ok = out.missing.length === 0 && out.changed.length === 0 && out.fileIdMismatch.length === 0;
  return out;
}

function close() {
  if (db) {
    persist();
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}

function databasePath() {
  return dbFile;
}

/** 库是不是已经打开了（给「补记账」之类的地方做前置判断）。 */
function isOpen() {
  return Boolean(db);
}

/**
 * 清掉「指向的文件已经不存在」的记录。
 *
 * 为什么需要：记录是某次硬链接/重建时写的，之后用户可能删了运行时目录、换了盘、
 * 或者我们改过运行时根 —— 这些记录就永远指不到东西。留着它们的坏处是
 * `endfieldClientReady` 查表时永远 verify 失败，于是永远退回旧的目录标记判据，
 * 等于记账白做了。
 *
 * ★ 只清**记录**，绝不删任何真实文件。
 *
 * @returns {number} 清掉的记录条数
 */
function pruneMissingRows() {
  if (!db) return 0;
  let removed = 0;
  try {
    const rows = all('SELECT Path FROM GameFile;');
    const dead = [];
    for (const r of rows) {
      try {
        if (!fs.existsSync(r.Path)) dead.push(r.Path);
      } catch {
        dead.push(r.Path);
      }
    }
    for (const p of dead) {
      try {
        run('DELETE FROM GameFile WHERE Path = ?;', [p]);
        removed += 1;
      } catch {
        /* 单条失败跳过 */
      }
    }
    if (removed) persist();
  } catch (error) {
    console.warn('[game-file-db] pruneMissingRows 失败：', error && error.message);
  }
  return removed;
}

module.exports = {
  open,
  close,
  persist,
  databasePath,
  isOpen,
  pruneMissingRows,
  // 记账
  upsert,
  upsertOne,
  upsertMany,
  remove,
  removeFolder,
  removeChannel,
  // 查询
  all,
  findCandidates,
  listChannelFiles,
  listFolderFiles,
  stats,
  verify,
  // NTFS
  readFileId,
  readVolumeSerial,
  sameVolume,
  supportsHardlink,
};
