'use strict';

/**
 * 抽卡记录的「账号级」同步
 * =========================
 *
 * gacha-sync.js 走的是老路：读游戏自己的网页缓存，抠出那条 getGachaLog 链接。
 * 那条链接里的 authkey 大约 24 小时就废，所以每次同步前用户都得先在游戏里
 * 打开一次抽卡记录页 —— 这也是「抽卡记录总是不自动同步」的根因。
 *
 * 这个文件补的是另一条路：拿一次 SToken，之后每次同步都用它实时申请新的
 * authkey，不需要碰游戏，也不会 24 小时过期。原来那条路一行没动，
 * 缓存路径还在 syncGacha() 里，两条路可以并存、互为兜底。
 *
 * 拿到 SToken 后的完整链路：
 *     SToken ──getLTokenBySToken──▶ LTuid + LToken
 *                                  └─getAuthkeyBySToken──▶ authkey（几百字节，不是链接）
 *                                                             └─拼成 getGachaLog 的 query──▶ 翻页
 * 翻页、去重、合并、落盘的规则和 gacha-sync.js 完全一致（照着它的 fetchPage /
 * mergeGroups 抄的），因为写进 gacha-imports.json 的数据形状必须一模一样，
 * 否则同一个账号的两种来源会互相打架、记录翻倍。
 */

const fs = require('node:fs');
const path = require('node:path');

const { mergeGroups, saveImportGroups, readImportGroups, importsPath } = require('./gacha-import');
const stoken = require('./stoken-login');

/** 桌面浏览器的 UA。抽卡接口对 UA 不挑，但用 curl 默认 UA 会被风控。 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 每个游戏的抽卡类型与接口地址，和第几列编码的对应关系。
 *
 * types 决定要翻几类卡池；zzz 额外要 real_gacha_type 这个参数名，
 * 这里是唯一和原神/星铁不一样的地方。
 */
const GAMES = {
  genshin: {
    name: '原神',
    types: [100, 200, 301, 302, 400, 500],
    cn: 'https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog',
    os: 'https://public-operation-hk4e-sg.hoyoverse.com/gacha_info/api/getGachaLog',
  },
  starrail: {
    name: '崩坏：星穹铁道',
    types: [1, 2, 11, 12],
    cn: 'https://public-operation-hkrpg.mihoyo.com/common/hkrpg_gacha_record/api/getGachaLog',
    os: 'https://public-operation-hkrpg-sg.hoyoverse.com/common/hkrpg_gacha_record/api/getGachaLog',
  },
  zzz: {
    name: '绝区零',
    types: [1, 2, 3, 5, 102, 103],
    cn: 'https://public-operation-nap.mihoyo.com/common/gacha_record/api/getGachaLog',
    os: 'https://public-operation-nap-sg.hoyoverse.com/common/gacha_record/api/getGachaLog',
  },
};

/* ------------------------------------------------------------------ */
/* 账号库                                                              */
/* ------------------------------------------------------------------ */

/**
 * 每个账号一条：
 *   { id, mid, region, stoken, ltuid, ltoken, isV2, nickname, roles, boundAt, lastSyncAt }
 *
 * stoken 本身也留着 —— 换 ltoken 失败时（比如某些老号改过密码）可以拿它
 * 重新走一遍，比让用户再粘一次省事。
 */
function readStore(userData) {
  const store = stoken.readStokenStore(userData);
  const visible = store.accounts.filter((item) => item && item.mid);
  return {
    /*
     * 判据是「有 mid 就留着」，不再要求 ltoken。
     *
     * 官方 App 扫码签发的 SToken 常常换不出 ltoken（getLTokenBySToken 回 -100），
     * 但 authkey 照样能申、抽卡记录照样能取。以前这里要求 item.ltoken 非空，
     * 结果第二个扫码绑定的账号一存进去就被过滤掉，界面上永远是「只有一个账号」
     * —— 看起来像「扫码没反应」，其实是读的时候被自己藏了。
     */
    accounts: visible,
    /*
     * activeId 必须指向一个真实存在的账号。
     *
     * 绑定 / 解绑之后旧 id 很容易留在文件里（扫码绑第二个账号又把它删掉就是这种情况），
     * 这时 activeId 指向一条已经不存在的记录，界面按它找账号会找不到，
     * 于是「明明有账号却说没绑」。落到第一个账号上最稳。
     */
    activeId: visible.some((item) => item.id === store.activeId)
      ? store.activeId
      : (visible[0] && visible[0].id) || '',
  };
}

