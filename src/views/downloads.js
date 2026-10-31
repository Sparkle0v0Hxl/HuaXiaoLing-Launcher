'use strict';
/*
 * 下载任务队列 + 渠道资源补齐弹窗（第 12 批从 app.js 搬出，2026-10-31）
 *
 * 内容：
 *   · 下载任务：状态文案 / 任务行 / 任务队列整页（downloadsView）
 *   · NTE 渠道资源：按官方清单补齐缺文件的进度窗（openNtePredownloadModal）
 *   · NTE 抓包状态面板（renderNteCapture）与账号同步面板（nteSyncPanel）
 *   · 终末地打包弹窗（openEndfieldPackModal）
 *
 * 为什么这些放一起：它们都是「按官方清单把本机缺的东西补下来」这一条链路 ——
 * 下载队列是这条链路的落地页，NTE 那几个弹窗是它的入口。
 * 第 8 批搬 gacha 时，这段代码正好把 gacha 段打断成四块，所以单独留到这一批整段搬。
 *
 * 逐字搬运，逻辑一行没改。依赖的 state / dom / api / render / toast / icon / openModal
 * 都在 app.js 与 services 里定义，classic script 共享全局作用域。
 */

/* ------------------------------------------------------------------ */
/* NTE 渠道资源（预下载窗 / 抓包状态 / 同步面板）+ 终末地打包弹窗        */
/* ------------------------------------------------------------------ */
/**
 * 渠道资源预下载进度窗：花筱灵按官方清单下载缺的文件，实时进度、可取消。
 * B服/官服共用（切服后官方链路都可能要补几十 M），channel 决定文案。
 * 完成后弹窗留在原地展示结果，用户手动关。
 */
