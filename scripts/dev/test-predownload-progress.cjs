'use strict';
/*
 * 预下载弹窗「进度」渲染测试（不需要真有版本可预下载）。
 *
 * 为什么需要它：真机验收预下载进度必须等官方放新版本，平时根本点不到那条路径。
 * 这里用一套最小 DOM 桩 + 假 IPC 事件，把真实的 openPredownloadModal / onProgress
 * 跑一遍，逐项断言进度条宽度、阶段文案、分块计数、体积/复用统计、jobId 过滤、
 * 按钮显隐、暂停/停止调用。
 *
 * 只覆盖渲染层（弹窗 DOM 更新），不覆盖主进程下载器与真实网络。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/test-predownload-progress.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

const readFile = (p) => fs.readFileSync(p, 'utf8');

/* fmtBytes 直接从 app.js 抽出来用，避免测试里另写一份跟实现漂移 */
const appSource = readFile(path.join(SRC, 'app.js'));
const fmtMatch = appSource.match(/function fmtBytes\(bytes\) \{[\s\S]*?\n\}/);
if (!fmtMatch) {
  console.error('[x] 没能从 app.js 抽到 fmtBytes');
  process.exit(1);
}

const prelude = `
${fmtMatch[0]}

const __results = [];
const __els = new Map();
const __calls = [];
let __modalHtml = '';
let __modalOptions = null;
let __listener = null;
let __toasts = [];

function __ok(name, pass, detail) {
  __results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
}
function __eq(name, actual, expected) {
  __ok(name, actual === expected, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

function __el(id) {
  if (!__els.has(id)) {
    __els.set(id, {
      id,
      style: {},
      textContent: '',
      innerHTML: '',
      disabled: false,
      dataset: {},
      __handlers: {},
      addEventListener(type, fn) { this.__handlers[type] = fn; },
      click() { if (this.__handlers.click) this.__handlers.click(); },
    });
  }
  return __els.get(id);
}

const document = {
  querySelector(sel) {
    const id = String(sel).replace(/^#/, '');
    // 只给弹窗内部元素造桩；其它选择器返回 null，被测代码里有 null 保护
    if (id.startsWith('pd-') || id === 'server-manager-list') {
      return id === 'server-manager-list' ? null : __el(id);
    }
    return null;
  },
  querySelectorAll() { return []; },
};

function openModal(html, options) {
  __modalHtml = String(html);
  __modalOptions = options || null;
}
function toast(message, kind) { __toasts.push([kind || 'info', String(message)]); }
function humanError(error) { return (error && error.message) || String(error); }

const state = {
  games: [
    {
      id: 'genshin',
      name: '原神',
      builtinKey: 'genshin',
      servers: [
        {
          id: 's1',
          name: '官服',
          active: true,
          exists: true,
          predownload: {
            state: 'available',
            localVersion: '6.1.0',
            targetVersion: '6.2.0',
            latestVersion: '6.1.0',
            bytesGame: 1073741824,
            bytesAudio: 209715200,
          },
        },
      ],
    },
  ],
  settings: {},
};

const api = {
  onPredownloadProgress(callback) {
    __listener = callback;
    return () => { __listener = null; };
  },
  predownload: {
    check: async (input) => { __calls.push(['check', input]); return { state: 'available' }; },
    start: async (input) => {
      __calls.push(['start', input]);
      const base = { jobId: input.jobId };
      const snapshots = [];

      // 1) 开始阶段（不带计数）
      if (__listener) __listener({ ...base, phase: 'start', current: '正在读取官方清单…' });
      snapshots.push({
        phase: __el('pd-phase').textContent,
        bar: __el('pd-bar').style.width,
        count: __el('pd-count').textContent,
      });

      // 2) 下载中：3/10 块、300MB/1GB、复用 4 个、命中缓存 12 块
      if (__listener) {
        __listener({
          ...base,
          phase: 'download',
          processed: 3,
          total: 10,
          bytesDone: 314572800,
          totalBytes: 1073741824,
          skipped: 4,
          reusedChunks: 12,
          current: 'data_0.pak',
        });
      }
      snapshots.push({
        phase: __el('pd-phase').textContent,
        bar: __el('pd-bar').style.width,
        count: __el('pd-count').textContent,
        stats: __el('pd-stats').textContent,
        current: __el('pd-current').textContent,
      });

      // 3) 终末地的「写入游戏目录」阶段必须有中文，不能退化成「处理中…」
      if (__listener) __listener({ ...base, phase: 'commit', current: '正在写盘' });
      snapshots.push({ phase: __el('pd-phase').textContent });

      // 4) 别的任务的进度必须被 jobId 过滤掉
      if (__listener) __listener({ jobId: 'someone-else', phase: 'download', processed: 99, total: 100 });
      snapshots.push({ countAfterForeign: __el('pd-count').textContent, barAfterForeign: __el('pd-bar').style.width });

      // 5) 完成：进度条必须强制 100%
      if (__listener) __listener({ ...base, phase: 'done', current: '预下载完成' });
      snapshots.push({ bar: __el('pd-bar').style.width, phase: __el('pd-phase').textContent });

      globalThis.__snapshots = snapshots;
      return { targetVersion: '6.2.0' };
    },
    apply: async (input) => { __calls.push(['apply', input]); return { tag: '6.2.0' }; },
    cancel: async (jobId) => { __calls.push(['cancel', jobId]); return { ok: true }; },
    pause: async (input) => { __calls.push(['pause', input]); return { ok: true }; },
  },
};
`;

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Math,
  Date,
  JSON,
  Map,
  Set,
  Promise,
  Number,
  String,
  Boolean,
  Object,
  Array,
  RegExp,
  Error,
  globalThis: null,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

