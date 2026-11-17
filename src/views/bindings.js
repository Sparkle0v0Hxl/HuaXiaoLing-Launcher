'use strict';

/*
 * view bindings —— 第 15 批从 app.js 搬出（原 app.js 714–977 行，264 行逐行原样，逻辑零改动）。
 *
 * 内容只有两个函数：
 *   · bindCoverFallbacks(root = document)：给每个 img[data-cover] 挂一次性 error 兜底，
 *     破图时隐藏图片并给 .game-cover 加 no-img，露出底下的字牌；
 *   · bindView()：每次整页重绘后重新挂事件 —— 封面兜底、头像兜底（破图降级成名字首字）、
 *     战绩页角色头像加 .is-broken、抽卡五星头像兜底，最后调 bindSongLyrics()。
 *
 * 跨文件：顶层只有函数声明，零顶层常量、零立即执行副作用，排在 app.js 之前安全；
 * 函数体内读的 state / document 都在调用时才有值。
 */

/* ------------------------------------------------------------------ */
/* view bindings                                                       */
/* ------------------------------------------------------------------ */

function bindCoverFallbacks(root = document) {
  root.querySelectorAll('img[data-cover]').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        img.style.display = 'none';
        const cover = img.closest('.game-cover');
        if (cover) cover.classList.add('no-img');
      },
      { once: true }
    );
  });
}

/*
 * 进音乐页时把「当前播放的那首」滚到可视区（2026-11-18）。
 *
 * 用户要求：「再次打开启动器，点音乐页，页面跳到我上次选择的歌曲位置」。
 * songIndex 已经持久化，这里只负责把对应行滚进视野 —— 每次从别的页进音乐页做一次，
 * 页内其他重绘不触发，免得用户正在看别处时被突然拉走。
 */
let lastBoundSongRoute = '';

function scrollSongPageToCurrent() {
  const node = document.querySelector('.song-row.active, .kr-detail-row.is-current, .song-chart-song.is-current');
  if (!node) return;
  const scroller = node.closest('.song-app-scroll') || node.closest('.song-app-side');
  if (scroller && scroller.scrollHeight > scroller.clientHeight) {
    // 只滚内容容器，不带着整页跳
    const top = node.offsetTop - scroller.clientHeight / 2 + node.offsetHeight / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    return;
  }
  node.scrollIntoView({ block: 'center', behavior: 'auto' });
}

