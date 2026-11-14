'use strict';

const { ipcMain, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const pluginHost = require('./plugin-host');

/**
 * 自定义插件加载。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installPluginIpc(ctx) {
  const { dialog, win, getPluginRoot } = ctx;

  /*
   * pluginRoot 在 main.js 里声明在 installIpc() 的后半段，
   * 按值传过去会踩 TDZ（Cannot access 'pluginRoot' before initialization），
   * 只能用 getter 现取。
   */
  const root = () => {
    if (typeof getPluginRoot === 'function') return getPluginRoot();
    return app.getPath('userData');
  };

    ipcMain.handle('plugin:list', async () => {
      const { dir, plugins } = await pluginHost.listPlugins(root());
      return { ok: true, dir, plugins, permissions: pluginHost.PERMISSIONS };
    });

    ipcMain.handle('plugin:read', async (_event, id) => pluginHost.readPlugin(root(), String(id || '')));

    ipcMain.handle('plugin:import', async () => {
      const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
        title: '选择插件文件',
        properties: ['openFile'],
        filters: [{ name: '花筱灵插件', extensions: ['hxl', 'js'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
      return pluginHost.importPlugin(root(), result.filePaths[0]);
    });

    ipcMain.handle('plugin:remove', async (_event, id) => pluginHost.removePlugin(root(), String(id || '')));

    ipcMain.handle('plugin:storage-get', async (_event, id) => pluginHost.getStorage(root(), String(id || '')));

    ipcMain.handle('plugin:storage-set', async (_event, input) => {
      const payload = input && typeof input === 'object' ? input : {};
      return pluginHost.setStorage(root(), String(payload.id || ''), payload.value);
    });
}

module.exports = { installPluginIpc };
