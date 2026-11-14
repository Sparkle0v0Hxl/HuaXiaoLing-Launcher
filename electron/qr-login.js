'use strict';
/*
 * 米游社官方 App 扫码登录。
 *
 * 为什么要有这个：
 *   genAuthKey（登录态换抽卡 authkey 的接口）只认真正的 SToken，
 *   而启动器里内嵌的米游社网页登录只能拿到 ltoken —— 那条路永远 -100。
 *   能让用户自己拿到 SToken 的途径只有扫码。
 *
 * 为什么不是游戏 SDK 扫码：
 *   先前试的 hk4e-sdk combo/panda 扫码返回的是「米游社网页会话级」的 BBS token
 *   （raw 里 is_bbs: "true"），拿它去 genAuthKey 换 authkey 永远 -100。
 *   官方 App 登录要走 passport 的 ma-cn-passport/app/createQRLogin，
 *   拿到的才是 App 端可用的真 stoken。
 *
 * 实现参考 gggssepgf/mihoyo-stoken-login（MIT）。
 */

const QRCode = require('./qrcode-lib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PASSPORT_HOST = 'https://passport-api.mihoyo.com';
const PASS_SALT = 'JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS';
const APP_ID = 'bll8iq97cem8';
const APP_VERSION = '2.70.1';
const APP_UA = 'okhttp/4.8.0';
const CREATE_QR = '/account/ma-cn-passport/app/createQRLogin';
const QUERY_QR = '/account/ma-cn-passport/app/queryQRLoginStatus';

/* 扫码二维码有效期官方约 2 分钟，留点余量；这里一过期就自动换一张 */
const EXPIRE_MS = 110 * 1000;
const POLL_MS = 3000;

/**
 * 设备号：必须持久化复用。
 *
 * 每次随机生成会让 passport 返回 -3503「当前设备或网络环境存在风险」，
 * 这是参考实现里专门提醒过的一个坑。存文件，第一次生成后一直用。
 */
function deviceFile(userData) {
  return path.join(userData || require('os').tmpdir(), 'stoken-device-id.txt');
}

function loadDeviceId(userData) {
  const file = deviceFile(userData);
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 16) return saved;
  } catch {
    /* 第一次跑，没有文件 */
  }
  /* 参考实现用的是大写 32 位；这里照做，风格统一 */
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 32; i += 1) id += chars[Math.floor(Math.random() * chars.length)];
  try {
    fs.writeFileSync(file, id);
  } catch {
    /* 写不了就用内存里的，至少这次能用 */
  }
  return id;
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * passport 的 DS2 签名。
 *
 * 和网页端那套 md5(salt&t&r) 不同：passport 要把请求体 b 和查询串 q 一起签进去，
 * 少签这一段服务器直接当签名非法。
 */
function ds2(body, query, salt) {
  const t = String(Math.floor(Date.now() / 1000));
  const r = String(Math.floor(Math.random() * 100000) + 100001);
  const text = 'salt=' + salt + '&t=' + t + '&r=' + r + '&b=' + body + '&q=' + query;
  return t + ',' + r + ',' + md5(text);
}

