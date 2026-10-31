'use strict';

/**
 * 更新域服务：「发现新版本」下载弹窗、升级后的「更新内容」公告、
 * 版本配图挑选、更新进度显示。
 *
 * 2026-10-31 从 app.js 拆出 —— 「前后端分离」第 3 批。
 *
 * 依赖（均在 app.js / 其他 services，全局作用域，调用时解析）：
 *   state / dom / api / openModal / closeModal / render /
 *   applySettingLocally / esc / icon / REPO_RELEASES_URL
 * 数据源：主进程 updater 读 latest.json 塞进 state.update（notes 字段即公告正文）。
 *
 * 两个弹窗别搞混：
 *   · openUpdateModal      —— 远端有更新可装时的下载入口；
 *   · openReleaseNotesModal —— 升级装好之后告诉用户这一版改了什么。
 */

/**
 * 把清单里的 notes 拆成一行一条。
 *
 * latest.json 只支持「一行一条」：行首的 - / * / • 会剥掉，空行和空白直接丢。
 * 更新公告弹窗还要给行首加个小星标，所以单独抽出来，两边共用同一套拆分规则，
 * 免得设置页和弹窗对同一份 notes 理解出两种结果。
 */
function splitNotes(notes) {
  return String(notes || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*•]\s*/, ''))
    .filter(Boolean);
}

function notesMarkup(notes) {
  const clean = splitNotes(notes);
  if (!clean.length) return '<p>没有附带更新说明。</p>';
  if (clean.length === 1) return '<p>' + esc(clean[0]) + '</p>';
  return '<ul>' + clean.map((line) => '<li>' + esc(line) + '</li>').join('') + '</ul>';
}

function updateStatusText() {
  const info = state.update || {};
  const current = `当前 v${state.app.version || '1.0.0'}`;
  if (info.downloading) return `${current} · 正在下载更新（${Number(info.percent) || 0}%）`;
  if (info.error) return `${current} · ${info.error}`;
  if (info.hasUpdate) return `${current} · 发现新版本 v${info.latest}${info.mandatory ? '（建议尽快更新）' : ''}`;
  if (info.checkedAt) return `${current} · 已是最新${info.latest ? `（远端 v${info.latest}）` : ''}`;
  return `${current} · 还没检查过`;
}

