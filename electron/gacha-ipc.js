'use strict';

const { ipcMain, app, dialog, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { loadSecret, saveSecret } = require('./secret-store');

const { loadGachaHistory } = require('./gacha');
// loadGachaMeta 在 gacha-meta.js，不在 gacha.js。
// 模块化拆分时这里误写成从 gacha.js 解构，导致 gacha:refresh-meta 一调就
// "loadGachaMeta is not a function"（图鉴刷新按钮点了没反应）。
const { loadGachaMeta } = require('./gacha-meta');
const { syncGacha, extractUrlFromCache } = require('./gacha-sync');
const nteTool = require('./nte-tool');
const nteCapture = require('./nte-capture');
const { syncEndfieldGacha, readTokenFromLog } = require('./endfield-gacha');
const miyoushe = require('./miyoushe-login');
const { importUigf, importsPath } = require('./gacha-import');

const arknightsGacha = require('./arknights-gacha');
const stokenSync = require('./stoken-sync');
const gachaBackup = require('./gacha-backup');
const qrLogin = require('./qr-login');
const gachaIcons = require('./gacha-icons');
const roster = require('./roster');
const kuroGacha = require('./kuro-gacha');
const kuroPredownload = require('./kuro-predownload');
const renderApi = require('./render-api');

/* 云备份密码 / 加密口令在 safeStorage 里的键名，与 main.js 里那份必须一致 */
const GACHA_BACKUP_PASSWORD_KEY = 'gachaBackupPassword';
const GACHA_BACKUP_SECRET_KEY = 'gachaBackupSecret';

/**
 * 抽卡记录：同步、导入、SToken 账号、云备份、meta 刷新。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC，改一处要在万字里找位置）。搬运时逻辑未改。
 *
 * 这些 handler 在原来的文件里被 endfield / servers / games / predownload 的 handler 穿插，
 * 所以是按名字逐个挑出来的，不是连续区间。
 */

function installGachaIpc(ctx) {
  const {
    getStore,
    gachaBackupSnapshot,
    gachaBackupCredentials,
    pushState,
    readHoyolabStore,
    pickHoyolabAccount,
    win,
    send,
    // 重构拆分时漏掉的依赖（原来都在 main.js 作用域里，模块内直接用了 → ReferenceError）
    targetExists,
    publicGame,
    running,                    // const Map，按值传即同一实例
    refreshGachaSecretFlags,
    scheduleGachaBackup,
    runGachaBackup,
    detectStarwardDbPath,
    nteGachaDir,
    refreshNteAccount,
    scanNteGachaDrops,
    hoyolabAccountLabel,
    verifyHoyolabAccount,
    stopScanSession,
    qrLog,
    getNteToolAbort,
    setNteToolAbortCtx,
    setScanSessionCtx,
    setGachaBackupFailStreakCtx,
    setGachaBackupRetryAtCtx,
  } = ctx;

  /* 云备份的两个计数器是 main.js 的模块级 let，必须走 getter/setter，不能 const 赋值 */
  const resetBackupBackoff = () => {
    if (typeof setGachaBackupFailStreakCtx === 'function') setGachaBackupFailStreakCtx(0);
    if (typeof setGachaBackupRetryAtCtx === 'function') setGachaBackupRetryAtCtx(0);
  };

  /* nteToolAbort / scanSession 同样是模块级 let，存的是 AbortController / 扫码会话 */
  const nteToolAbort = () => (typeof getNteToolAbort === 'function' ? getNteToolAbort() : null);
  const setNteToolAbort = (value) => {
    if (typeof setNteToolAbortCtx === 'function') setNteToolAbortCtx(value);
  };
  const setScanSession = (value) => {
    if (typeof setScanSessionCtx === 'function') setScanSessionCtx(value);
  };

    ipcMain.handle('gacha:sync', async (_event, input = {}) => {
      const game = getStore().data.games.find((item) => item.id === input?.gameId);
      if (!game || !['genshin', 'starrail', 'zzz', 'endfield', 'wutheringwaves', 'arknights'].includes(game.builtinKey)) {
        throw new Error('这个游戏没有接入官方抽卡同步');
      }
      /*
       * 明日方舟：走鹰角账号通行证（hypergryph-accounts.json），和米哈游的
       * SToken 完全是两套账号。以前白名单里没有 arknights，四项同步菜单里
       * 「从鹰角账号获取 / 全量 / 增量」点了必然报「这个游戏没有接入官方抽卡同步」。
       * 这里单独分流：syncAccount 自己认 activeId，没绑会回 needToken，
       * 前端 runGachaSync 收到后弹鹰角账号绑定窗（openGachaAkModal）。
       */
      if (game.builtinKey === 'arknights') {
        return arknightsGacha.syncAccount(app.getPath('userData'), {
          accountId: input?.accountId,
          full: input?.full === true,
        });
      }
      if (game.builtinKey === 'wutheringwaves') {
        // 鸣潮：分享链接路线。链接在 Client 日志里（ELog XOR 加密），
        // 一次分享可查 11 个卡池；没有米哈游那种缓存，必须用户点过一次分享。
        const server = (game.servers || []).find((item) => item.id === game.activeServerId);
        // 本体根（不是 exe 所在层）：鸣潮的分享日志在 <根>\Client\Saved\Logs，
        // 老数据里 server.root 可能被填成 Client\Binaries\Win64，这里向上找回来。
        const installRoot =
          kuroPredownload.findKuroClientRoot(server?.root || '') ||
          kuroPredownload.findKuroClientRoot(server?.path || '') ||
          server?.root ||
          '';
        if (!installRoot || !targetExists(server?.path)) {
          throw new Error('先配置鸣潮的客户端路径');
        }
        try {
          return await kuroGacha.syncWuwaGacha({
            installRoot,
            userData: app.getPath('userData'),
            manualLink: input?.link,
          });
        } catch (error) {
          if (error?.needShare) {
            return { ok: false, needShare: true, error: String(error.message) };
          }
          throw error;
        }
      }
      if (game.builtinKey === 'endfield') {
        let auth = input?.auth;
        if (!auth) {
          try {
            auth = JSON.parse(await loadSecret('endfield'));
          } catch {
            auth = null;
          }
        }
        // 优先读游戏自己写的日志：只要玩家打开过一次抽卡记录，
        // 里面就有最新的 u8_token，完全不需要弹网页登录窗口。
        if (!auth?.token) {
          try {
            // 历史上这里写的是 readEndfieldTokenFromLog()，那个名字从来没存在过，
            // 异常被下面的 catch 吞掉，等于这条路一直是死的。真名是 readTokenFromLog。
            const fromLog = readTokenFromLog();
            if (fromLog?.token) auth = fromLog;
          } catch {
            /* 日志不存在或格式变化时忽略 */
          }
        }
        if (!auth?.token) {
          // 只有真正拿不到 token 才需要用户介入。
          // Electron 的 invoke 会丢掉自定义 error.code，所以用结构化结果返回。
          return {
            ok: false,
            needLogin: true,
            error: '没有读到终末地抽卡凭据。请先在游戏里打开一次「抽卡记录」页面，再回来点同步；如果仍然失败，再选择网页登录。',
          };
        }
        try {
          const result = await syncEndfieldGacha({ userData: app.getPath('userData'), auth });
          await saveSecret('endfield', JSON.stringify(auth)).catch(() => {});
          return { ok: true, ...result };
        } catch (error) {
          if (/token|40100|登录|到期|invalid/i.test(String(error.message))) {
            await saveSecret('endfield', '').catch(() => {});
            // 凭据失效：告诉界面可以走网页登录，而不是让用户面对一段报错
            return {
              ok: false,
              needLogin: true,
              error: String(error.message || '终末地登录已失效'),
            };
          }
          throw error;
        }
      }
      /*
       * 从这里开始是米哈游三款游戏（原神 / 星铁 / 绝区零）。
       *
       * 顺序是「SToken 优先，缓存兜底」，不是随便排的：
       *   - SToken 绑过一次就一直能用，不碰游戏、不会 24 小时过期，还能认国际服；
       *   - 缓存那条链接只有 24 小时寿命，而且要求用户先去游戏里点一次抽卡记录。
       * 所以只要有账号就先走 SToken。失败时（没绑、网络断了、authkey 被拒）
       * 自动退回老路，失败原因一起带回去，界面才知道该提示什么。
       *
       * 星铁是唯一的例外：genAuthKey 给它签出来的 key 服务端一律回 -100，
       * 拿 SToken 怎么试都签不出游戏缓存里那种 684~730 字符的 key（那串是
       * 游戏内 SDK 会话签的，外部复现不了）。所以星铁直接从缓存读 —— 走
       * SToken 只会白打一次接口，还把「请打开一次跃迁记录」这件事盖掉。
       */
      const userData = app.getPath('userData');
      const accountId = String(input?.accountId || '');
      let tokenError = '';
      /*
       * 用户手动粘进来的抽卡链接：优先级最高，直接把缓存和 SToken 都绕过。
       * 这是「游戏缓存读不到、SToken 又签不出 key」时唯一还能走通的路，
       * 也是四项菜单里「手动输入 URL」那一项的落点。
       */
      if (input?.manualUrl) {
        const server = (game.servers || []).find((item) => item.id === game.activeServerId);
        return syncGacha({
          game: game.builtinKey,
          installRoot: server?.root || '',
          userData,
          uid: input?.uid,
          manualUrl: String(input.manualUrl),
          full: input?.full === true,
        });
      }
      if (game.builtinKey === 'starrail') {
        /*
         * 星铁专用：跳过 SToken，直接读缓存。
         * 注意这里必须放在 token 分支之前，否则界面拿到的永远是
         * 「SToken 可能已经失效」，用户会去重新绑一个本来就绑好的账号。
         * 也不用看 allowCache —— 星铁走 SToken 必然失败，那条路没有任何意义。
         */
        const server = (game.servers || []).find((item) => item.id === game.activeServerId);
        if (!server?.root || !targetExists(server.path)) {
          throw new Error('先配置星铁的客户端路径');
        }
        return syncGacha({
          game: game.builtinKey,
          installRoot: server.root,
          userData,
          uid: input?.uid,
          full: input?.full === true,
        });
      }
      /*
       * 四项同步菜单里「从 SToken 获取」要真的只用 SToken，「从网页缓存获取」
       * 要真的只用缓存。以前前端只有 allowCache（控制 SToken 失败后是否兜底），
       * 绑了 SToken 时点「从网页缓存获取」仍会先走 SToken，等于骗用户。
       *
       * 这两个开关只影响米哈游三款：星铁 / 终末地 / 鸣潮 / 方舟在前面都已
       * 各自分流，不经过这段。
       */
      const stokenOnly = input?.stokenOnly === true;
      const cacheOnly = input?.cacheOnly === true;
      if (!cacheOnly) {
        try {
          const store = stokenSync.listAccounts(userData);
          /*
           * 多账号时不能只看 activeId。
           *
           * 实测：activeId 是账号 B，但抽卡页停的是账号 A 的原神 UID，
           * 拿着 B 的 SToken 去申 A 的 authkey，米哈游回
           * 「角色还未绑定通行证账号」—— 用户看到这句只会以为 SToken 坏了。
           * 有 uid 就先按 uid 反查归属账号，查不到才退回 activeId。
           */
          /*
           * 账号库就在上面那行 listAccounts 的返回值里，不要再问 getStore() 要。
           *
           * getStore() 是 JsonStore 实例，账号挂在 getStore().data 上；写成
           * getStore().accounts 恒为 undefined，后面一 .find 就抛
           * 「Cannot read properties of undefined (reading 'find')」——
           * 表现是点「从 SToken 获取」后整块菜单变灰、只留一行英文报错，
           * 缓存兜底也走不到（异常被外层 catch 吞成 tokenError）。
           * 而且这里要的本来就是 SToken 账号库（stoken-accounts.json），
           * 和 JsonStore 里的 games 是两回事。
           */
          const knownAccounts = store.accounts || [];
          const targetUid = String(input?.uid || '');
          const owner = targetUid
            ? knownAccounts.find((item) =>
                (item.roles || []).some(
                  (role) => String(role.uid) === targetUid && (!role.game || role.game === game.builtinKey)
                )
              )
            : null;
          const account =
            (accountId && knownAccounts.find((item) => item.id === String(accountId))) ||
            owner ||
            knownAccounts.find((item) => item.id === store.activeId);
          if (account) {
            /* 换成 owner 之后也要同步把 uid 定准，别再让两边对不上 */
            const uid = targetUid || String(account.roles?.find((role) => role.game === game.builtinKey)?.uid || '');
            const result = await stokenSync.syncWithAccount(userData, {
              accountId: account.id,
              game: game.builtinKey,
              uid,
              full: input?.full === true,
            });
            if (result.ok) return result;
            /*
             * 没绑 SToken 是「缺凭据」，不是「链接过期」。
             * 再走缓存只会拿到一句误导人的「抽卡链接已过期」，直接回给界面。
             */
            if (result.needStoken) return { ...result, triedCache: false };
            tokenError = result.error || 'SToken 同步失败';
            if (stokenOnly || !input?.allowCache) return { ...result, triedCache: false };
          } else if (stokenOnly) {
            /* 强制 SToken 但一个账号都没绑：别偷偷落到下面的缓存分支 */
            return {
              ok: false,
              needStoken: true,
              error: '还没绑 SToken。点左下角头像 →「抽卡账号」扫一次码，以后就不用开游戏了。',
            };
          }
        } catch (error) {
          tokenError = String(error?.message || error);
          if (stokenOnly || !input?.allowCache) return { ok: false, error: tokenError, triedCache: false };
        }
      }

      const server = (game.servers || []).find((item) => item.id === game.activeServerId);
      let installRoot = server?.root;
      if (!installRoot && game.target) installRoot = path.dirname(game.target);
      if (!installRoot && server?.path) installRoot = path.dirname(server.path);
      if (!installRoot || !targetExists(server?.path)) {
        throw new Error(tokenError || '先配置这个游戏的客户端路径');
      }
      /*
       * 手动同步的错误要带结构化字段回界面（Electron 的 invoke 会把自定义
       * error.code / error.rateLimited 全丢掉，只剩 message），所以这里自己
       * catch 一层：限流、正在同步、链接过期 三种给不同的可操作提示。
       */
      try {
        const cachedResult = await syncGacha({
          game: game.builtinKey,
          installRoot,
          userData,
          // 绑了 SToken 的话 uid 是已知的：没有抽卡记录的新号第一条返回永远是空，
          // 靠猜 UID 会直接判成「链接过期」。
          uid: input?.uid,
          full: input?.full === true,
        });
        return tokenError ? { ...cachedResult, warning: tokenError } : cachedResult;
      } catch (error) {
        if (error?.rateLimited) {
          return {
            ok: false,
            rateLimited: true,
            retryAfterMs: Number(error.cooldownMs) || 10 * 60 * 1000,
            error: String(error.message || '抽卡接口被限流了，等十来分钟再试'),
          };
        }
        if (error?.busy) {
          return { ok: false, busy: true, error: String(error.message || '这个游戏的抽卡记录正在同步中') };
        }
        throw error;
      }
    });

    ipcMain.handle('gacha:ak-list', async () => arknightsGacha.listAccounts(app.getPath('userData')));

    ipcMain.handle('gacha:ak-bind', async (_event, input = {}) => {
      try {
        return await arknightsGacha.bindAccount(app.getPath('userData'), { token: String(input?.token || '') });
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    });

    ipcMain.handle('gacha:ak-login', async () => {
      const ses = session.fromPartition('persist:hypergryph');
      return new Promise((resolve) => {
        let settled = false;
        let polling = false;
        const finish = (payload) => {
          if (settled) return;
          settled = true;
          clearInterval(poll);
          clearTimeout(timeout);
          try {
            if (akWindow && !akWindow.isDestroyed()) akWindow.close();
          } catch {}
          resolve(payload);
        };
        const akWindow = new BrowserWindow({
          width: 1000,
          height: 760,
          parent: win && !win.isDestroyed() ? win : undefined,
          modal: false,
          show: true,
          title: '登录鹰角账号',
          autoHideMenuBar: true,
          webPreferences: {
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        akWindow.setMenuBarVisibility(false);
        akWindow.on('closed', () => finish({ ok: false, cancelled: true, error: '已取消登录' }));
        akWindow.loadURL('https://user.hypergryph.com/userInfo').catch(() => {});

        const poll = setInterval(async () => {
          if (settled || polling || !akWindow || akWindow.isDestroyed()) return;
          polling = true;
          try {
            const all = await ses.cookies.get({});
            const picked = all.filter((item) => /hypergryph\.com$/i.test(String(item.domain || '').replace(/^\./, '')));
            if (!picked.length) return;
            const cookieStr = picked.map((item) => item.name + '=' + item.value).join('; ');
            const token = await arknightsGacha.tokenFromCookies(cookieStr);
            if (!token.ok) return;
            const result = await arknightsGacha.bindAccount(app.getPath('userData'), { token: token.token });
            finish(result && result.ok === false ? result : { ok: true, ...result });
          } catch (error) {
            /* 轮询里的异常不当作失败，等下一轮；超时才有最终结论 */
          } finally {
            polling = false;
          }
        }, 1500);

        const timeout = setTimeout(() => {
          finish({ ok: false, error: '等太久了，登录窗口先关掉了。可以重试，或者手动把 token 粘进来。' });
        }, 5 * 60 * 1000);
      });
    });

    ipcMain.handle('gacha:ak-remove', async (_event, input = {}) =>
      arknightsGacha.removeAccount(app.getPath('userData'), input?.id)
    );

    ipcMain.handle('gacha:ak-active', async (_event, input = {}) =>
      arknightsGacha.setActiveAccount(app.getPath('userData'), input?.id)
    );

    ipcMain.handle('games:render-api', async (_event, id, mode) => {
      const game = getStore().data.games.find((item) => item.id === id);
      if (!game) throw new Error('没有找到这个游戏');
      // 参数只在启动那一刻传给客户端，运行中改了也不会生效，直接挡住比让它「看起来成功了」好
      if (running.has(id)) throw new Error('游戏正在运行，关掉之后再切换渲染后端');
      game.renderApi = renderApi.normalizeMode(mode);
      await getStore().saveNow();
      pushState(true);
      return publicGame(game);
    });

    ipcMain.handle('gacha:nte-tool', async (_event, _input) => {
      if (nteToolAbort()) throw new Error('工具正在下载中');
      const controller = new AbortController();
      setNteToolAbort(controller);
      try {
        const result = await nteTool.run({
          downloadsDir: app.getPath('downloads'),
          signal: controller.signal,
          onProgress: (progress) => send('nte-tool', progress),
        });
        // 下载解压完直接打开文件夹，省得用户自己找
        if (result?.dir) shell.openPath(result.dir).catch(() => {});
        return result;
      } finally {
        setNteToolAbort(null);
      }
    });
    ipcMain.handle('gacha:nte-tool-cancel', () => {
      const controller = nteToolAbort();
      if (controller) {
        controller.abort();
        return { ok: true };
      }
      return { ok: false };
    });

    ipcMain.handle('gacha:backup-status', () => gachaBackupSnapshot());

    /*
     * 保存配置。
     *
     * 密码和加密口令走「空串 = 沿用已存的那份」：表单是密码框，回显不了明文，
     * 用户只是想改地址时不该被迫重填密码。要清掉就传 null。
     */
    ipcMain.handle('gacha:backup-save', async (_event, patch = {}) => {
      const settings = getStore().data.settings.gachaBackup;
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
      await getStore().saveNow();
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
        if (result && result.ok !== false) {
          resetBackupBackoff();
        }
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
          userData: app.getPath('userData'),
          name: input && input.name ? String(input.name) : '',
        });
        const settings = getStore().data.settings.gachaBackup;
        settings.lastResult = result.text;
        settings.lastError = '';
        await getStore().saveNow();
        pushState(true);
        return result;
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });

    ipcMain.handle('gacha:backup-now', async () => {
      try {
        return await runGachaBackup('手动');
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });

    ipcMain.handle('gacha:load', async (_event, force = false) => {
      // 用户不需要手动选库：路径为空或已失效时自动重新探测一次
      const configured = getStore().data.settings.starwardDbPath;
      if (!configured || !fs.existsSync(configured)) {
        const detected = detectStarwardDbPath();
        if (detected !== configured) {
          getStore().data.settings.starwardDbPath = detected;
          await getStore().saveNow();
        }
      }
      return loadGachaHistory(
        getStore().data.settings.starwardDbPath,
        path.join(app.getPath('userData'), 'gacha-meta-v2.json'),
        force === true,
        importsPath(app.getPath('userData'))
      );
    });

    ipcMain.handle('gacha:import', async (_event, input = {}) => {
      const result = await dialog.showOpenDialog(win, {
        title: '导入 UIGF 抽卡记录',
        properties: ['openFile'],
        filters: [{ name: 'UIGF / SRGF JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
      const imported = await importUigf({
        filePath: result.filePaths[0],
        userData: app.getPath('userData'),
        game: input?.game,
      });
      return { ...imported, filePath: result.filePaths[0] };
    });

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
      nteCapture.info(app.getPath('userData')),
    );

    ipcMain.handle('gacha:nte-capture-start', async (_event, input = {}) => {
      const result = await nteCapture.start({
        userData: app.getPath('userData'),
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

    ipcMain.handle('gacha:stoken-list', async () => stokenSync.listAccounts(app.getPath('userData')));

    ipcMain.handle('gacha:stoken-bind', async (_event, input = {}) =>
      stokenSync.bindAccount(app.getPath('userData'), {
        input: String(input?.stoken || ''),
        region: input?.region === 'os' ? 'os' : 'cn',
        nickname: String(input?.nickname || ''),
      })
    );

    /*
     * 智能粘贴：用户把从浏览器复制的整段 cookie（或单独的 SToken 值）贴进来，
     * 主进程自己从中挑出 stoken / mid / stuid / login_ticket。
     *
     * 为什么不让用户在界面上挑：cookie 里哪个是哪个对普通用户毫无意义，
     * 而「整段复制、一次粘贴」是所有人都会的动作。
     */
    ipcMain.handle('gacha:stoken-bind-bundle', async (_event, input = {}) =>
      stokenSync.bindBundle(app.getPath('userData'), {
        raw: String(input?.raw || ''),
        region: input?.region === 'os' ? 'os' : 'cn',
        nickname: String(input?.nickname || ''),
      })
    );

    /*
     * 已经登录的米游社 / HoYoLAB 账号列表。
     *
     * 为什么要有这条：SToken 得用户自己去浏览器 F12 里翻，还要连 mid 一起复制。
     * 但「米游社登录」这个功能本来就在，登录窗口落盘的 cookie 里带着 ltoken / ltuid，
     * 用已登录账号建抽卡账号是主路径，粘贴 SToken 只是没登录时的备选。
     */
    ipcMain.handle('gacha:stoken-login-state', async () => {
      const providers = [];
      for (const providerId of ['miyoushe', 'hoyolab']) {
        const loginStore = await readHoyolabStore(providerId);
        providers.push({
          providerId,
          name: providerId === 'hoyolab' ? 'HoYoLAB（国际服）' : '米游社（国服）',
          activeId: loginStore.activeId,
          accounts: loginStore.accounts.map((account) => ({
            id: account.id,
            label: hoyolabAccountLabel(account),
            roles: Array.isArray(account.roles) ? account.roles.length : 0,
          })),
        });
      }
      return { ok: true, providers };
    });

    ipcMain.handle('gacha:stoken-bind-login', async (_event, input = {}) => {
      const providerId = input?.providerId === 'hoyolab' ? 'hoyolab' : 'miyoushe';
      const loginStore = await readHoyolabStore(providerId);
      const account = pickHoyolabAccount(loginStore, input?.accountId);
      if (!account || !account.cookie) {
        return {
          ok: false,
          needLogin: true,
          error: providerId === 'hoyolab'
            ? '还没有登录 HoYoLAB 账号，先去登录一次'
            : '还没有登录米游社账号，先去登录一次',
        };
      }
      const result = await stokenSync.bindFromCookie(app.getPath('userData'), {
        cookie: account.cookie,
        providerId,
        nickname: account.label || hoyolabAccountLabel(account),
      });
      // 绑成功就顺手把这条登录态的角色列表刷新一下，界面上的昵称才不会一直是旧的
      if (result.ok) verifyHoyolabAccount(account, providerId).catch(() => {});
      return result;
    });

    ipcMain.handle('gacha:stoken-scan-start', async (_event, input = {}) => {
      stopScanSession();
      const scanGame = ['genshin', 'starrail', 'zzz', 'bh3'].includes(input?.game) ? input.game : 'genshin';
      const session = new qrLogin.ScanSession({
        game: scanGame,
        userData: app.getPath('userData'),
        onState: (state) => {
          // 状态变化每次都记：成功/失败的消息里没有凭据，可以放心落盘
          qrLog({ at: 'state', status: state.status, message: state.message });
          send('gacha:stoken-scan', state);
        },
        onDebug: (info) => qrLog(info),
        onToken: async (token) => {
          stopScanSession();
          try {
            const result = await stokenSync.bindAccount(app.getPath('userData'), {
              // 扫码回来的是真 SToken + mid，正好是 bindAccount 要的那种输入形态
              input:
                'stoken=' + token.stoken +
                ';mid=' + (token.mid || token.uid) +
                ';stuid=' + (token.uid || token.mid),
              /* 扫码返回里已经带了 ltoken / cookie_token，顺手存下，少发一次请求 */
              ltoken: token.ltoken || '',
              cookieToken: token.cookieToken || '',
              /*
               * 扫码 token 里没有 ltuid，但账号 id 要用 ltuid 口径才能和登录态那条记录合并。
               * 这里读一次登录态：当前激活账号的 id 就是 ltuid。读不到也无所谓，
               * bindAccount 会退回用 mid 当 id。
               */
              ltuid: (() => {
                try {
                  const providerId = input?.region === 'os' ? 'hoyolab' : 'miyoushe';
                  const loginStore = readHoyolabStore(providerId);
                  const account = pickHoyolabAccount(loginStore, '');
                  return account ? String(account.id || '') : '';
                } catch {
                  return '';
                }
              })(),
              region: input?.region === 'os' ? 'os' : 'cn',
            });
            if (result && result.ok) {
              send('gacha:stoken-scan', { status: 'success', game: scanGame, gameName: '', message: '扫好了，这个账号以后可以直接同步', account: result.account });
            } else {
              send('gacha:stoken-scan', { status: 'failed', game: scanGame, gameName: '', message: (result && result.error) || '保存账号失败' });
            }
          } catch (error) {
            send('gacha:stoken-scan', { status: 'failed', game: scanGame, gameName: '', message: String((error && error.message) || error) });
          }
        },
      });
      setScanSession(session);
      await session.start();
      /*
       * 官方 App 扫码是账号级的：一次登录就能拿到所有游戏的权限，
       * 所以这里不再返回「按游戏分」的表，界面上那个游戏下拉也就没有意义了。
       */
      return { ok: true, game: scanGame };
    });

    ipcMain.handle('gacha:stoken-scan-stop', async () => {
      stopScanSession();
      return { ok: true };
    });

    ipcMain.handle('gacha:stoken-remove', async (_event, input = {}) =>
      stokenSync.removeAccount(app.getPath('userData'), input?.id)
    );

    ipcMain.handle('gacha:stoken-active', async (_event, input = {}) =>
      stokenSync.setActiveAccount(app.getPath('userData'), input?.id)
    );

    ipcMain.handle('gacha:stoken-refresh', async (_event, input = {}) =>
      stokenSync.refreshRoles(app.getPath('userData'), input?.id)
    );

    // syncWithAccount 里的 delayMs 是给接口留的间隔，这里不覆盖：
    // 以前全速连发几百次请求，撞限流后被当成普通错误吞掉。
    ipcMain.handle('gacha:stoken-sync', async (_event, input = {}) =>
      stokenSync.syncWithAccount(app.getPath('userData'), {
        accountId: input?.accountId,
        game: input?.game,
        uid: input?.uid,
      })
    );

    ipcMain.handle('gacha:stoken-reveal', async (_event, input = {}) => {
      const tokenStore = stokenSync.listAccounts(app.getPath('userData'));
      const account = tokenStore.accounts.find((item) => item.id === String(input?.id));
      if (!account) throw new Error('这个账号不在列表里');
      // 界面上点「重新绑定」时把旧值填回输入框，省得用户再去翻一次 cookie
      const full = require('./stoken-login').readStokenStore(app.getPath('userData'));
      const target = full.accounts.find((item) => item.id === String(input?.id));
      return { ok: true, stoken: target?.stoken || '', mid: account.mid };
    });

    ipcMain.handle('gacha:refresh-meta', async () => {
      // 强制刷新终末地 / 异环的图鉴缓存，拉到新版本角色和武器
      const metaPath = path.join(app.getPath('userData'), 'gacha-meta-ext.json');
      const meta = await loadGachaMeta(metaPath, true);
      // 原神的头像图鉴（观测枢）：顺手一起刷，用户点「刷新图鉴」时都更新
      const icons = await gachaIcons.loadIcons(path.join(app.getPath('userData'), 'genshin-icons.json'), true).catch(() => null);
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
      const result = await dialog.showOpenDialog(win, {
        title: '选择抽卡记录数据库',
        properties: ['openFile'],
        filters: [{ name: '抽卡记录数据库', extensions: ['db', 'sqlite', 'sqlite3'] }],
      });
      if (result.canceled) return null;
      const dbPath = result.filePaths[0];
      getStore().data.settings.starwardDbPath = dbPath;
      await getStore().saveNow();
      pushState(true);
      return dbPath;
    });
}

module.exports = { installGachaIpc };
