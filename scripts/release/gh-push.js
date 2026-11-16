// 通过 GitHub Git Data API 把本地源码差异提交到 main
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WS = 'H:\\花筱灵启动器-源码';
const REPO = 'Sparkle0v0Hxl/HuaXiaoLing-Launcher';
const BRANCH = 'main';
const TOKEN = process.env.GH_TOKEN;
const DRY = process.env.DRY === '1';

if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1); }

const H = {
  'user-agent': 'hx-push',
  accept: 'application/vnd.github+json',
  authorization: 'Bearer ' + TOKEN,
  'content-type': 'application/json',
};

async function api(method, url, body) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, {
        method,
        headers: H,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
      if (!r.ok) {
        if ((r.status === 403 || r.status === 429) && i < 3) { await new Promise(s => setTimeout(s, 3000)); continue; }
        return { ok: false, status: r.status, json };
      }
      return { ok: true, status: r.status, json };
    } catch (e) {
      if (i === 3) return { ok: false, status: 0, json: { error: e.message } };
      await new Promise(s => setTimeout(s, 1500));
    }
  }
}

function gitBlobSha(buf) {
  return crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');
}

function repoPathOf(rel) {
  // 仓库已在 restructure-repo.js 后扁平化：electron/ src/ build/ package.json 等都在仓库根。
  const p = rel.replace(/\\/g, '/');
  return p;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp', 'shots', '.cache', '.build-tools']);
const SKIP_EXT = /\.(log|lnk)$/i;
const SKIP_NAME = /(^|\.)(bak|old)(\.|$|-)|\.bak-/i;
const TOPS = ['electron', 'src', 'build', 'scripts', 'package.json', 'LICENSE', 'README.md', 'AUTHORS.md', '启动-安全模式.bat','更新说明.md','latest.json'];
// ONLY=README.md,AUTHORS.md 只推这几个（相对仓库根的路径前缀）
const ONLY = (process.env.ONLY || '')
  .split(',')
  .map((s) => s.trim().replace(/\\/g, '/'))
  .filter(Boolean);

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('userdata-') || e.name.startsWith('.userdata-')) continue;
      walk(full, out);
    } else if (e.isFile() && !SKIP_EXT.test(e.name) && !SKIP_NAME.test(e.name)) out.push(full);
  }
}

