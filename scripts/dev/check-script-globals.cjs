'use strict';
/*
 * 经典脚本全局作用域检查（拆分批次的常备工序）。
 *
 * classic script 没有模块作用域：两个文件都写 `const A = ...` 就是 SyntaxError，
 * 实机上表现是**整个启动器白屏**，而单个文件 `--check` 永远发现不了。
 * 所以每搬一批都要跑这个：
 *
 *   第 1 步 按 index.html 的真实加载顺序把所有 script 拼成一个大文件，交给 V8 检查。
 *           V8 会按同一个作用域解析，重复 const/let/class、语法错误一律报错 —— 最接近真机。
 *   第 2 步 再做一遍逐文件重名扫描，出问题时能直接指到「哪两个文件的哪两行」。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/check-script-globals.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const fail = (msg) => {
  console.error('\n[x] ' + msg);
  process.exit(1);
};

/* ── 1. 拼接检查（按 index.html 顺序） ── */
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const sources = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);
if (!sources.length) fail('index.html 里没找到任何 <script src>');

const chunks = [];
for (const rel of sources) {
  const file = path.join(SRC, rel);
  if (!fs.existsSync(file)) fail('index.html 引用了不存在的脚本：' + rel);
  chunks.push(`\n/* ===== ${rel} ===== */\n`);
  chunks.push(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

const tmp = path.join(os.tmpdir(), `hxl-concat-check-${process.pid}.js`);
fs.writeFileSync(tmp, chunks.join(''), 'utf8');
const check = spawnSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
const bytes = fs.statSync(tmp).size;
fs.rmSync(tmp, { force: true });

if (check.status !== 0) {
  console.error('[x] 按 index.html 顺序拼接后检查失败 —— 大概率是跨文件重复声明或语法错误：');
  console.error((check.stderr || '').toString().trim());
  process.exit(1);
}
console.log(`  PASS  拼接检查：${sources.length} 个脚本 / ${(bytes / 1024 / 1024).toFixed(2)} MB，无重复声明`);

/* ── 2. 逐文件重名扫描（给出可定位的报错） ── */
const declRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'data') continue;
      walk(full);
      continue;
    }
    if (entry.name.endsWith('.js')) files.push(full);
  }
})(SRC);

const owners = new Map();
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(declRe);
    if (!match) return;
    const name = match[1] || match[2];
    if (!owners.has(name)) owners.set(name, []);
    owners.get(name).push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${index + 1}`);
  });
}

const clashes = [...owners.entries()].filter(([, list]) => list.length > 1);
if (clashes.length) {
  console.error(`\n[x] 跨文件重名 ${clashes.length} 处：`);
  for (const [name, list] of clashes) console.error(`  ! ${name}  →  ${list.join('  ,  ')}`);
  process.exit(1);
}
console.log(`  PASS  重名扫描：${files.length} 个脚本 / ${owners.size} 个顶层声明，0 冲突`);
console.log('\n全局作用域检查全部通过。');
