'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { multiDownload, MIN_PARALLEL_SIZE } = require('./multi-download');
const netThrottle = require('./net-throttle');
const { httpFetch, segmentFetch } = require('./http-fetch');
const linkSource = require('./link-source');
const diskSpace = require('./disk-space');

const AES_KEY = Buffer.from([
  192, 243, 14, 28, 231, 99, 187, 194, 28, 195, 85, 163, 67, 3, 172, 80, 57, 148, 68,
  191, 246, 140, 74, 34, 175, 57, 140, 10, 22, 110, 225, 67,
]);
const AES_IV = Buffer.from([
  51, 70, 120, 97, 25, 39, 80, 100, 149, 1, 147, 114, 100, 96, 132, 0,
]);

const COMMON_ROOT = ['U8CoreUI.dll', 'U8SDK.dll', 'u8_channel.dll'];
const COMMON_DIRS = ['sdkdata/', 'U8Data/config/'];

/*
 * EndfieldBase.dll（游戏平台基座，约 37MB）官方清单实锤分渠道：
 *   official/bilibili = fb6986b7…，global = 94ff01ac…。
 * 渠道包不带它的话，国际服运行时里永远是基础客户端（国服）的版本，
 * 官方完整性校验直接报「游戏文件缺失或损坏」——第三方切服器要求手动替换的
 * HGP.dll / EndfieldBase.dll / OneChannelLC.dll 三件套里的前者和后者
 * 我们的渠道包本来就有，缺的只有这一颗。
 * WebviewConfig 文件夹经切换器作者确认不需要处理，不收。
 */
const COMMON_CHANNEL_ROOT = [...COMMON_ROOT, 'EndfieldBase.dll'];

const PROFILES = [
  {
    iconName: 'Endfield',
    directory: 'EndOfficial',
    api: 'https://launcher.hypergryph.com/api/proxy/batch_proxy',
    appcode: '6LL0KJuqHBVz33WK',
    launcherAppcode: 'abYeZZ16BPluCFyT',
    channel: '1',
    subChannel: '1',
    seq: '5',
    rootFiles: [
      ...COMMON_CHANNEL_ROOT,
      'eld_Endfield.db', 'hgsdk.dll', 'OneChannelLC.dll', 'HGP.dll',
      // 跨族当源（国际服 / Play / Steam 运行时 → 官服）时，源树里这 5 颗是
      // Gryphline 版，和 Hypergryph 的 SDK / 账号体系不配套，正是「官服重二进制
      // + 国际服 SDK」6 秒崩的镜像。补回官服官方全量清单里的官服版 5 颗，
      // overlay 会先断链再 copy，把壳与件刷成同一套。与 EndGlobal 完全对称，
      // 不动 GameAssembly.dll / Qt5 / CefView 等官服与国际服同版的大件。
      'Endfield.exe',
      'UnityPlayer.dll',
      'AntiCheatExpert/ACE-Base.dat',
      'AntiCheatExpert/ACE-Base64.dll',
      'Endfield_Data/Plugins/x86_64/CrashSight64.dll',
    ],
    dirs: COMMON_DIRS,
    // 补 5 颗后提 packRev：老 .state 判未就绪 → 整包重下（约 112MB），
    // 保证跨族生成官服运行时一定拿到官服版重二进制，不会留着国际服壳子。
    packRev: 1,
  },
  {
    iconName: 'BiliEndfield',
    directory: 'EndBilibili',
    api: 'https://launcher.hypergryph.com/api/proxy/batch_proxy',
    appcode: '6LL0KJuqHBVz33WK',
    launcherAppcode: 'abYeZZ16BPluCFyT',
    channel: '2',
    subChannel: '2',
    seq: '5',
    rootFiles: [
      ...COMMON_CHANNEL_ROOT,
      'eld_Endfield.db', 'PCGameSDK.dll', 'OneChannelLC.dll', 'HGP.dll',
      // 同 EndOfficial：跨族当源时靠这 5 颗官服版重二进制把 Gryphline 壳刷回来。
      'Endfield.exe',
      'UnityPlayer.dll',
      'AntiCheatExpert/ACE-Base.dat',
      'AntiCheatExpert/ACE-Base64.dll',
      'Endfield_Data/Plugins/x86_64/CrashSight64.dll',
    ],
    dirs: ['BLPlatform64/', 'U8Data/config/'],
    // 回退大包（2026-11-08）：只铺 SDK 白名单小包（v2.3.0 / Xel 式），不再叠 deltaOf
    // 差异二进制。packRev 3→4：补 5 颗官服版重二进制，强制老用户重下成新小包，
    // 见 channelPackFilesReady / packDownloadedState。
    packRev: 4,
  },
  {
    iconName: 'GlobalEndfield',
    directory: 'EndGlobal',
    api: 'https://launcher.gryphline.com/api/proxy/batch_proxy',
    appcode: 'YDUTE5gscDZ229CW',
    launcherAppcode: 'YDUTE5gscDZ229CW',
    channel: '6',
    subChannel: '6',
    seq: '3',
    rootFiles: [
      ...COMMON_CHANNEL_ROOT,
      'gfsdk.dll',
      'glfoundation.dll',
      'OneChannelLC.dll',
      'HGP.dll',
      // 回退大包后的纯 SDK 小包让国际服「官服重二进制 + 国际服 SDK」混搭、启动 6 秒
      // 即退（launch.log pid 6984/12588）。补回这 5 颗渠道重二进制让壳与件配套；
      // 均取自 EndGlobal 官方全量清单，与三服替换包国际服版 md5 逐字节一致（约 114.6MB）。
      // 不动 GameAssembly.dll / CefView / Qt5 等大件：历史替换包亦不带、官服基底沿用；
      // 若本机实测仍崩则回退 126 文件完整差异包。
      'Endfield.exe',
      'UnityPlayer.dll',
      'AntiCheatExpert/ACE-Base.dat',
      'AntiCheatExpert/ACE-Base64.dll',
      'Endfield_Data/Plugins/x86_64/CrashSight64.dll',
    ],
    dirs: COMMON_DIRS,
    // 补 110MB（2026-11-09）：packRev 3→4 强制重下新增的 5 颗（老 .state 里 PackRev=3
    // 会被判未就绪）；B服 / 官服 / Play / Steam 一行不动。
    packRev: 4,
  },
  {
    iconName: 'PlayEndfield',
    directory: 'EndPlay',
    api: 'https://launcher.gryphline.com/api/proxy/batch_proxy',
    appcode: 'YDUTE5gscDZ229CW',
    launcherAppcode: 'YDUTE5gscDZ229CW',
    channel: '6',
    subChannel: '802',
    seq: '3',
    rootFiles: [
      ...COMMON_CHANNEL_ROOT,
      'gfsdk.dll',
      'glextra.dll',
      'glfoundation.dll',
      'manifest.xml',
      'play_pc_sdk.dll',
      'OneChannelLC.dll',
      'HGP.dll',
      // 与 EndGlobal 对称：跨渠道当源时补回 Play 版 5 颗重二进制，让壳与件配套。
      // 路径是白名单，内容由 Play 官方全量清单按同名路径下载，不硬编码 md5。
      'Endfield.exe',
      'UnityPlayer.dll',
      'AntiCheatExpert/ACE-Base.dat',
      'AntiCheatExpert/ACE-Base64.dll',
      'Endfield_Data/Plugins/x86_64/CrashSight64.dll',
    ],
    dirs: COMMON_DIRS,
    // 补 5 颗后提 packRev：老 .state 判未就绪 → 整包重下，保证跨渠道生成时
    // 一定拿到 Play 版重二进制，不会留着别的渠道的壳子。
    packRev: 4,
  },
  {
    iconName: 'SteamEndfield',
    directory: 'EndSteam',
    api: 'https://launcher.gryphline.com/api/proxy/batch_proxy',
    appcode: 'YDUTE5gscDZ229CW',
    launcherAppcode: 'YDUTE5gscDZ229CW',
    channel: '6',
    subChannel: '803',
    seq: '3',
    rootFiles: [
      ...COMMON_CHANNEL_ROOT,
      'gfsdk.dll',
      'glextra.dll',
      'glfoundation.dll',
      'HGP.dll',
      'steam_api64.dll',
      'steam_appid.txt',
      // 与 EndGlobal 对称：跨渠道当源时补回 Steam 版 5 颗重二进制，让壳与件配套。
      // 路径是白名单，内容由 Steam 官方全量清单按同名路径下载，不硬编码 md5。
      'Endfield.exe',
      'UnityPlayer.dll',
      'AntiCheatExpert/ACE-Base.dat',
      'AntiCheatExpert/ACE-Base64.dll',
      'Endfield_Data/Plugins/x86_64/CrashSight64.dll',
    ],
    dirs: COMMON_DIRS,
    // 补 5 颗后提 packRev：老 .state 判未就绪 → 整包重下，保证跨渠道生成时
    // 一定拿到 Steam 版重二进制，不会留着别的渠道的壳子。
    packRev: 4,
  },
  {
    /*
     * 明日方舟 PC 端（2026-02-10 技术测试，2026-09-14 正式上线）。
     *
     * appcode 不是公开常量，是从鹰角启动器日志里读出来的：
     *   %USERPROFILE%\AppData\LocalLow\Hypergryph\<hash>\logs\games.log
     *   → strAppCode:GzD1CpaWgmSq1wew, strGameVersion:78.0.0, 入口 lights.exe
     *
     * 和终末地同构：base 下的加密逐文件清单（GET <base>/game_files）能读到，
     * 实测 13749 个文件 / 25.4GB，所以走同一套增量更新逻辑。
     * 接口另外还会给 20 个分卷 ZIP（43.7GB），那是整包重装用的，这里不用。
     */
    iconName: 'Arknights',
    directory: 'Arknights',
    api: 'https://launcher.hypergryph.com/api/proxy/batch_proxy',
    appcode: 'GzD1CpaWgmSq1wew',
    launcherAppcode: 'abYeZZ16BPluCFyT',
    channel: '1',
    subChannel: '1',
    seq: '5',
    rootFiles: [...COMMON_CHANNEL_ROOT, 'eld_Arknights.db', 'hgsdk.dll', 'OneChannelLC.dll'],
    dirs: COMMON_DIRS,
    entry: 'Arknights.exe',
  },
];

