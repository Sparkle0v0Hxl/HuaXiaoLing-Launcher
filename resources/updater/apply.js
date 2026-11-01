'use strict';

/**
 * 花筱灵启动器覆盖安装器（Node 版）。
 *
 * 由 electron/updater.js 在「已经下载、校验、解压完成」之后拉起，脱离主进程运行。
 * 用法（会以 Electron 自带的 Node 运行，见 updater.js 的 apply()）：
 *   node apply.js --meta <apply-meta.json 路径>
 *
 * meta.json 里的 action 决定走哪条路：
 *   update    等旧进程退出 → 逐项备份 → 逐项覆盖 → 清理另一套结构 → 写标记 → 拉起 + 看护
 *   rollback  等旧进程退出 → 把备份还原回去 → 写标记 → 拉起
 *
 * 这是 resources/updater/HXL-Updater.ps1 的等价实现。为什么要重写：
 * 一部分机器上的安全软件 / 策略会拦住「Electron 进程 spawn PowerShell 执行脚本」，
 * 表现为脚本完全没有被执行、界面卡在 100%（10-30 复现）。PowerShell 那条路保留
 * 在 updater.js 里当兜底，但默认不再走它。
 *
 * 覆盖粒度刻意是「文件」而不是「目录镜像」：
 *   · 目录镜像会删掉目标里源没有的文件，data、下载缓存、渠道包全在里面；
 *   · 万一中途失败，已经备份的文件可以逐个还原，不会留下半新半旧的程序目录。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

/*
 * Electron 自带的 Node 会给 fs 打补丁：凡是路径里带 *.asar 的都被当成「归档里的虚拟文件」，
 * 写 resources\app.asar 会直接抛 "Invalid package"。我们要写的是磁盘上的真实文件，
 * 所以一进来就把这套补丁关掉（实测：不关的话新包带 app.asar 时覆盖必失败）。
 * 纯 Node 下这个字段没人读，赋值没有副作用。
 */
process.noAsar = true;

const EXE_NAME = '花筱灵启动器.exe';
/** 等旧进程退出最多等多久。 */
const PROCESS_WAIT_MS = 60 * 1000;
/** 根目录文件（exe、dll…）被占用时最多等它多久释放。 */
const LOCK_TIMEOUT_MS = 60 * 1000;
/** 子目录里的文件只短等一下，不能让一个被占用的文件拖住整个更新。 */
const SHORT_LOCK_TIMEOUT_MS = 3 * 1000;
/** 拉起后观察多久。 */
const SETTLE_MS = 45 * 1000;
/** 连续几次起不来就回滚。 */
const MISS_LIMIT = 3;
/** 存活超过这么久基本已经进了主窗口，没必要一直盯到 45 秒。 */
const ALIVE_ENOUGH_MS = 8 * 1000;

/* ---------------------------------------------------------------- */
/* 参数                                                               */
/* ---------------------------------------------------------------- */

function pickArg(...names) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    for (const name of names) {
      if (arg === name) return String(argv[i + 1] || '');
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return '';
}

/* ---------------------------------------------------------------- */
/* 小工具                                                             */
/* ---------------------------------------------------------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowStamp() {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`;
}

function resolveJoined(root, relative) {
  return path.join(root, String(relative || '').replace(/\//g, path.sep));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** 写 JSON。失败只记日志 —— 这些文件是给别人看的，写不出来不该中断流程。 */
function writeJson(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    log(`[warn] 写文件失败 ${file}：${error && error.message ? error.message : error}`);
    return false;
  }
}

/** 追加一行到日志文件。 */
function writeLine(file, line) {
  try {
    fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8', flag: 'a' });
  } catch {
    /* 日志写不出来不影响主流程 */
  }
}

let LOG_PATH = '';

function log(message) {
  const line = `[${nowStamp()}] ${message}`;
  console.log(line);
  if (LOG_PATH) writeLine(LOG_PATH, line);
}

let GUARD_LOG_PATH = '';

