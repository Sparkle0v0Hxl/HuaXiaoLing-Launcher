'use strict';

const { ipcMain, app, shell, dialog } = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const renderApi = require('./render-api');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const gameFeatures = require('./game-features');
const clientChannel = require('./client-channel');
const { createCancelSignal } = require('./cancel-signal');
// 渠道能力表：哪个游戏在哪个渠道能修 / 能更新 / 能硬链接，全在 game-channels.js 里定，
// 这里的 handler 只查表，不再自己写死渠道数组（用户 2026-11-16 定的规则）。
const gameChannels = require('./game-channels');

/**
 * 鸣潮客户端的「本体根」：主程序在 Client\Binaries\Win64 下（三层深），
 * 本体根由根目录的 launcherDownloadConfig.json 认定。老数据里 root 常被填成
 * exe 所在那一层，这里向上找回来（判据与 main.js 的 wuwaClientRootOf 一致）。
 */
function kuroClientRootOf(dirOrExe) {
  let dir = String(dirOrExe || '').trim();
  if (!dir) return '';
  if (path.extname(dir).toLowerCase() === '.exe') dir = path.dirname(dir);
  dir = path.normalize(dir);
  for (let depth = 0; depth < 5 && dir; depth += 1) {
    if (fs.existsSync(path.join(dir, 'launcherDownloadConfig.json'))) return dir;
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return '';
}

/*
 * 渠道体检（2026-11-16 报障）：只有这几款米哈游游戏的客户端目录里带 config.ini
 * （或者 exe 名本身能区分 YuanShen.exe / GenshinImpact.exe），判出来的渠道才可信。
 * 终末地 play/steam、方舟 global-en/global-jp/taiwan 这些渠道 key 与 ini 判定不同名，
 * 一律不参与体检，免得把正常的配置误报成「指错了目录」。
 */
const MIHOYO_CHANNEL_KEYS = ['genshin', 'starrail', 'zzz', 'bh3'];
const CHANNEL_PROBE_KEYS = ['official', 'bilibili', 'global'];

/**
 * 游戏增删改、封面、自动探测、启动停止、官网同步。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC，改一处要在万字里找位置）。搬运时逻辑未改。
 *
 * 这些 handler 在原来的文件里被 servers / predownload / dialog 的 handler 穿插，
 * 所以是按名字逐个挑出来的，不是连续区间。
 */

function installGamesIpc(ctx) {
  const { getStore, getRunning, getLaunching, pushState, send, detectServerExecutable, fetchAllGameNotices, syncAllOfficial, writeLaunchLog, targetExists, launchWithSignedParent, finishGame, killGame, markLaunched, updater, ensureServers, detectBuiltins, detectGame, clearRegistryCache } = ctx;
  /*
   * 下面这批是从 main.js 顶层直接传进来的（函数提升 / require 的常量）。
   * 拆分时漏掉过，导致 games:launch / games:update / games:detect 一调用就 ReferenceError。
   */
  const {
    fetchGameNotices, updateEndfieldGame, externalLinkSources, invalidateRuntimesAfterUpdate,
    yostarPacks, ARKNIGHTS_CN_CHANNELS, predownload, prepareSophon, storyResourcesEnabled,
    nevernessChannels, normalizeGame, publicGame, repairServerChannels, detectionChannel,
    serverForDetected, pruneStaleRunning, isEndfieldLegacyWorkRoot, WEGAME_LAUNCH_URI,
    ensureEndfieldChannelRuntime, launchPreflightNotice, findNteGame, findNteLauncher,
    listRunningImages, activateWindowByImage, clearNteLingeringLauncher, splitArgs,
    startWithShellExecute, spawn, trackGameProcess, autoClickNtePredownload, autoClickNteStart,
    wuwaLaunch,
  } = ctx;

    ipcMain.handle('game:notices', async (_event, gameId) => {
      const game = getStore().data.games.find((item) => item.id === gameId);
      if (!game?.builtinKey) return [];
      return fetchGameNotices(game.builtinKey);
    });
    ipcMain.handle('games:notices', async (_event, force = false) => fetchAllGameNotices(Boolean(force)));
    /*
     * 更新弹窗的配图：读缓存，需要时刷新。
     * 登录态和战绩共用一份，没登录米游社就返回空表，前端退回官网美术图。
     */

    ipcMain.handle('games:repair-game', async (_event, input) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game) throw new Error('没有找到该游戏');
      const server =
        game.servers.find((item) => item.id === input?.serverId) ||
        game.servers.find((item) => item.id === game.activeServerId) ||
        game.servers[0];
      if (!server?.root || !server.path || !targetExists(server.path)) {
        throw new Error('这个服务器还没有可修复的客户端');
      }
      if (getRunning().has(game.id)) throw new Error('游戏正在运行，先结束进程再修复');
      const key = game.builtinKey;
      if (key === 'endfield') {
        const result = await updateEndfieldGame({
          root: server.root,
          channel: server.channel,
          force: true,
          // 修复时整盘重扫，正是跨渠道复用收益最大的场景：同内容文件直接链，不用重下
          linkSources: externalLinkSources(game, server, server.root),
          onProgress: (progress) => send('repair:progress', progress),
        });
        // 逐文件 rm+rename 换了 inode，硬链接运行时镜像必须失效重建
        if (result?.ok && !result?.skipped) invalidateRuntimesAfterUpdate(game);
        return result;
      }
      if (key === 'arknights') {
        /*
         * 国际服（EN / JP / KR）：走 Yostar 自己的 updateGame 做全量校验补齐。
         * 那边没有「每个文件都能单独下」的公开接口 —— 官方只给整文件 CRC64 清单，
         * 所以修复就是「按清单对每个文件算 CRC64，不一致的重下」。allowDelete 传 false：
         * 修复的目的是补缺补坏，不该顺手删东西（删清单由「更新本体」那条链负责）。
         */
        if (yostarPacks.isYostarChannel(server.channel)) {
          const result = await yostarPacks.updateGame({
            profile: server.channel,
            installRoot: server.root,
            allowDelete: false,
            fullVerify: true,
            onProgress: (progress) => send('repair:progress', progress),
            /*
             * 修复时也复用同机别的方舟区（EN/JP/KR 三区互为源），
             * 同 CRC64 的文件硬链接过来，只下真缺的（2026-11-16 用户要求）。
             */
            linkSources: externalLinkSources(game, server, server.root),
          });
          if (result?.ok) {
            game.version = String(result.version || game.version || '');
            game.versionName = game.version;
            await getStore().saveNow();
            pushState(true);
          }
          return { ...result, repaired: true };
        }
        // 修复带 force:true 会整盘重扫、逐文件 in-place 覆盖；台服由第三个发行商发行、
        // 协议未验证，绝不能被国服全量清单刷坏。'arknights' 是国服清单专用哨兵值，保持原样不动。
        if (!ARKNIGHTS_CN_CHANNELS.includes(server.channel) && server.channel !== 'taiwan') {
          throw new Error('这个渠道暂不支持在此修复本体，请前往对应官网');
        }
        const result = await updateEndfieldGame({
          root: server.root,
          // 台服用自己的 Gryphline 清单
          channel: server.channel === 'taiwan' ? 'taiwan' : 'arknights',
          force: true,
          linkSources: externalLinkSources(game, server, server.root),
          onProgress: (progress) => send('repair:progress', progress),
        });
        if (result?.ok && !result?.skipped) invalidateRuntimesAfterUpdate(game);
        return result;
      }
      if (key === 'wutheringwaves') {
        /*
         * 鸣潮修复＝按线上 bundle 全量清单逐文件 size+md5 校验，缺的/坏的重下。
         * 绝不能再走 kuroPacks.updateGame 的 legacy 3.7.1 清单：那会把官方已经
         * 更到 3.8.0 的文件重新覆盖回旧版（审计 P0）。allowDelete 也由 bundle
         * 链内部的「只删官方 deleteFiles 且全部下载成功后才删」代替。
         */
        const result = await predownload.updateKuroGame({
          gameKey: 'wutheringwaves',
          channel: server.channel,
          installRoot: predownload.kuroInstallRoot(server),
          signal: new AbortController().signal,
          onProgress: (progress) => send('repair:progress', progress),
          /*
           * 修复也复用同机别的鸣潮客户端（同内容文件硬链接过来，只下缺的），
           * 2026-11-16 用户要求「没更新的服点更新可以直接硬链接补齐」。
           */
          linkSources: externalLinkSources(game, server, server.root),
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
        return { ...result, repaired: true };
      }
      if (['genshin', 'starrail', 'zzz', 'bh3'].includes(key)) {
        /*
         * 修复要重新拉官方清单校验分块，所以它跟「更新」一样受渠道限制，不能只看游戏。
         * 用户 2026-11-16 定的规则：原神 / 星铁 / 绝区零三渠道都能修（官方 HoYoPlay
         * 对 hk4e / hkrpg / nap 都发 *_global 清单）；崩坏3 2026-11-17 实测官服与
         * 国际服都有清单（国际服本体 game_id=5TIVvvcwtM，参考本机 Starward 源码），
         * B服查不到清单，所以 B服才会被下面这道闸拦下。
         * 硬链接（link）虽然三渠道全开，但那是本地文件操作，跟这里的远端校验不是一回事。
         */
        if (!gameChannels.can(key, server.channel, 'repair')) {
          const channelName = clientChannel.channelLabel(server.channel);
          throw new Error(
            `${game.name || '这个游戏'}的${channelName}没有官方修复清单，这个渠道不支持在启动器内修复，请用对应官方启动器`
          );
        }
        const signal = createCancelSignal();
        const result = await prepareSophon({
          gameKey: key,
          channel: server.channel,
          baseRoot: server.root,
          targetRoot: server.root,
          cacheDir: path.join(app.getPath('userData'), 'sophon-cache'),
          audioLanguages: getStore().data?.settings?.audioLanguages,
          includeStoryResources: storyResourcesEnabled(game, server),
          // 修复要查的是「中间分块坏掉」这类问题，只比首尾两块查不出来，必须整份校验
          verifyAll: true,
          signal,
          onProgress: (progress) => send('repair:progress', progress),
        });
        game.version = result.tag;
        game.versionName = result.tag;
        server.sophonVersion = result.tag;
        game.lastOfficialSync = Date.now();
        await getStore().saveNow();
        pushState(true);
        // 修复换了本体文件，链接运行时若有标记也应失效（非终末地当前为 no-op）
        invalidateRuntimesAfterUpdate(game);
        return { ok: true, version: result.tag, updated: result.files, root: server.root };
      }
      if (key === 'neverness') {
        const root = nevernessChannels.findConfigRoot(server?.root || server?.path || game.target || '');
        if (!root) throw new Error('没有找到异环安装目录，先在服务器设置里指好游戏路径');
        const launcher = path.join(root, 'NTELauncher.exe');
        if (!fs.existsSync(launcher)) throw new Error(`没有找到官方启动器：${launcher}`);
        const error = await shell.openPath(launcher);
        if (error) throw new Error(`官方启动器打开失败：${error}`);
        return { ok: true, official: true };
      }
      throw new Error('这个游戏暂不支持修复');
    });

    ipcMain.handle('games:add', async (_event, input) => {
      const game = normalizeGame(input);
      game.id = crypto.randomUUID();
      game.createdAt = new Date().toISOString();
      game.launchCount = 0;
      game.playSeconds = 0;
      game.lastPlayed = null;
      game.demo = false;
      ensureServers(game);
      getStore().data.games.unshift(game);
      await getStore().saveNow();
      pushState(true);
      return publicGame(game);
    });

    ipcMain.handle('games:update-cover', async (_event, id, cover) => {
      const game = getStore().data.games.find((item) => item.id === id);
      if (!game) throw new Error('没有找到这个游戏');
      const value = String(cover || '').trim();
      if (value && !fs.existsSync(path.join(app.getPath('userData'), value))) {
        throw new Error('封面文件不存在');
      }
      game.cover = value;
      await getStore().saveNow();
      pushState(true);
      return publicGame(game);
    });

    ipcMain.handle('games:update', async (_event, id, input) => {
      const index = getStore().data.games.findIndex((g) => g.id === id);
      if (index === -1) throw new Error('没有找到这个游戏');
      const current = getStore().data.games[index];
      const next = normalizeGame(input);
      /*
       * 调用方没提渲染后端就沿用原值。
       * 收藏、改名这些局部更新都会走这个 IPC，而 normalizeGame 对缺失字段给的是默认值，
       * 直接合并会把用户设好的 DX12 悄悄改回「跟随默认」——用户只会觉得「设了不生效」。
       */
      if (!input || input.renderApi === undefined) {
        next.renderApi = renderApi.normalizeMode(current.renderApi);
      }
      const merged = {
        ...current,
        ...next,
        demo: current.demo && !next.target ? current.demo : false,
        id,
      };
      if (next.target !== current.target) {
        const active =
          (merged.servers || []).find((server) => server.id === merged.activeServerId) ||
          (merged.servers || [])[0];
        if (active) {
          active.path = next.target || '';
          active.root = next.target ? path.dirname(next.target) : '';
        }
      }
      ensureServers(merged);
      getStore().data.games[index] = merged;
      await getStore().saveNow();
      pushState(true);
      return publicGame(merged);
    });

    ipcMain.handle('games:remove', async (_event, id) => {
      if (getRunning().has(id)) {
        await killGame(id);
      }
      const index = getStore().data.games.findIndex((g) => g.id === id);
      if (index === -1) return false;
      const [removed] = getStore().data.games.splice(index, 1);
      if (removed?.builtinKey) {
        getStore().data.hiddenBuiltins = Array.from(
          new Set([...(getStore().data.hiddenBuiltins || []), removed.builtinKey])
        );
      }
      if (removed && removed.cover && removed.cover.startsWith('covers/cover-')) {
        fsp.unlink(path.join(app.getPath('userData'), removed.cover)).catch(() => {});
      }
      await getStore().saveNow();
      pushState(true);
      return true;
    });

    ipcMain.handle('games:clear-demo', async () => {
      getStore().data.games = getStore().data.games.filter((g) => !g.demo);
      await getStore().saveNow();
      pushState(true);
      return true;
    });

    ipcMain.handle('games:detect', async (_event, id) => {
      const targets = id
        ? getStore().data.games.filter((game) => game.id === id)
        : getStore().data.games.filter((game) => game.builtin);
      if (!targets.length) {
        return { ok: false, error: '没有找到可以自动检测的游戏' };
      }
      /*
       * 先修历史错配，再检测。
       * 顺序很重要：老数据里「官服行 = 国际服客户端」时，先检测会把同一条路径
       * 也写进国际服行，两行指向同一个 exe，后面的修复就看不出该清哪一条了。
       * 先修能把路径搬回国际服行，检测再写一次也只是原地覆盖。
       */
      let repaired = await repairServerChannels();
      /*
       * 用户点「自动检测」= 明确要求重新扫一遍，先把注册表查询的进程内缓存清掉。
       * 不清的话上一次启动时没扫到（超时/游戏当时还没装）的负结果会一直挡着，
       * 用户会以为「检测按钮坏了」。启动路径上的 detectBuiltins 不清，那是省时间用的。
       */
      if (typeof clearRegistryCache === 'function') clearRegistryCache();
      const updated = [];
      for (const game of targets) {
        if (!game.builtinKey) continue;
        const found = await detectGame(game.builtinKey);
        if (found) {
          const active = (game.servers || []).find((server) => server.id === game.activeServerId);
          const activeHadPath = Boolean(active && active.path);
          // 同 detectBuiltins：写进真实渠道那一行，没有官服客户端时不再凭空占用官服行。
          const channel = await detectionChannel(game, found);
          // 留一行日志：以后用户再报「被识别成官服」，从 launch.log 就能看到判定结果与依据
          writeLaunchLog(`detect ${game.builtinKey}: ${channel || '未知'} ← ${found}`);
          const detected = serverForDetected(game, channel);
          if (detected) {
            /*
             * 2026-11-17 审查：这里是第四条写 server.path 的路，也是唯一没有占用检查的一条
             * （另外三处 main.js 的 discoverBuiltinServers / detectBuiltins 和本文件的
             *  games:detect-server 都有）。「自动检测」按钮走的就是这里 —— 只要官服目录的
             * config.ini 被第三方三服切换器改成 cps=bilibili，就会把官服路径写进 B服 行，
             * 又变回「两个渠道共用一个目录」。
             *
             * 所以照 detectBuiltins 的做法补两道：
             *   ① 非官服行的目标目录如果已经被别的渠道占到，就不写这一行；
             *   ② root 用本体根（鸣潮主程序在三层深，用 exe 目录会落到 Client\Binaries\Win64）。
             */
            const foundRoot = kuroClientRootOf(found) || path.dirname(found);
            const normTarget = String(foundRoot).replace(/[\\/]+$/, '').toLowerCase();
            const occupied = (game.servers || []).some((item) => {
              if (!item || item.id === detected.id || item.channel === detected.channel) return false;
              const other = String(item.root || '').replace(/[\\/]+$/, '').toLowerCase();
              if (!other) return false;
              return other === normTarget || other.startsWith(`${normTarget}\\`) || other.startsWith(`${normTarget}/`);
            });
            if (detected.channel !== 'official' && occupied) {
              writeLaunchLog(`detect ${game.builtinKey}: 扫到的目录已被别的渠道占用，不写入 ${detected.channel} 行 ← ${foundRoot}`);
            } else {
              detected.path = found;
              detected.root = foundRoot;
              detected.incomplete = false;
              detected.unavailable = false;
            }
          }
          if (detected && (!active || !activeHadPath)) {
            game.activeServerId = detected.id;
            game.target = found;
            game.workDir = path.dirname(found);
          }
          updated.push(game.name);
        }
      }
      // 检测完再扫一遍：discover 类逻辑可能又把路径写回了旧行
      repaired += await repairServerChannels();
      if (updated.length || repaired) {
        await getStore().saveNow();
        pushState(true);
      }
      if (!updated.length) {
        return {
          ok: false,
          error: id
            ? '没有自动找到安装位置，可以手动选择启动程序，或前往官网下载。'
            : '没有自动找到已安装的游戏，可以手动添加或前往官网下载。',
        };
      }
      return {
        ok: true,
        updated,
        path: id ? targets[0].target : null,
      };
    });

    ipcMain.handle('games:detect-server', async (_event, id, serverId) => {
      const game = getStore().data.games.find((item) => item.id === id);
      if (!game) return { ok: false, error: '没有找到这个游戏' };
      const server = (game.servers || []).find((item) => item.id === serverId);
      if (!server) return { ok: false, error: '没有找到这个服务器' };
      const found = await detectServerExecutable(game, server);
      if (!found) {
        return {
          ok: false,
          error: `没扫到${server.name}的客户端。它可能还没下载，或者装在非常规目录里 —— 可以手动选路径。`,
        };
      }
      /*
       * 2026-11-17（用户报障：「绝区零 B服和官服共用一个文件夹」）：
       * 非官服渠道不能和别的渠道共用同一个安装目录 —— 扫到的这个 exe 所在的目录
       * 如果已经被别的渠道行占了，就不写这一行，改成提示用户「硬链接生成一份」。
       *
       * 鸣潮要按「本体根」比：主程序在 Client\Binaries\Win64 下（三层深），
       * 本体根由根目录的 launcherDownloadConfig.json 认定。用 exe 目录比会
       * 把同一个本体根的两个渠道误判成「没占用」，也拦不住真冲突。
       */
      const foundRoot = kuroClientRootOf(found) || path.dirname(found);
      const target = String(foundRoot).replace(/[\\/]+$/, '').toLowerCase();
      const shared = (game.servers || []).some((item) => {
        if (!item || item.id === server.id || item.channel === server.channel) return false;
        const other = String(item.root || '').replace(/[\\/]+$/, '').toLowerCase();
        if (!other) return false;
        return other === target || other.startsWith(`${target}\\`) || other.startsWith(`${target}/`);
      });
      if (server.channel !== 'official' && shared) {
        return {
          ok: false,
          error: `扫到的${server.name}客户端和别的渠道装在同一个目录里（${foundRoot}）。每个渠道要一份独立目录，请点「硬链接生成一份」。`,
        };
      }
      server.path = found;
      // 鸣潮的本体根不是 exe 目录（主程序在 Client\Binaries\Win64 下），
      // 靠根目录的 launcherDownloadConfig.json 认。填 exeDir 会让「点更新」
      // 判成「不是库洛官方客户端」（2026-11-17 报障）。
      server.root = foundRoot;
      server.incomplete = false;
      server.unavailable = false;
      await getStore().saveNow();
      pushState(true);
      return { ok: true, path: found, name: server.name };
    });

    ipcMain.handle('games:sync-official', async () => syncAllOfficial());

    ipcMain.handle('games:launch', async (_event, id, options) => {
      const game = getStore().data.games.find((g) => g.id === id);
      if (!game) return { ok: false, error: '没有找到这个游戏' };
      /*
       * purpose 目前只有一个值：'predownload'（异环「打开官方预下载」）。
       * 这条路上的差别是：不刷新最近游玩、不自动点「开始游戏」，也绝不杀掉
       * 已经在跑的官方启动器（用户可能正靠它下载预下载资源）。
       */
      const purpose = options && typeof options === 'object' ? String(options.purpose || '') : '';
      // 先清掉已经不存在的进程，避免「点了没反应、只说游戏在运行」
      if (await pruneStaleRunning()) pushState(true);
      if (getRunning().has(id)) return { ok: false, error: '游戏已经在运行了' };
      if (getLaunching().has(id)) {
        return { ok: false, error: '正在启动中，请稍候…（如果弹出了管理员授权窗口，请点“是”）' };
      }

      let target = String(game.target || '').trim();
      const activeServer = (game.servers || []).find(
        (server) =>
          server.id === game.activeServerId &&
          server.path &&
          targetExists(server.path) &&
          // 旧单 work 混合目录绝不沿用：否则 allowPackDownload 会被关掉、
          // 重建失败又被「尽力而为」吞掉，最后静默启动那个 3~9 秒就崩的目录。
          !isEndfieldLegacyWorkRoot(path.dirname(server.path))
      );
      if (activeServer) {
        target = activeServer.path;
        game.target = activeServer.path;
        game.workDir = activeServer.root || path.dirname(activeServer.path);
      }
      /*
       * 鸣潮 WeGame 版不能用本地 exe 直接启动：缺 Rail 登录票据（rail_api64.dll
       * 的 FROM_WEGAME_LOGIN / railSessionTicket）与 ACE+TenProtect 环境，直接
       * spawn 会进不去游戏。必须走 URI 拉起 WeGame 客户端，由它完成票据注入
       * 再启动（_wegame-launch-research.md 一手结论）。server.path 仍存真实 exe
       * 供识别/状态判定用，这里只改启动目标；下面已有的 scheme 分支会接住它。
       */
      if (activeServer && activeServer.channel === 'wegame' && game.builtinKey === 'wutheringwaves') {
        target = WEGAME_LAUNCH_URI;
      }
      if (game.builtinKey === 'endfield' && !getRunning().has(id)) {
        // 所有渠道统一先走自动生成：该渠道的独立运行时已建好且签名未变就只复用（很快），
        // 只有目录里连 Endfield.exe 都没有、或基础客户端更新过才会重建，并清掉 incomplete
        // 让启动页状态点变绿。
        const efServer = (game.servers || []).find((server) => server.id === game.activeServerId);
        if (efServer) {
          // 已经能直接启动时就不要再为了补渠道包让「开始游戏」等上一场下载
          const prepared = await ensureEndfieldChannelRuntime(game, efServer, {
            allowPackDownload: !(activeServer && targetExists(activeServer.path)),
            allowRuntimeBase: true,
          }).catch((error) => {
            // 已经有可用路径时尽力而为：重建失败不阻断启动；连路径都没有就只能报错。
            if (activeServer && targetExists(activeServer.path)) return null;
            return { ok: false, error: '自动生成' + efServer.name + '运行时失败：' + error.message };
          });
          if (prepared) writeLaunchLog(`launch ${id}: endfield runtime ok=${prepared.ok !== false} built=${prepared.built === true} root=${prepared.runtimeRoot || ''}`);
          if (prepared && prepared.ok === false) return prepared;
          if (prepared) {
            target = prepared.launchPath;
            game.target = prepared.launchPath;
            game.workDir = prepared.runtimeRoot;
          }
        }
      }
      /*
       * 启动前轻量只读预检（边界①）：只读已落盘的 server.predownload 发个 toast，
       * 补掉「启动后 18 秒定时检查」的空窗。fire-and-forget：不联网、不下载、
       * 不阻断启动；异环打开官方预下载那条路不提示。异常一律吞掉。
       */
      if (purpose !== 'predownload' && activeServer) {
        try { launchPreflightNotice(game, activeServer); } catch {}
      }
      if (!target) {
        return { ok: false, error: '还没有配置启动程序，先编辑这个游戏吧' };
      }

      try {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
          await shell.openExternal(target);
          await markLaunched(game);
          return { ok: true, external: true };
        }

        if (!path.isAbsolute(target)) {
          return { ok: false, error: '启动程序需要使用完整路径，请重新选择一次' };
        }

        if (!fs.existsSync(target)) {
          return { ok: false, error: '启动程序不存在，请编辑游戏重新选择' };
        }

        const stat = fs.statSync(target);
        if (!stat.isFile()) return { ok: false, error: '启动路径不是一个文件' };

        let nteDirectArgs = [];
        if (game.builtinKey === 'neverness' && getStore().data.settings.nevernessUseOfficialLauncher !== false) {
          /*
           * 官方启动链的中间环节 NTEGame.exe /launcher：自带资源校验，直达登录窗，
           * 跳过 NTELauncher 主界面（资讯/商城那些）——点花筱灵「启动」≈直接到登录。
           * NTEGame 不在时回落 NTELauncher.exe 完整链路。
           */
          const nteGame = findNteGame(target);
          if (nteGame) {
            writeLaunchLog(`launch ${id}: NTE direct game chain=${nteGame}`);
            target = nteGame;
            nteDirectArgs = ['/launcher'];
          } else {
            const launcher = findNteLauncher(target);
            if (launcher) {
              writeLaunchLog(`launch ${id}: NTE official launcher=${launcher}`);
              target = launcher;
            }
          }
          /*
           * 清掉官方启动器的托盘残留：它关窗只是缩托盘，进程不退。带着旧进程 spawn
           * 会触发它的单实例「唤醒旧实例→旧实例退出→新实例秒退」，点了等于没点。
           */
          if (/^nte(game|launcher)\.exe$/i.test(path.basename(target))) {
            if (purpose === 'predownload') {
              /*
               * 预下载只借用官方启动页：它已经开着就直接拉到前台，绝不先杀掉。
               * 官方正在下载预下载资源时把它结束掉，等于把用户几十分钟的进度连进程一起收了。
               */
              const alive = await listRunningImages(['NTEGame.exe']);
              if (alive.length) {
                await activateWindowByImage('NTEGame.exe');
                writeLaunchLog(`launch ${id}: NTE official launcher already open, reused for predownload`);
                return { ok: true, reused: true, officialPage: true };
              }
            }
            const nteClear = await clearNteLingeringLauncher(id);
            if (nteClear.code === 'game-running') {
              return { ok: false, error: '异环已经在运行了（HTGame.exe）。先玩着，或退出游戏再启动。' };
            }
            if (nteClear.code === 'updater-running') {
              return { ok: false, error: '异环官方更新器正在自更新，等十几秒再点一次。' };
            }
          }
        }

        if (game.builtinKey === 'endfield') {
          /*
           * 「点了启动却弹出官方启动器」的根因：安装/更新/兜底链路会把 server.path
           * 存成 PlatformProcess.exe（平台进程）甚至 HypergryphLauncher.exe ——
           * 这两个直接跑起来就是官方平台/启动器界面，永远不会是游戏。
           * 启动前统一修正：同目录（或 workDir）有 Endfield.exe 就用它，
           * 按官方启动器托管布局再找一层（games\Endfield Game\Endfield.exe）；
           * 都没有就明确报错，绝不直接执行平台进程。
           */
          const baseName = path.basename(target).toLowerCase();
          if (baseName !== 'endfield.exe') {
            const rootDir =
              game.workDir && fs.existsSync(path.join(game.workDir, 'Endfield.exe'))
                ? game.workDir
                : path.dirname(target);
            const gameExe = [
              path.join(path.dirname(target), 'Endfield.exe'),
              path.join(rootDir, 'Endfield.exe'),
              path.join(path.dirname(target), 'games', 'Endfield Game', 'Endfield.exe'),
              path.join(rootDir, 'games', 'Endfield Game', 'Endfield.exe'),
            ].find((candidate) => fs.existsSync(candidate));
            if (gameExe) {
              writeLaunchLog(`launch ${id}: 终末地启动路径被修正 ${target} -> ${gameExe}`);
              target = gameExe;
              game.workDir = path.dirname(gameExe);
            } else if (/platformprocess|hypergryphlauncher/i.test(baseName)) {
              writeLaunchLog(`launch ${id}: 终末地路径指向平台进程且找不到游戏本体：${target}`);
              return {
                ok: false,
                error:
                  '这个服务器指向的是官方启动器的平台进程，不是游戏本体（Endfield.exe 缺失）。' +
                  '请在这个服务器上点「重建运行时」，或到服务器设置里把路径指到 Endfield.exe。',
              };
            }
          }
        }

        if (game.builtinKey === 'arknights') {
          /*
           * 明日方舟官服 / B服 的目录里同样躺着 PlatformProcess.exe（鹰角两家游戏
           * 共用同一套平台层，Xel-Launcher 的方舟渠道清单里就包含它）。扫描时我们
           * 只认 Arknights.exe 当入口，不会存成它；但用户手改过路径、或者数据是从
           * 更早的版本升上来的，server.path 有可能已经指向平台进程 —— 跑起来就是
           * 官方平台界面。这里同样修正到本体。
           */
          const baseName = path.basename(target).toLowerCase();
          if (baseName !== 'arknights.exe') {
            const rootDir =
              game.workDir && fs.existsSync(path.join(game.workDir, 'Arknights.exe'))
                ? game.workDir
                : path.dirname(target);
            const gameExe = [
              path.join(path.dirname(target), 'Arknights.exe'),
              path.join(rootDir, 'Arknights.exe'),
              path.join(path.dirname(target), 'games', 'Arknights Game', 'Arknights.exe'),
              path.join(rootDir, 'games', 'Arknights Game', 'Arknights.exe'),
            ].find((candidate) => fs.existsSync(candidate));
            if (gameExe) {
              writeLaunchLog(`launch ${id}: 明日方舟启动路径被修正 ${target} -> ${gameExe}`);
              target = gameExe;
              game.workDir = path.dirname(gameExe);
            } else if (/platformprocess|hypergryphlauncher/i.test(baseName)) {
              writeLaunchLog(`launch ${id}: 明日方舟路径指向平台进程且找不到游戏本体：${target}`);
              return {
                ok: false,
                error:
                  '这个服务器指向的是官方启动器的平台进程，不是游戏本体（Arknights.exe 缺失）。' +
                  '请在这个服务器上点「重建运行时」，或到服务器设置里把路径指到 Arknights.exe。',
              };
            }
          }
        }

        const lower = target.toLowerCase();
        let cwd = game.workDir && fs.existsSync(game.workDir) ? game.workDir : path.dirname(target);
        if (
          game.builtinKey === 'neverness' &&
          ['ntelauncher.exe', 'ntegame.exe'].includes(path.basename(target).toLowerCase())
        ) {
          cwd = path.dirname(target);
        }
        let args = splitArgs(game.args);
        /*
         * 渲染后端（DX11 / DX12）参数拼在最前面：用户自定义参数在后，
         * 万一两边写了冲突的开关，以用户手填的为准。
         */
        const renderArgs = renderApi.argsFor(game.builtinKey, game.renderApi);
        if (renderArgs.length) args = [...renderArgs, ...args];
        if (
          nteDirectArgs.length &&
          path.basename(target).toLowerCase() === 'ntegame.exe' &&
          !args.some((item) => /^\/?launcher$/i.test(item))
        ) {
          args = [...nteDirectArgs, ...args];
        }

        /*
         * 鸣潮：客户端启动后会做一条 UE4 断言
         *   Fatal error: [File:Unknown] [Line: 54] kuro: Use launcher to start game!
         * 缺了启动器给的上下文（画质档位 -krqlv=）就自杀，进程十几秒后自己退掉，
         * 表现就是「点了开始游戏，弹一下就没了」（用户 2026-11-16 报障「提示要官方启动器」）。
         *
         * 本机 A/B 实测（_wuwa-ab-test.ps1）：同一个父进程、同一个 exe，
         * 不带参数 → 退出；带 -krqlv=hd → 存活。客户端二进制里也没有读父进程路径的
         * API，所以它并不在乎父进程是谁，缺的是这个参数。
         * 画质档位取自本体根的 launcherDownloadConfig.json 的 bundles 键（官服/B服都是 HD）。
         */
        if (game.builtinKey === 'wutheringwaves' && !/^wegame:/i.test(target)) {
          try {
            const wuwa = wuwaLaunch.resolveLaunchArgs(target, args);
            if (wuwa.args.length) {
              args = [...args, ...wuwa.args];
              writeLaunchLog(
                `launch ${id}: 鸣潮补启动参数 ${wuwa.args.join(' ')}（${wuwa.source}：${wuwa.note}）`
              );
            }
          } catch (error) {
            /* 算不出参数也不能挡住启动：客户端顶多自己断言退出，用户还能用官方启动器 */
            writeLaunchLog(`launch ${id}: 鸣潮启动参数计算失败 ${error.message}`);
          }
        }

        if (lower.endsWith('.lnk') || lower.endsWith('.url')) {
          /*
           * 终末地不允许走快捷方式：快捷方式可能指向官方启动器（那就白弹一次界面），
           * 而且绕过签名父进程后游戏会报 10100。直接让用户指到本体。
           */
          if (game.builtinKey === 'endfield') {
            return {
              ok: false,
              error: '终末地不能用快捷方式启动（可能指向官方启动器）。请在这个服务器上把路径直接指到 Endfield.exe。',
            };
          }
          const openError = await shell.openPath(target);
          if (openError) return { ok: false, error: openError };
          await markLaunched(game);
          return { ok: true, external: true };
        }

        if (!lower.endsWith('.exe') && !lower.endsWith('.bat') && !lower.endsWith('.cmd')) {
          const openError = await shell.openPath(target);
          if (openError) return { ok: false, error: openError };
          await markLaunched(game);
          return { ok: true, external: true };
        }

        /*
         * 终末地：不论 exe 叫什么名字（含用户改过名的 Endfield_cn.exe），一律经签名
         * 父进程 —— 只要落到下面的通用启动，父进程就是花筱灵自己，游戏立刻报
         * 10100「请通过官方启动器打开游戏」。指向平台进程的那种在上面已经被拦下。
         *
         * 明日方舟**不走**这条链路：它不校验父进程，双击本体就能开。Xel-Launcher 里
         * 也是同一条界线 —— 它的 decoy 父进程桥只对 Endfield / BiliEndfield /
         * GlobalEndfield / PlayEndfield 四个渠道启用，Arknights 系一律普通启动。
         * 套上去只会让每次开方舟都白跑一次 PowerShell，在没装终末地的机器上
         * 还会必然失败。
         */
        if (game.builtinKey === 'endfield') {
          const signed = await launchWithSignedParent(game, target, cwd, {
            requireElevation: true,
            strict: true,
            // 渲染后端参数也要一起传：这条链路绕过了下面的 spawn，漏传等于 DX 开关对终末地无效
            args: args.join(' '),
          });
          if (signed.handled) return signed.result;
        }

        /*
         * 渠道体检（2026-11-16 报障：原神从国际服切回官服后，账号「上次登录」从 11-13
         * 变回 11-04 并要求重新登录）。
         *
         * 那次把 2.10.1 → 2.10.2 的改动面和所有会写游戏目录 / 注册表的代码都翻了一遍：
         * 启动器没有写过原神目录里的任何账号文件，也没有整项导入注册表的能力。所以最可能
         * 的成因是「选了官服那一行，实际拉起的却是国际服客户端」——两边的账号态不在同一处，
         * 表现就像账号被回滚了。以前 launch.log 只有 target= 一行，看不出这层错配。
         *
         * 这里补一条渠道对照：所选渠道 vs 客户端自己声明的渠道（config.ini 优先，
         * 其次 exe 名/目录名）。不一致就落日志 + 明确提示，用户至少知道该去改哪一行。
         * 体检失败一律吞掉 —— 它绝不能挡住启动。
         */
        try {
          const chosenChannel = String((activeServer && activeServer.channel) || '');
          /*
           * 2026-11-17：这里原来只看 config.ini（configChannelFromPath）。
           * 但第三方三服切换器会把官服目录的 ini 改成 cps=bilibili，
           * 于是点启动必弹「那个目录里是B服客户端，账号会串到另一个服」——纯误报。
           *
           * resolveChannelFromRoot 会拿渠道 SDK（BLPlatform64 / PCGameSDK.dll）复核：
           * ini 说是 B服、目录里却没有渠道件 → 判成官服（evidence=config-conflict）。
           * ini 只用来落日志，最终判定以它为准。
           */
          const iniChannel = clientChannel.configChannelFromPath(target) || '';
          const hintChannel = clientChannel.pathChannelHint(target) || '';
          const resolved = clientChannel.resolveChannelFromRoot
            ? clientChannel.resolveChannelFromRoot(path.dirname(target))
            : null;
          const actualChannel = (resolved && resolved.channel) || iniChannel || hintChannel;
          const mismatch =
            MIHOYO_CHANNEL_KEYS.indexOf(game.builtinKey) >= 0 &&
            CHANNEL_PROBE_KEYS.indexOf(chosenChannel) >= 0 &&
            Boolean(actualChannel) &&
            chosenChannel !== actualChannel;
          writeLaunchLog(
            `launch ${id}: server=${(activeServer && activeServer.name) || '(未配置)'} ` +
              `chosen=${chosenChannel || '-'} ini=${iniChannel || '-'} hint=${hintChannel || '-'}` +
              (mismatch ? ` MISMATCH actual=${actualChannel}` : '')
          );
          if (mismatch) {
            send('toast', {
              type: 'error',
              message:
                `「${(activeServer && activeServer.name) || game.name || '这一行'}」标的是${clientChannel.channelLabel(chosenChannel)}，` +
                `但那个目录里是${clientChannel.channelLabel(actualChannel)}客户端 —— 账号会串到另一个服。` +
                '请点这一行的“编辑”重新选目录。',
            });
          }
        } catch {
          /* 体检只是体检，不许影响启动 */
        }

        getLaunching().set(id, Date.now());
        writeLaunchLog(`launch ${id}: target=${target} args=${args.join(' ')} cwd=${cwd}`);

        let pid = null;
        let shellError = '';
        const needExplicitArgs = args.length > 0 || (game.workDir && fs.existsSync(game.workDir));
        if (needExplicitArgs) {
          const result = await startWithShellExecute(target, args, cwd);
          if (result.ok) pid = result.pid;
          else shellError = result.error;
        } else {
          const openError = await shell.openPath(target);
          if (openError) {
            const result = await startWithShellExecute(target, args, cwd);
            if (result.ok) pid = result.pid;
            else shellError = result.error;
          }
        }

        if (!pid && shellError) {
          // 最后再尝试一次 CreateProcess，部分绿色程序不接受 ShellExecute。
          try {
            const child = spawn(target, args, {
              cwd,
              detached: true,
              stdio: 'ignore',
              windowsHide: false,
            });
            if (child.pid) {
              pid = child.pid;
              getRunning().set(id, { pid, startedAt: Date.now() });
              child.once('error', () => {
                getRunning().delete(id);
                pushState(true);
              });
              child.once('exit', () => finishGame(id));
              child.unref();
            }
          } catch (error) {
            getLaunching().delete(id);
            writeLaunchLog(`launch ${id}: failed ${shellError}; ${error.message}`);
            return { ok: false, error: shellError || error.message };
          }
        }

        // 预下载只是去官方页面下资源，不算「玩过这个游戏」——别去动最近游玩时间
        if (purpose !== 'predownload') await markLaunched(game);

        if (lower.endsWith('.exe') && !getRunning().has(id)) {
          const isNeverness = game.builtinKey === 'neverness';
          const trackExe = isNeverness ? 'HTGame.exe' : path.basename(target);
          trackGameProcess(
            id,
            trackExe,
            isNeverness ? null : Date.now(),
            isNeverness ? 150 : 8
          ).catch(() => {});
          /*
           * 请求了渲染后端就核对一次结果。
           * 参数传过去不等于生效：客户端可能不认这个开关，也可能显卡不支持而静默回退。
           * 45 秒足够冷启动写完 Player.log，又不至于拖到用户已经进游戏几分钟。
           * 详情只进启动日志，不打扰界面 —— 读不到日志路径是常态，不该弹提示。
           */
          if (renderArgs.length) {
            const probe = setTimeout(async () => {
              try {
                const requested = renderApi.labelFor(game.builtinKey, game.renderApi);
                const actual = await renderApi.readActualApi(game.builtinKey);
                writeLaunchLog(
                  `launch ${id}: 渲染后端 请求=${requested} 实际=${actual || '未从游戏日志确认'}`
                );
              } catch {
                /* 日志读不到就算了，不影响游戏 */
              }
            }, 45000);
            probe.unref?.();
          }
          if (isNeverness && path.basename(target).toLowerCase() === 'ntegame.exe') {
            if (purpose === 'predownload') {
              // 只试着点官方页面上的「预下载」，绝不点「开始游戏」——那是直接进游戏
              autoClickNtePredownload(id);
            } else {
              // 异环直达登录窗后，帮忙把「开始游戏」也点了（UIA 找按钮，找不到就静默让人点）
              autoClickNteStart(id);
            }
          }
        } else {
          getLaunching().delete(id);
        }

        return { ok: true, pid: pid || null };
      } catch (error) {
        getLaunching().delete(id);
        writeLaunchLog(`launch ${id}: exception ${error.message}`);
        return { ok: false, error: error.message };
      }
    });

    ipcMain.handle('games:stop', async (_event, id) => {
      if (!getRunning().has(id)) return { ok: false, error: '这个游戏没有在运行' };
      await killGame(id);
      return { ok: true };
    });

    ipcMain.handle('games:reveal', async (_event, id) => {
      const game = getStore().data.games.find((g) => g.id === id);
      if (!game || !game.target) return false;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(game.target)) return false;
      try {
        if (fs.existsSync(game.target)) {
          shell.showItemInFolder(game.target);
          return true;
        }
      } catch {
        /* ignore */
      }
      return false;
    });
}

module.exports = { installGamesIpc };
