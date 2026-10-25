'use strict';

/**
 * 点歌台的视图层。
 *
 * 拆出来是为了两件事：
 *   1. 三个平台的登录（网易云扫码 / QQ 音乐 / 酷狗）统一到一个「音乐账号」面板；
 *   2. 点歌台整体重排成播放器 + 歌词 + 工具 + 歌单/榜单分页的结构。
 *
 * 依赖 app.js 里的全局：state / icon / esc / songCover / parseLrc /
 * playModeOptions / audioFxLabel / AUDIO_FX_PRESETS / chartPanelMarkup /
 * myPlaylistsMarkup / toast / openModal / closeModal / api。
 */

const SONG_TABS = [
  ['queue', '歌单'],
  ['charts', '榜单'],
  ['mine', '我的歌单'],
  ['search', '搜索'],
];

/* ── 搜索 ─────────────────────────────────────────────────── */

/**
 * 搜索栏：关键字输入 + 平台选择 + 搜索按钮。
 * 放在标签页那一行的右侧，切哪个分页都在。
 */
function songSearchMarkup() {
  const s = state.songSearch;
  const platforms = [
    ['all', '三平台'],
    ['qq', 'QQ 音乐'],
    ['kugou', '酷狗'],
    ['netease', '网易云'],
  ];
  return `
    <div class="song-search">
      <span class="song-search-icon">${icon('search', 'xs')}</span>
      <input id="song-search-input" class="song-search-input" type="search" autocomplete="off"
        placeholder="搜歌名 / 歌手 / 专辑" value="${esc(s.keyword)}" data-enter="song-search-run" />
      <select id="song-search-platform" class="song-search-platform" data-change="song-search-platform" title="搜哪个平台">
        ${platforms
          .map(([key, label]) => `<option value="${key}" ${s.platform === key ? 'selected' : ''}>${esc(label)}</option>`)
          .join('')}
      </select>
      <button class="song-search-btn" data-action="song-search-run" ${s.loading ? 'disabled' : ''}>
        ${s.loading ? '搜索中…' : '搜索'}
      </button>
    </div>`;
}

/** 搜索结果的每一行：点一下就把这首歌加进歌单。 */
function songSearchRow(item, index) {
  const cover = item.cover
    ? `<img src="${esc(item.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover />`
    : icon('music');
  return `
    <button class="song-search-row" data-action="song-search-add" data-index="${index}" title="加入歌单">
      <span class="song-search-cover">${cover}</span>
      <span class="song-search-copy">
        <strong>${esc(item.title)}</strong>
        <small>${esc(item.artist || '未知歌手')}${item.album ? ` · ${esc(item.album)}` : ''}</small>
      </span>
      <span class="song-search-source">${esc(item.sourceLabel || '')}</span>
      <span class="song-search-add">${icon('plus', 'xs')}</span>
    </button>`;
}

function songSearchPanel() {
  const s = state.songSearch;
  if (s.loading) {
    return `<div class="song-empty">${icon('search')}<strong>正在搜索…</strong><span>同时查三个平台的公开接口。</span></div>`;
  }
  if (!s.done) {
    return `<div class="song-empty">${icon('search')}<strong>搜点什么</strong><span>输入歌名或歌手，回车开始搜。结果点一下就加入歌单。</span></div>`;
  }
  const errors = s.errors?.length
    ? `<p class="song-search-errors">${s.errors.map((line) => esc(line)).join('　·　')}</p>`
    : '';
  if (!s.list.length) {
    return `<div class="song-empty">${icon('search')}<strong>没有找到「${esc(s.keyword)}」</strong><span>换个关键词，或者换个平台试试。</span></div>${errors}`;
  }
  return `
    <div class="song-search-result">
      <div class="song-search-head"><strong>${esc(s.keyword)}</strong><span>${s.list.length} 个结果</span></div>
      ${errors}
      <div class="song-search-list">
        ${s.list.map((item, index) => songSearchRow(item, index)).join('')}
      </div>
    </div>`;
}

/* ── 账号状态 ─────────────────────────────────────────────── */

function musicAccountLoggedIn(platform) {
  if (platform === 'netease') return Boolean(state.neteaseLogin?.loggedIn);
  return Boolean(state.musicLogin?.[platform]?.loggedIn);
}

function musicAccountSub(platform) {
  if (platform === 'netease') {
    if (!state.neteaseLogin?.loggedIn) return '扫码登录';
    return '已连接';
  }
  const info = state.musicLogin?.[platform];
  if (!info?.loggedIn) return '内置窗口登录';
  const id = info.uin || info.userid || '';
  return id ? `已登录 · ${id}` : '已登录';
}

