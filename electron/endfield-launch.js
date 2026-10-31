'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { app } = require('electron');

/** 本机 powershell.exe 绝对路径：PATH 被安全软件/定制系统改坏的机器上，
 * 裸写 'powershell.exe' 会 ENOENT，整条签名父进程链直接瘫痪。 */
function powershellExe() {
  const candidate = path.join(
    process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* ignore */
  }
  return 'powershell.exe';
}

/*
 * 终末地会校验自己的**直接父进程**：父进程文件必须名为 Games.exe、带鹰角官方签名。
 * 直接双击 Endfield.exe 会拿到 10100「请通过官方启动器打开游戏」。
 *
 * 做法是把它做成「签名父进程 + 游戏子进程」：以挂起状态创建一个签名有效的
 * Games.exe 并永不恢复，再用 PROC_THREAD_ATTRIBUTE_PARENT_PROCESS 把它指定为
 * 游戏的父进程（参考 EndfieldNoLauncher 的做法）。启动器界面因此不会弹出来。
 */
const DECOY_PARENT_NAMES = [
  'PlatformProcess.exe',
  'UnityCrashHandler64.exe',
  'Endfield.exe',
  // 明日方舟 PC 端：共用同一套鹰角平台，本体（签名有效）也能当签名父进程
  'Arknights.exe',
  'lights.exe',
];

/** 官方鹰角启动器的常见安装位置：里面的 Games.exe 本来就叫这个名字，可以原地使用。 */
function officialLauncherDirs() {
  const dirs = [];
  for (const base of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
    process.env.LOCALAPPDATA,
  ]) {
    if (!base) continue;
    dirs.push(path.join(base, 'Hypergryph Launcher'));
    dirs.push(path.join(base, 'Hypergryph'));
  }
  return dirs;
}

/**
 * 找一个已经叫 Games.exe 的官方启动器本体。
 * 命中的话直接使用原文件，不做复制 —— 从 Program Files 里起的签名进程
 * 不会被安全软件当成「临时目录里的可疑 exe」，这是最干净的一条路。
 */
function findOfficialGamesExe() {
  for (const base of officialLauncherDirs()) {
    const queue = [{ dir: base, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      try {
        if (fs.statSync(path.join(current.dir, 'Games.exe')).isFile()) {
          return path.join(current.dir, 'Games.exe');
        }
      } catch {
        /* 目录不存在或没有这个文件，继续往上找 */
      }
      if (current.depth >= 2) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return '';
}

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
 * 挑签名父进程：优先官方启动器里现成的 Games.exe（原地用，不复制），
 * 其次是游戏目录里的 PlatformProcess.exe / Endfield.exe（复制成 Games.exe 再用）。
 * 返回 { parent, tempDir }：tempDir 为空表示直接用的原文件。
 */
function stageDecoyParent(gameRoot) {
  const official = findOfficialGamesExe();
  if (official) return { parent: official, tempDir: '' };

  const source = findDecoyParent(gameRoot);
  if (!source) return { parent: '', tempDir: '' };
  if (path.basename(source).toLowerCase() === 'games.exe') return { parent: source, tempDir: '' };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Vela-Endfield-'));
  return { parent: path.join(tempDir, 'Games.exe'), tempDir, copyFrom: source };
}

/** 上次启动被中断时（关掉 UAC、任务管理器强杀等）会在 %TEMP% 留下残留，启动前清掉。 */
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

/**
 * C# 互操作那段只编译一次，之后直接加载编译好的程序集。
 * Add-Type -TypeDefinition 每次都要启动一次 C# 编译器（冷启动 5~15 秒），
 * 以前 12 秒超时一到就直接判定失败、退化成直接启动游戏，
 * 用户看到的就是「请先通过官方启动器打开游戏」。编译成果缓存在数据目录里，
 * 之后每次只是 Add-Type -Path（几百毫秒）。
 */
let assemblyPathCache = null;
let assemblyChecked = false;

function decoyAssemblyPath() {
  if (assemblyPathCache) return assemblyPathCache;
  let root = '';
  try {
    root = app.getPath('userData');
  } catch {
    root = '';
  }
  if (!root) return '';
  assemblyPathCache = path.join(root, 'tools', 'VelaEndfield.dll');
  return assemblyPathCache;
}

async function buildDecoyAssembly(script) {
  const target = decoyAssemblyPath();
  if (!target) return '';
  if (fs.existsSync(target)) return target;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    return '';
  }
  // 异步编译：C# 编译器冷启动要几秒到十几秒，同步等会把界面卡住
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        childProcess.kill();
      } catch {
        /* ignore */
      }
      done({ ok: false });
    }, 120000);
    const childProcess = spawn(
      powershellExe(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-CompileOnly',
        target,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let detail = '';
    childProcess.stderr.on('data', (chunk) => {
      detail += chunk.toString('utf8');
    });
    childProcess.once('error', () => done({ ok: false, detail }));
    childProcess.once('exit', (code) => done({ ok: code === 0, detail: detail.slice(0, 300) }));
  });
  if (!result.ok) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* ignore */
    }
    return '';
  }
  return fs.existsSync(target) ? target : '';
}

