'use strict';

const { ipcMain, app, dialog } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const installManager = require('./install-manager');

/**
 * 游戏安装（下载 / 分卷 / 解压）。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installInstallIpc(ctx) {
  const { fetchLatestForChannel, shell } = ctx;

    ipcMain.handle('install:check-remote', async (_event, input) => {
      const channel = String(input?.channel || '').trim();
      if (!channel) return { ok: false, reason: '缺少渠道' };
      try {
        const latest = await fetchLatestForChannel(channel);
        const root = String(input?.root || '').trim();
        let localVersion = '';
        if (root) {
          try {
            const stateFile = path.join(root, '.vela-game-state.json');
            const raw = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
            localVersion = String(raw?.version || '');
          } catch {
            /* 没有本地状态文件就当未知 */
          }
        }
        return {
          ok: true,
          localVersion,
          remoteVersion: latest.version,
          clientVersion: latest.clientVersion || '',
          totalSize: latest.totalSize || 0,
          base: latest.base || '',
          packCount: Array.isArray(latest.packs) ? latest.packs.length : 0,
          outdated: Boolean(localVersion && latest.version && localVersion !== latest.version),
        };
      } catch (error) {
        return { ok: false, reason: String(error.message || '查询失败') };
      }
    });

    ipcMain.handle('install:open', async (_event, input) => {
      const what = String(input?.what || '');
      if (what === 'miyoushe') {
        const exe = installManager.findMiyousheLauncher();
        if (!exe) return { ok: false, reason: '没有找到米哈游启动器（HYP.exe），请先安装 HoYoPlay' };
        await shell.openPath(exe);
        return { ok: true };
      }
      if (what === 'folder') {
        const target = String(input?.path || '');
        if (!target || !fs.existsSync(target)) return { ok: false, reason: '目录不存在' };
        await shell.openPath(target);
        return { ok: true };
      }
      if (what === 'site') {
        const url = String(input?.url || '');
        if (!/^https:\/\//i.test(url)) return { ok: false, reason: '链接不合法' };
        await shell.openExternal(url);
        return { ok: true };
      }
      return { ok: false, reason: '未知操作' };
    });
}

module.exports = { installInstallIpc };
