// 修 v2.1.9 Release 正文：去掉「- · 」双重圆点，纠正 SHA-256
const TOKEN = process.env.GH_TOKEN;
const REPO = 'Sparkle0v0Hxl/HuaXiaoLing-Launcher';
const TAG = 'v2.1.9';
const SHA = '3384f5044192cd8f77b27cf74611211e1fbea19bc412d7ca4373557c3e7bd6a1';
const SIZE = 300635833;

const H = {
  'user-agent': 'hx-patch',
  authorization: 'Bearer ' + TOKEN,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
};

async function api(method, url, body) {
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, {
        method, headers: H, body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
      if (r.status >= 500 && i < 4) { await new Promise((s) => setTimeout(s, 1500)); continue; }
      return { ok: r.ok, status: r.status, json };
    } catch (e) {
      lastErr = e;
      await new Promise((s) => setTimeout(s, 1500 + i * 800));
    }
  }
  throw lastErr || new Error('fetch failed');
}

const BULLETS = [
  '官方更新源内置进包，装好就能自己检查更新，不用再手填地址。想自己架服务器（局域网共享、对象存储都行）再填，填了就优先用你填的。',
  '启动器根目录自带 `latest.json`（指针式），跟着 ZIP 一起发出去；它只写「真正的清单在仓库里」，下载地址和 sha256 由仓库根目录那份提供。',
  '检查更新改成取版本最高的那一份：以前目录里留着上个版本的清单，会一直显示「已是最新」，官网真发了新版也看不见。',
];

const body = [
  '## 花筱灵启动器 2.1.9',
  '',
  '### 这一版改了什么',
  '',
  ...BULLETS.map((t) => `- ${t}`),
  '',
  '### 下载',
  '- 便携版：`HuaXiaoLing-2.1.9-Portable.zip`（解压即用，数据在 `data\\` 里，覆盖升级不会丢）',
  '',
  `SHA-256：\`${SHA}\`（${SIZE.toLocaleString('en-US')} 字节）`,
  '',
  '### 手动更新',
  '启动器装好就自带更新源（仓库根目录的 `latest.json`，raw 与 jsDelivr 两条路），正常情况下点「检查更新」就能升级；也可以直接把新包解压覆盖过去，`data\\` 里的数据不会丢。',
  '',
  '---',
  '感谢 **Starward** 与 **XelLauncher** 两个开源项目。',
  '',
].join('\n');

(async () => {
  const me = await api('GET', '/user');
  if (!me.ok) { console.error('令牌无效', me.status); process.exit(1); }
  console.log('token user:', me.json.login);

  const rel = await api('GET', `/repos/${REPO}/releases/tags/${TAG}`);
  if (!rel.ok) { console.error('取 release 失败', rel.status); process.exit(1); }
  const id = rel.json.id;

  const assets = (rel.json.assets || []).map((a) => `${a.name} ${a.size}B`);
  console.log('assets:', assets.join(', '));

  const patched = await api('PATCH', `/repos/${REPO}/releases/${id}`, { body });
  if (!patched.ok) { console.error('PATCH 失败', patched.status, JSON.stringify(patched.json).slice(0, 300)); process.exit(1); }
  console.log('PATCH ok, body len', patched.json.body.length);
  console.log('body 里有 - · :', /^- · /m.test(patched.json.body));
  console.log('body 里有正确 sha:', patched.json.body.includes(SHA));
})();
