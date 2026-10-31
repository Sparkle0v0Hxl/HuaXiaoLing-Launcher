'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

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
  const response = await fetch(profile.api, {
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

async function loadRemoteManifest(profile, allFiles = false) {
  const latest = await fetchLatest(profile);
  const response = await fetch(`${latest.base}/game_files`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`${profile.iconName} 清单 HTTP ${response.status}`);
  const encrypted = Buffer.from(await response.arrayBuffer());
  const parsed = parseManifest(decryptManifest(encrypted));
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
  return {
    version: latest.version,
    base: latest.base,
    manifestSha256: crypto.createHash('sha256').update(encrypted).digest('hex').toUpperCase(),
    files,
  };
}

/**
 * 只取清单本身（不做渠道过滤），给「按差异打包」当基线用。
 *
 * 国服清单一次几万行，国际服 / Play / Steam 都要用它，缓存 10 分钟：
 * 一个渠道包下载动辄几分钟，重复拉只会把切服前的等待拉长。
 */
const rawManifestCache = new Map();
async function rawManifest(directory) {
  const hit = rawManifestCache.get(directory);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.files;
  const profile = PROFILES.find((item) => item.directory === directory);
  if (!profile) throw new Error(`没有 ${directory} 这条渠道`);
  const remote = await loadRemoteManifest(profile, true);
  rawManifestCache.set(directory, { at: Date.now(), files: remote.files });
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
 * 流式下载到文件。
 *
 * 渠道包里最大的单个文件是 B站 SDK 的 libcef.dll（112 MB）—— 老版本先
 * arrayBuffer() 整个读进内存再写盘，峰值内存就是文件本身的大小，
 * 叠加 md5 计算还要再来一份。这里一律走流，边下边写。
 *
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] 取消信号（用户在弹窗里点「取消」）
 * @param {(bytes:number)=>void} [options.onChunk] 每收到一块就报一次增量字节
 */
async function downloadToFile(url, destination, options = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA },
    // 有外部信号时以它为准：取消要能立刻生效，不能再套一层 30 分钟超时
    signal: options.signal || AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const file = fs.createWriteStream(destination);
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  const source = Readable.fromWeb(response.body);
  if (typeof options.onChunk === 'function') {
    source.on('data', (chunk) => options.onChunk(chunk.length));
  }
  try {
    await pipeline(source, file);
  } catch (error) {
    // 半截文件留着会被下一轮的 md5 校验当成坏文件反复重下，直接清掉
    await fsp.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
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
  const report = (index, phase) => {
    if (typeof onProgress === 'function') {
      onProgress({
        game: profile.iconName,
        version: latest.version,
        phase,
        index,
        total,
        percent: Math.round((index / total) * 100),
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
    await downloadToFile(pack.url, target);
    if (pack.md5) {
      const actual = await md5File(target);
      if (actual !== pack.md5) throw new Error(`${name} 校验失败（md5 不符）`);
    }
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
    await downloadToFile(`${remote.base}/${file.urlPath}`, temporary);
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
    if (!fs.existsSync(temporary)) {
      /*
       * 已下过的文件按 md5 复用：上次取消时留下的那一半、以及「先下了 B服、
       * 后来又切官服」这种重复渠道件，都不该重下。复用走 copyFile 不读进内存。
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
        try {
          await downloadToFile(`${remote.base}/${file.urlPath}`, temporary, {
            signal,
            // 单个大文件内部也要推进进度条，否则 112 MB 的 libcef 一下载界面就是死的
            onChunk: (chunkBytes) => {
              downloadedBytes += chunkBytes;
              report(index, file.path);
            },
          });
        } catch (error) {
          if (signal?.aborted) throw abortedError();
          throw error;
        }
        downloaded += 1;
        if ((await md5File(temporary)) !== file.md5) {
          await fsp.rm(temporary, { force: true });
          throw new Error(`${file.path} MD5 校验失败`);
        }
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
  downloadAndExtractSplit,
  findSevenZip,
  decryptManifest,
  encryptManifest,
  profileForChannel,
  PROFILES,
};
