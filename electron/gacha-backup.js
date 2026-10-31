'use strict';

/*
 * gacha-backup —— 抽卡记录云备份（WebDAV）。
 *
 * 纯逻辑模块，不 require electron：调用方把 userData 和配置传进来，
 * 方便脱离主进程单测（scripts 里那份自测就是这么跑的）。
 *
 * 上传的东西只有三样：
 *   gacha-imports.json    抽卡记录本体（导入的、从各家抓下来的都在这）
 *   gacha-meta-v2.json    池子 / 角色元数据缓存，丢了要重新联网拉
 *   gacha-meta-ext.json   扩展元数据缓存
 * 账号、Cookie、下载记录、启动器设置一概不传。
 *
 * 云端布局（目录 hxl-gacha）：
 *   hxl-gacha-latest.hxlg        最新一份，**历史份传成功之后**才覆盖
 *   hxl-gacha-20261101-052326.hxlg   每次一份，只留最近 N 份
 * 先传历史份再覆盖 latest，是为了让 latest 永远指向「最近一次成功」，
 * 中途断网也不会把唯一一份好备份冲掉。
 *
 * 加密（可选）：设置了口令就走 AES-256-GCM，
 *   文件头 HXLG0001(8) + salt(16) + iv(12) + tag(16) + 密文
 * 密钥 scrypt(口令, salt, 32)。没设口令就是明文 JSON，用户自己看着办。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  readImportGroups,
  mergeGroups,
  saveImportGroups,
  importsPath,
} = require('./gacha-import');

const REMOTE_DIR = 'hxl-gacha';
const LATEST_NAME = 'hxl-gacha-latest.hxlg';
const DEFAULT_KEEP = 5;

/** 参与备份的文件名，顺序即打包顺序（gacha-imports.json 排第一，好认）。 */
const PAYLOAD_FILES = ['gacha-imports.json', 'gacha-meta-v2.json', 'gacha-meta-ext.json'];

