'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * decoy 父进程候选。PlatformProcess.exe 是官方标准父进程（游戏根目录），
 * 但参照 Xel-Launcher（GameDecoyParentBridge.CandidateNames）加两个鹰角签名
 * 兜底：官方未来挪动/删除 PlatformProcess.exe 时，任何本地鹰角签名 exe 都能
 * 当签名父进程用（endfield-decoy.ps1 会再校验一次 Authenticode）。
 */
const DECOY_PARENT_NAMES = ['PlatformProcess.exe', 'UnityCrashHandler64.exe', 'Endfield.exe'];

function findDecoyParent(root, maxDepth = 3) {
  for (const name of DECOY_PARENT_NAMES) {
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      const candidate = path.join(current.dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* continue */
      }
      if (current.depth >= maxDepth) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.vela-linked-runtime')) continue;
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return null;
}

/**
 * 上次启动被中断时（关掉 UAC、任务管理器强杀等）会在 %TEMP% 留下
 * Vela-Endfield-xxxx 目录，里面是复制出来的 Games.exe。启动前顺手清掉旧残留。
 */
function cleanStaleTempDirs() {
  try {
    const tmp = os.tmpdir();
    const now = Date.now();
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith('Vela-Endfield-')) continue;
      const full = path.join(tmp, name);
      try {
        if (now - fs.statSync(full).mtimeMs < 10 * 60 * 1000) continue;
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        /* 单个目录清不掉不影响启动 */
      }
    }
  } catch {
    /* ignore */
  }
}

function launchEndfield(gameRoot, gameExe, args = '') {
  return new Promise((resolve) => {
    cleanStaleTempDirs();
    const platformProcess = findDecoyParent(gameRoot);
    if (!platformProcess) {
      resolve({ ok: false, error: '没有找到可用的鹰角签名父进程（PlatformProcess.exe）' });
      return;
    }

    let tempDir;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Vela-Endfield-'));
      fs.copyFileSync(platformProcess, path.join(tempDir, 'Games.exe'));
    } catch (error) {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      resolve({ ok: false, error: `无法准备官方启动器：${error.message}` });
      return;
    }

    const script = path.join(__dirname, 'endfield-decoy.ps1');
    const decoy = path.join(tempDir, 'Games.exe');
    const scriptArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ParentExe',
      decoy,
      '-GameExe',
      gameExe,
      '-WorkDir',
      gameRoot,
    ];
    if (args && args.trim()) scriptArgs.push('-GameArgs', args);
    scriptArgs.push('-TempDir', tempDir);
    const child = spawn('powershell.exe', scriptArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const cleanup = () => {
      try {
        child.stdout.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.stderr.destroy();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        cleanup();
      } else {
        try {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        } catch {
          /* ignore */
        }
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: '官方启动器启动超时' });
    }, 12000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const pidMatch = stdout.match(/PID:(\d+)/);
      if (pidMatch) {
        finish({ ok: true, pid: Number(pidMatch[1]), platformProcess });
        return;
      }
      if (/ERROR:/.test(stdout)) {
        finish({ ok: false, error: stdout.split('ERROR:').pop().trim() });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.once('error', (error) => {
      finish({ ok: false, error: `无法启动官方启动器：${error.message}` });
    });

    child.once('exit', (code) => {
      if (!settled) {
        const message = (stdout.match(/ERROR:(.+)/) || [])[1] || stderr.trim() || `启动器退出（${code}）`;
        finish({ ok: false, error: message });
      }
    });
  });
}

function launchEndfieldElevated(gameRoot, gameExe, args = '') {
  return new Promise((resolve) => {
    const platformProcess = findDecoyParent(gameRoot);
    if (!platformProcess) {
      resolve({ ok: false, error: '没有找到可用的鹰角签名父进程（PlatformProcess.exe）' });
      return;
    }
    let tempDir;
    let pidFile;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Vela-Endfield-'));
      pidFile = path.join(os.tmpdir(), `Vela-Endfield-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`);
      fs.copyFileSync(platformProcess, path.join(tempDir, 'Games.exe'));
    } catch (error) {
      resolve({ ok: false, error: `无法准备官方启动器：${error.message}` });
      return;
    }

    /*
     * 给内层 powershell 传参必须整体拼成一个「预先加好引号的字符串」再交给
     * -ArgumentList。PS 5.1 的 Start-Process 对数组参数只做空格拼接、不加引号，
     * 路径里带空格（比如官方客户端目录 G:\Arknights Endfield）会把参数撕碎，
     * 内层脚本根本跑不起来，外层只能干等 180 秒超时（10-29 官服直启后踩中）。
     */
    const dq = (value) => `"${String(value)}"`;
    const innerArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      dq(path.join(__dirname, 'endfield-decoy.ps1')),
      '-ParentExe',
      dq(path.join(tempDir, 'Games.exe')),
      '-GameExe',
      dq(gameExe),
      '-WorkDir',
      dq(gameRoot),
    ];
    if (args && args.trim()) innerArgs.push('-GameArgs', dq(args));
    innerArgs.push('-TempDir', dq(tempDir), '-PidFile', dq(pidFile));
    const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList '${innerArgs
      .join(' ')
      .replace(/'/g, "''")}'`;
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const outer = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore',
    });

    let settled = false;
    const cleanup = () => {
      try {
        if (pidFile) fs.rmSync(pidFile, { force: true });
      } catch {
        /* ignore */
      }
      if (!fs.existsSync(path.join(tempDir, 'Games.exe'))) return;
      // The elevated worker owns the staged image while the game runs.
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (!result.ok) {
        try {
          outer.kill();
        } catch {
          /* ignore */
        }
        cleanup();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      } else {
        cleanup();
      }
      resolve(result);
    };

    const poll = setInterval(() => {
      try {
        if (!fs.existsSync(pidFile)) return;
        const content = fs.readFileSync(pidFile, 'utf8').trim();
        const pid = content.match(/PID:(\d+)/);
        if (pid) {
          finish({ ok: true, pid: Number(pid[1]), platformProcess, elevated: true });
          return;
        }
        if (/ERROR:/.test(content)) {
          finish({ ok: false, error: content.split('ERROR:').pop().trim() });
        }
      } catch {
        /* keep polling */
      }
    }, 400);

    /*
     * 这里的等待是在等用户点「用户账户控制」窗口里的「是」。
     * 之前只给 60 秒，用户去干别的就超时，看到的却是毫无指向性的
     * 「等待管理员授权超时」。给足 3 分钟并写清楚该做什么。
     */
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: '等待管理员授权超时。启动终末地需要管理员权限，请在「用户账户控制」窗口里点“是”后重试',
      });
    }, 180000);

    outer.once('exit', (code) => {
      if (settled || fs.existsSync(pidFile)) return;
      if (code && code !== 0) {
        finish({
          ok: false,
          error: `管理员授权未完成（退出码 ${code}）。如果在「用户账户控制」窗口点了“否”，请重试并点“是”`,
        });
      }
    });
  });
}

module.exports = { launchEndfield, launchEndfieldElevated };
