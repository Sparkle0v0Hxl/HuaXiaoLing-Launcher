'use strict';
/*
 * 音乐 · 播放器核心（第 9 批从 app.js 搬出，2026-10-31）
 *
 * 内容：点歌队列存档 / 播放模式 / 音质档位 / 播不动就跳下一首 / 播放进度记忆 /
 *      迷你播放器（吸附、展开、启动页避让）/ 歌词区 / 直播间点歌桥接。
 *
 * 逐字搬运，逻辑一行没改。依赖的 state / dom / api / render / toast 都在 app.js 与
 * services 里定义，classic script 共享全局作用域，加载顺序见 index.html
 * （本文件排在 app.js 之前，函数在调用时才解析名字，所以逆向依赖安全）。
 */
/* ------------------------------------------------------------------ */
/* karaoke request queue                                               */
/* ------------------------------------------------------------------ */

/** 上一次提示「存档写不下」的时间戳，用来节流，别每加一首就弹一次。 */
let saveSongsWarnedAt = 0;

function saveSongs() {
  try {
    // 队列里的歌原来最多只存 200 首：整张歌单八百首进来时，
    // 重开一次启动器就只剩前 200 首，注释还要告诉用户去恢复。现在改存全诗。
    localStorage.setItem('vela:songs', JSON.stringify(state.songs));
  } catch (error) {
    /*
     * 不再截 200 首之后，几百首的队列有可能顶到 localStorage 配额。
     * 内存里的队列一首没少，只是没写进本地存档而已，
     * 但默认静默吞掉会让用户以为「歌单丢了」——必须说清楚。
     * 每加一首都会走到这里，所以用时间戳压一下，别反复弹同一句。
     */
    console.error('[saveSongs] 队列写不进本地存档:', error);
    if (Date.now() - saveSongsWarnedAt > 60000) {
      saveSongsWarnedAt = Date.now();
      toast('队列太长了，这次没能写进本地存档。歌单还在播放列表里没丢，只是重启启动器后需要重新导入一次。', 'info');
    }
  }
}

const PLAY_MODES = [
  { key: 'order', label: '顺序播放', short: '顺序', icon: 'order' },
  { key: 'list', label: '列表循环', short: '列表', icon: 'repeat' },
  { key: 'single', label: '单曲循环', short: '单曲', icon: 'repeat-one' },
  { key: 'shuffle', label: '随机播放', short: '随机', icon: 'shuffle' },
];

function playModeMeta(mode = state.playMode) {
  return PLAY_MODES.find((item) => item.key === mode) || PLAY_MODES[1];
}

function playModeOptions(short = false) {
  return PLAY_MODES.map(
    (item) =>
      `<option value="${item.key}" ${state.playMode === item.key ? 'selected' : ''}>${short ? item.short : item.label}</option>`
  ).join('');
}

/* 音质档位：和 electron 侧 /song/url/v1 的 level 参数一一对应 */
const QUALITY_LEVELS = [
  ['standard', '标准'],
  ['higher', '较高'],
  ['exhigh', '极高 320K'],
  ['lossless', '无损'],
  ['hires', 'Hi-Res'],
];

function qualityLabel(level) {
  const hit = QUALITY_LEVELS.find(([key]) => key === level);
  return hit ? hit[1] : QUALITY_LEVELS[0][1];
}

/**
 * 底部工具条上的小下拉。
 *
 * 原生 <select> 的弹层方向由系统决定，播放器贴在窗口底边时只能往下弹，
 * 会被窗口裁掉、点不到下面的选项，所以这里自己画一个向上展开的菜单。
 */
function songPopMarkup(id, options, { current, cls = '', title = '' } = {}) {
  const active = options.find((item) => item[0] === current) || options[0];
  return `
    <div class="song-pop${cls ? ` ${cls}` : ''}" data-pop="${esc(id)}">
      <button class="song-pop-trigger" data-action="song-pop-toggle" data-pop="${esc(id)}" title="${esc(title)}">
        <span class="song-pop-label">${esc(active[1])}</span>
        ${icon('chevron-up', 'xs')}
      </button>
      <div class="song-pop-menu" role="listbox" aria-label="${esc(title)}">
        ${options
          .map(
            ([value, label]) =>
              `<button class="song-pop-item${value === current ? ' is-active' : ''}" role="option" aria-selected="${value === current}" data-action="song-pop-pick" data-pop="${esc(id)}" data-value="${esc(value)}">${esc(label)}</button>`
          )
          .join('')}
      </div>
    </div>`;
}

function qualityPopMarkup(id, cls = '') {
  return songPopMarkup(id, QUALITY_LEVELS, { current: state.songQuality, cls, title: '音质' });
}

function playModePopMarkup(id, cls = '') {
  return songPopMarkup(id, PLAY_MODES.map((item) => [item.key, item.label]), {
    current: state.playMode,
    cls,
    title: '播放模式',
  });
}

/** 下拉被切换后同步按钮文案和高亮项（不重绘整页）。 */
function refreshSongPops() {
  document.querySelectorAll('.song-pop').forEach((wrap) => {
    const id = wrap.dataset.pop || '';
    const isMode = id.indexOf('mode') >= 0;
    const current = isMode ? state.playMode : state.songQuality;
    const options = isMode ? PLAY_MODES.map((item) => [item.key, item.label]) : QUALITY_LEVELS;
    const label = wrap.querySelector('.song-pop-label');
    if (label) {
      const hit = options.find(([key]) => key === current) || options[0];
      label.textContent = hit[1];
    }
    wrap.querySelectorAll('.song-pop-item').forEach((item) => {
      const on = item.dataset.value === current;
      item.classList.toggle('is-active', on);
      item.setAttribute('aria-selected', String(on));
    });
  });
}

/** 点空白处把展开的下拉收起来。 */
function closeSongPops() {
  document.querySelectorAll('.song-pop.is-open').forEach((wrap) => wrap.classList.remove('is-open'));
}

function applyPlayModeUi() {
  const meta = playModeMeta();
  document.querySelectorAll('#song-mode, #dock-play-mode').forEach((select) => {
    select.value = state.playMode;
  });
  refreshSongPops();
  const miniIcon = document.querySelector('#mini-mode-use');
  if (miniIcon) miniIcon.setAttribute('href', `#i-${meta.icon}`);
  const miniButton = document.querySelector('[data-action="cycle-play-mode"]');
  if (miniButton) miniButton.title = `播放模式：${meta.label}（点击切换）`;
}

function setPlayMode(mode) {
  if (!PLAY_MODES.some((item) => item.key === mode)) return;
  state.playMode = mode;
  try {
    localStorage.setItem('vela:play-mode', mode);
  } catch {
    /* optional local preference */
  }
  applyPlayModeUi();
}

function cyclePlayMode() {
  const index = PLAY_MODES.findIndex((item) => item.key === state.playMode);
  const next = PLAY_MODES[(index + 1) % PLAY_MODES.length];
  setPlayMode(next.key);
  toast(`播放模式：${next.label}`, 'info');
}

function randomSongIndex() {
  const total = state.songs.length;
  if (total <= 1) return 0;
  let next = state.songIndex;
  while (next === state.songIndex) {
    next = Math.floor(Math.random() * total);
  }
  return next;
}

async function playSongAt(index, options = {}) {
  if (!state.songs.length) return;
  state.songIndex = Math.max(0, Math.min(Number(index) || 0, state.songs.length - 1));
  await hydrateSong(state.songs[state.songIndex]);
  await ensureSongQuality(state.songs[state.songIndex]);
  if (options.skipRender) updateSongChrome();
  else render({ preserveScroll: options.preserveScroll !== false });
  playCurrentSong();
}

async function handleSongEnded() {
  const audio = document.querySelector('#song-audio');
  if (!audio || !state.songs.length) return;
  if (state.playMode === 'single') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    updateSongChrome();
    return;
  }
  if (state.playMode === 'order' && state.songIndex >= state.songs.length - 1) {
    /*
     * 歌单续播还在往后排（点了一首，后面几十首正在一首首解析）：
     * 这里等下一刻，别刚放完一首就报「播放完毕」。
     */
    if (playlistFill && (await waitForMoreSongs(8000)) && state.songIndex < state.songs.length - 1) {
      await playSongAt(state.songIndex + 1, { skipRender: state.route !== 'song' });
      return;
    }
    audio.currentTime = 0;
    updateSongChrome();
    toast('歌单已经播放完毕', 'info');
    return;
  }
  const next =
    state.playMode === 'shuffle' ? randomSongIndex() : (state.songIndex + 1) % state.songs.length;
  await playSongAt(next, { skipRender: state.route !== 'song' });
}

/* ── 播不动就跳下一首 ─────────────────────────────────────── */

/*
 * 以前「歌播不了」是怎么被吞掉的：
 *   1. #song-audio 的 error 只被音效模块拿去关音效（app.js 的 fx 那段），
 *      音效本来就关着时那句 if 直接不成立，等于什么都没做；
 *   2. 队列推进只挂在 ended 上，播不了的歌永远等不到 ended；
 *   3. 没有任何超时 —— 请求挂在那儿不报错也不出声，就一直停着。
 * 三条合起来就是用户说的「放到听不到的歌曲后，就一直停住」。
 *
 * 现在解析没拿到地址 / audio 报 error / 超过 SONG_LOAD_TIMEOUT_MS 没出声，
 * 都收进 handleSongFailed 这一个口子：先试着重新取一次链，还不行就标不可用并跳下一首。
 */
const SONG_LOAD_TIMEOUT_MS = 12000;
/** 连着这么多首都播不了就停手，别把整个队列空转一遍。 */
const SONG_FAIL_STREAK_LIMIT = 5;
/** 同一首歌重新取链的冷却时间，防止「重取 → 又失败 → 再重取」转圈。 */
const SONG_REFETCH_COOLDOWN_MS = 5 * 60 * 1000;

let songLoadTimer = 0;
let songFailStreak = 0;
// 同一首歌的失败去重键：用「序号 + 地址」做键，避免同一首歌的 error 被反复处理陷入死循环，
// 但跳到下一首后键就变了，不会挡住下一首的失败接管（原来是全局布尔锁，会在连续多首播不动时把
// 第二首起的 error 静默吞掉，导致卡在第二首出不来）。
let songFailGuard = '';
let songSkipBatch = { count: 0, titles: [], reason: '', timer: 0 };

function clearSongLoadWatchdog() {
  if (songLoadTimer) clearTimeout(songLoadTimer);
  songLoadTimer = 0;
}

/**
 * 挂上「多久还没出声就算失败」的定时器。
 * 只用在「已经在尝试播放但迟迟没声音」的情况：真正出声（playing）会摘掉它，
 * 自动播放被浏览器拦下时 play() 会 reject，也会摘掉它 —— 那不是这首歌的错。
 */
function armSongLoadWatchdog() {
  clearSongLoadWatchdog();
  const audio = document.querySelector('#song-audio');
  if (!audio || !audio.src) return;
  songLoadTimer = window.setTimeout(() => {
    songLoadTimer = 0;
    // 已经出声了，或者根本没在尝试播放（自动播放被拦 / 用户暂停）：都不算失败
    if (audio.currentTime > 0.5 || audio.paused) return;
    void handleSongFailed('加载超时');
  }, SONG_LOAD_TIMEOUT_MS);
}