/** 组装好给 decoy 脚本的参数（两条启动路径共用）。 */
function decoyArgs(script, staging, gameExe, gameRoot, args, extra = [], assembly = '') {
  const list = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-ParentExe',
    staging.parent,
    '-GameExe',
    gameExe,
    '-WorkDir',
    gameRoot,
  ];
  if (args && args.trim()) list.push('-GameArgs', args);
  if (staging.tempDir) list.push('-TempDir', staging.tempDir);
  if (assembly) list.push('-Assembly', assembly);
  list.push(...extra);
  return list;
}

/**
 * 拿到可以直接加载的程序集：第一次编译一次，之后都直接 Add-Type -Path。
 * 返回空串表示这次让脚本自己编译（编译失败也只是慢一点，不影响能不能起来）。
 */
async function resolveDecoyAssembly(script) {
  if (assemblyChecked) {
    return assemblyPathCache && fs.existsSync(assemblyPathCache) ? assemblyPathCache : '';
  }
  assemblyChecked = true;
  return buildDecoyAssembly(script);
}

async function launchEndfield(gameRoot, gameExe, args = '') {
  cleanStaleTempDirs();
  const script = path.join(__dirname, 'endfield-decoy.ps1');
  let staging;
  try {
    staging = stageDecoyParent(gameRoot);
  } catch (error) {
    return { ok: false, error: `无法准备官方启动器：${error.message}` };
  }
  if (!staging.parent) {
    return {
      ok: false,
      error: '没有找到可用的鹰角签名父进程（官方启动器 Games.exe / 游戏目录 PlatformProcess.exe）',
    };
  }
  if (staging.copyFrom) {
    try {
      fs.copyFileSync(staging.copyFrom, staging.parent);
    } catch (error) {
      if (staging.tempDir) {
        try {
          fs.rmSync(staging.tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      return { ok: false, error: `无法准备官方启动器：${error.message}` };
    }
  }
  const assembly = await resolveDecoyAssembly(script);

  return new Promise((resolve) => {
    const child = spawn(
      powershellExe(),
      decoyArgs(script, staging, gameExe, gameRoot, args, [], assembly),
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );

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
      if (staging.tempDir) {
        try {
          fs.rmSync(staging.tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
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
        // 游戏还活着：脚本要留着等它退出，管道先摘掉避免句柄堆积
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

    // 程序集缓存命中后脚本本身是秒级的；留 45 秒是给「第一次编译 + 杀软扫描」的余量
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `官方启动器父进程准备超时（45 秒）。常见原因是安全软件拦截了 PowerShell，请把 ${script} 与 powershell.exe 加入白名单后重试`,
      });
    }, 45000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const pidMatch = stdout.match(/PID:(\d+)/);
      if (pidMatch) {
        finish({ ok: true, pid: Number(pidMatch[1]), parent: staging.parent });
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
        const message =
          (stdout.match(/ERROR:(.+)/) || [])[1] ||
          stderr.trim() ||
          `启动器退出（${code}）`;
        finish({ ok: false, error: message });
      }
    });
  });
}

async function launchEndfieldElevated(gameRoot, gameExe, args = '') {
  cleanStaleTempDirs();
  const script = path.join(__dirname, 'endfield-decoy.ps1');
  let staging;
  try {
    staging = stageDecoyParent(gameRoot);
  } catch (error) {
    return { ok: false, error: `无法准备官方启动器：${error.message}` };
  }
  if (!staging.parent) {
    return {
      ok: false,
      error: '没有找到可用的鹰角签名父进程（官方启动器 Games.exe / 游戏目录 PlatformProcess.exe）',
    };
  }
  if (staging.copyFrom) {
    try {
      fs.copyFileSync(staging.copyFrom, staging.parent);
    } catch (error) {
      return { ok: false, error: `无法准备官方启动器：${error.message}` };
    }
  }
  const assembly = await resolveDecoyAssembly(script);

  return new Promise((resolve) => {
    const pidFile = path.join(
      os.tmpdir(),
      `Vela-Endfield-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`
    );

    /*
     * 给内层 powershell 传参必须整体拼成一个「预先加好引号的字符串」再交给
     * -ArgumentList。PS 5.1 的 Start-Process 对数组参数只做空格拼接、不加引号，
     * 路径里带空格（比如官方客户端目录 G:\Arknights Endfield）会把参数撕碎，
     * 内层脚本根本跑不起来，外层只能干等超时。
     */
    const dq = (value) => `"${String(value)}"`;
    const innerArgs = decoyArgs(script, staging, gameExe, gameRoot, args, ['-PidFile', dq(pidFile)], assembly);
    // 前 6 个是 powershell 自己的开关，路径参数才需要加引号
    const quoted = innerArgs.map((item, index) => (index < 6 ? item : dq(item)));
    const command = `Start-Process -FilePath '${powershellExe()}' -Verb RunAs -WindowStyle Hidden -ArgumentList '${quoted
      .join(' ')
      .replace(/'/g, "''")}'`;
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const outer = spawn(powershellExe(), ['-NoProfile', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore',
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        fs.rmSync(pidFile, { force: true });
      } catch {
        /* ignore */
      }
      if (!result.ok) {
        try {
          outer.kill();
        } catch {
          /* ignore */
        }
        if (staging.tempDir) {
          try {
            fs.rmSync(staging.tempDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
      resolve(result);
    };

    const poll = setInterval(() => {
      try {
        if (!fs.existsSync(pidFile)) return;
        const content = fs.readFileSync(pidFile, 'utf8').trim();
        const pid = content.match(/PID:(\d+)/);
        if (pid) {
          finish({ ok: true, pid: Number(pid[1]), parent: staging.parent, elevated: true });
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
     * 两分钟足够看一眼并点掉；超时就明确告诉他该点哪个窗口。
     */
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error:
          '等待管理员授权超时。终末地必须经 Windows「用户账户控制」窗口授权才能启动；如果那个窗口没弹出来，多半是安全软件拦下了 PowerShell，请把 powershell.exe 加入白名单后重试',
      });
    }, 120000);

    outer.once('exit', (code) => {
      if (settled || fs.existsSync(pidFile)) return;
      if (code && code !== 0) {
        finish({
          ok: false,
          error: `管理员授权未完成（退出码 ${code}）。请在本机的「用户账户控制」设置里至少保留“仅当应用尝试更改计算机时通知我”，或在 UAC 窗口里点“是”`,
        });
      }
    });
  });
}

module.exports = { launchEndfield, launchEndfieldElevated };
