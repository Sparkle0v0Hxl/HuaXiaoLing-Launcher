'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function shouldSkipDir(name) {
  return ['.git', 'node_modules', '.vela-linked-runtime', 'crashsightlog', 'sdklogs'].includes(
    name.toLowerCase()
  );
}

/**
 * 暂停等待：硬链接这条路以前只支持「取消」，不支持「暂停」。
 * 生成几十 GB 的运行时中途想停一下，只能整个取消重来。
 * 这里按 300ms 轮询，signal.paused 为真就停住，取消则抛出。
 */
async function waitIfPausedLocal(signal) {
  while (signal?.paused && !signal.cancelled) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (signal?.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
}

async function walkFiles(root, signal, onProgress) {
  const files = [];
  let lastScan = 0;
  async function walk(dir, relative) {
    if (signal && signal.cancelled) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (signal && signal.cancelled) return;
      if (entry.isSymbolicLink()) continue;
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        await walk(full, rel);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = await fsp.stat(full);
        } catch {
          continue;
        }
        files.push({ rel, full, size: stat.size });
        /*
         * 扫描本身也要报进度。一万三千个文件挨个 stat，冷缓存下就是几十秒，
         * 这段时间一个事件都不发，界面会停在「读取官方清单…」不动，看着像卡死。
         */
        const now = Date.now();
        if (onProgress && now - lastScan > 400) {
          lastScan = now;
          onProgress({ scanned: files.length, current: rel });
        }
      }
    }
  }
  await walk(root, '');
  return files;
}

/*
 * 判断一个文件是否必须「拷贝」而不是「硬链接」。
 *
 * 硬链接 = 两条路径指向同一份数据，谁写都会改到对方。所以只有真正只读的资源
 * 才能链接；任何游戏运行时会改写的文件都必须拷贝，否则渠道之间会互相污染。
 *
 * 2026-11-07 真实事故：终末地切服后官服一直报「检查资源完整性时发现异常」并反复
 * 下载 1059MB。根因是 Endfield_Data\Persistent 下的 index_main.json / pref_main.json
 * 和各 VFS 目录的 .blc 索引被硬链接了 —— 国际服下载语音包改写索引后，官服目录里的
 * index_main.json 直接变成了国际服那份（inode 相同、大小 283452 而非官服的 276964），
 * 于是官服读到「应该有 181 个 .chk」而自己只有 137 个，判定缺文件；下完再写又是同一份
 * 共享文件，永远自愈不了。
 *
 * 资源 .chk 是只读的，继续硬链接（66GB 不必重复占盘）；索引类小文件一律拷贝。
 *
 * 2026-11-08 补充（HGDownloadLog.log:1669-1682 一手证据）：游戏**下载落地**的过程是
 * 「旧文件 rename 成 .bak → temp rename 成正式名 → 删 .bak」，全程 rename、没有任何
 * 原地覆写。Windows 同卷 rename 只改目录项、不动 inode 数据，所以 .chk/.blc 就算被
 * 硬链接，被替换后也只是这条链接指向新 inode，另一侧那份 inode 一个字节都不会变 ——
 * .chk 硬链接是安全的。
 *
 * 真正危险的是「进程内直接写文件」的那一类（.json 索引：index_main.json / pref_*.json，
 * 尺寸在 42360→52328→52316 来回变），它们不是 rename 替换，而是同 inode 写穿。
 * 因此 Endfield_Data\Persistent 整棵子树额外用 copyDirs 强制拷贝（见 ENDFIELD_COPY_DIRS），
 * 宁可多占约 3.9GB 也彻底隔离基础客户端。
 */
const MUTABLE_INDEX_EXTS = ['.json', '.blc'];

function isMutableIndexFile(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (MUTABLE_INDEX_EXTS.indexOf(ext) < 0) return false;
  // 只针对游戏数据目录里的索引；顶层零散 json（如 manifest）本来就该独立
  return true;
}

