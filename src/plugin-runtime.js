'use strict';

/**
 * 用户自定义插件 —— 渲染层运行时。
 *
 * 这个文件干两件事：
 *
 * 1. `Render`：把插件声明的视图（text / list / table / progress）变成 HTML 字符串。
 *    它是**纯函数**，不碰 DOM、不碰 electron，所以可以直接在 node 里 require 跑单测。
 *    插件是用户写的东西，它给的每一个字符串都是不可信输入 —— 所有内容必须过
 *    escapeHtml，输出里绝不能出现 NaN / undefined / [object Object]。
 *
 * 2. `Host`：插件的实际执行环境。每个插件在自己的 Web Worker 里跑，
 *    Worker 里没有 window / document / require / fs / fetch，只能通过 postMessage
 *    调用这里放行的几个方法（权限按 manifest 的 permissions 仲裁）。
 *    Worker 崩了、语法错了、死循环超时了，都只会记到错误表里，
 *    绝不能让整个启动器页面跟着白屏。
 *
 * 为什么 Worker 源码是「prelude + 插件正文」拼出来的 Blob：
 * plugin-host.js 在主进程里，它管文件不管执行；渲染层拿不到 fs，只能拿字符串。
 * prelude 必须和主进程那份**逐字一致**，否则插件看到的 API 和主进程以为的不一样。
 *
 * 浏览器里暴露 `window.HXLPlugin = { Render, renderView, Host }`；
 * node 里只导出 { Render, renderView }（Host 依赖 Worker / Blob，node 下没有）。
 */