vm.runInContext(prelude, sandbox, { filename: 'harness-prelude.ts' });
vm.runInContext(readFile(path.join(SRC, 'services', 'helpers.js')), sandbox, { filename: 'helpers.js' });
vm.runInContext(readFile(path.join(SRC, 'views', 'servers.js')), sandbox, { filename: 'servers.js' });

const testScript = `
(async () => {
  /* ---- 1. 打开弹窗 ---- */
  openPredownloadModal('genshin', 's1');
  __ok('弹窗已打开', __modalHtml.includes('预下载'), 'modalHtml 长度 ' + __modalHtml.length);
  __ok('含进度区', __modalHtml.includes('id="pd-progress"'), '');
  __ok('含开始按钮', __modalHtml.includes('id="pd-start"'), '');
  __ok('弹窗 HTML 含状态行「可以预下载」', __modalHtml.includes('可以预下载'), '');
  __ok('弹窗 HTML 含目标版本 6.2.0', __modalHtml.includes('6.2.0'), '');

  /* ---- 2. 点「开始预下载」→ 进度事件 ---- */
  __el('pd-start').click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const snaps = globalThis.__snapshots || [];
  __eq('共收到 5 次进度快照', snaps.length, 5);
  const startSnap = snaps[0] || {};
  const dl = snaps[1] || {};
  const commit = snaps[2] || {};
  const foreign = snaps[3] || {};
  const done = snaps[4] || {};

  // 「start / done」这类非计数阶段会把当前动作拼在阶段名后面，是设计如此
  __ok('start 阶段文案 = 准备中 · 当前动作', startSnap.phase === '准备中 · 正在读取官方清单…', startSnap.phase);
  // 弹窗 HTML 里进度条初始就是 width:0%，没有计数的事件不该去改写它（桩里保持 undefined 即证明未改写）
  __eq('start 阶段不改写进度条宽度', startSnap.bar, undefined);

  __ok('下载阶段文案 = 下载预下载内容', dl.phase === '下载预下载内容', dl.phase);
  __eq('3/10 块 → 进度条 30%', dl.bar, '30%');
  __eq('分块计数 3 / 10', dl.count, '3 / 10');
  __ok('体积统计 300 MB / 1 GB', dl.stats.includes('300 MB') && dl.stats.includes('1.0 GB'), dl.stats);
  __ok('统计含「复用 4」', dl.stats.includes('复用 4'), dl.stats);
  __ok('统计含「命中缓存 12 块」', dl.stats.includes('命中缓存 12 块'), dl.stats);
  __eq('当前文件 = data_0.pak', dl.current, 'data_0.pak');

  __eq('别的任务 jobId 被过滤（计数不变）', foreign.countAfterForeign, '3 / 10');
  __eq('别的任务 jobId 被过滤（进度不变）', foreign.barAfterForeign, '30%');

  __ok('commit 阶段有中文（写入游戏目录）', commit.phase.startsWith('写入游戏目录'), commit.phase);

  __eq('done 阶段进度条强制 100%', done.bar, '100%');
  __ok('done 阶段文案以「完成」开头', done.phase.startsWith('完成'), done.phase);

  /* ---- 3. 按钮显隐：状态变成 done 后应出「应用更新」 ---- */
  state.games[0].servers[0].predownload = { state: 'done', targetVersion: '6.2.0', storedFiles: 128, storedBytes: 268435456 };
  if (pdModalRepaint) pdModalRepaint();
  __eq('done 状态：应用更新按钮出现', __el('pd-apply').style.display, '');
  __eq('done 状态：开始按钮隐藏', __el('pd-start').style.display, 'none');
  __ok('done 状态：状态行显示「预下载已完成」', __el('pd-status').innerHTML.includes('预下载已完成'), '');

  /* ---- 4. 暂停 / 继续 ---- */
  __el('pd-pause').click();
  const pauseCall = __calls.filter((c) => c[0] === 'pause').pop();
  __ok('暂停调用了后端 pause(paused=true)', pauseCall && pauseCall[1] && pauseCall[1].paused === true, JSON.stringify(pauseCall));
  __eq('暂停后按钮变「继续」', __el('pd-pause').textContent, '继续');
  __el('pd-pause').click();
  const resumeCall = __calls.filter((c) => c[0] === 'pause').pop();
  __ok('继续调用了后端 pause(paused=false)', resumeCall && resumeCall[1] && resumeCall[1].paused === false, JSON.stringify(resumeCall));
  __eq('继续后按钮变回「暂停」', __el('pd-pause').textContent, '暂停');

  /* ---- 5. 停止 ---- */
  __el('pd-cancel').click();
  const cancelCall = __calls.filter((c) => c[0] === 'cancel').pop();
  __ok('停止调用了后端 cancel', !!cancelCall, JSON.stringify(cancelCall));

  /* ---- 6. 开始预下载成功后提示 ---- */
  __ok('完成后有成功提示', __toasts.some((t) => t[0] === 'success' && t[1].includes('预下载完成')), JSON.stringify(__toasts));

  return __results;
})()
`;

const results = vm.runInContext(testScript, sandbox, { filename: 'test.ts' });

results
  .then((list) => {
    let failed = 0;
    for (const item of list) {
      if (item.pass) {
        console.log('  PASS  ' + item.name);
      } else {
        failed += 1;
        console.log('  FAIL  ' + item.name + (item.detail ? '   → ' + item.detail : ''));
      }
    }
    console.log('\n共 ' + list.length + ' 项，通过 ' + (list.length - failed) + ' 项，失败 ' + failed + ' 项');
    process.exit(failed ? 1 : 0);
  })
  .catch((error) => {
    console.error('[x] 测试脚本抛错:', error && error.stack ? error.stack : error);
    process.exit(1);
  });
