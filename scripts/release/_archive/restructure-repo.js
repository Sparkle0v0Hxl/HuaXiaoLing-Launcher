const https = require('https');
const T = process.env.GH_TOKEN;
const REPO = 'Sparkle0v0Hxl/HuaXiaoLing-Launcher';

function api(method, path, body, retries = 3) {
  return new Promise((res, rej) => {
    const attempt = (n) => {
      const u = new URL('https://api.github.com' + path);
      const data = body ? JSON.stringify(body) : null;
      const r = https.request(u, {
        method,
        headers: {
          'User-Agent': 'hxl',
          'Accept': 'application/vnd.github+json',
          'Authorization': 'Bearer ' + T,
          'Content-Type': 'application/json',
          'Content-Length': data ? Buffer.byteLength(data) : 0
        }
      }, x => {
        let d = ''; x.on('data', c => d += c); x.on('end', () => res({ s: x.statusCode, b: d }));
      });
      r.on('error', e => { if (n > 0) setTimeout(() => attempt(n - 1), 1500); else rej(e); });
      r.setTimeout(30000, () => r.destroy(new Error('timeout')));
      if (data) r.write(data); r.end();
    };
    attempt(retries);
  });
}

(async () => {
  // 1. get main ref
  const ref = JSON.parse((await api('GET', `/repos/${REPO}/git/ref/heads/main`)).b);
  const baseCommitSha = ref.object.sha;
  console.log('base commit:', baseCommitSha);

  // 2. get recursive tree
  const tree = JSON.parse((await api('GET', `/repos/${REPO}/git/trees/${baseCommitSha}?recursive=1`)).b);
  const entries = tree.tree;

  // 3. build new tree ops
  const ops = [];
  // 3a. promote resources/app/* to root
  for (const e of entries) {
    if (e.path.startsWith('resources/app/') && e.type === 'blob') {
      ops.push({ path: e.path.replace('resources/app/', ''), mode: '100644', type: 'blob', sha: e.sha });
    }
  }
  console.log('promoted blobs:', ops.length);
  console.log('sample ops:', JSON.stringify(ops.slice(0,3)), '...', JSON.stringify(ops.slice(-4)));

  // 3b. delete leaked runtime files at root
  for (const f of ['LICENSE.electron.txt', 'LICENSES.chromium.html', 'vk_swiftshader_icd.json']) {
    ops.push({ path: f, mode: '100644', type: 'blob', sha: null });
    console.log('delete root file:', f);
  }
  // 3c. delete entire resources/ (was accidentally pushed install dir)
  ops.push({ path: 'resources', mode: '040000', type: 'tree', sha: null });
  console.log('delete dir: resources/');

  // 4. create new tree
  const newTree = JSON.parse((await api('POST', `/repos/${REPO}/git/trees`, {
    base_tree: baseCommitSha,
    tree: ops
  })).b);
  if (newTree.message) { console.error('TREE ERROR:', newTree); process.exit(1); }
  console.log('new tree:', newTree.sha, 'size:', newTree.size);

  // 5. create commit
  const commit = JSON.parse((await api('POST', `/repos/${REPO}/git/commits`, {
    message: '仓库结构整理：源码提升到根目录，移除误传的打包产物\n\n- 将 resources/app/{electron,src,build,package.json,LICENSE} 提升到仓库根目录\n- 删除运行时泄漏文件：LICENSES.chromium.html、LICENSE.electron.txt、vk_swiftshader_icd.json\n- 删除误传的 resources/ 目录（endfield-packs/netease-api/updater 随发布包分发，不进 git）',
    tree: newTree.sha,
    parents: [baseCommitSha]
  })).b);
  if (commit.message) { console.error('COMMIT ERROR:', commit); process.exit(1); }
  console.log('new commit:', commit.sha);

  // 6. update ref
  const upd = JSON.parse((await api('PATCH', `/repos/${REPO}/git/refs/heads/main`, {
    sha: commit.sha,
    force: false
  })).b);
  if (upd.message) { console.error('REF ERROR:', upd); process.exit(1); }
  console.log('main ->', upd.object.sha);
  console.log('DONE');
})();
