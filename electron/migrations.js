'use strict';

/**
 * 升级迁移表。
 *
 * ── 为什么要有这个东西 ────────────────────────────────────────────────
 *
 * 每次版本升级都会「换掉」一些东西：旧功能下线、数据格式变更、目录搬家、
 * 字段废弃。这些东西的残留如果没人清，就会一直堆在用户硬盘上 ——
 * 用户看到的只是「怎么越来越占地方」，而我们这边根本不知道谁该清谁。
 *
 * 以前是零散的：
 *   · migrateLegacyUserData()        —— 只处理「从 %APPDATA% 搬到便携版」那一件事
 *   · purgeLegacyChunkCache()        —— 只处理 sophon-cache/chunks
 *   · cleanupLegacyEndfieldBackup()  —— 只处理终末地语音包备份
 * 每加一个都得记得再写一个函数、再挂一次启动，漏了就永久残留。
 *
 * 这个模块把它们收成一张**声明式迁移表**：一条 = 一个已经在某版被替换/废弃的
 * 东西 + 从哪个版本开始清 + 怎么判断它确实是「遗留」（而不是用户现在还在用的）。
 *
 * ── 三条铁律 ──────────────────────────────────────────────────────────
 *
 * 1. **只清「确定是遗留」的，绝不清「用户自己的」**。
 *    判断依据必须来自「我们以前会生成/放这个东西」，不能靠名字像不像。
 *    反例：`art-pack/` 里是用户自己放的素材包、`lx-sources/` 里是用户导入的音源
 *    脚本 —— 这两样长得像「旧数据」，但删了就是删用户的东西。
 *
 * 2. **清理必须幂等、可中断**。删一半断电了，下次启动要能继续删完，
 *    不能因为「记录里说清过了」就跳过实际还留着的文件。
 *    做法：完成才写标记；失败不写，下次重试。
 *
 * 3. **每个版本只跑一次，但标记按「条目」记**，不是全局一个版本号。
 *    这样以后新增条目时，老用户升级上来也会被执行（不会被「本版已迁移」挡住）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 标记文件名（放 userData 下）。内容：{ [entryId]: { at, version } } */
const MARKER_NAME = '.migrations.json';

/**
 * 主程序显示名，用来拼安装目录里的卸载入口文件名。
 *
 * 为什么写死：迁移模块刻意不依赖 Electron（不 require('electron')），
 * 拿不到 app.getName()；而这个名字必须和安装器 installer/main.js 的
 * APP_NAME、electron/main.js 里的 APP_EXE 完全一致，否则建出来的入口
 * 名字对不上，用户看到的还是旧的那个。
 */
const APP_DISPLAY_NAME = '花筱灵启动器';

/* ── 迁移表 ─────────────────────────────────────────────────────────── */

/**
 * 字段说明：
 *   id        唯一标识，写进标记文件。**改了 id = 这条会重跑**，所以定下来别动。
 *   since     从哪个版本开始执行（用来在说明里写清楚「哪版换掉的」）
 *   desc      人话说明：这是什么、为什么可以删
 *   paths     userData 下的相对路径（文件或目录）
 *   guard     可选：返回 false 表示「这不是遗留，别删」
 *   estimate  可选：估算体积（日志用）
 */