/*
 * 「必须拷贝、禁止硬链接」的完整判据（2026-11-08 扩容）。
 *
 * 起因：`fsutil hardlink list` 实测 `G:\Arknights Endfield`，下面这些**可写/渠道态**
 * 文件现在就是 nlink=2（另一端全部指向 `.vela-linked-runtime\Endfield\global\...`），
 * 也就是说它们**已经被硬链接共享了**：
 *   config.ini 256
 *   sdk_data.dat 64
 *   game_files 222432
 *   verify_files.json 73987
 *   U8Data\config\config.bin 1568 与另外 8 个 .bin/.gryph（256~13824）
 *   mmkv\gameprotocol_cache / gameprotocol_cache.crc / gf_login_cache / login_cache（4096）
 *   WebviewConfig\BulletinConfig.bin / CustomerServiceConfig.bin / localBulletin / popupVersion
 *   HGEventLog_Encrypted\sdid_s 192
 * 老判据 `MUTABLE_INDEX_EXTS = ['.json','.blc']` 只按扩展名，上面这些**一条都盖不住**，
 * 照它去建单工作目录会原样重演 11-07 的共享 inode 事故（官服报资源完整性异常）。
 *
 * 因此改成参照 Xel-Launcher `IsSafeSharedPath` 的三重判据（目录段 / 文件名片段 / 扩展名），
 * 再加两份花筱灵专用的清单（顶层目录白名单、顶层无扩展名文件白名单）。
 *
 * 与 Xel 的一处**故意不同**：Xel 还规定「只有 Endfield_Data\ 下的文件才允许链接」，
 * 花筱灵不照抄 —— 根目录那几个重二进制（GameAssembly.dll 320MB、Qt5WebEngineCore.dll
 * 114MB、UnityPlayer.dll 35MB…）只读且巨大，硬链接能省一半盘，必须继续链接。
 * 所以这里只走「可疑就拷贝」的黑名单，不做「只有白名单能链接」的白名单。
 *
 * 判据宁可多拷贝：命中的都是小文件（合计几十 MB），错判的代价是几百 MB 盘；
 * 而漏判一次就是整个基础客户端被就地改写、修不回来。
 */

// 文件名片段（只看 basename，不做全路径匹配，避免 StreamingAssets 里误伤）
const MUTABLE_NAME_FRAGMENTS = [
  'config',
  'setting',
  'account',
  'login',
  'session',
  'save',
  'preference',
  'userdata',
  // 鸣潮（库洛）运行时自己写的账号 / 画质 / 性能 / 崩溃上报状态。
  // 硬链接 = 共享 inode：官服写一次，B服（或 WeGame）那份也跟着变。
  // 命中的都是小文件，错判代价是几 MB 盘，漏判一次就是两个渠道互相污染。
  'kurodata',
  'distinctid',
  'cos_perf.data',
  'performance_data',
  'crashsight_data',
  'config.txt',
  'cert.pem',
  'key.pem',
];

// 扩展名（Xel 原表 + 花筱灵实测需要的 .blc / .dat）
const MUTABLE_EXTS = [
  '.ini',
  '.cfg',
  '.config',
  '.json',
  '.xml',
  '.log',
  '.tmp',
  '.lock',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.info',
  '.blc',
  '.dat',
];

// 目录段：相对路径里任意一段命中就整棵拷贝
const MUTABLE_DIR_SEGMENTS = [
  'cache',
  'caches',
  'log',
  'logs',
  'temp',
  'temporary',
  'save',
  'saves',
  'saved',
  'userdata',
  'persistent',
  'persistentdata',
  'crash',
  'crashes',
  // 鸣潮：画质档位缓存、性能采样、崩溃上报目录（运行时可写）
  '.quality',
  'wesight',
  'crashsight_data',
];

// 顶层目录整棵拷贝（花筱灵实测：这些都是游戏运行时自己写的）
const MUST_COPY_TOP_DIRS = [
  'u8data',
  'sdkdata',
  'mmkv',
  'launcher_tmp',
  '.switch',
  'webviewconfig',
  'hgeventlog_encrypted',
  'sdklogs',
  'crashsightlog',
];

