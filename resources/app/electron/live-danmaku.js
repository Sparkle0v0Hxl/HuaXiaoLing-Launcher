'use strict';

/**
 * 多平台弹幕抓取。
 *
 * 背景：斗鱼 / 虎牙 / 抖音 / 快手 的弹幕都不是公开协议——
 * 斗鱼是 TCP 私有协议、虎牙是 Tars 编码、抖音和快手还要 ttwid / a_bogus 之类签名。
 * 在 Electron 里硬啃这些协议，平台一改版就全废，维护成本极高。
 *
 * 这里换一条更稳的路子：开一个**隐藏窗口**把直播间网页真的加载出来，
 * 只从聊天区（DOM）里读文字，把视频流和音频全部拦掉。
 * 好处是平台改协议我们不受影响，坏处是依赖页面结构，所以下面
 * 每个平台都给了「首选选择器 + 兜底选择器」，抓不到时如实回报状态。
 *
 * 与 B 站的关系：B 站继续用官方 WebSocket（更准、更省），这里只服务其它平台。
 */

const { BrowserWindow, session } = require('electron');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 各平台聊天区的选择器配置。item 命中一条弹幕，user/text 是其中的用户名与正文。 */
const PLATFORM_PICKERS = {
  douyu: {
    label: '斗鱼',
    item: '.danmaku-item, #js-chat-list .danmaku-item, .chat-cont .danmaku-item',
    user: '.nickname, .user-name, .dy-nickname',
    text: '.danmaku-content, .cont, .content',
  },
  huya: {
    label: '虎牙',
    item: '.chat-room__item, .msg-item, #chat-room__content .item, .J_msg',
    user: '.nick, .name, .user-name',
    text: '.content, .msg, .text',
  },
  douyin: {
    label: '抖音',
    item: '[class*="chatroom___item"], [class*="chat-item"], [data-e2e="chat-message"]',
    user: '[class*="nickname"], [class*="user-name"]',
    text: '[class*="content"], [class*="message"]',
  },
  kuaishou: {
    label: '快手',
    item: '.comment-item, [class*="comment-item"], [class*="chat-item"]',
    user: '.name, [class*="nickname"], [class*="user-name"]',
    text: '.content, [class*="content"]',
  },
  yy: {
    label: 'YY',
    item: '.chat-list .item, [class*="chat"] [class*="item"], .message-item',
    user: '.nick, .name, [class*="nick"]',
    text: '.content, .txt, [class*="content"]',
  },
  cc: {
    label: '网易CC',
    item: '.chat-msg-item, .chat_item, [class*="chat"] [class*="item"]',
    user: '.nickname, .name, [class*="nick"]',
    text: '.content, .msg, [class*="content"]',
  },
  huajiao: {
    label: '花椒',
    item: '.chat-item, [class*="chat"] [class*="item"]',
    user: '.nick, .name, [class*="nick"]',
    text: '.content, [class*="content"]',
  },
  kugou: {
    label: '酷狗直播',
    item: '.chat-item, .chat-msg, [class*="chat"] [class*="item"]',
    user: '.nick, .name, [class*="nick"]',
    text: '.content, [class*="content"]',
  },
  xiaohongshu: {
    label: '小红书',
    item: '[class*="chat-item"], [class*="comment-item"], [class*="message-item"]',
    user: '[class*="nickname"], [class*="user-name"]',
    text: '[class*="content"], [class*="message"]',
  },
  taobao: {
    label: '淘宝直播',
    item: '.chat-item, [class*="message-item"], [class*="chat"] [class*="item"]',
    user: '.nick, [class*="nick"]',
    text: '.content, [class*="content"]',
  },
  twitch: {
    label: 'Twitch',
    item: '.chat-line__message, [data-a-target="chat-line-message"]',
    user: '.chat-author__display-name, [data-a-target="chat-message-username"]',
    text: '[data-a-target="chat-message-text"]',
  },
  youtube: {
    label: 'YouTube',
    item: 'yt-live-chat-text-message-renderer',
    user: '#author-name',
    text: '#message',
  },
  /*
   * 通用兜底：没有专门适配过的直播站，用「类名像聊天」的元素硬抓。
   * 准确率不如专用选择器，但比直接报不支持有用；抓不到时状态栏会说清楚。
   */
  generic: {
    label: '通用抓取',
    item:
      '[class*="danmu"], [class*="danmaku"], [class*="barrage"], [class*="chat"] [class*="item"], [class*="comment-item"], [class*="message-item"]',
    user: '[class*="nick"], [class*="name"], [class*="author"]',
    text: '[class*="content"], [class*="text"], [class*="message"]',
  },
};

const MEDIA_PATTERN = /\.(flv|m3u8|ts|mp4|m4s|aac|mp3)(\?|$)/i;

let current = null;

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

