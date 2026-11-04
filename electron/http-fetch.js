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
const proxyTunnel = require('./proxy-agent');

let electronNetFetch = null;
try {
  const electron = require('electron');
  const net = electron && electron.net;
  if (net && typeof net.fetch === 'function') electronNetFetch = net.fetch.bind(net);
} catch {
  /* 非 Electron 环境：require('electron') 拿到的是 exe 路径字符串或直接抛错 */
}

/*
 * 复用连接（keep-alive）。
 *
 * 渠道包里绝大多数是十几 KB 的小文件，一次一个连接的话，每个文件光 TCP + TLS
 * 握手就要 100~300 ms，真正的传输只有几毫秒——「硬链接生成一份」走几千个文件，
 * 时间几乎全耗在握手上。这里按协议共享一个 keep-alive agent，同 host 的空闲
 * socket 直接复用，握手只发生在第一批连接上。
 *
 * maxSockets 给到 64：分段下载（单个大文件最多 16 段）和文件级并发（8 个文件
 * ×2 段）叠起来也在预算内，不会互相排队。
 */
const agentOptions = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 64, maxFreeSockets: 16 };
const httpsAgent = new https.Agent(agentOptions);
const httpAgent = new http.Agent(agentOptions);

/** 用 node 的 http/https 发请求，返回标准 Response（body 为 Web 流）。
 *
 * ⚠️ 必须自己跟随 3xx：GitHub Release 的下载地址会 302 到
 * objects.githubusercontent.com。这条兜底路径如果不跟重定向，分段请求拿到的
 * 就是一个空 302（不是 206），多连接会整体判失败、悄悄退回单连接——
 * 表现就是「加了多线程还是几十 KB/s」。
 */
