'use strict';

/**
 * 硬链接运行时一致性检查。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────
 *
 * 启动器给每个渠道生成「独立运行时」目录（`VelaRuntimes\<游戏>\<渠道>`），
 * 里面绝大多数文件是指向本体的硬链接 —— 省盘。但硬链接有三个结构性风险，
 * 之前一个都没检查过：
 *
 *   ① **本该链接、实际是独立副本** —— 生成时源校验（size + 首尾 md5）没通过，
 *      走了 copyFile 回退。之后本体更新，这份副本**不会跟着变**，用户看到的是
 *      旧版文件。实测本机原神 50 个、星铁 243 个。
 *
 *   ② **跨发行版差异被误判成「不同步」** —— 原神国服 hk4e_cn vs 国际服 hk4e_global，
 *      `global-metadata.dat` 本来就该差几十字节。这类**不能**当异常处理，
 *      否则每次都提示用户「文件损坏」。
 *
 *   ③ **本体更新后运行时没重建** —— 终末地有 marker 失效机制（baseSignature 变了
 *      自动重建），但米哈游四款**没有任何失效标记**，只能靠这里的检查兜住。
 *
 * ── 判定策略 ────────────────────────────────────────────────────────
 *
 * 只检查「关键文件」（随版本变、缺了会启动失败的那批），不扫全量（太慢）：
 *   global-metadata.dat / globalgamemanagers / config.ini / pkg_version / 主 exe
 *
 * 对每个关键文件比 (size, mtime)：
 *   · size 相同 → 视为一致（跨发行版也可能是同 size）
 *   · size 不同 且 mtime 与本体一致 → 说明是同一次更新写的，只是发行版差异 → 记「版本差异」不算异常
 *   · size 不同 且 mtime 明显旧于本体 → **真异常**：本体更新了，运行时没跟上
 */

const fs = require('node:fs');
const path = require('node:path');

/** 各游戏的关键文件（相对 Data 目录或根目录）。 */
const KEY_FILES = {
  genshin: {
    /* 两套目录名：国服 YuanShen_Data / 国际服 GenshinImpact_Data */
    dataDirs: ['YuanShen_Data', 'GenshinImpact_Data'],
    files: [
      'Native/Data/Metadata/global-metadata.dat',
      'globalgamemanagers.assets',
      'globalgamemanagers',
      'app.info',
    ],
    rootFiles: ['config.ini', 'pkg_version'],
  },
  starrail: {
    dataDirs: ['StarRail_Data'],
    files: ['il2cpp_data/Metadata/global-metadata.dat', 'app.info', 'boot.config'],
    rootFiles: ['config.ini'],
  },
  zzz: {
    dataDirs: ['ZenlessZoneZero_Data'],
    files: ['il2cpp_data/Metadata/global-metadata.dat', 'app.info', 'boot.config'],
    rootFiles: ['config.ini'],
  },
  bh3: {
    dataDirs: ['BH3_Data'],
    files: ['il2cpp_data/Metadata/global-metadata.dat', 'app.info'],
    rootFiles: ['config.ini'],
  },

  /*
   * 终末地：Unity + IFix。
   * 关键文件取「随版本变、缺了启动失败」的那批：
   *   global-metadata.dat  —— 游戏逻辑元数据，版本一变必换
   *   globalgamemanagers   —— Unity 场景索引
   *   boot.config / app.info
   * 注意它还有 Persistent（热更层），那部分由 game-heat.js 单独处理，不在这里比。
   */
  endfield: {
    dataDirs: ['Endfield_Data'],
    files: [
      'il2cpp_data/Metadata/global-metadata.dat',
      'globalgamemanagers',
      'globalgamemanagers.assets',
      'boot.config',
      'app.info',
    ],
    rootFiles: [],
  },

  /*
   * 鸣潮：UE4/UE5，主程序 Client-Win64-Shipping.exe。
   * 关键文件取 UE 的打包签名文件与主 exe 旁的版本文件：
   *   Client-Win64-Shipping.exe 本身随补丁变（体积大但只 stat，不读内容，很快）
   *   KRSDKRes / config 之类在运行时目录下有差异
   * 这里只放最稳的几个，避免误报。
   */
  wutheringwaves: {
    dataDirs: [],
    files: [],
    rootFiles: ['Client-Win64-Shipping.exe', 'launcherDownloadConfig.json'],
  },

  /*
   * 明日方舟：鹰角自研平台层 + Unity。
   * 方舟的结构和别的不一样：主程序在根目录，数据在 <游戏>_Data 下。
   * B服与官服共用同一套 appcode，只靠 channel/subChannel 区分，
   * 所以关键文件要比对，但**不能因为大小略差就报错**（B服渠道件本来不同）。
   */
  arknights: {
    dataDirs: ['Arknights_Data'],
    files: ['il2cpp_data/Metadata/global-metadata.dat', 'app.info', 'boot.config'],
    rootFiles: ['Arknights.exe', 'config.ini'],
  },
};