function saveStore(userData, store) {
  stoken.writeStokenStore(userData, store);
  return store;
}

/** 账号文件的位置，界面上要显示给用户看（方便自己备份）。 */
function storePath(userData) {
  return stoken.stokenFile(userData);
}

/** 打码：界面上永远不显示完整的 stoken / ltoken。 */
function mask(value) {
  const text = String(value || '');
  if (text.length <= 12) return text ? '***' : '';
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function publicAccount(account) {
  return {
    id: account.id,
    mid: account.mid,
    region: account.region,
    nickname: account.nickname || '',
    ltuid: account.ltuid,
    stokenMasked: mask(account.stoken),
    /*
     * hasStoken 是「能不能真同步」的唯一判据。
     * 账号存在 ≠ 能同步：从网页登录态建出来的账号没有 stoken，
     * 只能认出角色和 UID，申不了 authkey。界面靠这个字段决定说真话还是说假话。
     */
    hasStoken: Boolean(account.stoken),
    /* canRenew：留着 login_ticket，SToken 失效时能自己换回来，界面可以承诺「不用再管」 */
    canRenew: Boolean(account.loginTicket),
    source: account.source || '',
    boundAt: account.boundAt || '',
    lastSyncAt: account.lastSyncAt || '',
    roles: (account.roles || []).map((role) => ({
      game: role.game,
      gameBiz: role.gameBiz,
      uid: String(role.uid),
      nickname: role.nickname || '',
      level: role.level || 0,
      regionName: role.regionName || '',
    })),
  };
}

/** 列表：只出脱敏数据，绝不出 ltoken。 */
function listAccounts(userData) {
  const store = readStore(userData);
  return {
    ok: true,
    activeId: store.activeId,
    accounts: store.accounts.map(publicAccount),
    file: storePath(userData),
    games: Object.fromEntries(
      Object.entries(GAMES).map(([key, value]) => [key, { name: value.name, types: value.types }])
    ),
  };
}

/* ------------------------------------------------------------------ */
/* 绑定 / 解绑                                                         */
/* ------------------------------------------------------------------ */

/**
 * 绑定一个 SToken。
 *
 * 先走一遍完整校验（换 ltoken → 拉角色），确认真的能用才落盘，
 * 免得用户粘错了也显示「已绑定」，下次同步才炸。
 * 同一个 mid 重复绑定时覆盖而不是新增 —— 用户重新粘一份新 stoken
 * 的意思就是「更新这个账号」，不是「再来一个账号」。
 */
async function bindAccount(userData, { input, region = 'cn', nickname = '', ltoken = '', cookieToken = '', ltuid = '' }) {
  /* 扫码拿到的 token 不带 ltuid，调用方（main.js）知道当前登录账号的 ltuid，优先用它做 id */
  const STOKEN_UID_HINT = String(ltuid || '');
  const verified = await stoken.verifyStoken(input, { region });
  if (!verified.ok) return { ok: false, error: verified.error };
  /*
   * 注意：这里不能再拿 ltoken 当「SToken 是否有效」的判据。
   * 扫码（官方 App）签发的 SToken 常常换不出 ltoken，但 genAuthKey 照样能用它
   * 换 authkey 取抽卡记录。ltoken 只作为兜底凭据，没有也能正常同步。
   */
  if (!verified.stoken) return { ok: false, error: '没拿到 SToken' };

  const store = readStore(userData);
  /*
   * 账号 id 统一用 ltuid 口径 —— 和登录态模块（readHoyolabStore 里那套）对齐。
   * 之前用 mid 当过 id，结果同一份通行证在库里存了两条：登录态那条 id=82374705、
   * 扫码那条 id=0cyjuew66u_mhy，界面上看着像两个账号，角色列表还各存一半。
   */
  /*
   * id 只用 aid（纯数字的米游社账号 id）。
   *
   * 以前这里是 verified.ltuid || STOKEN_UID_HINT || verified.mid —— 三段里最后一段
   * 是 mid（0cyjuew66u_mhy 那种）。当 SToken 换不出 ltoken 时前两段都空，id 就
   * 落到了 mid 上；之后拉角色要把 id 当 uid 传给 getActionTicketBySToken，接口
   * 一律回 -502。表现就是「扫第二个账号成功、但永远没有角色、要手填 UID」。
   * mid 照样存在账号里（genAuthKey 的 cookie 要用），只是不再当 id。
   */
  const id = String(verified.ltuid || STOKEN_UID_HINT || '');
  if (!id) {
    /*
     * 没 aid 就不要落盘。宁可让用户重扫一次，也不要写一条 id 是 mid 的账号
     * 进去 —— 那种记录能存下、能显示，但永远拉不到角色、也永远同步不了。
     */
    return { ok: false, error: '这次扫码没拿到账号 id（aid），请在手机上刷新一下二维码重新扫' };
  }
  const existing = store.accounts.find((item) => item.id === id);
  const account = {
    id,
    mid: verified.mid,
    // 以角色列表实际返回的服务器为准，用户选的服务器只是初值
    region: verified.region || region,
    stoken: verified.stoken,
    ltuid: String(verified.ltuid || id),
    ltoken: String(ltoken || verified.ltoken),
    isV2: Boolean(verified.isV2),
    /* 扫码直接给了 ltoken / cookie_token 时用它们，少发一次请求 */
    cookieToken: cookieToken || verified.cookieToken || existing?.cookieToken || '',
    nickname: nickname || existing?.nickname || pickNickname(verified.roles) || '',
    roles: verified.roles || [],
    boundAt: existing?.boundAt || new Date().toISOString(),
    lastSyncAt: existing?.lastSyncAt || '',
  };

  const accounts = existing
    ? store.accounts.map((item) => (item.id === id ? account : item))
    : [...store.accounts, account];
  saveStore(userData, { accounts, activeId: id });
  return {
    ok: true,
    account: publicAccount(account),
    created: !existing,
    // 角色列表拉空时提示一句，否则用户会以为绑上就能同步所有游戏
    warning: (verified.roles || []).length
      ? ''
      : 'SToken 有效，但没拉到角色列表。同步时请手动填 UID（游戏内个人资料页能看到）',
  };
}

/**
 * 用用户粘进来的一整段东西建账号。
 *
 * 为什么要有入口层之外的这一层：用户从浏览器复制来的往往是一整段 cookie，
 * 里面有 stoken、mid、stuid、login_ticket。parseCredentialBundle 已经把它们都挑出来了，
 * 这里负责把「能不能长期用」这件事定下来 ——
 *   - 有 stoken：能取抽卡记录（genAuthKey 只认它）
 *   - 有 login_ticket：stoken 万一失效还能自己换回来，用户不用再动
 * 两个都有，才算「粘一次，以后不用管」。
 */
async function bindBundle(userData, { raw, region = "cn", nickname = "" }) {
  const bundle = stoken.parseCredentialBundle(raw);
  if (!bundle.ok) return { ok: false, error: bundle.error, needStoken: Boolean(bundle.needStoken) };

  /*
   * 只贴了裸值时会没有 mid。这种情况下先拿 stoken 换一次 ltoken，
   * getLTokenBySToken 的返回里带着真正的 mid / ltuid。
   */
  let probe = null;
  if (!bundle.mid) {
    try {
      probe = await stoken.getLtokenByStoken(region, { stoken: bundle.stoken, mid: "" });
    } catch (error) {
      return { ok: false, error: "用这个 SToken 换不到登录态：" + String((error && error.message) || error) };
    }
    if (!probe || !probe.ltoken) {
      return { ok: false, error: "这个 SToken 换不到登录态，可能已经失效了" };
    }
    bundle.mid = String(probe.ltuid || "");
    bundle.stuid = bundle.mid;
  }

  const verified = await stoken.verifyStoken("stoken=" + bundle.stoken + ";mid=" + bundle.mid, { region });
  if (!verified.ok) return { ok: false, error: verified.error };
  /*
   * 和 bindAccount 保持一致：能不能用看 stoken，不看 ltoken。
   * 手工粘进来的 SToken 同样常常换不出 ltoken，卡在这里会让有效 token 白扔。
   */
  if (!verified.stoken) return { ok: false, error: verified.error || "没有拿到 SToken" };

  const store = readStore(userData);
  const id = String(verified.mid || bundle.mid);
  const existing = store.accounts.find((item) => item.id === id);
  const account = {
    id,
    mid: id,
    stuid: bundle.stuid || id,
    region: verified.region || region,
    stoken: verified.stoken || bundle.stoken,
    ltuid: String(verified.ltuid || bundle.ltuid || ""),
    ltoken: String(verified.ltoken || bundle.ltoken || ""),
    isV2: Boolean(verified.isV2),
    cookieToken: bundle.cookieToken || existing?.cookieToken || "",
    /* 自动续期的凭据：有它就不用再麻烦用户 */
    loginTicket: bundle.loginTicket || existing?.loginTicket || "",
    loginUid: bundle.loginUid || existing?.loginUid || "",
    canRenew: Boolean(bundle.loginTicket || existing?.loginTicket),
    nickname: nickname || existing?.nickname || pickNickname(verified.roles) || "",
    roles: (verified.roles || []).length ? verified.roles : existing?.roles || [],
    boundAt: existing?.boundAt || new Date().toISOString(),
    lastSyncAt: existing?.lastSyncAt || "",
    source: "paste",
  };

  const accounts = existing
    ? store.accounts.map((item) => (item.id === id ? account : item))
    : [...store.accounts, account];
  saveStore(userData, { accounts, activeId: id });

  return {
    ok: true,
    account: publicAccount(account),
    created: !existing,
    canRenew: account.canRenew,
    warning: (account.roles || []).length
      ? ""
      : "SToken 有效，但没拉到角色列表。同步时请手动填 UID（游戏内个人资料页能看到）",
  };
}

function pickNickname(roles) {
  return (roles || []).find((role) => role.nickname)?.nickname || '';
}

/**
 * 用「已经登录的米游社账号」直接建一个抽卡账号，不需要用户抄 SToken。
 *
 * 为什么会走到这里
 * ----------------
 * 启动器本来就有米游社登录，那个登录窗口落盘的 cookie 里带着 ltoken / ltuid，
 * 而申请抽卡 authkey 需要的恰恰就是这两个 —— SToken 只是「在没有登录态时
 * 换出 ltoken」的一条绕路，已经登录过的用户完全不用再走。
 *
 * providerId 决定国服 / 国际服：米游社是 cn，HoYoLAB 是 os。
 */
async function bindFromCookie(userData, { cookie, providerId = 'miyoushe', nickname = '' }) {
  const parsed = stoken.accountFromCookie(cookie, providerId);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const roles = await stoken.fetchRoles({
    region: parsed.region,
    ltoken: parsed.ltoken,
    ltuid: parsed.ltuid,
    cookieToken: parsed.cookieToken,
    cookie: parsed.cookie,
  });

  const store = readStore(userData);
  /*
   * 账号 id 用 ltuid（通行证数字 id），不用 mid。
   *
   * 登录态模块存账号时用的就是 ltuid_v2，两边对齐之后同一个通行证才不会
   * 出现两条记录；mid 单独留着，申请 authkey 时要把它放进 cookie。
   */
  const id = String(parsed.ltuid || parsed.mid);
  const existing = store.accounts.find((item) => item.id === id);
  const account = {
    id,
    mid: parsed.mid,
    region: parsed.region,
    // 不再保存 stoken：这条路径根本没有 stoken，全靠 ltoken 长期续
    stoken: '',
    ltuid: String(parsed.ltuid),
    cookieToken: String(parsed.cookieToken || ''),
    ltoken: String(parsed.ltoken),
    isV2: /^v2_/.test(String(parsed.ltoken)),
    nickname: nickname || existing?.nickname || pickNickname(roles) || '',
    // 角色列表拉空时留着旧的：一次接口抖动不该把「原神 UID …」这种已知信息抹掉
    roles: roles.length ? roles : (existing?.roles || []),
    boundAt: existing?.boundAt || new Date().toISOString(),
    lastSyncAt: existing?.lastSyncAt || '',
    source: 'login',
  };

  const accounts = existing
    ? store.accounts.map((item) => (item.id === id ? account : item))
    : [...store.accounts, account];
  saveStore(userData, { accounts, activeId: id });
  return {
    ok: true,
    account: publicAccount(account),
    created: !existing,
    warning: roles.length ? '' : '已经从登录态建好账号，但没拉到角色列表，同步时请手动填 UID',
  };
}

function removeAccount(userData, id) {
  const store = readStore(userData);
  const accounts = store.accounts.filter((item) => item.id !== String(id));
  const activeId = store.activeId === String(id) ? accounts[0]?.id || '' : store.activeId;
  saveStore(userData, { accounts, activeId });
  return { ok: true, activeId, accounts: accounts.map(publicAccount) };
}

function setActiveAccount(userData, id) {
  const store = readStore(userData);
  if (!store.accounts.some((item) => item.id === String(id))) {
    return { ok: false, error: '这个账号不在列表里' };
  }
  saveStore(userData, { accounts: store.accounts, activeId: String(id) });
  return { ok: true, activeId: String(id) };
}

/**
 * 重新拉一次角色列表。
 *
 * 用户抽到新游戏的角色（比如原神号突然开始玩绝区零）之后要能刷出来，
 * 不然同步列表里永远缺一个。
 */
async function refreshRoles(userData, id) {
  const store = readStore(userData);
  const account = store.accounts.find((item) => item.id === String(id));
  if (!account) return { ok: false, error: '这个账号不在列表里' };

  let token = account;
  /*
   * 顺序和 verifyStoken 里保持一致：先 SToken 那条（不依赖 ltoken），
   * 再退到 ltoken。扫码来的账号只有 SToken，走 ltoken 永远拉不到东西。
   */
  let roles = account.stoken
    ? await stoken.fetchRolesByStoken({
        region: account.region,
        stoken: account.stoken,
        mid: account.mid,
        stuid: account.ltuid,
      })
    : [];

  if (!roles.length) {
    roles = await stoken.fetchRoles(account);
  }

  // 还拉不到（ltoken 过期或被踢）时退一步：拿原始 stoken 重新换一次 ltoken 再来
  if (!roles.length && account.stoken) {
    try {
      token = { ...account, ...(await stoken.getLtokenByStoken(account.region, account)) };
      roles = await stoken.fetchRoles(token);
    } catch {
      /* 换也失败就保持原样，别把已经能用的账号搞坏 */
    }
  }

  const next = {
    ...account,
    ltuid: String(token.ltuid || account.ltuid),
    ltoken: String(token.ltoken || account.ltoken),
    // 刷新失败时保留原列表，避免把能用的数据刷没
    roles: roles.length ? roles : (account.roles || []),
    nickname: account.nickname || pickNickname(roles),
  };
  saveStore(userData, {
    accounts: store.accounts.map((item) => (item.id === account.id ? next : item)),
    activeId: store.activeId,
  });
  return { ok: true, account: publicAccount(next) };
}

/* ------------------------------------------------------------------ */
/* 同步                                                                */
/* ------------------------------------------------------------------ */

/** 拼 getGachaLog 的 query：authkey 是一小串 base64，其余和缓存里那条链接完全一致。 */
function buildApiUrl({ game, region, authkey, uid }) {
  const conf = GAMES[game];
  const base = conf[region] || conf.cn;
  /*
   * auth_appid 与 sign_type 不能省。
   *
   * 之前这里只拼了 authkey / game_biz / uid 这几项，同一个 SToken 直连 node 能取到记录、
   * 走启动器却报「接口限流了」，原因就是少了这两个参数 —— 服务端没有 auth_appid 时
   * 认不出这是 webview 抽卡页的 authkey，回的就是那条容易被误读成限流的错误。
   *
   * region 也统一取配置里的 api.region：星铁 / 绝区零以前传空串，同样是错的。
   */
  const conf2 = stoken.REGIONS[region]?.api?.[game] || {};
  const params = new URLSearchParams({
    authkey_ver: '1',
    sign_type: '2',
    auth_appid: 'webview_gacha',
    // lang 不能省：少了它米哈游回的是 "language error"，跟 authkey 一点关系都没有
    lang: 'zh-cn',
    authkey,
    region: conf2.region || (game === 'genshin' ? (region === 'os' ? 'os_usa' : 'cn_gf01') : ''),
    game_biz: conf2.gameBiz || '',
    uid: String(uid),
    page: '1',
    size: '20',
    end_id: '0',
  });
  return `${base}?${params}`;
}

/**
 * 抽卡接口的限流不是我们的错，重试一下往往就过了。
 *
 * -110004 是米哈游的「请求过于频繁」。以前这里直接抛错，用户看到的是一句
 * 「等十来分钟再试」—— 可实际上停几秒再发就能成功，白白让一次同步失败。
 * 退避三步：3s / 8s / 20s，合计约半分钟，失败次数远小于用户手动重试的次数。
 */
const RETRY_DELAYS = [3000, 8000, 20000];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchPage(base, game, type, page, endId) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchPageOnce(base, game, type, page, endId);
    } catch (error) {
      const limited = error && error.limited;
      if (!limited || attempt >= RETRY_DELAYS.length) throw error;
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
}

