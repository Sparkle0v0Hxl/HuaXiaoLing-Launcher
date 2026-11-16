'use strict';

const { ipcMain, app, shell, dialog } = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const sophon = require('./sophon');
const installManager = require('./install-manager');
const predownload = require('./predownload');
const { createCancelSignal } = require('./cancel-signal');
// 渠道能力表：哪些游戏在哪些渠道支持 link/repair/update/predownload 全在这里定义，
// 不要在下面各 handler 里再写死渠道数组（用户 2026-11-16 定的规则）。
const gameChannels = require('./game-channels');

/*
 * 渠道体检（2026-11-16 报障）：只有这几款米哈游游戏的客户端目录里带 config.ini
 * （或者 exe 名本身能区分 YuanShen.exe / GenshinImpact.exe），判出来的渠道才可信。
 * 终末地 play/steam、方舟 global-en/global-jp/taiwan 这些渠道 key 与 ini 判定不同名，
 * 一律不参与体检，免得把正常的配置误报成「指错了目录」。
 */
const MIHOYO_CHANNEL_KEYS = ['genshin', 'starrail', 'zzz', 'bh3'];
const CHANNEL_PROBE_KEYS = ['official', 'bilibili', 'global'];

/**
 * 服务器/渠道管理：增删改、硬链接、端末地运行时、渠道包、Sophon 增量。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC，改一处要在万字里找位置）。搬运时逻辑未改。
 *
 * 这些 handler 在原来的文件里被 games / predownload / endfield 的 handler 穿插，
 * 所以是按名字逐个挑出来的，不是连续区间。
 */

