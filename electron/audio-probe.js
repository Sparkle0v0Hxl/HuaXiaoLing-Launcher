'use strict';

/**
 * 播放前探测：确认一条地址真的能拿到音频文件。
 *
 * 「换链成功」不等于「地址能放」：有的接口返回错误页 JSON，有的 CDN 已失效，
 * 有的只给几十秒试听片段。以前 raceFirst 谁先给地址就用谁，结果经常拿到一条
 * 放不出的 URL。这里用 Range 只取头部十几 KB 验一次身份：
 *   · 状态码必须是 200 / 206；
 *   · Content-Type 明确是网页 / JSON 错误页的直接否掉；
 *   · 明确是 audio/* 就采纳（aac / adts 之类没有固定魔数，不能靠魔数判）；
 *   · 类型可疑或缺失时再看头部魔数是不是常见音频容器。
 * 只读第一个 chunk 就 cancel，不会把整首歌拉下来。
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpsify(url) {
  let out = String(url || '').replace(/^http:/i, 'https:');
  out = out.replace(/\/\/(img\d+)\.kwcdn\.kuwo\.cn\//i, '//$1.kuwo.cn/');
  return out;
}

const AUDIO_MAGIC = [
  { name: 'mp3-id3', test: (b) => b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 },
  { name: 'ogg', test: (b) => b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53 },
  { name: 'flac', test: (b) => b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43 },
  {
    name: 'wav',
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45,
  },
  { name: 'mp4/m4a', test: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
  { name: 'ebml/webm', test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { name: 'mp3-frame', test: (b) => b[0] === 0xff && (b[1] & 0xe0) === 0xe0 },
];

const PROBE_TIMEOUT = 5000;
const PROBE_RANGE = 'bytes=0-16383';

/**
 * @returns {Promise<{ok: boolean, reason?: string, contentType?: string, magic?: string, bytes?: number}>}
 */
async function probeAudioUrl(rawUrl, timeout = PROBE_TIMEOUT) {
  const url = httpsify(rawUrl);
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: '不是 http(s) 地址' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const cancelBody = async (resp) => {
    try { await resp.body?.cancel?.(); } catch { /* ignore */ }
  };
  try {
    const resp = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, range: PROBE_RANGE },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (resp.status !== 200 && resp.status !== 206) {
      await cancelBody(resp);
      return { ok: false, reason: `HTTP ${resp.status}` };
    }
    const ct = String(resp.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    if (ct.startsWith('text/') || ct === 'application/json' || ct === 'application/javascript') {
      await cancelBody(resp);
      return { ok: false, reason: `返回的不是音频（${ct || '空类型'}）` };
    }
    let head = new Uint8Array(0);
    const reader = resp.body?.getReader?.();
    if (reader) {
      try {
        const { value } = await reader.read();
        if (value) head = value instanceof Uint8Array ? value : new Uint8Array(value);
      } finally {
        try { await reader.cancel(); } catch { /* ignore */ }
      }
    } else {
      const buf = await resp.arrayBuffer();
      head = new Uint8Array(buf).subarray(0, 16384);
    }
    if (!head.length) return { ok: false, reason: '响应为空' };
    if (ct.startsWith('audio/')) return { ok: true, contentType: ct, bytes: head.length };
    const hit = AUDIO_MAGIC.find((m) => m.test(head));
    if (hit) return { ok: true, contentType: ct, magic: hit.name, bytes: head.length };
    const hex = Array.from(head.subarray(0, 8)).map((n) => n.toString(16).padStart(2, '0')).join(' ');
    return { ok: false, reason: `头部不像音频（${ct || '无 Content-Type'} / ${hex}）` };
  } catch (error) {
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return { ok: false, reason: aborted ? '探测超时' : String(error?.message || error).slice(0, 60) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { probeAudioUrl, PROBE_TIMEOUT };
