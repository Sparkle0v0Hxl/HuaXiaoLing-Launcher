'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/*
 * 终末地 / 明日方舟会校验自己的**直接父进程**：父进程文件必须是带鹰角官方 Authenticode
 * 签名的可执行体（Games.exe / PlatformProcess.exe / Arknights.exe…）。直接双击游戏本体
 * 会拿到 10100「请通过官方启动器打开游戏」。
 *
 * 治本方案（v2.6.1 起）：把整套「签名父进程 + 游戏子进程」逻辑预编译进 VelaEndfield.exe，
 * 主进程直接 spawn 它、读它的 PID:/ERROR: 输出即可，**彻底不再依赖 PowerShell**——
 * 哪怕机器上完全没装 PowerShell、或被组策略 / WDAC 禁用，只要 Windows 自带的 .NET
 * Framework 在（每台 Win10/11 都有），终末地就能正常起。
 *
 * VelaEndfield.exe 内部流程：校验父进程内嵌签名 → 以挂起态拉起签名父进程 → 用
 * PROC_THREAD_ATTRIBUTE_PARENT_PROCESS 把它设为游戏父进程 → 把游戏 PID / 错误写进管道
 * 与 pid 文件。提权版（-Elevate）用 runas 自提升，替代 PowerShell 的
 * Start-Process -Verb RunAs，连 UAC 窗口都自己弹。
 *
 * 路径（重点，之前就是这里写错导致打包后 spawn ENOENT）：
 *   开发态  —— __dirname 就是 electron/，VelaEndfield.exe 是真实文件，直接用。
 *   打包态  —— __dirname 形如 …/resources/app.asar/electron（asar 虚拟路径），
 *             操作系统 CreateProcess 根本找不到；asarUnpack 实际把 exe 抽到了
 *             …/resources/app.asar.unpacked/electron/VelaEndfield.exe（这才是真身）。
 *             所以打包态要把 app.asar 换成 app.asar.unpacked 再拼，不能用 __dirname 的虚拟路径。
 *   不能用 fs.existsSync 判断两种态——Electron 给 fs 打了补丁，asar 虚拟路径会被误判「存在」。
 */
function velaExe() {
  const sep = path.sep;
  const asarIdx = __dirname.indexOf('.asar' + sep);
  if (asarIdx !== -1) {
    const unpackedDir =
      __dirname.slice(0, asarIdx) + '.asar.unpacked' + __dirname.slice(asarIdx + '.asar'.length);
    return path.join(unpackedDir, 'VelaEndfield.exe');
  }
  return path.join(__dirname, 'VelaEndfield.exe');
}

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
 * 返回 { parent, tempDir, copyFrom }：tempDir 为空表示直接用的原文件。
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

/** 组装给 VelaEndfield.exe 的参数。 */
function velaArgs(staging, gameExe, gameRoot, args, pidFile) {
  const list = [
    '-ParentExe', staging.parent,
    '-GameExe', gameExe,
    '-WorkDir', gameRoot,
  ];
  if (args && args.trim()) list.push('-GameArgs', args);
  if (staging.tempDir) list.push('-TempDir', staging.tempDir);
  if (pidFile) list.push('-PidFile', pidFile);
  return list;
}

/** 准备签名父进程：找得到返回 staging，找不到返回 null（调用方据此报错）。 */
function prepareStaging(gameRoot) {
  let staging;
  try {
    staging = stageDecoyParent(gameRoot);
  } catch (error) {
    return { error: `无法准备官方启动器：${error.message}` };
  }
  if (!staging.parent) {
    return { error: '没有找到可用的鹰角签名父进程（官方启动器 Games.exe / 游戏目录 PlatformProcess.exe）' };
  }
  return { staging };
}

