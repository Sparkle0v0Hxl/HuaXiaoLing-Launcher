'use strict';

const { ipcMain, app } = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const nevernessChannels = require('./neverness-channels');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const predownload = require('./predownload');
const predownloadSim = require('./predownload-sim');
const { createCancelSignal } = require('./cancel-signal');

/**
 * 预下载（官方分卷 / 模拟 / 剧情资源）。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installPredownloadIpc(ctx) {
  const { beginBackgroundTask, send, sendProgress, endBackgroundTask, writeLaunchLog, externalLinkSources, pushState, syncOfficialGame, storyResourcesEnabled, getStore, getRunning, getPredownloadJobs, resolvePredownload, savePredownloadState, invalidateRuntimesAfterUpdate } = ctx;

    ipcMain.handle('predownload:check', async (_event, input) => {
      const { server, base } = resolvePredownload(input);
      const report = await predownloadSim.check({ ...base, verify: input?.verify === true });
      await savePredownloadState(server, report);
      return report;
    });

    ipcMain.handle('predownload:start', async (_event, input) => {
      const { game, server, base } = resolvePredownload(input);
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再预下载');
      const jobId = String(input?.jobId || crypto.randomUUID());
      /*
       * 必须是真 AbortSignal（见 cancel-signal.js）：这条链最终走到
       * kuro-packs.downloadOne → segmentFetch，手造 { cancelled: false }
       * 会被 fetch 直接拒绝（TypeError: Expected signal to be an instance of
       * AbortSignal），鸣潮预下载就一直是坏的。用混合信号后，
       * 下面 cancel/pause 处理器的 `job.cancelled = true` 写法照旧有效。
       */
      const signal = createCancelSignal();
      getPredownloadJobs().set(jobId, signal);
      beginBackgroundTask();
      send('predownload:progress', { jobId, phase: 'start', current: '正在读取官方清单…' });
      /*
       * 跨服复用（用户 2026-11-16「预下载功能也是」）：别的服已经预下载过的
       * 分块 / 补丁包 / 分包，直接硬链接过来，不必再从网上拉一遍。
       *
       * 与 predownload:apply 不同，这里**不排除 endfield** —— 终末地预下载的
       * Diffs/ 分包同样是内容寻址的，别的服下过就能复用。
       */
      const linkSources = externalLinkSources(game, server, base.installRoot);
      try {
        const result = await predownloadSim.start({
          ...base,
          linkSources,
          signal,
          onProgress: (progress) => sendProgress('predownload:progress', jobId, progress),
        });
        if (signal.cancelled) return { ok: false, cancelled: true };
        await savePredownloadState(server, await predownloadSim.check(base));
        send('predownload:progress', { jobId, phase: 'done', current: '预下载完成' });
        return { ok: true, ...result };
      } catch (error) {
        server.predownload = {
          ...(server.predownload || {}),
          state: 'error',
          error: error.message,
          updatedAt: new Date().toISOString(),
        };
        await getStore().saveNow().catch(() => {});
        send('predownload:progress', { jobId, phase: 'error', current: error.message });
        throw error;
      } finally {
        endBackgroundTask();
        getPredownloadJobs().delete(jobId);
      }
    });

    ipcMain.handle('predownload:apply', async (_event, input) => {
      const { game, server, base } = resolvePredownload(input);
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再应用更新');
      // 异环更新会改写 NTELauncher 下的文件，官方启动器开着会锁文件 / 退出时回写配置
      if (game.builtinKey === 'neverness') await nevernessChannels.assertLauncherClosed();
      const jobId = String(input?.jobId || crypto.randomUUID());
      // 同 predownload:start：这条链也会走到 kuro-packs.downloadOne / segmentFetch
      const signal = createCancelSignal();
      getPredownloadJobs().set(jobId, signal);
      beginBackgroundTask();
      send('predownload:progress', { jobId, phase: 'start', current: '正在校验并应用预下载内容…' });
      writeLaunchLog(`predownload apply ${game.builtinKey}/${server.channel}: 开始（jobId=${jobId}, installRoot=${base.installRoot}）`);
      try {
        /*
         * 同机另一渠道客户端里已经有同内容的文件时，直接硬链接过来，别再下/解压一遍。
         * 「更新游戏」那条路一直是这么做的，应用预下载这条以前没接上：assembleFile 里的
         * 复用逻辑一直在，但没人把源递进来，等于白写。
         *
         * 终末地以前被这里排除掉了（那会儿 applyEndfieldPredownload 不收 linkSources）。
         * 现在它每条 patch.json 条目都会先按目标 md5 去别的服找一遍，所以一并放开。
         */
        const linkSources = externalLinkSources(game, server, base.installRoot);
        const result = await predownloadSim.apply({
          ...base,
          linkSources,
          signal,
          onProgress: (progress) => sendProgress('predownload:progress', jobId, progress),
        });
        if (signal.cancelled) return { ok: false, cancelled: true };
        const tag = String(result?.tag || result?.version || '');
        /*
         * 异环这条「更新」动的只是 NTELauncher 那层资源，返回的是启动器资源版本
         * （实测 1.0.7.1029），跟卡片上的游戏版本（1.4）不是一回事。以前无条件
         * 覆盖，点完「更新启动器」卡片就变成 v1.0.7.1029，用户以为游戏升到别的版本了。
         * scope='launcher' 或异环这种「只更启动器」的结果一律不碰游戏版本号。
         */
        const launcherOnly =
          String(result?.scope || '') === 'launcher' || game.builtinKey === 'neverness' || base.gameKey === 'neverness';
        server.predownload = null;
        // 更新落在了真实安装目录，把链接运行时的标记清掉，下次启动自动重建
        invalidateRuntimesAfterUpdate(game);
        // 演练模式不能改写游戏真实版本号，否则卡片会挂一个官方根本没发布过的版本
        if (tag && !result?.simulated && !launcherOnly) {
          game.version = tag;
          game.versionName = tag;
        }
        game.lastOfficialSync = Date.now();
        if (game.activeServerId === server.id) {
          game.target = server.path || game.target;
          game.workDir = server.root || game.workDir;
        }
        await getStore().saveNow();
        pushState(true);
        syncOfficialGame(game, []).catch(() => {});
        send('predownload:progress', { jobId, phase: 'done', current: '更新已应用' });
        writeLaunchLog(`predownload apply ${game.builtinKey}: 完成（tag=${tag}, applied=${result?.applied ?? '-'}, downloaded=${result?.downloaded ?? '-'}, reused=${result?.reused ?? '-'}）`);
        return { ok: true, ...result };
      } catch (error) {
        send('predownload:progress', { jobId, phase: 'error', current: error.message });
        writeLaunchLog(`predownload apply ${game.builtinKey}: 失败 — ${error.message}`);
        throw error;
      } finally {
        endBackgroundTask();
        getPredownloadJobs().delete(jobId);
      }
    });

    ipcMain.handle('predownload:clear', async (_event, input) => {
      const { server, base } = resolvePredownload(input);
      const result = await predownloadSim.clear({ gameKey: base.gameKey, installRoot: base.installRoot });
      server.predownload = null;
      await getStore().saveNow();
      pushState(true);
      return { ok: true, ...result };
    });

    ipcMain.handle('predownload:set-story-resources', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      const server = (game.servers || []).find((item) => item.id === input?.serverId);
      if (!server) throw new Error('没有找到这个服务器');
      const enabled = input?.enabled;
      if (enabled === null || enabled === undefined) {
        delete server.includeStoryResources;
      } else {
        server.includeStoryResources = Boolean(enabled);
      }
      await getStore().saveNow();
      pushState(true);
      // 口径变了要重新查一次，界面上的「已完成 / 需要重新预下载」才会跟着变
      const report = await predownload
        .check({
          gameKey: game.builtinKey,
          channel: server.channel,
          installRoot:
            game.builtinKey === 'endfield' ? predownload.endfieldInstallRoot(game, server) : predownload.hoyoInstallRoot(server),
          cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
          audioLanguages: getStore().data?.settings?.audioLanguages,
          includeCategory: storyResourcesEnabled(game, server),
        })
        .catch((error) => ({ state: 'error', error: error.message }));
      server.predownload = predownload.stateFromReport(report);
      await getStore().saveNow();
      pushState(true);
      return { ok: true, enabled: server.includeStoryResources ?? null, report };
    });

    ipcMain.handle('predownload:cancel', async (_event, jobId) => {
      const job = getPredownloadJobs().get(String(jobId));
      if (!job) return false;
      job.cancelled = true;
      return true;
    });

    ipcMain.handle('predownload:pause', async (_event, input) => {
      const job = getPredownloadJobs().get(String(input?.jobId));
      if (!job) return false;
      job.paused = input?.paused === true;
      return true;
    });
}

module.exports = { installPredownloadIpc };
