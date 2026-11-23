'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { powershellExe } = require('./ps-path');

const endfieldLaunch = require('./endfield-launch');

/*
 * 终末地「官方托管启动」——用官方启动器自己去拉游戏。
 *
 * ── 这条链路不伪装任何东西 ───────────────────────────────────────
 * 终末地的客户端（U8SDK.dll）会取自己的**直接父进程**的小写全路径，再拿它去比对
 * 官方启动器的路径；对不上就弹「游戏启动失败 / 请通过官方启动器打开游戏」。
 * 之前我们的做法是复制官方签名 exe 当父进程（VelaEndfield.exe +
 * PROC_THREAD_ATTRIBUTE_PARENT_PROCESS）—— 那是让游戏「以为」自己是官方拉起来的，
 * 属于伪装进程身份。
 *
 * 现在的做法反过来：**真的去跑官方启动器**，由它亲自 CreateProcess 拉起游戏。
 * 父进程是真的 Games.exe，游戏侧的任何校验都天然通过，我们唯一做的事相当于
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
    dirs = endfieldLaunch.officialLauncherDirs();
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
 */
async function readButtonState(page, uuid) {
  const hooked = await page.evaluate(`(function(){
    window.__hxlNative = [];
    if (!window.jsbridge || !window.jsbridge.SendMsgToWeb) return 'no-signal';
    try {
      window.jsbridge.SendMsgToWeb.connect(function(type, payload){
        window.__hxlNative.push({ type: String(type), payload: String(payload).slice(0, 4000) });
      });
      return 'ok';
    } catch (e) { return 'err:' + e.message; }
  })()`);
  if (hooked !== 'ok' && hooked !== 'no-signal') {
    return { ok: false, error: `无法监听官方启动器消息：${hooked}` };
  }

  const sent = await page.evaluate(`(function(){
    try {
      window.jsbridge.SendMsgToNative('main_btn_state_req', JSON.stringify({ uuid: ${JSON.stringify(uuid)} }));
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

/** 让官方启动器真正启动游戏：调它自己那颗按钮的 onClick。 */
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
 * 提权起官方启动器并打开 DevTools 端口。
 *
 * Games.exe 是 requireAdministrator；两种情形分开处理：
 *   · 当前启动器已经是管理员 → 直接 spawn，环境变量天然继承；
 *   · 不是管理员 → 用 PowerShell Start-Process -Verb RunAs 走一次 UAC。
 *     环境变量得靠一个临时 .cmd 兜一下（runas 起的进程不保证继承我们的 env）。
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

  // 非提权：写一个临时 .cmd，里面设好 env 再 start。
  // runas 起的进程不保证继承调用方的环境变量，写进脚本里最稳。
  const script = path.join(os.tmpdir(), `Vela-Endfield-Official-${Date.now()}.cmd`);
  const body = [
    '@echo off',
    `set "QTWEBENGINE_REMOTE_DEBUGGING=${portText}"`,
    'set "QTWEBENGINE_CHROMIUM_FLAGS=--remote-allow-origins=*"',
    `start "" "${exe}" "--game=${uuid}"`,
    'exit /b 0',
    '',
  ].join('\r\n');
  try {
    fs.writeFileSync(script, body, 'ascii');
  } catch (error) {
    return { ok: false, error: `写启动脚本失败：${error.message}` };
  }

  const powershell = powershellExe();
  try {
    const child = spawn(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `Start-Process -FilePath '${script}' -Verb RunAs -WindowStyle Hidden`,
      ],
      { detached: true, windowsHide: true, stdio: 'ignore' }
    );
    child.unref();
    // 脚本本身过 30 秒才清，避免 start 还没拉起来就被删
    setTimeout(() => {
      try {
        fs.rmSync(script, { force: true });
      } catch {
        /* ignore */
      }
    }, 30000);
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
async function launchViaOfficial(options = {}) {
  const gameRoot = String(options.gameRoot || '').trim();
  const runRoot = String(options.runRoot || gameRoot).trim() || gameRoot;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  if (!gameRoot) return { ok: false, error: '没有拿到终末地的安装目录。' };

  // 把手填路径透传，否则 tryOfficialLaunch 认了、这里又搜一次会白忙（2026-11-23）
  const games = findOfficialGames(options.customExe);
  if (!games.ok) return { ok: false, error: games.error };

  const uuid = String(options.uuid || '').trim() || readGameUuid() || UUID_FALLBACK;

  const sameRoot =
    path.resolve(runRoot).toLowerCase() === path.resolve(gameRoot).toLowerCase();

  // 已经有一套进程在跑就别再起第二套
  if (isPidAlive(findProcessByName(GAME_PROCESS_NAME))) {
    return { ok: false, error: '终末地已经在运行了。' };
  }

  let swapped = null;
  let launcherPid = 0;
  const cleanup = async (restore) => {
    if (launcherPid) {
      // 官方启动器是我们起的，游戏结束后不该留在托盘里
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
      return {
        ok: false,
        error:
          '官方启动器起来了但没开出调试口（QTWEBENGINE_REMOTE_DEBUGGING 没生效）。' +
          '多半是安全软件拦了环境变量注入，把它加入白名单后重试。',
      };
    }

    // ── 闸门 1 / 2：先问状态，再决定点不点
    onProgress('正在向官方启动器确认状态…');
    const stateResult = await withCdpPage(target.webSocketDebuggerUrl, async (page) => {
      const state = await readButtonState(page, uuid);
      if (!state.ok) return { ok: false, error: state.error };

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

    if (!stateResult.ok) return stateResult;
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

    // ── 游戏起来了：立刻把 junction 换回来（游戏已经加载完 exe，后续操作不依赖路径）
    //    这里必须等游戏真正把 exe 映进内存，否则换回来会让它读不到自己的资源。
    if (swapped) {
      await delay(3000);
      const restored = restoreBase(gameRoot);
      if (restored.ok) {
        swapped = null;
        onProgress('安装目录已复原。');
      } else {
        options.onLog?.(`[endfield] 游戏起来后复位失败：${restored.error}`);
      }
    }

    // ── 后台守着：游戏退出后清掉官方启动器
    const guard = setInterval(() => {
      if (isPidAlive(gamePid)) return;
      clearInterval(guard);
      void cleanup(true);
    }, 5000);
    if (typeof guard.unref === 'function') guard.unref();

    return { ok: true, pid: gamePid, uuid, state: stateResult.state };
  } catch (error) {
    return { ok: false, error: `官方托管启动失败：${error.message}` };
  } finally {
    // 走到这里还没换成游戏（中途失败），必须把 junction 复原
    if (swapped) {
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
  _internal: { pickPort, fetchTargets, makeJunction, removeJunction, needsUpdateMessage },
};
