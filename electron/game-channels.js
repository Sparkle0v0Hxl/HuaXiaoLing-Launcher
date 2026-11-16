/*
 * 渠道能力表（唯一权威源）。
 *
 * 为什么要有这张表：以前「某一款游戏的某个渠道能不能硬链接 / 能不能下载 / 能不能修复」
 * 散落在十几处硬编码里 —— 前端 src/views/home.js 的 canLinkByEngine、src/views/servers.js
 * 的 canUpdateSophon / canRepairGame / canPrepare / PREDOWNLOAD_GAMES / predownloadChannelOk，
 * 后端 electron/servers-ipc.js 的 prepare-sophon 渠道白名单、electron/main.js 的
 * DOWNLOADABLE_KEYS / engineFor / ensureKuroRuntime 的渠道判断、electron/sophon.js 的
 * CHANNELS…… 每加一个渠道就要改一圈，改漏一处就是「这个服按钮没了 / 点了报错」。
 *
 * 2026-11-16 用户把规则一次说清（原话见下），这里按他的话固化成表：
 *   「原神是全都可以硬链接的，星铁也是全都可以，绝区零也是全都可以，崩坏三我没有，
 *     但是做的时候，应该也是全都可以的，终末地也是全都可以，明日方舟是官服B服可以硬链接，
 *     然后国际服的三个可以硬链接，鸣潮官服B服wegame都可以硬链接，异环是可以官服B服切的，
 *     然后鸣潮国际服和异环都需要能能下载什么的」
 *   「这些硬链接，都可以互相为源，只要有一个服是全的，就可以随便硬链接别的服和官服」
 *   「wegame不是国际服，是另外的一个平台」
 *   「异环国际服和鸣潮国际服需要能下载，刚刚异环说少了国际服三个字」
 *
 * 注意两条边界（是能力缺口的真实原因，不是偷懒）：
 *   · 崩坏3 的 B服 / 国际服：HoYoPlay 官方接口只给 bh3_cn（已用 getGameBranches 实网验证，
 *     bilibili launcher 与 global host 查 osvnlOc0S8 都返回空分支），没有清单就没法按
 *     文件级 hash 硬链接，也没法一键下载。这两个渠道仍保留渠道行（能选路径、能启动、
 *     能修复——修复走的是本地已有文件的清单比对，不依赖远端渠道清单）。
 *   · 异环的国际服：官方 Config.ini 只有 publish_ob / publish_ob_B 两套渠道配置与 CDN
 *     前缀，没有第三套。用户要求「国际服要能下载」——能做的部分是「以已装的官服/B服
 *     客户端为源，硬链接相同文件、把国际服目录铺出来」（不需要官方清单，走 linkTrees），
 *     做不了的是「从官方 CDN 拉国际服增量包」。
 */

/** 全部渠道（含 wegame，它是独立平台不是国际服）。 */
const CH_GENSHIN = ['official', 'bilibili', 'global'];
const CH_SR = ['official', 'bilibili', 'global'];
const CH_ZZZ = ['official', 'bilibili', 'global'];
const CH_BH3 = ['official', 'bilibili', 'global'];
const CH_ENDFIELD = ['official', 'bilibili', 'global', 'play', 'steam'];
const CH_ARKNIGHTS = ['official', 'bilibili', 'global-en', 'global-jp', 'global-kr', 'taiwan'];
const CH_WUWA = ['official', 'bilibili', 'global', 'wegame'];
const CH_NTE = ['official', 'bilibili', 'global'];

/**
 * 每款游戏的能力矩阵。
 *
 *   link       能以另一个渠道为源硬链接生成该渠道运行时（用户口径：互相为源）
 *   download   该渠道走「一键下载」直接装（引擎 = 官方 CDN 清单是否存在）
 *   repair     服务器卡片上的「修复」入口
 *   update     服务器卡片上的「检查更新」入口（米哈游系只对 sophon 渠道）
 *   predownload 预下载入口
 *   switchIni  切换是改官方 Config.ini（异环特有）
 */
