'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/*
 * 文件记账库（借鉴 Starward 的 GameFileDatabase）。
 * 硬链接/拷贝完把落位文件记进去，之后判断「运行时完不完整」靠查表 + NTFS FileId，
 * 不再依赖 launcher-data.json 里一个布尔字段。
 */
const gameFileDb = require('./game-file-db');
/* 硬链接安全守卫：占用探测 / EPERM 中文提示（2026-11-26） */
const hardlinkGuard = require('./hardlink-guard');

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
 * 真实事故：终末地切服后官服一直报「检查资源完整性时发现异常」并反复
 * 下载 1059MB。根因是 Endfield_Data\Persistent 下的 index_main.json / pref_main.json
 * 和各 VFS 目录的 .blc 索引被硬链接了 —— 国际服下载语音包改写索引后，官服目录里的
 * index_main.json 直接变成了国际服那份（inode 相同、大小 283452 而非官服的 276964），
 * 于是官服读到「应该有 181 个 .chk」而自己只有 137 个，判定缺文件；下完再写又是同一份
 * 共享文件，永远自愈不了。
 *
 * 资源 .chk 是只读的，继续硬链接（66GB 不必重复占盘）；索引类小文件一律拷贝。
 *
 * 补充（HGDownloadLog.log:1669-1682 一手证据）：游戏**下载落地**的过程是
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
 * 硬链接例外白名单（2026-11-17 查出来的）。
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
  /*
   * 终末地 Endfield_Data\Persistent（2026-11-19）。
   *
   * 这里和下面 HARDLINK_ALLOW_EXTS 的 .chk 配合使用，两个条件同时满足才放行，
   * 所以只有 Persistent 下的 .chk 走硬链接；.json / .blc 扩展名不在 exts 白名单里，
   * 照样掉进 MUTABLE_DIR_SEGMENTS 的 'persistent' 判据被强制拷贝。
   *
   * 依据（一手）：G:\Arknights Endfield\sdklogs\HGDownloadLog.log 显示官方下载器
   * 落位全程是 rename（旧文件 → .bak，temp → 正式名，删 .bak），没有原地覆写；
   * 搜 truncate / overwrite in place / write 到 VFS 目标零命中。
   * 已实证：StreamingAssets\VFS 下同类 .chk 早就 nlink=3、三渠道共享 63.3 GB。
   * 11-07 官服污染的元凶是索引 json 同 inode 写穿，不是 .chk 被改写。
   */
  'endfield_data/persistent',
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
/*
 * 前缀 + 扩展名的配对准入（2026-11-19）。
 *
 * 为什么不能直接把 .chk 塞进上面的 HARDLINK_ALLOW_EXTS：那个表是全局的，
 * 塞进去之后「任何前缀 + .chk」都会放行 —— 实测 `Client/Saved/Resources/x.chk`
 * （鸣潮 Saved/Resources，走的是 `client/saved/resources` 前缀）也会被判成可链接。
 * 鸣潮那边 Saved/Resources 是官方可写目录，不该因为终末地的需求被放宽。
 *
 * 所以要成对声明：只有前缀和扩展名同时命中才放行。
 */
