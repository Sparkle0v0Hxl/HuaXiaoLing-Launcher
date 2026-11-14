'use strict';

const { ipcMain, session, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const miyoushe = require('./miyoushe-login');
const passport = require('./passport-login');

/**
 * 第三方通行证登录（鹰角 / 库洛 / 完美世界）。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC，改一处要在万字里找位置）。搬运时逻辑未改。
 */

function installPassportIpc(ctx) {
  const { store, win } = ctx;

    ipcMain.handle('passport:login', async (_event, input = {}) => {
      const providerId = String(input.provider || '');
      const provider = passport.PROVIDERS[providerId];
      if (!provider) return { ok: false, reason: `未知的通行证渠道：${providerId}` };

      const ses = session.fromPartition(`persist:passport-${providerId}`);

      return new Promise((resolve) => {
        let settled = false;
        let poll = null;
        let timeout = null;

        const finish = (payload) => {
          if (settled) return;
          settled = true;
          if (poll) clearInterval(poll);
          if (timeout) clearTimeout(timeout);
          try {
            if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
          } catch {
            /* ignore */
          }
          resolve(payload);
        };

        const loginWindow = new BrowserWindow({
          width: 520,
          height: 720,
          parent: win && !win.isDestroyed() ? win : undefined,
          modal: false,
          show: true,
          title: `登录${provider.label}`,
          autoHideMenuBar: true,
          webPreferences: {
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        loginWindow.setMenuBarVisibility(false);
        loginWindow.webContents.setUserAgent(passport.UA);

        /*
         * 和米游社那条路一样：只认主框架加载完成，子框架（通行证页自己嵌的登录 iframe）
         * 的加载不再触发注入，否则同样会把已经打开的登录框关掉重开。
         */
        const inject = () => {
          if (!provider.openDialogScript) return;
          loginWindow.webContents.executeJavaScript(provider.openDialogScript, true).catch(() => {});
        };
        loginWindow.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
          if (isMainFrame) inject();
        });

        loginWindow.on('closed', () => {
          finish({ ok: false, cancelled: true, reason: '已取消登录' });
        });

        loginWindow.loadURL(provider.home).catch(() => {});

        /*
         * 轮询 cookie。不用「用户点完成」按钮，是因为各家的登录完成页
         * 五花八门，而且有的会直接跳回站点首页；盯着 cookie 变最可靠。
         */
        poll = setInterval(async () => {
          if (settled || !loginWindow || loginWindow.isDestroyed()) return;
          try {
            const all = await ses.cookies.get({});
            const picked = passport.filterCookies(all, provider.cookieDomains);
            if (!passport.hasLoginCookie(picked, provider.loginKeys)) return;
            const cookieStr = passport.cookieHeader(picked);
            const roles = await passport.fetchRoles(providerId, cookieStr);
            await saveSecret(
              `passport-${providerId}`,
              JSON.stringify({ cookie: cookieStr, savedAt: Date.now(), provider: providerId })
            );
            finish({ ok: true, provider: providerId, cookie: cookieStr, roles });
          } catch {
            // 网络抖动就下一轮再试
          }
        }, 1200);

        timeout = setTimeout(() => {
          finish({ ok: false, cancelled: true, reason: '登录超时（5 分钟）' });
        }, 5 * 60 * 1000);
      });
    });

    ipcMain.handle('passport:status', async (_event, input = {}) => {
      const providerId = String(input.provider || '');
      const provider = passport.PROVIDERS[providerId];
      if (!provider) return { ok: false, loggedIn: false, roles: null, reason: `未知的通行证渠道：${providerId}` };
      const raw = await loadSecret(`passport-${providerId}`);
      if (!raw) return { ok: true, loggedIn: false, roles: null };
      try {
        const saved = JSON.parse(raw);
        /*
         * 鹰角 / 完美的 cookie 没有能直接验证有效性的公开接口，
         * 所以这里只报告「存过凭据」，真正的失效会在下次调用业务接口时暴露。
         * 米家那套有 roleList 可以验，所以走的是 miyoushe 分支。
         */
        return {
          ok: true,
          loggedIn: Boolean(saved.cookie),
          roles: null,
          savedAt: saved.savedAt || 0,
          verified: false,
        };
      } catch (error) {
        return { ok: true, loggedIn: false, roles: null, reason: String(error.message || error) };
      }
    });

    ipcMain.handle('passport:logout', async (_event, input = {}) => {
      const providerId = String(input.provider || '');
      await saveSecret(`passport-${providerId}`, '');
      try {
        const ses = session.fromPartition(`persist:passport-${providerId}`);
        await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage'] });
      } catch {
        /* ignore */
      }
      return { ok: true };
    });
}

module.exports = { installPassportIpc };