function bindView() {
  bindQueueDragOnce();
  bindQueueBrushOnce();
  if (state.route === 'song' && lastBoundSongRoute !== 'song') {
    lastBoundSongRoute = 'song';
    setTimeout(scrollSongPageToCurrent, 280);
  } else if (state.route !== 'song') {
    lastBoundSongRoute = state.route;
  }
  bindCoverFallbacks();
  document.querySelectorAll('.avatar img').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        const holder = img.closest('.avatar');
        if (holder) holder.textContent = initial(state.settings.profileName || '大小姐');
      },
      { once: true }
    );
  });
  // 战绩页的角色头像是外链，挂掉时留一个占位方块而不是显示破图标
  document.querySelectorAll('img[data-record-avatar]').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        img.classList.add('is-broken');
        img.removeAttribute('src');
      },
      { once: true }
    );
  });
  // 抽卡记录的五星头像同样是外链，挂掉时隐藏图片，露出底下的字牌
  document.querySelectorAll('img[data-gacha-avatar]').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        const holder = img.closest('.gacha-avatar') || img.closest('.gacha-tile');
        if (!holder) return;
        if (holder.classList.contains('gacha-tile')) {
          holder.classList.add('is-blank');
          holder.innerHTML = '<span class="gacha-tile-blank">星</span>';
        } else {
          holder.classList.add('is-blank');
          holder.textContent = '星';
        }
      },
      { once: true }
    );
  });

  const search = document.querySelector('#game-search');
  if (search) {
    search.addEventListener('input', () => {
      state.search = search.value;
      const results = document.querySelector('#library-results');
      if (results) {
        results.innerHTML = libraryResultsMarkup();
        bindCoverFallbacks(results);
      }
      const clear = document.querySelector('.search-clear');
      if (clear) clear.style.display = search.value ? 'grid' : 'none';
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        search.value = '';
        state.search = '';
        const results = document.querySelector('#library-results');
        if (results) {
          results.innerHTML = libraryResultsMarkup();
          bindCoverFallbacks(results);
        }
        const clear = document.querySelector('.search-clear');
        if (clear) clear.style.display = 'none';
      }
    });
  }

  const songSearchInput = document.querySelector('#song-search-input');
  if (songSearchInput) {
    songSearchInput.addEventListener('input', () => {
      // 只记关键字，不重渲染，否则输入框会丢焦点
      state.songSearch.keyword = songSearchInput.value;
    });
    songSearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runSongSearch();
      }
    });
  }

  /*
   * 直播间输入框：外面那个 .song-live-form 是 div 不是 form，粘完链接按回车不会提交，
   * 之前按回车完全静默。这里补一条「回车 = 点连接」，元素照 #song-search-input 的写法取。
   *
   * input 那条只把值记回 state.live.roomUrl、不重绘：弹幕事件会整块重画点歌卡片，
   * 输入框的 value 是用 state.live.roomUrl 渲染的，不同步的话刚粘进去的链接会被旧值盖掉。
   */
  const liveRoomInput = document.querySelector('#live-room-input');
  if (liveRoomInput) {
    liveRoomInput.addEventListener('input', () => {
      // 只记值，不重渲染，否则输入框会丢焦点
      state.live.roomUrl = liveRoomInput.value;
    });
    liveRoomInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        // 回车等价于点那颗「连接」按钮。最近连接的历史芯片也带 data-action="live-connect"，
        // 但它们带 data-url，用 :not([data-url]) 排除掉，免得回车连到某条历史记录上。
        const btn = liveRoomInput.parentElement?.querySelector('[data-action="live-connect"]:not([data-url])');
        handleAction('live-connect', undefined, btn || liveRoomInput).catch((error) =>
          toast(humanError(error), 'error')
        );
      }
    });
  }

  /*
   * 队列过滤框：输入即过滤。这里只重绘 .song-list 这一小块，
   * 输入框和焦点原地不动；折叠状态在过滤时会被忽略（一律全展开）。
   */
  const queueFilterInput = document.querySelector('#song-queue-filter');
  if (queueFilterInput) {
    queueFilterInput.addEventListener('input', () => {
      state.queueFilter = queueFilterInput.value;
      const list = document.querySelector('#song-queue .song-list');
      if (list) {
        list.innerHTML = songQueueRowsMarkup() ||
          `<div class="song-empty">${icon('search')}<strong>没有匹配的队列歌曲</strong><span>换个关键字，或者点右侧的 × 清空过滤。</span></div>`;
        bindCoverFallbacks(list);
      }
      // 过滤词出现/消失会切换清除按钮，重绘过滤条之外不动输入框
      const wrap = document.querySelector('#song-queue');
      const clearBtn = wrap?.querySelector('.song-queue-filter-clear');
      if (clearBtn) clearBtn.hidden = !state.queueFilter;
    });
  }
  const songSearchPlatform = document.querySelector('#song-search-platform');
  if (songSearchPlatform) {
    songSearchPlatform.addEventListener('change', () => {
      state.songSearch.platform = songSearchPlatform.value;
      // 已经搜过一次的话，换平台直接重搜
      if (state.songSearch.done) runSongSearch();
    });
  }

  const sort = document.querySelector('#sort-select');
  if (sort) {
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      const results = document.querySelector('#library-results');
      if (results) {
        results.innerHTML = libraryResultsMarkup();
        bindCoverFallbacks(results);
      }
    });
  }

  const profile = document.querySelector('#profile-name-input');
  if (profile) {
    const save = () => {
      const value = profile.value.trim();
      if (!value || value === state.settings.profileName) return;
      api.updateSettings({ profileName: value }).catch((error) => toast(humanError(error), 'error'));
    };
    profile.addEventListener('change', save);
    profile.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        profile.blur();
      }
    });
  }

  const accountSelect = document.querySelector('#gacha-account-select');
  if (accountSelect) {
    accountSelect.addEventListener('change', () => {
      state.gachaUid = accountSelect.value;
      state.gachaScope = 'all';
      render({ preserveScroll: true });
    });
  }

  // 背景不透明度 / 清晰度：拖动时实时改 CSS 变量，松手才落盘。
  // 注意：不能直接用滑块 DOM 上的 value 回写——页面可能是在设置变化前渲染的，
  // 那样会把别的途径刚写进去的值覆盖掉。记下渲染时的初值，只提交真正的改动。
  const bgOpacity = document.querySelector('#bg-opacity');
  if (bgOpacity) {
    const label = document.querySelector('#bg-opacity-value');
    const initial = bgOpacity.value;
    bgOpacity.addEventListener('input', () => {
      const value = Number(bgOpacity.value) || 0;
      if (label) label.textContent = `${value}%`;
      document.documentElement.style.setProperty('--bg-opacity', String(value / 100));
      // 内容底跟着变：背景图拉淡时让位给材质，拉实时才加厚，否则文字读不清
      document.documentElement.style.setProperty(
        '--bg-veil',
        `${Math.round(34 + (value / 100) * 34)}%`
      );
    });
    bgOpacity.addEventListener('change', async () => {
      if (bgOpacity.value === initial) return;
      const value = Number(bgOpacity.value) || 0;
      // 先把本地值跟上，免得落盘期间的回推把滑到一半的位置弹回去
      state.settings = { ...(state.settings || {}), backgroundOpacity: value };
      const saved = await api.updateSettings({ backgroundOpacity: value });
      if (saved?.settings) state.settings = saved.settings;
      applySettings();
    });
  }

  // 下载限速：拖动时只改显示，松手才落盘（和上面两个滑块一致）。
  // 同样记下渲染时的初值，只提交真正的改动——否则别的途径刚写进去的值会被覆盖。
  const downloadLimit = document.querySelector('#download-limit');
  if (downloadLimit) {
    const label = document.querySelector('#download-limit-value');
    const initial = downloadLimit.value;
    const format = (kb) => {
      if (kb <= 0) return '不限速';
      return kb >= 1024 ? `${(kb / 1024).toFixed(kb % 1024 === 0 ? 0 : 1)} MB/s` : `${kb} KB/s`;
    };
    downloadLimit.addEventListener('input', () => {
      const kb = Number(downloadLimit.value) || 0;
      if (label) label.textContent = format(kb);
    });
    downloadLimit.addEventListener('change', async () => {
      if (downloadLimit.value === initial) return;
      const kb = Number(downloadLimit.value) || 0;
      state.settings = { ...(state.settings || {}), downloadLimitKBps: kb };
      const saved = await api.updateSettings({ downloadLimitKBps: kb });
      if (saved?.settings) state.settings = saved.settings;
    });
  }

  // 音乐缓存上限：和下载限速同一套写法，拖动只改显示，松手才落盘。
  const musicCacheLimit = document.querySelector('#music-cache-limit');
  if (musicCacheLimit) {
    const label = document.querySelector('#music-cache-limit-value');
    const initial = musicCacheLimit.value;
    const format = (mb) => {
      const n = Number(mb) || 0;
      if (n <= 0) return '不缓存';
      return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} GB` : `${n} MB`;
    };
    musicCacheLimit.addEventListener('input', () => {
      if (label) label.textContent = format(musicCacheLimit.value);
    });
    musicCacheLimit.addEventListener('change', async () => {
      if (musicCacheLimit.value === initial) return;
      const mb = Number(musicCacheLimit.value) || 0;
      state.settings = { ...(state.settings || {}), musicCacheLimitMB: mb };
      const saved = await api.updateSettings({ musicCacheLimitMB: mb });
      if (saved?.settings) state.settings = saved.settings;
      try {
        if (api.musicCacheConfig) await api.musicCacheConfig({ musicCacheLimitMB: mb });
      } catch {
        /* 模块自己的 config.json 同步失败也不影响主设置 */
      }
    });
  }

  const bgBlur = document.querySelector('#bg-blur');  if (bgBlur) {
    const label = document.querySelector('#bg-blur-value');
    const initial = bgBlur.value;
    bgBlur.addEventListener('input', () => {
      // 滑杆是「清晰度」，模糊半径是它的补数
      const clarity = Number(bgBlur.value) || 0;
      const blur = 100 - clarity;
      if (label) label.textContent = blur ? `模糊 ${blur}` : '原图';
      document.documentElement.style.setProperty('--bg-blur', `${blur}px`);
    });
    bgBlur.addEventListener('change', async () => {
      if (bgBlur.value === initial) return;
      const clarity = Number(bgBlur.value) || 0;
      const blur = 100 - clarity;
      state.settings = { ...(state.settings || {}), backgroundBlur: blur };
      const saved = await api.updateSettings({ backgroundBlur: blur });
      if (saved?.settings) state.settings = saved.settings;
      applySettings();
    });
  }

  const soundVolume = document.querySelector('#sound-volume');
  if (soundVolume) {
    const label = document.querySelector('#sound-volume-value');
    soundVolume.addEventListener('input', () => {
      state.sound.volume = Number(soundVolume.value) || 0;
      if (label) label.textContent = `${state.sound.volume}%`;
    });
    soundVolume.addEventListener('change', () => {
      saveSoundSettings();
      playUiSound('click', true);
    });
  }

  const songVolume = document.querySelector('#song-volume');
  if (songVolume) {
    songVolume.value = String(state.songVolume);
    songVolume.addEventListener('input', () => setSongVolume(songVolume.value));
  }

  const mainVolume = document.querySelector('#song-volume-main');
  if (mainVolume) {
    mainVolume.value = String(state.songVolume);
    mainVolume.addEventListener('input', () => setSongVolume(mainVolume.value));
  }

  const fxSetting = document.querySelector('#fx-intensity-setting');
  if (fxSetting) {
    const label = document.querySelector('#fx-intensity-setting-value');
    fxSetting.addEventListener('input', () => {
      const value = setAudioFxIntensity(fxSetting.value);
      if (label) label.textContent = `${value}%`;
    });
  }

  const dockVolume = document.querySelector('#dock-volume');
  if (dockVolume) {
    dockVolume.value = String(state.songVolume);
    dockVolume.addEventListener('input', () => setSongVolume(dockVolume.value));
  }

  syncVolumeUi();
  applyAudioFx();
  restoreStartVideoState();
  startStartRunningTimer();
  bindSongLyrics();
}


/**
 * 队列拖拽排序（2026-11-18）。
 *
 * 主流播放器都能拖动调整播放顺序，这里补上：
 *   · document 级委托，只绑一次（bindQueueDragOnce 幂等）；
 *   · 行上带 data-index（state.songs 的全局下标，折叠后依然正确）；
 *   · 落位后调 moveQueueItem，播放指针跟着走，序号与队列一起重排。
 */
let queueDragBound = false;
let queueDragFrom = -1;

function bindQueueDragOnce() {
  if (queueDragBound) return;
  queueDragBound = true;

  const clearMarks = () => {
    document.querySelectorAll('.song-row.is-dragging, .song-row.is-drop-target').forEach((node) => {
      node.classList.remove('is-dragging', 'is-drop-target');
    });
  };

  document.addEventListener('dragstart', (event) => {
    const row = event.target && event.target.closest && event.target.closest('.song-row');
    if (!row || row.dataset.index == null) return;
    queueDragFrom = Number(row.dataset.index);
    row.classList.add('is-dragging');
    try {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(queueDragFrom));
    } catch {
      /* 某些环境不给写 dataTransfer，拖拽本身仍可用 */
    }
  });

  document.addEventListener('dragover', (event) => {
    if (queueDragFrom < 0) return;
    const row = event.target && event.target.closest && event.target.closest('.song-row');
    if (!row) return;
    event.preventDefault();
    document.querySelectorAll('.song-row.is-drop-target').forEach((node) => node.classList.remove('is-drop-target'));
    row.classList.add('is-drop-target');
  });

  document.addEventListener('drop', (event) => {
    if (queueDragFrom < 0) return;
    const row = event.target && event.target.closest && event.target.closest('.song-row');
    if (!row) return;
    event.preventDefault();
    const to = Number(row.dataset.index);
    const from = queueDragFrom;
    queueDragFrom = -1;
    clearMarks();
    if (Number.isFinite(to) && to !== from && typeof moveQueueItem === 'function') {
      moveQueueItem(from, to);
    }
  });

  document.addEventListener('dragend', () => {
    queueDragFrom = -1;
    clearMarks();
  });
}


/**
 * 队列批量选择：按住 Shift 拖动刷选（2026-11-18）。
 *
 * 用户要求「批量操作的时候，可以按住鼠标往下划，快速选择」。
 * 普通拖动留给排序（HTML5 drag），所以这里用 Shift + 拖动做刷选，两者不打架。
 * 松开后顶部出现操作条：加入播放 / 从队列删除 / 取消。
 */
let queueBrushBound = false;

function bindQueueBrushOnce() {
  if (queueBrushBound) return;
  queueBrushBound = true;

  let active = false;
  let anchor = -1;
  let selected = new Set();

  // 2026-11-18：歌单详情页也要能刷选，所以两种行都认
  const rows = () => Array.from(document.querySelectorAll('#song-queue .song-row, .kr-detail-row'));

  const paint = () => {
    rows().forEach((row) => {
      const index = Number(row.dataset.index);
      row.classList.toggle('is-brush-selected', selected.has(index));
    });
    const bar = document.querySelector('#song-queue-brush');
    if (bar) {
      const count = bar.querySelector('b');
      if (count) count.textContent = String(selected.size);
    }
  };

  const clear = () => {
    selected = new Set();
    paint();
    const bar = document.querySelector('#song-queue-brush');
    if (bar) bar.remove();
  };

  const showBar = () => {
    if (selected.size < 1) return;
    let bar = document.querySelector('#song-queue-brush');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'song-queue-brush';
      bar.className = 'song-queue-brush';
      const host = document.querySelector('#song-queue');
      if (!host) return;
      host.prepend(bar);
    }
    bar.innerHTML = `
      <span>已选 <b>${selected.size}</b> 首</span>
      <button class="song-queue-brush-btn" data-brush="play">加入播放</button>
      <button class="song-queue-brush-btn is-danger" data-brush="remove">从队列删除</button>
      <button class="song-queue-brush-btn" data-brush="cancel">取消</button>`;
    bar.querySelector('[data-brush="cancel"]').onclick = clear;
    bar.querySelector('[data-brush="remove"]').onclick = (event) => {
      event.stopPropagation();
      const picked = state.pickedSongs || [];
      const removeSet = new Set(selected);
      state.pickedSongs = picked.filter((_item, index) => !removeSet.has(index));
      savePicked();
      const count = removeSet.size;
      clear();
      render({ preserveScroll: true });
      toast(`已从队列移除 ${count} 首`, 'success');
    };
    bar.querySelector('[data-brush="play"]').onclick = async (event) => {
      event.stopPropagation();
      const picked = state.pickedSongs || [];
      const pickedSongs = [...selected]
        .sort((a, b) => a - b)
        .map((index) => picked[index])
        .filter(Boolean)
        .map((item) => ({ ...item }));
      if (!pickedSongs.length) return;
      clear();
      state.songs = pickedSongs;
      state.songIndex = 0;
      saveSongs();
      await playSongAt(0, { preserveScroll: true });
      toast(`正在播放选中的 ${pickedSongs.length} 首`, 'success');
    };
  };

  document.addEventListener('mousedown', (event) => {
    if (!event.shiftKey || event.button !== 0) return;
    if (!document.querySelector('#song-queue')) return;
    const row = event.target && event.target.closest && event.target.closest('#song-queue .song-row, .kr-detail-row');
    if (!row) return;
    event.preventDefault();
    active = true;
    anchor = Number(row.dataset.index);
    selected = new Set([anchor]);
    paint();
  });

  document.addEventListener('mousemove', (event) => {
    if (!active) return;
    const row = event.target && event.target.closest && event.target.closest('#song-queue .song-row, .kr-detail-row');
    if (!row) return;
    const index = Number(row.dataset.index);
    if (!Number.isFinite(index)) return;
    const from = Math.min(anchor, index);
    const to = Math.max(anchor, index);
    selected = new Set();
    for (let i = from; i <= to; i += 1) selected.add(i);
    paint();
  });

  document.addEventListener('mouseup', () => {
    if (!active) return;
    active = false;
    /*
     * 歌单详情页的刷选写进 detailSelected；队列页写进 queueSelected。
     * 写完后统一渲染一次，把选中态和操作条一起画出来。
     */
    if (document.querySelector('.kr-detail')) {
      state.detailSelectMode = true;
      state.detailSelected = [...selected].sort((a, b) => a - b);
      render({ preserveScroll: true });
      return;
    }
    state.queueSelectMode = true;
    state.queueSelected = [...selected].sort((a, b) => a - b);
    renderKeepingSideScroll();
  });
}
