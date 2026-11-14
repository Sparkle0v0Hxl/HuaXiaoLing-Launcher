'use strict';

const { ipcMain, BrowserWindow, session, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');

const miyoushe = require('./miyoushe-login');
const gameFeatures = require('./game-features');
const accountProfile = require('./account-profile');
const passport = require('./passport-login');

/**
 * 米游社 / HoYoLAB 登录态与战绩。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC，改一处要在万字里找位置）。搬运时逻辑未改。
 */

function installHoyolabIpc(ctx) {
  const { store, win, pushState, readHoyolabStore, writeHoyolabStore, pickHoyolabAccount, verifyHoyolabAccount, hoyolabAccountId, publicHoyolabAccount } = ctx;

    ipcMain.handle('hoyolab:login', async (_event, input = {}) => {
      const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
      const provider = miyoushe.PROVIDERS[providerId];
      const targetGame = gameFeatures.normalizeKey(input.game || 'genshin');
      const url = provider.site?.[targetGame] || provider.home;

      const ses = session.fromPartition(`persist:hoyolab-${providerId}`);

      /*
       * 「添加账号」时先把登录窗口的会话清干净。
       *
       * 登录窗口和已保存的账号是两个东西：已登录的 cookie 存在 safeStorage 里，
       * 而窗口这个 persist 分区里还留着上一次的登录态。不清的话，点「添加账号」
       * 打开米游社就直接是已登录的旧账号，轮询立刻把同一个账号再存一遍 ——
       * 用户永远加不上第二个通行证。
       */
      if (input.addAccount) {
        try {
          await ses.clearStorageData({
            storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
          });
        } catch {}
      }

      return new Promise((resolve) => {
        let settled = false;
        /** 是否已经注过「自动点头像」脚本（只注一次，见下面的注释）。 */
        let dialogInjected = false;
        /** 上次注入的时间，用于挡住站点自己在 1 秒内重复刷新。 */
        let dialogInjectedAt = 0;
        /** 最近一次 cookie 校验失败的原因，超时后一起报给用户。 */
        let lastVerifyReason = '';
        const DIALOG_INJECT_COOLDOWN = 1200;
        const finish = (payload) => {
          if (settled) return;
          settled = true;
          clearInterval(poll);
          clearTimeout(timeout);
          try {
            if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
          } catch {}
          resolve(payload);
        };

        const loginWindow = new BrowserWindow({
          width: 1080,
          height: 800,
          parent: win && !win.isDestroyed() ? win : undefined,
          modal: false,
          show: true,
          title: `登录${provider.label}`,
          autoHideMenuBar: true,
          webPreferences: {
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        loginWindow.setMenuBarVisibility(false);
        loginWindow.webContents.setUserAgent(miyoushe.UA);

        /*
         * 只注一次，而且只认主文档加载完成。
         *
         * 这里踩过的坑：以前每收到 did-finish-load / did-navigate 就注一次，
         * 而米游社是 SPA——首屏就会触发两次 did-navigate-in-page，登录框本身又是跨域 iframe，
         * 它每次重建都会再带回一个加载事件 → 再注一次 → 再点头像 → iframe 再重建。
         * 实测 18 秒里 iframe 被重建了 100 多次，页面上永远是转圈，
         * 用户既输入不了也扫不了码（就是「登录框一直弹出」那个症状）。
         *
         * 现在的约束：
         * - 只挂 did-frame-finish-load（只认主框架）和 did-stop-loading，且注入幂等；
         * - 注入的脚本自己带幂等锁，同一个文档里最多点一次头像；
         * - 1.2 秒内的重复完成加载不再注入，避免站点自己刷新时把弹窗关掉重开。
         */
        const injectDialog = (why) => {
          if (!provider.openDialogScript) return;
          if (dialogInjected) return;
          if (dialogInjectedAt && Date.now() - dialogInjectedAt < DIALOG_INJECT_COOLDOWN) return;
          dialogInjected = true;
          dialogInjectedAt = Date.now();
          loginWindow.webContents.executeJavaScript(provider.openDialogScript, true).catch(() => {});
          if (process.env.HXL_LOGIN_DEBUG) console.log(`[login] inject openDialogScript via ${why}`);
        };

        /*
         * 只认主框架完成加载，子框架（比如登录框那个跨域 iframe）的加载一律不理。
         * 这是上面那段死循环的真正入口：以前 iframe 每重建一次就会重新注入一次脚本。
         */
        loginWindow.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
          if (isMainFrame) injectDialog('did-frame-finish-load');
        });
        loginWindow.webContents.on('did-stop-loading', () => injectDialog('did-stop-loading'));

        /*
         * 主框架换页（登录成功后往回跳、或站点自己刷新）时解锁一次，
         * 这样新文档里还能再点一次头像；子框架导航不触发这条。
         */
        loginWindow.webContents.on('did-navigate', () => {
          dialogInjected = false;
        });

        loginWindow.on('closed', () => {
          finish({ ok: false, cancelled: true, reason: '已取消登录' });
        });

        loginWindow.loadURL(url).catch(() => {});

        /*
         * 轮询 cookie：用户一登录成功，米游社就会种下登录 cookie，
         * 我们这边立刻收工，不需要用户手动点「完成」。
         *
         * 注意 get({}) 拿到的 cookie 是全站点的，米游社会把 cookie_token_v2 等
         * 同时写在 user.miyoushe.com / passport.miyoushe.com 多个子域上，
         * filterCookies 会按「域名 + 名字」保留，拼请求头时这些都带上。
         */
        const poll = setInterval(async () => {
          if (settled || !loginWindow || loginWindow.isDestroyed()) return;
          try {
            const all = await ses.cookies.get({});
            const picked = miyoushe.filterCookies(all, provider.cookieDomains);
            if (!miyoushe.hasLoginCookie(picked)) return;
            const cookieStr = miyoushe.cookieHeader(picked);
            const result = await miyoushe.verifyCookie(cookieStr, providerId);
            if (!result.ok) {
              /*
               * 有 cookie 但接口说无效：这通常是站点还没把 cookie 写全
               * （扫码刚完成的那一两秒），或者账号确实已失效。
               * 不要立刻放弃，记住原因继续轮询，超时后再报给用户。
               */
              lastVerifyReason = result.reason || '';
              return;
            }
            /*
             * 存成账号列表：同一个通行证账号重新登录就覆盖那一条，
             * 不同账号则新增，并把新登录的这个设为当前账号。
             */
            const store = await readHoyolabStore(providerId);
            const accountId = hoyolabAccountId(cookieStr) || `a${Date.now().toString(36)}`;
            const account = {
              id: accountId,
              cookie: cookieStr,
              savedAt: Date.now(),
              roles: result.roles || [],
              label: '',
            };
            const index = store.accounts.findIndex((item) => item.id === accountId);
            if (index >= 0) store.accounts[index] = account;
            else store.accounts.push(account);
            store.activeId = accountId;
            await writeHoyolabStore(providerId, store);
            finish({
              ok: true,
              provider: providerId,
              roles: result.roles,
              accountId,
              activeId: accountId,
              accounts: store.accounts.map(publicHoyolabAccount),
            });
          } catch (error) {
            lastVerifyReason = String(error?.message || error);
            // 网络抖动就下一轮再试
          }
        }, 1200);

        const timeout = setTimeout(() => {
          finish({
            ok: false,
            cancelled: true,
            reason: lastVerifyReason
              ? `登录超时（5 分钟）：${lastVerifyReason}`
              : '登录超时（5 分钟）：没有读到米游社的登录 cookie，请确认扫码后页面显示已登录',
          });
        }, 5 * 60 * 1000);
      });
    });

    /*
     * 登录状态查询。
     *
     * 多账号之后这里返回的是「账号列表 + 当前账号的角色」：
     * 只验证当前激活的那一个账号（verifyCookie 一轮就是四个 gameBiz 请求，
     * 账号一多会明显拖慢启动），其它账号直接用上次缓存的角色列表。
     */
    ipcMain.handle('hoyolab:status', async (_event, input = {}) => {
      const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
      let store;
      try {
        store = await readHoyolabStore(providerId);
      } catch (error) {
        return { ok: true, loggedIn: false, roles: [], accounts: [], activeId: '', reason: '登录状态损坏，请重新登录' };
      }
      const accounts = store.accounts.map(publicHoyolabAccount);
      if (!store.accounts.length) {
        return { ok: true, loggedIn: false, roles: [], accounts: [], activeId: '' };
      }

      const account = pickHoyolabAccount(store, input.accountId) || store.accounts[0];
      const verify = await verifyHoyolabAccount(account, providerId);
      if (verify.ok) {
        // 角色列表刷新过就顺手写回去，下次启动不用再查
        try {
          await writeHoyolabStore(providerId, store);
        } catch {}
      }
      return {
        ok: true,
        loggedIn: verify.ok,
        roles: verify.ok ? verify.roles : account.roles || [],
        accounts: store.accounts.map(publicHoyolabAccount),
        activeId: account.id,
        savedAt: account.savedAt || 0,
        reason: verify.ok ? '' : verify.reason || '',
      };
    });

    /*
     * 切换当前账号。
     * 只改 activeId，不重新登录；角色列表跟着新账号走。
     */
    ipcMain.handle('hoyolab:switch', async (_event, input = {}) => {
      const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
      const store = await readHoyolabStore(providerId);
      const account = pickHoyolabAccount(store, input.accountId);
      if (!account) return { ok: false, reason: '还没有登录米游社', accounts: [], activeId: '', roles: [] };
      store.activeId = account.id;
      const verify = await verifyHoyolabAccount(account, providerId);
      try {
        await writeHoyolabStore(providerId, store);
      } catch {}
      return {
        ok: true,
        loggedIn: verify.ok,
        roles: verify.ok ? verify.roles : account.roles || [],
        accounts: store.accounts.map(publicHoyolabAccount),
        activeId: account.id,
        reason: verify.ok ? '' : verify.reason || '',
      };
    });

    /*
     * 退出登录。
     *   { provider, id } —— 只移除这一个账号（删的是当前账号就自动切到第一个）
     *   { provider }     —— 移除全部账号并清掉登录窗口的 cookie
     */
    ipcMain.handle('hoyolab:logout', async (_event, input = {}) => {
      const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
      const removeId = String(input.id || '');
      const store = await readHoyolabStore(providerId);

      if (removeId && store.accounts.some((account) => account.id === removeId)) {
        store.accounts = store.accounts.filter((account) => account.id !== removeId);
        if (store.activeId === removeId) store.activeId = store.accounts[0]?.id || '';
        await writeHoyolabStore(providerId, store);
        // 只有全删光了才清 cookie 分区，否则会顺手把别的账号也一起踢掉
        if (!store.accounts.length) {
          try {
            const ses = session.fromPartition(`persist:hoyolab-${providerId}`);
            await ses.clearStorageData({ storages: ['cookies'] });
          } catch {}
        }
        return {
          ok: true,
          removedId: removeId,
          accounts: store.accounts.map(publicHoyolabAccount),
          activeId: store.activeId,
        };
      }

      await saveSecret(`hoyolab-${providerId}`, '');
      try {
        const ses = session.fromPartition(`persist:hoyolab-${providerId}`);
        await ses.clearStorageData({ storages: ['cookies'] });
      } catch {}
      return { ok: true, accounts: [], activeId: '' };
    });

    /*
     * 战绩数据（每日便笺 / 深渊 / 剧场…）。
     * 接口路径由能力注册表（game-features.js 的 TRAITS）给出，这里只负责：
     * 补 cookie、拼查询参数、补 DS2、选对宿主与 Referer。
     *
     * 两种入参，都保留：
     *   { provider, api }                        —— 旧用法：直接给相对路径
     *   { provider, game, feature, uid, region } —— 新用法：路径和参数都从 TRAITS 来
     *
     * 新用法里 uid/region 由渲染层从角色列表带过来。放在渲染层是因为
     * hoyolab:status 本来就会把角色列表返回给前端，前端已经在展示它；
     * 如果这里再查一遍 passport，每点一次卡片就多四次网络请求。
     */
    /*
     * 通行证账号的社区昵称与头像。
     *
     * 登录态里只有 cookie，没有头像也没有社区昵称 —— 账号列表要长得像胡桃那样
     * （圆头像 + 昵称），就得单独查一次公开资料。这个接口不需要 cookie，
     * 按 uid 就能查；国际服在国内 IP 下会被 region_block 挡掉，那就退回
     * 昵称首字，不报错。
     */
    ipcMain.handle('hoyolab:profile', async (_event, input = {}) => {
      const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
      const uid = String(input.uid || input.accountId || '');
      if (!uid) return { ok: false, error: '没有账号 id', nickname: '', avatarUrl: '' };
      return accountProfile.getProfile(app.getPath('userData'), providerId, uid, input.force === true);
    });
    ipcMain.handle('hoyolab:record', async (_event, input = {}) => {
      const providerId = input.provider === 'hoyolab' ? 'hoyolab' : 'miyoushe';
      const store = await readHoyolabStore(providerId);
      if (!store.accounts.length) {
        return { ok: false, error: '还没有登录米游社，请先在工具页点「登录」', retcode: null, url: '', debug: null };
      }
      /*
       * 战绩归属于某个具体的通行证账号：按 accountId 取，没指定就用当前激活的那个。
       * 这一步必须在拼接口之前定下来 —— 不同账号的 uid 不能混着查。
       */
      const account = pickHoyolabAccount(store, input.accountId);
      if (!account) {
        return { ok: false, error: '没有找到这个米游社账号，请重新登录', retcode: null, url: '', debug: null };
      }
      const saved = account;

      const provider = gameFeatures.LOGIN_PROVIDERS[providerId] || gameFeatures.LOGIN_PROVIDERS.miyoushe;
      let api = String(input.api || '');
      let referer = '';
      let withDs = true;

      if (input.game && input.feature) {
        const trait = gameFeatures.traitOf(input.game, input.feature);
        if (!trait || trait.kind !== 'game-record') {
          throw new Error('这个功能不在战绩接口的支持范围内');
        }
        /*
         * 留一个「接口已下线」的出口：trait 上写了 unavailable 就直接回一句人话。
         * 这里 return 而不是 throw —— throw 穿过 IPC 会变
         * 「Error invoking remote method ...」，界面上就是一句没法读的错误。
         * （原来绝区零的临界推演走的是这条，后来整条功能被删掉了，出口留着备用。）
         */
        if (trait.unavailable) {
          return { ok: false, error: String(trait.unavailable), retcode: null, url: '', debug: null };
        }
        const uid = String(input.uid || '').trim();
        const region = String(input.region || '').trim();
        if (!uid || !region) {
          throw new Error('没有读到这个游戏的角色，请先在工具页重新登录一次');
        }
        // schedule_type：1 当期，2 上期。只有深渊类接口模板里带 {schedule}
        const schedule = Number(input.schedule) === 2 ? 2 : 1;
        api = String(trait.api)
          .replace(/\{server\}/g, encodeURIComponent(region))
          .replace(/\{role_id\}/g, encodeURIComponent(uid))
          .replace(/\{region\}/g, encodeURIComponent(region))
          .replace(/\{uid\}/g, encodeURIComponent(uid))
          .replace(/\{schedule\}/g, String(schedule));
        if (/\{[a-z_]+\}/.test(api)) {
          throw new Error(`接口模板里还有没替换的参数：${api}`);
        }
        const baseKey = trait.host === 'act' ? 'act' : 'record';
        const base = provider.api && provider.api[baseKey];
        if (!base) {
          throw new Error('当前登录通道没有接入这个功能（国际服暂未接入战绩查询）');
        }
        api = `${base}${api}`;
        referer = trait.referer === 'act' ? provider.api.refererAct : provider.api.refererRecord;
        withDs = trait.ds !== false;
      } else {
        if (!api.startsWith('/')) throw new Error('接口路径不合法');
        referer = input.referer === 'act' ? provider.api.refererAct : provider.api.refererRecord;
      }

      /*
       * 排查用的请求头矩阵：同一个地址依次换几种头组合打一遍，
       * 把每个组合的 retcode 一起带回去。5003 这类风控错误光看一句话
       * 根本判断不出是哪个头被拒，只能这样 A/B。
       */
      if (input.probe) {
        const variants = [
          { name: 'A 现状（全部头 + DS2）', opts: {} },
          { name: 'B 全部头、不带 DS2', opts: { ds: false } },
          { name: 'C 去掉 X-Requested-With + DS2', opts: { withXrw: false } },
          { name: 'D 去掉 X-Requested-With、不带 DS2', opts: { withXrw: false, ds: false } },
          { name: 'E 去掉 XRW + Origin + DS2', opts: { withXrw: false, origin: 'https://webstatic.mihoyo.com' } },
          { name: 'F 固定指纹 0000000000000 + DS2', opts: { deviceFp: '0000000000000' } },
          { name: 'G client_type=2 + DS2', opts: { clientType: '2' } },
          { name: 'H 桌面 UA + DS2', opts: { ua: miyoushe.UA } },
        ];
        const results = [];
        for (const variant of variants) {
          try {
            const data = await miyoushe.fetchRecord(api, saved.cookie, providerId, {
              referer,
              ds: withDs && variant.opts.ds !== false,
              ...variant.opts,
            });
            results.push({
              name: variant.name,
              ok: true,
              keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 6) : [],
            });
          } catch (error) {
            results.push({
              name: variant.name,
              ok: false,
              retcode: error.retcode === undefined ? null : error.retcode,
              message: error.message || String(error),
            });
          }
        }
        return { ok: true, probe: results, url: api, deviceFp: await miyoushe.ensureDeviceFp(saved.cookie) };
      }

      try {
        const data = await miyoushe.fetchRecord(api, saved.cookie, providerId, { referer, ds: withDs });
        // url 一起带回去，出问题时能直接在控制台看到实际请求了什么
        return { ok: true, data, url: api };
      } catch (error) {
        /*
         * 以前这里两个条件都写成 10001，等于「参数错误就清登录态」，
         * 一次拼错参数的请求就会把好好的登录态删掉。
         * 真正代表凭据失效的是 -100（未登录）和 -101（登录过期）。
         */
        if (error.retcode === -100 || error.retcode === -101) {
          /*
           * 只摘掉这一个账号，别把其它通行证一起清了 ——
           * 多账号下某个小号过期是很正常的事，连坐会让人莫名其妙地重新登录。
           */
          const fresh = await readHoyolabStore(providerId);
          fresh.accounts = fresh.accounts.filter((item) => item.id !== account.id);
          if (fresh.activeId === account.id) fresh.activeId = fresh.accounts[0]?.id || '';
          await writeHoyolabStore(providerId, fresh);
        }
        /*
         * 不 throw：ipcMain.handle 抛错时 Electron 只把 message 传回渲染进程，
         * retcode 和实际请求地址都会丢，用户和排查的人都只能看到一句话。
         * 当成返回值带回去，前端就能把「打的是哪个地址、服务端回了什么码」显示出来。
         */
        /*
         * 诊断信息：只带 cookie 的字段名，不带值。
         * 5003 这类风控/参数错误，常见原因是 cookie 里缺 ltoken 或 cookie_token 中的某一项，
         * 但这层信息用户在界面上完全看不到，出问题时只能干瞪眼。
         */
        const cookieKeys = String(saved.cookie || '')
          .split(';')
          .map((part) => part.split('=')[0].trim())
          .filter(Boolean);
        return {
          ok: false,
          error: error.message || String(error),
          retcode: typeof error.retcode === 'number' ? error.retcode : null,
          url: error.url || api,
          debug: { cookieKeys },
        };
      }
    });
}

module.exports = { installHoyolabIpc };
