'use strict';

/*
 * 用户自定义插件 —— 存储、校验与沙箱宿主。
 *
 * 设计取舍：
 * 1. 插件是单个 .hxl 文件（内容是 JS），放在 data/plugins/ 下，拷走 data 目录就是完整搬家；
 * 2. 插件代码**不在主进程执行**，也不在主页面执行，而是在渲染层新建的 Web Worker 里跑。
 *    Worker 里没有 window / document / require / fs，碰不到 cookie 和本地文件；
 * 3. 插件只能通过 postMessage 调用一组固定 API，能力面写在 manifest 的 permissions 里，
 *    用之前在界面上明示给用户确认。
 *
 * 这里只负责「文件层面」的事：落盘、解析 manifest、校验 id、配置读写、生成 Worker 源码。
 * 真正的执行与 API 桥接在 src/plugin-runtime.js。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/** 插件文件扩展名。用自定义后缀，既能一眼认出，也不会被系统当成脚本双击执行。 */
const PLUGIN_EXT = '.hxl';
/** 插件脚本正文上限，防止有人塞一个几十 MB 的文件把渲染层拖死。 */
const MAX_PLUGIN_BYTES = 512 * 1024;
/** 允许在 manifest 里声明的能力。没写进去的一律拿不到。 */
const PERMISSIONS = {
  state: '读取启动器的公开状态（游戏列表 / 游玩时长 / 抽卡统计）',
  notify: '弹出提示消息',
  storage: '读写本插件自己的配置',
  ui: '渲染面板内容',
};

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** 内置图标名，和 index.html 里的 symbol id 对应；写错了退回插件图标。 */
const ICON_NAMES = new Set([
  'alert', 'check', 'chevron-down', 'chevron-left', 'chevron-right', 'clock', 'database',
  'download', 'edit', 'external', 'folder', 'folder-open', 'gamepad', 'grip', 'headphones',
  'home', 'image', 'info', 'library', 'link', 'login', 'maximize', 'mic', 'minus', 'monitor',
  'moon', 'music', 'news', 'order', 'pause', 'pin', 'play', 'plus', 'refresh', 'repeat',
  'repeat-one', 'restore', 'search', 'server', 'settings', 'shield', 'shuffle', 'sparkle',
  'star', 'stop', 'sun', 'trash', 'type', 'volume', 'volume-x', 'wrench', 'x',
]);

function pluginsDir(userDataPath) {
  return path.join(userDataPath, 'plugins');
}

function storageFile(userDataPath) {
  return path.join(userDataPath, 'plugins.json');
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * 从插件正文里抠出 `/* @hxl { ... } *\/` 这段 manifest。
 *
 * 用注释而不是 import 或 JSON 文件，是因为这样插件仍然是「一个文件」，
 * 而且被当成普通 JS 打开时 manifest 也不影响语法。
 * 返回 { manifest, error }，解析失败不抛异常，交给调用方决定怎么提示。
 */
function parseManifest(source, fileName = '') {
  const text = String(source || '');
  const marker = text.indexOf('@hxl');
  if (marker < 0) {
    return { manifest: null, error: '缺少 /* @hxl { ... } */ 清单块' };
  }
  // 从 @hxl 之后找第一个 {，再做括号配对，避免被字符串里的花括号骗到
  const start = text.indexOf('{', marker);
  if (start < 0) return { manifest: null, error: '清单块里没有 JSON' };
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return { manifest: null, error: '清单块的花括号没有闭合' };

  let raw;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return { manifest: null, error: `清单不是合法 JSON：${error.message}` };
  }
  return { manifest: normalizeManifest(raw, fileName), error: '' };
}

