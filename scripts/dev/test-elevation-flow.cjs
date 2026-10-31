'use strict';
/*
 * 终末地 / 明日方舟启动权限链路：不能再「每开一次游戏弹一次 UAC」。
 *
 * 背景（实测，不是猜的）：非提权创建游戏进程直接
 *   failed to create game process (740)   —— ERROR_ELEVATION_REQUIRED
 * 所以 740 是官方客户端的硬限制，唯一能省掉的是「每次都问」：让启动器自己
 * 以管理员运行，提权一次、整场免问。这个脚本盯的是那条链路别被改回去。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const mainSource = read('electron/main.js');
const preloadSource = read('electron/preload.js');
const actionsSource = read('src/views/actions.js');
const appSource = read('src/app.js');
const settingsSource = read('src/views/settings.js');

const results = [];
const ok = (name, pass) => results.push({ name, pass: Boolean(pass) });

ok('首次遇到提权游戏先问一次，不直接弹 UAC', /if \(requireElevation && !isElevated && store\.data\.settings\.elevationAsked !== true\) \{/.test(mainSource));
ok('问之前就返回，后面才轮到 UAC 方案', /elevationUndecided: true[\s\S]{0,400}const plans = requireElevation/.test(mainSource));
ok('默认不预设管理员，也不预设「问过了」', /alwaysAdmin: null,/.test(mainSource) && /elevationAsked: false,/.test(mainSource));
ok('elevationAsked 进设置白名单（否则界面写不进去）', /'elevationAsked',/.test(mainSource));
ok('提权重启可以带上「重启后开哪个游戏」', /String\(input\?\.launchGameId \|\| ''\)/.test(mainSource) && /pendingLaunchGameId = gameId/.test(mainSource));
ok('页面加载完后接着开游戏', /setTimeout\(\(\) => resumePendingLaunch\(\), 1600\)/.test(mainSource));
ok('没提权成功就不自动开（避免白开一次又失败）', /async function resumePendingLaunch\(\)[\s\S]{0,600}if \(!currentElevation\(\)\) return;/.test(mainSource));
ok('preload 把 launchGameId 透传下去', /relaunchAdmin: \(input\) => ipcRenderer\.invoke\('app:relaunch-admin', input\)/.test(preloadSource));
ok('preload 提供 game:autolaunch 订阅', /onGameAutolaunch: \(callback\) => subscribe\('game:autolaunch', callback\)/.test(preloadSource));
ok('渲染层两边都记住选择（不再反复问）', /await api\.updateSettings\(\{ elevationAsked: true, alwaysAdmin: useAdmin === true \}\)/.test(actionsSource));
ok('点「以管理员重启」时把游戏 id 带上', /api\.relaunchAdmin\(\{ launchGameId: id \}\)/.test(actionsSource));
ok('自动续开走同一条 launch-game 动作', /api\.onGameAutolaunch\([\s\S]{0,260}handleAction\('launch-game', gameId\)/.test(appSource));
ok('设置页写清「第一次会问一次」', /第一次点「开始游戏」时会问你一次/.test(settingsSource));
ok('不再有「记住并重启」的老文案', !/记住并重启/.test(actionsSource));

const failed = results.filter((item) => !item.pass);
for (const item of failed) console.log(`  FAIL ${item.name}`);
console.log(`\n启动权限流程：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
