'use strict';

/**
 * 异环 启动器侧资源预下载（官服 / B服 通用）。
 *
 * 体系逆向自官方 CDN 并已实测验证（2026-10-29）：
 *   1. Config.ini [VERSION] VersionInfoFileURL = .../publish_ob[_B]/launcher/Version.ini
 *   2. Version.ini → Version / Build / FileListURL（.../launcher/<版本>_N/AllFiles.xml）
 *   3. AllFiles.xml（约 130KB）→ <File Checksum Path Size ZipChecksum ZipSize/> 逐文件清单
 *   4. 文件实体 = <FileListURL 所在目录>/<Path>.zip —— 标准 zip 单条目，
 *      zip 本身 MD5 = ZipChecksum，解压后 MD5 = Checksum，落盘到 <安装根>/NTELauncher/<Path>。
 * 全部铺好后，官方启动器启动时没有"下载"环节（游戏本体两服共用 Client 目录，不在此列；
 * 本体更新走 Patcher 机制，仍由官方启动器正常拉，属于普通游戏更新）。
 *
 * 安全边界：只新增/覆盖清单里列出的文件，绝不删除任何本地文件；路径带 .. 直接拒绝。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');

const { httpFetch } = require('./http-fetch');
// 异环的 Config.ini 实测是 UTF-16LE，按 utf8 读出来是乱码 —— 统一走这个解码器
const { readIniText } = require('./client-channel');
const diskSpace = require('./disk-space');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 逐段比较版本号：a 比 b 新返回 1，一样返回 0，更旧返回 -1。 */
function compareVersion(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.\-+_]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split(/[.\-+_]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 异环这里能更新的只有 NTELauncher 那部分资源，游戏本体不在范围内。
 * 带出去给界面用，免得按钮写成「更新游戏」让人以为本体也能装。
 */
const NTE_SCOPE_LAUNCHER = 'launcher';

/**
 * 「本体预下载」的边界标记：官方放出了下一版，但资源只有官方启动器能下。
 * 带上它，界面就不会把这条说成「我们能替你下」，也不会把按钮接到我们自己的下载器上。
 */
const NTE_SCOPE_OFFICIAL = 'official';

/** 找 Config.ini（复用 neverness-channels 的查找逻辑，避免两份实现）。 */
function findConfigRoot(startPath, levels = 8) {
  let dir = startPath;
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  } catch {
    /* keep going */
  }
  for (let level = 0; level < levels && dir; level += 1) {
    const candidate = path.join(dir, 'NTELauncher', 'Config', 'Config.ini');
    if (fs.existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/**
 * 读启动器 Config.ini。异环这份是 UTF-16LE，直接 readFile(..., 'utf8') 得到乱码，
 * 所有 `^Key=value$` 都匹配不上 —— 走 client-channel 的编码自适应解码。
 */
function readLauncherIni(root) {
  try {
    return readIniText(path.join(root, 'NTELauncher', 'Config', 'Config.ini'));
  } catch {
    return '';
  }
}

/**
 * 本体资源的分发参数：gameResUrl + branchName + appId。
 *
 * 全部来自官方自己维护的 <安装根>/NTELauncher/ResFilesM/<appId>/PatcherConfig/PatcherConfig.json。
 * 跟着它读而不是写死，官方换 CDN、换分支名我们不用改代码。
 */
function readPatcherTarget(root) {
  const resDir = path.join(root, 'NTELauncher', 'ResFilesM');
  const ini = readLauncherIni(root);
  const appId = (ini.match(/^GameID=(\d+)$/m) || [])[1] || '';
  let ids = appId ? [appId] : [];
  if (!ids.length) {
    try {
      ids = fs.readdirSync(resDir).filter((name) => /^\d+$/.test(name));
    } catch {
      ids = [];
    }
  }
  for (const id of ids) {
    const file = path.join(resDir, id, 'PatcherConfig', 'PatcherConfig.json');
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const urls = []
        .concat(Array.isArray(data.gameResUrl) ? data.gameResUrl : [data.gameResUrl])
        .filter(Boolean)
        .map((url) => String(url).trim().replace(/\/+$/, ''));
      if (!urls.length) continue;
      return {
        appId: String(data.appId || id),
        urls,
        branch: String(data.branchName || ''),
      };
    } catch {
      /* 换下一个 appId 试 */
    }
  }
  return null;
}

/**
 * 本地已装的本体资源版本 / 分支。
 * PatcherSDK/config.xml 是官方自己写的状态文件：LocalBranch=PC_140、ResVersion=1.4.18。
 */
function readLocalResVersion(root) {
  const file = path.join(root, 'NTELauncher', 'UserData', 'Patcher', 'PatcherSDK', 'config.xml');
  try {
    const xml = fs.readFileSync(file, 'utf8');
    return {
      branch: (xml.match(/<LocalBranch>([^<]*)<\/LocalBranch>/) || [])[1]?.trim() || '',
      version: (xml.match(/<ResVersion>([^<]*)<\/ResVersion>/) || [])[1]?.trim() || '',
    };
  } catch {
    return { branch: '', version: '' };
  }
}

/**
 * 解析分支配置（config.xml）。
 *
 * 顶层 <ResSize>数字</ResSize> 与 <BaseVerson> 里的 ResSize="…" 属性是两回事，
 * 所以这里只认带尖括号的标签形态。
 */
function parseBranchConfig(xml) {
  const tag = (name) => (xml.match(new RegExp(`<${name}>([^<]*)</${name}>`)) || [])[1]?.trim() || '';
  return {
    section: tag('Section'),
    resVersion: tag('ResVersion'),
    resSize: Number(tag('ResSize')) || 0,
    preReleaseBranch: tag('PreReleaseBranch'),
    preReleaseVersion: tag('PreReleaseVersion'),
    preReleaseStatus: tag('PreReleaseStatus'),
  };
}

/*
 * 版本清单和文件清单都很小（Version.ini 几百字节、AllFiles.xml 约 130 KB），
 * 但「检查有没有预下载」和「开始预下载」会各读一遍 —— 60 秒内同一地址只请求一次。
 */
const TEXT_MEMO_MS = 60 * 1000;
const textMemo = new Map();

async function fetchText(url, signal) {
  const hit = textMemo.get(url);
  if (hit && Date.now() - hit.at < TEXT_MEMO_MS) return hit.text;
  const response = await httpFetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const text = await response.text();
  textMemo.set(url, { at: Date.now(), text });
  while (textMemo.size > 8) textMemo.delete(textMemo.keys().next().value);
  return text;
}

async function fetchBuffer(url, signal) {
  const response = await httpFetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * 查官方有没有开放「游戏本体」的预下载。
 *
 * 数据源（2026-11-05 实测）：
 *   {gameResUrl}/{本地分支}/Version/Windows/config.xml   ← 公开，无需登录
 *   → <PreReleaseBranch>PC_150</PreReleaseBranch>
 *     <PreReleaseVersion>1.5.0</PreReleaseVersion>
 *     <PreReleaseStatus>start</PreReleaseStatus>
 *   与本地 PatcherSDK/config.xml 的 <ResVersion>1.4.18</ResVersion> 比，远程更新即「有预下载」。
 *
 * 为什么只能「检测」不能「下载」：
 *   资源实体走 PatcherSDK 的 prerelease 通道，下载地址由登录态换来的腾讯云 STS 临时密钥
 *   动态签名（PatcherSDK 里 request sts failed for not login error），匿名直连一律 404；
 *   清单（ResList.xml / client.xml）还是 PatcherXML0 私有加密格式，落盘后要过 .sig 验签。
 *   所以这里只负责「发现 + 提醒 + 拉起官方」，真正的下载仍由官方启动器完成。
 */
async function checkPreRelease({ installRoot, signal } = {}) {
  const root = findConfigRoot(installRoot);
  if (!root) return { ok: false, reason: '没有找到异环安装目录（NTELauncher/Config/Config.ini）' };

  const target = readPatcherTarget(root);
  const local = readLocalResVersion(root);
  if (!target) {
    return { ok: false, reason: '没有找到本体资源分发配置（ResFilesM/*/PatcherConfig/PatcherConfig.json）', localVersion: local.version };
  }

  const branch = local.branch || target.branch;
  if (!branch) return { ok: false, reason: '没有读到异环的资源分支（LocalBranch）', localVersion: local.version };

  let lastError = '';
  for (const base of target.urls) {
    const url = `${base}/${branch}/Version/Windows/config.xml`;
    try {
      const xml = await fetchText(url, signal);
      const parsed = parseBranchConfig(xml);
      const status = String(parsed.preReleaseStatus || '').toLowerCase();
      /*
       * 判定顺序很重要：
       *   · 远端的 ResVersion（正式分支最新）比本地新 → 正式更新已上线，不是预下载；
       *   · PreReleaseVersion 比本地新 + 状态不是 end/close → 预下载开放中。
       * 只比字面不同会把「官方改了命名」当成有预下载，所以统一走 compareVersion。
       */
      const officialNewer = Boolean(parsed.resVersion) && Boolean(local.version) && compareVersion(parsed.resVersion, local.version) > 0;
      /*
       * 本地版本读不出来时不能判「有预下载」：compareVersion('1.5.0','') 会把空版本当 0，
       * 结果是 every 台刚装好、还没跑过一次官方启动器的机器都弹「预下载 1.5.0」。
       */
      const preNewer =
        Boolean(parsed.preReleaseVersion) &&
        Boolean(local.version) &&
        compareVersion(parsed.preReleaseVersion, local.version) > 0;
      const statusOpen = status !== 'end' && status !== 'close' && status !== 'closed' && status !== 'stop';
      return {
        ok: true,
        installRoot: root,
        appId: target.appId,
        branch,
        localVersion: local.version,
        officialVersion: parsed.resVersion,
        officialAvailable: officialNewer,
        preReleaseBranch: parsed.preReleaseBranch,
        preReleaseVersion: parsed.preReleaseVersion,
        preReleaseStatus: parsed.preReleaseStatus,
        available: preNewer && statusOpen,
        bytes: parsed.resSize,
        source: url,
      };
    } catch (error) {
      lastError = error.message;
    }
  }
  return { ok: false, reason: `读取异环资源分支配置失败：${lastError || '未知原因'}`, localVersion: local.version };
}

/**
 * 官方启动器 / 更新器 / 游戏本体是否在跑。
 *
 * 我们「更新启动器」要整份替换 NTELauncher 目录里的 exe/dll —— 官方进程正开着的时候
 * 替换，轻则写不进去，重则把它正在用的文件写到一半，更新直接坏掉。宁可让用户等十几秒。
 * 查 tasklist 失败（返回空）时按「没在跑」处理：不能因为查不到进程就把更新挡死。
 */
const NTE_OFFICIAL_IMAGES = ['NTEGame.exe', 'NTEUpdate.exe', 'HTGame.exe'];

function officialBusy() {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 8000 },
      (error, stdout) => {
        if (error) return resolve('');
        const text = String(stdout || '');
        const hits = NTE_OFFICIAL_IMAGES.filter((name) =>
          new RegExp(`^"${name.replace(/\./g, '\\.')}"`, 'im').test(text)
        );
        resolve(hits.join('、'));
      }
    );
  });
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 解析 AllFiles.xml 的 <File .../> 清单，只要四个属性。 */
function parseAllFiles(xml) {
  const files = [];
  const pattern = /<File\s+([^>]*?)\/>/g;
  const attr = (text, name) => {
    const hit = text.match(new RegExp(`${name}="([^"]*)"`));
    return hit ? hit[1] : '';
  };
  let match;
  while ((match = pattern.exec(xml))) {
    const text = match[1];
    const filePath = attr(text, 'Path');
    if (!filePath) continue;
    files.push({
      path: filePath,
      size: Number(attr(text, 'Size')) || 0,
      checksum: attr(text, 'Checksum').toLowerCase(),
      zipChecksum: attr(text, 'ZipChecksum').toLowerCase(),
    });
  }
  return files;
}

