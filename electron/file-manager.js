'use strict';

/*
 * 文件管理：把 userData 里「能安全清理」的东西分类统计出来，交给用户自己决定删什么。
 *
 * 三条硬规则：
 *  1) 只碰下面 GROUPS 里明确列出的目录/文件，绝不递归整盘、绝不触及游戏本体与存档；
 *  2) 自定义封面（custom-*）、随包内置封面、当前正在引用的封面一律不删；
 *  3) 删不掉的（被占用 / 无权限）只计数，不中断、不报错给用户看。
 *
 * 统计与清理都返回「字节 + 文件数」，前端据此画分类卡片。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

/* 单个目录最多扫这么多文件：正常情况远达不到，只是防极端情况下界面卡住 */
const WALK_LIMIT = 40000;

function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/** 递归累加一个文件或目录的体积与文件数。符号链接不跟随。 */
function measure(target) {
  const stat = statSafe(target);
  if (!stat) return { bytes: 0, files: 0 };
  if (stat.isFile()) return { bytes: stat.size, files: 1 };
  let bytes = 0;
  let files = 0;
  const stack = [target];
  while (stack.length && files < WALK_LIMIT) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          /* 被占用就算不进去 */
        }
      }
    }
  }
  return { bytes, files };
}

/** 顶层目录下的直接子项（文件或目录），跳过符号链接。 */
function children(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** 匹配一层通配（只支持 `*`），用于 Partitions/<id>/Cache 这种固定层数的路径。 */
function expandPattern(root, pattern) {
  let current = [root];
  for (const segment of pattern.split('/')) {
    const next = [];
    for (const base of current) {
      if (segment === '*') {
        next.push(...children(base));
      } else {
        const full = path.join(base, segment);
        if (statSafe(full)) next.push(full);
      }
    }
    current = next;
  }
  return current;
}

/*
 * 封面归类：只有「已经被同款游戏的新图替代」的官方残留才算可清理。
 * 用户自定义封面、随包内置封面、正在引用的封面都不会出现在结果里。
 */
function staleCoverFiles(userData, games, bundleCovers) {
  const coversDir = path.join(userData, 'covers');
  const keep = new Set();
  try {
    for (const name of fs.readdirSync(bundleCovers)) keep.add(name);
  } catch {
    /* 没有内置目录就只按引用判断 */
  }
  const referencedBy = new Map();
  for (const game of Array.isArray(games) ? games : []) {
    for (const ref of [game.cover, game.startCover]) {
      if (typeof ref !== 'string') continue;
      const match = /^covers\/([^/\\]+)$/.exec(ref);
      if (!match) continue;
      keep.add(match[1]);
      const keyMatch = /^official-([a-z0-9]+)/i.exec(match[1]);
      if (!keyMatch) continue;
      if (!referencedBy.has(keyMatch[1])) referencedBy.set(keyMatch[1], new Set());
      referencedBy.get(keyMatch[1]).add(match[1]);
    }
  }
  const stale = [];
  for (const name of fs.existsSync(coversDir) ? fs.readdirSync(coversDir) : []) {
    if (!/^official-.*\.(png|jpe?g|webp|gif|avif)$/i.test(name)) continue;
    if (keep.has(name)) continue;
    const keyMatch = /^official-([a-z0-9]+)/i.exec(name);
    if (!keyMatch) continue;
    const refs = referencedBy.get(keyMatch[1]);
    // 这个游戏当前一张被引用的图都没有 → 可能是用户自定义封面顶掉了官方图，别动
    if (!refs || !refs.size) continue;
    stale.push(path.join(coversDir, name));
  }
  return stale;
}

/*
 * 分组定义。collect 返回「这次要清掉的绝对路径列表」，
 * 统计和清理走同一份逻辑，数字才对得上。
 */
const GROUPS = [
  {
    id: 'webcache',
    label: '网页缓存',
    note: '界面用到的网页资源缓存。删掉后第一次切页会稍慢一点，会自动重建，不影响账号、设置和存档。',
    risk: 'safe',
    collect: (ctx) =>
      ['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUPersistentCache']
        .map((name) => path.join(ctx.userData, name))
        .filter((full) => statSafe(full)),
  },
  {
    id: 'partition',
    label: '账号分区缓存',
    note: '多账号隔离环境各自的网页缓存。只清缓存目录，登录态（Cookies、Local Storage）不动，不需要重新登录。',
    risk: 'safe',
    collect: (ctx) =>
      ['Partitions/*/Cache', 'Partitions/*/Code Cache', 'Partitions/*/GPUCache', 'Partitions/*/DawnCache', 'Partitions/*/GrShaderCache']
        .flatMap((pattern) => expandPattern(ctx.userData, pattern)),
  },
  {
    id: 'tmp',
    label: '临时文件',
    note: '解压、转码、更新中途留下的临时文件。正常退出后不会再被用到，可以放心清。',
    risk: 'safe',
    collect: (ctx) => children(path.join(ctx.userData, 'tmp')),
  },
  {
    id: 'backgrounds',
    label: '启动页动态背景',
    note: '从官网缓存的启动视频与背景图。删掉后启动页先用静态版本图顶着，下次打开对应游戏会重新下载；自己导入的背景图不受影响。',
    risk: 'caution',
    collect: (ctx) =>
      children(path.join(ctx.userData, 'backgrounds')).filter((full) => {
        const name = path.basename(full);
        if (/^custom-/i.test(name)) return false;
        const stat = statSafe(full);
        return Boolean(stat) && stat.isFile() && VIDEO_EXT.test(name);
      }),
  },
  {
    id: 'covers',
    label: '过期封面残留',
    note: '同一款游戏的官方版本图换过格式或换过去字版之后，旧的那几张会一直占地方。这里只删「已经有新图替代」的官方残留，你自己换的封面一张都不动。',
    risk: 'safe',
    collect: (ctx) => staleCoverFiles(ctx.userData, ctx.games, ctx.bundleCovers),
  },
  {
    id: 'sophon',
    label: '游戏下载缓存',
    note: '下载 / 更新游戏时的分块缓存。没有正在进行的下载就可以清；如果正在下载，清掉会让这一轮从头开始。',
    risk: 'caution',
    collect: (ctx) => children(path.join(ctx.userData, 'sophon-cache')),
  },
  {
    id: 'logs',
    label: '日志与崩溃记录',
    note: '启动日志、崩溃栈和更新日志。反馈问题时才用得上，平时清掉不影响任何功能。',
    risk: 'safe',
    collect: (ctx) =>
      children(ctx.userData).filter((full) => {
        const stat = statSafe(full);
        if (!stat || !stat.isFile()) return false;
        const name = path.basename(full).toLowerCase();
        if (name === 'launcher-data.json' || name === 'sessions.enc.json') return false;
        return name === 'crash.log' || name === 'launch.log' || name.endsWith('.log');
      }),
  },
];

const GROUP_INDEX = new Map(GROUPS.map((group) => [group.id, group]));

function contextOf(userData, games, bundleCovers) {
  return {
    userData,
    games: Array.isArray(games) ? games : [],
    // 由主进程传 app.getAppPath()/data/covers；缺省时只按引用判断，内置文件不会出现在清理列表里
    bundleCovers: bundleCovers || '',
  };
}

/** 统计：每个分组当前占用多少、文件多少个，外加整个数据目录的总量。 */
function describeStorage(userData, games, options = {}) {
  const ctx = contextOf(userData, games, options.bundleCovers);
  const groups = GROUPS.map((group) => {
    let bytes = 0;
    let files = 0;
    let items = 0;
    let targets = [];
    try {
      targets = group.collect(ctx);
    } catch {
      targets = [];
    }
    for (const target of targets) {
      const part = measure(target);
      bytes += part.bytes;
      files += part.files;
      items += 1;
    }
    return {
      id: group.id,
      label: group.label,
      note: group.note,
      risk: group.risk,
      bytes,
      files,
      items,
    };
  });
  const total = measure(userData);
  const safeGroups = groups.filter((group) => group.risk === 'safe');
  return {
    totalBytes: total.bytes,
    totalFiles: total.files,
    // cleanable 含「清理前要确认」的两类（背景视频 / 下载缓存），
    // safe 才是「一键清理安全项」真正会释放的量。
    cleanableBytes: groups.reduce((sum, group) => sum + group.bytes, 0),
    cleanableFiles: groups.reduce((sum, group) => sum + group.files, 0),
    safeBytes: safeGroups.reduce((sum, group) => sum + group.bytes, 0),
    safeFiles: safeGroups.reduce((sum, group) => sum + group.files, 0),
    groups,
  };
}

/** 清理一个分组，返回真正释放的字节数（被占用删不掉的会如实扣掉）。 */
async function cleanGroup(userData, games, id, options = {}) {
  const group = GROUP_INDEX.get(id);
  if (!group) return { id, ok: false, error: '未知的分类', freed: 0, removed: 0, failed: 0 };
  const ctx = contextOf(userData, games, options.bundleCovers);
  let targets = [];
  try {
    targets = group.collect(ctx);
  } catch (error) {
    return { id, ok: false, error: error.message, freed: 0, removed: 0, failed: 0 };
  }
  let freed = 0;
  let removed = 0;
  let failed = 0;
  for (const target of targets) {
    const before = measure(target);
    try {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
      const after = measure(target);
      freed += Math.max(0, before.bytes - after.bytes);
      removed += 1;
    } catch {
      // 正在被占用的文件（Chromium 自己的缓存、正在播的视频）删不掉属正常
      const after = measure(target);
      freed += Math.max(0, before.bytes - after.bytes);
      failed += 1;
    }
  }
  return { id, ok: true, freed, removed, failed };
}

/** 清理全部安全项（跳过标了 caution 的，避免把正在进行的下载弄坏）。 */
async function cleanSafe(userData, games, options = {}) {
  const results = [];
  for (const group of GROUPS) {
    if (group.risk !== 'safe') continue;
    results.push(await cleanGroup(userData, games, group.id, options));
  }
  return {
    ok: true,
    freed: results.reduce((sum, item) => sum + (item.freed || 0), 0),
    removed: results.reduce((sum, item) => sum + (item.removed || 0), 0),
    failed: results.reduce((sum, item) => sum + (item.failed || 0), 0),
    results,
  };
}

module.exports = { describeStorage, cleanGroup, cleanSafe, GROUPS };
