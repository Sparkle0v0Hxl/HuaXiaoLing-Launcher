'use strict';

/**
 * 米哈游系（原神 / 星穹铁道 / 绝区零）预下载。
 *
 * 协议来源：HoYoPlay 公开接口，无签名、无登录态，只需要 launcher_id + language。
 *
 * 核心思路（与 Starward 一致）：
 *   1. getGameBranches 会同时给出 main（当前正式版）和 pre_download（预下载分支）。
 *      预下载分支带自己的 { branch, package_id, password }，但走的是同一个 getBuild 接口，
 *      所以「预下载」= 提前把正式版要用的 chunk 拉到本地，不做任何安装动作。
 *   2. chunk 落到 <安装目录>/chunk/<chunk.id>，保持压缩态（zstd），不做解压。
 *   3. 完成后只在 config.ini 追加 predownload=<本地版本>,<目标版本>,<语音组合>，
 *      game_version 保持不变 —— 否则游戏会认为自己已经是新版本。
 *   4. 正式版上线后（main.tag 变成新版本）走 apply：组装每个文件时优先命中
 *      chunk/ 缓存，命中就 0 流量；最后一定校验整文件 MD5 才落盘。
 *
 * 为什么预下载这一侧只做 CHUNK、不掺 ldiff：
 *   1. 实测九个渠道（原神/星铁/绝区零 × 官服/B服/国际服）的
 *      launcher_config.default_download_mode 全是 DOWNLOAD_MODE_CHUNK；
 *      enable_ldiff 只在原神/星铁为 true，绝区零为 false —— 也就是说 ldiff 从来不是
 *      「另一种下载模式」，而是叠在 chunk 上的加速层，chunk 模式覆盖率本身就是 100%。
 *   2. 更要紧的是时机：预下载发生在正式版**发布之前**，此时绝不能动安装目录里的游戏文件。
 *      而 ldiff 的前提恰恰是「拿本地旧文件当基底就地改成新内容」，天生属于
 *      正式更新那一刻的动作，所以它放在 update 链路里（electron/hdiff.js 的
 *      applyHdiffPrepass），不放在这里。
 *   3. 预下载拉下来的 chunk 会被正式更新的 prepareSophon 直接复用，
 *      两条链路最终走的是同一份 chunk 缓存，不存在「白下」。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const {
  CHANNELS,
  decodeManifest,
  normalizeAudioLanguages,
  AUDIO_LANGUAGES,
  // 清单读取复用安装链路那一套：多份并发 + 大清单分段 + 解码缓存 + 单飞。
  // 预下载原来自己写了一份串行循环，绝区零带分类剧情 113 份就是 113 次往返。
  ensureManifests,
  // 预下载 apply 侧：用「本地旧版本的分块索引 + 按 offset 读本地字节」补齐差量里
  // 没变的那些块，否则预下载省下来的块在 apply 时会被当成缺块联网重下（星铁实测
  // 预下载 12.70G 之后 apply 又追加 10.48G，合计 23.17G，比不做预下载直接更新还多）。
  loadLocalChunkIndex,
  readLocalChunk,
  // 官方「这些资源本次不用下」的黑名单：预下载和 apply 都要按它跳过，
  // 否则官方明确不要的资源我们照样下下来。
  loadDeletedAssets,
  isDeletedAsset,
} = require('./sophon');
const { httpFetch, directFetch } = require('./http-fetch');
const linkSource = require('./link-source');
const clientChannel = require('./client-channel');
const diskSpace = require('./disk-space');
const hdiff = require('./hdiff');
const netThrottle = require('./net-throttle');

const API = {
  cn: 'https://hyp-api.mihoyo.com/hyp/hyp-connect/api',
  global: 'https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api',
  buildCn: 'https://downloader-api.mihoyo.com/downloader/sophon_chunk/api/getBuild',
  buildGlobal: 'https://sg-downloader-api.hoyoverse.com/downloader/sophon_chunk/api/getBuild',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** chunk 缓存目录名（固定，官方启动器和 Starward 都用这个，不能改）。 */
const CHUNK_DIR = 'chunk';

const HOYO_GAME_KEYS = ['genshin', 'starrail', 'zzz', 'bh3'];

function supported(gameKey) {
  return HOYO_GAME_KEYS.includes(String(gameKey || ''));
}

function channelInfo(gameKey, channel) {
  const info = CHANNELS[gameKey]?.[channel];
  if (!info) throw new Error('这个游戏/服务器没有对应的官方渠道参数');
  return info;
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/*
 * zstd 解压走异步接口。
 *
 * 以前用的是 zstdDecompressSync：解压本身要几百毫秒到几秒（大块 8~16MB），
 * 而它跑在主进程的主线程上 —— 解压期间事件循环是停的，IPC 发不出去、
 * 进度事件挤在一起，界面看着就是「进度条一次跳一大格，然后半天不动」。
 * 异步版丢进 libuv 线程池，主线程可以继续调度，也不影响窗口响应。
 * Electron 45 / Node 24 有 zlib.zstdDecompress；老版本自动回退同步实现。
 */
const zstdDecompressAsync =
  typeof zlib.zstdDecompress === 'function'
    ? (buffer) =>
        new Promise((resolve, reject) => {
          zlib.zstdDecompress(buffer, (error, output) => (error ? reject(error) : resolve(output)));
        })
    : async (buffer) => zlib.zstdDecompressSync(buffer);

async function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const normalized = path.resolve(root);
  if (target !== normalized && !target.startsWith(`${normalized}${path.sep}`)) {
    throw new Error(`清单包含非法路径：${relative}`);
  }
  return target;
}

async function waitIfPaused(signal) {
  while (signal?.paused && !signal?.cancelled) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
}

/**
 * 把临时文件就地换成正式文件。
 *
 * 为什么不是「先 rm 再 rename」——2026-11-11 用户报障查出来的坑：
 * 游戏目录里有些文件是官方安装器用管理员身份写的，ACL 上普通用户只给了
 * 读取+执行，连 DELETE 都没有。这种文件 `rm` 会直接 EPERM，而 Node 在
 * Windows 上把「权限不足」和「文件被占用」都报成 EPERM，提示就成了
 * 「文件被其它程序占用」——用户关掉所有程序也永远修不好。
 *
 * 实测（deny DELETE 的文件、目录本身可写）：`rm` → EPERM，但
 * `rename` 直接覆盖 → 成功。Windows 的 fs.rename 底层是 MoveFileExW +
 * MOVEFILE_REPLACE_EXISTING，覆盖已存在的目标不需要目标可删，只需要
 * 目录可写。所以先试 rename，失败才退回「删了再改名」。
 *
 * 这也和 hdiff.js 里打补丁落地那段是同一套写法（那边注释早写了原因），
 * 两条更新链路不该一个对一个错。
 */
async function replaceFileAtomic(tmp, target) {
  try {
    await fsp.rename(tmp, target);
    return;
  } catch (error) {
    // rename 失败可能是跨卷、目标被独占、或真没有目录写权限。退回老办法再试一次，
    // 这一次的报错才带有意义（大概率是真正的占用/权限问题）。
    await fsp.rm(target, { force: true }).catch(() => {});
    try {
      await fsp.rename(tmp, target);
    } catch (retryError) {
      throw Object.assign(
        new Error(`无法写入 ${path.basename(target)}：${retryError.message}`),
        { code: retryError.code || error.code }
      );
    }
  }
}

function throwIfCancelled(signal) {
  if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
}

/*
 * 接口结果 60 秒内复用：预下载一次操作里，check / start / apply 会各问一遍
 * getGameBranches 和 getBuild，同一份数据来回问三次纯属白等往返。
 */
const jsonMemo = new Map();

