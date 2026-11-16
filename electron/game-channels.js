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
 *   · 方舟台服（繁中）： Gryphline 直营，走 batch_proxy + md5 清单，与国服同协议同密钥
 *     （2026-11-17 实测：接口 200、清单 12678 文件 / 21.51GB、与国服 35% 文件 md5 相同）。
 *     所以台服能下载、能更新、能修复，也能以国服客户端为源硬链接生成一份；
 *     但它与 Yostar 三区（EN/JP/KR）不能互源 —— 那三区是 CRC64 清单、不同 CDN、不同发行商。
 *   · 异环的国际服：官方 Config.ini 只有 publish_ob / publish_ob_B 两套渠道配置与 CDN
 *     前缀，没有第三套。用户要求「国际服要能下载」——能做的部分是「以已装的官服/B服
 *     客户端为源，硬链接相同文件、把国际服目录铺出来」（不需要官方清单，走 linkTrees），
 *     做不了的是「从官方 CDN 拉国际服增量包」。
 */

/** 全部渠道（含 wegame，它是独立平台不是国际服）。 */
/*
 * 明日方舟：台服（taiwan）由第三个发行商发行，协议未验证，
 * 生成运行时 / 更新本体 / 修复本体 / 一键下载四条链路都会直接抛错，
 * 所以它不在可用渠道里（渠道行仍然保留，玩家能选路径、能启动）。
 * B服（bilibili）只有渠道包（ArkBilibili 增量载荷）没有完整客户端整包清单，
 * 所以它能硬链接、能更新、能修复，但不能「一键下载整包」。
 */
const CH_ARKNIGHTS_USABLE = ['official', 'bilibili', 'global-en', 'global-jp', 'global-kr', 'taiwan'];
/** 方舟里「能一键下载整包」的渠道：官服用鹰角整包清单，Yostar 三区用自己的清单。 */
const CH_ARKNIGHTS_DOWNLOAD = ['official', 'global-en', 'global-jp', 'global-kr', 'taiwan'];
/** 鸣潮里「库洛官方清单存在」的渠道（WeGame 是独立平台，没有这一档清单）。 */
const CH_KURO = ['official', 'bilibili', 'global'];
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
     *
     * 2026-11-17 实测修正（参考本机 Starward 源码 H:\_research\Starward
     * src/Starward.Core/HoYoPlay/GameId.cs:25-30 + getGameBranches 实网验证）：
     *   · 官服 bh3_cn   game_id=osvnlOc0S8  launcher=jGHBHlcOq1  server=cn
     *   · 国际服 bh3_global game_id=5TIVvvcwtM launcher=VYTpXlbWo8 server=global
     *     （sg-hyp-api 里 bh3_global 有 5 个 game_id，是同一款游戏的 5 个发行区服：
     *       本体 5TIVvvcwtM / 日服 g0mMIvshDb / 韩服 uxB4MC7nzC /
     *       东南亚 bxPTXSET5t / 繁中 wkE5P5WsIf；Starward 只把本体当默认。）
     *     实测国际服分支返回 tag=9.1.0、matching_fields=[game, asb]，
     *     两份清单（game 1.42GB + asb 35.27GB）都能正常下载并 zstd 解码。
     *   · B服确实没有：三个 B服 launcher（umfgRO5gh5 / 6P5gHMNyK3 / xV0f4r1GT0）
     *     下都查不到崩坏3 —— B服走 B站自有启动器，不在 HoYoPlay 分发体系里。
     * 所以 download / repair / update / predownload 现在官服 + 国际服都通，
     * B服只剩 link（硬链接是纯本地文件操作，不依赖远端清单）。
     */
    link: CH_BH3,
    download: ['official', 'global'],
    /*
     * 修复走的是 prepareSophon({ verifyAll: true })，要读该渠道的官方清单。
     * 官服 bh3_cn、国际服 bh3_global 都有清单，B服没有 —— 所以 B服 不在这张表里，
     * 别给点了必报错的入口。
     */
    repair: ['official', 'global'],
    update: ['official', 'global'],
    predownload: ['official', 'global'],
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
    link: CH_ARKNIGHTS_USABLE,
    /*
     * 一键下载：官服用鹰角整包清单，Yostar 三区（global-en/jp/kr）用 Yostar 自己的清单。
     * B服只有渠道包（增量载荷）不是完整客户端，所以不在这张表里。
     * 台服（繁中，Gryphline 直营）：2026-11-17 实测确认它跟国服官服同协议同密钥
     * （batch_proxy + AES-256-CBC，密钥与 Hi3Helper.Plugin.Arknights 逐字节一致），
     * 清单 12678 文件 / 74.0.1，与国服 35% 的文件 md5 相同 → 可下载、可更新、可修复，
     * 也能拿国服官服当源硬链接生成。它跟 Yostar 三区不能互源（协议与 CDN 都不同）。
     */
    download: CH_ARKNIGHTS_DOWNLOAD,
    repair: CH_ARKNIGHTS_USABLE,
    update: CH_ARKNIGHTS_USABLE,
    /*
     * 预下载：方舟官方至今没开放预下载分支（协议里有 pre_patch 字段，只是没放包），
     * 后端 predownload.js 里 SUPPORT.arknights.supported 一直是 false。
     * 这里必须留空数组 —— 之前跟着 USABLE 一起放开的话，界面会给台服挂一个
     * 「预下载」入口，点进去只能得到一句「不支持」，属于典型的假入口。
     */
    predownload: [],
  },
  wutheringwaves: {
    label: '鸣潮',
    /*
     * 用户：「鸣潮官服B服wegame都可以硬链接」+「鸣潮国际服需要能下载」。
     * wegame 是独立平台：自己就是一份完整客户端、启动走 wegame:// URI，
     * 可以当源给别人，也可以以别人为源铺一份（但不参与「切服」语义）。
     * 国际服：库洛官方 index.json 有 G153 清单（kuro-packs 的 KURO_PROFILES.global），
     * 下载 / 更新 / 修复 全通。
     */
    /*
     * link（能作为「硬链接生成」的目标）只放官服 / B服：
     *   kuroPacks.buildCrossRuntime 对 global 直接抛「不支持硬链接互切」，
     *   wegame 没有目标清单 —— 这两个渠道只能当「源」（externalLinkSources 与
     *   ensureKuroRuntime 的 candidates 都收它们），不能当生成目标。
     * download / repair / update / predownload 读库洛官方清单：官方 / B服 / 国际服三档有，
     *   wegame 没有这一档清单，所以不在表里。
     */
    link: ['official', 'bilibili'],
    download: CH_KURO,
    repair: CH_KURO,
    update: CH_KURO,
    predownload: CH_KURO,
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
  CH_ARKNIGHTS_USABLE,
  CH_ARKNIGHTS_DOWNLOAD,
  CH_KURO,
  CH_WUWA,
  CH_NTE,
  capsOf,
  can,
  channelsFor,
  capsForServer,
};
