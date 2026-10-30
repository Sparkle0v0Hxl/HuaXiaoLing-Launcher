'use strict';

/**
 * 预下载统一入口。
 *
 * 三个厂商三套协议，这里只做三件事：
 *   1. 告诉调用方某个游戏 / 渠道「支不支持、为什么不支持」；
 *   2. 按 builtinKey 把 check / start / apply / clear 分发到对应实现；
 *   3. 定义预下载状态在启动器里的落盘结构（server.predownload）。
 *
 * 状态存哪：
 *   - 米哈游系：权威标记写在 <游戏目录>/config.ini 的 predownload=<本地版本>,<目标版本>,<语音组合>
 *     （和 Starward / 官方启动器同一套写法），启动器自己再存一份 server.predownload 供界面直接读。
 *   - 终末地：预下载完成**没有**任何落盘标记，只能靠 Diffs/ 里每个包的 size + md5 重算，
 *     所以启动器必须自己存 { 安装路径, 目标版本 }，界面完全依赖 server.predownload。
 *
 * server.predownload 结构：
 *   {
 *     kind:        'hoyo' | 'endfield'
 *     state:       'available' | 'done' | 'update' | 'none' | 'not-installed' | 'unsupported' | 'error'
 *     localVersion / targetVersion / latestVersion
 *     dir:         预下载产物目录（hoyo: <安装目录>/chunk，endfield: <安装目录>/Diffs）
 *     completed:   boolean
 *     updatedAt:   ISO 时间
 *     error:       失败原因（state === 'error' 时才有）
 *   }
 */

const fs = require('node:fs');
const path = require('node:path');

const hoyo = require('./predownload-hoyo');
const endfield = require('./predownload-endfield');
const neverness = require('./neverness-predownload');

/** 各游戏的预下载能力表。 */
const SUPPORT = {
  // 官服 / B服 / 国际服 三家都有自己独立的 Sophon build（实测 B服 package_id 与官服不同
  // 但 manifests 逐项相同），所以三个渠道都能走同一套预下载。
  genshin: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（官服 / B服 / 国际服）' },
  starrail: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（官服 / B服 / 国际服）' },
  zzz: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（官服 / B服 / 国际服）' },
  endfield: { supported: true, kind: 'endfield', note: '鹰角 zip 分包预下载（Diffs/）' },
  neverness: {
    supported: true,
    kind: 'nte',
    /*
     * 异环（Neverness to Everness，Hotta Studio / 完美世界）—— 2026-10-30 接入。
     *
     * 能做的：启动器侧资源（NTELauncher 文件夹）的版本检测 + 更新。
     *   Config.ini [VERSION] Version vs 远程 Version.ini，不一致即「有更新」；
     *   更新走 AllFiles.xml 清单逐文件下载校验（neverness-predownload.js）。
     *
     * 做不了的：游戏本体（Client）的差分更新。
     *   本体走 PatcherSDK 的 .sig 差分机制，远程路径未公开、sig 是二进制私有格式，
     *   拿不到清单就做不到可校验的下载。本体更新仍由官方启动器在启动时接管
     *   （异环本来就是拉官方启动器启动，本体有新版本时它会自己补）。
     */
    note: '异环启动器侧资源检测与更新（游戏本体仍由官方启动器接管）',
  },
};

function describe(gameKey, channel = '') {
  const entry = SUPPORT[String(gameKey || '')];
  if (!entry) return { supported: false, kind: 'none', reason: '这个游戏没有接入预下载' };
  if (entry.kind === 'endfield' && channel) {
    if (!endfield.supported(channel)) {
      return { supported: false, kind: 'endfield', reason: 'Steam 渠道的更新由 Steam 自己负责，官方协议里没有预下载包' };
    }
  }
  return { ...entry };
}

function readState(server) {
  return server?.predownload && typeof server.predownload === 'object' ? server.predownload : null;
}

/** 把一次 check 的结果收敛成要落盘的状态；只有可用的状态才值得记。 */
function stateFromReport(report) {
  if (!report || typeof report !== 'object') return null;
  const base = {
    kind: report.kind || 'none',
    state: report.state || 'none',
    localVersion: report.localVersion || '',
    targetVersion: report.targetVersion || '',
    latestVersion: report.latestVersion || '',
    dir: report.dir || '',
    completed: Boolean(report.completed),
    updatedAt: new Date().toISOString(),
  };
  if (report.error) base.error = String(report.error);
  if (report.reason) base.reason = String(report.reason);
  for (const key of [
    'packs',
    'matchedPacks',
    'missingPacks',
    'bytesDone',
    'bytesTotal',
    'bytesGame',
    'bytesAudio',
    'bytesCategory',
    'bytesMiniSkipped',
    'categoryCount',
    'chunks',
    'storedFiles',
    'storedBytes',
  ]) {
    if (typeof report[key] === 'number') base[key] = report[key];
  }
  if (typeof report.includeCategory === 'boolean') base.includeCategory = report.includeCategory;
  return base;
}