async function fetchJson(url, init) {
  const key = `${url}|${init?.method || 'GET'}`;
  const hit = jsonMemo.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  const response = await httpFetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
    ...init,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}：${url}`);
  const json = await response.json();
  if (json.retcode !== 0) throw new Error(json.message || `接口返回 ${json.retcode}`);
  jsonMemo.set(key, { at: Date.now(), data: json.data });
  while (jsonMemo.size > 24) jsonMemo.delete(jsonMemo.keys().next().value);
  return json.data;
}

/** getGameBranches：同时拿到正式分支和预下载分支。 */
async function fetchBranch(gameKey, channel) {
  const info = channelInfo(gameKey, channel);
  const base = info.server === 'global' ? API.global : API.cn;
  const query = `getGameBranches?launcher_id=${info.launcher}&language=zh-cn&game_ids[]=${info.game}`;
  const data = await fetchJson(`${base}/${query}`);
  const branch = (data.game_branches || []).find((item) => item.game?.id === info.game);
  if (!branch?.main) throw new Error('官方没有返回这个服务器的版本分支');
  return { info, branch };
}

async function fetchBuild(info, branchPackage, tag = '') {
  const base = info.server === 'global' ? API.buildGlobal : API.buildCn;
  let query = `branch=${encodeURIComponent(branchPackage.branch)}&package_id=${encodeURIComponent(
    branchPackage.package_id
  )}&password=${encodeURIComponent(branchPackage.password)}`;
  if (tag) query += `&tag=${encodeURIComponent(tag)}`;
  return fetchJson(`${base}?${query}`);
}

/*
 * 清单选择 —— 这里刻意没有照搬 sophon.js:232 那份 pickManifests。
 *
 * 那份只取 matching_field === 'game' 和 4 份语音，其余全丢。实测绝区零 3.3.0 的 build
 * 有 120 份清单，不是 5 份：
 *   - game          游戏资源-外网            58.63GB（1 份）
 *   - zh-cn/en-us/ja-jp/ko-kr  语音包        18.01GB（4 份，按设置勾中的取）
 *   - mini-zh-cn/...           登录资源小包  18.01GB（4 份）
 *        ⚠️ 与对应语音是**同一批文件**（实测逐项同 4.25/4.38/4.55/4.83GB），
 *        纯去重包，取了会把每种语音算两遍，一律跳过。
 *   - 111 份纯数字分类包（10108 任务▶主线▶第六章、10202 任务▶个人线▶猫又、
 *     30102002 系统▶影像档案、20101 空洞▶…）  19.73GB / 2068 个文件
 *        实测这些文件 0 个出现在 game 清单里，是互斥补充资源：
 *        只取 game + 语音会缺掉全部主线剧情 / 个人线 / 影像档案 / OVA / 空洞的动画。
 *
 * 原神、星铁不受影响（实测这两个游戏确实只有 game + 4 份语音，共 5 份清单）。
 *
 * 体积可以直接从 manifest.stats.uncompressed_size 读，不用把清单下下来。
 * 注意 deduplicated_stats 只在单份清单内部去重，不会去掉 mini-* 与语音之间的重复，
 * 所以 mini-* 必须自己排除。
 */
const AUDIO_KEYS = new Set(AUDIO_LANGUAGES.map(([key]) => key));
const MINI_PREFIX = 'mini-';

function manifestKind(field) {
  if (field === 'game') return 'game';
  if (field.startsWith(MINI_PREFIX)) return 'mini';
  if (AUDIO_KEYS.has(field)) return 'audio';
  return 'category';
}

/*
 * includeCategory 默认 false：绝区零那 111 份分类包要 19.73GB，而主安装链路也是默认不装，
 * 预下载默认开就会白下 20GB。要下就显式传 true（settings.includeStoryResources 勾上）。
 * 不勾只是缺剧情动画，不影响进游戏。
 */
function classifyManifests(build, languages, options = {}) {
  const manifests = build.manifests || [];
  const wanted = new Set(normalizeAudioLanguages(languages));
  const includeCategory = options.includeCategory === true;
  const groups = { game: [], audio: [], category: [], mini: [] };
  for (const item of manifests) {
    const field = String(item.matching_field || '').toLowerCase();
    const kind = manifestKind(field);
    if (kind === 'game') groups.game.push(item);
    else if (kind === 'mini') groups.mini.push(item);
    else if (kind === 'audio') {
      if (wanted.has(field)) groups.audio.push(item);
    } else if (includeCategory) {
      groups.category.push(item);
    }
  }
  if (!groups.game.length) throw new Error('官方清单缺少游戏资源');
  return { all: [...groups.game, ...groups.audio, ...groups.category], ...groups };
}

function pickManifests(build, languages, options = {}) {
  return classifyManifests(build, languages, options).all;
}

/** 不下载任何清单就能算出的体积拆解，给界面显示「本体 / 语音 / 剧情资源」三段。 */
function summarizeManifests(build, languages, options = {}) {
  const groups = classifyManifests(build, languages, options);
  const bytes = (list) =>
    list.reduce((sum, item) => sum + (Number(item?.stats?.uncompressed_size) || 0), 0);
  const gameBytes = bytes(groups.game);
  const audioBytes = bytes(groups.audio);
  const categoryBytes = bytes(groups.category);
  return {
    bytesGame: gameBytes,
    bytesAudio: audioBytes,
    bytesCategory: categoryBytes,
    bytesTotal: gameBytes + audioBytes + categoryBytes,
    // 被排除的 mini-* 体积，只是给用户看「我们替你省了多少」
    bytesMiniSkipped: bytes(groups.mini),
    categoryCount: groups.category.length,
    audioCount: groups.audio.length,
    categoryNames: groups.category
      .slice(0, 10)
      .map((item) => item.category_name || item.matching_field),
  };
}

/*
 * config.ini 一律走编码自适应读取。
 *
 * 国际服客户端的 config.ini 有 UTF-16 的版本，用 utf8 直读是乱码：既读不到
 * game_version（预下载会误判「本地版本为空」），也让 setConfigIniValue 的正则匹配不上，
 * 改写时把 cps / game_biz 这些行整份丢掉 —— 客户端的渠道信息就这么没了。
 */
function readGameVersion(root) {
  const config = clientChannel.readClientConfig(root);
  if (!config) return '';
  return String(config.fields.get('game_version') || '').trim();
}

function readConfigIni(root) {
  return clientChannel.readIniText(path.join(root, 'config.ini'));
}

/**
 * 改 config.ini 里的某一行，其他字段（cps / channel / game_biz / sdk_version …）原样保留。
 * 预下载只改 predownload=；应用时才把 game_version 提到新版本并清空 predownload。
 */
async function setConfigIniValue(root, key, value) {
  const file = path.join(root, 'config.ini');
  // 编码自适应读：UTF-16 的 ini 用 utf8 读会变成乱码，正则匹配不上，
  // 改写时会把 cps / game_biz / sdk_version 整份丢掉（客户端渠道信息因此消失）
  let text = clientChannel.readIniText(file);
  const line = `${key}=${value ?? ''}`;
  const pattern = new RegExp(`^${key}\\s*=.*$`, 'im');
  if (pattern.test(text)) {
    text = text.replace(pattern, line);
  } else if (text.trim()) {
    text = text.replace(/\r?\n$/, '') + `\n${line}\n`;
  } else {
    text = `[General]\n${line}\n`;
  }
  // 运行时目录里的文件可能是 hardlinkTree 硬链接来的，直接写会改到基础客户端，先删再写。
  await fsp.rm(file, { force: true });
  await fsp.writeFile(file, text, 'utf8');
}

function audioKey(languages) {
  return normalizeAudioLanguages(languages).join('+');
}

/** predownload=<本地版本>,<目标版本>,<语音组合> —— 三段全等才算这份预下载还对得上。 */
function marker(localVersion, targetVersion, languages) {
  return `${localVersion},${targetVersion},${audioKey(languages)}`;
}

function compareVersion(a, b) {
  const left = String(a || '0.0.0')
    .split('.')
    .map((part) => Number(part) || 0);
  const right = String(b || '0.0.0')
    .split('.')
    .map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function chunkDirOf(installRoot) {
  return path.join(installRoot, CHUNK_DIR);
}

/**
 * ldiff 补丁包的存放目录。
 *
 * 官方和 Starward 都用安装目录下的 ldiff/ 放「下载好了但还没打」的补丁包，
 * 沿用这个名字，将来换成官方启动器接手也不会打架。
 */
function patchDirOf(installRoot) {
  return path.join(installRoot, 'ldiff');
}

function fmtBytes(value) {
  const size = Number(value) || 0;
  if (size >= 1024 ** 4) return `${(size / 1024 ** 4).toFixed(2)} TB`;
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(size / 1024)} KB`;
}

/*
 * chunk/ 旁边的元信息文件。
 *
 * config.ini 的 predownload= 只有三段（<本地版本>,<目标版本>,<语音>），那是官方启动器
 * 也认的格式，不能随便加字段。但「这份预下载有没有包含绝区零那 111 份剧情分类包」
 * 光靠三段是看不出来的 —— 用户改了设置以后标记还是会显示已完成。
 * 所以额外写一个小 JSON 放在 chunk/ 里，游戏本身完全不读它，删了也只是退化成重新预下载。
 */
