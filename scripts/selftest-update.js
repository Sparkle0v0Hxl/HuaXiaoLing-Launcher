'use strict';

/**
 * 自更新模块的自检脚本（开发用，不随发布包走）。
 *
 * 两段：
 *   1. 不依赖任何产物的纯函数 / 本地清单用例，随时可跑；
 *   2. 给一个发布目录（publish-portable.ps1 的 -OutDir），做一遍真实链路：
 *      读清单 → 本地下载 → sha256 → 解压 + 规划覆盖范围 → 覆盖前核对。
 *      HTTP 下载那一小段自己起一个本地服务器验证进度回调。
 *
 * 用法：
 *   node scripts\selftest-update.js
 *   node scripts\selftest-update.js build\release
 *
 * 覆盖脚本 HXL-Updater.ps1 的实装流程需要在「模拟安装目录」上跑，
 * 由 scripts\publish-portable.ps1 旁边的发布流程手工验证，这里不重复。
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const updaterPath = path.join(ROOT, 'resources', 'app', 'electron', 'updater.js');
const u = require(updaterPath);

const results = [];
function ok(cond, name, extra) {
  results.push({ pass: Boolean(cond), name, extra });
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${extra ? '  ->  ' + extra : ''}`);
}

const CURRENT_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'app', 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
})();

async function main() {
  const releaseDir = process.argv[2] ? path.resolve(process.argv[2]) : '';
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hxl-selftest-'));

  /* ---------- 1. 纯函数与本地清单 ---------- */
  ok(u.compareVersions('2.0.0', '2.0.0') === 0, '同版本相等');
  ok(u.compareVersions('1.9.9', '2.0.0') === -1, '旧版本更小');
  ok(u.compareVersions('v2.0.10', '2.0.9') === 1, 'v 前缀与数字比较');
  ok(u.parseVersion('2.0').join('.') === '2.0.0', '两段版本号补齐');
  ok(u.parseVersion('2.1.3-beta.1').join('.') === '2.1.3', '预发布后缀被忽略');
  ok(u.isProtected('data/state/gacha.json'), '保护 data/');
  ok(u.isProtected('downloads/game.zip'), '保护 downloads/');
  ok(u.isProtected('resources/endfield-packs/channels.zip'), '保护 endfield-packs');
  ok(u.isProtected('resources/netease-api/server.js'), '保护 netease-api');
  ok(u.isProtected('resources/app/electron/main.js.bak-20260101'), '保护 .bak 残留');
  ok(u.isProtected('花筱灵启动器.exe') === false, '允许覆盖主程序');
  ok(u.isProtected('resources/app/electron/main.js') === false, '允许覆盖 main.js');

  const manifestPath = path.join(tmp, 'latest.json');
  await fsp.writeFile(
    manifestPath,
    JSON.stringify({
      version: '2.0.1',
      notes: '第一行\n第二行',
      url: 'HuaXiaoLing-2.0.1-Portable.zip',
      sha256: 'abc',
      size: 123,
    })
  );
  const man = await u.readManifest(manifestPath);
  ok(path.isAbsolute(man.url) && man.url.endsWith('HuaXiaoLing-2.0.1-Portable.zip'), '清单相对 url 解析成绝对路径');
  ok(man.notes === '第一行\n第二行', '说明里的换行保留');

  const found = await u.checkForUpdate({ location: manifestPath, currentVersion: '2.0.0' });
  ok(found.ok && found.hasUpdate && found.latest === '2.0.1', '发现新版本');
  const same = await u.checkForUpdate({ location: manifestPath, currentVersion: '2.0.1' });
  ok(same.ok && !same.hasUpdate, '同版本不提示更新');
  const missing = await u.checkForUpdate({ location: path.join(tmp, 'nope.json'), currentVersion: '2.0.0' });
  ok(!missing.ok && /找不到更新源文件/.test(missing.error || ''), '清单缺失时报错', missing.error);
  const empty = await u.checkForUpdate({ location: '', currentVersion: '2.0.0' });
  ok(!empty.ok && empty.error === '还没有设置更新源', '未配置更新源');
  const multi = await u.checkForUpdate({
    location: ['', path.join(tmp, 'nope.json'), manifestPath],
    currentVersion: '2.0.0',
  });
  ok(multi.ok && multi.latest === '2.0.1', '多候选地址时取第一个能用的');

  /* ---------- 2. 真实发布产物 ---------- */
  if (!releaseDir) {
    console.log('\n（没给发布目录，跳过真实链路；加参数 build\\release 可完整跑一遍）');
  } else {
    const zipName = (await fsp.readdir(releaseDir)).find((name) => /^HuaXiaoLing-.*\.zip$/i.test(name));
    if (!zipName) throw new Error(`${releaseDir} 里没有 HuaXiaoLing-*.zip`);
    const zipPath = path.join(releaseDir, zipName);
    const realManifest = path.join(releaseDir, 'latest.json');

    // 模拟「还装着 2.0.0 的老电脑」去检查，这样真实清单一定能被判定为新版本
    const OLD_VERSION = '2.0.0';
    const check = await u.checkForUpdate({ location: realManifest, currentVersion: OLD_VERSION });
    ok(check.ok && check.hasUpdate, `真实清单可读，最新 ${check.latest}（模拟本机 ${OLD_VERSION}，真实本机 ${CURRENT_VERSION}）`, check.error);
    ok(path.basename(check.url) === zipName, '清单里的 url 指向同名 ZIP', path.basename(check.url));

    const dest = path.join(tmp, 'download.zip');
    let lastPercent = 0;
    let monotonic = true;
    await u.downloadToFile({
      url: check.url,
      dest,
      expectedSize: check.size,
      onProgress: (p) => {
        if (p.percent + 0.001 < lastPercent) monotonic = false;
        lastPercent = p.percent;
      },
    });
    const size = (await fsp.stat(dest)).size;
    ok(size === check.size, `本地下载大小 ${size} 与清单一致`);
    ok(lastPercent === 100 && monotonic, '下载进度单调走到 100%');

    const digest = await u.sha256File(dest);
    ok(digest === check.sha256, 'sha256 与清单一致', digest.slice(0, 16));

    const staged = await u.stage({ zipPath: dest, tempBase: path.join(tmp, 'staging'), version: check.latest });
    ok(staged.version === check.latest, `规划出的版本号取自清单 ${staged.version}`);
    ok(staged.files.length > 10, `覆盖清单 ${staged.files.length} 个文件`);
    ok(!staged.files.some((rel) => /^(data|downloads)\//.test(rel)), '覆盖清单不含 data/downloads');
    ok(staged.files.includes('resources/app/electron/main.js'), '覆盖清单含 main.js');
    ok(staged.files.includes('resources/updater/HXL-Updater.ps1'), '覆盖清单含覆盖脚本');
    ok(!staged.files.some((rel) => rel.includes('node_modules')), '覆盖清单不含 node_modules');
    ok(!staged.files.some((rel) => /\.bak/i.test(rel) || /\.log$/i.test(rel)), '覆盖清单不含 .bak / .log 残留');

    const tooOld = u.describeApplyProblem({ staged, currentVersion: check.latest });
    ok(/不比当前/.test(tooOld), '覆盖前核对：版本不比当前新就拒绝', tooOld);
    const fine = u.describeApplyProblem({ staged: { ...staged, packageVersion: '' }, currentVersion: '0.0.1' });
    ok(fine === '', '覆盖前核对：更新的版本放行', fine);
    const mismatch = u.describeApplyProblem({ staged: { ...staged, packageVersion: '9.9.9' }, currentVersion: '0.0.1' });
    ok(/对不上/.test(mismatch), '覆盖前核对：包内版本与清单不一致就拒绝', mismatch);

    // HTTP 下载：起一个只服务这个 ZIP 的小服务器
    const server = http.createServer((req, res) => {
      const stat = fs.statSync(dest);
      res.writeHead(200, { 'content-length': stat.size, 'content-type': 'application/zip' });
      fs.createReadStream(dest).pipe(res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const httpDest = path.join(tmp, 'http-download.zip');
    let ticks = 0;
    await u.downloadToFile({
      url: `http://127.0.0.1:${port}/pkg.zip`,
      dest: httpDest,
      expectedSize: size,
      onProgress: () => {
        ticks += 1;
      },
    });
    server.close();
    ok((await fsp.stat(httpDest)).size === size, `HTTP 下载大小 ${size}`);
    ok(ticks > 1, `HTTP 下载进度回调 ${ticks} 次`);
    ok((await u.sha256File(httpDest)) === digest, 'HTTP 下载内容与本地一致');

    const notFound = http.createServer((req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise((resolve) => notFound.listen(0, '127.0.0.1', resolve));
    let httpError = '';
    try {
      await u.downloadToFile({ url: `http://127.0.0.1:${notFound.address().port}/x.zip`, dest: path.join(tmp, 'x.zip') });
    } catch (error) {
      httpError = error.message;
    }
    notFound.close();
    ok(/404/.test(httpError), 'HTTP 404 立刻报错不重试', httpError);
  }

  await fsp.rm(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    failed.forEach((r) => console.log(`FAILED  ${r.name}`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('自检中断：', error && error.message ? error.message : error);
  process.exitCode = 1;
});

