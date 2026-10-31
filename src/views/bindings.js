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

function bindView() {
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

  const bgBlur = document.querySelector('#bg-blur');
  if (bgBlur) {
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