const META_FILE = '.hxl-predownload.json';

function metaPath(installRoot) {
  return path.join(chunkDirOf(installRoot), META_FILE);
}

async function readMeta(installRoot) {
  try {
    return JSON.parse(await fsp.readFile(metaPath(installRoot), 'utf8'));
  } catch {
    return null;
  }
}

async function writeMeta(installRoot, meta) {
  await fsp.mkdir(chunkDirOf(installRoot), { recursive: true });
  await fsp.writeFile(metaPath(installRoot), JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * 数出 chunk/ 里已有的分块（不含元信息文件，也不含下到一半的 .pd_tmp）。
 *
 * 这套数字有两个用途：告诉用户「上次下了一半，现在有多少」，
 * 以及在没有标记的情况下判断「到底有没有下过东西」（没下过就别显示残留）。
 * 目录不存在 / 读不动都当 0，不让一次 IO 失败把整个状态查询带崩。
 */
async function measureStoredChunks(dir) {
  let files = 0;
  let bytes = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { files: 0, bytes: 0 };
  }
  for (const name of entries) {
    if (name === META_FILE || name.endsWith('.pd_tmp')) continue;
    const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (!stat?.isFile()) continue;
    files += 1;
    bytes += stat.size;
  }
  return { files, bytes };
}

async function inspect({
  gameKey,
  channel,
  installRoot,
  audioLanguages,
  cacheDir,
  includeCategory,
  onProgress,
}) {
  if (!gameKey || !channel) throw new Error('缺少游戏或服务器参数');
  if (!installRoot || !fs.existsSync(installRoot)) throw new Error('游戏安装目录不存在');
  const { info, branch } = await fetchBranch(gameKey, channel);
  const localVersion = readGameVersion(installRoot);
  const result = {
    info,
    branch,
    localVersion,
    latestVersion: String(branch.main?.tag || ''),
    targetVersion: String(branch.pre_download?.tag || ''),
    cacheDir,
    installRoot,
    audioLanguages,
    includeCategory: includeCategory === true,
    onProgress,
  };
  if (!localVersion) {
    return { ...result, state: 'not-installed' };
  }
  return result;
}

/**
 * 查询预下载状态。
 *
 * state:
 *   not-installed  读不到本地版本（没装 / config.ini 缺失）
 *   update         正式版已经比本地新，只能更新，预下载按钮要让位
 *   available      有预下载包可以下
 *   done           预下载已完成
 *   none           官方当前没有开放预下载
 */
async function checkHoyoPredownload({
  gameKey,
  channel,
  installRoot,
  audioLanguages,
  cacheDir,
  includeCategory,
  verify = false,
}) {
  if (!supported(gameKey)) return { supported: false, state: 'unsupported' };
  try {
    const base = await inspect({ gameKey, channel, installRoot, audioLanguages, cacheDir, includeCategory });
    if (base.state === 'not-installed') {
      return { supported: true, state: 'not-installed', installRoot, localVersion: '' };
    }
    const { localVersion, latestVersion, targetVersion } = base;
    const dir = chunkDirOf(installRoot);
    /*
     * 先把已经躺着的东西数出来。
     * 预下载中途停掉、关窗、断电，产物都留在 chunk/（或补丁模式的 ldiff/）里，
     * 而「下完了」的三段标记只在全部走完时才写 —— 所以没标记不等于没有进度。
     * 界面要能说出「已经下了多少、接着来能省多少」，全靠这两个数字，所有分支都带上。
     */
    const meta = await readMeta(installRoot);
    /*
     * 补丁模式下产物在 ldiff/ 而不是 chunk/：数错目录会出现「下完了却显示 0 个文件、
     * 状态一直停在 available」，用户以为没下成又去点一遍。
     */
    const patchMode = Boolean(meta && meta.mode === 'ldiff');
    const stored = patchMode
      ? await measureStoredChunks(patchDirOf(installRoot))
      : await measureStoredChunks(dir);
    const answer = {
      supported: true,
      kind: 'hoyo',
      mode: patchMode ? 'ldiff' : 'chunk',
      dir: patchMode ? patchDirOf(installRoot) : dir,
      installRoot,
      localVersion,
      latestVersion,
      targetVersion,
      includeCategory: base.includeCategory,
      state: 'none',
      completed: false,
      storedFiles: stored.files,
      storedBytes: stored.bytes,
    };
    if (compareVersion(latestVersion, localVersion) > 0) {
      // 正式版已上线：顺带把这次更新的体积拆解算出来给界面看
      return { ...answer, state: 'update', ...(await summarizeFor(base, base.branch.main)) };
    }
    if (!base.branch.pre_download || compareVersion(targetVersion, localVersion) <= 0) {
      return answer;
    }
    // 预下载模式：补丁包是官方给的那一份差量，体积比按块下小一半
    const sizes = patchMode
      ? { bytesTotal: Number(meta.bytes) || 0, bytesGame: Number(meta.bytes) || 0, bytesAudio: 0 }
      : await summarizeFor(base, base.branch.pre_download);
    const saved = (readConfigIni(installRoot).match(/^\s*predownload\s*=\s*([^\r\n]*)$/im) || [])[1] || '';
    const expected = marker(localVersion, targetVersion, audioLanguages);
    /*
     * 「下完了」不能只押在 config.ini 的 predownload= 单行标记上：sophon 更新/修复
     * 或官方启动器重写 config.ini 时会把这一行整份清空，切服后的重查就把明明下完、
     * 产物还在的包判回 available，界面又冒出「开始预下载」。完成收尾我们自己也写过
     * 一份 meta（含 localVersion/targetVersion/audioKey），拿它当第二个凭据。
     * 旧版 meta 缺字段时 metaDone 为 false，自动回退到原判据，向后兼容。
     * 下面的 sameScope / stored.files / 0.9 阈值全部保留，产物被删仍会判回 available。
     */
    const metaDone =
      Boolean(meta) &&
      meta.localVersion === localVersion &&
      meta.targetVersion === targetVersion &&
      meta.audioKey === audioKey(audioLanguages);
    const marked = saved.trim() === expected || metaDone;
    /*
     * 三段标记对了还不够，还得确认「选清单的口径」没变：
     * 用户把「剧情分类包」开关改了以后，之前下的 chunk 集合就不对了，必须重新预下载。
     */
    const sameScope =
      Boolean(meta) &&
      Boolean(meta.includeCategory) === base.includeCategory &&
      meta.audioKey === audioKey(audioLanguages);
    if (!marked || !sameScope) {
      /*
       * 两种「没下完」都落到这里：
       *   - 手动停止 / 关窗 / 报错：标记没写成，但 chunk 在，下次接着用；
       *   - 改了语音或剧情分类开关：标记对不上，而且旧范围下的分块有一批用不上了。
       * 后者不能打包票说「接着用」，只提示「范围变了」，别让用户以为进度白攒。
       */
      return {
        ...answer,
        ...sizes,
        state: 'available',
        partial: stored.files > 0 && sameScope,
        scopeChanged: stored.files > 0 && !sameScope,
      };
    }
    // 标记对了还要看东西还在不在：产物目录被人删了就是白标。
    if (!stored.files) return { ...answer, ...sizes, state: 'available' };
    /*
     * 光有文件不够，还得对数。config.ini 的标记只在整轮跑完才写，但产物可能被
     * 手动删掉一部分、或被清理软件带走一半 —— 那种情况下标着 done、界面显示
     * 「已备好，点应用」，用户点下去才发现缺包，比直接说「没下完」糟得多。
     * 阈值与 hasCache / hasPatchCache 保持一致（0.9），三处判据口径统一。
     */
    const expectedCount = patchMode ? Number(meta?.patchCount) || 0 : Number(meta?.chunkCount) || 0;
    if (expectedCount && stored.files < expectedCount * 0.9) {
      return { ...answer, ...sizes, state: 'available', partial: true };
    }
    const report = {
      ...answer,
      ...sizes,
      state: 'done',
      completed: true,
      expectedChunks: patchMode ? meta?.patchCount || 0 : meta?.chunkCount || 0,
    };
    // 抽样校验只对 chunk 模式有意义：补丁包是整份 md5，不需要也不能按块抽验
    if (!verify || patchMode) return report;
    return { ...report, ...(await verifyChunks(base, 8)) };
  } catch (error) {
    return { supported: true, state: 'error', error: error.message, installRoot };
  }
}

/** 体积拆解：从 manifest.stats 直接读，不用把清单下下来。失败就当没有，不阻断 check。 */
async function summarizeFor(base, branchPackage) {
  try {
    const build = await fetchBuild(base.info, branchPackage, '');
    return summarizeManifests(build, base.audioLanguages, { includeCategory: base.includeCategory });
  } catch {
    return {};
  }
}

/** 抽样校验 chunk 缓存：随机抽 count 个，按目标清单比对 size + 压缩态 MD5。 */
async function verifyChunks(base, count) {
  const dir = chunkDirOf(base.installRoot);
  try {
    const build = await fetchBuild(base.info, base.branch.pre_download, '');
    const wanted = new Map();
    const manifests = pickManifests(build, base.audioLanguages, {
      includeCategory: base.includeCategory,
    });
    const lists = await ensureManifests(manifests, base.cacheDir, null, { label: '校验用清单' });
    for (const files of lists) {
      for (const file of files) {
        for (const chunk of file.chunks || []) {
          if (chunk.id && !wanted.has(chunk.id)) {
            wanted.set(chunk.id, { size: chunk.compressedSize, md5: String(chunk.compressedMd5 || '').toLowerCase() });
          }
        }
      }
    }
    const names = await fsp.readdir(dir);
    const picked = names.filter((name) => wanted.has(name));
    const step = Math.max(1, Math.floor(picked.length / Math.max(1, count)));
    const samples = [];
    for (let index = 0; index < picked.length && samples.length < count; index += step) {
      samples.push(picked[index]);
    }
    let checked = 0;
    let bad = 0;
    for (const name of samples) {
      const expect = wanted.get(name);
      const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
      if (!stat || (expect.size && stat.size !== expect.size)) {
        bad += 1;
        continue;
      }
      if (expect.md5 && (await md5File(path.join(dir, name))) !== expect.md5) bad += 1;
      checked += 1;
    }
    return { verified: bad === 0, verifiedFiles: checked, brokenFiles: bad };
  } catch (error) {
    return { verified: false, verifyError: error.message };
  }
}

/*
 * 单个 chunk 落盘：<chunkDir>/<id>，压缩态，不做解压。
 * .pd_tmp + HTTP Range 续传 + 压缩态 MD5 校验，通过才 rename 就位。
 */
async function downloadChunkFile(url, target, expectedSize, expectedMd5, signal, onTick) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.pd_tmp`;
  let offset = 0;
  try {
    const stat = await fsp.stat(tmp);
    offset = Number(stat.size) || 0;
    if (offset > expectedSize) {
      await fsp.rm(tmp, { force: true });
      offset = 0;
    }
  } catch {
    offset = 0;
  }

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfCancelled(signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    try {
      const headers = { 'user-agent': UA, accept: '*/*' };
      if (offset > 0) headers.range = `bytes=${offset}-`;
      const response = await fetch(url, { headers, signal: controller.signal });
      // 200 = 服务端不支持续传，从头写；206 = 接着上次的写
      if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
      if (response.status === 206) {
        const from = Number((response.headers.get('content-range') || '').split('/')[0]?.split('-')[0]);
        if (Number.isFinite(from)) offset = from;
      } else {
        // 服务端不支持续传，从头写
        offset = 0;
      }
      let resumed = false;
      try {
        resumed = offset > 0 && (await fsp.stat(tmp)).size >= offset;
      } catch {
        resumed = false;
      }
      if (offset > 0 && !resumed) offset = 0;
      const handle = await fsp.open(tmp, resumed ? 'r+' : 'w');
      try {
        let position = offset;
        if (!response.body) throw new Error('响应没有数据体');
        for await (const piece of response.body) {
          throwIfCancelled(signal);
          await handle.write(piece, 0, piece.length, position);
          position += piece.length;
          // 千兆下这几万个小 chunk 全靠 16 路工人灌，限速要在这里生效
          if (netThrottle.getLimit() > 0) await netThrottle.consume(piece.length);
          onTick?.(piece.length);
        }
        await handle.truncate(position);
      } finally {
        await handle.close();
      }
      clearTimeout(timer);
      if (expectedSize && (await fsp.stat(tmp)).size !== expectedSize) {
        throw new Error(`大小不符（${(await fsp.stat(tmp)).size} ≠ ${expectedSize}）`);
      }
      if (expectedMd5 && (await md5File(tmp)) !== String(expectedMd5).toLowerCase()) {
        throw new Error('压缩数据校验失败');
      }
      await replaceFileAtomic(tmp, target);
      return;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      await fsp.rm(tmp, { force: true }).catch(() => {});
      offset = 0;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error(`分块下载失败 ${path.basename(target)}：${lastError?.message || '未知错误'}`);
}

/** 从一份 build 里收集所有要去重的 chunk（按 id 去重，保持压缩态信息）。 */
async function collectChunks(build, cacheDir, audioLanguages, onProgress, signal, options = {}) {
  const chunks = new Map();
  const manifests = pickManifests(build, audioLanguages, options);
  // 并发读：绝区零带分类剧情是 113 份清单，串行等于 113 次往返
  const lists = await ensureManifests(manifests, cacheDir, onProgress, { label: '读取清单', signal });
  throwIfCancelled(signal);
  /*
   * 官方黑名单：被标为「本次不用下」的文件整份跳过。
   *
   * 但块是内容寻址、跨文件共享的，这里必须区分「只被删除文件引用的块」和
   * 「还有正常文件在用的块」——直接按块名删会把后者需要的数据一起漏掉。
   */
  const deleted = options.deleted || null;
  const usedByDeleted = new Set();
  for (let index = 0; index < manifests.length; index += 1) {
    const files = lists[index];
    const prefix = String(manifests[index].chunk_download?.url_prefix || '').replace(/\/$/, '');
    if (!prefix) continue;
    const matchingField = manifests[index].matching_field;
    for (const file of files) {
      if (!file.file) continue;
      const skip = deleted && isDeletedAsset(deleted, { file: file.file, matchingField });
      for (const chunk of file.chunks || []) {
        if (!chunk.id) continue;
        if (skip) usedByDeleted.add(chunk.id);
        if (chunks.has(chunk.id)) continue;
        chunks.set(chunk.id, {
          id: chunk.id,
          url: `${prefix}/${chunk.id}`,
          compressedSize: chunk.compressedSize,
          compressedMd5: String(chunk.compressedMd5 || '').toLowerCase(),
          uncompressedMd5: String(chunk.uncompressedMd5 || '').toLowerCase(),
        });
      }
    }
  }
  if (deleted && deleted.active && usedByDeleted.size) {
    // 只删「仅被删除文件引用」的块：还有正常文件在用的块必须留下
    const stillNeeded = new Set();
    for (let index = 0; index < manifests.length; index += 1) {
      const matchingField = manifests[index].matching_field;
      for (const file of lists[index] || []) {
        if (!file.file) continue;
        if (isDeletedAsset(deleted, { file: file.file, matchingField })) continue;
        for (const chunk of file.chunks || []) if (chunk.id) stillNeeded.add(chunk.id);
      }
    }
    let dropped = 0;
    for (const id of usedByDeleted) {
      if (stillNeeded.has(id)) continue;
      if (chunks.delete(id)) dropped += 1;
    }
    if (dropped > 0) {
      onProgress?.({
        phase: 'manifest',
        current: `官方清单标了 ${dropped} 个分块本次不用下，已跳过`,
        deletedSkipped: dropped,
      });
    }
  }
  return chunks;
}

/**
 * 开始预下载：只下载「本地版本里没有」的 chunk。
 *
 * 去重依据是 chunk 的 uncompressed_md5（内容寻址）：目标清单里某个块的解压内容
 * 在本地版本清单里出现过，就说明这个块的字节本地已经有了，不用再下。
 */
async function startHoyoPredownload({
  gameKey,
  channel,
  installRoot,
  cacheDir,
  audioLanguages,
  includeCategory,
  signal,
  onProgress,
  // 只给自检 / 真机验证脚本用来「只下前 N 个补丁包」；正式链路不传 = 下全部
  maxPatches = 0,
}) {
  if (!supported(gameKey)) throw new Error('这个游戏不支持米哈游预下载');
  const base = await inspect({
    gameKey,
    channel,
    installRoot,
    audioLanguages,
    cacheDir,
    includeCategory,
    onProgress,
  });
  if (base.state === 'not-installed') {
    throw new Error('没有读到本地版本号，请先确认这个目录里已经装好游戏（config.ini 缺失）');
  }
  if (compareVersion(base.latestVersion, base.localVersion) > 0) {
    throw new Error(`正式版 ${base.latestVersion} 已经上线，请直接更新，不需要预下载`);
  }
  const pre = base.branch.pre_download;
  if (!pre || compareVersion(base.targetVersion, base.localVersion) <= 0) {
    throw new Error('官方当前没有开放这个版本的预下载');
  }

  const scope = { includeCategory: base.includeCategory };
  onProgress?.({ phase: 'version', current: `目标版本 ${base.targetVersion}` });

  /*
   * 先试「ldiff 补丁包」这条更省的路（官方启动器、Starward 用的都是它）。
   *
   * 两条路下的是同一份官方数据，但计价单位完全不同：
   *   - 分块（chunk）：按「块」比对，文件里任何一个字节变动，它所在的整个块都要重下。
   *     实测星铁 4.6.0→4.7.0 要下 12171 块 = 11.82GB。
   *   - 补丁（ldiff） ：按「文件」给二进制差分，一个 60MB 的补丁包里可能装着上百个
   *     小文件的差分。同一次更新只要 91 个包 = 5.82GB。
   * 差距全在「变了但没大改」的那批文件上：5.63GB 里只有 1.24GB 是真正的二进制差分，
   * 其余 4.39GB 是新增文件本身的压缩态。块级比法在这批文件上白下了一半。
   *
   * 预下载阶段**只存不打**：补丁包落到 <安装目录>/ldiff/，游戏本体一个字节都不动
   * （预下载发生时游戏还在跑旧版本，就地改文件等于边走边拆轮胎）。真正应用留给
   * 正式版上线后的 applyHoyoPredownload / applyHdiffPrepass。
   *
   * 拿不到补丁（官方没给本版本差分、绝区零那种官方关了 ldiff、接口异常）时，
   * 静静落回原来的分块预下载，行为与改造前完全一致。
   */
  let patchResult = null;
  try {
    patchResult = await hdiff.downloadPatchPackages({
      gameKey,
      channel,
      installRoot,
      cacheDir,
      audioLanguages,
      includeStory: base.includeCategory === true,
      patchRoot: patchDirOf(installRoot),
      signal,
      onProgress,
      maxPatches,
    });
  } catch (error) {
    onProgress?.({ phase: 'manifest', current: `补丁包下载不了，改走分块：${error.message}` });
  }
  if (patchResult?.ok && patchResult.patchCount > 0) {
    await setConfigIniValue(installRoot, 'predownload', marker(base.localVersion, base.targetVersion, audioLanguages));
    await writeMeta(installRoot, {
      localVersion: base.localVersion,
      targetVersion: base.targetVersion,
      audioKey: audioKey(audioLanguages),
      includeCategory: base.includeCategory,
      // 模式位：apply / hasPatchCache 靠它区分「这份预下载是补丁包还是分块」
      mode: 'ldiff',
      patchCount: patchResult.patchCount,
      bytes: patchResult.totalBytes,
      savedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      kind: 'hoyo',
      mode: 'ldiff',
      gameKey,
      channel,
      localVersion: base.localVersion,
      targetVersion: base.targetVersion,
      dir: patchDirOf(installRoot),
      patchCount: patchResult.patchCount,
      patchBytes: patchResult.totalBytes,
      totalBytes: patchResult.totalBytes,
      bytesTotal: patchResult.totalBytes,
      files: patchResult.patchCount,
      skipped: 0,
    };
  }
  if (patchResult?.reason) {
    onProgress?.({
      phase: 'manifest',
      current: `官方这次没给补丁包（${patchResult.reason}），按分块预下载`,
    });
  }

  const targetBuild = await fetchBuild(base.info, pre, '');
  const sizes = summarizeManifests(targetBuild, audioLanguages, scope);
  if (sizes.bytesCategory) {
    onProgress?.({
      phase: 'version',
      current: `本体 ${fmtBytes(sizes.bytesGame)} + 语音 ${fmtBytes(sizes.bytesAudio)} + 剧情等分类资源 ${fmtBytes(
        sizes.bytesCategory
      )}（${sizes.categoryCount} 类）`,
    });
  }
  onProgress?.({ phase: 'manifest', current: '读取目标版本清单' });
  // 官方黑名单挂在安装目录上（游戏自己写的那份），读不到就 active:false → 不过滤
  const deletedAssets = loadDeletedAssets(installRoot, gameKey);
  const targetChunks = await collectChunks(targetBuild, cacheDir, audioLanguages, onProgress, signal, {
    ...scope,
    deleted: deletedAssets,
  });

  // 本地版本清单拿不到就按「全量下」处理，宁可多下也不能漏。
  const existing = new Set();
  try {
    const localBuild = await fetchBuild(base.info, pre, base.localVersion);
    onProgress?.({ phase: 'manifest', current: '比对本地版本清单' });
    for (const chunk of (await collectChunks(localBuild, cacheDir, audioLanguages, onProgress, signal, scope))
      .values()) {
      if (chunk.uncompressedMd5) existing.add(chunk.uncompressedMd5);
    }
  } catch (error) {
    onProgress?.({ phase: 'manifest', current: `本地清单不可用，按全量下载：${error.message}` });
  }

  const needed = [...targetChunks.values()].filter(
    (chunk) => !chunk.uncompressedMd5 || !existing.has(chunk.uncompressedMd5)
  );
  const totalBytes = needed.reduce((sum, chunk) => sum + (chunk.compressedSize || 0), 0);
  const dir = chunkDirOf(installRoot);
  await fsp.mkdir(dir, { recursive: true });

  let processed = 0;
  let bytesDone = 0;
  let skipped = 0;

  /*
   * 分块下载并发化 —— 这是整条下载链里最大的一道坎。
   *
   * 星铁一次预下载要下 12,171 个分块，而官方分块最大只有 3.4 MB、平均 0.37 MB
   * （实测 field=game 91,687 块 / maxMB 3.4，field=zh-cn 10,756 块 / maxMB 3.1）。
   * 这么小的块永远够不上 multiDownload 的 8 MB 分段门槛，于是以前这里是纯串行
   * for-await：一条连接一个接一个地拉。用同一批真实分块实测（400 块 / 149.1 MB）：
   *
   *   串行 1 路  4.03 MB/s
   *   4 路  23.83 / 8 路  31.19 / 16 路  38.52（最佳） / 32 路  29.53 / 48 路  31.21
   *
   * 也就是说「循环改成并发」这一件事本身就能把吞吐提到 9.6 倍，再加连接数反而
   * 因为对端限流掉回去。所以默认 16 路，与 apply 侧工人数一致；环境变量只给自测用。
   *
   * 并发安全：每个分块写自己的 <chunkId>.pd_tmp、成功后 rename 到自己的 <chunkId>，
   * 块与块之间不共享文件句柄，所以并发写不会互相踩。累加量（processed/bytesDone/
   * skipped）在单线程事件循环里自增是原子的，界面进度只是数字抖动不会错乱。
   */
  const downloadConcurrency = Math.max(
    1,
    Math.min(32, Number(process.env.HXL_PREDOWNLOAD_CONCURRENCY) || 16)
  );

  /*
   * 进度节流：downloadChunkFile 每收到一片数据（约 64 KB）就回调一次，串行时一块
   * 6 片还能接受；16 路并发后事件量放大 16 倍，6 万个块全开就是几十万条 IPC，
   * 渲染进程光重绘进度条就要卡住。这里统一收到 120ms 一帧，界面反而是流畅的。
   * 收尾会 force 推一次，避免最后停在 99%。
   */
  let lastProgressAt = 0;
  const pushProgress = (chunk, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 120) return;
    lastProgressAt = now;
    onProgress?.({
      phase: 'download',
      current: chunk.id,
      processed,
      total: needed.length,
      skipped,
      bytesDone,
      totalBytes,
    });
  };

  const downloadOne = async (chunk) => {
    await waitIfPaused(signal);
    throwIfCancelled(signal);
    const target = path.join(dir, chunk.id);
    let reused = false;
    try {
      const stat = await fsp.stat(target);
      if (!chunk.compressedSize || stat.size === chunk.compressedSize) {
        reused = !chunk.compressedMd5 || (await md5File(target)) === chunk.compressedMd5;
      }
    } catch {
      reused = false;
    }
    if (reused) {
      skipped += 1;
      bytesDone += chunk.compressedSize || 0;
      processed += 1;
      pushProgress(chunk);
      return;
    }
    await downloadChunkFile(chunk.url, target, chunk.compressedSize, chunk.compressedMd5, signal, (delta) => {
      bytesDone += delta;
      pushProgress(chunk);
    });
    processed += 1;
    pushProgress(chunk);
  };

  /*
   * 一个块失败就整条停下（和串行版行为一致）：预下载少一块，后面 apply 一定缺文件，
   * 与其带病跑完再让用户在更新时发现「预下载内容不完整」，不如当场报错。
   * fatalError 是给已经排队的工人用的刹车 —— 第一个工人出错后，其余立刻退出，
   * 不要继续把剩下几万个块拉完。
   */
  let cursor = 0;
  let fatalError = null;
  const downloadWorkerCount = Math.max(1, Math.min(downloadConcurrency, needed.length));
  await Promise.all(
    Array.from({ length: downloadWorkerCount }, async () => {
      for (;;) {
        if (fatalError) return;
        const index = cursor;
        cursor += 1;
        if (index >= needed.length) return;
        try {
          await downloadOne(needed[index]);
        } catch (error) {
          // 用户主动取消不是下载失败，原样往上抛
          if (signal?.cancelled || error?.cancelled) throw error;
          if (!fatalError) fatalError = error;
          throw error;
        }
      }
    })
  );

  // 收尾强推一帧满进度：节流会吞掉最后几片，别让界面停在 99%
  onProgress?.({
    phase: 'download',
    current: '',
    processed: needed.length,
    total: needed.length,
    skipped,
    bytesDone: totalBytes,
    totalBytes,
  });

  await setConfigIniValue(installRoot, 'predownload', marker(base.localVersion, base.targetVersion, audioLanguages));
  await writeMeta(installRoot, {
    localVersion: base.localVersion,
    targetVersion: base.targetVersion,
    audioKey: audioKey(audioLanguages),
    includeCategory: base.includeCategory,
    // 模式位：这份预下载是「分块缓存」还是「补丁包」，apply 时两条路完全不同
    mode: 'chunk',
    chunkCount: needed.length,
    bytes: totalBytes,
    ...sizes,
    savedAt: new Date().toISOString(),
  });
  return {
    ok: true,
    kind: 'hoyo',
    gameKey,
    channel,
    localVersion: base.localVersion,
    targetVersion: base.targetVersion,
    dir,
    chunks: needed.length,
    reused: skipped,
    downloaded: needed.length - skipped,
    totalBytes,
    ...sizes,
    includeCategory: base.includeCategory,
    installRoot,
  };
}

/** 目标文件是否已经正确：先比大小，再抽首/末两个 chunk 的解压 MD5。 */
async function quickFileMatches(file, filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size !== file.size) return false;
    if (!file.chunks?.length) return (await md5File(filePath)) === String(file.md5 || '').toLowerCase();
    const picked = [file.chunks[0], file.chunks[file.chunks.length - 1]].filter(Boolean);
    const handle = await fsp.open(filePath, 'r');
    try {
      for (const chunk of picked) {
        if (!chunk.uncompressedMd5 || !chunk.uncompressedSize) return false;
        const buffer = Buffer.alloc(chunk.uncompressedSize);
        const { bytesRead } = await handle.read(buffer, 0, chunk.uncompressedSize, chunk.offset);
        if (bytesRead !== chunk.uncompressedSize) return false;
        if (md5(buffer) !== chunk.uncompressedMd5.toLowerCase()) return false;
      }
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

/** chunk 缓存命中则返回解压后的字节，否则返回 null。 */
async function readCachedChunk(dir, chunk) {
  if (!chunk.compressedMd5 && !chunk.compressedSize) return null;
  const file = path.join(dir, chunk.id);
  try {
    const stat = await fsp.stat(file);
    if (chunk.compressedSize && stat.size !== chunk.compressedSize) return null;
    const compressed = await fsp.readFile(file);
    if (chunk.compressedMd5 && md5(compressed) !== chunk.compressedMd5) return null;
    const raw = await zstdDecompressAsync(compressed);
    if (chunk.uncompressedMd5 && md5(raw) !== chunk.uncompressedMd5) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 联网下载并解压一个 chunk。
 *
 * 走 directFetch（node:https 直连优先）：Chromium 栈对同一个 host 只有 6 条 socket，
 * 16 路文件并发走过去实际只有 6 条在跑。直连不通时它自己会退回 Chromium 栈。
 */
async function fetchChunk(chunk, signal) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitIfPaused(signal);
    throwIfCancelled(signal);
    try {
      const response = await directFetch(chunk.url, {
        headers: { 'user-agent': UA, accept: '*/*' },
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const compressed = await netThrottle.toBuffer(response);
      if (chunk.compressedMd5 && md5(compressed) !== chunk.compressedMd5) {
        throw new Error('分块压缩数据校验失败');
      }
      const raw = await zstdDecompressAsync(compressed);
      if (chunk.uncompressedMd5 && md5(raw) !== chunk.uncompressedMd5) {
        throw new Error('分块解压数据校验失败');
      }
      return raw;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw new Error(`分块下载失败 ${chunk.id}：${lastError?.message || '未知错误'}`);
}

/**
 * 用一个文件的 chunk 清单把目标文件拼出来 —— apply 的核心步骤。
 *
 * 单独抽成函数是为了能被测试直接驱动：并发写盘和「边写边算 md5」这两件事一旦
 * 写错，后果是把游戏文件写坏，不能只靠肉眼跑一遍。
 *
 * 校验规则：chunk 按 offset 排好后若能首尾相接铺满整个文件，就在写入过程中
 * 增量算 md5，省掉最后再把整文件读一遍（30GB 的更新等于少读 30GB）；
 * 铺不满就用整文件 md5 兜底；增量结果对不上时再复核一次，避免清单 offset
 * 不规范时误删文件。
 *
 * @param {object} file 清单项：{ file, size, md5, chunks, chunkPrefix }
 * @param {object} ctx  { installRoot, chunkDir, hasCache, signal, onChunk }
 *                      onChunk({ bytes, reused }) 每个 chunk 落盘后回调
 */
async function assembleFile(file, ctx) {
  const target = safeJoin(ctx.installRoot, file.file);
  if (await quickFileMatches(file, target)) {
    ctx.onChunk?.({ bytes: file.size, reused: false, skippedFile: true });
    return { applied: 0, skipped: 1, reused: 0, bytes: file.size };
  }
  /*
   * 别的渠道客户端里已经有同内容文件（比如官服已经更到新版本、这里更的是国际服），
   * 直接硬链接过去：整份文件免下载，也免掉解压 + 写盘那一步。
   * 校验用 quickFileMatches，和「本地是否已就位」完全同一套口径。
   */
  if (ctx.linkSources?.length) {
    const reused = await linkSource.reuseFromSources({
      file,
      target,
      gameKey: ctx.gameKey,
      sources: ctx.linkSources,
      match: (candidate) => quickFileMatches(file, candidate),
    });
    if (reused.ok) {
      ctx.onChunk?.({ bytes: file.size, reused: false, linkedFile: true });
      return { applied: 1, skipped: 0, reused: 0, bytes: file.size, linked: 1 };
    }
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.pd_tmp`;
  await fsp.rm(tmp, { force: true });

  const chunks = [...file.chunks].sort((a, b) => Number(a.offset) - Number(b.offset));
  const contiguous = chunks.every((chunk, index) =>
    index === 0
      ? Number(chunk.offset) === 0
      : Number(chunk.offset) ===
        Number(chunks[index - 1].offset) + Number(chunks[index - 1].uncompressedSize || 0)
  );
  const hash = contiguous ? crypto.createHash('md5') : null;

  let bytes = 0;
  let reused = 0;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.truncate(file.size);
    for (const chunk of chunks) {
      // 大文件里也要能响应停止：以前只在文件之间检查，单个 4GB 的包点停要等很久
      throwIfCancelled(ctx.signal);
      await waitIfPaused(ctx.signal);
      const entry = {
        ...chunk,
        url: `${file.chunkPrefix}/${chunk.id}`,
        compressedMd5: String(chunk.compressedMd5 || '').toLowerCase(),
        uncompressedMd5: String(chunk.uncompressedMd5 || '').toLowerCase(),
      };
      let raw = ctx.hasCache ? await readCachedChunk(ctx.chunkDir, entry) : null;
      const fromCatalog = Boolean(raw);
      let fromLocalFile = false;
      if (raw) {
        reused += 1;
      } else {
        /*
         * 再试一次「本地旧文件里的同一个分块」。
         *
         * chunk/ 里只有这一次预下载**新下**的块（星铁 12171 个），差量里没变的那些块
         * （94430 个）从来没有落进 chunk/；不补这一级，apply 就会把它们全当缺块联网重下，
         * 于是「预下载 12.70G」之后再追加 10.48G。
         *
         * 这里读的是**还没被改写的旧文件**：本函数先把内容写进 `.pd_tmp`，最后才
         * rename 覆盖目标，所以组装期间目标文件原样可读。readLocalChunk 自带
         * 「size 相等 + md5 相符」双校验，读不到或不符都返回 null，退回联网下载 ——
         * 复用失败只会慢，不会写坏文件。
         */
        const localEntry = ctx.localChunks?.get(entry.uncompressedMd5);
        if (localEntry && ctx.localChunkBase) {
          /*
           * 这里**不复用读句柄**，每次开、读完立刻关。
           *
           * 16 路并发下，本文件要读的本地字节很可能落在另一个工人正在重写的文件里。
           * 句柄一旦跨工人持有，别人走到最后一步 `rm target` + `rename` 时就会撞上
           * Windows 的占用/删除待决，轻则白报错、重则整次 apply 中断。
           * 每次开合的成本是每个块一次 open/close（十万级、几十秒量级），
           * 相比它换掉的「联网重下十几 GB」可以忽略；正确性优先。
           */
          const handles = new Map();
          try {
            raw = await readLocalChunk(ctx.localChunkBase, localEntry, chunk, handles);
          } finally {
            for (const pending of handles.values()) {
              try {
                await (await pending).close();
              } catch {
                /* 没打开成功或已关闭，忽略 */
              }
            }
          }
          if (raw) {
            fromLocalFile = true;
            reused += 1;
          }
        }
      }
      if (!raw) raw = await fetchChunk(entry, ctx.signal);
      await handle.write(raw, 0, raw.length, chunk.offset);
      if (hash) hash.update(raw);
      bytes += chunk.uncompressedSize || raw.length;
      ctx.onChunk?.({
        bytes: chunk.uncompressedSize || raw.length,
        reused: fromCatalog || fromLocalFile,
      });
    }
  } finally {
    await handle.close();
  }

  let actual = hash ? hash.digest('hex') : await md5File(tmp);
  const expected = String(file.md5 || '').toLowerCase();
  if (expected && actual !== expected) {
    // 增量哈希对不上：整文件复核一次，真错才删
    actual = await md5File(tmp);
    if (actual !== expected) {
      await fsp.rm(tmp, { force: true });
      throw new Error(`文件校验失败：${file.file}`);
    }
  }
  await replaceFileAtomic(tmp, target);
  return { applied: 1, skipped: 0, reused, bytes };
}

