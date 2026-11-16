'use strict';

/**
 * 可取消/可暂停的信号 —— 一个「既是真 AbortSignal、又带 cancelled/paused 老字段」的混合体。
 *
 * 为什么需要它（2026-11-16 审计）：
 *   主进程里大量任务用 `const signal = { cancelled: false }` 这种**手造普通对象**
 *   当取消信号，IPC 层的 cancel / pause 处理器直接 `job.cancelled = true` /
 *   `job.paused = x` 赋值。这套写法在「只做轮询判断」的地方没问题
 *   （`if (signal.cancelled) throw`、`while (signal.paused) sleep`）。
 *
 *   但只要这条链里有一处把 signal **原样递给 fetch**，就必然炸：
 *     · node:https 栈（http-fetch.js:181）调 `signal.addEventListener('abort', …)`
 *       → TypeError: options.signal.addEventListener is not a function
 *     · Chromium/undici 栈严格要求 AbortSignal 实例
 *       → TypeError: RequestInit: Expected signal ("{ cancelled: false }") to be an instance of AbortSignal
 *
 *   实测（2026-11-16，本地 HTTP 服务 + 真源码 require）：
 *     kuro-packs.downloadOne({ signal: { cancelled: false } })
 *       → TypeError: RequestInit: Expected signal ("{ cancelled: false }") ...
 *     鸣潮预下载（predownload:start）与「应用预下载」（predownload:apply 走暂存）
 *     正是这条链，所以那条功能一直是坏的。鸣潮「更新游戏」没坏，是因为
 *     kuro-predownload.updateGameFromBundle 里单独做了 signal 规范化兜底。
 *
 * 本模块的解法：造一个**真正的 AbortController().signal**，再用
 * Object.defineProperty 往上挂 `cancelled` / `paused` 访问器：
 *   · 读 `signal.cancelled` → 反映当前是否已取消（含被 abort 的情况）
 *   · 写 `signal.cancelled = true` → 同时把底层 controller abort 掉，
 *     在途的 fetch/流会立刻中断，比 300ms 轮询更及时
 *   · 读/写 `signal.paused` → 纯标记，不碰 abort（暂停语义靠各下载循环自己轮询）
 *   · `signal instanceof AbortSignal` → true，fetch 系列照收
 *
 * 于是 IPC 层不需要改任何 `job.cancelled = true` 的写法，
 * 下游也能拿到合法 AbortSignal —— 两头都满足。
 */

/**
 * @returns {AbortSignal & { cancelled: boolean, paused: boolean }}
 */
function createCancelSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  let cancelled = false;
  let paused = false;

  Object.defineProperty(signal, 'cancelled', {
    configurable: true,
    enumerable: true,
    get() {
      return cancelled || signal.aborted;
    },
    set(value) {
      cancelled = Boolean(value);
      if (cancelled) {
        try {
          controller.abort();
        } catch {
          /* 已经 abort 过 */
        }
      }
    },
  });

  Object.defineProperty(signal, 'paused', {
    configurable: true,
    enumerable: true,
    get() {
      return paused;
    },
    set(value) {
      paused = Boolean(value);
    },
  });

  return signal;
}

module.exports = { createCancelSignal };
