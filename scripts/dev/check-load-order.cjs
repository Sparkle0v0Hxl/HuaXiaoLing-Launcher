'use strict';
/*
 * 加载顺序检查（前后端分离每批必跑）。
 *
 * 为什么需要：
 *   1. V8 `--check` 只查语法，`check-script-globals.cjs` 只查重复声明 ——
 *      两者都发现不了「前面的文件在顶层读了后面的文件才声明的名字」。
 *   2. 本项目用 classic script，service/view 文件排在 app.js 之前。若某个 view
 *      在**顶层**（不是函数体里）写了 `dom.xxx` / `state.xxx`，加载到那行就是
 *      ReferenceError，该文件从这里整个中断：后面的函数声明因为是提升的还能用，
 *      所以界面看起来正常，只有那几行副作用（绑定监听器、注册定时器）静默丢失。
 *      第 10 批就是这么翻出 views/chrome.js 里一个从第 4 批起就没生效过的监听器。
 *
 * 做法：按 index.html 的真实顺序，在同一个 VM 上下文里把每个脚本真跑一遍
 *      （app.js 会跑完整 bootstrap，跳过它 —— 它排最后，本来也没有后置依赖）。
 *      任何文件抛错即 FAIL，并打印出错文件与首行堆栈。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/check-load-order.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/* ── DOM / 浏览器 API 万能桩：任何属性都是可调用、可赋值的空对象 ─────── */
function anyStub() {
  return new Proxy(function () {}, {
    get(_target, key) {
      if (key === 'then') return undefined; // 别让桩被当成 Promise
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'toString') return () => '';
      if (key === 'length') return 0;
      return anyStub();
    },
    apply() {
      return anyStub();
    },
    construct() {
      return anyStub();
    },
    set() {
      return true;
    },
    has() {
      return true;
    },
  });
}

function makeContext() {
  /* document 单独做一个桩：
   *   · readyState 固定 'loading'（脚本在 </body> 前执行时真机就是这个值），
   *     否则「推迟到 DOMContentLoaded 再碰 dom」这种正确写法会被误判成错误；
   *   · addEventListener 只记录不触发 —— 加载期检查不看回调体，
   *     那时 app.js 已经跑完、dom 已经存在，属于运行期。 */
  const listeners = [];
  const doc = new Proxy(function () {}, {
    get(_target, key) {
      if (key === 'readyState') return 'loading';
      if (key === 'addEventListener') return (type, fn, opts) => listeners.push({ type, fn, opts });
      if (key === 'removeEventListener') return () => {};
      if (key === 'then') return undefined;
      return anyStub();
    },
    set() {
      return true;
    },
    has() {
      return true;
    },
  });

  const ctx = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    Date,
    Math,
    JSON,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    Proxy,
    Reflect,
    Error,
    RegExp,
    Array,
    Object,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: doc,
    navigator: anyStub(),
    location: anyStub(),
    performance: { now: () => 0 },
    Audio: anyStub(),
    Image: anyStub(),
    fetch: () => Promise.resolve(anyStub()),
  });
  ctx.window = ctx; // classic script 里 window 就是全局
  ctx.globalThis = ctx;
  return ctx;
}

/* ── 按 index.html 的真实顺序取脚本 ──────────────────────────────────── */
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const order = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
if (!order.length) {
  console.error('FAIL  index.html 里没找到任何 <script src>');
  process.exit(1);
}

/* 按顺序在**同一个**上下文里逐个跑：前面的声明对后面可见，正是真机行为。 */
const ctx = makeContext();
const results = [];
let failed = 0;
for (const rel of order) {
  if (/^https?:/.test(rel)) {
    results.push({ rel, status: 'skip', detail: '外部脚本' });
    continue;
  }
  /* app.js 会执行 bootstrap（读真实 DOM、订阅状态、拉数据），桩撑不住；
   * 它排最后，本来也不存在「后置依赖」风险，跳过即可。 */
  if (rel === 'app.js') {
    results.push({ rel, status: 'skip', detail: 'bootstrap，跳过（排最后）' });
    continue;
  }
  const file = path.join(SRC, rel);
  if (!fs.existsSync(file)) {
    failed += 1;
    results.push({ rel, status: 'fail', detail: '文件不存在' });
    continue;
  }
  const code = fs.readFileSync(file, 'utf8');
  try {
    vm.runInContext(code, ctx, { filename: rel });
    results.push({ rel, status: 'pass' });
  } catch (error) {
    failed += 1;
    const stack = String((error && error.stack) || '').split('\n');
    const where = stack.find((line) => line.includes(rel) && /:\d+/.test(line)) || stack[0] || '';
    results.push({ rel, status: 'fail', detail: `${error && error.message} @ ${where.trim()}` });
  }
}

/* ── 输出 ─────────────────────────────────────────────────────────────── */
console.log('加载顺序检查（按 index.html 顺序真跑，跳过 app.js）\n');
for (const item of results) {
  const tag = item.status === 'pass' ? 'PASS' : item.status === 'fail' ? 'FAIL' : 'SKIP';
  console.log(`  ${tag}  ${item.rel}${item.detail ? `  — ${item.detail}` : ''}`);
}
const stat = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
console.log(`\n共 ${results.length} 个脚本：通过 ${stat.pass || 0}，失败 ${stat.fail || 0}，跳过 ${stat.skip || 0}`);
if (failed) {
  console.log('\n失败意味着该文件加载到那行就中断了：后面的函数声明还能用（提升），');
  console.log('但那几行副作用（监听器 / 定时器 / 初始化）静默丢失 —— 必须改成延迟执行。');
  process.exit(1);
}
console.log('\n加载顺序检查全部通过。');
