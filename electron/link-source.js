'use strict';

/*
 * 跨客户端硬链接复用。
 *
 * 场景：同一台机器上装了两份同一款游戏（官服 + 国际服、官服 + B服），
 * 其中一份已经更新到目标版本，另一份要更新。两份客户端的资源包有大量文件
 * 内容完全一样（官方同一个构建产物），没必要再下一遍 —— 直接把已经存在
 * 的那份硬链接过来，秒完成、不占额外空间。
 *
 * 这里只负责「找候选路径 + 建链接」，命中判定交给调用方：
 * sophon 与预下载各自有分块清单，校验口径必须和它们「本地文件算不算已就位」
 * 的判定完全一致，不能另起一套，否则会出现「这里说命中、那边又重新下」。
 */

const path = require('path');
const fs = require('fs');

/*
 * 数据目录名的国服 / 国际服差异。原神是唯一需要交叉的：
 * 国服 YuanShen_Data，国际服 GenshinImpact_Data（连 exe 名也不同）。
 * 星铁 / 绝区零 两边同名，不需要映射。
 */
const DATA_DIR_ALIASES = {
  genshin: [['YuanShen_Data', 'GenshinImpact_Data']],
};

/** 路径归一化：比较用，Windows 不区分大小写，顺带吃掉尾部斜杠。 */
function norm(value) {
  return String(path.resolve(String(value || '')).replace(/[\\/]+$/, '')).toLowerCase();
}

/** 所在磁盘卷。硬链接的硬限制：两个路径必须同一卷。 */
function driveOf(value) {
  try {
    return path.parse(path.resolve(String(value || ''))).root.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 一个清单里的相对路径，在某客户端根目录下对应的所有候选绝对路径。
 * 顺序：先同相对路径，再数据目录交叉命名的等价路径。
 */
function candidatesUnder(root, relative, gameKey) {
  const rel = String(relative || '').replace(/\\/g, '/');
  if (!rel) return [];
  const join = (value) => path.join(root, ...value.split('/'));
  const out = [join(rel)];
  for (const [a, b] of DATA_DIR_ALIASES[gameKey] || []) {
    if (rel === a) out.push(join(b));
    else if (rel.startsWith(`${a}/`)) out.push(join(`${b}${rel.slice(a.length)}`));
    else if (rel === b) out.push(join(a));
    else if (rel.startsWith(`${b}/`)) out.push(join(`${a}${rel.slice(b.length)}`));
  }
  return out;
}

/**
 * 挑出真正能当源的客户端目录。
 *
 * 跨卷的直接丢掉：跨卷既不能硬链接，退化成复制又要读一遍 + 写一遍（双份 IO），
 * 还不如老老实实按分块下载 —— 那份 IO 开销只会让更新更慢。
 */
function usableSources(sources, { targetRoot, excludeRoots = [] } = {}) {
  const targetDrive = driveOf(targetRoot);
  const blocked = new Set([norm(targetRoot), ...excludeRoots.map((item) => norm(item))]);
  const seen = new Set();
  const out = [];
  for (const raw of sources || []) {
    if (!raw) continue;
    const root = path.resolve(String(raw));
    const key = norm(root);
    if (!key || key === norm('')) continue;
    if (blocked.has(key) || seen.has(key)) continue;
    // 只有两边都在同一卷上才可能建硬链接
    if (!targetDrive || driveOf(root) !== targetDrive) continue;
    let stat;
    try {
      stat = fs.statSync(root);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/**
 * 尝试从别的客户端目录复用同一个文件。
 *
 * match(candidatePath) 由调用方给（sophon 是 quickFileMatches，预下载是它自己那份），
 * 命中就 unlink 目标再 link 源。unlink 不会影响源：目标之前可能是别的硬链接，
 * 断开的是那一条路径，源文件的数据仍然完好。
 */
async function reuseFromSources({ file, target, gameKey, sources, match }) {
  if (!file || !target || !Array.isArray(sources) || !sources.length) return { ok: false };
  /*
   * 清单项里的相对路径字段各游戏叫法不同：米哈游叫 file，终末地叫 path。
   * 这里兜一下，免得调用方少写一层映射就静默失效（表现为「明明有源还是全量下载」，
   * 而且不报错，极难查）。
   */
  const relative = String(file.file || file.path || '');
  if (!relative) return { ok: false };
  const targetKey = norm(target);
  for (const root of sources) {
    for (const candidate of candidatesUnder(root, relative, gameKey)) {
      if (norm(candidate) === targetKey) continue;
      let hit = false;
      try {
        hit = Boolean(await match(candidate));
      } catch {
        hit = false;
      }
      if (!hit) continue;
      try {
        await fs.promises.unlink(target).catch(() => {});
        await fs.promises.link(candidate, target);
        return { ok: true, source: candidate, linked: true };
      } catch {
        /*
         * 理论上同卷不会失败；权限受限、目标被游戏占用时退回复制，
         * 至少保证内容正确（不会因为复用失败让整个更新中止）。
         */
        try {
          await fs.promises.copyFile(candidate, target);
          return { ok: true, source: candidate, linked: false };
        } catch {
          /* 换下一个候选 */
        }
      }
    }
  }
  return { ok: false };
}

module.exports = {
  candidatesUnder,
  usableSources,
  reuseFromSources,
  driveOf,
  DATA_DIR_ALIASES,
};
