'use strict';
/*
 * 右上角关闭按钮：首次询问「收进托盘 / 退出程序」，选完记住、以后照办。
 *
 * 两个层面都要验：
 * 1) 主进程 close 事件的决策表（真跑那段回调，假 event / win / store）
 *    —— 这里最容易写错：拦太死会「关不掉窗口」，放太松会「选了托盘还是退了」。
 * 2) 渲染层与 IPC 接线（静态断言）：询问框、两个按钮、设置页开关要同时写
 *    closeToTray 与 closeAction，否则开关看着变了、✕ 还是老行为。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/test-close-action.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const results = [];
const ok = (name, pass, detail) =>
  results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });

const mainSource = read('electron/main.js');
const preloadSource = read('electron/preload.js');
const appSource = read('src/app.js');
/* 第 14 批起设置页整段搬到 views/settings.js（说明文案在那边），
 * 第 15 批起 handleAction 整段搬到 views/actions.js（toggle-setting 分支在那边），
 * 所以界面侧断言要在这三个文件里合起来找，不能只看 app.js。 */
const settingsSource = read('src/views/settings.js');
/* 第 16 批起弹窗整段搬到 views/modals.js（openCloseChoiceDialog 在那边），
 * 询问框相关的断言改读 modalSource。 */
const modalSource = read('src/views/modals.js');
const actionsSource = read('src/views/actions.js');
const uiSource = appSource + '\n' + settingsSource + '\n' + actionsSource;

/* ── 1. 抽出 win.on('close') 的回调体，真跑决策 ─────────────────── */
const closeMatch = mainSource.match(/win\.on\('close', \(event\) => \{([\s\S]*?)\n  \}\);/);
ok('能抽到窗口 close 回调', Boolean(closeMatch));
ok('close 回调里不再直接读 closeToTray（改由 closeAction 决定）', closeMatch && !/closeToTray/.test(closeMatch[1]));

if (closeMatch) {
  const body = closeMatch[1];
  const runner = new Function(
    'event',
    'win',
    'store',
    'quitting',
    'saveWindowBounds',
    'flags',
    `
    let closeAskPending = flags.pending;
    let tray = flags.tray === false ? null : { /* 默认：托盘图标已装上 */ };
    try {${body}
    } finally { flags.pending = closeAskPending; }
    `
  );
  ok(
    '托盘缺失时 close 回调不会把窗口藏成孤儿',
    /action === 'tray' && tray/.test(closeMatch[1]),
    'close 回调没检查 tray 是否存在'
  );

  const makeWin = (opts = {}) => {
    const calls = { prevented: false, hidden: 0, sent: [] };
    const win = {
      calls,
      webContents: {
        isDestroyed: () => opts.destroyed === true,
        isLoading: () => opts.loading === true,
        send: (channel) => calls.sent.push(channel),
      },
      hide: () => {
        calls.hidden += 1;
      },
    };
    return win;
  };

  const run = (action, opts = {}) => {
    const win = makeWin(opts);
    const flags = { pending: opts.pending === true, tray: opts.tray };
    runner(
      { preventDefault: () => (win.calls.prevented = true) },
      win,
      { data: { settings: { closeAction: action } } },
      opts.quitting === true,
      () => {},
      flags
    );
    return { ...win.calls, pending: flags.pending };
  };

  // 选过「收进托盘」：拦住关闭 + hide，且不再问
  const tray = run('tray');
  ok('选过托盘：拦住 close 并收进托盘', tray.prevented === true && tray.hidden === 1, JSON.stringify(tray));
  ok('选过托盘：不再弹询问', tray.sent.length === 0, JSON.stringify(tray.sent));

  // 选过「退出」：放行，让窗口真关
  const quit = run('quit');
  ok('选过退出：不拦 close', quit.prevented === false, JSON.stringify(quit));
  ok('选过退出：不 hide（退进程走 window-all-closed）', quit.hidden === 0, JSON.stringify(quit));

  // 选了托盘但托盘图标没装上：不能 hide，否则窗口再也叫不回来
  const noTray = run('tray', { tray: false });
  ok('托盘不可用时按退出处理（不会把窗口藏成孤儿）', noTray.prevented === false && noTray.hidden === 0, JSON.stringify(noTray));

  // 还没选过：拦下来问一句
  const ask = run(null);
  ok('首次点关闭：先拦住窗口', ask.prevented === true, JSON.stringify(ask));
  ok('首次点关闭：发出询问事件', ask.sent.includes('window:close-ask'), JSON.stringify(ask.sent));
  ok('首次点关闭：记下「正在问」防重复', ask.pending === true, String(ask.pending));

  // 已经在问：连点关闭不叠第二个框
  const again = run(null, { pending: true });
  ok('连点关闭：不重复发询问', again.sent.length === 0, JSON.stringify(again.sent));

  // 页面还没加载完：没人接询问，必须放行，否则窗口关不掉
  const early = run(null, { loading: true });
  ok('页面未加载完：直接放行（否则关不掉）', early.prevented === false, JSON.stringify(early));

  // 渲染进程没了：同样放行
  const dead = run(null, { destroyed: true });
  ok('渲染进程已销毁：直接放行', dead.prevented === false, JSON.stringify(dead));

  // 正在退出：任何设置都不能拦
  const quitting = run('tray', { quitting: true });
  ok('正在退出：不被托盘设置拦住', quitting.prevented === false, JSON.stringify(quitting));
}

