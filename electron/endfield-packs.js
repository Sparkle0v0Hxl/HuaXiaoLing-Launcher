'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { multiDownload, MIN_PARALLEL_SIZE, DEFAULT_CONNECTIONS } = require('./multi-download');
const { httpFetch } = require('./http-fetch');

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
    rootFiles: [...COMMON_CHANNEL_ROOT, 'eld_Endfield.db', 'hgsdk.dll', 'OneChannelLC.dll', 'HGP.dll'],
    dirs: COMMON_DIRS,
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
    rootFiles: [...COMMON_CHANNEL_ROOT, 'eld_Endfield.db', 'PCGameSDK.dll', 'OneChannelLC.dll', 'HGP.dll'],
    dirs: ['BLPlatform64/', 'U8Data/config/'],
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
    rootFiles: [...COMMON_CHANNEL_ROOT, 'gfsdk.dll', 'glfoundation.dll', 'OneChannelLC.dll', 'HGP.dll'],
    dirs: COMMON_DIRS,
    // Gryphline 版连本体二进制都不同（126 个文件 / 936 MB），见 loadRemoteManifest 注释
    deltaOf: 'EndOfficial',
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
    ],
    dirs: COMMON_DIRS,
    deltaOf: 'EndOfficial',
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
    ],
    dirs: COMMON_DIRS,
    deltaOf: 'EndOfficial',
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
        fetchImpl: httpFetch,
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
  const buffer = Buffer.from(await response.arrayBuffer());
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
   * Gryphline 三个渠道（国际服 / Play / Steam）不能只盖 SDK。
   *
   * 实测 1.6.4 的官方清单：国际服与国服官服有 126 个文件不同、合计 936 MB ——
   * Endfield.exe（895 KB vs 827 KB）、GameAssembly.dll（320 MB）、UnityPlayer.dll、
   * CefView/libcef.dll、Qt5WebEngineCore.dll、AntiCheatExpert、sdk_data.dat…… 全是
   * 各自发行的另一份二进制。只换 SDK 拼出来的运行时是「国服的壳 + 国际服的 SDK」，
   * 启动 3 秒就以 0xc0000005 崩掉（崩在 Endfield.exe 里偏移 0x6eeb68）。
   *
   * 所以这三条改成「与国服清单不同的全部文件」：官方清单里 md5 和国服一样的不下
   * （运行时本来就硬链接过来了），不一样的、国服清单里没有的全部进包。
   * 同时保留原来的渠道件白名单：万一用户的基础客户端是 B服，SDK 那几样也得换。
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
  const buffer = Buffer.from(await response.arrayBuffer());
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
  const { Readable } = require('node:stream');
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

  const response = await fetch(url, {
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
    await pipeline(source, file);
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

/** 渠道包的连接数。和更新包保持一致，对端按连接限速时才能吃满带宽。 */
const PACK_CONNECTIONS = DEFAULT_CONNECTIONS;

/**
 * 下载一个渠道包文件：够大就走多连接分段，其余照旧单连接。
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
 * @param {number} [options.size] 清单里的文件大小，用于判断值不值得分段
 * @param {AbortSignal} [options.signal]
 * @param {(bytes:number)=>void} [options.onChunk]
 */
async function downloadPackFile(url, destination, options = {}) {
  const { size = 0, signal, onChunk } = options;
  if (size >= MIN_PARALLEL_SIZE) {
    let sent = 0;
    try {
      await multiDownload({
        url,
        dest: destination,
        expectedSize: size,
        headers: { 'user-agent': UA },
        connections: PACK_CONNECTIONS,
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
function findSevenZip(launcherRoot = 'C:\\Program Files\\Hypergryph Launcher') {
  const candidates = [
    path.join(launcherRoot, '1.6.0', '7zg.exe'),
    path.join(launcherRoot, '7zg.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 无权限就当没有 */
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
    // 大卷走 16 连接分段，小卷仍是单连接（分段对小文件没意义，反而多几次探测）
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

async function updateEndfieldGame({ root, channel, onProgress, force } = {}) {
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
        totalBytes: remote.files.reduce((sum, item) => sum + item.size, 0),
      });
      continue;
    }
    const temporary = `${target}.vela-download`;
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
      totalBytes: remote.files.reduce((sum, item) => sum + item.size, 0),
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
  return { ok: true, version: remote.version, updated, skipped: false, root };
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
 * 这个渠道包「是不是按当前这套差异完整下过一遍」。
 *
 * 为什么不能只看目录在不在：2.6.0 之前随安装包分发的那份 EndGlobal 只有 10 个
 * SDK 文件（55 MB），Gryphline 三个渠道真正要的是 126 个文件（936 MB）—— 目录
 * 结构完好、U8Data 也在，但缺 Endfield.exe / GameAssembly.dll 这些本体二进制，
 * 铺出来的运行时一启动就崩。老机器升级上来时目录里躺的正是这份旧的，只看
 * 「U8Data 在不在」会把它当成已就绪，于是不下载、直接拼出错的运行时。
 *
 * 判据落在 `.state/<目录>.json`：只有 updateProfile 完整跑完（每个文件过 md5、
 * staging 整体改名、写状态）才会生成它，随安装包分发的老包和 XelLauncher 里
 * 借来的包都没有。缺它就让切服时问一次、下完再切；updateProfile 会按 md5
 * 复用已有文件，所以「其实文件已经齐了，只是没状态」的机器不会真的重下 936 MB。
 */
function packDownloadedState(root, directory) {
  try {
    const raw = fs.readFileSync(path.join(root, '.state', `${directory}.json`), 'utf8');
    const state = JSON.parse(raw);
    return Boolean(state && state.ManifestSha256);
  } catch {
    return false;
  }
}

/**
 * 某个渠道包目录算不算齐了。
 *
 * 差异渠道（国际服 / Play / Steam）走状态文件；官服 / B服 这两个和基础客户端
 * 同二进制、老机器上随安装包带来的就是完整的，继续用轻量的 U8Data 判定，
 * 免得升级后让所有人重下 235 MB。
 */
function channelPackFilesReady(profile, dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (profile && profile.deltaOf) return packDownloadedState(path.dirname(dir), path.basename(dir));
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
  const report = (index, current) => {
    onProgress?.({
      profile: profile.iconName,
      directory: profile.directory,
      current,
      // 两个口径都给：processed 是文件个数（老调用方在用），bytes 是进度条用的字节
      processed: index,
      total: remote.files.length,
      bytes: processedBytes,
      totalBytes,
      downloadedBytes,
      speed: bytesPerSecond(downloadedBytes, startedAt),
    });
  };
  for (let index = 0; index < remote.files.length; index += 1) {
    if (signal?.aborted) throw abortedError();
    const file = remote.files[index];
    report(index, file.path);
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
           * 大文件（Endfield.exe / GameAssembly.dll 这类几十上百 MB 的）走
           * 16 连接分段，小文件仍是单连接：CDN 按连接限速，分段是唯一能让
           * 「硬链接生成一份」等 940 MB 差异包时快起来的办法。分段不可用时
           * downloadPackFile 内部就退回单连接了，这里不用再判断。
           */
          await downloadPackFile(`${remote.base}/${file.urlPath}`, temporary, {
            size: file.size || 0,
            signal,
            onChunk: (chunkBytes) => {
              downloadedBytes += chunkBytes;
              report(index, file.path);
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
    processedBytes += file.size || 0;
    if (processedBytes > totalBytes) processedBytes = totalBytes;
    report(index + 1, file.path);
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
    // 这份包是不是「整包差异」（国际服 / Play / Steam）：给 readiness 与排查用
    Delta: Boolean(profile.deltaOf),
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
  // 渠道包目录算不算齐了：差异渠道看状态文件，其余看 U8Data
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
