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
 *   - 终末地：Diffs/ 里每个包的 size + md5 是权威判定，另外预下载收尾会写
 *     <安装目录>/Diffs/.hxl-predownload.json（{targetVersion,packCount,totalBytes}）——
 *     只为了让同步的 hasCache 能区分「完整下完」和「残包」，不影响鹰角自己的命中判定。
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
const kuroPredownload = require('./kuro-predownload');
// 渠道能力表 + 渠道中文名：预下载在哪些渠道有官方清单，统一由 game-channels.js 定，
// 不要在下面 SUPPORT 里再写死渠道（用户 2026-11-16 定的规则）。
const gameChannels = require('./game-channels');
const clientChannel = require('./client-channel');

/** 各游戏的预下载能力表。 */
const SUPPORT = {
  // 官服 / B服 / 国际服 三家都有自己独立的 Sophon build（实测 B服 package_id 与官服不同
  // 但 manifests 逐项相同），所以三个渠道都能走同一套预下载。
  genshin: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（官服 / B服 / 国际服）' },
  starrail: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（官服 / B服 / 国际服）' },
  zzz: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（官服 / B服 / 国际服）' },
  // 崩坏3 2026-11-17 实测：官服 bh3_cn 与国际服 bh3_global 都有官方清单（国际服本体
  // game_id=5TIVvvcwtM，参考本机 Starward 源码 GameId.cs），B服三个 launcher 都查不到。
  bh3: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（官服 / 国际服）' },
  endfield: { supported: true, kind: 'endfield', note: '鹰角 zip 分包预下载（Diffs/）' },
  /*
   * 鸣潮（库洛 G152 / G153）：3.0.1.0 起官方启动器改用 bundle 分包协议，
   * 预下载槽挂在 index.json 顶层的 predownload，不在已弃用的 default 里。
   * 实现见 electron/kuro-predownload.js（自实现 gzip GET + 逐文件 md5 + 事务式记账）。
   * WeGame 渠道没有对应的 bundle 官方清单，界面那层会直接不给入口。
   */
  wutheringwaves: { supported: true, kind: 'kuro', note: '库洛 bundle 分包预下载（官服 / B服 / 国际服）' },
  /*
   * 明日方舟（Hypergryph）：当前不接预下载。
   * 与终末地同一套 batch_proxy 协议：get_latest_game_rsp 里同样带 patch / pre_patch
   * 字段（2026-11-09 实测，方舟官服带旧版本号询问时 patch 非空、pre_patch 为 null），
   * 所以「接口不存在」这个说法是错的 —— 只是官方这一刻没有放出预下载分支。
   * 真正没接的是产品层：没有 Diffs 落盘目录的语义、没有 UI 入口（servers.js 的
   * PREDOWNLOAD_GAMES 不含 arknights），要接得先把 check/start/apply 三阶段补齐。
   * 这里显式登记成「不支持 + 原因」，而不是让它落到默认的「这个游戏没有接入预下载」，
   * 是因为将来要加「为什么不支持」的说明时，这句话就是唯一来源。
   */
  arknights: {
    supported: false,
    kind: 'none',
    reason: '明日方舟官方当前未开放预下载分支（协议本身有 pre_patch 字段，只是这一刻没放包），版本更新由官方客户端自己完成',
  },
  neverness: {
    supported: true,
    kind: 'nte',
    /*
     * 异环（Neverness to Everness，Hotta Studio / 完美世界）—— 2026-10-30 接入。
     *
     * 我们自己能做的：启动器侧资源（NTELauncher 文件夹）的版本检测 + 更新。
     *   Config.ini [VERSION] Version vs 远程 Version.ini，不一致即「有更新」；
     *   更新走 AllFiles.xml 清单逐文件下载校验（neverness-predownload.js）。
     *
     * 只能检测、不能自己下的：游戏本体（Client）。
     *   本体走 PatcherSDK 的 PreRelease 机制。预下载分支配置是公开的
     *   （{gameResUrl}/{LocalBranch}/Version/Windows/config.xml 里有 PreReleaseBranch /
     *   PreReleaseVersion / PreReleaseStatus），所以「官方放出了 1.5.0」我们查得到；
     *   但资源实体要登录态换腾讯云 STS 临时密钥动态签名，匿名直连一律 404，
     *   清单还是 PatcherXML0 私有加密格式 + .sig 验签 —— 自己下不了。
     *   所以这条状态带 scope='official'，界面把按钮接到「打开官方预下载」。
     */
    note: '异环启动器侧资源检测与更新；本体预下载只做检测与引导（资源由官方启动器下载）',
  },
};