function musicAccountChip(platform, label) {
  const on = musicAccountLoggedIn(platform);
  return `
    <button class="song-account ${on ? 'is-on' : ''}" data-action="music-accounts" data-platform="${platform}"
      title="${on ? `${label} 已登录，点击管理` : `登录 ${label}`}">
      <span class="song-account-dot"></span>
      <span class="song-account-text">
        <strong>${label}</strong>
        <small>${esc(musicAccountSub(platform))}</small>
      </span>
    </button>`;
}

function songAccountsMarkup() {
  return `
    <div class="song-accounts">
      ${musicAccountChip('netease', '网易云')}
      ${musicAccountChip('qq', 'QQ 音乐')}
      ${musicAccountChip('kugou', '酷狗')}
    </div>`;
}

/* ── 三平台统一的登录面板 ─────────────────────────────────── */

function openMusicAccountsModal(focus = '') {
  const apiDefault = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
  openModal(
    `
    <div class="modal-backdrop" data-backdrop>
    <div class="modal music-accounts-modal" role="dialog" aria-modal="true">
    <div class="modal-head"><div><h2>音乐账号</h2><p>三个平台的登录都在这里。凭证只加密保存在这台电脑上，不会上传。</p></div><button class="icon-btn" data-close>${icon('x')}</button></div>
    <div class="modal-body music-accounts-body">
      <section class="music-account-card ${focus === 'netease' ? 'is-focus' : ''}" data-platform="netease">
        <header>
          <div class="music-account-title">
            <span class="music-account-badge is-netease">${icon('music')}</span>
            <div><strong>网易云音乐</strong><small id="net-acc-state">${musicAccountSub('netease')}</small></div>
          </div>
          <span class="music-account-actions">
            <button class="btn btn-ghost btn-sm" id="net-qr-refresh">${icon('refresh')}获取二维码</button>
            <button class="btn btn-ghost btn-sm" id="net-acc-logout">退出</button>
          </span>
        </header>
        <div class="music-account-body">
          <div class="netease-qr-box is-inline">
            <div class="netease-qr-image" id="netease-qr-image">${icon('music')}</div>
            <div class="netease-qr-copy">
              <strong id="netease-login-status">等待获取二维码</strong>
              <span id="netease-login-hint">点「获取二维码」用网易云音乐 App 扫码。</span>
            </div>
          </div>
          <div class="music-account-row">
            <input class="text-input" id="netease-login-api" value="${esc(apiDefault)}" placeholder="http://127.0.0.1:3100" spellcheck="false" />
            <button class="btn btn-ghost btn-sm" id="netease-service-start">${icon('play')}启动本地服务</button>
          </div>
        </div>
      </section>

      <section class="music-account-card ${focus === 'qq' ? 'is-focus' : ''}" data-platform="qq">
        <header>
          <div class="music-account-title">
            <span class="music-account-badge is-qq">${icon('music')}</span>
            <div><strong>QQ 音乐</strong><small id="qq-acc-state">${musicAccountSub('qq')}</small></div>
          </div>
          <span class="music-account-actions">
            <button class="btn btn-primary btn-sm" data-action="music-account-login" data-platform="qq">${icon('login')}打开登录</button>
            <button class="btn btn-ghost btn-sm" data-action="music-account-logout" data-platform="qq">退出</button>
          </span>
        </header>
        <div class="music-account-body">
          <p class="music-account-note">弹出官方登录页，扫码 / QQ / 微信 / 手机验证码都可以。登录后榜单和歌单会显示在这里。</p>
        </div>
      </section>

      <section class="music-account-card ${focus === 'kugou' ? 'is-focus' : ''}" data-platform="kugou">
        <header>
          <div class="music-account-title">
            <span class="music-account-badge is-kugou">${icon('music')}</span>
            <div><strong>酷狗音乐</strong><small id="kg-acc-state">${musicAccountSub('kugou')}</small></div>
          </div>
          <span class="music-account-actions">
            <button class="btn btn-primary btn-sm" data-action="music-account-login" data-platform="kugou">${icon('login')}打开登录</button>
            <button class="btn btn-ghost btn-sm" data-action="music-account-logout" data-platform="kugou">退出</button>
          </span>
        </header>
        <div class="music-account-body">
          <p class="music-account-note">同样走官方登录页。酷狗的 cookie 名常改，登录后按域内 cookie 判定，不会再莫名掉登录。</p>
        </div>
      </section>
    </div>
    </div>
    </div>
  `
  );
  bindNeteaseQr();
}

