'use strict';

/**
 * 多连接分段下载（IDM / NDM 那套做法）。
 *
 * 背景：GitHub Release 的直连在国内容易被限到每条连接几十 KB/s，
 * 单连接下载 180 MB 要一个小时。实测同样的地址开 32 条连接能到 1~2 MB/s，
 * 瓶颈是「每条连接」而不是「总带宽」，所以分段并发是唯一能立刻见效的改法。
 *
 * 用法：
 *   const { multiDownload } = require('./multi-download');
 *   await multiDownload({ url, dest, expectedSize, report, fetchImpl });
 *
 * 约定：
 *   - fetchImpl 由调用方注入，保持和更新器一致（Electron net.fetch 走系统代理
 *     和系统证书库，Steam++ 之类的加速器才生效）。不传则用全局 fetch。
 *   - 服务器不支持 Range、文件太小、或任何环节不对劲时抛 `fallbackToSingle`
 *     错误，调用方退回原来的单连接下载，不会卡死在分段逻辑上。
 *   - 每个分段独立重试，断点位置就是该分段已写入的字节数，所以中途断了能续。
 *   - 传了 signal 就能取消：立刻掐断所有在途分段并抛 code='ABORTED'。
 *     ⚠️ 分段下载会先把文件按总长预分配，中断后文件里是「洞」而不是前缀，
 *     所以取消/失败时调用方必须把半截文件删掉（否则会被当成完整的）。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** 小于这个大小不值得分段。 */
const MIN_PARALLEL_SIZE = 8 * 1024 * 1024;
/** 单个分段的最小长度，避免小文件切出一堆几十 KB 的碎片。 */
const MIN_SEGMENT_SIZE = 1024 * 1024;
/** 默认连接数。再往上加边际收益很低，反而容易被对端限流。 */
const DEFAULT_CONNECTIONS = 16;
const MAX_CONNECTIONS = 32;
/** 分段内单次连接静默多久算超时。 */
const SEGMENT_IDLE_TIMEOUT = 25000;
/** 单分段最多重连几次。 */
const SEGMENT_RETRIES = 8;
/** 进度上报间隔。 */
const REPORT_INTERVAL = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fallbackError(message) {
  const error = new Error(message);
  error.fallbackToSingle = true;
  return error;
}

/** 取消下载：上层据此区分「用户点了取消」和「真的失败了」。 */
function abortError() {
  const error = new Error('下载已取消');
  error.code = 'ABORTED';
  return error;
}

/** 掐断所有在途分段。state.active 里放的是 reader（body 已被 getReader 锁住）。 */
function cancelActive(state) {
  for (const reader of state.active) {
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* 已经关闭 */
    }
  }
}

/** 从 content-range 里抠总长度：bytes 0-0/188054180 */
function totalFromContentRange(value) {
  const match = /\/(\d+)\s*$/.exec(String(value || ''));
  return match ? Number(match[1]) : 0;
}

/**
 * 探测：服务器认不认 Range、文件多大。
 * 用 bytes=0-0 只取一个字节，代价可以忽略。
 */
async function probe({ url, fetchImpl, headers, signal }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { ...headers, range: 'bytes=0-0' },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw fallbackError(`分段探测失败：${error.message}`);
  }
  try {
    if (response.status === 206) {
      const total = totalFromContentRange(response.headers.get('content-range'));
      if (!total) throw fallbackError('分段探测拿不到文件总长');
      return { total, ranges: true };
    }
    // 200 = 服务器无视 Range，老老实实单连接
    const total = Number(response.headers.get('content-length')) || 0;
    throw fallbackError(`服务器不支持分段下载（HTTP ${response.status}）${total ? '' : ''}`);
  } finally {
    try {
      await response.body?.cancel();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 拉一个分段：start~end（含端点），写到 fd 的对应偏移。
 * 中途断了就从 pos 续，不从头来。
 */
async function pullSegment({ id, start, end, url, fd, fetchImpl, headers, counters, state }) {
  let pos = start;
  let attempt = 0;
  while (pos <= end) {
    if (state.aborted) throw state.aborted;
    let response;
    try {
      response = await fetchImpl(url, { headers: { ...headers, range: `bytes=${pos}-${end}` } });
    } catch (error) {
      if (++attempt > SEGMENT_RETRIES) throw new Error(`分段 ${id} 连接失败：${error.message}`);
      await sleep(Math.min(4000, 400 * attempt));
      continue;
    }
    if (response.status !== 206) {
      try {
        await response.body?.cancel();
      } catch {
        /* 忽略 */
      }
      if (response.status === 200) throw fallbackError('分段请求被降级为整包响应');
      if (++attempt > SEGMENT_RETRIES) throw new Error(`分段 ${id} HTTP ${response.status}`);
      await sleep(Math.min(4000, 400 * attempt));
      continue;
    }
    let reader = null;
    try {
      reader = response.body.getReader();
      // 掐断连接必须用 reader.cancel()：body 已经被 getReader() 锁住，
      // 再调 body.cancel() 只会抛 ERR_INVALID_STATE（取消/卡顿判定都会踩到）
      state.active.add(reader);
      let idleTimer = setTimeout(() => {
        reader.cancel().catch(() => {});
      }, SEGMENT_IDLE_TIMEOUT);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          reader.cancel().catch(() => {});
        }, SEGMENT_IDLE_TIMEOUT);
        if (value && value.length) {
          fs.writeSync(fd, value, 0, value.length, pos);
          pos += value.length;
          counters[id] = pos - start;
        }
        if (state.aborted) break;
      }
      clearTimeout(idleTimer);
    } catch (error) {
      if (state.aborted) throw state.aborted;
      // 流中断：pos 已经推进过，下一轮从这里续
      if (++attempt > SEGMENT_RETRIES) throw new Error(`分段 ${id} 传输失败：${error.message}`);
      await sleep(Math.min(4000, 400 * attempt));
    } finally {
      if (reader) state.active.delete(reader);
    }
  }
}

