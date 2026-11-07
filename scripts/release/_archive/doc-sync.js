const fs = require('fs');
const path = require('path');
const p = process.argv[2];

// 1) news.json：给 2.0.4 那条加一条「手动更新入口」
const newsPath = path.join(p, 'src/data/news.json');
const news = JSON.parse(fs.readFileSync(newsPath, 'utf8'));
const entry = news.find((item) => item && item.id === 'release-2-0-4');
if (entry) {
  const line = '设置 → 软件更新新增「手动更新」入口：不想等弹窗时可以直接跳 GitHub 发布页自己下新版 ZIP，覆盖程序文件即可，data 目录不会被动。';
  if (!entry.body.includes(line)) entry.body.push(line);
  fs.writeFileSync(newsPath, JSON.stringify(news, null, 2) + '\n', 'utf8');
  console.log('news.json: added bullet, body len =', entry.body.length);
} else {
  console.log('news.json: release-2-0-4 not found');
}

// 2) 更新说明.md：给 2.0.4 章节补一条
const mdPath = path.join(p, '更新说明.md');
let md = fs.readFileSync(mdPath, 'utf8');
const anchor = '- **更新公告移回动态页**';
const bullet = '- **新增手动更新入口**：设置 → 软件更新里可以直接跳 GitHub 发布页，手动下载新版 ZIP 覆盖程序文件即可，`data` 目录（游戏、账号、抽卡记录、设置）不受影响。\n';
if (md.includes(anchor) && !md.includes('新增手动更新入口')) {
  const idx = md.indexOf('\n', md.indexOf(anchor));
  md = md.slice(0, idx + 1) + bullet + md.slice(idx + 1);
  fs.writeFileSync(mdPath, md, 'utf8');
  console.log('更新说明.md: added bullet');
} else {
  console.log('更新说明.md: skipped (anchor missing or already present)');
}

// 3) README：把 v2.0.4 的手动更新那条说清楚是设置里的入口
const rdPath = path.join(p, 'README.md');
let rd = fs.readFileSync(rdPath, 'utf8');
const oldLine = '- 更新方式多了一条：也可以在 GitHub 仓库页面手动下载更新 —— https://github.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher';
const newLine = '- 更新方式多了一条：设置 → 软件更新里新增「手动更新」，可以直接跳到 GitHub 发布页自己下新版 ZIP 覆盖程序文件 —— https://github.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher';
if (rd.includes(oldLine)) {
  rd = rd.replace(oldLine, newLine);
  fs.writeFileSync(rdPath, rd, 'utf8');
  console.log('README.md: updated manual-update line');
} else {
  console.log('README.md: line not found (already updated?)');
}
