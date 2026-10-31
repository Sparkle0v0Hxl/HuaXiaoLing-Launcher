'use strict';
/*
 * 启动页预下载入口的「出现时机」测试。
 *
 * 用户 2026-10-31 定的规则，原话：
 *   「正常不显示出来，有预下载的时候，显示出来在开始游戏上面，
 *     正式更新的时候，也直接关掉，直接开始游戏变成更新游戏，点更新游戏更新」
 *
 * 这里逐条断言：平时 / 正式更新 / 不支持 / 没客户端目录 → 一个字都不输出；
 * 有预下载（available）与已下好（done）→ 出按钮，且文案分别正确；
 * 同时验「正式更新时主按钮变成更新游戏」这条联动。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/test-start-dock-predownload.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const read = (file) => fs.readFileSync(file, 'utf8');

const fmtMatch = read(path.join(SRC, 'app.js')).match(/function fmtBytes\(bytes\) \{[\s\S]*?\n\}/);
if (!fmtMatch) {
  console.error('[x] 没能从 app.js 抽到 fmtBytes');
  process.exit(1);
}

const prelude = `
${fmtMatch[0]}

const __results = [];
function __ok(name, pass, detail) {
  __results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
}
function __eq(name, actual, expected) {
  __ok(name, actual === expected, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}
const document = { querySelector() { return null; }, querySelectorAll() { return []; } };
function openModal() {}
function toast() {}
function humanError(error) { return (error && error.message) || String(error); }
const state = { games: [], settings: {}, gameUpdate: null };
const api = { predownload: { check: async () => ({}), start: async () => ({}), apply: async () => ({}), cancel: async () => ({}), pause: async () => ({}), clear: async () => ({}), setStoryResources: async () => ({}) } };

/* 造一款「已接入预下载、已安装」的游戏；info 传 null 表示还没查过 */
function makeGame(builtinKey, channel, info) {
  return {
    id: 'g-' + builtinKey,
    name: builtinKey,
    builtinKey,
    builtin: true,
    installed: true,
    servers: [{ id: 's-1', name: '服', channel, active: true, root: 'D:/Game', predownload: info || null }],
  };
}
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
vm.runInContext(prelude, sandbox, { filename: 'harness.ts' });
vm.runInContext(read(path.join(SRC, 'services', 'helpers.js')), sandbox, { filename: 'helpers.js' });
vm.runInContext(read(path.join(SRC, 'views', 'servers.js')), sandbox, { filename: 'servers.js' });
// 主按钮（开始游戏 / 更新游戏）在 home.js 里，正式更新那条联动要一起验
vm.runInContext(read(path.join(SRC, 'views', 'home.js')), sandbox, { filename: 'home.js' });

