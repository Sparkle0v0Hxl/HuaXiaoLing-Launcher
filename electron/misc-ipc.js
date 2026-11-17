'use strict';

const { ipcMain, app, shell, dialog, net } = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const diagnostics = require('./diagnostics');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');
const { createCancelSignal } = require('./cancel-signal');


/**
 * 零散入口（wegame / start / diag / fs / media / shell / proxy / starrail / features / news / game / state / cover / avatar / bili）。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installMiscIpc(ctx) {
  const {
    describeStorage, cleanSafe, pushState, cleanGroup, setStarRailFps, snapshot, pathToFileURL,
    neteaseGet, NETEASE_URL_BATCH, wuwaExeAt, findWeGameWuwaRoots, findWeGameDownloadRoots,
    WEGAME_WUWA_ID, pathsOverlap, send, sendProgress, hardlinkTree, updateLogDirs, updateStatus,
    APP_VERSION, ensureAnimatedStartBackgrounds, win, portableDownloads, ROOT, getStore, getLinkJobs,
    // 重构拆分时漏掉的依赖（原来都是 main.js 里的名字，模块里直接用了，运行时是 ReferenceError）
    repairMissingBackgrounds,             // 清完背景缓存后修复失效引用
    safeFileName,                         // 导出动图时的文件名清洗
    minisign,                             // 诊断信息里的清单签名公钥
    os,
    setBh3OfficialRetry,
  } = ctx;

  /*
   * 清理时要把「随包内置的封面」排除在待删列表外。
   * app-ipc.js 里有一份同名同构的实现（那边是模块内局部的），这里自己留一份，
   * 免得为了一个两行的小函数再往 ctx 里加一条。
   */
  const storageOptions = () => ({
    bundleCovers: path.join(app.getAppPath(), 'data', 'covers'),
  });

  /* bh3OfficialRetry 是 main.js 的模块级 let：按值解构是 const，赋值会抛 TypeError */
  const resetBh3Retry = () => {
    if (typeof setBh3OfficialRetry === 'function') setBh3OfficialRetry(0);
    else console.warn('[misc-ipc] 缺少 setBh3OfficialRetry，重试计数未清零');
  };

  /* store 在 main.js 是模块级 let，随时可能重建，必须每次现取 */
  const storeRef = () => (typeof getStore === 'function' ? getStore() : null);

    ipcMain.handle('fs:usage', () =>
      describeStorage(app.getPath('userData'), storeRef()?.data?.games || [], storageOptions())
    );
    ipcMain.handle('fs:clean', async (_event, input = {}) => {
      const id = String(input.id || '');
      const userData = app.getPath('userData');
      const games = storeRef()?.data?.games || [];
      if (id === 'all') {
        const result = await cleanSafe(userData, games, storageOptions());
        console.log(`[文件管理] 一键清理释放 ${(result.freed / 1048576).toFixed(1)}MB`);
        if (repairMissingBackgrounds(games)) {
          await getStore().saveNow();
          pushState(true);
        }
        return result;
      }
      const result = await cleanGroup(userData, games, id, storageOptions());
      console.log(`[文件管理] ${id} 释放 ${(result.freed / 1048576).toFixed(1)}MB`);
      if (id === 'backgrounds' && repairMissingBackgrounds(games)) {
        await getStore().saveNow();
        pushState(true);
      }
      return result;
    });

    ipcMain.handle('starrail:fps:set', async (_event, fps) => {
      const game = getStore().data.games.find((item) => item.builtinKey === 'starrail');
      const server = (game?.servers || []).find((item) => item.id === game.activeServerId);
      return setStarRailFps(fps, server?.channel || '');
    });

    ipcMain.handle('state:get', () => snapshot());






    /*
     * 全游戏通用的「修复游戏」：按官方清单逐文件校验，重新下载损坏/缺失的文件。
     * - 终末地 / 明日方舟：直接复用鹰角那套加密逐文件清单（force 重校，版本号没变也会重扫）
     * - 米哈游系（原神 / 星铁 / 绝区零 / 崩坏3）：走 Sophon 逐 chunk 校验补齐
     * - 异环：本体修复由官方启动器接管，这里直接拉起它
     */


    /*
     * 明日方舟的两个渠道包。和终末地分开成一条：这两条是照着 Xel-Launcher 的
     * 清单配的，虽然实测取得到（78.0.0），但还没在真机切服上验证过，
     * 让用户单独点、单独看结果，不跟着终末地一起静默发生。
     */


    /*
     * 渠道包按需下载（2.5.0）：安装包不再内置这 632 MB，第一次切到某个服时
     * 由渲染层先问一次「有没有 / 要下多少」，用户点了才下。
     * 三条 IPC 分开是刻意的：查状态不该顺带下载，下载不该阻塞查状态。
     */

    /** 设置页「释放空间」：列出现在占了哪些渠道包、各多大。 */

    /**
     * 切服前的唯一入口：这次切换需不需要先下渠道包、要下多少。
     *
     * 只回答「需不需要」（channelPackNeededFor），不下载；
     * 用户点了弹窗里的下载才走 endfield:channel-pack-download。
     */

    ipcMain.handle('media:url', async (_event, source) => {
      const value = String(source || '').trim();
      if (!value) return '';
      if (/^https?:\/\//i.test(value)) return value;
      return pathToFileURL(path.resolve(value)).href;
    });

    ipcMain.handle('media:netease-playlist', async (_event, input) => {
      const apiBase = String(input?.apiBase || 'http://127.0.0.1:3100').replace(/\/+$/, '');
      const rawUrl = String(input?.url || '');
      const match = rawUrl.match(/(?:playlist\?id=|\/playlist\/)(\d+)/i) || rawUrl.match(/id=(\d+)/);
      const playlistId = match?.[1];
      if (!playlistId) throw new Error('没有识别出网易云歌单 ID，请粘贴完整歌单链接');
      const detail = await neteaseGet(apiBase, '/playlist/detail', { id: playlistId });
      const playlist = detail.playlist || detail.result?.playlist;
      const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
      if (!tracks.length) throw new Error('歌单里没有歌曲，或本地 API 未登录/不可用');
      /*
       * 以前这里写的是 tracks.slice(0, 100)：不管歌单多少首都只导前 100 首，
       * 用户贴个八百首的链接进来，队列里还是 100 首 —— 这就是「只能拿到 100 首」的来源。
       * 现在整单全导，URL 查询按批切分（一次送上千个 id 会把请求撑爆）。
       */
      const level = input?.level || 'exhigh';
      const urlMap = new Map();
      for (let start = 0; start < tracks.length; start += NETEASE_URL_BATCH) {
        const ids = tracks.slice(start, start + NETEASE_URL_BATCH).map((track) => track.id);
        let urlJson = null;
        try {
          urlJson = await neteaseGet(apiBase, '/song/url/v1', { id: ids.join(','), level });
        } catch {
          urlJson = await neteaseGet(apiBase, '/song/url', { id: ids.join(',') });
        }
        for (const item of urlJson?.data || []) {
          urlMap.set(String(item.id), { url: item.url, quality: item.level || level });
        }
      }
      const songs = [];
      for (const track of tracks) {
        const info = urlMap.get(String(track.id));
        if (!info?.url) continue;
        const artists = (track.ar || track.artists || []).map((item) => item.name).filter(Boolean);
        songs.push({
          title: track.name,
          artist: artists.join(' / '),
          cover: String(track.al?.picUrl || track.album?.picUrl || '').replace(/^http:/i, 'https:'),
          neteaseId: track.id,
          quality: info.quality,
          url: info.url,
        });
      }
      return {
        ok: true,
        playlist: playlist.name || '网易云歌单',
        total: tracks.length,
        songs,
        skipped: tracks.length - songs.length,
      };
    });

    ipcMain.handle('wegame:wuwa-probe', async () => {
      // 源：当前活跃的鸣潮官方版客户端（渠道不限，主体互通）
      const game = getStore().data.games.find((item) => item.builtinKey === 'wutheringwaves');
      const activeServer = game ? game.servers.find((item) => item.id === game.activeServerId) : null;
      /*
       * UE 游戏的可执行文件在 `<根>\Client\Binaries\Win64\Client-Win64-Shipping.exe`，
       * 不在根目录（根目录的 `Wuthering Waves.exe` 是启动转发器）。
       * 判「客户端装好」用两层：根目录有 Client/ + Binaries 下有 Shipping exe 都算。
       */

      // 源优先取官方体系（官服 / B服）里装好的完整客户端；WeGame 自己不当源，
      // 免得「自己转自己」被 pathsOverlap 拦住（用户 m29017「B服转换wegame能转吗」）。
      let sourceRoot = '';
      const officialSource = game
        ? (game.servers || []).find(
            (item) =>
              ['official', 'bilibili'].includes(String(item.channel || '')) &&
              item.root &&
              wuwaExeAt(item.root)
          )
        : null;
      if (officialSource) sourceRoot = officialSource.root;
      else if (
        activeServer &&
        activeServer.root &&
        activeServer.channel !== 'wegame' &&
        wuwaExeAt(activeServer.root)
      ) {
        sourceRoot = activeServer.root;
      } else if (game) {
        const usable = (game.servers || []).find(
          (item) => item.root && wuwaExeAt(item.root) && item.channel !== 'wegame'
        );
        if (usable) sourceRoot = usable.root;
      }
      const sourceReady = Boolean(sourceRoot && wuwaExeAt(sourceRoot));
      // 目标：下载中(downloading\2002137) 与 已安装(rail_apps\Wuthering Waves(2002137))
      // 都认 —— WeGame 装完会把目录从 downloading 迁到 rail_apps（用户 m28189/m28195）。
      const wuwaRoots = findWeGameWuwaRoots();
      const roots = findWeGameDownloadRoots();
      let targetRoot = wuwaRoots[0] || '';
      if (!targetRoot && roots.length) targetRoot = path.join(roots[0], WEGAME_WUWA_ID);
      const alreadyInstalled = Boolean(targetRoot && wuwaExeAt(targetRoot));
      return {
        ok: true,
        wegameFound: roots.length > 0 || wuwaRoots.length > 0,
        downloadRoots: roots,
        targetRoot,
        targetExists: Boolean(targetRoot && fs.existsSync(targetRoot)),
        sourceRoot,
        sourceReady,
        alreadyInstalled,
        wegameRunning: Boolean(
          (() => {
            try {
              return require('node:child_process').execSync(
                'tasklist /FI "IMAGENAME eq wegame.exe" /NH',
                { encoding: 'utf8', timeout: 4000 }
              ).includes('wegame.exe');
            } catch {
              return false;
            }
          })()
        ),
      };
    });

    /*
     * 2026-11-17 修 bug 3（转换后回填 WeGame 服务器行）。
     *
     * 做什么：把鸣潮 game 的「WeGame」渠道行的 server.path / server.root 填上，
     * 并标记 confirmed = true，让界面点「WeGame 版」不再是空的。
     *
     * 定位主程序：WeGame 版鸣潮的 UE 主程序与官服同构，
     *   `<WeGame根>\Client\Binaries\Win64\Client-Win64-Shipping.exe`
     * （与 main.js 的 wuwaExeAt 一致：根目录的 Wuthering Waves.exe 只是启动壳）。
     * server.root 填 WeGame 本体根（那棵含 Client/ 的鸣潮目录）。
     *
     * 找不到行 / 拿不到 store 时静默跳过：回填失败不应该让已经做完的转换报错。
     */
    const backfillWeGameServerRow = async (wegameRoot) => {
      try {
        if (typeof getStore !== 'function' || typeof pushState !== 'function') return false;
        const root = String(wegameRoot || '').trim();
        if (!root) return false;
        const store = getStore();
        const game = (store?.data?.games || []).find((item) => item.builtinKey === 'wutheringwaves');
        if (!game) return false;
        const servers = Array.isArray(game.servers) ? game.servers : [];
        const server = servers.find((item) => String(item.channel || '') === 'wegame');
        if (!server) return false;
        /*
         * 2026-11-17 审查（rev-wuwa B2）：这里原来无条件覆盖 —— 只要点一次「转换」，
         * 就把用户手填过的 WeGame 路径（可能是另一个安装位）改成当前这次的目标目录，
         * 还顺手把 confirmed 置 true。
         *
         * 现在只在这一行还没有可用路径时才回填：
         *   · 已经指着一个真实存在的 exe → 尊重用户/历史，不动；
         *   · 空着，或指着已经不存在的位置 → 才写。
         * 这样「转换成功但界面没有这一行」（用户删过 WeGame 行的情况）能补回，
         * 而不会把用户手选的目录顶掉。
         */
        const hadPath = Boolean(server.path && fs.existsSync(server.path));
        if (hadPath) return false;
        // 主程序路径：优先用真实存在的 exe；不存在也照样写期望路径
        // （转换刚完成时文件必然在，但 WeGame 自己搬过目录时可能需要重算）。
        const exe = wuwaExeAt(root)
          || path.join(root, 'Client', 'Binaries', 'Win64', 'Client-Win64-Shipping.exe');
        server.path = exe;
        server.root = root;
        server.confirmed = true;
        server.incomplete = false;
        server.unavailable = false;
        if (!server.packPath) server.packPath = exe;
        if (game.activeServerId === server.id) {
          game.target = exe;
          game.workDir = root;
        }
        await store.saveNow();
        pushState(true);
        return true;
      } catch (error) {
        console.warn('[misc-ipc] WeGame 服务器行回填失败：', error && error.message);
        return false;
      }
    };

    ipcMain.handle('wegame:wuwa-convert', async (_event, input) => {
      const sourceRoot = String(input?.sourceRoot || '').trim();
      const targetRoot = String(input?.targetRoot || '').trim();
      if (!sourceRoot || !targetRoot) throw new Error('需要同时指定官方版源目录与 WeGame 目标目录');
      /*
       * UE 主程序在 `<根>\Client\Binaries\Win64\Client-Win64-Shipping.exe`，不在根目录。
       * 根目录的 `Wuthering Waves.exe` 只是启动壳，探测客户端是否装好用 Client/ 目录。
       */

      if (!wuwaExeAt(sourceRoot)) {
        throw new Error('源目录里没有客户端主程序（Client/Binaries/Win64/Client-Win64-Shipping.exe），请确认这是已下载完的鸣潮客户端');
      }
      const sourceDrive = path.parse(path.normalize(sourceRoot)).root.toLowerCase();
      const targetDrive = path.parse(path.normalize(targetRoot)).root.toLowerCase();
      if (sourceDrive !== targetDrive) {
        throw new Error('官方版和 WeGame 目录不在同一个盘 —— WeGame 版下载目录挪到与官方版同一块盘后再试（硬链接无法跨盘）');
      }
      if (pathsOverlap(sourceRoot, targetRoot)) {
        throw new Error('源目录和目标目录互相包含，不能转换');
      }
      if (!fs.existsSync(targetRoot)) {
        throw new Error('WeGame 里还没有这个游戏的下载目录（downloading\\2002137）。先在 WeGame 商店找到鸣潮点一次「下载」，等它建好目录再暂停，然后回来点转换。');
      }
      if (wuwaExeAt(targetRoot)) {
        // WeGame 版已经装好（rail_apps 里有完整主程序）：不再往里硬链覆盖，
        // 否则会把它自己的渠道件冲掉（用户 m28159「我wegame端下好能启动了」）。
        const alreadyDone = { jobId: crypto.randomUUID(), ok: true, already: true, phase: 'done' };
        // 已经是装好的 WeGame 版：同样回填服务器行（否则这一行永远空着）。
        await backfillWeGameServerRow(targetRoot);
        send('link:progress', { gameId: 'builtin-wutheringwaves', ...alreadyDone });
        send('link:done', { gameId: 'builtin-wutheringwaves', ...alreadyDone });
        return { ok: true, already: true, message: 'WeGame 版已经装好并能启动，不需要再转换' };
      }
      const jobId = crypto.randomUUID();
      const signal = createCancelSignal();
      getLinkJobs().set(jobId, signal);
      const emit = (progress) => sendProgress('link:progress', jobId, { gameId: 'builtin-wutheringwaves', ...progress });
      emit({ phase: 'scan', processed: 0, total: 0, bytesDone: 0, totalBytes: 0, current: '正在把官方版客户端硬链接进 WeGame 目录…' });
      try {
        const result = await hardlinkTree({
          sourceRoot,
          targetRoot,
          signal,
          onProgress: emit,
          // WeGame 目录里的记账 / 渠道件 / 运行时状态必须各留一份：
          // 硬链接共享 inode 会让 WeGame 版写一次就把官服那份也改了。
          copyDirs: [
            'launcherDownload',
            'launcherDownloadConfig',
            'Client/Config',
            /*
             * 2026-11-17 修 bug 2（渠道身份）：
             * 渠道身份写在
             *   Client/Binaries/Win64/ThirdParty/KrPcSdk_Mainland/KRSDKRes/KRSDKConfig.json
             * （官服 KR_ChannelId=19 / B服 46 / KR_AppId=com.kurogame.mingchao.bilibili）。
             * 原来只把 KRSDKRes 整棵拷贝，而 ThirdParty 下别的 SDK 二进制
             * （KRSDK.dll / KRSDKExternal.exe 等）仍然是硬链 —— 硬链共享 inode，
             * WeGame 目录里就可能带着官服渠道身份的 SDK。
             *
             * 修法：改成**整棵 ThirdParty SDK 目录**拷贝，渠道身份文件必然在其中。
             * 代价：ThirdParty 整棵实测约 800 MB 量级，转换多占一份磁盘、
             * 多花一点时间；换来的是「WeGame 目录里绝不会有官服渠道身份件」。
             * 国际服目录名是 KrPcSdk_Global（不是 Mainland），一并列上更保险
             * （WeGame 转换目前只对官服/B服，但以后放宽也不用再改这里）。
             */
            'Client/Binaries/Win64/ThirdParty/KrPcSdk_Mainland',
            'Client/Binaries/Win64/ThirdParty/KrPcSdk_Global',
            '.quality',
            'wesight',
            'crashsight_data',
          ],
        });
        /*
         * 2026-11-17 修 bug 3：转换完成后回填鸣潮的 WeGame 服务器行。
         * 以前只发 link:progress / link:done，从不回填 —— WeGame 行的
         * server.path / server.root 恒空，界面点「WeGame 版」永远像没配好。
         *
         * 回填内容：
         *   server.path = WeGame 目录里的主程序（Client\Binaries\Win64\Client-Win64-Shipping.exe）
         *   server.root = WeGame 本体根（exe 往上一层的客户端根，即 WeGameApps 下那棵鸣潮目录）
         *   confirmed = true（用户不再需要手工选路径）
         * 代价：多一次 saveNow + pushState（写盘一次、推一次全量状态），可忽略。
         */
        await backfillWeGameServerRow(targetRoot);
        const done = { jobId, ok: true, ...result, phase: 'done' };
        // 任务面板只认 link:progress 的 done 帧（src/app.js 的 onLinkProgress
        // 在 phase==='done' 时 setTaskState(null)）。以前只发 link:done，弹窗
        // 收尾了、启动页却永远卡在「硬链接生成 100%」（用户 m28159）。
        send('link:progress', { gameId: 'builtin-wutheringwaves', ...done });
        send('link:done', { jobId, gameId: 'builtin-wutheringwaves', ...done });
        return { ok: true, jobId, ...result };
      } catch (error) {
        send('link:done', { jobId, gameId: 'builtin-wutheringwaves', ok: false, error: error.message });
        throw error;
      } finally {
        getLinkJobs().delete(jobId);
      }
    });

    ipcMain.handle('cover:import', async (_event, sourcePath) => {
      if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('图片不存在');
      const stat = fs.statSync(sourcePath);
      if (stat.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB');
      const ext = path.extname(sourcePath).toLowerCase() || '.png';
      const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
      if (!allowed.has(ext)) throw new Error('不支持这种图片格式');
      const dir = path.join(app.getPath('userData'), 'covers');
      await fsp.mkdir(dir, { recursive: true });
      const fileName = `cover-${crypto.randomUUID()}${ext}`;
      await fsp.copyFile(sourcePath, path.join(dir, fileName));
      return `covers/${fileName}`;
    });

    ipcMain.handle('avatar:import', async (_event, sourcePath) => {
      if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('图片不存在');
      const stat = fs.statSync(sourcePath);
      if (stat.size > 20 * 1024 * 1024) throw new Error('头像不能超过 20 MB');
      const ext = path.extname(sourcePath).toLowerCase() || '.png';
      const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
      if (!allowed.has(ext)) throw new Error('不支持这种图片格式');
      const dir = path.join(app.getPath('userData'), 'avatars');
      await fsp.mkdir(dir, { recursive: true });
      const fileName = `avatar-${crypto.randomUUID()}${ext}`;
      await fsp.copyFile(sourcePath, path.join(dir, fileName));
      return `avatars/${fileName}`;
    });

    ipcMain.handle('shell:open-path', async (_event, target) => {
      if (!target || typeof target !== 'string') return false;
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return true;
    });

    ipcMain.handle('shell:open-external', async (_event, url) => {
      if (!/^https?:\/\//i.test(String(url))) return false;
      await shell.openExternal(url);
      return true;
    });

    ipcMain.handle('diag:export', async () => {
      try {
        const dirs = updateLogDirs();
        const readLog = async (name, limit = 12000) => {
          for (const dir of dirs) {
            try {
              const text = await fsp.readFile(path.join(dir, name), 'utf8');
              const clean = text.replace(/^\uFEFF/, '').trim();
              return clean.length > limit ? clean.slice(-limit) : clean;
            } catch {
              /* 换下一个目录 */
            }
          }
          return '';
        };
        let crashLog = '';
        try {
          const raw = await fsp.readFile(path.join(app.getPath('userData'), 'crash.log'), 'utf8');
          crashLog = raw.length > 20000 ? raw.slice(-20000) : raw;
        } catch {
          /* 没崩溃过就没有这个文件 */
        }

        /*
         * stage 失败时写的「解压结构诊断」：最有用的一份证据，以前用户拿不到——
         * 它在 vela-update-* 里，下次启动就被 cleanTemp 删了。所以 stage 现在会
         * 额外往 tempBase 根写一份（cleanTemp 不删根文件），这里两处都找，取最新的。
         */
        const findLatestStageDebug = async (limit = 12000) => {
          const found = [];
          for (const dir of dirs) {
            try {
              const file = path.join(dir, 'stage-debug.json');
              const stat = await fsp.stat(file);
              found.push({ path: file, mtimeMs: stat.mtimeMs });
            } catch {
              /* 没有根级兜底副本就算了 */
            }
          }
          for (const dir of dirs) {
            let entries;
            try {
              entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
              continue;
            }
            for (const entry of entries) {
              if (!entry.isDirectory() || !entry.name.startsWith('vela-update-') || entry.name.includes('staging')) continue;
              const file = path.join(dir, entry.name, 'stage-debug.json');
              try {
                const stat = await fsp.stat(file);
                found.push({ path: file, mtimeMs: stat.mtimeMs });
              } catch {
                /* 这个目录里没有诊断文件 */
              }
            }
          }
          if (!found.length) return null;
          found.sort((a, b) => b.mtimeMs - a.mtimeMs);
          const latest = found[0];
          let text = (await fsp.readFile(latest.path, 'utf8')).replace(/^\uFEFF/, '').trim();
          if (text.length > limit) text = text.slice(-limit);
          return { path: latest.path, text };
        };
        const stageDebug = await findLatestStageDebug();
        let launchLog = '';
        try {
          const raw = await fsp.readFile(path.join(app.getPath('userData'), 'launch.log'), 'utf8');
          launchLog = raw.length > 6000 ? raw.slice(-6000) : raw;
        } catch {
          /* 没记录过就没有这个文件 */
        }

        const cfg = storeRef()?.data?.settings || {};
        const updateSourceModeText = {
          auto: '自动（内置镜像依次尝试）',
          gitee: 'Gitee 镜像优先',
          gitcode: 'GitCode 更新源优先',
          jsdelivr: 'jsDelivr 优先',
          github: 'GitHub 直连优先',
          custom: '只用手填地址',
        }[cfg.updateSourceMode || 'auto'] || `未知（${cfg.updateSourceMode}）`;
        const settingsSummary = {
          主题: `${cfg.theme || '跟随系统'} / 强调色 ${cfg.accent || '默认'}`,
          代理: cfg.proxyRules ? String(cfg.proxyRules) : '未设置（直连）',
          更新源模式: updateSourceModeText,
          更新源: cfg.updateManifest ? String(cfg.updateManifest) : '内置官方源',
          自动检查更新: cfg.autoCheckUpdate === false ? '关闭' : '开启',
          清单签名: `已启用，公钥 ${minisign.KEY_ID}，最近验签版本 ${cfg.updateSignedVersion || '（还没验过）'}`,
          最近一次检查: updateStatus
            ? `${updateStatus.ok ? '成功' : '失败'}  当前 ${updateStatus.current || APP_VERSION} / 最新 ${updateStatus.latest || '?'}${updateStatus.error ? `  错误：${updateStatus.error}` : ''}`
            : '（还没检查过）',
          游戏数量: String((storeRef()?.data?.games || []).length),
        };
        const env = {
          版本: APP_VERSION,
          Electron: process.versions.electron || '',
          Chrome: process.versions.chrome || '',
          Node: process.versions.node || '',
          系统: `${os.type()} ${os.release()} ${process.arch}`,
          安装目录: path.dirname(process.execPath),
          数据目录: app.getPath('userData'),
        };

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stampName = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const target = path.join(app.getPath('desktop'), `花筱灵诊断-${stampName}.txt`);
        const text = diagnostics.buildReport({
          generatedAt: now.toLocaleString('zh-CN'),
          env,
          settings: settingsSummary,
          logs: [
            { title: '覆盖安装日志 update-log.txt', text: await readLog('update-log.txt') },
            { title: '自愈日志 self-heal.log', text: await readLog('self-heal.log', 6000) },
            { title: '崩溃日志 crash.log（尾部）', text: crashLog },
            { title: '启动/运行日志 launch.log（尾部 6000 字）', text: launchLog },
            ...(stageDebug
              ? [{ title: `最近一次解压诊断 stage-debug.json：${stageDebug.path}`, text: stageDebug.text }]
              : []),
          ],
        });
        await fsp.mkdir(path.dirname(target), { recursive: true }).catch(() => {});
        await fsp.writeFile(target, text, 'utf8');
        diagnostics.recordEvent('info', 'diag', `诊断已导出：${path.basename(target)}`);
        return { ok: true, path: target, requests: diagnostics.requestCount() };
      } catch (error) {
        return { ok: false, error: (error && error.message) || String(error) };
      }
    });

    ipcMain.handle('start:refresh-art', async (_event, gameId) => {
      const game = storeRef()?.data?.games?.find((item) => item.id === gameId);
      if (!game) return { ok: false, reason: '没有找到这个游戏' };
      if (!game.builtinKey) return { ok: false, reason: '这个游戏不是内置游戏，没有官方动态背景' };
      // 手动触发时把自动重试计数清零，否则接口抖动留下的 3 次上限会一直卡着
      resetBh3Retry();
      try {
        await ensureAnimatedStartBackgrounds({ only: game.builtinKey });
      } catch (error) {
        return { ok: false, reason: error.message || '获取失败' };
      }
      const video = String(game.backgroundVideo || '');
      if (video) return { ok: true, video };
      return { ok: false, reason: `${game.name} 的官方接口这次没有返回动态背景` };
    });

    ipcMain.handle('start:export-video', async (_event, gameId) => {
      const game = getStore().data.games.find((item) => item.id === gameId);
      if (!game) throw new Error('没有找到这个游戏');
      const relative = String(game.backgroundVideo || '');
      if (!relative) throw new Error('这个游戏还没有动态背景');

      // 只有本地缓存能导出；远程 URL 先下载到临时文件再让用户另存
      let sourcePath = '';
      if (/^https?:/i.test(relative)) {
        const cachePath = path.join(app.getPath('userData'), 'backgrounds', `${game.builtinKey}.mp4`);
        await fsp.mkdir(path.dirname(cachePath), { recursive: true });
        const response = await fetch(relative, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`下载动图失败：HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        await fsp.writeFile(cachePath, buffer);
        sourcePath = cachePath;
      } else if (/^file:/i.test(relative)) {
        /*
         * 路径解码要包 try：动态背景是我们自己记下的 file:// 路径，
         * 但用户的文件夹名里本来就可能带 %（比如「100%」这类），
         * 解不开时 decodeURIComponent 抛 URIError，导出就直接失败了。
         * 解不开就按去掉前缀的原文用，Windows 路径本来就允许 %。
         */
        const rawPath = relative.replace(/^file:\/\/\/?/i, '');
        try {
          sourcePath = decodeURIComponent(rawPath);
        } catch {
          sourcePath = rawPath;
        }
      } else {
        sourcePath = path.join(app.getPath('userData'), relative);
      }
      if (!fs.existsSync(sourcePath)) throw new Error('动态背景文件不存在，可能已被清理');

      const defaultName = `${safeFileName(game.name)}-启动页动图.mp4`;
      const result = await dialog.showSaveDialog(win, {
        title: '保存动态背景',
        defaultPath: path.join(
          portableDownloads || app.getPath('downloads'),
          defaultName
        ),
        filters: [{ name: '视频', extensions: ['mp4', 'webm'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      await fsp.copyFile(sourcePath, result.filePath);
      const stat = await fsp.stat(result.filePath);
      return { ok: true, path: result.filePath, bytes: stat.size };
    });

    /*
     * 完整更新说明（更新说明.md）。
     *
     * 这个文件以前只躺在源码目录里，程序内读不到 —— 用户想看「这一版到底改了什么」，
     * 只能去仓库里翻。现在它跟着 asar 一起打包，设置页「关于」里能直接打开看。
     * 读不到就返回空字符串，界面自己给一句提示，不弹错。
     */
    ipcMain.handle('app:changelog', async () => {
      try {
        const file = path.join(ROOT, '更新说明.md');
        return await fsp.readFile(file, 'utf8');
      } catch {
        return '';
      }
    });

    ipcMain.handle('news:list', async () => {
      try {
        const file = path.join(ROOT, 'src', 'data', 'news.json');
        return JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch {
        return [];
      }
    });
}

module.exports = { installMiscIpc };
