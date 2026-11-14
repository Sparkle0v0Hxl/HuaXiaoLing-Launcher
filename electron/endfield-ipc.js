'use strict';

const { ipcMain, app, dialog } = require('electron');
const path = require('node:path');
const predownload = require('./predownload');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const endfieldPacks = require('./endfield-packs');
const endfieldLaunch = require('./endfield-launch');
const predownloadEndfield = require('./predownload-endfield');

/**
 * 终末地渠道包 / 运行时 / 更新。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installEndfieldIpc(ctx) {
  const { BrowserWindow, win, targetExists, send, pushState, writeLaunchLog, updateEndfieldGame, externalLinkSources, endfieldPackWritableRoot, ENDFIELD_PACK_NAMES, updateEndfieldPacks, refreshPackChannels, describePackUsage, ARKNIGHTS_PACK_DIRS, ENDFIELD_PACK_DIRS, builtinPackRoot, dirSize, refreshArknightsPackChannels, channelPackStatus, downloadChannelPack, cancelChannelPack, ARKNIGHTS_PACK_CHANNELS, channelPackSpec, endfieldPackCandidateRoots, channelPackReady, getStore, getRunning, invalidateRuntimesAfterUpdate } = ctx;

    ipcMain.handle('endfield:login-token', async () => {
      return new Promise((resolve, reject) => {
        const loginWindow = new BrowserWindow({
          width: 520,
          height: 720,
          parent: win || undefined,
          modal: false,
          show: true,
          title: '终末地网页登录',
          webPreferences: {
            partition: 'persist:endfield-gacha-login',
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        let settled = false;
        const finish = async (auth) => {
          if (settled) return;
          settled = true;
          await saveSecret('endfield', JSON.stringify(auth)).catch(() => {});
          try {
            loginWindow.close();
          } catch {
            /* ignore */
          }
          resolve(auth);
        };
        const checkUrl = (url) => {
          try {
            const parsed = new URL(url);
            if (!/ef-webview\.(?:hypergryph|gryphline)\.com$/.test(parsed.hostname)) return;
            const token = parsed.searchParams.get('u8_token');
            if (!token) return;
            finish({
              token,
              provider: parsed.hostname.includes('gryphline') ? 'gryphline' : 'hypergryph',
              serverId: parsed.searchParams.get('server') || parsed.searchParams.get('server_id') || '1',
            });
          } catch {
            /* ignore */
          }
        };
        loginWindow.webContents.on('will-navigate', (_event, url) => checkUrl(url));
        loginWindow.webContents.on('will-redirect', (_event, url) => checkUrl(url));
        loginWindow.webContents.on('did-navigate', (_event, url) => checkUrl(url));
        loginWindow.webContents.on('did-navigate-in-page', (_event, url) => checkUrl(url));
        loginWindow.webContents.setWindowOpenHandler(({ url }) => {
          checkUrl(url);
          return { action: 'deny' };
        });
        loginWindow.on('closed', () => {
          if (!settled) {
            settled = true;
            reject(new Error('已取消网页登录'));
          }
        });
        loginWindow.loadURL('https://ef-webview.hypergryph.com/page/gacha_char');
      });
    });

    ipcMain.handle('endfield:update-game', async (_event, options = {}) => {
      const game = getStore().data.games.find((item) => item.builtinKey === 'endfield');
      const server = game?.servers.find((item) => item.id === game.activeServerId);
      if (!game || !server?.root || !targetExists(server.path)) {
        throw new Error('先配置终末地客户端路径');
      }
      if (getRunning().has(game.id)) throw new Error('请先退出终末地再更新');
      /*
       * 从启动页那颗「更新游戏」进来时会带 jobId：跟着发一份到 predownload:progress，
       * 启动页按钮才能显示百分比（它只认这条通道 + 自己的 jobId）。不带 jobId 的老入口
       * （服务器面板里的按钮）走原来的 endfield:game-progress，行为不变。
       */
      const jobId = String(options?.jobId || '');
      /*
       * 两个面板共用同一条出口：老入口只发 endfield:game-progress（服务器面板的 busy toast
       * 在听），带 jobId 的再发一份 predownload:progress 给启动页那个进度面板。
       * 补上 phase：endfield-packs 原来只发 current/processed/total/downloadedBytes，
       * 没有 phase，界面拿到事件也拼不出「下载更新 42%」——只能落回「正在更新…」。
       */
      const meter = require('./progress-meter').createMeter((progress) => {
        send('endfield:game-progress', progress);
        if (!jobId) return;
        send('predownload:progress', {
          jobId,
          ...progress,
          // 面板读的是 bytesDone，这里把下载字节映射过去，按钮才有百分比
          bytesDone: Number(progress?.bytesDone ?? progress?.downloadedBytes) || 0,
        });
      });
      const emit = (progress) => {
        const withPhase = { ...progress };
        if (!withPhase.phase) {
          // 有 downloadedBytes 认为是真在下网，否则是在比对/复用已有文件
          withPhase.phase = Number(progress?.downloadedBytes) > 0 ? 'download' : 'install';
        }
        meter(withPhase);
      };
      /*
       * 预下载过的 Diffs/ 里就是这次更新的 zip 分包，先走它：同名同 size 同 md5 直接命中，
       * 不用重新下载。没预下载过时 hasCache 为 false，整段跳过，还是原来的逐文件校验更新。
       */
      const predownloadRoot = predownload.endfieldInstallRoot(game, server);
      if (predownload.hasCache({ gameKey: 'endfield', channel: server.channel, installRoot: predownloadRoot })) {
        try {
          const applied = await predownload.apply({
            gameKey: 'endfield',
            channel: server.channel,
            installRoot: predownloadRoot,
            onProgress: (progress) => emit(progress),
          });
          if (applied?.ok) {
            const version = String(applied.version || '');
            server.predownload = null;
            if (version) {
              game.version = version;
              game.versionName = version;
            }
            await getStore().saveNow();
            pushState(true);
            // 预下载内容落进真实安装目录后，链接运行时要失效（与 predownload:apply 同一语义）
            invalidateRuntimesAfterUpdate(game);
            return applied;
          }
        } catch (error) {
          /*
           * 预下载内容用不上，回落成逐文件全量更新。
           *
           * 这条回落原来只写一行 launch.log —— 用户那边看到的是「我明明预下载完了，
           * 怎么更新还是下了几十 G」，没有任何提示。现在把原因报上去，界面能说明白；
           * 同时顺手把用不上的 Diffs 清掉（apply 失败说明这批包跟当前清单对不上，
           * 留着只会在下一次检测里继续被当成「可以应用」）。
           */
          const reason = String(error?.message || error || '未知原因');
          writeLaunchLog(`endfield update: predownload apply fallback: ${reason}`);
          emit({ phase: 'predownload', current: `预下载内容无法应用（${reason}），改为逐文件更新` });
          try {
            await predownload.clear({ gameKey: 'endfield', installRoot: predownloadRoot });
          } catch {
            /* 清不掉不影响后面的更新 */
          }
          if (server.predownload) {
            server.predownload = null;
            await getStore().saveNow();
            pushState(true);
          }
        }
      }
      const result = await updateEndfieldGame({
        root: server.root,
        channel: server.channel,
        // 同机另一份终末地（官服 / B服 / 国际服）已经在目标版本时，相同内容直接硬链接，不再重下
        linkSources: externalLinkSources(game, server, server.root),
        onProgress: (progress) => emit(progress),
      });
      /*
       * 更新完把版本号落库。以前这里直接 return，卡片版本要等下一次检测才动，
       * 用户看到「已更新到 1.5.0」的提示、卡片却还挂旧版本，以为没更上。
       */
      const version = String(result?.version || '');
      if (result?.ok && version) {
        game.version = version;
        game.versionName = version;
        game.lastOfficialSync = Date.now();
        // Diffs 里的预下载包已经用掉了，状态跟着清掉，别再显示「可以应用」
        server.predownload = null;
        await getStore().saveNow();
        pushState(true);
      }
      // 与其余逐文件更新落点统一：skipped（本地已是最新）时不触发无谓的运行时重建
      if (result?.ok && !result?.skipped) invalidateRuntimesAfterUpdate(game);
      return result;
    });

    ipcMain.handle('endfield:update-official-packs', async (_event, options = {}) => {
      const root = endfieldPackWritableRoot();
      /*
       * 默认只补本机还缺的那几个渠道 —— 全新机器上五个一起下是约 400MB，把第一次
       * 用的人直接劝退。真要备齐是用户在弹窗里点「下载全部」（all=true）的事。
       */
      const missing = Object.entries(ENDFIELD_PACK_NAMES)
        .filter(([channel]) => !(getStore().data.settings.endfieldPackChannels || []).includes(channel))
        .map(([, packName]) => packName);
      const result = await updateEndfieldPacks({
        root,
        only: options.all ? null : missing,
        onProgress: (progress) => send('endfield:pack-progress', progress),
      });
      getStore().data.settings.endfieldPackRoot = root;
      refreshPackChannels();
      await getStore().saveNow();
      pushState(true);
      return { ...result, requested: options.all ? 'all' : 'missing', missingCount: missing.length };
    });

    ipcMain.handle('endfield:pack-usage', async () => describePackUsage());

    /*
     * 释放渠道包占的空间。
     *
     * 内置包（随安装包分发的那份）默认装在 %LOCALAPPDATA%\Programs 下，是用户自己的
     * 目录，可以直接删，不需要管理员。删完界面上就是「按需下载」，想要了随时能下回来。
     * 连带删掉 .state 里的记录：不然 updateProfile 会以为这个包还是最新的，
     * 重新下载时直接跳过，结果就是「显示能切，实际缺文件」。
     */
    ipcMain.handle('endfield:delete-packs', async (_event, options = {}) => {
      const scope = ['endfield', 'arknights', 'all'].includes(options.scope)
        ? options.scope
        : 'endfield';
      /*
       * 单渠道释放：管理窗口里每一行都有自己的「释放」，只删那一个目录。
       * 目录名过一遍白名单再拼路径 —— 这个值来自渲染层，不能直接当路径用。
       */
      const allDirs = new Set([...ENDFIELD_PACK_DIRS, ...ARKNIGHTS_PACK_DIRS]);
      const requested = Array.isArray(options.directories)
        ? options.directories.filter((name) => allDirs.has(String(name)))
        : [];
      const dirs = requested.length
        ? requested
        : scope === 'arknights'
          ? ARKNIGHTS_PACK_DIRS
          : scope === 'endfield'
            ? ENDFIELD_PACK_DIRS
            : [...ENDFIELD_PACK_DIRS, ...ARKNIGHTS_PACK_DIRS];
      const roots = [endfieldPackWritableRoot(), builtinPackRoot()].filter(Boolean);
      let freed = 0;
      const removed = [];
      for (const root of roots) {
        for (const name of dirs) {
          const dir = path.join(root, name);
          if (!fs.existsSync(dir)) continue;
          freed += dirSize(dir);
          await fsp.rm(dir, { recursive: true, force: true });
          await fsp.rm(path.join(root, '.state', `${name}.json`), { force: true }).catch(() => {});
          removed.push(name);
        }
      }
      refreshPackChannels();
      refreshArknightsPackChannels();
      pushState(true);
      return { ok: true, freed, removed: Array.from(new Set(removed)) };
    });

    ipcMain.handle('endfield:sync-packs', async () => {
      const result = await dialog.showOpenDialog(win, {
        title: '选择 XelLauncher 的 load 文件夹（用于同步渠道包更新）',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
      const source = result.filePaths[0];
      const names = ['EndOfficial', 'EndBilibili', 'EndGlobal', 'EndPlay', 'EndSteam'];
      const target = path.join(app.getPath('userData'), 'endfield-packs');
      const stateFile = (root) => path.join(root, '.state');
      const readState = (root, name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(stateFile(root), `${name}.json`), 'utf8'));
        } catch {
          return null;
        }
      };
      const updated = [];
      const skipped = [];
      for (const name of names) {
        const sourceDir = path.join(source, name);
        if (!fs.existsSync(path.join(sourceDir, 'U8Data'))) continue;
        const sourceState = readState(source, name);
        const targetState = readState(target, name);
        const sourceTime = Date.parse(sourceState?.UpdatedAtUtc || 0) || 0;
        const targetTime = Date.parse(targetState?.UpdatedAtUtc || 0) || 0;
        if (
          fs.existsSync(path.join(target, name, 'U8Data')) &&
          targetTime >= sourceTime &&
          targetState?.Version === sourceState?.Version
        ) {
          skipped.push(name);
          continue;
        }
        await fsp.rm(path.join(target, name), { recursive: true, force: true });
        await fsp.cp(sourceDir, path.join(target, name), { recursive: true, force: true });
        updated.push(name);
      }
      if (updated.length) {
        await fsp.mkdir(stateFile(target), { recursive: true });
        for (const name of updated) {
          const state = readState(source, name);
          if (state) {
            await fsp.writeFile(
              path.join(stateFile(target), `${name}.json`),
              JSON.stringify(state, null, 2),
              'utf8'
            );
          }
        }
        getStore().data.settings.endfieldPackRoot = target;
        refreshPackChannels();
        await getStore().saveNow();
        pushState(true);
      }
      return { ok: true, updated, skipped, path: target };
    });

    ipcMain.handle('endfield:import-packs', async () => {
      const result = await dialog.showOpenDialog(win, {
        title: '选择 XelLauncher 的 load 文件夹',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
      const source = result.filePaths[0];
      const names = ['EndOfficial', 'EndBilibili', 'EndGlobal', 'EndPlay', 'EndSteam'];
      const found = names.filter((name) => fs.existsSync(path.join(source, name, 'U8Data')));
      if (!found.length) throw new Error('这个目录里没有找到 EndOfficial / EndBilibili / EndGlobal 等渠道包');
      const target = path.join(app.getPath('userData'), 'endfield-packs');
      await fsp.mkdir(target, { recursive: true });
      for (const name of found) {
        await fsp.cp(path.join(source, name), path.join(target, name), {
          recursive: true,
          force: true,
        });
        /*
         * 顺手把状态文件带过来：从另一台机器整个 endfield-packs 拷过来的机器，
         * 差异渠道（国际服 / Play / Steam）靠它证明「这份包是按整套差异下完的」，
         * 不带过来的话会被判成待下载、白问一遍。
         */
        try {
          await fsp.mkdir(path.join(target, '.state'), { recursive: true });
          await fsp.cp(
            path.join(source, '.state', `${name}.json`),
            path.join(target, '.state', `${name}.json`),
            { force: true }
          );
        } catch {
          /* XelLauncher 的 load 目录没有状态文件，正常 */
        }
      }
      getStore().data.settings.endfieldPackRoot = target;
      refreshPackChannels();
      await getStore().saveNow();
      pushState(true);
      return { ok: true, imported: found, path: target };
    });

    ipcMain.handle('endfield:channel-pack-status', async (_event, input) => {
      const { game, channel } = input || {};
      return channelPackStatus(String(game || ''), String(channel || ''));
    });

    ipcMain.handle('endfield:channel-pack-download', async (_event, input) => {
      const { game, channel } = input || {};
      // 进度单独走一条通道：切服时的 busy toast 也在用 endfield:progress，
      // 两套进度混在一条通道里，界面会收到对方的百分比
      return downloadChannelPack(String(game || ''), String(channel || ''), (progress) => {
        if (win && !win.isDestroyed()) win.webContents.send('endfield:pack-progress', progress);
      });
    });

    ipcMain.handle('endfield:channel-pack-cancel', async (_event, input) => {
      const { game, channel } = input || {};
      return { ok: cancelChannelPack(String(game || ''), String(channel || '')) };
    });

    ipcMain.handle('endfield:channel-pack-list', async () => {
      const rows = [];
      for (const game of ['endfield', 'arknights']) {
        const channels =
          game === 'arknights'
            ? Object.keys(ARKNIGHTS_PACK_CHANNELS)
            : Object.keys(ENDFIELD_PACK_NAMES);
        for (const channel of channels) {
          const spec = channelPackSpec(game, channel);
          if (!spec) continue;
          const root = endfieldPackCandidateRoots().find((item) => channelPackReady(spec, item));
          rows.push({
            game,
            channel,
            directory: spec.directory,
            label: spec.label,
            ready: Boolean(root),
            root: root || '',
            bytes: root ? dirSize(path.join(root, spec.directory)) : 0,
          });
        }
      }
      return { ok: true, rows };
    });
}

module.exports = { installEndfieldIpc };
