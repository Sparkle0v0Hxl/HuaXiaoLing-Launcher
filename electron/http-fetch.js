'use strict';

/**
 * 网络请求入口：优先走 Electron 的 Chromium 网络栈（net.fetch）。
 *
 * 为什么不用 Node 自带的 fetch：Node 只认自己内置的 CA 列表，不读系统证书库——
 * Steam++（Watt Toolkit）这类加速器的原理就是本地中间人代理 + 把自己的根证书装进
 * 系统证书库，Node fetch 对它伪造的证书一律校验失败；不开加速器国内又直连不上
 * GitHub，两头堵死（10-29 用户反馈：开了 Steam++ 检查更新失败，关了直连也失败）。
 * Chromium 网络栈两个问题都没有：
 *   - 证书走系统证书库，用户装了什么根证书就认什么；
 *   - 代理走系统设置，系统代理和 Steam++ 的本地端口自动生效，设置页里填的
 *     「网络代理」（setProxy）也只作用于这一条栈。
 * 自测环境（node 直接跑 selftest / test-*.js）没有 Electron，降级回 Node fetch。
 */

let electronNetFetch = null;
try {
  const electron = require('electron');
  const net = electron && electron.net;
  if (net && typeof net.fetch === 'function') electronNetFetch = net.fetch.bind(net);
} catch {
  /* 非 Electron 环境：require('electron') 拿到的是 exe 路径字符串或直接抛错 */
}

async function httpFetch(url, options = {}) {
  const { dispatcher, ...rest } = options; // dispatcher 是 undici 专属参数，Chromium 栈不认
  if (electronNetFetch) {
    try {
      return await electronNetFetch(url, rest);
    } catch (error) {
      // Chromium 栈连不上时退回 Node fetch 再试一把：两边各自的可达性盲区
      // （系统代理配置异常、证书库被改）不同，互为兜底。
      if (typeof fetch === 'function') return fetch(url, options);
      throw error;
    }
  }
  return fetch(url, options);
}

module.exports = { httpFetch };
