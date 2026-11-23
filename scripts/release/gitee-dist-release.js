#!/usr/bin/env node
/*
 * Gitee 发行版仓库的发布页（2026-11-17 用户要求「Gitee 弄的和 GitHub 一样」）。
 *
 * 现在 Gitee 上有两个仓库，各司其职：
 *   · SparkleHxl/hxl-update          —— 更新清单源（客户端「设置 → 更新源」选 Gitee 时读它）
 *   · SparkleHxl/HuaXiaoLing-Launcher —— 发行版仓库（源码 + 发布页 + 下载入口，仿 GitHub）
 * 这个脚本只管第二个仓库的发布页；第一个仓库的发布页由 gitee-release.js 管。
 *
 * 实测出来的接口事实（2026-11-17，别再重复试错）：
 *   · 建发布页：POST /api/v5/repos/{owner}/{repo}/releases
 *       body 必须带 target_commitish（不给就 400「错误的请求」），填分支名即可。
 *       返回体里有 id，用它做附件上传的路径参数。
 *   · 上传附件：POST /api/v5/repos/{owner}/{repo}/releases/{id}/attach_files
 *       multipart，字段名固定叫 file。成功 201，返回 browser_download_url
 *       （形如 https://gitee.com/{owner}/{repo}/releases/download/{tag}/{文件名}）。
 *   · 删发布页：DELETE /api/v5/repos/{owner}/{repo}/releases/{id}
 *       ★必须用 Authorization 头带 token，用 ?access_token= 查询参数会 401。
 *   · ★附件单文件上限 100 MB：传 172.9 MB 的 Setup.exe 会报
 *       「验证失败：文件大小已超出限制：100 MB」。所以完整安装包/便携包挂不上，
 *       改成在正文里给镜像直链（同一个文件、同一份 sha256），用户照样能点。
 *   · 仓库根文件：POST/PUT /api/v5/repos/{owner}/{repo}/contents/{path}
 *       （base64 content + branch + sha）。★更新已存在的文件必须带旧 sha，否则 400。
 *
 * 用法：
 *   GITEE_TOKEN=<私人令牌> VER=2.12.1 node scripts/release/gitee-dist-release.js
 *   DRY=1 只看要传什么，不真的传。
 */
const fs = require('fs');
const path = require('path');
const minisign = require('../../electron/minisign');

const OWNER = 'SparkleHxl';
const REPO = 'HuaXiaoLing-Launcher';
const BRANCH = 'main';
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

/** 上传一个文件到 release（multipart，字段名固定 file）。 */
async function attach(releaseId, filePath) {
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
  console.log(`  ✓ ${name}（${(buf.length / 1048576).toFixed(2)} MB）`);
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

  const deltas = Array.isArray(manifest.deltas) ? manifest.deltas : [];
  const deltaFiles = deltas.map((d) => path.join(BUILD, `delta-${d.from}-to-${d.to}.zip`));
  for (const f of deltaFiles) if (!fs.existsSync(f)) die('清单声明了增量包但找不到: ' + f);

  // Gitee 附件单文件上限 100 MB，超出的只留正文镜像直链
  const ASSET_LIMIT = 100 * 1024 * 1024;
  const tooBig = (file) => fs.statSync(file).size > ASSET_LIMIT;
  const inlineOnly = [setup, zip, ...deltaFiles].filter(tooBig);

  const notes = Array.isArray(manifest.notes) ? manifest.notes.map((s) => String(s).trim()).filter(Boolean) : String(manifest.notes || '').split('\n').map((s) => s.trim()).filter(Boolean);
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
    `- 更新清单：\`latest.json\`（附件，可直接下载做离线更新源）`,
    '',
    ...(inlineOnly.length
      ? [
          '> Gitee 附件单个文件上限 100 MB，完整安装包与便携包放不下，改用下面这个镜像直链下载（同一个文件，同一份校验值）：',
          '',
          ...inlineOnly.map((f) => `- \`${path.basename(f)}\` → ${MIRROR}${manifest.url.replace(/[^/]+$/, path.basename(f))}`),
          '',
        ]
      : []),
    `SHA-256（便携包）：\`${manifest.sha256 || ''}\``,
    '',
    '### 手动更新',
    '旧版本可以直接下载上面的文件覆盖；也可以把 latest.json 地址填到启动器「设置 → 启动器更新 → 更新源」。',
    '',
    '### 源码',
    '本仓库是完整源码，结构与 GitHub 一致：`electron/` 主进程与 IPC、`src/` 渲染层、`scripts/release/` 发布脚本。',
    '',
    '---',
    '感谢 **Starward** 与 **XelLauncher** 两个开源项目。',
  ].join('\n');

  console.log(`仓库      ${OWNER}/${REPO}`);
  console.log(`版本      ${VER}`);
  console.log(`tag       ${TAG}`);
  console.log(`安装包    ${path.basename(setup)}（${(fs.statSync(setup).size / 1048576).toFixed(1)} MB）`);
  console.log(`便携包    ${path.basename(zip)}（${(fs.statSync(zip).size / 1048576).toFixed(1)} MB）`);
  for (const f of deltaFiles) {
    console.log(`增量包    ${path.basename(f)}（${(fs.statSync(f).size / 1048576).toFixed(2)} MB）`);
  }

  if (dry) {
    console.log('\nDRY=1，未创建发布页、未上传附件。正文预览：\n');
    console.log(body);
    return;
  }

  // 1. 同 tag 的旧发布页先删掉重建（Gitee 不支持改已发布页的附件集合）
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

  // 3. 传附件（超 100 MB 的只留正文直链）
  for (const f of [setup, zip, ...deltaFiles]) {
    if (tooBig(f)) {
      console.log(`  · ${path.basename(f)} 超过 100 MB，改用正文里的镜像直链`);
      continue;
    }
    await attach(rel.id, f);
  }
  await attach(rel.id, MANIFEST);

  // 4. 仓库根 latest.json 也带镜像前缀提交一份（浏览仓库的人能直接看到本版清单）
  let giteeManifest = { ...manifest };
  const url = String(giteeManifest.url || '');
  if (url && !url.startsWith(MIRROR)) giteeManifest.url = MIRROR + url;
  if (Array.isArray(giteeManifest.deltas)) {
    giteeManifest.deltas = giteeManifest.deltas.map((d) => {
      const u = String((d && d.url) || '');
      return u && !u.startsWith(MIRROR) ? { ...d, url: MIRROR + u } : d;
    });
  }
  /*
   * ★2026-11-17（审查 rev-release 后）：deltas[].url 现在**在签名载荷内**，
   *   上面把 delta 的 url 改成镜像前缀之后，原签名必然失配 ——
   *   客户端（updater.js「有签名就必须验过」）会直接拒绝这份清单，国内用户全掉更新。
   *   所以提交前必须重签；没有私钥就中止，绝不把失效签名推上去。
   */
  const hadSig = Boolean(manifest && manifest.sig && manifest.sig.value);
  const keyFile = (process.env.HXL_UPDATE_KEY || 'H:\\HXL-pack\\keys\\update-signing.pem').trim();
  const resigned = minisign.signManifestWithKeyFile(giteeManifest, keyFile);
  if (!resigned && hadSig) {
    console.error('✗ 镜像清单改写 url 后需要重新签名，但找不到私钥：' + keyFile);
    process.exit(1);
  }
  if (resigned) giteeManifest = resigned;
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
    ...[setup, zip, ...deltaFiles].filter((f) => !tooBig(f)).map((f) => path.basename(f)),
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
  console.error('Gitee 发行版发布失败：', err.message);
  process.exit(1);
});
