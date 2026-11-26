'use strict';

/**
 * 蓝色星原：官方启动器托管启动。
 *
 * ── 为什么必须走官方启动器 ──────────────────────────────────────────
 *
 * 实测（2026-11-26）：
 *   · 直接 spawn AzurPromilia.exe（即使带 manjuu_user_info 等环境变量）
 *     → 触发 ACE「安全组件发生异常」
 *   · 读运行中的游戏进程：父进程就是 launcher.exe，且 ACE 拒绝外部 OpenProcess
 *     （OPEN_FAILED:5）
 *
 * 结论：**蓝原和终末地一样，校验的是父进程必须是官方启动器。**
 * 伪造父进程有封号风险（用户明确否决过这条路），所以只能让官方启动器自己拉游戏。
 *
 * ── 这套怎么做 ──────────────────────────────────────────────────────
 *
 * 蓝原启动器是 Electron 应用，页面里直接挂着 window.ipcRenderer（实测确认），
 * 而它主进程监听 `r2m.gameEntry` 通道：
 *
 *   this.on("r2m.gameEntry", (e, t) => { ee.gameEntry(t) })   // ee.gameEntry 就是点「开始游戏」
 *
 * 所以我们：
 *   ① 用 elevate.exe 提权启动 launcher.exe（它的 PE 清单是 highestAvailable，
 *      非管理员 spawn 会 EACCES）
 *   ② 传 --remote-debugging-port=xxxx 打开 CDP（实测 T+5s 可用）
 *   ③ CDP 连页面，调 window.ipcRenderer.send('r2m.gameEntry', ...)
 *   ④ 启动器自己走完整启动链：校验 → 请求 launchEntry/launchParams → spawn 游戏
 *   ⑤ 我们检测到 AzurPromilia.exe 起来 → 关掉启动器
 *
 * **游戏进程的父进程始终是 launcher.exe，ACE 检测不到任何异常。**
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { powershellExe } = require('./ps-path');

const LAUNCHER_EXE = 'launcher.exe';
const GAME_PROCESS = 'AzurPromilia.exe';
const LAUNCHER_PROCESS = 'launcher';

/** 默认启动器安装位置（注册表 InstallLocation 的常见值）。 */
const LAUNCHER_ROOTS = [
  'H:\\AzurPromilia',
  'H:\\AzurPromilia bilibili',
  'C:\\Program Files\\AzurPromilia',
  'C:\\Program Files (x86)\\AzurPromilia',
  'D:\\AzurPromilia',
  'E:\\AzurPromilia',
];

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 找 launcher.exe：在候选根目录下按 <版本号>\launcher.exe 的布局搜。 */
function findLauncher(customPath) {
  const manual = String(customPath || '').trim();
  if (manual) {
    try {
      if (fs.statSync(manual).isFile() && /launcher\.exe$/i.test(manual)) {
        return { ok: true, exe: manual, manual: true, root: path.dirname(manual) };
      }
    } catch {
      /* 手填无效，继续自动找 */
    }
  }

  for (const root of LAUNCHER_ROOTS) {
    if (!fs.existsSync(root)) continue;
    /* 直接在这个目录 */
    const direct = path.join(root, LAUNCHER_EXE);
    if (fs.existsSync(direct)) return { ok: true, exe: direct, root };

    /* <root>\<版本>\launcher.exe —— 官方布局，版本号会变 */
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cand = path.join(root, e.name, LAUNCHER_EXE);
      if (fs.existsSync(cand)) return { ok: true, exe: cand, root: path.join(root, e.name) };
    }
  }
  return { ok: false, error: '没找到蓝色星原官方启动器（launcher.exe）。请在设置里指定它的位置。' };
}

/** 取某进程名的所有 PID。 */
function pidsOf(name) {
  try {
    const out = execFileSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-Process -Name '${name.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','`],
      { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
    return out ? out.split(',').map((x) => parseInt(x, 10)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 挑一个空闲端口给 CDP。 */
async function pickPort(start = 9560) {
  for (let p = start; p < start + 40; p++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(300) });
      /* 能连上说明被占用 */
      if (res) continue;
    } catch {
      return p;
    }
  }
  return start;
}

/** 等 CDP 出现。 */
async function waitCdp(port, maxMs = 60000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
      const list = await res.json();
      if (Array.isArray(list) && list.length) {
        return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
      }
    } catch {
      /* 还没起来 */
    }
    await delay(700);
  }
  return null;
}

