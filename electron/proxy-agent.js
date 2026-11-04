'use strict';

/**
 * node:https 的代理隧道 Agent（HTTP CONNECT / SOCKS5）。
 *
 * 为什么需要这一层：Chromium 网络栈（net.fetch）自动继承系统代理，但同一个
 * host 最多 6 条连接，下载又普遍是 HTTP/2，几十路请求会被并进一两条连接里
 * 共享同一个拥塞窗口——多线程加了等于没加。node:https 能开 16 条独立连接，
 * 却完全不认代理：它不读注册表、不读 WinINET、不认 PAC 脚本。
 *
 * 于是靠加速器上网的用户（尤其是国际服）会卡在一个死循环里：开 16 路 →
 * 16 路全部连不通 → 熔断回退 Chromium 的 6 条 → 还是慢。这一版补的就是
 * 「node 自己读代理、自己建隧道」这段。
 *
 * 隧道建成之后 https 请求在它上面做正常的 TLS 握手，证书校验的是目标站点
 * 自己的证书，代理只是一根透明管道。16 路并发就是 16 条隧道，各自独立的
 * 拥塞窗口——这才是高延迟链路上提速的来源。
 *
 * 代理地址有三个来源，优先级从高到低：
 *   1. 启动器设置里的「网络代理」（用户手填）；
 *   2. 系统代理（由主进程用 Electron 的 session.resolveProxy 解析，PAC 也算）；
 *   3. 环境变量 HTTPS_PROXY / ALL_PROXY（自测脚本、命令行场景）。
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

/** 建隧道（连代理 + CONNECT 握手）的超时。代理没开时不该让调用方干等两分钟。 */
const TUNNEL_TIMEOUT = Math.max(3000, Number(process.env.HXL_PROXY_TIMEOUT) || 12000);
/** 某条路失败后多久不再尝试。避免了「每条请求都白等一次超时」。 */
const BROKEN_COOLDOWN = 5 * 60 * 1000;
/** 目标 host 的代理决策缓存。PAC 是按 URL 算的，缓存按 origin 分。 */
const RESOLVE_TTL = 3 * 60 * 1000;
/** 「当前直连」的结论只缓存 30 秒：用户经常是先点下载才想起来开加速器。 */
const DIRECT_TTL = 30 * 1000;

let resolver = null; // async (url) => 'http://127.0.0.1:7890' | 'socks5://...' | ''
let directBrokenAt = 0;
let proxyBrokenAt = 0;

const specCache = new Map(); // origin -> { at, spec }
const agentCache = new Map(); // proxy key -> ProxyTunnelAgent

/**
 * 解析一条代理规则成可用的描述对象。
 *
 * 兼容用户手填的各种写法：`127.0.0.1:7890`、`http://127.0.0.1:7890`、
 * `socks5://user:pass@127.0.0.1:1080`。认不出的（比如只填了域名没端口）返回 null，
 * 由上层退回 Chromium 栈——绝不能因为代理填错把整个启动器的联网搞死。
 */
function parseProxySpec(spec) {
  const text = String(spec || '').trim();
  if (!text) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  /*
   * 没写协议时必须显式给端口。
   * 否则「随便写点什么」这种随手输入会被 new URL 当成合法域名（IDN 允许中文），
   * 然后每条请求都去连一个不存在的 8080 端口，等满 12 秒超时才回落——
   * 代理填错不该变成全局变慢。
   */
  if (!hasScheme && !/^[^\s/@]+@?[^\s/]*:\d{1,5}$/.test(text)) return null;
  const withScheme = hasScheme ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(':', '').toLowerCase();
  let type = '';
  if (scheme === 'http' || scheme === 'https') type = 'http';
  else if (scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks') type = 'socks5';
  if (!type) return null;
  const host = url.hostname;
  if (!host) return null;
  // 主机名只认常见的几种写法（域名、IPv4、[IPv6]），其他一律当填错
  if (!/^[A-Za-z0-9._-]+$/.test(host) && !/^\[[0-9a-fA-F:]+\]$/.test(host)) return null;
  const port = Number(url.port) || (type === 'socks5' ? 1080 : 8080);
  if (!(port > 0 && port < 65536)) return null;
  let user = '';
  let pass = '';
  try {
    user = decodeURIComponent(url.username || '');
    pass = decodeURIComponent(url.password || '');
  } catch {
    user = url.username || '';
    pass = url.password || '';
  }
  return {
    type,
    host,
    port,
    user,
    pass,
    key: `${type}://${host}:${port}`,
  };
}

function isAbort(error) {
  return Boolean(error && (error.name === 'AbortError' || error.message === 'ABORTED'));
}

/**
 * 注入「按目标地址解析代理」的回调。
 *
 * 交给主进程实现，因为只有 Electron 的 session.resolveProxy 能拿到系统代理和
 * PAC 的真实决策；这个模块保持纯 node，自测脚本里能直接 require。
 * 每次注入都清空缓存与熔断标记——用户改完设置应该立刻生效。
 */
function setProxyResolver(fn) {
  resolver = typeof fn === 'function' ? fn : null;
  invalidate();
}

/** 清空决策缓存与熔断状态。设置变更、网络切换后调用。 */
function invalidate() {
  specCache.clear();
  directBrokenAt = 0;
  proxyBrokenAt = 0;
  for (const agent of agentCache.values()) {
    try {
      agent.destroy();
    } catch {
      /* 正在用的 socket 交给上层自己回收 */
    }
  }
  agentCache.clear();
}

function envProxy() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  );
}

