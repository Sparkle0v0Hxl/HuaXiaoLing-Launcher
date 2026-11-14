'use strict';

const { ipcMain, app, shell } = require('electron');
const path = require('node:path');
const gameFeatures = require('./game-features');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const screenshotLib = require('./screenshots');

/**
 * 截图扫描。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installScreenshotsIpc(ctx) {
  const { targetExists, screenshotAllow, getStore } = ctx;

    ipcMain.handle('screenshots:list', async () => {
      const customRoots = getStore().data?.settings?.screenshotRoots || {};
      try {
        // 游玩区间 → 游戏 key，用于把混在一个目录里的截图分回各自游戏
        const playLog = getStore().data?.stats?.playLog || [];
        const idToKey = new Map();
        const knownKeys = new Set(gameFeatures.listGames().map((item) => item.key));
        for (const game of getStore().data?.games || []) {
          const key = gameFeatures.normalizeKey(game.featureKey || game.id) || '';
          // 自定义游戏 normalizeKey 会原样返回 id，那种 key 图鉴里没有意义，丢掉
          if (key && knownKeys.has(key)) idToKey.set(game.id, key);
        }
        const sessionWindows = screenshotLib.sessionWindowsFrom(playLog, (id) => idToKey.get(id) || '');
        // 截图管理要指向「每个游戏的截图目录」，而不是电脑自带的截图文件夹。
        // 游戏安装目录 = exe 所在目录，截图通常落在 <游戏目录>\ScreenShot 及常见变体。
        // 所以当用户没手动配置截图目录时，就从各游戏安装路径推导出它的截图目录，
        // 而不是退回 defaultRoots 里的 Pictures\Screenshots。
        const screenshotRoots = {};
        if (customRoots && Object.keys(customRoots).length) {
          screenshotRoots.custom = customRoots;
        } else {
          for (const game of getStore().data?.games || []) {
            const key = idToKey.get(game.id);
            const dirs = new Set();
            for (const server of game.servers || []) {
              if (!server.path || !targetExists(server.path)) continue;
              const gameDir = path.dirname(server.path);
              const shotNames = ['ScreenShot', 'Screenshot', '截图', 'screenshot', 'Screenshots', 'ScreenShots'];
              for (const name of shotNames) dirs.add(path.join(gameDir, name));
              dirs.add(path.join(gameDir, 'Photos'));
            }
            if (key && dirs.size) screenshotRoots[key] = [...dirs];
          }
        }
        const result = await screenshotLib.listScreenshots({
          customRoots: screenshotRoots.custom || screenshotRoots,
          sessionWindows,
        });
        // 刷新缩略图白名单：只有本次扫描出来的路径能被 hxl-shot 协议读到
        screenshotAllow.clear();
        for (const list of Object.values(result.groups || {})) {
          for (const item of list) screenshotAllow.add(path.normalize(item.path.toLowerCase()));
        }
        return { ok: true, ...result };
      } catch (error) {
        return { ok: false, reason: String(error.message || '扫描失败') };
      }
    });

    ipcMain.handle('screenshots:check-dir', async (_event, dir) => screenshotLib.checkDir(String(dir || '')));

    /*
     * 缩略图本体通过 IPC 取回 data URL，而不是自定义协议：
     * 页面跑在 file:// 下，file:// → hxl-shot:// 属于跨源，会被 CORS 直接拦掉。
     * 只允许「本次扫描过的路径」，单张超过 8MB 不内联，避免内存暴涨。
     */
    ipcMain.handle('screenshots:thumb', async (_event, filePath) => {
      const target = String(filePath || '');
      if (!target) return { ok: false, reason: '缺少路径' };
      if (!screenshotAllow.has(path.normalize(target.toLowerCase()))) {
        return { ok: false, reason: '这个文件不在扫描结果里' };
      }
      try {
        const stat = await fsp.stat(target);
        if (stat.size > 8 * 1024 * 1024) return { ok: false, reason: '图片太大，请用系统看图工具打开' };
        const buffer = await fsp.readFile(target);
        const ext = path.extname(target).toLowerCase().replace('.', '');
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' }[ext];
        if (!mime) return { ok: false, reason: '不支持的图片格式' };
        return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
      } catch (error) {
        return { ok: false, reason: String(error.message || '读取失败') };
      }
    });

    ipcMain.handle('screenshots:open', async (_event, filePath) => {
      const target = String(filePath || '');
      if (!target) return { ok: false };
      try {
        await shell.openPath(target);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String(error.message || '') };
      }
    });

    ipcMain.handle('screenshots:reveal', async (_event, filePath) => {
      const target = String(filePath || '');
      if (!target) return { ok: false };
      shell.showItemInFolder(target);
      return { ok: true };
    });
}

module.exports = { installScreenshotsIpc };