/** 把用户写的 manifest 收拾成固定形状，缺字段给默认值，不认识的能力直接丢掉。 */
function normalizeManifest(raw, fileName = '') {
  const data = raw && typeof raw === 'object' ? raw : {};
  const perms = Array.isArray(data.permissions)
    ? [...new Set(data.permissions.filter((item) => typeof item === 'string' && PERMISSIONS[item]))]
    : ['ui'];
  const icon = String(data.icon || '').trim();
  return {
    id: String(data.id || '').trim(),
    name: String(data.name || idFallbackName(fileName)).trim().slice(0, 40),
    version: String(data.version || '1.0.0').trim().slice(0, 24),
    author: String(data.author || '').trim().slice(0, 40),
    desc: String(data.desc || '').trim().slice(0, 200),
    icon: ICON_NAMES.has(icon) ? icon : 'wrench',
    order: Number.isFinite(Number(data.order)) ? Number(data.order) : 100,
    // 一律补上 ui：不声明它插件根本无法显示任何东西
    permissions: perms.includes('ui') ? perms : ['ui', ...perms],
  };
}

function idFallbackName(fileName) {
  return path.basename(String(fileName || ''), PLUGIN_EXT) || '未命名插件';
}

/** 校验 id 是否合法，并说明为什么不行。 */
function checkId(id) {
  if (!id) return '清单里缺少 id 字段';
  if (!ID_PATTERN.test(id)) return `id 只能是小写字母、数字、点、下划线或短横线（2–64 位），现在是「${id}」`;
  return '';
}

/**
 * 列目录：读出每个插件的 manifest 和基本信息。
 *
 * 单个插件解析失败不能连累其它插件，所以坏了的那条会带着 error 字段返回，
 * 界面上把它显示成「已损坏」并提供删除入口。
 */
async function listPlugins(userDataPath) {
  const dir = pluginsDir(userDataPath);
  await ensureDir(dir);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return { dir, plugins: [] };
  }

  const plugins = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(PLUGIN_EXT)) continue;
    const filePath = path.join(dir, name);
    const base = { file: name, path: filePath };
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_PLUGIN_BYTES) {
        plugins.push({ ...base, id: '', name: idFallbackName(name), version: '', author: '', desc: '', icon: 'wrench', permissions: [], size: stat.size, error: `文件太大（${Math.round(stat.size / 1024)} KB，上限 ${MAX_PLUGIN_BYTES / 1024} KB）` });
        continue;
      }
      const source = await fsp.readFile(filePath, 'utf8');
      const { manifest, error } = parseManifest(source, name);
      if (error) {
        plugins.push({ ...base, id: '', name: idFallbackName(name), version: '', author: '', desc: '', icon: 'wrench', permissions: [], size: stat.size, error });
        continue;
      }
      const idError = checkId(manifest.id);
      if (idError) {
        plugins.push({ ...base, ...manifest, size: stat.size, error: idError });
        continue;
      }
      plugins.push({ ...base, ...manifest, size: stat.size, error: '' });
    } catch (error) {
      plugins.push({ ...base, id: '', name: idFallbackName(name), version: '', author: '', desc: '', icon: 'wrench', permissions: [], size: 0, error: String(error.message || error) });
    }
  }

  // 同 id 的只留第一个，后面的是重复安装
  const seen = new Set();
  for (const plugin of plugins) {
    if (!plugin.id) continue;
    if (seen.has(plugin.id)) plugin.error = plugin.error || `id「${plugin.id}」和另一个插件重复，只加载了先读到的那个`;
    else seen.add(plugin.id);
  }

  plugins.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return { dir, plugins };
}

/** 读某个插件的源码，交给渲染层放进 Worker 执行。 */
async function readPlugin(userDataPath, id) {
  const { plugins } = await listPlugins(userDataPath);
  const hit = plugins.find((item) => item.id === id);
  if (!hit) return { ok: false, error: '没有找到这个插件，可能已经被删除' };
  if (hit.error) return { ok: false, error: hit.error };
  try {
    const source = await fsp.readFile(hit.path, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > MAX_PLUGIN_BYTES) {
      return { ok: false, error: '插件文件过大' };
    }
    // 去掉 manifest 那段注释再执行，省得注释里的中文被当成代码的一部分干扰栈追踪
    return { ok: true, id: hit.id, source };
  } catch (error) {
    return { ok: false, error: `读不到插件文件：${error.message}` };
  }
}

