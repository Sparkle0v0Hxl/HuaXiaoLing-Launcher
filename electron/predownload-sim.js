'use strict';

/**
 * 预下载演练模式（只在验收 / 开发时开）。
 *
 * 为什么要有这个：
 *   预下载按钮按设计「只有官方真的放出新版本时才出现」。平时既没有可触发的游戏、
 *   也不能凭空等一次版本更新，于是「弹窗长什么样、进度条会不会跳回 0、暂停/停止/
 *   出错文案对不对」这些**全是盲区** —— 只能等真版本上线那天赌一把。
 *
 * 这个模块只替换最底层的四个动作（check / start / apply / clear）：
 *   IPC 通道、进度事件、server.predownload 落盘、按钮可见性、toast、错误处理
 *   统统还是真实代码路径，所以看到的就是真实界面在真实数据流下的样子。
 *
 * 开关（**删文件即恢复真实链路，不用改代码、不用重打包**）：
 *   <userData>/predownload-sim.json     存在 = 启用
 *   <userData>/predownload-sim-state.json  sim 自己的进度（available → done → none）
 *
 * 配置项（全部可选，写 {} 就是默认值）：
 *   gameKey    只演练某一款游戏（builtinKey，如 genshin / endfield），别的游戏照旧走真实链路；
 *              不写或写 "*" 就是所有游戏都演练
 *   state      强制某个状态，用来单独看某一种界面：
 *              available | done | update | none | unsupported | error
 *   reason     state=unsupported 时显示的原因文案
 *   error      state=error 时显示的错误文案
 *   seconds    预下载总时长（秒，默认 18）
 *   chunks     分块数（默认 240）
 *   bytes      总体积（字节，默认 20.9GB）
 *   failAt     在下载到百分之几时抛错，用来验错误界面（默认 0 = 不失败）
 *   localVersion / targetVersion  假版本号
 *
 * 用户目录由 main.js 通过 setup() 注入 —— 本模块不直接 require electron，
 * 这样开发脚本里可以脱离 Electron 直接跑。
 */

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'predownload-sim.json';
const STATE_FILE = 'predownload-sim-state.json';
/** 落盘状态里带这个前缀，就能认出是演练写进去的假数据，关掉后自动清掉。 */
const SIM_DIR = 'sim://predownload';

const DEFAULTS = {
  localVersion: '6.2.0',
  targetVersion: '6.3.0',
  seconds: 18,
  chunks: 240,
  bytes: Math.round(20.9 * 1024 ** 3),
};

let simDir = '';

/** main.js 拿到 userData 之后调一次。没调过 = 永远关闭，绝不误伤真实链路。 */
function setup({ userDataDir } = {}) {
  simDir = userDataDir ? String(userDataDir) : '';
}

function configPath() {
  return simDir ? path.join(simDir, CONFIG_FILE) : '';
}