/* ── 2. 记住选择：IPC + 默认值 + 白名单 ─────────────────────────── */
ok('默认设置里有 closeAction（null = 没选过）', /closeAction:\s*null/.test(mainSource));
ok('有 window:close-choice 处理器', /ipcMain\.handle\('window:close-choice'/.test(mainSource));
ok('有 window:close-cancel 处理器（取消后能再问）', /ipcMain\.handle\('window:close-cancel'/.test(mainSource));
ok(
  '回答后同时写 closeAction 与 closeToTray',
  /settings\.closeAction = action;[\s\S]{0,120}settings\.closeToTray = action === 'tray'/.test(mainSource),
  '两个键没同步写'
);
ok(
  '回答「收进托盘」时也检查托盘是否存在',
  /action === 'tray' && tray/.test(mainSource),
  'close-choice 没检查 tray'
);
ok(
  '没勾「不再询问」时不写设置（只执行这一次，下次还会问）',
  /if \(remember\) \{[\s\S]{0,220}settings\.closeAction = action/.test(mainSource),
  'remember 没有拦住写盘'
);
ok(
  'settings:update 白名单放行 closeAction',
  /const allowed = \[[\s\S]{0,900}'closeAction'/.test(mainSource),
  '白名单里没有 closeAction'
);
ok(
  'closeAction 有专门校验（不能被 Boolean 兜底压成 true）',
  /key === 'closeAction'[\s\S]{0,260}patch\.closeAction === 'tray'/.test(mainSource),
  '缺 closeAction 的字符串校验分支'
);
ok(
  'window-all-closed 按 closeAction 判断去留',
  /window-all-closed'[\s\S]{0,320}closeAction !== 'tray'/.test(mainSource),
  'window-all-closed 还在读旧字段'
);

/* ── 3. preload 接线 ────────────────────────────────────────────── */
ok('preload 暴露 closeChoice', /closeChoice:\s*\(choice, remember = true\)/.test(preloadSource));
ok(
  'preload 把「是否记住」一起传过去',
  /ipcRenderer\.invoke\('window:close-choice', \{ action: choice, remember \}\)/.test(preloadSource),
  'closeChoice 只传了 action'
);
ok('preload 暴露 closeAskCancel', /closeAskCancel:\s*\(\) => ipcRenderer\.invoke\('window:close-cancel'/.test(preloadSource));
ok('preload 暴露 onCloseAsk 订阅', /onCloseAsk:\s*\(callback\) => subscribe\('window:close-ask'/.test(preloadSource));

/* ── 4. 渲染层：询问框 + 设置页开关 ─────────────────────────────── */
ok('有首次关闭的询问框', /function openCloseChoiceDialog\(\)/.test(modalSource));
ok('询问框里两个选项都在', /close-choice-tray/.test(modalSource) && /close-choice-quit/.test(modalSource));
ok(
  '询问框有「以后不再询问」勾选框，且默认勾上',
  /id="close-choice-remember" checked/.test(modalSource),
  '缺勾选框或没默认勾选'
);
ok(
  '勾选状态在关掉弹窗前读取（closeModal 会清空 DOM）',
  /const remember = document\.querySelector\('#close-choice-remember'\)\?\.checked !== false;[\s\S]{0,200}closeModal\(\)/.test(
    modalSource
  ),
  '读勾选的顺序不对'
);
ok(
  '选择时把 remember 一起交给主进程',
  /api\.closeChoice\?\.\(choice, remember\)/.test(modalSource),
  '没传 remember'
);
ok('询问框里保留去设置的入口', /设置 → 行为 → 关闭时收进托盘/.test(modalSource));
ok('订阅了 window:close-ask', /api\.onCloseAsk\(\(\) => \{/.test(appSource));
ok(
  '关掉询问框会放开询问锁（否则下次点 ✕ 没反应）',
  /onClose:\s*\(\) => api\.closeAskCancel\?\.\(\)/.test(modalSource),
  '缺 closeAskCancel 调用'
);
ok(
  '设置页改「关闭时收进托盘」会同时写两个键',
  /patch = \{ closeToTray: next, closeAction: next \? 'tray' : 'quit' \}/.test(uiSource),
  '设置页只写了一个键'
);
ok(
  '设置页文案点明「点 ✕ 后去哪改」',
  /第一次点 ✕ 时问过一次，之后都以这里为准/.test(uiSource),
  '设置页说明没更新'
);

/* ── 结果 ─────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : `  (${r.detail})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