// 顶层无扩展名 / 扩展名不足以判断的可写文件
const MUST_COPY_ROOT_FILES = [
  'config.ini',
  'sdk_data.dat',
  'game_files',
  'verify_files',
  'verify_files.json',
  'eld_endfield.db',
  'eld_platformprocess.db',
  'marquee_config.bin',
];

/*
 * 硬链接例外白名单（2026-11-17 用户报障「转换 WeGame 端怎么占那么大」查出来的）。
 *
 * 鸣潮的客户端资源实际放在 `Client\Saved\Resources\`（pak 分块 + 视频，官方版本体
 * 里这一块就 48 GB）。而相对路径里带 'saved' 段，会命中 MUTABLE_DIR_SEGMENTS，
 * 结果整棵 48 GB 被**拷贝**而不是硬链接 —— 转换一次就多占 48 GB，
 * 「硬链接本来只该多占几 MB」的前提整个不成立。
 *
 * 这些 pak 是只读的（游戏按 pak 只读挂载，不会就地改写），共享 inode 没有污染风险，
 * 所以给一份例外白名单，让它们走硬链接。
 *
 * 例外里仍要拷贝的：还在下载/临时状态的pak（.kuro-tmp 之类），
 * 内容随时会变，链过去等于两个渠道互相写坏。
 */
const HARDLINK_ALLOW_PREFIXES = [
  'client/saved/resources',
  'starrail_data/persistent/audio',
  /* 其它几款米哈游客户端如果也是 Persistent/Audio 布局，段名兜底见 isHardlinkAllowed 的第二段判据 */
];
/* 白名单里只放只读扩展名：.pak/.sig 是官方资源分块与签名，.pck/.hash 是语音包与校验；
 * .txt/.json 挂载表仍按可写处理。 */
const HARDLINK_ALLOW_EXTS = [
  '.pak',
  '.sig',
  '.pck',
  '.hash',
];
const HARDLINK_ALLOW_BLOCK_SUFFIXES = [
  '.kuro-tmp',
  '.tmp',
  '.part',
  '.partial',
  '.download',
  '.crdownload',
];