/**
 * 正式版上线后应用预下载产物。
 *
 * 用 main 分支的清单把每个文件重新组装一遍：chunk/ 里能命中的直接解压复用（0 流量），
 * 缺的才联网补下；整文件 MD5 通过才覆盖目标文件。
 * 只有走到最后一步（全部文件校验通过）才会改 config.ini 和清理 chunk/，
 * 中途任何一步失败都保持原状，下次可以接着来。
 */
async function applyHoyoPredownload({
  gameKey,
  channel,
  installRoot,
  cacheDir,
  audioLanguages,
  includeCategory,
  signal,
  onProgress,
  // 同一台机器上别的渠道客户端的根目录：内容相同的文件直接硬链接，不再下载
  linkSources = [],
}) {
  if (!supported(gameKey)) throw new Error('这个游戏不支持米哈游预下载');
  const base = await inspect({
    gameKey,
    channel,
    installRoot,
    audioLanguages,
    cacheDir,
    includeCategory,
    onProgress,
  });
  if (base.state === 'not-installed') {
    throw new Error('没有读到本地版本号，无法应用更新');
  }
  const dir = chunkDirOf(installRoot);
  const patchDir = patchDirOf(installRoot);
  const hasCache = fs.existsSync(dir);
  const hasPatches = fs.existsSync(patchDir);
  /*
   * 必须等官方新版本正式上线（main 分支版本比本地新）才能应用。
   * 预下载只是把新版本的 chunk 提前缓存到 chunk/，游戏本体此时还是旧版本；
   * 提前点「应用」只会按旧版本把缓存重建一遍、再把 chunk/ 清掉，既不会让游戏
   * 变成新版本，又把刚下好的预下载内容报废，等于白下。所以这里拦下来保住缓存，
   * 等官方上线（check 状态变成 update）再点应用。
   */
  if (compareVersion(base.latestVersion, base.localVersion) <= 0) {
    if (hasCache || hasPatches) {
      throw new Error(
        '新版本还没正式发布，现在「应用」只会清掉已下好的预下载内容、游戏也不会变新。' +
          '请等官方上线后（启动器提示「应用官方更新」，或预下载状态变成「正式版已上线」）再来点应用。'
      );
    }
    throw new Error('没有找到预下载内容，而且官方也还没发布新版本');
  }

  onProgress?.({ phase: 'version', current: `目标版本 ${base.latestVersion}` });
  const build = await fetchBuild(base.info, base.branch.main, '');
  const files = new Map();
  const manifests = pickManifests(build, audioLanguages, {
    includeCategory: base.includeCategory,
  });
  const lists = await ensureManifests(manifests, cacheDir, onProgress, { label: '读取清单', signal });
  throwIfCancelled(signal);
  // 官方黑名单：apply 侧同样跳过（否则预下载不下了，正式应用时又补下回来）
  const deletedAssets = loadDeletedAssets(installRoot, gameKey);
  let deletedSkipped = 0;
  for (let index = 0; index < manifests.length; index += 1) {
    const list = lists[index];
    const prefix = String(manifests[index].chunk_download?.url_prefix || '').replace(/\/$/, '');
    const matchingField = manifests[index].matching_field;
    for (const item of list) {
      if (!item.file || files.has(item.file)) continue;
      if (isDeletedAsset(deletedAssets, { file: item.file, matchingField })) {
        deletedSkipped += 1;
        continue;
      }
      files.set(item.file, { ...item, chunkPrefix: prefix });
    }
  }
  if (deletedSkipped > 0) {
    onProgress?.({
      phase: 'install',
      current: `官方清单标了 ${deletedSkipped} 个资源本次不用下，已跳过`,
      deletedSkipped,
    });
  }

  const normalized = [...files.values()].filter((file) => !file.isFolder && file.chunks?.length);
  /*
   * 按体积从大到小排（LPT 调度），不是按文件名。
   *
   * 16 个工人领活，最后总会剩几个尾巴；尾巴如果是个 2 GB 的大文件，那 15 个工人
   * 早就空了，只剩 1 条在跑 —— 这一段就是纯串行，几 GB 能拖出好几分钟。
   * 先把大文件铺开，小文件自然填进空档，收尾时大家几乎同时结束。
   * 同体积按文件名兜底，保证每次跑的调度顺序一致、便于对比。
   */
  normalized.sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
  const totalBytes = normalized.reduce((sum, file) => sum + file.size, 0);

  let processed = 0;
  let applied = 0;
  let skipped = 0;
  let reusedChunks = 0;
  let linkedFiles = 0;
  let bytesDone = 0;

  // 只有同盘的源才可能硬链接，跨盘的在这里就筛掉
  const externalRoots = linkSource.usableSources(linkSources, {
    targetRoot: installRoot,
    excludeRoots: [],
  });

  /*
   * 并发度默认 16。
   *
   * 这一步的耗时几乎全在「读 chunk 缓存 → zstd 解压 → md5 → 写盘」这条链上。
   * 单路串行时磁盘队列深度只有 1，随机读的寻道开销全压进关键路径 —— 实测机械盘
   * 只有 13~29 MB/s，两万个 chunk 走下来要一个多小时。文件之间并行能把队列压深，
   * 也能让 CPU 解压和磁盘 IO 重叠起来。
   *
   * 16 路是这一版定下的默认值。同机实测（600 个 400KB 文件 / 234MB，chunk 已缓存）：
   *   NVMe  1 路 46.8 → 4 路 96.6 → 8 路 116.1 → 16 路 117.7 MB/s（16 路是 4 路的 1.22×）
   *   机械   1 路 23.5 → 4 路 35.7 → 8 路 105.2 → 16 路 131.2 MB/s（16 路是 4 路的 3.68×）
   * 机械盘上 16 路收益反而最大：小文件随机读靠队列深度把磁头调度填满，4 路只有一条队伍。
   * NVMe 上 8 路已经接近饱和，16 路再多约 1~2%，不会亏。
   * 极端情况下（盘本身很慢、并发反而抖动）可以用 HXL_APPLY_CONCURRENCY 退回 4。
   *
   * 注意：光加文件级并发不够 —— 异步 zstd 跑在 libuv 线程池里，线程池默认只有
   * 4 条，16 路并发会全部堵在解压上。main.js 启动时已把 UV_THREADPOOL_SIZE
   * 提到 16（见那里的注释），两处要一起看。
   */
  const concurrency = Math.max(1, Math.min(32, Number(process.env.HXL_APPLY_CONCURRENCY) || 16));
  let cursor = 0;
  /*
   * 进度节流：一个块发一条 IPC 的话，两万多个块就是两万多条消息，渲染层光处理
   * 事件就够卡。120ms 一条足够顺滑；每个文件写完强制补一条，保证计数不丢。
   */
  let lastReportAt = 0;
  const report = (file, force) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 120) return;
    lastReportAt = now;
    onProgress?.({
      phase: 'install',
      processed,
      total: normalized.length,
      applied,
      skipped,
      reusedChunks,
      bytesDone,
      totalBytes,
      current: file.file,
    });
  };

  /*
   * 空间守卫：装配是「解压缓存 → 写 .pd_tmp → rename」，临时文件还在时新旧两份
   * 会同时存在，所以每个文件都要额外占一份目标大小的空间。缓存目录和安装目录
   * 可能不在同一个卷上，两个都盯。空间不够就在这里停，别等 ENOSPC 落到半截文件上。
   */
  const spaceGuard = diskSpace.createSpaceGuard({
    dirs: [installRoot, dir],
    label: '游戏所在盘',
    reserveBytes: 256 * 1024 ** 2,
  });

  /*
   * 本地旧版本的分块索引：差量里没变的块可以按 offset 直接从本地旧文件读出来，
   * 不必联网重下。这是「预下载完再点更新」不至于比直接更新还多下一倍的关键一级。
   *
   * 必须用**和预下载/正式更新同一套 includeStory 口径**建索引，否则两边文件集合
   * 对不上、该复用的块找不到源。建索引失败不致命（返回空 Map + reason）：
   * 退化成纯 chunk 组装，只是重新变慢，不会写坏任何文件。
   */
  let localChunks = new Map();
  try {
    const built = await loadLocalChunkIndex({
      gameKey,
      baseRoot: installRoot,
      cacheDir,
      onProgress,
      signal,
      audioLanguages,
      includeStory: base.includeCategory === true,
    });
    localChunks = built.index || new Map();
    if (built.reason) {
      onProgress?.({ phase: 'install', current: `本地复用不可用：${built.reason}` });
    }
  } catch (error) {
    onProgress?.({ phase: 'install', current: `本地复用不可用：${error.message}` });
  }

  /*
   * 预下载存下来的补丁包，在这里就地打完。
   *
   * 顺序很关键：必须**在索引建好之后、16 路工人开工之前**一次跑完。
   *   1. 索引是在本地旧文件上建的，补丁会把文件 rm + rename 换成新内容，
   *      索引一旦失效，那些「没变的块」就找不到源、又得联网重下 —— 白下；
   *   2. 补丁阶段和 16 路并发组装同时进行的话，会互相踩同一个目标文件
   *      （Windows 上还会撞「删除待决」），必须串行。
   * 打完补丁，assembleFile 里 quickFileMatches 会把这些文件判成 skipped，
   * 剩下的才轮到 chunk 缓存 / 本地旧块 / 联网。
   */
  let patchApplied = 0;
  let patchFailed = 0;
  if (hasPatches) {
    try {
      const prepass = await hdiff.applyHdiffPrepass({
        gameKey,
        channel,
        installRoot,
        cacheDir,
        audioLanguages,
        includeStory: base.includeCategory === true,
        patchRoot: patchDir,
        onProgress,
        signal,
        linkSources,
      });
      if (prepass?.ok) {
        patchApplied = prepass.applied || 0;
        patchFailed = prepass.failed || 0;
        if (prepass.reason) {
          onProgress?.({ phase: 'install', current: `补丁包未应用：${prepass.reason}` });
        }
      }
    } catch (error) {
      // 补丁失败不致命：没打上的文件照样能走 chunk 重下，只是慢一点，不会写坏东西
      onProgress?.({ phase: 'install', current: `补丁包应用失败，改走分块：${error.message}` });
    }
  }

  const applyOne = async (file) => {
    const result = await assembleFile(file, {
      installRoot,
      chunkDir: dir,
      hasCache,
      signal,
      gameKey,
      linkSources: externalRoots,
      localChunkBase: installRoot,
      localChunks,
      onChunk: (delta) => {
        bytesDone += delta.bytes;
        if (delta.reused) reusedChunks += 1;
        report(file, false);
      },
    });
    applied += result.applied;
    skipped += result.skipped;
    if (result.linked) linkedFiles += 1;
    processed += 1;
    report(file, true);
  };

  /*
   * 一路失败就让其余几路收手。
   *
   * 16 路并发时如果不设闸，界面已经弹「更新失败」，后台剩下的工人还在下分块、还在写盘；
   * 用户马上点重试，两个工人池就可能同时往同一个 .pd_tmp 里写。已经在跑的那个文件
   * 没法中途掐断（要按 offset 写完），但排队的必须立刻退出。
   */
  let fatalError = null;
  const workerCount = Math.max(1, Math.min(concurrency, normalized.length));
  const workers = [];
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(
      (async () => {
        while (true) {
          if (fatalError) return;
          const next = cursor;
          cursor += 1;
          if (next >= normalized.length) return;
          try {
            // 装配前复查空间：这个文件要额外占一份，装不下就整条停下并说明差多少
            await spaceGuard.check(normalized[next].size || 0);
            await applyOne(normalized[next]);
          } catch (error) {
            if (!fatalError) fatalError = error || new Error('应用预下载失败');
            throw error;
          }
        }
      })()
    );
  }
  await Promise.all(workers);
  // 收尾强制一条满进度，别让界面停在最后一个节流点（比如 99%）
  onProgress?.({
    phase: 'install',
    processed: normalized.length,
    total: normalized.length,
    applied,
    skipped,
    reusedChunks,
    bytesDone: totalBytes,
    totalBytes,
    current: '',
  });

  // 全部文件都过了才动版本号和清理，避免半套更新把游戏写坏。
  await setConfigIniValue(installRoot, 'game_version', base.latestVersion);
  await setConfigIniValue(installRoot, 'predownload', '');
  await clearHoyoPredownloadFiles(installRoot);
  return {
    ok: true,
    kind: 'hoyo',
    gameKey,
    channel,
    tag: base.latestVersion,
    applied,
    skipped,
    reusedChunks,
    // 其中有多少个文件是从别的渠道客户端硬链接过来的（没走下载）
    linkedFiles,
    files: normalized.length,
    installRoot,
  };
}