const MIGRATIONS = [
  /*
   * ★ 以下两条**故意不放进这张表**，因为它们已经有专用清理函数，而且那个函数
   *   带「当前有任务在跑就先别清」的忙碌保护 —— 那正是这类清理最要紧的东西：
   *     · sophon-cache/chunks        → cache-purge.js 的 purgeLegacyChunkCache()
   *     · endfield-persistent-backup → main.js 的 cleanupLegacyEndfieldBackup()
   *   这张表里如果再来一份，就会绕开忙碌保护（可能正下载到一半把缓存删了），
   *   而且两边标记互不知情、重复劳动。所以「有专人管的」不进这张表。
   *
   *   这张表只收「没人管、纯遗留」的那些。
   */
  {
    id: 'endfield-legacy-work-runtime',
    since: '2.13.0',
    desc: '2026-11-08 那一版「所有非官服渠道共用一个 work 目录」的混合运行时。'
      + '里面是「国际服重二进制 + 某渠道 SDK」的拼装结果，启动 3~9 秒就崩，必须清。',
    paths: ['endfield-work'],
  },
  {
    id: 'netease-legacy-qr-session',
    since: '2.12.0',
    desc: '旧版网易云「本地 NeteaseCloudMusicApi 代做扫码」留下的会话记录。'
      + '现在改成内置浏览器登录，这份已经没有任何代码读它了。'
      + '★ 只清「二维码会话」这一个文件名，不动其它登录态（用户可能还在用）。',
    paths: ['netease-qr-session.json'],
  },
  {
    id: 'electron-crash-preferences-tmp',
    since: '2.12.0',
    desc: 'Electron 崩溃时留下的 Preferences 临时文件（Preferences<uuid>.tmp）。'
      + '这些是 Chromium 写配置写到一半崩掉的残片，程序不会读，只会一直堆着。',
    paths: [],
    // 用 glob 匹配：Preferences<uuid>.tmp
    globs: [/^Preferences[0-9a-f-]{20,}\.tmp$/i],
  },
  {
    id: 'gamefile-db-from-v1',
    since: '2.13.1',
    desc: '文件记账库（GameFile.db）从 v1 schema 升级时，旧库里可能残留已不存在的运行时路径记录。'
      + '这些记录指向的文件早没了，留着只会让「查表验证完整性」永远失败、落到旧的目录标记判据。'
      + '★ 只清**记录**，不动任何真实文件；清完下次生成运行时会重新记账。',
    paths: [],
    // 特殊处理：不是删文件，而是清库里失效的记录。由 guard + 单独逻辑处理。
    dbCleanup: 'orphan-rows',
  },
  {
    id: 'uninstall-entry-v2',
    since: '2.14.0',
    desc: '「设置 → 应用 → 卸载」里那条记录还是旧安装器写的（指向 Uninstall 花筱灵启动器.exe，'
      + '或指向早已不存在的目录）。老用户走增量更新，不会重跑安装器，所以这条永远修不好，'
      + '点「卸载」看到的还是旧界面、甚至没反应。'
      + '这里改成指向主程序自己：花筱灵启动器.exe --uninstall，并把残留的旧项/僵尸项清掉。',
    paths: [],
    // 特殊处理：操作对象是注册表，不是 userData 里的文件。
    registryRepair: true,
  },
  {
    /*
     * id 带 v3 而不是沿用 v2：v2 那版有个真 bug —— 只要安装目录里「有」同名 exe 就跳过，
     * 而老用户目录里躺着的是 2.8.0 时代 NSIS 安装器留下的 363KB 旧卸载器，
     * 于是 v2 判定「已存在」、写入 ok 标记、从此永不重跑，用户点卸载永远是旧界面。
     * 换成新 id 才能让这批人重新执行一次（条目级标记，改 id 等于新增条目）。
     */
    id: 'uninstall-shortcut-v3',
    since: '2.14.0',
    desc: '安装目录里少一个能双击的卸载入口（用户习惯在文件夹里找 Uninstall）。'
      + '新装用户由安装器直接建；老用户走完整包更新时不会重跑安装器，所以这里补建。'
      + '用硬链接（不是复制）—— 和主程序是同一个文件，不额外占 250MB，'
      + '主程序按 exe 文件名前缀 /^uninstall/i 认卸载模式。',
    paths: [],
    // 特殊处理：在安装目录建硬链接。
    uninstallShortcut: true,
  },
];

/* ── 实现 ───────────────────────────────────────────────────────────── */

function markerPath(userData) {
  return path.join(userData, MARKER_NAME);
}