function isHardlinkAllowed(relLower, baseName) {
  const lower = String(baseName || '').toLowerCase();
  for (const suffix of HARDLINK_ALLOW_BLOCK_SUFFIXES) {
    if (lower.endsWith(suffix)) return false;
  }
  const ext = path.extname(lower);
  if (HARDLINK_ALLOW_EXTS.indexOf(ext) < 0) return false;
  for (const prefix of HARDLINK_ALLOW_PREFIXES) {
    if (relLower === prefix || relLower.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function mustCopyNotLink(rel) {
  const relLower = String(rel).toLowerCase().replace(/\\/g, '/');
  const segments = relLower.split('/');
  const topDir = segments[0];
  const baseName = segments[segments.length - 1];

  /*
   * 下载中 / 临时状态的文件一律拷贝 —— 必须排在最前面，连白名单都不能放行。
   *
   * 2026-11-17 审查发现：这段以前只写在 isHardlinkAllowed() 内部（命中后缀就
   * return false =「不走白名单例外」）。但白名单之外的地方仍然会掉进下面那套
   * 通用判据，而 .kuro-tmp / .part / .partial / .download / .crdownload 这五个
   * 后缀一个都不在 MUTABLE_EXTS 里 —— 于是非白名单路径下的临时文件照样被判
   * 「可硬链接」。实测 Client/Content/Paks/x.pak.kuro-tmp → false（链接）。
   *
   * kuro-packs.js 的下载器正是在这些 temp 上 open(r+/w) + truncate 原地续传，
   * 硬链接过去 = 两个渠道共享同一个 inode，续传会把另一侧写坏。
   * 所以这里提到最前面：命中后缀直接 return true，后面的判据一条不看。
   */
  for (const suffix of HARDLINK_ALLOW_BLOCK_SUFFIXES) {
    if (baseName.endsWith(suffix)) return true;
  }

  // 例外白名单优先：这些是只读大资源，走硬链接省几十 GB（见上面的说明）。
  if (isHardlinkAllowed(relLower, baseName)) return false;

  if (segments.length <= 1) {
    if (MUST_COPY_ROOT_FILES.indexOf(relLower) >= 0) return true;
  }
  if (MUST_COPY_TOP_DIRS.indexOf(topDir) >= 0) return true;
  // 目录段（跳过最后一段，那是文件名）
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (MUTABLE_DIR_SEGMENTS.indexOf(segments[i]) >= 0) return true;
  }
  // 文件名片段
  for (const fragment of MUTABLE_NAME_FRAGMENTS) {
    if (baseName.indexOf(fragment) >= 0) return true;
  }
  // 扩展名
  const ext = path.extname(baseName);
  if (MUTABLE_EXTS.indexOf(ext) >= 0) return true;
  // 老判据保留（.json / .blc 索引）
  return isMutableIndexFile(rel);
}

/**
 * 把一个文件铺到目标路径：硬链接或拷贝。返回 'link' / 'copy'，调用方按它计数。
 *
 * ⚠ 这里有两个必须守住的规矩（2026-11-17 审查 + 真机复现确认）：
 *
 * 1）**拷贝前先断链**（rename 挪开再写）。
 *    `fsp.copyFile(src, dest)` 对已存在的 dest 是**原地截断写**。如果 dest 是
 *    别处的硬链接（重复生成运行时 / 增量补文件 / 上一次留下的运行时），
 *    这一下就顺着 inode 写穿过去，把另一个渠道的文件也改成新内容。
 *    真机复现过：other/shared.bin 从 "BBBB" 变成 "AAAA"。
 *    overlayDirectory 一直是这么做的（先 rename 断链），这里以前漏了。
 *
 * 2）**link 失败不能无脑退 copy**。
 *    link 抛 EEXIST 的语义是「目标已存在」。这时直接 copyFile 就是上面那个写穿。
 *    所以 EEXIST 要先把目标挪开再重试 link；其它错误（跨卷 EXDEV / 权限）
 *    才退化成拷贝，且拷贝同样要先断链。
 */
async function placeOneFile({ rel, full, destination, shouldCopy }) {
  const parkAway = async () => {
    const parked = `${destination}.hxl-old-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsp.rename(destination, parked);
      return parked;
    } catch (error) {
      // 目标不存在：本来就没有可写穿的 inode，直接往下写新文件。
      if (error && error.code === 'ENOENT') return '';
      /*
       * 改名挪不开 = 目标存在但被占用 / ACL 没权限（官方安装器用管理员身份写的文件，
       * 普通用户没有 DELETE 权限）。**绝不退回原地覆盖写** —— 目标多半是硬链接，
       * copyFile 会写穿到基础客户端，硬链接架构下不可逆。
       */
      throw new Error(
        `无法替换 ${rel}：目标被其它进程占用或权限不足（${String(error && error.message ? error.message : error)}）。` +
        '为避免沿硬链接写穿其它渠道的客户端，已拒绝原地覆盖写，请关闭占用该文件的程序后重试。'
      );
    }
  };

  const dropParked = async (parked) => {
    if (!parked) return;
    try {
      await fsp.rm(parked, { force: true });
    } catch {
      // 清不掉（ACL 挡着）不中断整次操作：残留的是整份旧文件，记日志事后清
      console.warn(`[runtime] 旧文件清理失败，残留 ${parked}`);
    }
  };

  if (shouldCopy) {
    const parked = await parkAway();
    try {
      await fsp.copyFile(full, destination);
    } catch (error) {
      // 拷贝失败要把原件搬回去，否则目标路径上就缺了这个文件
      if (parked) {
        try { await fsp.rename(parked, destination); } catch { /* 搬不回，错误信息里带上路径 */ }
      }
      throw new Error(`无法创建 ${rel}：${error.message}${parked ? `（原文件保留在 ${parked}）` : ''}`);
    }
    await dropParked(parked);
    return 'copy';
  }

  // 先试硬链接（目标不存在时最省事、零拷贝）
  try {
    await fsp.link(full, destination);
    return 'link';
  } catch (error) {
    const code = error && error.code;
    if (code !== 'EEXIST') {
      /*
       * 跨卷 / 权限 / 文件系统不支持硬链接：退化成拷贝。
       * 拷贝前同样要断链（目标可能存在，也可能是上次残留的硬链接）。
       */
      const parked = await parkAway();
      try {
        await fsp.copyFile(full, destination);
      } catch (e2) {
        if (parked) {
          try { await fsp.rename(parked, destination); } catch { /* 同上 */ }
        }
        throw new Error(`无法创建 ${rel}：${e2.message}${parked ? `（原文件保留在 ${parked}）` : ''}`);
      }
      await dropParked(parked);
      return 'copy';
    }
    // EEXIST：目标已存在。断链后重试链接，绝不直接 copyFile（那会写穿）。
    const parked = await parkAway();
    try {
      await fsp.link(full, destination);
    } catch (error2) {
      // 断链后仍链不上（跨卷等）：这次才是合法的拷贝时机
      try {
        await fsp.copyFile(full, destination);
      } catch (e3) {
        if (parked) {
          try { await fsp.rename(parked, destination); } catch { /* 同上 */ }
        }
        throw new Error(`无法创建 ${rel}：${e3.message}${parked ? `（原文件保留在 ${parked}）` : ''}`);
      }
      await dropParked(parked);
      return 'copy';
    }
    await dropParked(parked);
    return 'link';
  }
}

/** 下载中间态后缀：这些文件永远不该被硬链或复制（半成品，链过去就是共享一个残缺 inode）。 */
const SKIP_LINK_SUFFIXES = ['.kuro-tmp', '.part', '.partial', '.download', '.crdownload'];

/** 转换时「根本不处理」的文件判断：临时文件后缀 + 调用方指定的目录前缀。 */
function shouldSkipLink(rel, skipPrefixes, skipSuffixes) {
  const relLower = String(rel || '').toLowerCase().replace(/\\/g, '/');
  const base = relLower.slice(relLower.lastIndexOf('/') + 1);
  for (const suffix of skipSuffixes) {
    if (base.endsWith(suffix)) return true;
  }
  for (const prefix of skipPrefixes) {
    if (relLower === prefix || relLower.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

async function hardlinkTree({
  sourceRoot,
  targetRoot,
  onProgress = () => {},
  signal,
  copyDirs = [],
  skipPrefixes = [],
  skipSuffixes = SKIP_LINK_SUFFIXES,
}) {
  const files = await walkFiles(sourceRoot, signal, (progress) =>
    onProgress({
      phase: 'scan',
      processed: progress.scanned,
      total: 0,
      current: `扫描基础客户端：${progress.current}`,
    })
  );
  /*
   * 2026-11-18：转换时「不处理」的文件先剔掉。
   *
   * 实测（本机官服 108.13 GiB / 1804 个文件）转换 WeGame：
   *   · 两个没下完的可选包 `.pak.kuro-tmp` 合计 2.85 GiB；
   *   · 两个 PSO 着色器缓存 1.03 GiB（`Client/Saved/PSO`，游戏端自己会重建）。
   * 这两类就占了「必须复制」4.75 GiB 里的 82%，复制过去没有任何用处，
   * 只会让 WeGame 目录白占 3.88 GiB。
   *
   * 处理方式：临时后缀一律跳过（对任何调用都安全 —— 半成品文件本来就不该被链）；
   * PSO 这类目录由调用方通过 skipPrefixes 指定（名字因游戏而异，不能写死在这里）。
   */
  const skipPrefixesNorm = skipPrefixes
    .map((dir) => String(dir).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
  const effective = [];
  let skipped = 0;
  let skippedBytes = 0;
  for (const file of files) {
    if (shouldSkipLink(file.rel, skipPrefixesNorm, skipSuffixes)) {
      skipped += 1;
      skippedBytes += Number(file.size) || 0;
      continue;
    }
    effective.push(file);
  }

  let processed = 0;
  let linked = 0;
  let copied = 0;
  let lastEmit = 0;
  /*
   * 字节量：walkFiles 已经把每个文件的 size 存下来了，这里直接累加，零额外 IO。
   * 之前只报文件个数，界面上「整理文件 4200/11300」用户根本判断不了还要多久
   * （一个大 .chk 和一个小 .ini 在计数里长得一样）。
   * 跳过的文件不计入 totalBytes，否则进度条会卡在 96% 再猛地跳满。
   */
  let bytesDone = 0;
  const totalBytes = effective.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  /*
   * copyDirs 统一成小写、正斜杠的无尾斜杠形式，支持「多段路径」。
   *
   * 以前只取 rel 的第一段（见下方 topDir），传 'Endfield_Data/Persistent' 永远匹配不上，
   * 结果 Persistent 下的可写索引还是被硬链接走了 —— 正是 11-07 那次官服污染事故的形状。
   * 现在两种写法都认：单段目录（'U8Data'）按第一段比，多段前缀（'Endfield_Data/Persistent'）
   * 按完整相对路径比，互为补充，原有判据一条不丢。
   */
  const copyPrefixes = copyDirs.map((dir) =>
    String(dir).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
  );
  for (const file of effective) {
    if (signal && signal.cancelled) break;
    // 暂停检查点：放在每个文件开头。fsp.link 是原子的，不会留半个文件，
    // 所以暂停后从同一个文件继续是安全的。
    if (signal && signal.paused) {
      try {
        await waitIfPausedLocal(signal);
      } catch {
        break;
      }
    }
    const destination = path.join(targetRoot, file.rel);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const slash = file.rel.indexOf('/');
    const backslash = file.rel.indexOf('\\');
    let end = slash;
    if (end < 0 || (backslash >= 0 && backslash < end)) end = backslash;
    const topDir = (end < 0 ? file.rel : file.rel.slice(0, end)).toLowerCase();
    const relLower = file.rel.toLowerCase().replace(/\\/g, '/');
    /*
     * 判据（任一命中就拷贝）：
     *   1. copyDirs 多段前缀命中（'Endfield_Data/Persistent' 整棵子树）
     *   2. copyDirs 单段目录命中（'U8Data' / 'sdkdata'）
     *   3. mustCopyNotLink 三重判据（目录段 / 文件名片段 / 扩展名 + 实测清单）
     * 剩下的纯只读资源（StreamingAssets 的 .chk、CefView、plugins、各个 .dll）才走硬链接。
     */
    const shouldCopy =
      copyPrefixes.some((prefix) => relLower === prefix || relLower.startsWith(`${prefix}/`)) ||
      copyPrefixes.indexOf(topDir) >= 0 ||
      mustCopyNotLink(file.rel);
    const placed = await placeOneFile({
      rel: file.rel,
      full: file.full,
      destination,
      shouldCopy,
    });
    if (placed === 'copy') copied += 1;
    else linked += 1;
    processed += 1;
    bytesDone += Number(file.size) || 0;
    const now = Date.now();
    if (now - lastEmit > 160) {
      lastEmit = now;
      onProgress({
        phase: 'link',
        processed,
        total: effective.length,
        linked,
        copied,
        bytesDone,
        totalBytes,
        current: file.rel,
      });
    }
  }
  // 收尾强推一帧满进度：别让界面停在最后一个节流点（比如 99%）
  if (effective.length) {
    onProgress({
      phase: 'link',
      processed: effective.length,
      total: effective.length,
      linked,
      copied,
      bytesDone: totalBytes,
      totalBytes,
      current: '',
    });
  }
  return { total: effective.length, processed, linked, copied, totalBytes, skipped, skippedBytes };
}

async function overlayDirectory({ packRoot, targetRoot, onProgress = () => {}, signal }) {
  const files = await walkFiles(packRoot, signal);
  let processed = 0;
  let lastEmit = 0;
  let bytesDone = 0;
  const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  for (const file of files) {
    if (signal && signal.cancelled) break;
    const destination = path.join(targetRoot, file.rel);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    // 目标可能是从基础客户端硬链接过来的同 inode 文件。直接 copyFile 会原地覆盖，
    // 把基础客户端/别的渠道一起改掉；先断开链接，再写成独立文件。
    //
    // 断链用「改名挪开」而不是「删除」：官方安装器用管理员身份写的文件，ACL 上
    // 普通用户没有 DELETE，rm 会 EPERM（Node 还把它和「被占用」混成一个错误），
    // 而 rename 只需要目录写权限，实测可行。硬链接是按 inode 共享数据的，
    // 改名之后目标路径已经指向「不存在」，下一句 copyFile 会新建独立文件，链接自然断掉。
    const parked = `${destination}.hxl-old-${Date.now()}`;
    let parkedOk = false;
    try {
      await fsp.rename(destination, parked);
      parkedOk = true;
    } catch (error) {
      // 目标不存在（第一次铺）：没有旧文件、不存在硬链接可写穿，直接往下写新文件。
      if (error?.code !== 'ENOENT') {
        // 改名挪不开、目标又确实存在（被占用 / ACL 权限不足）：**绝不退回原地覆盖写**。
        // 目标多半是硬链接，copyFile 原地截断写会顺着 inode 写穿到基础客户端
        // （官服本体被渠道文件污染，硬链接架构下这是不可逆的）。这里直接拒绝本次操作，
        // 让用户关掉占用该文件的程序或提权重试。
        throw new Error(`无法替换渠道文件 ${file.rel}：目标被其它进程占用或权限不足（${String(error?.message || error)}）。为避免沿硬链接写穿基础客户端，已拒绝原地覆盖写，请关闭占用该文件的程序后重试。`);
      }
    }
    try {
      await fsp.copyFile(file.full, destination);
    } catch (error) {
      // 复制失败必须把原件搬回去：否则这个文件在目标路径上是空的（改名已把原件挪走），
      // 用户的运行时会被我们弄缺一个文件。搬不回也不额外抛，保住原始错误信息。
      if (parkedOk) {
        try {
          await fsp.rename(parked, destination);
        } catch {
          // 搬不回：至少把 parked 路径写进错误里，用户和我们都能找到原件
          throw new Error(`无法写入渠道文件 ${file.rel}：${error.message}（原文件已改名保留在 ${parked}，未能自动恢复）`);
        }
      }
      throw new Error(`无法写入渠道文件 ${file.rel}：${error.message}`);
    }
    // 挪开的旧文件尽量清掉。清不掉（ACL 挡着）不能静默吞掉：残留的是**整个旧渠道文件**
    // （可能是大 .dll/.chk，不是几十字节），切几次服会累积好几份；这里记日志留痕，
    // 方便事后清扫，但不因此中断整次切服。
    if (parkedOk) {
      try {
        await fsp.rm(parked, { force: true });
      } catch (error) {
        console.warn(`[runtime] 旧渠道文件清理失败，残留 ${parked}：${String(error?.message || error)}`);
      }
    }
    processed += 1;
    bytesDone += Number(file.size) || 0;
    const now = Date.now();
    if (now - lastEmit > 160) {
      lastEmit = now;
      onProgress({
        phase: 'overlay',
        processed,
        total: files.length,
        bytesDone,
        totalBytes,
        current: file.rel,
      });
    }
  }
  if (files.length) {
    onProgress({
      phase: 'overlay',
      processed: files.length,
      total: files.length,
      bytesDone: totalBytes,
      totalBytes,
      current: '',
    });
  }
  return { total: files.length, processed, totalBytes };
}

/**
 * 删一棵目录树，删不掉就让旧目录「让路」。
 *
 * 运行时目录里的文件都是从基础客户端硬链接过来的，其中内嵌 Chromium 的缓存目录
 * （原神是 YuanShen_Data\webCaches\<版本>\Service Worker，星铁/绝区零同理）经常
 * 被残留句柄或只读属性咬住。以前直接 fsp.rm({ recursive, force }) 一句，rmdir
 * 一失败整个任务就抛异常，而界面上进度条还停在「读取官方清单」—— 看着像卡死，
 * 其实任务早就挂了。
 *
 * 三档处理：带重试的整树删除 → 逐项删除只看真正删不掉的 → 整体改名让路
 * （同卷 rename 只要求父目录可写，子目录里的句柄不挡路）。只有改名也失败才抛错，
 * 且抛的是看得懂的中文。
 */
async function removeTreeResilient(root) {
  if (!fs.existsSync(root)) return '';
  try {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return '';
  } catch {
    /* 落到逐项删 */
  }
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const stuck = [];
  for (const entry of entries) {
    try {
      await fsp.rm(path.join(root, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 6,
        retryDelay: 200,
      });
    } catch {
      stuck.push(entry.name);
    }
  }
  if (!stuck.length) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    return '';
  }
  const stalePath = `${root}.stale-${Date.now()}`;
  try {
    await fsp.rename(root, stalePath);
    return stalePath;
  } catch {
    throw new Error(
      `清理残留目录失败：${stuck.slice(0, 3).join('、')}${
        stuck.length > 3 ? ' 等' : ''
      } 正被其它程序占用。请先关闭正在运行的游戏、等杀毒软件扫描结束后再重新尝试。`
    );
  }
}

async function prepareLinkedRuntime({ baseRoot, packRoot, targetRoot, onProgress, signal, copyDirs = [] }) {
  if (!baseRoot || !fs.existsSync(baseRoot)) throw new Error('找不到基础客户端目录');
  if (!packRoot || !fs.existsSync(packRoot)) throw new Error('找不到渠道差异文件目录');
  const baseStat = await fsp.stat(baseRoot);
  const packStat = await fsp.stat(packRoot);
  if (!baseStat.isDirectory() || !packStat.isDirectory()) throw new Error('客户端或渠道目录无效');
  // 老数据里的基础路径可能带正斜杠（"G:/Arknights Endfield"），
  // path.parse('G:/x').root 是 "G:/"，跟 "G:\\" 比永远不相等，会误报「不在同一个磁盘」。
  const normalizedBase = path.normalize(baseRoot);
  const normalizedTarget = path.normalize(targetRoot);
  if (path.parse(normalizedBase).root.toLowerCase() !== path.parse(normalizedTarget).root.toLowerCase()) {
    throw new Error('链接运行时必须和基础客户端在同一个磁盘分区');
  }

  const stalePath = await removeTreeResilient(targetRoot);
  if (stalePath) {
    onProgress?.({
      phase: 'clean',
      current: `旧目录删不干净，已改名放行：${path.basename(stalePath)}`,
    });
  }
  await fsp.mkdir(targetRoot, { recursive: true });
  const linkResult = await hardlinkTree({ sourceRoot: baseRoot, targetRoot, onProgress, signal, copyDirs });
  if (signal && signal.cancelled) return { cancelled: true, ...linkResult };
  const overlayResult = await overlayDirectory({ packRoot, targetRoot, onProgress, signal });
  return {
    cancelled: Boolean(signal && signal.cancelled),
    ...linkResult,
    overlay: overlayResult,
    targetRoot,
  };
}

/**
 * 把一棵目录完整复制过去（不做硬链接）。
 *
 * 渠道包是长期缓存，往运行时里铺的时候必须复制：用硬链接的话，用户哪天在设置里
 * 「清理渠道包」就等于把游戏文件一起删了。
 */
async function copyTree(sourceRoot, targetRoot) {
  const files = await walkFiles(sourceRoot);
  for (const file of files) {
    const target = path.join(targetRoot, file.rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(file.full, target);
  }
}

module.exports = {
  prepareLinkedRuntime,
  walkFiles,
  hardlinkTree,
  copyTree,
  removeTreeResilient,
  // 终末地单工作目录切服用：切服时原地覆盖渠道文件，不再重建整树。
  overlayDirectory,
  // 建单工作目录（以及基线刷新）时判断「拷贝还是硬链接」。
  mustCopyNotLink,
  isMutableIndexFile,
};