/** 删掉预下载产物：chunk/ 与 ldiff/ 目录 + 自己留下的 .pd_tmp。不碰游戏文件。 */
async function clearHoyoPredownloadFiles(installRoot) {
  await fsp.rm(chunkDirOf(installRoot), { recursive: true, force: true }).catch(() => {});
  // ldiff/ 里只有我们自己下下来的补丁包，没有游戏文件，整目录可以删
  await fsp.rm(patchDirOf(installRoot), { recursive: true, force: true }).catch(() => {});
  await sweepTempFiles(installRoot).catch(() => {});
  return true;
}

async function sweepTempFiles(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === CHUNK_DIR) continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.pd_tmp')) {
        await fsp.rm(full, { force: true }).catch(() => {});
      }
    }
  }
}

async function clearHoyoPredownload({ installRoot }) {
  if (!installRoot) throw new Error('缺少游戏目录');
  await clearHoyoPredownloadFiles(installRoot);
  await setConfigIniValue(installRoot, 'predownload', '');
  return { ok: true, installRoot };
}

module.exports = {
  HOYO_GAME_KEYS,
  supported,
  checkHoyoPredownload,
  startHoyoPredownload,
  applyHoyoPredownload,
  assembleFile,
  clearHoyoPredownload,
  chunkDirOf,
  patchDirOf,
  measureStoredChunks,
  compareVersion,
  readGameVersion,
  classifyManifests,
  summarizeManifests,
  fmtBytes,
};