/** 问一次「这个地址该走哪个代理」，结果按 origin 缓存几分钟。 */
async function resolveSpecFor(targetUrl) {
  let origin = '';
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    return null;
  }
  const now = Date.now();
  const cached = specCache.get(origin);
  if (cached && now - cached.at < (cached.spec ? RESOLVE_TTL : DIRECT_TTL)) return cached.spec;
  let spec = null;
  if (resolver) {
    try {
      const answer = await resolver(targetUrl);
      // 返回空串 / null = 「已经问过，结论是直连」，别再拿环境变量去覆盖；
      // 返回 undefined 或抛错 = 「问不出来」，才轮到环境变量兜底。
      if (answer !== undefined) {
        spec = parseProxySpec(answer);
        specCache.set(origin, { at: now, spec });
        return spec;
      }
    } catch {
      /* 解析失败：走环境变量兜底 */
    }
  }
  spec = parseProxySpec(envProxy());
  specCache.set(origin, { at: now, spec });
  return spec;
}

/**
 * 给一个地址选路。返回 { proxy, source }：
 *   proxy  为 null 表示直连；source 说明为什么这么选（排障时有用）。
 *
 * 熔断规则：代理刚失败过就直连，直连刚失败过就走代理，两边都失败过就直连
 * （让最外层退回 Chromium 栈）。
 */
async function routeFor(targetUrl) {
  const spec = await resolveSpecFor(targetUrl);
  const now = Date.now();
  const proxyBroken = proxyBrokenAt && now - proxyBrokenAt < BROKEN_COOLDOWN;
  const directBroken = directBrokenAt && now - directBrokenAt < BROKEN_COOLDOWN;
  if (!spec) return { proxy: null, source: 'direct' };
  if (proxyBroken) {
    // 代理挂了但直连之前没失败过：先直连试试，别在死代理上耗时间
    return { proxy: null, source: 'proxy-broken' };
  }
  if (directBroken) return { proxy: spec, source: 'direct-broken' };
  return { proxy: spec, source: 'proxy' };
}

function markProxyBroken() {
  proxyBrokenAt = Date.now();
}

function markDirectBroken() {
  directBrokenAt = Date.now();
}

/** 取（或建）某个代理对应的隧道 Agent。同一个代理复用同一个连接池。 */
function agentFor(spec) {
  const key = spec.key || `${spec.type}://${spec.host}:${spec.port}`;
  let agent = agentCache.get(key);
  if (!agent) {
    agent = new ProxyTunnelAgent(spec);
    agentCache.set(key, agent);
  }
  return agent;
}

/**
 * 通过 HTTP 代理建 CONNECT 隧道，返回一条到目标 host:port 的裸 TCP。
 *
 * 握手过程：连代理 → 发 `CONNECT host:port HTTP/1.1` → 等 `200 Connection
 * Established` → 把这条 socket 交回去。之后的字节流由调用方自己决定（这里是 TLS）。
 */
function openHttpTunnel(proxy, host, port, timeout = TUNNEL_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let buffered = Buffer.alloc(0);

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onFail);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('close', onClose);
    };
    const onFail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onTimeout = () => onFail(new Error('代理连接超时'));
    // 代理直接把连接掐掉（并发超限时很常见）：立刻失败，别干等 12 秒超时
    const onClose = () => onFail(new Error('代理连接被关闭'));
    const onDone = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.setTimeout(0);
      resolve(socket);
    };

    socket.setTimeout(timeout);
    socket.once('timeout', onTimeout);
    socket.once('close', onClose);
    socket.once('error', onFail);
    socket.once('connect', () => {
      const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`, 'Proxy-Connection: Keep-Alive'];
      if (proxy.user || proxy.pass) {
        const token = Buffer.from(`${proxy.user}:${proxy.pass}`, 'utf8').toString('base64');
        lines.push(`Proxy-Authorization: Basic ${token}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });

    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) {
        // 代理的应答头不该超过 16KB；超了说明对面根本不是 HTTP 代理
        if (buffered.length > 16384) onFail(new Error('代理应答异常'));
        return;
      }
      const head = buffered.subarray(0, end).toString('latin1');
      const status = Number((head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/) || [])[1] || 0);
      if (status === 407) {
        onFail(new Error('代理要求认证（407）'));
        return;
      }
      if (status !== 200) {
        onFail(new Error(`代理拒绝建立隧道（${status || '无应答'}）`));
        return;
      }
      // CONNECT 成功后服务端通常不再说话，但万一有残留字节要还给上层
      const rest = buffered.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      onDone();
    };
    socket.on('data', onData);
  });
}

