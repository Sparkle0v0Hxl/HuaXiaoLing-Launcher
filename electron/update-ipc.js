'use strict';

const { ipcMain, app } = require('electron');
const path = require('node:path');
const updater = require('./updater');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');


/**
 * 自动更新检查与应用。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installUpdateIpc(ctx) {
  const { performUpdateCheck, readSystemProxy, probeProxy, startUpdate, dialog, win, updateBackupInfo, updateTempBase, describeRunningProcesses, setQuitting, getStore } = ctx;

  /* quitting 是 main.js 的模块级 let，只能通过 setter 改（按值解构是 const，赋值会抛 TypeError） */
  const markQuitting = () => {
    if (typeof setQuitting === 'function') setQuitting(true);
    else console.warn('[update-ipc] 缺少 setQuitting，退出标记未生效');
  };

    ipcMain.handle('update:check', async () => performUpdateCheck({ push: true, manual: true }));
    // 代理：从系统里读一条现成的规则，省得用户自己去翻 Clash 的端口
    ipcMain.handle('proxy:system', async () => readSystemProxy());
    // 代理：拿真实地址试一下通不通，比「保存了但不知道有没有用」强
    ipcMain.handle('proxy:test', async (_event, rules) => probeProxy(typeof rules === 'string' ? rules : ''));

    ipcMain.handle('update:apply', async () => startUpdate());

    ipcMain.handle('update:pick-source', async () => {
      const result = await dialog.showOpenDialog(win, {
        title: '选择更新源文件（latest.json）',
        properties: ['openFile'],
        filters: [{ name: '更新清单', extensions: ['json', 'txt'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
      getStore().data.settings.updateManifest = result.filePaths[0];
      await getStore().saveNow();
      const status = await performUpdateCheck({ push: true });
      return { ok: true, status };
    });

    ipcMain.handle('update:backup', async () => updateBackupInfo());

    ipcMain.handle('update:rollback', async () => {
      const staged = await updater.prepareRollback({ tempBase: updateTempBase() });
      if (!staged) return { ok: false, message: '没有找到可回滚的上一个版本备份' };
      const busy = describeRunningProcesses(staged.locks);
      if (busy.length) {
        return { ok: false, message: `这些程序还开着，关掉之后再回滚：${busy.join('、')}` };
      }
      await updater.apply({
        staged,
        onReadyToQuit: () => {
          setTimeout(() => {
            markQuitting();
            app.quit();
          }, 250);
        },
      });
      return { ok: true, restarting: true, version: staged.version };
    });
}

module.exports = { installUpdateIpc };
