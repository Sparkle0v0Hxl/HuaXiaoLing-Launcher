#!/usr/bin/env node
/*
 * GitCode 清单源（只放更新源，不放安装包）。
 *
 * 为什么只做清单源（2026-11-17 实测结论）：
 *   GitCode 的 release 只能自动生成源码归档（v2.12.1.zip / .tar.gz / .tar.bz2 / .tar），
 *   附件上传接口全部 404 —— 试过这些路由都是 404 Route Not Found：
 *     POST /api/v5/repos/{owner}/{repo}/releases/{tag}/attach_files
 *     POST /api/v5/repos/{owner}/{repo}/releases/assets
 *     POST /api/v5/repos/{owner}/{repo}/releases/{tag}/assets
 *     POST /api/v5/repos/{owner}/{repo}/releases/{tag}/upload
 *     POST /api/v5/repos/{owner}/{repo}/uploads
 *   所以 Setup.exe / Portable.zip 传不上去，只能让 GitCode 当「清单源」：
 *   客户端填 GitCode 源后，能读到最新版本号并去 GitHub / 镜像站下载包。
 *
 * 鉴权：GitCode 与 Gitee 同构，但**鉴权头必须是 private-token**，
 *   用 access-token 头会报「Invalid header parameter: private-token, required」；
 *   ?access_token= 查询参数也可以。
 *
 * 能用的公开 raw 地址（客户端填这个）：
 *   https://raw.gitcode.com/{owner}/{repo}/raw/{branch}/latest.json
 * ★注意：文件名必须是 .json —— .txt 会被「暂不支持预览」挡成 403；
 *   而且 raw 有预览限制策略，偶尔 403，回读要用 API /contents 更稳。
 *
 * 用法：
 *   GITCODE_TOKEN=<私人令牌> node scripts/release/gitcode-sync.js
 *   DRY=1 只看要提交什么
 */
const fs = require('fs');
const path = require('path');
const minisign = require('../../electron/minisign');

const OWNER = 'huahuozuikeai';
const REPO = 'hxl-update';
const FILE = 'latest.json';
const BRANCH = 'master';
const DEFAULT_MIRROR = 'https://ghfast.top/';

const token = (process.env.GITCODE_TOKEN || '').trim();
const mirror = (process.env.MIRROR || DEFAULT_MIRROR).replace(/\/$/, '') + '/';
const dry = !!process.env.DRY;

const SRC_MANIFEST = path.join(__dirname, '..', '..', 'latest.json');
const OUT_COPY = 'H:\\HXL-pack\\gitcode-latest.json';
const RAW_URL = `https://raw.gitcode.com/${OWNER}/${REPO}/raw/${BRANCH}/${FILE}`;

function readManifest() {
  if (!fs.existsSync(SRC_MANIFEST)) {
    throw new Error(`找不到正式清单：${SRC_MANIFEST}（先跑 pack.js 生成）`);
  }
  return JSON.parse(fs.readFileSync(SRC_MANIFEST, 'utf8'));
}

/** 生成给 GitCode 的清单：url 换成镜像前缀，其余字段原样。 */
function buildGitCodeManifest(manifest) {
  const out = { ...manifest };
  const url = String(out.url || '');
  if (url && !url.startsWith(mirror)) out.url = mirror + url;
  if (Array.isArray(out.deltas)) {
    out.deltas = out.deltas.map((d) => {
      const u = String((d && d.url) || '');
      return u && !u.startsWith(mirror) ? { ...d, url: mirror + u } : d;
    });
  }
  return out;
}

/**
 * 改写之后重签。
 *
 * ★2026-11-17（审查 rev-release 后）：deltas[].url 现在**在签名载荷内**，
 *   所以改完 url 必须重新签名，否则这份清单的 sig 必然失配 ——
 *   客户端（updater.js「有签名就必须验过」）会直接拒绝它，国内用户全掉更新。
 *   私钥路径沿用 sign-manifest.js 的约定：HXL_UPDATE_KEY 或
 *   H:\HXL-pack\keys\update-signing.pem。没有私钥且原来有签名 → 返回 null，调用方必须中止。
 */
function reapSign(payload, hadSig) {
  const keyFile = (process.env.HXL_UPDATE_KEY || 'H:\\HXL-pack\\keys\\update-signing.pem').trim();
  const signed = minisign.signManifestWithKeyFile(payload, keyFile);
  if (signed) return signed;
  if (!hadSig) return payload; // 过渡期老清单，本来就没签名
  return null;
}

