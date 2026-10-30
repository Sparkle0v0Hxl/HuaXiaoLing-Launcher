#!/usr/bin/env node
/**
 * 把最新更新清单同步到 Gitee 镜像源（D 方案）
 *
 * 仓库：https://gitee.com/SparkleHxl/hxl-update （只放一个 latest.json，几 KB）
 * 作用：老版本客户端（2.3.0 ~ 2.4.2）没有镜像回退逻辑，只认清单里的 url。
 *       国内裸连 GitHub 下载不动，所以推到 Gitee 的这份会把 url 换成镜像前缀地址，
 *       老用户在「设置 → 更新源」填上 Gitee raw 地址就能自动发现 + 自动下载。
 *       2.4.5+ 客户端已内置 Gitee 源，会自己读到这份清单。
 *
 * 用法：
 *   1）有私人令牌（推荐，全自动）：
 *      GITEE_TOKEN=<Gitee 私人令牌> node scripts/release/gitee-sync.js
 *      令牌申请：Gitee → 设置 → 私人令牌 → 勾选 projects（读写）即可
 *   2）无令牌：脚本会输出待提交内容与网页编辑器直链，手工粘一次（30 秒）
 *      node scripts/release/gitee-sync.js
 *
 * 可选环境变量：
 *   MIRROR=   覆盖镜像前缀，默认 https://ghfast.top/
 *   DRY=1     只预览不提交
 */
const fs = require('fs');
const path = require('path');

const OWNER = 'SparkleHxl';
const REPO = 'hxl-update';
const FILE = 'latest.json';
const BRANCH = 'master';
const DEFAULT_MIRROR = 'https://ghfast.top/';

const SRC_MANIFEST = path.join(__dirname, '..', '..', 'latest.json');
const OUT_COPY = 'H:\\HXL-pack\\gitee-latest.json';
const RAW_URL = `https://gitee.com/${OWNER}/${REPO}/raw/${BRANCH}/${FILE}`;
const EDIT_URL = `https://gitee.com/${OWNER}/${REPO}/edit/${BRANCH}/${FILE}`;

const token = (process.env.GITEE_TOKEN || '').trim();
const mirror = (process.env.MIRROR || DEFAULT_MIRROR).replace(/\/$/, '') + '/';
const dry = !!process.env.DRY;

function readManifest() {
  if (!fs.existsSync(SRC_MANIFEST)) {
    throw new Error(`找不到正式清单：${SRC_MANIFEST}（先跑 pack.js 生成）`);
  }
  return JSON.parse(fs.readFileSync(SRC_MANIFEST, 'utf8'));
}

/** 生成推给 Gitee 的版本：url 换成镜像前缀，其余字段原样 */
function buildGiteeManifest(manifest) {
  const out = { ...manifest };
  const url = String(out.url || '');
  if (url && !url.startsWith(mirror)) out.url = mirror + url;
  return out;
}

async function api(method, urlPath, body) {
  const base = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}${urlPath}`;
  const sep = urlPath.includes('?') ? '&' : '?';
  const url = `${base}${sep}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
  if (!res.ok) {
    throw new Error(`Gitee API ${method} ${urlPath} → ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

(async () => {
  const manifest = readManifest();
  const payload = buildGiteeManifest(manifest);
  const text = JSON.stringify(payload, null, 2);

  console.log(`版本      ${manifest.version}`);
  console.log(`Gitee url ${payload.url}`);
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
    console.log('\n未设置 GITEE_TOKEN，走手工提交：');
    console.log(`  1) 打开 ${EDIT_URL}`);
    console.log(`  2) 全选替换为 ${OUT_COPY} 的内容（当前 ${manifest.version}）`);
    console.log('  3) 提交后跑一次本脚本做校验（curl 读 raw 比对）');
    console.log(`\n想全自动就申请 Gitee 私人令牌（projects 读写），然后：GITEE_TOKEN=xxx node ${path.relative(process.cwd(), __filename)}`);
    return;
  }

  const current = await api('GET', `/contents/${FILE}?ref=${BRANCH}`);
  const sha = current && current.sha;
  const remoteVersion = current && current.content
    ? (() => { try { return JSON.parse(Buffer.from(current.content, 'base64').toString('utf8')).version; } catch { return '?'; } })()
    : '(新文件)';
  console.log(`远端版本  ${remoteVersion}`);

  const res = await api('PUT', `/contents/${FILE}`, {
    message: `update ${manifest.version}`,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  });
  console.log(`提交完成  ${(res && res.commit && res.commit.sha) || 'ok'}`);

  await new Promise((r) => setTimeout(r, 3000));
  const verify = await fetch(RAW_URL + '?t=' + Date.now(), { redirect: 'follow' });
  const vText = await verify.text();
  let vJson = null;
  try { vJson = JSON.parse(vText); } catch { /* 可能是重定向页 */ }
  if (vJson && vJson.version === manifest.version && vJson.url === payload.url) {
    console.log(`校验通过  ${RAW_URL} → ${vJson.version}（raw 有 CDN 缓存，最多几十秒）`);
  } else {
    console.log(`⚠ 校验没读到新版（可能缓存或重定向），确认：${RAW_URL}`);
  }
})().catch((err) => {
  console.error('同步失败：', err.message);
  process.exit(1);
});