/**
 * 解压"单条目 zip"：找 EOCD → 中央目录 → 本地头，method 8 走 inflateRaw，0 直接截取。
 * 只有一个条目、无加密的官方 zip 用这套足够；完整性由外层 MD5 校验兜底。
 */
function unzipSingleEntry(buffer) {
  const eocdIndex = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdIndex < 0) throw new Error('zip 结构异常（找不到 EOCD）');
  const cdOffset = buffer.readUInt32LE(eocdIndex + 16);
  const entries = buffer.readUInt16LE(eocdIndex + 10);
  if (entries < 1) throw new Error('zip 里没有文件');
  // 读中央目录第一条
  if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('zip 中央目录异常');
  const method = buffer.readUInt16LE(cdOffset + 10);
  const compressedSize = buffer.readUInt32LE(cdOffset + 20);
  const nameLen = buffer.readUInt16LE(cdOffset + 28);
  const extraLen = buffer.readUInt16LE(cdOffset + 30);
  const commentLen = buffer.readUInt16LE(cdOffset + 32);
  const localOffset = buffer.readUInt32LE(cdOffset + 42);
  const localNameLen = buffer.readUInt16LE(localOffset + 26);
  const localExtraLen = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLen + localExtraLen;
  const data = buffer.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return buffer.subarray(dataStart, dataStart + compressedSize);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的 zip 压缩方式：${method}（name=${nameLen ? buffer.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen) : '?'} extra=${extraLen}）`);
}

/** 简易并发池：workers 个工人消化 tasks。 */
async function runPool(items, workers, job) {
  let index = 0;
  const runners = Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await job(current);
    }
  });
  await Promise.all(runners);
}

/**
 * 本地这份文件算不算「已经是清单里那份」。
 *
 * 关键：校验口径必须和下载落盘那边完全一致，否则会出现「每次都判不符 → 每次更新
 * 都把这个文件重下一遍，还永远修不完」。
 *
 * 官方清单里有瑕疵条目：实测 /qml/QtQuick/Controls/Styles/Flat/plugins.qmltypes
 * 声明 size=0 却配了一个非空的 md5（85f70fb2…），而空文件的 md5 恒为 d41d8cd9…，
 * 比对必然失败。下载时已经按「size 为 0 就跳过内容校验」处理了，这里必须同样处理。
 */
async function localFileMatches(file, target) {
  try {
    const stat = await fsp.stat(target);
    if (file.size && stat.size !== file.size) return false;
    if (!file.size) return true;
    if (!file.checksum) return true;
    return (await md5File(target)) === file.checksum;
  } catch {
    return false;
  }
}

/**
 * 预下载一个渠道的全部启动器侧文件。
 * @param {{installRoot:string, channel?:string, versionUrl?:string, onProgress?:Function, signal?:AbortSignal, concurrency?:number}} options
 */
async function predownload({
  installRoot,
  channel = '',
  versionUrl = '',
  onProgress = () => {},
  signal = null,
  concurrency = 3,
}) {
  const root = findConfigRoot(installRoot);
  if (!root) throw new Error('没有找到异环安装目录（NTELauncher/Config/Config.ini）');

  /*
   * 启动器侧资源要整份覆盖 NTELauncher 目录里的 exe / dll。
   * 官方启动器、更新器或游戏本体正开着的时候写进去，轻则更新失败，
   * 重则把它正在使用的文件写到一半。让用户等十几秒，比自己抢文件安全。
   */
  const busy = await officialBusy();
  if (busy) {
    throw new Error(`异环官方程序正在运行（${busy}），先退出它再更新启动器资源，别抢它正在用的文件`);
  }

  // 1. Version.ini：优先用调用方给的地址，否则从 Config.ini 读，再否则按渠道拼
  let iniUrl = versionUrl;
  if (!iniUrl) {
    // 之前这里写死 utf8：异环的 Config.ini 是 UTF-16LE，读出来是乱码，
    // VersionInfoFileURL 永远匹配不到，只能一路落到渠道兜底地址（B服会拿错清单）。
    const text = readLauncherIni(root);
    const hit = text.match(/^VersionInfoFileURL=(.+)$/m);
    if (hit) iniUrl = hit[1].trim();
  }
  if (!iniUrl && channel) {
    iniUrl = `https://yhcdn1.wmupd.com/hd/publish_ob${channel === 'bilibili' ? '_B' : ''}/launcher/Version.ini`;
  }
  if (!iniUrl) throw new Error('没有找到版本清单地址（VersionInfoFileURL）');

  onProgress({ phase: 'manifest', message: '正在读取版本清单…' });
  const versionIni = await fetchText(iniUrl, signal);
  const fileListUrl = (versionIni.match(/^FileListURL=(.+)$/m) || [])[1]?.trim();
  const version = (versionIni.match(/^Version=(.+)$/m) || [])[1]?.trim() || '';
  if (!fileListUrl) throw new Error('版本清单里没有 FileListURL');

  const xml = await fetchText(fileListUrl, signal);
  const files = parseAllFiles(xml);
  if (!files.length) throw new Error('文件清单是空的');

  // zip 实体所在的目录 = AllFiles.xml 的目录
  const zipBase = fileListUrl.replace(/[^/]*$/, '');

  // 2. 找出本地缺的/坏的文件
  //    清单 Path 相对「NTELauncher 文件夹」（channelSdk/Patcher 等都在它下面），不是安装根
  const baseDir = path.join(root, 'NTELauncher');
  onProgress({ phase: 'scan', message: '正在比对本地文件…', total: files.length });
  const need = [];
  let skipped = 0;
  for (const file of files) {
    if (signal?.aborted) throw new Error('已取消');
    if (file.path.includes('..')) continue; // 路径穿越保护
    const target = path.join(baseDir, file.path.replace(/^[/\\]/, ''));
    const ok = await localFileMatches(file, target);
    if (ok) skipped += 1;
    else need.push({ ...file, target });
  }

  // 3. 并发下载缺的文件：zip → 校验 → 解压 → 校验 → 落盘
  const result = {
    version,
    channel,
    total: files.length,
    skipped,
    downloaded: 0,
    failed: [],
    bytes: 0,
  };
  if (need.length) {
    let done = 0;
    /*
     * 空间守卫：每个文件都先写 `.nte_tmp` 再 rename，临时文件在时新旧两份同时存在，
     * 所以要按文件大小预留。空间不够就在这个文件开始前停下 —— 半截 exe 会让官方
     * 启动器直接打不开，比「空间不足，请清理」严重得多。
     */
    const spaceGuard = diskSpace.createSpaceGuard({
      dirs: [baseDir],
      label: '异环所在盘',
      reserveBytes: 128 * 1024 ** 2,
    });
    await runPool(need, concurrency, async (file) => {
      if (signal?.aborted) throw new Error('已取消');
      await spaceGuard.check(file.size || 0);
      const zipUrl = `${zipBase}${file.path.replace(/^[/\\]/, '')}.zip`;
      let temp = '';
      try {
        const zipBuffer = await fetchBuffer(zipUrl, signal);
        if (file.zipChecksum && md5(zipBuffer) !== file.zipChecksum) {
          throw new Error('压缩包校验不符');
        }
        const raw = unzipSingleEntry(zipBuffer);
        // 官方清单有瑕疵条目：0 字节空文件却配了非空 md5，空文件跳过内容校验
        if (file.checksum && file.size > 0 && md5(raw) !== file.checksum) {
          throw new Error('解压后校验不符');
        }
        await fsp.mkdir(path.dirname(file.target), { recursive: true });
        /*
         * 先写临时文件再改名。
         *
         * 这里是启动器自己的 exe / dll / 资源，直接覆盖写的话，中途断电或者用户
         * 点了停止就会留下半截文件 —— 下次虽然会按 md5 重下（能自愈），但在这之前
         * 启动器是坏的，用户只会看到「花筱灵启动器打不开」。改名是原子的，要么新的
         * 要么旧的，不存在中间态。
         */
        temp = `${file.target}.nte_tmp`;
        await fsp.writeFile(temp, raw);
        try {
          await fsp.rename(temp, file.target);
        } catch {
          await fsp.rm(file.target, { force: true });
          await fsp.rename(temp, file.target);
        }
        result.downloaded += 1;
        result.bytes += raw.length;
      } catch (error) {
        if (signal?.aborted) throw new Error('已取消');
        if (temp) await fsp.rm(temp, { force: true }).catch(() => {});
        result.failed.push({ path: file.path, error: error.message });
      }
      done += 1;
      onProgress({
        phase: 'download',
        current: done,
        total: need.length,
        file: path.basename(file.path),
        downloadedBytes: result.bytes,
      });
    });
  }

  if (signal?.aborted) throw new Error('已取消');
  result.ok = result.failed.length === 0;
  return result;
}

