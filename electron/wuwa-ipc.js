'use strict';

const { ipcMain, app } = require('electron');
const path = require('node:path');
const predownload = require('./predownload');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');


/**
 * 鸣潮渠道与更新。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installWuwaIpc(ctx) {
  const { targetExists, send, pushState, writeLaunchLog, getStore, getRunning, invalidateRuntimesAfterUpdate, externalLinkSources } = ctx;

    ipcMain.handle('wutheringwaves:update-game', async (_event, options) => {
      const game = getStore().data.games.find((item) => item.builtinKey === 'wutheringwaves');
      const server = game?.servers.find((item) => item.id === game.activeServerId);
      if (!game || !server?.root || !targetExists(server.path)) {
        throw new Error('先配置鸣潮客户端路径');
      }
      if (getRunning().has(game.id)) throw new Error('请先退出鸣潮再更新');
      /*
       * 进度双路输出：与 arknights:update-game 同构（老入口 wutheringwaves:game-progress +
       * 带 jobId 时再发一份 predownload:progress 给进度面板）。
       */
      const jobId = String(options?.jobId || '');
      const emit = require('./progress-meter').createMeter((progress) => {
        const withPhase = { ...progress };
        if (!withPhase.phase) {
          withPhase.phase = Number(progress?.downloadedBytes) > 0 ? 'download' : 'install';
        }
        send('wutheringwaves:game-progress', withPhase);
        if (!jobId) return;
        send('predownload:progress', {
          jobId,
          ...withPhase,
          bytesDone: Number(withPhase.bytesDone ?? withPhase.downloadedBytes) || 0,
        });
      });
      /*
       * 先把已经下好的预下载包用掉：官方新版上线后，点「更新游戏」不该再把那
       * 12GB 从 CDN 重下一遍。kuro-predownload.applyPredownload 自己会核对线上
       * 正式版本是否真到了目标版本、逐文件 md5、只在全部命中时清暂存；还没上线
       * 时它会给中文 reason，这里吃掉异常照常走普通更新，不会卡住用户。
       */
      /*
       * signal 必须是真 AbortSignal：bundle 链底层 fetch（undici/Chromium）严格
       * 校验 signal 类型，传 {cancelled:false} 普通对象会让每个下载文件都报
       * TypeError「Expected signal to be an instance of AbortSignal」，表现为
       * 「获取清单正常、下载 0 个文件、两分钟后失败」（2026-11-13 dock 更新实测）。
       */
      const updateAbort = new AbortController();
      const kuroRoot = predownload.kuroInstallRoot(server);
      const kuroPending = await predownload.kuroPendingState(kuroRoot);
      if (kuroPending && kuroPending.completed && !kuroPending.applied) {
        try {
          const applied = await predownload.apply({
            gameKey: 'wutheringwaves',
            channel: server.channel,
            installRoot: kuroRoot,
            signal: updateAbort.signal,
            onProgress: (progress) => emit(progress),
          });
          if (applied?.ok && applied.applied) {
            const tag = String(applied.tag || kuroPending.targetVersion || '');
            if (tag) {
              game.version = tag;
              game.versionName = tag;
            }
            server.predownload = null;
            invalidateRuntimesAfterUpdate(game);
            await getStore().saveNow();
            pushState(true);
            return { ok: true, ...applied, patched: true, fromPredownload: true };
          }
        } catch (error) {
          writeLaunchLog('update ' + game.id + ': kuro predownload apply fallback: ' + error.message);
        }
      }
      /*
       * 鸣潮 3.0.1.0 起官方改用 bundle 分包协议，正式版在 resourcePacks.*.version
       * （当前 3.8.0），而 kuro-packs 的 legacy loadIndex 仍冻结在 3.7.1。继续用
       * kuroPacks.updateGame 会把新客户端按旧清单覆盖回去（审计 P0），所以真升级
       * 统一走 predownload.updateKuroGame：bundle 全量清单逐文件 md5 比对，只下
       * 变化的文件，删官方 deleteFiles，最后写本地版本记账。
       */
      const result = await predownload.updateKuroGame({
        gameKey: 'wutheringwaves',
        channel: server.channel,
        installRoot: predownload.kuroInstallRoot(server),
        signal: updateAbort.signal,
        onProgress: (progress) => emit(progress),
        /*
         * 别的鸣潮客户端（官服 / B服 / 国际服）已经在目标版本时，同内容文件
         * 直接硬链接过来，只下真正缺的差异文件（2026-11-16 用户要求）。
         */
        linkSources: typeof externalLinkSources === 'function'
          ? externalLinkSources(game, server, server.root)
          : [],
      });
      if (result?.ok) {
        const tag = String(result.tag || result.version || '');
        if (tag) {
          game.version = tag;
          game.versionName = tag;
        }
        invalidateRuntimesAfterUpdate(game);
        await getStore().saveNow();
        pushState(true);
      }
      return result;
    });
}

module.exports = { installWuwaIpc };
