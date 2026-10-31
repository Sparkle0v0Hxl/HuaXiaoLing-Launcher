/*
 * B站弹幕链路诊断（开发用，不进打包）
 *
 * 背景：界面卡片「最近弹幕」一直显示 —，说明主进程 WebSocket 一条 DANMU_MSG
 * 都没收到。这个脚本用**和主进程完全相同的签名算法与补包格式**在纯 Node 里跑一遍，
 * 一条命令就能分清是：
 *   a) 协议层有问题（拿不到 token / 连上不推 / 解析不出 DANMU_MSG）
 *   b) 那个房间当时真的没人发弹幕
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 "<启动器.exe>" scripts/dev/diag-live-danmaku.cjs [房间号] [持续秒数]
 * 不带房间号时自动挑一个正在直播的热门房间。
 */

const crypto = require('crypto');
const zlib = require('zlib');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* 与 electron/main.js 完全一致的规范 64 位置换表 */
const WBI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 11, 60, 20, 21, 56, 34, 44, 52, 22, 36, 1, 63, 59, 57, 54, 62, 6,
  4, 30, 25, 51,
];

const mixinKey = (imgKey, subKey) =>
  WBI_MIXIN_TAB.map((i) => `${imgKey}${subKey}`[i]).join('').slice(0, 32);

const wbiEncode = (text) =>
  encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

function wbiQuery(params, imgKey, subKey) {
  const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(signed)
    .sort()
    .map((key) => `${wbiEncode(key)}=${wbiEncode(String(signed[key]))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey(imgKey, subKey)).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

async function getJson(url, referer) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json' },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 80)}`);
  }
}

async function wbiKeys() {
  const json = await getJson('https://api.bilibili.com/x/web-interface/nav', 'https://www.bilibili.com/');
  const img = json?.data?.wbi_img?.img_url;
  const sub = json?.data?.wbi_img?.sub_url;
  if (!img || !sub) throw new Error('nav 里没有 wbi_img，拿不到签名密钥');
  return {
    imgKey: String(img).split('/').pop().split('.')[0],
    subKey: String(sub).split('/').pop().split('.')[0],
  };
}

async function pickLiveRoom() {
  // 直播首页推荐位，挑第一个有真实房间号的
  const json = await getJson(
    'https://api.live.bilibili.com/room/v1/room/get_user_recommend?page=1&page_size=8',
    'https://live.bilibili.com/'
  );
  for (const item of json?.data || []) {
    const id = item?.roomid || item?.room_id;
    if (id) return { roomId: String(id), title: String(item?.title || '') };
  }
  return null;
}

