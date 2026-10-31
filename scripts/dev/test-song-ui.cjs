'use strict';
/*
 * 音乐页「看着不对」的两处行为测试：歌词跟随的滚动目标 + 弹幕点歌的关键词解析。
 *
 * 为什么要单独测：
 * - 歌词那条以前用 line.offsetTop 算目标位置，而歌词容器没有 position，
 *   offsetTop 是按整页算的（多了一个页头高度），目标永远超出可滚范围、被夹到最底部，
 *   现象就是「歌词不会自动向下滚」。这里用假 rect 直接验数学，不需要真界面。
 * - 弹幕点歌以前只吃掉空白，「点歌：晴天」会把冒号当歌名去搜，必然搜不到，
 *   看起来就是「点歌没生效」。这里逐个写法验解析结果。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/test-song-ui.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const read = (p) => fs.readFileSync(p, 'utf8');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
const eq = (name, actual, expected) =>
  ok(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

/* ── 1. lyricScrollTop：从 views/song.js 里真加载 ─────────────────── */
const songSource = read(path.join(SRC, 'views', 'song.js'));
const songCtx = vm.createContext({ console, Date, Math, JSON });
vm.runInContext(songSource, songCtx, { filename: 'song.js' });
const lyricScrollTop = songCtx.lyricScrollTop || (songCtx.window && songCtx.window.lyricScrollTop);
ok('song.js 能加载出 lyricScrollTop', typeof lyricScrollTop === 'function', typeof lyricScrollTop);

if (typeof lyricScrollTop === 'function') {
  const mkBox = (top, height, scrollTop, scrollHeight) => ({
    scrollTop,
    clientHeight: height,
    scrollHeight,
    getBoundingClientRect: () => ({ top, height }),
  });
  const mkLine = (top, height = 24) => ({ getBoundingClientRect: () => ({ top, height }) });

  // 容器在页面 y=600 处（页头 600px），高 400；内容 2400 高 → 可滚 2000
  const box = mkBox(600, 400, 0, 2400);

  // 第一句：偏移 20px，居中需要 -168，必须夹到 0（不能出现负滚动）
  eq('第一句不产生负滚动', lyricScrollTop(box, mkLine(620)), 0);

  // 中间某句：相对偏移 800 → 800 - (400-24)/2 = 612
  eq('中间句滚到竖直居中', lyricScrollTop(box, mkLine(1400)), 612);

  // 第 50 句：相对偏移 2000 → 1812（不是 2600-188=2412，那是按整页算的老 bug）
  eq('靠后的句子按容器相对位置算', lyricScrollTop(box, mkLine(2600)), 1812);
  ok(
    '靠后的句子不会被夹到最底部（老 offsetTop 写法会）',
    lyricScrollTop(box, mkLine(2600)) < 2000,
    lyricScrollTop(box, mkLine(2600))
  );

  // 最后一句：目标超出 max 时必须夹到 max
  eq('超出范围夹到最大滚动量', lyricScrollTop(box, mkLine(3600)), 2000);

  // 同一个相对位置、不同页头高度 → 结果必须一致（证明与 offsetParent 无关）
  const boxNoHeader = mkBox(0, 400, 0, 2400);
  eq('页头高度不影响结果', lyricScrollTop(boxNoHeader, mkLine(800)), lyricScrollTop(box, mkLine(1400)));

  // 已经滚过一段时，按当前 scrollTop 继续算增量
  const boxScrolled = mkBox(600, 400, 400, 2400);
  eq('已滚过时按当前偏移算增量', lyricScrollTop(boxScrolled, mkLine(1400)), 1012);

  // 歌词比容器还短：可滚 0，任何一句都只能是 0
  eq('内容不够高时不滚', lyricScrollTop(mkBox(600, 400, 0, 300), mkLine(1000)), 0);
}

/* ── 2. parseSongRequest：从音乐相关文件里抽函数体 ─────────────────
 * 第 10 批把直播间点歌搬到了 views/song-playlist.js，这里改成在「app.js +
 * song-playlist.js」里找，以后再搬家不会再误报失败。 */
const appSource = read(path.join(SRC, 'app.js'));
const playlistSource = read(path.join(SRC, 'views', 'song-playlist.js'));
const musicSources = `${appSource}\n${playlistSource}`;
const parseMatch = musicSources.match(/function parseSongRequest\(message\) \{[\s\S]*?\n\}/);
ok('能从音乐相关文件抽到 parseSongRequest', Boolean(parseMatch), 'app.js / views/song-playlist.js 里都没有');
if (parseMatch) {
  const fn = new Function(`${parseMatch[0]}; return parseSongRequest;`)();
  eq('点歌 + 空格', fn('点歌 晴天'), '晴天');
  eq('点歌 + 全角冒号', fn('点歌：晴天'), '晴天');
  eq('点歌 + 半角冒号', fn('点歌:晴天'), '晴天');
  eq('点歌 + 逗号', fn('点歌，晴天'), '晴天');
  eq('点歌 + 句号结尾', fn('点歌 晴天。'), '晴天');
  eq('点播也算，带前后空格', fn('  点播 晴天  '), '晴天');
  eq('点歌连着歌名', fn('点歌晴天'), '晴天');
  eq('不是点歌指令', fn('这首歌真好听'), '');
  eq('只有指令没有歌名', fn('点歌'), '');
  eq('指令 + 空白', fn('点歌   '), '');
  eq('空消息', fn(''), '');
  eq('null 不炸', fn(null), '');
  ok('超长关键词截到 60', fn(`点歌 ${'啊'.repeat(100)}`).length === 60, fn(`点歌 ${'啊'.repeat(100)}`).length);
}

