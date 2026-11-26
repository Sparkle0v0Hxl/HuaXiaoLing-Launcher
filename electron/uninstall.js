'use strict';

/**
 * 卸载流程（主程序自己执行）。
 *
 * ── 为什么卸载要放回主程序 ──────────────────────────────────────────
 *
 * 之前安装器是把「安装小程序自己」复制一份成 <安装目录>\Uninstall.exe，
 * 期望用户点它就进卸载界面。这个做法有个致命前提：Electron 只认可执行文件
 * 同目录下的 resources\app.asar。而安装目录里那个 resources\app.asar 是
 * **启动器本体**，所以双击 Uninstall.exe 实际跑起来的是启动器 —— 界面上
 * 看到的是主界面，卸载流程根本不会进。用户报的「卸载里面掺进来安装」就是
 * 这个。
 *
 * 换了个思路：卸载不需要额外的 exe，让主程序自己认领。启动参数带
 * --uninstall 时走这里的流程，显示的界面来自主程序自己的 asar，不存在
 * 「加载了别人的 resources」这种错位。
 *
 * ── 卸载时删什么、留什么 ────────────────────────────────────────────
 *
 * 保留：<安装目录>\data
 *   游戏列表、服务器配置、歌单、抽卡记录、素材包、导入的音源脚本全在这里。
 *   用户重装后这些还在，不用重新配一遍。
 *
 * 删除：安装目录下的其它一切（程序本体、asar、dll、locales、payload 残留…）
 * 以及开始菜单 / 桌面快捷方式、HKCU 的卸载注册表项。
 *
 * ── 删不掉的怎么办 ──────────────────────────────────────────────────
 *
 * 正在运行的 exe / 被加载的 dll 删不掉（EPERM/EBUSY），这是 Windows 的硬
 * 限制，不是逻辑问题。这类文件先记进 pending 列表，等本进程退出后由一段
 * 分离的 PowerShell 补删。脚本里带重试，杀软扫文件时会短暂锁住，等一会儿
 * 就能删。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { powershellExe } = require('./ps-path');

const APP_NAME = '花筱灵启动器';
const APP_ID = 'huaxiaoling-launcher';
/** 安装出来的主程序文件名（与安装器 main.js 的 APP_EXE 保持一致）。 */
const APP_EXE = '花筱灵启动器.exe';
const UNINSTALL_KEY = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}`;

/** 卸载时保留的目录名（大小写不敏感）。只有 data。 */
const KEEP_TOP_LEVEL = new Set(['data']);

/**
 * 删除快捷方式。装的时候建了两个位置：开始菜单和桌面。
 * 删不掉就算了 —— 快捷方式指向已经不存在的 exe 时，Windows 会自己清掉。
 */
function removeShortcuts() {
  const lnks = [
    path.join(
      process.env.APPDATA || '',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      `${APP_NAME}.lnk`
    ),
    path.join(process.env.USERPROFILE || '', 'Desktop', `${APP_NAME}.lnk`),
    path.join(
      process.env.PUBLIC || 'C:\\Users\\Public',
      'Desktop',
      `${APP_NAME}.lnk`
    ),
  ];
  for (const lnk of lnks) {
    try {
      fs.rmSync(lnk, { force: true });
    } catch {
      /* 没有就算了 */
    }
  }
}

/** 删 HKCU 的卸载项，让「设置 → 应用」里不再列出。 */
function removeUninstallRegistry() {
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('reg', ['delete', `HKCU\\${UNINSTALL_KEY}`, '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 删安装目录里除 data 之外的东西。
 *
 * 返回 { removed, pending, failed }：
 *   removed —— 删成功的条目数
 *   pending —— 被占用、留给延迟脚本清的一级条目名
 *   failed  —— 因为别的原因失败的 [{ name, error }]
 */
function removeProgramFiles(installDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(installDir, { withFileTypes: true });
  } catch (error) {
    return { removed: 0, pending: [], failed: [{ name: '.', error: error.message }] };
  }

  let removed = 0;
  const pending = [];
  const failed = [];

  for (const entry of entries) {
    if (KEEP_TOP_LEVEL.has(entry.name.toLowerCase())) continue;
    const target = path.join(installDir, entry.name);
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed += 1;
    } catch (error) {
      // EPERM / EBUSY / EACCES 都是「正在被使用」，交给延迟脚本
      const code = error && error.code;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        pending.push(entry.name);
      } else {
        failed.push({ name: entry.name, error: error.message || String(error) });
      }
    }
  }

  return { removed, pending, failed };
}

/**
 * 起一段分离的 PowerShell，等本进程退出后把 pending 里的条目补删。
 *
 * 为什么是 PowerShell 而不是 cmd：
 *   cmd 的 rmdir 没有重试，删到一半遇上杀软扫描就停下来，目录留在那里。
 *   PowerShell 能写循环重试，也能逐个删、报每一段的结果。
 *
 * 为什么 detached + unref：
 *   卸载完主程序要立刻退出，脚本必须活下来。detached 让它脱离父进程的
 *   作业对象，unref 让它不拖住 Node 的事件循环。
 */
function schedulePurge(installDir, pendingNames) {
  if (!pendingNames.length) return false;

  // 脚本用单引号字符串拼路径，避免 PowerShell 把 $ 当变量
  const dirPs = installDir.replace(/'/g, "''");
  const lines = [];
  lines.push(`$dir = '${dirPs}'`);
  /*
   * ★ 先等卸载进程真的退出，不能只睡固定秒数。
   *
   * 以前这里是 `Start-Sleep -Seconds 2`。问题在于脚本是在「卸载动作刚完成、
   * 界面还没显示完」时就起来的 —— 用户读完完成提示再点关闭，往往已经过去十几秒，
   * 脚本那 12×0.6 秒的重试早跑完了，被占用的那些文件（Chromium 的 pak、dll、
   * 主 exe）一个都删不掉，安装目录里留一大片残骸。
   *
   * 现在按 PID 盯着父进程：只要它还在，就一秒一次地等，最多等 10 分钟
   * （用户可能开着完成界面去忙别的）。进程没了才开始删，重试窗口也更长。
   */
  lines.push(`$parentPid = ${process.pid}`);
  lines.push('$waited = 0');
  lines.push('while ($waited -lt 600) {');
  lines.push('  $alive = $null');
  lines.push('  try { $alive = Get-Process -Id $parentPid -ErrorAction SilentlyContinue } catch { }');
  lines.push('  if (-not $alive) { break }');
  lines.push('  Start-Sleep -Seconds 1');
  lines.push('  $waited++');
  lines.push('}');
  lines.push('Start-Sleep -Milliseconds 800');
  lines.push(`$names = @(${pendingNames.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',')})`);
  lines.push('foreach ($n in $names) {');
  lines.push('  $p = Join-Path $dir $n');
  lines.push('  for ($i = 0; $i -lt 500; $i++) {');
  lines.push('    if (-not (Test-Path -LiteralPath $p)) { break }');
  lines.push('    try {');
  lines.push('      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop');
  lines.push('    } catch {');
  lines.push('      Start-Sleep -Milliseconds 500');
  lines.push('    }');
  lines.push('  }');
  lines.push('}');
  // 目录里只剩 data 时，把卸载器自己的残留（jobs 记录之类）再扫一遍
  lines.push('try {');
  lines.push('  Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop |');
  lines.push("    Where-Object { $_.Name -ne 'data' } |");
  lines.push('    ForEach-Object {');
  lines.push('      try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { }');
  lines.push('    }');
  lines.push('} catch { }');

  const script = lines.join('\r\n');

  try {
    /*
     * ★ 必须用 `cmd /c start` 起一个真正脱离本进程的 PowerShell（2026-11-25 实测）。
     *
     * 以前这里是 `spawn(powershellExe(), [...], { detached: true })`。看似标准做法，
     * 实际在 Electron 里必然失效：Electron 把子进程放进了一个 Windows 作业对象
     * （Job Object），主进程一退出，作业里所有进程被一起终止 —— PowerShell 还没醒
     * 过来就被杀了，`pending` 里那些「被占用的文件」永远留在安装目录里。
     *
     * 实测对照（同一个卸载流程，只看补删有没有生效）：
     *   spawn detached + unref          → 脚本从未写出第一行日志（被连带杀掉）
     *   Start-Process 由 PowerShell 起   → 同上
     *   cmd /c start /min ... -File      → ✅ 活下来，父进程退出 8 秒后完成删除
     *
     * `cmd start` 创建的进程不继承作业对象，是这里唯一可靠的路子。脚本先落盘成
     * .ps1 再用 -File 跑，比 EncodedCommand 更好排查（出问题能直接看文件）。
     */
    const scriptPath = path.join(require('node:os').tmpdir(), `hxl-uninstall-purge-${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, '\uFEFF' + script, 'utf8');

    const child = spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', 'start', '""', '/min', powershellExe(), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
      { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: false }
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 安装目录里 data 占多少（卸载界面用来告诉用户「这些会留下」）。
 */