/**
 * 终末地的安装根目录不能直接用 server.root —— 那是硬链接出来的运行时目录，
 * 往里写 Diffs/ 会污染运行时，而且鹰角官方的更新流程认的是真实安装目录。
 * 运行时目录的特征是带 .hxl-endfield-runtime-v2 标记，需要排除掉。
 */
const RUNTIME_MARKER = '.hxl-endfield-runtime-v2';

function isRuntimeDir(dir) {
  try {
    return fs.existsSync(path.join(dir, RUNTIME_MARKER));
  } catch {
    return false;
  }
}

function endfieldInstallRoot(game, server) {
  const candidates = [];
  for (const item of game?.servers || []) {
    if (item?.originalRoot) candidates.push(item.originalRoot);
  }
  if (server?.originalRoot) candidates.unshift(server.originalRoot);
  for (const item of game?.servers || []) {
    if (item?.root) candidates.push(item.root);
  }
  if (server?.root) candidates.push(server.root);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isRuntimeDir(candidate)) continue;
    if (fs.existsSync(path.join(candidate, 'Endfield.exe')) && fs.existsSync(path.join(candidate, 'config.ini'))) {
      return candidate;
    }
  }
  return server?.root || '';
}

/** 米哈游系的安装根目录：server.root 就是客户端目录（config.ini 在那儿）。 */
function hoyoInstallRoot(server) {
  return server?.root || (server?.path ? path.dirname(server.path) : '');
}

async function check({
  gameKey,
  channel,
  installRoot,
  audioLanguages,
  cacheDir,
  includeCategory,
  verify = false,
}) {
  const info = describe(gameKey, channel);
  if (!info.supported) {
    return { supported: false, state: 'unsupported', kind: info.kind, reason: info.reason || '', installRoot };
  }
  if (info.kind === 'hoyo') {
    return hoyo.checkHoyoPredownload({
      gameKey,
      channel,
      installRoot,
      audioLanguages,
      cacheDir,
      includeCategory,
      verify,
    });
  }
  if (info.kind === 'endfield') {
    return endfield.checkEndfieldPredownload({ channel, installRoot, verify });
  }
  if (info.kind === 'nte') {
    return neverness.checkUpdate({ installRoot, channel, signal: null });
  }
  return { supported: false, state: 'unsupported' };
}

async function start(options) {
  const { gameKey, channel } = options;
  const info = describe(gameKey, channel);
  if (!info.supported) throw new Error(info.reason || '这个游戏不支持预下载');
  if (info.kind === 'hoyo') return hoyo.startHoyoPredownload(options);
  if (info.kind === 'endfield') return endfield.startEndfieldPredownload(options);
  if (info.kind === 'nte') return neverness.updateLauncherFiles(options);
  throw new Error('这个游戏不支持预下载');
}

async function apply(options) {
  const { gameKey, channel } = options;
  const info = describe(gameKey, channel);
  if (!info.supported) throw new Error(info.reason || '这个游戏不支持预下载');
  if (info.kind === 'hoyo') return hoyo.applyHoyoPredownload(options);
  if (info.kind === 'endfield') return endfield.applyEndfieldPredownload(options);
  // 异环没有「预下载缓存」这一层，检测到更新后直接把启动器侧资源补齐
  if (info.kind === 'nte') return neverness.updateLauncherFiles(options);
  throw new Error('这个游戏不支持预下载');
}

/** 目录里是否真的有预下载产物（用来决定「点更新」时要不要先走应用预下载那条路）。 */
function hasCache({ gameKey, channel, installRoot }) {
  const info = describe(gameKey, channel);
  if (!info.supported || !installRoot) return false;
  try {
    if (info.kind === 'hoyo') return fs.existsSync(hoyo.chunkDirOf(installRoot));
    if (info.kind === 'endfield') return fs.existsSync(endfield.diffsDirOf(installRoot));
  } catch {
    return false;
  }
  return false;
}

async function clear({ gameKey, installRoot }) {
  const info = describe(gameKey);
  if (info.kind === 'hoyo') return hoyo.clearHoyoPredownload({ installRoot });
  if (info.kind === 'endfield') return endfield.clearEndfieldPredownload({ installRoot });
  return { ok: true, installRoot, skipped: true };
}

module.exports = {
  SUPPORT,
  describe,
  readState,
  stateFromReport,
  check,
  start,
  apply,
  clear,
  hasCache,
  endfieldInstallRoot,
  hoyoInstallRoot,
  isRuntimeDir,
};