/* ── 3. 拖动绑定必须覆盖所有 [data-mini-drag]（含手柄）─────── */
ok(
  '拖动绑定用 querySelectorAll 覆盖全部手柄',
  /querySelectorAll\('\[data-mini-drag\]'\)/.test(songSource),
  '没找到 querySelectorAll([data-mini-drag])'
);
ok(
  '拖动位移走 transform（left/top 是布局属性，每帧写会跟不上手）',
  /translate3d\(\$\{x - drag\.baseX\}px, \$\{y - drag\.baseY\}px, 0\)/.test(songSource),
  '没找到 translate3d 的拖动位移写法'
);
ok(
  '松手时把位移落回 left/top（否则后续 clamp/归位全偏一个位移量）',
  /setProperty\('left', `\$\{Math\.round\(lastX\)\}px`, 'important'\)/.test(songSource),
  '没找到松手后写 left 的代码'
);
ok(
  '拖动时捕获指针（甩出窗口也不丢 pointermove/up）',
  /setPointerCapture\(drag\.pointerId\)/.test(songSource),
  '没找到 setPointerCapture'
);
ok(
  '拖动中复用按下时量好的尺寸（避免每帧 offsetWidth 强制同步布局）',
  /clampMiniPosition\([\s\S]{0,160}drag\.size\s*\)/.test(songSource),
  'clampMiniPosition 没传 drag.size'
);

/* ── 3b. 按下不能吞掉 click（「迷你播放器展开不了」的回归）─────────
 *
 * 上一版为了跟手，在 pointerdown 里就 setPointerCapture + 把窄条 appendChild
 * 到 body。两件事都会让 click 丢 target：捕获会把 click 目标改写成捕获元素，
 * 搬家会让浏览器认为 down/up 不同源、干脆不派发。结果窄条上「展开 / 播放 /
 * 下一首」全成了死按钮。约束：这两步只能在确认拖动（位移 > 3px）之后做。
 */
const sliceArrowFn = (name) => {
  const start = songSource.indexOf(`const ${name} = `);
  if (start < 0) return '';
  const end = songSource.indexOf('\n  };', start);
  return end < 0 ? '' : songSource.slice(start, end + 5);
};
const startDragBody = sliceArrowFn('startDrag');
const moveBody = sliceArrowFn('move');
ok('能定位到 startDrag 函数体', startDragBody.length > 100, startDragBody.length);
ok('能定位到 move 函数体', moveBody.length > 100, moveBody.length);
ok(
  'pointerdown 阶段不捕获指针（否则 click 的 data-action 全失效）',
  startDragBody && !/setPointerCapture/.test(startDragBody),
  'startDrag 里仍在 setPointerCapture'
);
ok(
  'pointerdown 阶段不把窄条搬出槽（否则 click 不派发）',
  startDragBody && !/appendChild/.test(startDragBody),
  'startDrag 里仍在 appendChild'
);
ok(
  '确认拖动后才脱槽（detachForDrag 在 move 的首次位移分支里）',
  /moved = true;[\s\S]{0,120}detachForDrag\(\)/.test(moveBody) &&
    /const detachForDrag = \(\) => \{[\s\S]{0,400}appendChild/.test(songSource),
  'move 里没有先 detachForDrag()，或 detachForDrag 没做脱槽'
);
ok(
  '滑块 / 输入框永远不参与拖动（音量、进度要能按住调）',
  /closest\('input, select, textarea'\)/.test(startDragBody),
  'startDrag 没无条件排除 input/select/textarea'
);
ok(
  '缩起来的窄条整体可拖（按钮占满宽度，只在缝里能拖 = 「时不时能拖」）',
  /const inChip = Boolean\(event\.target\.closest\('#mini-chip'\)\)/.test(startDragBody) &&
    /!inChip/.test(startDragBody),
  'startDrag 没给 #mini-chip 内部开拖动例外'
);
ok(
  '展开卡里的按钮仍不启动拖动（只有握把 / 标题 / 空白能拖）',
  /const control = event\.target\.closest\('button, a, \[data-action\]'\)/.test(startDragBody) &&
    /!control\.hasAttribute\('data-mini-drag'\)/.test(startDragBody),
  '展开卡按钮没被排除'
);
ok(
  '显式拖动手柄与卡片标题仍可拖（握把 data-mini-drag / .mini-copy）',
  /hasAttribute\('data-mini-drag'\)/.test(startDragBody) &&
    /classList\.contains\('mini-copy'\)/.test(startDragBody),
  '手柄 / 标题例外没写'
);
ok(
  '拖动中 applyMiniPosition 不重写坐标（否则拖一半被拽回旧位置）',
  /function applyMiniPosition\([\s\S]{0,600}classList\.contains\('dragging'\)\) return;/.test(songSource),
  'applyMiniPosition 没有跳过拖动中的重排'
);

/* ── 结果 ─────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  const mark = r.pass ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${r.name}${r.pass || !r.detail ? '' : `  (${r.detail})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
