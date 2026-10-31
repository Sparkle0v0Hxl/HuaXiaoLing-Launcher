'use strict';
/*
 * 「点歌单里的歌，后续按这张歌单顺序播」行为测试。
 *
 * 报障原话：「酷狗歌单点歌曲，点下一首又回到网易云的了」。
 * 根因是当时用 queuedSongIndex() 扫**整个队列**做模糊匹配（歌名+歌手），
 * 同一首歌如果早先被别的歌单解析过，就会命中旧队列那一条 ——
 * 播放位置和续播顺序全落回旧队列。现在匹配范围限定在这张歌单自己的那一段，
 * 段里没有就插到当前播放之后。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/test-playlist-queue.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const songPlaylist = read('src/views/song-playlist.js');

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

/* ── 1. 静态：不再扫全队列 ─────────────────────────────────────── */
console.log('\n[1] 点歌单里的歌时不再扫全队列');
ok('queuedSongIndex 已删除（它就是「回到网易云」的源头）', !/function queuedSongIndex/.test(songPlaylist));
ok('改用 playlistBlockRange 定位本歌单那一段', /function playlistBlockRange\(fromName\)/.test(songPlaylist));

const fromIndexFn = (songPlaylist.match(/async function playPlaylistFromIndex\([\s\S]*?\n\}/) || [''])[0];
ok('能抽出 playPlaylistFromIndex', Boolean(fromIndexFn));
ok(
  '在段内找歌（不是整个队列）',
  /for \(let i = block\.start; i >= 0 && i < block\.end; i \+= 1\)/.test(fromIndexFn),
  '循环范围没限定在 block 内'
);
ok(
  '没命中时插进队列，而不是甩到队尾',
  /const insertAt =\s*block\.start >= 0\s*\?\s*block\.end\s*:\s*Math\.min\(state\.songs\.length, \(Number\(state\.songIndex\) \|\| 0\) \+ 1\)/.test(
    fromIndexFn
  ),
  '插入位置计算不对'
);
ok('不再用「队尾 -1」那种追加写法', !/target = state\.songs\.length - 1/.test(fromIndexFn));
ok('入队时带上 insertAt', /insertAt,/.test(fromIndexFn));

/* ── 2. 真跑 playlistBlockRange ───────────────────────────────── */
console.log('\n[2] playlistBlockRange 认段');
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

const state = { route: 'song', myPlaylists: { groups: [], detailCache: {} }, songs: [] };
const ctx = vm.createContext({
  console,
  setTimeout: () => 0,
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
  api: anyStub(),
  render() {},
  toast() {},
  musicPlatformLabel: (platform) => platform,
  humanError: (error) => String(error?.message || error),
  esc: (value) => String(value ?? ''),
  icon: () => '',
});
vm.runInContext(songPlaylist, ctx, { filename: 'song-playlist.js' });

const pick = (title) => ({ title, origin: 'pick' });
const pl = (title, from) => ({ title, origin: 'playlist', from });

state.songs = [pick('观众点的歌'), pl('酷狗1', '酷狗歌单'), pl('酷狗2', '酷狗歌单'), pick('另一首'), pl('网易云1', '网易云歌单')];
let range = ctx.playlistBlockRange('酷狗歌单');
ok('认出酷狗那一段 [1,3)', range.start === 1 && range.end === 3, JSON.stringify(range));
ok(
  '只认第一段连续块（后面被隔开的同名单不算进来）',
  range.end === 3,
  '把整条队列里所有同名段拼成一段了'
);
const none = ctx.playlistBlockRange('不存在的歌单');
ok('没有这一段返回 -1', none.start === -1 && none.end === -1, JSON.stringify(none));
ok('空 from 按「歌单」这个名字找', ctx.playlistBlockRange('').start === -1);

// 关键场景：队列里只有网易云那批，点酷狗歌单 —— 必须认成「没有酷狗段」
state.songs = [pl('同名歌', '网易云歌单'), pl('网易云2', '网易云歌单')];
const kugouRange = ctx.playlistBlockRange('酷狗歌单');
ok('队列里只有别的歌单时，认成「没有本歌单段」', kugouRange.start === -1, JSON.stringify(kugouRange));

// 段在队首 / 队尾都要认
state.songs = [pl('A1', '甲'), pl('A2', '甲')];
ok('段在队首', ctx.playlistBlockRange('甲').start === 0 && ctx.playlistBlockRange('甲').end === 2);
state.songs = [pick('x'), pl('A1', '甲')];
ok('段在队尾', ctx.playlistBlockRange('甲').start === 1 && ctx.playlistBlockRange('甲').end === 2);

/* ── 3. playlistBlockEnd 与 range 口径一致 ───────────────────── */
console.log('\n[3] playlistBlockEnd 与 range 同口径');
state.songs = [pick('a'), pl('B1', '乙'), pl('B2', '乙'), pick('b')];
ok('从段首往后跳到段末', ctx.playlistBlockEnd(1, '乙') === 3, String(ctx.playlistBlockEnd(1, '乙')));
ok('段外位置原样返回', ctx.playlistBlockEnd(0, '乙') === 0, String(ctx.playlistBlockEnd(0, '乙')));

const total = passed + failed;
console.log(`\n共 ${total} 项，通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed ? 1 : 0;
