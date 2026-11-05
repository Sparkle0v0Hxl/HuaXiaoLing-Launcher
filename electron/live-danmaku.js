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

// 只拦明确的媒体扩展名：ts 后缀会误杀 TypeScript / JS / 接口请求，故不再列入。
const MEDIA_PATTERN = /\.(flv|m3u8|mp4|m4s|aac|mp3)(\?|$)/i;

/*
 * 多房间并存：id → handle。点歌台可以同时挂 B 站（官方 WS，不在这）+
 * 抖音 + 斗鱼…，每路隐藏窗口独立开关、独立轮询。
 */
const handles = new Map();
let handleSeq = 1;

// 每个 partition 的 webRequest 拦截只注册一次，避免同平台多房间叠加 N 个监听器。
const registeredSessions = new Set();

// 页面进程异常时的自动恢复：总次数上限 + 最小间隔，避免无限 reload。
const MAX_AUTO_RELOAD = 3;
const AUTO_RELOAD_MIN_GAP = 15000;

// 去重滑动窗口上限：从 600 提到 5000，降低长时间直播里旧键被挤出后
// 同一条弹幕被重复喂给点歌队列的概率；仍是滑动窗口，内存可控。
const MAX_SEEN = 5000;

const LONG_EMPTY_STATUS = '长时间未抓到弹幕，请检查登录/页面结构';
const BAD_TITLE_RE = /(登录|登陆|验证|风控|安全验证|安全中心|安全拦截|安全检测|403|出错|访问受限|拒绝访问|人机|滑动)/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

/**
 * 生成注入到页面的扫描函数。页面里只做「把聊天区最近 80 条读出来」，不含业务逻辑。
 * 用 String.raw 是为了让注入代码里的正则反斜杠原样输出，不必在模板里二次转义。
 */
function scanScript(picker) {
  return String.raw`(() => {
  const cfg = ${JSON.stringify({ item: picker.item, user: picker.user, text: picker.text })};
  window.__hxCfg = cfg;
  const pickOne = (el, sel) => {
    for (const part of String(sel || '').split(',')) {
      const s = part.trim();
      if (!s) continue;
      let node = null;
      try { node = el.querySelector(s); } catch { node = null; }
      const t = node ? (node.textContent || '') : '';
      if (t && t.trim()) return t.replace(/\s+/g, ' ').trim();
    }
    return '';
  };
  window.__hxScan = () => {
    const out = [];
    let items = [];
    try { items = Array.from(document.querySelectorAll(cfg.item)); } catch { items = []; }
    for (const el of items.slice(-80)) {
      // 正文优先取平台专用的 text 子选择器，取不到才回退整条 textContent，
      // 避免把用户名混进正文、导致点歌命令正则失配。
      const picked = pickOne(el, cfg.text);
      const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const text = picked || raw;
      if (!text || text.length < 2) continue;
      // 只过滤明显的系统/进场提示：含点歌命令的一律保留；纯「来了」、
      // 「欢迎xxx来了」「xxx进入直播间」这类才丢掉，不误杀
      // 「点歌 春天来了」「春天来了」等正常弹幕。
      const hasSongCommand = /(点歌|点播)/.test(text);
      const isSystemNotice =
        /^(来了|来啦|来咯|欢迎光临|欢迎来到直播间|进入直播间)[～~!！。\s]*$/.test(text) ||
        /(进入(了)?直播间|送给主播|赠送|关注了主播|分享(了)?直播间)/.test(text) ||
        /^(欢迎|恭迎).{0,20}(来了|来到|进入|光临)/.test(text);
      if (!hasSongCommand && isSystemNotice) continue;
      const user = pickOne(el, cfg.user);
      out.push({ user, text });
    }
    return out;
  };
  return true;
})()`;
}

