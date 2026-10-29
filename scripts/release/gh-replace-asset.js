// 替换 Release v2.1.9 的 ZIP 资产，并删掉多余的 latest.json 资产
const fs = require('fs');
const path = require('path');

const REPO = 'Sparkle0v0Hxl/HuaXiaoLing-Launcher';
const TOKEN = process.env.GH_TOKEN;
const VER = process.env.VER || '2.1.9';
const ZIP = process.env.ZIP;

if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1); }

const H = {
  'user-agent': 'hx-release',
  accept: 'application/vnd.github+json',
  authorization: 'Bearer ' + TOKEN,
};

async function api(method, url, body, raw) {
  const h = { ...H, 'content-type': raw ? 'application/octet-stream' : 'application/json' };
  const r = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, {
    method,
    headers: h,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, json };
}

(async () => {
  const rel = await api('GET', `/repos/${REPO}/releases/tags/v${VER}`);
  if (!rel.ok) { console.error('找不到 release', rel.status); process.exit(1); }
  const rid = rel.json.id;
  console.log('release:', rel.json.html_url);

  const assets = rel.json.assets || [];
  console.log('现有资产:', assets.map((a) => a.name).join(', ') || '(空)');

  // 1. 删掉 latest.json（包根已经带了，不用再单独挂）
  for (const a of assets) {
    if (a.name === 'latest.json') {
      const d = await api('DELETE', `/repos/${REPO}/releases/assets/${a.id}`);
      console.log('删除 latest.json 资产:', d.status);
    }
  }
  // 2. 删掉旧的 ZIP（准备重传）
  const zipName = `HuaXiaoLing-${VER}-Portable.zip`;
  for (const a of assets) {
    if (a.name === zipName) {
      const d = await api('DELETE', `/repos/${REPO}/releases/assets/${a.id}`);
      console.log('删除旧 ZIP 资产:', d.status);
    }
  }

  // 3. 上传新 ZIP
  const buf = fs.readFileSync(ZIP);
  console.log('新 ZIP:', (buf.length / 1024 / 1024).toFixed(1), 'MB');
  const up = await api(
    'POST',
    `https://uploads.github.com/repos/${REPO}/releases/${rid}/assets?name=${encodeURIComponent(zipName)}`,
    buf,
    true
  );
  console.log('上传:', up.ok ? `OK ${up.json.state} ${up.json.size}` : `FAIL ${up.status} ${JSON.stringify(up.json).slice(0, 200)}`);

  // 4. 回读
  const after = await api('GET', `/repos/${REPO}/releases/tags/v${VER}`);
  console.log('最终资产:', (after.json.assets || []).map((a) => `${a.name}(${a.size})`).join(', '));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
