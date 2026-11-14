'use strict';

const { ipcMain, app, shell } = require('electron');
const path = require('node:path');
const nevernessChannels = require('./neverness-channels');
const nevernessPredownload = require('./neverness-predownload');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');


/**
 * 异环渠道 / 启动器 / 预下载。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installNevernessIpc(ctx) {
  const { pushState, send, getStore, getRunning, getNtePredownloadAbort, setNtePredownloadAbort } = ctx;

  /*
   * ntePredownloadAbort 是 main.js 的模块级 let（存 AbortController）。
   * 按值解构拿到的是 null 快照，一赋值就抛 TypeError —— 预下载永远开不起来。
   */
  const abortRef = () => (typeof getNtePredownloadAbort === 'function' ? getNtePredownloadAbort() : null);
  const setAbort = (value) => {
    if (typeof setNtePredownloadAbort === 'function') setNtePredownloadAbort(value);
  };

    ipcMain.handle('neverness:channel', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.builtinKey === 'neverness');
      if (!game) throw new Error('没有找到异环');
      const server =
        (game.servers || []).find((item) => item.id === input?.serverId) ||
        (game.servers || []).find((item) => item.id === game.activeServerId);
      return nevernessChannels.readNevernessChannel({
        installRoot: server?.root || '',
        gamePath: server?.path || game.target || '',
      });
    });

    ipcMain.handle('neverness:set-channel', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.builtinKey === 'neverness');
      if (!game) throw new Error('没有找到异环');
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先退出异环再切换服务器');
      const server =
        (game.servers || []).find((item) => item.id === input?.serverId) ||
        (game.servers || []).find((item) => item.id === game.activeServerId);
      const result = await nevernessChannels.setNevernessChannel({
        installRoot: server?.root || '',
        gamePath: server?.path || game.target || '',
        channel: input?.channel,
      });
      // 把当前渠道记在服务器上，界面下次打开就能直接显示
      const target =
        (game.servers || []).find((item) => item.channel === result.channel) || server || null;
      if (target) game.activeServerId = target.id;
      await getStore().saveNow();
      pushState(true);
      return result;
    });

    ipcMain.handle('neverness:open-launcher', async () => {
      const game = getStore().data.games.find((item) => item.builtinKey === 'neverness');
      if (!game) throw new Error('没有找到异环');
      const server =
        (game.servers || []).find((item) => item.id === game.activeServerId) ||
        (game.servers || [])[0] ||
        null;
      const root = nevernessChannels.findConfigRoot(
        server?.root || server?.path || game.target || ''
      );
      if (!root) throw new Error('没有找到异环安装目录，先在服务器设置里指好游戏路径');
      const launcher = path.join(root, 'NTELauncher.exe');
      if (!fs.existsSync(launcher)) throw new Error(`没有找到官方启动器：${launcher}`);
      const error = await shell.openPath(launcher);
      if (error) throw new Error(`官方启动器打开失败：${error}`);
      return { ok: true };
    });

    ipcMain.handle('neverness:predownload', async (_event, input) => {
      if (abortRef()) throw new Error('已有预下载在进行中');
      const game = getStore().data.games.find((item) => item.builtinKey === 'neverness');
      if (!game) throw new Error('没有找到异环');
      const server =
        (game.servers || []).find((item) => item.id === input?.serverId) ||
        (game.servers || []).find((item) => item.id === game.activeServerId) ||
        (game.servers || [])[0] ||
        null;
      const controller = new AbortController();
      setAbort(controller);
      try {
        return await nevernessPredownload.predownload({
          installRoot: server?.root || server?.path || game.target || '',
          channel: input?.channel || 'bilibili',
          signal: controller.signal,
          onProgress: (progress) => send('nte-predownload', progress),
        });
      } finally {
        setAbort(null);
      }
    });
    ipcMain.handle('neverness:predownload-cancel', () => {
      const controller = abortRef();
      if (controller) {
        controller.abort();
        return { ok: true };
      }
      return { ok: false };
    });
}

module.exports = { installNevernessIpc };
