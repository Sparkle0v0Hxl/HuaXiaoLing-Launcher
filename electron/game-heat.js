'use strict';

/**
 * 各游戏「热更层」的更新后善后。
 *
 * ── 为什么按游戏分开处理，而不是一刀切 ──────────────────────────────
 *
 * 每款游戏的「基础包 / 热更层」关系不一样，乱动会把用户几十 GB 的语音包弄没。
 * 本机实测（2026-11-25）：
 *
 *   ┌────────┬──────────────────────────────────────┬────────────────┐
 *   │ 游戏   │ Persistent 里的东西                  │ 会不会错配     │
 *   ├────────┼──────────────────────────────────────┼────────────────┤
 *   │ 终末地 │ index_main/pref_main/*.json + VFS/*.blc│ **会**（IFix） │
 *   │ 原神   │ res_versions_persist + AssetBundles  │ 不会（自愈）   │
 *   │ 星铁   │ InstallVersion.bin + IFix/(空)       │ 不会           │
 *   │ 绝区零 │ res_version_persist + Blocks         │ 不会（自愈）   │
 *   └────────┴──────────────────────────────────────┴────────────────┘
 *
 * 米哈游三款（原神 / 星铁 / 绝区零）的 Persistent 里有自己的
 * `*_versions_persist` / `*_revision`，游戏启动时会对版本，对不上自己重下增量。
 * 启动器去清它们的 Persistent，等于让用户白白重下 12 GB 语音包 —— 绝不能做。
 *
 * 只有终末地的 IFix 补丁**没有自愈**：基础包换新版后，它会拿新程序集去套旧补丁，
 * 抛 `can not load field [handleCache]`，然后界面报「获取资源失败，请检查网络状态重试」
 * （这句话是误导文案，跟网络无关）。这才是必须由启动器插手的地方。
 *
 * ── 将来要扩到别的游戏怎么办 ────────────────────────────────────────
 *
 * 在 HEAT_PROFILES 里加一条就行：给 `files`（要归档的文件/目录名）和
 * `archive`（是否归档）。没有配置的游戏默认「什么都不做」，安全。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/* ── 每款游戏的热更层描述 ─────────────────────────────────────────── */
const HEAT_PROFILES = {
  /*
   * 终末地：IFix 热更清单 + 补丁块。必须归档重建。
   * 目录结构：<root>\Endfield_Data\Persistent\{index_main.json, VFS\}
   */
  endfield: {
    dataDir: 'Endfield_Data',
    persistDir: 'Persistent',
    files: ['index_main.json', 'pref_main.json', 'index_initial.json', 'pref_initial.json'],
    dirs: ['VFS'],
    archive: true,
    reason: 'IFix 热更清单/补丁与基础包错版后不会自愈，会报「获取资源失败」',
  },

  /*
   * 米哈游三款：有内建版本自愈，**不动**。
   * 这里显式列出来是为了让后来的人知道「查过了，故意不处理」，
   * 而不是漏了。
   */
  genshin: { archive: false, reason: '米哈游自维护 res_versions_persist，会自愈；动它会重下语音包' },
  starrail: { archive: false, reason: '版本靠 InstallVersion.bin 自维护；IFix 目录为空' },
  zzz: { archive: false, reason: '米哈游自维护 res_version_persist，会自愈' },
  bh3: { archive: false, reason: '同米哈游体系，自维护版本' },
  wutheringwaves: { archive: false, reason: '库洛自己维护 bundle 清单' },
};

/** 归档后缀，一眼能看出是启动器处理的、哪个时间点。 */
const ARCHIVE_PREFIX = '.hxl-heat-';

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 目录/文件有多大（用于日志）。 */
function sizeOf(target) {
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return st.size;
    let sum = 0;
    for (const e of fs.readdirSync(target, { withFileTypes: true })) {
      sum += sizeOf(path.join(target, e.name));
    }
    return sum;
  } catch {
    return 0;
  }
}

