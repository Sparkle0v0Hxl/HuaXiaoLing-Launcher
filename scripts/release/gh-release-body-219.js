// 更新 v2.1.9 Release 说明：资产里已经没有 latest.json 了，正文里的下载段要去掉那一行
const REPO = 'Sparkle0v0Hxl/HuaXiaoLing-Launcher';
const TOKEN = process.env.GH_TOKEN;
const VER = process.env.VER || '2.1.9';

const H = {
  'user-agent': 'hx-release',
  accept: 'application/vnd.github+json',
  authorization: 'Bearer ' + TOKEN,
  'content-type': 'application/json',
};

async function api(method, url, body) {
  const r = await fetch('https://api.github.com' + url, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, json };
}

(async () => {
  const rel = await api('GET', `/repos/${REPO}/releases/tags/v${VER}`);
  if (!rel.ok) { console.error('找不到 release'); process.exit(1); }
  let body = rel.json.body || '';
  const before = body;

  // 更新清单不再作为资产上传，下载段删掉那一行
  body = body.replace(/^- 更新清单：`latest\.json`\n/m, '');
  body = body.replace(
    /旧版本可以直接用本仓库的 releases 覆盖，也可以把 `latest\.json` 地址填到启动器「设置 → 启动器更新 → 更新源」。/,
    '启动器装好就自带更新源（仓库根目录的 `latest.json`），正常情况下点「检查更新」就能升级；也可以直接把新包解压覆盖过去，`data\\` 里的数据不会丢。'
  );

  const r = await api('PATCH', `/repos/${REPO}/releases/${rel.json.id}`, { body });
  console.log('更新说明:', r.ok ? 'OK' : `FAIL ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  console.log('changed:', before !== body);
  console.log('--- 新正文 ---');
  console.log(body);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