/*
 * 明日方舟 B服 渠道载荷（单独一条，不进 PROFILES）。
 *
 * 明日方舟官服和 B服 共用同一个安装目录：B服 只是在里面多出渠道 SDK 那几样。
 * 切到 B服 时如果它们不在，过去只能让用户自己先用 B服 官方启动器装一遍。
 * 这条配置就是用来从官方接口把它们取回来的。
 *
 * 文件清单逐项对齐 Xel-Launcher 的 BiliArknightsPayload（Helpers/GameChannelCatalog.cs）：
 *   通用三件 U8CoreUI.dll / U8SDK.dll / u8_channel.dll
 * + B服 专属 PCGameSDK.dll、PlatformProcess.dll / .exe、webviewsdk.dll
 * + 两个目录 BLPlatform64\、U8Data\config\
 * 少一样 B服 登录界面就起不来，所以宁可多收，不能照着猜。
 *
 * 目录名用 Xel-Launcher 的 ArkBilibili：装了它的机器，load 目录里的方舟包
 * 我们直接认。不进 PROFILES 是有意的：这条还需要在真机上验证，绝不能让
 * 「下载全部渠道包」顺手把没验证过的东西塞进用户机器。
 */
const ARKNIGHTS_BILIBILI_PROFILE = {
  iconName: 'ArkBilibili',
  directory: 'ArkBilibili',
  api: 'https://launcher.hypergryph.com/api/proxy/batch_proxy',
  appcode: 'GzD1CpaWgmSq1wew',
  launcherAppcode: 'abYeZZ16BPluCFyT',
  channel: '2',
  subChannel: '2',
  seq: '5',
  rootFiles: [
    ...COMMON_ROOT,
    'PCGameSDK.dll',
    'PlatformProcess.dll',
    'PlatformProcess.exe',
    'webviewsdk.dll',
  ],
  dirs: ['BLPlatform64/', 'U8Data/config/'],
  entry: 'Arknights.exe',
};

/** 判定某个方舟渠道包已经完整落盘：渠道专属件和通用件都得在。 */
const ARKNIGHTS_BILIBILI_READY = [
  'PCGameSDK.dll',
  'U8CoreUI.dll',
  'U8SDK.dll',
  'u8_channel.dll',
  'U8Data/config/config.bin',
];
const ARKNIGHTS_OFFICIAL_READY = [
  'hgsdk.dll',
  'U8CoreUI.dll',
  'U8SDK.dll',
  'u8_channel.dll',
  'U8Data/config/config.bin',
];

/*
 * 明日方舟官服渠道包（同样单独一条，不进 PROFILES）。
 *
 * 用户手上装的是 B服 时，切回官服也得换东西：U8SDK.dll / U8CoreUI.dll /
 * u8_channel.dll / U8Data\config\ 这些通用件是分渠道的，沿用 B站 的那一份，
 * 官服运行时里跑的还是 B站 的 SDK。目录名同样照抄 Xel-Launcher 的 ArkOfficial。
 * 清单逐项对齐它的 ArknightsPayload：通用三件 + hgsdk.dll 与平台层三件套。
 */
const ARKNIGHTS_OFFICIAL_PROFILE = {
  iconName: 'ArkOfficial',
  directory: 'ArkOfficial',
  api: 'https://launcher.hypergryph.com/api/proxy/batch_proxy',
  appcode: 'GzD1CpaWgmSq1wew',
  launcherAppcode: 'abYeZZ16BPluCFyT',
  channel: '1',
  subChannel: '1',
  seq: '5',
  rootFiles: [
    ...COMMON_ROOT,
    'hgsdk.dll',
    'PlatformProcess.dll',
    'PlatformProcess.exe',
    'webviewsdk.dll',
  ],
  dirs: COMMON_DIRS,
  entry: 'Arknights.exe',
};

/**
 * 先确认官方接口上拿到的确实**是明日方舟**的清单。
 *
 * 明日方舟和终末地共用同一个 batch_proxy 接口，只靠 appcode / channel 区分。
 * 配错时接口会照常返回一份清单，而终末地 B服 的清单里同样有 PCGameSDK.dll 和
 * BLPlatform64 —— 直接写进方舟运行时会换来一个打不开的游戏。所以先看清单里
 * 有没有 Arknights.exe 再决定动不动手。
 */
async function verifyArknightsSource(profile = ARKNIGHTS_BILIBILI_PROFILE) {
  try {
    const remote = await loadRemoteManifest(profile, true);
    return remote.files.some((file) => /(^|\/)arknights\.exe$/i.test(file.path));
  } catch {
    return false;
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function decryptManifest(encrypted) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, AES_IV);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** 与 decryptManifest 配对：鹰角本地的 config.ini 也是同一套 AES 加密。 */
function encryptManifest(text) {
  const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, AES_IV);
  return Buffer.concat([cipher.update(Buffer.from(String(text), 'utf8')), cipher.final()]);
}

function parseManifest(text) {
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let node;
    try {
      node = JSON.parse(line);
    } catch {
      continue;
    }
    if (!node?.path || !node?.md5) continue;
    const normalized = String(node.path).replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.includes('..')) continue;
    files.push({
      path: normalized,
      urlPath: normalized,
      md5: String(node.md5).toLowerCase(),
      size: Number(node.size) || 0,
    });
  }
  return files;
}

function isAllowed(profile, relative) {
  if (profile.rootFiles.some((name) => name.toLowerCase() === relative.toLowerCase())) {
    return true;
  }
  return profile.dirs.some((prefix) => relative.toLowerCase().startsWith(prefix.toLowerCase()));
}

