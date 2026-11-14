'use strict';

const { ipcMain, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const miyoushe = require('./miyoushe-login');
const postArt = require('./post-art');

/**
 * 启动页同人图。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC，改一处要在万字里找位置）。搬运时逻辑未改。
 */

function installPostartIpc(ctx) {
  const { store, readHoyolabStore, pickHoyolabAccount } = ctx;

    ipcMain.handle('postart:list', async (_event, force = false) => {
      const cached = postArt.readCache(app.getPath('userData'));
      const fresh = cached && Date.now() - Number(cached.updatedAt || 0) < 7 * 24 * 60 * 60 * 1000;
      if (!force && fresh) return { ok: true, cached: true, items: cached.items, updatedAt: cached.updatedAt };
      let cookie = '';
      try {
        const store2 = await readHoyolabStore('miyoushe');
        const account = pickHoyolabAccount(store2, '') || (store2.accounts && store2.accounts[0]);
        cookie = (account && account.cookie) || '';
      } catch {
        cookie = '';
      }
      try {
        return await postArt.refresh({ userDataDir: app.getPath('userData'), cookie, force: Boolean(force) });
      } catch (error) {
        return {
          ok: false,
          items: (cached && cached.items) || {},
          error: (error && error.message) || String(error),
        };
      }
    });
}

module.exports = { installPostartIpc };
