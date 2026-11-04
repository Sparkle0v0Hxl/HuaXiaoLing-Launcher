'use strict';

/**
 * 运行诊断：网络请求留痕 + 一键导出。
 *
 * 起因很朴素：用户报「更新失败」「封面不显示」，我们手上什么都没有，只能靠
 * 猜和来回问。这份日志的作用是把「哪个地址、什么时候、多久、什么状态码、
 * 走的哪条网络栈」记下来——这三项基本能直接指认出是代理没生效、CDN 挂了，
 * 还是证书被中间人拦了。
 *
 * 只记元数据，不记 body、不记 header、不记 token。环形缓冲，内存里最多留
 * 240 条请求 + 200 条事件，跑一整天也就几十 KB。
 */

const MAX_REQUESTS = 240;
const MAX_EVENTS = 200;
/** 同一个地址在这个窗口内只记一次：封面批量拉取、分段重试不该把日志刷满 */
const DEDUPE_WINDOW = 5000;

const requests = [];
const events = [];
const lastSeen = new Map();

function push(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

function stamp() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * 记一条网络请求。由 http-fetch 在注入后调用，其它模块也可以直接用。
 */
function recordRequest(entry) {
  if (!entry) return;
  const url = String(entry.url || '');
  if (!url) return;
  const now = Date.now();
  const seen = lastSeen.get(url);
  // 只对「成功且同一地址」去重；失败不去重——连续失败几次本身就是信息
  if (!entry.error && seen && now - seen < DEDUPE_WINDOW) return;
  lastSeen.set(url, now);
  if (lastSeen.size > 400) {
    // 简单清理：删掉最早的一批，别让 Map 无限长大
    let drop = lastSeen.size - 300;
    for (const key of lastSeen.keys()) {
      lastSeen.delete(key);
      if (--drop <= 0) break;
    }
  }
  push(
    requests,
    {
      at: stamp(),
      method: String(entry.method || 'GET').toUpperCase(),
      url: url.length > 300 ? `${url.slice(0, 300)}…` : url,
      status: Number(entry.status) || 0,
      ms: Number(entry.ms) || 0,
      transport: String(entry.transport || ''),
      error: entry.error ? String(entry.error).slice(0, 200) : '',
    },
    MAX_REQUESTS
  );
}

/** 记一条事件（更新失败、崩溃、代理切换之类）。level: info | warn | error */
function recordEvent(level, tag, message, extra) {
  push(
    events,
    {
      at: stamp(),
      level: String(level || 'info'),
      tag: String(tag || ''),
      message: String(message || '').slice(0, 400),
      extra: extra ? String(extra).slice(0, 400) : '',
    },
    MAX_EVENTS
  );
}

function requestLines() {
  if (!requests.length) return ['（没有记录到网络请求）'];
  return requests.map((item) => {
    const result = item.error ? `ERR ${item.error}` : `${item.status || '-'}`;
    return `${item.at}  ${item.method.padEnd(4)} ${String(result).padEnd(6)} ${String(item.ms).padStart(6)}ms  ${item.transport.padEnd(9)} ${item.url}`;
  });
}

function eventLines() {
  if (!events.length) return ['（没有记录到事件）'];
  return events.map((item) => {
    const extra = item.extra ? `  ${item.extra}` : '';
    return `${item.at}  [${item.level}] ${item.tag ? item.tag + ' ' : ''}${item.message}${extra}`;
  });
}

/**
 * 拼出诊断正文。
 *
 * @param {object} info 由主进程提供：版本、系统、安装与数据目录、设置摘要、日志片段
 */
function buildReport(info = {}) {
  const lines = [];
  lines.push('花筱灵启动器 · 运行诊断');
  lines.push(`生成时间  ${info.generatedAt || new Date().toLocaleString('zh-CN')}`);
  lines.push('');
  lines.push('—— 环境 ——');
  for (const [key, value] of Object.entries(info.env || {})) {
    lines.push(`${key}  ${value}`);
  }
  if (info.settings && Object.keys(info.settings).length) {
    lines.push('');
    lines.push('—— 设置摘要（不含任何账号或密码）——');
    for (const [key, value] of Object.entries(info.settings)) {
      lines.push(`${key}  ${value}`);
    }
  }
  lines.push('');
  lines.push(`—— 网络请求（最近 ${requests.length} 条，新的在下）——`);
  lines.push(...requestLines());
  lines.push('');
  lines.push(`—— 事件（最近 ${events.length} 条）——`);
  lines.push(...eventLines());
  for (const block of Array.isArray(info.logs) ? info.logs : []) {
    if (!block || !block.text) continue;
    lines.push('');
    lines.push(`—— ${block.title || '日志'} ——`);
    lines.push(String(block.text).replace(/^\uFEFF/, '').trimEnd());
  }
  lines.push('');
  return lines.join('\n');
}

function requestCount() {
  return requests.length;
}

function reset() {
  requests.length = 0;
  events.length = 0;
  lastSeen.clear();
}

module.exports = {
  recordRequest,
  recordEvent,
  buildReport,
  requestCount,
  reset,
};