async function dataSizeBytes(installDir) {
  const dataDir = path.join(installDir, 'data');
  if (!fs.existsSync(dataDir)) return 0;

  let total = 0;
  const stack = [dataDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* 单个文件读不到不影响总量估算 */
        }
      }
    }
  }
  return total;
}

/**
 * 卸载入口。调用方（主进程）负责创建窗口和展示进度，这里只做文件操作。
 *
 * options.keepData 固定为 true —— 界面上的文案已经写明会保留，不做可选项，
 * 免得用户勾错一次丢掉全部抽卡记录。真要清干净，删掉 data 目录即可。
 */
async function performUninstall(installDir, onProgress) {
  const report = (phase, percent, text) => {
    try {
      if (typeof onProgress === 'function') onProgress({ phase, percent, text });
    } catch {
      /* 进度回调失败不影响卸载 */
    }
  };

  const result = {
    ok: false,
    installDir,
    removed: 0,
    pending: [],
    failed: [],
    dataKept: fs.existsSync(path.join(installDir, 'data')),
  };

  try {
    report('prepare', 5, '正在准备卸载…');

    report('shortcut', 15, '正在移除快捷方式…');
    removeShortcuts();

    report('registry', 25, '正在清除系统记录…');
    removeUninstallRegistry();

    report('remove', 40, '正在移除程序文件…');
    const { removed, pending, failed } = removeProgramFiles(installDir);
    result.removed = removed;
    result.pending = pending;
    result.failed = failed;

    report('cleanup', 85, pending.length ? '正在安排清理被占用的文件…' : '正在收尾…');
    result.scheduled = schedulePurge(installDir, pending);

    result.ok = true;
    report('done', 100, '卸载完成');
    return result;
  } catch (error) {
    result.error = (error && error.message) || String(error);
    return result;
  }
}

