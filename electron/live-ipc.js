'use strict';

const {
  ipcMain,
  BrowserWindow,
  session,
  net,
  app,
} = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { resolveLiveRoom } = require('./live-rooms');
const { startDanmaku, pollDanmaku, stopDanmaku } = require('./live-danmaku');

/**
 * 直播间点歌：房间号解析、第三方平台弹幕抓取、B 站官方 WebSocket 弹幕。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行）。
 * 搬运时逻辑未改，只把 writeLaunchLog 改成 ctx 注入。
 *
 * B 站这部分是本块的大头（约 500 行）：
 *   - 风控 -352：先领 buvid3/buvid4 写进会话 cookie，否则 getDanmuInfo 不给 token
 *   - 官方 WebSocket 要求 auth 包带 token，不带照样能连上但一条弹幕都不推
 *   - 候选 host 全耗尽 / 被踢 / 1006 / watchdog 超时都走 biliReconnect 重来
 *   - 心跳、二进制帧解包（brotli）、日志按连接限流防刷屏
 */

function installLiveIpc(ctx) {
  const {
    writeLaunchLog,
  } = ctx;

    ipcMain.handle('live:bili-room', async (_event, input) => {
      const raw = String(input?.url || input || '');
      return resolveLiveRoom(raw);
    });

    /*
     * 斗鱼 / 虎牙 / 抖音 / 快手 的弹幕抓取。
     *
     * 用一个隐藏窗口加载直播间网页，只读聊天区文字（见 electron/live-danmaku.js）。
     * 渲染层每 900ms 拉一次新弹幕，断开时调 stop 关掉窗口。
     */
    ipcMain.handle('live:danmaku-start', async (_event, input) => startDanmaku(input));
    ipcMain.handle('live:danmaku-poll', async (_event, id) => pollDanmaku(id));
    ipcMain.handle('live:danmaku-stop', async (_event, id) => stopDanmaku(id));

    /*
     * B 站弹幕鉴权：官方 WebSocket 现在要求 auth 包里带 getDanmuInfo 发的
     * token（key 字段），不带 key 服务器照样接受连接（界面显示"已连接"），
     * 但一条弹幕都不会推——正是"连接成功、观众点歌没反应"的原因。
     * 放主进程走 net.fetch：没有 CORS 限制，还能带上默认会话里的 B 站 cookie。
     */
    /*
     * B 站风控(-352)：getDanmuInfo 只给"看起来像正常浏览器"的请求发鉴权 token，
     * 判断依据主要是 cookie 里有没有 buvid3/buvid4。启动器会话里从没有过 B 站
     * cookie 的用户就会被拦。这里主动领一对写进会话 cookie，让整个会话从此
     * 都以"带身份的浏览器"身份请求 B 站（写一次，长期有效）。
     */
    const BILI_UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    async function ensureBiliBuvid() {
      const jar = session.defaultSession;
      const existing = await jar.cookies.get({ url: 'https://live.bilibili.com/' });
      if (existing.some((c) => c.name === 'buvid3')) return;
      const spi = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com/' },
      })
        .then((r) => r.json())
        .catch(() => null);
      const b3 = spi?.data?.b_3;
      if (!b3) return;
      const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
      await jar.cookies.setCookie({
        url: 'https://www.bilibili.com/',
        name: 'buvid3',
        value: b3,
        domain: '.bilibili.com',
        path: '/',
        secure: true,
        expirationDate: expires,
      });
      if (spi?.data?.b_4) {
        await jar.cookies.setCookie({
          url: 'https://www.bilibili.com/',
          name: 'buvid4',
          value: spi.data.b_4,
          domain: '.bilibili.com',
          path: '/',
          secure: true,
          expirationDate: expires,
        });
      }
    }

    /*
     * 走 Chromium 网络栈并自动携带会话 cookie 的 GET。
     * 之前用 undici 的 fetch：手动拼 Cookie 头会被当"禁止头"剥掉，
     * 会话里的 buvid/登录态根本发不出去。
     */
    function biliFetchText(url, referer) {
      return new Promise((resolve, reject) => {
        const request = net.request({ url, method: 'GET', useSessionCookies: true });
        request.setHeader('User-Agent', BILI_UA);
        request.setHeader('Referer', referer);
        request.on('response', (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })
          );
        });
        request.on('error', reject);
        request.end();
      });
    }

    /*
     * 取一个 B 站接口的 JSON：先走 Chromium 栈，被拦了自动回落 Node 栈。
     * accept 用来判断"这份结果算不算拿到"，默认是 code===0。
     */
    async function biliGetJson(url, referer, accept) {
      const good = accept || ((parsed) => parsed?.code === 0);
      let detail = '';
      let json = null;
      // 路线一：Chromium 网络栈，自动带会话 cookie，TLS 指纹与真实浏览器一致
      try {
        const { status, body } = await biliFetchText(url, referer);
        detail = `HTTP ${status}`;
        try {
          json = JSON.parse(body);
          if (good(json)) return { json, detail };
        } catch {
          json = null;
          detail += `，返回的不是 JSON：${body.slice(0, 60)}`;
        }
      } catch (error) {
        detail = `Chromium 请求失败：${error.message}`;
      }
      /*
       * 路线二：Node fetch + 手动 Cookie。用户的系统级拦截软件（AdGuard 之类）
       * 会把 Chromium 栈的请求挡成 ERR_BLOCKED_BY_CLIENT，这时走 Node 的
       * 网络栈绕开它；undici 允许显式带 Cookie 头，会话里的 buvid/登录态照样能用。
       */
      try {
        const jarCookies = await session.defaultSession.cookies.get({ url }).catch(() => []);
        const cookie = jarCookies.map((c) => `${c.name}=${c.value}`).join('; ');
        const res = await fetch(url, {
          headers: {
            'User-Agent': BILI_UA,
            Referer: referer,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        });
        const body = await res.text();
        detail += `；Node 备用路线 HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === 'object') json = parsed;
        } catch {
          detail += `，非 JSON：${body.slice(0, 60)}`;
        }
      } catch (error) {
        detail += `；Node 备用路线失败：${error.message}`;
      }
      return { json, detail };
    }

    /*
     * WBI 签名：B 站给一批 web 接口加的风控，getDanmuInfo 就在其中。
     *
     * -352 的根因：请求里的 w_rid 算错。w_rid = md5(排序后的 query + mixinKey)，
     * 而 mixinKey 来自一份 64 位的置换表（WBI_MIXIN_TAB）。这份表以前在 idx40 之后
     * 是错的，于是无论登录与否、带不带 buvid，签名永远不对，B 站一律回 -352，
     * 文案一直让用户"去登录"，登录完照样 -352。已用探针逐位对照官方算法校正为规范表，
     * 实测：不带 cookie 只带签名即可 code=0 拿到 token。
     *
     * 密钥（img_key / sub_key）从 x/web-interface/nav 的 wbi_img 里取，
     * 未登录也能拿到，服务端会轮换，这里缓存 30 分钟。
     */
    // 注意：这是 B 站官方公开的规范 mixin 置换表（64 位）。之前这份表在 idx40 之后是错的，
    // 导致 w_rid 算错、getDanmuInfo 永远回 -352（签名未通过）。已用探针对照官方算法逐位校正。
    const WBI_MIXIN_TAB = [
      46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
      33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
      26, 17, 0, 11, 60, 20, 21, 56, 34, 44, 52, 22, 36, 1, 63, 59, 57, 54, 62, 6,
      4, 30, 25, 51,
    ];
    let biliWbiKeysCache = null;

    function biliMixinKey(imgKey, subKey) {
      const raw = `${imgKey}${subKey}`;
      return WBI_MIXIN_TAB.map((index) => raw[index]).join('').slice(0, 32);
    }

    function biliWbiQuery(params, imgKey, subKey) {
      const wbiEncode = (text) =>
        encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
      const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
      const query = Object.keys(signed)
        .sort()
        .map((key) => `${wbiEncode(key)}=${wbiEncode(String(signed[key]))}`)
        .join('&');
      const wRid = crypto
        .createHash('md5')
        .update(query + biliMixinKey(imgKey, subKey))
        .digest('hex');
      return `${query}&w_rid=${wRid}`;
    }

    async function biliWbiKeys(force) {
      if (!force && biliWbiKeysCache && Date.now() - biliWbiKeysCache.at < 30 * 60 * 1000) {
        return biliWbiKeysCache;
      }
      // nav 未登录时回 -101，但 wbi_img 照样给，所以这里按"有没有 wbi_img"算成功
      const { json } = await biliGetJson(
        'https://api.bilibili.com/x/web-interface/nav',
        'https://www.bilibili.com/',
        (parsed) => Boolean(parsed?.data?.wbi_img?.img_url && parsed?.data?.wbi_img?.sub_url)
      );
      const imgUrl = json?.data?.wbi_img?.img_url;
      const subUrl = json?.data?.wbi_img?.sub_url;
      if (!imgUrl || !subUrl) throw new Error('拿不到B站签名密钥，稍后重试');
      biliWbiKeysCache = {
        imgKey: String(imgUrl).split('/').pop().split('.')[0],
        subKey: String(subUrl).split('/').pop().split('.')[0],
        at: Date.now(),
      };
      return biliWbiKeysCache;
    }

    ipcMain.handle('live:danmu-info', async (_event, roomId) => {
      const info = await getBiliDanmuInfo(roomId);
      const first = info.hosts[0] || {};
      return {
        token: info.token,
        host: String(first.host || ''),
        port: Number(first.port || 443),
        hosts: info.hosts,
      };
    });

    /*
     * 未开播 / 轮播房间的聊天区补拉（2026-11-18）。
     *
     * 用户报"没开播、轮播中也要能点到歌"。这两种房间 B 站照样开聊天区，
     * 但官方弹幕 WebSocket 基本不推（轮播尤其明显），结果是界面「已连接」
     * 却一条点歌都收不到。
     *
     * xlive/web-room/v1/dM/gethistory 不需要 token、不需要 wbi 签名，
     * 未开播房间也能读到最近 20 条聊天记录。前端按 key 去重、首轮只做基线，
     * 之后与 WS 事件汇进同一个点歌入口。
     */
    async function getBiliDanmuHistory(roomId) {
      const id = String(roomId || '').trim();
      if (!id) throw new Error('没有房间号');
      await ensureBiliBuvid().catch(() => {});
      const url = `https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${encodeURIComponent(
        id
      )}&room_type=0`;
      const { json } = await biliGetJson(url, `https://live.bilibili.com/${id}`, (parsed) => Boolean(parsed?.data));
      const list = Array.isArray(json?.data?.room) ? json.data.room : [];
      return list.map((item) => {
        const user = String(item?.nickname || item?.uname || '');
        const text = String(item?.text || '');
        return {
          user,
          text,
          // timeline 只有 "HH:MM:SS"，同一秒可能多条，拼上 uid 与正文才能稳稳去重
          key: `${String(item?.timeline || '')}|${String(item?.uid || '')}|${text}`,
        };
      });
    }

    ipcMain.handle('live:danmu-history', async (_event, roomId) => getBiliDanmuHistory(roomId));

    /*
     * 弹幕 WebSocket 迁到主进程（根治渲染层长连接被本机网络层掐断的问题）。
     * 渲染层只负责：发 live:danmu-connect(token+hosts) / 收 live:danmu-event。
     * 真正建连、鉴权、心跳、断线重连、服务器轮换、token 刷新全在这里（Node 栈，
     * 实测 95 秒以上稳定，不再受 Chromium 出站长连接约 70 秒被掐的限制）。
     */
    const zlib = require('zlib');
    const WS = globalThis.WebSocket || WebSocket;
    const biliDanmuConnections = new Map();

    /*
     * 组2：B 站弹幕「老捕捉不到 / 过一会就断」的稳定性修复参数。
     * 以前 open 回调一触发就发 open 事件当「已连接」，但服务器可能只是接受了 TCP
     * 握手、根本没推数据；也没有读超时，长连接变僵尸后永远等不到重连。
     */
    const BILI_FRAME_TIMEOUT = 60000;     // 60s 没收到任意帧（含 op=3 心跳回应）视为僵尸连接
    const BILI_WATCHDOG_TICK = 15000;     // watchdog 每 15s 巡检一次
    const BILI_FIRST_DANMU_WAIT = 15000;  // 真连上后若这段时间仍无弹幕，只给一句「房间较安静」提示（不重连）
    const BILI_RECONNECT_BASE = 3000;     // 指数退避基数
    const BILI_RECONNECT_MAX = 60000;     // 退避上限
    const BILI_DECODE_LOG_LIMIT = 5;      // 解码失败日志按连接限流，别刷屏
    const BILI_DANMU_LOG_LIMIT = 20;      // 弹幕落日志前 20 条（原来只记 5 条）

    // 判断这个 state 是不是「当前仍挂在 Map 上、且没被用户主动关掉」的连接。
    // 同 roomId 重连/重连替换时，旧 state 的异步回调靠这个判断避免误伤新连接。
    function biliIsCurrent(state) {
      return Boolean(state) && !state.closedByUser && biliDanmuConnections.get(state.roomId) === state;
    }

    // 统一删除：先清掉全部定时器，且只删「自己」，避免旧连接把新连接从 Map 里挤掉。
    function biliRemoveConnection(state) {
      biliClearAllTimers(state);
      if (biliDanmuConnections.get(state.roomId) === state) biliDanmuConnections.delete(state.roomId);
    }

    // 限流日志：同一 state 同一 kind 最多写 limit 条，最后一条附带「已限流」说明。
    function biliLogLimited(state, kind, limit, message) {
      if (!state || !state.logCounts) return;
      const key = String(kind);
      const seen = state.logCounts[key] || 0;
      if (seen >= limit) return;
      state.logCounts[key] = seen + 1;
      writeLaunchLog(seen + 1 === limit ? `${message}（后续同类日志已限流省略）` : message);
    }

    // 清掉「单条 ws 连接」的定时器（换 host / 断开时用）；reconnectTimer 是跨重连的，不动。
    function biliClearWsTimers(state) {
      if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
      if (state.watchdog) { clearInterval(state.watchdog); state.watchdog = null; }
      if (state.waitFirstDanmuTimer) { clearTimeout(state.waitFirstDanmuTimer); state.waitFirstDanmuTimer = null; }
    }

    // 连接彻底删除时把所有定时器都清掉，避免后台重试 / watchdog 泄漏。
    function biliClearAllTimers(state) {
      biliClearWsTimers(state);
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    }

    // 第 n 次重连的退避：3s、6s、12s、24s、48s、60s、60s…
    function biliBackoff(tries) {
      return Math.min(BILI_RECONNECT_BASE * Math.pow(2, Math.max(0, tries - 1)), BILI_RECONNECT_MAX);
    }

    /*
     * 统一的「断线 -> 后台重连」入口：指数退避 + 长期重试，不再有「重连 3 次就彻底 closed」。
     * 候选 host 全耗尽、被踢、1006、watchdog 超时都走这里，由 biliReconnect 重取 token 重来一轮。
     */
    function biliScheduleReconnect(state, code, opts = {}) {
      if (state.closedByUser || !biliIsCurrent(state) || state.reconnectArmed) return;
      // 先置 armed 再 close：下面 ws.close() 会在下一轮异步触发 onDrop，
      // 不能让它又排一次重连、更不能让它误去连下一个 host。
      state.reconnectArmed = true;
      // closeWs=false 用于 watchdog 这类「调用方已自己 close」的场景，避免重复关。
      if (opts.closeWs !== false) { try { state.ws && state.ws.close(); } catch {} }
      biliClearWsTimers(state);
      state.connected = false;
      state.forceToken = true;   // 异常断开：下次 biliReconnect 一律强制重取 token
      const tries = (state.retryCount || 0) + 1;
      state.retryCount = tries;
      state.lastRetryAt = Date.now();
      const delay = biliBackoff(tries);
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      writeLaunchLog(`danmu ${state.roomId}: 连接断开（code ${code ?? '未知'}），第 ${tries} 次重连，${Math.round(delay / 1000)}s 后重试`);
      safeSend(state.sender, 'live:danmu-event', { roomId: state.roomId, type: 'reconnecting', tries, code, delayMs: delay });
      // 保留原有 1006 / 被踢提示文案，只是从「彻底 closed」改成后台重连期间的状态提示
      const statusText = opts.status || (code === 1006 ? '像是被代理或加速器掐断的，关掉加速器再连一次' : undefined);
      if (statusText) {
        safeSend(state.sender, 'live:danmu-event', { roomId: state.roomId, type: 'status', status: statusText });
      }
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        state.reconnectArmed = false;
        biliReconnect(state);
      }, delay);
    }

    // 取弹幕鉴权：与 live:danmu-info 共用同一套 wbi 签名逻辑，重连时主进程自己取，不绕回渲染层。
    async function getBiliDanmuInfo(roomId) {
      const id = String(roomId || '').trim();
      if (!id) throw new Error('没有房间号');
      await ensureBiliBuvid().catch(() => {});
      const referer = `https://live.bilibili.com/${id}`;
      let json = null;
      let detail = '';
      for (let attempt = 0; attempt < 2 && json?.code !== 0; attempt += 1) {
        const { imgKey, subKey } = await biliWbiKeys(attempt > 0);
        const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${biliWbiQuery(
          { id, type: 0 },
          imgKey,
          subKey
        )}`;
        const result = await biliGetJson(url, referer);
        json = result.json;
        detail = result.detail;
      }
      if (json?.code !== 0 || !json?.data?.token) {
        const message = String(json?.message || '');
        throw new Error(
          message === '-352'
            ? `被B站风控拦截(-352)，接口签名未通过（${detail || '原因不明'}）`
            : `${message || '弹幕鉴权获取失败'}（${detail || '原因不明'}）`
        );
      }
      const hosts = (json.data.host_list || [])
        .map((item) => ({ host: String(item?.host || ''), port: Number(item?.wss_port || item?.ws_port || 443) }))
        .filter((item) => item.host);
      return { token: String(json.data.token), hosts };
    }

    function biliBuildWsUrls(hosts) {
      const list = [];
      const seen = new Set();
      const push = (host, port) => {
        const h = String(host || '').trim();
        const p = Number(port) || 443;
        if (!h) return;
        const key = `${h}:${p}`;
        if (seen.has(key)) return;
        seen.add(key);
        list.push(`wss://${h}:${p}/sub`);
      };
      for (const item of hosts || []) {
        push(item && item.host, 443);
        push(item && item.host, item && item.port);
      }
      push('broadcastlv.chat.bilibili.com', 443);
      return list;
    }

    function biliPacketMain(value, operation = 7) {
      const body = Buffer.from(JSON.stringify(value), 'utf8');
      const buffer = Buffer.alloc(16 + body.length);
      buffer.writeUInt32BE(16 + body.length, 0);
      buffer.writeUInt16BE(16, 4);
      buffer.writeUInt16BE(1, 6);
      buffer.writeUInt32BE(operation, 8);
      buffer.writeUInt32BE(1, 12);
      body.copy(buffer, 16);
      return buffer;
    }

    function safeSend(sender, channel, payload) {
      try {
        if (sender && !sender.isDestroyed()) sender.send(channel, payload);
      } catch {
        /* webContents 已销毁 */
      }
    }

    /*
     * 主进程的 WebSocket 是 Electron 暴露的 DOM 风格实现：用 addEventListener 注册事件，
     * 不是 Node 的 ws 包（ws 包才有 .on）。为了不依赖具体版本，这里做个兼容：
     * 优先 addEventListener；万一某版本暴露的是 ws 风格就退回 .on。
     * message 事件：addEventListener 给的是 {data}，ws 风格直接给 data；
     * close 事件：addEventListener 给的是 {code}，ws 风格直接给 code。都归一化一下。
     */
    function wsOn(ws, name, handler) {
      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener(name, (event) => {
          if (name === 'message') return handler(event && event.data !== undefined ? event.data : event);
          if (name === 'close') return handler(event && event.code !== undefined ? event.code : event);
          return handler(event);
        });
      } else {
        ws.on(name, handler);
      }
    }

    // 只有服务器回了 op=8（确认 auth 包）才算「真连上」：发 open 事件、置 connected。
    // 空 key 的连接即使握手成功也拿不到 op=8，所以旧版那种「已连接（未取得弹幕鉴权）」
    // 的假状态不会再出现；握手成功但迟迟不推数据则由 watchdog 兜底。
    function biliMarkReallyConnected(state) {
      if (state.connected) return;
      state.connected = true;
      // 已经拿到首条弹幕，别再让「等首条弹幕」的超时器误触发换线路
      if (state.waitFirstDanmuTimer) { clearTimeout(state.waitFirstDanmuTimer); state.waitFirstDanmuTimer = null; }
      // 真正稳定收到弹幕后重置退避计数（只在成功的这一刻清零，不再按「>5 分钟」丢计数）
      state.retryCount = 0;
      state.lastRetryAt = 0;
      biliLogLimited(state, 'really-connected', BILI_DECODE_LOG_LIMIT,
        `danmu ${state.roomId}: 已确认真实连上（收到首条弹幕），重连计数清零`);
      safeSend(state.sender, 'live:danmu-event', { roomId: state.roomId, type: 'open', status: '已连接' });
    }

    function biliDecodeMain(buf, roomId, sender, state) {
      let offset = 0;
      while (offset + 16 <= buf.length) {
        const total = buf.readUInt32BE(offset);
        const header = buf.readUInt16BE(offset + 4);
        const version = buf.readUInt16BE(offset + 6);
        const operation = buf.readUInt32BE(offset + 8);
        if (!total || total > buf.length - offset) break;
        // 只要进了这个循环就是「收到了一帧」：刷新 watchdog 的读时间戳。
        state.lastFrameAt = Date.now();
        const body = buf.subarray(offset + header, offset + total);
        if (operation === 8) {
          // 服务器确认 auth 包：空 key / 被风控的连接永远收不到 op=8（配合 connect 处的空 token 拦截），
          // 所以拿到它才算「真连上」——不会再出现「已连接（未取得弹幕鉴权）」那种一条弹幕都没有的假状态。
          safeSend(sender, 'live:danmu-event', { roomId, type: 'pushing' });
          biliMarkReallyConnected(state);
          // 安静直播间可能几分钟都没弹幕：只给一句提示，绝不因「没弹幕」就换线路重连
          // （旧版 15 秒强制重连反而制造「过一会就断」）。真正的僵尸连接交给 watchdog。
          if (!state.waitFirstDanmuTimer) {
            state.waitFirstDanmuTimer = setTimeout(() => {
              state.waitFirstDanmuTimer = null;
              if (state.connected && biliIsCurrent(state) && state.captured === 0) {
                safeSend(sender, 'live:danmu-event', { roomId, type: 'status', status: '已连上，房间暂时没有弹幕' });
              }
            }, BILI_FIRST_DANMU_WAIT);
          }
        } else if (operation === 3) {
          // 心跳回应 / 人气包：服务器还活着，刷新读时间戳（watchdog 已统一刷新），不必解析内容。
        } else if (operation === 5) {
          if (version === 2 || version === 3) {
            try {
              const inflated = version === 3 ? zlib.brotliDecompressSync(body) : zlib.inflateSync(body);
              biliDecodeMain(inflated, roomId, sender, state);
            } catch (error) {
              biliLogLimited(state, `inflate-v${version}`, BILI_DECODE_LOG_LIMIT,
                `danmu ${roomId}: op 5 压缩帧解压失败 version=${version} operation=${operation}：${error.message}`);
            }
          } else {
            try {
              const json = JSON.parse(body.toString('utf8'));
              const items = Array.isArray(json) ? json : [json];
              for (const item of items) {
                if (String(item?.cmd || '').includes('DANMU_MSG')) {
                  const message = String(item.info?.[1] || '');
                  const user = String(item.info?.[2]?.[1] || '');
                  state.captured += 1;
                  state.lastMessageAt = Date.now();  // 真正的「最后一条弹幕」时间（token 复用看它）
                  biliMarkReallyConnected(state);    // 首条弹幕 = 真连上，发 open
                  if (state.captured <= BILI_DANMU_LOG_LIMIT) writeLaunchLog(`danmu ${roomId}: ${user}: ${message}`);
                  safeSend(sender, 'live:danmu-event', { roomId, type: 'danmu', message, user, captured: state.captured });
                }
              }
            } catch (error) {
              biliLogLimited(state, 'json-parse', BILI_DECODE_LOG_LIMIT,
                `danmu ${roomId}: op 5 非 JSON 包 operation=${operation} version=${version}：${error.message}`);
            }
          }
        }
        offset += total;
      }
    }

    function biliOpenWs(state) {
      if (!biliIsCurrent(state)) return;
      const urls = state.urls;
      if (state.urlIndex >= urls.length) {
        // 一轮候选全失败：不再直接判死刑，交给后台重连重取 token 再来一轮
        // （closeWs:false 因为此刻没有在途 ws，避免重复关）。
        biliScheduleReconnect(state, 1006, { closeWs: false, status: '弹幕服务器暂时都不通，正在重试…' });
        return;
      }
      let ws = null;
      try {
        ws = new WS(urls[state.urlIndex]);
      } catch {
        state.urlIndex += 1;
        biliOpenWs(state);
        return;
      }
      state.ws = ws;
      state.opened = false;
      ws.binaryType = 'arraybuffer';
      let done = false;
      const goNext = () => {
        try { ws.close(); } catch {}
        state.urlIndex += 1;
        biliOpenWs(state);
      };
      wsOn(ws, 'open', () => {
        state.opened = true;
        state.openedAt = Date.now();
        state.lastFrameAt = Date.now();
        // 发鉴权包。旧的 try/catch 会把失败吞掉、让界面停在假「已连接」，这里记进 launch.log。
        try {
          ws.send(biliPacketMain({ uid: 0, roomid: Number(state.roomId), protover: 2, platform: 'web', type: 2, key: state.token }));
        } catch (error) {
          biliLogLimited(state, 'auth-send', BILI_DECODE_LOG_LIMIT,
            `danmu ${state.roomId}: 发送鉴权包失败：${error.message}`);
        }
        // 每次新 ws 都先清掉上一条 ws 遗留的定时器，避免叠加。
        if (state.heartbeat) clearInterval(state.heartbeat);
        if (state.watchdog) clearInterval(state.watchdog);
        if (state.waitFirstDanmuTimer) { clearTimeout(state.waitFirstDanmuTimer); state.waitFirstDanmuTimer = null; }
        state.heartbeat = setInterval(() => {
          if (ws.readyState === WS.OPEN) {
            try { ws.send(biliPacketMain({}, 2)); } catch {}
          }
        }, 20000);
        // 读超时 watchdog：只发心跳不验活，TCP 半开时会一直显示「已连接」却不重连。
        // 超过 BILI_FRAME_TIMEOUT 没收到任意帧（含 op=3 心跳回应）就主动重连。
        state.watchdog = setInterval(() => {
          if (!biliIsCurrent(state) || state.reconnectArmed) return;
          if (Date.now() - (state.lastFrameAt || 0) > BILI_FRAME_TIMEOUT) {
            writeLaunchLog(`danmu ${state.roomId}: ${Math.round(BILI_FRAME_TIMEOUT / 1000)}s 没收到任何数据，判定僵尸连接，主动重连`);
            biliScheduleReconnect(state, 1006, { status: '连接长时间没有数据，正在重连…' });
          }
        }, BILI_WATCHDOG_TICK);
        // 不再在这里发 open / 置 connected：等服务器回 op=8 由 biliMarkReallyConnected 发，
        // 彻底消除「TCP 握手成功就被当成已连接」和「一条弹幕都没推」的假状态。
      });
      wsOn(ws, 'message', (data) => {
        let buf;
        if (data instanceof ArrayBuffer) buf = Buffer.from(data);
        else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        else buf = Buffer.from(data);
        if (!buf || !buf.length) return;
        biliDecodeMain(buf, state.roomId, state.sender, state);
      });
      const onDrop = (code) => {
        if (done) return;
        done = true;
        biliClearWsTimers(state);
        state.connected = false;
        // 用户主动断开 / 旧连接已被替换：静默收尾，绝不往渲染层发事件。
        // 事件是按 roomId 路由的，旧连接若发 'closed' 会误伤同一 roomId 的新卡片
        // （手动重连时闪一下「已断开」），而这正是「过一会断开」要消除的观感。
        // 主动断开时卡片本就由渲染层同步移除，不需要这条 closed 事件。
        if (state.closedByUser || !biliIsCurrent(state)) {
          if (biliDanmuConnections.get(state.roomId) === state) biliRemoveConnection(state);
          return;
        }
        // 握手都没成功、或连上 5 秒内立刻被踢：先在本轮候选里换下一个 host。
        // 这两种都算「线路不可用」而非稳定连接断开，换 host 更对症。
        if (!state.opened || (state.openedAt && Date.now() - state.openedAt < 5000 && state.urlIndex + 1 < urls.length)) {
          safeSend(state.sender, 'live:danmu-event', { roomId: state.roomId, type: 'status', status: '这个弹幕服务器连上就被踢，换一个…' });
          goNext();
          return;
        }
        // 真正的一次掉线：统一走指数退避 + 长期后台重连，不再「重连 3 次就彻底 closed」。
        // 先置 armed（防止 ws.close 的异步 onDrop 二次入队），且本次 ws 已断不要再 close。
        biliScheduleReconnect(state, code, { closeWs: false, status: code === 1006 ? '像是被代理或加速器掐断的，关掉加速器再连一次' : undefined });
      };
      wsOn(ws, 'error', () => { if (!done) onDrop(1006); });
      wsOn(ws, 'close', (code) => onDrop(code));
    }

    async function biliReconnect(state) {
      if (state.closedByUser || !biliIsCurrent(state)) return;
      // 「最后弹幕时间」用真正的 lastMessageAt（旧 lastDanmuAt 其实是建连时间，命名误导）。
      // 异常断开（forceToken）或 5 分钟没收到过弹幕，一律重取 token，不再拿被风控踢掉的旧 key 重试。
      const recentMessage = state.lastMessageAt && Date.now() - state.lastMessageAt < 5 * 60 * 1000;
      if (state.forceToken || !state.token || !recentMessage) {
        try {
          const info = await getBiliDanmuInfo(state.roomId);
          // 取 token 是异步的，期间用户可能已断开或该连接已被替换。
          if (state.closedByUser || !biliIsCurrent(state)) return;
          state.token = info.token;
          state.hosts = info.hosts;
          state.lastMessageAt = Date.now();
          state.forceToken = false;
        } catch (error) {
          if (state.closedByUser || !biliIsCurrent(state)) return;
          biliLogLimited(state, 'reconnect-token', BILI_DECODE_LOG_LIMIT,
            `danmu ${state.roomId}: 重连取鉴权失败：${error.message}`);
          // 不彻底放弃：按退避继续后台重试（旧版这里直接判死刑）。
          biliScheduleReconnect(state, 1006);
          return;
        }
      }
      state.urls = biliBuildWsUrls(state.hosts);
      state.urlIndex = 0;
      biliOpenWs(state);
    }

    ipcMain.on('live:danmu-connect', (event, payload = {}) => {
      const roomId = String(payload.roomId || '');
      if (!roomId) return;
      const existing = biliDanmuConnections.get(roomId);
      if (existing) {
        existing.closedByUser = true;
        biliRemoveConnection(existing);   // 清掉旧连接的全部定时器 + 只删自己
        try { existing.ws && existing.ws.close(); } catch {}
      }
      const token = String(payload.token || '');
      const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
      const state = {
        roomId,
        token,
        hosts,
        lastDanmuAt: Date.now(),       // 保留旧字段以兼容，真正复用判断看 lastMessageAt
        lastMessageAt: 0,             // 真正的「最后一条弹幕」时间
        lastFrameAt: Date.now(),      // watchdog 的读时间戳
        sender: event.sender,
        urls: biliBuildWsUrls(hosts),
        urlIndex: 0,
        opened: false,
        openedAt: 0,
        retryCount: 0,
        lastRetryAt: 0,
        closedByUser: false,
        forceToken: false,
        reconnectArmed: false,
        reconnectTimer: null,
        heartbeat: null,
        watchdog: null,
        waitFirstDanmuTimer: null,
        logCounts: {},
        captured: 0,
        ws: null,
        connected: false,
      };
      biliDanmuConnections.set(roomId, state);
      if (typeof WS !== 'function') {
        safeSend(event.sender, 'live:danmu-event', { roomId, type: 'closed', status: '主进程缺少 WebSocket 支持' });
        biliRemoveConnection(state);
        return;
      }
      // 空 token 拦截：不带 key 服务器照样接受连接，但一条弹幕都不会推（旧版还会显示假「已连接」）。
      if (!token) {
        safeSend(event.sender, 'live:danmu-event', { roomId, type: 'closed', status: '弹幕鉴权失败：没有拿到 key，请重新连接或稍后再试' });
        biliRemoveConnection(state);
        return;
      }
      biliOpenWs(state);
    });

    ipcMain.on('live:danmu-disconnect', (_event, roomId) => {
      const state = biliDanmuConnections.get(String(roomId || ''));
      if (!state) return;
      state.closedByUser = true;
      biliRemoveConnection(state);   // 清 watchdog / 心跳 / 退避定时器 + 只删自己
      try { state.ws && state.ws.close(); } catch {}
    });

    /*
     * B 站账号登录窗口：passport.bilibili.com，扫码 / 账密都行。
     * 用默认会话开窗——登录产生的 SESSDATA 等 cookie 直接落在主会话里，
     * 弹幕鉴权（useSessionCookies）立刻就能用上，不需要导来导去。
     * 窗口轮询到 SESSDATA 出现就自动关闭并返回成功。
     *
     * 注意：-352 并不是"没登录"造成的（见上面的 WBI 签名），登录入口只是
     * 顺手保留。但它必须真的能用，不能点了没反应，所以这里补两件事：
     *   1. 伪装成桌面 Chrome——Electron 默认 UA 带 Electron/xx，B 站登录页
     *      会按 UA 判断"浏览器不受支持"，二维码渲染不出来 / 登录提交被拒。
     *   2. 放行 window.open——QQ / 微信 / 短信登录是弹窗，Electron 默认拦掉，
     *      不放行就是点了没反应。
     */
    /*
     * B 站登录状态（2026-11-18）。
     *
     * 登录窗口早就做了（bili:login 轮询 SESSDATA 自动关窗），但界面上没有地方
     * 能看到"我现在到底登录了没有"。而轮播/未开播房间的点歌依赖聊天区接口，
     * 未登录时 gethistory 返回空数组 —— 用户完全没有可观测依据，只能怀疑功能坏了。
     * 这里用 x/web-interface/nav 回一个明确状态，卡片头部常驻显示。
     * 未登录时 nav 返回 code -101 但 data.isLogin=0，仍然能判断，所以 accept 放宽。
     */
    ipcMain.handle('bili:login-status', async () => {
      try {
        const { json } = await biliGetJson(
          'https://api.bilibili.com/x/web-interface/nav',
          'https://www.bilibili.com/',
          (parsed) => Boolean(parsed && typeof parsed === 'object' && parsed.data)
        );
        const data = (json && json.data) || {};
        return {
          loggedIn: Number(data.isLogin) === 1,
          uname: String(data.uname || ''),
          mid: String(data.mid || ''),
        };
      } catch {
        return { loggedIn: false, uname: '', mid: '' };
      }
    });

    let biliLoginWin = null;
    ipcMain.handle('bili:login', () => {
      if (biliLoginWin) {
        biliLoginWin.focus();
        return Promise.resolve({ ok: false, reason: '登录窗口已经开着，去看一眼' });
      }
      return new Promise((resolve) => {
        let settled = false;
        let poll = null;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (poll) clearInterval(poll);
          resolve(result);
        };
        biliLoginWin = new BrowserWindow({
          width: 1020,
          height: 720,
          title: '登录B站账号',
          autoHideMenuBar: true,
          backgroundColor: '#f6f7f8',
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        try {
          biliLoginWin.webContents.setUserAgent(BILI_UA);
          biliLoginWin.webContents.session.setUserAgent(BILI_UA);
        } catch {
          /* ignore */
        }
        // QQ / 微信登录会另开弹窗，Electron 默认拦掉 window.open
        biliLoginWin.webContents.setWindowOpenHandler(() => ({
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        }));
        poll = setInterval(async () => {
          try {
            const cookies = await session.defaultSession.cookies.get({ domain: 'bilibili.com' });
            if (cookies.some((c) => c.name === 'SESSDATA')) {
              const win = biliLoginWin;
              biliLoginWin = null;
              try {
                win.close();
              } catch {
                /* already gone */
              }
              finish({ ok: true });
            }
          } catch {
            /* ignore poll errors */
          }
        }, 800);
        biliLoginWin.on('closed', () => {
          biliLoginWin = null;
          finish({ ok: false, reason: '窗口已关闭' });
        });
        biliLoginWin.loadURL('https://passport.bilibili.com/login').catch(() => {});
      });
    });

    // 应用退出时别把隐藏窗口留成孤儿进程
    app.on('before-quit', () => {
      try {
        stopDanmaku();
      } catch {
        /* ignore */
      }
    });
}

module.exports = { installLiveIpc };
