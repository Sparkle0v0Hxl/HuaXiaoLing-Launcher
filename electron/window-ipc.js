'use strict';

const { ipcMain, app, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const windowMaterial = require('./window-material');
const gameFeatures = require('./game-features');
const installManager = require('./install-manager');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');


/**
 * 窗口控制（最小化 / 最大化 / 关闭 / 拖动 / 启动导航）。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installWindowIpc(ctx) {
  /*
   * 这里全部用 getter / setter 取外层状态。
   *
   * closeAskPending、quitting 在 main.js 里是模块级 `let`，`win.on('close')` 也在读写它们；
   * 按值解构拿到的是启动那一刻的快照（而且还是个 const，赋值直接抛 TypeError），
   * 表现就是「点关闭没反应」—— 询问框永远弹不出来，或者关掉了却退不出去。
   */
  const {
    win,
    getStore,
    getRunning,
    getStarRailFps,
    channelFromArknightsRoot,
    pushState,
    tray,
    getCloseAskPending,
    setCloseAskPending,
    setQuitting,
    startNavRoom,
    applyStartNav,
    collapseStartNav,
  } = ctx;

  const closeAskPending = () => Boolean(getCloseAskPending && getCloseAskPending());
  const setCloseAsk = (value) => {
    if (typeof setCloseAskPending === 'function') setCloseAskPending(Boolean(value));
  };
  const markQuitting = () => {
    if (typeof setQuitting === 'function') setQuitting(true);
    else console.warn('[window-ipc] 缺少 setQuitting，退出标记未生效');
  };

    ipcMain.handle('window:toggle-maximize', () => {
      if (!win || win.isDestroyed()) return false;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    });
    ipcMain.handle('window:close', () => {
      if (win && !win.isDestroyed()) win.close();
    });

    ipcMain.handle('window:close-choice', async (_event, payload) => {
      const choice = typeof payload === 'string' ? payload : payload?.action;
      const remember = typeof payload === 'object' && payload !== null ? payload.remember !== false : true;
      const action = choice === 'tray' || choice === 'quit' ? choice : null;
      if (!action || !getStore()) return { ok: false };
      setCloseAsk(false);
      if (remember) {
        getStore().data.settings.closeAction = action;
        getStore().data.settings.closeToTray = action === 'tray';
        await getStore().saveNow().catch(() => {});
        pushState(true);
      }
      if (!win || win.isDestroyed()) return { ok: true, action };
      if (action === 'tray' && tray) {
        win.hide();
        return { ok: true, action };
      }
      // 托盘图标没装上：不能 hide（否则再也叫不回来），按用户选「退出」处理
      markQuitting();
      app.quit();
      return { ok: true, action: action === 'tray' ? 'quit' : action };
    });

    ipcMain.handle('window:close-cancel', () => {
      setCloseAsk(false);
      return true;
    });

    ipcMain.handle('window:move-by', (event, payload = {}) => {
      if (!win || win.isDestroyed()) return false;
      if (win.isMaximized() || win.isFullScreen()) return false;
      const dx = Math.round(Number(payload.dx) || 0);
      const dy = Math.round(Number(payload.dy) || 0);
      if (!dx && !dy) return false;
      const [x, y] = win.getPosition();
      win.setPosition(x + dx, y + dy);
      return true;
    });

    ipcMain.handle('window:start-nav-room', () => startNavRoom());

    // 渲染层每帧调一次，只做事不回话（回话要排一趟请求-响应，纯浪费）
    ipcMain.on('window:start-nav-resize', (_event, payload = {}) =>
      applyStartNav(payload.delta)
    );

    ipcMain.handle('window:start-nav-collapse', () => collapseStartNav());

    ipcMain.handle('starrail:fps:get', async () => {
      const game = getStore().data.games.find((item) => item.builtinKey === 'starrail');
      const server = (game?.servers || []).find((item) => item.id === game.activeServerId);
      return getStarRailFps(server?.channel || '');
    });

    ipcMain.handle('window:minimize', () => {
      if (win && !win.isDestroyed()) win.minimize();
    });

    ipcMain.handle('window:material', async (_event, input) => {
      const material = String(input?.material || 'none');
      const result = windowMaterial.applyMaterial(win, material);
      return {
        ...result,
        material,
        transparency: windowMaterial.transparencyEnabled(),
        supported: windowMaterial.MATERIALS,
      };
    });

    ipcMain.handle('window:material-state', async () => ({
      ok: true,
      material: getStore().data.settings?.material || 'none',
      transparency: windowMaterial.transparencyEnabled(),
      supported: windowMaterial.MATERIALS,
    }));

    /* ---------------- 安装与更新 ---------------- */

    /**
     * 汇总每个内置游戏的安装状态。
     *
     * 分三类：
     *   hyp  米哈游 — 版本读 exe 的 FileVersion，更新交给官方启动器
     *   pack 鹰角   — 本地版本读 .vela-game-state.json，远端版本查 launcher API
     * 远端查询是网络操作，所以单独放进 games:update-check，列表接口只给本地信息。
     */
    ipcMain.handle('install:list', async () => {
      const rows = [];
      for (const game of getStore().data.games || []) {
        const key = game.builtinKey || game.featureKey || '';
        const normalized = gameFeatures.normalizeKey(key);
        const trait = normalized ? gameFeatures.traitOf(normalized, 'install-manager') : null;
        const servers = Array.isArray(game.servers) ? game.servers : [];
        const active = servers.find((s) => s.id === game.activeServerId) || servers[0] || null;

        // 找一个真实存在的安装目录
        let installed = null;
        for (const server of servers) {
          const entryName =
            normalized === 'arknights' ? 'Arknights.exe' : normalized === 'endfield' ? 'Endfield.exe' : '';
          if (!server.root || !entryName) continue;
          // 明日方舟（2.4.0 合并）：官服 / B服 共用同一目录，
          // 按渠道 SDK 文件校正真实渠道（只读，不落盘）
          if (normalized === 'arknights') {
            server.channel = channelFromArknightsRoot(server.root);
          }
          const probe = installManager.looksInstalled(server.root, entryName);
          if (probe && probe.hasEntry) {
            installed = { ...probe, serverName: server.name, serverId: server.id, channel: server.channel };
            break;
          }
        }

        const exePath = installed?.entry || active?.path || game.target || '';
        const fileVer = installed ? installManager.fileVersion(exePath) : '';

        rows.push({
          id: game.id,
          name: game.name,
          subtitle: game.subtitle || '',
          featureKey: normalized,
          kind: trait ? trait.kind : null,
          packId: trait && trait.id ? trait.id : null,
          installed: Boolean(installed),
          root: installed ? installed.root : active?.root || '',
          entry: exePath,
          totalBytes: installed ? installed.totalBytes : 0,
          fileCount: installed ? installed.fileCount : 0,
          fileVersion: fileVer,
          serverName: installed ? installed.serverName : active?.name || '',
          channel: installed ? installed.channel : active?.channel || '',
          servers: servers.map((s) => ({ id: s.id, name: s.name, channel: s.channel, root: s.root || '' })),
          activeServerId: game.activeServerId || '',
          running: getRunning().has(game.id),
        });
      }
      return {
        ok: true,
        games: rows,
        miyousheLauncher: installManager.findMiyousheLauncher(),
      };
    });
}

module.exports = { installWindowIpc };