/** 生成注入到页面的扫描函数。页面里只做「把聊天区最近 80 条读出来」，不含业务逻辑。 */
function scanScript(picker) {
  return `(() => {
  const cfg = ${JSON.stringify({ item: picker.item, user: picker.user, text: picker.text })};
  const pickOne = (el, sel) => {
    for (const part of String(sel).split(',')) {
      const s = part.trim();
      if (!s) continue;
      const node = el.querySelector(s);
      const t = node ? node.textContent : '';
      if (t && t.trim()) return t.replace(/\\s+/g, ' ').trim();
    }
    return '';
  };
  window.__hxScan = () => {
    const out = [];
    let items = [];
    try { items = Array.from(document.querySelectorAll(cfg.item)); } catch { items = []; }
    for (const el of items.slice(-80)) {
      const raw = el.textContent || '';
      const text = raw.replace(/\\s+/g, ' ').trim();
      if (!text || text.length < 2) continue;
      if (text.includes('送给主播') || text.includes('进入直播间') || text.includes('来了')) continue;
      const user = pickOne(el, cfg.user);
      out.push({ user, text });
    }
    return out;
  };
  return true;
})()`;
}

function stopDanmaku() {
  const handle = current;
  current = null;
  if (!handle) return { ok: true };
  try {
    if (handle.timer) clearInterval(handle.timer);
  } catch {
    /* ignore */
  }
  try {
    handle.win.destroy();
  } catch {
    /* ignore */
  }
  return { ok: true };
}

/**
 * 开一个隐藏窗口去抓某个直播间的弹幕。
 *
 * @param {{ url: string, platform: string }} input
 * @returns {Promise<{ok:boolean, platform:string, status:string, note?:string}>}
 */
async function startDanmaku(input) {
  const url = String(input?.url || '').trim();
  const platform = String(input?.platform || '').trim();
  const picker = PLATFORM_PICKERS[platform] || PLATFORM_PICKERS.generic;
  if (!url) throw new Error('没有直播间地址');

  stopDanmaku();

  const partition = `persist:live-${platform}`;
  const ses = session.fromPartition(partition);

  /*
   * 拦掉视频/音频请求。
   *
   * 隐藏窗口里我们不关心画面，只要聊天区。不拦的话直播间会真的把流拉下来，
   * 几百 KB/s 地烧带宽和 CPU，抓个弹幕没必要付这个代价。
   */
  try {
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      if (details.resourceType === 'media' || MEDIA_PATTERN.test(details.url)) {
        callback({ cancel: true });
        return;
      }
      callback({ cancel: false });
    });
  } catch {
    /* 老版本 Electron 没有 webRequest 时忽略 */
  }

  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 760,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  try {
    win.webContents.setAudioMuted(true);
    win.webContents.setUserAgent(BROWSER_UA);
  } catch {
    /* ignore */
  }

  const handle = {
    win,
    platform,
    status: '正在加载直播间…',
    messages: [],
    seen: new Set(),
    seenOrder: [],
    ready: false,
  };
  current = handle;

  win.webContents.on('did-fail-load', (_event, code, description) => {
    handle.status = `页面加载失败（${code} ${description}）`;
  });

  win.webContents.on('did-finish-load', async () => {
    handle.status = '正在读取聊天区…';
    try {
      await win.webContents.executeJavaScript(scanScript(picker), true);
      const title = await win.webContents.executeJavaScript('document.title || ""', true);
      if (title) handle.pageTitle = normalizeText(title);
      handle.ready = true;
      handle.status = `已连接${picker.label}（弹幕抓取中）`;
    } catch (error) {
      handle.status = `读取聊天区失败：${error.message}`;
    }
  });

  try {
    await win.loadURL(url, { userAgent: BROWSER_UA });
  } catch (error) {
    handle.status = `打开直播间失败：${error.message}`;
  }

  return { ok: true, platform, status: handle.status, pageTitle: handle.pageTitle || '' };
}

/**
 * 取一次新弹幕。
 * 页面里每次返回最近 80 条，这里按「用户+正文」去重，只把没见过的返回给渲染层。
 */
async function pollDanmaku() {
  const handle = current;
  if (!handle) return { messages: [], status: '未连接', alive: false };

  if (handle.win.isDestroyed()) {
    current = null;
    return { messages: [], status: '窗口已关闭', alive: false };
  }

  let items = [];
  try {
    items = await handle.win.webContents.executeJavaScript('window.__hxScan ? window.__hxScan() : []', true);
  } catch {
    items = [];
  }

  const fresh = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      const text = normalizeText(item?.text);
      if (!text) continue;
      let user = normalizeText(item?.user);
      let body = text;
      // 平台把「用户名」也塞在同一条文本里时，从正文里剥掉，避免点歌命令被前缀污染
      if (user && body.startsWith(user)) body = body.slice(user.length).replace(/^[:：\s]+/, '').trim();
      if (!user && /[:：]/.test(body)) {
        const parts = body.split(/[:：]/);
        if (parts.length >= 2 && parts[0].length <= 24) {
          user = parts.shift().trim();
          body = parts.join(':').trim();
        }
      }
      const bodyText = body || text;
      const key = `${user}|${bodyText}`;
      if (!bodyText || handle.seen.has(key)) continue;
      handle.seen.add(key);
      handle.seenOrder.push(key);
      if (handle.seenOrder.length > 600) {
        const drop = handle.seenOrder.shift();
        if (drop) handle.seen.delete(drop);
      }
      fresh.push({ user, text: bodyText });
    }
  }

  return {
    messages: fresh,
    status: handle.status,
    alive: true,
    pageTitle: handle.pageTitle || '',
    captured: handle.seen.size,
  };
}

module.exports = { startDanmaku, pollDanmaku, stopDanmaku, PLATFORM_PICKERS };
