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

/** 各游戏的预下载能力表。 */
const SUPPORT = {
  // 官服 / B服 / 国际服 三家都有自己独立的 Sophon build（实测 B服 package_id 与官服不同
  // 但 manifests 逐项相同），所以三个渠道都能走同一套预下载。
  genshin: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（官服 / B服 / 国际服）' },
  starrail: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（官服 / B服 / 国际服）' },
  zzz: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（官服 / B服 / 国际服）' },
  bh3: { supported: true, kind: 'hoyo', note: '米哈游 Sophon chunk 预下载（仅官服）' },
  endfield: { supported: true, kind: 'endfield', note: '鹰角 zip 分包预下载（Diffs/）' },
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
  endfieldInstallRoot,
  hoyoInstallRoot,
  isRuntimeDir,
};