/** 极简 CDP 客户端。 */
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 10000);
  });

  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const call = (method, params = {}, timeout = 12000) => new Promise((res) => {
    const i = ++id;
    pend.set(i, res);
    try { ws.send(JSON.stringify({ id: i, method, params })); } catch { res({ error: 'send-failed' }); }
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({ error: 'timeout' }); } }, timeout);
  });

  await call('Runtime.enable');
  const evaluate = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.error) return { __err: r.error };
    if (r.result && r.result.exceptionDetails) {
      return { __err: String(r.result.exceptionDetails.text || 'eval-error').slice(0, 200) };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { evaluate, close: () => { try { ws.close(); } catch {} } };
}

/**
 * 按渠道挑 launcher.exe。
 *
 * 蓝原的每个渠道各有自己的启动器安装（目录里 res/app_config.dat 的 channelCode 不同）。
 * 官服 C000、B服 C001 是两个独立安装，都在 LAUNCHER_ROOTS 下。
 * 如果不按渠道挑，就会「切了 B服 却启动官服启动器」—— 表现为 B服 进去是官服。
 *
 * @param {string} channelCode 目标渠道号（C000 / C001），空则退回第一个能找到的
 * @returns {{ok:boolean, exe?:string, dir?:string, channelCode?:string, error?:string}}
 */
function findLauncherForChannel(channelCode, customPath) {
  /* 手填的优先（用户明确指定） */
  const manual = String(customPath || '').trim();
  if (manual) {
    try {
      if (fs.statSync(manual).isFile() && /launcher\.exe$/i.test(manual)) {
        return { ok: true, exe: manual, dir: path.dirname(manual), channelCode: '', manual: true };
      }
    } catch {
      /* 手填无效，继续自动找 */
    }
  }

  /* 收集所有候选启动器目录 */
  const candidates = [];
  for (const root of LAUNCHER_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const direct = path.join(root, LAUNCHER_EXE);
    if (fs.existsSync(direct)) candidates.push({ dir: root, exe: direct });
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const exe = path.join(dir, LAUNCHER_EXE);
      if (fs.existsSync(exe)) candidates.push({ dir, exe });
    }
  }
  if (!candidates.length) {
    return { ok: false, error: '没找到蓝色星原官方启动器（launcher.exe）。请在设置里指定它的位置。' };
  }

  /* 按渠道号匹配：读每个候选的 res/app_config.dat */
  if (channelCode) {
    let cutils = null;
    try {
      /* 用任意一个候选的原生模块都能解（全渠道通用） */
      const mod = require('./azur-channel');
      cutils = mod.loadCutils(candidates[0].dir);
    } catch {
      cutils = null;
    }
    if (cutils) {
      for (const item of candidates) {
        const file = path.join(item.dir, 'res', 'app_config.dat');
        try {
          if (!fs.existsSync(file)) continue;
          const parsed = JSON.parse(cutils.extApi1(file));
          if (String(parsed.channelCode || '') === channelCode) {
            return { ok: true, exe: item.exe, dir: item.dir, channelCode };
          }
        } catch {
          /* 解不开就跳过 */
        }
      }
      /* 没找到同渠道的：说明这个渠道的启动器没装 */
      return {
        ok: false,
        error:
          `没有找到 ${channelCode} 渠道的官方启动器。` +
          '请先安装一次该渠道的官方启动器（启动器里那份渠道配置必须由官方安装写入）。',
      };
    }
  }

  /* 没有渠道要求 / 拿不到解密模块：退回第一个 */
  return { ok: true, exe: candidates[0].exe, dir: candidates[0].dir, channelCode: '' };
}

