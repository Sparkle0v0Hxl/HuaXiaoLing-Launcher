'use strict';

/**
 * 抽卡数据的读写 IPC：记录加载、UIGF 导入、数据库选择、图鉴刷新、云备份、NTE 抓取。
 *
 * 2026-11-14 从 main.js 的 installIpc() 里整段搬出来（与 gacha-ipc.js 同一次重构）。
 * 拆分理由见 gacha-ipc.js 文件头：installIpc() 原本 8700 多行、225 个 IPC 全塞里面。
 *
 * ★★★ 本文件目前是**死代码**，不要接线（2026-11-17 审查确认）★★★
 *   · 全仓库（electron / src / scripts，含 .tmp）零处 require 本文件；
 *   · 它注册的 16 个 channel 与 electron/gacha-ipc.js **完全重名**，
 *     且**没有一个是本文件独有的**；
 *   · 上游 2.11.1 官方包里同样残留着这个文件（不是我们拆分时漏删的）。
 * 一旦有人把它接进 installIpc()，同一批 channel 会被 ipcMain.handle 注册两遍，
 * Electron 会直接抛「Attempted to register a second handler for 'gacha:load'」
 * —— 启动即崩。要接线必须先删掉 gacha-ipc.js 里的同名 handler，
 * 但那样等于把抽卡 IPC 整体搬家，没有任何收益，所以保持现状 + 本注释警示。
 *
 * 约定：只注册 handler，不持有业务状态。业务状态在 gacha-backup / gacha-meta /
 * nte-capture 各自的模块与 store.data 里。
 *
 * 注意 store / win / gachaBackupFailStreak / gachaBackupRetryAt 都是 main.js 里会被
 * 重新赋值的变量，所以这里必须用 getter / setter 取值，不能传快照。
 */

/**
 * @param {object} ctx
 * @param {import('electron').App} ctx.app
 * @param {import('electron').IpcMain} ctx.ipcMain
 * @param {import('electron').Dialog} ctx.dialog
 * @param {import('electron').Shell} ctx.shell
 * @param {import('node:fs')} ctx.fs
 * @param {import('node:fs/promises')} ctx.fsp
 * @param {import('node:path')} ctx.path
 * @param {() => object} ctx.getStore
 * @param {() => import('electron').BrowserWindow|null} ctx.getWindow
 * @param {(immediate?: boolean) => void} ctx.pushState
 * @param {(channel: string, payload: any) => void} ctx.send
 * @param {(name: string, value: any) => Promise<void>} ctx.saveSecret
 * @param {object} ctx.gachaBackup
 * @param {object} ctx.gachaIcons
 * @param {object} ctx.nteCapture
 * @param {object} ctx.nteTool
 * @param {() => Promise<object>} ctx.gachaBackupCredentials
 * @param {() => object} ctx.gachaBackupSnapshot
 * @param {() => Promise<void>} ctx.refreshGachaSecretFlags
 * @param {() => void} ctx.scheduleGachaBackup
 * @param {() => void} ctx.resetBackupBackoff 把失败退避清零（改过配置/测试通过时）
 * @param {() => string} ctx.detectStarwardDbPath
 * @param {() => string} ctx.nteGachaDir
 * @param {() => Promise<any>} ctx.refreshNteAccount
 * @param {(options?: object) => Promise<any>} ctx.scanNteGachaDrops
 * @param {string} ctx.GACHA_BACKUP_PASSWORD_KEY
 * @param {string} ctx.GACHA_BACKUP_SECRET_KEY
 * @param {{ loadGachaHistory: Function, loadGachaMeta: Function, importUigf: Function, importsPath: Function }} ctx.gachaModule
 */