function stopDanmaku(id) {
  // 不带 id：全部关掉（应用退出时用）
  if (!id) {
    for (const key of Array.from(handles.keys())) stopDanmaku(key);
    return { ok: true };
  }
  const handle = handles.get(String(id));
  if (!handle) return { ok: true };
  handles.delete(String(id));
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
 * @param {{ url: string, platform: string, id?: string }} input
 * @returns {Promise<{ok:boolean, id:string, platform:string, status:string, note?:string}>}
 */
async function startDanmaku(input) {
  const url = String(input?.url || '').trim();
  const platform = String(input?.platform || '').trim();
  const id = String(input?.id || `bridge-${handleSeq++}`);
  const picker = PLATFORM_PICKERS[platform] || PLATFORM_PICKERS.generic;
  if (!url) throw new Error('没有直播间地址');

  // 同 id 重连：先把旧的关干净
  stopDanmaku(id);

  const partition = `persist:live-${platform}`;
  const ses = session.fromPartition(partition);

  /*
   * 拦掉视频/音频请求。
   *
   * 隐藏窗口里我们不关心画面，只要聊天区。不拦的话直播间会真的把流拉下来，
   * 几百 KB/s 地烧带宽和 CPU，抓个弹幕没必要付这个代价。
   *
   * onBeforeRequest 挂在 session 上，同平台多个房间共享同一个 session，
   * 所以按 partition 只注册一次，避免监听器越叠越多。
   */
  if (!registeredSessions.has(partition)) {
    try {
      ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        if (details.resourceType === 'media' || MEDIA_PATTERN.test(details.url)) {
          callback({ cancel: true });
          return;
        }
        callback({ cancel: false });
      });
      registeredSessions.add(partition);
    } catch {
      /* 老版本 Electron 没有 webRequest 时忽略 */
    }
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
    id,
    platform,
    picker,
    status: '正在加载直播间…',
    messages: [],
    seen: new Set(),
    seenOrder: [],
    capturedTotal: 0,
    ready: false,
    healthy: false,
    needsReinject: false,
    emptyScans: 0,
    reloadCount: 0,
    lastReloadAt: 0,
  };
  handles.set(id, handle);

  win.webContents.on('did-fail-load', (_event, code, description) => {
    handle.status = `页面加载失败（${code} ${description}）`;
    handle.ready = false;
    handle.healthy = false;
    handle.needsReinject = true;
  });

  // 导航后 JS 上下文 / 页面结构都可能变，先标记未就绪，
  // 由 did-finish-load 或下一次 poll 重新注入并校验。
  const onNavigate = () => {
    handle.ready = false;
    handle.healthy = false;
    handle.needsReinject = true;
    handle.emptyScans = 0;
    handle.status = '页面发生跳转，正在重新读取聊天区…';
  };
  win.webContents.on('did-navigate', onNavigate);
  win.webContents.on('did-navigate-in-page', onNavigate);

  win.webContents.on('did-finish-load', async () => {
    handle.status = '正在读取聊天区…';
    try {
      await win.webContents.executeJavaScript(scanScript(picker), true);
      // 一次调用同时取标题与聊天区节点数，避免两次调用之间页面又变了。
      const probe = await win.webContents.executeJavaScript(
        `(function () {
          var n = 0;
          try { n = document.querySelectorAll((window.__hxCfg && window.__hxCfg.item) || '').length; } catch (e) { n = 0; }
          return { title: document.title || '', count: n };
        })()`,
        true
      );
      const title = normalizeText(probe && probe.title);
      if (title) handle.pageTitle = title;
      const count = (probe && Number(probe.count)) || 0;
      if (count === 0 || BAD_TITLE_RE.test(title)) {
        handle.healthy = false;
        handle.status = '未检测到聊天区（可能未登录、遇到验证页或页面结构已变化）';
      } else {
        handle.healthy = true;
        handle.status = `已连接${picker.label}（弹幕抓取中）`;
      }
      handle.needsReinject = false;
      handle.emptyScans = 0;
      handle.ready = true;
    } catch (error) {
      handle.healthy = false;
      handle.status = `读取聊天区失败：${error.message}`;
    }
  });

  // 渲染进程崩溃 / 消失：如实回报状态并尝试自愈（有次数上限与节流）。
  const tryRecover = (reason) => {
    handle.ready = false;
    handle.healthy = false;
    handle.needsReinject = true;
    handle.status = `页面进程异常，正在恢复…（${reason}）`;
    if (handle.win.isDestroyed()) return;
    const now = Date.now();
    if (handle.reloadCount >= MAX_AUTO_RELOAD) {
      handle.status = '页面反复异常，已停止自动恢复，请检查网络或重新连接';
      return;
    }
    if (now - handle.lastReloadAt < AUTO_RELOAD_MIN_GAP) return;
    handle.reloadCount += 1;
    handle.lastReloadAt = now;
    try {
      handle.win.webContents.reload();
    } catch (error) {
      handle.status = `页面恢复失败：${error.message}`;
    }
  };
  win.webContents.on('render-process-gone', (_event, details) => {
    tryRecover((details && details.reason) || 'render-process-gone');
  });
  win.webContents.on('crashed', () => tryRecover('crashed'));

  // 窗口真正关闭时只清理 handles 引用，不再次 destroy（stopDanmaku 已负责销毁）。
  win.on('closed', () => {
    const current = handles.get(id);
    if (current && current.win === win) {
      handles.delete(id);
      try {
        if (current.timer) clearInterval(current.timer);
      } catch {
        /* ignore */
      }
    }
  });

  try {
    await win.loadURL(url, { userAgent: BROWSER_UA });
  } catch (error) {
    handle.status = `打开直播间失败：${error.message}`;
  }

  return { ok: true, id, platform, status: handle.status, pageTitle: handle.pageTitle || '' };
}