/** 把 audio 的 MediaError 翻成人话。 */
function describeAudioError(audio) {
  const code = audio?.error?.code;
  if (code === 1) return '播放被中断';
  if (code === 2) return '网络错误';
  if (code === 3) return '音频解码失败';
  if (code === 4) return '音源不可用（地址过期，或受到版权 / 会员限制）';
  return '无法播放';
}

/**
 * 歌名主体：去括号后缀（Live / 重制 / 伴奏）、标点、空格和大小写。
 * 与主进程 music-resolve.js 里的同名函数保持同一套规则。
 */
function songCoreName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(【\[].*?[)）】\]]/g, ' ')
    .replace(/[\s\-_/、,.·'"!?·・。，！？：:；;]+/g, '');
}

/** 歌手串拆成名字数组，"A / B"、"A、B"、"A feat. B" 都算多人。 */
function artistNameList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item?.name || item || '')).filter(Boolean);
  return String(value || '')
    .split(/[\/、,&;；·]|feat\.?/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 换源拿回来的到底还是不是原来那首。
 *
 * 换源最糟的结果不是失败，而是「换成了另一首」：能放、也不报错、也没有提示，
 * 但唱的是同名不同曲或者别人的翻唱。所以渲染层再核一次歌名主体 + 歌手，
 * 对不上就当这次没换成功，走正常的失败/跳过流程。
 */
function songIdentityMatches(want, got) {
  const wantCore = songCoreName(want?.title || want?.name);
  // 主进程把「实际拿到地址的那一份」放在 matchedTitle / matchedArtist 上
  const gotCore = songCoreName(got?.matchedTitle || got?.title || got?.name);
  if (!wantCore || !gotCore) return true;
  if (!(gotCore === wantCore || gotCore.includes(wantCore) || wantCore.includes(gotCore))) return false;
  const wantNames = artistNameList(want?.artist).map(songCoreName).filter(Boolean);
  const gotNames = artistNameList(got?.matchedArtist || got?.artist).map(songCoreName).filter(Boolean);
  if (!wantNames.length || !gotNames.length) return true;
  return wantNames.some((wantName) => gotNames.some((gotName) => gotName === wantName || gotName.includes(wantName) || wantName.includes(gotName)));
}

/**
 * 失败时先试着重新取一次链。
 *
 * 地址过期是会员曲最常见的死法：队列整份存在 localStorage 里，
 * 隔天再打开，昨天还能播的地址今天多半已经 403。
 * 拿得到新地址就返回它，拿不到就把后端给的原因（会员专享 / 没有可播放版本）
 * 留在 song.failReason 上，交给提示文案。
 */
async function refetchSongUrl(song) {
  if (!song) return '';
  // 本地文件没有可重新解析的对象
  if (String(song.url || '').startsWith('file:')) return '';
  if (Date.now() - (song.refetchedAt || 0) < SONG_REFETCH_COOLDOWN_MS) return '';
  song.refetchedAt = Date.now();
  try {
    const result = await api.musicResolve({
      song: {
        title: song.title,
        artist: song.artist,
        album: song.album,
        platform: song.source || song.platform || '',
        mid: song.mid,
        hash: song.hash,
        neteaseId: song.neteaseId,
      },
      apiBase: localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100',
      level: state.songQuality,
    });
    if (result?.ok && result.url) {
      // 换回来的必须还是同一首歌、同一个歌手；换到别的歌就当没换到
      if (songIdentityMatches(song, result)) return String(result.url);
      song.failReason = '换到的音源不是同一首歌';
    } else {
      song.failReason = String(result?.reason || '');
    }
  } catch (error) {
    song.failReason = String(error?.message || '');
  }
  saveSongs();
  return '';
}

/**
 * 从 from 往后找第一首还没被标不可用的。
 * 返回 -1 表示没得跳：队列只有一首，或者剩下的全标了不可用。
 */
function nextPlayableIndex(from) {
  const total = state.songs.length;
  if (total <= 1) return -1;
  const start = Number(from) || 0;
  if (state.playMode === 'shuffle') {
    const pool = [];
    for (let i = 0; i < total; i += 1) {
      if (i !== start && !state.songs[i]?.unavailable) pool.push(i);
    }
    if (!pool.length) return -1;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  for (let step = 1; step <= total; step += 1) {
    const index = (start + step) % total;
    if (!state.songs[index]?.unavailable) return index;
  }
  return -1;
}

function resetSkipBatch() {
  if (songSkipBatch.timer) clearTimeout(songSkipBatch.timer);
  songSkipBatch = { count: 0, titles: [], reason: '', timer: 0 };
}

/**
 * 跳过提示。连着跳多首时合并成一条，不刷屏。
 * 后端给得出原因就写原因（「会员专享」「版权受限」之类），给不出就统一说无法播放。
 */
function queueSkipToast(song, reason) {
  songSkipBatch.count += 1;
  songSkipBatch.reason = songSkipBatch.reason || reason;
  if (song?.title && songSkipBatch.titles.length < 3) songSkipBatch.titles.push(song.title);
  if (songSkipBatch.timer) clearTimeout(songSkipBatch.timer);
  songSkipBatch.timer = window.setTimeout(() => {
    const count = songSkipBatch.count;
    const titles = songSkipBatch.titles.slice();
    const why = songSkipBatch.reason;
    resetSkipBatch();
    if (count <= 1) {
      toast(`「${titles[0] || '这首'}」${why}，已跳过`, 'error');
      return;
    }
    const more = count > titles.length ? ` 等 ${count} 首` : '';
    toast(`已跳过 ${count} 首播不了的歌：${titles.join('、')}${more}`, 'error');
  }, 700);
}

/** 一首歌「起不来」的统一收口。 */
async function handleSongFailed(rawReason = '') {
  const audio = document.querySelector('#song-audio');
  // 手动关掉迷你播放器会 removeAttribute('src') 再 load()，那也会冒一个 error，
  // 跟歌曲本身没关系，别去动队列。
  if (!audio || !audio.src) return;
  const song = currentSongEntry();
  if (!song) return;
  // 同一首歌不要重复处理（防死循环），但允许下一首接管：
  // 用「序号 + 地址」做去重键，跳到下一首后键就变了，不会挡住它。
  const guardKey = `${state.songIndex}:${song.url || ''}`;
  if (songFailGuard === guardKey) return;
  songFailGuard = guardKey;
  clearSongLoadWatchdog();
  try {
    // 1) 先试着重新取一次链：地址过期 / 能换源救回来的，就不该跳
    const fresh = await refetchSongUrl(song);
    if (fresh) {
      song.url = fresh;
      song.unavailable = false;
      delete song.unavailableReason;
      delete song.failReason;
      songFailStreak = 0;
      saveSongs();
      playCurrentSong();
      /*
       * 换源成功不弹提示：换回来的是同一首歌、同一个歌手，接着往下放就行，
       * 弹一句「音源已刷新」属于系统自己的事，用户不需要知道。
       * 换到的不是同一首（或换不到）才走下面的提示/跳过。
       */
      return;
    }

    // 2) 真的播不了：标不可用 → 提示 → 跳下一首
    const reason = song.failReason || rawReason || '无法播放';
    song.unavailable = true;
    song.unavailableReason = reason;
    saveSongs();
    songFailStreak += 1;
    queueSkipToast(song, reason);
    if (state.route === 'song') render({ preserveScroll: true });
    else updateSongChrome();

    if (songFailStreak >= SONG_FAIL_STREAK_LIMIT) {
      resetSkipBatch();
      toast('连续多首无法播放，已停止。检查一下音源开关，以及网易云的登录和会员状态。', 'error');
      return;
    }
    const next = nextPlayableIndex(state.songIndex);
    if (next < 0) {
      toast('队列里没有其它能播的歌了', 'info');
      return;
    }
    await playSongAt(next, { skipRender: state.route !== 'song' });
  } finally {
    // 只在我们还停在「同一首」时清锁：跳到下一首后若下一首的 error 已抢先接管，
    // 它的 guard 键不同，这里就不该把它清掉。
    if (songFailGuard === guardKey) songFailGuard = '';
  }
}

/**
 * 启动时恢复上次的歌曲：
 * - 只恢复「当前曲目指针」和封面信息，不自动播放；
 * - 只有用户开启了 autoResumeSong 才真正开始播放；
 * - 没开启时，播放器会停在「已就绪」状态，等用户点播放。
 */
/** 播放进度记忆：曲目索引 + 秒数，关掉再打开能接着听。 */
const SONG_PROGRESS_KEY = 'vela:song-progress';

function saveSongProgress() {
  const audio = document.querySelector('#song-audio');
  if (!audio || !audio.src) return;
  try {
    localStorage.setItem(
      SONG_PROGRESS_KEY,
      JSON.stringify({
        index: state.songIndex,
        time: Math.max(0, Math.floor(audio.currentTime || 0)),
        at: Date.now(),
      })
    );
  } catch {
    /* 可选记忆 */
  }
}

function readSongProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(SONG_PROGRESS_KEY) || 'null');
    if (!saved || !Number.isFinite(saved.index)) return null;
    return {
      index: Math.max(0, Math.min(Number(saved.index) || 0, Math.max(0, state.songs.length - 1))),
      time: Math.max(0, Number(saved.time) || 0),
    };
  } catch {
    return null;
  }
}

function resumeLastSong() {
  const saved = readSongProgress();
  if (saved) state.songIndex = saved.index;

  const song = state.songs[state.songIndex];
  if (!song?.url) return;
  const audio = document.querySelector('#song-audio');
  if (!audio) return;

  // 先把 src 挂上，让播放器显示这首歌
  const key = `${state.songIndex}:${song.url}`;
  if (audio.dataset.songKey !== key) {
    audio.dataset.songKey = key;
    audio.src = song.url;
    audio.preload = 'metadata';
    audio.load();
  }

  // 恢复上次听到的位置（等元数据就绪再 seek）
  const seekTo = saved ? saved.time : 0;
  const applySeek = () => {
    if (!seekTo) return;
    try {
      audio.currentTime = Math.min(seekTo, Math.max(0, (audio.duration || seekTo) - 0.5));
    } catch {
      /* 某些直链不允许 seek */
    }
  };
  if (audio.readyState >= 1) applySeek();
  else audio.addEventListener('loadedmetadata', applySeek, { once: true });

  // 只有开启自动续播才真的出声；否则保持「已就绪」等用户点播放
  if (state.autoResumeSong) {
    audio.play().catch(() => {
      /* 浏览器策略可能拦下自动播放 */
    });
  }
  updateSongChrome();
}