function describe(gameKey, channel = '') {
  const entry = SUPPORT[String(gameKey || '')];
  if (!entry) return { supported: false, kind: 'none', reason: '这个游戏没有接入预下载' };
  // 终末地要单独判：Steam 渠道官方根本没有 GameInstaller，连 Diffs/ 都不会生成，
  // 同一款游戏、同一份协议，只有这一条渠道的预下载包在 Valve 手里。
  if (entry.kind === 'endfield' && channel) {
    if (!endfield.supported(channel)) {
      return { supported: false, kind: 'endfield', reason: 'Steam 渠道的更新由 Steam 自己负责，官方协议里没有预下载包' };
    }
  }
  /*
   * 统一的渠道判据（用户 2026-11-16 定的规则）：预下载要看官方有没有对这个渠道发清单，
   * 这件事 game-channels.js 的能力表里已经写好了，这里不再各游戏各写一套。
   *   崩坏3  —— 官服 bh3_cn 与国际服 bh3_global 都有 Hoyoverse 预下载清单
   *     （国际服本体 game_id=5TIVvvcwtM，2026-11-17 实测），B服得用 B 站官方启动器；
   *   鸣潮   —— official / bilibili / global / wegame 四个渠道都在表里（用户 2026-11-16 定的是全渠道）；
   *   原神 / 星铁 / 绝区零 —— 三个渠道都有。
   * 三个前提缺一不可：
   *   1. channel 非空 —— describe() 还被 hasCache / clear 这类只关心「有没有缓存」的
   *      地方以 empty channel 调用，能力表对空渠道恒为 false，不排除的话会把状态读坏；
   *   2. entry.supported —— 方舟（supported:false）已经带着自己那句更具体的 reason，
   *      不能被这里覆盖成通用文案；
   *   3. kind !== 'nte' —— 异环的「预下载」其实是启动器侧资源检测 + 引导官方启动器，
   *      走的是 neverness-predownload 自己那套渠道判定，本轮明确不动。
   */
  if (channel && entry.supported && entry.kind !== 'nte') {
    const key = String(gameKey || '');
    if (!gameChannels.can(key, channel, 'predownload')) {
      // 文案里的游戏名 / 渠道名都从表里取，避免每个游戏再写一份中文对照。
      const gameName = gameChannels.capsOf(key).label || '这个游戏';
      const channelName = clientChannel.channelLabel(channel);
      return {
        supported: false,
        kind: entry.kind,
        reason: `${gameName}的${channelName}没有官方预下载清单，请用对应官方客户端更新`,
      };
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
  // 异环只覆盖启动器侧资源，带出去让界面别写成「更新游戏」
  if (report.scope) base.scope = String(report.scope);
  /*
   * 异环本体预下载（scope = official）：官方放出了下一版，但资源只有官方启动器
   * 下得动。officialOnly 让界面把按钮接到「打开官方预下载」而不是我们自己的下载器；
   * 其余 preRelease* 只用于文案，不参与任何下载决策。
   */
  if (typeof report.officialOnly === 'boolean') base.officialOnly = report.officialOnly;
  if (typeof report.preReleaseAvailable === 'boolean') base.preReleaseAvailable = report.preReleaseAvailable;
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
    'preReleaseBytes',
    'requiredSpace',
    'finalSize',
    'currentSize',
    'downloadSize',
  ]) {
    if (typeof report[key] === 'number') base[key] = report[key];
  }
  for (const key of [
    'preReleaseBranch',
    'preReleaseVersion',
    'preReleaseStatus',
    'preReleaseReason',
    'officialResVersion',
    'localResVersion',
  ]) {
    if (typeof report[key] === 'string' && report[key]) base[key] = report[key];
  }
  if (typeof report.includeCategory === 'boolean') base.includeCategory = report.includeCategory;
  // 鸣潮：下到一半的暂存要能在界面上说「接着下，不会重来」
  if (typeof report.partial === 'boolean') base.partial = report.partial;
  return base;
}

