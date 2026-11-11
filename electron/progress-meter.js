/*
 * 进度计量器：给各条下载 / 更新 / 硬链接链路补上「速度」和「剩余时间」。
 *
 * 为什么放在主进程而不是渲染层：
 *  1. 所有 onProgress 都在主进程节流（hardlinkTree 160ms、predownload 120ms），
 *     采样点的密度由这里掌握；渲染层只能被动收事件，间隔一抖算出来的速度就乱跳。
 *  2. ETA 需要「剩余量 ÷ 当前速率」，而 totalBytes 只有主进程全程持有 ——
 *     渲染层收到的某些事件会把 totalBytes 覆盖成 0（比如「本地复用不可用」这种
 *     无计数的提示事件），一旦被覆盖，渲染层算出来的 ETA 就是 0 或 Infinity。
 *  3. 已有成熟实现可抄：endfield-packs.js 里的 sampleSpeed()（3 秒滑动窗）
 *     和 bytesPerSecond()，这套口径已经在真机上跑过很久。
 *
 * 用法：
 *   const { createMeter } = require('./progress-meter');
 *   const meter = createMeter((event) => send('sophon:progress', event));
 *   ... onProgress: meter
 * 计量器只是「包一层」，不改任何引擎内部逻辑，拿到的字段原样透传，只多补三个。
 */

/** 滑动窗长度：最近 3 秒的采样算速率。太短会抖，太长反应慢。 */
const WINDOW_MS = 3000;
/** 两次采样间隔低于这个值就不采纳（节流太密时避免 0 秒除法）。 */
const MIN_SAMPLE_MS = 120;

/**
 * 按「已完成的字节数」建一个速率估算器。
 *
 * 刻意不依赖事件频率：只在 done 真的涨了的时候记一个采样点，
 * 所以引擎那边改成 60ms 还是 500ms 节流都不影响结果。
 */
function createSpeedSampler() {
  let samples = [];
  let lastDone = -1;

  return function sample(done, now = Date.now()) {
    const bytes = Number(done) || 0;
    // 字节没涨（比如「正在读清单」这种只改 current 的事件）：沿用上一次的速率
    if (bytes === lastDone) {
      return samples.length >= 2 ? speedOf(samples) : 0;
    }
    lastDone = bytes;
    const last = samples[samples.length - 1];
    if (last && now - last.t < MIN_SAMPLE_MS) {
      // 同一个节流窗口内的抖动：只更新最后一个采样的字节，不新增点
      last.bytes = bytes;
    } else {
      samples.push({ t: now, bytes });
    }
    while (samples.length > 2 && now - samples[0].t > WINDOW_MS) samples.shift();
    return speedOf(samples);
  };

  function speedOf(list) {
    if (list.length < 2) return 0;
    const first = list[0];
    const final = list[list.length - 1];
    const seconds = (final.t - first.t) / 1000;
    if (seconds <= 0) return 0;
    const speed = (final.bytes - first.bytes) / seconds;
    return Number.isFinite(speed) && speed > 0 ? Math.round(speed) : 0;
  }
}

/*
 * 阶段 → 三条子任务中的哪一行。
 *
 * 官方式面板是三行分开显示（下载 / 安装 / 校验），每行有自己的完成量、总量与速度，
 * 所以这里要把不同 phase 的字节数归到各自的行上，并且**累计**保留 ——
 * 一条链路的同一时刻只有一个阶段在动，但面板要同时看到前面已经走过的量。
 *
 * 映射依据（各引擎实际发的 phase）：
 *   download / ldiff / link / predownload → 下载行（取文件；link 是复用本机已有文件，用户语义等于不用再下）
 *   install / patch / overlay             → 安装行（写入目标目录）
 *   verify                               → 校验行（逐文件 md5）
 */
const ROW_OF_PHASE = {
  download: 'download',
  ldiff: 'download',
  link: 'download',
  predownload: 'download',
  // 硬链接去重链路的阶段名：扫描 / 比对（还没开始链，但用户语义上仍在「取文件」这一步）
  scan: 'download',
  compare: 'download',
  // 更新包本身的下载：算进下载行，否则下更新包那十几分钟面板一行数据都没有
  pack: 'download',
  install: 'install',
  patch: 'install',
  overlay: 'install',
  verify: 'verify',
};