const HARDLINK_ALLOW_PAIRS = [
  {
    /* 终末地 Endfield_Data\Persistent：语音包与资源分块。 */
    prefix: 'endfield_data/persistent',
    exts: ['.chk'],
  },
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
  // 配对准入：前缀与扩展名同时命中才放行（见 HARDLINK_ALLOW_PAIRS 的说明）。
  for (const pair of HARDLINK_ALLOW_PAIRS) {
    if (pair.exts.indexOf(ext) < 0) continue;
    if (relLower === pair.prefix || relLower.startsWith(`${pair.prefix}/`)) return true;
  }
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
   * 审查发现：这段以前只写在 isHardlinkAllowed() 内部（命中后缀就
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
  /*
   * ── 原子替换（借鉴 Starward 的 HardLinkService.TryHardLink）──────────────
   *
   * Starward 的做法：
   *   string link = path + ".link";
   *   if (File.Exists(link)) File.Delete(link);
   *   if (Kernel32.CreateHardLink(link, pathToTarget)) {
   *       File.Move(link, path, true);   // ← 先建到临时名，再 move 覆盖
   *   }
   *
   * 为什么这样更好：
   *   原来我们是「先把目标 rename 走（parkAway）→ 建新链接 → 删走的那份」。
   *   中间有窗口期：parkAway 成功、link 失败时，目标位置上**什么都没了**，
   *   要靠 catch 里的 rename 搬回去。搬回失败（被占用 / 断电）就丢文件。
   *
   *   改成「先建到临时名 .link → 再 move 覆盖目标」：
   *   · 建临时名失败 → 目标原封不动，什么都没有发生；
   *   · move 覆盖是同一卷内的目录项操作，原子且瞬间完成，没有空窗；
   *   · 不需要「搬回去」这种补救逻辑，出错路径天然是干净的。
   *
   * 注意：File.Move 覆盖在 Node 里是 `fs.rename`（Windows 上 rename 到已存在
   * 文件会失败，所以要先删目标 —— 这里是唯一的非原子点，但删的是「马上要被
   * 替换掉的旧文件」，即使断电也只是丢一个待替换文件，不是丢数据）。
   */

  /** 建一个硬链接到临时名，成功返回临时路径，失败返回 ''。 */
  const linkToTemp = async () => {
    const tmp = `${destination}.hxl-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsp.link(full, tmp);
      return tmp;
    } catch {
      try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
      return '';
    }
  };

  /** 拷到临时名，成功返回临时路径，失败返回 ''. */
  const copyToTemp = async () => {
    const tmp = `${destination}.hxl-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsp.copyFile(full, tmp);
      return tmp;
    } catch (error) {
      try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
      throw new Error(`无法创建 ${rel}：${error.message}`);
    }
  };

  /**
   * 把临时文件原子地放到目标位置。
   * Windows 上 fs.rename 不能覆盖已存在的文件，所以先删目标再 rename。
   * 删目标前先确认临时文件已经建好（否则会出现「删了旧的、新的没到位」空窗）。
   */
  const commitTemp = async (tmp) => {
    if (!tmp) return false;
    // 目标可能不存在（首次建），也可能存在（覆盖）
    let targetExists = false;
    try {
      await fsp.stat(destination);
      targetExists = true;
    } catch {
      targetExists = false;
    }
    if (targetExists) {
      /*
       * rename 前占用探测：目标可能正被游戏/启动器读写。先试一次写句柄，
       * 被独占就直接报中文错误，不去删它 —— 删到一半失败会留下空窗。
       */
      if (hardlinkGuard.isFileLocked(destination)) {
        try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
        throw new Error(
          `无法替换 ${rel}：文件正被游戏或官方启动器占用。请完全退出它们后再生成/修复硬链接。`
        );
      }
      try {
        await fsp.rm(destination, { force: true });
      } catch (error) {
        // 删不掉目标（被占用 / ACL）：把临时文件也清掉，保持「什么都没变」
        try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
        throw new Error(hardlinkGuard.humanizeFsError(error, `替换 ${rel}`));
      }
    }
    try {
      await fsp.rename(tmp, destination);
      return true;
    } catch (error) {
      try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
      throw new Error(`无法提交 ${rel}：${error.message}`);
    }
  };

  /* ── 需要拷贝的：直接拷到临时名再提交 ── */
  if (shouldCopy) {
    const tmp = await copyToTemp();
    await commitTemp(tmp);
    return 'copy';
  }

  /*
   * ── 需要链接的：先探这个盘支不支持硬链接 ──
   * 不支持（FAT32/exFAT）就直接拷贝，省掉每个文件一次必然失败的尝试。
   */
  if (!canHardlink(full)) {
    const tmp = await copyToTemp();
    await commitTemp(tmp);
    return 'copy';
  }

  // 先试「建临时链接 → 提交」。失败（跨卷 / 权限）退化成拷贝。
  const tmp = await linkToTemp();
  if (tmp) {
    await commitTemp(tmp);
    return 'link';
  }

  // 链接建不出来：退化成拷贝（同样走临时名 + 原子提交）
  const copyTmp = await copyToTemp();
  await commitTemp(copyTmp);
  return 'copy';
}

