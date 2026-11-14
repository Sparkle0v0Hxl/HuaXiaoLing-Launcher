'use strict';

const { ipcMain, app, dialog } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const hgBackgrounds = require('./hg-backgrounds');

/**
 * 启动页背景同步与导入。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installBackgroundIpc(ctx = {}) {
  /*
   * officialSyncState 是 main.js 里的模块级状态机，但它声明在 installIpc() 的后半段，
   * 按值传会踩 TDZ（Cannot access 'officialSyncState' before initialization），
   * 必须用 getter 现取。对象本身是复用的，改属性有效。
   */
  const { getOfficialSyncState } = ctx;

  const state = () => {
    if (typeof getOfficialSyncState === 'function') return getOfficialSyncState();
    return { busy: false, lastError: '', lastResult: null };
  };

    ipcMain.handle('background:sync-official', async () => {
      const syncState = state();
      if (syncState.busy) return { busy: true };
      syncState.busy = true;
      syncState.lastError = '';
      try {
        const result = await hgBackgrounds.syncOfficialBackgrounds(app.getPath('userData'));
        syncState.lastResult = result;
        return { ok: true, ...result };
      } catch (error) {
        syncState.lastError = (error && error.message) || String(error);
        console.warn('官方背景同步失败：', syncState.lastError);
        return { ok: false, error: syncState.lastError };
      } finally {
        syncState.busy = false;
      }
    });
    ipcMain.handle('background:official-state', async () => {
      const backgrounds = await hgBackgrounds.listOfficialBackgrounds(app.getPath('userData'));
      const syncState = state();
      return {
        backgrounds,
        busy: syncState.busy,
        lastError: syncState.lastError,
        lastResult: syncState.lastResult,
      };
    });
    ipcMain.handle('background:official-stat', async () =>
      hgBackgrounds.officialBackgroundsStat(app.getPath('userData'))
    );

    ipcMain.handle('background:import', async (_event, sourcePath) => {
      if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('图片不存在');
      const stat = fs.statSync(sourcePath);
      if (stat.size > 40 * 1024 * 1024) throw new Error('背景图不能超过 40 MB');
      const ext = path.extname(sourcePath).toLowerCase() || '.png';
      const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
      if (!allowed.has(ext)) throw new Error('请选择 PNG / JPG / WebP / GIF 图片');
      const dir = path.join(app.getPath('userData'), 'backgrounds');
      await fsp.mkdir(dir, { recursive: true });
      // 清掉旧的自定义背景，避免目录无限增长
      try {
        for (const name of await fsp.readdir(dir)) {
          if (name.startsWith('custom-')) await fsp.rm(path.join(dir, name), { force: true });
        }
      } catch {
        /* 清理失败不影响导入 */
      }
      const fileName = `custom-${crypto.randomUUID()}${ext}`;
      await fsp.copyFile(sourcePath, path.join(dir, fileName));
      return `backgrounds/${fileName}`;
    });
}

module.exports = { installBackgroundIpc };