/** 取某路径的写入时间；目录取其中最新文件的时间。 */
function mtimeOf(target) {
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return st.mtimeMs;
    let newest = 0;
    for (const e of fs.readdirSync(target, { withFileTypes: true })) {
      const t = mtimeOf(path.join(target, e.name));
      if (t > newest) newest = t;
    }
    return newest || st.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 检查某游戏的热更层是否「比基础包旧」。
 *
 * @param {string} gameKey 游戏标识（endfield / genshin / ...）
 * @param {string} root    客户端根目录
 * @returns {{applicable:boolean, stale:boolean, reason:string, targets:Array, baseMtime:number, heatMtime:number}}
 */
function inspectGameHeatLayer(gameKey, root) {
  const prof = HEAT_PROFILES[gameKey];
  const out = { applicable: false, stale: false, reason: '', targets: [], baseMtime: 0, heatMtime: 0 };
  if (!prof || !prof.archive || !root) return out;

  const dataDir = path.join(root, prof.dataDir);
  const persist = path.join(dataDir, prof.persistDir);
  if (!fs.existsSync(persist)) return { ...out, applicable: true, reason: '没有 Persistent 目录' };

  const targets = [];
  for (const f of prof.files || []) {
    const p = path.join(persist, f);
    if (fs.existsSync(p) && !fs.existsSync(p + ARCHIVE_PREFIX + '*')) targets.push({ name: f, path: p, dir: false });
  }
  for (const d of prof.dirs || []) {
    const p = path.join(persist, d);
    if (fs.existsSync(p)) targets.push({ name: d, path: p, dir: true });
  }
  if (!targets.length) return { ...out, applicable: true, reason: '热更层是空的，无需处理' };

  /* 已经归档过的（名字里带 .hxl-heat-）不算在 targets 里 */
  const live = targets.filter((t) => !t.name.includes(ARCHIVE_PREFIX));
  if (!live.length) return { ...out, applicable: true, reason: '热更层已归档过' };

  /* 基础包时间：优先用基础包清单，退而用 StreamingAssets 目录 */
  const streaming = path.join(dataDir, 'StreamingAssets');
  for (const cand of ['index_main.json', 'data.unity3d', 'resources.resource']) {
    const p = path.join(streaming, cand);
    if (fs.existsSync(p)) {
      out.baseMtime = mtimeOf(p);
      break;
    }
  }
  if (!out.baseMtime) out.baseMtime = mtimeOf(streaming);

  /* 热更层时间：取最旧的那个（保守，避免部分文件新就判成不旧） */
  let oldest = Infinity;
  for (const t of live) {
    const m = mtimeOf(t.path);
    if (m && m < oldest) oldest = m;
  }
  out.heatMtime = Number.isFinite(oldest) ? oldest : 0;

  /* 判据：热更层明显早于基础包（留 10 分钟余量） */
  if (out.baseMtime && out.heatMtime && out.heatMtime + 10 * 60 * 1000 < out.baseMtime) {
    const hours = ((out.baseMtime - out.heatMtime) / 3600000).toFixed(1);
    out.stale = true;
    out.reason = `热更层比基础包早 ${hours} 小时（上一版遗留）`;
  } else {
    out.reason = '热更层不旧';
  }

  out.applicable = true;
  out.targets = live;
  return out;
}

/**
 * 归档某游戏的热更层（改名，不删除）。
 *
 * @param {string} gameKey
 * @param {string} root
 * @returns {Promise<{ok:boolean, archived:string[], failed:Array, tag:string}>}
 */
async function archiveGameHeatLayer(gameKey, root) {
  const prof = HEAT_PROFILES[gameKey];
  const out = { ok: true, archived: [], failed: [], tag: '' };
  if (!prof || !prof.archive || !root) return { ...out, ok: false };

  const persist = path.join(root, prof.dataDir, prof.persistDir);
  if (!fs.existsSync(persist)) return { ...out, ok: false };

  const tag = ARCHIVE_PREFIX + stamp();
  out.tag = tag;

  const names = [...(prof.files || []), ...(prof.dirs || [])];
  for (const name of names) {
    const src = path.join(persist, name);
    const dst = path.join(persist, name + tag);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) continue;
    try {
      await fsp.rename(src, dst);
      out.archived.push(name);
    } catch (error) {
      out.failed.push({ name, error: (error && error.message) || String(error) });
    }
  }
  return out;
}

/**
 * 对外统一入口：更新 / 修复之后调一次。
 *
 * 原则：
 *   · **绝不抛异常** —— 善后动作失败不能把已经成功的更新搞成失败；
 *   · **只处理配置里 archive:true 的游戏** —— 米哈游三款有自愈，动了会害用户重下；
 *   · 全程写日志，出问题能追。
 *
 * @param {object} opts
 * @param {string} opts.gameKey 游戏标识
 * @param {string} opts.root 客户端根目录
 * @param {(msg:string)=>void} [opts.onLog]
 * @returns {Promise<{checked:boolean, stale:boolean, archived:string[], reason:string}>}
 */
async function healAfterUpdate({ gameKey, root, onLog } = {}) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const out = { checked: false, stale: false, archived: [], reason: '' };

  const prof = HEAT_PROFILES[gameKey];
  if (!prof) {
    out.reason = `未配置热更层策略（${gameKey || '未知'}），跳过`;
    return out;
  }
  if (!prof.archive) {
    out.reason = prof.reason || '该游戏自维护热更层，不需要处理';
    return out;
  }

  try {
    const info = inspectGameHeatLayer(gameKey, root);
    out.checked = true;
    out.reason = info.reason;

    if (!info.applicable || !info.stale) {
      log(`[${gameKey}] 热更层检查：${info.reason}`);
      return out;
    }

    log(`[${gameKey}] 热更层需要重建（${info.reason}）→ 归档旧热更数据`);
    const r = await archiveGameHeatLayer(gameKey, root);
    out.archived = r.archived;

    if (r.failed.length) {
      log(`[${gameKey}] 归档部分失败：${r.failed.map((f) => `${f.name}(${f.error})`).join(', ')}`);
    }
    if (r.archived.length) {
      log(
        `[${gameKey}] 已归档 ${r.archived.length} 项旧热更数据（后缀 ${r.tag}）；` +
          '游戏下次启动会按新基础包重建。要还原就把后缀去掉。'
      );
    }
  } catch (error) {
    log(`[${gameKey}] 热更层检查异常（不影响本次更新结果）：${(error && error.message) || error}`);
  }

  return out;
}

/** 还原某次归档。 */
async function restoreHeatLayer(gameKey, root, tag) {
  const prof = HEAT_PROFILES[gameKey];
  const restored = [];
  if (!prof || !root || !tag) return { ok: false, restored };
  const persist = path.join(root, prof.dataDir, prof.persistDir);
  for (const name of [...(prof.files || []), ...(prof.dirs || [])]) {
    const src = path.join(persist, name + tag);
    const dst = path.join(persist, name);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try {
      await fsp.rename(src, dst);
      restored.push(name);
    } catch {
      /* 单个失败不影响其它 */
    }
  }
  return { ok: restored.length > 0, restored };
}

module.exports = {
  HEAT_PROFILES,
  ARCHIVE_PREFIX,
  inspectGameHeatLayer,
  archiveGameHeatLayer,
  healAfterUpdate,
  restoreHeatLayer,
};
