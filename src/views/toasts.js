'use strict';

/*
 * toasts —— 第 17 批从 app.js 搬出（原 app.js 726–837 行，112 行逐行原样，逻辑零改动）。
 *
 * 内容（4 个顶层函数，按原顺序）：
 *   · toast(message, type)          全站提示条：剥掉主进程错误壳、配图标、4.2 秒后淡出
 *   · canPatchDownloads(prev, next) 下载页能否只改行内进度、不整页重绘
 *   · patchDownloads()              就地刷进度条 / 已下载字节 / 速度 / 总速度
 *   · onState(next)                 主进程状态回推的唯一入口：合并设置、决定是否重绘
 *
 * 搬走这一段的理由：这四个函数是全站被调用最多的（toast 有上百处调用点），
 * 留在 app.js 里意味着看任何一处的提示行为都要翻那个文件。
 *
 * 顶层零声明、零立即执行语句 —— 只注册函数，加载期无任何副作用。
 * 它们引用的 dom / icon / esc / humanError / playUiSound / state / render 等都在更早的
 * 文件里定义；因为全部在函数体内访问，不构成跨文件 TDZ。
 */

function toast(message, type = 'info') {
  if (!dom.toastRoot) return;
  // 后端偶尔会返回一个没有 error 字段的结果对象，直接 toast(undefined) 会弹一个空提示；
  // 这里兜底成一句能看懂的话，避免「点了没反应」。
  if (message === undefined || message === null || message === '') message = '操作失败，请重试';
  // 主进程抛回来的错误常带着「Error invoking remote method 'xxx': Error:」这层壳，
  // 直接弹出去就是一句英文开头的提示。这里统一剥掉，只留人话。
  if (type === 'error') message = humanError(message);
  playUiSound(type === 'error' ? 'error' : 'notify');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  const iconName = type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info';
  node.innerHTML = `${icon(iconName)}<span>${esc(message)}</span>`;
  dom.toastRoot.appendChild(node);
  window.setTimeout(() => {
    node.classList.add('leaving');
    window.setTimeout(() => node.remove(), 240);
  }, 4200);
}

function canPatchDownloads(previous, next) {
  return (
    state.route === 'downloads' &&
    previous.downloads.length === next.downloads.length &&
    previous.downloads.every(
      (item, index) =>
        next.downloads[index] &&
        item.id === next.downloads[index].id &&
        item.status === next.downloads[index].status
    )
  );
}

function patchDownloads() {
  for (const item of state.downloads) {
    const row = document.querySelector(`[data-dl-id="${item.id}"]`);
    if (!row) continue;
    const pct = item.total > 0 ? Math.min(100, (item.received / item.total) * 100) : 0;
    const bar = row.querySelector('.progress-bar');
    if (bar) {
      bar.classList.toggle('indeterminate', item.status === 'downloading' && !item.total);
      const fill = bar.querySelector('span');
      if (fill) fill.style.width = `${pct}%`;
    }
    const bytes = row.querySelector('[data-dl-bytes]');
    if (bytes) {
      bytes.textContent = `${fmtBytes(item.received)}${item.total ? ` / ${fmtBytes(item.total)}` : ''}`;
    }
    const speed = row.querySelector('[data-dl-speed]');
    if (speed && item.status === 'downloading') {
      const eta = etaText(item);
      speed.textContent = `${fmtSpeed(item.speed)}${eta ? ` · 剩余 ${eta}` : ''}`;
    }
  }
  const totalSpeed = activeDownloads().reduce((sum, item) => sum + (item.speed || 0), 0);
  const speedNode = document.querySelector('#dl-total-speed');
  if (speedNode) speedNode.textContent = fmtSpeed(totalSpeed);
}

function onState(next) {
  // 这里原来写的是 `data`，那个变量根本不存在，每次状态回推都会抛
  // ReferenceError，后面的 applySettings() 直接不执行——改设置时界面
  // 刷不动、主题还停在旧色，都是它先炸掉导致的。快照里的更新状态就叫 update。
  if (next && next.update) state.update = next.update;
  const previous = {
    downloads: state.downloads,
    games: state.games,
    settings: state.settings,
    stats: state.stats,
  };
  /*
   * charms / charBg 是渲染进程自己用的两个开关，主进程的设置白名单里没有这两个键，
   * 每次状态回推都会把它们抹掉——开关刚点下去就被刷回旧值，看着也像「点了不动」。
   * 覆盖 state.settings 之前先把这两个值捞回来。
   */
  const incomingSettings = keepRendererSettings(next.settings, state.settings);
  const gamesChanged = JSON.stringify(previous.games) !== JSON.stringify(next.games || []);
  const settingsChanged = JSON.stringify(previous.settings) !== JSON.stringify(incomingSettings);
  const statsChanged = JSON.stringify(previous.stats) !== JSON.stringify(next.stats || {});
  const structuralChanged = gamesChanged || settingsChanged || statsChanged;

  state.games = next.games || [];
  state.settings = incomingSettings;
  state.stats = next.stats || state.stats;
  state.nteAccount = next.nteAccount || null;
  state.downloads = next.downloads || [];
  state.app = next.app || state.app;
  applySettings();
  updateChrome();

  if (canPatchDownloads(previous, next)) {
    patchDownloads();
    return;
  }

  // 弹窗打开时先不重绘背景页面，避免添加游戏/保存资料时出现明显卡顿。
  // 下载进度最小化到任务条时不算弹窗，仍然允许切换页面。
  if (dom.modalRoot.childElementCount && !document.body.classList.contains('sophon-minimized')) return;

  // 只有下载进度变化时，不重绘其他页面，避免闪烁和打断输入。
  if (!structuralChanged && state.route !== 'downloads') return;

  /*
   * 开关是就地切状态的（见 paintSwitch）：点完之后主进程会回推一份内容相同的
   * 设置，这次重绘只会把刚跑起来的滑块动画掐断，内容一致就跳过它。
   */
  if (!gamesChanged && !statsChanged && consumeSettingsEcho(incomingSettings)) return;

  const focus = captureFocus();
  render({ preserveScroll: true });
  restoreFocus(focus);
}