/** 下载中间态后缀：这些文件永远不该被硬链或复制（半成品，链过去就是共享一个残缺 inode）。 */
const SKIP_LINK_SUFFIXES = ['.kuro-tmp', '.part', '.partial', '.download', '.crdownload'];

/* ── 卷能力判定（借鉴 Starward：先看文件系统支不支持，再决定要不要试硬链接）── */

/**
 * 缓存「某个盘能不能建硬链接」。
 *
 * 为什么要有：硬链接只支持 NTFS / ReFS。在 FAT32 / exFAT 的盘上（U 盘、
 * 移动硬盘、某些双系统共享分区）`fs.link` 一定失败。不提前判断的话，
 * 每个文件都要先失败一次再退化成拷贝 —— 上万次失败的异常开销很可观，
 * 而且 EPERM/ENOTSUP 的错误信息对用户完全不可读（只会说「操作不支持」）。
 *
 * 判据：星铁/原神这类游戏的安装盘基本都是 NTFS；用 `fs.statfs` 拿不到
 * 文件系统类型，所以这里用「在目标盘上真建一次链接」来探测（探测一次、缓存）。
 * 探测不成也不报错，只是记下「这个盘不能链」。
 *
 * @type {Map<string, boolean>}
 */
const volumeHardlinkCache = new Map();