function playCurrentSong(toggle = false) {
  const audio = document.querySelector('#song-audio');
  const song = currentSongEntry();
  if (!audio) return;
  /*
   * 没有可播放地址时以前是直接 return：不出声、不报错、也不推进队列，
   * 播放器就静悄悄地死在这一首上。现在按「播不了」处理，交给失败收口去跳。
   */
  if (!song?.url) {
    if (song) void handleSongFailed('没有可播放地址');
    return;
  }
  const key = `${state.songIndex}:${song.url}`;
  if (audio.dataset.songKey !== key) {
    audio.dataset.songKey = key;
    audio.src = song.url;
    audio.load();
  }
  if (toggle && !audio.paused) {
    audio.pause();
    clearFxWatchdog();
    clearSongLoadWatchdog();
    updateSongChrome();
    return;
  }
  if (state.audioFx.preset !== 'off' && !audioFxFallback) {
    applyAudioFx();
    armFxWatchdog(audio);
  }
  armSongLoadWatchdog();
  audio.play().catch(() => {
    /*
     * 自动播放被浏览器策略拦下时 promise 会 reject：这首歌本身没问题，
     * 只是还没轮到用户点播放。不在这里摘掉超时判定——真正出声时
     * 'playing' 事件会清掉它；若一首死链连 error 都没冒，超时判定还能兜底。
     * （autoplay 被拦时 audio.paused 仍为 true，watchdog 本身也不会误判失败。）
     */
  });
  updateSongChrome();
}

function openNeteaseLoginModal() {
  const defaultApi = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
  let timer = null;
  let key = '';
  openModal(
    `
    <div class="modal-head"><div><h2>网易云扫码登录</h2><p>连接你本机运行的 NeteaseCloudMusicApi 服务，扫码后只在本机内存保存登录态。</p></div><button class="icon-btn" data-close>${icon('x')}</button></div>
    <div class="modal-body">
      <label class="field"><span>本地 API 地址</span><input class="text-input" id="netease-login-api" value="${esc(defaultApi)}" placeholder="http://127.0.0.1:3100" /></label>
      <div class="netease-qr-box">
        <div class="netease-qr-image" id="netease-qr-image">${icon('music')}</div>
        <div class="netease-qr-copy"><strong id="netease-login-status">等待获取二维码</strong><span id="netease-login-hint">先确认本地 API 已启动，再点获取二维码。</span></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>关闭</button>
        <button class="btn btn-ghost" id="netease-service-start">${icon('play')}自动启动服务</button>
        <button class="btn btn-primary" id="netease-login-refresh">${icon('refresh')}获取二维码</button>
      </div>
    </div>
  `,
    { onClose: () => timer && clearInterval(timer) }
  );
  const apiInput = document.querySelector('#netease-login-api');
  const status = document.querySelector('#netease-login-status');
  const hint = document.querySelector('#netease-login-hint');
  const image = document.querySelector('#netease-qr-image');
  const refresh = document.querySelector('#netease-login-refresh');
  if (!apiInput || !refresh) return;
  api.netease
    .startService(apiInput.value.trim())
    .then((result) => {
      if (result?.apiBase) apiInput.value = result.apiBase;
      status.textContent = result?.started ? '本地服务已自动启动' : '本地服务已经在运行';
      hint.textContent = '正在获取登录二维码…';
      refresh.click();
    })
    .catch(() => {});
  const check = async () => {
    if (!key) return;
    try {
      const result = await api.netease.qrCheck({ apiBase: apiInput.value.trim(), key });
      if (result.loggedIn) {
        if (timer) clearInterval(timer);
        status.textContent = '登录成功';
        hint.textContent = '登录态已保存在本次运行中，可以直接导入歌单。';
        toast('网易云登录成功', 'success');
        setTimeout(() => closeModal(), 900);
      } else if (result.code === 802) {
        status.textContent = '已扫码，请在手机上确认';
        hint.textContent = result.message || '确认后会自动完成登录。';
      } else if (result.code === 800) {
        status.textContent = '二维码已过期';
        hint.textContent = '重新获取二维码。';
        if (timer) clearInterval(timer);
      } else {
        hint.textContent = result.message || '等待扫码…';
      }
    } catch (error) {
      if (timer) clearInterval(timer);
      status.textContent = '登录检查失败';
      hint.textContent = error.message;
    }
  };
  refresh.addEventListener('click', async () => {
    if (timer) clearInterval(timer);
    key = '';
    refresh.disabled = true;
    status.textContent = '正在获取二维码…';
    hint.textContent = '连接本地 API';
    try {
      const apiBase = apiInput.value.trim();
      localStorage.setItem('vela:netease-api', apiBase);
      const result = await api.netease.qrCreate({ apiBase });
      key = result.key;
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
  const serviceStart = document.querySelector('#netease-service-start');
  serviceStart?.addEventListener('click', async () => {
    serviceStart.disabled = true;
    status.textContent = '正在启动本地服务…';
    hint.textContent = '查找 NeteaseCloudMusicApi 并启动，需要几秒钟。';
    try {
      const result = await api.netease.startService(apiInput.value.trim());
      if (result?.apiBase) apiInput.value = result.apiBase;
      status.textContent = result?.started ? '本地服务已启动' : '本地服务已经在运行';
      hint.textContent = '现在正在获取登录二维码…';
      refresh.click();
    } catch (error) {
      status.textContent = '自动启动服务失败';
      hint.textContent = error.message;
    } finally {
      serviceStart.disabled = false;
    }
  });
}

function parseLrc(text) {
  const lines = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((raw) => {
      const match = raw.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/);
      if (!match) return;
      const title = match[4].trim();
      if (!title) return;
      const seconds =
        Number(match[1]) * 60 +
        Number(match[2]) +
        (match[3] ? Number(match[3].padEnd(3, '0').slice(0, 3)) / 1000 : 0);
      lines.push({ time: seconds, text: title });
    });
  return lines.sort((a, b) => a.time - b.time);
}

function currentSongEntry() {
  return state.songs[state.songIndex] || null;
}

function songCover(song) {
  return String(song?.cover || '').replace(/^http:/i, 'https:');
}

function formatSongTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const MINI_POS_KEY = 'vela:mini-pos';

/*
 * 把坐标夹进窗口。
 *
 * size 可以传 { w, h } 复用按下时量好的尺寸：拖动过程中每帧都读 offsetWidth
 * 会强制同步布局（读一次 = 让浏览器立刻把前面的写操作全部布局一遍），
 * 页面这么大、卡片还带 backdrop-filter，每帧一次就足以让拖动明显跟不上手。
 */
function clampMiniPosition(mini, x, y, size) {
  const margin = 6;
  const width = (size && size.w) || mini.offsetWidth || 338;
  const height = (size && size.h) || mini.offsetHeight || 92;
  return {
    x: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin)),
    y: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - height - margin)),
  };
}

/** 位置按场景分开存：启动页和主界面各自记住自己的位置。 */
function miniPosKey() {
  return state.route === 'start' ? `${MINI_POS_KEY}:start` : `${MINI_POS_KEY}:main`;
}

/**
 * 主界面小球默认停靠点：侧栏底部，压在「收起侧栏」按钮上方。
 *
 * 侧栏本身就是一块抽屉面板，小球停在这一列里，收起 / 展开时都贴着中线，
 * 不压导航项，也不压底部的收起按钮和个人资料。
 */
function defaultMiniPosition(mini) {
  const sidebar = document.querySelector('.sidebar');
  const toggle = document.querySelector('.sidebar-toggle');
  const profile = document.querySelector('.profile');
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : collapsed ? 76 : 238;
  const width = mini.offsetWidth || 200;
  const height = mini.offsetHeight || 34;
  const anchor = toggle || profile;
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : window.innerHeight - 74;
  const limit = window.innerHeight - height - 12;
  return {
    x: Math.max(10, Math.round(sidebarWidth / 2 - width / 2)),
    y: Math.round(Math.min(Math.max(56, anchorTop - height - 14), limit)),
  };
}

/** 停靠状态下展开成面板时，向侧栏右侧弹出，别压住侧栏本身。 */
function dockedPanelPosition(mini) {
  const sidebar = document.querySelector('.sidebar');
  const anchorEl = document.querySelector('.sidebar-toggle') || document.querySelector('.profile');
  const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 238;
  const anchorTop = anchorEl ? anchorEl.getBoundingClientRect().top : window.innerHeight - 74;
  const width = mini.offsetWidth || 320;
  const height = mini.offsetHeight || 150;
  return {
    x: Math.min(sidebarWidth + 14, Math.max(8, window.innerWidth - width - 14)),
    y: Math.max(16, Math.round(Math.min(anchorTop - height - 6, window.innerHeight - height - 14))),
  };
}

function applyMiniPosition(mini = document.querySelector('#mini-player')) {
  const miniRef = mini;
  if (miniRef && miniRef.classList && miniRef.classList.contains('is-start-chip')) return;
  /*
   * 拖动中一律不重算位置。
   * 拖动时位移写在 transform 上、left/top 还停在按下那一刻的值；这里若按记忆
   * 坐标重写 left/top，正在拖的球会被拽回旧位置 —— 现象就是「有时候拖得动、
   * 有时候拖一半跳回去」。拖完 end() 已经落回 left/top 并写进 localStorage。
   */
  if (miniRef && miniRef.classList && miniRef.classList.contains('dragging')) return;

  if (!mini || mini.hidden) return;
  // 启动页的位置由 updateSongChrome 内联写死，这里不要覆盖
  if (state.route === 'start') return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(miniPosKey()) || 'null');
  } catch {
    saved = null;
  }

  // 先切样式再量尺寸：停靠态的球比自由态小一圈，量晚了会算偏
  const docked = !(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y));
  mini.classList.toggle('is-docked', docked);

  let position;
  if (!docked) {
    position = clampMiniPosition(mini, saved.x, saved.y);
  } else if (state.route !== 'start') {
    // 主界面没有记录时，默认停靠在侧栏底部；展开成面板时朝侧栏右侧弹出
    position = isMiniExpanded() ? dockedPanelPosition(mini) : defaultMiniPosition(mini);
  } else {
    return;
  }

  mini.style.left = `${position.x}px`;
  mini.style.top = `${position.y}px`;
  mini.style.right = 'auto';
  mini.style.bottom = 'auto';
}

/**
 * 小播放器总开关：关掉之后，即使还在放歌、即使来回切界面，都不再冒出来，
 * 直到用户在设置或点歌台里重新打开。默认开着。
 */
const MINI_ENABLED_KEY = 'vela:mini-enabled';