const test = `
(() => {
  /* 1. 平时（官方暂未开放）→ 不显示 */
  __eq('官方暂未开放：不渲染', startDockPredownload(makeGame('genshin', 'official', {
    state: 'none', localVersion: '7.1.0', latestVersion: '7.1.0',
  })), '');
  __eq('还没查过：不渲染', startDockPredownload(makeGame('genshin', 'official', null)), '');
  __eq('没读到客户端版本：不渲染', startDockPredownload(makeGame('genshin', 'official', { state: 'not-installed' })), '');
  __eq('状态读取失败：不渲染', startDockPredownload(makeGame('genshin', 'official', { state: 'error', error: 'X' })), '');
  __eq('不支持预下载：不渲染', startDockPredownload(makeGame('neverness', 'official', { state: 'unsupported' })), '');

  /* 2. 有预下载 → 显示在开始游戏上面 */
  const available = makeGame('genshin', 'official', {
    state: 'available', localVersion: '7.1.0', targetVersion: '7.2.0', latestVersion: '7.1.0',
    bytesTotal: 20937965568, bytesGame: 16165142528, bytesAudio: 4940873728,
  });
  const html = startDockPredownload(available);
  __ok('有预下载：出按钮', html.includes('class="start-dock-pd"'), html.slice(0, 90));
  __ok('有预下载：文案是「预下载新版本」', html.includes('预下载新版本'), html.slice(0, 200));
  __ok('有预下载：带目标版本 7.2.0', html.includes('7.2.0'), html.slice(0, 300));
  __ok('有预下载：带体积', html.includes('GB'), html.slice(0, 300));
  __ok('有预下载：点击直达面板', html.includes('data-action="open-predownload"'));
  __ok('有预下载：没掺进乱七八糟的常驻占位', !html.includes('start-dock-pd-quiet'));

  /* 3. 已经下好 → 「安装预下载的版本」 */
  const done = startDockPredownload(makeGame('genshin', 'official', {
    state: 'done', targetVersion: '7.2.0', storedBytes: 1073741824, storedFiles: 320,
  }));
  __ok('已下好：文案是「安装预下载的版本」', done.includes('安装预下载的版本'), done.slice(0, 200));
  __ok('已下好：显示已下体积', done.includes('已下'), done.slice(0, 300));

  /* 4. 正式更新：预下载入口关掉，主按钮变成「更新游戏」 */
  const updateGame = makeGame('genshin', 'official', {
    state: 'update', localVersion: '7.1.0', latestVersion: '7.2.0', targetVersion: '7.2.0',
  });
  __eq('正式更新：预下载入口消失', startDockPredownload(updateGame), '');
  const primary = startDockDownloadActions(updateGame);
  __ok('正式更新：主按钮变成「更新游戏」', primary.includes('更新游戏'), primary.slice(0, 160));
  __ok('正式更新：不再显示「开始游戏」', !primary.includes('开始游戏'), primary.slice(0, 160));
  __ok('正式更新：点它走 start-update-game', primary.includes('data-action="start-update-game"'));

  /* 5. 正常（无预下载）时主按钮仍是开始游戏 */
  const normal = startDockDownloadActions(makeGame('genshin', 'official', { state: 'none' }));
  __ok('平时：主按钮是「开始游戏」', normal.includes('开始游戏'), normal.slice(0, 160));
  __ok('平时：不会变成更新游戏', !normal.includes('更新游戏'), normal.slice(0, 160));

  /* 6. 崩坏3 只有官服有入口 */
  __ok('崩坏3 官服有入口', startDockPredownload(makeGame('bh3', 'official', { state: 'available', targetVersion: '9.2.0' })).includes('start-dock-pd'));
  __eq('崩坏3 B服无入口', startDockPredownload(makeGame('bh3', 'bilibili', { state: 'available' })), '');
  __eq('崩坏3 国际服无入口', startDockPredownload(makeGame('bh3', 'global', { state: 'available' })), '');

  /* 7. 没客户端目录 / 没接入预下载 → 不渲染 */
  const noRoot = makeGame('genshin', 'official', { state: 'available', targetVersion: '7.2.0' });
  noRoot.servers[0].root = '';
  __eq('没有客户端目录：不渲染', startDockPredownload(noRoot), '');
  __eq('明日方舟（未接入）：不渲染', startDockPredownload(makeGame('arknights', 'official', { state: 'available' })), '');

  /* 8. 卡片入口同样受渠道与目录约束 */
  __eq('卡片入口：崩坏3 B服无入口', cardPredownloadEntry(makeGame('bh3', 'bilibili', { state: 'available' })), '');
  __ok('卡片入口：原神有入口', cardPredownloadEntry(makeGame('genshin', 'official', { state: 'none' })).includes('pd-card-entry'), '');

  /*
   * 9. 下了一半（用户 2026-10-31 追问「预下载下了一半没继续咋办」）
   *    后端在 available 时会额外给 partial + storedBytes，按钮必须改口叫「继续」，
   *    而且要说清已经下了多少、还差多少，别让人以为上次白下。
   */
  const half = {
    state: 'available', localVersion: '7.1.0', targetVersion: '7.2.0', latestVersion: '7.1.0',
    bytesTotal: 20937965568, partial: true, storedBytes: 8589934592, storedFiles: 120,
  };
  const halfHtml = startDockPredownload(makeGame('genshin', 'official', half));
  __ok('下了一半：按钮说「继续预下载」', halfHtml.includes('继续预下载'), halfHtml.slice(0, 200));
  __ok('下了一半：不再说「预下载新版本」', !halfHtml.includes('预下载新版本'), halfHtml.slice(0, 200));
  __ok('下了一半：显示已下 8 GB', halfHtml.includes('已下') && halfHtml.includes('8.0 GB'), halfHtml.slice(0, 300));
  __ok('下了一半：显示还差多少', halfHtml.includes('还差'), halfHtml.slice(0, 300));
  __ok('下了一半：title 说明会接着下', halfHtml.includes('接着下'), halfHtml.slice(0, 400));

  /* partial 但 storedBytes 为 0（目录被清空）时不能假装有进度 */
  const emptyPartial = startDockPredownload(makeGame('genshin', 'official', {
    state: 'available', targetVersion: '7.2.0', partial: true, storedBytes: 0, storedFiles: 0,
  }));
  __ok('假 partial（没有字节）：仍说「预下载新版本」', emptyPartial.includes('预下载新版本'), emptyPartial.slice(0, 200));

  /* 范围变过（语音 / 剧情开关）不算可续传，不能说「接着下」 */
  const scopeChanged = startDockPredownload(makeGame('genshin', 'official', {
    state: 'available', targetVersion: '7.2.0', scopeChanged: true, storedBytes: 8589934592, storedFiles: 120,
  }));
  __ok('改了范围：不承诺续传', !scopeChanged.includes('继续预下载'), scopeChanged.slice(0, 200));

  /* 10. 状态行文案：把「下了一半」和「正式版上线后分块复用」说清楚 */
  __ok('状态行（下了一半）：提到接着下', predownloadDetail(half, false).includes('接着下'), predownloadDetail(half, false));
  __ok('状态行（下了一半）：带已下体积', predownloadDetail(half, false).includes('8.0 GB'), predownloadDetail(half, false));
  __ok('状态行（下了一半）：带分块数', predownloadDetail(half, false).includes('120'), predownloadDetail(half, false));
  __ok(
    '状态行（改了范围）：说明要重新核对',
    predownloadDetail({ state: 'available', scopeChanged: true, storedBytes: 1073741824 }, false).includes('重新核对'),
    predownloadDetail({ state: 'available', scopeChanged: true, storedBytes: 1073741824 }, false)
  );
  const upd = { state: 'update', localVersion: '7.1.0', latestVersion: '7.2.0', storedBytes: 8589934592 };
  __ok('状态行（正式版上线）：说分块直接复用', predownloadDetail(upd, false).includes('直接复用'), predownloadDetail(upd, false));
  __ok('状态行（正式版上线）：仍提醒用应用更新', predownloadDetail(upd, false).includes('应用更新'), predownloadDetail(upd, false));
  const leftover = { state: 'none', storedBytes: 2147483648 };
  __ok('状态行（官方撤了但有残留）：提示可以清除', predownloadDetail(leftover, false).includes('清除'), predownloadDetail(leftover, false));
  __ok('状态行（没有残留）：不提清除', !predownloadDetail({ state: 'none' }, false).includes('清除'), predownloadDetail({ state: 'none' }, false));

  return __results;
})()
`;

const list = vm.runInContext(test, sandbox, { filename: 'test.ts' });
let failed = 0;
for (const item of list) {
  if (item.pass) console.log('  PASS  ' + item.name);
  else {
    failed += 1;
    console.log('  FAIL  ' + item.name + (item.detail ? '   → ' + item.detail : ''));
  }
}
console.log(`\n共 ${list.length} 项，通过 ${list.length - failed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