/** 监护人的日志单独一份（self-heal.log），界面上会把它单列出来。 */
function guardLog(message) {
  const line = `[${nowStamp()}] ${message}`;
  console.log(line);
  log(message);
  if (GUARD_LOG_PATH) writeLine(GUARD_LOG_PATH, line);
}

/* ---------------------------------------------------------------- */
/* 文件操作                                                           */
/* ---------------------------------------------------------------- */

/** 目标是否被别的进程占着写不了（游戏正在跑主程序 exe 时就是这种情况）。 */
function isFileLocked(file) {
  if (!fs.existsSync(file)) return false;
  let handle = null;
  try {
    // libuv 打开文件时会申请读写权限，正在运行的镜像只放行 FILE_SHARE_READ，这里必然撞上
    handle = fs.openSync(file, 'r+');
    return false;
  } catch {
    return true;
  } finally {
    if (handle !== null && typeof handle === 'number') {
      try {
        fs.closeSync(handle);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 等到文件可以写为止。超时了就交给调用方决定是否跳过。 */
async function waitFileWritable(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isFileLocked(file)) return true;
    await sleep(500);
  }
  return !isFileLocked(file);
}

function copyFileReplacing(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    try {
      // 只读属性会让覆盖失败
      fs.chmodSync(destination, 0o666);
    } catch {
      /* ignore */
    }
  }
  fs.copyFileSync(source, destination);
}

/**
 * 列出「名字是指定 exe」的运行中进程，返回 PID 列表。
 *
 * 走 tasklist /FO CSV：中文进程名在 GBK 代码页下取回来会乱码，所以这里不解析名字、
 * 只数「以引号开头的数据行」——名字的比对交给 tasklist 自己（它内部按 Unicode 比），
 * 我们只取第二列的 PID（纯数字，怎么编码都不会错）。
 */
function listLauncherPids(exeName) {
  try {
    const result = spawnSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${exeName}`], {
      windowsHide: true,
      encoding: 'latin1',
      timeout: 15000,
    });
    const text = String((result && result.stdout) || '');
    const pids = [];
    for (const line of text.split(/\r?\n/)) {
      // 没有匹配时 tasklist 只吐一行提示信息，不以引号开头
      const hit = /^"[^"]*","(\d+)"/.exec(line.trim());
      if (hit) pids.push(Number(hit[1]));
    }
    return pids;
  } catch (error) {
    log(`[warn] 列进程失败（按「没有在跑」处理）：${error && error.message ? error.message : error}`);
    return [];
  }
}

/**
 * 等旧进程退出。
 *
 * 光看进程名是不够的：用户机器上可能同时装着另一个副本，它跑着也不该挡住这次更新。所以额外核一件事——本副本的主程序文件是否还被占着。本副本在跑时它的
 * exe 一定打不开（镜像只放行共享读），别的副本占不到这个文件。
 */
async function waitForMainProcessExit(target) {
  const exePath = path.join(target, EXE_NAME);
  const deadline = Date.now() + PROCESS_WAIT_MS;
  for (;;) {
    const pids = listLauncherPids(EXE_NAME);
    if (!pids.length) return true;
    if (!isFileLocked(exePath)) {
      log(`[warn] 检测到 ${pids.length} 个 ${EXE_NAME}（PID ${pids.join(', ')}），但它们没有占用 ${exePath}，判断为其他副本，继续`);
      return true;
    }
    if (Date.now() >= deadline) {
      log(`[error] 等了 ${Math.round(PROCESS_WAIT_MS / 1000)} 秒，${EXE_NAME}（PID ${pids.join(', ')}）仍在运行`);
      return false;
    }
    log(`等待进程退出：${EXE_NAME}（PID ${pids.join(', ')}）`);
    await sleep(1000);
  }
}

/* ---------------------------------------------------------------- */
/* 拉起 / 看护                                                        */
/* ---------------------------------------------------------------- */

function relaunchExe(target, meta) {
  const declared = String((meta && meta.relaunch) || '').trim();
  if (declared && fs.existsSync(declared)) return declared;
  const local = path.join(target, EXE_NAME);
  return fs.existsSync(local) ? local : declared || local;
}

/** 拉起启动器。失败只记日志 —— 这个函数经常在兜底路径里被调用。 */
function startLauncher(target, exe) {
  if (!fs.existsSync(exe)) {
    log(`[error] 找不到要拉起的程序：${exe}`);
    return false;
  }
  log(`重新启动启动器：${exe}`);
  try {
    const child = spawn(exe, [], { cwd: target, detached: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', (error) => {
      log(`[error] 拉起失败：${error && error.message ? error.message : error}`);
    });
    try {
      child.unref();
    } catch {
      /* ignore */
    }
    return true;
  } catch (error) {
    log(`[error] 拉起失败：${error && error.message ? error.message : error}`);
    return false;
  }
}

/** 一次「拉起 → 观察是否活着」，返回 true 表示这次站住了。 */
async function launchAndWatch(target, exe, attemptLabel) {
  guardLog(attemptLabel);
  let child = null;
  try {
    child = spawn(exe, [], { cwd: target, detached: true, windowsHide: true, stdio: 'ignore' });
  } catch (error) {
    guardLog(`[error] 启动失败：${error && error.message ? error.message : error}`);
    return { alive: false, child: null, startedAt: 0 };
  }
  child.on('error', (error) => {
    guardLog(`[error] 启动失败：${error && error.message ? error.message : error}`);
  });
  try {
    child.unref();
  } catch {
    /* ignore */
  }

  const startedAt = Date.now();
  const deadline = startedAt + SETTLE_MS;
  for (;;) {
    await sleep(500);
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (exited) return { alive: false, child, startedAt };
    if (Date.now() - startedAt >= ALIVE_ENOUGH_MS) return { alive: true, child, startedAt };
    if (Date.now() >= deadline) return { alive: true, child, startedAt };
  }
}

/* ---------------------------------------------------------------- */
/* 还原备份（回滚共用）                                                */
/* ---------------------------------------------------------------- */

/** 把 sourceRoot 里的文件按清单还原回 target，顺便还原 resources/updater 目录。 */
async function restoreFiles({ target, sourceRoot, files, statusDir, backupMarker }) {
  log(`开始还原 ${files.length} 个文件，来源 ${sourceRoot}`);
  const total = files.length;
  for (let index = 0; index < total; index += 1) {
    const relative = files[index];
    if ((index + 1) % 50 === 0 || index + 1 === total) log(`还原中 ${index + 1}/${total}`);
    const backupFile = resolveJoined(sourceRoot, relative);
    if (!fs.existsSync(backupFile)) continue;
    const destination = resolveJoined(target, relative);
    const timeout = relative.includes('/') ? SHORT_LOCK_TIMEOUT_MS : LOCK_TIMEOUT_MS;
    if (!(await waitFileWritable(destination, timeout))) {
      log(`[skip] 被占用，暂不还原：${relative}`);
      continue;
    }
    try {
      copyFileReplacing(backupFile, destination);
    } catch (error) {
      log(`[skip] 还原失败 ${relative}：${error && error.message ? error.message : error}`);
    }
  }

  // 覆盖脚本/自检脚本本身也被覆盖过，一起还原，否则旧版启动器会带着新版脚本
  const restoredUpdater = path.join(sourceRoot, 'resources', 'updater');
  const destUpdater = path.join(target, 'resources', 'updater');
  if (fs.existsSync(restoredUpdater)) {
    try {
      fs.mkdirSync(destUpdater, { recursive: true });
      const entries = await fsp.readdir(restoredUpdater, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
          copyFileReplacing(path.join(restoredUpdater, entry.name), path.join(destUpdater, entry.name));
        } catch {
          /* 单个文件还原不了不影响其它文件 */
        }
      }
    } catch {
      /* ignore */
    }
  }

  writeJson(path.join(statusDir, 'last-update.json'), backupMarker);
}

/* ---------------------------------------------------------------- */
/* 更新                                                               */
/* ---------------------------------------------------------------- */

function backupDirName(meta, kind) {
  const from = String(meta.fromVersion || '') || 'unknown';
  const to = String(meta.targetVersion || '');
  if (kind === 'rollback') return `backup-rollback-${to}`;
  return `backup-${from}`;
}

async function invokeUpdate(target, meta) {
  const source = String(meta.source || '');
  const files = Array.isArray(meta.files) ? meta.files : [];
  const statusDir = String(meta.statusDir || '');
  const version = String(meta.targetVersion || '') || 'unknown';

  if (!source || !fs.existsSync(source)) throw new Error(`更新包解压目录不见了：${source}`);
  if (!files.length) throw new Error('apply-meta.json 里没有要覆盖的文件清单');

  if (!(await waitForMainProcessExit(target))) {
    throw new Error('启动器还在运行，没能退出，本次更新已放弃（可以重试）');
  }

  /* ---- 1. 备份 ---- */
  const backupRoot = path.join(statusDir, backupDirName(meta, 'update'));
  await fsp.rm(backupRoot, { recursive: true, force: true }).catch(() => {});
  fs.mkdirSync(backupRoot, { recursive: true });
  log(`备份到 ${backupRoot}`);

  let backed = 0;
  for (let index = 0; index < files.length; index += 1) {
    const relative = files[index];
    if ((index + 1) % 50 === 0 || index + 1 === files.length) log(`备份中 ${index + 1}/${files.length}`);
    const destination = resolveJoined(target, relative);
    if (!fs.existsSync(destination)) continue;
    if (!(await waitFileWritable(destination, SHORT_LOCK_TIMEOUT_MS))) {
      log(`[skip] 文件被占用，跳过备份：${relative}`);
      continue;
    }
    try {
      copyFileReplacing(destination, resolveJoined(backupRoot, relative));
      backed += 1;
    } catch (error) {
      log(`[skip] 备份失败 ${relative}：${error && error.message ? error.message : error}`);
    }
  }

  // 字段名保持和 HXL-Updater.ps1 的 Write-BackupMeta 一致：prepareRollback 靠它读备份
  writeJson(path.join(backupRoot, 'meta.json'), {
    backupRoot,
    createdAt: new Date().toISOString(),
    fromVersion: String(meta.fromVersion || ''),
    targetVersion: String(meta.targetVersion || ''),
    files,
    protectedFiles: Array.isArray(meta.protectedExisting) ? meta.protectedExisting : [],
  });
  log(`备份完成：${backed} 个文件`);

  /* ---- 2. 覆盖 ---- */
  const skipped = [];
  let written = 0;
  for (let index = 0; index < files.length; index += 1) {
    const relative = files[index];
    if ((index + 1) % 50 === 0 || index + 1 === files.length) log(`覆盖中 ${index + 1}/${files.length}`);
    const sourceFile = resolveJoined(source, relative);
    if (!fs.existsSync(sourceFile)) continue;
    const destination = resolveJoined(target, relative);
    const timeout = relative.includes('/') ? SHORT_LOCK_TIMEOUT_MS : LOCK_TIMEOUT_MS;
    if (!(await waitFileWritable(destination, timeout))) {
      log(`[skip] 文件被占用，暂不覆盖：${relative}`);
      skipped.push(relative);
      continue;
    }
    try {
      copyFileReplacing(sourceFile, destination);
      written += 1;
    } catch (error) {
      log(`[skip] 覆盖失败 ${relative}：${error && error.message ? error.message : error}`);
      skipped.push(relative);
    }
  }
  log(`覆盖完成：${written} 个文件，跳过 ${skipped.length} 个`);

  const exePath = path.join(target, EXE_NAME);
  if (!fs.existsSync(exePath)) {
    // 只记日志、不抛异常：新文件已经落地，抛出去反而会把已经装好的状态说成失败。
    // 拉不起来这种事交给下面的看护去判断（缺少主程序时它也不会贸然回滚）。
    log(`[error] 覆盖后找不到主程序：${exePath}`);
  }

  /* ---- 2.5 结构切换 ---- */
  // 新包和旧安装可能是两套形态：asar 包（resources\app.asar）或展开目录（resources\app）。
  // 两套并存时 Electron 只认其中一套，用户看到的版本和磁盘上的文件对不上，
  // 所以覆盖成功后才清掉另一套旧结构：万一失败，新结构已经落地，还能起来。
  let newAsar = files.includes('resources/app.asar');
  let newAppDir = files.includes('resources/app/package.json');
  if (newAsar && newAppDir) newAppDir = false;
  const oldAppDir = path.join(target, 'resources', 'app');
  const oldAsar = path.join(target, 'resources', 'app.asar');
  try {
    if (newAsar && fs.existsSync(oldAppDir)) {
      log('新包是 asar 结构，清理旧的 resources\\app 目录');
      await fsp.rm(oldAppDir, { recursive: true, force: true });
    } else if (newAppDir && fs.existsSync(oldAsar)) {
      log('新包是展开目录结构，清理旧的 resources\\app.asar');
      await fsp.rm(oldAsar, { force: true });
    }
  } catch (error) {
    log(`[warn] 清理旧结构失败：${error && error.message ? error.message : error}`);
  }

  /* ---- 3. 标记 ---- */
  writeJson(path.join(statusDir, 'last-update.json'), {
    action: 'update',
    fromVersion: String(meta.fromVersion || ''),
    targetVersion: version,
    appliedAt: new Date().toISOString(),
    filesWritten: written,
    skippedFiles: skipped,
    backupRoot,
  });

  /* ---- 4. 拉起 + 看护 ---- */
  const exe = relaunchExe(target, meta);
  if (!fs.existsSync(exe)) {
    // 跟 self-heal.ps1 的口径一致：没有主程序可拉，就别把备份还原一遍了
    log(`[error] 没有可拉起的启动器，跳过看护：${exe}`);
    return;
  }
  await guard({ target, exe, statusDir, meta, backupRoot, files });
}

/**
 * 升级后的看护：新版本能站住就万事大吉，连续起不来就把备份还原回去再拉一次。
 * self-heal.ps1 原来是独立脚本（要 PowerShell 才能跑），这里用 Node 重写了同样的判定：
 * 拉起 → 观察（活过 8 秒或撑到 45 秒算成功，中途退出算失败）→ 连续 3 次失败就回滚。
 */
async function guard({ target, exe, statusDir, meta, backupRoot, files }) {
  GUARD_LOG_PATH = path.join(statusDir, 'self-heal.log');
  let lastPid = 0;
  for (let attempt = 1; attempt <= MISS_LIMIT; attempt += 1) {
    const watch = await launchAndWatch(target, exe, `第 ${attempt} 次拉起启动器，观察 ${Math.round(SETTLE_MS / 1000)}s`);
    if (watch.child && watch.child.pid) lastPid = watch.child.pid;
    if (watch.alive) {
      guardLog('监护通过，启动器已正常运行');
      writeJson(path.join(statusDir, 'self-heal.json'), {
        status: 'ok',
        failures: 0,
        attempts: attempt,
        alivePreviewMs: Date.now() - watch.startedAt,
        pid: lastPid,
        checkedAt: new Date().toISOString(),
      });
      return;
    }
    guardLog(`启动器在第 ${attempt} 次观察中退出（存活 ${Date.now() - watch.startedAt}ms）`);
  }

  guardLog(`连续失败 ${MISS_LIMIT} 次，准备还原备份：${backupRoot}`);
  writeJson(path.join(statusDir, 'self-heal.json'), {
    status: 'rolled-back',
    failures: MISS_LIMIT,
    action: 'rollback',
    backupRoot,
    checkedAt: new Date().toISOString(),
  });
  const marker = {
    action: 'rollback',
    returnedTo: String(meta.fromVersion || ''),
    revertedFrom: String(meta.targetVersion || ''),
    appliedAt: new Date().toISOString(),
    backupRoot,
  };
  try {
    await restoreFiles({ target, sourceRoot: backupRoot, files, statusDir, backupMarker: marker });
  } catch (error) {
    log(`[error] 还原备份失败：${error && error.message ? error.message : error}`);
  }
  startLauncher(target, exe);
}

/* ---------------------------------------------------------------- */
/* 回滚                                                               */
/* ---------------------------------------------------------------- */

async function invokeRollback(target, meta) {
  const source = String(meta.source || '');
  const files = Array.isArray(meta.files) ? meta.files : [];
  const statusDir = String(meta.statusDir || '');
  if (!source || !fs.existsSync(source)) throw new Error(`备份目录不存在：${source}`);

  if (!(await waitForMainProcessExit(target))) {
    throw new Error('启动器还在运行，没能退出，回滚已放弃');
  }

  await restoreFiles({
    target,
    sourceRoot: source,
    files,
    statusDir,
    backupMarker: {
      action: 'rollback',
      returnedTo: String(meta.targetVersion || ''),
      revertedFrom: String(meta.fromVersion || ''),
      appliedAt: new Date().toISOString(),
      backupRoot: source,
    },
  });

  log('回滚完成，重新启动');
  startLauncher(target, relaunchExe(target, meta));
}

/* ---------------------------------------------------------------- */
/* 入口                                                               */
/* ---------------------------------------------------------------- */

async function main() {
  const metaPath = pickArg('--meta', '-MetaPath', '-meta');
  if (!metaPath) {
    console.error('用法：apply.js --meta <apply-meta.json 路径>');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(metaPath)) {
    console.error(`[error] 找不到 ${metaPath}`);
    process.exitCode = 1;
    return;
  }

  let meta = null;
  try {
    meta = readJson(metaPath);
  } catch (error) {
    console.error(`[error] 读取 apply-meta.json 失败：${error && error.message ? error.message : error}`);
    process.exitCode = 1;
    return;
  }

  const target = String(meta.target || '');
  if (!target || !fs.existsSync(target)) {
    console.error(`[error] 程序目录不存在：${target}`);
    process.exitCode = 1;
    return;
  }

  const statusDir = String(meta.statusDir || '') || path.join(target, 'data', 'tmp');
  try {
    fs.mkdirSync(statusDir, { recursive: true });
    LOG_PATH = path.join(statusDir, 'update-log.txt');
  } catch (error) {
    LOG_PATH = '';
    console.error(`[warn] 建日志目录失败：${error && error.message ? error.message : error}`);
  }

  const action = String(meta.action || '') || 'update';
  log(`覆盖脚本启动：action=${action}，${String(meta.fromVersion || '')} -> ${String(meta.targetVersion || '')}`);
  log(`程序目录：${target}`);

  // 握手标记：主进程退出前会等这个文件。
  // 等不到就不退出 —— 否则脚本没起来、窗口却没了，用户只看到启动器消失。
  const startedPath = path.join(statusDir, 'apply-started.json');
  if (
    !writeJson(startedPath, {
      action,
      startedAt: new Date().toISOString(),
      pid: process.pid,
      logPath: LOG_PATH,
    })
  ) {
    writeJson(path.join(statusDir, 'update-error.json'), {
      action,
      failedAt: new Date().toISOString(),
      message: `写不了握手文件 ${startedPath}`,
      target,
      logPath: LOG_PATH,
    });
    return;
  }

  try {
    if (action === 'rollback') await invokeRollback(target, meta);
    else await invokeUpdate(target, meta);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log(`[error] ${message}`);
    writeJson(path.join(statusDir, 'update-error.json'), {
      action,
      failedAt: new Date().toISOString(),
      message,
      target,
      logPath: LOG_PATH,
    });
    // 失败了也要把启动器拉回来，不能让用户对着空桌面发呆
    startLauncher(target, relaunchExe(target, meta));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`[error] ${message}`);
  process.exitCode = 1;
});
