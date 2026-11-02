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

const { segmentFetch } = require('./http-fetch');

/** 小于这个大小不值得分段。 */
const MIN_PARALLEL_SIZE = 8 * 1024 * 1024;
/** 单个分段的最小长度，避免小文件切出一堆几十 KB 的碎片。 */
const MIN_SEGMENT_SIZE = 1024 * 1024;
/** 默认连接数。再往上加边际收益很低，反而容易被对端限流。 */
const DEFAULT_CONNECTIONS = 16;
const MAX_CONNECTIONS = 32;
/** 分段内单次连接静默多久算超时。 */
const SEGMENT_IDLE_TIMEOUT = 25000;
/** 单分段「连上但没数据」的等待上限：比 idle 短，卡住的段尽快换掉。 */
const SEGMENT_CONNECT_TIMEOUT = 15000;
/** 探测（bytes=0-0）多久没结果就直接放弃分段。不设这个会卡在这一步不动。 */
const PROBE_TIMEOUT = 10000;
/** 全局停滞判定：这么久总进度一点没涨，就认为剩下的连接都被黑洞了。 */
const STALL_TIMEOUT = 45000;
/** 单分段最多重连几次。 */
const SEGMENT_RETRIES = 8;
/** 进度上报间隔。 */
const REPORT_INTERVAL = 250;
/** 写盘路径上的进度节流：比定时器短，界面看着才是连续走。 */
const PROGRESS_THROTTLE = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 临时诊断：HXL_UPDATE_DEBUG=1 时把下载各阶段的时间点打到主进程控制台 */
const DEBUG_DL = process.env.HXL_UPDATE_DEBUG === '1';
const dbg = (...args) => {
  if (DEBUG_DL) console.log('[dl]', new Date().toISOString().slice(11, 23), ...args);
};