/** 让进行中的预下载尽快中止（下载间与每次 fetch 都会检查）。 */
function makeAbort() {
  const controller = new AbortController();
  return controller;
}

/**
 * 异环更新检测（只查版本，不下载）。
 *
 * 数据源（都实测过）：
 *   本地启动器版本 → <安装根>/NTELauncher/Config/Config.ini 的 [VERSION] Version
 *   远程启动器版本 → VersionInfoFileURL 指到的 Version.ini（官服/B服 CDN 各一份）
 * 两边不一致 = 启动器侧资源有更新（channelSdk / Patcher / 配置等）。
 *
 * ⚠️ 覆盖范围说明：这套清单只管 NTELauncher 文件夹，游戏本体（Client）走
 * PatcherSDK 的 .sig 差分机制，远程路径未公开、sig 是二进制私有格式，
 * 本体的下载/校验暂时做不了，仍由官方启动器在启动时接管。
 * 所以检测到「有更新」时，能自动更新的只是启动器侧资源。
 */
async function checkUpdate({ installRoot, channel = '', versionUrl = '', signal }) {
  const root = findConfigRoot(installRoot);
  if (!root) {
    return {
      kind: 'nte',
      state: 'not-installed',
      localVersion: '',
      latestVersion: '',
      reason: '没有找到异环安装目录（NTELauncher/Config/Config.ini）',
    };
  }

  // 这份 ini 是 UTF-16LE，之前按 utf8 读只能拿到乱码，等于每次都走渠道兜底地址
  const localIni = readLauncherIni(root);

  let iniUrl = versionUrl;
  if (!iniUrl) {
    const hit = localIni.match(/^VersionInfoFileURL=(.+)$/m);
    if (hit) iniUrl = hit[1].trim();
  }
  if (!iniUrl && channel) {
    iniUrl = `https://yhcdn1.wmupd.com/hd/publish_ob${channel === 'bilibili' ? '_B' : ''}/launcher/Version.ini`;
  }

  const localVersion = (localIni.match(/^\[VERSION\][\s\S]*?^Version=(.+)$/m) || [])[1]?.trim() || '';

  /*
   * 两条线各查各的，谁也别说谁：
   *   · 启动器资源版本（Version.ini / AllFiles.xml）—— 我们能自己下；
   *   · 本体预下载（PatcherSDK 的 PreRelease 分支）—— 只能官方下。
   * 预下载查询失败不能连累启动器更新，反过来也一样。
   */
  const pre = await checkPreRelease({ installRoot: root, signal }).catch((error) => ({
    ok: false,
    reason: error.message,
  }));
  const preAvailable = Boolean(pre && pre.ok && pre.available);
  const prePayload =
    pre && pre.ok
      ? {
          // 界面判断「要不要提预下载」得看这个，不能只看版本号非空 ——
          // 预下载撤了 / 已经正式上线之后，config 里的 PreReleaseVersion 还在
          preReleaseAvailable: Boolean(pre.available),
          preReleaseBranch: pre.preReleaseBranch || '',
          preReleaseVersion: pre.preReleaseVersion || '',
          preReleaseStatus: pre.preReleaseStatus || '',
          preReleaseBytes: Number(pre.bytes) || 0,
          officialResVersion: pre.officialVersion || '',
          localResVersion: pre.localVersion || '',
        }
      : { preReleaseReason: String((pre && pre.reason) || '') };

  /**
   * 本体预下载开放时的统一返回：明确标成「只能官方下」，别让界面接错按钮。
   *
   * 故意不带 bytesTotal：config 里的 ResSize 是**整套资源**的大小（实测 82 GB），
   * 不是这次要下的量（真实增量在官方加密的 diff 清单里，拿不到）。挂出去界面就会
   * 写成「约 82 GB」，用户以为预下载要重下整个游戏。要体积就让官方自己报。
   */
  const preResult = () => ({
    kind: 'nte',
    state: 'available',
    scope: NTE_SCOPE_OFFICIAL,
    officialOnly: true,
    localVersion: (pre && pre.localVersion) || '',
    latestVersion: pre.preReleaseVersion || '',
    targetVersion: pre.preReleaseVersion || '',
    versionUrl: iniUrl,
    installRoot: root,
    ...prePayload,
  });

  if (!iniUrl) {
    // 启动器清单地址都没拿到，但本体预下载照样可能查得到，不能因此什么都不说
    if (preAvailable) return preResult();
    return {
      kind: 'nte',
      state: 'none',
      localVersion: '',
      latestVersion: '',
      reason: '没有找到版本清单地址（VersionInfoFileURL）',
      installRoot: root,
      ...prePayload,
    };
  }

  try {
    const ini = await fetchText(iniUrl, signal);
    const latestVersion = (ini.match(/^Version=(.+)$/m) || [])[1]?.trim() || '';
    /*
     * 必须远程真的比本地新才算有更新。
     *
     * 原来是 latestVersion !== localVersion，只要字面不同就报 update。版本号
     * 格式一变（官方改了命名、本地带构建后缀）就会天天报「有更新」，可游戏
     * 本体一个字节都没动——用户点了「更新游戏」，装完发现版本还是那个版本。
     * 而且这里比对的是启动器资源的版本，本来就不代表本体有新版本。
     */
    const newer = Boolean(latestVersion && localVersion) && compareVersion(latestVersion, localVersion) > 0;
    if (newer) {
      return {
        kind: 'nte',
        state: 'update',
        scope: NTE_SCOPE_LAUNCHER,
        localVersion,
        latestVersion,
        targetVersion: latestVersion,
        versionUrl: iniUrl,
        installRoot: root,
        ...prePayload,
      };
    }
    if (preAvailable) return preResult();
    return {
      kind: 'nte',
      state: 'none',
      scope: NTE_SCOPE_LAUNCHER,
      localVersion,
      latestVersion,
      targetVersion: latestVersion,
      versionUrl: iniUrl,
      installRoot: root,
      ...prePayload,
    };
  } catch (error) {
    // 启动器清单拉不到，但本体预下载查到了就照实报预下载，别把整条状态打成 error
    if (preAvailable) return preResult();
    return {
      kind: 'nte',
      state: 'error',
      localVersion,
      latestVersion: '',
      error: `读取异环版本清单失败：${error.message}`,
      installRoot: root,
      ...prePayload,
    };
  }
}

/** 更新启动器侧资源（就是预下载那套：AllFiles 清单 → zip → 校验 → 落盘）。 */
async function updateLauncherFiles(options) {
  return predownload(options);
}

module.exports = {
  findConfigRoot,
  parseAllFiles,
  unzipSingleEntry,
  parseBranchConfig,
  readPatcherTarget,
  readLocalResVersion,
  checkPreRelease,
  officialBusy,
  predownload,
  makeAbort,
  checkUpdate,
  updateLauncherFiles,
};
