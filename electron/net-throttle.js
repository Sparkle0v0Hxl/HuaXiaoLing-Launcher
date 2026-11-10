'use strict';

/**
 * 全局下载限速。
 *
 * 为什么需要：几个下载链路的实际吞吐差得很远，最快的能把千兆宽带吃干净——
 * 实测终末地国际服差异包（`endfield-packs.js` 的 `packSegmentPlan` 给 16 段）
 * 稳定跑到 127.8 MB/s，等于 1 Gbps 满载；同一台机器上别的设备看视频必然卡。
 * 用户要的是「给个上限，别把宽带全占了」，所以这里做的是**全局总量**限速，
 * 不是每个文件各自限速——16 路并发共享同一个配额，加起来不超过设定值。
 *
 * 实现是「累计量对时间」的漏桶：每读一块就记一笔，超过配额的进度就 sleep
 * 到该有的时刻。不做精细的令牌桶是因为下载块大小不均（几 KB 到几 MB），
 * 令牌桶在块粒度上要么一次性发太多、要么把小请求饿死；按「已读总量应该用掉
 * 多少时间」反推等待时间，天然平滑，也不需要维护队列。
 *
 * 默认 limit = 0 表示不限速，此时 consume() 直接返回，调用方的行为与不加
 * 这个模块完全一致——这一点很重要，热路径（16 连接分段下载）在默认配置下
 * 必须零变化。
 */

/** 0 = 不限速（字节/秒） */
let limitBytesPerSec = 0;

/** 本窗口内已放行的字节数 */
let grantedBytes = 0;

/** 本窗口开始时刻 */
let windowStartedAt = Date.now();

/**
 * 等待中的请求数。超过太多就直接放行：限速绝不能把下载卡成死循环——
 * 万一时间计算出了问题，宁可短暂超速也不能让下载停住。
 */
let pending = 0;

const MAX_PENDING = 400;

/** 窗口超过这个长度就重置计数，避免浮点误差和长时间运行的漂移 */
const WINDOW_RESET_MS = 5000;

/**
 * 单个 consume 调用最多等这么久（毫秒）。
 *
 * 为什么要有个上限：等待时间不能无限长，否则取消信号没法及时响应、
 * 进度回调也会长时间不刷新。但上限也不能太小——太小的话「块大小 ÷ 上限」
 * 就成了实际速率的托底：设 100 KB/s 却因为每块最多只等 2 秒而跑出几 MB/s。
 * 8 秒是掐着 multi-download.js 的 SEGMENT_IDLE_TIMEOUT(25s) 取的一半不到：
 * 一段连续 8 秒没有新数据就要被判成卡住重连，等得更久反而帮倒忙。
 */
const MAX_WAIT_MS = 8000;

/**
 * 绝对值上限（1 GB/s）。设置页那边已经按 100 MB/s 夹过一次，这里再挡一道：
 * 万一哪天有人从配置文件里塞了个 Infinity 进来，限速会变成「永远等不完」，
 * 下载直接挂死。宁可当不限速处理，也不能把下载锁死。
 */
const MAX_LIMIT_BYTES = 1024 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 设置限速值。
 * @param {number} bytesPerSec 字节/秒；0 或负数表示不限速
 */
function setLimit(bytesPerSec) {
  const raw = Math.floor(Number(bytesPerSec) || 0);
  const next = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT_BYTES) : 0;
  if (next === limitBytesPerSec) return limitBytesPerSec;
  limitBytesPerSec = next;
  grantedBytes = 0;
  windowStartedAt = Date.now();
  return limitBytesPerSec;
}

function getLimit() {
  return limitBytesPerSec;
}

/** 界面上更愿意看到 MB/s，这里给个换算（1 MB = 1024 KB，和下载速度显示口径一致）。 */
function limitMbPerSec() {
  return limitBytesPerSec / (1024 * 1024);
}

/**
 * 记一笔已读取的字节，必要时等待到「按限速应该有这么多」的时刻。
 *
 * @param {number} bytes 刚读到的字节数
 * @returns {Promise<void>}
 */