function installGachaDataIpc(ctx) {
  const {
    app, ipcMain, dialog, shell, fs, fsp, path,
    getStore, getWindow, pushState, send, saveSecret,
    gachaBackup, gachaIcons, nteCapture, nteTool,
    gachaBackupCredentials, gachaBackupSnapshot, refreshGachaSecretFlags, scheduleGachaBackup,
    resetBackupBackoff,
    detectStarwardDbPath, nteGachaDir, refreshNteAccount, scanNteGachaDrops,
    GACHA_BACKUP_PASSWORD_KEY, GACHA_BACKUP_SECRET_KEY,
    gachaModule,
  } = ctx;

  const { loadGachaHistory, loadGachaMeta, importUigf, importsPath } = gachaModule;
  const userData = () => app.getPath('userData');

  /* ── 抽卡记录云备份：状态 / 保存 / 测试 / 列云端 / 恢复 ──────────────── */
  ipcMain.handle('gacha:backup-status', () => gachaBackupSnapshot());

  /*
   * 保存配置。
   *
   * 密码和加密口令走「空串 = 沿用已存的那份」：表单是密码框，回显不了明文，
   * 用户只是想改地址时不该被迫重填密码。要清掉就传 null。
   */
  ipcMain.handle('gacha:backup-save', async (_event, patch = {}) => {
    const store = getStore();
    const settings = store.data.settings.gachaBackup;
    if (!settings) return { ok: false, error: '设置还没准备好' };
    const input = patch && typeof patch === 'object' ? patch : {};
    if ('enabled' in input) settings.enabled = input.enabled === true;
    if ('url' in input) settings.url = String(input.url || '').trim().slice(0, 500);
    if ('username' in input) settings.username = String(input.username || '').trim().slice(0, 200);
    if ('keep' in input) {
      settings.keep = Math.max(1, Math.min(10, Number(input.keep) || gachaBackup.DEFAULT_KEEP));
    }
    if ('password' in input) {
      const value = input.password === null ? '' : String(input.password || '').trim();
      if (input.password === null || value) await saveSecret(GACHA_BACKUP_PASSWORD_KEY, value);
    }
    if ('secret' in input) {
      const value = input.secret === null ? '' : String(input.secret || '');
      if (input.secret === null || value) await saveSecret(GACHA_BACKUP_SECRET_KEY, value);
    }
    await refreshGachaSecretFlags();
    await store.saveNow();
    // 用户刚改过地址或密码：失败退避清零，否则他要白等几小时才会重试
    resetBackupBackoff();
    // 开开关之后要重排定时器，否则要等到下一次启动才会开始算周期
    scheduleGachaBackup();
    pushState(true);
    return { ok: true, backup: gachaBackupSnapshot() };
  });

  ipcMain.handle('gacha:backup-test', async () => {
    try {
      const result = await gachaBackup.testConnection({ config: await gachaBackupCredentials() });
      // 刚验证通过：说明配置能用，把自动备份的失败退避清掉
      if (result && result.ok !== false) resetBackupBackoff();
      return result;
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('gacha:backup-list', async () => {
    try {
      return await gachaBackup.listBackups({ config: await gachaBackupCredentials() });
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('gacha:backup-restore', async (_event, input = {}) => {
    try {
      const result = await gachaBackup.restoreFrom({
        config: await gachaBackupCredentials(),
        userData: userData(),
        name: input && input.name ? String(input.name) : '',
      });
      const store = getStore();
      const settings = store.data.settings.gachaBackup;
      settings.lastResult = result.text;
      settings.lastError = '';
      await store.saveNow();
      pushState(true);
      return result;
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('gacha:load', async (_event, force = false) => {
    const store = getStore();
    // 用户不需要手动选库：路径为空或已失效时自动重新探测一次
    const configured = store.data.settings.starwardDbPath;
    if (!configured || !fs.existsSync(configured)) {
      const detected = detectStarwardDbPath();
      if (detected !== configured) {
        store.data.settings.starwardDbPath = detected;
        await store.saveNow();
      }
    }
    return loadGachaHistory(
      store.data.settings.starwardDbPath,
      path.join(userData(), 'gacha-meta-v2.json'),
      force === true,
      importsPath(userData())
    );
  });

  ipcMain.handle('gacha:import', async (_event, input = {}) => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '导入 UIGF 抽卡记录',
      properties: ['openFile'],
      filters: [{ name: 'UIGF / SRGF JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    const imported = await importUigf({
      filePath: result.filePaths[0],
      userData: userData(),
      game: input?.game,
    });
    return { ...imported, filePath: result.filePaths[0] };
  });

  // 异环：把导出目录开给用户，并把当前识别到的账号回给界面
  ipcMain.handle('gacha:nte-folder', async () => {
    const dir = nteGachaDir();
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('gacha:nte-refresh', async () => {
    const account = await refreshNteAccount().catch(() => null);
    const imported = await scanNteGachaDrops({ notify: true }).catch(() => 0);
    pushState(true);
    return { ok: true, account: account || getStore().data.nteAccount || null, imported };
  });

  ipcMain.handle('gacha:nte-capture-info', async () =>
    nteCapture.info(userData())
  );

  ipcMain.handle('gacha:nte-capture-start', async (_event, input = {}) => {
    const result = await nteCapture.start({
      userData: userData(),
      jsonDir: nteGachaDir(),
      autoPage: input?.autoPage !== false,
      onProgress: (message) => send('nte-capture', { phase: 'progress', message }),
      onDone: async (payload) => {
        const imported = await scanNteGachaDrops({ notify: false }).catch(() => 0);
        await refreshNteAccount().catch(() => null);
        pushState(true);
        send('nte-capture', {
          phase: 'done',
          imported,
          captured: payload?.count || 0,
          jsonPath: payload?.jsonPath || '',
        });
        send('toast', {
          type: imported > 0 ? 'success' : 'info',
          message:
            imported > 0
              ? `已自动导入异环抽卡记录 ${imported} 条`
              : '抓取完成，但没有发现新的抽卡记录',
        });
      },
      onError: (error) => {
        send('nte-capture', { phase: 'error', message: error.message || '抓取失败' });
        send('toast', { type: 'error', message: error.message || '异环抓取失败' });
      },
    });
    send('nte-capture', { phase: 'capturing', jsonPath: result.jsonPath, autoPage: input?.autoPage !== false });
    return { ok: true, ...result };
  });

  ipcMain.handle('gacha:nte-capture-stop', async () => {
    const result = await nteCapture.stop();
    send('nte-capture', { phase: 'stopped', message: result.message || '' });
    return result;
  });

  /*
   * 异环抓取工具（NTE_Gacha_Exporter）：下载官方/社区提供的抓取器，
   * 解压到系统下载目录并打开文件夹。可取消，进度走 send('nte-tool', ...)。
   */
  let nteToolAbort = null;

  ipcMain.handle('gacha:nte-tool', async (_event, _input) => {
    if (nteToolAbort) throw new Error('工具正在下载中');
    nteToolAbort = new AbortController();
    try {
      const result = await nteTool.run({
        downloadsDir: app.getPath('downloads'),
        signal: nteToolAbort.signal,
        onProgress: (progress) => send('nte-tool', progress),
      });
      // 下载解压完直接打开文件夹，省得用户自己找
      if (result?.dir) shell.openPath(result.dir).catch(() => {});
      return result;
    } finally {
      nteToolAbort = null;
    }
  });

  ipcMain.handle('gacha:nte-tool-cancel', () => {
    if (nteToolAbort) {
      nteToolAbort.abort();
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('gacha:refresh-meta', async () => {
    // 强制刷新终末地 / 异环的图鉴缓存，拉到新版本角色和武器
    const metaPath = path.join(userData(), 'gacha-meta-ext.json');
    const meta = await loadGachaMeta(metaPath, true);
    // 原神的头像图鉴（观测枢）：顺手一起刷，用户点「刷新图鉴」时都更新
    const icons = await gachaIcons.loadIcons(path.join(userData(), 'genshin-icons.json'), true).catch(() => null);
    return {
      ok: true,
      updatedAt: meta.updatedAt ? new Date(meta.updatedAt).toISOString() : null,
      endfield: Object.keys(meta.endfield?.bySlug || {}).length,
      neverness: Object.keys(meta.neverness?.items || {}).length,
      genshinCharacter: icons ? Object.keys(icons.character || {}).length : 0,
      genshinWeapon: icons ? Object.keys(icons.weapon || {}).length : 0,
      errors: [...(meta.errors || []), ...((icons && icons.errors) || [])],
    };
  });

  ipcMain.handle('gacha:pick-db', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择抽卡记录数据库',
      properties: ['openFile'],
      filters: [{ name: '抽卡记录数据库', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    if (result.canceled) return null;
    const dbPath = result.filePaths[0];
    const store = getStore();
    store.data.settings.starwardDbPath = dbPath;
    await store.saveNow();
    pushState(true);
    return dbPath;
  });
}

module.exports = { installGachaDataIpc };