/** 取盘符（'G:\...' → 'g:') */
function volumeKey(p) {
  try {
    return path.parse(path.resolve(p)).root.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 这个路径所在的盘能不能建硬链接。带缓存，探测失败按「不能」处理。
 * @param {string} p
 * @returns {boolean}
 */
function canHardlink(p) {
  const key = volumeKey(p);
  if (!key) return false;
  if (volumeHardlinkCache.has(key)) return volumeHardlinkCache.get(key);

  let ok = false;
  try {
    const probeDir = path.dirname(path.resolve(p));
    fs.mkdirSync(probeDir, { recursive: true });
    const a = path.join(probeDir, `.hxl-link-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const b = a + '.b';
    try {
      fs.writeFileSync(a, '');
      fs.linkSync(a, b);
      ok = true;
    } finally {
      try { fs.rmSync(a, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(b, { force: true }); } catch { /* ignore */ }
    }
  } catch {
    ok = false;
  }
  volumeHardlinkCache.set(key, ok);
  if (!ok) {
    console.warn('[runtime] 盘 ' + key + ' 不支持硬链接（非 NTFS/ReFS），该盘上的文件将走复制');
  }
  return ok;
}

/** 清掉探测缓存（用户换了盘 / 盘符变了之后调）。 */
function clearVolumeHardlinkCache() {
  volumeHardlinkCache.clear();
}

/* ── 跨渠道复用（借鉴 Starward 的 TryHardLinkAsync）───────────────────── */

/**
 * 建一个「同内容文件」索引，供跨渠道复用查询。
 *
 * 索引结构：size → [ {path, md5?} ... ]。用 size 做粗筛（免费，记账表里就有），
 * MD5 只在候选里按需算（对同大小的少数几个文件算，成本可控）。
 *
 * 数据来源优先级：
 *   1. 记账库（GameFile.db）里**别的渠道**的记录 —— 这是 Starward 的做法，最准；
 *   2. 记账库为空时，退化成「扫本机已有运行时目录」—— 老用户补记账之前也能用。
 *
 * @param {{gameKey:string, excludeChannel:string}} options
 * @returns {{bySize:Map<number,string[]>, gameKey:string}}
 */
function buildReuseIndex({ gameKey, excludeChannel }) {
  const bySize = new Map();
  if (!gameKey) return { bySize, gameKey };

  let rows = [];
  try {
    // 记账库里的所有记录（本游戏），排除目标渠道自己
    const all = gameFileDb.all('SELECT Path, Channel, Size FROM GameFile WHERE GameKey = ?;', [gameKey]);
    rows = (all || []).filter((r) => String(r.Channel || '') !== String(excludeChannel || ''));
  } catch {
    rows = [];
  }

  for (const r of rows) {
    const size = Number(r.Size) || 0;
    if (!size) continue;
    const p = String(r.Path || '');
    if (!p) continue;
    if (!bySize.has(size)) bySize.set(size, []);
    bySize.get(size).push(p);
  }
  return { bySize, gameKey };
}

/**
 * 在复用索引里找一个「和目标文件同内容」的源。
 *
 * 两级判据（严格执行，宁可不复用也不复用错）：
 *   ① Size 必须相同（索引里已保证）；
 *   ② MD5 必须相同 —— 只对候选算 MD5，且最多验 3 个候选就放弃。
 *
 * 安全阀：
 *   · 只接受**同盘**的源（硬链接不能跨卷）；
 *   · 源文件必须真实存在且大小对得上（记账可能过时）；
 *   · 源不能是目标自己。
 *
 * @returns {Promise<string>} 可用的源路径，没有则空串
 */
async function findReusableSource(index, file, targetRoot) {
  if (!index || !index.bySize) return '';
  const size = Number(file.size) || 0;
  if (!size) return '';
  const candidates = index.bySize.get(size);
  if (!candidates || !candidates.length) return '';

  const targetVol = volumeKey(targetRoot);
  const selfPath = path.resolve(file.full).toLowerCase();

  let checked = 0;
  for (const cand of candidates) {
    if (checked >= 3) break; // 最多验 3 个，避免极端情况拖慢
    let candAbs;
    try {
      candAbs = path.resolve(cand);
    } catch {
      continue;
    }
    if (candAbs.toLowerCase() === selfPath) continue;
    // 同盘才行
    if (volumeKey(candAbs) !== targetVol) continue;
    // 存在 + 大小对
    let st;
    try {
      st = await fsp.stat(candAbs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size !== size) continue;
    checked += 1;
    // 同大小还要比内容：用 MD5 确认（只对少数候选算）
    try {
      const [a, b] = await Promise.all([fileMd5(candAbs), fileMd5(file.full)]);
      if (a && b && a === b) return candAbs;
    } catch {
      /* 算不出来就换下一个 */
    }
  }
  return '';
}

/**
 * 算文件 MD5（流式，不整文件读进内存 —— 游戏资源有单文件上 GB 的）。
 * @returns {Promise<string>} 十六进制摘要，失败返回 ''
 */
function fileMd5(p) {
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(p);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', () => resolve(''));
    } catch {
      resolve('');
    }
  });
}

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
  /*
   * 是否回传落位清单。默认关（绝大多数调用方不需要，多存一个数组没意义）。
   * 需要记账的调用方置 true，拿到 placedFiles 后在最终路径确定时调 recordPlacedFiles。
   */
  collectPlaced = false,
      /*
       * 跨渠道复用（借鉴 Starward）：给了 gameKey 就去记账表里找「别的渠道已有的
       * 同内容文件」，直接拿它当硬链接源，省掉大量拷贝和磁盘占用。
       * 默认关 —— 只有「建渠道运行时」这种明确需要省空间的场景才开。
       */
      reuseAcrossChannels = false,
      gameKey = '',
      channel = '',
}) {
  /*
   * 统一入口的进程探活（2026-11-26）：不管哪个游戏、哪条调用链调到这里，
   * 只要源客户端或目标运行时里有进程正在跑，就不开始硬链接。
   * 这一步放在扫描之前，避免扫了几万个文件才失败。
   */
  hardlinkGuard.assertNoGameRunning([sourceRoot, targetRoot], '生成硬链接');
  const files = await walkFiles(sourceRoot, signal, (progress) =>
    onProgress({
      phase: 'scan',
      processed: progress.scanned,
      total: 0,
      current: `扫描基础客户端：${progress.current}`,
    })
  );
  /*
   * 转换时「不处理」的文件先剔掉。
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
  const placedFiles = collectPlaced ? [] : null;
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
  /*
   * ── 跨渠道复用（借鉴 Starward 的 TryHardLinkAsync）──────────────────────
   *
   * 场景：用户已经装了另一个渠道的运行时（比如 B服），现在要生成国际服。
   * 两个渠道有大量文件是完全一样的（本体资源、CefView、各种 dll），
   * 但基础客户端（官服）里可能没有这些 —— 以前只能从官服拷，白占空间。
   *
   * Starward 的做法：查文件记账表，找「别的路径上 size 和 md5 都相同」的文件，
   * 直接拿它当硬链接源。这样切服时能从「另一个渠道已有的那份」链过来，
   * 省掉大量磁盘占用。
   *
   * 我们的实现：
   *   · 只在调用方要求时启用（reuseAcrossChannels=true），默认关；
   *   · 先用 Size 粗筛（查表很快），再局部算 MD5 确认（MD5 只对「大小相同」的算，
   *     数量通常很小，成本可控）；
   *   · 只复用**同盘**的文件（硬链接不能跨卷）；
   *   · 复用失败（源文件被删/被改）就退回原逻辑，不影响正确性。
   */
  let reuseIndex = null;
/*
 * 跨渠道复用：**暂不启用**（保留实现，条件恒 false）。
 *
 * 查了 Starward 的 HardLinkService.TryHardLinkAsync，他那套是为「从零安装」省下载用的：
 * 新装游戏时本机别的盘/别的渠道已有同内容文件，直接硬链接过来不下载。
 *
 * 我们的架构里它省不到东西：建运行时是「从已有基础客户端链」，本来就不下载；
 * 渠道差异文件只有十几个、来自渠道包，也没有「需要找别处借」的。
 * 所以这里条件写成 false ——代码留着（以后真有「从零拼接」的场景能用上），
 * 但不参与实际流程，也不背这个复杂度。
 *
 * 从 Starward 抄过来、在我们这儿**真有价值**的是另外两样：
 *   · canHardlink()：先判盘支不支持硬链接，省掉 FAT32/exFAT 上每文件必然失败的尝试；
 *   · placeOneFile() 的「临时名 + 原子提交」：消除原来 parkAway 那条
 *     「删了旧的、新的还没到位」的空窗。
 */
  if (false && reuseAcrossChannels && gameKey) {
    try {
      reuseIndex = buildReuseIndex({ gameKey, excludeChannel: channel });
    } catch (error) {
      console.warn('[runtime] 跨渠道复用索引建立失败，本次不复用：', error && error.message);
      reuseIndex = null;
    }
  }
  let reused = 0;
  let reusedBytes = 0;

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

    /*
     * 跨渠道复用：先看别的渠道有没有「同大小 + 同 MD5」的文件。
     * 命中就直接拿它当硬链接源 —— 这是 Starward 的做法，切服时能省下大量空间。
     *
     * 只在 shouldCopy=false（原本要走硬链接）时尝试：本来就要拷贝说明这个文件
     * 不该跨渠道共享（比如渠道 SDK、可写索引），复用它等于把老事故再演一遍。
     */
    let reuseSource = '';
    if (!shouldCopy && reuseIndex) {
      reuseSource = await findReusableSource(reuseIndex, file, targetRoot);
    }

    let placed;
    if (reuseSource) {
      const tmpLink = `${destination}.hxl-reuse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let ok = false;
      try {
        await fsp.link(reuseSource, tmpLink);
        ok = true;
      } catch {
        try { await fsp.rm(tmpLink, { force: true }); } catch { /* ignore */ }
        ok = false;
      }
      if (ok) {
        // 建好了临时链接，按原子替换提交
        try {
          const dstExists = await fsp.stat(destination).then(() => true).catch(() => false);
          if (dstExists) await fsp.rm(destination, { force: true });
          await fsp.rename(tmpLink, destination);
          placed = 'reuse';
        } catch {
          try { await fsp.rm(tmpLink, { force: true }); } catch { /* ignore */ }
          placed = null;
        }
      } else {
        placed = null;
      }
      // 复用失败就退回原路径
      if (!placed) {
        placed = await placeOneFile({ rel: file.rel, full: file.full, destination, shouldCopy });
      }
    } else {
      placed = await placeOneFile({ rel: file.rel, full: file.full, destination, shouldCopy });
    }

    if (placed === 'copy') copied += 1;
    else if (placed === 'reuse') { reused += 1; reusedBytes += Number(file.size) || 0; linked += 1; }
    else linked += 1;
    /*
     * 收集落位清单（rel + 是链还是拷）。
     *
     * ★ 为什么这里不直接记账：调用方经常先建在 staging 目录、再整体 rename 到正式目录
     *   （buildEndfieldChannelRuntime / prepareLinkedRuntime 都是这样）。如果在循环里
     *   按 staging 路径记账，rename 之后这些记录就全指向不存在的路径了。
     *   所以这里只回传清单，由调用方在**最终路径确定之后**调 recordPlacedFiles 记账。
     */
    if (placedFiles) placedFiles.push({ rel: file.rel, kind: placed });
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
  // 记账落盘由调用方在最终路径确定后调 recordPlacedFiles 负责，这里不再处理。
  const out = { total: effective.length, processed, linked, copied, reused, reusedBytes, totalBytes, skipped, skippedBytes };
  if (placedFiles) out.placedFiles = placedFiles;
  return out;
}

/**
 * 把 hardlinkTree 回传的落位清单记进记账库（最终路径已确定时调用）。
 *
 * 为什么需要单独一步：调用方常常先建在 staging、再 rename 到正式目录。
 * 只有 rename 之后才能知道文件的最终路径，所以记账必须延后到这里。
 *
 * @param {Array<{rel:string, kind:string}>} placedFiles  hardlinkTree 回传的清单
 * @param {string} finalRoot  最终运行时根目录（rename 之后的正式路径）
 * @param {{gameKey:string, channel:string}} meta
 * @returns {{recorded:number, failed:number}}
 */
function recordPlacedFiles(placedFiles, finalRoot, meta = {}) {
  const result = { recorded: 0, failed: 0 };
  if (!Array.isArray(placedFiles) || !placedFiles.length) return result;
  if (!finalRoot || !meta.gameKey) return result;
  for (const item of placedFiles) {
    try {
      gameFileDb.upsert({
        path: path.join(finalRoot, item.rel),
        gameKey: meta.gameKey,
        channel: meta.channel || '',
      });
      result.recorded += 1;
    } catch {
      result.failed += 1;
    }
  }
  try {
    gameFileDb.persist();
  } catch (error) {
    console.warn('[runtime] 文件记账落盘失败：', error && error.message);
  }
  return result;
}

/**
 * 文件记账（异步 + 后台，不阻塞界面）。
 *
 * ── 为什么改成后台 ───────────────────────────────────────────────
 * 用户实测（2026-11-26）：「终末地硬链接收尾的记账很慢」。
 *
 * 根因是 readFileId 每个文件 spawn 一次 `fsutil file queryfileid`，
 * 实测单次 52.8ms。终末地 2567 个文件 → 约 136 秒，全花在创建子进程上。
 * 就算用 setImmediate 让出事件循环，主进程仍然被同步 spawn 占满。
 *
 * ── 现在的做法 ──────────────────────────────────────────────────
 * 记账只是「锦上添花」：它用于以后判断「这个渠道运行时装没装好」，
 * 不参与启动、不影响游戏文件本身。
 * 所以：
 *   ① 先按目录分组，同目录的文件一次处理；
 *   ② 每处理一个文件就 await 一次 setImmediate，让 IPС 和渲染进程拿到 CPU；
 *   ③ 整体在后台跑，调用方用 await 拿结果的场景传 options.background=true
 *      就会立刻返回 {queued:true}，不阻塞收尾。
 */
async function recordPlacedFilesAsync(placedFiles, finalRoot, meta = {}, options = {}) {
  const result = { recorded: 0, failed: 0 };
  if (!Array.isArray(placedFiles) || !placedFiles.length) return result;
  if (!finalRoot || !meta.gameKey) return result;

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const signal = options.signal || null;
  /* 记账批次提示的节奏：每 200 个报一次，别让界面刷屏 */
  const progressEvery = Number(options.progressEvery) || 200;

  for (let i = 0; i < placedFiles.length; i += 1) {
    if (signal && signal.cancelled) break;
    const item = placedFiles[i];
    const abs = path.join(finalRoot, item.rel);
    try {
      gameFileDb.upsert({
        path: abs,
        gameKey: meta.gameKey,
        channel: meta.channel || '',
      });
      result.recorded += 1;
    } catch {
      result.failed += 1;
    }
    /*
     * 每个文件都让出一次事件循环。
     * 这比「每 64 个让一次」有效得多：upsert 内部是同步 spawn（52ms），
     * 攒 64 个再让，界面就要卡 3 秒多。逐个让，单次最多卡 52ms，用户感知不到。
     */
    await new Promise((resolve) => setImmediate(resolve));
    if (onProgress && (i + 1) % progressEvery === 0) {
      onProgress({
        phase: 'record',
        processed: i + 1,
        total: placedFiles.length,
        current: `正在记账 ${i + 1}/${placedFiles.length}`,
      });
    }
  }

  try {
    gameFileDb.persist();
  } catch (error) {
    console.warn('[runtime] 文件记账落盘失败：', error && error.message);
  }
  return result;
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
    /* rename 前占用探测：被游戏/启动器独占的文件不硬改，直接给出可操作的中文提示 */
    if (hardlinkGuard.isFileLocked(destination)) {
      throw new Error(
        `无法替换渠道文件 ${file.rel}：文件正被游戏或官方启动器占用。请完全退出它们后重试。`
      );
    }
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

/**
 * 把旧运行时里「仍与别处共享 inode 的可写状态文件」断链成独立拷贝。
 *
 * 用户反馈：只有游戏内闪断更新之后，切服才会一直报「文件缺失或损坏」，
 * 而且 B 服热更后切官服坏、再切回 B 服也坏。现场规律是：本机每个服都会各自弹一次
 * 闪断更新（Persistent 下 index_main.json / pref_*.json / VFS\*.blc 的 nlink=1），
 * 出问题的机器上这些索引仍是老版本运行时留下的硬链接。
 *
 * 闪断更新对这批索引是**同 inode 原地写**（2026-11-07 事故已确认），硬链接状态下
 * 一次热更会把所有渠道的索引一起写成新版本；别的渠道并没有下载对应的 .chk，
 * 于是「索引说有 181 个，实际只有 137 个」→ 一直判缺失，且再下再写还是共享文件。
 *
 * .chk 不动：热更落地走 rename（2026-11-08 HGDownloadLog 一手证据），替换后只是
 * 换 inode，另一侧不受影响；66GB 继续硬链接。
 *
 * 每次启动前跑一遍，健康树是 0 次拷贝，老树会一次性修好。
 */
async function breakSharedPersistentState(runRoot, options = {}) {
  const root = path.join(runRoot, 'Endfield_Data', 'Persistent');
  const result = { checked: 0, broke: 0, failed: 0, bytes: 0 };
  try {
    if (!(await fsp.stat(root)).isDirectory()) return result;
  } catch {
    return result;
  }

  async function walk(dir) {
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        await walk(full);
        continue;
      }
      if (/\.chk$/i.test(it.name)) continue;
      result.checked += 1;
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      if (st.nlink <= 1) continue;
      const tmp = `${full}.vela-deshed`;
      try {
        // 先写到新 inode，再 rename 覆盖：copyFile 直接写已有硬链接会顺着 inode 写穿
        await fsp.copyFile(full, tmp);
        await fsp.utimes(tmp, st.atime, st.mtime);
        await fsp.rename(tmp, full);
        result.broke += 1;
        result.bytes += st.size;
      } catch (error) {
        result.failed += 1;
        try {
          await fsp.rm(tmp, { force: true });
        } catch {}
        if (typeof options.onError === 'function') options.onError(full, error);
      }
    }
  }

  await walk(root);
  return result;
}

module.exports = {
  prepareLinkedRuntime,
  walkFiles,
  hardlinkTree,
  // 文件记账（借鉴 Starward）：hardlinkTree 回传清单，最终路径确定后记进 GameFile.db
  recordPlacedFiles,
  recordPlacedFilesAsync,
  canHardlink,
  clearVolumeHardlinkCache,
  copyTree,
  removeTreeResilient,
  // 终末地单工作目录切服用：切服时原地覆盖渠道文件，不再重建整树。
  overlayDirectory,
  // 建单工作目录（以及基线刷新）时判断「拷贝还是硬链接」。
  mustCopyNotLink,
  isMutableIndexFile,
  // 闪断更新前修复老树：Persistent 下仍共享 inode 的非 .chk 状态文件断链。
  breakSharedPersistentState,
};
