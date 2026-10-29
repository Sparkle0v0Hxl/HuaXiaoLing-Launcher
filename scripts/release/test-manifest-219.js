// 验证：指针式清单 + 「取版本最高」的候选挑选
const fs = require('fs');
const path = require('path');
const os = require('os');

const updater = require('H:\\花筱灵启动器-源码\\electron\\updater.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-manifest-'));
const real = path.join(dir, 'real.json');
const pointer = path.join(dir, 'latest.json');
const stale = path.join(dir, 'stale.json');

fs.writeFileSync(real, JSON.stringify({
  version: '2.1.9', title: '花筱灵启动器 2.1.9', date: '2026-10-27',
  notes: '真实清单', url: 'HuaXiaoLing-2.1.9-Portable.zip',
  sha256: 'a'.repeat(64), size: 12345, portable: true,
}), 'utf8');

// 指针式：只写 manifest，不写 url
fs.writeFileSync(pointer, JSON.stringify({
  version: '2.1.9', channel: 'stable', date: '2026-10-27',
  title: '花筱灵启动器 2.1.9', manifest: real, portable: true,
}), 'utf8');

// 旧的真实清单，版本比当前低
fs.writeFileSync(stale, JSON.stringify({
  version: '2.1.8', title: 'old', notes: '旧', url: 'old.zip',
  sha256: 'b'.repeat(64), size: 1, portable: true,
}), 'utf8');

(async () => {
  // 1. 指针能不能顺着取到真正的清单
  const m = await updater.readManifest(pointer);
  console.log('1) 指针解析  version=%s url=%s sha256=%s', m.version, m.url, m.sha256.slice(0, 8));

  // 2. 候选里既有旧的 2.1.8、又有指针，得取 2.1.9（而不是先读到 2.1.8 就收工）
  const r = await updater.resolveManifest([stale, pointer]);
  console.log('2) 取最高版本  ok=%s version=%s source=%s', r.ok, r.manifest.version, path.basename(r.source));

  // 3. checkForUpdate：当前 2.1.8，候选 [旧的2.1.8, 指针2.1.9] → 应该报有更新
  const c = await updater.checkForUpdate({ location: [stale, pointer], currentVersion: '2.1.8' });
  console.log('3) 有更新吗  hasUpdate=%s latest=%s url=%s', c.hasUpdate, c.latest, c.url);

  // 4. 当前已经是 2.1.9 → 不该报更新
  const c2 = await updater.checkForUpdate({ location: [stale, pointer], currentVersion: '2.1.9' });
  console.log('4) 已最新     hasUpdate=%s latest=%s', c2.hasUpdate, c2.latest);

  // 5. 全部读不到 → ok:false 且带错误
  const c3 = await updater.checkForUpdate({ location: [path.join(dir, 'nope.json')], currentVersion: '2.1.9' });
  console.log('5) 读不到     ok=%s error=%s', c3.ok, String(c3.error).slice(0, 40));

  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error('TEST FAIL', e); process.exit(1); });