async function consume(bytes) {
  const size = Number(bytes) || 0;
  if (!limitBytesPerSec || size <= 0) return;
  // 排队太长说明时间计算已经跟不上，直接放行，绝不把下载拖死
  if (pending >= MAX_PENDING) return;

  grantedBytes += size;
  const now = Date.now();

  // 窗口重置：只在没有积压时做，否则会把「该等的时间」一起清掉、瞬间超速
  if (now - windowStartedAt >= WINDOW_RESET_MS && pending === 0) {
    grantedBytes = size;
    windowStartedAt = now;
    return;
  }

  pending += 1;
  try {
    // 分片等待 + 每次重算：并发下别的工人也在记账，算一次就睡到底会越跑越快。
    // 上限 8 秒是掐着 multi-download.js 的 SEGMENT_IDLE_TIMEOUT(25s) 定的一半不到——
    // 等太久会被那边判成「段卡住」然后重连，反而更糟。
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      const nowMs = Date.now();
      const elapsedSec = (nowMs - windowStartedAt) / 1000;
      const expectedSec = grantedBytes / limitBytesPerSec;
      const aheadSec = expectedSec - elapsedSec;
      if (aheadSec <= 0.0005) break;
      const remainingMs = deadline - nowMs;
      if (remainingMs <= 0) break;
      await sleep(Math.min(250, remainingMs, Math.ceil(aheadSec * 1000)));
    }
  } finally {
    pending -= 1;
  }
}

/**
 * 把一个「可能是 Web 流、也可能是 Node 流」的响应体包成节流的异步可迭代对象。
 *
 * 调用方写法不变：`for await (const piece of throttleBody(response.body))`。
 * 不在这里做 Response 重建，是因为各下载点的消费方式不统一（有的用
 * `for await`、有的用 `getReader()`、有的 `Readable.fromWeb` + pipeline），
 * 重建 Response 反而要求每个点都改。直接包可迭代对象，改动只在循环那一行。
 *
 * @template T
 * @param {AsyncIterable<T>|ReadableStream<T>|null|undefined} body
 * @returns {AsyncIterable<T>|null|undefined}
 */
function throttleBody(body) {
  if (!body || !limitBytesPerSec) return body;
  if (typeof body[Symbol.asyncIterator] === 'function') {
    return (async function* throttled() {
      for await (const piece of body) {
        await consume(piece && piece.length ? piece.length : 0);
        yield piece;
      }
    })();
  }
  // Web ReadableStream：用 reader 适配成异步迭代
  if (typeof body.getReader === 'function') {
    return (async function* throttled() {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await consume(value && value.length ? value.length : 0);
          yield value;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* 已释放 */
        }
      }
    })();
  }
  return body;
}

/**
 * 给 `multi-download.js`、`updater.js` 这类用 `getReader()` 手写读循环的地方用：
 * 包一层 reader，`read()` 的返回值先过限速再交出去。其余接口（cancel、releaseLock）
 * 原样透传，取消语义不受影响。
 *
 * @param {ReadableStreamDefaultReader} reader
 */
function throttleReader(reader) {
  if (!limitBytesPerSec) return reader;
  return {
    async read() {
      const result = await reader.read();
      if (!result.done && result.value && result.value.length) {
        await consume(result.value.length);
      }
      return result;
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
    releaseLock() {
      return reader.releaseLock();
    },
    get closed() {
      return reader.closed;
    },
  };
}

/**
 * 把整个响应体读成 Buffer，途中照样限速。
 *
 * 有几处下载点是 `Buffer.from(await response.arrayBuffer())` 一次性读的
 * （清单、渠道 SDK、分块数据）。arrayBuffer() 没法在中途插等待，所以这里
 * 改成按流读、边读边记账，最后拼成 Buffer —— 对调用方是完全等价的返回值。
 *
 * 不限速时退回 arrayBuffer()，与原来逐行一致（也不额外占一份内存拷贝）。
 *
 * @param {Response} response
 * @returns {Promise<Buffer>}
 */
async function toBuffer(response) {
  if (!limitBytesPerSec || !response || !response.body) {
    return Buffer.from(await response.arrayBuffer());
  }
  const parts = [];
  for await (const piece of throttleBody(response.body)) {
    parts.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece));
  }
  return Buffer.concat(parts);
}

/** 供自测/诊断读当前窗口状态（产品代码不用）。 */
function stats() {
  return {
    limit: limitBytesPerSec,
    grantedBytes,
    windowMs: Date.now() - windowStartedAt,
    pending,
  };
}

module.exports = {
  setLimit,
  getLimit,
  limitMbPerSec,
  consume,
  throttleBody,
  throttleReader,
  toBuffer,
  stats,
};
