'use strict';

const fs = require('node:fs');
const path = require('node:path');

/*
 * 官方鹰角（Hypergryph）启动器的安装位置探测。
 *
 * 终末地的「官方托管启动」需要找到用户机器上那份真的官方启动器（Games.exe），
 * 由它自己拉起游戏。这个模块只负责「它在哪」这一件事，不做任何进程创建。
 *
 * 三层来源：环境变量猜常见目录 → 注册表（官方自己记的 install_path / 卸载项
 * InstallLocation）→ 盘符扫描兜底。后两层按进程缓存，用户重装后可调
 * clearOfficialLauncherCache() 强制重扫。
 */

/**
 * 跑一次 reg.exe 查询，拿不到就返回空串。
 * 用 execFileSync 而不是 exec，避免 shell 引号问题；超时给 2500ms，
 * 注册表查询本在毫秒级，超时说明环境异常，直接放弃不影响启动。
 */
function regQuery(args, timeout) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('reg.exe', args, {
      timeout: timeout || 2500,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out || '');
  } catch {
    return '';
  }
}

/** 从 reg query 输出里抽取指定值名、且确实存在的目录路径。 */
function pathsFromRegOutput(output, valueNames) {
  const found = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (valueNames && !valueNames.includes(m[1])) continue;
    const value = m[2].replace(/^"|"$/g, '').trim();
    if (!value || !path.isAbsolute(value)) continue;
    try {
      if (!fs.statSync(value).isDirectory()) continue;
    } catch {
      continue;
    }
    found.push(value);
  }
  return found;
}

/** 注册表里官方启动器自己记的安装路径（最权威）。 */
function registryLauncherDirs() {
  const dirs = [];
  // HKCU\SOFTWARE\Hypergryph\Launcher\<hash> 下有一个值叫 install_path
  const installPathOut = regQuery(['query', 'HKCU\\SOFTWARE\\Hypergryph\\Launcher', '/s', '/v', 'install_path']);
  dirs.push(...pathsFromRegOutput(installPathOut, ['install_path']));
  // 卸载项里的 InstallLocation（官方安装包写的那一份）
  for (const root of [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    const output = regQuery(['query', root, '/s', '/f', 'Hypergryph', '/d']);
    if (!output) continue;
    dirs.push(...pathsFromRegOutput(output, ['InstallLocation']));
  }
  return dirs;
}

/** 常见盘符 + 常见相对路径兜底：官方启动器也可能装在注册表没记录的位置。 */
function scannedLauncherDirs() {
  const dirs = [];
  const relatives = [
    ['Hypergryph Launcher'],
    ['Hypergryph', 'Launcher'],
    ['Program Files', 'Hypergryph Launcher'],
    ['Program Files (x86)', 'Hypergryph Launcher'],
    ['Games', 'Hypergryph Launcher'],
    ['Launchers', 'Hypergryph Launcher'],
  ];
  for (const letter of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) {
    const root = letter + ':\\';
    try {
      if (!fs.statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const parts of relatives) {
      const candidate = path.join(root, ...parts);
      try {
        if (fs.statSync(candidate).isDirectory() && !dirs.includes(candidate)) dirs.push(candidate);
      } catch {
        /* 不存在就算了 */
      }
    }
  }
  return dirs;
}

let cachedOfficialDirs = null;

/**
 * 官方鹰角启动器的候选安装目录。
 * 顺序 = 环境变量 → 注册表 → 盘符扫描；后两者按进程缓存。
 * 注册表记的是安装根目录，Games.exe 通常在其版本子目录（如 1.6.0/）下，
 * 所以这里把根目录原样加进去即可，由调用方自己往下找。
 */
function officialLauncherDirs() {
  const dirs = [];
  for (const base of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
    process.env.LOCALAPPDATA,
  ]) {
    if (!base) continue;
    dirs.push(path.join(base, 'Hypergryph Launcher'));
    dirs.push(path.join(base, 'Hypergryph'));
  }
  if (!cachedOfficialDirs) {
    const discovered = [];
    for (const extra of [...registryLauncherDirs(), ...scannedLauncherDirs()]) {
      if (!discovered.includes(extra)) discovered.push(extra);
    }
    cachedOfficialDirs = discovered;
  }
  for (const extra of cachedOfficialDirs) {
    if (!dirs.includes(extra)) dirs.push(extra);
  }
  return dirs;
}

/** 供上层在用户重装官方启动器后强制重扫。 */
function clearOfficialLauncherCache() {
  cachedOfficialDirs = null;
}

/**
 * 判断一个 exe 的清单是否要求以管理员身份运行。
 * 官方鹰角启动器的 Games.exe 就是 requireAdministrator，启动它之前需要先确认权限。
 * 按 path + size + mtime 缓存，避免重复扫大文件。
 */
const adminCache = new Map();
function peNeedsAdmin(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  const key = file + '|' + stat.size + '|' + stat.mtimeMs;
  if (adminCache.has(key)) return adminCache.get(key);
  let needs = false;
  try {
    // 清单在 PE 资源段里，位置不固定，只能整体扫；限制上限避免极端大文件卡住
    if (stat.size <= 64 * 1024 * 1024) {
      const buf = fs.readFileSync(file);
      needs = buf.includes('requireAdministrator');
    }
  } catch {
    needs = false;
  }
  adminCache.set(key, needs);
  return needs;
}

module.exports = { officialLauncherDirs, clearOfficialLauncherCache, peNeedsAdmin };
