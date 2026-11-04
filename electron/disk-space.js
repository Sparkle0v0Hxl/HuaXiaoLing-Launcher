'use strict';

/*
 * 写盘前的磁盘空间守卫。
 *
 * 背景：更新游戏与「应用预下载」原来只有 ENOSPC 之后的兜底文案。问题在于
 * ENOSPC 是「写到一半才炸」——那时已经下了几十 GB、几百个文件写了一半，
 * 用户看到的是「失败」，还要自己猜是空间不够。更糟的是有的盘在几乎写满时
 * 写入速度会掉到几 MB/s，看起来像卡死，实际是在硬撑。
 *
 * 这里不追求「开跑前百分之百算准要多少」（更新是就地覆盖，真实增量要逐个
 * 文件比对清单才知道），而是做两件事：
 *   1. 开跑前给一次粗筛：连清单全量都装不下就直接拒绝，别让人白等；
 *   2. 跑的过程中按节流周期复查：剩余空间逼近「还要写的量 + 安全余量」时立刻
 *      停下并说清还差多少，已下好的分块保留，清完空间能接着下。
 *
 * 读不到 statfs 时一律放行：宁可最后靠 ENOSPC 兜底，也不能因为查询失败
 * 把正常更新拦住。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

/** 目标路径所在卷的剩余字节；读不到返回 0（表示「未知」，不是「没有空间」）。 */
async function freeBytes(dir) {
  try {
    const root = path.parse(path.resolve(String(dir || '.'))).root;
    if (!root) return 0;
    const stats = await fsp.statfs(root);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) && free > 0 ? free : 0;
  } catch {
    return 0;
  }
}

function gb(bytes) {
  return `${(Number(bytes) / 1024 ** 3).toFixed(1)} GB`;
}

function mb(bytes) {
  return `${(Number(bytes) / 1024 ** 2).toFixed(0)} MB`;
}

/** 人类可读的体积，按量级选单位，避免「0.0 GB」这种看不出差别的显示。 */
function human(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return gb(value);
  if (value >= 1024 ** 2) return mb(value);
  return `${Math.max(0, Math.round(value / 1024))} KB`;
}

/** 不足时抛错的错误对象：带上结构化字段，界面可以按需取用。 */
function spaceError({ dir, free, need, label }) {
  const error = new Error(
    `${label || '目标盘'}空间不足：该盘只剩 ${human(free)}，本次还需要约 ${human(need)}。` +
      '清理出足够空间后再试即可，已经下好的分块和文件会保留，不会从头重下。'
  );
  error.code = 'ENOUGH_SPACE';
  error.diskFree = free;
  error.diskNeed = need;
  error.diskDir = dir;
  return error;
}

/**
 * 开跑前的一次性粗筛。
 *
 * needBytes 传「这次最多会写多少」的上界：全新安装是清单全量，更新是清单全量
 * 与已就位字节之差（算不准就传全量，宁可提前拒绝，也不要跑到 90% 才炸）。
 */
async function assertRoom({ dir, needBytes, label, reserveBytes = 512 * 1024 ** 2 }) {
  const need = Number(needBytes) || 0;
  if (need <= 0) return { ok: true, free: 0, need: 0 };
  const free = await freeBytes(dir);
  // free === 0 表示查询失败或该卷信息不可用，不能据此拒绝用户
  if (!free) return { ok: true, free: 0, need };
  if (free < need + reserveBytes) throw spaceError({ dir, free, need: need + reserveBytes, label });
  return { ok: true, free, need };
}

/**
 * 运行中的节流复查器。
 *
 * 每个文件都查一次 statfs 会让系统调用挤进关键路径（两万多个文件就是两万多次），
 * 所以按时间节流：默认 1.5 秒内复用上一次结果。检查失败（读不到）继续放行。
 *
 * 用法：
 *   const guard = createSpaceGuard({ dirs: [installRoot, cacheDir], label: '游戏所在盘' });
 *   ...
 *   await guard.check(fileBytes * 2);
 */
function createSpaceGuard({ dirs = [], label = '目标盘', reserveBytes = 1024 ** 3, minIntervalMs = 1500 } = {}) {
  const roots = [...new Set((dirs || []).filter(Boolean).map((item) => path.parse(path.resolve(item)).root))];
  let lastAt = 0;
  let last = null;
  let inflight = null;

  const measure = async () => {
    const out = [];
    for (const root of roots) {
      out.push({ root, free: await freeBytes(root) });
    }
    lastAt = Date.now();
    last = out;
    return out;
  };

  return {
    /**
     * @param {number} needBytes 接下来还要写的量（调用方可传「本文件大小 × 2」这类保守值）
     */
    async check(needBytes = 0) {
      if (!roots.length) return { ok: true };
      const now = Date.now();
      let snapshot = last;
      if (!snapshot || now - lastAt >= minIntervalMs) {
        if (!inflight) {
          inflight = measure().finally(() => {
            inflight = null;
          });
        }
        snapshot = await inflight;
      }
      const need = Number(needBytes) || 0;
      for (const item of snapshot) {
        if (!item.free) continue;
        // reserveBytes 是留给日志、索引、系统还原点等杂项的余量
        if (item.free < need + reserveBytes) {
          throw spaceError({ dir: item.root, free: item.free, need: need + reserveBytes, label });
        }
      }
      return { ok: true };
    },
  };
}

module.exports = {
  freeBytes,
  assertRoom,
  createSpaceGuard,
  human,
};