async function fetchPageOnce(base, game, type, page, endId) {
  const url = new URL(base);
  if (game === 'zzz') url.searchParams.set('real_gacha_type', String(type));
  else url.searchParams.set('gacha_type', String(type));
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', '20');
  url.searchParams.set('end_id', String(endId));
  const response = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://webstatic.mihoyo.com/' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`抽卡接口 HTTP ${response.status}`);
  const json = await response.json();
  if (json.retcode !== 0) {
    if ([-100, -101, 10001].includes(Number(json.retcode))) {
      throw new Error('authkey 被拒绝（-100 / -101），SToken 可能已经失效，请重新绑定');
    }
    // 2.10.2 的笔记里提过：限流以前被当普通错误吞掉，看起来就是「永远同步不上」
    if (Number(json.retcode) === -110004 || /频繁|frequen|too many|retry later/i.test(String(json.message || ''))) {
      const limited = new Error('请求太密了，米哈游那边限流了。等十来分钟再点一次同步。');
      limited.limited = true;
      throw limited;
    }
    throw new Error(json.message || `抽卡接口错误 ${json.retcode}`);
  }
  return json.data?.list || [];
}

/**
 * 用账号同步某个游戏。
 *
 * uid 允许手动填：有些账号的角色列表拉不出来（风控/新号），
 * 但用户自己知道 UID。有 UID 就能同步，不必卡在角色列表上。
 */
