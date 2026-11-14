'use strict';

/**
 * 米游社 / HoYoLAB 通行证账号的头像与昵称。
 *
 * 为什么单独弄一个模块：
 *   登录态里只有 cookie（ltoken / ltuid），既没有头像也没有社区昵称。
 *   游戏角色列表（roles）里的 nickname 是「游戏内角色名」，跟社区昵称不是一回事 ——
 *   胡桃那边的账号列表显示的是社区昵称 + 社区头像，这里对齐它。
 *
 * 数据来源：
 *   国服  GET https://bbs-api.miyoushe.com/user/api/getUserFullInfo?uid=<aid>
 *         → data.user_info.{ nickname, avatar_url }
 *   国际服 bbs-api-os.hoyolab.com 同路径，但国内 IP 会被 CDN 以
 *         region_block 403 挡掉，所以拿不到就退回昵称首字。
 *
 * 这个接口不需要 cookie（公开资料），所以不传登录态也能取；
 * 但为了不每次开弹窗都打一次网络，这里落盘缓存一天。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PROFILE_TTL = 24 * 60 * 60 * 1000;

const ENDPOINTS = {
  miyoushe: 'https://bbs-api.miyoushe.com/user/api/getUserFullInfo',
  hoyolab: 'https://bbs-api-os.hoyolab.com/community/user/wapi/getUserFullInfo',
};

function cacheFile(userData) {
  return path.join(userData || '.', 'account-profiles.json');
}

async function readCache(userData) {
  try {
    const raw = JSON.parse(await fsp.readFile(cacheFile(userData), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

async function writeCache(userData, cache) {
  try {
    await fsp.mkdir(path.dirname(cacheFile(userData)), { recursive: true });
    await fsp.writeFile(cacheFile(userData), JSON.stringify(cache), 'utf8');
  } catch {
    /* 缓存写不进去不影响本次显示 */
  }
}

/**
 * 拉一个通行证账号的社区资料。
 * 任何一步失败都返回 { ok:true, nickname:'', avatarUrl:'', reason } —— 调用方
 * 只是拿不到头像，不该因此弹错误提示。
 */
async function fetchProfile(providerId, uid, timeout = 12000) {
  const base = ENDPOINTS[providerId] || ENDPOINTS.miyoushe;
  const url = `${base}?uid=${encodeURIComponent(uid)}`;
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'application/json',
        'x-rpc-client_type': '4',
        'x-rpc-app_version': '2.95.1',
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      return { ok: true, uid, nickname: '', avatarUrl: '', reason: `HTTP ${response.status}` };
    }
    const json = await response.json();
    if (json && json.retcode !== 0) {
      return { ok: true, uid, nickname: '', avatarUrl: '', reason: json.message || `retcode ${json.retcode}` };
    }
    const info = (json && json.data && json.data.user_info) || {};
    return {
      ok: true,
      uid,
      nickname: String(info.nickname || ''),
      avatarUrl: String(info.avatar_url || info.avatar || ''),
      // 社区等级顺手带出来，账号列表里可以显示，没有就是 0
      level: Number(info.level_exp && info.level_exp.level) || 0,
      reason: '',
    };
  } catch (error) {
    return { ok: true, uid, nickname: '', avatarUrl: '', reason: String((error && error.message) || error) };
  }
}

/**
 * 取资料（带缓存）。
 * 返回 { ok, uid, nickname, avatarUrl, level, reason }
 */
async function getProfile(userData, providerId, uid, force = false) {
  const key = `${providerId}:${uid}`;
  const cache = await readCache(userData);
  const hit = cache[key];
  if (!force && hit && Date.now() - Number(hit.at || 0) < PROFILE_TTL) {
    return { ok: true, uid, nickname: hit.nickname || '', avatarUrl: hit.avatarUrl || '', level: hit.level || 0, reason: '' };
  }

  const fresh = await fetchProfile(providerId, uid);
  // 只有真拿到昵称才写缓存 —— 被 region_block 挡掉的那次不该缓存一天
  if (fresh.nickname) {
    cache[key] = { at: Date.now(), nickname: fresh.nickname, avatarUrl: fresh.avatarUrl, level: fresh.level || 0 };
    await writeCache(userData, cache);
  }
  return fresh;
}

module.exports = { getProfile, fetchProfile, PROFILE_TTL };