/** 卸载界面上要显示的信息。 */
async function uninstallInfo(installDir) {
  /*
   * 主程序 exe 名必须跟安装出去的一致。以前这里写死 `launcher.exe` —— 那是
   * 早期英文版的文件名，现在装出来的是 `花筱灵启动器.exe`，于是 exeExists
   * 永远是 false（界面据此显示「没找到程序」的误导状态）。用常量统一。
   */
  const exePath = path.join(installDir, APP_EXE);
  return {
    installDir,
    dataKept: fs.existsSync(path.join(installDir, 'data')),
    dataBytes: await dataSizeBytes(installDir),
    exeExists: fs.existsSync(exePath),
  };
}

/* ── 卸载窗口 ─────────────────────────────────────────────────────── */

/**
 * 创建卸载窗口并跑完整流程。
 *
 * 调用方是 main.js 里 --uninstall 的分支。这个函数自己管 IPC 注册，
 * 卸载完就退出应用 —— 卸载窗口关掉之后进程没有存在的理由。
 *
 * 窗口尺寸和安装程序对齐（720×480，无边框），用的是主程序 asar 里的图。
 */
function runUninstallWindow({ BrowserWindow, ipcMain, app, rootDir }) {
  const win = new BrowserWindow({
    width: 720,
    height: 480,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    backgroundColor: '#1a0f1c',
    show: false,
    title: `卸载 ${APP_NAME}`,
    webPreferences: {
      preload: path.join(__dirname, 'uninstall-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // 窗口位置在屏幕正中
  try {
    const { screen } = require('electron');
    const { workArea } = screen.getPrimaryDisplay();
    win.setPosition(
      Math.round(workArea.x + (workArea.width - 720) / 2),
      Math.round(workArea.y + (workArea.height - 480) / 2)
    );
  } catch {
    /* 居中失败不影响卸载 */
  }

  // 这是卸载程序 —— 装的时候写在安装目录里，dir 就是它自己所在处
  const installDir = path.dirname(process.execPath);

  ipcMain.handle('uninstall:info', () => uninstallInfo(installDir));

  ipcMain.handle('uninstall:start', async () => {
    const result = await performUninstall(installDir, (payload) => {
      try {
        if (!win.isDestroyed()) win.webContents.send('uninstall:progress', payload);
      } catch {
        /* 窗口关掉了就算了 */
      }
    });
    return result;
  });

  ipcMain.handle('uninstall:close', () => {
    try {
      if (!win.isDestroyed()) win.close();
    } catch {
      /* ignore */
    }
    return { ok: true };
  });

  win.loadFile(path.join(rootDir, 'src', 'uninstall.html'));

  win.once('ready-to-show', () => win.show());

  win.on('closed', () => {
    app.quit();
  });

  return win;
}

module.exports = {
  APP_NAME,
  APP_ID,
  UNINSTALL_KEY,
  KEEP_TOP_LEVEL,
  performUninstall,
  uninstallInfo,
  removeShortcuts,
  removeUninstallRegistry,
  removeProgramFiles,
  schedulePurge,
  dataSizeBytes,
  runUninstallWindow,
};