/** 加密文件头。没有这个魔数的一律按明文解析，兼容早期没加密的份。 */
const MAGIC = Buffer.from('HXLG0001', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const REQUEST_TIMEOUT_MS = 20000;
const UPLOAD_TIMEOUT_MS = 90000;
/** 再大就不像抽卡记录了，多半是有人在 userData 里塞了别的东西。 */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

const AUTH_ERROR = '网盘地址或账号密码不对：请确认填的是 WebDAV 地址，账号用「应用密码」而不是登录密码';

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 拼 WebDAV 地址。
 *
 * 用户填的 base 原样保留（坚果云 / 群晖的个人目录里可能带中文，服务端认的是
 * 用户输入的那串），只有我们自己追加的段落才做 encodeURIComponent。
 */
function joinUrl(base, ...segments) {
  const root = String(base || '').trim().replace(/\/+$/, '');
  const tail = segments
    .filter((segment) => segment !== undefined && segment !== null && String(segment) !== '')
    .map((segment) => encodeURIComponent(String(segment)))
    .join('/');
  return tail ? `${root}/${tail}` : `${root}/`;
}

function basicAuth(config) {
  const user = String(config?.username || '');
  const pass = String(config?.password || '');
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

/** 一次 HTTP 请求，带超时与统一的鉴权头；返回 status / buffer / text。 */
async function request(config, method, url, options = {}) {
  const controller = new AbortController();
  const timeout = Number(options.timeout) || REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { ...(options.headers || {}) };
    if (config?.username) headers.Authorization = basicAuth(config);
    const response = await fetch(url, {
      method,
      headers,
      body: options.body,
      signal: controller.signal,
      redirect: 'follow',
    });
    const buffer =
      method === 'DELETE' || method === 'HEAD'
        ? Buffer.alloc(0)
        : Buffer.from(await response.arrayBuffer());
    return { status: response.status, ok: response.ok, buffer, text: buffer.toString('utf8') };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`连接网盘超时（${Math.round(timeout / 1000)} 秒没有响应）`);
    throw new Error(`连不上网盘：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 401/403/404 这类错误，文案要能直接告诉用户改哪儿，别丢 H T T P 码了事。 */
function describeStatus(status, action) {
  if (status === 401 || status === 403) return AUTH_ERROR;
  if (status === 404) return '地址不对：这个 WebDAV 地址下没有可写的目录';
  if (status === 507) return '网盘空间不够了，清一下云端旧文件再试';
  return `${action}失败（HTTP ${status}）`;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/>' +
  '</d:prop></d:propfind>';

/* ------------------------------------------------------------------ */
/* 加密                                                                */
/* ------------------------------------------------------------------ */

/** 有口令就加密，没口令原样返回（用户自己选的不加密）。 */
function seal(plain, password) {
  const text = String(password || '');
  if (!text) return plain;
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = crypto.scryptSync(text, salt, KEY_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

/**
 * 解回来。有魔数才认为加密过；没有就当明文 JSON。
 * 口令错的时候 GCM 会在 final() 抛错，文案换成用户能懂的说法。
 */
function unseal(buffer, password) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('云端这份备份是空的');
  const encrypted = buffer.length > MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC);
  if (!encrypted) {
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new Error('云端这份备份读不出来（不是有效的备份文件）');
    }
  }
  const text = String(password || '');
  if (!text) throw new Error('这份备份设了加密口令，先在上面把口令填上再恢复');
  const salt = buffer.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = buffer.subarray(MAGIC.length + SALT_BYTES, MAGIC.length + SALT_BYTES + IV_BYTES);
  const tagStart = MAGIC.length + SALT_BYTES + IV_BYTES;
  const tag = buffer.subarray(tagStart, tagStart + TAG_BYTES);
  const body = buffer.subarray(tagStart + TAG_BYTES);
  const key = crypto.scryptSync(text, salt, KEY_BYTES);
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('备份口令不对，解不开这份备份');
  }
  try {
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('解出来的内容不是有效数据，备份可能损坏了');
  }
}

/* ------------------------------------------------------------------ */
/* 打包 / 还原                                                         */
/* ------------------------------------------------------------------ */

function requireConfig(config) {
  const url = String(config?.url || '').trim();
  const username = String(config?.username || '').trim();
  if (!url) throw new Error('还没填网盘地址');
  if (!username) throw new Error('还没填网盘账号');
  if (!/^https?:\/\//i.test(url)) throw new Error('网盘地址要以 http:// 或 https:// 开头');
  if (!String(config?.password || '')) throw new Error('还没填应用密码');
}

function countRecords(groups) {
  if (!Array.isArray(groups)) return 0;
  return groups.reduce((sum, group) => sum + (Array.isArray(group?.records) ? group.records.length : 0), 0);
}

/** 把要备份的文件读进来。缺文件不算错，记 null 就行（新用户可能只有本体）。 */
async function buildPayload(userData) {
  const files = {};
  for (const name of PAYLOAD_FILES) {
    try {
      const raw = await fsp.readFile(path.join(userData, name), 'utf8');
      files[name] = JSON.parse(raw);
    } catch {
      files[name] = null;
    }
  }
  return {
    version: 1,
    source: 'hxl-launcher-gacha-backup',
    createdAt: new Date().toISOString(),
    files,
  };
}

function stampName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/* ------------------------------------------------------------------ */
/* WebDAV 基本动作                                                     */
/* ------------------------------------------------------------------ */

/**
 * 确认云端目录在。MKCOL 对已存在的目录会返 405，这正是「已经有了」，当成功。
 * 群晖 / 坚果云有些实现返 301/409，也一并放过（后面 PUT 才是真正的试金石）。
 */
async function ensureRemoteDir(config) {
  const url = joinUrl(config.url, REMOTE_DIR);
  const response = await request(config, 'MKCOL', url);
  if (response.ok || [301, 405, 409].includes(response.status)) return url;
  throw new Error(describeStatus(response.status, '创建云端目录'));
}

/** PUT 一次，失败重试两次（1.2s / 2.4s 退避）。鉴权错不重试，重试也没用。 */
async function putFile(config, url, buffer) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await request(config, 'PUT', url, {
        body: buffer,
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: UPLOAD_TIMEOUT_MS,
      });
      if (response.ok || response.status === 201 || response.status === 204) return;
      if (response.status === 401 || response.status === 403) {
        throw new Error(describeStatus(response.status, '上传'));
      }
      lastError = new Error(describeStatus(response.status, '上传'));
    } catch (error) {
      lastError = error;
      if (error.message === AUTH_ERROR) throw error;
    }
    if (attempt < 3) await sleep(1200 * 2 ** (attempt - 1));
  }
  throw lastError || new Error('上传失败');
}

/** PROPFIND 一份目录，返回条目。命名空间前缀（D: / d: / 无）都认。 */
async function propfind(config, url, depth = '1') {
  const response = await request(config, 'PROPFIND', url, {
    headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
  });
  if (!response.ok && response.status !== 207) {
    throw new Error(describeStatus(response.status, '读取云端目录'));
  }
  const entries = [];
  const blocks = response.text.split(/<[^>]*:?response[\s>]/i).slice(1);
  for (const block of blocks) {
    const href =
      /<[^>]*:href>([^<]+)</i.exec(block)?.[1]?.trim() || /<href>([^<]+)</i.exec(block)?.[1]?.trim();
    if (!href) continue;
    const isCollection = /<[^>]*:?collection\s*\/?>/i.test(block);
    const name = decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
    entries.push({
      name,
      href,
      collection: isCollection,
      size: Number(/<[^>]*:getcontentlength>(\d+)</i.exec(block)?.[1]) || 0,
      modifiedAt: /<[^>]*:getlastmodified>([^<]+)</i.exec(block)?.[1]?.trim() || '',
    });
  }
  return entries;
}

/** 只留最近 keep 份历史备份；latest 永远不动。删不掉不算失败，最多就是多占点地方。 */
async function pruneOld(config, keep, justUploaded) {
  const limit = Math.max(1, Math.min(20, Number(keep) || DEFAULT_KEEP));
  let entries;
  try {
    entries = await propfind(config, `${joinUrl(config.url, REMOTE_DIR)}/`);
  } catch {
    return { removed: 0, kept: 0 };
  }
  const history = entries
    .filter((entry) => !entry.collection && /^hxl-gacha-\d{8}-\d{6}\.hxlg$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const dropped = history.slice(limit);
  let removed = 0;
  for (const name of dropped) {
    if (name === justUploaded) continue;
    try {
      const response = await request(config, 'DELETE', joinUrl(config.url, REMOTE_DIR, name));
      if (response.ok || response.status === 404 || response.status === 204) removed += 1;
    } catch {
      /* 删不掉就算了，下次再删 */
    }
  }
  return { removed, kept: Math.min(history.length, limit) };
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/** 打包 → 加密 → 传历史份 → 覆盖 latest → 清旧份。 */
async function backupNow({ config, userData, keep } = {}) {
  requireConfig(config);
  if (!userData) throw new Error('缺少数据目录');
  const payload = await buildPayload(userData);
  const groups = payload.files['gacha-imports.json']?.groups;
  const records = countRecords(groups);
  if (!records) throw new Error('本地还没有抽卡记录，先导入或同步一份再来备份');

  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  if (plain.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`要备份的数据有 ${formatBytes(plain.length)}，超过 ${formatBytes(MAX_PAYLOAD_BYTES)} 上限`);
  }
  const body = seal(plain, config.secret);
  const dir = await ensureRemoteDir(config);
  const name = `hxl-gacha-${stampName()}.hxlg`;

  await putFile(config, `${dir}/${encodeURIComponent(name)}`, body);
  await putFile(config, `${dir}/${encodeURIComponent(LATEST_NAME)}`, body);
  const pruned = await pruneOld(config, keep, name);

  return {
    ok: true,
    records,
    name,
    bytes: body.length,
    encrypted: Boolean(config.secret),
    kept: pruned.kept,
    removed: pruned.removed,
    savedAt: payload.createdAt,
    text: `已备份 ${records} 条 / ${formatBytes(body.length)}${config.secret ? '（已加密）' : ''}`,
  };
}

/** 列云端已有的备份份，最新在前。 */
async function listBackups({ config } = {}) {
  requireConfig(config);
  const entries = await propfind(config, `${joinUrl(config.url, REMOTE_DIR)}/`);
  const list = entries
    .filter((entry) => !entry.collection && /\.hxlg$/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      latest: entry.name === LATEST_NAME,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
      stamp: (/^hxl-gacha-(\d{8})-(\d{6})\.hxlg$/.exec(entry.name) || []).slice(1).join('-') || '',
    }))
    .sort((a, b) => Number(b.latest) - Number(a.latest) || b.name.localeCompare(a.name));
  return { ok: true, list };
}

/**
 * 从云端拉一份回来。默认只认 latest。
 *
 * **只合并不覆盖**：按记录 Id 去重后并进本地，本地多的记录一条不删。
 * 这样即使云端是台旧机器传的，也不会把新抽的卡冲掉。
 */
async function restoreFrom({ config, userData, name } = {}) {
  requireConfig(config);
  if (!userData) throw new Error('缺少数据目录');
  const fileName = String(name || LATEST_NAME);
  const response = await request(config, 'GET', joinUrl(config.url, REMOTE_DIR, fileName), {
    timeout: UPLOAD_TIMEOUT_MS,
  });
  if (response.status === 404) throw new Error('云端还没有备份，先让自动备份跑一次');
  if (!response.ok) throw new Error(describeStatus(response.status, '下载备份'));

  const document = unseal(response.buffer, config.secret);
  const remoteGroups = document?.files?.['gacha-imports.json']?.groups;
  if (!Array.isArray(remoteGroups) || !remoteGroups.length) {
    throw new Error('云端这份备份里没有抽卡记录');
  }

  const file = importsPath(userData);
  const existing = readImportGroups(file);
  const before = countRecords(existing);
  const merged = mergeGroups(existing, remoteGroups);
  const total = countRecords(merged);
  await saveImportGroups(file, merged);

  return {
    ok: true,
    name: fileName,
    added: Math.max(0, total - before),
    total,
    bytes: response.buffer.length,
    savedAt: String(document?.createdAt || ''),
    text: `已合并 ${total - before} 条，本地现在共 ${total} 条`,
  };
}

/** 只验连通和凭据：PROPFIND depth 0，不读文件也不写文件。 */
async function testConnection({ config } = {}) {
  requireConfig(config);
  const response = await request(config, 'PROPFIND', joinUrl(config.url), {
    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
  });
  if (!response.ok && response.status !== 207) {
    throw new Error(describeStatus(response.status, '连接测试'));
  }
  return { ok: true, text: '地址和账号都对，可以备份了' };
}

module.exports = {
  backupNow,
  listBackups,
  restoreFrom,
  testConnection,
  seal,
  unseal,
  REMOTE_DIR,
  LATEST_NAME,
  DEFAULT_KEEP,
  PAYLOAD_FILES,
};