function performRequest(url, options = {}, redirects = 0) {
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
        // 同 host 复用空闲连接：小文件下载省掉每次的 TCP/TLS 握手。
        // 走代理时用隧道的 Agent（每个代理一个池，同样是 keep-alive）
        agent: options.agent || (isHttps ? httpsAgent : httpAgent),
        // 国内 CDN 的证书链在 Node 内置 CA 里可能缺一环；这条路径只是兜底，
        // 不校验证书反而更不容易「两边都连不上」
        rejectUnauthorized: false,
        timeout: options.timeout || 120000,
      },
      (response) => {
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && redirects < 5) {
          response.resume();
          const nextUrl = new URL(location, url).href;
          const nextHeaders = { ...headers };
          // 换了主机就别把 origin 带过去；range / ua 这些要留着，分段靠它
          delete nextHeaders.host;
          delete nextHeaders.Host;
          delete nextHeaders.origin;
          delete nextHeaders.Origin;
          // GET/HEAD 重发不带 body；POST 的 307/308 才需要原样重发
          const keepBody = body && (status === 307 || status === 308);
          // 剥掉 agent：跨域重定向要按新目标重新选路（代理可能只对某些域名生效）
          const { agent: _dropAgent, ...restOptions } = options;
          resolve(
            nodeRequest(
              nextUrl,
              { ...restOptions, headers: nextHeaders, body: keepBody ? body : undefined },
              redirects + 1
            )
          );
          return;
        }

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
        const noBody = status === 204 || status === 304;
        resolve(
          new Response(noBody ? null : Readable.toWeb(stream), {
            status,
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

/**
 * 带选路的 node 请求：直连 / 代理隧道二选一，失败自动换另一条。
 *
 * 为什么不在请求里写死 agent：用户的代理配置是「按目标域名」生效的（Clash
 * 规则模式、PAC 都一样）——国际服的 CDN 要走加速器，国内接口反而必须直连。
 * 所以每条请求都问一次 proxy-agent，由它按 origin 缓存决策结果。
 *
 * 失败处理：代理挂掉就标记 5 分钟，期间直接走直连；直连挂掉同理。真正两条
 * 都不通时抛错，由上层（segmentFetch / httpFetch）退回 Chromium 栈。
 */
async function nodeRequest(url, options = {}) {
  // 调用方自己指定了 agent（自测、特殊场景），不插手
  if (options.agent) return performRequest(url, options);

  const route = await proxyTunnel.routeFor(url);
  if (route.proxy) {
    try {
      return await performRequest(url, { ...options, agent: proxyTunnel.agentFor(route.proxy) });
    } catch (error) {
      if (proxyTunnel.isAbort(error)) throw error;
      // 拥塞型失败（连接被重置、超时）不熔断：让它自动降并发继续用，
      // 否则机场限制连接数时会一路退回 Chromium 的 6 条，比改之前更慢
      if (!proxyTunnel.noteFailure(route.proxy, error)) proxyTunnel.markProxyBroken();
      // 代理不通（没开、端口错、规则把 CDN 判成直连）：再试一次直连
    }
  }
  try {
    return await performRequest(url, options);
  } catch (error) {
    if (!proxyTunnel.isAbort(error)) proxyTunnel.markDirectBroken();
    throw error;
  }
}

/*
 * 请求留痕。
 *
 * 默认什么都不挂：自测脚本直接 require 这个文件时不需要诊断模块。主进程启动
 * 时调用 setRequestLogger() 注入，之后每条请求都记一条元数据（地址、状态码、
 * 耗时、走的哪条栈、错误信息），不记 body、不记 header。
 *
 * 记日志本身绝不能影响请求，所以整段都包在 try 里。
 */
let requestLogger = null;

function setRequestLogger(fn) {
  requestLogger = typeof fn === 'function' ? fn : null;
}

function reportRequest(url, method, startedAt, transport, status, error) {
  if (!requestLogger) return;
  try {
    requestLogger({
      url: String(url),
      method,
      status,
      ms: Date.now() - startedAt,
      transport,
      error: error ? error.message || String(error) : '',
    });
  } catch {
    /* 诊断日志写失败不能反过来把请求搞挂 */
  }
}

async function httpFetch(url, options = {}) {
  const { dispatcher, ...rest } = options; // dispatcher 是 undici 专属参数，Chromium 栈不认
  const startedAt = Date.now();
  const method = String(rest.method || 'GET').toUpperCase();
  if (electronNetFetch) {
    try {
      const response = await electronNetFetch(url, rest);
      reportRequest(url, method, startedAt, 'chromium', response.status, null);
      return response;
    } catch (error) {
      // Chromium 栈连不上时退回 Node 的 https 栈再试一把：两边各自的可达性盲区
      // （系统代理配置异常、证书库被改、个别 CDN 的 TLS 实现差异）不同，互为兜底。
      if (error && (error.name === 'AbortError' || error.message === 'ABORTED')) {
        reportRequest(url, method, startedAt, 'chromium', 0, error);
        throw error;
      }
      try {
        const response = await nodeRequest(url, rest);
        reportRequest(url, method, startedAt, 'node', response.status, null);
        return response;
      } catch (fallbackError) {
        // 两条路都断了：记成一条，比记两条「Chromium 失败 + Node 失败」更好读
        reportRequest(url, method, startedAt, 'node', 0, fallbackError);
        throw fallbackError;
      }
    }
  }
  // 纯 Node 环境（自测脚本）：用原生 fetch，行为最完整
  try {
    const response = await fetch(url, rest);
    reportRequest(url, method, startedAt, 'fetch', response.status, null);
    return response;
  } catch (error) {
    reportRequest(url, method, startedAt, 'fetch', 0, error);
    throw error;
  }
}

/**
 * 分段下载专用取数函数：**只走 node:https**，每段一条独立 TCP。
 *
 * 为什么不能给分段用 net.fetch：Chromium 对同一个 host 最多 6 条 socket，
 * 下载资源又普遍支持 HTTP/2，几十个 Range 请求会被并进一两条连接里共享同一个
 * 拥塞窗口——多线程加了等于没加。实测同一条 CDN 大文件：单连接 7.6 MB/s，
 * 16 条独立 socket 19.2 MB/s。
 *
 * Node 不读系统代理，所以「只有挂代理才出得去网」的环境会连不上；这种情况下
 * 自动退回 Chromium 栈（至少还有 6 条并发），并记一个熔断标记，避免每条分段
 * 都白等一次超时。
 */
let rangeTransport = 'unknown'; // unknown | node
let rangeTransportBrokenAt = 0;
const RANGE_FALLBACK_COOLDOWN = 5 * 60 * 1000;

async function segmentFetch(url, options = {}) {
  const brokenRecently = rangeTransportBrokenAt && Date.now() - rangeTransportBrokenAt < RANGE_FALLBACK_COOLDOWN;
  if (!brokenRecently) {
    try {
      const response = await nodeRequest(url, options);
      rangeTransport = 'node';
      return response;
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.message === 'ABORTED')) throw error;
      // Node 直连不通（多半是靠代理出网）：5 分钟内不再尝试，免得每段都等超时
      rangeTransport = 'node-broken';
      rangeTransportBrokenAt = Date.now();
    }
  }
  return httpFetch(url, options);
}

/**
 * 「直连优先」取数：和 segmentFetch 是同一个实现，只是名字说清适用面。
 *
 * 不只 Range 分段要用它 —— 预下载的 chunk（几 MB 的整块）也一样：
 * Chromium 栈对同一个 host 最多 6 条 socket，16 路文件级并发走过去，
 * 实际只有 6 条在跑，剩下 10 路排队。换 node:https 才是 16 条真连接。
 * 直连不通时自动退回 Chromium 栈（并熔断 5 分钟），代理环境不会因此挂掉。
 */
const directFetch = segmentFetch;

module.exports = { httpFetch, nodeRequest, directFetch, segmentFetch, setRequestLogger };