/**
 * 取一次指定房间的新弹幕。
 * 页面里每次返回最近 80 条，这里按「用户+正文」去重，只把没见过的返回给渲染层。
 */
async function pollDanmaku(id) {
  const handle = handles.get(String(id || ''));
  if (!handle) return { messages: [], status: '未连接', alive: false, id: String(id || '') };

  if (handle.win.isDestroyed()) {
    handles.delete(String(id));
    return { messages: [], status: '窗口已关闭', alive: false, id: String(id || '') };
  }

  // 一次 executeJavaScript 完成「检测 + 按需重新注入 + 扫描」：
  // 页面导航、SPA 跳页或渲染进程重启后 window.__hxScan 会丢失，
  // 守卫保证只在缺失（或显式标记需要重注入）时才定义，不会每次轮询重复定义。
  let items = [];
  try {
    const forceReinject = handle.needsReinject ? 'true' : 'false';
    const runner = `(() => {
      if (${forceReinject} || typeof window.__hxScan !== 'function') {
        ${scanScript(handle.picker)}
      }
      return typeof window.__hxScan === 'function' ? window.__hxScan() : [];
    })()`;
    items = await handle.win.webContents.executeJavaScript(runner, true);
    handle.needsReinject = false;
  } catch {
    items = [];
  }

  // status 参与健康判定：连续多次扫到 0 条时给人话提示，且能自愈回「已连接」；
  // 注意不改变 alive 契约，绝不因为抓不到就主动断开。
  if (Array.isArray(items) && items.length > 0) {
    handle.emptyScans = 0;
    if (!handle.healthy) {
      handle.healthy = true;
      handle.status = `已连接${handle.picker.label}（弹幕抓取中）`;
    }
  } else {
    handle.emptyScans = (handle.emptyScans || 0) + 1;
    // 硬错误（加载失败 / 进程异常 / 自动恢复）与「未检测到聊天区」更具体，保留原文案。
    const hasHardError = /(失败|异常|恢复|拒绝|403|停止自动恢复)/.test(handle.status);
    const alreadyReported =
      handle.status === LONG_EMPTY_STATUS || handle.status.indexOf('未检测到聊天区') === 0;
    // 原本健康的窗口也长期扫不到（如页面被换成登录墙却没触发导航），同样要如实回报。
    const threshold = handle.healthy ? 10 : 3;
    if (!hasHardError && !alreadyReported && handle.emptyScans >= threshold) {
      handle.healthy = false;
      handle.status = LONG_EMPTY_STATUS;
    }
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
      if (handle.seenOrder.length > MAX_SEEN) {
        const drop = handle.seenOrder.shift();
        if (drop) handle.seen.delete(drop);
      }
      handle.capturedTotal += 1;
      fresh.push({ user, text: bodyText });
    }
  }

  return {
    messages: fresh,
    status: handle.status,
    alive: true,
    id: handle.id,
    pageTitle: handle.pageTitle || '',
    captured: handle.capturedTotal,
  };
}

module.exports = { startDanmaku, pollDanmaku, stopDanmaku, PLATFORM_PICKERS };