function isMiniEnabled() {
  try {
    return localStorage.getItem(MINI_ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

function setMiniEnabled(enabled) {
  try {
    localStorage.setItem(MINI_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    /* 可选记忆 */
  }
  const mini = document.querySelector('#mini-player');
  if (!enabled && mini) {
    mini.hidden = true;
    mini.style.setProperty('display', 'none', 'important');
  }
  updateSongChrome();
  if (enabled) requestAnimationFrame(() => applyMiniPosition(mini));
}

/** 窄条 / 展开卡片 的形态记忆，默认收成窄条。 */
const MINI_EXPANDED_KEY = 'vela:mini-expanded';

/**
 * 展开前那一刻窄条所在的左上角坐标。
 *
 * 收起时回到这里，才是用户说的「按原位收缩」。
 * 之前拿展开卡片的左上角当锚点，而卡片比窄条宽一圈、高一截，
 * 收起后窄条就贴在卡片的左上角上 —— 看起来就是「往左上缩了一下」。
 */
let miniExpandOrigin = null;

function isMiniExpanded() {
  try {
    return localStorage.getItem(MINI_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

function setMiniExpanded(expanded) {
  const mini = document.querySelector('#mini-player');
  if (!mini) return;
  const before = mini.getBoundingClientRect();
  const wasExpanded = !mini.classList.contains('is-chip');
  if (expanded && !wasExpanded) {
    // 记住窄条现在的位置，收起时原样回去（用户要的「按原位收缩」）
    miniExpandOrigin = { x: before.left, y: before.top };
    delete mini.dataset.draggedSinceExpand;
  }
  mini.classList.toggle('is-chip', !expanded);
  try {
    localStorage.setItem(MINI_EXPANDED_KEY, expanded ? '1' : '0');
  } catch {
    /* 可选记忆 */
  }
  // 形态变化后尺寸不同，重新夹回可视区
  requestAnimationFrame(() => {
    /*
     * 从展开卡片收回窄条：优先回到展开前那个位置；
     * 如果展开期间用户把卡片拖走了，就以卡片中心为锚点收，
     * 这样视觉上也是「原地缩小」，而不是飘到某个角上。
     */
    if (!expanded && wasExpanded) {
      // 启动页收起：直接嵌回抽屉标题行的槽里，别让窄条飘在固定定位上
      if (state.route === 'start') {
        miniExpandOrigin = null;
        delete mini.dataset.draggedSinceExpand;
        // 「收起」同时也是归位：被拖出过抽屉的窄条回到标题行里
        delete mini.dataset.freePos;
        try {
          localStorage.removeItem(miniPosKey());
        } catch {
          /* 位置记忆是可选的 */
        }
        positionStartMini(mini);
        return;
      }
      mini.classList.remove('is-docked');
      const dragged = mini.dataset.draggedSinceExpand === '1';
      const width = mini.offsetWidth || 214;
      const height = mini.offsetHeight || 52;
      const target =
        miniExpandOrigin && !dragged
          ? { x: miniExpandOrigin.x, y: miniExpandOrigin.y }
          : {
              x: before.left + before.width / 2 - width / 2,
              y: before.top + before.height / 2 - height / 2,
            };
      const anchored = clampMiniPosition(mini, target.x, target.y);
      mini.style.left = `${anchored.x}px`;
      mini.style.top = `${anchored.y}px`;
      mini.style.right = 'auto';
      mini.style.bottom = 'auto';
      miniExpandOrigin = null;
      delete mini.dataset.draggedSinceExpand;
      try {
        localStorage.setItem(
          miniPosKey(),
          JSON.stringify({ x: Math.round(anchored.x), y: Math.round(anchored.y) })
        );
      } catch {
        /* 位置持久化是可选的 */
      }
      return;
    }
    /*
     * 启动页展开：chip 原本内嵌在抽屉标题行右侧的槽里（position: static !important），
     * 直接去掉 is-chip 只会让卡片卡在槽内被 overflow 裁掉、看起来「没弹出来」。
     * 这里把 mini 挪回 body，改成固定定位，再按 chip 右下角锚点算位置。
     *
     * 注意别再用 CSS 的 right/bottom 钉死右下角：那正是卡片压在
     * 「开始游戏」面板上的原因，位置统一交给 positionStartMiniCard 避让。
     */
    if (expanded && state.route === 'start') {
      if (mini.parentElement !== document.body) document.body.appendChild(mini);
      [
        'position',
        'left',
        'right',
        'top',
        'bottom',
        'width',
        'max-width',
        'margin',
        'transform',
        'display',
      ].forEach((prop) => mini.style.removeProperty(prop));
      positionStartMiniCard(mini, {
        x: before.left,
        y: before.top,
        w: before.width,
        h: before.height,
      });
      return;
    }
    const rect = mini.getBoundingClientRect();
    const position = clampMiniPosition(mini, rect.left, rect.top);
    mini.style.left = `${position.x}px`;
    mini.style.top = `${position.y}px`;
    mini.style.right = 'auto';
    mini.style.bottom = 'auto';
    if (expanded) {
      const volume = mini.querySelector('#mini-volume');
      if (volume) volume.value = String(state.songVolume);
    }
  });
}

/** 启动页底部抽屉展开时，小球跟着抬高。 */
function setupStartDrawerSync() {
  const drawer = document.querySelector('.start-games');
  const mini = document.querySelector('#mini-player');
  if (!drawer || drawer.dataset.syncBound === '1') return;
  drawer.dataset.syncBound = '1';
  const sync = () => {
    const open = drawer.matches(':hover') || drawer.matches(':focus-within');
    // body 级联动：展开时左下任务面板 / 右下开始面板整体让路（CSS 接手），
    // 否则这两个浮层会压在抽屉的游戏卡片上，排后面的游戏点不到。
    document.body.classList.toggle('drawer-open', open);
    if (mini) mini.classList.toggle('drawer-open', open);
    // 展开形态已挪到 body 固定定位，别在抽屉 hover 时把它拽回槽里
    if (mini && mini.classList.contains('is-on-start') && !isMiniExpanded()) positionStartMini(mini);
  };
  drawer.addEventListener('mouseenter', sync);
  drawer.addEventListener('mouseleave', sync);
  drawer.addEventListener('focusin', sync);
  drawer.addEventListener('focusout', () => setTimeout(sync, 60));
}

/**
 * 启动页抽屉的游戏列表导轨：左右翻页箭头 + 滚轮横滚。
 *
 * 游戏多了以后一行放不下，列表本身能横向滚（滚动条特意藏了），
 * 但没有可见的翻页入口，排在后面的游戏「看不到」。这里补两个箭头：
 * - 箭头按滚动位置自动显隐（到头的一侧不显示）；
 * - 鼠标滚轮在列表上直接横向滚，不用按住 Shift。
 */
function setupStartGameRail() {
  const rail = document.querySelector('.start-game-rail');
  const list = rail?.querySelector('.start-game-list');
  if (!rail || !list || rail.dataset.railBound === '1') return;
  rail.dataset.railBound = '1';
  const prev = rail.querySelector('.start-game-nav.is-prev');
  const next = rail.querySelector('.start-game-nav.is-next');
  const step = () => Math.max(list.clientWidth * 0.65, 320);
  const sync = () => {
    const max = list.scrollWidth - list.clientWidth;
    rail.classList.toggle('is-at-start', list.scrollLeft <= 4);
    rail.classList.toggle('is-at-end', list.scrollLeft >= max - 4);
  };
  prev?.addEventListener('click', () => list.scrollBy({ left: -step(), behavior: 'smooth' }));
  next?.addEventListener('click', () => list.scrollBy({ left: step(), behavior: 'smooth' }));
  list.addEventListener(
    'wheel',
    (event) => {
      // 触控板横向手势原生就有，只接管纵向滚轮；deltaX 为主时别画蛇添足
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (list.scrollWidth <= list.clientWidth) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    },
    { passive: false }
  );
  list.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
  sync();
}

/**
 * 启动页：把小播放器直接挂进「选择游戏」标题行右边的槽里。
 *
 * 不用固定定位、也不用算坐标 —— 它就是标题行里的一个子元素，抽屉收起 / 展开、
 * 窗口缩放都交给 flex 布局自己处理。挂在抽屉内部还有个好处：鼠标停在窄条上时
 * 抽屉仍然算被 hover，不会因为指到窄条就把抽屉收回去。
 */
/**
 * 启动页：窄条被用户拖出抽屉之后的位置。
 *
 * 位置就存在 vela:mini-pos:start 里（end() 拖动结束时写的），
 * 这里只负责把它按固定定位贴回去。启动页收起一次就会归位到抽屉槽里。
 */
function applyStartFreePosition(mini) {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(miniPosKey()) || 'null');
  } catch {
    saved = null;
  }
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return;
  /*
   * 自由位置是浮层，必须先脱离抽屉标题行那个槽。
   *
   * #start-mini-slot 上是 `display:inline-flex; max-height:30px`，
   * 留在槽里的展开卡会被直接压成一条 30px 高的缝 —— 看起来就是
   * 「点了展开，启动页上什么都没有」。用户拖过一次（freePos=1）之后
   * 每次回启动页都走这里，所以现象是「有时候」不显示。
   */
  if (mini.parentElement !== document.body) document.body.appendChild(mini);
  const pos = clampMiniPosition(mini, saved.x, saved.y);
  mini.style.setProperty('position', 'fixed', 'important');
  mini.style.setProperty('left', `${pos.x}px`, 'important');
  mini.style.setProperty('top', `${pos.y}px`, 'important');
  mini.style.setProperty('right', 'auto', 'important');
  mini.style.setProperty('bottom', 'auto', 'important');
  mini.style.setProperty('width', 'auto', 'important');
  mini.style.setProperty('max-width', '420px', 'important');
  // 槽里的 30px 上限不能再作用到浮层上
  mini.style.setProperty('max-height', 'none', 'important');
  mini.style.setProperty('margin', '0', 'important');
  mini.style.setProperty('transform', 'none', 'important');
  mini.style.setProperty('display', 'flex', 'important');
}

function positionStartMini(mini = document.querySelector('#mini-player')) {
  if (!mini) return;
  const slot = document.querySelector('#start-mini-slot');
  if (!slot) return;
  // 用户自己把它从槽里拖出来了：尊重拖出来的位置，别再塞回抽屉标题行
  if (mini.dataset.freePos === '1') {
    applyStartFreePosition(mini);
    return;
  }
  if (mini.parentElement !== slot) slot.appendChild(mini);
  // 历史样式里有 #mini-player.mini-player { position: fixed; right: 28px; bottom: 96px }
  // 特异性很高，光靠 class 覆盖不掉，直接写内联最稳。
  // 用 important 写内联：后面的 applyMiniPosition 想改也改不动
  mini.style.setProperty('position', 'static', 'important');
  mini.style.setProperty('left', 'auto', 'important');
  mini.style.setProperty('right', 'auto', 'important');
  mini.style.setProperty('top', 'auto', 'important');
  mini.style.setProperty('bottom', 'auto', 'important');
  mini.style.setProperty('width', 'auto', 'important');
  mini.style.setProperty('max-width', '420px', 'important');
  mini.style.setProperty('margin', '0', 'important');
  mini.style.setProperty('transform', 'none', 'important');
  mini.style.setProperty('display', 'flex', 'important');
}

/** 离开启动页：挪回 body，恢复固定定位。 */
function unmountStartMini(mini = document.querySelector('#mini-player')) {
  if (!mini) return;
  if (mini.parentElement !== document.body) document.body.appendChild(mini);
  [
    'position',
    'left',
    'right',
    'top',
    'bottom',
    'width',
    'max-width',
    'margin',
    'transform',
    'display',
  ].forEach((prop) => mini.style.removeProperty(prop));
}

/**
 * 把展开的小播放器卡片推开，别压住右下角的「开始游戏」面板。
 *
 * 这两个浮层都在右下角，卡片一展开就整块盖住开始游戏那一带（服务器列表 +
 * 开始按钮），而且卡片挂着 z-index 80、比面板高，盖上去就点不着。
 * 这里量一次面板矩形：相交就往上抬到面板之上；窗口太矮抬不动，就往左错开。
 */
function avoidStartDock(mini, x, y) {
  const dock = document.querySelector('.start-dock');
  if (!dock) return { x, y };
  const gap = 12;
  const w = mini.offsetWidth || 320;
  const h = mini.offsetHeight || 200;
  const d = dock.getBoundingClientRect();
  const overlap =
    x < d.right + gap && x + w > d.left - gap && y < d.bottom + gap && y + h > d.top - gap;
  if (!overlap) return { x, y };
  // 优先往上抬（启动页上方是空的）
  const lifted = d.top - gap - h;
  if (lifted >= 8) return { x, y: lifted };
  // 抬不动就贴到面板左侧，让出整个右下角
  const shifted = d.left - gap - w;
  if (shifted >= 8) return { x: shifted, y };
  return { x, y };
}

/**
 * 启动页：展开卡片的定位。
 *
 * origin 传窄条（chip）的矩形，卡片以它的右下角为锚点向左上生长；
 * 不传就按卡片当前矩形算（窗口缩放时保持原位、只重新避让）。
 */
function positionStartMiniCard(mini = document.querySelector('#mini-player'), origin) {
  if (!mini) return;
  const chip = origin || null;
  const anchorX = chip ? chip.x + chip.w : window.innerWidth - 34;
  const anchorY = chip ? chip.y + chip.h : window.innerHeight - 92;
  const w = mini.offsetWidth || 320;
  const h = mini.offsetHeight || 200;
  const spot = avoidStartDock(mini, anchorX - w, anchorY - h);
  const pos = clampMiniPosition(mini, spot.x, spot.y);
  // 用 important 写内联：历史 CSS 里有几处 right/bottom !important，普通内联压不住
  mini.style.setProperty('position', 'fixed', 'important');
  mini.style.setProperty('left', `${pos.x}px`, 'important');
  mini.style.setProperty('top', `${pos.y}px`, 'important');
  mini.style.setProperty('right', 'auto', 'important');
  mini.style.setProperty('bottom', 'auto', 'important');
}

/** 侧栏宽度有过渡动画，收起/展开后隔一拍再贴一次。 */
function repositionDockedMini() {
  const mini = document.querySelector('#mini-player');
  if (!mini || mini.hidden || !mini.classList.contains('is-docked')) return;
  requestAnimationFrame(() => applyMiniPosition(mini));
  setTimeout(() => applyMiniPosition(mini), 320);
}

function setupMiniPlayer() {
  const mini = document.querySelector('#mini-player');
  if (!mini) return;

  /* 音量与音效控件每次都重新绑定（迷你播放器可能被重建） */
  const miniVolume = document.querySelector('#mini-volume');
  if (miniVolume && miniVolume.dataset.bound !== '1') {
    miniVolume.dataset.bound = '1';
    miniVolume.value = String(state.songVolume);
    miniVolume.addEventListener('input', () => setSongVolume(miniVolume.value));
  }
  const miniFx = mini.querySelector('[data-action="open-audio-fx"]');
  if (miniFx) miniFx.classList.toggle('active', state.audioFx.preset !== 'off');
  syncVolumeUi();

  if (mini.dataset.dragReady === '1') {
    applyMiniPosition(mini);
    return;
  }
  mini.dataset.dragReady = '1';
  applyMiniPosition(mini);

  /*
   * 可拖区域：窄条 / 展开卡的把手和标题，以及面板顶栏空白。
   *
   * 以前这里用 querySelector 只取到第一个 [data-mini-drag]，恰好就是 #mini-chip，
   * 展开卡上那个写着「按住拖动到任意位置」的手柄从来没被绑上 ——
   * 用户抓着它拖，一点反应都没有（这就是「迷你播放器拖不动」的直接原因）。
   * 另外启动页的窄条是嵌在抽屉标题行里的 static 子元素，也要在按下时先脱离出来。
   */
  const handles = [
    ...new Set(
      [
        ...mini.querySelectorAll('[data-mini-drag]'),
        mini.querySelector('.mini-copy'),
        mini.querySelector('.mini-panel-head'),
      ].filter(Boolean)
    ),
  ];

  let drag = null;
  let moved = false;
  let dragRaf = 0;
  let dragNext = null;

  /*
   * 启动页的窄条嵌在抽屉标题行的槽里（static + 内联 important），
   * 位置由 flex 决定，光靠写 left/top 拖不动 —— 得先挪回 body 钉成 fixed。
   *
   * 但这步必须等「确认在拖」才做：在 pointerdown 里就 appendChild，
   * 节点在按下瞬间被搬走，浏览器认为 mousedown / mouseup 的目标不同，
   * 后续 click 直接不派发 —— 表现就是窄条上的「展开 / 播放 / 下一首」
   * 全部点不动。所以按下时只记录位置，位移超过 3px 才调用这里。
   */
  const detachForDrag = () => {
    if (!drag || drag.pinned) return;
    const { rect } = drag;
    if (mini.parentElement !== document.body) {
      document.body.appendChild(mini);
      ['position', 'left', 'right', 'top', 'bottom', 'width', 'max-width', 'margin', 'transform', 'display'].forEach(
        (prop) => mini.style.removeProperty(prop)
      );
    }
    mini.style.setProperty('position', 'fixed', 'important');
    mini.style.setProperty('left', `${rect.left}px`, 'important');
    mini.style.setProperty('top', `${rect.top}px`, 'important');
    mini.style.setProperty('right', 'auto', 'important');
    mini.style.setProperty('bottom', 'auto', 'important');
    mini.style.setProperty('transform', 'none', 'important');
    drag.pinned = true;
    drag.baseX = rect.left;
    drag.baseY = rect.top;
    // 脱槽后宽高可能变（窄条形态的尺寸是槽给的），边界夹紧用新的
    drag.size = { w: mini.offsetWidth || rect.width, h: mini.offsetHeight || rect.height };
  };

  /*
   * 拖动时的位移走 transform，不动 left/top。
   *
   * left/top 是布局属性：每写一次浏览器就要重新排版，卡片又带 backdrop-filter
   * 大阴影，一帧一次重排 + 重绘就足以让指针和卡片明显脱节（用户体感是
   * 「拖半天才挪一点」）。transform 走合成层，只重绘不重排，跟手。
   * 松手时再把位移落回 left/top（见 end），免得后续 clamp / 归位全部偏一个位移量。
   */
  const paintDrag = () => {
    dragRaf = 0;
    if (!drag || !dragNext) return;
    const { x, y } = dragNext;
    dragNext = null;
    drag.lastX = x;
    drag.lastY = y;
    mini.style.setProperty(
      'transform',
      `translate3d(${x - drag.baseX}px, ${y - drag.baseY}px, 0)`,
      'important'
    );
  };

  const move = (event) => {
    if (!drag) return;
    if (!moved) {
      const dx = Math.abs(event.clientX - drag.startX);
      const dy = Math.abs(event.clientY - drag.startY);
      if (dx < 3 && dy < 3) return;
      moved = true;
      // 确认是「拖」了才脱槽 + 捕获指针，见 startDrag 顶部注释
      detachForDrag();
      try {
        if (drag?.handle) drag.handle.setPointerCapture(drag.pointerId);
      } catch {
        /* 老内核不支持，window 上的监听兜住 */
      }
      // 真的拖动了才算「用户自己放的位置」，重绘后别再塞回抽屉
      if (state.route === 'start') mini.dataset.freePos = '1';
      mini.classList.add('dragging');
    }
    // 尺寸用按下时量好的那份，别在 move 里读 offsetWidth（读 = 强制同步布局）
    dragNext = clampMiniPosition(
      mini,
      event.clientX - drag.offsetX,
      event.clientY - drag.offsetY,
      drag.size
    );
    if (!dragRaf) dragRaf = requestAnimationFrame(paintDrag);
  };

  const end = () => {
    if (!drag) return;
    const wasMoved = moved;
    const finished = drag;
    drag = null;
    moved = false;
    if (dragRaf) {
      cancelAnimationFrame(dragRaf);
      dragRaf = 0;
    }
    dragNext = null;
    if (finished.pointerId !== undefined && finished.handle) {
      try {
        finished.handle.releasePointerCapture(finished.pointerId);
      } catch {
        /* 指针已经释放 */
      }
    }
    mini.classList.remove('dragging');
    mini.style.cursor = '';
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('blur', end);
    if (!wasMoved) {
      /* 没拖动只是点了一下。只有按下时真被钉成 fixed 过才需要清 transform；
         嵌在启动页槽里的窄条一个字都别碰，否则会把槽里的内联样式抹掉。 */
      if (finished.pinned) mini.style.removeProperty('transform');
      return;
    }
    const lastX = Number.isFinite(finished.lastX) ? finished.lastX : finished.baseX;
    const lastY = Number.isFinite(finished.lastY) ? finished.lastY : finished.baseY;
    mini.style.removeProperty('transform');
    mini.style.setProperty('left', `${Math.round(lastX)}px`, 'important');
    mini.style.setProperty('top', `${Math.round(lastY)}px`, 'important');
    mini.style.setProperty('right', 'auto', 'important');
    mini.style.setProperty('bottom', 'auto', 'important');
    mini.dataset.justDragged = '1';
    // 展开状态下拖过：收起时就不能再回到展开前的老位置了，改按卡片中心收
    if (!mini.classList.contains('is-chip')) mini.dataset.draggedSinceExpand = '1';
    window.setTimeout(() => delete mini.dataset.justDragged, 260);
    try {
      localStorage.setItem(
        miniPosKey(),
        JSON.stringify({ x: Math.round(lastX), y: Math.round(lastY) })
      );
    } catch {
      /* position persistence is optional */
    }
  };

  const startDrag = (event, handle) => {
    if (event.button !== 0) return;
    /*
     * 缩起来的窄条整体都能拖 —— 包括里面的「展开 / 播放 / 下一首」按钮。
     *
     * 那条只有 30px 高、按钮又把宽度占满，如果按在按钮上就不算拖，
     * 用户只在按钮之间的缝里拖得动，体感就是「时不时能拖」。现在纯点击
     * 不会被吞（pointerdown 不捕获、不搬节点，没越 3px 就把 click 原样
     * 交给按钮），所以放开是安全的：按住不动 = 点击，按住移动 = 拖。
     *
     * 展开卡里则相反：按钮和滑块各有各的用处，只有握把 / 标题 / 空白能拖。
     */
    if (event.target.closest('input, select, textarea')) return;
    const inChip = Boolean(event.target.closest('#mini-chip'));
    const control = event.target.closest('button, a, [data-action]');
    if (control && !inChip && !control.hasAttribute('data-mini-drag') && !control.classList.contains('mini-copy')) {
      return;
    }
    const rect = mini.getBoundingClientRect();
    /*
     * 只在已经在 body 里时才立刻钉成 fixed 并接管 left/top（这一层本来就是浮层，
     * 不会有 click 被搬家吞掉的问题）。嵌在启动页槽里的窄条保持原样，
     * 等 move() 确认真的在拖再脱槽 —— 见 detachForDrag。
     */
    const pinned = mini.parentElement === document.body;
    if (pinned) {
      mini.style.setProperty('position', 'fixed', 'important');
      mini.style.setProperty('left', `${rect.left}px`, 'important');
      mini.style.setProperty('top', `${rect.top}px`, 'important');
      mini.style.setProperty('right', 'auto', 'important');
      mini.style.setProperty('bottom', 'auto', 'important');
      mini.style.setProperty('transform', 'none', 'important');
    }
    drag = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      rect,
      pinned,
      baseX: rect.left,
      baseY: rect.top,
      size: { w: rect.width, h: rect.height },
      handle,
      pointerId: event.pointerId,
      lastX: rect.left,
      lastY: rect.top,
    };
    moved = false;
    dragNext = null;
    /*
     * 捕获指针要等确认在拖之后（move 里做）：不捕获时手一快把指针甩出窗口，
     * pointermove / pointerup 就收不到，卡片停在半路 —— 这是「很难才拖过来」。
     * 但如果在 pointerdown 就捕获，click 的 target 会被改写成捕获元素，
     * 按钮上的 data-action 全部失效，所以必须延后。
     */
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
  };

  for (const handle of handles) {
    handle.addEventListener('pointerdown', (event) => startDrag(event, handle));
  }

  /*
   * 卡片空白处（按钮之间、控制区边缘）也能拖：可拖区域越小越难拖中，
   * 之前实际只有 20px 宽的那个握把，难怪「很难才拖过来」。
   * 按钮 / 滑块 / 链接上的按下仍交给它们自己处理。
   */
  mini.addEventListener('pointerdown', (event) => {
    if (drag) return;
    if (event.target.closest('button, input, select, textarea, a, [data-action]')) return;
    startDrag(event, mini);
  });

  /* 拖动后不要误触「打开点歌台」 */
  // 拖动过后屏蔽紧接着的那次 click，避免「拖完球突然展开」
  mini.addEventListener(
    'click',
    (event) => {
      if (mini.dataset.justDragged !== '1') return;
      const draggable = event.target.closest('[data-mini-drag]') ||
        event.target.closest('.mini-copy') ||
        event.target.closest('#mini-chip');
      if (draggable) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  window.addEventListener('resize', () => {
    // 侧栏推开的那 180ms 里，窗口宽度每帧都在变。这里跟着每帧量一次矩形、再写一次
    // left/top，等于每帧强制同步布局 —— 画面正好在这时候卡。收尾补一次就够了。
    if (startNavAnimating()) return;
    if (mini.hidden) return;
    if (mini.classList.contains('is-on-start')) {
      // 窄条跟着抽屉标题行走；展开卡片是固定定位，窗口变了要重新避让开始面板
      if (!isMiniExpanded()) {
        positionStartMini(mini);
        return;
      }
      const rect = mini.getBoundingClientRect();
      positionStartMiniCard(mini, { x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      return;
    } else if (mini.classList.contains('is-docked')) {
      // 停靠态跟着侧栏走，窗口变化后重新贴一次，别只是夹紧在旧坐标上
      applyMiniPosition(mini);
      return;
    }
    if (!mini.hidden) {
      const rect = mini.getBoundingClientRect();
      const position = clampMiniPosition(mini, rect.left, rect.top);
      mini.style.left = `${position.x}px`;
      mini.style.top = `${position.y}px`;
      mini.style.right = 'auto';
      mini.style.bottom = 'auto';
    }
  });
}

function updateSongChrome() {
  const audio = document.querySelector('#song-audio');
  const mini = document.querySelector('#mini-player');
  const song = currentSongEntry();
  if (!audio || !mini) return;
  applyPlayModeUi();
  const playing = Boolean(audio.src && !audio.paused);
  // 总开关关掉时，就算是正在放歌也不显示（否则切一次界面它又自己冒出来）
  const visible = isMiniEnabled() && Boolean(audio.src) && state.route !== 'song';
  mini.hidden = !visible;
  if (visible) mini.style.removeProperty('display');
  else mini.style.setProperty('display', 'none', 'important');
  if (!visible) {
    // 没在放歌时把启动页形态也摘掉，免得 hidden 了窄条还挂着
    mini.classList.remove('is-start-chip');
    mini.classList.remove('is-on-start');
  }

  if (visible) {
    const onStart = state.route === 'start';
    // 收起形态统一成窄条：启动页嵌在「选择游戏」右边，其它页面停靠在侧栏上
    mini.classList.toggle('is-on-start', onStart);
    // 启动页展开形态是 body 固定定位的浮卡，不能再挂 is-start-chip（其 CSS 是 position:static）
    mini.classList.toggle('is-start-chip', onStart && !isMiniExpanded());
    mini.classList.toggle('is-chip', !isMiniExpanded());
    mini.classList.remove('is-chip');
    if (!isMiniExpanded()) mini.classList.add('is-chip');

    if (onStart) {
      // 启动页：收起形态由 positionStartMini 内嵌在抽屉标题行右侧的槽里；
      // 展开形态已经由 setMiniExpanded 挪到 body 固定定位，别再用 positionStartMini 拽回去
      mini.dataset.wasOnStart = '1';
      if (!isMiniExpanded()) {
        positionStartMini(mini);
      } else {
        // 开始面板会变高变矮（比如切到「更新游戏」/ 多一行进度），隔一拍再避让一次，
        // 免得重绘后两者又叠在一起
        requestAnimationFrame(() => {
          if (mini.hidden || !isMiniExpanded() || state.route !== 'start') return;
          const rect = mini.getBoundingClientRect();
          positionStartMiniCard(mini, { x: rect.left, y: rect.top, w: rect.width, h: rect.height });
        });
      }
    } else {
      /*
       * 只有「真的从启动页切出来」这一次才丢弃原位锚点。
       * 之前这里无条件清空，而 updateSongChrome 每次渲染 / 每次播放状态变化都会跑，
       * 结果展开时刚记下的原位立刻被抹掉，收起只能走「按卡片中心缩」的兜底 ——
       * 表现就是「展开再收起，没回到原来的位置」。
       */
      const cameFromStart = mini.dataset.wasOnStart === '1';
      unmountStartMini(mini);
      if (cameFromStart) {
        // 离开启动页：启动页槽里的坐标不能再用于主页
        miniExpandOrigin = null;
        delete mini.dataset.draggedSinceExpand;
        delete mini.dataset.wasOnStart;
      }
      if (!mini.hidden) {
        // 离开启动页：清掉启动页留下的内联定位，交回按场景记忆的位置
        ['position', 'left', 'right', 'top', 'bottom', 'width'].forEach((prop) =>
          mini.style.removeProperty(prop)
        );
      }
    }
  }

  setupMiniPlayer();
  if (visible) requestAnimationFrame(() => applyMiniPosition(mini));
  if (visible && song) {
    const title = document.querySelector('#mini-title');
    const artist = document.querySelector('#mini-artist');
    const cover = mini.querySelector('.mini-cover');
    if (title) title.textContent = song.title || '未命名歌曲';
    if (artist) artist.textContent = song.artist || '音乐';
    if (cover) {
      const image = songCover(song);
      cover.style.backgroundImage = image ? `url("${image.replace(/"/g, '')}")` : '';
      cover.classList.toggle('has-cover', Boolean(image));
    }
    const toggle = document.querySelector('#mini-play-use');
    if (toggle) toggle.setAttribute('href', playing ? '#i-pause' : '#i-play');
    syncVolumeUi();
    const fill = document.querySelector('#mini-progress-fill');
    if (fill && Number.isFinite(audio.duration) && audio.duration > 0) {
      fill.style.width = `${Math.min(100, (audio.currentTime / audio.duration) * 100)}%`;
    }

    /* 启动页窄条：封面 + 歌名 + 播放键 */
    const chipCover = document.querySelector('#mini-chip-cover');
    if (chipCover) {
      const image = songCover(song);
      chipCover.style.backgroundImage = image ? `url("${image.replace(/"/g, '')}")` : '';
      chipCover.classList.toggle('has-cover', Boolean(image));
    }
    const chipTitle = document.querySelector('#mini-chip-title');
    if (chipTitle) chipTitle.textContent = song.title || '未命名歌曲';
    const chipArtist = document.querySelector('#mini-chip-artist');
    if (chipArtist) chipArtist.textContent = song.artist || '音乐';
    const chipPlay = document.querySelector('#mini-chip-play-use');
    if (chipPlay) chipPlay.setAttribute('href', playing ? '#i-pause' : '#i-play');
  }

  const progress = document.querySelector('#song-progress');
  if (progress && Number.isFinite(audio.duration) && audio.duration > 0) {
    const ratio = Math.min(1, Math.max(0, audio.currentTime / audio.duration));
    progress.value = String(Math.round(ratio * 1000));
    /*
     * 进度条已经改成自绘（appearance:none + 渐变轨道），原生那条「已播放」上色
     * 没有了，进度靠这个自定义属性画：滑块和填充从此严格在同一条线上。
     */
    progress.style.setProperty('--song-progress', `${(ratio * 100).toFixed(2)}%`);
  }
  const current = document.querySelector('#song-current');
  if (current) current.textContent = formatSongTime(audio.currentTime);
  const duration = document.querySelector('#song-duration');
  if (duration) duration.textContent = formatSongTime(audio.duration);
  if (song) {
    const dockTitle = document.querySelector('#dock-title');
    const dockNowTitle = document.querySelector('#dock-now-title');
    const dockArtist = document.querySelector('#dock-now-artist');
    const dockIcon = document.querySelector('#dock-play-use');
    if (dockTitle) dockTitle.textContent = song.title || '未播放';
    if (dockNowTitle) dockNowTitle.textContent = song.title || '未播放';
    if (dockArtist) dockArtist.textContent = song.artist || '';
    if (dockIcon) dockIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
  }

  /* 主页双人卡（火花 · 音乐遥控）：同步歌名和播放键图标，不用整页重绘 */
  const duoTitle = document.querySelector('#duo-song-title');
  if (duoTitle) duoTitle.textContent = song ? song.title || '未知曲目' : '队列空着，去点歌';
  document.querySelectorAll('.duo-ctrl[data-action="duo-toggle"] .duo-ic').forEach((node) => {
    const wantPlay = node.dataset.when === 'play';
    node.hidden = wantPlay === playing;
  });
}

/**
 * 歌词容器要滚到哪，才能让这一句停在竖直中间。
 *
 * 单独抽出来是为了能测：它只认 rect 和 scroll 尺寸，和 offsetParent 无关。
 * 用 offsetTop 的老写法在容器没有 position 时会按整页算，目标永远超出可滚范围，
 * 浏览器一律夹到最底部 —— 现象就是歌词卡在最后一行不动。
 */
function lyricScrollTop(box, line) {
  const boxRect = box.getBoundingClientRect();
  const lineRect = line.getBoundingClientRect();
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  const target =
    (box.scrollTop || 0) + (lineRect.top - boxRect.top) - (box.clientHeight - lineRect.height) / 2;
  return Math.min(max, Math.max(0, target));
}

function bindSongLyrics() {
  const audio = document.querySelector('#song-audio');
  if (!audio) return;
  if (audio.dataset.chromeBound !== '1') {
    audio.dataset.chromeBound = '1';
    audio.addEventListener('timeupdate', updateSongChrome);
    audio.addEventListener('loadedmetadata', updateSongChrome);
    audio.addEventListener('play', updateSongChrome);
    audio.addEventListener('pause', updateSongChrome);
    // 每秒记一次播放进度；暂停时立即记一次
    audio.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - (audio.dataset.progressAt || 0) < 1000) return;
      audio.dataset.progressAt = String(now);
      saveSongProgress();
    });
    audio.addEventListener('pause', saveSongProgress);
    audio.addEventListener('ended', updateSongChrome);
    audio.addEventListener('ended', () => {
      void handleSongEnded();
    });
    /*
     * 播不了（404 / 403 / 地址过期 / 音源失效）时 audio 只报 error，不会有 ended，
     * 以前这里没人管，队列就永远停在这一首。现在和超时一起走失败收口。
     */
    audio.addEventListener('error', () => {
      void handleSongFailed(describeAudioError(audio));
    });
    // 真的出声了：摘掉超时判定，清掉连续失败计数，顺手把这首的不可用标记洗掉
    audio.addEventListener('playing', () => {
      clearSongLoadWatchdog();
      songFailStreak = 0;
      const song = currentSongEntry();
      if (song?.unavailable) {
        song.unavailable = false;
        delete song.unavailableReason;
        saveSongs();
      }
    });
  }
  if (audio.dataset.fxErrorBound !== '1') {
    audio.dataset.fxErrorBound = '1';
    audio.addEventListener('error', () => {
      if (state.audioFx.preset !== 'off') disableAudioFxOnError();
    });
    audio.addEventListener('playing', () => clearFxWatchdog());
    audio.addEventListener('pause', () => clearFxWatchdog());
    audio.addEventListener('play', () => {
      if (state.audioFx.preset === 'off' || audioFxFallback) return;
      const graph = ensureAudioFxGraph(audio);
      if (graph && graph.context.state === 'suspended') graph.context.resume().catch(() => {});
      armFxWatchdog(audio);
    });
  }

  const progress = document.querySelector('#song-progress');
  if (progress) {
    progress.addEventListener('input', () => {
      if (audio.duration) audio.currentTime = (Number(progress.value) / 1000) * audio.duration;
    });
  }
  const quality = document.querySelector('#song-quality');
  if (quality) {
    quality.addEventListener('change', () => changeSongQuality(quality.value));
  }
  const dockQuality = document.querySelector('#dock-quality');
  if (dockQuality) {
    dockQuality.addEventListener('change', () => changeSongQuality(dockQuality.value));
  }
  const songMode = document.querySelector('#song-mode');
  if (songMode) {
    songMode.addEventListener('change', () => setPlayMode(songMode.value));
  }
  const dockMode = document.querySelector('#dock-play-mode');
  if (dockMode) {
    dockMode.addEventListener('change', () => setPlayMode(dockMode.value));
  }
  const box = document.querySelector('#song-lyrics');
  if (!box) {
    updateSongChrome();
    return;
  }
  const lines = [...box.querySelectorAll('.song-lyric-line')];
  /*
   * 重绘前用户是不是关掉了自动跟随（手动滚过歌词）。
   * 这是跨 render 保留的状态，否则每切一次界面就又自动滚了。
   */
  if (lyricFollowPaused && box.dataset.followPaused !== '1') {
    box.dataset.followPaused = '1';
  }
  let lastIndex = -1;
  let programmaticScroll = false;
  let resumeTimer = 0;

  /*
   * 把某一句滚到容器竖直中间。
   *
   * 这里必须用 getBoundingClientRect 的差值，不能用 line.offsetTop：
   * offsetTop 量的是「离最近的定位祖先」有多远，而歌词容器本身没有 position，
   * 一路找到 body 去了 —— 目标值多算了一个页头的高度，永远超出可滚范围、
   * 被浏览器夹到最底部。表现就是「一开始播就卡在最后一行，之后再也不动」。
   * rect 差值和 offsetParent 无关，容器嵌多深都对。
   */
  const centerOn = (line) => {
    programmaticScroll = true;
    /*
     * .song-lyrics 上有 scroll-behavior:smooth，而 timeupdate 每 ~250ms 就来一次，
     * 平滑动画会被反复打断重来 —— 直接 instant 落到目标位置才跟得住。
     */
    box.scrollTo({ top: lyricScrollTop(box, line), behavior: 'instant' });
    // scroll 事件在下一帧的 scroll steps 里才派发，等它走完再放开标记
    requestAnimationFrame(() => {
      programmaticScroll = false;
    });
  };

  const setActive = () => {
    const current = audio.currentTime || 0;
    let index = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (Number(lines[i].dataset.time) <= current) index = i;
      else break;
    }
    if (index === lastIndex) return;
    lines.forEach((line, i) => line.classList.toggle('active', i === index));
    lastIndex = index;
    if (index < 0) return;
    // 用户刚手动滚过就暂时别抢他的滚动位置
    if (box.dataset.followPaused === '1') return;
    centerOn(lines[index]);
  };

  /*
   * 用户自己滚歌词 → 暂停跟随；停下来 2.5 秒自动接回来。
   *
   * 以前是「滚过一次就永久暂停，只有滚到最底部才恢复」，而且 wheel 一碰就暂停：
   * 鼠标停在歌词上滚页面时会同时命中这个 wheel，整首歌从此不再跟唱 ——
   * 用户看到的就是「歌词不会自动向下滚」。改成只认真正的 scroll，
   * 而且过一会儿自己接回来。
   */
  const onScroll = () => {
    if (programmaticScroll) return;
    box.dataset.followPaused = '1';
    lyricFollowPaused = true;
    window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => {
      delete box.dataset.followPaused;
      lyricFollowPaused = false;
      // 接回来时立刻对齐到当前句，不用等下一句
      lastIndex = -1;
      setActive();
    }, 2500);
  };
  box.addEventListener('scroll', onScroll, { passive: true });
  /*
   * #song-audio 可能在多次重绘之间复用，直接 addEventListener 会让
   * timeupdate 监听越积越多（每 250ms 跑好几遍 setActive）。
   * 先把上一次挂的摘掉，保证任何时候只有一份。
   */
  if (bindSongLyrics._audio && bindSongLyrics._setActive) {
    bindSongLyrics._audio.removeEventListener('timeupdate', bindSongLyrics._setActive);
    bindSongLyrics._audio.removeEventListener('loadedmetadata', bindSongLyrics._setActive);
  }
  bindSongLyrics._audio = audio;
  bindSongLyrics._setActive = setActive;
  audio.addEventListener('timeupdate', setActive);
  audio.addEventListener('loadedmetadata', setActive);
  setActive();
  updateSongChrome();
}

async function hydrateSong(song) {
  if (!song) return;
  // 网易云曲目走本地 API 补歌手/封面/歌词；别的平台的曲目用跨平台搜索补歌词
  if (song.neteaseId) {
    if (song.metaChecked || (song.lyric && song.cover && song.artist)) return;
    try {
      const meta = await api.netease.songMeta({
        apiBase: localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100',
        id: song.neteaseId,
      });
      song.metaChecked = true;
      if (!meta) return;
      if (meta.artist) song.artist = meta.artist;
      if (meta.cover && !song.cover) song.cover = meta.cover;
      if (meta.lyric) song.lyric = meta.lyric;
      saveSongs();
    } catch {
      /* local service may be offline */
    }
    return;
  }
  // 非网易云：没有原生歌词接口时去酷我 / QQ 找 LRC
  if (song.lyric || song.lyricChecked) return;
  try {
    const result = await api.musicLyric({
      song: {
        title: song.title,
        artist: song.artist,
        album: song.album,
        platform: song.platform || song.source || '',
        mid: song.mid,
        hash: song.hash,
        neteaseId: song.neteaseId,
      },
      apiBase: localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100',
    });
    song.lyricChecked = true;
    if (result?.ok && result.lyric) {
      song.lyric = result.lyric;
      saveSongs();
    }
  } catch {
    song.lyricChecked = true;
    /* 拉不到歌词就拉不到，不阻断播放 */
  }
}

/**
 * 按 bilibili 房间号找到对应的卡片房间对象（app 内部 id 与 B 站房间号不是同一个，
 * 主进程回传的事件里带的是 B 站房间号，所以要用 roomId 反查）。
 */
function findBiliRoom(biliRoomId) {
  return state.liveRooms.find((r) => r.platform === 'bilibili' && String(r.roomId) === String(biliRoomId));
}

/** 点歌页才重绘卡片，避免别的页面无谓刷新。 */
function renderLiveIfNeeded() {
  if (state.route !== 'song') return;
  // 右栏弹幕段能就地换的就别整页重绘：整页重绘会打断正在输入的直播间链接
  if (refreshLiveRoomsPanel()) return;
  render({ preserveScroll: true });
}

/**
 * 主进程转发过来的弹幕事件统一在这里落地到 UI。
 * 全部连接逻辑（建连 / 鉴权 / 心跳 / 断线重连 / 服务器轮换）都在主进程，
 * 这里只把事件翻译成卡片状态 + 把弹幕喂给点歌匹配。
 */
function handleBiliDanmuEvent(payload) {
  if (!payload || !payload.roomId) return;
  const room = findBiliRoom(payload.roomId);
  if (!room) return;
  switch (payload.type) {
    case 'pushing':
      // 服务器对 auth 包回了确认：从这刻起才真的在推弹幕（之前"已连接"只是 TCP 握手）
      room.status = '弹幕推送中';
      renderLiveIfNeeded();
      break;
    case 'danmu': {
      // 捕获数直接用主进程累计值；卡片上数字动 = 服务器真的在推，否则是连接没活
      room.captured = payload.captured || (room.captured || 0) + 1;
      const node = document.querySelector(`#live-captured-${room.id} b`);
      if (node) node.textContent = String(room.captured);
      /*
       * 最近一条弹幕原样贴在卡片上：观众自己就能分清是「弹幕根本没到」
       * 还是「到了、但没匹配上点歌」。以前这两种情况在界面上长得一模一样。
       */
      room.lastDanmaku = String(payload.message || '').slice(0, 80);
      const lastNode = document.querySelector(`#live-last-${room.id}`);
      if (lastNode) lastNode.textContent = `最近弹幕：${room.lastDanmaku}`;
      handleLiveDanmaku(payload.message, payload.user);
      break;
    }
    case 'open':
      room.connected = true;
      room.connecting = false;
      if (room.lastRetryAt && Date.now() - room.lastRetryAt > 5 * 60 * 1000) room.retryCount = 0;
      room.status = payload.status || '已连接';
      // 只在第一次连上弹提示，换服务器 / 自动重连成功不重复弹
      if (!room.toastedLive) {
        room.toastedLive = true;
        toast(`已连接直播间：${room.roomTitle}`, 'success');
      }
      renderLiveIfNeeded();
      break;
    case 'status':
      room.status = payload.status || room.status;
      renderLiveIfNeeded();
      break;
    case 'reconnecting':
      room.connecting = false;
      room.connected = false;
      room.status = `连接中断（code ${payload.code ?? '未知'}），3 秒后自动重连 ${payload.tries}/3…`;
      renderLiveIfNeeded();
      break;
    case 'closed':
      room.connected = false;
      room.connecting = false;
      if (payload.code != null) room.lastCloseCode = payload.code;
      room.status = payload.status || '已断开';
      renderLiveIfNeeded();
      break;
    default:
      break;
  }
}


/*
 * decodeBiliFrame 已删除：弹幕帧的解码（zlib/brotli 解压 + DANMU_MSG 提取）现在
 * 全部在主进程用 Node 栈完成，主进程解出来后只把 {type:'danmu',message,user,captured}
 * 通过 live:danmu-event 回传，渲染层不再碰原始二进制帧。
 */

/** 关掉一个房间的运行时链路（B 站 WebSocket / 其它平台的轮询与隐藏窗口）。 */
function closeLiveRuntime(room) {
  const rt = liveRuntimes.get(room.id);
  if (rt) {
    liveRuntimes.delete(room.id);
    if (rt.heartbeat) clearInterval(rt.heartbeat);
    if (rt.timer) clearInterval(rt.timer);
    if (rt.socket) {
      // 标记是用户主动关的：close 事件据此判断要不要自动重连
      rt.closedByUser = true;
      try {
        rt.socket.close();
      } catch {
        /* ignore */
      }
    }
  }
  if (room.danmaku === 'bridge') {
    try {
      api.live.danmakuStop(room.id);
    } catch {
      /* 主进程没起来时忽略 */
    }
  }
  // B 站弹幕连接现在在主进程：主动断开要通知主进程，否则主进程还在重连 / 继续推弹幕。
  // 这里会把它在 biliDanmuConnections 里的连接标记为 closedByUser 并 close，
  // 主进程回一个 closed 事件，但房间卡片已经先被摘掉了，handleBiliDanmuEvent 会 no-op。
  if (room.platform === 'bilibili' && room.roomId) {
    try {
      api.live.danmuDisconnect(room.roomId);
    } catch {
      /* 主进程没起来时忽略 */
    }
  }
}

/** 从列表里摘掉一个房间并关链路（卡片上的「断开」按钮）。 */
function disconnectLiveRoom(id) {
  const idx = state.liveRooms.findIndex((r) => r.id === id);
  if (idx < 0) return;
  const [room] = state.liveRooms.splice(idx, 1);
  closeLiveRuntime(room);
  toast(`已断开：${room.roomTitle || room.platformLabel || '直播间'}`, 'info');
  if (state.route === 'song') render({ preserveScroll: true });
}

/** 兼容旧调用：断开全部（app 退出等场景）。 */
function disconnectBiliLive() {
  for (const room of state.liveRooms.splice(0)) closeLiveRuntime(room);
  if (state.route === 'song') render({ preserveScroll: true });
}

/*
 * buildBiliWsUrls 已删除：弹幕服务器候选地址（每 host 先 443 再自报端口、末尾补
 * broadcastlv:443）现在由主进程的 biliBuildWsUrls 负责，渲染层不再拼 WebSocket URL。
 */

/*
 * connectBiliWs / reconnectBiliRoom 已删除：B 站弹幕的建连、鉴权、心跳、断线重连、
 * 服务器轮换、token 刷新现在全部在主进程（electron/main.js 的 biliOpenWs /
 * biliReconnect）完成。渲染层只通过 api.live.danmuConnect({roomId,token,hosts}) 发起，
 * 再由 handleBiliDanmuEvent 接收主进程回传的 open/pushing/danmu/status/closed/
 * reconnecting 事件来更新卡片与喂点歌。这样长连接跑在 Node 栈上，不再受 Chromium
 * 出站长连接约 70 秒被本机网络层掐断的限制（实测 ≥95 秒稳定）。
 */


/**
 * 连接直播间（可同时连多个：B站+抖音+斗鱼…并存，弹幕汇进同一个点歌处理）。
 *
 * B站：官方 WebSocket，auth 带弹幕鉴权 token（见下方说明）。
 * 其它平台：主进程隐藏窗口抓聊天区（见 electron/live-danmaku.js）。
 */
async function connectLiveRoom(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return;
  // 同一个链接重复连接：先把旧的顶掉；这个链接还在连接中就直接忽略（防连点重复建卡）
  const dup = state.liveRooms.find((r) => r.url === url);
  if (dup) {
    if (dup.connecting) return;
    disconnectLiveRoom(dup.id);
  }

  state.live.roomUrl = url;
  localStorage.setItem('vela:live-room-url', url);
  const room = {
    id: `room-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    url,
    connected: false,
    connecting: true,
    roomTitle: '',
    roomId: '',
    platform: '',
    platformLabel: '',
    danmaku: '',
    status: '连接直播间…',
    captured: 0,
  };
  state.liveRooms.push(room);
  /*
   * 之前这里把全局 state.live.connecting 锁成 true 且只有"解析房间失败"才解锁，
   * 导致连过一次后表单永远显示"连接中"、输入框废掉（断开也不恢复）。
   * 多房间并存后每个房间卡自己显示"连接中"，表单不该被全局锁死——常保持可填可点。
   */
  state.live.connecting = false;
  render({ preserveScroll: true });
  try {
    const info = await api.live.room(url);
    room.platform = info.platform || '';
    room.platformLabel = info.platformLabel || '';
    room.roomId = info.roomId;
    room.roomTitle = info.title || `房间 ${info.roomId}`;
    room.danmaku = info.danmaku || '';
    room.status = info.note || '';
    // 连接成功就记进历史（去重、最新在前、最多 5 个），重启后一键重连
    state.liveHistory = [url, ...(state.liveHistory || []).filter((item) => item !== url)].slice(0, 5);
    localStorage.setItem('vela:live-room-history', JSON.stringify(state.liveHistory));

    if (room.platform !== 'bilibili') {
      await startBridgeLive(room);
      return;
    }

    /*
     * 先拿弹幕鉴权：官方 WS 的 auth 包必须带 getDanmuInfo 发的 token（key），
     * 不带 key 服务器接受连接但一条弹幕都不推——"已连接却收不到点歌"的根因。
     * 顺便用 host_list 里的弹幕服务器，比写死的 broadcastlv 更稳。
     */
    let authKey = '';
    let hosts = [];
    try {
      const danmu = await api.live.danmuInfo(room.roomId);
      if (danmu?.token) authKey = String(danmu.token);
      hosts = Array.isArray(danmu?.hosts) ? danmu.hosts : [];
      // 存一份：断线重连时 5 分钟内直接复用，不用每次都重新请求鉴权
      room.danmuToken = authKey;
      room.danmuHosts = hosts;
      room.danmuAt = Date.now();
    } catch (error) {
      /*
       * 拿不到鉴权就直接不连：B 站服务器对空 key 的连接"接受但一条弹幕都不推"，
       * 以前这里静默继续，用户看到"已连接"却永远收不到点歌，还以为是自己房间没开播的问题。
       * 现在把失败原因亮在卡片上（-352 = B站风控），用户能自己判断要不要重试。
       */
      room.connecting = false;
      room.connected = false;
      room.status = `弹幕鉴权失败：${error.message}`;
      if (state.route === 'song') render({ preserveScroll: true });
      toast(`B站弹幕鉴权失败：${error.message}`, 'error');
      return;
    }

    /*
     * 弹幕长连接已迁到主进程：这里只把鉴权 token + hosts 交给主进程，
     * 真正的建连 / 心跳 / 断线重连 / 服务器轮换全由主进程（Node 栈）负责，
     * 根治渲染层出站长连接约 70 秒被本机网络层掐断的问题。
     * 卡片先置成"连接中"，主进程回 open 事件再改"已连接"，避免一瞬间状态跳变。
     */
    room.connecting = true;
    room.connected = false;
    room.status = '连接直播间…';
    renderLiveIfNeeded();
    api.live.danmuConnect({ roomId: room.roomId, token: authKey, hosts });
  } catch (error) {
    // 房间信息都解析不出来：从列表里摘掉，别留一张永远转圈的卡
    const idx = state.liveRooms.indexOf(room);
    if (idx >= 0) state.liveRooms.splice(idx, 1);
    state.live.connecting = false;
    toast(`直播间连接失败：${error.message}`, 'error');
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

/**
 * 斗鱼 / 虎牙 / 抖音 / 快手：后台隐藏窗口抓聊天区（每路房间一个窗口）。
 *
 * 这几个平台没有公开弹幕协议（斗鱼 TCP、虎牙 Tars、抖音/快手要签名），
 * 硬啃私有协议平台一改版就废。这里让主进程开一个隐藏窗口真的把直播间网页
 * 加载出来，只读聊天区的文字；视频流在请求阶段就被拦掉，不会真的把流拉下来。
 * captured 计数会显示在卡片上：观众发了弹幕但计数不动 = 这个站抓取失效。
 */
async function startBridgeLive(room) {
  const label = room.platformLabel || '该平台';
  try {
    const started = await api.live.danmakuStart({ url: room.url, platform: room.platform, id: room.id });
    room.connected = true;
    room.connecting = false;
    room.danmaku = 'bridge';
    room.status = started?.status || '已连接';
    if (started?.pageTitle && !room.roomTitle) room.roomTitle = started.pageTitle;
    toast(`已连接${label}直播间：${room.roomTitle}`, 'success');
    if (state.route === 'song') render({ preserveScroll: true });

    const rt = liveRuntimes.get(room.id) || {};
    liveRuntimes.set(room.id, rt);
    rt.timer = setInterval(async () => {
      let payload = null;
      try {
        payload = await api.live.danmakuPoll(room.id);
      } catch {
        return;
      }
      if (!payload) return;
      room.captured = payload.captured ?? room.captured;
      if (payload.status && payload.status !== room.status) {
        room.status = payload.status;
        if (state.route === 'song') render({ preserveScroll: true });
      }
      if (!payload.alive) {
        disconnectLiveRoom(room.id);
        toast(`${label}弹幕已断开：${payload.status || '连接失效'}`, 'info');
        return;
      }
      for (const item of payload.messages || []) {
        room.lastDanmaku = String(item.text || '').slice(0, 80);
        handleLiveDanmaku(item.text, item.user);
      }
      if (payload.messages?.length) {
        const lastNode = document.querySelector(`#live-last-${room.id}`);
        if (lastNode) lastNode.textContent = `最近弹幕：${room.lastDanmaku}`;
      }
    }, 900);
  } catch (error) {
    const idx = state.liveRooms.indexOf(room);
    if (idx >= 0) state.liveRooms.splice(idx, 1);
    // 起窗口过程中失败时别把隐藏窗口留成孤儿
    try {
      api.live.danmakuStop(room.id);
    } catch {
      /* ignore */
    }
    toast(`${label}弹幕连接失败：${error.message}`, 'error');
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

let liveRequestBusy = false;