async function api(method, urlPath, body) {
  const base = `https://api.gitcode.com/api/v5/repos/${OWNER}/${REPO}${urlPath}`;
  const sep = urlPath.includes('?') ? '&' : '?';
  const url = `${base}${sep}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      // GitCode 只认 private-token
      'private-token': token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    throw new Error(`GitCode API ${method} ${urlPath} → ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

(async () => {
  const manifest = readManifest();
  const mirrored = buildGitCodeManifest(manifest);
  const hadSig = Boolean(manifest && manifest.sig && manifest.sig.value);
  const payload = reapSign(mirrored, hadSig);
  if (!payload) {
    console.error('');
    console.error('✗ 改写 url 之后需要重新签名，但找不到私钥。');
    console.error('  私钥默认在 H:\\HXL-pack\\keys\\update-signing.pem，也可以用 HXL_UPDATE_KEY 指定。');
    console.error('  不能把签名已失效的清单推上去 —— 客户端会直接拒绝它（updater.js「有签名就必须验过」）。');
    process.exit(1);
  }
  if (hadSig && payload.sig && payload.sig.value !== manifest.sig.value) {
    console.log('已重新签名（deltas[].url 在签名载荷内，改写后必须重签）');
  }
  const text = JSON.stringify(payload, null, 2);

  console.log(`版本      ${manifest.version}`);
  console.log(`GitCode url ${payload.url}`);
  console.log(`sha256    ${manifest.sha256}`);

  if (!manifest.sha256 || !manifest.size) {
    console.log('\n⚠ 清单里 sha256/size 为空，确认 pack.js 已跑完再同步。');
  }

  fs.mkdirSync(path.dirname(OUT_COPY), { recursive: true });
  fs.writeFileSync(OUT_COPY, text, 'utf8');
  console.log(`\n已写出待提交内容 → ${OUT_COPY}`);

  if (dry) {
    console.log('\nDRY=1，未提交。内容如下：\n');
    console.log(text);
    return;
  }

  if (!token) {
    console.log('\n未设置 GITCODE_TOKEN，走手工提交：');
    console.log(`  1) 打开 https://gitcode.com/${OWNER}/${REPO}/edit/${BRANCH}/${FILE}`);
    console.log(`  2) 全选替换为 ${OUT_COPY} 的内容（当前 ${manifest.version}）`);
    console.log('\n想全自动就申请 GitCode 私人令牌（projects 读写），然后：');
    console.log(`  GITCODE_TOKEN=xxx node ${path.relative(process.cwd(), __filename)}`);
    return;
  }

  // 建/改发布页（GitCode 的发布页只能自动生成源码归档，不能传附件）
  const TAG = `v${manifest.version}`;
  try {
    await api('POST', '/releases', {
      tag_name: TAG,
      target_commitish: BRANCH,
      name: `花筱灵启动器 ${manifest.version}`,
      body: `花筱灵启动器 ${manifest.version}\n\n本仓库只提供更新源（latest.json），安装包请到 GitHub Release 下载。`,
      prerelease: false,
    });
    console.log(`发布页已建  ${TAG}`);
  } catch (e) {
    // 已存在就算了，不算失败
    if (/已经存在|exists|409/i.test(e.message)) console.log(`发布页已存在  ${TAG}`);
    else console.log(`发布页创建跳过：${e.message}`);
  }

  const current = await api('GET', `/contents/${FILE}?ref=${BRANCH}`);
  const sha = current && current.sha;
  await api('PUT', `/contents/${FILE}`, {
    message: `update ${manifest.version}`,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  });
  console.log('清单已提交');

  await new Promise((r) => setTimeout(r, 2000));
  const verify = await api('GET', `/contents/${FILE}?ref=${BRANCH}`);
  let vJson = null;
  try {
    vJson = JSON.parse(Buffer.from(verify.content, 'base64').toString('utf8'));
  } catch { /* 忽略 */ }
  if (vJson && vJson.version === manifest.version) {
    console.log(`校验通过  ${RAW_URL} → ${vJson.version}`);
  } else {
    console.log(`⚠ API 回读到的版本不是 ${manifest.version}，确认：${RAW_URL}`);
  }
})().catch((err) => {
  console.error('GitCode 同步失败：', err.message);
  process.exit(1);
});