/** 通过 SOCKS5 代理建隧道（含用户名密码认证）。 */
function openSocksTunnel(proxy, host, port, timeout = TUNNEL_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let stage = 'greeting';
    let buffered = Buffer.alloc(0);

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onFail);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('close', onClose);
    };
    const onFail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onTimeout = () => onFail(new Error('SOCKS5 代理连接超时'));
    const onClose = () => onFail(new Error('SOCKS5 代理连接被关闭'));
    const onDone = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.setTimeout(0);
      resolve(socket);
    };

    const sendConnect = () => {
      const addr = Buffer.from(host, 'utf8');
      if (addr.length > 255) {
        onFail(new Error('目标域名过长'));
        return;
      }
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      // ATYP=3：域名由代理解析（socks5h 的语义，本地 DNS 污染环境下更可靠）
      const head = Buffer.from([0x05, 0x01, 0x00, 0x03, addr.length]);
      socket.write(Buffer.concat([head, addr, portBuf]));
    };

    socket.setTimeout(timeout);
    socket.once('timeout', onTimeout);
    socket.once('close', onClose);
    socket.once('error', onFail);
    socket.once('connect', () => {
      const methods = proxy.user || proxy.pass ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });

    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);

      if (stage === 'greeting') {
        if (buffered.length < 2) return;
        if (buffered[0] !== 0x05) {
          onFail(new Error('对方不是 SOCKS5 代理'));
          return;
        }
        const method = buffered[1];
        buffered = buffered.subarray(2);
        if (method === 0xff) {
          onFail(new Error('SOCKS5 代理拒绝了认证方式'));
          return;
        }
        if (method === 0x02) {
          const user = Buffer.from(proxy.user || '', 'utf8');
          const pass = Buffer.from(proxy.pass || '', 'utf8');
          if (user.length > 255 || pass.length > 255) {
            onFail(new Error('SOCKS5 用户名或密码过长'));
            return;
          }
          stage = 'auth';
          socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
          return;
        }
        stage = 'reply';
        sendConnect();
        return;
      }

      if (stage === 'auth') {
        if (buffered.length < 2) return;
        const ok = buffered[1] === 0x00;
        buffered = buffered.subarray(2);
        if (!ok) {
          onFail(new Error('SOCKS5 用户名或密码错误'));
          return;
        }
        stage = 'reply';
        sendConnect();
        return;
      }

      // 应答：VER REP RSV ATYP ADDR PORT，按 ATYP 算长度，可能被拆成两个包
      if (buffered.length < 5) return;
      const rep = buffered[1];
      const atyp = buffered[3];
      let need = 0;
      if (atyp === 0x01) need = 4 + 4 + 2;
      else if (atyp === 0x04) need = 4 + 16 + 2;
      else if (atyp === 0x03) {
        if (buffered.length < 5) return;
        need = 4 + 1 + buffered[4] + 2;
      } else {
        onFail(new Error('SOCKS5 应答格式异常'));
        return;
      }
      if (buffered.length < need) return;
      if (rep !== 0x00) {
        const reasons = {
          0x01: '代理内部错误',
          0x02: '代理规则不允许该连接',
          0x03: '网络不可达',
          0x04: '目标主机不可达',
          0x05: '目标拒绝连接',
          0x06: 'TTL 过期',
          0x07: '不支持的命令',
          0x08: '不支持的地址类型',
        };
        onFail(new Error(`SOCKS5 建立失败：${reasons[rep] || `代码 ${rep}`}`));
        return;
      }
      const rest = buffered.subarray(need);
      if (rest.length) socket.unshift(rest);
      onDone();
    };
    socket.on('data', onData);
  });
}

/**
 * 走隧道的 https.Agent。
 *
 * 关键点在 createConnection：先建隧道拿到裸 TCP，再在这条 TCP 上做 TLS。
 * 不能只覆写 socket 连接部分就交给 https.request —— 那样它会在已经加密的
 * 通道上再做一次握手，或者干脆把明文写进 443 端口。
 */
