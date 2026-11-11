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

/**
 * 把一条引擎原始进度事件补成界面直接能用的形状。
 *
 * 补三样：
 *  - bytesPerSec：速度（0 表示算不出来，界面就不显示，绝不显示假的 0 B/s）
 *  - etaSeconds ：剩余时间（0 表示未知）
 *  - percent   ：总百分比（0~100；没有总量时给 -1，让界面显示不确定态而不是 0%）
 *
 * 注意 bytesDone 的语义在不同链路不一样（下载阶段是「已就位」含复用，
 * 安装阶段是「已写入」），这里不做换算，只按同一口径算速率 —— 每个阶段
 * 内部 bytesDone 都是单调递增的，速率就是对的。
 */
function createMeter(send) {
  const samplers = new Map();

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
    const remain = total > done ? total - done : 0;
    send({
      ...event,
      bytesPerSec: speed,
      etaSeconds: speed > 0 && remain > 0 ? Math.round(remain / speed) : 0,
      percent: total > 0 ? Math.max(0, Math.min(100, Math.floor((done / total) * 100))) : -1,
    });
  };
}

module.exports = { createMeter, createSpeedSampler };
