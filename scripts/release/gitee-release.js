#!/usr/bin/env node
/*
 * Gitee 发布页 + 下载源。
 *
 * 为什么要这个脚本（2026-11-17 用户要求）：
 *   以前 Gitee 只当「更新清单源」，只有一个 latest.json，没有发布页，
 *   也不能当下载源（客户端在 Gitee 源下拿不到安装包）。现在 Gitee 要和
 *   GitHub 一样：有发布页、有安装包/便携包/增量包可下载。
 *
 * 实测出来的接口事实（别再重复试错了）：
 *   · 建发布页：POST /api/v5/repos/{owner}/{repo}/releases
 *       body 必须带 target_commitish（不给就 400），值填 master 或 HEAD 的 sha。
 *       返回体里有 id，用它做附件上传的路径参数。
 *   · 上传附件：POST /api/v5/repos/{owner}/{repo}/releases/{id}/attach_files
 *       multipart，字段名固定叫 file。上传成功 201，返回 asset id 与
 *       browser_download_url（形如
 *       https://gitee.com/{owner}/{repo}/releases/download/{tag}/{文件名}）。
 *   · 删发布页：DELETE /api/v5/repos/{owner}/{repo}/releases/{id}
 *       ★必须用 Authorization 头带 token，access_token 查询参数会 401。
 *   · 鉴权头两种都认：Authorization: token <令牌> 或 ?access_token=<令牌>。
 *
 * 用法：
 *   GITEE_TOKEN=<私人令牌> VER=2.12.1 node scripts/release/gitee-release.js
 *   DRY=1 只看要传什么，不真的传。
 *
 * 环境变量：
 *   GITEE_TOKEN  必填，Gitee 私人令牌（projects 读写）
 *   VER          要发布的版本号，不传就读正式清单里的 version
 *   BUILD_DIR    产物目录，默认 H:\HXL-pack\dist
 *   MANIFEST     正式清单，默认 H:\HXL-pack\latest.json
 *   MIRROR       清单里 url 的镜像前缀，默认 https://ghfast.top/
 *   DRY=1        预演
 */
const fs = require('fs');
const path = require('path');

const OWNER = 'SparkleHxl';
const REPO = 'hxl-update';
const BRANCH = 'master';
const DEFAULT_MIRROR = 'https://ghfast.top/';

const token = (process.env.GITEE_TOKEN || '').trim();
const BUILD = process.env.BUILD_DIR || 'H:\\HXL-pack\\dist';
const MANIFEST = process.env.MANIFEST || 'H:\\HXL-pack\\latest.json';
const MIRROR = (process.env.MIRROR || DEFAULT_MIRROR).replace(/\/$/, '') + '/';
const dry = !!process.env.DRY;

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

async function api(method, urlPath, body) {
  const base = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}${urlPath}`;
  const sep = urlPath.includes('?') ? '&' : '?';
  const url = `${base}${sep}access_token=${encodeURIComponent(token)}`;
  const headers = { 'Content-Type': 'application/json; charset=UTF-8' };
  // 删除接口只有 Authorization 头才认（查询参数会 401），所以统一都带上
  headers.Authorization = `token ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    throw new Error(`Gitee API ${method} ${urlPath} → ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

/** 上传一个大文件到 release（multipart，字段名固定 file）。 */
async function attach(releaseId, filePath, label) {
  const name = path.basename(filePath);
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), name);
  const url = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `token ${token}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`上传 ${name} 失败 → ${res.status} ${text.slice(0, 300)}`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* 忽略 */ }
  console.log(`  ✓ ${name}（${(buf.length / 1048576).toFixed(1)} MB）${label ? ' ' + label : ''}`);
  return json;
}

