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
 *
 * 兜底为什么要自己写 node:https：Electron 主进程里的全局 fetch 就是 net.fetch 的别名，
 * 直接调它等于原地重试。web.hycdn.cn 这类 CDN 在 Chromium 栈里 TLS 握手会失败
 * （net_error -101），而 Node 的 TLS 实现能通——这条路是 11-02 做官方背景同步时找出来的。
 * 兜底返回标准 Response（body 是 Web 流），多连接下载的 getReader() 用法照旧。
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

let electronNetFetch = null;
try {
  const electron = require('electron');
  const net = electron && electron.net;
  if (net && typeof net.fetch === 'function') electronNetFetch = net.fetch.bind(net);
} catch {
  /* 非 Electron 环境：require('electron') 拿到的是 exe 路径字符串或直接抛错 */
}

/** 用 node 的 http/https 发请求，返回标准 Response（body 为 Web 流）。 */
function nodeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (body && typeof body !== 'string' && !Buffer.isBuffer(body)) body = String(body);
    if (body && !headers['content-length'] && !headers['Content-Length']) {
      headers['content-length'] = Buffer.byteLength(body);
    }
    if (!headers['accept-encoding'] && !headers['Accept-Encoding']) headers['accept-encoding'] = 'gzip, deflate';

    const request = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: (options.method || 'GET').toUpperCase(),
        headers,
        // 国内 CDN 的证书链在 Node 内置 CA 里可能缺一环；这条路径只是兜底，
        // 不校验证书反而更不容易「两边都连不上」
        rejectUnauthorized: false,
        timeout: options.timeout || 120000,
      },
      (response) => {
        const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
        let stream = response;
        if (encoding === 'gzip') stream = response.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = response.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = response.pipe(zlib.createBrotliDecompress());

        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
          else if (value != null) responseHeaders.set(key, String(value));
        }
        // body 已经被解压过，别让消费方再解一次
        if (encoding) responseHeaders.delete('content-encoding');

        // 204 / 304 不能带 body
        const noBody = response.statusCode === 204 || response.statusCode === 304;
        resolve(
          new Response(noBody ? null : Readable.toWeb(stream), {
            status: response.statusCode || 0,
            statusText: response.statusMessage || '',
            headers: responseHeaders,
          })
        );
      }
    );
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
    if (options.signal) {
      if (options.signal.aborted) {
        request.destroy(new Error('ABORTED'));
        return;
      }
      options.signal.addEventListener('abort', () => request.destroy(new Error('ABORTED')), { once: true });
    }
    if (body) request.write(body);
    request.end();
  });
}

async function httpFetch(url, options = {}) {
  const { dispatcher, ...rest } = options; // dispatcher 是 undici 专属参数，Chromium 栈不认
  if (electronNetFetch) {
    try {
      return await electronNetFetch(url, rest);
    } catch (error) {
      // Chromium 栈连不上时退回 Node 的 https 栈再试一把：两边各自的可达性盲区
      // （系统代理配置异常、证书库被改、个别 CDN 的 TLS 实现差异）不同，互为兜底。
      if (error && (error.name === 'AbortError' || error.message === 'ABORTED')) throw error;
      return nodeRequest(url, rest);
    }
  }
  // 纯 Node 环境（自测脚本）：用原生 fetch，行为最完整
  return fetch(url, rest);
}

module.exports = { httpFetch, nodeRequest };