function formatUpdateSize(bytes) {
  const size = Number(bytes) || 0;
  if (!size) return '';
  if (size > 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

/**
 * 更新弹窗 / 动态详情里的配图。
 *
 * 图片挂在 news.json 的 `image` 字段上（每个版本一张、取游戏库里的游戏），
 * `imageSource` 是找到这张图的页面，`imageCredit` 是显示用的来源名。
 * 来源链接一律做成按钮走 openExternal，不在页面里直接外跳。
 */
function newsFigure(post, extraClass) {
  if (!post || !post.image) return '';
  const credit = post.imageSource
    ? `<button class="figure-credit" data-action="open-external" data-url="${esc(post.imageSource)}" title="${esc(post.imageSource)}">图片来源：${esc(post.imageCredit || post.imageSource)}</button>`
    : '';
  return `
    <figure class="news-figure ${extraClass || ''}">
      <img src="${esc(post.image)}" alt="${esc(post.title || '')}" loading="lazy" referrerpolicy="no-referrer" />
      ${credit}
    </figure>`;
}

/**
 * 按版本号在本地动态里找那一条，用来取这一版的配图。
 * 找不到就返回 null，弹窗退化成纯文字。
 */
function releaseEntry(version) {
  const target = String(version || '')
    .replace(/^v/i, '')
    .trim();
  if (!target) return null;
  return (
    (state.news || []).find(
      (item) =>
        String(item.version || '')
          .replace(/^v/i, '')
          .trim() === target
    ) || null
  );
}

/** 版本号 → 一个稳定的整数，用来决定这一版挑哪款游戏当封面。 */
function versionHash(text) {
  const raw = String(text || '');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * 更新弹窗的置顶图。
 *
 * 取图顺序：
 *   1. news.json 里这一版自己的 `image`（带找图来源）；
 *   2. 下面这张选好的官方美术图（按版本号挑一款游戏，来源写官网）；
 *   3. 再没有就用游戏库里那款游戏已经下载好的封面。
 * 第 2、3 步都不需要联网准备，所以每次发版一定有图。
 */
const HERO_ART = {
  genshin: {
    image:
      'https://sdk-webstatic.mihoyo.com/upload/ann/2026/09/23/92220da84f2e0fbeb5b6ddfd09b22336_6625910379513968240_transformed.jpg',
    source: 'https://ys.mihoyo.com/main/news/detail/21888',
    credit: '原神官网',
  },
  starrail: {
    image:
      'https://sdk-webstatic.mihoyo.com/upload/ann/2026/09/15/0e28df09eb425be765a8f22f6b30c9c6_554111496134813712_transformed.png',
    source: 'https://sr.mihoyo.com/main/news',
    credit: '星穹铁道官网',
  },
  neverness: {
    image: 'https://yh.wanmei.com/images/cover260924/box3Slide1.jpg',
    source: 'https://yh.wanmei.com/',
    credit: '异环官网',
  },
  zzz: {
    image:
      'https://launcher-webstatic.mihoyo.com/launcher-public/2026/10/20/c20eaf6a8a32d6342da4d5334be51bfe_5591770470767677066.png',
    source: 'https://zzz.mihoyo.com/',
    credit: '绝区零官网',
  },
  endfield: {
    image: 'https://web.hycdn.cn/upload/image/20261016/79d9bdebd562b2b7421339c40d5c1199.jpg',
    source: 'https://endfield.hypergryph.com/',
    credit: '明日方舟：终末地官网',
  },
};

function versionHero(version) {
  const entry = releaseEntry(version);
  if (entry && entry.image) return entry;
  const games = (state.games || []).filter((game) => game.coverUrl || game.startCoverUrl);
  if (!games.length) return entry;
  const pick = games[versionHash(version) % games.length];
  /*
   * 米游社画师图优先：它是联网抓的，带作者和帖子地址，
   * 比官网美术图更适合放更新弹窗。抓不到就往下走官网那套。
   */
  const artist = (state.postArt || {})[pick.builtinKey];
  if (artist && artist.image) {
    return {
      ...(entry || {}),
      image: artist.image,
      imageSource: artist.source || '',
      imageCredit: artist.credit || '',
    };
  }
  const art = HERO_ART[pick.builtinKey];
  if (art) {
    return {
      ...(entry || {}),
      image: art.image,
      imageSource: art.source,
      imageCredit: art.credit,
    };
  }
  return {
    ...(entry || {}),
    image: pick.startCoverUrl || pick.coverUrl,
    imageSource: pick.officialSite || '',
    imageCredit: pick.officialSite ? `${pick.name} 官网` : '',
  };
}

/**
 * 取更新弹窗的配图。
 * 主进程那边：有缓存就直接给，超过一周才去米游社抓一次；
 * 没登录米游社或抓不到，返回的 items 是空的，界面自动用官网美术图。
 * 配图只是锦上添花，所以这里任何失败都咽下去。
 */
async function loadPostArt(force = false) {
  if (typeof api.postArt !== 'function') return;
  try {
    const result = await api.postArt(force);
    const items = (result && result.items) || {};
    if (!Object.keys(items).length) return;
    state.postArt = items;
    render({ preserveScroll: true });
  } catch {
    /* 忽略：没有配图也照样能更新 */
  }
}

function openUpdateModal(info) {
  const data = info || state.update || {};
  const size = formatUpdateSize(data.size);
  const entry = versionHero(data.latest);
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal narrow update-modal" role="dialog" aria-modal="true">
        ${newsFigure(entry, 'update-hero')}
        <div class="modal-head">
          <div>
            <h2>发现新版本 v${esc(data.latest || '')}</h2>
            <p>当前 v${esc(state.app.version || '')}${size ? ` · 更新包 ${esc(size)}` : ''}</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          ${data.notes ? `<div class="update-notes"><strong>这一版改了什么</strong>${notesMarkup(data.notes)}</div>` : '<p class="desc">没有附带更新说明。</p>'}
          <div class="update-progress" id="update-modal-progress" hidden><div class="update-progress-bar"><span style="width:0%"></span></div><small>准备下载…</small></div>
          <p class="desc" style="margin-top:14px">更新会关闭启动器、覆盖程序文件然后自动重新打开。游戏、账号、抽卡记录、歌单和设置都在数据目录里，不会被覆盖。</p>
          <p class="desc">不想走弹窗更新的话，也可以去 GitHub 自己下新版 ZIP，覆盖程序文件同样不会动数据。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_RELEASES_URL}" title="${REPO_RELEASES_URL}">${icon('external')}打开发布页</button>
          <span style="flex:1"></span>
          <button class="btn btn-ghost" data-close>稍后再说</button>
          <button class="btn btn-primary" data-action="apply-update">${icon('download')}立即更新</button>
        </div>
      </div>
    </div>`);
  setUpdateProgress(data.percent || 0);
}

/* ------------------------------------------------------------------ */
/* 更新公告弹窗                                                        */
/* ------------------------------------------------------------------ */

/*
 * 「这次更新改了什么」。
 *
 * 和上面那个「发现新版本」弹窗是两回事：那个是有新版本可装时的下载入口，
 * 这个是升级装好之后、告诉用户这一版干了什么。数据直接来自 latest.json 的
 * notes 字段（主进程 updater.readManifest 读出来塞进 state.update），
 * 所以只要发布时往清单里写 notes，这次更新就会有自己的公告。
 *
 * 「看过了」记在 settings.notesSeenVersion：settings 落在数据目录的
 * launcher-data.json 里，升级覆盖 resources/app 不会动它，所以同一个版本只会弹一次；
 * 版本号一变（清单里写了新版本），下次启动再弹。
 */
function pendingReleaseNotes(info) {
  const data = info || state.update || {};
  const version = String(data.latest || '').replace(/^v/i, '').trim();
  if (!version) return null;
  // 和本地版本一致才算「这一版已经装上了」，远端比本地新时走的是下载流程
  const current = String((state.app && state.app.version) || '').replace(/^v/i, '').trim();
  if (!current || version !== current) return null;
  const items = splitNotes(data.notes);
  if (!items.length) return null;
  const seen = String((state.settings && state.settings.notesSeenVersion) || '').replace(/^v/i, '').trim();
  if (seen === version) return null;
  return { version, items };
}

let releaseNotesOpen = false;

function openReleaseNotesModal(info) {
  const data = info || state.update || {};
  const release = pendingReleaseNotes(data);
  if (!release || releaseNotesOpen) return;
  releaseNotesOpen = true;
  const meta = [data.date ? esc(data.date) : '', data.title ? esc(data.title) : ''].filter(Boolean).join(' · ');
  const entry = versionHero(release.version);
  openModal(
    `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal release-notes update-modal" role="dialog" aria-modal="true" aria-labelledby="release-notes-title">
        ${newsFigure(entry, 'update-hero')}
        <div class="modal-head">
          <div>
            <h2 id="release-notes-title">更新内容 · v${esc(release.version)}</h2>
            <p>${meta || '启动器已经更新到这一版，下面是这次改了什么。'}</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <ul class="release-notes-list">
            ${release.items.map((item) => `<li><span>${esc(item)}</span></li>`).join('')}
          </ul>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_RELEASES_URL}" title="${REPO_RELEASES_URL}">${icon('external')}打开发布页</button>
          <label class="release-notes-ask"><input type="checkbox" id="release-notes-ask" checked /> 以后有更新也这样弹出来</label>
          <button class="btn btn-primary" data-close>知道了</button>
        </div>
      </div>
    </div>`,
    {
      onClose: () => {
        // 注意：onClose 是在 closeModal 把 dom.modalRoot 清空之后才调的，
        // 所以要在这之前把勾选框的状态读出来，不能等进 markReleaseNotesSeen 再查 DOM。
        const ask = document.querySelector('#release-notes-ask');
        const keepAsking = !ask || ask.checked;
        releaseNotesOpen = false;
        markReleaseNotesSeen(release.version, keepAsking);
      },
    }
  );
}

/**
 * 记下「这个版本的公告看过了」，顺手记住用户要不要以后继续弹。
 *
 * 走 applySettingLocally 而不是直接调 api.updateSettings：它只就地更新
 * state.settings 并重画 chrome，不会整页重绘，弹窗刚关掉时画面不会跳一下。
 */
function markReleaseNotesSeen(version, keepAsking) {
  applySettingLocally({
    notesSeenVersion: String(version || ''),
    autoCheckUpdate: keepAsking !== false,
  }).catch(() => {});
}

/**
 * 启动后守着「这次更新改了什么」的触发时机。
 *
 * 主进程开机 15 秒自动查一次清单，这里每 3 秒看一眼 state.update；
 * 读到、并且清单版本 == 本地版本、settings 里还没记过这个版本，就弹。
 * 两分钟没等到就收工，不常驻轮询。
 */
function startReleaseNotesWatch() {
  if (!(state.settings && state.settings.autoCheckUpdate !== false)) return;
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    if (!releaseNotesOpen) {
      // 弹「有新版本可装」的时候先让位，等它关掉再来
      if (dom.modalRoot && dom.modalRoot.childElementCount === 0) {
        const release = pendingReleaseNotes(state.update);
        if (release) {
          openReleaseNotesModal(state.update);
          return;
        }
      }
    }
    if (attempts >= 40) return;
    // 清单写的是更老的版本（比如发布了 1.6.3，本地已经是 2.0.0）时永远等不到，
    // 这里主动查一次，把 state.update 拉成「远端 = 本地」。
    if (attempts === 1 && !(state.update && state.update.latest)) {
      api.checkUpdate().then((result) => {
        if (result && typeof result === 'object') state.update = { ...state.update, ...result };
      }).catch(() => {});
    }
    window.setTimeout(tick, 3000);
  };
  window.setTimeout(tick, 3000);
}

/** 把字节数说成人看得懂的大小，进度条上要显示「下了多少 / 一共多少」。 */
function formatMB(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** 进度条下面那行字：优先用主进程给的阶段说明，否则拼出百分比 + 已下/总量。 */
function updateProgressText(percent, label) {
  if (label) return label;
  const update = state.update || {};
  const done = formatMB(update.received);
  const total = formatMB(update.total);
  if (Number(percent) >= 100) return '下载完成，正在校验并覆盖文件…';
  if (done && total) return `正在下载 ${percent}% · ${done} / ${total}`;
  if (done) return `正在下载 ${percent}% · 已下 ${done}`;
  return `正在下载 ${percent}%`;
}

function setUpdateProgress(percent, label) {
  const wrap = document.querySelector('#update-modal-progress');
  if (!wrap) return;
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  if (value > 0) wrap.hidden = false;
  const bar = wrap.querySelector('.update-progress-bar span');
  const text = wrap.querySelector('small');
  if (bar) bar.style.width = `${value}%`;
  if (text) text.textContent = updateProgressText(value, label);
}
