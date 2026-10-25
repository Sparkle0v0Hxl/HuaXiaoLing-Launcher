'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function findPlatformProcess(root, maxDepth = 3) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    const candidate = path.join(current.dir, 'PlatformProcess.exe');
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
  return null;
}

function launchEndfield(gameRoot, gameExe, args = '') {
  return new Promise((resolve) => {
    const platformProcess = findPlatformProcess(gameRoot);
    if (!platformProcess) {
      resolve({ ok: false, error: '没有找到终末地官方 PlatformProcess.exe' });
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
    const platformProcess = findPlatformProcess(gameRoot);
    if (!platformProcess) {
      resolve({ ok: false, error: '没有找到终末地官方 PlatformProcess.exe' });
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

    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const argsList = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'endfield-decoy.ps1'),
      '-ParentExe',
      path.join(tempDir, 'Games.exe'),
      '-GameExe',
      gameExe,
      '-WorkDir',
      gameRoot,
    ];
    if (args && args.trim()) argsList.push('-GameArgs', args);
    argsList.push('-TempDir', tempDir, '-PidFile', pidFile);
    const command = [
      `$arguments = @(${argsList.map(quote).join(',')})`,
      `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments`,
    ].join('; ');
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

    const timer = setTimeout(() => {
      finish({ ok: false, error: '等待管理员授权超时，请重试' });
    }, 60000);

    outer.once('exit', (code) => {
      if (settled || fs.existsSync(pidFile)) return;
      if (code && code !== 0) {
        finish({ ok: false, error: `管理员授权未完成（${code}）` });
      }
    });
  });
}

module.exports = { launchEndfield, launchEndfieldElevated };
