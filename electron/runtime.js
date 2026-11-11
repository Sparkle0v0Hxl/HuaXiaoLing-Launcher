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

function mustCopyNotLink(rel) {
  const relLower = String(rel).toLowerCase().replace(/\\/g, '/');
  const segments = relLower.split('/');
  const topDir = segments[0];
  const baseName = segments[segments.length - 1];

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

async function hardlinkTree({ sourceRoot, targetRoot, onProgress = () => {}, signal, copyDirs = [] }) {
  const files = await walkFiles(sourceRoot, signal, (progress) =>
    onProgress({
      phase: 'scan',
      processed: progress.scanned,
      total: 0,
      current: `扫描基础客户端：${progress.current}`,
    })
  );
  let processed = 0;
  let linked = 0;
  let copied = 0;
  let lastEmit = 0;
  /*
   * 字节量：walkFiles 已经把每个文件的 size 存下来了，这里直接累加，零额外 IO。
   * 之前只报文件个数，界面上「整理文件 4200/11300」用户根本判断不了还要多久
   * （一个大 .chk 和一个小 .ini 在计数里长得一样）。
   */
  let bytesDone = 0;
  const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
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
  for (const file of files) {
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
    try {
      if (shouldCopy) {
        await fsp.copyFile(file.full, destination);
        copied += 1;
      } else {
        await fsp.link(file.full, destination);
        linked += 1;
      }
    } catch {
      try {
        await fsp.copyFile(file.full, destination);
        copied += 1;
      } catch (error) {
        throw new Error(`无法创建 ${file.rel}：${error.message}`);
      }
    }
    processed += 1;
    bytesDone += Number(file.size) || 0;
    const now = Date.now();
    if (now - lastEmit > 160) {
      lastEmit = now;
      onProgress({
        phase: 'link',
        processed,
        total: files.length,
        linked,
        copied,
        bytesDone,
        totalBytes,
        current: file.rel,
      });
    }
  }
  // 收尾强推一帧满进度：别让界面停在最后一个节流点（比如 99%）
  if (files.length) {
    onProgress({
      phase: 'link',
      processed: files.length,
      total: files.length,
      linked,
      copied,
      bytesDone: totalBytes,
      totalBytes,
      current: '',
    });
  }
  return { total: files.length, processed, linked, copied, totalBytes };
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
    } catch {
      // 目标不存在（第一次铺）或改名也失败：退回删除，删不掉就让 copyFile 报真错
      await fsp.rm(destination, { force: true }).catch(() => {});
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
    // 挪开的旧文件尽量清掉；清不掉（ACL 挡着）也只是几十字节的垃圾，
    // 绝不能因为清理失败就把整次切服中断
    if (parkedOk) await fsp.rm(parked, { force: true }).catch(() => {});
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