/**
 * @param {object} options
 * @param {string} options.url 下载地址
 * @param {string} options.dest 落盘路径
 * @param {number} [options.expectedSize] 清单里写的大小，用于最后比对
 * @param {(percent:number, received:number, total:number)=>void} [options.report] 进度回调
 * @param {Function} [options.fetchImpl] 注入的 fetch，默认全局 fetch
 * @param {object} [options.headers] 额外请求头
 * @param {number} [options.connections] 连接数
 * @param {number} [options.minSpeed] 低于这个速度（字节/秒）就判定这条线路不值得等
 * @param {number} [options.graceMs] 速度判定的观察窗口
 * @param {AbortSignal} [options.signal] 取消信号
 */
async function multiDownload(options) {
  const {
    url,
    dest,
    expectedSize = 0,
    report = () => {},
    fetchImpl = (...args) => fetch(...args),
    headers = {},
    connections = DEFAULT_CONNECTIONS,
    minSpeed = 0,
    graceMs = 15000,
    signal = null,
  } = options;

  if (signal?.aborted) throw abortError();

  const { total, ranges } = await probe({ url, fetchImpl, headers, signal });
  if (!ranges) throw fallbackError('不支持分段');
  const size = total || expectedSize;
  if (!size) throw fallbackError('拿不到文件大小');
  if (size < MIN_PARALLEL_SIZE) throw fallbackError('文件太小，不值得分段');

  const count = Math.max(1, Math.min(MAX_CONNECTIONS, connections, Math.floor(size / MIN_SEGMENT_SIZE)));
  const chunk = Math.ceil(size / count);
  const counters = new Array(count).fill(0);
  const state = { aborted: null, active: new Set() };

  // 取消：掐断在途分段，pullSegment 里的 read() 会立刻结束，主流程走 abort 分支。
  const onAbort = () => {
    if (state.aborted) return;
    state.aborted = abortError();
    cancelActive(state);
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const fd = await fsp.open(dest, 'w');
  try {
    await fd.truncate(size);
  } catch {
    /* 预分配失败不影响写入 */
  }
  const handle = fd.fd;

  const started = Date.now();
  let lastSum = 0;
  let lastAt = Date.now();
  const timer = setInterval(() => {
    const sum = counters.reduce((a, b) => a + b, 0);
    const now = Date.now();
    const instant = ((sum - lastSum) / Math.max(1, now - lastAt)) * 1000;
    lastSum = sum;
    lastAt = now;
    try {
      report(size ? (sum / size) * 100 : 0, sum, size);
    } catch {
      /* 进度回调出错不影响下载 */
    }
    if (minSpeed > 0 && now - started > graceMs) {
      const average = (sum / (now - started)) * 1000;
      if (average < minSpeed && sum < size) {
        const error = new Error(`下载速度过低（${(average / 1024).toFixed(0)} KB/s）`);
        error.slow = true;
        state.aborted = error;
        cancelActive(state);
        void instant;
      }
    }
  }, REPORT_INTERVAL);

  try {
    const tasks = [];
    for (let i = 0; i < count; i += 1) {
      const start = i * chunk;
      const end = Math.min(size - 1, start + chunk - 1);
      if (start > end) continue;
      tasks.push(
        pullSegment({
          id: i,
          start,
          end,
          url,
          fd: handle,
          fetchImpl,
          headers,
          counters,
          state,
        })
      );
    }
    await Promise.all(tasks);
    if (state.aborted) throw state.aborted;
  } finally {
    clearInterval(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    await fd.close().catch(() => {});
  }

  const stat = await fsp.stat(dest);
  if (stat.size !== size) throw new Error(`分段下载大小不符（期望 ${size}，实际 ${stat.size}）`);
  if (expectedSize && stat.size !== expectedSize) {
    throw new Error(`更新包大小不对（清单写 ${expectedSize}，实际 ${stat.size}）`);
  }
  try {
    report(100, size, size);
  } catch {
    /* 忽略 */
  }
  return dest;
}

module.exports = {
  multiDownload,
  DEFAULT_CONNECTIONS,
  MIN_PARALLEL_SIZE,
};