/** 把「用户取消」和「超时」合成为一个 signal（旧 Node 没有 AbortSignal.any 就退化为超时）。 */
function withTimeout(externalSignal, ms) {
  const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : null;
  if (!timeout) return externalSignal || null;
  if (!externalSignal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([externalSignal, timeout]);
  return externalSignal;
}

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
 * 记住「哪个 host 认 Range」，避免每个文件都探一次。
 * 差异包动辄几十上百个文件，每个文件探测一次就是几十次多余往返，
 * 小文件本身才几百 KB，探测开销比下载还大。
 */
const rangeSupportCache = new Map(); // host -> { ok: boolean, at: number }
const RANGE_CACHE_TTL = 10 * 60 * 1000;

function rememberRangeSupport(host, ok) {
  if (!host) return;
  rangeSupportCache.set(host, { ok, at: Date.now() });
}

function knownRangeSupport(host) {
  const hit = host ? rangeSupportCache.get(host) : null;
  if (!hit) return null;
  if (Date.now() - hit.at > RANGE_CACHE_TTL) {
    rangeSupportCache.delete(host);
    return null;
  }
  return hit.ok;
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
      ...(() => {
        const merged = withTimeout(signal, PROBE_TIMEOUT);
        return merged ? { signal: merged } : {};
      })(),
    });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    // 探测卡住/超时都不要硬撑：直接告诉上层「分段不可用」，让它走单连接
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
async function pullSegment({ id, start, end, url, fd, fetchImpl, headers, counters, state, tick }) {
  let pos = start;
  let attempt = 0;
  while (pos <= end) {
    if (state.aborted) throw state.aborted;
    let response;
    try {
      // 连接阶段单独设超时：被墙黑洞的 IP 常常连得上但不回数据，
      // 没有这个超时就会一直挂在 fetch 里，进度条一动不动
      response = await fetchImpl(url, {
        headers: { ...headers, range: `bytes=${pos}-${end}` },
        signal: withTimeout(null, SEGMENT_CONNECT_TIMEOUT),
      });
    } catch (error) {
      if (state.aborted) throw state.aborted;
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
          if (!state.firstByteAt) {
            state.firstByteAt = Date.now();
            dbg('首字节到达 分段', id, value.length, 'B');
          }
          fs.writeSync(fd, value, 0, value.length, pos);
          pos += value.length;
          counters[id] = pos - start;
          /*
           * 进度必须在这里推一把，不能只靠下面的 setInterval。
           *
           * 16 条分段同时灌数据时，reader.read() 的微任务会把事件循环占满，
           * 定时器会被一路往后推——实测 200 MB 下载全程 30 秒里一次都没触发，
           * 界面就一直停在 0%，下完才瞬间跳到 100%。write 里按时间节流上报，
           * 不依赖定时器的调度，进度才是连续的。
           */
          if (typeof tick === 'function') tick();
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
 * @param {number} [options.minSize] 低于这个大小直接退单连接（默认 8 MB）
 * @param {number} [options.minSegmentSize] 单段最小长度（默认 1 MB）
 */
async function multiDownload(options) {
  const {
    url,
    dest,
    expectedSize = 0,
    report = () => {},
    fetchImpl = segmentFetch,
    headers = {},
    connections = DEFAULT_CONNECTIONS,
    minSpeed = 0,
    graceMs = 15000,
    signal = null,
    minSize = MIN_PARALLEL_SIZE,
    minSegmentSize = MIN_SEGMENT_SIZE,
  } = options;

  if (signal?.aborted) throw abortError();

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }

  /*
   * 清单里已经给了文件大小 + 这个 host 之前确认过支持 Range，
   * 就直接跳过探测：差异包里每个小文件都少一次往返。
   */
  let size = 0;
  const cachedSupport = knownRangeSupport(host);
  dbg('开始', url.slice(0, 80), '缓存支持=', cachedSupport, 'expectedSize=', expectedSize);
  /*
   * 这个 host 刚确认过不认 Range：别每个文件都再探一次。
   * 差异包里小文件动辄几千个，每探一次都是白白多一次往返 + 一次超时等待，
   * 直接抛 fallback 让上层退回单连接（单连接照样能下，只是不分段）。
   */
  if (cachedSupport === false) throw fallbackError('这台 CDN 不支持分段');
  if (cachedSupport === true && expectedSize > 0) {
    size = expectedSize;
  } else {
    let probed;
    try {
      dbg('探测开始');
      probed = await probe({ url, fetchImpl, headers, signal });
      dbg('探测完成', probed.total);
    } catch (error) {
      dbg('探测失败', error.message);
      if (cachedSupport === null) rememberRangeSupport(host, false);
      throw error;
    }
    rememberRangeSupport(host, true);
    size = probed.total || expectedSize;
  }
  if (!size) throw fallbackError('拿不到文件大小');
  if (size < minSize) throw fallbackError('文件太小，不值得分段');

  const count = Math.max(1, Math.min(MAX_CONNECTIONS, connections, Math.floor(size / minSegmentSize)));
  const chunk = Math.ceil(size / count);
  dbg('分段计划', count, '段，每段', chunk);
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
  let lastGrowthSum = -1;
  let lastGrowthAt = Date.now();
  let lastEmitAt = 0;

  /*
   * 统一的进度出口：定时器与写盘路径都会调它，靠 lastEmitAt 做时间节流，
   * 所以既不会因为定时器被饿死而断更，也不会因为每次 write 都上报把 IPC 刷爆。
   */
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_THROTTLE) return;
    if (state.aborted) return;
    lastEmitAt = now;
    const sum = counters.reduce((a, b) => a + b, 0);
    dbg('emit', Math.round((sum / size) * 100) + '%', sum);
    try {
      report(size ? (sum / size) * 100 : 0, sum, size);
    } catch {
      /* 进度回调出错不影响下载 */
    }

    /*
     * 停滞看门狗：有的线路「连得上、握手成功、就是不回数据」，
     * 单看某一段有 idle 超时也救不了——16 段一起被黑洞时，进度条能定格几分钟。
     * 这里按「总进度多久没涨」判断，超时就整批放弃，交给上层换网络栈或单连接。
     */
    if (sum > lastGrowthSum) {
      lastGrowthSum = sum;
      lastGrowthAt = now;
    } else if (sum < size && now - lastGrowthAt > STALL_TIMEOUT) {
      state.aborted = fallbackError(
        `分段下载停滞 ${Math.round(STALL_TIMEOUT / 1000)} 秒（已下 ${(sum / 1024 / 1024).toFixed(1)} MB）`
      );
      cancelActive(state);
    }

    if (minSpeed > 0 && now - started > graceMs) {
      const average = (sum / (now - started)) * 1000;
      if (average < minSpeed && sum < size) {
        const error = new Error(`下载速度过低（${(average / 1024).toFixed(0)} KB/s）`);
        error.slow = true;
        state.aborted = error;
        cancelActive(state);
      }
    }
  };

  // 定时器只负责「没数据时也要判停滞」，正常情况下走 write 里的 emit
  const timer = setInterval(() => emit(true), REPORT_INTERVAL);

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
          tick: emit,
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
