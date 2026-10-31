'use strict';
/*
 * 预下载演练模式测试（不需要真有版本可预下载，也不联网）。
 *
 * 为什么需要它：官方没放开预下载时，「检查 → 预下载 → 应用」这条路一步都点不到。
 * 演练模式（electron/predownload-sim.js）用假数据把这四个动作替换掉，界面和 IPC 还是真的。
 * 这里直接跑那个模块，断言它产出的进度事件序列、暂停 / 停止 / 失败语义，以及
 * 状态机（available → done → none）和「关掉演练后自动清假状态」。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/test-predownload-sim.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const sim = require(path.join(ROOT, 'electron', 'predownload-sim.js'));

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail: detail == null ? '' : String(detail) });
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

const dir = path.join(os.tmpdir(), `hxl-pd-sim-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const cfgFile = path.join(dir, 'predownload-sim.json');
const stateFile = path.join(dir, 'predownload-sim-state.json');

const writeCfg = (obj) => fs.writeFileSync(cfgFile, JSON.stringify(obj), 'utf8');
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
};

/** 采集一次 start / apply 的全部进度事件。 */
function collect(run) {
  const events = [];
  return run((event) => events.push(event)).then((result) => ({ result, events }));
}

const FAST = { seconds: 0.35, chunks: 12, bytes: 1024 ** 3 };