async function syncWithAccount(userData, { accountId, game, uid, onProgress, delayMs = 250, full = false }) {
  if (!GAMES[game]) return { ok: false, error: '这个游戏还不支持 SToken 同步' };
  const store = readStore(userData);
  const account = store.accounts.find((item) => item.id === String(accountId || store.activeId));
  if (!account) return { ok: false, error: '还没有绑定 SToken 账号' };

  /*
   * 先判 SToken，再判 UID —— 顺序不能反。
   *
   * 没有 stoken 时往下走会拿 ltoken 调 genAuthKey，米哈游回一句
   * 「登录状态失效，请重新登录」，我们转述成「抽卡链接已过期」，用户于是
   * 真的去开游戏，白折腾一圈。先判 UID 也不对：roles 被清空过，会先返回
   * 「请先填游戏 UID」，可没有 SToken 时填了 UID 照样申不到 authkey。
   * needStoken 让界面能精准提示「去扫码」而不是「去开游戏」。
   */
  if (!account.stoken) {
    return {
      ok: false,
      needStoken: true,
      error: `这个账号还没绑 SToken，取不到${GAMES[game].name}的抽卡记录。点「SToken 账号」扫一次码就能长期同步。`,
    };
  }

  const targetUid = String(uid || account.roles.find((role) => role.game === game)?.uid || '');
  if (!targetUid) return { ok: false, error: `请先填 ${GAMES[game].name} 的游戏 UID` };

  let key;
  try {
    key = await stoken.getAuthkey({
      game,
      ltoken: account.ltoken,
      // 有真 SToken 时优先用它 —— genAuthKey 只认 SToken 三件套，
      // 拿 ltoken 冒充会被回一句「登录状态失效」，看起来像过期其实是从没对上
      stoken: account.stoken,
      mid: account.mid,
      uid: targetUid,
      region: account.region,
      cookieToken: account.cookieToken,
    });
  } catch (error) {
    return { ok: false, error: `申请 authkey 失败：${error.message}` };
  }

  const base = buildApiUrl({ game, region: account.region, authkey: key.authkey, uid: targetUid });
  const existing = readImportGroups(importsPath(userData)).find(
    (group) => group.game === game && String(group.uid) === targetUid
  );
  const known = new Set((existing?.records || []).map((record) => String(record.Id)));
  const maxKnown = (existing?.records || []).reduce((max, record) => {
    try {
      const value = BigInt(record.Id);
      return value > max ? value : max;
    } catch {
      return max;
    }
  }, 0n);

  const records = [];
  try {
    for (const type of GAMES[game].types) {
      let endId = '0';
      for (let page = 1; page <= 200; page += 1) {
        const list = await fetchPage(base, game, type, page, endId);
        if (!list.length) break;
        let added = 0;
        for (const item of list) {
          const id = String(item.id);
          if (known.has(id)) continue;
          known.add(id);
          records.push({
            Uid: String(item.uid || targetUid),
            Id: id,
            Name: String(item.name || ''),
            Time: String(item.time || '').replace('T', ' ').replace(/Z$/, ''),
            ItemId: String(item.item_id || ''),
            ItemType: String(item.item_type || ''),
            RankType: Number(item.rank_type) || 0,
            GachaType: Number(item.gacha_type) || type,
          });
          added += 1;
        }
        onProgress?.({ game, type, page, added, total: records.length });
        const lastId = list[list.length - 1]?.id;
        if (list.length < 20) break;
        if (!lastId) break;
        endId = String(lastId);
        // 全量模式要一路翻到底，不能遇到本地最老那条就停
        if (!full) {
          try {
            if (BigInt(endId) <= maxKnown) break;
          } catch {
            /* ignore malformed id */
          }
          if (!added && page > 1) break;
        }
        // 请求之间留点空隙，别再像以前那样全速连发撞限流
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } catch (error) {
    // 已经抓到的先存下来 —— 下一次不会重抓，也不会白跑一趟
    if (records.length) {
      const file = importsPath(userData);
      const groups = mergeGroups(readImportGroups(file), [{ game, uid: targetUid, records }]);
      await saveImportGroups(file, groups);
    }
    return { ok: false, error: error.message, imported: records.length, uid: targetUid };
  }

  const next = {
    ...account,
    lastSyncAt: new Date().toISOString(),
    roles: account.roles.some((role) => role.game === game && String(role.uid) === targetUid)
      ? account.roles
      : [...(account.roles || []), { game, uid: targetUid, nickname: '' }],
  };
  saveStore(userData, {
    accounts: store.accounts.map((item) => (item.id === account.id ? next : item)),
    activeId: store.activeId,
  });

  if (!records.length) {
    return { ok: true, game, uid: targetUid, imported: 0, total: existing?.records.length || 0 };
  }
  const file = importsPath(userData);
  const groups = mergeGroups(readImportGroups(file), [{ game, uid: targetUid, records }]);
  await saveImportGroups(file, groups);
  return {
    ok: true,
    game,
    uid: targetUid,
    imported: records.length,
    total: groups.find((group) => group.game === game && group.uid === targetUid)?.records.length || 0,
  };
}

module.exports = {
  GAMES,
  listAccounts,
  bindAccount,
  bindFromCookie,
  bindBundle,
  removeAccount,
  setActiveAccount,
  refreshRoles,
  syncWithAccount,
  buildApiUrl,
  storePath,
};
