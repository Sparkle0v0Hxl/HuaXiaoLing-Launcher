'use strict';

/*
 * 卸载界面的渲染层。
 *
 * 只有三个 stage：确认 → 进度 → 完成。不开任何花活 —— 这是卸载，
 * 用户此刻要的是「点一下、看清删什么、走完」，不是动画。
 */

const el = (id) => document.getElementById(id);

const ui = {
  brandSub: el('brandSub'),
  stageConfirm: el('stageConfirm'),
  stageProgress: el('stageProgress'),
  stageDone: el('stageDone'),
  keepNote: el('keepNote'),
  installDirNote: el('installDirNote'),
  progressText: el('progressText'),
  progressPercent: el('progressPercent'),
  progressFill: el('progressFill'),
  progressCurrent: el('progressCurrent'),
  doneTitle: el('doneTitle'),
  doneSub: el('doneSub'),
  btnCancel: el('btnCancel'),
  btnPrimary: el('btnPrimary'),
};

const state = {
  phase: 'idle', // idle | running | done | failed
  info: null,
};

const STAGES = ['stageConfirm', 'stageProgress', 'stageDone'];

function show(stage) {
  for (const key of STAGES) {
    ui[key].classList.toggle('is-hidden', key !== stage);
  }
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return (index === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[index];
}

function onProgress(payload) {
  if (!payload) return;
  const percent = Math.max(0, Math.min(100, Math.round(Number(payload.percent) || 0)));
  ui.progressText.textContent = payload.text || '正在卸载…';
  ui.progressPercent.textContent = percent + '%';
  ui.progressFill.style.width = percent + '%';
  if (payload.phase === 'remove' || payload.phase === 'cleanup') {
    ui.progressCurrent.textContent = payload.text || '';
  }
}

async function startUninstall() {
  state.phase = 'running';
  show('stageProgress');
  ui.brandSub.textContent = '正在卸载';
  ui.btnPrimary.disabled = true;
  ui.btnPrimary.textContent = '卸载中…';
  ui.btnCancel.disabled = true;

  let result = null;
  try {
    result = await window.uninstall.start();
  } catch (error) {
    result = { ok: false, error: (error && error.message) || String(error) };
  }

  if (!result || !result.ok) {
    state.phase = 'failed';
    show('stageConfirm');
    ui.brandSub.textContent = '卸载失败';
    ui.installDirNote.textContent = '卸载失败：' + ((result && result.error) || '未知错误');
    ui.btnPrimary.disabled = false;
    ui.btnPrimary.textContent = '重试';
    ui.btnCancel.disabled = false;
    return;
  }

  state.phase = 'done';
  show('stageDone');
  ui.brandSub.textContent = '卸载完成';

  const lines = [];
  lines.push('已移除 ' + (result.removed || 0) + ' 项程序文件。');
  if (result.dataKept) {
    lines.push('data 目录已保留 —— 重装后游戏列表、设置、歌单、抽卡记录都还在。');
  }
  if (result.pending && result.pending.length) {
    lines.push(
      '有 ' +
        result.pending.length +
        ' 个文件正被占用，已安排在本窗口关闭后自动清理（杀毒软件扫描时可能稍慢，不影响使用）。'
    );
  }
  if (result.failed && result.failed.length) {
    lines.push('另有 ' + result.failed.length + ' 个文件没能删除，可以稍后手动清理安装目录。');
  }
  ui.doneSub.textContent = lines.join('\n');

  ui.btnPrimary.disabled = false;
  ui.btnPrimary.textContent = '关闭';
  ui.btnPrimary.className = 'btn btn-primary';
  ui.btnCancel.classList.add('is-hidden');
}

async function onPrimary() {
  if (state.phase === 'idle' || state.phase === 'failed') {
    await startUninstall();
    return;
  }
  if (state.phase === 'done') {
    await window.uninstall.close();
  }
}

async function init() {
  // 标题栏关闭按钮
  for (const btn of document.querySelectorAll('.win-btn')) {
    btn.addEventListener('click', () => {
      if (state.phase === 'running') return; // 卸载中途不许直接关掉窗口
      window.uninstall.close();
    });
  }

  window.uninstall.onProgress(onProgress);

  let info = null;
  try {
    info = await window.uninstall.info();
  } catch (error) {
    info = null;
  }
  state.info = info;

  if (info && info.installDir) {
    ui.installDirNote.textContent = '安装位置：' + info.installDir;
  }
  if (info && info.dataBytes > 0) {
    ui.keepNote.textContent =
      'data 目录里的游戏列表、设置、歌单、抽卡记录（约 ' +
      fmtBytes(info.dataBytes) +
      '）。';
  }

  // 破坏性操作：主按钮用警告色
  ui.btnPrimary.className = 'btn btn-danger';

  ui.btnPrimary.addEventListener('click', onPrimary);
  ui.btnCancel.addEventListener('click', () => {
    if (state.phase === 'running') return;
    window.uninstall.close();
  });

  show('stageConfirm');
}

init().catch((error) => {
  ui.brandSub.textContent = '界面初始化失败';
  ui.installDirNote.textContent = String((error && error.message) || error);
});