/*
 * 把 README.md 与 更新说明.md 同步到 Gitee 发行版仓库（main 分支）。
 *
 * 背景：GitHub 的源码是 gh-push.js 推的，README 与更新说明会自动跟着更新；
 * Gitee 发行版仓库是网页端从 GitHub 导入的，导入后不会跟着变，浏览仓库的人
 * 看到的版本说明会停在旧版本。这一个把这两份文档单独同步过去。
 *
 * 用法：node --use-system-ca scripts/release/gitee-docs-sync.js
 * 环境变量：GITEE_TOKEN（Gitee 私人令牌；缺省用 gitee-sync.js 那套）
 *
 * 接口要点（实测）：
 *   · 读取：GET  /api/v5/repos/{owner}/{repo}/contents/{path}?ref={branch}
 *     返回 content 是 base64，解出来是文件原文。
 *   · 写入：PUT  /api/v5/repos/{owner}/{repo}/contents/{path}
 *     body { message, content(base64), branch, sha }；改已存在的文件必须带 sha，
 *     不带会被当成新建而报 400。
 *   · 文件名含中文要 encodeURIComponent 编码后再拼路径。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const OWNER = process.env.GITEE_OWNER || 'SparkleHxl';
const REPO = process.env.GITEE_DIST_REPO || 'HuaXiaoLing-Launcher';
const BRANCH = process.env.GITEE_DIST_BRANCH || 'main';
const TOKEN = process.env.GITEE_TOKEN || '';
const SRC = path.resolve(__dirname, '..', '..');
const FILES = ['README.md', '更新说明.md'];

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request(
      {
        host: 'gitee.com',
        path: '/api/v5' + apiPath,
        method,
        headers: {
          authorization: 'token ' + TOKEN,
          'content-type': 'application/json',
          'content-length': data ? data.length : 0,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  if (!TOKEN) {
    console.log('没有 GITEE_TOKEN，跳过 Gitee 文档同步');
    return;
  }
  for (const name of FILES) {
    const localPath = path.join(SRC, name);
    if (!fs.existsSync(localPath)) {
      console.log(`跳过 ${name}（本地没有这个文件）`);
      continue;
    }
    const local = fs.readFileSync(localPath, 'utf8');
    const enc = encodeURIComponent(name);
    const cur = await api('GET', `/repos/${OWNER}/${REPO}/contents/${enc}?ref=${BRANCH}`);
    let sha = null;
    let remoteText = null;
    if (cur.status === 200) {
      try {
        const j = JSON.parse(cur.text);
        sha = j.sha || null;
        remoteText = Buffer.from(j.content, 'base64').toString('utf8');
      } catch { sha = null; }
    }
    if (remoteText === local) {
      console.log(`skip  ${name}（远端已一致）`);
      continue;
    }
    const put = await api('PUT', `/repos/${OWNER}/${REPO}/contents/${enc}`, {
      message: `docs: 同步 ${name}（版本说明与 GitHub 对齐）`,
      content: Buffer.from(local, 'utf8').toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    });
    if (put.status === 200 || put.status === 201) {
      console.log(`ok   ${name}  ${Buffer.byteLength(local)} 字节`);
    } else {
      console.error(`✗ ${name} 同步失败 http=${put.status}`);
      console.error('  ' + String(put.text).slice(0, 300));
      process.exitCode = 1;
    }
  }
  // 回读确认
  for (const name of FILES) {
    const enc = encodeURIComponent(name);
    const a = await api('GET', `/repos/${OWNER}/${REPO}/contents/${enc}?ref=${BRANCH}`);
    if (a.status !== 200) { console.error(`✗ 回读 ${name} http=${a.status}`); process.exitCode = 1; continue; }
    const txt = Buffer.from(JSON.parse(a.text).content, 'base64').toString('utf8');
    const mark = txt.match(/badge\/版本-v[\d.]+/) || txt.match(/当前版本：v[\d.]+/) || txt.match(/^## v[\d.]+/m);
    console.log(`回读 ${name}  ${Buffer.byteLength(txt)} 字节  ${mark ? mark[0] : ''}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