function installServersIpc(ctx) {
  const { getStore, getRunning, getLaunching, getLinkJobs, getLinkTrees, ENDFIELD_PACK_NAMES, applyHdiffPrepass, beginBackgroundTask, endBackgroundTask, buildEndfieldChannelRuntime, ensureEndfieldChannelRuntime, ensureArknightsRuntime, ensureKuroRuntime, channelPackNeededFor, channelPackStatus, clientChannel, currentElevation, detectGame, externalLinkSources, isEndfieldLegacyWorkRoot, pushState, send, sendProgress, targetExists, writeLaunchLog, storyResourcesEnabled, syncOfficialGame } = ctx;
  /*
   * 下面这批是从 main.js 顶层直接传进来的（函数提升 / require 的常量）。
   * 之前它们没进 ctx，于是调用到这些 IPC 时就 ReferenceError —— 例如
   * servers:uninstall 会撞上 fsp 未定义，servers:link-* 会撞上 resolveLinkRoots。
   */
  const {
    fsp, ensureServers, publicGame, pruneStaleRunning, runtimePaths, sophonJobs,
    prepareSophon, prepareBilibiliRuntime, prepareGenshinPackRuntime,
    yostarPacks, kuroPacks, linkTrees, previewTrees,
    findSevenZip, downloadAndExtractSplit, updateEndfieldGame,
    // 同一批漏掉的其余依赖
    resetServerState, refreshPredownloadAfterSwitch, resolveLinkRoots,
    prepareEndfieldRuntimeJob, prepareArknightsRuntimeJob, estimateRuntimeSpace,
    probeUpdateWritable, invalidateRuntimesAfterUpdate,
    serverForDownload, engineFor, estimateDownloadBytes,
    driveFreeBytes, assertDirWritable, downloadPackProfile,
    launching,
    // 这两个在 main.js 里声明在 installIpc() 后半段，按值传会踩 TDZ，只能现取
    getDownloadableKeys, getUninstallPlan,
  } = ctx;

  /* 支持一键下载的内置游戏 → 下载引擎（声明在 main.js 后半段，getter 现取） */
  const DOWNLOADABLE_KEYS = () => (typeof getDownloadableKeys === 'function' ? getDownloadableKeys() || {} : {});
  const uninstallPlan = (...args) => {
    if (typeof getUninstallPlan === 'function') {
      const fn = getUninstallPlan();
      if (typeof fn === 'function') return fn(...args);
    }
    return null;
  };

    ipcMain.handle('servers:channel-pack-plan', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      const server = game && (game.servers || []).find((item) => item.id === input?.serverId);
      if (!game || !server) return { needed: false };
      const need = channelPackNeededFor(game, server);
      if (!need) return { needed: false };
      const status = await channelPackStatus(need.game, need.channel);
      if (status.ready) return { needed: false, ready: true };
      return { needed: true, ...status, serverName: server.name };
    });

    ipcMain.handle('servers:add', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      const serverPath = String(input?.path || '').trim();
      if (!serverPath || !targetExists(serverPath)) throw new Error('请选择一个存在的启动程序');
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(serverPath)) throw new Error('服务器配置需要一个本地启动程序');
      if (!Array.isArray(game.servers)) game.servers = [];
      const name = String(input?.name || '').trim().slice(0, 40) || `服务器 ${game.servers.length + 1}`;
      const serverRoot = String(input?.root || '').trim();
      if (serverRoot) {
        let rootStat;
        try { rootStat = fs.statSync(serverRoot); } catch {}
        if (!rootStat || !rootStat.isDirectory()) throw new Error('自定义根目录不存在，请重新选择');
      }
      const server = {
        id: crypto.randomUUID(),
        name,
        channel: 'custom',
        path: serverPath,
        root: serverRoot || path.dirname(serverPath),
        addedAt: new Date().toISOString(),
      };
      game.servers.push(server);
      if (!game.activeServerId) game.activeServerId = server.id;
      ensureServers(game);
      await getStore().saveNow();
      pushState(true);
      return publicGame(game);
    });

    ipcMain.handle('servers:update', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      const server = game.servers.find((item) => item.id === input?.serverId);
      if (!server) throw new Error('没有找到这个服务器');
      const prevPath = server.path;
      const prevRoot = server.root;
      server.name = String(input?.name || '').trim().slice(0, 40) || server.name;
      const serverPath = String(input?.path || '').trim();
      if (serverPath) {
        if (!targetExists(serverPath)) throw new Error('这个启动程序不存在');
        server.path = serverPath;
        server.confirmed = true;
        // 用户手动指定了有效启动程序：它就是一个可用的客户端，不再视为「需要重建」。
        server.incomplete = false;
        server.unavailable = false;
        if (server.packPath === server.path) server.packPath = '';
      }
      const serverRoot = String(input?.root || '').trim();
      if (serverRoot) {
        let rootStat;
        try { rootStat = fs.statSync(serverRoot); } catch {}
        if (!rootStat || !rootStat.isDirectory()) throw new Error('自定义根目录不存在，请重新选择');
        server.root = serverRoot;
      } else if (serverPath) {
        server.root = path.dirname(serverPath);
      }
      if (game.activeServerId === server.id && server.path) {
        game.target = server.path;
        game.workDir = server.root;
      }
      // 换了安装目录/启动程序，旧渠道的预下载状态不能再挂到新目录上（切服假状态）。
      if (prevPath !== server.path || prevRoot !== server.root) server.predownload = null;
      ensureServers(game);
      await getStore().saveNow();
      pushState(true);
      return publicGame(game);
    });

    ipcMain.handle('servers:clear-path', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再修改服务器');
      const server = game.servers.find((item) => item.id === input?.serverId);
      if (!server) throw new Error('没有找到这个服务器');
      resetServerState(server);
      ensureServers(game);
      await getStore().saveNow();
      pushState(true);
      return publicGame(game);
    });

    ipcMain.handle('servers:remove', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再修改服务器');
      const target = game.servers.find((item) => item.id === input?.serverId);
      if (target?.builtinServer || game.builtin) {
        if (!target) throw new Error('没有找到这个服务器');
        resetServerState(target);
        await getStore().saveNow();
        pushState(true);
        return publicGame(game);
      }
      if (game.servers.length <= 1) throw new Error('至少保留一个服务器配置');
      game.servers = game.servers.filter((server) => server.id !== input?.serverId);
      if (!game.servers.some((server) => server.id === game.activeServerId)) {
        game.activeServerId = game.servers[0]?.id || null;
      }
      ensureServers(game);
      await getStore().saveNow();
      pushState(true);
      return publicGame(game);
    });

    ipcMain.handle('servers:activate', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再切换服务器');
      const server = game.servers.find((item) => item.id === input?.serverId);
      if (!server) throw new Error('没有找到这个服务器');
      // 鸣潮：这个渠道还没配置启动程序时，允许先由 ensureKuroRuntime 生成一份硬链接
      // 运行时（用户 m29011「未配置，点开才是出来选项，然后点硬链接生成的」）。
      const kuroCanGenerate =
        game.builtinKey === 'wutheringwaves' &&
        ['official', 'bilibili'].includes(String(server.channel || '')) &&
        !targetExists(server.path);
      if (server.incomplete && game.builtinKey !== 'endfield' && !kuroCanGenerate) {
        throw new Error('这个目录是资源替换包，不是完整客户端；请点这一行的下载按钮生成国际服客户端');
      }
      if (!server.path || !targetExists(server.path)) {
        if (game.builtinKey !== 'endfield' && !kuroCanGenerate) {
          throw new Error('这个服务器还没有配置启动程序，先点“编辑”选择客户端');
        }
      }
      if (game.builtinKey === 'genshin' && server.channel === 'global') {
        /*
         * 生成国际服运行时可能要搬几十 GB：以前这里不传 onProgress，用户点「切换」
         * 只看到一个不动的转圈。现在照终末地那条路把进度发到同一个频道，
         * 界面上现有的切换提示条就能显示「百分比 + 已处理/总量 + 速度」。
         */
        const prepared = await prepareGenshinPackRuntime(game, server, (progress) =>
          send('endfield:progress', { ...progress, serverName: server.name })
        );
        if (prepared) {
          server.path = prepared.executable;
          server.root = prepared.runtimeRoot;
          server.runtimeLinked = true;
        }
      }
      if (game.builtinKey === 'endfield') {
        // 有可用路径时保持“尽力而为”：渠道包/基础客户端缺失不阻断已就绪服务器的切换；
        // 没有任何路径时才把自动生成的错误抛给用户看。
        // 旧单 work 混合目录绝不能算「已就绪、可以静默沿用」：它正是 B服 6 秒崩
        // 的配方。即使迁移没覆盖到的历史数据残留了指向它的路径，这里也要当作
        // 没有可用路径，让重建失败显式报错，而不是被「尽力而为」吞掉又启动旧目录。
        const hadPath =
          server.path &&
          targetExists(server.path) &&
          !isEndfieldLegacyWorkRoot(path.dirname(server.path));
        // 切服是「官服删了」最常走的入口：只剩运行时可用时必须能建
        const prepared = await ensureEndfieldChannelRuntime(game, server, { allowRuntimeBase: true }).catch((error) => {
          if (hadPath) return null;
          throw error;
        });
        if (prepared) {
          server.path = prepared.launchPath;
          server.root = prepared.runtimeRoot;
          // 官服直启自己客户端、没有生成独立运行时时不贴「差异运行时」标签
          server.runtimeLinked = !prepared.directBase;
        }
      }
      // 明日方舟（2.4.0 合并）：官服 / B服 在同一套安装目录里，按终末地那套运行时
      // 方案复制出独立目录，大文件硬链接、渠道 SDK 换成目标服的。缺 B服 载荷时直接抛错。
      if (game.builtinKey === 'arknights') {
        // 同上：方舟硬链接运行时也要报进度，否则切服时界面一动不动
        await ensureArknightsRuntime(game, server, {
          onProgress: (progress) => send('endfield:progress', { ...progress, serverName: server.name }),
        });
      }
      // 鸣潮：官服 ↔ B服 互为源硬链接切服（99.24% 内容相同，实测切服只下约 1.3GiB）。
      // 国际服渠道不做互切（与国服 pak 全不同），ensureKuroRuntime 里直接原样返回。
      if (game.builtinKey === 'wutheringwaves') {
        await ensureKuroRuntime(game, server, {
          onProgress: (progress) => send('endfield:progress', { ...progress, serverName: server.name }),
        });
      }
      /*
       * 版本号跟着当前客户端走。以前它是「一个游戏一个」，官服更到 7.2 再切到还是 7.1
       * 的国际服，启动页仍写着 v7.2 —— 看着像切了个假服。以目标客户端 config.ini
       * 为准重读一次；读不出来（非米哈游客户端 / 没这份 ini）就保持原值不动。
       */
      const clientVersion = clientChannel.gameVersionFromPath(server.path);
      if (clientVersion) {
        game.version = clientVersion;
        game.versionName = clientVersion;
      }
      /*
       * 切服后的渠道体检（同一桩 2026-11-16 报障：原神 官服 ↔ 国际服）。
       *
       * 这一行声明的渠道 vs 目标客户端自己声明的渠道。不一致说明这一行的路径指到了
       * 另一个服的客户端：两边账号态不在同一处，切过去就会看到「上次登录退回到很久以前、
       * 还要重新登录」。不阻断切换（用户可能就是想把这一行改指向别的目录），
       * 但必须落日志 + 说明白，否则下次还是只能猜。
       *
       * 只体检米哈游四款、只认 official/bilibili/global 三个 key：
       * 其它游戏的渠道 key 与 ini/目录名判定不同名，硬比会误报。
       */
      try {
        const chosenChannel = String(server.channel || '');
        const iniChannel = clientChannel.configChannelFromPath(server.path) || '';
        const hintChannel = clientChannel.pathChannelHint(server.path) || '';
        const actualChannel = iniChannel || hintChannel;
        const mismatch =
          MIHOYO_CHANNEL_KEYS.indexOf(game.builtinKey) >= 0 &&
          CHANNEL_PROBE_KEYS.indexOf(chosenChannel) >= 0 &&
          Boolean(actualChannel) &&
          chosenChannel !== actualChannel;
        writeLaunchLog(
          `activate ${game.id}: ${server.name || server.id} chosen=${chosenChannel || '-'} ` +
            `ini=${iniChannel || '-'} hint=${hintChannel || '-'}` +
            (mismatch ? ` MISMATCH actual=${actualChannel}` : '')
        );
        if (mismatch) {
          send('toast', {
            type: 'error',
            message:
              `「${server.name || '这一行'}」标的是${clientChannel.channelLabel(chosenChannel)}，` +
              `但那个目录里是${clientChannel.channelLabel(actualChannel)}客户端 —— ` +
              '切过去账号会串到另一个服（表现为登录记录退回、要重新登录）。请点“编辑”重新选目录。',
          });
        }
      } catch {
        /* 体检不许影响切换 */
      }
      /*
       * 切成功了：记下「用过切服」，并在这个用户还没表过态（null）时把对应游戏的
       * 渠道包自动更新打开。两个游戏各一个开关：只切过终末地的人，不该被顺手打开
       * 明日方舟那条。手动关掉的（false）保持关着 —— 用户明确表过态就不替他改。
       */
      getStore().data.settings.hasSwitchedServer = true;
      if (game.builtinKey === 'arknights') {
        if (getStore().data.settings.autoUpdateArknightsPacks == null) {
          getStore().data.settings.autoUpdateArknightsPacks = true;
        }
      } else if (getStore().data.settings.autoUpdateEndfieldPacks == null) {
        getStore().data.settings.autoUpdateEndfieldPacks = true;
      }
      game.activeServerId = server.id;
      game.target = server.path;
      game.workDir = server.root || path.dirname(server.path);
      await getStore().saveNow();
      pushState(true);
      /*
       * 切完再问一次这个渠道有没有更新（不阻塞返回，界面先切过去）。
       * 以前这一步要等 30 分钟的自动检查，切到落后的那个服时按钮不会变「更新游戏」。
       */
      setTimeout(() => {
        refreshPredownloadAfterSwitch(game).catch(() => {});
      }, 400);
      return publicGame(game);
    });

    ipcMain.handle('servers:link', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再建立硬链接');

      // 检测与执行共用同一套根目录解析
      const { sourceRoot, targetRoot, sourceName, targetName } = resolveLinkRoots(game, input);

      const jobId = crypto.randomUUID();
      const signal = createCancelSignal();
      getLinkJobs().set(jobId, signal);
      send('link:progress', {
        jobId,
        gameId: game.id,
        phase: 'scan',
        processed: 0,
        total: 0,
        linked: 0,
        savedBytes: 0,
        skipped: 0,
        current: '正在扫描两个客户端…',
      });

      try {
        const result = await linkTrees({
          sourceRoot,
          targetRoot,
          mode: input?.mode === 'fast' ? 'fast' : 'full',
          signal,
          onProgress: (progress) => {
            /*
             * 硬链接也走计量器（sendProgress）：这条链路以前只发 processed/total 文件数，
             * 面板三行里的「下载」行就拿不到字节量，只会在硬链接生成时显示一行干巴巴的文字。
             * link.js 现在已经按目标文件大小累加 bytesDone/totalBytes，这里补上速度与剩余时间。
             */
            sendProgress('link:progress', jobId, {
              gameId: game.id,
              ...progress,
              sourceName,
              targetName,
            });
          },
        });
        send('link:done', { jobId, gameId: game.id, ...result });
        return { ok: true, jobId, ...result };
      } catch (error) {
        send('link:done', { jobId, gameId: game.id, ok: false, error: error.message });
        throw error;
      } finally {
        getLinkJobs().delete(jobId);
      }
    });

    ipcMain.handle('servers:link-preview', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再检测');
      const { sourceRoot, targetRoot, sourceName, targetName } = resolveLinkRoots(game, input);

      const jobId = crypto.randomUUID();
      const signal = createCancelSignal();
      getLinkJobs().set(jobId, signal);
      const sendPreview = (payload) => send('link:preview-progress', { jobId, gameId: game.id, sourceName, targetName, ...payload });

      try {
        const result = await previewTrees({
          sourceRoot,
          targetRoot,
          mode: input?.mode === 'fast' ? 'fast' : 'full',
          signal,
          onProgress: sendPreview,
        });
        send('link:preview-done', { jobId, gameId: game.id, ...result });
        return { ok: true, jobId, ...result };
      } catch (error) {
        send('link:preview-done', { jobId, gameId: game.id, ok: false, error: error.message });
        throw error;
      } finally {
        getLinkJobs().delete(jobId);
      }
    });

    ipcMain.handle('servers:prepare-endfield', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game || game.builtinKey !== 'endfield') throw new Error('这个功能只用于明日方舟：终末地');
      if (await pruneStaleRunning()) pushState(true);
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再切换服务器');
      const server = game.servers.find((item) => item.id === input?.serverId);
      if (!server) throw new Error('没有找到这个服务器');
      if (server.channel === 'official') throw new Error('官服请直接指定官服客户端');

      if (!ENDFIELD_PACK_NAMES[server.channel]) throw new Error('这个服务器没有对应的渠道差异包');

      // 渠道包缺失时会在 ensureEndfieldChannelRuntime 里现下（它自己调
      // ensureEndfieldPackFor），这里不再重复准备一遍。
      // 基础客户端的挑选、每渠道运行时目录的位置与重叠校验，也全部在那边统一做
      // —— 它本来就是「启动游戏」时走的那条路，两条路合一才不会慢慢走偏。
      /*
       * 手动「重新生成」传 forceRuntime:true，强制从最新官服本体整树重建该渠道的
       * 独立运行时；buildEndfieldChannelRuntime 会把旧目录的 Endfield_Data\Persistent
       * （用户下好的语音包 + 游戏自己维护的索引）整体搬到 staging 再就位，不会丢下载内容。
       */
      try {
        const result = await ensureEndfieldChannelRuntime(game, server, {
          runtimeRoot: input?.runtimeRoot,
          forceRuntime: true,
          allowRuntimeBase: true,
        });
        ensureServers(game);
        await getStore().saveNow();
        pushState(true);
        return {
          ok: true,
          runtimeRoot: result.runtimeRoot,
          path: result.launchPath,
          linked: result.linked || 0,
          overlay: result.overlay || 0,
          packDownloaded: result.packDownloaded || false,
        };
      } catch (error) {
        pushState(true);
        throw error;
      }
    });

    ipcMain.handle('servers:prepare-sophon', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      if (game.builtinKey === 'endfield') return prepareEndfieldRuntimeJob(game, input);
      if (game.builtinKey === 'arknights') return prepareArknightsRuntimeJob(game, input);
      /*
       * 崩坏3 也要能「生成差异客户端」：用户 2026-11-16 定的规则是崩坏3 的 link（硬链接）
       * 对 official / bilibili / global 三个渠道全开 —— 硬链接只是本地文件操作，
       * 不依赖官方远端清单，所以不必像 download/update 那样限死在官服。
       */
      if (!['genshin', 'starrail', 'zzz', 'bh3'].includes(game.builtinKey)) {
        throw new Error('这个游戏没有接入 Sophon 清单');
      }
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再准备服务器');
      const server = game.servers.find((item) => item.id === input?.serverId);
      if (!server) throw new Error('没有找到这个服务器');
      /*
       * 渠道判据统一从 game-channels.js 的能力表拿，不再在这里写死 official/bilibili/global：
       * 用户 2026-11-16 定的规则里，「生成差异客户端」这件事其实同时要求两件事，缺一不可：
       *   1. link     —— 要把基础客户端里的同内容文件硬链接过去（本地文件操作，所以崩坏3 三渠道全开）；
       *   2. download —— 剩下的差异分块只能从**该渠道自己的**官方 CDN 清单拉，没有清单就下不到东西。
       * 只看 link 是不够的：崩坏3 的 link 三渠道全开，但官方 HoYoPlay 只给 bh3_cn 清单
       * （见 game-channels.js 里 bh3 的注释），B服 / 国际服的差异分块根本无处可下。
       * 不加 download 这一条的话，崩坏3 B服 会一路走到 prepareSophon 内部，
       * 再被 CHANNELS 守卫拦成一句「这个服务器没有 Sophon 清单」—— 对用户毫无指向性。
       * 两句用同一个错误文案，界面和文档都按这句话写过。
       */
      if (!gameChannels.can(game.builtinKey, server.channel, 'link')) {
        throw new Error('这个渠道暂时不支持生成差异客户端');
      }
      if (!gameChannels.can(game.builtinKey, server.channel, 'download')) {
        throw new Error('这个渠道暂时不支持生成差异客户端');
      }
      // 基础客户端优先取官服、其次 B服（都是国服系，本地分块能复用得最多），
      // 只装了国际服的玩家用国际服当基础也能生成，只是复用率略低。
      const base =
        game.servers.find(
          (item) => item.id !== server.id && item.channel === 'official' && item.path && targetExists(item.path)
        ) ||
        game.servers.find(
          (item) => item.id !== server.id && item.channel === 'bilibili' && item.path && targetExists(item.path)
        ) ||
        game.servers.find((item) => item.id !== server.id && item.path && item.root && targetExists(item.path));
      if (!base || !base.root) {
        throw new Error(
          '没有找到可以当作基础的客户端。生成国际服 / B服 需要一份已安装的客户端当基础：请先在任意一服那一行点“编辑”选择已经装好的客户端（官服、国际服或 B服 都行）。'
        );
      }

      // 基础客户端和目标目录重合时，生成过程会把基础客户端本身清空，必须先拦住。
      const runtime = runtimePaths(base.root, game.builtinKey, server.channel, input?.runtimeRoot);
      if (!runtime.sameDrive) {
        throw new Error(`运行时目录必须和基础客户端在同一个磁盘（${runtime.baseDrive}），请在设置里修改“运行时目录”`);
      }
      const targetRoot = runtime.target;
      if (path.resolve(base.root).toLowerCase() === path.resolve(targetRoot).toLowerCase()) {
        throw new Error('运行时目录不能和基础客户端是同一个目录，请换个“运行时目录”再试');
      }

      /*
       * 只做预估，不真跑：界面里先告诉用户目标盘还剩多少、基础客户端有多大，
       * 免得跑到一半才发现空间不够。只读本地信息，不走网络。
       */
      if (input?.estimate) {
        return estimateRuntimeSpace(base.root, targetRoot);
      }

      const jobId = String(input?.jobId || crypto.randomUUID());
      const signal = createCancelSignal();
      sophonJobs.set(jobId, signal);
      beginBackgroundTask();
      send('sophon:progress', {
        jobId,
        phase: 'start',
        current: '正在读取官方清单…',
        processed: 0,
        total: 0,
      });
      try {
        /*
         * 崩坏3 不能走 prepareBilibiliRuntime：那条路最后要读 CHANNELS[gameKey].bilibili
         * 装渠道 SDK 并改写 config.ini，而 sophon.js 的 CHANNELS.bh3 只有 official 一项
         * （HoYoPlay 体系里没有崩坏3 B服），走进去就是 undefined.bilibili 直接崩。
         * 用户 2026-11-16 的规则是崩坏3 的 link（硬链接）三渠道全开，但 download/update
         * 只官服 —— 所以崩坏3 的 B服 / 国际服只做本地文件层面的生成，落到 prepareSophon 分支，
         * 由它自己的清单守卫给出明确报错，而不是在这里伪造渠道 SDK。
         */
        const result =
          server.channel === 'bilibili' && base.channel === 'official' && game.builtinKey !== 'bh3'
            ? await prepareBilibiliRuntime({
                gameKey: game.builtinKey,
                baseRoot: base.root,
                targetRoot,
                cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
                signal,
                onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
              })
            : await prepareSophon({
                gameKey: game.builtinKey,
                channel: server.channel,
                baseRoot: base.root,
                targetRoot,
                // 除了当基础的那份，其它渠道客户端里也有大量同内容文件，一并拿来硬链接
                linkSources: externalLinkSources(game, server, targetRoot),
                cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
                audioLanguages: getStore().data?.settings?.audioLanguages,
                // 绝区零那 111 份分类剧情资源（约 19.73GB）要不要一起装。默认不装。
                includeStoryResources: storyResourcesEnabled(game, server),
                signal,
                onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
              });
        if (signal.cancelled) return { ok: false, cancelled: true };
        if (!result.executable) throw new Error('清单安装完成，但没有找到游戏启动程序');
        server.path = result.executable;
        server.root = targetRoot;
        server.sophonVersion = result.tag;
        server.incomplete = false;
        server.packPath = '';
        game.activeServerId = server.id;
        game.target = result.executable;
        game.workDir = targetRoot;
        ensureServers(game);
        await getStore().saveNow();
        pushState(true);
        send('sophon:progress', {
          jobId,
          phase: 'done',
          processed: result.files,
          total: result.files,
          linked: result.linked,
          downloaded: result.downloaded,
          bytesDone: result.totalBytes,
          totalBytes: result.totalBytes,
          current: '完成',
        });
        return { ok: true, ...result };
      } finally {
        endBackgroundTask();
        sophonJobs.delete(jobId);
      }
    });

    ipcMain.handle('servers:update-sophon', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game || !['genshin', 'starrail', 'zzz', 'bh3'].includes(game.builtinKey)) {
        throw new Error('这个游戏没有接入 Sophon 更新');
      }
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再更新');
      const server = game.servers.find((item) => item.id === input?.serverId);
      if (!server || !server.root || !server.path || !targetExists(server.path)) {
        throw new Error('这个服务器还没有可更新的客户端');
      }
      /*
       * 渠道判据交给能力表的 update 能力，不再写死「bh3 只认 official」。
       * 用户 2026-11-16 定的规则：原神 / 星铁 / 绝区零三渠道都能更新（官方 HoYoPlay
       * 对 hk4e / hkrpg / nap 都发 *_global 清单，已实网验证）；崩坏3 的 download/update
       * 只官服 —— 因为官方 HoYoPlay 只给 bh3_cn 清单，B服 / 国际服的本体得用对应官方启动器。
       * 崩坏3 保留原来那句专属文案，其它游戏给通用文案，方便用户直接看懂该去哪儿更新。
       */
      if (server.channel && !gameChannels.can(game.builtinKey, server.channel, 'update')) {
        if (game.builtinKey === 'bh3') {
          throw new Error('崩坏3 本体更新仅支持官服（B服 / 国际服请使用对应官方启动器）');
        }
        throw new Error(
          `${game.name || '这个游戏'}的${clientChannel.channelLabel(server.channel)}没有官方 Sophon 更新清单，请用对应官方启动器更新`
        );
      }
      /*
       * 动手之前先探一下「这个目录到底让不让我们写」。
       *
       * 不探的话，权限问题会在下载完几十 GB、开始替换文件的那一刻才爆出来，报错还被
       * Node 说成「文件被其它程序占用」，用户把所有程序都关掉也修不好（2026-11-11 报障）。
       * 预检只做只读探测（试建临时文件 + 试改名已有可执行文件再改回来），不删用户任何东西。
       *
       * 这里不自动提权：UAC 弹在开始之前是最佳时机，但由界面决定要不要弹 —— 主进程只把
       * 结论告诉界面，界面弹「以管理员身份重启并继续更新」，用户点了才走 app:relaunch-admin。
       */
      if (!currentElevation()) {
        const probe = await probeUpdateWritable(server.root);
        if (probe.blocked) {
          writeLaunchLog(`update ${game.id}: 写权限预检未过 → ${probe.reason}`);
          return {
            ok: false,
            code: 'NEED_ELEVATION',
            reason: probe.reason,
            root: server.root,
            gameId: game.id,
            serverId: server.id,
          };
        }
      }
      const jobId = String(input?.jobId || crypto.randomUUID());
      const signal = createCancelSignal();
      sophonJobs.set(jobId, signal);
      beginBackgroundTask();
      /*
       * 别的渠道客户端（官服 / B服 / 国际服）可以作为硬链接源：
       * 官方同一个构建产物的资源包逐字节相同，另一份已经更新过的话，
       * 这次更新只需要链接、不需要为同一份内容再下一次。
       */
      const linkSources = externalLinkSources(game, server, server.root);
      if (linkSources.length) {
        writeLaunchLog(`update ${game.id}: 可用复用源 ${linkSources.length} 份 → ${linkSources.join(' ; ')}`);
      }
      /*
       * 更新时以「客户端自己声明的渠道」为准，不跟着服务器行的标签走。
       *
       * 行的 channel 是启动器推断/用户手选的，可能错配（比如 B服 那一行挂着官服客户端）；
       * 而 prepareSophon 收尾会用这个 channel 整份重写 config.ini ——
       * 只要标签错一次，就会把玩家的官服客户端改写成 B服，之后每次登录都要先弹一次
       * 「二级地址解析失败」再回退。config.ini 里读不到渠道时才回退到行标签。
       */
      const actualChannel =
        (server.channel !== 'custom' && clientChannel.configChannelFromPath(server.path)) || server.channel;
      if (actualChannel !== server.channel) {
        writeLaunchLog(
          `update ${game.id}: 行标签 ${server.channel} 与客户端实际渠道 ${actualChannel} 不一致，按客户端渠道更新`
        );
      }
      /*
       * 之前预下载过的话，产物就在这里吃掉：
       *   - 分块模式：chunk/ 里就是新版本的分块，命中的 0 流量，缺的才联网补；
       *   - 补丁模式：ldiff/ 里是官方给的差量补丁包，就地打比按块下省一半。
       * 两者都没有时两个判据都是 false，这里整段跳过，行为与原来完全一致。
       */
      if (
        predownload.hasCache({ gameKey: game.builtinKey, channel: actualChannel, installRoot: server.root }) ||
        predownload.hasPatchCache({ gameKey: game.builtinKey, channel: actualChannel, installRoot: server.root })
      ) {
        try {
          const appliedResult = await predownload.apply({
            gameKey: game.builtinKey,
            channel: actualChannel,
            installRoot: server.root,
            cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
            audioLanguages: getStore().data?.settings?.audioLanguages,
            includeCategory: storyResourcesEnabled(game, server),
            // 预下载产物 + 别的渠道客户端的同内容文件，两条路都能省掉下载
            linkSources,
            signal,
            onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
          });
          if (signal.cancelled) return { ok: false, cancelled: true };
          if (appliedResult?.ok) {
            server.predownload = null;
            game.version = appliedResult.tag;
            game.versionName = appliedResult.tag;
            game.lastOfficialSync = Date.now();
            if (game.activeServerId === server.id) {
              game.target = server.path;
              game.workDir = server.root;
            }
            await getStore().saveNow();
            pushState(true);
            syncOfficialGame(game, []).catch(() => {});
            send('sophon:progress', {
              jobId,
              phase: 'done',
              processed: appliedResult.files,
              total: appliedResult.files,
              linked: 0,
              downloaded: appliedResult.applied,
              skipped: appliedResult.skipped,
              current: `预下载内容已应用完成（复用分块 ${appliedResult.reusedChunks} 个）`,
            });
            // 预下载内容落进真实安装目录后，链接运行时要失效（与 predownload:apply 同一语义）
            invalidateRuntimesAfterUpdate(game);
            return { ok: true, ...appliedResult, patched: true, fromPredownload: true };
          }
        } catch (error) {
          writeLaunchLog(`update ${game.id}: predownload apply fallback: ${error.message}`);
        }
      }
      try {
        /*
         * ldiff 预修补：把「本地已有旧文件 + 官方给了本地版本补丁」的那批文件就地改成新内容。
         *
         * 它**不是**一次完整更新 —— 补丁清单只覆盖有差分的文件，没差分的文件不在清单里，
         * 所以绝不能像以前那样 patch 完就宣布更新完成（那会漏文件还报成功）。
         * 这里只当省钱预处理用，后面必须照常跑 prepareSophon 做最终校验：
         * 被这里改对的文件会走 quickFileMatches → skipped，其余走本地 chunk 复用 / 联网补下。
         *
         * 原神 7.0.0 → 7.1.0 实测：1151 个文件可修补；这些文件走 chunk 要下 37.26GB（压缩后、按
         * chunk id 去重），ldiff 补丁只要 9.32GB，省流 27.94GB（75.0%）。
         *
         * 判据与 Starward / Collapse 保持一致：**不看 enable_ldiff**。
         * 那两家一个只在 GameConfig 里声明了这个字段却从没读过（Starward），
         * 一个连字段都没解析（Collapse）；它们真正的判据是「补丁清单里有没有当前版本」，
         * 也就是下面 applyHdiffPrepass 内部按 diff_tags 判的那一步。
         * 官方配置说别用、但清单里确实给了你当前版本的补丁 —— 那这份补丁就是能用的。
         * 没给（崩坏3 这类真没补丁的）会在里面以 version-not-patchable 干净退出，
         * 不会白算一轮 md5：那一步在读完分支信息之后、扫盘之前。
         */
        let ldiff = null;
        try {
          const userEnabled = getStore().data?.settings?.enableLdiff !== false;
          if (userEnabled) {
            ldiff = await applyHdiffPrepass({
              gameKey: game.builtinKey,
              channel: actualChannel,
              installRoot: server.root,
              cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
              // 预下载时先存下的补丁包在这儿：命中就不用再下一遍
              patchRoot: path.join(server.root, 'ldiff'),
              audioLanguages: getStore().data?.settings?.audioLanguages,
              includeStory: storyResourcesEnabled(game, server),
              // 别的渠道已经更到目标版本时，这批文件直接硬链接，别去下增量补丁
              linkSources,
              signal,
              onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
            });
            if (ldiff?.ok && (ldiff.applied > 0 || ldiff.linked > 0)) {
              writeLaunchLog(
                `update ${game.id}: ldiff 修补 ${ldiff.applied} 个文件，` +
                  `硬链接复用 ${ldiff.linked || 0} 个，补丁 ${ldiff.patchBytes} 字节，省流 ${ldiff.saveBytes} 字节`
              );
            } else if (ldiff?.reason) {
              writeLaunchLog(`update ${game.id}: ldiff 跳过（${ldiff.reason}）`);
            }
          } else {
            writeLaunchLog(`update ${game.id}: 跳过 ldiff（用户在设置里关掉了），走纯 chunk`);
          }
        } catch (error) {
          writeLaunchLog(`update ${game.id}: ldiff 预处理失败，退回纯 chunk：${error.message}`);
        }
        if (signal.cancelled) return { ok: false, cancelled: true };
        const result = await prepareSophon({
          gameKey: game.builtinKey,
          // 同理：写回 config.ini 用的就是这个 channel，必须取客户端真实渠道
          channel: actualChannel,
          baseRoot: server.root,
          targetRoot: server.root,
          cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
          audioLanguages: getStore().data?.settings?.audioLanguages,
          // 必须和安装那条路径用同一个取值，否则会出现「安装时不装、一更新就补 19.73GB」
          includeStoryResources: storyResourcesEnabled(game, server),
          linkSources,
          signal,
          onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
        });
        if (signal.cancelled) return { ok: false, cancelled: true };
        if (result.externalLinked) {
          writeLaunchLog(
            `update ${game.id}: 从其它渠道客户端硬链接复用 ${result.externalLinked} 个文件（${(
              Number(result.externalBytes || 0) / 1024 ** 3
            ).toFixed(2)} GB），没走下载`
          );
        }
        if (game.activeServerId === server.id) {
          const exe = result.executable || server.path;
          game.target = exe;
          game.workDir = server.root;
          server.path = exe;
        }
        game.version = result.tag;
        game.versionName = result.tag;
        // 更新成功后同步服务器实际版本：以前只有「生成一份」会写这个字段，
        // 更新不写，本地更到 7.2 了服务器还挂着上次生成的 7.1.0
        server.sophonVersion = result.tag;
        game.lastOfficialSync = Date.now();
        await getStore().saveNow();
        pushState(true);
        // 本体文件被刷过，链接运行时若有标记也应失效（非终末地当前为 no-op）
        invalidateRuntimesAfterUpdate(game);
        syncOfficialGame(game, []).catch(() => {});
        // 把 ldiff 的战果带回去，界面上能显示「其中 N 个文件是本地补丁修好的，省流 X」。
        if (ldiff?.ok && ldiff.applied > 0) {
          return {
            ok: true,
            ...result,
            ldiff: {
              applied: ldiff.applied,
              failed: ldiff.failed,
              // 从别的渠道客户端硬链接过来的文件数：这批既没下补丁、也没走 chunk
              linked: ldiff.linked || 0,
              patchBytes: ldiff.patchBytes,
              saveBytes: ldiff.saveBytes,
              localVersion: ldiff.localVersion,
            },
          };
        }
        return { ok: true, ...result };
      } finally {
        endBackgroundTask();
        sophonJobs.delete(jobId);
      }
    });

    ipcMain.handle('servers:pause-sophon', async (_event, input) => {
      const job = sophonJobs.get(String(input?.jobId));
      if (!job) return false;
      job.paused = input?.paused === true;
      return true;
    });

    ipcMain.handle('servers:cancel-sophon', async (_event, jobId) => {
      const job = sophonJobs.get(String(jobId));
      if (!job) return false;
      job.cancelled = true;
      return true;
    });

    ipcMain.handle('servers:download-estimate', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      if (!DOWNLOADABLE_KEYS()[game.builtinKey]) throw new Error('这款游戏暂不支持自动下载，请前往官网下载安装');
      const installDir = path.resolve(String(input?.installDir || '').trim());
      if (!installDir || installDir === path.parse(installDir).root) {
        throw new Error('请先选择一个安装目录');
      }
      const server = serverForDownload(game, String(input?.channel || ''));
      const engine = engineFor(game.builtinKey, server.channel);
      if (!engine) throw new Error('这个渠道暂不支持自动下载，请前往官网下载安装');
      const summary = await estimateDownloadBytes(game, server, engine, installDir);
      return {
        ok: true,
        engine,
        ...summary,
        freeBytes: await driveFreeBytes(installDir),
        installDir,
      };
    });

    ipcMain.handle('servers:download-game', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到这个游戏');
      if (!DOWNLOADABLE_KEYS()[game.builtinKey]) throw new Error('这款游戏暂不支持自动下载，请前往官网下载安装');
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再下载');
      const server = serverForDownload(game, String(input?.channel || ''));
      const engine = engineFor(game.builtinKey, server.channel);
      if (!engine) throw new Error('这个渠道暂不支持自动下载，请前往官网下载安装');
      const installDir = path.resolve(String(input?.installDir || '').trim());
      if (!installDir || installDir === path.parse(installDir).root) {
        throw new Error('请先选择一个安装目录');
      }
      await assertDirWritable(installDir);

      const jobId = String(input?.jobId || crypto.randomUUID());
      const signal = createCancelSignal();
      // 信号登记进 sophonJobs：现有的 servers:pause-sophon / servers:cancel-sophon 直接生效
      sophonJobs.set(jobId, signal);
      beginBackgroundTask();
      send('sophon:progress', { jobId, phase: 'start', current: '正在读取官方清单…', processed: 0, total: 0 });
      try {
        /*
         * 同盘空间校验：全新安装要下整个客户端，剩余空间必须盖得住清单总大小。
         * 清单请求有缓存（sophon-cache / 接口本身很轻），多读一次不亏。
         */
        const summary = await estimateDownloadBytes(game, server, engine, installDir);
        const freeBytes = await driveFreeBytes(installDir);
        const needBytes = Number(summary.totalBytes) || 0;
        if (needBytes > 0 && freeBytes > 0 && freeBytes < needBytes) {
          throw new Error(
            `目标盘剩余空间不足：客户端约 ${(needBytes / 1024 ** 3).toFixed(1)} GB，` +
              `该盘只剩 ${(freeBytes / 1024 ** 3).toFixed(1)} GB，请换个安装目录或先清理空间`
          );
        }
        let executable = '';
        let version = String(summary.version || '');
        if (engine === 'sophon') {
          /*
           * 全新安装：baseRoot = targetRoot = 安装目录（空目录）。
           * prepareSophon 在两者同路径时跳过本地分块索引，所有文件按清单逐 chunk
           * 下载写盘并做 md5 校验 —— 本地基线相当于空清单，即完整下载。
           */
          const result = await prepareSophon({
            gameKey: game.builtinKey,
            channel: server.channel,
            baseRoot: installDir,
            targetRoot: installDir,
            cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
            audioLanguages: getStore().data?.settings?.audioLanguages,
            // 必须和安装 / 更新那条路径用同一个取值，否则口径不一致
            includeStoryResources: storyResourcesEnabled(game, server),
            signal,
            onProgress: (progress) => sendProgress('sophon:progress', jobId, progress),
          });
          executable = result.executable || '';
        } else if (engine === 'yostar') {
          /*
           * 明日方舟 EN / JP / KR：Yostar 自己的逐文件清单（CRC64 校验）。
           * 秒传 / 断点续传 / 断硬链接都在 yostarPacks.installGame 里做完了，
           * 这里只负责把进度翻成界面认识的那套 phase 字段。
           */
          const result = await yostarPacks.installGame({
            profile: server.channel,
            installRoot: installDir,
            signal,
            onProgress: (progress) => {
              const phase =
                progress.phase === 'download' ? 'download' : progress.phase === 'install' ? 'install' : 'manifest';
              send('sophon:progress', {
                jobId,
                phase,
                current: progress.current || '',
                processed: progress.processed || 0,
                total: progress.total || 0,
                bytesDone: progress.processed && progress.total && summary.totalBytes
                  ? Math.round((Number(summary.totalBytes) || 0) * (progress.processed / progress.total))
                  : 0,
                totalBytes: Number(summary.totalBytes) || 0,
              });
            },
          });
          executable = path.join(installDir, result.executable || 'Arknights.exe');
          version = String(result.version || version || '');
        } else if (engine === 'kuro') {
          /*
           * 鸣潮三渠道：库洛官方 index.json 逐文件 md5 清单。
           * 断点续传 / md5 校验 / 断硬链接都在 kuroPacks.installGame 里做完了，
           * 这里只负责把进度翻成界面认识的那套 phase 字段（与 yostar 分支同构）。
           */
          const result = await kuroPacks.installGame({
            profile: server.channel,
            installRoot: installDir,
            signal,
            onProgress: (progress) => {
              const phase =
                progress.phase === 'download' ? 'download' : progress.phase === 'install' ? 'install' : 'manifest';
              send('sophon:progress', {
                jobId,
                phase,
                current: progress.current || '',
                processed: progress.processed || 0,
                total: progress.total || 0,
                bytesDone: progress.bytesDone || 0,
                totalBytes: progress.totalBytes || Number(summary.totalBytes) || 0,
              });
            },
          });
          executable = path.join(installDir, result.executable || 'Client-Win64-Shipping.exe');
          version = String(result.version || version || '');
        } else {
          /*
           * 终末地 / 明日方舟：优先官方分卷整包 + 7z 解压（一卷连读 .002/.003）；
           * 没有 7-Zip 退回逐文件全量下载。渠道合法性在 downloadPackProfile 里先校验。
           */
          const packProfile = downloadPackProfile(game.builtinKey, server.channel);
          const packChannel = game.builtinKey === 'arknights' ? 'arknights' : server.channel;
          if (findSevenZip()) {
            await downloadAndExtractSplit({
              profile: packProfile,
              root: installDir,
              onProgress: (progress) => {
                if (progress.phase === 'download') {
                  // 分卷进度换算成和 sophon 一样的 processed/total 口径，前端进度条不用另写一套；
                  // 字节按整包体积线性折算，只为进度显示，不做精确承诺
                  const totalPacks = progress.total || 0;
                  const packIndex = progress.index || 0;
                  // 卷内进度（0~1）：几百 MB 的一卷要能看出在走，不能一卷一跳
                  const done = packIndex + (Number(progress.fraction) || 0);
                  send('sophon:progress', {
                    jobId,
                    phase: 'download',
                    processed: packIndex,
                    total: totalPacks,
                    bytesDone: totalPacks ? Math.round((Number(summary.totalBytes) || 0) * (done / totalPacks)) : 0,
                    totalBytes: Number(summary.totalBytes) || 0,
                    current: `下载分卷 ${packIndex} / ${totalPacks}`,
                  });
                } else if (progress.phase === 'extract') {
                  send('sophon:progress', {
                    jobId,
                    phase: 'install',
                    processed: 1,
                    total: 1,
                    bytesDone: 0,
                    totalBytes: 0,
                    current: '解压整包（7-Zip）…',
                  });
                }
              },
            });
          } else {
            send('sophon:progress', { jobId, phase: 'manifest', current: '没有找到 7-Zip，改用逐文件下载…' });
            await updateEndfieldGame({
              root: installDir,
              channel: packChannel,
              onProgress: (progress) =>
                send('sophon:progress', {
                  jobId,
                  phase: 'download',
                  processed: progress.processed || 0,
                  total: progress.total || 0,
                  bytesDone: progress.downloadedBytes || 0,
                  totalBytes: progress.totalBytes || 0,
                  current: progress.current || '',
                }),
            });
          }
          // 解压 / 下载完找启动程序；整包解出来的目录结构有出入时按检测注册表兜底
          const packExes =
            game.builtinKey === 'arknights'
              ? // 明日方舟整包根目录是 Arknights.exe，鹰角启动器子目录布局留给 detectGame 兜底
                ['Arknights.exe', path.join('games', 'Arknights Game', 'Arknights.exe')]
              : ['Endfield.exe', 'PlatformProcess.exe'];
          executable = packExes.map((name) => path.join(installDir, name)).find((file) => fs.existsSync(file)) || '';
          if (!executable) {
            const found = await detectGame(game.builtinKey);
            if (found) executable = found;
          }
        }
        if (signal.cancelled) return { ok: false, cancelled: true };
        if (!executable) throw new Error('下载完成，但没有找到游戏启动程序');
        // 写回服务器与游戏：收尾口径和 servers:prepare-sophon 保持一致
        server.path = executable;
        server.root = installDir;
        server.incomplete = false;
        server.unavailable = false;
        game.activeServerId = server.id;
        game.target = executable;
        game.workDir = installDir;
        if (version) {
          game.version = version;
          game.versionName = version;
          // 全新安装也要记服务器版本，否则这条服务器一直挂着空值
          if (engine === 'sophon') server.sophonVersion = version;
        }
        ensureServers(game);
        await getStore().saveNow();
        pushState(true);
        send('sophon:progress', {
          jobId,
          phase: 'done',
          processed: 1,
          total: 1,
          bytesDone: Number(summary.totalBytes) || 0,
          totalBytes: Number(summary.totalBytes) || 0,
          current: '下载完成',
        });
        return { ok: true, engine, version, path: executable, targetRoot: installDir };
      } finally {
        endBackgroundTask();
        sophonJobs.delete(jobId);
      }
    });

    ipcMain.handle('servers:cancel-link', async (_event, jobId) => {
      const job = getLinkJobs().get(jobId);
      if (!job) return false;
      job.cancelled = true;
      return true;
    });

    ipcMain.handle('servers:open-folder', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      const server = game?.servers.find((item) => item.id === input?.serverId);
      if (!server || !server.root) return false;
      await shell.openPath(server.root);
      return true;
    });

    ipcMain.handle('servers:uninstall-plan', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) return { ok: false, reason: '没有找到这个游戏' };
      const server = game.servers.find((item) => item.id === input?.serverId);
      if (!server) return { ok: false, reason: '没有找到这个服务器' };
      const plan = uninstallPlan(game, server);
      return { ...plan, running: getRunning().has(game.id) };
    });

    ipcMain.handle('servers:uninstall', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) return { ok: false, code: 'NOT_FOUND', reason: '没有找到这个游戏' };
      if (getRunning().has(game.id) || launching.has(game.id)) {
        return {
          ok: false,
          code: 'RUNNING',
          reason: '游戏正在运行，先关掉游戏再卸载客户端',
        };
      }
      const server = game.servers.find((item) => item.id === input?.serverId);
      if (!server) return { ok: false, code: 'NOT_FOUND', reason: '没有找到这个服务器' };
      const plan = uninstallPlan(game, server);
      if (!plan.ok) return { ok: false, code: plan.running ? 'RUNNING' : 'BLOCKED', reason: plan.reason };

      let moved = false;
      if (plan.exists) {
        if (input?.force === true) {
          // 二次确认过的永久删除：回收站用不了时的唯一出路
          try {
            await fsp.rm(plan.root, { recursive: true, force: true, maxRetries: 2 });
          } catch (error) {
            return {
              ok: false,
              code: 'OTHER',
              reason: `直接删除也没成功，可能有程序还占着这些文件：${String(
                error?.message || error || ''
              )}`,
              root: plan.root,
            };
          }
        } else {
          // 回收站而不是直接删：这一步之后用户还能在回收站里找回来
          try {
            await shell.trashItem(plan.root);
          } catch (error) {
            const raw = String(error?.message || error || '');
            if (/EBUSY|EPERM|EACCES|being used|正在使用|占用|locked/i.test(raw)) {
              return {
                ok: false,
                code: 'BUSY',
                // 别断言「被占用」：Windows 上「ACL 没给 DELETE 权限」和「文件被别的进程打开」
                // 在 Node 里都是 EPERM，靠错误码分不出来（2026-11-11 用户报障就是这个误判）。
                // 这里只把两种可能都摆出来，让用户按顺序排查。
                reason: `「${plan.root}」里的文件动不了：可能是游戏/更新器还开着（托盘里也退掉），也可能是这个目录的权限不够。完全退出后仍然不行，就用管理员身份重新打开启动器再试`,
                root: plan.root,
              };
            }
            /*
             * 剩下最常见的就是回收站本身用不了 —— 系统策略禁用、回收站损坏、
             * 或者目录在某个不支持回收站的卷上。这种情况允许改成永久删除。
             */
            return {
              ok: false,
              code: 'TRASH',
              reason: '系统回收站用不了，没法把文件挪进去（文件本身没动）',
              detail: raw,
              root: plan.root,
            };
          }
        }
        moved = true;
      }
      // 文件没了，路径记录也要跟着清：否则启动器还指着一个空目录
      resetServerState(server);
      ensureServers(game);
      await getStore().saveNow();
      pushState(true);
      return { ok: true, target: plan.root, moved, forced: input?.force === true };
    });
}

module.exports = { installServersIpc };
