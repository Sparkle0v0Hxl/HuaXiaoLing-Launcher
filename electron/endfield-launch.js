'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/*
 * 终末地 / 明日方舟的启动辅助模块。
 *
 * 这两款游戏的客户端要求「以官方启动器的方式进入」，普通 spawn 起来时客户端拿不到它
 * 期望的进程上下文，会直接退到登录界面之前。这里对外提供 launchEndfield() 等入口，
 * 用 VelaEndfield.exe 建立一条与官方启动器一致的启动路径：
 *
 * VelaEndfield.exe 的流程：核对父进程文件的 Authenticode 状态 → 以挂起态创建它 →
 * 通过 PROC_THREAD_ATTRIBUTE_PARENT_PROCESS 指定为游戏进程的父进程 → 把游戏 PID /
 * 错误写进管道与 pid 文件。提权版（-Elevate）用 runas 自提升，取代
 * Start-Process -Verb RunAs，UAC 窗口由它自己弹。
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

const COMPAT_PARENT_NAMES = [
  'PlatformProcess.exe',
  'UnityCrashHandler64.exe',
  'Endfield.exe',
  // 明日方舟 PC 端与终末地共用同一套鹰角平台，本体同样可以承担父进程角色
  'Arknights.exe',
  'lights.exe',
];

/**
 * 跑一次 reg.exe 查询，拿不到就返回空串。
 * 用 execFileSync 而不是 exec，避免 shell 引号问题；超时给 2500ms，
 * 注册表查询本在毫秒级，超时说明环境异常，直接放弃不影响启动。
 */
function regQuery(args, timeout) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('reg.exe', args, {
      timeout: timeout || 2500,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out || '');
  } catch {
    return '';
  }
}

/** 从 reg query 输出里抽取指定值名、且确实存在的目录路径。 */
function pathsFromRegOutput(output, valueNames) {
  const found = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (valueNames && !valueNames.includes(m[1])) continue;
    const value = m[2].replace(/^"|"$/g, '').trim();
    if (!value || !path.isAbsolute(value)) continue;
    try {
      if (!fs.statSync(value).isDirectory()) continue;
    } catch {
      continue;
    }
    found.push(value);
  }
  return found;
}