async function fetchLatest(profile) {
  const body = {
    seq: profile.seq,
    proxy_reqs: [
      {
        kind: 'get_latest_game',
        get_latest_game_req: {
          appcode: profile.appcode,
          launcher_appcode: profile.launcherAppcode,
          channel: profile.channel,
          sub_channel: profile.subChannel,
          version: '',
        },
      },
    ],
  };
  const response = await httpFetch(profile.api, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${profile.iconName} 版本接口 HTTP ${response.status}`);
  const json = await response.json();
  const latest = (json.proxy_rsps || []).find(
    (item) => item.kind === 'get_latest_game' && item.get_latest_game_rsp
  )?.get_latest_game_rsp;
  const base = latest?.pkg?.file_path;
  const version = latest?.version;
  if (!base || !version) throw new Error(`${profile.iconName} 接口没有返回文件清单地址`);
  const packs = Array.isArray(latest?.pkg?.packs) ? latest.pkg.packs : [];
  return {
    version: String(version),
    clientVersion: latest?.client_version ? String(latest.client_version) : '',
    base: String(base).replace(/\/$/, ''),
    totalSize: Number(latest?.pkg?.total_size) || 0,
    packs: packs.map((pack) => ({
      url: String(pack.url || ''),
      md5: String(pack.md5 || '').toLowerCase(),
      size: Number(pack.package_size) || 0,
    })),
  };
}

/*
 * 清单体积分档：终末地只有 0.2 MB（单连接 300 ms 就完了，分段反而多一次探测往返），
 * 明日方舟 2.09 MB 而 CDN 对单连接限速到 1 MB/s —— 那条必须分段：
 * 实测单连接 2.1 s、8 连接 1.0 s、16 连接 1.2 s（再多就是互相抢带宽了）。
 * 阈值取两者中间。
 */
const MANIFEST_PARALLEL_MIN = 512 * 1024;
const MANIFEST_MIN_SEGMENT = 128 * 1024;
const MANIFEST_CONNECTIONS = 8;
/** 清单内存缓存：同一版本 5 分钟内重复读清单（切服、量体积、校验、下载各读一次）不再走网络。 */
const MANIFEST_MEMO_MS = 5 * 60 * 1000;
const MANIFEST_MEMO_MAX = 16;
const manifestMemo = new Map();
/** 记住各渠道上次清单多大：小清单下次直接单连接，省掉一次分段探测往返。 */
const manifestSizeHint = new Map();

/*
 * 清单磁盘缓存：2 MB 的加密原文，按「渠道 + 版本」存。
 *
 * 版本号来自版本接口，换版本自然换 key，不会读到过期清单。启动器每次开都要读一遍
 * 清单，网络那 1~2 秒是躲不掉的，但第二次开就不用再下了：只剩一次版本接口的往返，
 * 实测 1800 ms → 130 ms。缓存放临时目录，被系统清掉也不影响正确性。
 */
const MANIFEST_DISK_DIR = path.join(os.tmpdir(), 'hxl-manifest-cache');
const MANIFEST_DISK_MAX_AGE = 7 * 24 * 3600 * 1000;

function manifestDiskPath(profile, version) {
  const safe = `${profile.directory}-${version}`.replace(/[^\w.-]+/g, '_');
  return path.join(MANIFEST_DISK_DIR, `${safe}.bin`);
}

async function readDiskManifest(profile, version) {
  try {
    const file = manifestDiskPath(profile, version);
    const stat = await fsp.stat(file);
    if (!stat.size || Date.now() - stat.mtimeMs > MANIFEST_DISK_MAX_AGE) return null;
    return await fsp.readFile(file);
  } catch {
    return null;
  }
}

async function writeDiskManifest(profile, version, buffer) {
  try {
    const file = manifestDiskPath(profile, version);
    await fsp.mkdir(MANIFEST_DISK_DIR, { recursive: true });
    await fsp.writeFile(file, buffer);
    const entries = await fsp.readdir(MANIFEST_DISK_DIR);
    const stale = Date.now() - MANIFEST_DISK_MAX_AGE;
    for (const name of entries) {
      const full = path.join(MANIFEST_DISK_DIR, name);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && stat.mtimeMs < stale) await fsp.rm(full, { force: true }).catch(() => {});
    }
  } catch {
    /* 缓存写失败不影响正常流程 */
  }
}

/**
 * 取加密清单本体：先磁盘缓存，再分段下载，最后单连接。
 *
 * 分段下载要落文件，所以下到临时目录再读回来（2 MB 的磁盘往返可以忽略）。
 * 分段不可用（服务器不支持 Range / 文件很小）、或者分段中途失败，都退回单连接：
 * 清单是后续所有逻辑的入口，这里宁可慢一点也不能失败。
 */
async function fetchEncryptedManifest(latest, profile, options = {}) {
  if (!options.skipDisk) {
    const cached = await readDiskManifest(profile, latest.version);
    if (cached) return cached;
  }
  const url = `${latest.base}/game_files`;
  const temp = path.join(
    os.tmpdir(),
    `hxl-manifest-${profile.directory}-${process.pid}-${Date.now().toString(36)}.bin`
  );
  const known = manifestSizeHint.get(profile.directory) || 0;
  if (!known || known >= MANIFEST_PARALLEL_MIN) {
    try {
      await multiDownload({
        url,
        dest: temp,
        fetchImpl: segmentFetch,
        headers: { 'user-agent': UA },
        connections: MANIFEST_CONNECTIONS,
        minSize: MANIFEST_PARALLEL_MIN,
        minSegmentSize: MANIFEST_MIN_SEGMENT,
        signal: AbortSignal.timeout(120000),
      });
      const glued = await fsp.readFile(temp);
      manifestSizeHint.set(profile.directory, glued.length);
      await writeDiskManifest(profile, latest.version, glued);
      return glued;
    } catch (error) {
      if (error?.code === 'ABORTED') throw error;
      // 其余一律退单连接：fallbackToSingle 表示「不值得分段」，其他是分段失败
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => {});
    }
  }
  const response = await httpFetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`${profile.iconName} 清单 HTTP ${response.status}`);
  const buffer = await netThrottle.toBuffer(response);
  manifestSizeHint.set(profile.directory, buffer.length);
  await writeDiskManifest(profile, latest.version, buffer);
  return buffer;
}

async function loadRemoteManifest(profile, allFiles = false) {
  const latest = await fetchLatest(profile);
  const memoKey = `${profile.directory}|${latest.version}|${allFiles ? 1 : 0}`;
  const memo = manifestMemo.get(memoKey);
  if (memo && Date.now() - memo.at < MANIFEST_MEMO_MS) return memo.value;
  const encrypted = await fetchEncryptedManifest(latest, profile);
  let raw = encrypted;
  let parsed;
  try {
    parsed = parseManifest(decryptManifest(encrypted));
  } catch (error) {
    // 缓存被截断（上次写盘时断电）会在这里解密失败：删掉重下一次，不把坏缓存当正式结果
    await fsp.rm(manifestDiskPath(profile, latest.version), { force: true }).catch(() => {});
    raw = await fetchEncryptedManifest(latest, profile, { skipDisk: true });
    parsed = parseManifest(decryptManifest(raw));
    if (!parsed.length) throw error;
  }
  let files = allFiles ? parsed : parsed.filter((file) => isAllowed(profile, file.path));
  /*
   * 回退大包（2026-11-08）：所有渠道改回「只收 rootFiles + dirs 白名单」的小包
   * （v2.3.0 / Xel 式）。此前给 Gryphline / B服 加的 deltaOf 差异包（126 文件/936MB）
   * 覆盖官服本体后与根目录自带的 verify_files.json 冲突，客户端报「游戏文件损坏或
   * 缺失，要求重装游戏」；小包只造成少量不符、游戏照常进。故 PROFILES 里已全部移除
   * deltaOf，下面这段差异合并分支当前不会触发（无任何 profile 再设 deltaOf），
   * 逻辑原样保留、仅留作兜底，不再作为任何渠道的默认路径。
   * 老用户磁盘上的大包由 packRev=3 的迁移门禁（见 channelPackFilesReady）判未就绪后
   * 自动重下成小包。
   */
  if (!allFiles && profile.deltaOf) {
    const baseline = await rawManifest(profile.deltaOf);
    const baseMd5 = new Map(baseline.map((file) => [file.path.toLowerCase(), file.md5]));
    const merged = new Map(files.map((file) => [file.path.toLowerCase(), file]));
    for (const file of parsed) {
      const known = baseMd5.get(file.path.toLowerCase());
      if (!known || known !== file.md5) merged.set(file.path.toLowerCase(), file);
    }
    files = Array.from(merged.values());
  }
  if (!files.length) throw new Error(`${profile.iconName} 清单里没有渠道文件`);
  const value = {
    version: latest.version,
    base: latest.base,
    manifestSha256: crypto.createHash('sha256').update(raw).digest('hex').toUpperCase(),
    files,
  };
  return rememberManifest(memoKey, value);
}

/** 写清单缓存（按写入先后淘汰，够用就行）。 */
function rememberManifest(key, value) {
  manifestMemo.delete(key);
  manifestMemo.set(key, { at: Date.now(), value });
  while (manifestMemo.size > MANIFEST_MEMO_MAX) {
    manifestMemo.delete(manifestMemo.keys().next().value);
  }
  return value;
}

/**
 * 只取清单本身（不做渠道过滤），给「按差异打包」当基线用。
 *
 * 国服清单一次几万行，国际服 / Play / Steam 都要用它：统一由 loadRemoteManifest
 * 的内存缓存兜着（同版本 5 分钟内只拉一次）。一个渠道包下载动辄几分钟，
 * 重复拉只会把切服前的等待拉长。
 */
async function rawManifest(directory) {
  const profile = PROFILES.find((item) => item.directory === directory);
  if (!profile) throw new Error(`没有 ${directory} 这条渠道`);
  const remote = await loadRemoteManifest(profile, true);
  return remote.files;
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const buffer = await netThrottle.toBuffer(response);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, buffer);
  return buffer;
}

/**
 * 流式下载到文件，支持断点续传 + 卡顿检测 + 失败由上层重试。
 *
 * 旧版只做了「边下边写 + 出错删半截文件」，没有续传也没有卡顿检测：
 * 跨海 CDN（beyond.hg-cdn.com，gryphline 节点）大文件（Qt5WebEngineCore 108MB、
 * 资源 .chk 动辄上 GB）一旦连接中断，要么整文件从 0 重下（永远卡在某个文件），
 * 要么连接挂起不报错一直等到 30 分钟超时（界面就是「卡在 51% 不动」）。
 *
 * 这里改成：
 *   · 本地已有半截文件就带 Range 续传；服务器不支持 Range（返回 200 而非 206）
 *     时自动从头重写，绝不会把半截和全量乱拼；
 *   · 超过 DOWNLOAD_STALL_MS 没收到任何字节就判定卡顿、主动断开让上层重试，
 *     不再傻等 30 分钟；
 *   · 单次尝试超时设短（10 分钟），续传场景下每轮只接着下剩下的字节，不从头来。
 *
 * 上层（updateProfile）负责在失败时用更小的退避重试若干次。取消信号优先于超时。
 *
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] 取消信号（用户在弹窗里点「取消」）
 * @param {(bytes:number)=>void} [options.onChunk] 每收到一块就报一次增量字节（用于进度条）
 */
const DOWNLOAD_STALL_MS = 60 * 1000;

async function downloadToFile(url, destination, options = {}) {
  const { Readable, Transform } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  await fsp.mkdir(path.dirname(destination), { recursive: true });

  // 续传起点：本地已下到的字节数（半截文件接着下，而不是从头再来）
  let start = 0;
  try {
    const stat = await fsp.stat(destination);
    if (stat.size > 0) start = stat.size;
  } catch {
    start = 0;
  }

  const headers = { 'user-agent': UA };
  if (start > 0) headers.range = `bytes=${start}-`;

  /*
   * 走 segmentFetch 而不是裸 fetch：小文件现在会 6 个一起下，而 Chromium 对
   * 同一个 host 只有 6 条 socket，全挤在里面等于没有余量；node 侧每条都是
   * 独立连接，6 个并发就是实打实的 6 条。
   */
  const response = await segmentFetch(url, {
    headers,
    // 取消信号优先；单次尝试超时 10 分钟，卡顿检测会在更早（60s）就接管
    signal: options.signal || AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`下载失败 HTTP ${response.status}`);
  }
  const resumed = response.status === 206;
  // 服务器不支持续传（返回 200）时，从头写、丢弃本地半截，避免乱 append
  const writeFlag = resumed && start > 0 ? 'a' : 'w';
  if (!resumed && start > 0) start = 0;

  const file = fs.createWriteStream(destination, { flags: writeFlag });
  const source = Readable.fromWeb(response.body);

  let lastDataAt = Date.now();
  if (typeof options.onChunk === 'function') {
    source.on('data', (chunk) => {
      lastDataAt = Date.now();
      options.onChunk(chunk.length);
    });
  } else {
    source.on('data', () => {
      lastDataAt = Date.now();
    });
  }

  /*
   * 限速：这条链路走 pipeline + 'data' 事件，回调里没法 await，所以用
   * Transform 做背压——把等待放在 _transform 里，下游自然慢下来，pipeline
   * 的流控语义完全不变（不会丢数据、也不会把内存撑爆）。
   *
   * 不限速（默认）时直接把 source 接到 file，与改动前逐行等价。
   */
  const throttleStream = netThrottle.getLimit() > 0
    ? new Transform({
      transform(chunk, _encoding, callback) {
        netThrottle.consume(chunk.length).then(
          () => callback(null, chunk),
          () => callback(null, chunk)
        );
      },
    })
    : null;

  // 卡顿检测：每 5 秒看一眼，超过 DOWNLOAD_STALL_MS 没收任何字节就主动断开，
  // 让上层以退避重试（续传会从半截文件继续，不会从头重下）。
  const stallTimer = setInterval(() => {
    if (Date.now() - lastDataAt > DOWNLOAD_STALL_MS) {
      try {
        source.destroy(new Error('下载卡顿（长时间无数据）'));
      } catch {
        /* 已结束 */
      }
    }
  }, 5000);

  try {
    if (throttleStream) await pipeline(source, throttleStream, file);
    else await pipeline(source, file);
  } catch (error) {
    clearInterval(stallTimer);
    // 半截文件留着：续传时接着下，校验阶段会发现坏文件
    throw error;
  }
  clearInterval(stallTimer);
  return destination;
}

/** 取消下载用的统一错误：上层据此区分「用户取消」和「真失败」。 */
function abortedError() {
  const error = new Error('下载已取消');
  error.code = 'ABORTED';
  return error;
}

/** 下载速度（字节/秒）：界面要显示「3.2 MB/s」，不能只给个百分比。 */
function bytesPerSecond(bytes, startedAt) {
  const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
  return Math.round(bytes / seconds);
}

/**
 * 按体量给每个文件配一份分段计划：越大的文件开越多段，1 MB 以上才分段。
 *
 * 渠道包的 CDN（beyond.hg-cdn.com / gryphline 节点）是按「连接」限速的，
 * 跨海节点单连接常年只有 1~2 MB/s。差异包里绝大多数是几百 KB 的小文件，
 * 只开一个连接就意味着每个文件都要先等一次握手 + 302 才见到第一个字节，
 * 这段等待里带宽完全是空转的——串行下一堆小文件，总速度掉到几百 KB/s
 * 就是这么来的。所以这里不再沿用「小于 8 MB 就单连接」的旧判断，
 * 改成按大小分档多开几段；只有小到 256 KB 以下的才不值得（多一次往返
 * 反而更慢），仍旧走单连接。
 */
function packSegmentPlan(size) {
  const MB = 1024 * 1024;
  if (size >= 16 * MB) return { connections: 16, minSegmentSize: 1 * MB };
  if (size >= MIN_PARALLEL_SIZE) return { connections: 10, minSegmentSize: 1 * MB };
  if (size >= 2 * MB) return { connections: 6, minSegmentSize: 512 * 1024 };
  return { connections: 3, minSegmentSize: 384 * 1024 };
}

/** 小于这个大小就不分段：实测 1 MB 以下多开 2~4 段常常反而更慢（多一次探测往返）。 */
const PACK_MIN_SEGMENT_SIZE = 1 * 1024 * 1024;

/**
 * 下载一个渠道包文件：一律先试多连接分段，分段不可用才退单连接。
 *
 * 差异包体量不小（国际服整包 940 MB，里面 Endfield.exe / GameAssembly.dll 都是
 * 几十上百 MB 的单文件），而鹰角的 CDN 按连接限速——单连接跑这些大文件只有
 * 一两 MB/s，「硬链接生成一份」时用户就得干等十几分钟。分段并发之后同样一份包
 * 能快好几倍，实现直接复用更新包那套（electron/multi-download.js）。
 *
 * 分段不可用（服务器不认 Range、探测不到总长、中途出错）就退回单连接：
 * 单连接本来就有断点续传，慢但一定能下完。退之前必须先删半截文件——分段是
 * 「按总长预分配 + 各段写各自偏移」，中断后的文件里是洞，拿它当续传起点会把
 * 洞当成已下好的数据（大小够了，内容却是垃圾，最后卡在 md5 校验上）。
 *
 * @param {object} [options]
 * @param {number} [options.size] 清单里的文件大小，用于决定开几段
 * @param {AbortSignal} [options.signal]
 * @param {(bytes:number)=>void} [options.onChunk]
 */
async function downloadPackFile(url, destination, options = {}) {
  const { size = 0, signal, onChunk } = options;
  if (size >= PACK_MIN_SEGMENT_SIZE) {
    const plan = packSegmentPlan(size);
    let sent = 0;
    try {
      await multiDownload({
        url,
        dest: destination,
        expectedSize: size,
        headers: { 'user-agent': UA },
        connections: plan.connections,
        minSegmentSize: plan.minSegmentSize,
        // 小文件也要能进来：默认门槛是 8 MB，不显式放低会被直接打回单连接
        minSize: PACK_MIN_SEGMENT_SIZE,
        signal,
        report: (percent, received) => {
          if (typeof onChunk !== 'function') return;
          const delta = received - sent;
          sent = received;
          if (delta > 0) onChunk(delta);
        },
      });
      return destination;
    } catch (error) {
      if (signal?.aborted) throw abortedError();
      await fsp.rm(destination, { force: true }).catch(() => {});
    }
  }
  return downloadToFile(url, destination, options);
}

/**
 * 分卷 ZIP 整包下载（「全新安装 / 文件全坏」时兜底）。
 *
 * 常规增量更新走加密逐文件清单（loadRemoteManifest），比整包省得多：
 * 明日方舟整包 43.7GB / 20 卷，逐文件清单只有 25.4GB 且能按 md5 跳过已有文件。
 * 注意清单地址是 `file_path + '/game_files'`，单独请求 `file_path` 会 404。
 *
 * 解压需要 7-Zip；优先用鹰角启动器自带的 7zg.exe。
 */
/*
 * 找 7-Zip。
 *
 * 注意：鹰角启动器**不一定装在 C 盘**。原来这里默认参数写死
 * `C:\Program Files\Hypergryph Launcher`，用户把官方启动器装在别的盘（本机就是
 * `H:\Hypergryph Launcher`）时四个候选全部落空 → 预下载 apply 必然抛
 * 「没找到 7-Zip」→ 一路回落到逐文件全量更新，预下载下来的包白存。
 *
 * 所以这里改成：先用环境变量把常见安装根铺开，再对每个根做两层扫（固定文件名 +
 * 版本子目录里找 7zg.exe），最后才看常见 7-Zip 安装位置。
 */
function sevenZipRoots(launcherRoot) {
  const roots = [];
  if (launcherRoot) roots.push(launcherRoot);
  for (const base of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
    process.env.LOCALAPPDATA,
  ]) {
    if (!base) continue;
    roots.push(path.join(base, 'Hypergryph Launcher'));
    roots.push(path.join(base, 'Hypergryph'));
  }
  // 非系统盘：官方启动器允许装到任意盘，逐盘扫一层（D–Z，跳过 A/B 软驱与 C 已覆盖）
  for (let code = 68; code <= 90; code += 1) {
    const drive = String.fromCharCode(code);
    roots.push(`${drive}:\\Hypergryph Launcher`);
    roots.push(`${drive}:\\Hypergryph`);
  }
  return roots;
}

function findSevenZip(launcherRoot = '') {
  const direct = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const candidate of direct) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 无权限就当没有 */
    }
  }
  const seen = new Set();
  for (const root of sevenZipRoots(launcherRoot)) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    try {
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    // ① 根目录直接有
    for (const name of ['7zg.exe', '7z.exe']) {
      const direct7z = path.join(root, name);
      try {
        if (fs.statSync(direct7z).isFile()) return direct7z;
      } catch {
        /* 继续 */
      }
    }
    // ② 版本子目录（1.6.0 / 1.5.2 …）里找
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const name of ['7zg.exe', '7z.exe']) {
        const found = path.join(root, entry.name, name);
        try {
          if (fs.statSync(found).isFile()) return found;
        } catch {
          /* 继续 */
        }
      }
    }
  }
  return '';
}

async function downloadAndExtractSplit({ profile, root, stagingRoot, onProgress }) {
  const latest = await fetchLatest(profile);
  if (!latest.packs.length) throw new Error(`${profile.iconName} 接口没有返回分卷列表`);
  const zip = findSevenZip();
  if (!zip) throw new Error('没找到 7-Zip，无法解压分卷包（装一个 7-Zip 或装官方鹰角启动器）');

  const staging = stagingRoot || path.join(path.dirname(root), '_packs', latest.version);
  await fsp.mkdir(staging, { recursive: true });

  const total = latest.packs.length;
  const report = (index, phase, fraction = 0) => {
    if (typeof onProgress === 'function') {
      onProgress({
        game: profile.iconName,
        version: latest.version,
        phase,
        index,
        total,
        // 卷内进度：下载一卷几百 MB 时进度条得一点点走，不能一卷一跳
        fraction: Math.max(0, Math.min(0.999, fraction)),
        percent: Math.round(((index + Math.max(0, Math.min(0.999, fraction))) / total) * 100),
      });
    }
  };

  // ① 逐卷下载 + md5 校验
  for (let index = 0; index < latest.packs.length; index += 1) {
    const pack = latest.packs[index];
    const name = path.basename(new URL(pack.url).pathname);
    const target = path.join(staging, name);
    report(index, 'download');
    let reused = false;
    try {
      const stat = await fsp.stat(target);
      if (stat.size === pack.size && pack.md5) {
        reused = (await md5File(target)) === pack.md5;
      }
    } catch {
      reused = false;
    }
    if (reused) continue;
    // 分卷动辄几百 MB，按体量走 12~16 段；小分卷也会自动开 4~8 段
    let doneInPack = 0;
    await downloadPackFile(pack.url, target, {
      size: pack.size,
      onChunk: (bytes) => {
        doneInPack += bytes;
        report(index, 'download', doneInPack / Math.max(1, pack.size));
      },
    });
    if (pack.md5) {
      const actual = await md5File(target);
      if (actual !== pack.md5) throw new Error(`${name} 校验失败（md5 不符）`);
    }
    report(index + 1, 'download', 0);
  }
  report(total, 'download');

  // ② 7z 解压第一分卷，它会自动连读 .002 / .003 …
  report(total, 'extract');
  await fsp.mkdir(root, { recursive: true });
  const first = path.basename(new URL(latest.packs[0].url).pathname);
  const { execFile } = require('node:child_process');
  await new Promise((resolve, reject) => {
    execFile(
      zip,
      ['x', path.join(staging, first), `-o${root}`, '-y'],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`解压失败：${(stderr || stdout || error.message).slice(0, 400)}`));
        else resolve();
      }
    );
  });
  report(total, 'done');

  return {
    iconName: profile.iconName,
    version: latest.version,
    clientVersion: latest.clientVersion,
    totalBytes: latest.totalSize,
    packs: total,
    root,
    staging,
    entry: profile.entry || '',
  };
}

function profileForChannel(channel) {
  if (channel === 'arknights') return PROFILES.find((item) => item.directory === 'Arknights');
  if (channel === 'bilibili') return PROFILES.find((item) => item.directory === 'EndBilibili');
  if (channel === 'global') return PROFILES.find((item) => item.directory === 'EndGlobal');
  if (channel === 'play') return PROFILES.find((item) => item.directory === 'EndPlay');
  if (channel === 'steam') return PROFILES.find((item) => item.directory === 'EndSteam');
  return PROFILES.find((item) => item.directory === 'EndOfficial');
}

async function checkEndfieldGame({ root, channel }) {
  const profile = profileForChannel(channel);
  if (!profile) throw new Error('没有对应的终末地渠道');
  const remote = await loadRemoteManifest(profile, true);
  return {
    version: remote.version,
    base: remote.base,
    fileCount: remote.files.length,
    totalBytes: remote.files.reduce((sum, file) => sum + file.size, 0),
    manifestSha256: remote.manifestSha256,
    root,
  };
}

async function updateEndfieldGame({ root, channel, onProgress, force, linkSources = [] } = {}) {
  const profile = profileForChannel(channel);
  if (!profile) throw new Error('没有对应的终末地渠道');
  const remote = await loadRemoteManifest(profile, true);
  const statePath = path.join(root, '.vela-game-state.json');
  let state = null;
  try {
    state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  } catch {
    state = null;
  }
  if (
    !force &&
    state &&
    state.version === remote.version &&
    state.manifestSha256 === remote.manifestSha256
  ) {
    return { ok: true, version: remote.version, updated: 0, skipped: true, root };
  }
  let updated = 0;
  let downloadedBytes = 0;
  let linkedFiles = 0;
  /*
   * 总量算一次就够。以前写在循环里的每次进度回调上，1688 个文件就是 1688 次
   * 全表求和（约 285 万次加法），纯属白烧 CPU —— 进度条卡顿有一部分就是它。
   */
  const totalBytes = remote.files.reduce((sum, item) => sum + (item.size || 0), 0);
  /*
   * 同机另一份终末地（官服 / B服 / 国际服三份很常见）已经在目标版本时，
   * 内容相同的文件直接硬链接过来，不必再为同一份字节走一遍网络。
   * 判定口径与「本地是否已就位」一致：size + 整份 md5。
   */
  const usableSources = linkSource.usableSources(linkSources, { targetRoot: root });
  /*
   * 空间守卫：每个要下的文件都先写 `.vela-download` 临时文件再 rename，临时文件在时
   * 新旧两份同时存在，所以要按文件大小预留。空间不够就在这个文件开始前停下，
   * 而不是写到一半让系统抛 ENOSPC。
   */
  const spaceGuard = diskSpace.createSpaceGuard({
    dirs: [root],
    label: '游戏所在盘',
    reserveBytes: 256 * 1024 ** 2,
  });
  for (let index = 0; index < remote.files.length; index += 1) {
    const file = remote.files[index];
    const target = path.resolve(root, file.path);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('游戏清单路径非法');
    let current = false;
    try {
      const stat = await fsp.stat(target);
      if (stat.size === file.size) current = (await md5File(target)) === file.md5;
    } catch {
      current = false;
    }
    if (current) {
      onProgress?.({
        current: file.path,
        processed: index + 1,
        total: remote.files.length,
        downloadedBytes,
        totalBytes,
      });
      continue;
    }
    if (usableSources.length) {
      const reused = await linkSource.reuseFromSources({
        /*
         * 注意字段名：终末地清单项是 { path, urlPath, size, md5 }，而复用函数统一读
         * item.file。直接把 file 传进去会拿不到相对路径 → 永远命中不了（表现为
         * 「明明有源还是全量下载」）。这里显式把 path 映射成 file。
         */
        file: { ...file, file: file.path },
        target,
        gameKey: 'endfield',
        sources: usableSources,
        match: async (candidate) => {
          const stat = await fsp.stat(candidate);
          if (stat.size !== file.size) return false;
          return (await md5File(candidate)) === file.md5;
        },
      });
      if (reused.ok) {
        linkedFiles += 1;
        onProgress?.({
          current: file.path,
          processed: index + 1,
          total: remote.files.length,
          downloadedBytes,
          totalBytes,
        });
        continue;
      }
    }
    const temporary = `${target}.vela-download`;
    // 真要从网络下来的文件才需要额外空间：临时文件 + 原文件会同时存在
    await spaceGuard.check(file.size || 0);
    // 大文件同样走多连接；小文件由 downloadPackFile 自己判断走单连接
    await downloadPackFile(`${remote.base}/${file.urlPath}`, temporary, { size: file.size || 0 });
    const actual = await md5File(temporary);
    if (actual !== file.md5) {
      await fsp.rm(temporary, { force: true });
      throw new Error(`文件校验失败：${file.path}`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rm(target, { force: true });
    await fsp.rename(temporary, target);
    updated += 1;
    downloadedBytes += file.size;
    onProgress?.({
      current: file.path,
      processed: index + 1,
      total: remote.files.length,
      downloadedBytes,
      totalBytes,
    });
  }
  await fsp.writeFile(
    statePath,
    JSON.stringify(
      {
        version: remote.version,
        manifestSha256: remote.manifestSha256,
        updatedAt: new Date().toISOString(),
        fileCount: remote.files.length,
      },
      null,
      2
    ),
    'utf8'
  );
  return { ok: true, version: remote.version, updated, linked: linkedFiles, skipped: false, root };
}

/**
 * 按渠道包目录名反查配置。
 *
 * 明日方舟的两条（ArkOfficial / ArkBilibili）有意不在 PROFILES 里 —— 它们是
 * 渠道载荷，不是「可安装的游戏」。但按需下载要以目录名为入口，所以单独补进来。
 */
function profileByDirectory(directory) {
  const name = String(directory || '');
  if (name === ARKNIGHTS_OFFICIAL_PROFILE.directory) return ARKNIGHTS_OFFICIAL_PROFILE;
  if (name === ARKNIGHTS_BILIBILI_PROFILE.directory) return ARKNIGHTS_BILIBILI_PROFILE;
  return PROFILES.find((profile) => profile.directory === name) || null;
}

/**
 * 渠道包体积缓存：同一个渠道 10 分钟内只问一次官方清单。
 *
 * 切服前要弹「需要下载 194 MB」，这个数字必须是真的 —— 但每次点切换都
 * 拉一次清单（两万行密文）会让弹窗前先卡两秒。缓存够用：清单一天变不了几次。
 */
const measureCache = new Map();

/**
 * 预问「这个渠道包有多大」。
 *
 * @returns {Promise<{directory:string, iconName:string, version:string, fileCount:number, totalBytes:number}>}
 */
async function measureChannelPack(profile) {
  const key = profile.directory;
  const hit = measureCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const remote = await loadRemoteManifest(profile);
  const value = {
    directory: profile.directory,
    iconName: profile.iconName,
    version: remote.version,
    fileCount: remote.files.length,
    totalBytes: remote.files.reduce((sum, file) => sum + (file.size || 0), 0),
  };
  measureCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * 实测一个目录里的文件数与总字节数（递归、不跟随符号链接）。
 * 用来核对渠道包状态文件里记的 FileCount / TotalBytes 是否真落到了磁盘上。
 */
function countPackFiles(dir) {
  let count = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        count += 1;
        bytes += fs.statSync(full).size;
      }
    }
  }
  return { count, bytes };
}

/**
 * 这个渠道包「是不是按当前这套小包规约完整下过一遍」。
 *
 * 回退大包（2026-11-08）：老用户磁盘上可能还躺着 126 文件 / 936 MB 的差异大包
 * （或随安装包分发的旧包）。只看「目录在不在 / U8Data 在不在」会把它们当成已就绪，
 * 于是切服时铺出与 verify_files.json 冲突的运行时、客户端报「文件损坏或缺失」。
 * 判据落在 `.state/<目录>.json`：只有 updateProfile 完整跑完（每个文件过 md5、
 * staging 整体改名、写状态）才会生成它，且必须带当前 packRev。
 * PackRev 对不上（老状态 0 / 2，新规约 3）就判未就绪 → 触发重下小包；
 * updateProfile 按 md5 复用已有文件，所以「其实文件已齐只是状态旧」不会白下大流量。
 */
function packDownloadedState(root, directory, profile = null) {
  try {
    const raw = fs.readFileSync(path.join(root, '.state', `${directory}.json`), 'utf8');
    const state = JSON.parse(raw);
    if (!state || !state.ManifestSha256) return false;
    /*
     * 回退大包（2026-11-08）：包规约版本（PackRev）对不上就当没下过。
     * 四个非官服渠道统一 packRev=3；老用户 .state 里是差异大包时代的 0 或 2，
     * ManifestSha256 非空也不能算「齐了」，必须重下小包替换掉磁盘上的大包。
     * 旧状态文件没有 PackRev 字段，按 0 处理。
     */
    const wantRev = Number((profile && profile.packRev) || 0);
    const haveRev = Number(state.PackRev || 0);
    if (haveRev !== wantRev) return false;
    /*
     * 残包自愈（2026-11-09）：.state 里的 FileCount / TotalBytes 是清单的理论值，
     * 不代表磁盘真的有这么多文件。曾出现过下载中断/被 abort 后只剩 5 个文件
     * （缺的正好含根目录 HGP.dll 国际服版），但状态文件已按 24 个写好，于是
     * PackRev 一过就被永久当成「已就绪」借用 → overlay 少铺 19 个 → 运行时
     * HGP.dll 保持官服硬链接版 → 客户端自检弹「游戏文件缺失或损坏 → HGP.dll」。
     * 所以这里再核一次磁盘实际文件数/字节数；对不上就判未就绪，切服时整包重下。
     * 旧状态文件没有这两个字段时保持原行为，兼容老用户，不误伤 B服/官服/方舟。
     */
    if (Number.isFinite(Number(state.FileCount)) && Number.isFinite(Number(state.TotalBytes))
      && (Number(state.FileCount) > 0 || Number(state.TotalBytes) > 0)) {
      const packDir = path.join(root, directory);
      if (!fs.existsSync(packDir)) return false;
      let onDisk;
      try {
        onDisk = countPackFiles(packDir);
      } catch {
        return false;
      }
      if (onDisk.count !== Number(state.FileCount) || onDisk.bytes !== Number(state.TotalBytes)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 某个渠道包目录算不算齐了。
 *
 * 回退大包（2026-11-08）：四个非官服渠道（B服 / 国际服 / Play / Steam）设了
 * packRev=3，一律走状态文件 + PackRev 双条件判定，好让老用户磁盘上的差异大包
 * （状态里 PackRev=0/2）对不上新规约、切服前被判未就绪 → 自动重下小包。
 * EndOfficial / Arknights 清单没变、没有 packRev，仍用轻量的 U8Data 判定，
 * 免得升级后让所有人无谓重下。
 */
function channelPackFilesReady(profile, dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (profile && profile.packRev) {
    return packDownloadedState(path.dirname(dir), path.basename(dir), profile);
  }
  return fs.existsSync(path.join(dir, 'U8Data'));
}

/**
 * 把某个渠道的渠道件下到 root/<directory> 里。
 *
 * 第三版改动（渠道包不再随安装包分发之后）：
 *   · 进度从「第几个文件」升级成「字节」—— 界面上要的是 194 MB 的进度条，
 *     而不是 80 个文件里走到第 7 个；文件之间大小差 100 倍，按个数走会卡住不动。
 *   · 大文件流式落盘，不再整文件读进内存（B站 SDK 的 libcef.dll 112 MB）。
 *   · 支持取消：每处理一个文件前检查一次信号，已下好的文件按 md5 复用，
 *     所以取消后再点一次是从断点继续，不是从头再来。
 *
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {(progress:object)=>void} [options.onProgress] 覆盖第三参，二者等价
 */
async function updateProfile(profile, root, onProgress, options = {}) {
  if (typeof onProgress === 'object' && onProgress !== null) {
    options = onProgress;
    onProgress = options.onProgress;
  }
  if (profile.iconName === 'SteamEndfield') {
    return { iconName: profile.iconName, skipped: true, reason: 'Steam 渠道暂不自动更新' };
  }
  const remote = await loadRemoteManifest(profile);
  const target = path.join(root, profile.directory);
  const stateFile = path.join(root, '.state', `${profile.directory}.json`);
  let oldState = null;
  try {
    oldState = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  } catch {
    oldState = null;
  }
  const current =
    oldState &&
    oldState.Version === remote.version &&
    oldState.ManifestSha256 === remote.manifestSha256 &&
    // 回退大包（2026-11-08）：PackRev 变了（差异大包时代的 0/2 → 小包规约 3）
    // 就必须重下：光看清单 md5 会把磁盘上的大包当成「已是最新」而永远跳过。
    Number(oldState.PackRev || 0) === Number(profile.packRev || 0) &&
    remote.files.every((file) => fs.existsSync(path.join(target, file.path)));
  if (current) {
    return { iconName: profile.iconName, version: remote.version, updated: 0, skipped: true };
  }

  const staging = path.join(root, `.staging-${profile.directory}`);
  /*
   * 同一版本的重试不清 staging：用户点取消后已经下完的文件要留着，
   * 再点一次才能从断点继续（每个文件下完都过了 md5 校验才留下）。
   * 换版本了才整体清掉 —— 旧版本的文件名未必还在新清单里，留着会混进游戏目录。
   */
  const sameVersionAsLastTime = Boolean(oldState && oldState.Version === remote.version);
  if (!sameVersionAsLastTime) await fsp.rm(staging, { recursive: true, force: true });
  const totalBytes = remote.files.reduce((sum, file) => sum + (file.size || 0), 0);
  let downloaded = 0;
  let processedBytes = 0;
  let downloadedBytes = 0;
  const startedAt = Date.now();
  const signal = options.signal;

  /*
   * 速度用最近 3 秒的滑动窗口，而不是「总字节 / 总耗时」。
   * 后者把 md5 校验、文件切换、重试等待全算进分母，界面上就会一直显示
   * 一个远低于实际带宽的数字——看起来像「下载速度不对」。
   */
  const speedSamples = [];
  const sampleSpeed = () => {
    const now = Date.now();
    speedSamples.push({ t: now, bytes: downloadedBytes });
    while (speedSamples.length > 2 && now - speedSamples[0].t > 3000) speedSamples.shift();
    const first = speedSamples[0];
    const dt = (now - first.t) / 1000;
    if (dt <= 0.2) return 0;
    return Math.max(0, (downloadedBytes - first.bytes) / dt);
  };

  const report = (index, current) => {
    /*
     * 进度要三样东西，界面那套模板（「硬链接 X · 下载 Y · A / B」+ 阶段条）
     * 分别读 percent / bytesDone / totalBytes，少给一个就会显示成 0：
     *   · percent 按字节算；清单里若有大小为 0 的项，退回按文件个数算
     *   · bytesDone 是已处理的字节（老字段名叫 bytes，两个都给，老调用方不受影响）
     */
    const percent =
      totalBytes > 0
        ? Math.min(100, (processedBytes / totalBytes) * 100)
        : remote.files.length
          ? Math.min(100, (index / remote.files.length) * 100)
          : 0;
    onProgress?.({
      profile: profile.iconName,
      directory: profile.directory,
      current,
      // 两个口径都给：processed 是文件个数（老调用方在用），bytes 是进度条用的字节
      processed: index,
      total: remote.files.length,
      bytes: processedBytes,
      bytesDone: processedBytes,
      // 界面那条「硬链接 X · 下载 Y」里的 Y：已经下完并通过 md5 的文件数
      downloaded,
      totalBytes,
      downloadedBytes,
      percent,
      speed: sampleSpeed() || bytesPerSecond(downloadedBytes, startedAt),
    });
  };
  // 先把总量推上去：不然界面要等第一个文件下完才从「0 KB / 0 KB」变成真实体积
  report(0, '');
  /*
   * 文件级并发：差异包里绝大多数是十几 KB ~ 几百 KB 的小文件，逐个串行下载时
   * 每个文件都要先握手、302 跳转、读响应头，这段时间带宽完全空转，小文件一多
   * 总速度就掉到几百 KB/s。
   *
   * 1 MB 以上的文件自己还会开 3~16 段（见 packSegmentPlan），连接预算按
   * 「8 个文件 × 最多 6 段 = 48 条」算；http-fetch 的 keep-alive agent 上限
   * 是 64，留足了余量。小文件本身不分段，靠这 8 路并发 + 连接复用提速。大文件（Endfield.exe / GameAssembly.dll 这类几十上百
   * MB 的）反过来要串行：它内部已经开了 12~16 段，再叠文件级并发只会互相抢
   * 带宽，反而更慢。
   */
  const SMALL_FILE_PARALLEL = 8;
  const BIG_FILE_THRESHOLD = MIN_PARALLEL_SIZE;
  let finished = 0;

  const processFile = async (file) => {
    if (signal?.aborted) throw abortedError();
    const temporary = path.join(staging, file.path);

    /*
     * 目标目录里已有且 md5 一致：直接复用，省一次下载（切服时复用基础客户端里的
     * 同版本文件）。注意：只信 md5，不信「文件在不在」，否则半截/旧版本会被当成
     * 已完成混进包里。
     */
    let reused = false;
    try {
      if ((await md5File(path.join(target, file.path))) === file.md5) {
        await fsp.mkdir(path.dirname(temporary), { recursive: true });
        await fsp.copyFile(path.join(target, file.path), temporary);
        reused = true;
      }
    } catch {
      reused = false;
    }

    if (!reused) {
      /*
       * 失败重试：跨海 CDN 大文件极易中途断流 / 503，单次失败不该让整包重来。
       * 临时文件若已存在（上次中断留下的半截），downloadToFile 会带 Range 续传，
       * 不会从头重下。上限 5 次，仍失败才如实报错（避免无限卡死）。
       */
      let lastError = null;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          /*
           * 1 MB 以上的文件都先走多连接分段（3~16 段，按体量分档）。
           * CDN 按连接限速，分段是唯一能让「硬链接生成一份」等 940 MB 差异包
           * 时快起来的办法。分段不可用（不支持 Range / 探测失败）时
           * downloadPackFile 内部会退回单连接，这里不用再判断。
           */
          await downloadPackFile(`${remote.base}/${file.urlPath}`, temporary, {
            size: file.size || 0,
            signal,
            onChunk: (chunkBytes) => {
              downloadedBytes += chunkBytes;
              report(finished, file.path);
            },
          });
          lastError = null;
          break;
        } catch (error) {
          if (signal?.aborted) throw abortedError();
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * attempt, 10000)));
        }
      }
      if (lastError) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        throw new Error(`${file.path} 多次下载失败：${lastError.message}`);
      }
      downloaded += 1;
      if ((await md5File(temporary)) !== file.md5) {
        await fsp.rm(temporary, { force: true });
        throw new Error(`${file.path} MD5 校验失败`);
      }
    }
    finished += 1;
    processedBytes += file.size || 0;
    if (processedBytes > totalBytes) processedBytes = totalBytes;
    report(finished, file.path);
  };

  const smallFiles = remote.files.filter((file) => (file.size || 0) < BIG_FILE_THRESHOLD);
  const bigFiles = remote.files.filter((file) => (file.size || 0) >= BIG_FILE_THRESHOLD);

  let cursor = 0;
  const smallWorker = async () => {
    while (cursor < smallFiles.length) {
      if (signal?.aborted) throw abortedError();
      const file = smallFiles[cursor];
      cursor += 1;
      await processFile(file);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SMALL_FILE_PARALLEL, smallFiles.length) }, () => smallWorker())
  );
  for (const file of bigFiles) {
    if (signal?.aborted) throw abortedError();
    await processFile(file);
  }

  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rename(staging, target);
  const state = {
    IconName: profile.iconName,
    Version: remote.version,
    ManifestSha256: remote.manifestSha256,
    UpdatedAtUtc: new Date().toISOString(),
    FileCount: remote.files.length,
    TotalBytes: remote.files.reduce((sum, file) => sum + file.size, 0),
    // 回退大包后所有 profile 都不再设 deltaOf，此字段恒 false，保留供排查用
    Delta: Boolean(profile.deltaOf),
    // 包规约版本（小包=3）：判定「已下好」时要比对，见 packDownloadedState 的注释
    PackRev: Number(profile.packRev || 0),
  };
  await fsp.mkdir(path.dirname(stateFile), { recursive: true });
  await fsp.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
  return { iconName: profile.iconName, version: remote.version, updated: downloaded, skipped: false };
}

/**
 * @param {object} options
 * @param {boolean} options.onlyExisting 只更新本机已经存在的渠道包。
 *   后台自动更新用它：五个渠道全下下来约 400MB，不该在用户没要求时偷偷下。
 *   缺的那个渠道留给「切到那个服时按需下载」。
 * @param {'endfield'|'arknights'} options.family 更新哪个游戏的渠道包。
 *   两个游戏各有各的自动更新开关，这里必须能只跑一边 —— 默认终末地。
 */
async function updateEndfieldPacks({ root, onProgress, onlyExisting = false, only = null, family = 'endfield' } = {}) {
  await fsp.mkdir(root, { recursive: true });
  const results = [];
  const pool =
    family === 'arknights'
      ? [ARKNIGHTS_OFFICIAL_PROFILE, ARKNIGHTS_BILIBILI_PROFILE]
      : PROFILES;
  const jobs = Array.isArray(only)
    ? pool.filter((profile) => only.includes(profile.directory))
    : pool;
  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
    const profile = jobs[jobIndex];
    if (onlyExisting && !fs.existsSync(path.join(root, profile.directory, 'U8Data'))) {
      results.push({ iconName: profile.iconName, skipped: true, reason: 'not-installed' });
      continue;
    }
    try {
      // 进度里带上「第几个渠道包 / 共几个」，界面才能显示 2/3 而不是一堆文件名
      results.push(
        await updateProfile(profile, root, (progress) =>
          onProgress?.({
            ...progress,
            jobIndex,
            jobCount: jobs.length,
            directory: profile.directory,
          })
        )
      );
    } catch (error) {
      results.push({
        iconName: profile.iconName,
        skipped: false,
        error: error.message,
      });
    }
  }
  return { ok: true, root, results };
}

module.exports = {
  updateEndfieldPacks,
  // 单个渠道按需下载：切到某个服、而本地还没有那个渠道包时用
  updateEndfieldProfile: updateProfile,
  // 切服前的「要下多少」：确认弹窗里的体积与文件数都来自这里
  measureChannelPack,
  // 渠道包目录算不算齐了：设了 packRev 的渠道看状态文件 + PackRev，其余看 U8Data
  channelPackFilesReady,
  profileByDirectory,
  verifyArknightsSource,
  verifyArknightsBilibiliSource: () => verifyArknightsSource(ARKNIGHTS_BILIBILI_PROFILE),
  ARKNIGHTS_BILIBILI_PROFILE,
  ARKNIGHTS_BILIBILI_READY,
  ARKNIGHTS_OFFICIAL_PROFILE,
  ARKNIGHTS_OFFICIAL_READY,
  updateEndfieldGame,
  checkEndfieldGame,
  fetchLatest,
  loadRemoteManifest,
  downloadAndExtractSplit,
  findSevenZip,
  decryptManifest,
  encryptManifest,
  profileForChannel,
  PROFILES,
};