/** 需要复制时把源文件拷到临时目录；失败清理并返回错误。 */
function copyParentIfNeeded(staging) {
  if (!staging.copyFrom) return null;
  try {
    fs.copyFileSync(staging.copyFrom, staging.parent);
    return null;
  } catch (error) {
    if (staging.tempDir) {
      try {
        fs.rmSync(staging.tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return `无法准备官方启动器：${error.message}`;
  }
}

/**
 * 普通（非提权）启动：直接跑 VelaEndfield.exe，从 stdout 读 PID:/ERROR:。
 * exe 内部会一直守着游戏进程，成功后我们只摘掉管道句柄、不杀进程。
 */
async function launchEndfield(gameRoot, gameExe, args = '') {
  cleanStaleTempDirs();
  const exe = velaExe();
  if (!fs.existsSync(exe)) {
    return { ok: false, error: '缺少 VelaEndfield.exe（签名父进程组件），请重新安装启动器' };
  }
  const prepared = prepareStaging(gameRoot);
  if (prepared.error) return { ok: false, error: prepared.error };
  const staging = prepared.staging;
  const copyErr = copyParentIfNeeded(staging);
  if (copyErr) return { ok: false, error: copyErr };

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(exe, velaArgs(staging, gameExe, gameRoot, args), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';

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
        if (staging.tempDir) {
          try {
            fs.rmSync(staging.tempDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      } else {
        // 游戏还活着：exe 要留着守进程，管道先摘掉避免句柄堆积
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

    // exe 本身是秒级的；留 45 秒是给杀软首次扫描 VelaEndfield.exe 的余量
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `官方启动器父进程准备超时（45 秒）。常见原因是安全软件拦截了 VelaEndfield.exe，请把它加入白名单后重试`,
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

    child.stderr.on('data', () => {
      /* 暂不需要 stderr 内容，关键信号都在 stdout 的 PID:/ERROR: */
    });

    child.once('error', (error) => {
      finish({ ok: false, error: `无法启动官方启动器：${error.message}` });
    });

    child.once('exit', (code) => {
      if (!settled) {
        const message =
          (stdout.match(/ERROR:(.+)/) || [])[1] ||
          `启动器退出（${code}）`;
        finish({ ok: false, error: message.trim() });
      }
    });
  });
}

/**
 * 提权启动：给 VelaEndfield.exe 加 -Elevate，它自己用 runas 弹 UAC 窗口、自提升后
 * 再以管理员身份跑完整流程，结果写进 pid 文件。非提权的父进程会一直守着等提权子进程
 * 退出（也就是等游戏结束），我们这边轮询 pid 文件即可。
 */
async function launchEndfieldElevated(gameRoot, gameExe, args = '') {
  cleanStaleTempDirs();
  const exe = velaExe();
  if (!fs.existsSync(exe)) {
    return { ok: false, error: '缺少 VelaEndfield.exe（签名父进程组件），请重新安装启动器' };
  }
  const prepared = prepareStaging(gameRoot);
  if (prepared.error) return { ok: false, error: prepared.error };
  const staging = prepared.staging;
  const copyErr = copyParentIfNeeded(staging);
  if (copyErr) return { ok: false, error: copyErr };

  return new Promise((resolve) => {
    const pidFile = path.join(
      os.tmpdir(),
      `Vela-Endfield-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`
    );
    const child = spawn(exe, ['-Elevate', ...velaArgs(staging, gameExe, gameRoot, args, pidFile)], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
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
          child.kill();
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
      } else {
        // exe（含它提权起的子进程）继续守游戏，父进程 detach 不阻塞 Node
        try {
          child.unref();
        } catch {
          /* ignore */
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
          '等待管理员授权超时。终末地必须经 Windows「用户账户控制」窗口授权才能启动；如果那个窗口没弹出来，多半是安全软件拦下了 VelaEndfield.exe，请把它加入白名单后重试',
      });
    }, 120000);

    child.once('exit', (code) => {
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

// velaArgs 也导出：它是「启动器 → 签名父进程」这条链的唯一参数接缝，
// 自测直接断言它拼出来的命令行，比正则猜源码可靠（DX 开关就靠它过桥）。
module.exports = { launchEndfield, launchEndfieldElevated, velaArgs };