function openNtePredownloadModal(serverId, channel = 'bilibili') {
  const isB = channel === 'bilibili';
  const label = isB ? 'B服' : '官服';
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>下载 ${label}资源</h2><p>按官方清单补齐本机缺的文件，已有的一律跳过。</p></div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="nte-predl-status" id="nte-predl-status">正在读取版本清单…</div>
          <div class="nte-predl-bar"><span id="nte-predl-fill" style="width:0%"></span></div>
          <p class="form-hint" id="nte-predl-detail"></p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="nte-predl-cancel">取消</button>
        </div>
      </div>
    </div>
  `);
  const status = document.querySelector('#nte-predl-status');
  const fill = document.querySelector('#nte-predl-fill');
  const detail = document.querySelector('#nte-predl-detail');
  const cancelBtn = document.querySelector('#nte-predl-cancel');
  let settled = false;

  const unbind = api.neverness.onPredownload?.((progress) => {
    if (settled || !progress) return;
    if (progress.phase === 'download' && progress.total) {
      const percent = Math.round((progress.current / progress.total) * 100);
      fill.style.width = `${percent}%`;
      status.textContent = `正在下载 ${progress.current}/${progress.total}`;
      detail.textContent = progress.file || '';
    } else if (progress.message) {
      status.textContent = progress.message;
    }
  });

  cancelBtn?.addEventListener('click', async () => {
    if (settled) {
      dom.modalRoot.innerHTML = '';
      document.body.classList.remove('modal-open');
      return;
    }
    cancelBtn.disabled = true;
    cancelBtn.textContent = '正在取消…';
    await api.neverness.predownloadCancel().catch(() => {});
  });

  api.neverness
    .predownload({ channel, serverId })
    .then((result) => {
      settled = true;
      cancelBtn.textContent = '完成';
      if (result?.failed?.length) {
        status.textContent = `完成，但有 ${result.failed.length} 个文件失败`;
        detail.textContent = result.failed
          .slice(0, 3)
          .map((item) => item.path)
          .join('  ');
        toast(`${label}资源下载完成，${result.failed.length} 个文件失败，可重试`, 'error');
      } else {
        fill.style.width = '100%';
        fill.parentElement.classList.add('is-done');
        status.textContent = `下载完成：新增 ${result?.downloaded ?? 0} 个文件，跳过 ${result?.skipped ?? 0} 个（本来就有）`;
        detail.textContent = `${result?.version ? `官方版本 ${result.version} · ` : ''}现在从花筱灵点「启动」就能直接进${isB ? ' B服' : '游戏'}。`;
        toast(`${label}资源已就绪，点「启动」直接开玩`, 'success');
      }
    })
    .catch((error) => {
      settled = true;
      cancelBtn.textContent = '关闭';
      status.textContent = /取消/.test(String(error)) ? '已取消下载' : `下载失败：${humanError(error)}`;
    })
    .finally(() => {
      if (typeof unbind === 'function') unbind();
    });
}

// 异环：显示识别到的账号 + 自动导入目录入口 + 自动抓取
function renderNteCapture() {  const box = document.querySelector('#nte-capture-status');
  if (!box) return;
  const capture = state.nteCapture || {};
  const running = !!capture.running;
  box.classList.toggle('is-running', running);
  box.innerHTML = running
    ? `${icon('refresh')}<span>${esc(capture.message || '抓取中…')}</span>`
    : capture.message
      ? `${icon('info')}<span>${esc(capture.message)}</span>`
      : '';
  box.hidden = !running && !capture.message;
  const startBtn = document.querySelector('[data-action="nte-capture"]');
  const stopBtn = document.querySelector('[data-action="nte-capture-stop"]');
  if (startBtn) startBtn.disabled = running;
  if (stopBtn) stopBtn.hidden = !running;
}

function nteSyncPanel() {
  const account = state.nteAccount || null;
  const server = account ? String(account.serverName || '').trim() : '';
  const who = account
    ? [server, account.roleName || account.roleId].filter(Boolean).join(' · ')
    : '';
  const meta = account
    ? [account.level ? `Lv.${account.level}` : '', account.roleId ? `UID ${account.roleId}` : '']
        .filter(Boolean)
        .join(' · ')
    : '';
  const capture = state.nteCapture || {};
  const running = !!capture.running;
  const autoPage = state.nteAutoPage !== false;
  return `
    <div class="nte-sync-panel ${account ? 'is-ready' : ''}">
      <span class="nte-sync-dot"></span>
      <div class="nte-sync-copy">
        <strong>${account ? esc(who || '已识别账号') : '还没识别到异环账号'}</strong>
        <small>${
          account
            ? `${esc(meta)} · 抓取会自动导入；也可以把导出工具生成的 JSON 放进导出目录`
            : '先用官方启动器登录一次异环，启动器会从日志里认出账号'
        }</small>
      </div>
      <div class="nte-sync-actions">
        <button class="btn btn-primary" data-action="nte-capture" ${running ? 'disabled' : ''}>${icon('download')}自动抓取</button>
        <button class="btn btn-ghost" data-action="nte-capture-stop" ${running ? '' : 'hidden'}>${icon('x')}结束</button>
        <button class="btn btn-ghost" data-action="nte-capture-auto-page" title="抓取时自动翻页（需要游戏窗口在前台）">
          <span class="nte-auto-page-dot ${autoPage ? 'is-on' : ''}"></span>自动翻页
        </button>
        <button class="btn btn-ghost" data-action="nte-folder">${icon('folder')}导出目录</button>
        <button class="btn btn-ghost" data-action="nte-refresh">${icon('refresh')}立即检查</button>
      </div>
    </div>
    <div class="nte-capture-status" id="nte-capture-status" ${running || capture.message ? '' : 'hidden'}>
      ${running ? `${icon('refresh')}<span>${esc(capture.message || '抓取中…')}</span>` : capture.message ? `${icon('info')}<span>${esc(capture.message)}</span>` : ''}
    </div>
    <p class="nte-capture-hint">自动抓取会调用异环抓包组件（管理员权限），并读取游戏发出的抽卡封包；抓取完成后自动导入。不读取账号密码。</p>`;
}

/* gachaView2（抽卡整页）已拆到 views/gacha.js（第 8 批）。 */

/**
 * 渠道包管理窗口。
 *
 * 以前这里是「终末地更新」弹窗里塞了六个 update-option 按钮：渠道包只是其中一条，
 * 看不出哪个渠道装了、各占多大，也没法只处理某一个。现在按渠道逐行列：
 * 状态 / 占用 / 单独下载 / 单独释放，顶部给总占用，底部放导入、改目录、全部下载。
 *
 * 打开后异步读 packList（主进程会扫一遍目录算真实占用），读不到也不影响其它操作。
 */
async function openEndfieldPackModal() {
  const settings = state.settings || {};
  openModal(
    `<div class="modal-backdrop" data-backdrop>
      <div class="modal modal-pack" role="dialog" aria-modal="true" aria-labelledby="pack-manager-title">
        <div class="modal-head">
          <div>
            <h2 id="pack-manager-title">渠道包管理</h2>
            <p>切到哪个服才下那个；下过的会一直留着，官方更新渠道 SDK 时自动同步。</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="pack-summary" id="pack-summary"><span>正在读取本机渠道包…</span></div>
          <div class="pack-groups" id="pack-manager-list"></div>
          <div class="pack-manager-foot">
            <button class="btn btn-ghost" data-action="import-endfield-packs">${icon('folder-open')}从 XelLauncher 导入</button>
            <button class="btn btn-ghost" data-action="change-endfield-pack-root">${icon('folder')}改渠道包目录</button>
            <button class="btn btn-ghost" data-action="channel-pack-download-all">${icon('download')}下载全部</button>
          </div>
          <p class="form-hint">当前目录：${esc(settings.endfieldPackRoot || '启动器数据目录')}　·　下载可取消，已下完的文件下次直接用（断点续传）。</p>
          <div class="pack-manager-more">
            <button class="btn btn-ghost" data-action="update-endfield-game">${icon('download')}更新终末地本体</button>
            <button class="btn btn-ghost" data-action="repair-endfield-game">${icon('refresh')}修复终末地客户端</button>
          </div>
        </div>
      </div>
    </div>`,
    { onClose: stopPackManagerWatching }
  );
  startPackManagerWatching();
  await refreshChannelPackManager();
}

/* 窗口开着的时候订阅下载进度；关掉就取消，别让事件挂着往已销毁的节点上写。 */
let packManagerOffProgress = null;

function startPackManagerWatching() {
  stopPackManagerWatching();
  if (typeof api.endfield?.onPackProgress !== 'function') return;
  packManagerOffProgress = api.endfield.onPackProgress((progress) => updatePackManagerProgress(progress));
}

function stopPackManagerWatching() {
  if (typeof packManagerOffProgress === 'function') packManagerOffProgress();
  packManagerOffProgress = null;
}

/** 某一行正在下载时把进度写进那一行（进度事件带 game + channel，能精确定位）。 */
function updatePackManagerProgress(progress) {
  if (!progress) return;
  const key = `${progress.game}:${progress.channel}`;
  const row = document.querySelector(`[data-pack-row="${key}"]`);
  if (!row) return;
  const wrap = row.querySelector('[data-pack-progress]');
  if (!wrap) return;
  wrap.hidden = false;
  row.classList.add('is-downloading');
  const total = Number(progress.totalBytes) || 0;
  const done = Number(progress.downloadedBytes) || 0;
  const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
  const bar = wrap.querySelector('span');
  if (bar) bar.style.width = `${pct}%`;
  const meta = wrap.querySelector('small');
  if (meta) {
    const speed = Number(progress.speed) > 0 ? ` · ${fmtSpeed(progress.speed)}` : '';
    meta.textContent = total
      ? `${pct}% · ${packBytesText(done)} / ${packBytesText(total)}${speed}`
      : progress.current || '正在下载…';
  }
}

/** 一个渠道一行：名字 / 状态徽章 / 占用 / 按钮；下面留一条隐藏的进度条。 */
function packManagerRow(row) {
  const key = `${row.game}:${row.channel}`;
  const isSteam = row.directory === 'EndSteam';
  const badge = row.ready
    ? '<span class="pack-badge is-ready">已就绪</span>'
    : isSteam
      ? '<span class="pack-badge is-muted">需手动提供</span>'
      : '<span class="pack-badge">未下载</span>';
  const size = row.ready
    ? `<span class="pack-size">${packBytesText(row.bytes)}</span>`
    : '<span class="pack-size is-muted">—</span>';
  const actions = row.ready
    ? `<button class="btn btn-ghost btn-sm" data-action="channel-pack-download" data-game="${row.game}" data-channel="${row.channel}">${icon('refresh')}更新</button>
       <button class="btn btn-ghost btn-sm" data-action="channel-pack-release" data-directory="${row.directory}" data-label="${esc(row.label)}">${icon('trash')}释放</button>`
    : isSteam
      ? '<span class="pack-row-note" title="官方清单接口取不到，先从 Steam 装一次，或从 XelLauncher 导入">官方接口取不到，手动放回</span>'
      : `<button class="btn btn-primary btn-sm" data-action="channel-pack-download" data-game="${row.game}" data-channel="${row.channel}">${icon('download')}下载</button>`;
  return `<div class="pack-row" data-pack-row="${key}">
    <div class="pack-row-main">
      <strong>${esc(row.label)}</strong>
      ${badge}
      ${size}
    </div>
    <div class="pack-row-actions">${actions}</div>
    <div class="pack-progress" data-pack-progress hidden>
      <div class="pack-progress-bar"><span></span></div>
      <small></small>
    </div>
  </div>`;
}

/** 重新读一遍状态并重画列表（下载完、释放完都调它）。窗口已关就直接返回。 */
async function refreshChannelPackManager() {
  const host = document.getElementById('pack-manager-list');
  if (!host) return;
  let rows = [];
  try {
    const result = await api.endfield.packList();
    rows = (result && result.rows) || [];
  } catch (error) {
    host.innerHTML = `<p class="form-hint">读不到渠道包状态：${esc(error.message)}</p>`;
    return;
  }
  if (!document.getElementById('pack-manager-list')) return;
  const groups = [
    { game: 'endfield', name: '终末地', hint: '五个渠道共用一份客户端，切服靠替换渠道 SDK 文件' },
    {
      game: 'arknights',
      name: '明日方舟',
      hint: '官服与 B服 共用安装目录；国际服 / 台服 是独立客户端，不用渠道包',
    },
  ];
  let totalBytes = 0;
  let readyCount = 0;
  host.innerHTML = groups
    .map((group) => {
      const items = rows.filter((row) => row.game === group.game);
      if (!items.length) return '';
      const groupBytes = items.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
      const groupReady = items.filter((row) => row.ready).length;
      totalBytes += groupBytes;
      readyCount += groupReady;
      return `<section class="pack-group">
        <header class="pack-group-head">
          <strong>${esc(group.name)}</strong>
          <span>${groupReady} / ${items.length} 已就绪${groupBytes ? ` · ${packBytesText(groupBytes)}` : ''}</span>
        </header>
        <p class="pack-group-hint">${esc(group.hint)}</p>
        <div class="pack-rows">${items.map(packManagerRow).join('')}</div>
      </section>`;
    })
    .join('');
  const summary = document.getElementById('pack-summary');
  if (summary) {
    summary.innerHTML = `<div class="pack-summary-copy">
      <strong>本机渠道包占用 ${totalBytes ? packBytesText(totalBytes) : '0 KB'}</strong>
      <span>${readyCount} / ${rows.length} 个渠道已就绪；没下载的会在切到那个服时才问你要不要下</span>
    </div>`;
  }
}

/* gacha（导入说明 / 导入弹窗 / 同步弹窗 / loadGacha / 刷新定时器）已拆到 views/gacha.js（第 8 批）。 */


/* ------------------------------------------------------------------ */
/* downloads                                                           */
/* ------------------------------------------------------------------ */

function statusInfo(item) {
  switch (item.status) {
    case 'downloading':
      return { label: '下载中', cls: 'downloading' };
    case 'queued':
      return { label: '排队中', cls: 'paused' };
    case 'paused':
      return { label: '已暂停', cls: 'paused' };
    case 'completed':
      return { label: '已完成', cls: 'completed' };
    case 'error':
      return { label: '失败', cls: 'error' };
    case 'cancelled':
      return { label: '已取消', cls: 'paused' };
    default:
      return { label: '等待中', cls: '' };
  }
}

function downloadRow(item) {
  const status = statusInfo(item);
  const pct = item.total > 0 ? Math.min(100, (item.received / item.total) * 100) : 0;
  const indeterminate = item.status === 'downloading' && !item.total;
  const ext = (item.fileName.split('.').pop() || 'file').slice(0, 4);
  let subtitle = item.status === 'completed' ? '已保存到下载文件夹' : esc(item.url);
  try {
    subtitle = item.status === 'completed' ? item.filePath : new URL(item.url).hostname;
  } catch {
    /* keep */
  }
  const speedText =
    item.status === 'downloading'
      ? `${fmtSpeed(item.speed)}${etaText(item) ? ` · 剩余 ${etaText(item)}` : ''}`
      : item.status === 'completed'
        ? `${fmtBytes(item.received)} · ${relativeDate(item.completedAt)}`
        : item.status === 'paused'
          ? '已保留未完成的片段'
          : item.status === 'error'
            ? item.error || '下载失败'
            : item.status === 'cancelled'
              ? '文件片段已清理'
              : '等待开始';

  const actions = [];
  if (item.status === 'downloading' || item.status === 'queued') {
    actions.push(`<button class="btn-icon" data-action="pause-download" data-id="${esc(item.id)}" title="暂停">${icon('pause')}</button>`);
    actions.push(`<button class="btn-icon danger" data-action="cancel-download" data-id="${esc(item.id)}" title="取消">${icon('x')}</button>`);
  } else if (item.status === 'completed') {
    actions.push(`<button class="btn-icon" data-action="open-download" data-id="${esc(item.id)}" title="打开文件">${icon('play')}</button>`);
    actions.push(`<button class="btn-icon" data-action="open-download-folder" data-id="${esc(item.id)}" title="打开所在文件夹">${icon('folder-open')}</button>`);
    actions.push(`<button class="btn-icon danger" data-action="remove-download" data-id="${esc(item.id)}" title="移除记录">${icon('trash')}</button>`);
  } else {
    actions.push(`<button class="btn-icon" data-action="resume-download" data-id="${esc(item.id)}" title="继续">${icon('refresh')}</button>`);
    actions.push(`<button class="btn-icon danger" data-action="remove-download" data-id="${esc(item.id)}" title="移除">${icon('trash')}</button>`);
  }

  return `
    <div class="dl-row" data-dl-id="${esc(item.id)}">
      <div class="dl-file">
        <div class="file-icon">${esc(ext)}</div>
        <div style="min-width:0">
          <div class="dl-name" title="${esc(item.fileName)}">${esc(item.fileName)}</div>
          <div class="dl-url" title="${esc(subtitle)}">${esc(subtitle)}</div>
        </div>
      </div>
      <div class="dl-progress">
        <div class="progress-top">
          <strong data-dl-bytes>${fmtBytes(item.received)}${item.total ? ` / ${fmtBytes(item.total)}` : ''}</strong>
          <span>${item.total ? `${pct.toFixed(0)}%` : ''}</span>
        </div>
        <div class="progress-bar ${indeterminate ? 'indeterminate' : ''}">
          <span style="width:${pct}%"></span>
        </div>
      </div>
      <div class="dl-status">
        <span class="status-chip ${status.cls}">${status.label}</span>
        <div class="speed" data-dl-speed>${esc(speedText)}</div>
      </div>
      <div class="dl-actions">${actions.join('')}</div>
    </div>`;
}

function downloadsView() {
  const downloads = state.downloads;
  const active = activeDownloads();
  const paused = downloads.filter((d) => d.status === 'paused' || d.status === 'error').length;
  const completed = downloads.filter((d) => d.status === 'completed');
  const totalSpeed = active.reduce((sum, d) => sum + (d.speed || 0), 0);
  return `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">${PAGE_META.downloads.eyebrow}</div>
          <h1>下载 <span class="count">${active.length ? `${active.length} 个进行中` : '空闲'}</span></h1>
          <p class="sub">管理 http / https 直链下载，支持暂停、继续和断点续传。</p>
        </div>
        <div class="page-head-actions">
          <button class="btn btn-ghost" data-action="pause-all-downloads">暂停全部</button>
          <button class="btn btn-ghost" data-action="resume-all-downloads">继续全部</button>
          <button class="btn btn-primary" data-action="add-download">${icon('plus')}新建下载</button>
        </div>
      </div>
      <div class="dl-summary">
        <div class="dl-stat">
          <div class="label">${icon('download')}进行中</div>
          <div class="value" id="dl-active-count">${active.length}</div>
          <div class="hint">${paused ? `${paused} 个任务已暂停或失败` : '队列运行正常'}</div>
        </div>
        <div class="dl-stat">
          <div class="label">${icon('sparkle')}当前速度</div>
          <div class="value" id="dl-total-speed">${fmtSpeed(totalSpeed)}</div>
          <div class="hint">所有任务合计</div>
        </div>
        <div class="dl-stat">
          <div class="label">${icon('check')}已完成</div>
          <div class="value">${completed.length}</div>
          <div class="hint">保存在 ${esc(state.settings.downloadDir || '下载文件夹')}</div>
        </div>
      </div>
      <div class="dl-panel">
        <div class="dl-panel-head">
          <div>
            <h2>任务队列</h2>
            <div class="hint">${downloads.length ? `${downloads.length} 条记录` : '还没有下载任务'}</div>
          </div>
          <button class="link-btn" data-action="open-download-folder">${icon('folder-open')}打开下载文件夹</button>
        </div>
        ${
          downloads.length
            ? `<div class="dl-list">${downloads.map(downloadRow).join('')}</div>`
            : `<div class="empty" style="border:0;border-radius:0;background:transparent">
                <div class="empty-icon">${icon('download')}</div>
                <h3>队列是空的</h3>
                <p>把一个下载链接交给花筱灵。它会显示速度、进度和剩余时间，也可以随时暂停。</p>
                <button class="btn btn-primary" data-action="add-download">${icon('plus')}新建下载</button>
              </div>`
        }
      </div>
    </div>`;
}