function packet(value, operation = 7) {
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

async function main() {
  const argRoom = String(process.argv[2] || '').trim();
  const seconds = Math.max(5, Number(process.argv[3]) || 20);

  console.log('== 环境 ==');
  console.log('node        ', process.versions.node);
  console.log('WebSocket   ', typeof globalThis.WebSocket);
  console.log('fetch       ', typeof globalThis.fetch);

  let roomId = argRoom;
  if (!roomId) {
    const pick = await pickLiveRoom().catch((e) => {
      console.log('挑房间失败：', e.message);
      return null;
    });
    if (!pick) {
      console.log('\n没有指定房间号，也挑不到热门直播，请手动传入：scripts/dev/diag-live-danmaku.cjs 房间号');
      process.exit(1);
    }
    roomId = pick.roomId;
    console.log('自动挑选房间', roomId, pick.title);
  }

  console.log('\n== 1. 签名取 getDanmuInfo ==');
  const keys = await wbiKeys();
  console.log('imgKey/subKey', keys.imgKey.slice(0, 8) + '…', keys.subKey.slice(0, 8) + '…');
  const query = wbiQuery({ id: roomId, type: 0 }, keys.imgKey, keys.subKey);
  const info = await getJson(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
    `https://live.bilibili.com/${roomId}`
  );
  console.log('retcode', info?.code, 'message', info?.message);
  if (info?.code !== 0) {
    console.log('>>> 结论：拿不到弹幕鉴权，主进程同样会失败。');
    process.exit(1);
  }
  const token = String(info?.data?.token || '');
  const hosts = (info?.data?.host_list || []).map((h) => ({ host: h.host, port: h.wss_port || h.ws_port || 443 }));
  console.log('token 长度', token.length, '| 服务器', hosts.slice(0, 3).map((h) => h.host + ':' + h.port).join(', '));

  console.log('\n== 2. 建 WebSocket 并收包（' + seconds + ' 秒）==');
  const url = `wss://${(hosts[0] || {}).host || 'broadcastlv.chat.bilibili.com'}:${(hosts[0] || {}).port || 443}/sub`;
  console.log('连接', url);
  const WS = globalThis.WebSocket;
  if (typeof WS !== 'function') {
    console.log('>>> 结论：当前运行时没有全局 WebSocket（主进程同样会报「缺少 WebSocket 支持」）。');
    process.exit(1);
  }
  const ws = new WS(url);
  ws.binaryType = 'arraybuffer';

  const stat = { open: 0, authReply: 0, popular: 0, danmu: 0, other: 0, heartbeats: 0, versions: new Map() };
  let heartbeat = 0;

  ws.addEventListener('open', () => {
    stat.open += 1;
    console.log('[open] 已建立 TCP 连接，发 auth 包');
    ws.send(
      packet({ uid: 0, roomid: Number(roomId), protover: 2, platform: 'web', type: 2, key: token })
    );
    heartbeat = setInterval(() => {
      stat.heartbeats += 1;
      if (ws.readyState === 1) ws.send(packet({}, 2));
    }, 20000);
  });

  const decode = (buf) => {
    let offset = 0;
    while (offset + 16 <= buf.length) {
      const total = buf.readUInt32BE(offset);
      const header = buf.readUInt16BE(offset + 4);
      const version = buf.readUInt16BE(offset + 6);
      const operation = buf.readUInt32BE(offset + 8);
      if (!total || total > buf.length - offset) break;
      const body = buf.subarray(offset + header, offset + total);
      stat.versions.set(`${operation}/v${version}`, (stat.versions.get(`${operation}/v${version}`) || 0) + 1);
      if (operation === 8) {
        stat.authReply += 1;
        console.log('[op8] 认证成功，服务器开始推送');
      } else if (operation === 3) {
        stat.popular += 1;
        console.log('[op3] 人气值', body.readUInt32BE(0));
      } else if (operation === 5) {
        if (version === 2 || version === 3) {
          try {
            decode(version === 3 ? zlib.brotliDecompressSync(body) : zlib.inflateSync(body));
          } catch (error) {
            console.log('[op5] 解压失败 v' + version, error.message);
          }
        } else {
          let json = null;
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {
            stat.other += 1;
            offset += total;
            continue;
          }
          for (const item of Array.isArray(json) ? json : [json]) {
            const cmd = String(item?.cmd || '');
            if (cmd.includes('DANMU_MSG')) {
              stat.danmu += 1;
              console.log('  💬', String(item?.info?.[2]?.[1] || '?'), '：', String(item?.info?.[1] || ''));
            } else {
              stat.other += 1;
            }
          }
        }
      }
      offset += total;
    }
  };

  ws.addEventListener('message', (event) => {
    const data = event.data;
    let buf = null;
    if (data instanceof ArrayBuffer) buf = Buffer.from(data);
    else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else buf = Buffer.from(data);
    if (buf && buf.length) decode(buf);
  });

  ws.addEventListener('error', (event) => console.log('[error]', event?.message || event?.error?.message || '未知'));
  ws.addEventListener('close', (event) => console.log('[close] code', event?.code, event?.reason || ''));

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  clearInterval(heartbeat);
  try {
    ws.close();
  } catch {
    /* ignore */
  }

  console.log('\n== 汇总 ==');
  console.log(stat);
  console.log('包类型分布', [...stat.versions.entries()].map(([k, v]) => `${k}×${v}`).join('  '));
  if (!stat.open) console.log('>>> 结论：TCP 都没连上，是网络/代理问题。');
  else if (!stat.authReply) console.log('>>> 结论：连上了但服务器没回 op8 —— 鉴权被拒（token 无效或房间号不对）。');
  else if (!stat.danmu) {
    console.log('>>> 结论：鉴权通过、服务器在推包，但这段窗口里没有 DANMU_MSG。');
    console.log('    换个人多的房间或换个时间再跑一次（比如现在这个房间真的没人说话）。');
  } else console.log('>>> 结论：协议层完好，能正常收到弹幕。若界面仍是 —，问题在渲染层路由。');
}

main().catch((error) => {
  console.log('\n[异常]', error && error.stack ? error.stack : error);
  process.exit(1);
});