/**
 * 主入口：用官方启动器拉起蓝色星原。
 *
 * @param {object} options
 * @param {string} [options.customLauncher] 手填的 launcher.exe 路径
 * @param {string} [options.channelCode] 目标渠道号（C000/C001），用于挑对启动器
 * @param {boolean} [options.elevated] 当前进程是否已是管理员
 * @param {(msg:string)=>void} [options.onProgress]
 * @param {(msg:string)=>void} [options.onLog]
 * @returns {Promise<{ok:boolean, pid?:number, via?:string, error?:string, reason?:string}>}
 */
async function launchViaAzurLauncher(options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};

  /* 按目标渠道挑启动器：官服/B服 是两个独立安装，挑错就会「切了 B服 却起官服」 */
  const found = findLauncherForChannel(options.channelCode, options.customLauncher);
  if (!found.ok) return { ok: false, error: found.error };

  /* 已经有一套在跑就别重复拉 */
  if (pidsOf(GAME_PROCESS).length) {
    return { ok: false, error: '蓝色星原已经在运行了。' };
  }

  /*
   * 启动器有单实例锁：已有实例在跑时，新实例会把 argv 转给旧实例然后自己退出，
   * 那样我们拿不到 CDP（端口是旧实例的）。所以先清掉旧实例。
   * 只清 launcher，不碰游戏进程。
   */
  const existing = pidsOf(LAUNCHER_PROCESS);
  if (existing.length) {
    onLog(`[azur] 清理已有启动器实例: ${existing.join(',')}`);
    try {
      execFileSync(powershellExe(), ['-NoProfile', '-Command',
        "Get-Process -Name 'launcher' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }"],
        { stdio: 'ignore', timeout: 12000 });
    } catch {
      /* 清不掉就继续，后面 CDP 会失败再报 */
    }
    await delay(2000);
  }

  const port = await pickPort();
  onProgress('正在启动蓝色星原官方启动器…');
  onLog(`[azur] 启动 ${found.exe} --remote-debugging-port=${port}`);

  /* 提权启动（launcher.exe 是 highestAvailable，非管理员直接 EACCES） */
  /*
   * 提权启动。launcher.exe 的 PE 清单是 highestAvailable，非管理员 spawn 直接 EACCES。
   *
   * elevate.exe 的几个候选位置（顺序很重要）：
   *   ① 打包后：process.resourcesPath/elevate.exe
   *   ② 源码运行时：electron/../resources/elevate.exe
   *   ③ 运行副本：H:\花筱灵启动器\resources\elevate.exe
   * 一个都找不到时**不要**退回裸 spawn —— 那必然 EACCES，
   * 不如直接告诉用户「需要管理员权限」，让他手动开启动器。
   */
  const elevateCandidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'elevate.exe') : '',
    path.join(__dirname, '..', 'resources', 'elevate.exe'),
    'H:\\花筱灵启动器\\resources\\elevate.exe',
  ].filter(Boolean);
  const elevateExe = elevateCandidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || '';

  if (!elevateExe) {
    return {
      ok: false,
      reason: 'need-elevation',
      error:
        '找不到提权工具 elevate.exe，无法自动启动蓝色星原官方启动器（它要求管理员权限）。' +
        '请手动打开官方启动器，在里面点「开始游戏」。',
    };
  }

  try {
    const args = [found.exe, `--remote-debugging-port=${port}`];
    const child = spawn(elevateExe, args, { detached: true, stdio: 'ignore', windowsHide: false, cwd: found.root });
    child.unref();
  } catch (error) {
    return { ok: false, error: `启动官方启动器失败：${error.message}` };
  }

  /* 等 CDP */
  onProgress('正在连接官方启动器…');
  const target = await waitCdp(port, 60000);
  if (!target) {
    return {
      ok: false,
      reason: 'need-elevation',
      error:
        '官方启动器起来了，但没能连上它的调试接口（可能 UAC 被拒绝，或安全软件拦了）。' +
        '请在弹 UAC 时点「是」；如果反复失败，请手动打开蓝色星原官方启动器，在里面点「开始游戏」。',
    };
  }
  onLog(`[azur] CDP 已连接 ${target.url.slice(0, 80)}`);

  let cdp;
  try {
    cdp = await connectCdp(target.webSocketDebuggerUrl);
  } catch (error) {
    return { ok: false, error: `连接启动器页面失败：${error.message}` };
  }

  try {
    /* 等页面就绪（ipcRenderer 挂上、按钮状态出来了） */
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await cdp.evaluate(`(() => {
        const hasIpc = !!(window.ipcRenderer && typeof window.ipcRenderer.send === 'function');
        const text = document.body ? document.body.innerText.replace(/\\s+/g,' ').slice(0, 120) : '';
        return { hasIpc, text };
      })()`);
      if (r && r.hasIpc) {
        ready = true;
        onLog(`[azur] 页面就绪：${String(r.text).slice(0, 80)}`);
        break;
      }
      await delay(500);
    }

    if (!ready) {
      return {
        ok: false,
        reason: 'manual-required',
        error: '官方启动器页面没准备好（找不到 ipcRenderer）。请手动在启动器里点「开始游戏」。',
      };
    }

    /*
     * 当前是否已在运行 / 在更新 —— 先读按钮文案，避免误触发。
     * 蓝原的按钮状态由主进程推给页面（m2r.syncGame），页面文字里能看到「运行中」之类。
     */
    const stateText = await cdp.evaluate(`(document.body ? document.body.innerText.replace(/\\s+/g,' ') : '')`);
    const st = String(stateText || '');

    if (/安装|下载中|更新中|校验中/.test(st)) {
      return {
        ok: false,
        reason: 'not-startable',
        error: `官方启动器当前显示「${st.slice(0, 40)}」，现在不能开始游戏。请在启动器里等它完成。`,
      };
    }

    /* 触发「开始游戏」：和用户点按钮走同一个 IPC 通道 */
    onProgress('正在让官方启动器拉起游戏…');
    const sent = await cdp.evaluate(`(() => {
      try {
        window.ipcRenderer.send('r2m.gameEntry', {});
        return 'sent';
      } catch (e) { return 'err:' + e.message; }
    })()`);
    onLog(`[azur] r2m.gameEntry → ${sent}`);

    if (sent !== 'sent') {
      return { ok: false, reason: 'manual-required', error: `无法触发启动：${sent}` };
    }
  } finally {
    /* 页面操作完就可以断开，不影响启动器继续跑 */
    try { cdp.close(); } catch {}
  }

  /* 等游戏进程出现（官方启动器自己走校验+下载+spawn，可能较慢） */
  onProgress('正在等游戏进程…');
  let gamePid = 0;
  for (let i = 0; i < 240; i++) {
    await delay(1000);
    const list = pidsOf(GAME_PROCESS);
    if (list.length) { gamePid = list[0]; break; }
  }

  if (!gamePid) {
    return {
      ok: false,
      reason: 'manual-required',
      error: '已打开官方启动器，但游戏进程没出现。请在启动器里点一次「开始游戏」。',
    };
  }

  onLog(`[azur] 游戏进程出现 pid=${gamePid}`);

  /*
   * 游戏起来后关掉启动器：游戏已经独立运行（父进程关系建立完成），
   * 启动器留在后台只是占内存 + 托盘图标。
   * 留 3 秒缓冲让游戏完成初始化。
   */
  await delay(3000);
  try {
    execFileSync(powershellExe(), ['-NoProfile', '-Command',
      "Get-Process -Name 'launcher' -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }"],
      { stdio: 'ignore', timeout: 12000 });
    onLog('[azur] 官方启动器已关闭');
  } catch {
    onLog('[azur] 官方启动器关闭失败（不影响游戏）');
  }

  return { ok: true, pid: gamePid, via: 'azur-launcher', port };
}

/** 检查当前按钮状态（给界面上显示用，不触发启动）。 */
async function probeAzurState(options = {}) {
  /* 按目标渠道挑启动器：官服/B服 是两个独立安装，挑错就会「切了 B服 却起官服」 */
  const found = findLauncherForChannel(options.channelCode, options.customLauncher);
  if (!found.ok) return { ok: false, error: found.error };
  return { ok: true, launcher: found.exe, root: found.root };
}

module.exports = {
  findLauncher,
  findLauncherForChannel,
  launchViaAzurLauncher,
  probeAzurState,
  LAUNCHER_ROOTS,
};