function readMarkers(userData) {
  try {
    const raw = fs.readFileSync(markerPath(userData), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMarkers(userData, markers) {
  try {
    const p = markerPath(userData);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(markers, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (error) {
    console.warn('[migrations] 写标记失败：', error && error.message);
  }
}

/** 目录体积（日志用，失败返回 0）。 */
function dirSize(p) {
  let total = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
  } catch {
    return 0;
  }
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(full);
        else total += fs.statSync(full).size;
      } catch {
        /* 单个失败跳过 */
      }
    }
  }
  return total;
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

/**
 * 跑一遍迁移。
 *
 * @param {object} options
 * @param {string} options.userData  数据目录
 * @param {string} [options.version] 当前版本（只写进标记，不参与判断）
 * @param {(msg:string)=>void} [options.onLog]
 * @param {boolean} [options.dryRun] 只报告要清什么，不真删
 * @returns {Promise<{removed:number, freed:number, skipped:number, entries:Array}>}
 */
async function runMigrations(options = {}) {
  const { userData, version = '', onLog = () => {}, dryRun = false } = options;
  const result = { removed: 0, freed: 0, skipped: 0, entries: [] };
  if (!userData) return result;

  const markers = readMarkers(userData);
  let changed = false;

  for (const entry of MIGRATIONS) {
    // 已经跑过且成功：跳过（条目级标记，新增条目不会被老标记挡住）
    if (markers[entry.id] && markers[entry.id].ok) {
      result.skipped += 1;
      continue;
    }

    /* ── 特殊：修「设置 → 应用 → 卸载」里那条注册表记录 ── */
    if (entry.registryRepair) {
      try {
        /*
         * 安装目录 = 主程序 exe 所在目录。
         * 这里不能用 app.getPath 之类（迁移模块不依赖 Electron），
         * 而且卸载记录本来就该指向「把这个 exe 装在哪了」。
         */
        const installDir = path.dirname(process.execPath);
        const reg = require('./uninstall-registry');
        const repaired = reg.repairUninstallRegistry({ installDir, version, dryRun });
        if (!repaired.ok) {
          // 注册表没改成功（权限/杀软拦截）：不写标记，下次启动再试
          onLog(`[migrations] ${entry.id} 失败：${repaired.error}`);
          result.entries.push({ id: entry.id, desc: entry.desc, freed: 0, failed: 1, removed: 0 });
          continue;
        }
        if (repaired.removedNames.length > 0) {
          onLog(`[migrations] ${entry.id}：清掉旧卸载项 ${repaired.removedNames.join('、')}`);
        }
        // dry-run 时上面那句会照着 installDir 打印，看起来像已经改了 —— 标明是预演
        onLog(`[migrations] ${entry.id}：卸载入口${dryRun ? '将指向（预演）' : '已指向'} ${installDir}`);
        if (!dryRun) {
          markers[entry.id] = {
            ok: true,
            at: new Date().toISOString(),
            version,
            removed: repaired.removedNames.length,
          };
          changed = true;
        }
        result.entries.push({
          id: entry.id,
          desc: entry.desc,
          freed: 0,
          failed: 0,
          removed: repaired.removedNames.length,
        });
      } catch (error) {
        onLog(`[migrations] ${entry.id} 失败：${error && error.message}`);
        result.entries.push({ id: entry.id, desc: entry.desc, freed: 0, failed: 1, removed: 0 });
      }
      continue;
    }

    /* ── 特殊：在安装目录补建可双击的卸载入口（硬链接）── */
    if (entry.uninstallShortcut) {
      try {
        const installDir = path.dirname(process.execPath);
        const appExe = process.execPath;
        const uninstExe = path.join(installDir, `Uninstall ${APP_DISPLAY_NAME}.exe`);

        // 已经在跑卸载模式（自己就是这个入口）→ 什么都不用做
        if (path.basename(appExe).toLowerCase().startsWith('uninstall')) {
          result.skipped += 1;
          continue;
        }
        /*
         * 已存在时要分清「是谁的」：
         *  - 老版本（≤2.13.1）是 NSIS 安装器留在安装目录里的 Uninstall xxx.exe，只有几百 KB，
         *    点它跑的是旧 NSIS 卸载逻辑，会删不干净、也换不成新窗口 —— 必须删掉重建。
         *  - 已经是我们自己的入口（硬链接或复制的主程序本体，大小和主 exe 一样）→ 不动。
         * 早先这里写的是「存在就跳过」，结果是老用户永远卡在旧卸载器上（标记一旦写成 ok 就不再重跑）。
         */
        if (fs.existsSync(uninstExe)) {
          let ours = false;
          try {
            const a = fs.statSync(appExe);
            const b = fs.statSync(uninstExe);
            ours = a.size === b.size && Number(a.ino) === Number(b.ino) && Number(a.ino) !== 0;
            if (!ours && a.size === b.size) ours = true; // 非 NTFS 退回复制时 ino 不同，大小相等也认
          } catch {
            ours = false;
          }
          if (ours) {
            result.skipped += 1;
            if (!dryRun) {
              markers[entry.id] = { ok: true, at: new Date().toISOString(), version, note: 'already exists' };
              changed = true;
            }
            continue;
          }
          if (dryRun) {
            onLog(`[migrations] ${entry.id}：安装目录里那个卸载入口是旧版本的（将替换）`);
            result.entries.push({ id: entry.id, desc: entry.desc, freed: 0, failed: 0, removed: 0 });
            continue;
          }
          try {
            fs.rmSync(uninstExe, { force: true });
          } catch (removeError) {
            onLog(`[migrations] ${entry.id}：旧卸载入口删不掉（${removeError && removeError.message}），下次再试`);
            result.entries.push({ id: entry.id, desc: entry.desc, freed: 0, failed: 1, removed: 0 });
            continue;
          }
        }
        if (dryRun) {
          result.entries.push({ id: entry.id, desc: entry.desc, freed: 0, failed: 0, removed: 0 });
          continue;
        }
        let made = 'link';
        try {
          fs.linkSync(appExe, uninstExe);
        } catch {
          // 非 NTFS（FAT32/exFAT）不支持硬链接，退回复制一份
          fs.copyFileSync(appExe, uninstExe);
          made = 'copy';
        }
        onLog(`[migrations] ${entry.id}：已在 ${installDir} 补建卸载入口（${made}）`);
        markers[entry.id] = { ok: true, at: new Date().toISOString(), version, note: made };
        changed = true;
        result.entries.push({ id: entry.id, desc: entry.desc, freed: 0, failed: 0, removed: 0 });
      } catch (error) {
        onLog(`[migrations] ${entry.id} 失败：${error && error.message}`);
        result.entries.push({ id: entry.id, desc: entry.desc, freed: 0, failed: 1, removed: 0 });
      }
      continue;
    }

    /* ── 特殊：清记账库里的失效记录（不删任何真实文件）── */
    if (entry.dbCleanup === 'orphan-rows') {
      try {
        const gdb = require('./game-file-db');
        if (!gdb.isOpen()) {
          // 库没开：不算失败，下次启动再说（不写标记）
          result.skipped += 1;
          continue;
        }
        const removed = gdb.pruneMissingRows();
        if (removed > 0) {
          onLog(`[migrations] 已清 ${entry.id}：记账库里 ${removed} 条记录指向的文件已不存在`);
        }
        if (!dryRun) {
          markers[entry.id] = { ok: true, at: new Date().toISOString(), version, removed };
          changed = true;
        }
        result.entries.push({ id: entry.id, desc: entry.desc, freed: 0, failed: 0, removed });
      } catch (error) {
        onLog(`[migrations] ${entry.id} 失败：${error && error.message}`);
      }
      continue;
    }

    if (typeof entry.guard === 'function') {
      try {
        if (!entry.guard(userData)) {
          result.skipped += 1;
          continue;
        }
      } catch {
        result.skipped += 1;
        continue;
      }
    }

    const targets = [];
    for (const rel of entry.paths || []) {
      const full = path.join(userData, ...rel.split('/'));
      try {
        if (fs.existsSync(full)) targets.push(full);
      } catch {
        /* ignore */
      }
    }
    // glob 匹配（只看 userData 顶层）
    if (entry.globs && entry.globs.length) {
      try {
        for (const name of fs.readdirSync(userData)) {
          if (entry.globs.some((re) => re.test(name))) {
            targets.push(path.join(userData, name));
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (!targets.length) {
      // 没有要清的：也记为完成，避免每次启动都重新看一遍
      if (!dryRun) {
        markers[entry.id] = { ok: true, at: new Date().toISOString(), version, note: 'nothing to remove' };
        changed = true;
      }
      result.skipped += 1;
      continue;
    }

    let freed = 0;
    let failed = 0;
    for (const target of targets) {
      const size = dirSize(target);
      if (dryRun) {
        onLog(`[migrations] (dry) 会清 ${entry.id}：${target}（${formatBytes(size)}）`);
        freed += size;
        continue;
      }
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        freed += size;
        onLog(`[migrations] 已清 ${entry.id}：${target}（${formatBytes(size)}）`);
      } catch (error) {
        failed += 1;
        onLog(`[migrations] 清理失败 ${entry.id}：${target} —— ${error && error.message}`);
      }
    }

    result.entries.push({ id: entry.id, desc: entry.desc, freed, failed, targets: targets.length });
    result.freed += freed;
    result.removed += targets.length - failed;

    // 只有全部成功才写完成标记；有失败下次启动重试
    if (!dryRun && failed === 0) {
      markers[entry.id] = { ok: true, at: new Date().toISOString(), version, freed };
      changed = true;
    }
  }

  if (changed && !dryRun) writeMarkers(userData, markers);
  return result;
}

/** 列出迁移表（给诊断/文档用）。 */
function listMigrations() {
  return MIGRATIONS.map((m) => ({ id: m.id, since: m.since, desc: m.desc, paths: m.paths || [], hasGlobs: Boolean(m.globs) }));
}

module.exports = { runMigrations, listMigrations, MIGRATIONS, MARKER_NAME };
