'use strict';

const { ipcMain, app } = require('electron');
const path = require('node:path');
const yostarPacks = require('./yostar-packs');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');


/**
 * 明日方舟渠道与更新。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installArknightsIpc(ctx) {
  const { targetExists, send, pushState, ARKNIGHTS_CN_CHANNELS, updateEndfieldGame, externalLinkSources, endfieldPackWritableRoot, ARKNIGHTS_OFFICIAL_PROFILE, ARKNIGHTS_BILIBILI_PROFILE, verifyArknightsSource, updateEndfieldProfile, refreshPackChannels, getStore, getRunning, invalidateRuntimesAfterUpdate } = ctx;

    ipcMain.handle('arknights:update-game', async (_event, options) => {
      const game = getStore().data.games.find((item) => item.builtinKey === 'arknights');
      const server = game?.servers.find((item) => item.id === game.activeServerId);
      if (!game || !server?.root || !targetExists(server.path)) {
        throw new Error('先配置明日方舟客户端路径');
      }
      if (getRunning().has(game.id)) throw new Error('请先退出明日方舟再更新');
      /*
       * 进度双路输出：老入口只发 arknights:game-progress（原来全仓没人订阅，界面一直
       * 停在「正在准备更新…」），从启动页那颗按钮进来时带 jobId，再发一份
       * predownload:progress 给进度面板 —— 和终末地那条桥保持同一形状。
       */
      const jobId = String(options?.jobId || '');
      const emit = require('./progress-meter').createMeter((progress) => {
        const withPhase = { ...progress };
        if (!withPhase.phase) {
          withPhase.phase = Number(progress?.downloadedBytes) > 0 ? 'download' : 'install';
        }
        send('arknights:game-progress', withPhase);
        if (!jobId) return;
        send('predownload:progress', {
          jobId,
          ...withPhase,
          bytesDone: Number(withPhase.bytesDone ?? withPhase.downloadedBytes) || 0,
        });
      });
      /*
       * 国际服（EN / JP / KR）走 Yostar 自己的那套清单，和国服的鹰角清单毫无关系：
       * 逐文件 CRC64 + 官方 game-launcher-config.json / manifest.json 元数据，
       * 主程序和平台库都和国服不是一份文件。绝不能拿国服清单往它们目录里 in-place 写。
       */
      if (yostarPacks.isYostarChannel(server.channel)) {
        const result = await yostarPacks.updateGame({
          profile: server.channel,
          installRoot: server.root,
          allowDelete: true,
          onProgress: (progress) => emit(progress),
        });
        if (result?.ok) {
          game.version = String(result.version || game.version || '');
          game.versionName = game.version;
          await getStore().saveNow();
          pushState(true);
        }
        return result;
      }
      // profileForChannel('arknights') 是国服全量清单（13749 文件/25.4GB）的专用哨兵值，
      // 绝不能换成 server.channel（那会误拉终末地清单）。台服由第三个发行商发行、
      // 协议未验证，在发起任何网络请求或写盘之前先挡住，避免被国服清单 in-place 覆盖刷坏。
      if (!ARKNIGHTS_CN_CHANNELS.includes(server.channel)) {
        throw new Error('明日方舟台服暂不支持在此更新本体，请前往对应官网');
      }
      /*
       * 明日方舟本体走的是鹰角同一套加密逐文件清单（GET {base}/game_files），
       * 与终末地同构，直接用 updateEndfieldGame + profileForChannel('arknights') 重放即可，
       * 不需要拉起官方启动器。启动前的渠道 SDK 注入由 games:launch 里的 ensureArknightsRuntime 负责，
       * 更新完再启动依旧能正常进游戏。
       */
      const result = await updateEndfieldGame({
        root: server.root,
        channel: 'arknights',
        linkSources: externalLinkSources(game, server, server.root),
        onProgress: (progress) => emit(progress),
      });
      if (result?.ok && !result?.skipped) invalidateRuntimesAfterUpdate(game);
      return result;
    });

    ipcMain.handle('arknights:update-packs', async () => {
      const root = endfieldPackWritableRoot();
      const results = [];
      for (const [profile, label] of [
        [ARKNIGHTS_OFFICIAL_PROFILE, '官服'],
        [ARKNIGHTS_BILIBILI_PROFILE, 'B服'],
      ]) {
        if (!(await verifyArknightsSource(profile))) {
          results.push({ iconName: profile.iconName, skipped: true, error: '官方接口上没有这份清单' });
          continue;
        }
        try {
          await updateEndfieldProfile(profile, root, (progress) =>
            send('endfield:pack-progress', {
              ...progress,
              directory: profile.directory,
              current: `[${label}] ${progress.current || ''}`,
            })
          );
          results.push({ iconName: profile.iconName, skipped: false, updated: true });
        } catch (error) {
          results.push({ iconName: profile.iconName, skipped: false, error: error.message });
        }
      }
      refreshPackChannels();
      pushState(true);
      return { ok: true, results };
    });
}

module.exports = { installArknightsIpc };
