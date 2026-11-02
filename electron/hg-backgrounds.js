'use strict';

/*
 * 官方背景同步：跟随鹰角启动器的「版本简报」页面，把官方每次换的主视觉背景
 * 自动拉到本地 backgrounds/official/ 目录。
 *
 * 数据链路（全部公开、无需登录，也不依赖本机装没装官方启动器）：
 *   1. GET https://ef-webview.hypergryph.com/version_briefing/latest
 *      → 返回当前版本页 HTML，里面引用 web.hycdn.cn/endfield/webview/_version_briefing/<目录>/ 下的 JS / CSS
 *   2. 拉 JS + CSS，正则提取全部 visual.<hash>.png / maxVisual.<hash>.png / visual.<hash>.jpg
 *      （webpack 构建产物把每期背景的文件名都编在里面；官方换背景 = 发新版页面，hash 随之更新）
 *   3. 拼 CDN 地址逐张下载，与本地 manifest.json 比对，只下没有的
 *
 * 图片本体始终从鹰角官方 CDN 获取，本地只做缓存，不做二次分发。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { httpFetch } = require('./http-fetch');

const LATEST_PAGE = 'https://ef-webview.hypergryph.com/version_briefing/latest';
const UA = 'HuaXiaoLingLauncher/2.7.1';

const MEMO_MS = 10 * 60 * 1000;
let listMemo = { at: 0, value: [] };

/**
 * 拉当前版本的全部官方背景 URL。
 * 返回 [{ name: 'visual.7801aa.png', url: 'https://web.hycdn.cn/.../visual.7801aa.png' }]
 */
async function fetchOfficialBackgroundList() {
  if (Date.now() - listMemo.at < MEMO_MS && listMemo.value.length) return listMemo.value;

  const page = await fetchText(LATEST_PAGE);
  // 版本目录与构建指纹都在页面引用的资源路径里
  const base = page.match(
    /https:\/\/web\.hycdn\.cn\/endfield\/webview\/_version_briefing\/([a-z0-9]+)\//
  );
  if (!base) throw new Error('官方版本简报页面结构变了：找不到版本目录');
  const versionDir = base[1];
  const baseDir = `${base[0]}assets/imgs`;

  // JS 与 CSS 的文件名都在页面里；webpack 会把每期背景文件名编进其中
  const bundles = [
    ...page.matchAll(
      new RegExp(`https://web\\.hycdn\\.cn/endfield/webview/_version_briefing/${versionDir}/[a-zA-Z0-9._-]+\\.(js|css)`, 'g')
    ),
  ].map((m) => m[0]);
  if (!bundles.length) throw new Error('官方版本简报页面结构变了：找不到 JS/CSS');

  let bundleText = '';
  for (const url of bundles) {
    try {
      bundleText += await fetchText(url);
    } catch {
      /* 单个 bundle 拉不到不阻塞，另一份通常也有引用 */
    }
  }
  const names = [...new Set(bundleText.match(/[a-zA-Z]+(?:Visual)?\.[a-f0-9]{6}\.(?:png|jpe?g|webp)/g) || [])]
    .filter((name) => /^(visual|maxVisual)\./.test(name));
  if (!names.length) throw new Error('官方版本简报里没有背景资源');

  const value = names.map((name) => ({
    name,
    url: `${baseDir}/${name}`,
    versionDir,
  }));
  listMemo = { at: Date.now(), value };
  return value;
}

async function fetchText(url) {
  const response = await httpFetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

/**
 * 同步官方背景到 <userData>/backgrounds/official/。
 *
 * 文件名直接用官方名（ef- 前缀 + hash），天然去重：官方没换图就不会重复下载。
 * 官方下架的旧图保留在本地（用户可能正在用），只在 manifest 里标记不在最新列表。
 *
 * 返回 { added, total, versionDir, addedNames }
 */
async function syncOfficialBackgrounds(userDataDir, onProgress) {
  const list = await fetchOfficialBackgroundList();
  const dir = path.join(userDataDir, 'backgrounds', 'official');
  await fsp.mkdir(dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');

  let manifest = {};
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    /* 首次同步或清单损坏都从空开始 */
  }
  const known = manifest.files || {};

  const addedNames = [];
  let fetched = 0;
  for (const item of list) {
    const file = `ef-${item.name}`;
    const dest = path.join(dir, file);
    if (known[item.name]) {
      // 上次下过：确认文件还在（被手动删了就重下）
      try {
        await fsp.access(dest);
        continue;
      } catch {
        /* 掉下去重下 */
      }
    }
    try {
      const response = await httpFetch(item.url, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const head = buffer.slice(0, 4).toString('hex').toLowerCase();
      const isImage =
        head.startsWith('ffd8') || // JPEG
        head.startsWith('89504e47') || // PNG
        head.startsWith('52494646'); // RIFF（WebP）
      if (!isImage) throw new Error('返回内容不是图片，跳过');
      await fsp.writeFile(dest, buffer);
      known[item.name] = { url: item.url, file, bytes: buffer.length, syncedAt: Date.now() };
      addedNames.push(item.name);
      fetched++;
      if (typeof onProgress === 'function') onProgress(fetched, list.length, item.name);
    } catch (error) {
      console.warn(`官方背景 ${item.name} 下载失败：`, error && error.message);
    }
  }

  manifest = {
    syncedAt: Date.now(),
    versionDir: list[0]?.versionDir || '',
    files: known,
  };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    added: addedNames.length,
    total: list.length,
    versionDir: manifest.versionDir,
    addedNames,
  };
}

/** 列出本地已有的官方背景（relative: 'backgrounds/official/<file>'），供切换器展示。 */
async function listOfficialBackgrounds(userDataDir) {
  const dir = path.join(userDataDir, 'backgrounds', 'official');
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const manifestPath = path.join(dir, 'manifest.json');
  let order = [];
  try {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    // 越新的背景排越前：manifest 里 syncedAt 降序
    order = Object.entries(manifest.files || {})
      .sort((a, b) => (b[1].syncedAt || 0) - (a[1].syncedAt || 0))
      .map(([name, info]) => info.file);
  } catch {
    /* 没清单就按目录序 */
  }
  const rest = names.filter((n) => /^ef-/.test(n) && !order.includes(n));
  return [...order.filter((f) => names.includes(f)), ...rest].map((file) => ({
    file,
    relative: `backgrounds/official/${file}`,
  }));
}

/** 本地缓存的总占用与张数，给文件管理页用。 */
async function officialBackgroundsStat(userDataDir) {
  const dir = path.join(userDataDir, 'backgrounds', 'official');
  let bytes = 0;
  let count = 0;
  try {
    for (const name of await fsp.readdir(dir)) {
      if (!/^ef-/.test(name)) continue;
      const stat = await fsp.stat(path.join(dir, name));
      bytes += stat.size;
      count++;
    }
  } catch {
    /* 目录不存在就是 0 */
  }
  return { bytes, count };
}

module.exports = {
  fetchOfficialBackgroundList,
  syncOfficialBackgrounds,
  listOfficialBackgrounds,
  officialBackgroundsStat,
};