/**
 * 终末地的安装根目录不能直接用 server.root —— 那是硬链接出来的运行时目录，
 * 往里写 Diffs/ 会污染运行时，而且鹰角官方的更新流程认的是真实安装目录。
 * 运行时目录的特征是带标记文件，需要排除掉。
 *
 * 2026-11-08：架构是「每个渠道一份独立的硬链接运行时」（<运行时根>\endfield\<渠道>），
 * 标记就是 .hxl-endfield-runtime-v2。不认它的话，运行时目录会被当成「真实安装目录」，
 * 更新包直接写进运行时里，下一次重建就被渠道包覆盖掉，白下一次。
 */
const RUNTIME_MARKERS = ['.hxl-endfield-runtime-v2'];

function isRuntimeDir(dir) {
  try {
    return RUNTIME_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
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
  // 兜底不能把运行时镜像当真实安装目录：Diffs 写进去，下次重建就被渠道包覆盖，白下一次。
  if (isRuntimeDir(server?.root)) return '';
  return server?.root || '';
}

/** 米哈游系的安装根目录：server.root 就是客户端目录（config.ini 在那儿）。 */
function hoyoInstallRoot(server) {
  return server?.root || (server?.path ? path.dirname(server.path) : '');
}

/**
 * 鸣潮（库洛）系的安装根目录。
 *
 * 库洛客户端的本体根目录靠根下的 `launcherDownloadConfig.json` 认，而主程序在
 * 三层深的 `Client\Binaries\Win64` 下。行里的 root 有时被填成 exe 所在目录
 * （手动选路径、自动扫描都踩过），只认这一层就会判成「不是库洛官方客户端」。
 * 这里从 row 的 root/path 往上找本体根，找不到才回退原来的 root。
 */
function kuroInstallRoot(server) {
  const fromRoot = kuroPredownload.findKuroClientRoot(server?.root || '');
  if (fromRoot) return fromRoot;
  const fromPath = kuroPredownload.findKuroClientRoot(server?.path || '');
  if (fromPath) return fromPath;
  return server?.root || (server?.path ? path.dirname(server.path) : '');
}

/** 鸣潮预下载暂存目录（与 kuro-predownload.js 的 STAGE_DIR_NAME 保持一致）。 */
function kuroStageDir(installRoot) {
  return path.join(String(installRoot || ''), '_kuro_predownload');
}

/** 同步读暂存记录：给 hasCache 和界面用；读不到 / 损坏一律 null。 */
function kuroStateSync(installRoot) {
  try {
    const raw = fs.readFileSync(path.join(kuroStageDir(installRoot), 'state.json'), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** 异步版：给「更新游戏」链路判断是否先把预下载包应用掉，省一次 CDN 重下。 */
async function kuroPendingState(installRoot) {
  try {
    return await kuroPredownload.readState(installRoot);
  } catch {
    return null;
  }
}

/**
 * 把 kuro-predownload.checkPredownload 的返回值翻成界面这套状态机认得的 report。
 *
 * 底层只说「官方这次放了多少字节、能不能预下载」，界面认的是
 * state / bytesGame / storedBytes / partial，所以在这里适配一次，不改底层模块
 * （它有自己的 9 项自测和 12.08 / 13.48 / 82.32 / 80.52 GiB 实网数字闭环）。
 *
 *   available + 没下完          → available（可点「开始预下载」）
 *   available + 已下完          → done（等官方正式开放，应用按钮先禁用）
 *   官方撤掉预下载槽 + 已下完   → update（新版已上线，可点「应用更新」）
 *   没放包 / 本地已是最新       → none（附中文 reason）
 *   读不到本地客户端版本        → not-installed
 */
async function kuroReport({ channel, installRoot } = {}) {
  const info = await kuroPredownload.checkPredownload({ channel, installRoot });
  const state = kuroStateSync(installRoot);
  const downloaded = Boolean(state && state.completed && !state.applied);
  const storedBytes = Number(state && state.bytes) || 0;
  const storedFiles = Number(state && state.downloadedFiles) || 0;
  const targetVersion = String(info.targetVersion || (state && state.targetVersion) || '');
  const localVersion = String((state && state.localVersion) || '');
  const base = {
    supported: true,
    kind: 'kuro',
    localVersion,
    targetVersion,
    latestVersion: '',
    dir: kuroStageDir(installRoot),
    completed: downloaded,
    bytesGame: Number(info.downloadSize) || 0,
    bytesTotal: Number(info.downloadSize) || 0,
    requiredSpace: Number(info.requiredSpace) || 0,
    finalSize: Number(info.finalSize) || 0,
    currentSize: Number(info.currentSize) || 0,
    storedBytes,
    storedFiles,
  };
  const reason = String(info.reason || '');

  if (/读不到本地游戏版本/.test(reason)) {
    return { ...base, state: 'not-installed', reason };
  }
  // 官方已把新版本转正式（predownload 槽撤销）时，即使本机没下过预下载包，
  // 也要把「更新游戏」点亮（对标 predownload-hoyo.js:526-528，用户 m28959）。
  const liveVersion = String(info.liveVersion || '');
  const currentVersion = String(info.localVersion || localVersion || '');
  if (liveVersion && kuroPredownload.compareVersion(liveVersion, currentVersion) > 0) {
    return {
      ...base,
      state: 'update',
      latestVersion: liveVersion,
      targetVersion: liveVersion,
      localVersion: currentVersion,
      reason: reason || `发现新版本 ${liveVersion}`,
    };
  }
  if (downloaded) {
    const stateTarget = String((state && state.targetVersion) || '');
    // 官方把预下载槽撤了 = 正式版已上线，可以让「应用更新」亮起来
    if (!info.available && stateTarget) {
      return { ...base, state: 'update', latestVersion: stateTarget, targetVersion: stateTarget };
    }
    if (!info.available) {
      return { ...base, state: 'none', reason: reason || '官方暂未开放预下载' };
    }
    return { ...base, state: 'done' };
  }
  if (info.available) {
    return { ...base, state: 'available', partial: storedBytes > 0 };
  }
  return { ...base, state: 'none', reason: reason || '官方暂未开放预下载' };
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
  if (info.kind === 'kuro') {
    return kuroReport({ channel, installRoot });
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
  if (info.kind === 'kuro') {
    const result = await kuroPredownload.downloadPredownload({
      channel,
      installRoot: options.installRoot,
      signal: options.signal,
      onProgress: options.onProgress,
      // 跨服复用：同机别的鸣潮客户端预下载过同一份差量文件就直接硬链接过来
      linkSources: Array.isArray(options.linkSources) ? options.linkSources : [],
    });
    // 底层把「没渠道 / 没放包 / 读不到版本」都收敛成 ok:false + 中文 reason；
    // 不抛出去的话主进程会当成下载成功，界面直接显示「预下载完成」。
    if (!result || !result.ok) throw new Error((result && result.reason) || '预下载失败');
    return { ok: true, ...result, kind: 'kuro', gameKey };
  }
  if (info.kind === 'nte') return neverness.updateLauncherFiles(options);
  throw new Error('这个游戏不支持预下载');
}

/**
 * 鸣潮「真升级」：不依赖预下载暂存，直接按线上 bundle 全量清单逐文件刷到正式版。
 * 这是 wutheringwaves:update-game / games:repair-game / dock「更新游戏」共用的入口，
 * 返回统一带 tag/version，主进程可直接写回 game.version。
 */
async function updateKuroGame(options) {
  const result = await kuroPredownload.updateGameFromBundle({
    channel: options.channel,
    installRoot: options.installRoot,
    signal: options.signal,
    onProgress: options.onProgress,
    /*
     * 跨服硬链接复用（2026-11-16 用户要求）：同机别的鸣潮客户端已经在目标版本时，
     * 内容相同的文件直接硬链接过来，只下真正缺的差异文件。调用方传 ctx 的
     * externalLinkSources(game, server, server.root) 结果；不传就当没有源。
     */
    linkSources: Array.isArray(options.linkSources) ? options.linkSources : [],
  });
  if (!result || !result.ok) throw new Error((result && result.reason) || '鸣潮更新失败');
  // 只清掉「不比本次升级的目标版本更新」的暂存；用户可能已经预下载了更新的版本，
  // 那种暂存不能被一次普通升级顺手删掉。
  const staged = await kuroPredownload.readState(options.installRoot).catch(() => null);
  const keep = staged && staged.targetVersion &&
    kuroPredownload.compareVersion(String(staged.targetVersion), String(result.tag)) > 0;
  if (!keep) await kuroPredownload.clearPredownload(options.installRoot).catch(() => {});
  return {
    ok: true,
    ...result,
    kind: 'kuro',
    tag: result.tag,
    version: result.tag,
    applied: (Number(result.downloaded) || 0) + (Number(result.reused) || 0),
  };
}

async function apply(options) {
  const { gameKey, channel } = options;
  const info = describe(gameKey, channel);
  if (!info.supported) throw new Error(info.reason || '这个游戏不支持预下载');
  if (info.kind === 'hoyo') return hoyo.applyHoyoPredownload(options);
  if (info.kind === 'endfield') return endfield.applyEndfieldPredownload(options);
  if (info.kind === 'kuro') {
    let before = null;
    try { before = await kuroPredownload.readState(options.installRoot); } catch { before = null; }
    if (before && before.completed && !before.applied) {
      // 有完整暂存就先用掉：省掉一次 CDN 重下。applyPredownload 自己会核对线上
      // 正式版本是否真到了目标版本、逐文件 md5、只在全部命中时清暂存。
      const staged = await kuroPredownload.applyPredownload({
        channel,
        installRoot: options.installRoot,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      if (staged && staged.ok && staged.applied && !staged.reason) {
        const after = await kuroPredownload.readState(options.installRoot).catch(() => null);
        if (!after) {
          const tag = String(before.targetVersion || '');
          return { ok: true, ...staged, kind: 'kuro', tag, version: tag, applied: staged.applied };
        }
      }
      // 暂存没用掉（缺件 / 新版本还没正式开放 / 已过期）：不要卡住用户，
      // 继续走 bundle 真升级把客户端收敛到线上正式版。
    }
    return updateKuroGame(options);
  }
  // 异环没有「预下载缓存」这一层，检测到更新后直接把启动器侧资源补齐
  if (info.kind === 'nte') return neverness.updateLauncherFiles(options);
  throw new Error('这个游戏不支持预下载');
}

/**
 * 目录里是否真的有**可用**的预下载产物（用来决定「点更新」时要不要先走应用预下载那条路）。
 *
 * 米哈游这条不能只判目录存不存在：chunk/ 只要跑过一次预下载就会留下目录，哪怕里面
 * 是这个版本的残渣、甚至只下了一两个块。之前这样判的后果是「点更新」永远走应用预下载
 * 那条短路，正式更新里的 ldiff 预处理整段被跳过，一次小版本更新退化成纯 chunk 全量下载
 * （实测原神 22.43GB、星铁 12.70GB，而走 ldiff 只需 8.34GB / 5.82GB）。
 *
 * 这里只做**本地同步**判据，不联网——hasCache 被 main.js 的裸 if 同步调用，改成 async
 * 会让调用点恒真。于是判三件事：① 有真实分块（排除 .hxl- 元信息和 .pd_tmp 半成品）；
 * ② 有 startHoyoPredownload 完整跑完才写的元信息文件；③ 磁盘上的分块数没明显少于记录值
 * （下到一半或被清理过的残包不算）。
 *
 * 版本对不对得上交给 applyHoyoPredownload 按当前 main 清单自己校验；即便它失败，
 * 调用点也有 catch 落回 ldiff，所以这里从严判不会把「能用的缓存」永久判死，只会让
 * 「不该走的 apply」不触发。
 */
function hasCache({ gameKey, channel, installRoot }) {
  const info = describe(gameKey, channel);
  if (!info.supported || !installRoot) return false;
  try {
    if (info.kind === 'hoyo') {
      const dir = hoyo.chunkDirOf(installRoot);
      let entries;
      try {
        // 只要**文件**：chunk/ 里正常全是分块文件，但个别用户或工具可能在里面留空子目录，
        // 用 readdirSync 的名字列表会把目录也算成「块」，凑够 90% 就会误判成有缓存。
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      const chunks = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.hxl-') && !entry.name.endsWith('.pd_tmp'));
      if (!chunks.length) return false;
      let meta;
      try {
        // 文件名与 predownload-hoyo.js 的 META_FILE 保持一致；只有预下载完整收尾才写。
        meta = JSON.parse(fs.readFileSync(path.join(dir, '.hxl-predownload.json'), 'utf8'));
      } catch {
        // 没有元信息 = 从来没完整跑完过一次预下载，只是残渣。
        return false;
      }
      if (!meta || !meta.targetVersion || !Number(meta.chunkCount)) return false;
      if (chunks.length < Number(meta.chunkCount) * 0.9) return false;
      return true;
    }
    if (info.kind === 'endfield') {
      /*
       * 终末地原来是 `return fs.existsSync(diffsDirOf(installRoot))` —— 只要 Diffs\ 这个
       * 目录还在就算有缓存。代价很实在：用户在官方启动器里手动清过 Diffs、或者预下载
       * 下到一半被打断，目录还在但包里没东西，这里照样判「有缓存」→ 点更新走 apply →
       * apply 校验不通过（原来还拿正式 patch 清单去核对预下载包）→ 抛异常 → 回落成
       * 逐文件全量更新，预下载白下。和米哈游那边是同一个病。
       *
       * 改成和 hoyo 同构：① Diffs\ 里真有分卷包（排除 .hxl- 元信息与 .part 半成品）
       * ② 有预下载收尾才写的元信息 ③ 元信息记的包数没明显多于磁盘实数。
       * 老用户没有元信息文件（这一版之前下的）按「未就绪」处理：宁可让 apply 不触发、
       * 直接走完整更新，也不要拿一个核对不了的目录去赌。
       */
      const state = endfield.readEndfieldMeta(installRoot);
      if (!state.packFiles) return false;
      if (!state.meta || !state.meta.targetVersion || !Number(state.meta.packCount)) return false;
      if (state.packFiles < Number(state.meta.packCount) * 0.9) return false;
      return true;
    }
    if (info.kind === 'kuro') {
      const kstate = kuroStateSync(installRoot);
      return Boolean(kstate && kstate.completed && !kstate.applied);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * 目录里是否有**预下载下来的 ldiff 补丁包**（预下载走了「补丁」那条路时用）。
 *
 * 和 hasCache 分开而不是混成一个布尔：两条路的产物在磁盘上是两个目录
 * （chunk/ 与 ldiff/），点更新时该走哪条 apply 完全不同，调用点要能分别判断。
 * 同样是纯本地同步判据（不能联网），判三件事：① ldiff/ 里有真包（排除元信息）
 * ② 有预下载收尾写的元信息 ③ 元信息说这份是补丁模式。
 */
function hasPatchCache({ gameKey, channel, installRoot }) {
  const info = describe(gameKey, channel);
  if (!info.supported || !installRoot) return false;
  if (info.kind !== 'hoyo') return false;
  try {
    const dir = hoyo.patchDirOf(installRoot);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    const packs = entries.filter(
      (entry) => entry.isFile() && !entry.name.startsWith('.hxl-') && !entry.name.endsWith('.part')
    );
    if (!packs.length) return false;
    let meta;
    try {
      // 补丁模式的元信息仍写在 chunk/ 里（一份元信息描述一份预下载，不分散两处）
      meta = JSON.parse(fs.readFileSync(path.join(hoyo.chunkDirOf(installRoot), '.hxl-predownload.json'), 'utf8'));
    } catch {
      return false;
    }
    if (!meta || meta.mode !== 'ldiff') return false;
    if (!meta.targetVersion || !Number(meta.patchCount)) return false;
    if (packs.length < Number(meta.patchCount) * 0.9) return false;
    return true;
  } catch {
    return false;
  }
}

async function clear({ gameKey, installRoot }) {
  const info = describe(gameKey);
  if (info.kind === 'hoyo') return hoyo.clearHoyoPredownload({ installRoot });
  if (info.kind === 'endfield') return endfield.clearEndfieldPredownload({ installRoot });
  if (info.kind === 'kuro') return kuroPredownload.clearPredownload(installRoot);
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
  hasPatchCache,
  kuroPendingState,
  updateKuroGame,
  endfieldInstallRoot,
  hoyoInstallRoot,
  kuroInstallRoot,
  isRuntimeDir,
};
