'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { powershellExe } = require('./ps-path');

/**
 * 一个「提权脚本一定能读到」的目录。
 *
 * 不用 os.tmpdir()：在 Git Bash / 某些便携启动方式下它会给 POSIX 风格的 `/tmp`，
 * PowerShell 打不开，提权脚本直接空跑（2026-11-25 实测踩到，表现为点了没反应）。
 * 优先用 Electron 的 userData（已存在、权限稳），拿不到就退到程序目录。
 */
function runtimeScriptDir() {
  try {
    // 延迟 require：这个模块也会被纯 Node 脚本（回归测试）直接加载，那时没有 electron
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const dir = path.join(app.getPath('userData'), 'run');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
  } catch {
    /* 跑在纯 Node 里，没有 app */
  }
  const fallback = path.join(path.dirname(process.execPath), 'run');
  try {
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch {
    return process.env.TEMP || process.env.TMP || '.';
  }
}

const endfieldOfficialDirs = require('./endfield-official-dirs');

/*
 * 终末地「官方托管启动」——用官方启动器自己去拉游戏。
 *
 * ── 为什么必须这样 ──────────────────────────────────────────────
 * 终末地的客户端（U8SDK.dll）会取自己的**直接父进程**的小写全路径，再拿它去比对
 * 官方启动器的路径；对不上就弹「游戏启动失败 / 请通过官方启动器打开游戏」。
 *
 * 所以这里**真的去跑官方启动器**，由它亲自 CreateProcess 拉起游戏。
 * 父进程是真的 Games.exe，游戏侧的校验天然通过，我们唯一做的事相当于
 * 「替用户点了那个按钮」。官方启动器在 `--game=<uuid>` 模式下本来就是托盘常驻、
 * 窗口隐藏，用户看不到界面。
 *
 * ── 怎么点那个按钮 ──────────────────────────────────────────────
 * 官方启动器界面是 Qt WebEngine 渲染的网页（res/web/index.html）。用环境变量
 * `QTWEBENGINE_REMOTE_DEBUGGING` 打开它的 DevTools 端口，再走 CDP 在页面里调
 * 官方自己的桥：window.jsbridge.SendMsgToNative('click_main_btn', {uuid})。
 * 这就是页面上那颗「开始游戏」按钮的 onClick 原文，一个字符都没改。
 *
 * ── 换服怎么办（junction）───────────────────────────────────────
 * 官方启动器把安装路径存在自己的加密库里（eld_Games.db 是 SQLCipher，密钥拿不到），
 * 而且它**不扫盘符**，路径只在库里。所以没法让它指向我们生成的渠道运行时。
 * 但实测它完全接受「安装目录是 junction」：把 `G:\Arknights Endfield` 改名成
 * `.hxl-base`，再建一个同名 junction 指到目标目录，它读 config.ini / 校验 entry
 * 全绿（games.log 与真实目录逐行一致，eGameFileState:1、bEntryFileValid:true）。
 * 所以切服时临时把 junction 指到对应渠道运行时，启动完再换回来。
 *
 * ── 三道闸门（防官方启动器把渠道运行时写坏）──────────────────────
 * 官方启动器一旦触发「更新游戏」，会往当前安装目录写大量重二进制和清单文件。
 * 如果那时目录正指着渠道运行时，那个运行时就被污染了（跟 11-07 官服被污染同款）。
 *   闸 1：点之前先问官方启动器「按钮现在是什么状态」（main_btn_state_req）。
 *         只有 start_game / prepare_start_game 才允许点；任何 download_* /
 *         update_game / installing 一律不点，直接告诉用户原因。
 *   闸 2：非官服渠道下，只要状态里带更新/下载语义就整体拒绝，绝不换 junction 再点。
 *   闸 3：启动器启动时自检——如果安装目录是 junction 但没有游戏/启动器在跑，
 *         说明上次没来得及换回来（崩溃、断电），立刻复位回官服真目录。
 */

/** 官方托管启动用的 DevTools 端口扫描区间。避开常见开发端口。 */
const PORT_FROM = 9330;
const PORT_TO = 9399;

/** 官方启动器进程名（托盘常驻那个）。 */
const OFFICIAL_PROCESS_NAME = 'Games.exe';
/** 游戏本体进程名，用来判断「游戏还在跑」。 */
const GAME_PROCESS_NAME = 'Endfield.exe';

/** 允许点击的状态（官方前端 main_btn 的 state 枚举）。 */
const CLICKABLE_STATES = new Set(['start_game', 'prepare_start_game']);
/**
 * 一旦出现这些状态就说明官方启动器准备写盘了（下载 / 校验 / 安装 / 待更新）。
 * 这时候绝不能点，也绝不能让它对着渠道运行时的目录干活。
 */
const WRITE_RISK_STATES = new Set([
  'download_game',
  'continue_download',
  'downloading',
  'checking_download_zip',
  'checking_game_complete',
  'installing',
  'download_except',
  'download_paused',
  'queuing_download',
  'update_game',
]);

/** 游戏已经在跑——不用再点，直接当成已启动。 */
const IN_GAME_STATES = new Set(['in_game']);

/** 需要用户先去官方启动器处理的其它状态，给一句人话。 */
const NEED_USER_STATES = {
  need_login: '官方启动器要求先登录鹰角账号，请先打开一次官方启动器登录。',
  need_purchase: '这个渠道在官方启动器里显示未购买 / 未入库，请先用官方启动器完成校验。',
  game_service_stopped: '官方启动器说游戏服务没起来，请先打开官方启动器确认一次。',
  unbook: '这个渠道还没有在官方启动器里登记，请先打开一次官方启动器。',
  booked: '这个渠道官方启动器还在预约状态，暂时不能启动。',
  disable_download: '官方启动器把这个渠道标成不可下载，启动不了。',
};

/** 后台藏着的安装目录后缀：`G:\Arknights Endfield` → `G:\Arknights Endfield.hxl-base`。 */
const BASE_HOLD_SUFFIX = '.hxl-base';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── 官方启动器窗口隐身 ─────────────────────────────────────────────
 *
 * 用户诉求（2026-11-25 原话）：「还是会拉起官方启动器的话，就没意义了，
 * 缺你那用官方启动器点一下吗？大伙都是不喜欢官方启动器，肯定希望设置后，
 * 点了就能进」。
 *
 * 实测结论（当天验证过，见下）：终末地的启动授权由 U8 SDK 强校验，直接跑
 * Endfield.exe 一定会弹「游戏启动失败，请通过官方启动器打开游戏」
 * （Player.log: `PC launch auth extraInfo failed ... errorCode: 10100`）。
 * 不带 --game 参数也一样。也就是说官方启动器**必须存在**，绕不过去。
 *
 * 但「必须存在」不等于「必须让用户看见」。实测（Qt WebEngine 的调试端口）：
 *   · ShowWindow(SW_HIDE) 之后 CDP 依然可用，能查状态、能点按钮
 *   · 点击后 3 秒 Endfield.exe 就起来了，窗口全程不可见
 * 所以链路改成：起启动器 → 连调试口 → **立刻隐身** → 点按钮 → 游戏起来。
 *
 * 隐身失败绝不能影响启动（比如找不到窗口句柄），只记日志、继续走原来的点击。
 */

/** 取某进程的主窗口句柄；没有窗口返回 0。 */
function mainWindowHandle(processName) {
  try {
    const ps = [
      `$p = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue |`,
      '  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
      'if ($p) { $p.MainWindowHandle } else { 0 }',
    ].join('\n');
    const out = execFileSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    return parseInt(String(out).trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * 把官方启动器窗口最小化（用户 2026-11-25 拍的方案：「启动后你秒最小化缩了不就完事了嘛」）。
 *
 * 为什么最小化而不是隐藏：
 *   · 隐藏（SW_HIDE / 移到屏幕外）是纯视觉把戏，窗口还在、渲染还在跑，
 *     而且用户完全找不到它，出问题时连手动点一下的余地都没有；
 *   · 最小化是系统原生行为，任务栏上留一个可还原的按钮，行为可解释、可回退。
 *
 * 句柄拿不到（还没建窗口）就等下一轮，不报错 —— 这一步失败绝不影响启动。
 */
function minimizeWindow(hwnd) {
  if (!hwnd) return false;
  const ps = [
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class HxlMin {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
    '}',
    '"@',
    `[HxlMin]::ShowWindow([IntPtr]${hwnd}, 6) | Out-Null`, // 6 = SW_MINIMIZE
    "'ok'",
  ].join('\n');
  try {
    execFileSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 游戏起来后把官方启动器收掉（进程结束，任务栏与托盘一起消失）。
 *
 * 用户诉求（2026-11-25）：「进去游戏后，直接把官方启动器关掉，托盘都不残留」。
 *
 * 判定「该关了」用两条，任一满足即可 —— 只认窗口太脆（游戏全屏切换、无边框
 * 窗口、多显示器都可能让 MainWindowHandle 瞬时为 0，实测就漏过一次）：
 *   · Endfield.exe 的主窗口句柄出现
 *   · Endfield.exe 进程已经存活超过 12 秒（窗口还没建，但启动校验早已通过）
 *
 * ★ 绝不能 taskkill /T：
 *   官方启动器是游戏进程的父进程，/T 会顺着进程树把 Endfield.exe 一起杀掉。
 *   实测第一次就撞上：接口返回 ok、pid 也有，但几秒后游戏进程为 0。
 *
 * ★ 只关「我们自己起的那个 pid」：用户本来开着官方启动器的话，那不是我们的进程。
 */
async function retireOfficialLauncher(launcherPid, gamePid, onLog) {
  if (!launcherPid && !isPidAlive(findProcessByName(OFFICIAL_PROCESS_NAME))) return false;

  const started = Date.now();
  const deadline = started + 40000;
  let ready = false;
  let reason = '';
  while (Date.now() < deadline) {
    if (!isPidAlive(gamePid)) return false; // 游戏自己没了，交给上层
    if (mainWindowHandle(GAME_PROCESS_NAME)) {
      reason = '窗口已出现';
      ready = true;
      break;
    }
    if (Date.now() - started > 12000) {
      reason = '进程已稳定 12 秒';
      ready = true;
      break;
    }
    const hwnd = mainWindowHandle(OFFICIAL_PROCESS_NAME);
    if (hwnd) minimizeWindow(hwnd);
    await delay(500);
  }
  if (!ready) {
    onLog?.('[endfield] 40 秒内没等到游戏就绪，暂不关闭官方启动器');
    return false;
  }
  /* 关之前再确认一次游戏还活着，避免关在它崩溃的瞬间 */
  if (!isPidAlive(gamePid)) return false;
  await delay(1500);

  const targetPid =
    launcherPid || (countProcess(OFFICIAL_PROCESS_NAME) === 1 ? findProcessByName(OFFICIAL_PROCESS_NAME) : 0);
  if (!targetPid) {
    onLog?.('[endfield] 没有可收的官方启动器进程（可能用户自己开着一个，不动它）');
    return false;
  }
  if (!isPidAlive(targetPid)) {
    onLog?.('[endfield] 官方启动器已经自己退出了');
    return true;
  }

  /* 只杀这一个 pid，不带 /T */
  try {
    execFileSync('taskkill', ['/PID', String(targetPid), '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
  } catch {
    /* 下一轮再试 */
  }
  for (let i = 0; i < 15; i += 1) {
    await delay(400);
    if (!isPidAlive(targetPid)) break;
  }
  if (isPidAlive(targetPid)) {
    try {
      execFileSync('taskkill', ['/PID', String(targetPid), '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
    } catch {
      /* 还杀不掉就留给游戏退出后的 cleanup */
    }
  }

  const gone = !isPidAlive(findProcessByName(OFFICIAL_PROCESS_NAME));
  onLog?.(
    gone
      ? `[endfield] 游戏已就绪（pid=${gamePid}，${reason}），官方启动器已关闭，托盘不残留`
      : '[endfield] 官方启动器关闭失败，将在游戏退出后重试'
  );
  return gone;
}

/** 数同名进程个数（用于「只有一个才敢动」的保守判断）。 */
function countProcess(name) {
  try {
    const output = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    return (output.match(new RegExp(`"${name.replace(/\./g, '\\.')}"`, 'gi')) || []).length;
  } catch {
    return 0;
  }
}


/** 目录是 junction / 符号链接吗（只看 reparse 属性，不解引用）。 */
function isReparse(dir) {
  try {
    const st = fs.lstatSync(dir);
    // Windows 上 junction 的 isSymbolicLink() 为 true；再用 realpath 交叉确认一次
    return st.isSymbolicLink() || Boolean(st.isDirectory && (st.mode & 0o40000) && st.ino === 0);
  } catch {
    return false;
  }
}

/**
 * 把路径归一化成「父目录走 realpath + 保留自身名字」的形态。
 *
 * 用来判断 base 是不是链接：真目录的 realpath 一定等于「真实父目录 + 自己的名字」。
 * ★ 不能直接拿 `realpathSync(base)` 和自己比 —— Windows 会把 8.3 短名（`ADMINI~1`）
 *   展开成长名（`Administrator`），两者字面不同就误判成链接了（实测踩过）。
 */
function normalizeSelf(target) {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  const name = path.basename(resolved);
  let parentReal = parent;
  try {
    parentReal = fs.realpathSync.native(parent);
  } catch {
    /* 父目录不存在就用原值 */
  }
  return path.join(parentReal, name);
}

/** 把路径解析成真实长路径（用于比较两个路径是不是同一个位置）。 */
function samePath(a, b) {
  const norm = (value) => {
    try {
      return fs.realpathSync.native(path.resolve(value)).toLowerCase();
    } catch {
      return path.resolve(value).toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/**
 * 安装目录现在是什么形态。
 * @returns {'missing'|'link'|'dir'}
 */
function inspectBase(base) {
  let st;
  try {
    st = fs.lstatSync(base);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) return 'link';
  // Node 在 Windows 上对 junction 的 isSymbolicLink() 可能为 false（取决于创建的 API），
  // 用 realpath 与「真实父目录 + 自身名字」比较来兜底。
  try {
    const real = fs.realpathSync.native(base);
    if (real.toLowerCase() !== normalizeSelf(base).toLowerCase()) return 'link';
  } catch {
    /* realpath 失败就按目录处理 */
  }
  return st.isDirectory() ? 'dir' : 'missing';
}

/** 读 junction 指向哪里；不是链接就返回 ''。 */
function linkTarget(dir) {
  try {
    const real = fs.realpathSync.native(dir);
    return real.toLowerCase() === normalizeSelf(dir).toLowerCase() ? '' : real;
  } catch {
    return '';
  }
}

/**
 * 把安装目录换成一个指向 target 的 junction。
 *
 * 为什么要「改名 + 建链接」而不是直接改库：官方启动器的路径存在 SQLCipher 加密的
 * eld_Games.db 里，密钥拿不到（试过 18 个候选口令全失败）。而它接受 junction
 * —— 实测 games.log 与真实目录逐行一致。
 *
 * 全程同卷 rename，秒级、不复制不删；任何一步失败都回滚。
 *
 * @returns {{ok:boolean, error?:string, hold?:string, changed?:boolean}}
 */
function swapBaseToLink(base, target) {
  const kind = inspectBase(base);
  if (kind === 'missing') return { ok: false, error: `安装目录不存在：${base}` };
  if (!fs.existsSync(path.join(target, 'Endfield.exe'))) {
    return { ok: false, error: `目标目录里没有 Endfield.exe：${target}` };
  }
  // 已经在指着目标了，不用动
  if (kind === 'link') {
    const current = linkTarget(base);
    if (current && samePath(current, target)) {
      return { ok: true, changed: false };
    }
    return {
      ok: false,
      error: `安装目录已经是指向别的位置的链接（${current || '未知'}），请先恢复成真实目录再切换。`,
    };
  }

  const hold = base + BASE_HOLD_SUFFIX;
  if (fs.existsSync(hold)) {
    return { ok: false, error: `备份目录已存在，可能上次没恢复干净：${hold}` };
  }
  try {
    fs.renameSync(base, hold);
  } catch (error) {
    return { ok: false, error: `改名安装目录失败：${error.message}` };
  }
  // ★ 链接要指向「渠道运行时」，不是指向备份目录 —— 备份只是把原目录挪开。
  const made = makeJunction(base, target);
  if (!made.ok) {
    try {
      fs.renameSync(hold, base);
    } catch {
      /* 回滚失败只能如实报告 */
    }
    return { ok: false, error: made.error };
  }
  return { ok: true, changed: true, hold, target };
}

/** 把 junction 拆掉、真目录改回来。幂等：本来就不是链接就什么都不做。 */
function restoreBase(base) {
  const kind = inspectBase(base);
  const hold = base + BASE_HOLD_SUFFIX;
  if (kind === 'dir') {
    // 已经是真目录了；如果还留着备份目录，说明有异常，如实回报但不自动删
    return { ok: true, changed: false, strayHold: fs.existsSync(hold) ? hold : '' };
  }
  if (kind === 'link') {
    const removed = removeJunction(base);
    if (!removed.ok) return { ok: false, error: removed.error };
  }
  if (fs.existsSync(hold)) {
    try {
      fs.renameSync(hold, base);
    } catch (error) {
      return { ok: false, error: `恢复安装目录失败：${error.message}` };
    }
  }
  return { ok: true, changed: true };
}

/**
 * 建 junction。用 cmd 的 mklink，因为 Node 没有原生建 junction 的 API
 * （fs.symlinkSync 的 'junction' 类型在 Windows 上也能用，但需要开发者模式或提权，
 * 而我们已经处在提权上下文里；两种都试，cmd 更稳）。
 */
function makeJunction(linkPath, targetPath) {
  try {
    fs.symlinkSync(targetPath, linkPath, 'junction');
    return { ok: true };
  } catch (error) {
    // 退回到 cmd
    try {
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', linkPath, targetPath], {
        windowsHide: true,
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true };
    } catch (cmdError) {
      return { ok: false, error: `创建目录链接失败：${error.message} / ${cmdError.message}` };
    }
  }
}

/** 拆 junction。rmdir 只会删链接本身，不会碰目标目录（这是 Windows 的语义保证）。 */
function removeJunction(linkPath) {
  try {
    fs.unlinkSync(linkPath);
    return { ok: true };
  } catch {
    try {
      execFileSync('cmd.exe', ['/c', 'rmdir', linkPath], {
        windowsHide: true,
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `移除目录链接失败：${error.message}` };
    }
  }
}

/**
 * 找官方启动器里的 Games.exe。
 *
 * 目录发现复用 endfield-launch 的 officialLauncherDirs()（注册表 install_path +
 * 卸载项 InstallLocation + 盘符兜底三层），但**不走它的 peNeedsAdmin 过滤** ——
 * 官方 Games.exe 本身就是 requireAdministrator，而这条链路本来就要提权跑它。
 */
function findOfficialGames(customExe) {
  // 用户在「设置 → 行为」里手填的 Games.exe 路径优先（2026-11-23）：
  // 自动发现找不到时，让用户自己指一个也行。必须是真实存在的 .exe 文件才认，
  // 传空/无效时静默走原来的自动发现，无参调用行为完全不变。
  if (typeof customExe === 'string' && customExe.trim()) {
    const manual = path.resolve(customExe.trim());
    try {
      if (fs.statSync(manual).isFile() && /Games\.exe$/i.test(manual)) {
        return { ok: true, exe: manual, manual: true };
      }
    } catch {
      /* 手填路径无效，继续自动发现 */
    }
  }
  let dirs = [];
  try {
    dirs = endfieldOfficialDirs.officialLauncherDirs();
  } catch {
    dirs = [];
  }
  for (const base of dirs) {
    // 官方启动器的布局是 <安装目录>\<版本号>\Games.exe，但版本号会变，
    // 所以按层搜（最多两层），别写死 1.6.0。
    const queue = [{ dir: base, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      const candidate = path.join(current.dir, 'Games.exe');
      try {
        if (fs.statSync(candidate).isFile()) return { ok: true, exe: candidate };
      } catch {
        /* 继续往上找 */
      }
      if (current.depth >= 2) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
      }
    }
  }
  return {
    ok: false,
    error: '没找到鹰角官方启动器（Games.exe）。请先安装官方启动器，或在设置里指定它的位置。',
  };
}

/** 从 games.log 里读终末地的 game uuid（官方启动器自己写的，最权威）。 */
function readGameUuid() {
  for (const logPath of gamesLogPaths()) {
    const text = readLogTail(logPath);
    if (!text) continue;
    // 一对一找：endfield 的 ReadGameConfig 里带 strGameUUID 的那行
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.indexOf('strGameUUID:') === -1) continue;
      const m = line.match(/strGameUUID:([0-9a-f]{32})/i);
      if (!m) continue;
      // 确认这行说的是终末地（官方启动器里 dirName 是 Arknights Endfield）
      if (!/endfield|Arknights/i.test(line)) continue;
      return m[1].toLowerCase();
    }
  }
  return '';
}

/** 从 config.ini 旁边的 .vela-game-state.json 猜不到 uuid；这里只做兜底常量。 */
const UUID_FALLBACK = '24dab91fe61d1e55938b25b74963cbc5';

/** 列出所有可能的官方启动器 games.log（Hypergryph / Gryphline 两家）。 */
function gamesLogPaths() {
  const localLow = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'AppData', 'LocalLow')
    : '';
  const list = [];
  if (!localLow) return list;
  for (const company of ['Hypergryph', 'Gryphline']) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(localLow, company), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      list.push(path.join(localLow, company, entry.name, 'logs', 'games.log'));
    }
  }
  return list;
}

/** 读日志尾部（日志能到几十 MB，只取最后 512 KB 够用）。 */
function readLogTail(logPath, bytes = 512 * 1024) {
  try {
    const st = fs.statSync(logPath);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(logPath, 'r');
    const buffer = Buffer.alloc(st.size - start);
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 从 games.log 里读官方启动器**自己认定的终末地安装目录**。
 *
 * 官方每次启动都会打 `clgu enter ReadGameConfig strGameInstallPath:<路径>`。
 * 拿这个比让调用方猜路径可靠得多 —— 用户把游戏装在 D 盘、或者装了官方启动器
 * 但游戏目录被挪过，这里都会给到真实值。读不到返回 ''，调用方再退回自己的判断。
 */
function readGameInstallPath() {
  for (const logPath of gamesLogPaths()) {
    const text = readLogTail(logPath);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.indexOf('ReadGameConfig') === -1) continue;
      if (!/endfield/i.test(line)) continue;
      const m = line.match(/strGameInstallPath:([^\r\n]*?)\s*(?:,|$)/);
      if (!m) continue;
      const value = m[1].trim();
      if (!value) continue;
      try {
        if (fs.statSync(value).isDirectory()) return value;
      } catch {
        /* 路径已失效就继续找更早的行 */
      }
    }
  }
  return '';
}

/** 端口上有没有 Qt WebEngine 的 target 列表。 */
async function fetchTargets(port, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 挑一个空端口：从 PORT_FROM 往上试，先看能不能连上（连上说明被占了就跳过）。 */
async function pickPort() {
  for (let port = PORT_FROM; port <= PORT_TO; port += 1) {
    const targets = await fetchTargets(port, 200);
    if (targets === null) {
      // 连不上 = 大概率没人用；再确认一次不是超时导致的假空闲
      const again = await fetchTargets(port, 200);
      if (again === null) return port;
    }
  }
  return 0;
}

/**
 * 走 CDP 跟官方启动器的页面说话。
 *
 * 只用 Node 自带的 WebSocket（Electron 45 / Node 24 起 globalThis.WebSocket 可用），
 * 不引入 ws 依赖 —— 打包体积和原生模块风险都省了。
 */
async function withCdpPage(wsUrl, fn) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;

  const call = (method, params, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const id = (seq += 1);
      pending.set(id, { resolve, reject });
      try {
        socket.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (error) {
        pending.delete(id);
        reject(error);
        return;
      }
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
    });

  const evaluate = async (expression, timeoutMs) => {
    const result = await call(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      },
      timeoutMs
    );
    if (result && result.exceptionDetails) {
      throw new Error(`页面脚本出错：${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
    }
    return result && result.result ? result.result.value : undefined;
  };

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      socket.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      socket.removeEventListener('open', onOpen);
      reject(new Error('连接官方启动器的调试端口失败'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    setTimeout(() => reject(new Error('连接官方启动器的调试端口超时')), 10000);
  });

  try {
    await call('Runtime.enable', {}, 10000);
    return await fn({ call, evaluate });
  } finally {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 问官方启动器：这颗「开始游戏」按钮现在是什么状态。
 * 对应前端源码 `Hu({event:'main_btn_state_req', callbackEvent:'main_btn_state_rsp'})`。
 *
 * ★ payload 形状必须照抄官方（2026-11-25 实测）：
 *   官方 fetchQtCallback 发出去的是 `{ data: {...}, callbackEvent: 'xxx_rsp' }`，
 *   Qt 端靠 callbackEvent 决定回包挂在哪个事件名下。以前这里只发了 `{uuid}`，
 *   Qt 收不到 callbackEvent 就不回报 —— 表现就是「等了 6 秒没任何回调」，
 *   于是每次都被判成「无法向官方启动器查询状态」，官方托管启动必然失败。
 */
async function readButtonState(page, uuid) {
  /*
   * 先等前端把 window.jsbridge 挂上。
   *
   * 官方启动器的 Qt WebEngine 页面是异步加载的：CDP 目标一出现（devtools
   * 能连上）不代表页面脚本已经跑完 —— 这时 window.jsbridge 还不存在，
   * 直接发消息会拿到 `Cannot read property 'SendMsgToNative' of undefined`。
   * 以前这里只发一次就判失败，表现就是「点了开始游戏，几秒后报无法查询状态」。
   */
  let hooked = 'no-signal';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    hooked = await page.evaluate(`(function(){
      if (!window.jsbridge) return 'no-signal';
      if (typeof window.jsbridge.SendMsgToNative !== 'function') return 'no-method';
      try {
        window.__hxlNative = [];
        if (typeof window.jsbridge.SendMsgToWeb === 'object' || typeof window.jsbridge.SendMsgToWeb === 'function') {
          try { window.jsbridge.SendMsgToWeb.disconnect && window.jsbridge.SendMsgToWeb.disconnect(); } catch (e) {}
          window.jsbridge.SendMsgToWeb.connect(function(type, payload){
            window.__hxlNative.push({ type: String(type), payload: String(payload).slice(0, 4000) });
          });
        }
        return 'ok';
      } catch (e) { return 'err:' + e.message; }
    })()`);
    if (hooked === 'ok') break;
    await delay(500);
  }
  if (hooked !== 'ok') {
    return { ok: false, error: `官方启动器前端还没准备好（jsbridge=${hooked}），请重试一次` };
  }

  const sent = await page.evaluate(`(function(){
    try {
      var payload = JSON.stringify({ data: { uuid: ${JSON.stringify(uuid)} }, callbackEvent: 'main_btn_state_rsp' });
      window.jsbridge.SendMsgToNative('main_btn_state_req', payload);
      return 'sent';
    } catch (e) { return 'err:' + e.message; }
  })()`);
  if (sent !== 'sent') return { ok: false, error: `无法向官方启动器查询状态：${sent}` };

  // 官方前端的 fetchQtCallback 是 10 秒超时；这里给 6 秒，够本地回包了
  for (let i = 0; i < 20; i += 1) {
    await delay(300);
    const raw = await page.evaluate('JSON.stringify(window.__hxlNative || [])');
    let rows = [];
    try {
      rows = JSON.parse(raw || '[]');
    } catch {
      rows = [];
    }
    for (let j = rows.length - 1; j >= 0; j -= 1) {
      const row = rows[j];
      if (row.type !== 'main_btn_state_rsp' && row.type !== 'main_btn_state_notify') continue;
      try {
        const parsed = JSON.parse(row.payload);
        const inner = parsed && parsed.data ? parsed.data : parsed;
        if (inner && inner.uuid && inner.uuid !== uuid) continue;
        if (inner && inner.state) return { ok: true, state: inner.state, detail: inner };
      } catch {
        /* 非 JSON 就跳过 */
      }
    }
  }
  return { ok: false, error: '官方启动器没有回报按钮状态（可能还没加载完）' };
}

/**
 * 让官方启动器真正启动游戏：走它自己的按钮逻辑。
 *
 * 官方前端那颗按钮的 onClick 走的是 `ku({event:'click_main_btn', data:{uuid}})`，
 * 而 ku 内部是 `fetchQt`（只发不等回包），payload 就是 `bu(data)` = `{uuid}`。
 * 所以这里 payload 保持 `{uuid}` —— 和 readButtonState 不一样，别改成带
 * callbackEvent 的形状，Qt 端在 click_main_btn 上不看那个字段。
 */
async function clickStart(page, uuid) {
  const clicked = await page.evaluate(`(function(){
    try {
      window.jsbridge.SendMsgToNative('click_main_btn', JSON.stringify({ uuid: ${JSON.stringify(uuid)} }));
      return 'clicked';
    } catch (e) { return 'err:' + e.message; }
  })()`);
  return clicked === 'clicked' ? { ok: true } : { ok: false, error: clicked };
}

/** 等游戏进程出现，返回 pid。 */
function findProcessByName(name) {
  try {
    const output = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    // "Endfield.exe","1234","Console","1","1,234 K"
    const match = output.match(/"([^"]+)","(\d+)"/);
    if (match && match[1].toLowerCase() === name.toLowerCase()) return Number(match[2]);
  } catch {
    /* tasklist 失败就当没找到 */
  }
  return 0;
}

/** 按 pid 精确判活（别用进程名，官方启动器会留下同名的托盘进程）。 */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    return output.indexOf(String(pid)) !== -1;
  } catch {
    return false;
  }
}

/** 只要 pid 在跑就结束它（含子进程树）。提权进程需要提权才能杀。 */
function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10000,
      stdio: 'ignore',
    });
  } catch {
    /* 杀不掉就交给用户/下次启动的自检 */
  }
}

/**
 * 兜底：把官方启动器正常拉出来，交给用户自己点。
 *
 * 为什么需要（用户 2026-11-25 提的场景，也是真实用户最多的情形）：
 *   整套自动启动依赖三件事同时成立 —— UAC 提权被同意、官方启动器能起来、
 *   它的页面能渲染出 jsbridge。任何一件不成立（用户点了「否」、公司电脑禁提权、
 *   杀软拦了环境变量注入、显卡/驱动导致 WebEngine 白屏），我们就点不到那颗按钮。
 *   这时候**绝不能只说一句「启动失败」** —— 用户的诉求是「我要进游戏」，
 *   不是「我要看你的报错」。
 *
 * 所以这里退回最原始的路径：把 Games.exe 正常拉起来（带 --game 参数让它直接
 * 定位到这个游戏），让用户自己在界面上点「开始游戏」。这条路不需要我们的
 * 环境变量注入，也不需要调试口，是官方完全支持的正常使用方式。
 *
 * @returns {{ok:boolean, mode:string, error?:string}}
 */
function openOfficialLauncherManually(exe, uuid, onLog) {
  const args = uuid ? [`--game=${uuid}`] : [];
  try {
    // 用 Start-Process 而不是 spawn：它走 ShellExecute，会按 exe 的清单一并触发 UAC
    const ps = [
      `Start-Process -FilePath '${String(exe).replace(/'/g, "''")}'` +
        (args.length ? ` -ArgumentList '${args[0].replace(/'/g, "''")}'` : ''),
    ].join('\n');
    execFileSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: 20000,
      stdio: 'ignore',
    });
    onLog?.('[endfield] 已改用「手动模式」：把官方启动器正常拉出来，由用户自己点开始游戏');
    return { ok: true, mode: 'manual' };
  } catch (error) {
    return { ok: false, mode: 'manual', error: (error && error.message) || String(error) };
  }
}

/**
 * 提权起官方启动器并打开 DevTools 端口。
 *
 * Games.exe 是 requireAdministrator；两种情形分开处理：
 *   · 当前启动器已经是管理员 → 直接 spawn，环境变量天然继承；
 *   · 不是管理员 → 提权一个「设好环境变量再拉起 Games.exe」的包装脚本本身
 *     （UAC 提升出的进程不继承父进程 live env，所以必须让包装脚本在管理员
 *     进程内部设 $env:，再由它拉起的 Games.exe 继承，调试口才开得出来）。
 */
function spawnOfficialLauncher(exe, uuid, port, elevated) {
  const portText = String(port);
  if (elevated) {
    const child = spawn(exe, [`--game=${uuid}`], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        QTWEBENGINE_REMOTE_DEBUGGING: portText,
        QTWEBENGINE_CHROMIUM_FLAGS: '--remote-allow-origins=*',
      },
    });
    child.unref();
    return { ok: true, mode: 'direct' };
  }

  /*
   * 非提权：走一次 UAC 把官方启动器拉起来。
   *
   * ★ 关键坑（2026-11-24 报障实锤）：Games.exe 的清单是 requireAdministrator，必须提权。
   *   但「在非提权的 PowerShell 里设好 $env:，再 Start-Process -Verb RunAs Games.exe」
   *   会把环境变量丢掉 —— UAC 提升出的 Games.exe 不继承父进程的 live env，
   *   QTWEBENGINE_REMOTE_DEBUGGING 传不进去，调试口永远开不出来，游戏也起不来。
   *
   *   正确做法：把「设环境变量 + 拉起 Games.exe」写进一个包装脚本，**提权的是这个
   *   包装脚本本身**。脚本进程是管理员，脚本里设的 $env: 就在管理员进程内部，
   *   再由它 Start-Process（不带 -Verb RunAs）拉起的 Games.exe 作为它的子进程，
   *   天然继承这套环境变量，调试口才能开出来。
   */
  /*
   * ★ 脚本落在「启动器自己旁边」而不是 %TEMP%（2026-11-25 实测问题）。
   *
   * 原因：Electron 里 `os.tmpdir()` 在某些启动方式下返回的是 POSIX 风格的 `/tmp`
   * （Git Bash 环境变量 TMPDIR 影响），PowerShell 完全不认这个路径 → 提权脚本
   * 「文件不存在」，UAC 一闪而过什么都不做，表现为「点了没反应」。
   * 存到 userData 下的子目录，路径确定、普通权限可写、提权进程也读得到。
   */
  let scriptDir;
  try {
    scriptDir = path.join(app.getPath('userData'), 'run');
    fs.mkdirSync(scriptDir, { recursive: true });
  } catch {
    scriptDir = path.dirname(process.execPath);
  }
  const script = path.join(scriptDir, `Vela-Endfield-Official-${Date.now()}.ps1`);
  /*
   * ★ 包装脚本承担三件事（2026-11-25 按用户要求简化）：
   *   ① 设调试口环境变量（必须在本进程内设，才能被它拉起的 Games.exe 继承）
   *   ② 拉起 Games.exe，窗口一出现就最小化（用户：「启动后你秒最小化缩了不就完事了嘛」）
   *   ③ 等 Endfield.exe 出窗口后，直接关掉 Games.exe，托盘不残留
   *
   * 为什么必须在这个提权脚本里做，而不是主进程：
   *   Games.exe 的清单是 requireAdministrator，我们的启动器通常不是管理员。
   *   非管理员进程去 ShowWindow / 结束它，会被 Windows 的 UIPI 静默拒绝 ——
   *   实测四种手法（ShowWindow / SWP_HIDEWINDOW / MoveWindow / WS_EX_TOOLWINDOW）
   *   全部无效，窗口坐标一个像素都没动。这个脚本本身是管理员，改自己子进程没阻碍。
   *
   * 为什么最小化而不是隐藏：隐藏是纯视觉把戏，窗口和渲染都还在，用户还找不到它；
   * 最小化是系统原生行为，任务栏留一个可还原的按钮，能解释、能回退。
   *
   * 为什么关启动器要等「游戏窗口出现」：进程起来时游戏还没建窗口，
   * 太早关会让游戏拿不到后续启动上下文。实测等窗口出来再关，游戏继续跑 90 秒无异常。
   */
  const body = [
    `$env:QTWEBENGINE_REMOTE_DEBUGGING = '${portText}'`,
    `$env:QTWEBENGINE_CHROMIUM_FLAGS = '--remote-allow-origins=*'`,
    `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '--game=${uuid}'`,
    '',
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class HxlWin {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
    '}',
    '"@',
    '',
    '$deadline = (Get-Date).AddSeconds(180)',
    '$launcherPid = 0',
    '$gameWindowSeen = $false',
    '',
    'while ((Get-Date) -lt $deadline) {',
    '  if ($launcherPid -eq 0) {',
    "    $g = Get-Process -Name 'Games' -ErrorAction SilentlyContinue | Select-Object -First 1",
    '    if ($g) { $launcherPid = $g.Id }',
    '  }',
    '',
    '  # 游戏窗口出现 → 这次启动已经成功，启动器可以退场',
    "  $game = Get-Process -Name 'Endfield' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    '  if ($game) { $gameWindowSeen = $true; break }',
    '',
    '  # 启动器窗口一出现就最小化（6 = SW_MINIMIZE）',
    "  $lg = Get-Process -Name 'Games' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    '  if ($lg) { [HxlWin]::ShowWindow($lg.MainWindowHandle, 6) | Out-Null }',
    '  Start-Sleep -Milliseconds 150',
    '}',
    '',
    '# 进游戏后：留 2 秒缓冲，然后关掉启动器',
    '# 只 Stop-Process 这一个 pid，绝不用 taskkill /T —— 那会顺着进程树把游戏一起杀',
    'if ($gameWindowSeen -and $launcherPid -ne 0) {',
    '  Start-Sleep -Seconds 2',
    '  try { Stop-Process -Id $launcherPid -Force -ErrorAction Stop } catch { }',
    '}',
    '',
  ].join('\r\n');
  try {
    // PowerShell 5.1 读 .ps1 默认按 ANSI，路径里有中文会乱码，所以写成 UTF-8 BOM
    fs.writeFileSync(script, '\uFEFF' + body, 'utf8');
  } catch (error) {
    return { ok: false, error: `写启动脚本失败：${error.message}` };
  }

  const powershell = powershellExe();
  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  try {
    let child;
    const elevateExe = process.resourcesPath
      ? path.join(process.resourcesPath, 'elevate.exe')
      : '';
    if (fs.existsSync(elevateExe)) {
      /*
       * 优先用项目自带的 elevate.exe 提权包装脚本（与启动器自身提权同一套工具，
       * 稳、不依赖 PowerShell -Command 的引号/编码）。elevate.exe 提升的是
       * `powershell.exe -File wrapper.ps1` 这个包装进程本身。
       */
      child = spawn(
        elevateExe,
        [
          powershell,
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          script,
        ],
        { detached: true, windowsHide: true, stdio: 'ignore' }
      );
    } else {
      /*
       * elevate.exe 缺失时退回 PowerShell RunAs：用一个 runner 脚本把
       * `powershell.exe -File wrapper.ps1` 整体提权，等价于上面的包装进程提权。
       * runner 也写成 UTF-8 BOM，规避中文路径在 -Command 里乱码。
       */
      const runner = path.join(scriptDir, `Vela-Endfield-Official-Run-${Date.now()}.ps1`);
      const runBody = [
        `Start-Process -FilePath ${psQuote(powershell)} -Verb RunAs -ArgumentList @(`,
        `  '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',`,
        `  ${psQuote(script)}`,
        `)`,
        '',
      ].join('\r\n');
      fs.writeFileSync(runner, '\uFEFF' + runBody, 'utf8');
      child = spawn(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          runner,
        ],
        { detached: true, windowsHide: true, stdio: 'ignore' }
      );
      setTimeout(() => {
        try {
          fs.rmSync(runner, { force: true });
        } catch {
          /* ignore */
        }
      }, 40000);
    }
    child.unref();
    // 脚本过 40 秒才清，避开 UAC 弹窗等待期
    setTimeout(() => {
      try {
        fs.rmSync(script, { force: true });
      } catch {
        /* ignore */
      }
    }, 40000);
    return { ok: true, mode: 'runas' };
  } catch (error) {
    return { ok: false, error: `请求管理员权限失败：${error.message}` };
  }
}

/**
 * 对外主入口：用官方启动器拉起终末地。
 *
 * @param {object} options
 * @param {string} options.gameRoot   官方启动器认的那个安装目录（通常是 `G:\Arknights Endfield`）
 * @param {string} [options.runRoot]  实际要跑的目录（渠道运行时）；等于 gameRoot 时表示官服，不换 junction
 * @param {string} [options.uuid]     game uuid；不给就从 games.log 读
 * @param {boolean} [options.elevated] 当前进程是否已是管理员
 * @param {(msg:string)=>void} [options.onProgress]
 * @returns {Promise<{ok:boolean, pid?:number, error?:string, reason?:string, state?:string}>}
 */
/**
 * 手动模式：只把官方启动器拉起来并最小化，让用户自己点「开始游戏」。
 *
 * 用户 2026-11-25 定的兜底路线。为什么需要它：
 *   自动模式（full）要给官方启动器开 QTWEBENGINE 调试端口、用 CDP 在它页面里
 *   执行 JS 点按钮。逆向 ACE 后确认它目前不认这些（ACE-Base64.dll 里搜不到
 *   QTWEBENGINE / remote-debug 之类字符串，调试检测只在 AntiDbg/UserDbg 下、
 *   作用域是游戏进程自身）。但鹰角的判定规则是服务端下发的，万一哪天加了
 *   「启动链路异常」这类检测，必须有一条不碰调试口的路能立刻切过去。
 *
 * 这条路做的事：正常 Start-Process 拉起 Games.exe（不设任何环境变量），
 * 然后把它的窗口最小化（提权脚本里做，因为 Games.exe 是 requireAdministrator，
 * UIPI 会拦非管理员的窗口操作）。用户自己点开始游戏，进游戏后我们再把启动器关掉。
 */
async function launchViaOfficialManual(options, games, uuid, onLog) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const scriptDir = runtimeScriptDir();
  const script = path.join(scriptDir, `Vela-Endfield-Manual-${Date.now()}.ps1`);

  /*
   * 脚本职责：
   *   ① 拉起 Games.exe（不注入任何调试环境变量）
   *   ② 循环把它窗口最小化，直到 Endfield.exe 出窗口
   *   ③ 游戏进界面后关掉启动器（只杀自己 pid，绝不 /T）
   */
  const body = [
    `Start-Process -FilePath '${String(games.exe).replace(/'/g, "''")}' -ArgumentList '--game=${uuid}'`,
    '',
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class HxlMan {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '}',
    '"@',
    '',
    '$deadline = (Get-Date).AddSeconds(300)',
    '$launcherPid = 0',
    '$gameSeen = $false',
    'while ((Get-Date) -lt $deadline) {',
    '  if ($launcherPid -eq 0) {',
    "    $g = Get-Process -Name 'Games' -ErrorAction SilentlyContinue | Select-Object -First 1",
    '    if ($g) { $launcherPid = $g.Id }',
    '  }',
    "  $game = Get-Process -Name 'Endfield' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    '  if ($game) { $gameSeen = $true; break }',
    "  $lg = Get-Process -Name 'Games' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    '  if ($lg) {',
    '    $lh = $lg.MainWindowHandle',
    '    # 6 = SW_MINIMIZE。Qt 加载完会自己 show 一次，所以每轮都压一遍。',
    '    [HxlMan]::ShowWindow($lh, 6) | Out-Null',
    '    # 有些 Qt 窗口对 SW_MINIMIZE 不响应，用 7（SW_SHOWMINNOACTIVE）再试一次',
    '    if (-not [HxlMan]::IsIconic($lh)) { [HxlMan]::ShowWindow($lh, 7) | Out-Null }',
    '  }',
    '  Start-Sleep -Milliseconds 300',
    '}',
    'if ($gameSeen -and $launcherPid -ne 0) {',
    '  Start-Sleep -Seconds 2',
    '  try { Stop-Process -Id $launcherPid -Force -ErrorAction Stop } catch { }',
    '}',
    '',
  ].join('\r\n');

  try {
    fs.writeFileSync(script, '\uFEFF' + body, 'utf8');
  } catch (error) {
    return { ok: false, error: `写手动启动脚本失败：${error.message}` };
  }

  onProgress('正在打开官方启动器（手动模式）…');
  onLog?.('[endfield] 手动模式：不注入调试口，只拉起官方启动器并最小化');

  try {
    const elevateExe = process.resourcesPath
      ? path.join(process.resourcesPath, 'elevate.exe')
      : '';
    const powershell = powershellExe();
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script];
    const child = fs.existsSync(elevateExe)
      ? spawn(elevateExe, [powershell, ...args], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(powershell, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    return { ok: false, error: `拉起官方启动器失败：${error.message}` };
  }

  /* 等游戏进程出现（用户手动点之后） */
  let gamePid = 0;
  for (let i = 0; i < 240; i += 1) {
    await delay(500);
    gamePid = findProcessByName(GAME_PROCESS_NAME);
    if (gamePid) break;
  }
  if (!gamePid) {
    return {
      ok: false,
      reason: 'manual-required',
      error: '已打开官方启动器（窗口最小化在任务栏），请在它上面点「开始游戏」。点完还没进游戏的话，再点一次启动器图标即可。',
    };
  }

  return {
    ok: true,
    pid: gamePid,
    uuid,
    state: 'in_game',
    via: 'manual',
    note: '手动模式：用户自己点的开始游戏',
  };
}

async function launchViaOfficial(options = {}) {
  const gameRoot = String(options.gameRoot || '').trim();
  const runRoot = String(options.runRoot || gameRoot).trim() || gameRoot;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  if (!gameRoot) return { ok: false, error: '没有拿到终末地的安装目录。' };

  // 把手填路径透传，否则 tryOfficialLaunch 认了、这里又搜一次会白忙（2026-11-23）
  const games = findOfficialGames(options.customExe);
  if (!games.ok) return { ok: false, error: games.error };

  const uuid = String(options.uuid || '').trim() || readGameUuid() || UUID_FALLBACK;

  /*
   * 启动方式分流（2026-11-25 用户定：默认全自动，但要能一键退回手动）。
   * options.launchMode 由上层（games-ipc）从设置里读出来传进来，
   * 这样这个模块不依赖 store，纯 Node 单测也能跑。
   */
  if (String(options.launchMode || 'full') === 'manual') {
    return launchViaOfficialManual(options, games, uuid, options.onLog);
  }

  const sameRoot =
    path.resolve(runRoot).toLowerCase() === path.resolve(gameRoot).toLowerCase();

  // 已经有一套进程在跑就别再起第二套
  if (isPidAlive(findProcessByName(GAME_PROCESS_NAME))) {
    return { ok: false, error: '终末地已经在运行了。' };
  }

  let swapped = null;
  let launcherPid = 0;
  /*
   * 本次启动的游戏进程。
   *
   * 为什么单独记：junction 复原（把安装目录从渠道运行时指回真实目录）**绝不能**
   * 在游戏还活着的时候做。客户端启动后还会持续按安装目录路径读资源，中途换回来
   * 会让它读到另一套文件 —— 表现就是「卡很久，然后提示文件损坏」。
   * 2026-11-26 国际服实测就是这个问题：进程刚出现 3 秒就复原，游戏随即报损坏。
   * 现在改成「游戏退出后才复原」，由下面的守卫间隔和 finally 共同保证。
   */
  let runningPid = 0;
  const cleanup = async (restore) => {
    if (launcherPid) {
      // 官方启动器是我们起的，游戏结束后不该留在托盘里
      // （这里游戏已经退出了，用 killTree 连子进程一起收是安全的）
      try {
        const stillAlive = isPidAlive(launcherPid);
        if (stillAlive) killTree(launcherPid);
      } catch {
        /* ignore */
      }
    }
    if (swapped && restore) {
      const restored = restoreBase(gameRoot);
      if (!restored.ok) {
        // 复位失败很重要，必须留痕
        options.onLog?.(`[endfield] 安装目录复位失败：${restored.error}`);
      } else if (restored.changed) {
        options.onLog?.('[endfield] 游戏已退出，安装目录已复原为真实目录');
      }
    }
  };

  try {
    // ── 换 junction（非官服才需要）
    if (!sameRoot) {
      const kind = inspectBase(gameRoot);
      if (kind === 'link') {
        return {
          ok: false,
          error: `安装目录已经是一个目录链接（${linkTarget(gameRoot) || '未知'}），请先在设置里恢复成真实目录。`,
        };
      }
      onProgress('正在把安装目录切到当前渠道…');
      const swap = swapBaseToLink(gameRoot, runRoot);
      if (!swap.ok) return { ok: false, error: swap.error };
      swapped = swap;
    }

    // ── 起官方启动器（带 DevTools 端口）
    const port = await pickPort();
    if (!port) return { ok: false, error: '没有可用的本地端口给官方启动器开调试口。' };

    onProgress('正在唤起官方启动器…');
    const spawned = spawnOfficialLauncher(games.exe, uuid, port, Boolean(options.elevated));
    if (!spawned.ok) return { ok: false, error: spawned.error };

    // ── 等调试口就绪
    let target = null;
    for (let i = 0; i < 40; i += 1) {
      await delay(400);
      const list = await fetchTargets(port, 800);
      if (!list) continue;
      target = list.find((item) => item && item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) break;
      // 顺带记下启动器 pid，退出时清理
      if (!launcherPid) launcherPid = findProcessByName(OFFICIAL_PROCESS_NAME);
    }
    if (!launcherPid) launcherPid = findProcessByName(OFFICIAL_PROCESS_NAME);
    if (!target) {
      /*
       * 调试口没开不等于一定失败。
       *
       * `--game=<uuid>` 这个参数本身就是「直接开这个游戏」，官方启动器拿到后可以
       * 不初始化 Qt WebEngine 界面、直接走它自己的启动流程 —— 那种情况下调试口
       * 永远不出现，但游戏照样被拉起来了。所以先等一会儿看游戏进程有没有起来。
       */
      onProgress('调试口没开，检查官方启动器是否已经自己拉起游戏…');
      let liftedPid = 0;
      for (let i = 0; i < 40; i += 1) {
        await delay(500);
        liftedPid = findProcessByName(GAME_PROCESS_NAME);
        if (liftedPid) break;
      }
      if (liftedPid) {
        return {
          ok: true,
          pid: liftedPid,
          state: 'in_game',
          via: 'direct',
          note: '官方启动器已通过 --game 参数直接拉起游戏（调试口未开，但游戏进程已就绪）',
        };
      }
      /*
       * 两条都没成。这里把话说准：
       *
       * Games.exe 的 PE 清单是 requireAdministrator —— 必须提权才起得来。
       * 非提权时 spawnOfficialLauncher 已经改为「提权包装脚本本身、脚本内注入
       * 环境变量」，正常情况下调试口应该能开出来；走到这里说明提权本身没成功
       * （UAC 被拒绝、安全软件拦截，或官方启动器没正常启动）。
       */
      /*
       * 自动启动没成 —— 不让用户卡在这里。
       * 把官方启动器正常拉出来，让用户在它上面自己点「开始游戏」。
       */
      const manual = openOfficialLauncherManually(games.exe, uuid, (m) => options.onLog?.(m));
      return {
        ok: false,
        reason: 'need-elevation',
        manualOpened: manual.ok,
        error: manual.ok
          ? '已帮你打开官方启动器：请在它上面点「开始游戏」。' +
            '想让启动器下次全自动（不弹启动器、进游戏后自动关掉它），' +
            '请在弹 UAC 时点「是」，或在「设置 → 行为」里打开「始终以管理员身份启动」。'
          : '官方启动器需要管理员权限，自动拉起也没成功：' +
            ((manual.error && manual.error.slice(0, 120)) || '未知原因') +
            '。请手动打开鹰角官方启动器，点「开始游戏」。',
      };
    }

    // ── 闸门 1 / 2：先问状态，再决定点不点
    onProgress('正在向官方启动器确认状态…');
    let bridgeFailed = false;
    const stateResult = await withCdpPage(target.webSocketDebuggerUrl, async (page) => {
      const state = await readButtonState(page, uuid);
      if (!state.ok) {
        /*
         * 这里最常见的原因不是「启动器坏了」，而是**页面没渲染出来**：
         * 老显卡 / 驱动异常 / 硬件加速被禁 / 杀软拦 WebEngine / 企业策略，
         * 都会让官方启动器的界面白屏 —— 调试口能连上，但 window.jsbridge 永远
         * 不出现，于是我们发不出那颗按钮的点击（用户 2026-11-25 专门问过这个场景）。
         *
         * 这种机器上「自动点击」这条路本身就走不通，必须让用户自己点。
         * 打标记后统一在下面走手动兜底，不在这里直接返回。
         */
        bridgeFailed = true;
        return { ok: false, error: state.error };
      }

      if (IN_GAME_STATES.has(state.state)) {
        return { ok: true, alreadyRunning: true, state: state.state };
      }
      if (WRITE_RISK_STATES.has(state.state)) {
        return {
          ok: false,
          state: state.state,
          reason: 'update',
          error: needsUpdateMessage(state.state, sameRoot),
        };
      }
      if (!CLICKABLE_STATES.has(state.state)) {
        return {
          ok: false,
          state: state.state,
          reason: 'not-startable',
          error: NEED_USER_STATES[state.state] || `官方启动器当前按钮状态是「${state.state}」，现在不能开始游戏。`,
        };
      }
      const clicked = await clickStart(page, uuid);
      if (!clicked.ok) return { ok: false, error: clicked.error };
      return { ok: true, clicked: true, state: state.state };
    });

    if (!stateResult.ok) {
      /* 页面渲染不出来 → 无法自动点击。把启动器留给用户，并给一条看得懂的说明 */
      if (bridgeFailed) {
        onLog?.('[endfield] 官方启动器页面未就绪（jsbridge 未挂载），改由用户手动点击');
        const manual = openOfficialLauncherManually(games.exe, uuid, (m) => options.onLog?.(m));
        return {
          ok: false,
          reason: 'manual-required',
          manualOpened: manual.ok,
          error:
            '官方启动器没能渲染出界面（这是官方启动器在这台机器上的显示问题，不是启动器本身出错），' +
            '所以没法替你点「开始游戏」。' +
            (manual.ok ? '已经把官方启动器打开，请在它上面点一次「开始游戏」。' : '请手动打开鹰角官方启动器点「开始游戏」。') +
            '若它的窗口是白屏，可尝试：①把鹰角官方启动器加入杀软白名单 ②更新显卡驱动 ③重启电脑。',
        };
      }
      return stateResult;
    }
    if (stateResult.alreadyRunning) {
      return { ok: false, error: '终末地已经在运行了。' };
    }

    // ── 等游戏进程
    onProgress('正在等游戏进程…');
    let gamePid = 0;
    for (let i = 0; i < 60; i += 1) {
      await delay(500);
      gamePid = findProcessByName(GAME_PROCESS_NAME);
      if (gamePid) break;
    }
    if (!gamePid) {
      return {
        ok: false,
        error: '官方启动器接受了指令，但游戏进程一直没出现。请打开一次官方启动器看看它报了什么。',
      };
    }

    /*
     * 游戏起来了：**不要立刻复原 junction**。
     *
     * 以前这里等 3 秒就 restoreBase，国际服客户端加载慢，刚起进程还在读资源，
     * 安装目录一换回真实目录，它后续读到的就是另一套文件 → 提示「文件损坏」。
     * 现在只记下 pid，等游戏退出后由下面的守卫间隔调 cleanup(true) 复原。
     */
    runningPid = gamePid;

    // ── 兜底守着：万一游戏之后才退出，再清一次（通常上面已经清干净了）
    const guard = setInterval(() => {
      if (isPidAlive(gamePid)) return;
      clearInterval(guard);
      void cleanup(true);
    }, 5000);
    if (typeof guard.unref === 'function') guard.unref();

    /*
     * ── 收掉官方启动器：游戏起来后不留后台进程、不留托盘图标
     *
     * 2026-11-26：收尾不再挡「启动成功」。
     * retireOfficialLauncher 要等游戏窗口句柄（抓不到就等满 12 秒兜底）、
     * 再关官方启动器并等它退出，最多能拖十几秒 —— 用户看到的就是
     * 「游戏都开出来了，启动器还显示启动中」。现在改成后台收尾：
     *   · 游戏进程已经出现，立即返回成功；
     *   · 官方启动器照常最小化/关闭，失败只落日志；
     *   · 游戏退出后的 junction 复原由上面的 guard 负责，顺序不变。
     */
    const retiring = retireOfficialLauncher(launcherPid, gamePid, options.onLog);
    if (retiring && typeof retiring.catch === 'function') retiring.catch(() => {});

    return { ok: true, pid: gamePid, uuid, state: stateResult.state };
  } catch (error) {
    return { ok: false, error: `官方托管启动失败：${error.message}` };
  } finally {
    /*
     * 走到这里还没换成游戏（中途失败），必须把 junction 复原。
     * 但如果游戏已经在跑，就保持「安装目录指向渠道运行时」—— 中途复原会让它
     * 读到另一套资源。交给 cleanup(true) / healBaseOnBoot 在游戏退出后复原。
     */
    if (swapped && !(runningPid && isPidAlive(runningPid))) {
      const restored = restoreBase(gameRoot);
      if (!restored.ok) options.onLog?.(`[endfield] 失败回滚时复位失败：${restored.error}`);
      swapped = null;
    }
    if (launcherPid && !isPidAlive(findProcessByName(GAME_PROCESS_NAME))) {
      killTree(launcherPid);
    }
  }
}

/** 更新态给一句准确的话，区分官服 / 别的渠道。 */
function needsUpdateMessage(state, isOfficial) {
  const stateText = state === 'installing' ? '正在安装更新' : '有待更新的内容';
  if (isOfficial) {
    return `官方启动器显示「${stateText}」。请先打开官方启动器把更新装完，再来启动 —— 这里替用户点按钮，但不会替用户更新。`;
  }
  return (
    `官方启动器显示「${stateText}」，这个状态下它会往安装目录写文件。` +
    '当前是「' +
    '非官服渠道」，写进去会把这份渠道运行时弄坏。' +
    '请先在启动器里切回官服、打开官方启动器把更新装完，再切回来启动。'
  );
}

/**
 * 启动时自检（闸门 3）：上次如果没来得及把 junction 换回来，这里复位。
 *
 * 只在「安装目录是链接」且「没有游戏/官方启动器在跑」时才动手 —— 有进程在跑
 * 说明正在用，动它就是灾难。
 */
function healBaseOnBoot(gameRoot, options = {}) {
  const base = String(gameRoot || '').trim();
  if (!base) return { ok: true, changed: false };
  const kind = inspectBase(base);
  if (kind !== 'link') {
    // 不是链接；但如果备份目录还在，说明上次停在半路，留痕不自动删
    const hold = base + BASE_HOLD_SUFFIX;
    if (fs.existsSync(hold)) {
      options.onLog?.(`[endfield] 发现残留备份目录但安装目录已是真实目录：${hold}`);
    }
    return { ok: true, changed: false };
  }
  if (isPidAlive(findProcessByName(GAME_PROCESS_NAME))) {
    return { ok: true, changed: false, busy: true };
  }
  const games = findOfficialGames();
  if (games.ok && isPidAlive(findProcessByName(OFFICIAL_PROCESS_NAME))) {
    return { ok: true, changed: false, busy: true };
  }
  const restored = restoreBase(base);
  if (restored.ok && restored.changed) {
    options.onLog?.(`[endfield] 启动自检：安装目录已从链接复原为真实目录。`);
  } else if (!restored.ok) {
    options.onLog?.(`[endfield] 启动自检复位失败：${restored.error}`);
  }
  return restored;
}

module.exports = {
  launchViaOfficial,
  healBaseOnBoot,
  inspectBase,
  linkTarget,
  swapBaseToLink,
  restoreBase,
  readGameUuid,
  readGameInstallPath,
  findOfficialGames,
  // 给自测用
  CLICKABLE_STATES,
  WRITE_RISK_STATES,
  BASE_HOLD_SUFFIX,
  UUID_FALLBACK,
  openOfficialLauncherManually,
  launchViaOfficialManual,
  _internal: { pickPort, fetchTargets, makeJunction, removeJunction, needsUpdateMessage },
};
