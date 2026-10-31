'use strict';
/*
 * 「移除链接导入的歌单」行为测试。
 *
 * 为什么专门测这个：
 *   1. 删除是**内存 + 磁盘**两件事，少一件就会「删完重启又回来」。
 *      主进程缓存写入是「合并写 + 空列表跳过」，删到某平台最后一张时，
 *      光靠 schedulePlaylistsCacheSave 是写不掉的（会被 continue 跳过），
 *      必须走 music:playlist-remove 按 id 精确剔除。
 *   2. 只能删 imported 的。账号同步来的歌单属于平台账号，本地删了下次同步就回来，
 *      给按钮反而让人以为「删了没生效」。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/test-playlist-remove.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
function ok(name, pass, detail = '') {
  if (pass) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const songPlaylist = read('src/views/song-playlist.js');
const songView = read('src/views/song-view.js');
const appSource = read('src/app.js');
/* 第 15 批起 handleAction 整段搬到 views/actions.js，'my-playlist-remove' 分支
 * 要从那边抽；appSource 保留，其它断言可能还会用到。 */
const actionsSource = read('src/views/actions.js');
const mainSource = read('electron/main.js');
const preloadSource = read('electron/preload.js');
const css = read('src/styles.css');

/* ── 1. 视图：按钮只挂在链接导入的卡片上 ─────────────────────────── */
console.log('\n[1] 卡片上的移除按钮');
const cardFn = (songView.match(/function playlistCardMarkup\([\s\S]*?\n\}/) || [''])[0];
ok('能找到 playlistCardMarkup', Boolean(cardFn));
ok('卡片里有 my-playlist-remove 动作', /data-action="my-playlist-remove"/.test(cardFn));
ok(
  '只有 imported 且非广场的卡片才渲染移除按钮',
  /const removable = item\.imported && !item\.plaza/.test(cardFn) && /\$\{\s*removable/.test(cardFn),
  '判断条件没写对'
);
ok(
  '移除按钮带 platform / id / name（弹确认框要用 name）',
  /data-platform="\$\{pplatform\}" data-id="\$\{pid\}" data-name="\$\{esc\(item\.name\)\}"/.test(cardFn),
  '少参数'
);
ok(
  '移除按钮与播放按钮是兄弟节点（button 不能嵌套 button）',
  /<\/button>\s*\$\{\s*removable/.test(cardFn),
  '可能被塞进了 playlist-card-body 里'
);
ok('样式里有 .playlist-card-del', /\.playlist-card-del \{/.test(css));
ok(
  '移除按钮 hover 才出现（和播放按钮一致）',
  /\.playlist-card:hover \.playlist-card-del/.test(css),
  '没写 hover 规则'
);

/* ── 2. 渲染层：removeImportedPlaylist ──────────────────────────── */
console.log('\n[2] removeImportedPlaylist 逻辑');
ok('函数存在', /async function removeImportedPlaylist\(platform, playlistId\)/.test(songPlaylist));
ok(
  '非 imported 直接拒绝',
  /if \(at < 0 \|\| !list\[at\]\?\.imported\) return false;/.test(songPlaylist),
  '缺少 imported 校验'
);
ok(
  '清掉详情缓存（否则重新导入同一张会先显示旧曲目）',
  /delete state\.myPlaylists\.detailCache\?\.\[playlistDetailCacheKey\(key, id\)\]/.test(songPlaylist)
);
ok(
  '正在看这张歌单时退出钻取态',
  /state\.myPlaylists\.detail = null;/.test(songPlaylist)
);
ok(
  '调主进程按 id 精确剔除',
  /api\.musicRemovePlaylist\?\.\(\{ platform: key, id \}\)/.test(songPlaylist),
  '没调 musicRemovePlaylist'
);
ok(
  '磁盘写失败要出声（不能静默）',
  /toast\('歌单已从列表移除，但本地缓存没写成功/.test(songPlaylist)
);

/* ── 3. 主进程 + preload：精确剔除 ─────────────────────────────── */
console.log('\n[3] 主进程与 preload');
ok('注册了 music:playlist-remove', /ipcMain\.handle\('music:playlist-remove'/.test(mainSource));
const removeIpc = (mainSource.match(/ipcMain\.handle\('music:playlist-remove'[\s\S]*?\n  \}\);/ ) || [''])[0];
ok('能抽出 handler 体', Boolean(removeIpc));
ok(
  '按 id 过滤（不是整组清空）',
  /group\.list\.filter\(\(item\) => String\(item\?\.id \|\| ''\) !== id\)/.test(removeIpc),
  '没按 id 过滤'
);
ok(
  '剔完为空就把这组从缓存里删掉',
  /delete cache\.data\.groups\[key\]/.test(removeIpc),
  '删空后没清组 → 旧快照会被读回来'
);
ok('剔完还有就写回', /cache\.data\.groups\[key\] = \{ \.\.\.group, list \}/.test(removeIpc));
ok('有保存动作', /cache\.save\(\)/.test(removeIpc));
ok(
  'platform 白名单校验',
  /PLAYLIST_CACHE_PLATFORMS\.includes\(key\)/.test(removeIpc),
  '没校验平台，可能写出脏 key'
);
ok(
  '缓存瘦身保留 imported 标记（丢了它重启后导入歌单会变「自建」且没有移除按钮）',
  /imported: Boolean\(item\?\.imported\)/.test(mainSource),
  'slimCachedPlaylists 把 imported 丢了'
);
ok(
  'preload 暴露 musicRemovePlaylist',
  /musicRemovePlaylist: \(payload\) => ipcRenderer\.invoke\('music:playlist-remove'/.test(preloadSource)
);

/* ── 4. 动作分发：二次确认 ─────────────────────────────────────── */
console.log('\n[4] 动作分发');
const removeCase = (actionsSource.match(/case 'my-playlist-remove': \{[\s\S]*?\n    \}/) || [''])[0];
ok('handleAction 里有 my-playlist-remove 分支', Boolean(removeCase));
ok('先二次确认再删', /await confirmDialog\(\{/.test(removeCase) && /if \(!confirmed\) break;/.test(removeCase));
ok('确认框是危险样式', /danger: true/.test(removeCase));
ok('确认后调 removeImportedPlaylist', /await removeImportedPlaylist\(removePlatform, removeId\)/.test(removeCase));
ok('删掉后给提示', /toast\('已从我的歌单移除', 'success'\)/.test(removeCase));

/* ── 5. 真跑：内存与磁盘两边都动 ───────────────────────────────── */
console.log('\n[5] 真跑 removeImportedPlaylist');
function anyStub() {
  return new Proxy(function () {}, {
    get(_t, key) {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
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

const calls = { remove: [], save: [], render: 0, toast: [] };
const state = {
  route: 'song',
  myPlaylists: {
    groups: [
      {
        platform: 'kugou',
        label: '酷狗',
        ok: true,
        list: [
          { id: 'g1', name: '导入一', imported: true },
          { id: 'g2', name: '导入二', imported: true },
        ],
      },
      {
        platform: 'netease',
        label: '网易云',
        ok: true,
        list: [{ id: 'n1', name: '我的收藏', imported: false, subscribed: true }],
      },
    ],
    detail: { id: 'g1', platform: 'kugou', songs: [] },
    detailCache: { 'kugou:g1': { detail: { id: 'g1' }, at: Date.now() } },
    plaza: {},
    syncing: {},
  },
};
const api = {
  musicRemovePlaylist: async (payload) => {
    calls.remove.push(payload);
    return { ok: true, removed: 1 };
  },
  musicSavePlaylistsCache: async (payload) => {
    calls.save.push(payload);
    return { ok: true };
  },
};

const ctx = vm.createContext({
  console,
  setTimeout: () => 0, // 不真跑防抖落盘，避免干扰断言
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  Date,
  Math,
  JSON,
  Promise,
  Map,
  Set,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Error,
  RegExp,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: anyStub(),
  window: {},
  state,
  api,
  render: () => {
    calls.render += 1;
  },
  toast: (message, kind) => calls.toast.push({ message, kind }),
  musicPlatformLabel: (platform) => platform,
  humanError: (error) => String(error?.message || error),
  esc: (value) => String(value ?? ''),
  icon: () => '',
});
vm.runInContext(songPlaylist, ctx, { filename: 'song-playlist.js' });

(async () => {
  const removed = await ctx.removeImportedPlaylist('kugou', 'g1');
  ok('删导入的歌单返回 true', removed === true, String(removed));
  const kugou = state.myPlaylists.groups.find((g) => g.platform === 'kugou');
  ok('内存里已经摘掉', kugou.list.length === 1 && kugou.list[0].id === 'g2', JSON.stringify(kugou.list));
  ok('磁盘收到了精确删除请求', calls.remove.length === 1 && calls.remove[0].platform === 'kugou' && calls.remove[0].id === 'g1', JSON.stringify(calls.remove));
  ok('清掉了这张歌单的详情缓存', !state.myPlaylists.detailCache['kugou:g1']);
  ok('正在看它就退出钻取态', state.myPlaylists.detail === null, JSON.stringify(state.myPlaylists.detail));
  ok('重绘了一次', calls.render === 1, String(calls.render));
  ok('没有误报失败提示', calls.toast.length === 0, JSON.stringify(calls.toast));

  // 删非导入的（账号歌单）：必须拒绝
  const before = calls.remove.length;
  const refused = await ctx.removeImportedPlaylist('netease', 'n1');
  ok('账号同步来的歌单不给删', refused === false, String(refused));
  ok('拒绝时不发删除请求', calls.remove.length === before);
  const netease = state.myPlaylists.groups.find((g) => g.platform === 'netease');
  ok('账号歌单还在', netease.list.length === 1 && netease.list[0].id === 'n1');

  // 不存在的 id
  ok('id 不存在返回 false', (await ctx.removeImportedPlaylist('kugou', 'nope')) === false);
  ok('平台不存在返回 false', (await ctx.removeImportedPlaylist('kuwo', 'x')) === false);

  // 删空：内存保留空组，磁盘那边由 IPC 删整组
  await ctx.removeImportedPlaylist('kugou', 'g2');
  const empty = state.myPlaylists.groups.find((g) => g.platform === 'kugou');
  ok('最后一首删完组还在（不把分组头也弄没）', Array.isArray(empty.list) && empty.list.length === 0);

  const total = passed + failed;
  console.log(`\n共 ${total} 项，通过 ${passed} 项，失败 ${failed} 项`);
  process.exitCode = failed ? 1 : 0;
})();
