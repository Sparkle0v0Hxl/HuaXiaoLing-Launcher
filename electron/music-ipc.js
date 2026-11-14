'use strict';

const { ipcMain, BrowserWindow, session, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

/* 网易云客户端（客户端本体、播放地址回退链） */
const {
  normalizeNeteaseBase,
  neteaseGet,
  startNeteaseService,
  currentMusicSourceFlags,
  fetchNeteaseSongUrl,
  getNeteaseSession,
  setNeteaseSession,
} = require('./netease-client');

/* 音乐平台接口 */
const {
  musicCharts,
  chartSongs,
  mergedCharts,
  mergedChartSongs,
  searchSongs,
} = require('./music-platforms');

/* 歌单 */
const {
  accountPlaylists,
  accountPlaylistSongs,
  webMyPlaylists,
  webLikedSongs,
  withLikedPlaylist,
  LIKED_ID,
  publicPlaza,
  publicPlaylistSongs,
  parseSharedPlaylistLink,
} = require('./music-playlists');

/* 播放地址解析与自定义音源 */
const { resolvePlayableUrl } = require('./music-resolve');
const {
  resolveSourceUrl,
  validateCustomSource,
  disabledSourceOfUrl,
} = require('./music-source');

/* 登录辅助 */
const {
  PLATFORM_CONFIG: MUSIC_LOGIN_CONFIG,
  platformConfig: musicPlatformConfig,
  pickCookies: pickMusicCookies,
  hasAll: musicCookiesReady,
  checkLogin: checkMusicLogin,
  loadMusicSession,
  cookieHeader,
  verifyMusicSession,
  LOGIN_CLICK_SCRIPT: MUSIC_LOGIN_CLICK_SCRIPT,
} = require('./music-login');

/**
 * 音乐（QQ 音乐 / 酷狗 / 网易云）登录、歌单、搜索、播放地址。
 *
 * 从 main.js 的 installIpc() 里整段搬出来。搬运时逻辑未改，只有两处适配：
 *   1. 网易云会话状态改用 netease-client 的 getter/setter（它已被抽成独立模块）
 *   2. activeMusicLogin / musicLoginDebug 这两个跨 IPC 共享的可变状态
 *      从 main.js 的模块级 let 变成这里的模块级 let
 */

let activeMusicLogin = null;
let musicLoginDebug = null;

function installMusicIpc(ctx) {
  const {
    store,
    pushState,
    playlistCache,
    slimCachedPlaylists,
    PLAYLIST_CACHE_PLATFORMS,
    BROWSER_UA,
    MUSIC_LOGIN_PRELOAD,
    // 重构拆分时漏掉的依赖
    getMainWindow,          // 登录窗口的父窗口（main.js 的 let win）
    clearMusicResolveCache,
    fetchSourceLyric,
    musicLooksExpired,
  } = ctx;

  /*
   * win 是 main.js 的模块级 let，窗口销毁重建时会换掉。
   * 这里不能存快照（`const win = getMainWindow()`）—— 登录窗口如果开在窗口重建之后，
   * 拿到的就是已经销毁的旧句柄，`parent: win` 会让 Electron 直接抛错。
   * 所以每次现取。
   */
  const parentWindow = () => {
    if (typeof getMainWindow !== 'function') return null;
    const w = getMainWindow();
    return w && !w.isDestroyed() ? w : null;
  };

    /**
     * 打开内置浏览器窗口让用户真实登录 QQ 音乐 / 酷狗。
     *
     * 登录方式（扫码 / QQ / 微信 / 手机验证码）完全由官网页面自己提供，
     * 我们只负责在登录成功后把 cookie 里的凭证取出来并加密保存。
     */
    ipcMain.handle('music:login', async (_event, platform) => {
      const key = String(platform || '');
      const config = musicPlatformConfig(key);

      /*
       * 先把这个平台自己的登录态清干净再开窗口。
       *
       * 用户点「登录」的意思就是要扫码，可登录窗口跑在 persist 分区里，
       * 上一轮的 cookie 还留着时窗口一加载就自动登进去了，用户根本没机会扫码。
       * 而且这种情况下轮询会立刻判定「已登录」并把旧的整袋 cookie 再存一遍，
       * 等于「退出登录」没任何效果。所以这里进入登录流程前先清分区。
       */
      try {
        const stale = session.fromPartition(`persist:music-${key}-login`);
        await stale.clearStorageData({
          storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql'],
        });
        await stale.clearAuthCache();
      } catch (error) {
        console.error('[music-login] 清理旧登录态失败（继续登录）:', error);
      }

      return new Promise((resolve, reject) => {
        // 用明确的 session.fromPartition 拿分区，登录窗口和后续轮询共用同一个会话，
        // 也避免 webPreferences.partition 在某些版本下没真正落盘、cookie 取不全的问题。
        const ses = session.fromPartition(`persist:music-${key}-login`);
        const loginWindow = new BrowserWindow({
          width: 520,
          height: 720,
          parent: parentWindow() || undefined,
          modal: false,
          show: true,
          title: `${config.label} 登录`,
          webPreferences: {
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: MUSIC_LOGIN_PRELOAD,
          },
        });

        // 官网会按 UA 判断「浏览器是否受支持」。Electron 默认 UA 里带着
        // Electron/xx 和启动器名字，QQ 音乐 / 酷狗会直接拒绝渲染登录二维码，
        // 表现就是「点登录没反应、认不出浏览器」。统一伪装成桌面 Chrome。
        try {
          loginWindow.webContents.setUserAgent(BROWSER_UA);
          loginWindow.webContents.session.setUserAgent(BROWSER_UA);
        } catch {
          /* ignore */
        }

        // QQ / 微信登录会另开一个弹窗（ptlogin2.qq.com 等）。
        // Electron 默认拦掉 window.open，弹窗根本不出现；这里显式放行，
        // 子窗口和父窗口共用同一个 session，cookie 仍然能被轮询抓到。
        loginWindow.webContents.setWindowOpenHandler(() => ({
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          },
        }));

        let settled = false;
        let pollTimer = null;
        // 是否已经用登录接口验过这一袋 cookie（见 check() 里的说明）
        let verified = false;
        let lastVerifyAt = 0;

        const cleanup = () => {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          try {
            loginWindow.close();
          } catch {
            /* ignore */
          }
        };

        const finish = async (bag) => {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            // 存【全量】cookie：歌单 / 取歌地址接口要的不止 uin + qqmusic_key，
            // 少了 qm_keyst / skey / p_skey 这些，服务端就直接当成未登录。
            const payload = {
              ...bag,
              __cookieHeader: cookieHeader(bag),
              savedAt: new Date().toISOString(),
            };
            // 存盘失败不能静默吞掉：否则界面显示「已登录」，重启后却全没了。
            // saveSecret 在没有系统加密可用时会返回 false，这种情况要明确报出来。
            const saved = await saveSecret(`music-${key}`, JSON.stringify(payload)).catch((error) => {
              console.error('[music-login] 保存登录状态失败:', error);
              return false;
            });
            if (!saved) {
              console.error('[music-login] saveSecret 返回 false，系统加密不可用或写入失败');
            }
            resolve({ ok: true, platform: key, cookies: payload, saved: Boolean(saved) });
          } catch (error) {
            reject(error);
          }
        };

        // 轮询 cookie：官网登录成功后 cookie 会出现在窗口里。
        // 不同平台（尤其酷狗）的 cookie 名不统一，这里把所有 cookie 都摊平成 bag，
        // 交给 checkLogin 按候选组挑，命中即认为登录完成。
        // 命中后存盘的是【整袋】cookie，不是挑出来的那几个键。
        const check = async () => {
          if (settled) return;
          try {
            const cookies = await ses.cookies.get({});
            const bag = {};
            for (const cookie of cookies || []) {
              if (!cookie?.name) continue;
              // 只认 kugou / qq 域的 cookie，避免把无关域的值混进来
              const domain = String(cookie.domain || '');
              if (config.host && !config.host.some((h) => domain.includes(h))) continue;
              bag[cookie.name] = cookie.value;
            }
            musicLoginDebug = { at: Date.now(), platform: key, cookieCount: cookies.length, matched: Object.keys(bag) };
            const checked = checkMusicLogin(config, bag);
            if (checked.ok) {
              /*
               * 只凭 cookie 名齐了就存盘是不行的：QQ 音乐扫码过程中
               * p_uin / p_tk 这类 QQ 互联的 cookie 会先落地，y.qq.com 自己的
               * 会话还没写完，这时候存下来的是一袋半截凭证 —— 之后取歌单
               * 一律 500003（服务端当未登录）。所以这里再用最轻的登录接口验一次，
               * 验过才存；验不过就接着轮询。验证限流 3 秒一次，别把接口打爆。
               */
              const now = Date.now();
              if (!verified && now - lastVerifyAt > 3000) {
                lastVerifyAt = now;
                const result = await verifyMusicSession(key, bag).catch(() => ({ ok: false }));
                verified = Boolean(result && result.ok);
                musicLoginDebug.verify = { ok: verified, error: (result && result.error) || '' };
              }
              if (verified) await finish(bag);
            }
          } catch {
            /* 窗口还在加载时忽略 */
          }
        };

        // 给界面一个「我已经扫码登录了」的兜底：只要窗口里出现过账号类 cookie，
        // 就把整袋 cookie 存下来，不再苛求 qqmusic_key / qm_keyst 这种凭证名。
        activeMusicLogin = {
          platform: key,
          confirm: async () => {
            if (settled) return { ok: false, error: '登录窗口已经关闭，请重新打开' };
            try {
              const cookies = await ses.cookies.get({});
              const bag = {};
              for (const cookie of cookies || []) {
                if (!cookie?.name) continue;
                const domain = String(cookie.domain || '');
                if (config.host && !config.host.some((h) => domain.includes(h))) continue;
                bag[cookie.name] = cookie.value;
              }
              if (!Object.keys(bag).length) {
                return { ok: false, error: '还没有读到任何登录 cookie，请先在窗口里完成扫码' };
              }
              /*
               * 「我已登录」是用户的断言，所以这里不拦着他存盘：
               * 只是顺手验一次，验不过就把话说明白，让他知道还要再等一下。
               */
              const probe = await verifyMusicSession(key, bag).catch(() => ({ ok: false, error: '验证没跑通' }));
              await finish(bag);
              return {
                ok: true,
                platform: key,
                cookies: bag,
                verified: Boolean(probe && probe.ok),
                warning: probe && probe.ok ? '' : `已经存下来了，但还查不到账号信息（${(probe && probe.error) || '验证失败'}），歌单可能还读不出来`,
              };
            } catch (error) {
              return { ok: false, error: error.message || '保存登录状态失败' };
            }
          },
        };

        const startPolling = () => {
          if (pollTimer) return;
          pollTimer = setInterval(check, 1200);
          setTimeout(check, 600);
        };

        loginWindow.webContents.on('dom-ready', startPolling);
        loginWindow.webContents.on('did-finish-load', async () => {
          startPolling();

          /*
           * 官网首页要自己找到「登录」才出二维码。
           * QQ 音乐的点开后是 yqq-dialog，里面嵌 graph.qq.com 的 OAuth；
           * 酷狗也是首页点登录才出扫码框。
           * 这里注入脚本帮用户点开，省得他在页面里找。
           */
          try {
            await loginWindow.webContents.executeJavaScript(MUSIC_LOGIN_CLICK_SCRIPT, true);
          } catch {
            /* 页面还没准备好就跳过，用户自己点也行 */
          }

          // 在官网页面上叠一条自己的提示条：告诉用户扫完码可以点「我已登录」强制保存，
          // 避免凭证 cookie 名不匹配导致窗口一直不关。
          try {
            await loginWindow.webContents.insertCSS(`
              #hxl-music-login-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
                display:flex;align-items:center;gap:10px;padding:8px 12px;
                background:rgba(16,10,12,.94);border-top:1px solid rgba(240,198,116,.35);
                font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#e9dcc8;}
              #hxl-music-login-bar span{flex:1}
              #hxl-music-login-bar b{color:#f0c674}
              #hxl-music-login-bar button{flex:none;height:26px;padding:0 12px;border-radius:6px;
                border:1px solid rgba(240,198,116,.5);background:rgba(240,198,116,.14);
                color:#f0c674;font:inherit;cursor:pointer;}
              #hxl-music-login-bar button:hover{background:rgba(240,198,116,.26)}
              body{padding-bottom:52px !important}
            `);
            await loginWindow.webContents.executeJavaScript(`
              (() => {
                if (document.getElementById('hxl-music-login-bar')) return true;
                const bar = document.createElement('div');
                bar.id = 'hxl-music-login-bar';
                bar.innerHTML = '<span>扫码 / 登录完成后如果窗口没有自动关闭，点右边 <b>我已登录</b> 保存。</span>';
                const btn = document.createElement('button');
                btn.textContent = '我已登录';
                btn.onclick = async () => {
                  btn.textContent = '正在保存…';
                  btn.disabled = true;
                  try {
                    const r = await window.hxlMusicLoginConfirm();
                    btn.textContent = r && r.ok ? '已保存，窗口即将关闭' : (r?.error || '没有读到登录状态');
                    if (!r || !r.ok) { btn.disabled = false; btn.textContent = '我已登录'; }
                  } catch (e) {
                    btn.disabled = false;
                    btn.textContent = '我已登录';
                  }
                };
                bar.appendChild(btn);
                document.body.appendChild(bar);
                return true;
              })();
            `).catch(() => {});
          } catch {
            /* 官网页面结构特殊时忽略 */
          }
        });

        // 用户在窗口里导航到同域其他页面也要继续轮询
        loginWindow.webContents.on('did-navigate', () => {
          if (pollTimer) return;
          pollTimer = setInterval(check, 1200);
          setTimeout(check, 600);
        });

        loginWindow.on('closed', () => {
          if (activeMusicLogin && activeMusicLogin.platform === key) activeMusicLogin = null;
          if (settled) return;
          settled = true;
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          resolve({ ok: false, cancelled: true });
        });

        loginWindow.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
          if (!isMainFrame || settled) return;
          if (code === -3) return; // 用户自己中断的导航
          settled = true;
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          try {
            loginWindow.close();
          } catch {
            /* ignore */
          }
          resolve({ ok: false, error: `登录页打不开（${desc || code}）` });
        });

        loginWindow.loadURL(config.loginUrl);
      });
    });

    /**
     * 「我已经登录了」兜底：不管 cookie 名字对不对，把窗口里现有的整袋 cookie 存下来。
     * 用于扫码成功但凭证 cookie 名不在候选列表里的情况。
     */
    ipcMain.handle('music:login-confirm', async () => {
      if (!activeMusicLogin) return { ok: false, error: '当前没有打开的登录窗口' };
      return activeMusicLogin.confirm();
    });

    /** 登录窗口的诊断信息：读到手几个 cookie、命中了哪些名字。 */
    ipcMain.handle('music:login-debug', async () => musicLoginDebug);

    /** 当前已保存哪些平台的登录。 */
    /**
     * 把登录窗口分区里现存的 cookie 合并进已保存的凭据。
     *
     * 为什么要这一步：登录成功时我们是把「当时的整袋 cookie」存下来的，
     * 但酷狗 / QQ 音乐会在登录后再陆续补写几条关键 cookie（比如酷狗的
     * userid、QQ 的 refreshing 票据）。只吃存盘那一份，就会出现
     * 「明明登录了，服务端却说没登录」的情况。
     */
    async function mergePartitionCookies(key, creds) {
      const bag = { ...creds };
      try {
        const part = session.fromPartition(`persist:music-${key}-login`);
        const cookies = await part.cookies.get({});
        for (const cookie of cookies || []) {
          if (cookie && cookie.name) bag[cookie.name] = cookie.value;
        }
      } catch {
        /* 分区可能没建过，用已保存的即可 */
      }
      // QQ 号在不同版本落在不同 cookie 名上，这里统一补一次
      if (!bag.uin) bag.uin = bag.p_uin || bag.ptui_loginuin || bag.luin || bag.wxuin || '';
      const pairs = [];
      for (const [name, value] of Object.entries(bag)) {
        if (name === '__cookieHeader' || name === 'savedAt') continue;
        if (!/^[A-Za-z0-9_.$-]+$/.test(name)) continue;
        if (value == null) continue;
        pairs.push(`${name}=${String(value).replace(/;/g, '')}`);
      }
      bag.__cookieHeader = pairs.join('; ');
      return bag;
    }

    /** 给任意 Promise 套硬上限，任何一步卡住都不能让界面一直转圈。 */
    function playlistDeadline(promise, ms, label) {
      let timer = null;
      const guard = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label || '读取'}超时（${Math.round(ms / 1000)} 秒没有响应）`));
        }, ms);
      });
      return Promise.race([promise, guard]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }

    /** 打开一个带登录态的内置窗口（分区就是登录时用的那个）。 */
  function musicLoginWindow(target) {
    // 抓歌单用的窗口必须隐藏：弹出来的窗口会被用户随手关掉，
    // 一关整个应用就退出（window-all-closed），而且隐藏窗口配合
    // backgroundThrottling:false 一样能发请求、能跑 executeJavaScript。
    const win = new BrowserWindow({
      width: 1100,
      height: 780,
      show: false,
      webPreferences: {
        session: session.fromPartition(`persist:music-${target}-login`),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    // 伪装成桌面 Chrome：Electron 默认 UA 带 "Electron/xx"，
    // QQ 音乐/酷狗会拒绝渲染或返回精简页。
    try {
      win.webContents.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      );
    } catch {
      /* ignore */
    }
    return win;
  }

  /** 收集一个 QQ 音乐 / 酷狗账号的歌单：先走网页，失败回退 OpenAPI。 */
    async function collectPlatformPlaylists(key) {
      /*
       * 注意：这里的变量名不能叫 session。
       * 早前写成 `const session = await loadMusicSession(...)`，把 electron 的
       * session 模块整个遮住了，下面 `session.fromPartition` 直接抛
       * 「fromPartition is not a function」——网页这条路从来没跑通过一次，
       * 于是每次都默默回退到 OpenAPI，QQ 音乐 / 酷狗 的歌单也就一直是空的。
       */
      const saved = await loadMusicSession(key, loadSecret);
      if (!saved) throw new Error('还没有登录');
      const creds = await mergePartitionCookies(key, saved);
      // 酷狗：m.kugou.com 的「我的歌单」要浏览器自己种的 cookie（Node 侧裸拼多半 Access Deny），
      // 所以先走隐藏窗口。但曲目的 mobilecdn 接口是免登录的、Node 直连可用
      // （只认 http，https 握手失败），所以「点开某个歌单」这条路径不必开窗口。
      // QQ 音乐：先试接口（cookie 手动拼 header），失败再退到隐藏窗口抓包。
      const tryApi = async () => {
        const list = await playlistDeadline(accountPlaylists(key, creds), 18000, '接口读取歌单');
        if (Array.isArray(list) && list.length) return { list: withLikedPlaylist(key, list), source: 'api' };
        throw new Error('接口返回空列表');
      };
      const tryWeb = async () => {
        const list = await playlistDeadline(
          webMyPlaylists(key, creds, {
            getWindow: async (target) => {
              return { win: musicLoginWindow(target), ownWindow: true };
            },
          }),
          key === 'qq' ? 60000 : 35000,
          '网页读取歌单'
        );
        if (Array.isArray(list) && list.length) return { list: withLikedPlaylist(key, list), source: 'web' };
        throw new Error('网页返回空列表');
      };

      if (key === 'kuwo') {
        // 酷我：网页端用户歌单接口已全部删除，只走老接口 nplserver（api 路径）
        try { return await tryApi(); }
        catch (apiError) {
          throw new Error(`酷我：读取我的歌单失败（${apiError.message}）`);
        }
      }
      if (key === 'kugou') {
        // 酷狗：网页优先（隐藏窗口），接口兜底
        try { return await tryWeb(); }
        catch (webError) {
          try { return await tryApi(); }
          catch (apiError) {
            throw new Error(`酷狗：网页读取失败（${webError.message}）；接口也失败（${apiError.message}）`);
          }
        }
      }
      // QQ 音乐：接口优先，网页兜底
      try { return await tryApi(); }
      catch (apiError) {
        try { return await tryWeb(); }
        catch (webError) {
          throw new Error(`QQ 音乐：接口失败（${apiError.message}）；网页也失败（${webError.message}）`);
        }
      }
    }

    /** 三个平台的登录状态，含网易云（它的会话不在 MUSIC_LOGIN_CONFIG 里）。 */
    async function musicStatus() {
      const out = {
        netease: {
          label: '网易云',
          loggedIn: Boolean(getNeteaseSession().cookie),
          savedAt: null,
          uin: '',
          userid: '',
        },
      };
      for (const key of Object.keys(MUSIC_LOGIN_CONFIG)) {
        const session = await loadMusicSession(key, loadSecret);
        out[key] = {
          label: MUSIC_LOGIN_CONFIG[key].label,
          loggedIn: Boolean(session),
          savedAt: session?.savedAt || null,
          uin: session?.uin || '',
          userid: session?.userid || '',
        };
      }
      return out;
    }

    ipcMain.handle('music:status', async () => musicStatus());

    /*
     * 我的歌单缓存：读 / 写 / 丢。
     *
     * 写是合并的 —— 前端只把这次真正同步到的那几个平台传上来，
     * 没传的平台保留旧缓存，否则点一次酷狗同步会把网易云那份缓存抹掉。
     */
    ipcMain.handle('music:playlists-cache', async () => {
      const cache = playlistCache();
      return {
        ok: true,
        savedAt: Number(cache.data.savedAt) || 0,
        accounts: cache.data.accounts || {},
        groups: cache.data.groups || {},
      };
    });

    ipcMain.handle('music:playlists-cache-save', async (_event, input) => {
      const cache = playlistCache();
      const groups = Array.isArray(input?.groups) ? input.groups : [];
      const accounts = input?.accounts && typeof input.accounts === 'object' ? input.accounts : null;
      if (accounts) {
        for (const key of PLAYLIST_CACHE_PLATFORMS) {
          if (Object.prototype.hasOwnProperty.call(accounts, key)) {
            cache.data.accounts[key] = String(accounts[key] || '');
          }
        }
      }
      for (const group of groups) {
        const key = String(group?.platform || '');
        if (!PLAYLIST_CACHE_PLATFORMS.includes(key)) continue;
        const slim = slimCachedPlaylists(group);
        // 空列表不写：同步失败时 list 是空的，写进去等于把上次好好的缓存冲掉
        if (!slim.list.length) continue;
        cache.data.groups[key] = slim;
      }
      cache.data.version = 1;
      cache.data.savedAt = Date.now();
      // JsonStore.save() 自带 400ms 防抖 + 串行写 + 原子 rename，不用自己再拼一遍
      cache.save();
      return { ok: true, savedAt: cache.data.savedAt };
    });

    /*
     * 从「我的歌单」缓存里剔掉一张具体的歌单（链接导入的那种）。
     *
     * 为什么不复用 music:playlists-cache-save：那个是**合并写 + 空列表跳过**，
     * 删掉某平台最后一张歌单时前端传上来的 list 是空的，主进程会直接 continue，
     * 磁盘上的旧缓存原封不动 —— 重启后歌单原样复活，「删了没用」。
     * 所以删除必须按 id 精确落到缓存上：剔完为空就把这个平台整组丢掉。
     */
    ipcMain.handle('music:playlist-remove', async (_event, input) => {
      const key = String(input?.platform || '').trim().toLowerCase();
      const id = String(input?.id || '').trim();
      if (!PLAYLIST_CACHE_PLATFORMS.includes(key) || !id) {
        return { ok: false, removed: 0, reason: '参数不完整' };
      }
      const cache = playlistCache();
      const groups = cache.data.groups && typeof cache.data.groups === 'object' ? cache.data.groups : null;
      const group = groups?.[key];
      if (!Array.isArray(group?.list)) return { ok: true, removed: 0 };
      const before = group.list.length;
      const list = group.list.filter((item) => String(item?.id || '') !== id);
      const removed = before - list.length;
      if (!removed) return { ok: true, removed: 0 };
      if (list.length) cache.data.groups[key] = { ...group, list };
      else delete cache.data.groups[key];
      // JsonStore.save() 自带防抖 + 串行写 + 原子 rename
      cache.save();
      return { ok: true, removed };
    });

    ipcMain.handle('music:playlists-cache-drop', async (_event, input) => {
      const cache = playlistCache();
      const keys = Array.isArray(input?.platforms)
        ? input.platforms
            .map((item) => String(item || '').trim().toLowerCase())
            .filter((item) => PLAYLIST_CACHE_PLATFORMS.includes(item))
        : [];
      if (!keys.length) {
        cache.data.groups = {};
        cache.data.accounts = {};
      } else {
        for (const key of keys) {
          delete cache.data.groups[key];
          delete cache.data.accounts[key];
        }
      }
      cache.save();
      return { ok: true };
    });


    /**
     * 退出登录：本地凭证和登录窗口里的网页会话都要清掉。
     *
     * 只删 sessions.enc.json 是不够的：登录窗口跑在 persist:music-qq-login 分区里，
     * 那里的 cookie 还留着登录态，下次再点「登录」窗口一加载就自动登进去了，
     * 用户根本没机会扫码。所以这里把分区里的 cookies / storage 一起清掉，
     * 用户再点登录才会看到二维码。
     */
    ipcMain.handle('music:logout', async (_event, platform) => {
      const key = String(platform || '');
      musicPlatformConfig(key);
      await saveSecret(`music-${key}`, '').catch((error) => {
        console.error('[music-logout] 清除本地凭证失败:', error);
      });
      try {
        const partition = session.fromPartition(`persist:music-${key}-login`);
        await partition.clearStorageData({
          storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql'],
        });
        await partition.clearAuthCache();
      } catch (error) {
        // 分区可能压根没建过（从没登录过），这种失败不影响退出
        console.error('[music-logout] 清理登录分区失败:', error);
      }
      return { ok: true };
    });

    /** 验证保存的会话是否还有效。 */
    ipcMain.handle('music:verify', async (_event, platform) => {
      const key = String(platform || '');
      musicPlatformConfig(key);
      const session = await loadMusicSession(key, loadSecret);
      if (!session) return { ok: false, error: '还没有登录' };
      return verifyMusicSession(key, session);
    });

    /**
     * 登录账号的歌单列表。
     * 没登录或接口拿不到时返回 { ok:false, reason }，由界面提示，
     * 不要抛异常让用户看到一屏报错。
     */
    /**
     * 把 QQ / 酷狗 的曲目解析成可播放地址。
     * 走网易云找同名曲 + 内置 unblock 兜底，所以不需要会员也能听。
     */
    /*
     * 把曲目解析成可以直接播放的地址。
     *
     * 顺序（见 electron/music-source.js）：
     * 点歌台的换源现在走「多源并发竞速」：所有启用的音源同时开跑，谁先出
     * 地址用谁，结果缓存 20 分钟（详见 music-source.js）。
     * 默认只启用第三方免费音源：本地 NeteaseCloudMusicApi（含 /song/url/match
     * 换源解锁，VIP 曲目也能出地址）+ 咪咕；酷狗 / QQ 的匿名接口对付费曲目一律
     * 要会员，酷我常把人往手机端引，三家默认不参与，用户可在设置里打开。
     * 全部失败时再退回老的「网易云找同名曲 + unblock」那条路。
     */
    ipcMain.handle('music:sources-import', async (_event, input) => {
      let raw = '';
      if (input?.text) {
        raw = String(input.text).slice(0, 200000);
      } else if (input?.url) {
        const target = String(input.url).trim();
        if (!/^https?:\/\//i.test(target)) return { ok: false, reason: '订阅地址必须是 http(s) 链接' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(target, { signal: controller.signal });
          raw = await response.text();
        } catch (error) {
          return { ok: false, reason: `下载失败：${error.message}` };
        } finally {
          clearTimeout(timer);
        }
      } else {
        return { ok: false, reason: '没有拿到音源内容' };
      }

      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, reason: '不是合法的 JSON' };
      }
      const incoming = Array.isArray(parsed) ? parsed : [parsed];
      const accepted = [];
      const rejected = [];
      for (const def of incoming) {
        const check = validateCustomSource(def);
        if (!check.ok) {
          rejected.push(`${def?.name || def?.id || '未命名'}：${check.reason}`);
          continue;
        }
        accepted.push({
          id: String(def.id || def.name || '').slice(0, 60),
          name: String(def.name || def.id || '').slice(0, 60),
          search: def.search,
          url: def.url,
          headers: def.headers && typeof def.headers === 'object' ? def.headers : undefined,
          enabled: true,
        });
      }
      if (!accepted.length) return { ok: false, reason: rejected.join('；') || '里面没有可用的音源' };

      const current = Array.isArray(store.data.settings.musicCustomSources)
        ? store.data.settings.musicCustomSources
        : [];
      // 同 id 覆盖，最多存 20 个，免得被塞一堆死链把竞速拖垮
      const merged = current
        .filter((def) => !accepted.some((item) => item.id === def.id))
        .concat(accepted)
        .slice(0, 20);
      store.data.settings.musicCustomSources = merged;
      await store.saveNow().catch(() => {});
      // 音源变了，旧的换源结果可能不再合适
      clearMusicResolveCache();
      // 这个 IPC 不走 settings:update，得自己把新状态推给界面，否则卡片看不到刚导入的音源
      pushState(true);
      return { ok: true, sources: merged, added: accepted.length, rejected };
    });

    ipcMain.handle('music:resolve', async (_event, input) => {
      const song = input?.song || {};
      const level = String(input?.level || 'exhigh');
      const apiBase = normalizeNeteaseBase(input?.apiBase || '');
      const settings = store?.data?.settings || {};
      const attempts = [];
      try {
        const direct = await resolveSourceUrl(song, {
          apiBase,
          level,
          sources: settings.musicSources,
          customSources: settings.musicCustomSources,
        });
        if (direct?.url) return { ok: true, ...direct };
      } catch (error) {
        attempts.push(String(error.message || '解析失败'));
      }
      /*
       * 回退路径走的是本地网易云 API（unblock 会在服务端偷偷换成酷我等平台的
       * 直链），这里同样要认音源开关：网易云被停用就整条跳过；拿回来的地址
       * 宿主撞上被停用的音源（比如酷我）就丢弃，不能因为「能放」就绕过开关。
       */
      try {
        const flags = currentMusicSourceFlags();
        const resolved = flags.netease === false ? null : await resolvePlayableUrl(apiBase, song, level);
        if (resolved?.url) {
          const banned = disabledSourceOfUrl(resolved.url, flags);
          if (banned) {
            attempts.push(`回退地址来自已停用的音源（${banned}），已丢弃`);
          } else {
            return { ok: true, ...resolved };
          }
        }
        if (!resolved) {
          return {
            ok: false,
            reason: attempts.join('；') || '没有找到可播放的版本',
          };
        }
      } catch (error) {
        attempts.push(String(error.message || '解析失败'));
      }
      return { ok: false, reason: attempts.join('；') || '解析失败' };
    });

    /*
     * 歌词：按平台各自的公开接口取 LRC 文本。
     * 原生平台没词时用「歌名 + 歌手」去酷我 / QQ 再找一遍。
     */
    ipcMain.handle('music:lyric', async (_event, input) => {
      const song = input?.song || {};
      const apiBase = normalizeNeteaseBase(input?.apiBase || '');
      try {
        const result = await fetchSourceLyric(song, { apiBase });
        return { ok: Boolean(result?.lyric), lyric: result?.lyric || '', source: result?.source || '' };
      } catch (error) {
        return { ok: false, lyric: '', source: '', reason: String(error.message || '读取歌词失败') };
      }
    });

    ipcMain.handle('music:my-playlists', async (_event, platform) => {
      const key = String(platform || '');
      try {
        /*
         * 网易云单独处理：它的凭证是本地 API 的 cookie，不走 persist 分区。
         * 平台白名单校验（musicPlatformConfig）必须排在网易云分支之后：
         * PLATFORM_CONFIG 里只有 qq / kugou，这句以前写在 try 外面先执行，
         * 网易云一进来就抛「不支持的平台：netease」，界面上就变成了
         * 「我的歌单里有网易云，点进去永远是空的」。
         */
        if (key === 'netease') {
          // 本地服务可能要先启动，再加上逐次请求的超时，整体给个硬上限，
          // 免得界面停在「正在读取网易云账号里的歌单…」。
          const list = await playlistDeadline(
            neteaseMyPlaylists(getNeteaseSession().apiBase || 'http://127.0.0.1:3100'),
            45000,
            '读取网易云歌单'
          );
          return { ok: true, list, source: 'api' };
        }
        musicPlatformConfig(key);
        /*
         * QQ 音乐 / 酷狗：先走网页（在 persist 分区里让页面自己请求，
         * 用的是浏览器真实的 cookie / Referer / 签名上下文），
         * 失败再退回 OpenAPI 直连，保证不会比之前更差。
         */
        const result = await collectPlatformPlaylists(key);
        return { ok: true, list: result.list, source: result.source };
      } catch (error) {
        const reason = String(error.message || '读取歌单失败');
        /*
         * 500003 / Access Deny / 页面里找不到歌单链接，本质都是同一件事：
         * 对方不认这次请求的登录态。标成 expired，界面就能直接给一个
         * 「重新登录」的按钮，而不是让用户对着一串代码发呆。
         */
        const expired = musicLooksExpired(reason);
        return { ok: false, reason, expired };
      }
    });

    /**
     * 网易云「我创建的歌单」。
     *
     * 走本地 NeteaseCloudMusicApi：先 /login/status 拿 uid，再 /user/playlist。
     * 未登录时返回空列表而不是抛错，这样界面上「已登录但没歌单」和
     * 「根本没登录」能区分开。
     */
    async function neteaseMyPlaylists(apiBase) {
      const base = normalizeNeteaseBase(apiBase);
      /*
       * 先把本地服务探活 / 拉起来再查询。
       * 用户直接点「我的歌单」时，可能还没进行过任何播放，服务压根没启动；
       * 这时 neteaseGet 只会拿到 fetch failed，界面显示成「读取失败」，
       * 谁都看不出真正原因是「本地网易云服务没跑」。
       */
      await startNeteaseService(base).catch((error) => {
        console.error('[netease] 本地服务启动失败:', error);
      });
      const status = await neteaseGet(base, '/login/status');
      const body = status?.data || status || {};
      const account = body.account || body.profile || null;
      const profile = body.profile || account || null;
      const uid = profile?.userId || profile?.user_id || account?.id || '';
      if (!uid) {
        throw new Error('本地网易云服务没有登录（在网易云窗口里扫码后重试）');
      }
      const json = await neteaseGet(base, '/user/playlist', { uid: String(uid), limit: '1000' });
      const list = Array.isArray(json?.playlist) ? json.playlist : [];
      return list
        .map((item) => ({
          id: String(item.id || ''),
          // 「我喜欢的音乐」和自建/收藏歌单都算，用户想看的是自己账号里有什么
          name: String(item.name || '未命名歌单'),
          count: Number(item.trackCount || 0),
          cover: String(item.coverImgUrl || '').replace(/^http:/i, 'https:'),
          creator: String(item.creator?.nickname || ''),
          subscribed: Boolean(profile && item.creator?.userId && String(item.creator.userId) !== String(uid)),
        }))
        .filter((item) => item.id);
    }

    ipcMain.handle('netease:my-playlists', async () => {
      const apiBase = getNeteaseSession().apiBase || 'http://127.0.0.1:3100';
      try {
        const list = await neteaseMyPlaylists(apiBase);
        return { ok: true, list };
      } catch (error) {
        return { ok: false, reason: String(error.message || '读取网易云歌单失败') };
      }
    });

    /**
     * 一次性拿到所有已登录平台的歌单，按平台分组。
     *
     * 之前界面只显示「当前选中的那一个平台」，登了 QQ 音乐就看不到网易云的。
     * 这里并发去要，哪个失败就只让那个平台带错误，不影响其它平台。
     */
    ipcMain.handle('music:all-playlists', async (_event, input) => {
      const startedAt = Date.now();
      /*
       * 可选入参 { platforms: ['kugou'] }：只同步点名的这一家。
       *
       * 以前不论点哪个平台的「同步」，都会把四家全拉一遍 —— 用户抱怨的就是这个：
       * 只想知道酷狗有没有更新，结果 QQ 和网易云跟着一起转。
       * 不传 / 传空数组 = 全部，老的调用方式（preload 的 musicAllPlaylists()）照旧能用。
       */
      const PLATFORM_ORDER = ['netease', 'qq', 'kugou', 'kuwo'];
      const requested = Array.isArray(input?.platforms)
        ? [
            ...new Set(
              input.platforms
                .map((item) => String(item || '').trim().toLowerCase())
                .filter((item) => PLATFORM_ORDER.includes(item))
            ),
          ]
        : [];
      const wanted = requested.length ? requested : PLATFORM_ORDER;
      const status = await musicStatus();
      /*
       * 四家平台一律并发。
       * 以前网易云是「先 await 完再并发其它三家」，它自己有 45 秒硬上限，
       * 一旦本地 NeteaseCloudMusicApi 没起来，QQ/酷狗要白等 45 秒才开始动，
       * 用户看到的就是「点同步全部，转半天一个平台都没出来」。
       * 现在各自独立跑，谁慢谁慢，快的那几家先落进结果里。
       */
      const jobs = [];
      if (status?.netease?.loggedIn && wanted.includes('netease')) {
        jobs.push(
          (async () => {
            try {
              const list = await neteaseMyPlaylists(getNeteaseSession().apiBase || 'http://127.0.0.1:3100');
              return { platform: 'netease', label: '网易云', ok: true, list, error: '', expired: false };
            } catch (error) {
              const message = String(error.message || '读取失败');
              return {
                platform: 'netease',
                label: '网易云',
                ok: false,
                list: [],
                error: message,
                expired: musicLooksExpired(message),
              };
            }
          })()
        );
      }
      for (const key of ['qq', 'kugou', 'kuwo']) {
        if (!wanted.includes(key)) continue;
        if (!status?.[key]?.loggedIn) continue;
        jobs.push(
          (async () => {
            const label = key === 'qq' ? 'QQ 音乐' : key === 'kuwo' ? '酷我' : '酷狗';
            try {
              const result = await collectPlatformPlaylists(key);
              return { platform: key, label, ok: true, list: result.list, error: '', expired: false };
            } catch (error) {
              const message = String(error.message || '读取失败');
              return { platform: key, label, ok: false, list: [], error: message, expired: musicLooksExpired(message) };
            }
          })()
        );
      }
      // allSettled：某一家的实现里万一漏了 catch，也不至于把整次同步拖垮
      const settled = await Promise.allSettled(jobs);
      const groups = settled
        .map((item) =>
          item.status === 'fulfilled'
            ? item.value
            : { platform: 'unknown', label: '未知平台', ok: false, list: [], error: String(item.reason?.message || '未知错误'), expired: false }
        )
        // 固定顺序，界面上的分区不会因为谁先返回就跳来跳去
        .sort((a, b) => {
          return PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform);
        });
      return { ok: true, groups, syncedAt: Date.now(), durationMs: Date.now() - startedAt };
    });

    /*
     * 歌单广场：网易云 / QQ音乐 / 酷狗 / 酷我 四家的公开热门歌单，免登录。
     * 返回 { ok, lists: [...], page }，渲染层按页续拉。
     */
    ipcMain.handle('music:plaza', async (_event, input) => {
      const platform = String(input?.platform || '');
      const page = Math.max(1, Number(input?.page) || 1);
      try {
        const lists = await playlistDeadline(publicPlaza(platform, page), 20000, '读取歌单广场');
        return { ok: true, lists, page };
      } catch (error) {
        return { ok: false, reason: String(error.message || '读取歌单广场失败') };
      }
    });

    ipcMain.handle('music:playlist-songs', async (_event, input) => {
      const key = String(input?.platform || '');
      const playlistId = String(input?.playlistId || '');
      if (!playlistId) return { ok: false, reason: '缺少歌单 ID' };
      /*
       * 酷狗「自建歌单」的 ID 是 opaque 的（collect:uid:listid:chain:sign），
       * 它跟账号登录态没关系，也不该先拿去做一次账号路径的尝试 ——
       * 那条路只认纯数字 specialid，对它会直接抛「歌单 ID 无效」，
       * 白等一轮再退回来。认出来就直奔公开读取。
       */
      if (/^collect:/i.test(playlistId)) {
        try {
          const detail = await playlistDeadline(
            publicPlaylistSongs('kugou', playlistId),
            40000,
            '读取酷狗分享歌单'
          );
          return { ok: true, detail: { id: playlistId, name: detail.name, songs: detail.songs || [] } };
        } catch (error) {
          return { ok: false, reason: String(error.message || '读取酷狗分享歌单失败') };
        }
      }
      try {
        /*
         * 网易云的歌单走本地 API：它没有存盘会话，loadMusicSession 读不到，
         * 而 accountPlaylistSongs 也只支持 qq/kugou。
         *
         * 注意这里必须在 musicPlatformConfig(key) 之前处理：
         * PLATFORM_CONFIG 里只有 qq / kugou，没有 netease，
         * 之前那句校验会直接抛「不支持的平台：netease」，
         * 被 catch 吞成 {ok:false}，界面上又没地方显示这个 reason，
         * 于是用户看到的就是「歌单列表出来了，点进去毫无反应」。
         */
        if (key === 'netease') {
          return await playlistDeadline(
            (async () => {
          /*
           * 公开直连优先：music.163.com 的 v6 接口免登录可用，
           * 不依赖本地服务；失败（私有歌单/网络问题）再退本地 API。
           */
          try {
            const pub = await publicPlaylistSongs('netease', playlistId);
            if (pub && pub.songs && pub.songs.length) {
              return { ok: true, detail: { id: playlistId, name: pub.name, songs: pub.songs } };
            }
          } catch (pubError) {
            console.error('[netease] 公开直连失败，退本地服务:', pubError && pubError.message);
          }
          const apiBase = getNeteaseSession().apiBase || 'http://127.0.0.1:3100';
          // 本地服务没起来就先把它拉起来，否则读取必然失败
          await startNeteaseService(apiBase).catch((error) => {
            console.error('[netease] 本地服务启动失败:', error);
          });
          /*
           * /playlist/detail 自带完整曲目（本地 API 的 module/playlist_detail.js
           * 用的是 n=100000），所以一次请求就够；
           * 万一拿到的是空列表，再走 /playlist/track/all 补一次。
           */
          let json = null;
          let playlist = null;
          try {
            json = await neteaseGet(apiBase, '/playlist/detail', { id: playlistId });
            playlist = json?.playlist || null;
          } catch (error) {
            console.error('[netease] 读取歌单详情失败:', error);
          }
          let tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
          if (!tracks.length && playlist) {
            /*
             * /playlist/track/all 每页最多 200 条，之前只拉了一页，
             * 381 首的歌单后半截全是空的。改成 offset 分页循环拉全：
             * 空页 / 不满一页 / 去重后没新增，三个条件任一命中就停。
             */
            const PAGE = 200;
            const seen = new Set();
            for (let offset = 0; offset < PAGE * 50; offset += PAGE) {
              const all = await neteaseGet(apiBase, '/playlist/track/all', {
                id: playlistId,
                limit: String(PAGE),
                offset: String(offset),
              }).catch(() => null);
              const rows = Array.isArray(all?.songs) ? all.songs : [];
              if (!rows.length) break;
              let added = 0;
              for (const row of rows) {
                const songId = String(row?.id || '');
                if (!songId || seen.has(songId)) continue;
                seen.add(songId);
                tracks.push(row);
                added += 1;
              }
              if (!added || rows.length < PAGE) break;
            }
          }
          if (!playlist && !tracks.length) {
            return { ok: false, reason: '读取网易云歌单失败（本地网易云服务可能没启动，或歌单 ID 无效）' };
          }
          const songs = tracks.map((song) => ({
            title: String(song.name || ''),
            artist: String(
              (song.ar || song.artists || []).map((a) => a.name || '').filter(Boolean).join(' / ')
            ),
            cover: String(song.al?.picUrl || song.album?.picUrl || '').replace(/^http:/i, 'https:'),
            neteaseId: String(song.id || ''),
            mid: String(song.id || ''),
            hash: '',
          }));
          return {
            ok: true,
            detail: {
              id: playlistId,
              name: String(playlist?.name || '歌单'),
              songs,
            },
          };
            })(),
            30000,
            '读取网易云歌单'
          );
        }
        /*
         * 酷我：登录态歌单走老接口 nplserver（账号数据，含私有列表）；
         * 没登录或账号路径失败时退到公开详情接口（广场歌单）。
         * 详情要逐个 musicInfo 补元信息，给 35 秒。
         */
        if (key === 'kuwo') {
          const savedKuwo = await loadMusicSession('kuwo', loadSecret);
          if (savedKuwo) {
            const creds = await mergePartitionCookies('kuwo', savedKuwo);
            try {
              const detail = await playlistDeadline(
                accountPlaylistSongs('kuwo', creds, playlistId),
                35000,
                '读取酷我歌单'
              );
              return { ok: true, detail: { id: playlistId, name: detail.name, songs: detail.songs || [] } };
            } catch (accountError) {
              console.error('[kuwo] 登录歌单失败，退公开详情:', accountError && accountError.message);
            }
          }
          const pub = await playlistDeadline(
            publicPlaylistSongs('kuwo', playlistId),
            30000,
            '读取酷我公开歌单'
          );
          return { ok: true, detail: { id: playlistId, name: pub.name, songs: pub.songs || [] } };
        }
        musicPlatformConfig(key);
        const session = await loadMusicSession(key, loadSecret);
        /*
         * 没登录时直接走公开详情（歌单广场的卡片本来就是公开歌单）；
         * 登录了但账号路径失败，也退公开详情再试一次。
         */
        if (!session) {
          const pub = await playlistDeadline(
            publicPlaylistSongs(key, playlistId),
            25000,
            '读取公开歌单'
          ).catch(() => null);
          if (pub && pub.songs && pub.songs.length) {
            return { ok: true, detail: { id: playlistId, name: pub.name, songs: pub.songs } };
          }
          return { ok: false, reason: '还没有登录，且公开详情不可用' };
        }
        let detail;
        try {
          detail =
            playlistId === LIKED_ID
              ? await playlistDeadline(
                  webLikedSongs(key, session, {
                    getWindow: async (target) => ({ win: musicLoginWindow(target), ownWindow: true }),
                  }),
                  34000,
                  '读取我喜欢的音乐'
                )
              : await playlistDeadline(
                  accountPlaylistSongs(key, session, playlistId),
                  25000,
                  '读取歌单曲目'
                );
        } catch (accountError) {
          if (playlistId === LIKED_ID) throw accountError;
          console.error('[music] 账号路径读取失败，退公开详情:', accountError && accountError.message);
          detail = await playlistDeadline(
            publicPlaylistSongs(key, playlistId),
            25000,
            '读取公开歌单'
          );
        }
        return { ok: true, detail };
      } catch (error) {
        return { ok: false, reason: String(error.message || '读取歌单失败') };
      }
    });

    /**
     * 歌单分享链接 → 平台 + 歌单 ID。
     * 只做解析，不去取曲目，方便界面先告诉用户「识别成酷狗歌单了」再去拉。
     * 认不出来时把原因原样回给界面，由界面 toast 出来，
     * 绝不让用户看到一个干巴巴的「导入失败」。
     */
    ipcMain.handle('music:parse-playlist-link', async (_event, input) => {
      try {
        /*
         * 必须 await：解析酷狗短链要跟一次 302（见 music-playlists.js 里的说明），
         * 函数已经是 async 的。漏了 await 会拿到一个 Promise，
         * 展开成 {...promise} 就是空对象，界面只会看到 ok:true 但没有任何字段。
         */
        const parsed = await parseSharedPlaylistLink(typeof input === 'string' ? input : input?.url || '');
        return { ok: true, ...parsed };
      } catch (error) {
        return { ok: false, reason: String(error.message || '没有识别出歌单 ID') };
      }
    });

    // QQ 音乐 / 酷狗的公开榜单：只读曲目列表，播放仍走网易云或原站
    /**
     * 榜单：默认返回三家合并去重后的列表。
     * 传 platform 时保留旧的单平台行为，方便回退。
     */
    ipcMain.handle('music:charts', async (_event, input) => {
      const platform = typeof input === 'string' ? input : input?.platform || '';
      const apiBase = normalizeNeteaseBase(
        (typeof input === 'object' && input?.apiBase) || ''
      );
      if (!platform || platform === 'all') {
        return mergedCharts(apiBase);
      }
      return { charts: await musicCharts(platform, apiBase), counts: { [platform]: 0, merged: 0 } };
    });

    ipcMain.handle('music:chart-songs', async (_event, input) => {
      const limit = Math.max(1, Math.min(60, Number(input?.limit) || 30));
      const apiBase = normalizeNeteaseBase(input?.apiBase || '');

      // 新的合并结构：直接给 chart 对象（含 sourceIds）
      if (input?.chart && typeof input.chart === 'object') {
        const detail = await mergedChartSongs(input.chart, apiBase, limit);
        return { ...detail, songs: detail.songs };
      }

      // 旧调用方式保持兼容
      const platform = String(input?.platform || '');
      const chartId = String(input?.chartId || '');
      if (!chartId) throw new Error('缺少榜单 ID');
      return chartSongs(platform, chartId, limit, apiBase);
    });

    /**
     * 搜索歌曲：三个平台都走公开接口，不需要登录。
     * platform 传 all（或不传）时并发搜全部三家，单个平台失败不影响其它平台。
     */
    ipcMain.handle('music:search', async (_event, input) => {
      const platform = String(input?.platform || 'all');
      const keyword = String(input?.keyword || '').trim();
      const limit = Math.max(1, Math.min(50, Number(input?.limit) || 30));
      const apiBase = normalizeNeteaseBase(input?.apiBase || '');
      if (!keyword) return { keyword: '', songs: [], errors: [] };
      const result = await searchSongs(platform, keyword, apiBase, limit);
      // 搜索结果也按音源开关过滤：停用了酷我，列表里就不该再出现「酷我」标签
      const flags = currentMusicSourceFlags();
      const songs = (result?.songs || []).filter((item) => flags[item.platform] !== false);
      return { ...result, songs };
    });

    ipcMain.handle('netease:song-meta', async (_event, input) => {
      const apiBase = normalizeNeteaseBase(input?.apiBase);
      const id = String(input?.id || '');
      if (!id) return { lyric: '' };
      const [detail, lyric] = await Promise.all([
        neteaseGet(apiBase, '/song/detail', { ids: id }).catch(() => null),
        neteaseGet(apiBase, '/lyric', { id }).catch(() => null),
      ]);
      const song = detail?.songs?.[0];
      return {
        name: song?.name || '',
        artist: (song?.ar || []).map((item) => item.name).filter(Boolean).join(' / '),
        cover: String(song?.al?.picUrl || '').replace(/^http:/i, 'https:'),
        lyric: lyric?.lrc?.lyric || '',
        translated: lyric?.tlyric?.lyric || '',
      };
    });

    ipcMain.handle('netease:qr-create', async (_event, input) => {
      const apiBase = normalizeNeteaseBase(input?.apiBase);
      const keyJson = await neteaseGet(apiBase, '/login/qr/key');
      const key = keyJson.data?.unikey;
      if (!key) throw new Error('本地 API 没有返回二维码 key');
      const qrJson = await neteaseGet(apiBase, '/login/qr/create', { key, qrimg: 'true' });
      return { apiBase, key, qrimg: qrJson.data?.qrimg || '', qrurl: qrJson.data?.qrurl || '' };
    });

    /**
     * 把 NeteaseCloudMusicApi 吐出来的 cookie 串修成合法的请求 Cookie 头。
     *
     * 那个接口返回的 cookie 是【Set-Cookie 格式】：
     *   `NMTID=xxx; Max-Age=315360000; Expires=Wed, 22 Oct 2036 ...; Path=/;`
     * 直接塞进请求头会把 Max-Age / Expires / Path 当成 cookie 名，
     * 服务端解析失败 → 认不出登录态 → 退成匿名账号（profile 为 null）。
     * 这里只保留 name=value 形式的片段，属性名白名单外的都丢掉。
     */
    function sanitizeNeteaseCookie(raw) {
      const ATTRS = new Set([
        'max-age', 'expires', 'path', 'domain', 'secure', 'httponly', 'samesite',
        'partitioned', 'priority', 'version', 'comment',
      ]);
      const parts = [];
      for (const piece of String(raw || '').split(';')) {
        const text = piece.trim();
        if (!text) continue;
        const eq = text.indexOf('=');
        if (eq <= 0) continue;
        const name = text.slice(0, eq).trim();
        if (!name || ATTRS.has(name.toLowerCase())) continue;
        parts.push(text);
      }
      return parts.join('; ');
    }

    ipcMain.handle('netease:qr-check', async (_event, input) => {
      const apiBase = normalizeNeteaseBase(input?.apiBase);
      const json = await neteaseGet(apiBase, '/login/qr/check', { key: input?.key });
      if (Number(json.code) === 803 && json.cookie) {
        const cookie = sanitizeNeteaseCookie(json.cookie);
        setNeteaseSession({ apiBase, cookie });
        await saveSecret('netease', JSON.stringify({ apiBase, cookie })).catch(() => {});
      }
      return {
        code: Number(json.code) || 0,
        message: String(json.message || ''),
        loggedIn: Boolean(getNeteaseSession().cookie && getNeteaseSession().apiBase === apiBase),
      };
    });

    ipcMain.handle('netease:status', async () => ({
      loggedIn: Boolean(getNeteaseSession().cookie),
      apiBase: getNeteaseSession().apiBase,
    }));

    ipcMain.handle('netease:logout', async () => {
      setNeteaseSession({ apiBase: '', cookie: '' });
      await saveSecret('netease', '').catch(() => {});
      return { ok: true };
    });
}

module.exports = {
  installMusicIpc,
  getActiveMusicLogin: () => activeMusicLogin,
  getMusicLoginDebug: () => musicLoginDebug,
};
