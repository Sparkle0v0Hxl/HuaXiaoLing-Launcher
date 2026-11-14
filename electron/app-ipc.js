'use strict';

const { ipcMain, app, shell, dialog } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const updater = require('./updater');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');


/**
 * 应用级操作（信息 / 缩放 / 数据目录 / 更新包 / 管理员重启 / 退出）。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installAppIpc(ctx) {
  const { snapshot, normalizeUiScale, applyUiScale, win, updateTempBase, APP_VERSION, describeRunningProcesses, setQuitting, ensureDownloadsDir, updateLogDirs, currentElevation, relaunchElevated, getStore } = ctx;

  /* quitting 是 main.js 的模块级 let，只能通过 setter 改（按值解构是 const，赋值会抛 TypeError） */
  const markQuitting = () => {
    if (typeof setQuitting === 'function') setQuitting(true);
    else console.warn('[app-ipc] 缺少 setQuitting，退出标记未生效');
  };

    ipcMain.handle('app:info', () => snapshot().app);

    /* ---------------- 文件管理：分类统计 + 按类清理 ---------------- */

    /*
     * 只统计 userData 里明确列出的目录（见 file-manager.js 的 GROUPS），
     * 不扫游戏本体、不碰存档。bundleCovers 传给清理逻辑，是为了让「随包内置的封面」
     * 永远进不了待删列表。
     */
    const storageOptions = () => ({
      bundleCovers: path.join(app.getAppPath(), 'data', 'covers'),
    });

    ipcMain.handle('app:ui-scale', (_event, value) => {
      const scale = normalizeUiScale(value);
      getStore().data.settings.uiScale = scale;
      applyUiScale(scale);
      getStore().saveNow().catch(() => {});
      return scale;
    });

    ipcMain.handle('app:install-update', async () => {
      const result = await dialog.showOpenDialog(win, {
        title: '选择花筱灵启动器更新包',
        properties: ['openFile'],
        filters: [{ name: '便携版 ZIP', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
      const zipPath = result.filePaths[0];
      const tempBase = updateTempBase();
      await fsp.mkdir(tempBase, { recursive: true }).catch(() => {});
      // 解压到启动器旁边的临时目录，覆盖程序文件后自动重新打开（数据目录不动）
      const staged = await updater.stage({ zipPath, tempBase });
      const conflict = updater.describeApplyProblem({ staged, currentVersion: APP_VERSION });
      if (conflict) return { ok: false, message: conflict };
      const busy = describeRunningProcesses(staged.locks);
      if (busy.length) {
        return { ok: false, message: `这些程序还开着，关掉之后再导入一次：${busy.join('、')}` };
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

    ipcMain.handle('app:open-data-folder', async () => {
      await fsp.mkdir(app.getPath('userData'), { recursive: true });
      await shell.openPath(app.getPath('userData'));
    });

    ipcMain.handle('app:open-download-folder', async () => {
      try {
        const dir = await ensureDownloadsDir();
        const error = await shell.openPath(dir);
        // 静默失败最糟：用户点了没反应，还以为下载丢了自己去找
        if (error) return { ok: false, path: dir, error };
        return { ok: true, path: dir, error: '' };
      } catch (error) {
        console.warn('打开下载文件夹失败：', error && error.message);
        return { ok: false, path: '', error: (error && error.message) || String(error) };
      }
    });

    ipcMain.handle('app:open-update-log', async () => {
      const candidates = ['update-log.txt', 'self-heal.log', 'last-update.json', 'update-error.json'];
      for (const dir of updateLogDirs()) {
        for (const name of candidates) {
          const target = path.join(dir, name);
          if (fs.existsSync(target)) {
            await shell.openPath(target);
            return { ok: true, path: target, opened: true };
          }
        }
      }
      const dir = updateLogDirs()[0];
      await fsp.mkdir(dir, { recursive: true }).catch(() => {});
      await shell.openPath(dir);
      return { ok: true, path: dir, opened: false };
    });

    ipcMain.handle('app:read-update-log', async () => {
      const dirs = updateLogDirs();
      const read = async (name) => {
        for (const dir of dirs) {
          try {
            const text = await fsp.readFile(path.join(dir, name), 'utf8');
            return text.replace(/^\uFEFF/, '').trim();
          } catch {
            /* 换下一个目录 */
          }
        }
        return '';
      };
      return {
        dir: dirs[0],
        log: await read('update-log.txt'),
        selfHeal: await read('self-heal.log'),
        error: await read('update-error.json'),
      };
    });

    ipcMain.handle('app:create-desktop-shortcut', async () => {
      if (process.platform !== 'win32') {
        throw new Error('当前系统不支持创建 Windows 桌面快捷方式');
      }
      const desktop = app.getPath('desktop');
      await fsp.mkdir(desktop, { recursive: true });
      const shortcutPath = path.join(desktop, '花筱灵启动器.lnk');
      const portableTarget = process.env.PORTABLE_EXECUTABLE_FILE;
      const target =
        portableTarget && fs.existsSync(portableTarget) ? portableTarget : process.execPath;
      const existed = fs.existsSync(shortcutPath);
      const options = {
        target,
        cwd: app.isPackaged ? path.dirname(target) : app.getAppPath(),
        args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
        description: '花筱灵启动器',
        icon: target,
        iconIndex: 0,
        appUserModelId: 'com.huaxiaoling.launcher',
      };
      const ok = shell.writeShortcutLink(shortcutPath, existed ? 'replace' : 'create', options);
      if (!ok) throw new Error('系统未能创建桌面快捷方式');
      return { ok: true, path: shortcutPath, existed };
    });

    ipcMain.handle('app:relaunch-admin', async (_event, input) => {
      if (!app.isPackaged) return { ok: false, error: '开发模式下请直接用管理员终端运行' };
      /*
       * 带上「重启后要开哪个游戏」：界面上点的是「以管理员重启」，用户的本意是
       * 「把游戏打开」「别再问权限」，重启完必须接着开，不能让他再点一次。
       */
      const gameId = String(input?.launchGameId || '');
      if (gameId) {
        getStore().data.settings.pendingLaunchGameId = gameId;
        await getStore().saveNow().catch(() => {});
      }
      /*
       * 「更新到一半被权限挡住 → 以管理员重启 → 接着更新」这条链。
       * 和开游戏那条分开存：游戏目录权限不够和开游戏提权不是一回事，
       * 用户可能只是想更新，不想一开机就把游戏拉起来。
       */
      const updateGameId = String(input?.updateGameId || '');
      if (updateGameId) {
        getStore().data.settings.pendingUpdateGameId = updateGameId;
        getStore().data.settings.pendingUpdateServerId = String(input?.updateServerId || '');
        await getStore().saveNow().catch(() => {});
      }
      if (currentElevation()) return { ok: true, already: true };
      /*
       * 必须走 relaunchElevated()：它确认提权脚本进程真的起来了才退当前实例。
       * 以前这里直接 spawn + app.quit()——powershell 被安全软件拦掉时脚本没跑、
       * 老实例已经退了，用户看到的就是「点了重启，启动器消失，权限还是普通」，
       * 也就是「管理员权限功能根本无效」。
       */
      if (await relaunchElevated()) return { ok: true };
      return {
        ok: false,
        error: '无法调度提权重启（PowerShell 可能被安全软件拦截）。请右键启动器选「以管理员身份运行」',
      };
    });

    ipcMain.handle('app:quit', () => {
      markQuitting();
      app.quit();
    });
}

module.exports = { installAppIpc };