(async () => {
  sim.setup({ userDataDir: dir });

  /* ── 1. 没开关文件时完全关闭，必须转给真实实现 ── */
  eq('没开关文件时 enabled=false', sim.enabled(), false);
  const real = await sim.check({ gameKey: 'nonexistent-game' });
  eq('关闭时 check 走真实实现（未知游戏 → unsupported）', real.state, 'unsupported');

  /* ── 2. 打开开关后的 check 报告 ── */
  writeCfg({});
  eq('有开关文件时 enabled=true', sim.enabled(), true);
  const available = await sim.check({ gameKey: 'genshin' });
  eq('默认状态是 available', available.state, 'available');
  eq('报告 kind=hoyo', available.kind, 'hoyo');
  eq('报告带 sim:// 目录标记', String(available.dir).startsWith('sim://'), true);
  ok('默认给出版本与体积', Boolean(available.targetVersion) && Number(available.bytesTotal) > 0);
  ok(
    '体积拆解加起来等于总量',
    available.bytesGame + available.bytesAudio + available.bytesCategory === available.bytesTotal,
    `${available.bytesGame}+${available.bytesAudio}+${available.bytesCategory}`
  );

  /* ── 3. 一次完整的预下载（hoyo） ── */
  writeCfg(FAST);
  fs.rmSync(stateFile, { force: true });
  const { result: startResult, events: startEvents } =
    await collect((onProgress) => sim.start({ gameKey: 'genshin', onProgress }));
  const phases = startEvents.map((event) => event.phase);
  eq('第一个事件是 version', phases[0], 'version');
  ok('有 manifest 阶段', phases.includes('manifest'), phases.join(','));
  ok('有 download 阶段', phases.includes('download'), phases.join(','));
  ok(
    '阶段顺序是 version → manifest → download',
    phases.lastIndexOf('version') < phases.indexOf('manifest') &&
      phases.lastIndexOf('manifest') < phases.indexOf('download'),
    phases.join(',')
  );
  const downloads = startEvents.filter((event) => event.phase === 'download');
  eq('下载事件条数等于分块数', downloads.length, FAST.chunks);
  let monotonic = true;
  for (let i = 1; i < downloads.length; i += 1) {
    if (downloads[i].processed <= downloads[i - 1].processed) monotonic = false;
    if (downloads[i].bytesDone < downloads[i - 1].bytesDone) monotonic = false;
  }
  ok('processed / bytesDone 单调递增', monotonic);
  const last = downloads[downloads.length - 1];
  eq('最后一块 processed=total', `${last.processed}/${last.total}`, `${FAST.chunks}/${FAST.chunks}`);
  eq('下载量走满 totalBytes', last.bytesDone, FAST.bytes);
  ok('下载事件带文件名（current）', downloads.every((event) => String(event.current || '').length > 0));
  ok('会模拟命中缓存（skipped>0）', last.skipped > 0, `skipped=${last.skipped}`);
  eq('返回值标记 simulated', startResult.simulated, true);
  eq('state 落盘为 done', readState() && readState().phase, 'done');
  const afterStart = await sim.check({ gameKey: 'genshin' });
  eq('下载完 check 变成 done', afterStart.state, 'done');
  ok('done 报告带已存分块与体积', Number(afterStart.storedFiles) > 0 && Number(afterStart.storedBytes) > 0);

  /* ── 4. 停止：抛「已取消」，状态不前进 ── */
  fs.rmSync(stateFile, { force: true });
  const signal = { cancelled: false };
  let cancelledError = null;
  const cancelledEvents = [];
  try {
    await sim.start({
      gameKey: 'genshin',
      signal,
      onProgress: (event) => {
        cancelledEvents.push(event);
        if (cancelledEvents.length === 4) signal.cancelled = true;
      },
    });
  } catch (error) {
    cancelledError = error;
  }
  ok('停止后抛出错误', Boolean(cancelledError));
  eq('错误文案是「已取消」', cancelledError && cancelledError.message, '已取消');
  eq('错误带 cancelled 标记', Boolean(cancelledError && cancelledError.cancelled), true);
  eq('停止不影响状态（仍是 available）', (await sim.check({ gameKey: 'genshin' })).state, 'available');

  /* ── 5. 暂停：原地等待，松开后继续走完 ── */
  const pauseSignal = { paused: true };
  const pauseStarted = Date.now();
  let released = false;
  const pauseRun = sim
    .start({ gameKey: 'genshin', signal: pauseSignal, onProgress: () => {} })
    .then((value) => ({ value }));
  setTimeout(() => {
    pauseSignal.paused = false;
    released = true;
  }, 500);
  const pauseSettled = await pauseRun;
  ok('暂停期间没有结束', released, `elapsed=${Date.now() - pauseStarted}`);
  ok('暂停后仍能跑完', pauseSettled.value && pauseSettled.value.ok === true);
  ok('暂停确实等了 ≥500ms', Date.now() - pauseStarted >= 500, `elapsed=${Date.now() - pauseStarted}`);

  /* ── 6. failAt：中途失败要能抛出来，给界面显示错误 ── */
  writeCfg({ ...FAST, failAt: 30 });
  let failError = null;
  try {
    await sim.start({ gameKey: 'genshin', onProgress: () => {} });
  } catch (error) {
    failError = error;
  }
  ok('failAt 会在中途抛错', Boolean(failError));
  ok('失败文案说明是演练中断', failError && failError.message.includes('网络中断'), failError && failError.message);

  /* ── 7. 应用更新：hoyo 走 install 计数，终末地走解压/整理/写盘 ── */
  writeCfg(FAST);
  const hoyoApply = await collect((onProgress) => sim.apply({ gameKey: 'genshin', onProgress }));
  ok(
    'hoyo 应用阶段是 install 且带计数',
    hoyoApply.events.every((event) => event.phase === 'install' && Number(event.total) > 0),
    hoyoApply.events.map((event) => event.phase).join(',')
  );
  eq('应用完状态落盘为 none', readState() && readState().phase, 'none');
  eq('应用完 check 变成 none', (await sim.check({ gameKey: 'genshin' })).state, 'none');

  writeCfg(FAST);
  const endApply = await collect((onProgress) => sim.apply({ gameKey: 'endfield', onProgress }));
  eq(
    '终末地应用阶段顺序 extract → stage → commit',
    endApply.events.map((event) => event.phase).join(','),
    'extract,stage,commit'
  );
  ok(
    '终末地的应用阶段没有计数（不能把进度条清零重来）',
    endApply.events.every((event) => event.total === undefined),
    JSON.stringify(endApply.events.map((event) => event.total))
  );

  /* ── 8. 强制状态：单独验某一种界面 ── */
  writeCfg({ state: 'unsupported', reason: '演练：Steam 渠道没有预下载包' });
  const unsupported = await sim.check({ gameKey: 'endfield' });
  eq('可强制 unsupported', unsupported.state, 'unsupported');
  eq('可自定义原因文案', unsupported.reason, '演练：Steam 渠道没有预下载包');
  writeCfg({ state: 'error', error: '演练：接口 502' });
  eq('可强制 error', (await sim.check({ gameKey: 'genshin' })).error, '演练：接口 502');
  writeCfg({ state: 'done' });
  eq('可强制 done', (await sim.check({ gameKey: 'genshin' })).state, 'done');
  writeCfg({ state: 'update' });
  eq('可强制 update', (await sim.check({ gameKey: 'genshin' })).state, 'update');

  /* ── 9. 只演练一款游戏时，别的游戏不能受影响 ── */
  fs.rmSync(stateFile, { force: true });
  writeCfg({ ...FAST, gameKey: 'genshin' });
  eq('限定游戏时目标游戏走演练', (await sim.check({ gameKey: 'genshin' })).state, 'available');
  const otherGame = await sim.check({ gameKey: 'nonexistent-game' });
  eq('限定游戏时别的游戏走真实实现', otherGame.state, 'unsupported');
  writeCfg({ ...FAST, gameKey: '*' });
  eq('gameKey=* 时全部演练', (await sim.check({ gameKey: 'endfield' })).state, 'available');

  /* ── 10. 关掉演练后自动摘掉假状态 ── */
  const store = {
    data: {
      games: [
        { id: 'g1', servers: [{ id: 's1', predownload: { state: 'available', dir: 'sim://predownload' } }] },
        { id: 'g2', servers: [{ id: 's2', predownload: { state: 'none', dir: 'D:/Genshin/chunk' } }] },
      ],
    },
    saved: 0,
    async saveNow() {
      this.saved += 1;
    },
  };
  eq('演练开着时 cleanup 不动数据', await sim.cleanup(store), false);
  fs.rmSync(cfgFile, { force: true });
  eq('关掉演练后 cleanup 摘掉假状态', await sim.cleanup(store), true);
  eq('假状态被清空', store.data.games[0].servers[0].predownload, null);
  ok('真实状态不受影响', Boolean(store.data.games[1].servers[0].predownload));
  eq('摘完会落盘一次', store.saved, 1);

  fs.rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((item) => !item.pass);
  for (const item of results) {
    console.log(`${item.pass ? '  ok' : '  x '} ${item.name}${item.pass || !item.detail ? '' : `  (${item.detail})`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error('[x] 测试自身崩了：', error);
  process.exit(1);
});