(function (global) {
  /* ================================================================ */
  /* 一、HTML 转义与取值工具                                            */
  /* ================================================================ */

  /**
   * 把任意值转成可以安全放进 HTML 的字符串。
   *
   * 五个字符都要转：& < > " '。少转 & 会让 `&lt;` 这类字面量被浏览器
   * 二次解码成真正的标签（经典的 mXSS 手法），少转引号则能在属性值里逃逸。
   */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    let text;
    try {
      text = String(value);
    } catch {
      // Symbol 以外的奇怪对象（比如 toString 抛错的）降级成空串
      return '';
    }
    return text.replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  /** 字符串安全化：任何对象 / 函数 / 空值都降级成空串，绝不吐出 [object Object]。 */
  function str(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    // 对象 / 数组 / 函数 / Symbol 一律不显示，否则就是 [object Object] 或者源码
    return '';
  }

  /** 数字兜底：非有限数一律给 fallback，从源头挡掉 NaN / Infinity。 */
  function num(value, fallback = 0) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /** 数组兜底：不是数组就当空数组。 */
  function arr(value) {
    return Array.isArray(value) ? value : [];
  }

  /** 普通对象兜底：数组和 null 都不算。 */
  function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  /** 只认这三种语义色，别的（包括插件乱写的字符串）一律当无色。 */
  const TONES = ['ok', 'warn', 'bad'];
  function tone(value) {
    const t = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return TONES.includes(t) ? t : '';
  }

  /* ================================================================ */
  /* 二、视图渲染                                                        */
  /* ================================================================ */

  /** 视图不合法时的占位块。宁可显示一句话，也不要吐一段空白让人以为页面坏了。 */
  const NO_VIEW = `<div class="hxl-view"><div class="hxl-empty">插件没有给出可显示的视图</div></div>`;

  function titleOf(data) {
    const title = str(data && data.title).trim();
    return title
      ? `<div class="hxl-view-title">${escapeHtml(title)}</div>`
      : '';
  }

  /** text：一段正文。保留换行（由 CSS 的 white-space 处理），其余全部转义。 */
  function renderText(data) {
    const body = str(data.body);
    return `<div class="hxl-view">
      ${titleOf(data)}
      <div class="hxl-text">${escapeHtml(body)}</div>
    </div>`;
  }

  /** list：一组带标题 / 说明 / 数值的行。 */
  function renderList(data) {
    const items = arr(data.items);
    const rows = items
      .map((raw) => {
        const item = obj(raw);
        if (!item) return '';
        const t = tone(item.tone);
        const cls = t ? ` is-${t}` : '';
        const desc = str(item.desc);
        const value = str(item.value);
        return `<li class="hxl-row${cls}">
          <div class="hxl-row-main">
            <span class="hxl-row-title">${escapeHtml(str(item.title))}</span>
            ${desc ? `<span class="hxl-row-desc">${escapeHtml(desc)}</span>` : ''}
          </div>
          ${value ? `<span class="hxl-row-value">${escapeHtml(value)}</span>` : ''}
        </li>`;
      })
      .join('');
    return `<div class="hxl-view">
      ${titleOf(data)}
      ${rows ? `<ul class="hxl-list">${rows}</ul>` : '<div class="hxl-empty">这个列表里没有内容</div>'}
    </div>`;
  }

  /** table：表头 + 数据行。行里多出来的格子丢掉，缺的补空格。 */
  function renderTable(data) {
    const columns = arr(data.columns).map((col) => str(col));
    const rows = arr(data.rows);
    if (!columns.length) {
      return `<div class="hxl-view">${titleOf(data)}<div class="hxl-empty">这个表格没有声明列</div></div>`;
    }
    const head = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('');
    const body = rows
      .map((raw) => {
        const cells = arr(raw);
        if (!cells.length) return '';
        const tds = columns
          .map((_col, index) => `<td>${escapeHtml(str(cells[index]))}</td>`)
          .join('');
        return `<tr>${tds}</tr>`;
      })
      .filter(Boolean)
      .join('');
    return `<div class="hxl-view">
      ${titleOf(data)}
      <div class="hxl-table-wrap">
        <table class="hxl-table"><thead><tr>${head}</tr></thead>
          ${body ? `<tbody>${body}</tbody>` : ''}
        </table>
      </div>
      ${body ? '' : '<div class="hxl-empty">这个表格里没有数据</div>'}
    </div>`;
  }

  /**
   * progress：按 value / max 算宽度百分比。
   *
   * max <= 0 或不是有限数时按 0% 处理 —— 直接除会得到 Infinity / NaN，
   * 写进 style 里要么被浏览器丢掉，要么渲染成一条怪色块。
   * value 超过 max 时封顶 100%，负数按 0。
   */
  function renderProgress(data) {
    const items = arr(data.items);
    const rows = items
      .map((raw) => {
        const item = obj(raw);
        if (!item) return '';
        const max = num(item.max, 0);
        const value = num(item.value, 0);
        const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
        const width = Math.round(pct * 10) / 10;
        const t = tone(item.tone);
        const note = str(item.note);
        const label = str(item.label);
        const valueText = max > 0 ? `${value} / ${max}` : str(item.value);
        return `<div class="hxl-bar${t ? ` is-${t}` : ''}">
          <div class="hxl-bar-head">
            <span class="hxl-bar-label">${escapeHtml(label)}</span>
            <span class="hxl-bar-value">${escapeHtml(valueText)}</span>
          </div>
          <div class="hxl-bar-track"><div class="hxl-bar-fill" style="width:${width}%"></div></div>
          ${note ? `<div class="hxl-bar-note">${escapeHtml(note)}</div>` : ''}
        </div>`;
      })
      .join('');
    return `<div class="hxl-view">
      ${titleOf(data)}
      ${rows ? `<div class="hxl-progress">${rows}</div>` : '<div class="hxl-empty">这个进度视图里没有内容</div>'}
    </div>`;
  }

  const RENDERERS = {
    text: renderText,
    list: renderList,
    table: renderTable,
    progress: renderProgress,
  };

  /**
   * 把 (类型, 数据) 渲染成 HTML 字符串。
   *
   * 三种情况统一给占位块：类型不认识、数据不是普通对象、渲染过程抛异常。
   * 插件给的数据再离谱，页面也不该因此崩掉。
   * （列表 / 进度条内容为空不算错：标题是有意义的，照样渲染出来。）
   */
  function renderView(type, data) {
    try {
      const key = typeof type === 'string' ? type.trim().toLowerCase() : '';
      const render = Object.prototype.hasOwnProperty.call(RENDERERS, key) ? RENDERERS[key] : null;
      if (!render) return NO_VIEW;
      const payload = obj(data);
      if (!payload) return NO_VIEW;
      const html = render(payload);
      return typeof html === 'string' && html ? html : NO_VIEW;
    } catch {
      return NO_VIEW;
    }
  }

  const Render = Object.freeze({
    render: renderView,
    escapeHtml,
    /** 视图类型是否被支持，界面上可以先问一句再渲染。 */
    supports: (type) =>
      Object.prototype.hasOwnProperty.call(
        RENDERERS,
        typeof type === 'string' ? type.trim().toLowerCase() : ''
      ),
    types: Object.freeze(Object.keys(RENDERERS)),
    placeholder: NO_VIEW,
  });

  /* ================================================================ */
  /* 三、Worker 沙箱前置代码                                            */
  /* ================================================================ */

  /*
   * ⚠️ 下面这段必须和 electron/plugin-host.js 里的 sandboxPrelude(pluginId) **逐字一致**。
   *
   * 改这里必须同步改 electron/plugin-host.js 的 sandboxPrelude，反之亦然。
   * 两份代码跑的是同一套协议（插件 → { __hxl:'call', id, method, args }，
   * 宿主 → { __hxl:'result', id, ok, value|error }），任何一边改了协议，
   * 另一边要跟着改，否则插件调用会全部超时。
   *
   * 唯一的差异：这里把主进程那份的 `${JSON.stringify(pluginId)}` 拆成了运行时的
   * JSON.stringify(pluginId)。两份代码仍然是字面量逐字一致的。
   *
   * 注意：这段是模板字符串，里面的反引号 / ${ 已经没有（原函数本身没有嵌套模板），
   * 但保留了 \\n 之类的转义写法，改动时别手滑。
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
  /*
   * indexedDB / caches 是只读的全局访问器：直接赋值在严格模式下抛 TypeError、
   * 非严格模式下静默失败——两种都拦不掉（实测 self.indexedDB = undefined 之后
   * typeof indexedDB 仍然是 'object'）。它们挂在 WorkerGlobalScope 的原型链上，
   * 所以要在 self 自身上用 defineProperty 盖一层遮蔽，这才能真的挡掉。
   */
  try {
    Object.defineProperty(self, 'indexedDB', { value: undefined, configurable: true, writable: true });
  } catch (e) {}
  try {
    Object.defineProperty(self, 'caches', { value: undefined, configurable: true, writable: true });
  } catch (e) {}

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

  /* ================================================================ */
  /* 四、权限仲裁                                                       */
  /* ================================================================ */

  /**
   * 权限表：和 electron/plugin-host.js 的 PERMISSIONS 对应。
   * label 是界面上要显示的中文名，说明里不含技术黑话。
   */
  const PERMISSION_LABEL = {
    ui: '显示面板',
    notify: '弹出提示',
    state: '读取启动器状态',
    storage: '保存自己的配置',
  };

  /** 每个 API 要哪个权限。method 就是 prelude 里 call() 的第一个参数。 */
  const METHOD_PERMISSION = {
    render: 'ui',
    notify: 'notify',
    state: 'state',
    'storage.get': 'storage',
    'storage.set': 'storage',
    /*
     * ready 是 prelude 在 hxl.ready() 的回调跑完之后自己发的一次「我起来了」，
     * 不带任何数据、也动不了任何东西。它没有对应权限——但必须在这里登记，
     * 否则 handleCall 会当成未知接口报错，导致每个正常插件跑完都显示
     * 「运行出错：不认识的接口 ready」。error 同理，是插件主动上报异常用的。
     */
    ready: null,
    error: null,
  };

  /** 权限中文名，拒绝时那句「这个插件没有申请「xxx」权限」要用。 */
  function permissionLabel(name) {
    return PERMISSION_LABEL[name] || name;
  }

  /**
   * 启动器公开给插件的状态快照。
   *
   * 白名单式：**不给** cookie、登录态、账号 uid、文件路径、接口地址、设置项。
   * 抽卡数据只给「每个游戏几条记录」——够插件做个统计数字，但拿不到具体抽卡内容
   * （那里面有 uid 和时间，属于个人隐私）。
   *
   * 调用方传进来的 state 是 app.js 的 state 对象，这里只读，不改。
   */
  function publicState(state) {
    const src = obj(state) || {};
    const games = arr(src.games)
      .slice(0, 50)
      .map((raw) => {
        const game = obj(raw);
        if (!game) return null;
        return {
          id: str(game.id),
          name: str(game.name),
          playSeconds: Math.max(0, Math.round(num(game.playSeconds))),
          lastPlayed: str(game.lastPlayed),
        };
      })
      .filter((game) => game && game.id);

    const statsSrc = obj(src.stats) || {};
    // 启动次数既可能在顶层 stats，也可能由各游戏累加，两个都兜住
    const launchesFromGames = games.length
      ? arr(src.games).reduce((sum, raw) => sum + Math.max(0, Math.round(num(obj(raw)?.launchCount))), 0)
      : 0;
    const stats = {
      launches: Math.max(0, Math.round(num(statsSrc.launches, launchesFromGames))),
      playSeconds: Math.max(
        0,
        Math.round(num(statsSrc.playSeconds, games.reduce((sum, game) => sum + game.playSeconds, 0)))
      ),
      games: games.length,
    };

    // 抽卡：只给每个游戏的记录条数
    const gachaSrc = obj(src.gacha) || {};
    const gacha = arr(gachaSrc.games)
      .map((raw) => {
        const game = obj(raw);
        if (!game) return null;
        const users = arr(game.users);
        const records = users.reduce((sum, user) => {
          const u = obj(user);
          if (!u) return sum;
          // 不同接口给的字段名不一样，能数就数，数不出来给 0
          const direct = num(u.count, num(u.total, NaN));
          if (Number.isFinite(direct)) return sum + direct;
          const logs = arr(u.logs).length + arr(u.records).length + arr(u.items).length;
          return sum + logs;
        }, 0);
        return { game: str(game.key) || str(game.name), records: Math.max(0, Math.round(records)) };
      })
      .filter(Boolean);

    return { games, stats, gacha, now: Date.now() };
  }

  /* ================================================================ */
  /* 五、Host：插件 Worker 管理                                         */
  /* ================================================================ */

  function pluginsApi() {
    const api = global && global.launcher && global.launcher.plugins;
    return api && typeof api.list === 'function' ? api : null;
  }

  function hasWorker() {
    return typeof global?.Worker === 'function' && typeof global?.Blob === 'function' &&
      typeof global?.URL?.createObjectURL === 'function';
  }

  /** 单个插件在 Worker 里跑太久没响应，最多给这么久。 */
  const WORKER_HEAP_MS = 12000;
  /** notify 弹提示的去重窗口：插件在循环里刷提示不能把界面糊满。 */
  const NOTIFY_WINDOW_MS = 800;
  const NOTIFY_MAX = 3;

  const host = {
    /** 每个插件一条记录：{ id, worker, url, running, startedAt, lastRender, views } */
    workers: new Map(),
    /** 错误表：{ id: '最近一次错误' } */
    errors: new Map(),
    /** 视图表：{ id: { type, data, html } } */
    views: new Map(),
    updateHandlers: [],
    errorHandlers: [],
    /** 由 app.js 注入的状态读取器，避免 Host 反向依赖 app.js */
    stateProvider: null,
    /** 由 app.js 注入的通知回调（复用现有的 toast 样式） */
    notifyHandler: null,
    notifyTimes: new Map(),
  };

  function emitUpdate(pluginId) {
    for (const fn of host.updateHandlers) {
      try {
        fn(pluginId, host.views.get(pluginId) || null);
      } catch {
        /* 回调自己出错就吞掉，不能让插件影响到页面 */
      }
    }
  }

  function emitError(pluginId, message) {
    const text = str(message) || '插件出错了';
    host.errors.set(pluginId, text);
    for (const fn of host.errorHandlers) {
      try {
        fn(pluginId, text);
      } catch {
        /* 同上 */
      }
    }
  }

  /** app.js 注册的两个回调；返回取消订阅函数，方便以后热重载。 */
  host.onUpdate = function onUpdate(cb) {
    if (typeof cb !== 'function') return () => {};
    host.updateHandlers.push(cb);
    return () => {
      const index = host.updateHandlers.indexOf(cb);
      if (index >= 0) host.updateHandlers.splice(index, 1);
    };
  };

  host.onError = function onError(cb) {
    if (typeof cb !== 'function') return () => {};
    host.errorHandlers.push(cb);
    return () => {
      const index = host.errorHandlers.indexOf(cb);
      if (index >= 0) host.errorHandlers.splice(index, 1);
    };
  };

  /** app.js 用它把 state / toast 接进来（Host 自己不 import app.js）。 */
  host.attach = function attach(options = {}) {
    if (typeof options.state === 'function') host.stateProvider = options.state;
    if (typeof options.notify === 'function') host.notifyHandler = options.notify;
  };

  host.errorOf = (pluginId) => str(host.errors.get(pluginId));
  host.viewOf = (pluginId) => host.views.get(pluginId) || null;
  host.isRunning = (pluginId) => host.workers.has(pluginId) && host.workers.get(pluginId).running;

  function permOf(pluginId) {
    const entry = host.workers.get(pluginId);
    return entry ? entry.permissions : arr(host.permissionCache?.get?.(pluginId));
  }

  /** 权限列表由 app.js 在 start 时传进来（它手里有 list() 的结果）。 */
  host.setPermissions = function setPermissions(pluginId, permissions) {
    if (!host.permissionCache) host.permissionCache = new Map();
    host.permissionCache.set(pluginId, arr(permissions).filter((item) => typeof item === 'string'));
  };

  function permissionsFor(pluginId) {
    const entry = host.workers.get(pluginId);
    if (entry) return entry.permissions;
    return host.permissionCache ? host.permissionCache.get(pluginId) || [] : [];
  }

  /**
   * 处理插件发来的一次调用，返回要回传的 { ok, value } 或 { ok:false, error }。
   *
   * 所有参数都被当成恶意输入：不管插件传什么，这里都要么给出值、要么给出
   * 一句中文错误，绝不抛出去。
   */
  async function handleCall(pluginId, method, args) {
    const perms = permissionsFor(pluginId);
    const need = METHOD_PERMISSION[method];
    /*
     * 用 hasOwn 判断「这个接口是否存在」，而不是 `if (!need)`：
     * ready / error 的权限是 null（不需要权限），用假值判断会把它们当成未知接口，
     * 于是每个插件正常跑完都会误报一次「不认识的接口 ready」。
     */
    if (!Object.prototype.hasOwnProperty.call(METHOD_PERMISSION, method)) {
      return { ok: false, error: `不认识的接口「${str(method)}」` };
    }
    if (need && !perms.includes(need)) {
      return { ok: false, error: `这个插件没有申请「${permissionLabel(need)}」权限` };
    }
    const api = pluginsApi();
    const list = arr(args);

    if (method === 'render') {
      const html = renderView(list[0], list[1]);
      const entry = host.workers.get(pluginId);
      const view = { type: str(list[0]), data: list[1], html };
      host.views.set(pluginId, view);
      if (entry) entry.lastRender = Date.now();
      emitUpdate(pluginId);
      return { ok: true, value: true };
    }

    if (method === 'notify') {
      const message = str(list[0]).slice(0, 500);
      if (!message) return { ok: true, value: true };
      // 简单限流：同一个插件短时间内最多弹 NOTIFY_MAX 条
      const now = Date.now();
      const times = (host.notifyTimes.get(pluginId) || []).filter((t) => now - t < NOTIFY_WINDOW_MS * 10);
      if (times.length >= NOTIFY_MAX) return { ok: true, value: false };
      times.push(now);
      host.notifyTimes.set(pluginId, times);
      try {
        if (host.notifyHandler) host.notifyHandler(pluginId, message);
      } catch {
        /* toast 自己出错不影响插件 */
      }
      return { ok: true, value: true };
    }

    if (method === 'ready') {
      // prelude 在 ready 回调跑完之后发的「我起来了」，只用来清掉启动阶段的错误态
      host.errors.delete(pluginId);
      emitUpdate(pluginId);
      return { ok: true, value: true };
    }

    if (method === 'error') {
      /*
       * 插件自己上报的异常。worker.onmessage 里会再 emitError 一次（带原文），
       * 这里只回包、不重复记错误，免得同一条错因出现两遍。
       */
      return { ok: true, value: true };
    }

    if (method === 'state') {
      let snapshot = {};
      try {
        snapshot = publicState(host.stateProvider ? host.stateProvider() : null);
      } catch {
        snapshot = publicState(null);
      }
      return { ok: true, value: snapshot };
    }

    if (method === 'storage.get') {
      if (!api) return { ok: false, error: '当前环境没有插件存储接口' };
      const value = await api.storageGet(pluginId);
      // 主进程返回的是裸对象，不是 { ok, value }；顺手挡掉异常形状
      return { ok: true, value: obj(value) || {} };
    }

    if (method === 'storage.set') {
      if (!api) return { ok: false, error: '当前环境没有插件存储接口' };
      let payload = list[0];
      // 插件可能传了不可 clone 的东西，先在 worker 侧就丢掉函数 / 循环引用
      if (typeof payload !== 'object' || payload === null) payload = {};
      const result = await api.storageSet({ id: pluginId, value: payload });
      if (result && result.ok === false) {
        return { ok: false, error: str(result.error) || '保存配置失败' };
      }
      return { ok: true, value: true };
    }

    return { ok: false, error: '未知的调用' };
  }

  /**
   * 启动一个插件。
   *
   * 流程：read(id) 拿源码 → prelude + 源码拼成 Blob → classic worker。
   * classic 而不是 module：module worker 会去解析 import，而插件里不该有 import，
   * 一旦写了 module 版本反而会静默失败；classic 能保证顶层的语法错误立刻抛出来。
   */
  host.start = async function start(pluginId) {
    const id = str(pluginId).trim();
    if (!id) return { ok: false, error: '插件 id 是空的' };
    if (host.workers.has(id)) return { ok: true, already: true };
    const api = pluginsApi();
    if (!api) return { ok: false, error: '当前环境没有插件接口' };
    if (!hasWorker()) return { ok: false, error: '当前环境不支持 Web Worker，插件无法运行' };

    const result = await api.read(id);
    if (!result || result.ok === false) {
      const error = str(result && result.error) || '读不到插件代码';
      emitError(id, error);
      return { ok: false, error };
    }
    const source = str(result.source);
    if (!source) {
      emitError(id, '插件文件是空的');
      return { ok: false, error: '插件文件是空的' };
    }

    let url = '';
    let worker = null;
    try {
      const blob = new global.Blob([sandboxPrelude(id), '\n', source], { type: 'text/javascript' });
      url = global.URL.createObjectURL(blob);
      worker = new global.Worker(url);
    } catch (error) {
      if (url) {
        try {
          global.URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
      const message = `插件启动失败：${str(error && error.message) || '未知原因'}`;
      emitError(id, message);
      return { ok: false, error: message };
    }

    const entry = {
      id,
      worker,
      url,
      running: true,
      startedAt: Date.now(),
      lastRender: 0,
      permissions: permissionsFor(id).slice(),
    };
    host.workers.set(id, entry);
    host.errors.delete(id);

    worker.onmessage = async (event) => {
      const data = event && event.data;
      if (!data || data.__hxl !== 'call') return;
      const callId = data.id;
      const method = str(data.method);
      let reply;
      try {
        reply = await handleCall(id, method, data.args);
      } catch (error) {
        reply = { ok: false, error: `调用 ${method} 失败：${str(error && error.message) || '未知错误'}` };
      }
      // Worker 可能在调用过程中被 stop 掉了，这时不再回话
      if (!host.workers.has(id)) return;
      try {
        worker.postMessage({ __hxl: 'result', id: callId, ok: reply.ok === true, value: reply.value, error: reply.error });
      } catch (error) {
        emitError(id, `回传结果失败：${str(error && error.message)}`);
      }
      if (method === 'error') {
        const text = str(arr(data.args)[0]) || '插件运行时出错';
        emitError(id, text);
      }
    };

    worker.onerror = (event) => {
      /*
       * Worker 里的异常走 ErrorEvent，真实原因在 message 上；file/lineno/colno
       * 指向 Blob URL 里的位置，对用户没意义但对我们排查有用。
       * 早期版本只取 message，遇到「Script error.」这种被跨源屏蔽的空壳就把真正
       * 的错误吞掉了，界面上只剩一句「插件运行时出错」，什么都查不出来。
       */
      const raw = str(event && event.message);
      const file = str(event && event.filename);
      const line = event && typeof event.lineno === 'number' ? event.lineno : 0;
      const col = event && typeof event.colno === 'number' ? event.colno : 0;
      const where = line > 0 ? `（第 ${line} 行${col > 0 ? ` 第 ${col} 列` : ''}）` : '';
      let message = raw && raw !== 'Script error.' ? `${raw}${where}` : '';
      if (!message) {
        // 拿不到原因时至少把 Blob 里的行号还给用户，否则完全无从下手
        message = file
          ? `插件运行时出错${where}`
          : '插件运行时出错，且浏览器没有给出原因（可能是语法错误）';
      }
      // 语法错误 / 顶层抛异常都会走到这里，插件本身已经废了，直接收摊
      emitError(id, message);
      host.stop(id);
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    };

    worker.onmessageerror = () => {
      emitError(id, '插件发来了一条无法解析的消息');
    };

    // 看门狗：插件一直不 ready 就提示一次，但不强杀（可能是在做慢操作）
    entry.watchdog = global.setTimeout(() => {
      if (!host.workers.has(id)) return;
      if (!host.views.get(id)) {
        emitError(id, '插件启动后一直没有渲染内容，可能卡住了或忘了调用 hxl.render()');
      }
    }, WORKER_HEAP_MS);

    try {
      worker.postMessage({ __hxl: 'hello', id });
    } catch {
      /* prelude 不处理 hello，发一条只为确保 worker 已就绪 */
    }

    emitUpdate(id);
    return { ok: true, id };
  };

  /** 停掉一个插件：终止 Worker、回收 Blob URL、清掉视图。 */
  host.stop = function stop(pluginId) {
    const id = str(pluginId);
    const entry = host.workers.get(id);
    if (!entry) {
      host.views.delete(id);
      return { ok: true, already: true };
    }
    host.workers.delete(id);
    if (entry.watchdog) global.clearTimeout(entry.watchdog);
    try {
      entry.worker.onmessage = null;
      entry.worker.onerror = null;
      entry.worker.onmessageerror = null;
      entry.worker.terminate();
    } catch {
      /* terminate 失败无所谓 */
    }
    try {
      global.URL.revokeObjectURL(entry.url);
    } catch {
      /* ignore */
    }
    host.views.delete(id);
    host.notifyTimes.delete(id);
    emitUpdate(id);
    return { ok: true };
  };

  /** 离开插件页 / 应用退出时全停。 */
  host.stopAll = function stopAll() {
    for (const id of [...host.workers.keys()]) host.stop(id);
  };

  /** 插件列表变了（删除、重新导入）时，把不在列表里的 Worker 收掉。 */
  host.reconcile = function reconcile(pluginIds) {
    const keep = new Set(arr(pluginIds).map((id) => str(id)));
    for (const id of [...host.workers.keys()]) {
      if (!keep.has(id)) host.stop(id);
    }
  };

  /** 让插件重新跑一遍入口（界面上「重新加载这个插件」）。 */
  host.restart = async function restart(pluginId) {
    host.stop(pluginId);
    host.errors.delete(pluginId);
    return host.start(pluginId);
  };

  const API = Object.freeze({ Render, renderView, Host: host, escapeHtml, publicState, PERMISSION_LABEL, sandboxPrelude });

  if (global) global.HXLPlugin = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Render, renderView };
})(typeof window !== 'undefined' ? window : null);
