// 用 GitHub Releases API 上传发布资产：Setup.exe + Portable.zip + latest.json
const fs = require('fs');
const path = require('path');

const REPO = 'Sparkle0v0Hxl/HuaXiaoLing-Launcher';
const TOKEN = process.env.GH_TOKEN;
const VER = process.env.VER || '2.4.2';
const BUILD = process.env.BUILD_DIR || 'H:\\HXL-pack\\dist';
const MANIFEST = process.env.MANIFEST || 'H:\\HXL-pack\\latest.json'; // 正式清单（带真实 sha256/size），pack.js 生成
const TAG = 'v' + VER;

if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1); }

const H = { 'user-agent': 'hx-release', accept: 'application/vnd.github+json', authorization: 'Bearer ' + TOKEN };

async function api(method, url, body, raw) {
  // 本机代理对长连接不稳，socket 偶发被断——统一带重试
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      const h = { ...H };
      if (raw) h['content-type'] = 'application/octet-stream';
      else h['content-type'] = 'application/json';
      const r = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, {
        method, headers: h,
        body: raw ? body : (body ? JSON.stringify(body) : undefined),
      });
      const text = await r.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
      if (!r.ok && (r.status === 403 || r.status === 429 || r.status >= 500) && i < 4) {
        await new Promise((s) => setTimeout(s, 3000 * (i + 1)));
        continue;
      }
      return { ok: r.ok, status: r.status, json };
    } catch (e) {
      lastErr = e;
      if (i < 4) await new Promise((s) => setTimeout(s, 3000 * (i + 1)));
    }
  }
  throw lastErr || new Error('api failed');
}

(async () => {
  const zip = path.join(BUILD, `HuaXiaoLing-${VER}-Portable.zip`);
  const setup = path.join(BUILD, `HuaXiaoLing-${VER}-Setup.exe`);
  if (!fs.existsSync(zip) || !fs.existsSync(setup)) { console.error('缺少文件'); process.exit(1); }
  if (!fs.existsSync(MANIFEST)) { console.error('缺少正式清单:', MANIFEST); process.exit(1); }
  for (const f of [zip, setup, MANIFEST]) {
    console.log('资产', path.basename(f), (fs.statSync(f).size / 1024 / 1024).toFixed(1), 'MB');
  }

  // 正式清单：pack.js 已写好 url/sha256/size，这里只把 url 与 release 资产地址对齐核对
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const expectedUrl = `https://github.com/${REPO}/releases/download/${TAG}/HuaXiaoLing-${VER}-Portable.zip`;
  if (m.url && m.url !== expectedUrl) {
    console.log('清单 url 与 release 地址不一致，改写:', m.url, '->', expectedUrl);
    m.url = expectedUrl;
  }
  m.version = VER;
  console.log('manifest:', JSON.stringify({ ...m, notes: (m.notes || '').slice(0, 60) + '…' }));

  // 1. 找/建 release
  let rel = await api('GET', `/repos/${REPO}/releases/tags/${TAG}`);
  if (!rel.ok) {
    console.log('release 不存在，创建…');
    rel = await api('POST', `/repos/${REPO}/releases`, {
      tag_name: TAG,
      target_commitish: 'main',
      name: `花筱灵启动器 ${VER}`,
      body: [
        `## 花筱灵启动器 ${VER}`,
        '',
        '### 这一版改了什么',
        '',
        ...String(m.notes || '').split('\n').filter(Boolean).map(l => `- ${l}`),
        '',
        '### 下载',
        `- 安装版：\`HuaXiaoLing-${VER}-Setup.exe\`（向导安装，推荐）`,
        `- 便携版：\`HuaXiaoLing-${VER}-Portable.zip\`（解压即用，数据在 \`data\\\` 里，覆盖升级不会丢）`,
        `- 更新清单：\`latest.json\``,
        '',
        `SHA-256（便携包）：\`${m.sha256 || ''}\``,
        '',
        '### 手动更新',
        '旧版本可以直接用本仓库的 releases 覆盖，也可以把 `latest.json` 地址填到启动器「设置 → 启动器更新 → 更新源」。',
        '',
        '---',
        '感谢 **Starward** 与 **XelLauncher** 两个开源项目。',
      ].join('\n'),
      draft: false,
      prerelease: false,
    });
    if (!rel.ok) { console.error('建 release 失败', rel.status, JSON.stringify(rel.json).slice(0, 300)); process.exit(1); }
  } else {
    console.log('release 已存在:', rel.json.html_url);
  }
  const rid = rel.json.id;
  const existing = new Map(((rel.json.assets) || []).map(a => [a.name, a.id]));

  // 2. 上传资产（先删同名旧资产）
  for (const [file, name, type] of [
    [setup, `HuaXiaoLing-${VER}-Setup.exe`, 'application/octet-stream'],
    [zip, `HuaXiaoLing-${VER}-Portable.zip`, 'application/zip'],
    [MANIFEST, 'latest.json', 'application/json'],
  ]) {
    if (existing.has(name)) {
      const d = await api('DELETE', `/repos/${REPO}/releases/assets/${existing.get(name)}`);
      console.log('删除旧资产', name, d.status);
    }
    const buf = fs.readFileSync(file);
    const up = await api('POST',
      `https://uploads.github.com/repos/${REPO}/releases/${rid}/assets?name=${encodeURIComponent(name)}`,
      buf, true);
    console.log('上传', name, up.ok ? 'OK ' + up.json.state + ' ' + up.json.size : 'FAIL ' + up.status + ' ' + JSON.stringify(up.json).slice(0, 200));
    if (!up.ok) process.exitCode = 1;
  }
  console.log('release:', rel.json.html_url);
})();
