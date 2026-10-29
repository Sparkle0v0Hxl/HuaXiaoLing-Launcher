/*
 * 把多尺寸 .ico 写进 exe 的 PE 资源（RT_ICON / RT_GROUP_ICON）。
 *
 * 为什么必须改 exe：Windows 任务栏上「正在运行的应用」图标，优先用窗口调
 * WM_SETICON 设进去的那张，没设才回落到 exe 的资源图标。Electron 从 PNG
 * 建 nativeImage 只留一个尺寸，任务栏要 24px 时只能把 256 硬缩，糊成一团
 * 认不出；而 exe 资源里可以按档位各存一份，系统按尺寸精确取用。
 * 所以根治办法是让 exe 自己带一套 16~256 的图标，同时让窗口不要再覆盖它。
 *
 * 用 resedit（electron-builder 同款 PE 编辑库）而不是 rcedit：
 * 项目里 vendor 那份 rcedit 打不开这个 240MB 的 exe（报 Unable to load file）。
 *
 * 用法：node .tmp/inject-icon.js <exe路径> <ico路径> <输出路径>
 */

const fs = require('fs');
const path = require('path');
const resedit = require(path.join(
  __dirname,
  '..',
  '..',
  'node_modules',
  '.pnpm',
  'resedit@1.7.2',
  'node_modules',
  'resedit'
));

const exePath = process.argv[2];
const icoPath = process.argv[3];
const outPath = process.argv[4];

// exe 里现存的图标组是 ID 1、语言 1033（en-US），沿用同一个人 ID/语言，
// 否则会多出一个组，Windows 可能挑到空的那个。
const ICON_GROUP_ID = 1;
const LANG = 1033;

function main() {
  const exeBin = fs.readFileSync(exePath);
  const exe = resedit.NtExecutable.from(exeBin);
  const res = resedit.NtExecutableResource.from(exe);

  const icoBin = fs.readFileSync(icoPath);
  const iconFile = resedit.Data.IconFile.from(icoBin);
  const icons = iconFile.icons.map((item) => item.data);
  console.log('ico entries:', icons.length);

  resedit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    ICON_GROUP_ID,
    LANG,
    icons
  );

  res.outputResource(exe);
  const out = exe.generate();
  fs.writeFileSync(outPath, Buffer.from(out));
  console.log('written:', outPath, fs.statSync(outPath).size, 'bytes');
}

main();
