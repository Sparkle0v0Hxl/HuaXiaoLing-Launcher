'use strict';

/**
 * 硬链接安全守卫（2026-11-26）。
 *
 * 背景：游戏运行中做「硬链接生成」「修复」「切换渠道」会改到目标目录里的文件。
 * 如果游戏/官方启动器正持有句柄，轻则 EPERM/EBUSY 中断任务，重则覆盖到一半、
 * 运行时变成半新半旧。这里把四件事集中起来：
 *
 *   1. 进程探活：按可执行文件路径前缀找出真正在跑的游戏进程；
 *   2. 启动占位：调用方在 spawn 之后立即占位，生成任务据此避让（见 main.js 的 launching）；
 *   3. EPERM 中文提示：把 Node 的「操作不支持 / EPERM」翻译成可操作的话；
 *   4. rename 前占用探测：写入前先试开目标文件，被占用就跳过/报错，绝不硬写。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { powershellExe } = require('./ps-path');

function norm(p) {
  return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** 按可执行文件路径前缀查进程；返回 [{pid,name,exe}]。查询失败返回 []。 */
function listProcessesFromRoot(root) {
  const dir = norm(root);
  if (!dir) return [];
  const script = `$root=${psQuote(dir)};
$list=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -and ($_.ExecutablePath.ToLower().StartsWith($root))
} | Select-Object ProcessId,Name,ExecutablePath);
$list | ConvertTo-Json -Compress`;
  try {
    const out = execFileSync(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }
    ).trim();
    if (!out) return [];
    const data = JSON.parse(out);
    return (Array.isArray(data) ? data : [data]).filter(Boolean).map((x) => ({
      pid: Number(x.ProcessId) || 0,
      name: String(x.Name || ''),
      exe: String(x.ExecutablePath || ''),
    }));
  } catch {
    return [];
  }
}

/** 兜底：拿根目录第一层的 exe 名字，用 tasklist 查同名进程。 */
function listProcessesByNames(root) {
  const dir = String(root || '');
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.exe$/i.test(e.name))
      .map((e) => e.name.replace(/\.exe$/i, ''));
  } catch {
    return [];
  }
  if (!names.length) return [];
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    const hit = [];
    for (const line of out.split(/\r?\n/)) {
      const cols = line.split('","').map((x) => x.replace(/^"|"$/g, ''));
      const image = (cols[0] || '').replace(/\.exe$/i, '');
      if (!image) continue;
      if (names.some((n) => n.toLowerCase() === image.toLowerCase())) {
        hit.push({ pid: Number(cols[1]) || 0, name: image + '.exe', exe: '' });
      }
    }
    return hit;
  } catch {
    return [];
  }
}

/** 找出从这些目录启动的进程（合并两种探测），按 pid 去重。 */
function findRunningProcesses(roots) {
  const dirs = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  const map = new Map();
  for (const dir of dirs) {
    for (const p of listProcessesFromRoot(dir)) map.set(p.pid, p);
    for (const p of listProcessesByNames(dir)) if (!map.has(p.pid)) map.set(p.pid, p);
  }
  return [...map.values()];
}

/**
 * 生成/修复/切服前的强校验：有任何进程从这些目录启动就拒绝。
 * @param {string|string[]} roots
 * @param {string} [action] 动作名，用于文案
 */
function assertNoGameRunning(roots, action = '生成硬链接') {
  const procs = findRunningProcesses(roots);
  if (!procs.length) return true;
  const names = [...new Set(procs.map((p) => p.name || ('PID ' + p.pid)))].join('、');
  throw new Error(
    `检测到游戏或官方启动器正在运行（${names}）。为避免硬链接写入时被占用、把运行时改坏，` +
      `请先完全退出游戏和官方启动器，再${action}。`
  );
}

/**
 * rename / 覆盖前的占用探测。
 *
 * Windows 上「文件被占用」最可靠的探测是拿一次写句柄：打开失败（EPERM/EBUSY/EACCES）
 * 就是被独占。只读打开挡不住共享读，所以这里用 'r+'。不存在返回 false。
 * @param {string} file
 * @returns {boolean}
 */
function isFileLocked(file) {
  try {
    const fd = fs.openSync(file, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    return true;
  }
}

/** 把文件系统错误翻译成用户能照着操作的中文。 */
function humanizeFsError(error, what) {
  const code = String((error && error.code) || '');
  const raw = String((error && error.message) || error || '');
  if (/EPERM|EACCES|EBUSY/.test(code) || /EPERM|EACCES|EBUSY|占用|permission denied/i.test(raw)) {
    return (
      `${what}：目标文件被其它进程占用或权限不足。` +
      '请先完全退出游戏与官方启动器；若仍失败，请以管理员身份运行启动器后重试。'
    );
  }
  if (code === 'ENOSPC') {
    return `${what}：磁盘空间不足。请清理该盘空间后重试。`;
  }
  return `${what}：${raw || code || '未知错误'}`;
}

module.exports = {
  findRunningProcesses,
  assertNoGameRunning,
  isFileLocked,
  humanizeFsError,
};