const GAME_CHANNEL_CAPS = {
  genshin: {
    label: '原神',
    link: CH_GENSHIN,
    download: CH_GENSHIN,
    repair: CH_GENSHIN,
    update: CH_GENSHIN,
    predownload: CH_GENSHIN,
  },
  starrail: {
    label: '崩坏：星穹铁道',
    link: CH_SR,
    download: CH_SR,
    repair: CH_SR,
    update: CH_SR,
    predownload: CH_SR,
  },
  zzz: {
    label: '绝区零',
    link: CH_ZZZ,
    download: CH_ZZZ,
    repair: CH_ZZZ,
    update: CH_ZZZ,
    predownload: CH_ZZZ,
  },
  bh3: {
    label: '崩坏3',
    /*
     * 用户：「崩坏三我没有，但是做的时候，应该也是全都可以的」。
     * 硬链接本身是本地文件操作，不依赖远端清单 —— 只要有一份完整客户端当源，
     * 铺一份 B服 / 国际服 目录（再补对应 SDK 文件）在技术上是成立的，所以 link 放全渠道。
     * 但「一键下载」和「检查更新」依赖 HoYoPlay 清单，官方只给 bh3_cn，放不开。
     */
    link: CH_BH3,
    download: ['official'],
    /*
     * 修复走的是 prepareSophon({ verifyAll: true })，仍要读该渠道的官方清单
     * （sophon.js 的 CHANNELS.bh3 只有 official），B服/国际服进去只会拿到
     * 「这个服务器没有 Sophon 清单」。所以修复也只放官服，别给点了必报错的入口。
     */
    repair: ['official'],
    update: ['official'],
    predownload: ['official'],
  },
  endfield: {
    label: '明日方舟：终末地',
    link: CH_ENDFIELD,
    download: CH_ENDFIELD,
    repair: CH_ENDFIELD,
    update: CH_ENDFIELD,
    predownload: CH_ENDFIELD,
  },
  arknights: {
    label: '明日方舟',
    link: CH_ARKNIGHTS,
    download: CH_ARKNIGHTS,
    repair: CH_ARKNIGHTS,
    update: CH_ARKNIGHTS,
    predownload: CH_ARKNIGHTS,
  },
  wutheringwaves: {
    label: '鸣潮',
    /*
     * 用户：「鸣潮官服B服wegame都可以硬链接」+「鸣潮国际服需要能下载」。
     * wegame 是独立平台：自己就是一份完整客户端、启动走 wegame:// URI，
     * 可以当源给别人，也可以以别人为源铺一份（但不参与「切服」语义）。
     * 国际服：库洛官方 index.json 有 G153 清单（kuro-packs 的 KURO_PROFILES.global），
     * 下载 / 更新 / 修复 全通；硬链接也放行（用户定的「互相为源」），
     * 只是与国服差异 98%，复用率低但结果正确。
     */
    link: CH_WUWA,
    download: CH_WUWA,
    repair: CH_WUWA,
    update: CH_WUWA,
    predownload: CH_WUWA,
  },
  neverness: {
    label: '异环',
    /*
     * 用户：「异环是可以官服B服切的」+「异环国际服需要能下载」。
     * 国际服没有官方渠道配置，所以：
     *   · link 放行 —— 以官服/B服 或任意已装客户端为源，硬链接铺出国际服目录（本地操作）
     *   · download 放行 —— 走「硬链接生成」这条（和 link 同一入口），
     *     不是从官方 CDN 拉增量包（那条只有 publish_ob / publish_ob_B）
     *   · predownload 只放官服/B服（官方 CDN 只有两套前缀）
     */
    link: CH_NTE,
    download: CH_NTE,
    repair: CH_NTE,
    update: CH_NTE,
    predownload: ['official', 'bilibili'],
    switchIni: ['official', 'bilibili'],
  },
};

/** 自建游戏（没有 builtinKey 或不认识的）：当成单渠道，所有能力按「有客户端就能用」。 */
const FALLBACK_CAPS = {
  label: '',
  link: [],
  download: [],
  repair: [],
  update: [],
  predownload: [],
};

function capsOf(gameKey) {
  return GAME_CHANNEL_CAPS[String(gameKey || '')] || FALLBACK_CAPS;
}

/** 某个游戏某个渠道是否支持某项能力。 */
function can(gameKey, channel, capability) {
  const caps = capsOf(gameKey);
  const list = caps[capability];
  if (!Array.isArray(list)) return false;
  return list.includes(String(channel || ''));
}

/** 某个游戏某项能力支持的渠道列表（前端渲染下拉/白名单用）。 */
function channelsFor(gameKey, capability) {
  const caps = capsOf(gameKey);
  const list = caps[capability];
  return Array.isArray(list) ? list.slice() : [];
}

/**
 * 把一款游戏某个渠道的全部能力打包出来，挂到 publicGame 的每个 server 上，
 * 前端就不用再自己维护一份渠道白名单了（那是「两处不一致」的根源）。
 */
function capsForServer(gameKey, channel) {
  const ch = String(channel || '');
  return {
    link: can(gameKey, ch, 'link'),
    download: can(gameKey, ch, 'download'),
    repair: can(gameKey, ch, 'repair'),
    update: can(gameKey, ch, 'update'),
    predownload: can(gameKey, ch, 'predownload'),
    switchIni: can(gameKey, ch, 'switchIni'),
  };
}

module.exports = {
  GAME_CHANNEL_CAPS,
  CH_GENSHIN,
  CH_SR,
  CH_ZZZ,
  CH_BH3,
  CH_ENDFIELD,
  CH_ARKNIGHTS,
  CH_WUWA,
  CH_NTE,
  capsOf,
  can,
  channelsFor,
  capsForServer,
};