/** 读 config.ini 里的 game_biz（判断是不是同一个发行版）。 */
function readBiz(root) {
  try {
    const t = fs.readFileSync(path.join(root, 'config.ini'), 'utf8');
    const m = t.match(/game_biz\s*=\s*(\S+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** 找一个存在的 Data 目录。 */
function findDataDir(root, candidates) {
  for (const d of candidates) {
    const p = path.join(root, d);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function statOf(p) {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtime: st.mtimeMs, ino: st.ino };
  } catch {
    return null;
  }
}

/**
 * 检查某个渠道运行时与本体的一致性。
 *
 * @param {string} gameKey  genshin / starrail / zzz / bh3
 * @param {string} baseRoot 本体根目录
 * @param {string} runtimeRoot 运行时根目录
 * @returns {{ok:boolean, sameBiz:boolean, checked:number, stale:Array, versionDiff:Array, missing:Array, summary:string}}
 */
function checkRuntimeConsistency(gameKey, baseRoot, runtimeRoot) {
  const out = { ok: true, sameBiz: true, checked: 0, stale: [], versionDiff: [], missing: [], summary: '' };
  const spec = KEY_FILES[gameKey];
  if (!spec || !baseRoot || !runtimeRoot) {
    out.summary = '未配置或路径缺失，跳过';
    return out;
  }
  if (!fs.existsSync(baseRoot) || !fs.existsSync(runtimeRoot)) {
    out.summary = '路径不存在，跳过';
    return out;
  }

  const bizBase = readBiz(baseRoot);
  const bizRun = readBiz(runtimeRoot);
  out.sameBiz = !bizBase || !bizRun || bizBase === bizRun;

  const dataBase = findDataDir(baseRoot, spec.dataDirs);
  const dataRun = findDataDir(runtimeRoot, spec.dataDirs);

  /* 逐个关键文件比 */
  for (const rel of spec.files) {
    if (!dataBase) break;
    const pb = path.join(dataBase, rel);
    const sb = statOf(pb);
    if (!sb) continue; // 本体没这个文件，不检查

    /* 运行时侧：Data 目录名可能不同（国服 YuanShen_Data / 国际服 GenshinImpact_Data） */
    let sr = null;
    for (const d of spec.dataDirs) {
      const cand = path.join(runtimeRoot, d, rel);
      sr = statOf(cand);
      if (sr) break;
    }
    out.checked += 1;

    if (!sr) {
      out.missing.push(rel);
      continue;
    }
    if (sr.size === sb.size) continue; // 大小一致，认为同步

    /*
     * 大小不同：区分「发行版固有差异」和「真没跟上」。
     * 判据：两边 mtime 相差不到 1 小时 → 同一次更新写的，属发行版差异；
     *      运行时明显更旧 → 本体更新了运行时没跟上，是真问题。
     */
    const gap = Math.abs(sb.mtime - sr.mtime);
    if (gap < 3600 * 1000) {
      out.versionDiff.push({ rel, baseSize: sb.size, runSize: sr.size });
    } else if (sr.mtime < sb.mtime) {
      out.stale.push({ rel, baseSize: sb.size, runSize: sr.size, runMtime: sr.mtime, baseMtime: sb.mtime });
    } else {
      out.versionDiff.push({ rel, baseSize: sb.size, runSize: sr.size });
    }
  }

  /* 根目录文件 */
  for (const rel of spec.rootFiles || []) {
    const sb = statOf(path.join(baseRoot, rel));
    const sr = statOf(path.join(runtimeRoot, rel));
    if (!sb) continue;
    out.checked += 1;
    if (!sr) { out.missing.push(rel); continue; }
  }

  out.ok = out.stale.length === 0 && out.missing.length === 0;
  out.summary = out.ok
    ? `检查 ${out.checked} 项，与本体一致` +
      (out.versionDiff.length ? `（${out.versionDiff.length} 项为发行版差异，正常）` : '')
    : `检查 ${out.checked} 项：${out.stale.length} 项落后本体、${out.missing.length} 项缺失`;
  return out;
}

/**
 * 对所有已配置的服务器做一致性检查（给「修复」和「切服」用）。
 *
 * @param {object} game 游戏对象（含 servers）
 * @param {(msg:string)=>void} [onLog]
 * @returns {{problems:Array<{server:string, result:object}>}}
 */
function checkAllRuntimes(game, onLog) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const problems = [];
  const key = game && game.builtinKey;
  if (!KEY_FILES[key]) return { problems };

  for (const server of (game && game.servers) || []) {
    const runtime = String(server.root || '');
    const base = String(server.originalRoot || '');
    if (!runtime) continue;
    if (!base) {
      /*
       * 2026-11-26：独立客户端的 originalRoot 是空的，没有本体可比对 ——
       * 以前这里直接 continue，日志看起来像「无异常」，实际是根本没查。
       * 只对「看起来是我们生成的运行时」补日志（VelaRuntimes 下 / runtimeLinked），
       * 用户自己装的普通客户端本来就没什么可比，不必刷屏。
       */
      const looksRuntime = /[\\/]velaruntimes[\\/]/i.test(runtime) || server.runtimeLinked === true;
      if (looksRuntime && fs.existsSync(runtime)) {
        log(`[runtime] ${game.name || key} · ${server.name || server.id}：未登记本体（originalRoot），跳过一致性检查`);
      }
      continue;
    }
    if (runtime.toLowerCase() === base.toLowerCase()) continue;
    if (!fs.existsSync(runtime) || !fs.existsSync(base)) continue;

    const r = checkRuntimeConsistency(key, base, runtime);
    if (!r.ok) {
      problems.push({ server: server.name || server.id, result: r });
      log(`[runtime] ${game.name || key} · ${server.name || server.id}：${r.summary}`);
      for (const s of r.stale.slice(0, 3)) {
        log(`[runtime]   落后: ${s.rel}（本体 ${s.baseSize}B / 运行时 ${s.runSize}B）`);
      }
      for (const m of r.missing.slice(0, 3)) log(`[runtime]   缺失: ${m}`);
    }
  }
  return { problems };
}

module.exports = {
  KEY_FILES,
  readBiz,
  checkRuntimeConsistency,
  checkAllRuntimes,
};
