'use strict';

const { ipcMain, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const miyoushe = require('./miyoushe-login');
const roster = require('./roster');

/**
 * 角色图鉴数据。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC，改一处要在万字里找位置）。搬运时逻辑未改。
 */

function installRosterIpc(ctx) {
  const { store, readHoyolabStore, pickHoyolabAccount } = ctx;

    ipcMain.handle('roster:load', async (_event, input = {}) => {
      const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
      const store = await readHoyolabStore(providerId);
      if (!store.accounts.length) {
        return { ok: false, error: '还没有登录米游社，先去左下角账号中心登录一次' };
      }
      const account = pickHoyolabAccount(store, input.accountId);
      if (!account) {
        return { ok: false, error: '没有找到这个米游社账号，请重新登录' };
      }
      return roster.loadRoster(miyoushe, {
        userData: app.getPath('userData'),
        game: String(input.game || ''),
        uid: String(input.uid || ''),
        server: String(input.server || ''),
        providerId,
        cookie: account.cookie,
        force: input.force === true,
      });
    });

    ipcMain.handle('roster:detail', async (_event, input = {}) => {
      const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
      const store = await readHoyolabStore(providerId);
      const account = pickHoyolabAccount(store, input.accountId);
      if (!account) return { ok: false, error: '没有找到这个米游社账号' };
      return roster.loadCharacterDetail(miyoushe, {
        game: String(input.game || ''),
        uid: String(input.uid || ''),
        server: String(input.server || ''),
        providerId,
        cookie: account.cookie,
        characterId: Number(input.characterId) || 0,
      });
    });
}

module.exports = { installRosterIpc };