function statePath() {
  return simDir ? path.join(simDir, STATE_FILE) : '';
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 开关文件在 = 启用。文件内容坏了也当启用（否则用户会以为演练失效）。 */
function config() {
  if (!simDir) return null;
  const file = configPath();
  if (!fs.existsSync(file)) return null;
  const raw = readJson(file);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function enabled() {
  return Boolean(config());
}

/**
 * 只演练某一款游戏时用：配置里写 gameKey，别的游戏照旧走真实链路。
 * 不写 / 写 "*" 就是所有游戏都演练。
 */
function configured(options) {
  const cfg = config();
  if (!cfg) return null;
  const only = String(cfg.gameKey || '').trim();
  if (only && only !== '*' && (!options || options.gameKey !== only)) return null;
  return cfg;
}

function defaults(cfg) {
  const pick = (key) => {
    const value = Number(cfg && cfg[key]);
    return Number.isFinite(value) && value > 0 ? value : DEFAULTS[key];
  };
  return {
    localVersion: String((cfg && cfg.localVersion) || DEFAULTS.localVersion),
    targetVersion: String((cfg && cfg.targetVersion) || DEFAULTS.targetVersion),
    seconds: pick('seconds'),
    chunks: Math.max(1, Math.round(pick('chunks'))),
    bytes: Math.round(pick('bytes')),
  };
}

/** 演练自己走到哪一步了：available（还没下）→ done（下好了）→ none（应用完了）。 */
function phase() {
  const saved = readJson(statePath());
  const value = saved && typeof saved.phase === 'string' ? saved.phase : '';
  return ['available', 'done', 'none'].includes(value) ? value : 'available';
}

function setPhase(value) {
  if (!simDir) return;
  try {
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ phase: value, updatedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {
    /* 写不进去也不影响本次演练 */
  }
}

function kindOf(gameKey) {
  return gameKey === 'endfield' ? 'endfield' : 'hoyo';
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 和真实实现同一套语义：暂停就原地等，停止就抛「已取消」。 */
async function waitTick(ms, signal) {
  let waited = 0;
  while (signal && signal.paused && !signal.cancelled) {
    await sleep(100);
    waited += 100;
    if (waited > 5 * 60 * 1000) break; // 别真挂死
  }
  if (signal && signal.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
  await sleep(ms);
  if (signal && signal.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
}

/** 演练用的一份 check 报告，字段和真实 report 对齐（stateFromReport 只认这些）。 */
function report(cfg, { gameKey } = {}) {
  const d = defaults(cfg);
  const forced = String((cfg && cfg.state) || '').trim();
  const current = forced || phase();
  const kind = kindOf(gameKey);
  const base = {
    supported: true,
    kind,
    localVersion: d.localVersion,
    targetVersion: d.targetVersion,
    latestVersion: d.localVersion,
    dir: SIM_DIR,
    completed: false,
  };
  const bytesGame = Math.round(d.bytes * 0.72);
  const bytesAudio = Math.round(d.bytes * 0.22);
  const bytesCategory = d.bytes - bytesGame - bytesAudio;
  const split = {
    bytesTotal: d.bytes,
    bytesGame,
    bytesAudio,
    bytesCategory,
    categoryCount: kind === 'endfield' ? 0 : 9,
    chunks: d.chunks,
  };

  if (current === 'done') {
    return {
      ...base,
      ...split,
      state: 'done',
      completed: true,
      bytesDone: d.bytes,
      storedFiles: d.chunks,
      storedBytes: d.bytes,
    };
  }
  if (current === 'update') {
    return { ...base, ...split, state: 'update', latestVersion: d.targetVersion };
  }
  if (current === 'unsupported') {
    return {
      ...base,
      state: 'unsupported',
      reason: String((cfg && cfg.reason) || '演练模式：这个渠道没有官方预下载包（原因文案测试）'),
    };
  }
  if (current === 'error') {
    return {
      ...base,
      state: 'error',
      error: String((cfg && cfg.error) || '演练模式：模拟一次官方接口读取失败'),
    };
  }
  if (current === 'none') {
    return { ...base, ...split, state: 'none', bytesTotal: 0, targetVersion: '' };
  }
  return { ...base, ...split, state: 'available' };
}

/** check 的替换品：关掉演练时原样转给真实实现。 */
async function check(options) {
  const cfg = configured(options);
  if (!cfg) return require('./predownload').check(options);
  return report(cfg, { gameKey: options && options.gameKey });
}

async function start(options) {
  const cfg = configured(options);
  if (!cfg) return require('./predownload').start(options);
  const { signal, onProgress, gameKey } = options || {};
  const d = defaults(cfg);
  const kind = kindOf(gameKey);
  const failAt = Number(cfg.failAt) || 0;
  const total = d.chunks;
  const totalBytes = d.bytes;
  let processed = 0;
  let bytesDone = 0;
  let skipped = 0;

  onProgress?.({ phase: 'version', current: `目标版本 ${d.targetVersion}` });
  await waitTick(500, signal);
  if (kind === 'endfield') {
    onProgress?.({ phase: 'version', current: `本地 ${d.localVersion} → 目标 ${d.targetVersion}` });
  } else {
    onProgress?.({
      phase: 'version',
      current: `本体 ${fmtBytes(d.bytes * 0.72)} + 语音 ${fmtBytes(d.bytes * 0.22)} + 剧情等分类资源 ${fmtBytes(
        d.bytes - Math.round(d.bytes * 0.72) - Math.round(d.bytes * 0.22)
      )}（9 类）`,
    });
  }
  await waitTick(600, signal);
  onProgress?.({ phase: 'manifest', current: '读取官方清单' });
  await waitTick(700, signal);
  onProgress?.({ phase: 'manifest', current: '比对本地版本清单' });
  await waitTick(500, signal);

  const stepMs = Math.max(8, Math.round((d.seconds * 1000) / total));
  // 每 1/8 左右假装命中一次缓存，界面上「复用 n」才有东西可显示（分块很少时也保证有几块）
  const reuseEvery = Math.max(4, Math.round(total / 8));
  for (let index = 0; index < total; index += 1) {
    await waitTick(stepMs, signal);
    processed = index + 1;
    if (failAt && (processed / total) * 100 >= failAt) {
      throw new Error(`网络中断：演练模式在 ${failAt}% 处主动失败`);
    }
    const reused = processed % reuseEvery === 0;
    if (reused) skipped += 1;
    bytesDone = Math.round((totalBytes * processed) / total);
    onProgress?.({
      phase: 'download',
      current: kind === 'endfield' ? `build_${String(processed).padStart(4, '0')}.zip` : `${(processed * 7919).toString(16)}.chunk`,
      processed,
      total,
      downloaded: processed - skipped,
      skipped,
      bytesDone,
      totalBytes,
    });
  }

  setPhase('done');
  return {
    ok: true,
    simulated: true,
    kind,
    gameKey,
    localVersion: d.localVersion,
    targetVersion: d.targetVersion,
    dir: SIM_DIR,
    chunks: total,
    downloaded: total - skipped,
    reused: skipped,
    totalBytes,
    applied: false,
  };
}

async function apply(options) {
  const cfg = configured(options);
  if (!cfg) return require('./predownload').apply(options);
  const { signal, onProgress, gameKey } = options || {};
  const d = defaults(cfg);
  const kind = kindOf(gameKey);

  if (kind === 'endfield') {
    // 终末地的应用是「解压 → 整理 → 写盘」三段，且都没有计数事件。
    // 这正是进度条最容易被写坏的地方：处理不对就会从 100% 跳回 0%。
    onProgress?.({ phase: 'extract', current: '解压预下载包' });
    await waitTick(1200, signal);
    onProgress?.({ phase: 'stage', current: '整理更新内容' });
    await waitTick(900, signal);
    onProgress?.({ phase: 'commit', current: '写入游戏目录' });
    await waitTick(1100, signal);
  } else {
    const total = 80;
    for (let index = 0; index < total; index += 1) {
      await waitTick(Math.max(8, Math.round((6000 * 1) / total)), signal);
      onProgress?.({
        phase: 'install',
        current: `校验并写入 ${(index + 1) * 3} 个文件`,
        processed: index + 1,
        total,
        bytesDone: Math.round((d.bytes * (index + 1)) / total),
        totalBytes: d.bytes,
      });
    }
  }

  setPhase('none');
  return {
    ok: true,
    simulated: true,
    kind,
    gameKey,
    version: d.targetVersion,
    tag: d.targetVersion,
  };
}

async function clear(options) {
  const cfg = configured(options);
  if (!cfg) return require('./predownload').clear(options);
  setPhase('available');
  return { ok: true, simulated: true, removed: 0 };
}

/**
 * 演练关掉之后，把之前写进 server.predownload 的假状态摘掉 ——
 * 否则卡片会一直挂着「可以预下载」，而官方根本没有这个版本。
 */
async function cleanup(store) {
  if (enabled() || !store || !store.data || !Array.isArray(store.data.games)) return false;
  let changed = false;
  for (const game of store.data.games) {
    for (const server of game.servers || []) {
      const info = server && server.predownload;
      if (info && typeof info === 'object' && String(info.dir || '').startsWith('sim://')) {
        server.predownload = null;
        changed = true;
      }
    }
  }
  if (changed) await store.saveNow().catch(() => {});
  return changed;
}

module.exports = {
  setup,
  enabled,
  config,
  report,
  check,
  start,
  apply,
  clear,
  cleanup,
  phase,
  DEFAULTS,
};