/** 网易云的二维码流程（内嵌在账号面板里，也兼容独立调用）。 */
function bindNeteaseQr() {
  const apiInput = document.querySelector('#netease-login-api');
  const status = document.querySelector('#netease-login-status');
  const hint = document.querySelector('#netease-login-hint');
  const image = document.querySelector('#netease-qr-image');
  const refresh = document.querySelector('#net-qr-refresh');
  if (!apiInput || !refresh) return;

  let timer = null;
  let qrKey = '';
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const check = async () => {
    if (!qrKey) return;
    try {
      const result = await api.netease.qrCheck({ apiBase: apiInput.value.trim(), key: qrKey });
      if (result.loggedIn) {
        stop();
        status.textContent = '登录成功';
        hint.textContent = '可以直接去导入歌单了。';
        toast('网易云登录成功', 'success');
        await refreshNeteaseLogin();
        const chip = document.querySelector('#net-acc-state');
        if (chip) chip.textContent = '已登录';
        if (state.route === 'song') render({ preserveScroll: true });
      } else if (result.code === 802) {
        status.textContent = '已扫码，请在手机上确认';
        hint.textContent = result.message || '确认后会自动完成登录。';
      } else if (result.code === 800) {
        status.textContent = '二维码已过期';
        hint.textContent = '重新获取一个。';
        stop();
      } else {
        hint.textContent = result.message || '等待扫码…';
      }
    } catch (error) {
      stop();
      status.textContent = '登录检查失败';
      hint.textContent = error.message;
    }
  };

  refresh.addEventListener('click', async () => {
    stop();
    qrKey = '';
    refresh.disabled = true;
    status.textContent = '正在获取二维码…';
    hint.textContent = '连接本地 API';
    try {
      const apiBase = apiInput.value.trim();
      localStorage.setItem('vela:netease-api', apiBase);
      const result = await api.netease.qrCreate({ apiBase });
      qrKey = result.key;
      image.innerHTML = result.qrimg
        ? `<img src="${esc(result.qrimg)}" alt="网易云登录二维码" />`
        : icon('music');
      status.textContent = '请使用网易云音乐扫码';
      hint.textContent = '扫码后在手机上确认登录。';
      timer = setInterval(check, 2000);
    } catch (error) {
      status.textContent = '获取二维码失败';
      hint.textContent = error.message;
    } finally {
      refresh.disabled = false;
    }
  });

  document.querySelector('#netease-service-start')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    status.textContent = '正在启动本地服务…';
    hint.textContent = '查找 NeteaseCloudMusicApi 并启动，需要几秒钟。';
    try {
      const result = await api.netease.startService(apiInput.value.trim());
      if (result?.apiBase) apiInput.value = result.apiBase;
      status.textContent = result?.started ? '本地服务已启动' : '本地服务已经在运行';
      refresh.click();
    } catch (error) {
      status.textContent = '自动启动服务失败';
      hint.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector('#net-acc-logout')?.addEventListener('click', async () => {
    try {
      await api.netease.logout();
      await refreshNeteaseLogin();
      stop();
      status.textContent = '已退出登录';
      hint.textContent = '需要时重新获取二维码。';
      image.innerHTML = icon('music');
      const chip = document.querySelector('#net-acc-state');
      if (chip) chip.textContent = '扫码登录';
      toast('已退出网易云', 'success');
      if (state.route === 'song') render({ preserveScroll: true });
    } catch (error) {
      toast(error.message || '退出失败', 'error');
    }
  });

  // 打开面板时自动准备二维码，少点一次
  setTimeout(() => refresh.click(), 260);
}

/* ── 点歌台主体 ───────────────────────────────────────────── */

function songTabMarkup() {
  const tab = state.songTab || 'queue';
  return `
    <div class="song-tabs">
      ${SONG_TABS.map(
        ([key, label]) =>
          `<button class="song-tab ${tab === key ? 'active' : ''}" data-action="song-tab" data-value="${key}">${label}</button>`
      ).join('')}
    </div>`;
}

function songQueueList() {
  return `
    <div class="song-queue-wrap" id="song-queue">
      <div class="song-list">
        ${
          state.songs.length
            ? state.songs
                .map(
                  (song, index) => `
              <div class="song-row ${index === state.songIndex ? 'active' : ''}">
                <button class="song-row-main" data-action="song-select" data-index="${index}">
                  <span class="song-index">${index === state.songIndex ? icon('play') : index + 1}</span>
                  <span class="song-row-cover">${songCover(song) ? `<img src="${esc(songCover(song))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover />` : icon('music')}</span>
                  <span class="song-row-copy">
                    <strong>${esc(song.title)}</strong>
                    <small>${esc(song.artist || (String(song.url || '').startsWith('file:') ? '本地文件' : '网络直链'))}</small>
                  </span>
                </button>
                <button class="song-row-remove" data-action="song-remove" data-index="${index}" title="移除">${icon('x')}</button>
              </div>`
                )
                .join('')
            : `<div class="song-empty">${icon('music')}<strong>歌单还是空的</strong><span>添加本地音频，或者导入一个网易云歌单。</span></div>`
        }
      </div>
    </div>`;
}

function songMineMarkup() {
  // 「我的歌单」现在按平台分区，所有已登录平台的歌单一起列出来。
  // 之前只显示当前选中的那一个平台，登了 QQ 音乐就看不到网易云的。
  const anyLogged = ["netease", "qq", "kugou"].some((key) => state.musicLogin?.[key]?.loggedIn);
  if (!anyLogged) {
    return `<div class="song-empty">${icon('login')}<strong>先登录一个平台</strong><span>网易云 / QQ 音乐 / 酷狗 登录后，这里会按平台列出你账号里的歌单。</span>
      <button class="btn btn-primary btn-sm" data-action="music-accounts">${icon('login')}去登录</button></div>`;
  }
  ensureAllPlaylistsLoaded();
  return allPlaylistsMarkup();
}

function songViewMarkup() {
  const current = state.songs[state.songIndex] || null;
  const playing = Boolean(current?.url);
  const tab = state.songTab || "queue";
  const qualityOptions = [
    ["standard", "标准"],
    ["higher", "较高"],
    ["exhigh", "极高 320K"],
    ["lossless", "无损"],
    ["hires", "Hi-Res"],
  ];
  const qualitySelect = (id, cls) =>
    `<select id="${id}" class="${cls}" title="音质">${qualityOptions
      .map(([value, label]) => `<option value="${value}" ${state.songQuality === value ? "selected" : ""}>${label}</option>`)
      .join('')}</select>`;
  const cover = songCover(current);

  return `
    <div class="page song-page song-app">
      <header class="song-app-head">
        <div class="song-app-title">
          <h1>点歌台</h1>
          <span>${state.songs.length ? `${state.songs.length} 首` : "还没有歌"}${state.live.connected ? " · 弹幕已连接" : ""}</span>
        </div>
        <div class="song-app-accounts">
          ${["netease", "qq", "kugou"]
            .map((key) => {
              const label = key === "netease" ? "网易云" : key === "qq" ? "QQ 音乐" : "酷狗";
              const on = musicAccountLoggedIn(key);
              return `<button class="song-app-account ${on ? "is-on" : ""}" data-action="music-accounts" data-platform="${key}" title="${label} · ${on ? "已登录" : "未登录"}">${on ? `${icon("check", "xs")}` : ""}${esc(label)}</button>`;
            })
            .join('')}
        </div>
        <div class="song-app-actions">
          <button class="song-app-btn" data-action="add-song-file" title="添加本地歌曲">${icon("plus")}</button>
          <button class="song-app-btn" data-action="import-netease" title="导入网易云歌单">${icon("download")}</button>
          <button class="song-app-btn is-primary" data-action="add-song-link" title="添加音频链接">${icon("link")}</button>
        </div>
      </header>

      <div class="song-app-body">
        <main class="song-app-main">
          <div class="song-app-tabs">
            ${SONG_TABS.map(
              ([key, label]) =>
                `<button class="song-app-tab ${tab === key ? "active" : ""}" data-action="song-tab" data-value="${key}">${label}</button>`
            ).join('')}
            <span class="song-app-tabs-meta">
              ${tab === "queue" && state.songs.length ? `<button class="song-app-clear" data-action="song-clear">清空</button>` : ""}
            </span>
          </div>
          ${songSearchMarkup()}
          <div class="song-app-scroll">
            ${tab === "charts" ? chartPanelMarkup() : tab === "mine" ? songMineMarkup() : tab === "search" ? songSearchPanel() : songQueueList()}
          </div>
        </main>

        <aside class="song-app-rail">
          <section class="song-rail-card is-lyrics">
            <div class="song-rail-head">
              <span>歌词</span>
              <small>${current?.lyric ? "同步中" : current?.neteaseId ? "播放时获取" : "暂无"}</small>
            </div>
            <div class="song-lyrics song-rail-lyrics" id="song-lyrics">
              ${
                current?.lyric
                  ? parseLrc(current.lyric)
                      .map((line) => `<p class="song-lyric-line" data-time="${line.time}">${esc(line.text)}</p>`)
                      .join('')
                  : `<div class="song-lyric-empty">${icon("music")}<span>${current?.neteaseId ? "播放时自动获取歌词" : "本地或直链歌曲没有歌词"}</span></div>`
              }
            </div>
          </section>

          <section class="song-rail-card">
            <div class="song-rail-head">
              <span>音效</span>
              <button class="song-rail-more" data-action="open-audio-fx" title="完整音效面板">${icon("settings")}</button>
            </div>
            <div class="song-fx-row is-scroll">
              ${AUDIO_FX_PRESETS.map(
                (item) => `<button class="song-fx-chip ${state.audioFx.preset === item.key ? "active" : ""}"
                  data-action="fx-preset" data-value="${item.key}" title="${esc(item.desc)}">${esc(item.label)}</button>`
              ).join('')}
            </div>
            <div class="song-rail-row">
              <span>音量</span>
              <input class="song-rail-range" id="song-volume-main" type="range" min="0" max="100" step="1" value="${state.songVolume}" aria-label="歌曲音量" data-no-sound />
              <small id="song-volume-main-value">${state.songMuted ? "静音" : `${state.songVolume}%`}</small>
            </div>
            <div class="song-rail-row">
              <span>默认音质</span>
              ${qualitySelect("song-quality", "song-rail-select")}
            </div>
            <div class="song-rail-row">
              <span>开机继续播放</span>
              <button class="switch ${state.autoResumeSong ? "on" : ""}" role="switch" aria-checked="${Boolean(state.autoResumeSong)}" data-action="toggle-auto-resume"></button>
            </div>
          </section>

          <section class="song-rail-card">
            <div class="song-rail-head">
              <span>弹幕点歌</span>
              ${state.live.connected ? `<button class="song-rail-more" data-action="live-disconnect">断开</button>` : ""}
            </div>
            ${
              state.live.connected
                ? `<div class="song-live-on ${state.live.danmaku === "native" ? "is-native" : "is-status"}">
                    ${icon(state.live.danmaku === "native" ? "check" : "info")}
                    <span>${state.live.danmaku === "native" ? `${esc(state.live.platformLabel || "B站")} · 等待「点歌 歌名」` : `${esc(state.live.platformLabel || "")} · 仅显示状态`}</span>
                  </div>`
                : `<div class="song-live-form">
                    <input class="song-live-input" id="live-room-input" placeholder="B站 / 斗鱼 / 虎牙 / 抖音 直播间链接" value="${esc(state.live.roomUrl || "")}" spellcheck="false" />
                    <button class="song-live-btn" data-action="live-connect" ${state.live.connecting ? "disabled" : ""}>${state.live.connecting ? "连接中" : "连接"}</button>
                  </div>`
            }
          </section>
        </aside>
      </div>

      <footer class="song-bar">
        <div class="song-bar-now">
          <span class="song-bar-cover">${cover ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer" />` : icon("music")}</span>
          <span class="song-bar-copy">
            <strong id="dock-title">${esc(current?.title || "还没有点歌")}</strong>
            <small id="dock-now-artist">${esc(current?.artist || "点歌台")}</small>
          </span>
        </div>

        <div class="song-bar-center">
          <div class="song-bar-controls">
            <button class="song-bar-btn" data-action="song-prev" title="上一首">${icon("chevron-left")}</button>
            <button class="song-bar-play ${playing ? "is-ready" : ""}" data-action="song-play" title="播放 / 暂停">
              <svg class="icon"><use id="dock-play-use" href="#i-play"></use></svg>
            </button>
            <button class="song-bar-btn" data-action="song-next" title="下一首">${icon("chevron-right")}</button>
          </div>
          <div class="song-bar-progress">
            <span id="song-current">0:00</span>
            <input type="range" id="song-progress" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
            <span id="song-duration">0:00</span>
          </div>
        </div>

        <div class="song-bar-right">
          <select class="song-bar-mode" id="dock-play-mode" title="播放模式">${playModeOptions(true)}</select>
          ${qualitySelect("dock-quality", "song-bar-select")}
          <button class="song-bar-btn" data-action="song-mute" title="静音">
            <svg class="icon"><use id="dock-volume-use" href="${state.songMuted ? "#i-volume-x" : "#i-volume"}"></use></svg>
          </button>
          <input class="song-bar-volume" id="dock-volume" type="range" min="0" max="100" step="1" value="${state.songVolume}" aria-label="音量" data-no-sound />
          <button class="song-bar-btn" data-action="dock-open-list" title="歌曲列表">${icon("library")}</button>
        </div>
      </footer>

      <svg hidden style="display:none"><use id="song-mute-use" href="${state.songMuted ? "#i-volume-x" : "#i-volume"}"></use></svg>
    </div>`;
}