(async () => {
  if (!token) die('缺少 GITEE_TOKEN');
  if (!fs.existsSync(MANIFEST)) die('缺少正式清单: ' + MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const VER = (process.env.VER || manifest.version || '').trim();
  if (!VER) die('无法确定版本号（VER 与清单里都没有）');
  const TAG = `v${VER}`;

  const setup = path.join(BUILD, `HuaXiaoLing-${VER}-Setup.exe`);
  const zip = path.join(BUILD, `HuaXiaoLing-${VER}-Portable.zip`);
  if (!fs.existsSync(setup) || !fs.existsSync(zip)) die('产物不全（Setup.exe / Portable.zip）');

  // 增量包：清单里声明了就必须一起传，否则 deltas[].url 会 404
  const deltas = Array.isArray(manifest.deltas) ? manifest.deltas : [];
  const deltaFiles = deltas.map((d) => path.join(BUILD, `delta-${d.from}-to-${d.to}.zip`));
  for (const f of deltaFiles) if (!fs.existsSync(f)) die('清单声明了增量包但找不到: ' + f);

  const notes = String(manifest.notes || '').split('\n').filter(Boolean);
  const body = [
    `## 花筱灵启动器 ${VER}`,
    '',
    '### 这一版改了什么',
    '',
    ...notes.map((l) => `- ${l}`),
    '',
    '### 下载',
    `- 安装版：\`HuaXiaoLing-${VER}-Setup.exe\`（向导安装，推荐）`,
    `- 便携版：\`HuaXiaoLing-${VER}-Portable.zip\`（解压即用，数据在 \`data\\\` 里，覆盖升级不会丢）`,
    ...deltas.map((d) => `- 增量包：\`delta-${d.from}-to-${d.to}.zip\`（${(d.size / 1048576).toFixed(2)} MB）—— 启动器自动用，不用手动下`),
    `- 更新清单：\`latest.json\``,
    '',
    `SHA-256（便携包）：\`${manifest.sha256 || ''}\``,
    '',
    '### 手动更新',
    '旧版本可以直接下载本发布页的文件覆盖；也可以把 latest.json 地址填到启动器「设置 → 启动器更新 → 更新源」。',
    '',
    '---',
    '感谢 **Starward** 与 **XelLauncher** 两个开源项目。',
  ].join('\n');

  console.log(`版本      ${VER}`);
  console.log(`tag       ${TAG}`);
  console.log(`安装包    ${path.basename(setup)}（${(fs.statSync(setup).size / 1048576).toFixed(1)} MB）`);
  console.log(`便携包    ${path.basename(zip)}（${(fs.statSync(zip).size / 1048576).toFixed(1)} MB）`);
  for (let i = 0; i < deltaFiles.length; i += 1) {
    console.log(`增量包    ${path.basename(deltaFiles[i])}（${(fs.statSync(deltaFiles[i]).size / 1048576).toFixed(2)} MB）`);
  }

  if (dry) {
    console.log('\nDRY=1，未创建发布页、未上传附件。正文预览：\n');
    console.log(body);
    return;
  }

  // 1. 找同 tag 的旧发布页，有就删掉重建（Gitee 不支持改已发布页的附件集合）
  const list = await api('GET', '/releases');
  const old = (list || []).find((r) => r && r.tag_name === TAG);
  if (old && old.id) {
    await api('DELETE', `/releases/${old.id}`);
    console.log(`删掉旧发布页 ${TAG}（id=${old.id}）`);
  }

  // 2. 建发布页
  const rel = await api('POST', '/releases', {
    tag_name: TAG,
    target_commitish: BRANCH,
    name: `花筱灵启动器 ${VER}`,
    body,
    prerelease: false,
  });
  console.log(`\n发布页已建  ${rel && rel.html_url ? rel.html_url : ''}`);

  // 3. 传附件（先大包后小包；清单也传一份，客户端可直接从发布页读）
  await attach(rel.id, setup);
  await attach(rel.id, zip);
  for (const f of deltaFiles) await attach(rel.id, f);
  await attach(rel.id, MANIFEST);

  // 4. 把清单也写成仓库根的 latest.json（这份带镜像前缀，给 Gitee 源用）
  const giteeManifest = { ...manifest };
  const url = String(giteeManifest.url || '');
  if (url && !url.startsWith(MIRROR)) giteeManifest.url = MIRROR + url;
  if (Array.isArray(giteeManifest.deltas)) {
    giteeManifest.deltas = giteeManifest.deltas.map((d) => {
      const u = String((d && d.url) || '');
      return u && !u.startsWith(MIRROR) ? { ...d, url: MIRROR + u } : d;
    });
  }
  const text = JSON.stringify(giteeManifest, null, 2);
  const current = await api('GET', `/contents/latest.json?ref=${BRANCH}`);
  const sha = current && current.sha;
  await api('PUT', '/contents/latest.json', {
    message: `update ${VER}`,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  });
  console.log('清单已提交到仓库根 latest.json（带镜像前缀）');

  // 5. 校验：拉一次发布页，确认附件都在
  await new Promise((r) => setTimeout(r, 2000));
  const after = await api('GET', '/releases');
  const mine = (after || []).find((r) => r && r.tag_name === TAG);
  const names = ((mine && mine.assets) || []).map((a) => a.name);
  const want = [
    `HuaXiaoLing-${VER}-Setup.exe`,
    `HuaXiaoLing-${VER}-Portable.zip`,
    ...deltaFiles.map((f) => path.basename(f)),
    'latest.json',
  ];
  const missing = want.filter((n) => !names.includes(n));
  if (missing.length) {
    console.error('✗ 发布页缺附件: ' + missing.join(', '));
    process.exitCode = 1;
  } else {
    console.log(`\nDONE  ${mine && mine.html_url ? mine.html_url : ''}`);
    console.log(`附件齐全（${names.length} 项）：${names.join(', ')}`);
  }
})().catch((err) => {
  console.error('Gitee 发布失败：', err.message);
  process.exit(1);
});
