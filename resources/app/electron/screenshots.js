'use strict';

/**
 * 截图管理：扫描各游戏截图目录，按游戏归档、按时间排序。
 *
 * 目录来源有两种：内置默认位置 + 用户在设置里手动补充的路径。
 * 全部是只读扫描，绝不移动或删除用户文件。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

/**
 * 中文 UI 的 Windows 把「图片」夹重定向到「我的图片」，
 * 直接拼 'Pictures' 在部分机器上仍能读到，但用已知文件夹 API 更稳。
 * 这里只做一次惰性探测，失败就退回 %USERPROFILE%\Pictures。
 */
let cachedPictures = null;
function picturesDir() {
  if (cachedPictures) return cachedPictures;
  let dir = '';
  try {
    // Electron 的 shell 在纯 node 下不存在，所以用注册表读已知文件夹
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'My Pictures'],
      { encoding: 'buffer', windowsHide: true, timeout: 5000 }
    );
    const text = out.toString('utf16le') + out.toString('latin1');
    const match = text.match(/([A-Za-z]:\\[^\r\n]*?(?:Pictures|图片|圖片))(?=\s|$)/i);
    if (match) dir = match[1].replace(/%USERPROFILE%/gi, os.homedir());
  } catch {}
  cachedPictures = dir || path.join(os.homedir(), 'Pictures');
  return cachedPictures;
}

/**
 * 常见截图目录。
 * 米哈游三件套都放在 <游戏目录>\ScreenShot\，但游戏目录可能在任何盘，
 * 所以这里只放「用户级」的固定位置，其余靠 discoverRoots 扫描。
 */
function defaultRoots() {
  const home = os.homedir();
  const pictures = picturesDir();
  return [
    path.join(pictures, 'Genshin Impact'),
    path.join(pictures, 'HoYoPlay'),
    path.join(pictures, 'Star Rail'),
    path.join(pictures, 'ZenlessZoneZero'),
    path.join(pictures, '崩坏3'),
    path.join(pictures, 'Endfield'),
    path.join(home, 'Videos', 'Genshin Impact'),
    path.join(home, 'Videos', 'StarRail'),
    path.join(home, 'Videos', 'ZZZ'),
    path.join(pictures, 'Screenshots'),
  ];
}

/** 在给定目录里找截图，最多下探 depth 层。 */
async function scanDir(dir, gameKey, depth = 2, acc = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !entry.name.startsWith('.')) {
        // 子目录名也可能给出游戏线索（例如 ScreenShot\Genshin Impact）
        const guessed = guessGameFromPath(full) || gameKey;
        await scanDir(full, guessed, depth - 1, acc);
      }
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    acc.push({
      path: full,
      name: entry.name,
      size: stat.size,
      time: stat.mtimeMs,
      // 先用目录名判定，判不出来再让上层按文件名/时间兜底
      game: guessGameFromPath(full) || gameKey,
    });
  }
  return acc;
}

/**
 * 从路径里猜游戏。
 * 米哈游的截图会落在 <游戏>\ScreenShot\ 或 Pictures\<英文名>，
 * 文件名本身有时带前缀（GenshinImpact_2024...）。
 */
const PATH_HINTS = [
  [/(genshin|原神|yuanshen)/i, 'genshin'],
  [/(star[\s_-]?rail|starrail|星穹铁道|xingqiongtiedao)/i, 'starrail'],
  [/(zenless|zzz|绝区零|juequling)/i, 'zzz'],
  [/(honkai[\s_-]?impact|bh3|崩坏3|benghuai3)/i, 'bh3'],
  [/(endfield|终末地|zhongmodidi)/i, 'endfield'],
  [/(neverness|异环|yihuan|\bnte\b)/i, 'neverness'],
  [/(arknights|明日方舟)/i, 'arknights'],
];

function guessGameFromPath(full) {
  const text = String(full || '');
  for (const [re, key] of PATH_HINTS) {
    if (re.test(text)) return key;
  }
  return '';
}

/**
 * 按修改时间归档：截图目录常常用「ScreenShot_2026xxxx_123456.png」这类命名，
 * 但真正能判断归属的是文件时间（游戏内 F12 截图和游戏启动时间几乎一致）。
 * 这里只在路径判断失败时兜底，避免把用户桌面截图错归到某个游戏。
 */
function guessGameByTime(time, sessionWindows = []) {
  const ts = Number(time) || 0;
  if (!ts || !sessionWindows.length) return '';
  for (const win of sessionWindows) {
    if (ts >= win.start && ts <= win.end + 5 * 60 * 1000) return win.game;
  }
  return '';
}

/**
 * 扫描所有配置的目录。
 * @param {object} options
 * @param {Record<string,string[]>} options.customRoots 每个游戏的自定义目录
 */
async function listScreenshots(options = {}) {
  const { customRoots = {} } = options;
  const sessionWindows = Array.isArray(options.sessionWindows) ? options.sessionWindows : [];
  const targets = new Map();

  if (Object.keys(customRoots).length) {
    for (const [gameKey, dirs] of Object.entries(customRoots)) {
      targets.set(gameKey, (dirs || []).filter(Boolean));
    }
  } else {
    // 没配置时用默认位置，按目录名猜游戏
    for (const dir of defaultRoots()) {
      const gameKey = guessGameFromPath(dir) || 'other';
      if (!targets.has(gameKey)) targets.set(gameKey, []);
      targets.get(gameKey).push(dir);
    }
  }

  // 先扫出全部候选，再按「路径 → 时间窗 → 所在目录」三级回填游戏归属，
  // 这样同一个目录里混放的截图也能分开。
  const collected = [];
  for (const [gameKey, dirs] of targets) {
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const found = [];
      await scanDir(dir, '', 3, found);
      for (const item of found) {
        const byPath = guessGameFromPath(item.path);
        item.game = byPath || guessGameByTime(item.time, sessionWindows) || (gameKey !== 'other' ? gameKey : 'other');
        collected.push(item);
      }
    }
  }

  // 理论上同一个根目录可能被两个键指向（比如设置里配了别名），按路径去重
  const seen = new Set();
  const unique = [];
  for (const item of collected) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    unique.push(item);
  }

  const groups = {};
  for (const item of unique) {
    if (!groups[item.game]) groups[item.game] = [];
    groups[item.game].push(item);
  }
  for (const list of Object.values(groups)) list.sort((a, b) => b.time - a.time);
  return { total: unique.length, groups };
}

/**
 * 从游玩会话里算出「每个游戏的运行时间段」，供按时间归档兜底用。
 * @param {Array<{gameId?:string,game?:string,start?:number,end?:number}>} sessions
 * @param {(id:string)=>string} resolveKey gameId → 图鉴里的游戏 key
 */
function sessionWindowsFrom(sessions = [], resolveKey = (x) => x) {
  const windows = [];
  for (const item of sessions) {
    const start = Number(item.start || item.startedAt || 0);
    const end = Number(item.end || item.endedAt || 0);
    if (!start) continue;
    const game = resolveKey(String(item.gameId || item.game || ''));
    if (!game) continue;
    windows.push({ game, start, end: end || Date.now() });
  }
  return windows;
}

/** 校验目录是否可读，供设置页「添加目录」时即时反馈。 */
async function checkDir(dir) {
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return { ok: false, reason: '不是文件夹' };
    const entries = await fsp.readdir(dir);
    return { ok: true, count: entries.length };
  } catch (error) {
    return { ok: false, reason: String(error.message || '无法读取') };
  }
}

module.exports = { defaultRoots, listScreenshots, checkDir, sessionWindowsFrom, guessGameFromPath };