(async () => {
  // 0. 身份自检
  const me = await api('GET', '/user');
  if (!me.ok) { console.error('令牌无效:', me.status, JSON.stringify(me.json).slice(0, 200)); process.exit(1); }
  console.log('token user:', me.json.login);

  // 1. 当前 head
  const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  if (!ref.ok) { console.error('取 ref 失败', ref.status, JSON.stringify(ref.json).slice(0, 200)); process.exit(1); }
  const headSha = ref.json.object.sha;
  const commitInfo = await api('GET', `/repos/${REPO}/git/commits/${headSha}`);
  const baseTree = commitInfo.json.tree.sha;
  console.log('head:', headSha.slice(0, 8), 'tree:', baseTree.slice(0, 8));

  // 2. 远程 tree
  const tree = await api('GET', `/repos/${REPO}/git/trees/${baseTree}?recursive=1`);
  const remote = new Map();
  for (const t of tree.json.tree) if (t.type === 'blob') remote.set(t.path, t.sha);
  console.log('remote blobs:', remote.size);

  // 3. 本地文件
  const files = [];
  for (const top of TOPS) {
    const full = path.join(WS, top);
    if (!fs.existsSync(full)) { console.log('跳过不存在的:', top); continue; }
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, files); else files.push(full);
  }

  const changes = [];
  for (const f of files) {
    const rel = path.relative(WS, f);
    const rp = repoPathOf(rel);
    const buf = fs.readFileSync(f);
    const sha = gitBlobSha(buf);
    if (remote.get(rp) !== sha) changes.push({ rp, buf, sha, isNew: !remote.has(rp) });
  }

  changes.sort((a, b) => a.rp.localeCompare(b.rp));
  // 注意：ONLY 为空时不能直接用 changes，否则下面 changes.length = 0 会把 picked 一起清空
  const picked = ONLY.length
    ? changes.filter((c) => ONLY.some((p) => c.rp === p || c.rp.startsWith(p + '/')))
    : changes.slice();
  if (ONLY.length) {
    const dropped = changes.length - picked.length;
    console.log('ONLY 过滤:', ONLY.join(', '), '-> 保留', picked.length, '个，跳过', dropped, '个');
  }
  changes.length = 0;
  changes.push(...picked);
  console.log('\n待提交', changes.length, '个文件:');
  for (const c of changes) console.log(' ', c.isNew ? '+' : 'M', c.rp, c.buf.length);
  const total = changes.reduce((a, c) => a + c.buf.length, 0);
  console.log('总计', (total / 1024).toFixed(0), 'KB');

  if (DRY) { console.log('\nDRY 模式，不写入'); return; }
  if (!changes.length) { console.log('没有差异，无需提交'); return; }

  // 4. 建 blob
  const entries = [];
  for (const c of changes) {
    if (remote.get(c.rp) === c.sha) { entries.push({ path: c.rp, mode: '100644', type: 'blob', sha: c.sha }); continue; }
    const r = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: c.buf.toString('base64'),
      encoding: 'base64',
    });
    if (!r.ok) { console.error('blob 失败', c.rp, r.status, JSON.stringify(r.json).slice(0, 200)); process.exit(1); }
    entries.push({ path: c.rp, mode: '100644', type: 'blob', sha: r.json.sha });
  }
  console.log('blobs 就绪:', entries.length);

  // 5. 树
  const nt = await api('POST', `/repos/${REPO}/git/trees`, { base_tree: baseTree, tree: entries });
  if (!nt.ok) { console.error('tree 失败', nt.status, JSON.stringify(nt.json).slice(0, 300)); process.exit(1); }
  console.log('new tree:', nt.json.sha.slice(0, 8));

  // 6. 提交（提交信息必须显式传 COMMIT_MSG；默认兜底只写版本号，避免再出现
  //    2026-10-30 那种「内容推的是 2.5.0、提交信息还停在 2.0.4」的事故）
  const version = JSON.parse(fs.readFileSync(path.join(WS, 'package.json'), 'utf8')).version;
  const msg = process.env.COMMIT_MSG || `v${version}: 源码同步`;

  const nc = await api('POST', `/repos/${REPO}/git/commits`, { message: msg, tree: nt.json.sha, parents: [headSha] });
  if (!nc.ok) { console.error('commit 失败', nc.status, JSON.stringify(nc.json).slice(0, 300)); process.exit(1); }
  console.log('new commit:', nc.json.sha);

  // 7. 更新 ref
  const up = await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: nc.json.sha, force: false });
  if (!up.ok) { console.error('更新分支失败', up.status, JSON.stringify(up.json).slice(0, 300)); process.exit(1); }
  console.log('分支已更新:', up.json.object.sha);

  // 8. 回读校验
  const check = await api('GET', `/repos/${REPO}/contents/src/app.js?ref=${BRANCH}`);
  if (check.ok) console.log('校验 app.js 远端大小:', check.json.size);
  const pkg = await api('GET', `/repos/${REPO}/contents/package.json?ref=${BRANCH}`);
  if (pkg.ok) {
    const txt = Buffer.from(pkg.json.content, 'base64').toString('utf8');
    console.log('校验 package.json version:', JSON.parse(txt).version);
  }

  // 9. 刷新 jsDelivr 镜像缓存：清单刚推上 main，镜像可能还留着旧版本缓存
  //    （jsDelivr 对 @main 的缓存窗口最长 12 小时），不主动刷的话老用户会
  //    迟迟收不到更新。GET 一次 purge 接口即失效重取；失败不阻断（镜像自己
  //    到期也会刷，只是慢）。
  try {
    const pr = await fetch('https://purge.jsdelivr.net/gh/Sparkle0v0Hxl/HuaXiaoLing-Launcher@main/latest.json');
    const pj = await pr.json().catch(() => null);
    if (pj && pj.status === 'finished') console.log('jsDelivr 缓存已刷新:', pj.timestamp);
    else console.log('jsDelivr purge 响应异常:', JSON.stringify(pj).slice(0, 120));
    const vr = await fetch('https://cdn.jsdelivr.net/gh/Sparkle0v0Hxl/HuaXiaoLing-Launcher@main/latest.json', { headers: { 'user-agent': 'hx-push' } });
    const vt = await vr.text();
    const vm = JSON.parse(vt);
    console.log('jsDelivr 现返回版本:', vm.version);
  } catch (e) {
    console.log('jsDelivr 刷新失败（不阻断）:', e.message);
  }

  console.log('\nDONE');
})();
