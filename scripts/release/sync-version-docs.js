#!/usr/bin/env node
/*
 * 版本文档同步（2026-11-17 加进打包脚本）。
 *
 * 要解决的问题：版本号升了，README 还写着上一版，发布页正文也停在旧文案。
 * 这里把「版本号」当成单一来源：
 *   · 版本号、标题、日期、notes —— 源码\build\latest.json
 *   · 更新日志正文 —— 源码\src\data\news.json 里 id = release-<版本号> 的那条
 * 由本脚本统一把 README 的徽章、当前版本、便携包文件名、展开版本历史范围
 * 和新版本的展开段对齐到当前版本。
 *
 * ★README 的 <details>/<summary> 折叠结构必须原样保留（用户明确要求），
 *   所以这里只在既有段之间插入新段，不重排、不删除旧段。
 * ★绝不跑 scripts/release/build-readme.js —— 那个脚本会把 README 从 65KB
 *   砍到 29KB，把手写章节全冲掉。
 *
 * 用法：
 *   node scripts/release/sync-version-docs.js          # 真改
 *   DRY=1 node scripts/release/sync-version-docs.js    # 只看要改什么
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..');
const README = path.join(SRC, 'README.md');
const POINTER = path.join(SRC, 'build', 'latest.json');
const NEWS = path.join(SRC, 'src', 'data', 'news.json');
const dry = !!process.env.DRY;

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}
if (!fs.existsSync(README)) die('找不到 README.md');
if (!fs.existsSync(POINTER)) die('找不到 build/latest.json');
if (!fs.existsSync(NEWS)) die('找不到 src/data/news.json');

const pointer = JSON.parse(fs.readFileSync(POINTER, 'utf8'));
const VER = String(pointer.version || '').trim();
if (!VER) die('build/latest.json 里没有 version');
const news = JSON.parse(fs.readFileSync(NEWS, 'utf8'));
const item = news.find((n) => n && n.id === `release-${VER.replace(/\./g, '-')}`);

let t = fs.readFileSync(README, 'utf8');
const before = t;
const edits = [];

// 1. 徽章：badge/版本-v2.12.0-xxx → badge/版本-v2.12.1-xxx（颜色保持不变）
t = t.replace(/badge\/版本-v[\d.]+-/g, (m) => {
  edits.push(m + ' → badge/版本-v' + VER + '-');
  return `badge/版本-v${VER}-`;
});
// 2. 当前版本
t = t.replace(/\*\*当前版本：v[\d.]+\*\*/g, (m) => {
  edits.push(m + ` → **当前版本：v${VER}**`);
  return `**当前版本：v${VER}**`;
});
// 3. 便携包文件名
t = t.replace(/HuaXiaoLing-[\d.]+-Portable\.zip/g, (m) => {
  edits.push(m + ` → HuaXiaoLing-${VER}-Portable.zip`);
  return `HuaXiaoLing-${VER}-Portable.zip`;
});
// 4. 展开版本历史范围
t = t.replace(/展开版本历史<\/b>（v[\d.]+ → v[\d.]+）/g, (m) => {
  const to = `展开版本历史</b>（v${VER} → v1.0.0）`;
  edits.push(m + ' → ' + to);
  return to;
});

// 5. 新版本的展开段：插在上一版之前，保留折叠结构
const marker = `<summary><b>v${VER}</b></summary>`;
if (!t.includes(marker)) {
  if (!item) {
    console.log(`（news.json 里没有 release-${VER.replace(/\./g, '-')} 条目，跳过插入展开段）`);
  } else {
    const body = Array.isArray(item.body) ? item.body : String(item.body || '').split('\n');
    const lines = [`<details>`, `<summary><b>v${VER}</b></summary>`, ''];
    if (item.excerpt) { lines.push(String(item.excerpt)); lines.push(''); }
    for (const line of body) {
      const s = String(line);
      if (!s.trim()) { lines.push(''); continue; }
      if (s.startsWith('## ')) {
        lines.push('');
        lines.push('**' + s.slice(3) + '**');
        lines.push('');
      } else {
        lines.push('- ' + s);
      }
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
    const block = lines.join('\n') + '\n\n';
    // 锚点：紧邻的上一个版本段
    const vers = Array.from(new Set((t.match(/<summary><b>v([\d.]+)<\/b><\/summary>/g) || [])
      .map((x) => x.replace(/<summary><b>/, '').replace(/<\/b><\/summary>/, ''))));
    const cur = vers.indexOf(VER);
    const prev = cur > 0 ? vers[cur - 1] : vers[vers.length - 1];
    const anchor = `<details>\n<summary><b>v${prev}</b></summary>`;
    if (!t.includes(anchor)) {
      console.log(`（找不到上一版锚点 v${prev}，跳过插入展开段）`);
    } else {
      t = t.replace(anchor, block + anchor);
      edits.push(`插入 v${VER} 展开段（锚点 v${prev}）`);
    }
  }
}

const dCount = (t.match(/<details>/g) || []).length;
const sCount = (t.match(/<summary>/g) || []).length;
if (dCount !== sCount) die(`折叠结构被破坏：details ${dCount} / summary ${sCount}`);

for (const e of edits) console.log('  ' + e);
if (t === before) {
  console.log('README 已是当前版本，无需改动');
  process.exit(0);
}
if (dry) {
  console.log('DRY=1，未写盘');
  process.exit(0);
}
fs.writeFileSync(README, t, 'utf8');
console.log(`README 已更新到 v${VER}（details ${dCount} / summary ${sCount}）`);
