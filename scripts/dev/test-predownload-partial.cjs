'use strict';
/*
 * 「预下载下了一半」的账目测试。
 *
 * 用户 2026-10-31 问：「预下载下了一半，没继续下了，或者变正式的更新了，咋办？」
 *
 * 界面上能不能说出「已经下到哪、接着来会不会白下」，全看后端 measureStoredChunks()
 * 数得准不准。这里只盯这一件事：
 *   · 目录不存在 / 读不动 → 0，不许抛；
 *   · 下到一半的 .pd_tmp 不算已完成分块（它可能是断点，也可能只写了一半）；
 *   · 元信息文件 .hxl-predownload.json 不算用户下载的东西；
 *   · 子目录不算分块。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/test-predownload-partial.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { measureStoredChunks } = require(path.join(ROOT, 'electron', 'predownload-hoyo.js'));

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hxl-pd-partial-'));

  /* 1. 目录不存在 → 0，不抛 */
  const missing = await measureStoredChunks(path.join(tmp, 'missing-dir'));
  ok('目录不存在：返回 0 个 0 字节', missing.files === 0 && missing.bytes === 0, JSON.stringify(missing));

  /* 2. 空目录 → 0 */
  const emptyDir = path.join(tmp, 'chunk-empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  const empty = await measureStoredChunks(emptyDir);
  ok('空目录：返回 0 个 0 字节', empty.files === 0 && empty.bytes === 0, JSON.stringify(empty));

  /*
   * 3. 真正的场景：下到一半停下 —— 三块完整分块 + 一块 .pd_tmp + 元信息 + 一个子目录。
   *    只有三块算数。
   */
  const dir = path.join(tmp, 'chunk');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'chunk-a'), Buffer.alloc(100, 1));
  fs.writeFileSync(path.join(dir, 'chunk-b'), Buffer.alloc(200, 2));
  fs.writeFileSync(path.join(dir, 'chunk-c'), Buffer.alloc(300, 3));
  fs.writeFileSync(path.join(dir, 'chunk-d.pd_tmp'), Buffer.alloc(9999, 4));
  fs.writeFileSync(path.join(dir, '.hxl-predownload.json'), JSON.stringify({ chunkCount: 3 }));
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });

  const half = await measureStoredChunks(dir);
  ok('下了一半：只数完整分块（3 个）', half.files === 3, JSON.stringify(half));
  ok('下了一半：体积只算完整分块（600 字节）', half.bytes === 600, JSON.stringify(half));
  ok('下了一半：没把 .pd_tmp 算进去', half.bytes !== 600 + 9999, JSON.stringify(half));
  ok('下了一半：没把元信息文件算进去', half.files !== 4, JSON.stringify(half));
  ok('下了一半：没把子目录算进去', half.files === 3, JSON.stringify(half));

  /* 4. 再补一块，数字要跟着涨（模拟用户又下了一点） */
  fs.writeFileSync(path.join(dir, 'chunk-d'), Buffer.alloc(400, 5));
  const more = await measureStoredChunks(dir);
  ok('继续下了：分块数变成 4', more.files === 4, JSON.stringify(more));
  ok('继续下了：体积变成 1000', more.bytes === 1000, JSON.stringify(more));

  /* 5. 清空后回到 0（对应界面「清除预下载」之后） */
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  const cleared = await measureStoredChunks(dir);
  ok('清除之后：回到 0', cleared.files === 0 && cleared.bytes === 0, JSON.stringify(cleared));

  fs.rmSync(tmp, { recursive: true, force: true });

  let failed = 0;
  for (const item of results) {
    if (item.pass) console.log('  PASS  ' + item.name);
    else {
      failed += 1;
      console.log('  FAIL  ' + item.name + (item.detail ? '   → ' + item.detail : ''));
    }
  }
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('[x] 测试自身炸了：', error);
  process.exit(2);
});