/** 注册表里官方启动器自己记的安装路径（最权威）。 */
function registryLauncherDirs() {
  const dirs = [];
  // HKCU\SOFTWARE\Hypergryph\Launcher\<hash> 下有一个值叫 install_path
  const installPathOut = regQuery(['query', 'HKCU\\SOFTWARE\\Hypergryph\\Launcher', '/s', '/v', 'install_path']);
  dirs.push(...pathsFromRegOutput(installPathOut, ['install_path']));
  // 卸载项里的 InstallLocation（官方安装包写的那一份）
  for (const root of [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    const output = regQuery(['query', root, '/s', '/f', 'Hypergryph', '/d']);
    if (!output) continue;
    dirs.push(...pathsFromRegOutput(output, ['InstallLocation']));
  }
  return dirs;
}

/** 常见盘符 + 常见相对路径兜底：官方启动器也可能装在注册表没记录的位置。 */
function scannedLauncherDirs() {
  const dirs = [];
  const relatives = [
    ['Hypergryph Launcher'],
    ['Hypergryph', 'Launcher'],
    ['Program Files', 'Hypergryph Launcher'],
    ['Program Files (x86)', 'Hypergryph Launcher'],
    ['Games', 'Hypergryph Launcher'],
    ['Launchers', 'Hypergryph Launcher'],
  ];
  for (const letter of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) {
    const root = letter + ':\\';
    try {
      if (!fs.statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const parts of relatives) {
      const candidate = path.join(root, ...parts);
      try {
        if (fs.statSync(candidate).isDirectory() && !dirs.includes(candidate)) dirs.push(candidate);
      } catch {
        /* 不存在就算了 */
      }
    }
  }
  return dirs;
}

let cachedOfficialDirs = null;

/**
 * 官方鹰角启动器的候选安装位置：里面的 Games.exe 本来就叫这个名字，可以原地使用。
 * 顺序 = 环境变量 → 注册表 → 盘符扫描；后两者按进程缓存。
 * 注册表记的是安装根目录，Games.exe 通常在其版本子目录（如 1.6.0/）下，
 * findOfficialGamesExe() 会自己 BFS 两层，所以这里把根目录原样加进去即可。
 */
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
  if (!cachedOfficialDirs) {
    const discovered = [];
    for (const extra of [...registryLauncherDirs(), ...scannedLauncherDirs()]) {
      if (!discovered.includes(extra)) discovered.push(extra);
    }
    cachedOfficialDirs = discovered;
  }
  for (const extra of cachedOfficialDirs) {
    if (!dirs.includes(extra)) dirs.push(extra);
  }
  return dirs;
}

/** 供上层在用户重装官方启动器后强制重扫。 */
function clearOfficialLauncherCache() {
  cachedOfficialDirs = null;
}

/**
 * 找一个已经叫 Games.exe 的官方启动器可执行文件。
 * 命中就直接用原文件、不做复制 —— 从 Program Files 里启动的文件，
 * 路径与签名都和官方启动器完全一致，是行为差异最小的一条路。
 */
/**
 * 判断一个 exe 的清单是否要求以管理员身份运行。
 * 官方鹰角启动器的 Games.exe 就是 requireAdministrator —— 非提权进程无法把它
 * 以挂起状态创建出来（实测 VelaEndfield 报 "failed to create parent process"）。
 * 按 path + size + mtime 缓存，避免重复扫大文件。
 */
const adminCache = new Map();
function peNeedsAdmin(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  const key = file + '|' + stat.size + '|' + stat.mtimeMs;
  if (adminCache.has(key)) return adminCache.get(key);
  let needs = false;
  try {
    // 清单在 PE 资源段里，位置不固定，只能整体扫；限制上限避免极端大文件卡住
    if (stat.size <= 64 * 1024 * 1024) {
      const buf = fs.readFileSync(file);
      needs = buf.includes('requireAdministrator');
    }
  } catch {
    needs = false;
  }
  adminCache.set(key, needs);
  return needs;
}

/**
 * 找一个已经叫 Games.exe 的官方启动器可执行文件。
 * options.asInvokerOnly 为真时跳过 requireAdministrator 的候选 ——
 * 非提权进程创建不了它们，选中了只会白白失败一次。
 */
function findOfficialGamesExe(options) {
  const asInvokerOnly = Boolean(options && options.asInvokerOnly);
  for (const base of officialLauncherDirs()) {
    const queue = [{ dir: base, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      try {
        const candidate = path.join(current.dir, 'Games.exe');
        if (fs.statSync(candidate).isFile()) {
          if (!asInvokerOnly || !peNeedsAdmin(candidate)) return candidate;
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

function findCompatParent(root, maxDepth = 3) {
  for (const name of COMPAT_PARENT_NAMES) {
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
 * 挑父进程文件：优先取官方启动器里现成的 Games.exe（原地使用，不复制），
 * 其次是游戏目录里的 PlatformProcess.exe / Endfield.exe（复制成 Games.exe 后再用）。
 * 返回 { parent, tempDir, copyFrom }：tempDir 为空表示直接用原文件。
 */
function stageCompatParent(gameRoot, options) {
  const official = findOfficialGamesExe(options);
  if (official) return { parent: official, tempDir: '' };

  const source = findCompatParent(gameRoot);
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
function prepareStaging(gameRoot, options) {
  let staging;
  try {
    staging = stageCompatParent(gameRoot, options);
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
async function launchEndfield(gameRoot, gameExe, args = '', options = {}) {
  cleanStaleTempDirs();
  /*
   * 非提权进程创建不了 requireAdministrator 的父进程（官方 Games.exe 就是这种），
   * 所以只有明确「当前已提权」时才允许原地用官方 Games.exe；
   * 否则退回 asInvoker 候选（游戏目录 PlatformProcess.exe 复制成 Games.exe）。
   */
  const stagingOptions = { asInvokerOnly: !options.elevated };
  const exe = velaExe();
  if (!fs.existsSync(exe)) {
    return { ok: false, error: '缺少 VelaEndfield.exe（签名父进程组件），请重新安装启动器' };
  }
  const prepared = prepareStaging(gameRoot, stagingOptions);
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
async function launchEndfieldElevated(gameRoot, gameExe, args = '', options = {}) {
  cleanStaleTempDirs();
  // 提权版本体就跑在管理员上下文里，可以原地使用官方 Games.exe（最贴近官方启动行为）
  const stagingOptions = { asInvokerOnly: false };
  const exe = velaExe();
  if (!fs.existsSync(exe)) {
    return { ok: false, error: '缺少 VelaEndfield.exe（签名父进程组件），请重新安装启动器' };
  }
  const prepared = prepareStaging(gameRoot, stagingOptions);
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
          '等待管理员授权超时。终末地必须经 Windows「用户账户控制」窗口授权才能启动；如果那个窗口没弹出来，多半是安全软件拦下了 VelaEndfield.exe，请把它加入白名单后重试（这是旧的备用启动链路，正常情况下会走官方启动器托管）',
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
module.exports = { launchEndfield, launchEndfieldElevated, velaArgs, officialLauncherDirs, clearOfficialLauncherCache, peNeedsAdmin };
