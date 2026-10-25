'use strict';

/**
 * 多平台直播间解析。
 *
 * 目标：用户把任意支持的直播间链接贴进来，都能得到统一的
 * { platform, roomId, title, liveStatus, ws } / 或者明确的「不支持」提示。
 *
 * 说明：
 * - B 站：官方开放 WebSocket，弹幕可直接接收（已有实现）。
 * - 斗鱼：有公开的 RoomApi 拿房间信息；弹幕走 openbarrage TCP，
 *   浏览器里无法直连，所以这里只做「识别 + 房间信息」，弹幕需服务端转发。
 * - 虎牙 / 抖音：网页有强签名（ttwid、huya 的 ws 签名），
 *   纯前端拿不到稳定弹幕流；同样只做房间识别与状态，明确告知限制。
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function getJson(url, headers = {}) {
  const { signal, done } = withTimeout(15000);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json', ...headers },
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    done();
  }
}

async function getText(url, headers = {}) {
  const { signal, done } = withTimeout(15000);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html', ...headers },
      signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    done();
  }
}

/* ------------------------------------------------------------------ */
/* 平台识别                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从各种写法里抽出直播间标识。
 * 支持完整链接、省略协议、以及纯房间号（纯数字时按 B 站解析，保持旧行为）。
 */
function detectPlatform(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^live\.bilibili\.com/i.test(text) || /^bilibili\.com/i.test(text)) {
    return { platform: 'bilibili', text: `https://${text.replace(/^https?:\/\//i, '')}` };
  }
  if (/^https?:\/\//i.test(text)) return { platform: null, text };
  // 纯数字默认为 B 站房间号，兼容原有用法
  if (/^\d+$/.test(text)) return { platform: 'bilibili', text };
  return { platform: null, text };
}

function platformFromUrl(url) {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (!host) return null;
  if (host.endsWith('bilibili.com')) return 'bilibili';
  if (host.endsWith('douyu.com')) return 'douyu';
  if (host.endsWith('huya.com')) return 'huya';
  if (host.endsWith('douyin.com')) return 'douyin';
  if (host.endsWith('kuaishou.com')) return 'kuaishou';
  if (host.endsWith('yy.com')) return 'yy';
  if (host.endsWith('cc.163.com')) return 'cc';
  if (host.endsWith('zhanqi.tv')) return 'zhanqi';
  if (host.endsWith('huajiao.com')) return 'huajiao';
  return null;
}

const PLATFORM_LABELS = {
  bilibili: 'B站',
  douyu: '斗鱼',
  huya: '虎牙',
  douyin: '抖音',
  kuaishou: '快手',
  yy: 'YY',
  cc: '网易CC',
  zhanqi: '战旗',
  huajiao: '花椒',
};

/* ------------------------------------------------------------------ */
/* 各平台房间信息                                                      */
/* ------------------------------------------------------------------ */

async function resolveBilibili(text) {
  const match =
    text.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/i) ||
    text.match(/room[_/]?id[=:]?(\d+)/i) ||
    text.match(/^(\d+)$/);
  const roomId = match?.[1];
  if (!roomId) throw new Error('没有识别出 B 站直播间号');
  const json = await getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`);
  const info = json.data;
  if (json.code !== 0 || !info?.room_id) throw new Error(json.message || '没有找到这个直播间');
  return {
    platform: 'bilibili',
    platformLabel: 'B站',
    roomId: String(info.room_id),
    title: info.title || '',
    liveStatus: info.live_status || 0,
    danmaku: 'native',
  };
}

async function resolveDouyu(url) {
  const match = url.match(/douyu\.com\/(?:topic\/)?(\w+)/i);
  const roomId = match?.[1];
  if (!roomId) throw new Error('没有识别出斗鱼直播间号');
  const json = await getJson(`https://open.douyucdn.cn/api/RoomApi/room/${roomId}`);
  if (json.error !== 0 || !json.data) throw new Error(json.data?.error_msg || '没有找到这个斗鱼直播间');
  const data = json.data;
  return {
    platform: 'douyu',
    platformLabel: '斗鱼',
    roomId: String(data.room_id || roomId),
    title: data.room_name || '',
    liveStatus: data.room_status === '1' ? 1 : 0,
    danmaku: 'unsupported',
    note: '斗鱼的弹幕走 TCP 私有协议，浏览器无法直连；这里只显示房间状态。',
  };
}

async function resolveHuya(url) {
  const match = url.match(/huya\.com\/(\d+)/i) || url.match(/huya\.com\/([a-zA-Z0-9_]+)/i);
  const roomId = match?.[1];
  if (!roomId) throw new Error('没有识别出虎牙直播间号');
  const html = await getText(`https://www.huya.com/${roomId}`);
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  const live = /直播中|正在直播/.test(html) ? 1 : 0;
  return {
    platform: 'huya',
    platformLabel: '虎牙',
    roomId: String(roomId),
    title: title.replace(/-\s*虎牙直播.*$/i, '').trim(),
    liveStatus: live,
    danmaku: 'unsupported',
    note: '虎牙弹幕需要签名连接，当前只显示房间状态。',
  };
}

async function resolveDouyin(url) {
  const match = url.match(/douyin\.com\/(\d+)/i) || url.match(/live\.douyin\.com\/(\w+)/i);
  const roomId = match?.[1];
  if (!roomId) throw new Error('没有识别出抖音直播间号');
  const html = await getText(`https://live.douyin.com/${roomId}`);
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  return {
    platform: 'douyin',
    platformLabel: '抖音',
    roomId: String(roomId),
    title: title.replace(/-\s*抖音.*$/i, '').trim(),
    liveStatus: /直播中/.test(html) ? 1 : 0,
    danmaku: 'unsupported',
    note: '抖音弹幕需要 ttwid 签名，当前只显示房间状态。',
  };
}

/**
 * 统一入口：识别链接 → 拉房间信息。
 * 不支持弹幕的平台会带上 note，由界面提示用户。
 */
async function resolveLiveRoom(raw) {
  const detected = detectPlatform(raw);
  const url = detected.text;
  const platform = detected.platform || platformFromUrl(url);

  if (!platform) {
    throw new Error('暂不支持这个直播间链接；目前支持 B站、斗鱼、虎牙、抖音');
  }

  switch (platform) {
    case 'bilibili':
      return resolveBilibili(url);
    case 'douyu':
      return resolveDouyu(url);
    case 'huya':
      return resolveHuya(url);
    case 'douyin':
      return resolveDouyin(url);
    default: {
      const label = PLATFORM_LABELS[platform] || platform;
      throw new Error(`${label} 的弹幕接口需要额外签名，暂未接入；可以先使用 B站直播点歌`);
    }
  }
}

module.exports = { resolveLiveRoom, detectPlatform, platformFromUrl, PLATFORM_LABELS };
