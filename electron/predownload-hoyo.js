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

const { CHANNELS, decodeManifest, normalizeAudioLanguages, AUDIO_LANGUAGES } = require('./sophon');

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

function throwIfCancelled(signal) {
  if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
}

async function fetchJson(url, init) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
    ...init,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}：${url}`);
  const json = await response.json();
  if (json.retcode !== 0) throw new Error(json.message || `接口返回 ${json.retcode}`);
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

/** 清单（protobuf）下载 → zstd 解压 → 解压后 MD5 校验 → 解析。带本地缓存。 */
async function loadManifest(manifest, cacheDir, onProgress) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, manifest.manifest.id);
  let compressed = null;
  try {
    compressed = await fsp.readFile(cacheFile);
  } catch {
    compressed = null;
  }
  if (!compressed) {
    onProgress?.({ phase: 'manifest', current: manifest.manifest.id });
    const url = `${manifest.manifest_download.url_prefix.replace(/\/$/, '')}/${manifest.manifest.id}`;
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`下载清单失败：HTTP ${response.status}`);
    compressed = Buffer.from(await response.arrayBuffer());
    await fsp.writeFile(cacheFile, compressed);
  }
  const raw = zlib.zstdDecompressSync(compressed);
  if (manifest.manifest.checksum && md5(raw) !== manifest.manifest.checksum.toLowerCase()) {
    throw new Error('清单校验失败，缓存可能损坏');
  }
  return decodeManifest(raw);
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

function readGameVersion(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'config.ini'), 'utf8');
    return (text.match(/game_version\s*=\s*([^\r\n]+)/i) || [])[1]?.trim() || '';
  } catch {
    return '';
  }
}

function readConfigIni(root) {
  try {
    return fs.readFileSync(path.join(root, 'config.ini'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * 改 config.ini 里的某一行，其他字段（cps / channel / game_biz / sdk_version …）原样保留。
 * 预下载只改 predownload=；应用时才把 game_version 提到新版本并清空 predownload。
 */
async function setConfigIniValue(root, key, value) {
  const file = path.join(root, 'config.ini');
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    text = '';
  }
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
     * 先把 chunk/ 里已经躺着的东西数出来。
     * 预下载中途停掉、关窗、断电，产物都留在 chunk/ 里，而「下完了」的三段标记
     * 只在全部走完时才写 —— 所以没标记不等于没有进度。界面要能说出
     * 「已经下了多少、接着来能省多少」，全靠这两个数字，所有分支都带上。
     */
    const stored = await measureStoredChunks(dir);
    const answer = {
      supported: true,
      kind: 'hoyo',
      mode: 'chunk',
      dir,
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
    const sizes = await summarizeFor(base, base.branch.pre_download);
    const saved = (readConfigIni(installRoot).match(/^\s*predownload\s*=\s*([^\r\n]*)$/im) || [])[1] || '';
    const meta = await readMeta(installRoot);
    const marked = saved.trim() === marker(localVersion, targetVersion, audioLanguages);
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
    // 标记对了还要看东西还在不在：chunk/ 被人删了就是白标。
    if (!stored.files) return { ...answer, ...sizes, state: 'available' };
    const report = {
      ...answer,
      ...sizes,
      state: 'done',
      completed: true,
      expectedChunks: meta?.chunkCount || 0,
    };
    if (!verify) return report;
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
    for (const manifest of manifests) {
      const files = await loadManifest(manifest, base.cacheDir);
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
      await fsp.rm(target, { force: true });
      await fsp.rename(tmp, target);
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
  for (const manifest of pickManifests(build, audioLanguages, options)) {
    throwIfCancelled(signal);
    const files = await loadManifest(manifest, cacheDir, onProgress);
    const prefix = String(manifest.chunk_download?.url_prefix || '').replace(/\/$/, '');
    if (!prefix) continue;
    for (const file of files) {
      if (!file.file) continue;
      for (const chunk of file.chunks || []) {
        if (!chunk.id || chunks.has(chunk.id)) continue;
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
  const targetChunks = await collectChunks(targetBuild, cacheDir, audioLanguages, onProgress, signal, scope);

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
  for (const chunk of needed) {
    await waitIfPaused(signal);
    throwIfCancelled(signal);
    const target = path.join(dir, chunk.id);
    processed += 1;
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
      onProgress?.({
        phase: 'download',
        current: chunk.id,
        processed,
        total: needed.length,
        skipped,
        bytesDone,
        totalBytes,
      });
      continue;
    }
    await downloadChunkFile(chunk.url, target, chunk.compressedSize, chunk.compressedMd5, signal, (delta) => {
      bytesDone += delta;
      onProgress?.({
        phase: 'download',
        current: chunk.id,
        processed,
        total: needed.length,
        skipped,
        bytesDone,
        totalBytes,
      });
    });
    onProgress?.({
      phase: 'download',
      current: chunk.id,
      processed,
      total: needed.length,
      skipped,
      bytesDone,
      totalBytes,
    });
  }

  await setConfigIniValue(installRoot, 'predownload', marker(base.localVersion, base.targetVersion, audioLanguages));
  await writeMeta(installRoot, {
    localVersion: base.localVersion,
    targetVersion: base.targetVersion,
    audioKey: audioKey(audioLanguages),
    includeCategory: base.includeCategory,
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
    const raw = zlib.zstdDecompressSync(compressed);
    if (chunk.uncompressedMd5 && md5(raw) !== chunk.uncompressedMd5) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 联网下载并解压一个 chunk。 */
async function fetchChunk(chunk, signal) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitIfPaused(signal);
    throwIfCancelled(signal);
    try {
      const response = await fetch(chunk.url, {
        headers: { 'user-agent': UA, accept: '*/*' },
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const compressed = Buffer.from(await response.arrayBuffer());
      if (chunk.compressedMd5 && md5(compressed) !== chunk.compressedMd5) {
        throw new Error('分块压缩数据校验失败');
      }
      const raw = zlib.zstdDecompressSync(compressed);
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
  const hasCache = fs.existsSync(dir);
  if (!hasCache && compareVersion(base.latestVersion, base.localVersion) <= 0) {
    throw new Error('没有找到预下载内容，而且官方也没发布新版本');
  }

  onProgress?.({ phase: 'version', current: `目标版本 ${base.latestVersion}` });
  const build = await fetchBuild(base.info, base.branch.main, '');
  const files = new Map();
  for (const manifest of pickManifests(build, audioLanguages, {
    includeCategory: base.includeCategory,
  })) {
    throwIfCancelled(signal);
    const list = await loadManifest(manifest, cacheDir, onProgress);
    const prefix = String(manifest.chunk_download?.url_prefix || '').replace(/\/$/, '');
    for (const item of list) {
      if (!item.file || files.has(item.file)) continue;
      files.set(item.file, { ...item, chunkPrefix: prefix });
    }
  }

  const normalized = [...files.values()].filter((file) => !file.isFolder && file.chunks?.length);
  normalized.sort((a, b) => a.file.localeCompare(b.file));
  const totalBytes = normalized.reduce((sum, file) => sum + file.size, 0);

  let processed = 0;
  let applied = 0;
  let skipped = 0;
  let reusedChunks = 0;
  let bytesDone = 0;

  for (const file of normalized) {
    await waitIfPaused(signal);
    throwIfCancelled(signal);
    processed += 1;
    const target = safeJoin(installRoot, file.file);
    if (await quickFileMatches(file, target)) {
      skipped += 1;
      bytesDone += file.size;
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
      continue;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.pd_tmp`;
    await fsp.rm(tmp, { force: true });
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.truncate(file.size);
      for (const chunk of file.chunks) {
        const entry = {
          ...chunk,
          url: `${file.chunkPrefix}/${chunk.id}`,
          compressedMd5: String(chunk.compressedMd5 || '').toLowerCase(),
          uncompressedMd5: String(chunk.uncompressedMd5 || '').toLowerCase(),
        };
        let raw = hasCache ? await readCachedChunk(dir, entry) : null;
        if (raw) {
          reusedChunks += 1;
        } else {
          raw = await fetchChunk(entry, signal);
        }
        await handle.write(raw, 0, raw.length, chunk.offset);
        bytesDone += chunk.uncompressedSize || raw.length;
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
      }
    } finally {
      await handle.close();
    }
    const actual = await md5File(tmp);
    if (String(file.md5 || '').toLowerCase() && actual !== String(file.md5).toLowerCase()) {
      await fsp.rm(tmp, { force: true });
      throw new Error(`文件校验失败：${file.file}`);
    }
    await fsp.rm(target, { force: true });
    await fsp.rename(tmp, target);
    applied += 1;
  }

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
    files: normalized.length,
    installRoot,
  };
}

/** 删掉预下载产物：chunk/ 目录 + 自己留下的 .pd_tmp。不碰游戏文件。 */
async function clearHoyoPredownloadFiles(installRoot) {
  await fsp.rm(chunkDirOf(installRoot), { recursive: true, force: true }).catch(() => {});
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
  clearHoyoPredownload,
  chunkDirOf,
  measureStoredChunks,
  compareVersion,
  readGameVersion,
  classifyManifests,
  summarizeManifests,
  fmtBytes,
};