/**
 * 把一条引擎原始进度事件补成界面直接能用的形状。
 *
 * 补四样：
 *  - bytesPerSec：当前阶段的速度（0 表示算不出来，界面就不显示，绝不显示假的 0 B/s）
 *  - etaSeconds ：当前阶段的剩余时间（0 表示未知）
 *  - percent   ：总百分比（0~100；没有总量时给 -1，让界面显示不确定态而不是 0%）
 *  - rows      ：下载 / 安装 / 校验三行各自的 {done,total,bytesPerSec}，累计保留
 *
 * 注意 bytesDone 的语义在不同链路不一样（下载阶段是「已就位」含复用，
 * 安装阶段是「已写入」），所以三行的取值口径在这里分开写死，不让渲染层猜：
 * 下载行优先 netBytes（真下网量），安装行用 bytesDone，校验行用 verifiedBytes。
 */
function createMeter(send) {
  const samplers = new Map();
  // 三条子任务的累计状态：key -> { done, total, speed }
  const rows = new Map();

  const rowOf = (key) => {
    if (!rows.has(key)) rows.set(key, { done: 0, total: 0, speed: 0, sampler: createSpeedSampler() });
    return rows.get(key);
  };

  return function meter(event) {
    if (!event || typeof event !== 'object') {
      send(event);
      return;
    }
    const phase = String(event.phase || '');
    // 每个阶段单独一个采样器：从 download 切到 install 时字节含义变了，
    // 混在一起算会得到负数或离谱值（比如 install 从头计数，速率直接变负）。
    if (!samplers.has(phase)) samplers.set(phase, createSpeedSampler());
    const done =
      Number(event.bytesDone ?? event.downloadedBytes ?? event.downloaded ?? event.processed) || 0;
    const total = Number(event.totalBytes ?? event.total) || 0;
    const speed = samplers.get(phase)(done);

    /*
     * 更新对应那一行的累计值。
     *
     * 下载行用 netBytes（真下网量）而不是 bytesDone：bytesDone 把「命中缓存 / 硬链接复用」
     * 也算进去了，拿它当下载量会让进度条冲到 90% 而网卡几乎没动，用户会以为卡死。
     */
    const rowKey = ROW_OF_PHASE[phase] || '';
    if (rowKey) {
      const row = rowOf(rowKey);
      let rowDone = done;
      if (rowKey === 'download') {
        const net = Number(event.netBytes);
        if (Number.isFinite(net) && net > 0) rowDone = net;
      } else if (rowKey === 'verify') {
        const verified = Number(event.verifiedBytes);
        if (Number.isFinite(verified) && verified > 0) rowDone = verified;
      }
      // 只前进不后退：某些引擎会在阶段切换时把计数清零重来
      if (rowDone >= row.done) row.done = rowDone;
      if (total > 0) row.total = total;
      row.speed = row.sampler(row.done);
    }
    /*
     * 校验行单独喂一份。
     *
     * sophon 的 md5 校验是「写完一个文件就顺手校一个」，它没有独立 phase，
     * 只在 install 帧里带 verifiedBytes。所以不能靠 ROW_OF_PHASE 走：
     * 那样校验行永远是空的，而用户看到的官方面板是有「✓ 校验」这一行的。
     */
    const verifiedBytes = Number(event.verifiedBytes);
    if (Number.isFinite(verifiedBytes) && verifiedBytes > 0) {
      const row = rowOf('verify');
      if (verifiedBytes >= row.done) row.done = verifiedBytes;
      if (total > 0) row.total = total;
      row.speed = row.sampler(row.done);
    }

    // 打包三行快照（只带出现过的行，没出现的行界面自然不画）
    const rowSnapshot = {};
    for (const [key, row] of rows) {
      if (row.done > 0 || row.total > 0) {
        rowSnapshot[key] = { done: row.done, total: row.total, bytesPerSec: row.speed || 0 };
      }
    }

    const remain = total > done ? total - done : 0;
    send({
      ...event,
      bytesPerSec: speed,
      etaSeconds: speed > 0 && remain > 0 ? Math.round(remain / speed) : 0,
      percent: total > 0 ? Math.max(0, Math.min(100, Math.floor((done / total) * 100))) : -1,
      rows: rowSnapshot,
    });
  };
}

module.exports = { createMeter, createSpeedSampler };