/** passport 接口的完整请求头。缺一项就是 -3005，所以整段照抄参考实现。 */
function passportHeaders(bodyStr, device, cookie) {
  const headers = {
    'x-rpc-device_id': device,
    'x-rpc-app_id': APP_ID,
    'x-rpc-device_name': 'Xiaomi MI 6',
    'x-rpc-device_fp': '38d7ee0e96649',
    'x-rpc-device_model': 'Mi 6',
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-game_biz': 'bbs_cn',
    'x-rpc-sys_version': '11',
    'x-rpc-aigis': '',
    'Content-Type': 'application/json;',
    'x-rpc-client_type': '2',
    DS: ds2(bodyStr, '', PASS_SALT),
    'x-rpc-sdk_version': '1.3.1.2',
    'User-Agent': APP_UA,
    Connection: 'Keep-Alive',
    'x-rpc-channel': 'appstore',
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function passportPost(pathname, payload, device, cookie, timeout = 20000) {
  const bodyStr = JSON.stringify(payload);
  const res = await fetch(PASSPORT_HOST + pathname, {
    method: 'POST',
    headers: passportHeaders(bodyStr, device, cookie),
    body: bodyStr,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { retcode: -999, message: 'HTTP ' + res.status + ' ' + text.slice(0, 200) };
  }
}

function qrDataUrl(text) {
  const qr = QRCode(0, 'M');
  qr.addData(text);
  qr.make();
  /* 用 SVG：矢量、不吃像素，深色主题下也能扫 */
  const svg = qr.createSvgTag({ cellSize: 6, margin: 8 });
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/**
 * 从 queryQRLoginStatus 的返回值里取 stoken / mid / uid。
 *
 * 返回结构形如：
 *   { retcode: 0, data: { status: "Confirmed",
 *       user_info: { aid, mid, account_id, ... },
 *       tokens: [ { name: "stoken" | "ltoken" | "cookie_token", token: "v2_..." } ] } }
 * stoken 在 tokens 数组里按 name 挑，不能瞎取第一个。
 */
function extractAccount(payload) {
  const data = (payload && payload.data) || {};
  const info = data.user_info || {};
  const uid = String(info.aid || info.uid || info.account_id || '');
  const mid = String(info.mid || '');
  const tokens = data.tokens || [];
  const findToken = (names) => {
    const hit = tokens.find((item) => names.indexOf(item && item.name) >= 0);
    return hit ? String(hit.token || '') : '';
  };
  const stoken = findToken(['stoken', 'stoken_v2']) || (tokens[0] && String(tokens[0].token || '')) || '';
  const ltoken = findToken(['ltoken', 'ltoken_v2']);
  const cookieToken = findToken(['cookie_token', 'cookie_token_v2']);
  return { uid, mid, stoken, ltoken, cookieToken, status: String(data.status || '') };
}

/**
 * 一次扫码会话。
 *
 * 与旧版本的区别：不再需要先选游戏（官方 App 登录是账号级的，一次能拿到所有游戏），
 * 所以 game 参数只是用来在界面上显示「正在为哪个游戏登录」，不影响请求。
 */
class ScanSession {
  constructor({ game, userData, onState, onToken, onDebug }) {
    this.game = game || 'genshin';
    this.userData = userData || '';
    this.onState = onState;
    this.onToken = onToken;
    this.onDebug = onDebug;
    this.device = loadDeviceId(userData);
    this.ticket = '';
    this.qr = '';
    this.timer = null;
    this.expiredAt = 0;
    this.stopped = false;
    this.lastStat = '';
  }

  emit(status, message, extra = {}) {
    if (typeof this.onState !== 'function') return;
    this.onState(
      Object.assign(
        {
          status,
          game: this.game,
          qr: this.qr,
          ticket: this.ticket,
          message: message || '',
        },
        extra
      )
    );
  }

  debug(info) {
    if (typeof this.onDebug === 'function') {
      try {
        this.onDebug(info);
      } catch {
        /* 日志失败不能影响主流程 */
      }
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async start() {
    this.stopped = false;
    await this.refreshQr();
    if (this.stopped) return;
    this.timer = setInterval(() => {
      this.poll().catch((error) => {
        /* 不能吞异常：吞掉就是「界面毫无反应」，没法排查 */
        this.debug({ at: 'poll-error', error: String((error && error.message) || error) });
      });
    }, POLL_MS);
  }

  async refreshQr() {
    try {
      const res = await passportPost(CREATE_QR, {}, this.device, '');
      if (!res || res.retcode !== 0 || !res.data) {
        this.emit('failed', '申请二维码失败：' + ((res && res.message) || '未知错误'));
        return;
      }
      const url = String(res.data.url || '');
      this.ticket = String(res.data.ticket || '');
      this.qr = qrDataUrl(url);
      this.expiredAt = Date.now() + EXPIRE_MS;
      this.lastStat = '';
      this.debug({ at: 'qr', ticket: this.ticket.slice(0, 8), urlLen: url.length });
      this.emit('waiting', '用米游社 App 扫一下，扫完在手机上点确认');
    } catch (error) {
      this.emit('failed', '申请二维码失败：' + String((error && error.message) || error));
    }
  }

  async poll() {
    if (this.stopped || !this.ticket) return;

    if (Date.now() > this.expiredAt) {
      /* 过期就换一张，而不是让用户对着失效的码发呆 */
      await this.refreshQr();
      return;
    }

    const res = await passportPost(QUERY_QR, { ticket: this.ticket }, this.device, '');
    if (!res) return;

    if (res.retcode !== 0) {
      this.debug({ at: 'poll', retcode: res.retcode, message: res.message });
      /*
       * -106 之类是二维码失效，换一张；其它错误（网络抖动等）先记下来继续轮询，
       * 别因为一次 502 就让用户重扫。
       */
      if (res.retcode === -106 || res.retcode === -3501) {
        await this.refreshQr();
      }
      return;
    }

    const account = extractAccount(res);
    if (this.lastStat !== account.status) {
      this.lastStat = account.status;
      this.debug({ at: 'stat', status: account.status, hasTokens: (res.data && (res.data.tokens || []).length) || 0 });
    }

    /* 扫了但没确认 */
    if (account.status && account.status !== 'Confirmed' && !account.stoken) {
      const label = account.status === 'Scanned' ? '已扫到，正在等你在手机上点确认' : '服务端状态：' + account.status;
      this.emit('scanned', label);
      return;
    }

    if (!account.stoken || !account.mid || !account.uid) {
      /* Confirmed 了但字段不齐，把情况报上去，别静默 */
      if (account.status === 'Confirmed') {
        this.emit('failed', '登录确认了，但返回里没有 stoken（uid=' + (account.uid || '空') + ', mid=' + (account.mid || '空') + '）');
      }
      return;
    }

    this.stop();
    this.debug({ at: 'token', uid: account.uid, mid: account.mid, stokenLen: account.stoken.length });
    this.emit('success', '登录成功，正在保存…', { uid: account.uid, mid: account.mid });
    if (typeof this.onToken === 'function') {
      try {
        await this.onToken(account);
      } catch (error) {
        this.emit('failed', '保存失败：' + String((error && error.message) || error));
      }
    }
  }
}

module.exports = {
  ScanSession,
  qrDataUrl,
  loadDeviceId,
  extractAccount,
  ds2,
  passportHeaders,
  PASSPORT_HOST,
  CREATE_QR,
  QUERY_QR,
};