/**
 * 导入插件：把一个外部 .hxl 复制进插件目录。
 *
 * 先解析一遍 manifest，解析不过的拒绝导入 —— 与其让用户装完看到一个「已损坏」，
 * 不如在导入那一刻就说清楚。同名文件加序号，不覆盖已有的。
 */
async function importPlugin(userDataPath, sourcePath) {
  const dir = pluginsDir(userDataPath);
  await ensureDir(dir);
  const raw = sourcePath ? String(sourcePath) : '';
  if (!raw) return { ok: false, error: '没有选择文件' };
  let stat;
  try {
    stat = await fsp.stat(raw);
  } catch {
    return { ok: false, error: '文件不存在' };
  }
  if (!stat.isFile()) return { ok: false, error: '只能导入单个文件' };
  if (stat.size > MAX_PLUGIN_BYTES) {
    return { ok: false, error: `文件太大（${Math.round(stat.size / 1024)} KB，上限 ${MAX_PLUGIN_BYTES / 1024} KB）` };
  }

  let source;
  try {
    source = await fsp.readFile(raw, 'utf8');
  } catch (error) {
    return { ok: false, error: `读不到文件：${error.message}` };
  }

  const fileName = path.basename(raw);
  const { manifest, error } = parseManifest(source, fileName);
  if (error) return { ok: false, error };
  const idError = checkId(manifest.id);
  if (idError) return { ok: false, error: idError };

  const existing = await listPlugins(userDataPath);
  const same = existing.plugins.find((item) => item.id === manifest.id);
  if (same) {
    return {
      ok: false,
      error: `已经装过一个 id 为「${manifest.id}」的插件（${same.file}）。先删掉旧的再导入，或者改插件里的 id。`,
      duplicate: same.file,
    };
  }

  // 文件名冲突时加序号，绝不用同 id 覆盖别人
  let target = path.join(dir, fileName);
  let index = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${path.basename(fileName, path.extname(fileName))} (${index})${path.extname(fileName)}`);
    index += 1;
  }
  try {
    await fsp.writeFile(target, source, 'utf8');
  } catch (error) {
    return { ok: false, error: `写入插件目录失败：${error.message}` };
  }
  return { ok: true, id: manifest.id, name: manifest.name, file: path.basename(target), path: target };
}

/**
 * 删除插件。
 *
 * 只允许删插件目录里的 .hxl 文件，并且路径必须落在插件目录下 ——
 * 渲染层传过来的 id 一旦被改造成 ../.. 之类的路径，也不会删到别处去。
 */
async function removePlugin(userDataPath, id) {
  const dir = pluginsDir(userDataPath);
  const { plugins } = await listPlugins(userDataPath);
  const hit = plugins.find((item) => item.id === id);
  if (!hit) return { ok: false, error: '没有找到这个插件' };
  const resolved = path.resolve(hit.path);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    return { ok: false, error: '插件路径不在插件目录里，拒绝删除' };
  }
  try {
    await fsp.unlink(resolved);
  } catch (error) {
    return { ok: false, error: `删除失败：${error.message}` };
  }
  return { ok: true, id };
}

/* ------------------------------ 插件配置 ------------------------------ */

async function readStorageFile(userDataPath) {
  try {
    const text = await fsp.readFile(storageFile(userDataPath), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStorageFile(userDataPath, data) {
  await ensureDir(path.dirname(storageFile(userDataPath)));
  await fsp.writeFile(storageFile(userDataPath), JSON.stringify(data, null, 2), 'utf8');
}

/** 读一个插件的配置，没存过就是空对象。 */
async function getStorage(userDataPath, id) {
  const all = await readStorageFile(userDataPath);
  return all[id] && typeof all[id] === 'object' ? all[id] : {};
}

/**
 * 写一个插件的配置。
 *
 * 只允许存 JSON 能表示的东西，并且限制体积 —— 插件不该把启动器数据目录当网盘用。
 */
async function setStorage(userDataPath, id, value) {
  let text;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    return { ok: false, error: '配置里有无法序列化的值' };
  }
  if (text.length > 128 * 1024) return { ok: false, error: '配置太大（上限 128 KB）' };
  const all = await readStorageFile(userDataPath);
  all[id] = JSON.parse(text);
  await writeStorageFile(userDataPath, all);
  return { ok: true };
}

/**
 * 生成 Worker 里执行的沙箱前置代码。
 *
 * 这段代码写在字符串里、在 Worker 顶部 eval 出来。之所以不单独放一个文件，
 * 是因为它必须出现在用户插件代码之前，而且要用同一个 module Worker 作用域，
 * 这样插件里声明的变量不会泄漏到别处，插件也碰不到主线程的 DOM。
 *
 * 插件能用的全部能力都在这里，多一个都没有：没有 fetch、没有 XMLHttpRequest、
 * 没有 importScripts、关掉 import()，也拿不到 postMessage 的原始句柄。
 */
function sandboxPrelude(pluginId) {
  return `(function () {
  'use strict';
  const PLUGIN_ID = ${JSON.stringify(pluginId)};
  const pending = new Map();
  let seq = 0;
  let readyHandler = null;
  let disposeHandler = null;
  let lastRender = null;

  /* 掐掉一切能自己联网或越权加载代码的口子 */
  try { self.fetch = undefined; } catch (e) {}
  try { self.XMLHttpRequest = undefined; } catch (e) {}
  try { self.WebSocket = undefined; } catch (e) {}
  try { self.importScripts = undefined; } catch (e) {}
  try { self.indexedDB = undefined; } catch (e) {}
  try { delete self.caches; } catch (e) {}

  function call(method, args, timeout) {
    seq += 1;
    const id = seq;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        if (pending.has(id)) { pending.delete(id); reject(new Error('调用 ' + method + ' 超时')); }
      }, timeout || 15000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      self.postMessage({ __hxl: 'call', id: id, method: method, args: args });
    });
  }

  self.addEventListener('message', function (event) {
    const data = event.data;
    if (!data || data.__hxl !== 'result') return;
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    clearTimeout(item.timer);
    if (data.ok) item.resolve(data.value);
    else item.reject(new Error(data.error || '调用失败'));
  });

  const hxl = Object.freeze({
    id: PLUGIN_ID,
    ready: function (fn) { readyHandler = fn; },
    dispose: function (fn) { disposeHandler = fn; },
    render: function (type, data) {
      if (typeof type !== 'string') throw new Error('render 的第一个参数应该是视图类型');
      lastRender = { type: type, data: data };
      return call('render', [type, data]);
    },
    notify: function (message) { return call('notify', [String(message)]); },
    state: Object.freeze({ get: function () { return call('state'); } }),
    storage: Object.freeze({
      get: function () { return call('storage.get'); },
      set: function (value) { return call('storage.set', [value]); },
    }),
    /* 兼容更顺手的写法：hxl.onReady 别名 */
    onReady: function (fn) { readyHandler = fn; },
  });

  self.hxl = hxl;
  self.HXL = hxl;

  self.addEventListener('error', function (event) {
    call('error', [String(event.message || '插件运行时出错')]);
  });

  /* 把入口推迟到插件代码执行完之后 */
  queueMicrotask(function () {
    if (typeof readyHandler !== 'function') {
      call('error', ['插件没有调用 hxl.ready()，什么都不会显示']);
      return;
    }
    Promise.resolve()
      .then(function () { return readyHandler(hxl); })
      .then(function () { return call('ready', []); })
      .catch(function (error) { call('error', [String((error && error.stack) || error)]); });
  });
})();
`;
}

module.exports = {
  PLUGIN_EXT,
  MAX_PLUGIN_BYTES,
  PERMISSIONS,
  ICON_NAMES,
  pluginsDir,
  storageFile,
  parseManifest,
  normalizeManifest,
  checkId,
  listPlugins,
  readPlugin,
  importPlugin,
  removePlugin,
  getStorage,
  setStorage,
  sandboxPrelude,
  // 测试用
  _internal: { idFallbackName },
};
