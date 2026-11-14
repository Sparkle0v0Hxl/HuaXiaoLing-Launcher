'use strict';

const {
  ipcMain,
  session,
  BrowserWindow,
} = require('electron');
const { loadSecret, saveSecret } = require('./secret-store');

/**
 * 森空岛（鹰角社区）账号体系与 IPC。
 *
 * 终末地 / 明日方舟的战绩、便笺、战争回响、签到都走森空岛，凭据分三层：
 *   accountToken —— 账号级 token（网页登录后 cookie 里的那个），长期有效，用来重换 cred
 *   cred         —— 每次请求都带在头上的身份串，会过期
 *   credToken    —— 参与签名计算的密钥，和 cred 一起换
 * 这三样都是账号凭据，只走 safeStorage，不写进任何明文配置。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC，还内嵌着音乐登录窗口 / B 站弹幕这些业务实现）。
 * 搬运时逻辑一行未改。
 *
 * ctx 只注入真正用到的三个：passport / skland / win。
 * 注意 main.js 里 `win` 是 let 且会被重新赋值，所以这里每次调用都取当前值，
 * 不能缓存 —— 调用方传的是当时的值，够用（installIpc 本身也只在启动时跑一次）。
 */

function installSklandIpc(ctx) {
  const {
    passport,
    skland,
    win,
  } = ctx;

  /* ------------------------------------------------------------------ */
  /* 森空岛（鹰角社区）—— 终末地 / 明日方舟的官方数据源                    */
  /* ------------------------------------------------------------------ */

  /*
   * 凭据分三层，缺一层就换不出数据：
   *   accountToken —— 账号级 token（网页登录后 cookie 里的那个），长期有效，用来重换 cred
   *   cred         —— 每次请求都带在头上的身份串，会过期
   *   credToken    —— 参与签名计算的密钥，和 cred 一起换
   * 这三样都是账号凭据，只走 safeStorage，不写进任何明文配置。
   */
  const SKLAND_STORE_KEY = 'skland-store';
  /**
   * 存储版本 2 的来由：v1 时期 `roles` 里存的是 bindingList 的 uid（森空岛的绑定编号），
   * 而终末地的接口要的是 `roles[].roleId`，两者差一个数量级之外还完全不同。
   * 旧数据留着只会让便笺/战争回响/签到一直 403·10001，所以升版本时把缓存角色清空一次，
   * 下次刷新自动按新解析方式重读。accountToken 不动，用户不需要重新登录。
   */
  const SKLAND_STORE_VERSION = 2;

  async function readSklandStore() {
    const empty = { version: SKLAND_STORE_VERSION, accounts: [], activeId: '' };
    const raw = await loadSecret(SKLAND_STORE_KEY);
    if (!raw) return empty;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return empty;
    }
    if (!parsed || typeof parsed !== 'object') return empty;
    const stale = Number(parsed.version) !== SKLAND_STORE_VERSION;
    const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : [])
      .filter((item) => item && item.accountToken)
      .map((item) => ({
        id: String(item.id || `sk${Math.random().toString(36).slice(2, 8)}`),
        accountToken: String(item.accountToken),
        cred: String(item.cred || ''),
        credToken: String(item.credToken || ''),
        userId: String(item.userId || ''),
        roles: !stale && Array.isArray(item.roles) ? item.roles : [],
        savedAt: Number(item.savedAt) || 0,
      }));
    const activeId = accounts.some((item) => item.id === parsed.activeId)
      ? parsed.activeId
      : accounts[0]?.id || '';
    return { version: SKLAND_STORE_VERSION, accounts, activeId };
  }

  async function writeSklandStore(store) {
    await saveSecret(SKLAND_STORE_KEY, JSON.stringify(store));
  }

  function publicSklandAccount(account) {
    /*
     * 账号得有个能认人的名字。
     * 森空岛只给 userId（一串数字），列表里全是数字谁也分不清哪个是哪个，
     * 所以优先用这个账号下终末地角色的昵称，没有角色才退回 userId 尾号。
     */
    const roles = skland.endfieldRolesOf(account.roles || []);
    const nickname = String(roles[0]?.nickname || '');
    return {
      id: account.id,
      userId: account.userId,
      label: nickname || (account.userId ? `鹰角 ${String(account.userId).slice(-6)}` : '森空岛账号'),
      nickname,
      savedAt: account.savedAt || 0,
      roles: account.roles || [],
    };
  }

  function pickSklandAccount(store, accountId) {
    const wanted = String(accountId || '');
    if (wanted) {
      const found = store.accounts.find((item) => item.id === wanted);
      if (found) return found;
    }
    return store.accounts.find((item) => item.id === store.activeId) || store.accounts[0] || null;
  }

  /**
   * 候选 token 的判定：形状像不像一段令牌。
   *
   * 换 cred 的接口本身就是校验器，所以这里只管「值看起来像不像」，
   * 不追求认得出是哪个字段。太短的（语言、主题、AB 分组）直接排掉，
   * 免得拿一堆垃圾值去撞接口。
   */
  function looksLikeToken(value) {
    const text = String(value || '').trim();
    if (text.length < 16 || text.length > 4096) return false;
    if (!/^[A-Za-z0-9+/=_.\-:]+$/.test(text)) return false;
    // 纯数字、纯日期这类不算令牌
    if (/^\d+$/.test(text)) return false;
    return true;
  }

  /**
   * 从 cookie 里抠出所有「可能是账号 token」的值。
   *
   * 森空岛网页把登录态种在 ACCOUNT 上，鹰角通行证自己用 HG_TOKEN，
   * 老版本 SDK 还丢过一个 u8_token；三者历史上有过混用。
   * 更要紧的是：**站点改过 cookie 名**，只认这三个名字的话，
   * 用户明明登录成功了也会一直「识别不到账号」。
   * 所以分两轮：名字像 token 的排前面，其余 cookie 兜底排后面。
   */
  function sklandTokenCandidates(items) {
    const list = [];
    const push = (raw) => {
      const value = String(raw || '').trim();
      if (!value) return;
      /*
       * 先解码再判断。
       * 森空岛把 ACCOUNT 的值做过 URL 编码，原文带 % 号，而 looksLikeToken 的字符集
       * 白名单里没有 % —— 先前是先校验原文、不过就 return，等于把所有 URL 编码过的
       * token 直接扔了。用户明明登着，这边永远「识别不到账号」，就是这一步卡掉的。
       */
      let decoded = '';
      try {
        decoded = decodeURIComponent(value);
      } catch {
        decoded = '';
      }
      for (const candidate of [value, decoded]) {
        if (!candidate || !looksLikeToken(candidate) || list.includes(candidate)) continue;
        list.push(candidate);
      }
    };
    const rows = Array.isArray(items) ? items : [];
    const tokenish = /token|account|hg_|u8_|cred|passport|skland/i;
    for (const item of rows) if (tokenish.test(String(item?.name || ''))) push(item?.value);
    for (const item of rows) push(item?.value);
    /* 上限 12 个：每轮轮询都要逐个试，太多会把这个账号试进风控 */
    return list.slice(0, 12);
  }

  /**
   * 森空岛网页版也可能把 token 放 localStorage（不走 cookie）。
   * 拿不到 cookie 时补这一手，顺带把 JSON 里像 token 的字段挖出来。
   */
  async function sklandStorageCandidates(webContents) {
    try {
      const pairs = await webContents.executeJavaScript(
        `(() => {
          const out = [];
          try {
            for (let i = 0; i < localStorage.length; i += 1) {
              const key = localStorage.key(i);
              out.push([key, String(localStorage.getItem(key) || '').slice(0, 4096)]);
            }
          } catch (error) {
            /* 跨域或页面未就绪，忽略 */
          }
          return out;
        })()`,
        true
      );
      if (!Array.isArray(pairs)) return [];
      const list = [];
      for (const [key, value] of pairs) {
        if (looksLikeToken(value)) list.push(value);
        /* 值是 JSON 时把里面的 token 字段也挖出来 */
        if (value && value.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(value);
            for (const field of ['token', 'access_token', 'accountToken', 'account_token', 'hgToken']) {
              const found = parsed?.[field];
              if (looksLikeToken(found)) list.push(String(found));
            }
          } catch {
            /* 不是合法 JSON */
          }
        }
        void key;
      }
      return list.slice(0, 6);
    } catch {
      return [];
    }
  }

  /** 用候选 token 逐个换 cred，第一个成功的就留下。 */
  async function sklandCredFromCandidates(candidates) {
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const cred = await skland.loginByToken(candidate);
        return { cred, accountToken: candidate };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('这个账号的登录凭据用不了，请重新登录森空岛');
  }

  /**
   * 把换到的 cred 落成账号记录。
   * 轮询、粘贴令牌、接管通行证分区三条路都走这里，免得三份实现慢慢跑偏。
   */
  async function sklandSaveAccount({ cred, accountToken }) {
    const account = {
      id: `sk-${cred.userId || accountToken.slice(-8)}`,
      accountToken,
      cred: cred.cred,
      credToken: cred.token,
      userId: cred.userId,
      roles: [],
      savedAt: Date.now(),
    };
    const store = await readSklandStore();
    store.accounts = store.accounts.filter((item) => item.id !== account.id);
    store.accounts.unshift(account);
    store.activeId = account.id;
    await writeSklandStore(store);
    try {
      await refreshSklandRoles(account);
    } catch {
      /* 角色拉不到不影响登录本身 */
    }
    await writeSklandStore(store);
    return account;
  }

  /**
   * 顺手接管「鹰角通行证」那张卡已经登录的状态。
   *
   * 工具页上的「鹰角通行证」登录窗口跑在 persist:passport-hypergryph 分区里，
   * 森空岛这边跑在 persist:skland，两者 cookie 不共享。但登录成功后种下的是
   * 同一枚账号 token —— 用户先在通行证那边登过、再来点森空岛，不该再让他登一遍。
   */
  async function sklandAdoptPassportSession() {
    try {
      const ses = session.fromPartition('persist:passport-hypergryph');
      const candidates = sklandTokenCandidates(await ses.cookies.get({}));
      if (!candidates.length) return null;
      return await sklandCredFromCandidates(candidates);
    } catch {
      return null;
    }
  }

  /**
   * 换一份能用的 cred：有就直接用，没有或被告知失效就重新换。
   * `force` 用于接口返回「凭据失效」之后的第二次尝试。
   */
  async function ensureSklandCred(account, force = false) {
    if (!force && account.cred && account.credToken) {
      return { cred: account.cred, token: account.credToken };
    }
    const fresh = await skland.loginByToken(account.accountToken);
    account.cred = fresh.cred;
    account.credToken = fresh.token;
    account.userId = fresh.userId || account.userId;
    return { cred: account.cred, token: account.credToken };
  }

  /**
   * 终末地的 card/detail 与 war-echoes 都必须带 `userId`（森空岛账号 ID）。
   *
   * 以前直接读 account.userId。这个值只在「拉绑定角色」那一步顺手取，
   * 取失败会被静默吞掉（注释写着"缺了也能用"，但终末地这两个接口缺了不行）——
   * 于是 URL 里变成 `userId=`，服务端不解释，直接回 HTTP 401，
   * 用户看到的只有一句「接口 HTTP 401」，怎么点重试都一样。
   *
   * 这里改成缺了就现取，取不到如实报错，不再让它退化成 401。
   */
  async function ensureSklandUserId(account, cred, token) {
    if (account?.userId) return String(account.userId);
    const userId = await skland.fetchUserId(cred, token);
    if (account) account.userId = userId;
    return userId;
  }

  /** 拉一次绑定角色，只留终末地那些，顺手写回 store。 */
  async function refreshSklandRoles(account) {
    const { cred, token } = await ensureSklandCred(account);
    const all = await skland.fetchBindings(cred, token);
    account.roles = all;
    if (!account.userId) {
      try {
        account.userId = await skland.fetchUserId(cred, token);
      } catch {
        /* 少数接口不要 userId，缺了也能用 */
      }
    }
    return account.roles;
  }

  /**
   * 角色列表为空时补拉一次（每分钟最多一次）。
   *
   * 场景：存储升到 v2 后旧的角色缓存被清掉、或者刚登录还没同步过。
   * 界面上每次重绘都会问状态，所以这里卡一个时间窗，避免打开工具页就
   * 连打十几个 binding 请求。
   */
  const sklandRolesRefreshAt = new Map();
  async function ensureSklandRoles(account, { force = false } = {}) {
    if (!account) return [];
    if (!force && skland.endfieldRolesOf(account.roles || []).length) return account.roles;
    const last = sklandRolesRefreshAt.get(account.id) || 0;
    if (!force && Date.now() - last < 60_000) return account.roles || [];
    sklandRolesRefreshAt.set(account.id, Date.now());
    try {
      return await refreshSklandRoles(account);
    } catch {
      return account.roles || [];
    }
  }

  /** 先查缓存，查不到再补拉一次绑定 —— 老数据迁移后用户不用手动点「同步角色」。 */
  async function resolveEndfieldRole(account, roleId) {
    const cached = endfieldRoleOf(account, roleId);
    if (cached) return cached;
    /*
     * 这里是用户主动点了刷新/切游戏，别再受 status 那个 60 秒窗口限制：
     * 窗口内不重试的话，网络刚好抖一下就会误报「这个账号下没有终末地角色」。
     */
    await ensureSklandRoles(account, { force: true });
    return endfieldRoleOf(account, roleId);
  }

  /**
   * 统一入口：挑账号 → 拿 cred → 执行 → 凭据失效时自动重换一次。
   *
   * 森空岛的过期信号是 10000（未登录）/ 10002（登录过期）。
   * 只重试一次：如果是账号本身出问题，反复重换只会把风控惹毛。
   */
  async function withSkland(input, runner) {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input?.accountId);
    if (!account) {
      return { ok: false, error: '还没有登录森空岛，请先在工具页点「登录森空岛」', needLogin: true };
    }
    const run = async () => {
      const { cred, token } = await ensureSklandCred(account);
      return runner({ account, cred, token });
    };
    try {
      const result = await run();
      await writeSklandStore(store);
      return { ok: true, data: result };
    } catch (error) {
      const code = error?.code;
      const biz = Number(error?.bizCode);
      /*
       * 401 / 403 / 10000 / 10002 都按「凭据可能不同步」处理。
       * 服务端对「cred 还有效、但签名用的 token 已经不是这一份」这种情况，
       * 返回的是 HTTP 403 / 401 而不是 10002 这类业务码；用账号 token 重换一次
       * cred 往往就通了，所以和 10002 走同一条重试路径。
       *
       * 401 是 2026-11-03 补的：终末地 card/detail 实际会返 401（响应体仍是
       * {"code":10000}），以前只认 403，于是这种「重登一下就好」的情况被直接
       * 当成最终错误甩给用户，点了重试还是同一条。
       *
       * 但 403 里有一种不该重试：响应体带 `code:10001` 的「操作失败，请稍后重试」。
       * 那不是登录问题，而是请求里的角色/区服对不上（实测把 bindingList 的 uid
       * 当 roleId 就会必现）。重换凭据一百次也是同一句，只会让用户以为号坏了。
       * 这种直接如实说明并指向「同步角色」。
       */
      const paramRejected = code === 403 && biz === 10001;
      const retryable =
        !paramRejected && (code === 10000 || code === 10002 || code === 401 || code === 403);
      if (!retryable) {
        await writeSklandStore(store).catch(() => {});
        if (paramRejected) {
          const hint = error?.bizMessage ? `（10001 ${error.bizMessage}）` : '（10001）';
          return {
            ok: false,
            error:
              `森空岛不接受这次查询${hint}：请求里的角色或区服和这个账号对不上，` +
              '不是登录过期。点战绩页的「同步角色」重新读一次绑定，再点刷新就好。',
            code,
          };
        }
        return { ok: false, error: String(error?.message || error), code: code ?? null };
      }
      try {
        await ensureSklandCred(account, true);
        const result = await run();
        await writeSklandStore(store);
        return { ok: true, data: result };
      } catch (retryError) {
        await writeSklandStore(store).catch(() => {});
        const retryBiz = Number(retryError?.bizCode);
        if (retryBiz === 10001) {
          const hint = retryError?.bizMessage ? `（10001 ${retryError.bizMessage}）` : '（10001）';
          return {
            ok: false,
            error:
              `森空岛不接受这次查询${hint}：角色或区服和这个账号对不上。` +
              '点「同步角色」重新读取绑定后再刷新。',
            code: retryError?.code ?? 403,
          };
        }
        const prefix = code === 401 || code === 403
          ? `森空岛拒绝了这次请求（${code}），已经自动重新换过凭据仍然被拒`
          : '森空岛登录态已失效';
        return {
          ok: false,
          error: `${prefix}：${String(retryError?.message || retryError)}`,
          needLogin: true,
        };
      }
    }
  }

  /** 终末地角色（可能一个账号下挂多个服）。 */
  function endfieldRoleOf(account, roleId) {
    const roles = skland.endfieldRolesOf(account.roles || []);
    if (!roles.length) return null;
    const wanted = String(roleId || '');
    if (wanted) {
      const found = roles.find((role) => String(role.uid) === wanted || String(role.roleId) === wanted);
      if (found) return found;
    }
    return roles.find((role) => role.isDefault) || roles[0];
  }

  /*
   * 登录森空岛。
   *
   * 打开的是森空岛网页版而不是鹰角通行证首页 —— 后者登完只种 hypergryph 域的 cookie，
   * 拿不到森空岛自己的 ACCOUNT；在森空岛页面里点登录，走的虽然是同一套通行证 SSO，
   * 但登录态会同时落到 skland.com 下，正好是我们要的那一份。
   */
  ipcMain.handle('skland:login', async (_event, input = {}) => {
    const ses = session.fromPartition('persist:skland');
    if (input.relogin) {
      try {
        await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
      } catch {
        /* ignore */
      }
    }

    /*
     * 最常见的一种「明明登录了却识别不到」：
     * 用户先在工具页的「鹰角通行证」卡里登过，再来点森空岛 —— 两边是不同的
     * 会话分区，cookie 不互通，于是又弹一个空白的登录窗。
     * 这里先拿通行证分区的凭据换一次 cred，成功了连窗口都不开。
     *
     * add=true（添加另一个账号）时必须跳过这一步：通行证分区里只有第一次那个号，
     * 接管过来等于把用户已经有的账号又存一遍，新账号根本进不来。
     */
    if (!input.relogin && !input.add) {
      const adopted = await sklandAdoptPassportSession();
      if (adopted) {
        const account = await sklandSaveAccount(adopted);
        return { ok: true, account: publicSklandAccount(account), adopted: true };
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      let poll = null;
      let timeout = null;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        if (poll) clearInterval(poll);
        if (timeout) clearTimeout(timeout);
        try {
          if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
        } catch {
          /* ignore */
        }
        resolve(payload);
      };

      const loginWindow = new BrowserWindow({
        width: 560,
        height: 760,
        parent: win && !win.isDestroyed() ? win : undefined,
        modal: false,
        show: true,
        title: '登录森空岛',
        autoHideMenuBar: true,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      loginWindow.setMenuBarVisibility(false);
      loginWindow.webContents.setUserAgent(passport.UA);

      loginWindow.on('closed', () => {
        finish({ ok: false, cancelled: true, reason: '已取消登录' });
      });

      loginWindow.loadURL('https://www.skland.com/').catch(() => {});

      /*
       * 轮询：每 1.5 秒探一次登录态。
       *
       * 两个讲究：
       * ① 一进窗口先跑一次 —— 用户之前登录过、cookie 还留在 persist:skland 分区里时
       *    能立刻接管，不用他自己发现「明明登着却还说我没登」。
       * ② cookie 没变化就不重复换 cred。候选最多十二个，每轮全试一遍等于每 1.5 秒
       *    打十几次接口，容易把这个账号试进风控；失败一次后补一轮 localStorage
       *    （森空岛网页版也可能把 token 存那儿），补完仍失败就等 cookie 变化。
       */
      let lastProbeKey = '';
      let needStorageFallback = false;
      const probe = async () => {
        if (settled || !loginWindow || loginWindow.isDestroyed()) return;
        try {
          const all = await ses.cookies.get({});
          const fromCookie = sklandTokenCandidates(all);
          const key = fromCookie.join('|');
          if (key && key === lastProbeKey && !needStorageFallback) return;
          lastProbeKey = key;
          const candidates = fromCookie.slice();
          if (needStorageFallback) {
            needStorageFallback = false;
            candidates.push(...(await sklandStorageCandidates(loginWindow.webContents)));
          }
          if (!candidates.length) return;
          const account = await sklandSaveAccount(await sklandCredFromCandidates(candidates));
          finish({ ok: true, account: publicSklandAccount(account) });
        } catch {
          /* 还没登好 / 网络抖动：允许补一次 localStorage，再失败就等 cookie 变化 */
          needStorageFallback = true;
        }
      };
      poll = setInterval(probe, 1500);
      probe();

      timeout = setTimeout(() => {
        finish({ ok: false, cancelled: true, reason: '登录超时（5 分钟）' });
      }, 5 * 60 * 1000);
    });
  });

  /** 兜底：用户从 web-api.skland.com/account/info/hg 抄来的 token 直接粘进来。 */
  ipcMain.handle('skland:login-token', async (_event, input = {}) => {
    const token = String(input.token || '').trim();
    if (!token) return { ok: false, error: '请先粘贴 token' };
    try {
      const cred = await skland.loginByToken(token);
      const account = await sklandSaveAccount({ cred, accountToken: token });
      return { ok: true, account: publicSklandAccount(account) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('skland:status', async (_event, input = {}) => {
    const store = await readSklandStore();
    const active = pickSklandAccount(store, input.accountId);
    /*
     * 这里不主动联网：状态查询在页面每次重绘时都会调，
     * 真去换 cred 会让打开工具页要多等两秒。失效会在读数据时被发现。
     *
     * 但要顺带看一眼分区里有没有残留的 cookie —— 有的话说明「用户在这个窗口里
     * 登录过、只是账号还没被接管」，界面就能提示「点一次登录即可」，而不是干巴巴
     * 写着「未登录」。读 cookie 是内存操作，不发网络请求。
     */
    let hasCookies = false;
    if (!active) {
      for (const partition of ['persist:skland', 'persist:passport-hypergryph']) {
        if (hasCookies) break;
        try {
          const pieces = await session.fromPartition(partition).cookies.get({});
          hasCookies = sklandTokenCandidates(pieces).length > 0;
        } catch {
          /* 分区还没建，视作没有 */
        }
      }
    }
    /*
     * 例外：存储升级后角色缓存是空的（v1 存的是绑定编号，已经不再兼容）。
     * 这时候补拉一次绑定，否则界面会误报「这个账号下没有终末地角色」。
     * ensureSklandRoles 内部有 60 秒时间窗，成功一次就写回 store，不会反复请求。
     */
    if (active && !skland.endfieldRolesOf(active.roles || []).length) {
      const before = (active.roles || []).length;
      await ensureSklandRoles(active);
      if ((active.roles || []).length !== before) await writeSklandStore(store).catch(() => {});
    }
    return {
      ok: true,
      loggedIn: Boolean(active),
      hasCookies,
      activeId: active?.id || '',
      accounts: store.accounts.map(publicSklandAccount),
      roles: active ? skland.endfieldRolesOf(active.roles || []) : [],
    };
  });

  ipcMain.handle('skland:roles', async (_event, input = {}) => {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input.accountId);
    if (!account) return { ok: false, error: '还没有登录森空岛', needLogin: true, roles: [] };
    try {
      const roles = await refreshSklandRoles(account);
      await writeSklandStore(store);
      return { ok: true, roles: skland.endfieldRolesOf(roles) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), roles: skland.endfieldRolesOf(account.roles || []) };
    }
  });

  /** 切换当前使用的森空岛账号。多个号各自有自己的 cred 与角色，互不影响。 */
  ipcMain.handle('skland:use-account', async (_event, input = {}) => {
    const store = await readSklandStore();
    const wanted = String(input.accountId || '');
    const account = store.accounts.find((item) => item.id === wanted);
    if (!account) return { ok: false, error: '没有这个森空岛账号，可能已经被移除了' };
    store.activeId = account.id;
    await writeSklandStore(store);
    return { ok: true, accountId: account.id, account: publicSklandAccount(account) };
  });

  ipcMain.handle('skland:logout', async (_event, input = {}) => {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input.accountId);
    if (account) {
      store.accounts = store.accounts.filter((item) => item.id !== account.id);
      if (store.activeId === account.id) store.activeId = store.accounts[0]?.id || '';
      await writeSklandStore(store);
    }
    /*
     * 只有「一个号都不剩」时才清分区。
     * 多账号时删掉其中一个就把整个 persist:skland 清空，会把另一个号留在分区里的
     * cookie 一起扔了 —— 虽然它还能靠 accountToken 重新换 cred，但下次启动就得
     * 多走一次授权，没必要。
     */
    if (!store.accounts.length) {
      try {
        const ses = session.fromPartition('persist:skland');
        await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage'] });
      } catch {
        /* ignore */
      }
    }
    return { ok: true, accounts: store.accounts.map(publicSklandAccount), activeId: store.activeId };
  });

  ipcMain.handle('skland:note', async (_event, input = {}) => {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input.accountId);
    if (!account) return { ok: false, error: '还没有登录森空岛', needLogin: true };
    const role = await resolveEndfieldRole(account, input.roleId);
    await writeSklandStore(store).catch(() => {});
    if (!role) return { ok: false, error: '这个鹰角账号下没有终末地角色，请先在游戏里创建角色' };
    const result = await withSkland(input, async ({ cred, token, account: current }) =>
      skland.endfieldCard(cred, token, {
        userId: await ensureSklandUserId(current, cred, token),
        roleId: role.roleId,
        serverId: role.serverId,
      })
    );
    return { ...result, role };
  });

  ipcMain.handle('skland:record', async (_event, input = {}) => {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input.accountId);
    if (!account) return { ok: false, error: '还没有登录森空岛', needLogin: true };
    const role = await resolveEndfieldRole(account, input.roleId);
    await writeSklandStore(store).catch(() => {});
    if (!role) return { ok: false, error: '这个鹰角账号下没有终末地角色，请先在游戏里创建角色' };
    const result = await withSkland(input, async ({ cred, token, account: current }) =>
      skland.endfieldWarEchoes(cred, token, {
        userId: await ensureSklandUserId(current, cred, token),
        roleId: role.roleId,
        serverId: role.serverId,
        seasonId: input.seasonId,
      })
    );
    return { ...result, role };
  });

  ipcMain.handle('skland:sign', async (_event, input = {}) => {
    const store = await readSklandStore();
    const account = pickSklandAccount(store, input.accountId);
    if (!account) return { ok: false, error: '还没有登录森空岛', needLogin: true };
    const role = await resolveEndfieldRole(account, input.roleId);
    await writeSklandStore(store).catch(() => {});
    if (!role) return { ok: false, error: '这个鹰角账号下没有终末地角色' };
    const result = await withSkland(input, ({ cred, token }) =>
      skland.endfieldAttendance(cred, token, { roleId: role.roleId, serverId: role.serverId })
    );
    return { ...result, role };
  });
}

module.exports = { installSklandIpc };