class ProxyTunnelAgent extends https.Agent {
  constructor(proxy, options = {}) {
    super({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets: Math.max(1, Number(process.env.HXL_PROXY_MAX_SOCKETS) || 64),
      maxFreeSockets: 16,
      ...options,
    });
    this.proxy = proxy;
    this.baseMaxSockets = this.maxSockets;
    this.failureStreak = 0;
    this.throttleTimer = null;
  }

  /**
   * 隧道失败后的自愈判断。
   *
   * 为什么需要它：机场/加速器普遍限制「单 IP 同时连接数」，16 条并发在部分
   * 线路上会被重置。如果一失败就熔断 5 分钟、退回 Chromium 的 6 条，用户会比
   * 改之前更慢。所以对「连接被重置 / 超时」这类拥塞型错误先降并发再试，
   * 只有认证失败、规则拒绝、证书问题这种「这条路根本不通」才交给上层熔断。
   *
   * 返回 true = 这是拥塞，已经降级，别熔断，继续用。
   */
  noteTunnelFailure(error) {
    const text = String((error && error.message) || '');
    if (/407|认证|不是 SOCKS5|SOCKS5 建立失败|证书|CERT|self.signed|self signed/i.test(text)) return false;
    // 代理端口没人监听 / 域名解析不到：不是拥塞，立刻放弃这条代理
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ERR_INVALID_IP_ADDRESS/i.test(text)) return false;
    this.failureStreak += 1;
    // 先忍两次：偶发丢包不该立刻把并发砍半
    if (this.failureStreak < 2) return true;
    this.failureStreak = 0;
    if (this.maxSockets <= 4) return false; // 已经降到 4 路，还是不行就认了
    this.maxSockets = Math.max(4, Math.floor(this.maxSockets / 2));
    this.maxFreeSockets = Math.max(2, Math.floor(this.maxSockets / 2));
    // 两分钟后恢复原并发：可能只是那一段线路抖动
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.throttleTimer = setTimeout(() => {
      this.maxSockets = this.baseMaxSockets;
      this.maxFreeSockets = 16;
    }, 120000);
    if (this.throttleTimer.unref) this.throttleTimer.unref();
    return true;
  }

  createConnection(options, callback) {
    const host = options.host || options.hostname;
    const port = Number(options.port) || 443;
    const servername = options.servername || host;
    const open = this.proxy.type === 'socks5' ? openSocksTunnel : openHttpTunnel;
    let called = false;
    const finish = (error, socket) => {
      if (called) return;
      called = true;
      if (typeof callback === 'function') callback(error, socket);
    };

    open(this.proxy, host, port, TUNNEL_TIMEOUT).then(
      (raw) => {
        const secure = tls.connect({
          socket: raw,
          // IP 字面量不能作为 SNI 发出去（RFC 6066 不允许）
          servername: net.isIP(String(servername || '')) ? undefined : servername,
          // 与直连路径保持一致：国内 CDN 的证书链在 Node 内置 CA 里可能缺一环，
          // 这条路径本来就是兜底，宁可放弃校验也不要「两边都连不上」
          rejectUnauthorized: options.rejectUnauthorized !== false,
          ALPNProtocols: ['http/1.1'],
        });
        secure.once('secureConnect', () => finish(null, secure));
        secure.once('error', (error) => {
          // 握手失败要显式销毁，否则会挂住一个半开 socket 直到超时
          secure.destroy();
          finish(error);
        });
      },
      (error) => finish(error)
    );
  }
}

/** 上报一次隧道失败：返回 true 表示「拥塞，已自动降并发，别熔断」。 */
function noteFailure(spec, error) {
  if (!spec) return false;
  const agent = agentCache.get(spec.key || `${spec.type}://${spec.host}:${spec.port}`);
  if (!agent) return false;
  return agent.noteTunnelFailure(error);
}

/** 当前路由状态的简短说明，给诊断日志用。 */
function describe() {
  const now = Date.now();
  return {
    proxy: resolver ? 'resolver' : envProxy() ? 'env' : 'none',
    directBroken: Boolean(directBrokenAt && now - directBrokenAt < BROKEN_COOLDOWN),
    proxyBroken: Boolean(proxyBrokenAt && now - proxyBrokenAt < BROKEN_COOLDOWN),
    agents: agentCache.size,
    cached: specCache.size,
  };
}

module.exports = {
  parseProxySpec,
  setProxyResolver,
  invalidate,
  routeFor,
  agentFor,
  noteFailure,
  markProxyBroken,
  markDirectBroken,
  describe,
  isAbort,
  openHttpTunnel,
  openSocksTunnel,
  ProxyTunnelAgent,
};
