'use strict';
/*
 * 音乐 · 视图层与弹窗（第 11 批从 app.js 搬出，2026-10-31）
 *
 * 内容：导入歌单 / 添加歌曲两个弹窗（含链接识别与曲源解析）/ 音乐源开关与导入 /
 *      播放设置（音质、音源）/ 直播间房间列表与弹幕面板 / 音乐设置弹窗 /
 *      点歌台整页（karaokeViewMarkup）/ 音乐页入口（songView，chrome.js 的视图表指向它）/
 *      歌单卡片与详情 / 我的歌单分组 / 全部歌单面板 / 榜单面板。
 *
 * 逐字搬运，逻辑一行没改。依赖的 state / dom / api / render / toast / icon / openModal
 * 都在 app.js 与 services 里定义，classic script 共享全局作用域；本文件排在 app.js
 * 之前，函数在调用时才解析名字，所以逆向依赖安全。
 *
 * 与前后两批的分工：
 *   · views/song.js（第 9 批）= 播放器核心：队列存档 → 播放 → 进度与歌词 → 迷你播放器；
 *   · views/song-playlist.js（第 10 批）= 歌单从哪来：广场 / 账号同步 / 缓存 / 详情；
 *   · 本文件 = 画出来 + 弹窗装起来。三者共用同一份 state.song / state.myPlaylists。
 */
/* ------------------------------------------------------------------ */
/* 音乐 · 视图与弹窗                                                    */
/* ------------------------------------------------------------------ */
/* ---------- 导入歌单 / 添加歌曲：两个弹窗 ---------- */

/**
 * 从音频地址里猜一个能读的歌名：去掉域名、路径、扩展名、参数。
 * 猜不出来就返回空串，交给调用方让用户自己填。
 */
/**
 * 从音频地址猜「歌名 + 歌手」（2026-11-18）。
 *
 * 直链歌曲原来只填歌名，没有歌手 —— 主进程的歌词兜底是「歌名 + 歌手」
 * 去酷我/QQ 搜索，缺了歌手就只能靠标题硬碰，命中率很低。
 * 这里顺便把常见的「歌手 - 歌名」命名拆开，拆不出来就只给歌名。
 */
function guessSongMetaFromUrl(rawUrl) {
  const full = titleFromAudioUrl(rawUrl);
  if (!full) return { title: '', artist: '' };
  // 文件名里常见的分隔： " - " / "–" / "—"
  const matched = full.match(/^(.{1,40}?)\s*[-–—]\s*(.{1,60})$/);
  if (matched) {
    const left = matched[1].trim();
    const right = matched[2].trim();
    if (left && right) return { title: right, artist: left };
  }
  return { title: full, artist: '' };
}

function titleFromAudioUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  const last = (url.pathname || '').split('/').filter(Boolean).pop() || '';
  let name = '';
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  name = name
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) name = url.hostname.replace(/^www\./i, '');
  return name.slice(0, 60);
}

/**
 * 「导入歌单」弹窗。
 *
 * 设计上只留一个输入框：粘链接，或者直接把 App 里「分享 → 复制链接」的整段文案贴进来。
 * 边输边识别（防抖 450ms），认出来就在下面显示平台徽标卡，主按钮才亮；
 * 认不出来给一句人话，不把后端的异常栈直接甩到脸上。
 * 网易云的本地服务地址不影响其它平台，所以收进默认折叠的「高级」里。
 */
const PLAYLIST_LINK_API_DEFAULT = 'http://127.0.0.1:3100';

/**
 * 只有真的带回了平台和歌单号才算认出来。
 * 后端偶发只回一个 ok（比如还在解析短链），这时候当成没认出来更诚实，
 * 免得界面显示「音乐歌单」这种似是而非的结果。
 */
function recognizedPlaylistLink(data) {
  return Boolean(data?.ok && data?.platform && (data?.playlistId || data?.id));
}

/**
 * 真正跑一次歌单链接导入：识别链接 → 拉曲目 → 并入「我的歌单」→ 入队。
 * 「导入歌单」弹窗的提交和右栏那个常驻输入框共用这一段，防止两处逻辑走偏。
 *
 * 返回结果里 netease 为真表示曲目已直接落好（网易云服务带回了可播地址），
 * 为假表示曲目是逐首解析出来的，added 可能小于 total。
 */
async function runPlaylistLinkImport(url, { apiBase, parsed } = {}) {
  const base =
    String(apiBase || localStorage.getItem('vela:netease-api') || PLAYLIST_LINK_API_DEFAULT).trim() ||
    PLAYLIST_LINK_API_DEFAULT;
  localStorage.setItem('vela:netease-api', base);
  const info = parsed && parsed.url === url ? parsed.data : await api.musicParsePlaylistLink(url);
  if (!recognizedPlaylistLink(info)) {
    return { ok: false, reason: info?.reason || '这条链接还没认出来，换一条完整链接试试' };
  }

  if (info.platform === 'netease') {
    // 网易云沿用本地 API 流程：它直接带可播放地址回来
    const result = await api.neteasePlaylist({ apiBase: base, url, level: state.songQuality });
    if (!result?.songs?.length) {
      return { ok: false, reason: '没读到曲目：本地网易云服务可能没起来，或者这张歌单本身是空的' };
    }
    const name = result.playlist || info.name || info.playlistName || info.title || '';
    // 链接导入的歌单也并进「我的歌单」，不然导入完在那里看不到
    mergeImportedPlaylist('netease', {
      id: info.playlistId || info.id,
      name,
      cover: info.cover || '',
      count: result.songs.length,
      creator: info.creator || '',
    });
    state.songs.push(...result.songs);
    state.songIndex = Math.max(0, state.songs.length - result.songs.length);
    saveSongs();
    return {
      ok: true,
      netease: true,
      info,
      name,
      added: result.songs.length,
      skipped: result.skipped || 0,
    };
  }

  // QQ 音乐 / 酷我：走各自的公开详情
  const result = await api.musicPlaylistSongs({ platform: info.platform, playlistId: info.playlistId });
  const songs = result?.detail?.songs || [];
  if (!result?.ok || !songs.length) {
    return { ok: false, reason: result?.reason || '这张歌单里没有读到曲目，换一张试试' };
  }
  const name = result.detail.name || info.name || info.playlistName || info.title || '';
  // 链接导入的歌单也并进「我的歌单」：账号同步常年不稳，导入是最稳的入口
  mergeImportedPlaylist(info.platform, {
    id: info.playlistId || info.id,
    name,
    cover: result.detail.cover || info.cover || '',
    count: songs.length,
    creator: info.creator || result.detail.creator || '',
  });
  render({ preserveScroll: true });
  // 曲源逐首解析（每首都要找回可播版本），大歌单要跑一会儿，进度由这里报
  const added = await addSongsToQueue(songs, {
    platform: info.platform,
    label: `导入「${name || info.label}歌单」`,
  });
  if (!added) return { ok: false, reason: '这些曲目暂时都找不到可播放版本' };
  state.songIndex = Math.max(0, state.songs.length - added);
  saveSongs();
  return { ok: true, netease: false, info, name, added, total: songs.length };
}

function openImportPlaylistModal() {
  const defaultApi = localStorage.getItem('vela:netease-api') || PLAYLIST_LINK_API_DEFAULT;
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal kr-imp-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>导入歌单</h2><p>粘贴歌单链接，或者整个分享文案一起贴进来，都能认。</p></div>
          <button class="icon-btn" data-close>${icon('x')}</button>
        </div>
        <form class="modal-body kr-imp-body" id="playlist-link-form">
          <div class="kr-imp-box">
            <textarea class="kr-imp-input" name="url" rows="3" spellcheck="false" autofocus
              placeholder="https://music.163.com/#/playlist?id=…&#10;也可以粘一整段「分享文案」，多余的说明文字会自动忽略"></textarea>
            <div class="kr-imp-box-foot">
              <button type="button" class="kr-imp-paste" id="kr-imp-paste">${icon('file-text', 'xs')}从剪贴板粘贴</button>
              <span class="kr-imp-hint">网易云 / QQ 音乐 / 酷我</span>
            </div>
          </div>
          <div class="kr-imp-state" id="kr-imp-state"></div>
          <p class="kr-imp-error" id="kr-imp-error" hidden></p>
          <div class="kr-imp-adv">
            <button type="button" class="kr-imp-adv-toggle" id="kr-imp-adv-toggle" aria-expanded="false">
              ${icon('chevron-down', 'xs')}<span>高级：网易云本地服务地址</span>
            </button>
            <label class="kr-imp-adv-body" id="kr-imp-adv-body" hidden>
              <span>只有导入网易云歌单时才用得上，不确定就保持默认。</span>
              <input class="text-input kr-imp-adv-input" name="apiBase" value="${esc(defaultApi)}"
                placeholder="http://127.0.0.1:3100" spellcheck="false" />
            </label>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary kr-imp-submit" type="submit" id="kr-imp-submit" disabled>导入</button>
          </div>
        </form>
      </div>
    </div>
  `);

  const form = document.querySelector('#playlist-link-form');
  if (!form) return;
  const urlInput = form.querySelector('[name="url"]');
  const apiInput = form.querySelector('[name="apiBase"]');
  const submit = form.querySelector('#kr-imp-submit');
  const stateHost = form.querySelector('#kr-imp-state');
  const errorHost = form.querySelector('#kr-imp-error');

  let parsedFor = ''; // 这份链接已经认出过结果，提交时不用再问一次后端
  let parsedData = null;
  let timer = null;
  let seq = 0;
  let busy = false;

  const showError = (message) => {
    errorHost.hidden = !message;
    errorHost.textContent = message || '';
  };
  const noteMarkup = (text, miss = false) =>
    `<p class="kr-imp-note ${miss ? 'is-miss' : ''}">${esc(text)}</p>`;

  // 识别成功后的平台徽标卡：平台名 + 歌单名/曲目数（后端给多少显示多少）
  const cardMarkup = (data) => {
    const platform = String(data?.platform || '');
    const label = data?.label || musicPlatformLabel(platform);
    const name = String(data?.name || data?.playlistName || data?.title || '').trim();
    const count = Number(data?.songCount || data?.trackCount || data?.count || 0) || 0;
    const creator = String(data?.creator || '').trim();
    const cover = String(data?.cover || '').trim();
    const id = String(data?.playlistId || data?.id || '');
    /*
     * playlistId 是不透明字符串（有的平台自建歌单是 collect:用户:…:签名），
     * 只用来原样透传给后端，不要拆不要转数字。
     * 界面上也只在它是纯数字（网易云 / QQ 那种）时才当「歌单号」露出来，
     * 免得把一长串签名糊到用户脸上。
     */
    const showId = /^\d+$/.test(id) ? id : '';
    // 有歌单名就把名字当主标题（分享短链能解析出名字），没有就退回「平台歌单」
    const title = name || `${label}歌单`;
    const sub = [
      name ? label : showId ? `歌单号 ${showId}` : '',
      count ? `${count} 首` : '',
      creator,
    ]
      .filter(Boolean)
      .join(' · ');
    return `<div class="kr-imp-card">
        ${
          cover
            ? `<img class="kr-imp-card-cover" src="${esc(cover)}" alt="" referrerpolicy="no-referrer" />`
            : `<span class="mp-dot" data-platform="${esc(platform)}"></span>`
        }
        <span class="kr-imp-card-copy">
          <strong>${esc(title)}</strong>
          ${sub ? `<small>${esc(sub)}</small>` : ''}
        </span>
        <span class="kr-imp-card-ok">${icon('check', 'xs')}认出来了</span>
      </div>`;
  };

  /*
   * 只有真的带回了平台和歌单号才算认出来。
   * 后端偶发只回一个 ok（比如还在解析短链），这时候当成没认出来更诚实，
   * 免得界面显示「音乐歌单」这种似是而非的结果。
   */
  const recognized = (data) => Boolean(data?.ok && data?.platform && (data?.playlistId || data?.id));

  /*
   * 封面是外链，挂了就换回平台圆点 —— 否则卡片上会留一个空方块，像加载坏了。
   * 弹窗内容不经过 bindView()，所以这里自己挂一次。
   */
  const bindCardCover = (data) => {
    const img = stateHost.querySelector('.kr-imp-card-cover');
    if (!img) return;
    img.addEventListener(
      'error',
      () => {
        const dot = document.createElement('span');
        dot.className = 'mp-dot';
        if (data?.platform) dot.dataset.platform = String(data.platform);
        img.replaceWith(dot);
      },
      { once: true }
    );
  };

  const paintCard = (data) => {
    stateHost.innerHTML = cardMarkup(data);
    bindCardCover(data);
  };

  const runParse = async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    const mine = ++seq;
    stateHost.innerHTML = noteMarkup('正在识别…');
    submit.disabled = true;
    try {
      const data = await api.musicParsePlaylistLink(url);
      if (mine !== seq) return; // 用户又改了输入，这次结果作废
      if (!recognized(data)) {
        parsedFor = '';
        parsedData = null;
        stateHost.innerHTML = noteMarkup(data?.reason || '这条链接还没认出来，换一条完整链接试试', true);
        return;
      }
      parsedFor = url;
      parsedData = data;
      paintCard(data);
      submit.disabled = false;
    } catch (error) {
      if (mine !== seq) return;
      stateHost.innerHTML = noteMarkup(humanError(error), true);
    }
  };

  urlInput.addEventListener('input', () => {
    showError('');
    submit.disabled = true;
    const value = urlInput.value.trim();
    if (value !== parsedFor) {
      parsedData = null;
      parsedFor = '';
    }
    clearTimeout(timer);
    if (!value) {
      stateHost.innerHTML = '';
      return;
    }
    stateHost.innerHTML = noteMarkup('正在识别…');
    timer = setTimeout(runParse, 450);
  });

  form.querySelector('#kr-imp-paste')?.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        toast('剪贴板里没有文字', 'info');
        return;
      }
      urlInput.value = text.trim();
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    } catch {
      // 拿不到剪贴板权限时不装作成功了，直接把人送回输入框
      urlInput.focus();
      toast('读不到剪贴板，直接按 Ctrl + V 粘进来就行', 'info');
    }
  });

  const advToggle = form.querySelector('#kr-imp-adv-toggle');
  const advBody = form.querySelector('#kr-imp-adv-body');
  advToggle?.addEventListener('click', () => {
    const open = advToggle.getAttribute('aria-expanded') === 'true';
    advToggle.setAttribute('aria-expanded', String(!open));
    advToggle.classList.toggle('is-open', !open);
    advBody.hidden = open;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const url = urlInput.value.trim();
    const apiBase = String(apiInput?.value || '').trim() || defaultApi;
    if (!url) {
      showError('先把歌单链接粘进来');
      urlInput.focus();
      return;
    }
    showError('');
    localStorage.setItem('vela:netease-api', apiBase);

    const setBusy = (text) => {
      busy = Boolean(text);
      submit.disabled = busy;
      submit.textContent = text || '导入';
    };

    setBusy('正在识别…');
    try {
      const info = parsedData && parsedFor === url ? parsedData : await api.musicParsePlaylistLink(url);
      if (!recognized(info)) {
        stateHost.innerHTML = noteMarkup(info?.reason || '这条链接还没认出来，换一条完整链接试试', true);
        showError('这条链接暂时读不出来，换一条再试');
        setBusy('');
        return;
      }
      parsedFor = url;
      parsedData = info;
      paintCard(info);
      setBusy('正在读取曲目…');

      // 真正的导入动作抽在 runPlaylistLinkImport 里，和右栏那个链接导入入口共用一份
      const res = await runPlaylistLinkImport(url, {
        apiBase,
        parsed: parsedFor === url && parsedData ? { url, data: parsedData } : null,
      });
      if (!res.ok) {
        showError(res.reason);
        setBusy('');
        return;
      }
      closeModal();
      render({ preserveScroll: true });
      toast(
        res.netease
          ? `已导入「${res.name}」${res.added} 首${res.skipped ? `，跳过 ${res.skipped} 首没有版权的` : ''}，已加入我的歌单`
          : `已导入 ${res.added} 首${res.added < res.total ? `（${res.total - res.added} 首没有可播放版本）` : ''}，已加入我的歌单`,
        'success'
      );
      playCurrentSong();
    } catch (error) {
      // 失败不关弹窗：留在原地改链接就能重试
      showError(`导入失败：${humanError(error)}`);
      setBusy('');
    }
  });
}

/**
 * 「添加歌曲链接」弹窗。
 *
 * 一个地址输入框为主，歌名跟着地址自动填（可改），旁边直接给一个「选本地文件」。
 * 地址不对就在弹窗里说清楚哪儿不对，不再点了按钮毫无反应。
 */
function openAddSongLinkModal() {
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal kr-imp-modal is-narrow" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>添加歌曲</h2><p>贴一个音频直链就行，歌名会自动填好。</p></div>
          <button class="icon-btn" data-close>${icon('x')}</button>
        </div>
        <form class="modal-body kr-imp-body" id="song-link-form">
          <label class="kr-imp-field">
            <span class="kr-imp-field-label">音频地址</span>
            <input class="text-input kr-imp-url" name="url" placeholder="https://.../song.mp3" spellcheck="false" autofocus />
          </label>
          <p class="kr-imp-error" id="song-link-error" hidden></p>
          <label class="kr-imp-field">
            <span class="kr-imp-field-label">歌名<em>可选，自动填好后还能改</em></span>
            <input class="text-input" name="title" placeholder="夜航星" />
          </label>
          <label class="kr-imp-field">
            <span class="kr-imp-field-label">歌手<em>可选，填了才搜得准歌词</em></span>
            <input class="text-input" name="artist" placeholder="不才" />
          </label>
          <div class="kr-imp-foot-row">
            <button type="button" class="kr-imp-file" data-action="add-song-file">${icon('folder', 'xs')}选本地文件</button>
            <span class="kr-imp-hint">支持 mp3 / flac / m4a / wav</span>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary" type="submit">加入歌单</button>
          </div>
        </form>
      </div>
    </div>
  `);

  const form = document.querySelector('#song-link-form');
  if (!form) return;
  const urlInput = form.querySelector('[name="url"]');
  const titleInput = form.querySelector('[name="title"]');
  const artistInput = form.querySelector('[name="artist"]');
  const errorHost = form.querySelector('#song-link-error');

  const showError = (message) => {
    errorHost.hidden = !message;
    errorHost.textContent = message || '';
  };

  // 只有用户没自己动过歌名时才跟着地址改，别把人家改好的名字覆盖掉
  let titleTouched = false;
  let artistTouched = false;
  titleInput.addEventListener('input', () => {
    titleTouched = Boolean(titleInput.value.trim());
  });
  if (artistInput) {
    artistInput.addEventListener('input', () => {
      artistTouched = Boolean(artistInput.value.trim());
    });
  }

  urlInput.addEventListener('input', () => {
    showError('');
    const guess = guessSongMetaFromUrl(urlInput.value);
    if (!titleTouched && guess.title) titleInput.value = guess.title;
    if (artistInput && !artistTouched && guess.artist) artistInput.value = guess.artist;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = String(urlInput.value || '').trim();
    if (!url) {
      showError('先把音频地址粘进来');
      urlInput.focus();
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      showError('这个地址要以 http:// 或 https:// 开头，复制完整链接再试');
      urlInput.focus();
      return;
    }
    const guess = guessSongMetaFromUrl(url);
    const title = String(titleInput.value || '').trim() || guess.title || '未命名音频';
    const artist = String(artistInput?.value || '').trim() || guess.artist || '';
    const index = state.songs.length;
    state.songs.push({ title, artist, url });
    state.songIndex = index;
    saveSongs();
    // 手动加的直链也进「我的队列」，点歌单播放不会冲掉
    addToPicked({ title, artist, url, source: 'url' });
    closeModal();
    /*
     * 2026-11-18：以前这里直接 playCurrentSong()，跳过了 hydrateSong ——
     * 直链歌曲的歌词搜索就从来没触发过，界面上永远写着「直链歌曲没有歌词」。
     * 改走 playSongAt：它会补元数据、按歌名+歌手去酷我/QQ 搜 LRC。
     */
    await playSongAt(index, { preserveScroll: true });
  });
}

/**
 * 点歌台整体布局。
 *
 * 视图层组件分散在 song-ui.js（每块都是纯函数、可单独复用），本函数只负责把它们拼起来：
 *   顶部操作区（账号 / 添加歌曲）
 *   中间 左栏「曲库导航 + 歌单同步」+ 主区（标题条 / 搜索一条 / 队列或歌单或榜单）+ 右侧栏（歌词/音效/设置/弹幕）
 *   底部播放条
 *
 * 为什么把分页放到左栏：「我的歌单」原来跟队列挤在同一列里，还得滚到底才看得见，
 * 等于把人挡在门外。改成常驻左栏后，进歌单只要一次点击；窄屏（<1100px）由 CSS 把它折成顶部横向 tab。
 */
/* ── 点歌台「音源」卡片：内置音源勾选 + 第三方音源导入 ──────────
 * 数组顺序就是换源优先级：洛雪 → 网易云 → 咪咕 → 酷我 → QQ。
 * 播放前会按这个顺序并发验证一遍地址，第一个真能放出声音的胜出，
 * 所以这里排的是「先试谁」，不是「只能试谁」。
 * QQ / 酷我的匿名接口对付费曲目一律要会员，所以默认只开洛雪 / 网易云 / 咪咕，
 * 用户想开哪家自己点 chip。
 * 酷狗已经从内置音源里整条移除（不再显示、不再参与换源）。
 * 第三方音源是一份 JSON，描述「怎么搜」和「怎么取地址」两个接口，
 * 可以从文件导入，也可以用订阅地址导入。
 */

const MUSIC_SOURCE_LABELS = [
  ['lx', '洛雪音源'],
  ['netease', '网易云'],
  ['migu', '咪咕'],
  ['kuwo', '酷我'],
  ['qq', 'QQ 音乐'],
];
const MUSIC_SOURCE_DEFAULTS = { lx: true, netease: true, migu: true, kuwo: true, qq: false };
/** 内置音源的合法键（顺序 = 优先级）：不在这个表里的平台一律视为已下线。 */
const MUSIC_SOURCE_KEYS = MUSIC_SOURCE_LABELS.map(([key]) => key);

/**
 * 归一化后的音源开关。
 *
 * 只认 MUSIC_SOURCE_LABELS 里的键：老设置里遗留的 kugou（以及任何未知键）
 * 一律不进结果 —— 既不显示、也不会在下次保存时被写回去，等于自然消失。
 * 缺失的键用默认值补齐，所以「用户从没动过设置」和「存了半截」都能正常渲染。
 */
function musicSourceFlags() {
  const stored = (state.settings && state.settings.musicSources) || {};
  const flags = {};
  for (const [key] of MUSIC_SOURCE_LABELS) {
    flags[key] = typeof stored[key] === 'boolean' ? stored[key] : MUSIC_SOURCE_DEFAULTS[key];
  }
  return flags;
}

function musicCustomSources() {
  const list = state.settings?.musicCustomSources;
  return Array.isArray(list) ? list : [];
}

/**
 * 音源开关里被停用的平台，点歌台里的平台标签也跟着隐藏（酷我停了就不再显示酷我 tab）。
 * 不在 MUSIC_SOURCE_KEYS 里的平台（酷狗已整条移除）恒为不可用：
 * 否则「未定义的键不等于 false」会让它照样冒出来。
 */
function musicPlatformEnabled(key) {
  if (!MUSIC_SOURCE_KEYS.includes(key)) return false;
  return musicSourceFlags()[key] !== false;
}

function musicSourceCardMarkup() {
  const flags = musicSourceFlags();
  const customs = musicCustomSources();
  const on = customs.filter((def) => def.enabled !== false).length;
  /*
   * 音源卡只显示启用的内置音源；停用的（如酷我）不在界面上留任何入口。
   * 数据里的开关仍然生效：换源竞速、搜索、回退解析都会跳过停用的源。
   */
  const enabledLabels = MUSIC_SOURCE_LABELS.filter(([key]) => flags[key] !== false);
  const chips = enabledLabels
    .map(
      ([key, label]) =>
        `<button class="song-source-chip active" data-action="toggle-music-source" data-id="${key}" title="点击停用">${esc(label)}</button>`
    )
    .join('');
  // 说明行只写顺序，不写「只有这几家」：关掉某一家只是跳过它，顺序本身不变
  const orderNote = '按顺序试：洛雪 → 网易云 → 咪咕 → 酷我 → QQ；播放前先验证地址真能出声，自动选可用的那条';
  const list = customs.length
    ? customs
        .map(
          (def) => `
        <span class="song-source-item ${def.enabled === false ? 'is-off' : ''}">
          <button class="song-source-name" data-action="toggle-music-custom" data-id="${esc(def.id)}" title="启用 / 停用">${esc(def.name || def.id)}</button>
          <button class="song-source-del" data-action="music-source-remove" data-id="${esc(def.id)}" title="删除">${icon('x', 'xs')}</button>
        </span>`
        )
        .join('')
    : '<p class="song-source-empty">还没有导入第三方音源</p>';
  return `
    <section class="song-rail-card is-source">
      <div class="song-rail-head">
        <span>音源</span>
        <small>${on ? `已启用 ${on} 个第三方` : '点标签切换'}</small>
      </div>
      <div class="song-source-chips">${chips}</div>
      <p class="song-source-empty">${esc(orderNote)}</p>
      <div class="song-source-custom">${list}</div>
      <div class="song-source-url" id="song-source-url-row" hidden>
        <input class="song-source-input" id="music-source-url" type="text" placeholder="粘贴音源 JSON 的订阅地址" />
        <button class="song-rail-more" data-action="music-source-url-go">导入</button>
      </div>
      <div class="song-source-actions">
        <button class="song-rail-more" data-action="music-source-pick" title="导入本地音源文件">${icon('download', 'xs')}导入文件</button>
        <button class="song-rail-more" data-action="music-source-subscribe" title="用订阅地址导入">${icon('link', 'xs')}订阅地址</button>
      </div>
      <input type="file" id="music-source-file" accept=".json,application/json" hidden />
    </section>`;
}

/** 把一份音源内容交给主进程校验入库（本地文本或订阅地址二选一）。 */
async function importMusicSource(input) {
  if (typeof api.musicImportSources !== 'function') {
    toast('当前版本还不支持导入音源', 'error');
    return;
  }
  const result = await api.musicImportSources(input).catch((error) => ({ ok: false, reason: humanError(error) }));
  if (!result?.ok) {
    toast(result?.reason || '导入失败', 'error');
    return;
  }
  state.settings.musicCustomSources = result.sources || [];
  render({ preserveScroll: true });
  const extra = (result.rejected || []).length ? `（${result.rejected.length} 个不合格已跳过）` : '';
  toast(`已导入 ${result.added} 个音源${extra}`, 'success');
}

function musicSourceFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('文件读不出来'));
    reader.readAsText(file);
  });
}

/* ── 音乐设置：播放 / 音源 / 弹幕点歌，从右栏搬进弹窗 ──────────────
   右栏只留「正在播放 + 歌词」，功能型卡片不再占着浏览界面。
   弹窗是 #modal-root 里的独立 DOM，不受音乐页 render 影响，
   所以弹幕状态变化要单独往里刷（见 refreshLiveRoomsPanel）。 */

/** 播放设置块：音量 / 默认音质 / 续播 / 小播放器 + 音效入口。 */
function musicPlaybackSettingsMarkup() {
  // 音量和默认音质播放条上就能直接调，音效也有自己的小面板，这里不再重复摆一遍
  return `
    <div class="mset-block">
      <p class="mset-label">播放习惯</p>
      <div class="song-rail-row is-split">
        <span class="song-rail-pair">
          <span>开机续播</span>
          <button class="switch ${state.autoResumeSong ? 'on' : ''}" role="switch" aria-checked="${Boolean(state.autoResumeSong)}" data-action="toggle-auto-resume"></button>
        </span>
        <span class="song-rail-pair">
          <span>小播放器</span>
          <button class="switch ${isMiniEnabled() ? 'on' : ''}" role="switch" aria-checked="${Boolean(isMiniEnabled())}" data-action="toggle-mini-player"></button>
        </span>
      </div>
    </div>`;
}

/** 弹幕点歌里会实时变的那一段（模式切换 + 房间列表），单独抽出好刷新。 */
function liveRoomsListMarkup() {
  return `
    ${
      state.liveRooms.length
        ? `<div class="song-live-mode">
                  <span class="song-live-mode-label">观众点歌</span>
                  <button class="song-live-chip ${liveSongMode() === 'next' ? 'on' : ''}" data-action="live-song-mode" data-id="next">下一首播放</button>
                  <button class="song-live-chip ${liveSongMode() === 'now' ? 'on' : ''}" data-action="live-song-mode" data-id="now">立即播放</button>
                </div>`
        : ''
    }
    ${state.liveRooms
      .map((room) => {
        const label = esc(room.platformLabel || '直播间');
        const statusLine = room.status ? `<p class="song-live-status">${esc(room.status)}</p>` : '';
        // 拿不到鉴权时给一个登录入口（B站偶尔对未登录会话加码）。
        // -352 是接口签名问题，登录解决不了，别再把用户往死路上引。
        // 2026-11-18：轮播/未开播房间走聊天区轮询，B站未登录时 gethistory 返回空数组，
        // 所以「轮询已开但一条都没抓到」也把登录入口亮出来，并说明原因。
        const failedText = String(room.status || '');
        const needBiliLogin =
          (/鉴权失败/.test(failedText) && !/-352/.test(failedText)) ||
          (room.danmaku === 'history' && !room.captured);
        // 计数与最近弹幕始终渲染（只读展示）：reconnecting/closed 会把 room.connected 置 false，
        // 若按 connected 隐藏，历史计数与最近弹幕会一并消失，视觉上像「从没抓到过」。
        // 这里数字不清零、节点不隐藏；仅断开时补一句很轻的状态说明。
        const captured = `<p class="song-live-captured" id="live-captured-${esc(room.id)}">已捕获 <b>${room.captured || 0}</b> 条弹幕${
            room.danmaku === 'bridge'
              ? '（观众发弹幕后数字不动 = 该站抓取失效）'
              : room.danmaku === 'history'
                ? '（聊天区轮询中；B站未登录时读不到聊天记录，建议先登录）'
                : '（发条弹幕试试：数字不动 = 服务器没推送，看状态行的原因）'
          }</p>`;
        const liveLast = `<p class="song-live-last" id="live-last-${esc(room.id)}">最近弹幕：${esc(
            String(room.lastDanmaku || '—').slice(0, 80)
          )}</p>`;
        const disconnectedNote = room.connected
          ? ''
          : '<small class="song-live-offline-note">连接已断开，以下为断开前记录</small>';
        return `<div class="song-live-room">
                  <div class="song-live-room-head">
                    <span class="song-live-room-title">${label} · ${esc(room.roomTitle || `房间 ${room.roomId || ''}`)}</span>
                    <button class="song-rail-more" data-action="live-disconnect" data-id="${esc(room.id)}">断开</button>
                  </div>
                  <div class="song-live-on ${room.connected ? 'is-native' : 'is-status'}">
                    ${room.connecting || room.connected ? icon(room.connected ? 'check' : 'info') : icon('info')}
                    <span>${esc(room.connecting ? '连接中…' : room.connected ? '等待「点歌 歌名」' : room.status || '已断开')}</span>
                  </div>
                  ${statusLine}
                  ${disconnectedNote}
                  ${captured}
                  ${liveLast}
                  ${needBiliLogin ? `<button class="song-live-btn" data-action="bili-login" style="width:100%;margin-top:8px">登录B站账号</button>` : ''}
                </div>`;
      })
      .join('')}`;
}

/**
 * 弹幕点歌卡片头部的 B 站账号条（2026-11-18）。
 *
 * 轮播 / 未开播房间靠登录态读聊天区，所以登录入口必须常驻、
 * 而不是等某个房间失败后才冒出来 —— 那样用户只会以为功能是坏的。
 */
function biliAccountMarkup() {
  const acc = state.biliAccount || {};
  if (acc.loggedIn) {
    return `<div class="song-live-account is-on">
      <span class="song-live-account-dot"></span>
      <span class="song-live-account-text">B站已登录${acc.uname ? ` · ${esc(acc.uname)}` : ''}</span>
      <button class="song-rail-more" data-action="bili-login">切换账号</button>
    </div>`;
  }
  return `<div class="song-live-account">
    <span class="song-live-account-dot"></span>
    <span class="song-live-account-text">B站未登录${acc.checked ? ' · 轮播/未开播房间需登录后才能读聊天区点歌' : ''}</span>
    <button class="song-rail-more" data-action="bili-login">登录B站账号</button>
  </div>`;
}

/** 弹幕点歌块：房间列表（可单独刷新）+ 连接表单 + 历史。 */
function liveDanmakuMarkup() {
  /*
   * 折叠态（2026-11-18）。
   *
   * 完整表单常驻会把右栏撑满，歌词被压没；折叠后只占一行，
   * 状态（几个房间已连接）写在标题里，点一下才展开表单。
   * 未手动点过时按「有没有已连接房间」自动决定，连过就默认展开。
   */
  const autoOpen = state.liveRooms.length > 0;
  const open = state.livePanelOpen == null ? autoOpen : Boolean(state.livePanelOpen);
  const connected = state.liveRooms.filter((room) => room.connected).length;
  const head = `
      <button class="song-live-toggle" data-action="live-panel-toggle" aria-expanded="${open ? 'true' : 'false'}">
        <span class="song-live-toggle-title">${icon('mic', 'xs')} 弹幕点歌</span>
        <span class="song-live-toggle-state${connected ? ' is-on' : ''}">${
          connected ? `${connected} 个房间已连接` : state.liveRooms.length ? `${state.liveRooms.length} 个房间` : '未连接'
        }</span>
        <span class="song-live-toggle-arrow">${open ? '收起' : '展开'}</span>
      </button>`;

  if (!open) {
    return `<section class="song-rail-card is-live is-collapsed">${head}</section>`;
  }

  return `
    <section class="song-rail-card is-live">
      ${head}
      ${biliAccountMarkup()}
      <div id="live-rooms-panel">${liveRoomsListMarkup()}</div>
      <div class="song-live-form">
        <input class="song-live-input" id="live-room-input" placeholder="直播间链接（B站 / 斗鱼 / 虎牙…）" title="支持 B站、斗鱼、虎牙、抖音、快手、YY、网易CC、花椒、酷狗直播、小红书、淘宝直播、Twitch、YouTube，其它站点会尝试通用抓取。可同时连接多个直播间" value="${esc(state.live.roomUrl || '')}" spellcheck="false" />
        <button class="song-live-btn" data-action="live-connect" ${state.live.connecting ? 'disabled' : ''}>${state.live.connecting ? '连接中' : '连接'}</button>
      </div>
      ${
        state.liveHistory?.length
          ? `<div class="song-live-history"><span class="song-live-history-label">最近连接</span>${state.liveHistory
              .map(
                (item) =>
                  `<button class="song-live-history-btn" data-action="live-connect" data-url="${esc(item)}" title="点击直接重连：${esc(item)}">${esc(
                    String(item).replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 30)
                  )}</button>`
              )
              .join('')}</div>`
          : ''
      }
    </section>`;
}

/** 房间状态变了就把右栏那一段换掉，内容没变就不动（避免打断输入）。 */
function refreshLiveRoomsPanel() {
  const host = document.querySelector('#live-rooms-panel');
  if (!host) return false;
  const next = liveRoomsListMarkup();
  // 按数据签名比较，别再拿模板字符串与浏览器规范化后的 innerHTML 做严格相等：
  // 后者几乎必然不等，旧写法每次都重建整段 DOM，会打断输入框、丢焦点。
  // 签名覆盖 liveRoomsListMarkup 里所有会随弹幕事件/状态变化的字段，漏一个都会导致对应数字或文案不刷新。
  const sig = JSON.stringify({
    mode: liveSongMode(),
    // 登录态变了也要重绘账号条
    bili: [state.biliAccount?.loggedIn ? 1 : 0, state.biliAccount?.uname || '', state.biliAccount?.checked ? 1 : 0],
    rooms: state.liveRooms.map((room) => [
      room.id,
      room.platformLabel,
      room.roomTitle,
      room.roomId,
      room.status,
      room.connected,
      room.connecting,
      room.danmaku,
      room.captured || 0,
      String(room.lastDanmaku || '').length,
      String(room.lastDanmaku || '—').slice(0, 80),
    ]),
  });
  if (host.dataset.liveSig !== sig) {
    host.innerHTML = next;
    host.dataset.liveSig = sig;
  }
  return true;
}

function openMusicSettingsModal() {
  openModal(
    `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal music-settings-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>音乐设置</h2>
            <p>开机续播、小播放器和音源开关。音量和音质在播放条上直接调，音效点播放条右边的按钮。</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body mset-body" id="music-settings-body">
          ${musicPlaybackSettingsMarkup()}
          ${musicSourceCardMarkup()}
        </div>
      </div>
    </div>`
  );
}

/**
 * 底部播放条的「播放列表」浮层（2026-11-18 用户需求）。
 *
 * 以前列表按钮只是跳到音乐页再滚到队列，听歌时想换一首就得离开当前页。
 * 现在直接在播放条上方展开：正在播放 / 接下来 / 已播放 三段，
 * 点任意一行切歌。弹幕点的「下一首」插进来后会立刻出现在「接下来」第一行。
 */
function dockQueueMarkup() {
  if (!state.dockListOpen) return '';
  const songs = Array.isArray(state.songs) ? state.songs : [];
  const total = songs.length;
  const at = total ? Math.min(Math.max(0, Number(state.songIndex) || 0), total - 1) : -1;
  const row = (song, index) =>
    `<button class="dock-queue-row${index === at ? ' is-active' : ''}" data-action="song-select" data-index="${index}" title="${esc(
      `${song?.title || '未知曲目'}${song?.artist ? ' · ' + song.artist : ''}`
    )}">
      <span class="dock-queue-idx">${index === at ? icon('play', 'xs') : index + 1}</span>
      <span class="dock-queue-copy">
        <strong>${esc(song?.title || '未知曲目')}</strong>
        <small>${esc(song?.artist || '')}</small>
      </span>
    </button>`;
  const upcoming = at >= 0 ? songs.slice(at + 1) : [];
  const played = at >= 0 ? songs.slice(0, at) : [];
  const body = total
    ? `${at >= 0 ? `<p class="dock-queue-label">正在播放</p>${row(songs[at], at)}` : ''}
       ${
         upcoming.length
           ? `<p class="dock-queue-label">接下来 · ${upcoming.length} 首</p>${upcoming
               .map((s, i) => row(s, at + 1 + i))
               .join('')}`
           : '<p class="dock-queue-empty">已经是最后一首了</p>'
       }
       ${played.length ? `<p class="dock-queue-label">已播放 · ${played.length} 首</p>${played.map((s, i) => row(s, i)).join('')}` : ''}`
    : '<p class="dock-queue-empty">队列还是空的，去点几首歌吧</p>';
  return `
    <div class="song-dock-queue" id="song-dock-queue" role="dialog" aria-label="播放列表">
      <div class="song-dock-queue-head">
        <span>播放列表 · 共 ${total} 首</span>
        <button class="song-bar-btn" data-action="dock-list-toggle" title="收起">${icon('x', 'xs')}</button>
      </div>
      <div class="song-dock-queue-body">${body}</div>
    </div>`;
}

function karaokeViewMarkup() {
  // 每次进音乐页温和检查一次 B 站登录态（函数内部 60 秒节流，不会造成请求风暴）
  if (typeof refreshBiliAccount === 'function') refreshBiliAccount(false);
  const current = state.songs[state.songIndex] || null;
  const playing = Boolean(current?.url);
  const tab = state.songTab || 'queue';
  const cover = songCover(current);
  return `
    <div class="page song-page song-app">
      <header class="song-app-head">
        <div class="song-app-title">
          <!-- 和别的页统一：eyebrow 小标题 + 36px 主标题 + 计数跟在标题后 -->
          <div class="eyebrow">${PAGE_META.song.eyebrow}</div>
          <h1>音乐${state.liveRooms.some((r) => r.connected) ? '<span class="count">弹幕已连接</span>' : ''}</h1>
        </div>
        <!-- 说明与右上角那排控件同占一整排：说明在左，账号和加歌按钮在右 -->
        <p class="song-app-desc">本地歌曲、榜单和歌单都在这儿；登录音乐账号能读自己的歌单，直播间连上之后观众还能点歌。</p>
        <div class="song-app-toolrow">
          ${musicAccountEntryMarkup()}
          <div class="song-app-actions">
            <button class="song-app-btn" data-action="music-settings" title="音乐设置（播放 / 音源 / 弹幕点歌）">${icon('settings')}</button>
            <button class="song-app-btn" data-action="add-song-file" title="添加本地歌曲（mp3 / flac 等文件）">${icon('plus')}</button>
            <button class="song-app-btn" data-action="import-playlist-link" title="链接导入歌单（网易云 / QQ 音乐 / 酷我）：粘贴歌单链接或整段分享文案">${icon('download')}</button>
            <button class="song-app-btn" data-action="add-song-link" title="添加音频链接">${icon('link')}</button>
          </div>
        </div>
      </header>

      <div class="song-app-body kr-body">
        <aside class="song-app-side">
          ${liveDanmakuMarkup()}
          ${krNavMarkup()}
        </aside>

        <main class="song-app-main">
          ${
            /*
             * 2026-11-18：进了某张歌单，主区顶部不该再挂着「队列标题条 + 搜索框」——
             * 那是队列页的东西。歌单页只需要它自己的头部（返回 / 标题 / 整张播放 …）。
             */
            state.myPlaylists.detail || state.localDetailId
              ? ''
              : `${krSectionHeadMarkup()}
                 <div class="song-app-searchbar">${songSearchMarkup()}</div>`
          }
          <div class="song-app-scroll">
            ${
              state.localDetailId
                ? localPlaylistMarkup()
                : state.myPlaylists.detail
                ? playlistDetailMarkup(state.myPlaylists.detail, state.myPlaylists.detail.platform)
                : tab === 'charts'
                  ? chartPanelMarkup()
                  : tab === 'plaza'
                    ? songPlazaMarkup()
                    : tab === 'search'
                      ? songSearchPanel()
                      : tab === 'queue'
                        ? songQueueList(state.pickedSongs)
                        : songPlazaMarkup()
            }
          </div>
        </main>

        <aside class="song-app-rail">
          <section class="song-rail-card is-now">
            <div class="song-rail-head">
              <span>${icon('headphones', 'xs')} 正在播放</span>
              <small>${state.songs.length ? `播放列表 ${state.songs.length} 首` : '暂无曲目'}</small>
            </div>
            <div class="song-rail-now">
              <span class="song-rail-cover ${cover ? 'has-cover' : ''}">${cover ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer" />` : icon('music')}</span>
              <span class="song-rail-now-copy">
                <strong id="rail-now-title">${esc(current?.title || '还没有点歌')}</strong>
                <small id="rail-now-artist">${esc(current?.artist || '音乐')}</small>
              </span>
            </div>
          </section>

          <section class="song-rail-card is-lyrics">
            <div class="song-rail-head">
              <span>歌词</span>
              <small>${current?.lyric ? '同步中' : current?.lyricChecked ? '未找到' : '播放时获取'}</small>
            </div>
            <div class="song-lyrics song-rail-lyrics" id="song-lyrics">
              ${
                current?.lyric
                  ? parseLrc(current.lyric)
                      .map((line) => `<p class="song-lyric-line" data-time="${line.time}">${esc(line.text)}</p>`)
                      .join('')
                  : `<div class="song-lyric-empty">${icon('music')}<span>${
                      current?.lyricChecked
                        ? current?.title
                          ? `没找到「${esc(current.title)}」的歌词`
                          : '这首歌没找到歌词'
                        : '播放时按歌名 + 歌手搜索歌词'
                    }</span></div>`
              }
            </div>
          </section>
        </aside>
      </div>

      <footer class="song-bar">
        <div class="song-bar-now">
          <span class="song-bar-cover">${cover ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer" />` : icon('music')}</span>
          <span class="song-bar-copy">
            <strong id="dock-title">${esc(current?.title || '还没有点歌')}</strong>
            <small id="dock-now-artist">${esc(current?.artist || '音乐')}</small>
          </span>
        </div>

        <div class="song-bar-center">
          <div class="song-bar-controls">
            <button class="song-bar-btn" data-action="song-prev" title="上一首">${icon('chevron-left')}</button>
            <button class="song-bar-play ${playing ? 'is-ready' : ''}" data-action="song-play" title="播放 / 暂停">
              <svg class="icon"><use id="dock-play-use" href="#i-play"></use></svg>
            </button>
            <button class="song-bar-btn" data-action="song-next" title="下一首">${icon('chevron-right')}</button>
          </div>
          <div class="song-bar-progress">
            <span id="song-current">0:00</span>
            <input type="range" id="song-progress" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
            <span id="song-duration">0:00</span>
          </div>
        </div>

        <div class="song-bar-right">
          ${playModePopMarkup('dock-play-mode', 'song-bar-pop')}
          ${qualityPopMarkup('dock-quality', 'song-bar-pop')}
          <button class="song-bar-btn song-fx-btn${state.audioFx?.preset && state.audioFx.preset !== 'off' ? ' active' : ''}" data-action="open-audio-fx" title="音效（空间感 / 耳机定位 / 频段增强）" aria-label="音效设置"><span>${state.audioFx?.preset && state.audioFx.preset !== 'off' ? audioFxLabel() : '音效'}</span></button>
          <button class="song-bar-btn" data-action="song-mute" title="静音">
            <svg class="icon"><use id="dock-volume-use" href="${state.songMuted ? '#i-volume-x' : '#i-volume'}"></use></svg>
          </button>
          <input class="song-bar-volume" id="dock-volume" type="range" min="0" max="100" step="1" value="${state.songVolume}" aria-label="音量" data-no-sound />
          <button class="song-bar-btn" data-action="dock-list-toggle" title="${state.dockListOpen ? '收起播放列表' : '播放列表'}" aria-expanded="${state.dockListOpen ? 'true' : 'false'}">${icon('library')}</button>
        </div>
        ${dockQueueMarkup()}
      </footer>

      <svg hidden style="display:none"><use id="song-mute-use" href="${state.songMuted ? '#i-volume-x' : '#i-volume'}"></use></svg>
    </div>`;
}

function songView() {
  return karaokeViewMarkup();
}

/* ── 我的歌单：按平台分区，登录统一走「音乐账号」面板 ─────────────── */

/* 账号歌单只覆盖这三家；酷狗已整条移除（不在 MUSIC_SOURCE_KEYS 里，
   它的分组即便主进程还回来也会被 musicPlatformEnabled 拦掉）。 */
/*
 * 平台显示名（2026-11-18）。
 * 之前少了 kugou —— 酷狗歌单的标签会掉进兜底文案显示成「音乐」，
 * 用户看到的就是一个莫名其妙的标签，还以为自己的酷狗歌单没了。
 */
const MUSIC_PLATFORM_LABELS = { netease: '网易云', qq: 'QQ 音乐', kuwo: '酷我', kugou: '酷狗' };

function musicPlatformLabel(platform) {
  return MUSIC_PLATFORM_LABELS[platform] || '音乐';
}

/**
 * 一张歌单卡片：封面 + 名字 + 曲目数。
 *
 * 只有「链接导入」的卡片右上角带移除按钮：账号同步出来的歌单属于平台账号，
 * 本地删了下一次同步就回来，那种得去平台自己删，给按钮只会让人以为删了没生效。
 * 广场卡片（item.plaza）是公开歌单，不是「我的」，也不给。
 */
function playlistCardMarkup(item, platform, active) {
  const cover = item.cover
    ? `<img src="${esc(item.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : icon('music');
  const pid = esc(item.id);
  const pplatform = esc(platform);
  const removable = item.imported && !item.plaza;
  return `
    <div class="playlist-card ${active ? 'is-open' : ''}" data-id="${pid}" data-platform="${pplatform}">
      <span class="playlist-card-cover">
        <button class="playlist-card-body" data-action="my-playlist-open" data-platform="${pplatform}" data-id="${pid}" title="${esc(item.name)}">
          ${cover}
          <span class="playlist-card-count">${item.count ? `${item.count} 首` : '歌单'}</span>
        </button>
        <button class="playlist-card-play" data-action="my-playlist-play" data-platform="${pplatform}" data-id="${pid}" title="播放歌单" aria-label="播放歌单">${icon('play')}</button>
        ${
          removable
            ? `<button class="playlist-card-del" data-action="my-playlist-remove" data-platform="${pplatform}" data-id="${pid}" data-name="${esc(item.name)}" title="从我的歌单移除" aria-label="从我的歌单移除">${icon('trash', 'xs')}</button>`
            : ''
        }
      </span>
      <span class="playlist-card-name">${esc(item.name)}</span>
      <span class="playlist-card-sub">${
        item.plaza
          ? [item.creator, item.playcount ? formatPlaycount(item.playcount) + '次播放' : ''].filter(Boolean).join(' · ') || '公开歌单'
          : item.imported ? '链接导入' : item.subscribed ? '收藏歌单' : '自建歌单'
      }</span>
    </div>`;
}

/**
 * 歌单详情一次最多渲染多少首。
 *
 * 2026-11-18：1944 首的酷狗歌单全量渲染会直接把渲染进程撑崩
 * （crash.log 实测 render-process-gone exitCode=-2147483645）。
 * 200 首足够覆盖绝大多数浏览场景，剩下的用「显示全部」按需展开。
 */
const DETAIL_RENDER_LIMIT = 200;

/**
 * 点开的某张歌单：整块主区换成「返回 / 标题 / 整张播放 / 加入队列 + 全量曲目」。
 *
 * 以前曲目详情是挂在卡片墙下面的，歌单多的时候要一路滑到底才看得到曲目，
 * 用户反馈「点进去没反应」。现在改成钻取：点卡片 → 主区只剩这张歌单，
 * 头部常驻四个动作，进来第一眼就能整张播放。
 *
 * 曲目数据仍然完整保留（不再截断到 100 首），只是渲染分批：
 * 首屏 200 首 + 「显示全部」，避免大歌单把渲染进程打崩。
 */
function playlistDetailMarkup(detail, platform) {
  if (!detail) return '';
  const songs = detail.songs || [];
  const label = musicPlatformLabel(platform);
  const head = `
      <div class="kr-detail-bar">
        <button class="kr-detail-back" data-action="my-playlist-close">${icon('chevron-left', 'xs')}返回歌单</button>
        <div class="kr-detail-title">
          <strong>${esc(detail.name || '歌单')}</strong>
          <small>${detail.loading ? '正在读取…' : `${songs.length} 首 · ${esc(label)}`}</small>
        </div>
        <div class="kr-detail-actions">
          <button class="kr-detail-play" data-action="my-playlist-play" data-platform="${esc(platform)}" data-id="${esc(detail.id || '')}" ${songs.length ? '' : 'disabled'}>${icon('play', 'xs')}整张播放</button>
          <button class="playlists-chip" data-action="my-playlist-import" data-platform="${esc(platform)}" title="整张追加到队列末尾，不打断正在放的那首" ${songs.length ? '' : 'disabled'}>${icon('plus', 'xs')}整张入队</button>
          <button class="playlists-chip${state.detailSelectMode ? ' is-active' : ''}" data-action="detail-select-mode" title="勾选若干首加入我的队列">${state.detailSelectMode ? '退出选择' : '批量选择'}</button>
          ${
            (() => {
              // 只有「链接导入」的歌单可以删：账号同步来的歌单是云端数据，我们不动
              const meta = (state.myPlaylists.groups || [])
                .flatMap((group) => (group.list || []).map((item) => ({ ...item, platform: group.platform })))
                .find((item) => String(item.id) === String(detail.id) && item.platform === platform);
              return meta && meta.imported
                ? `<button class="playlists-chip is-danger" data-action="my-playlist-remove" data-platform="${esc(platform)}" data-id="${esc(detail.id || '')}" data-name="${esc(detail.name || '这张歌单')}" title="只删启动器里的记录，不动账号">${icon('trash', 'xs')}删除歌单</button>`
                : '';
            })()
          }
        </div>
      </div>`;

  if (detail.loading) {
    /*
     * 首次点开的读取占位：把卡片上登记的曲目数亮出来（网易云大歌单退本地
     * API 全量解析时可能要几十秒），再垫几行骨架，别整页只有一句话。
     */
    const count = findPlaylistCount(platform, detail.id);
    const hint = count ? `正在读取曲目（共 ${count} 首，大歌单解析需要一些时间）` : '正在读取曲目…';
    const skeleton = Array.from({ length: 6 }, () => '<span class="kr-detail-skeleton-row"></span>').join('');
    return `<div class="kr-detail">${head}<p class="playlists-group-note">${esc(hint)}</p><div class="kr-detail-skeleton">${skeleton}</div></div>`;
  }
  if (!songs.length) {
    return `<div class="kr-detail">${head}<p class="playlists-group-note">这个歌单里没有读到曲目。</p></div>`;
  }
  const current = state.songs[state.songIndex] || null;
  /*
   * 2026-11-18 防崩溃：歌单详情分段渲染。
   *
   * 用户点开 1944 首的酷狗歌单后，渲染进程直接崩溃
   * （crash.log: render-process-gone exitCode=-2147483645）。
   * 原因就是这里一次性 map 出 1944 个按钮 + 1944 个封面 <img>，
   * 单页 DOM 节点与图片解码内存一起顶爆。
   * 现在默认只渲染前 DETAIL_RENDER_LIMIT 首，底部给「显示全部」；
   * 配合 CSS 的 content-visibility，即使用户点了全部也不会一次布局几千行。
   */
  const detailKey = `${platform}:${detail.id || ''}`;
  const expanded = Boolean(state.myPlaylists?.detailExpanded?.[detailKey]);
  const visible = expanded ? songs : songs.slice(0, DETAIL_RENDER_LIMIT);
  return `
    <div class="kr-detail">${head}
      ${
        state.detailSelectMode
          ? `<div class="song-queue-brush">
              <span>已选 <b>${(state.detailSelected || []).length}</b> 首</span>
              <select class="song-queue-brush-target" data-detail-target title="选择要加入哪个歌单">
                <option value="queue">我的队列</option>
                ${(state.localPlaylists || [])
                  .map((pl) => `<option value="${esc(pl.id)}">${esc(pl.name)}</option>`)
                  .join('')}
              </select>
              <button class="song-queue-brush-btn" data-action="detail-select-add" ${(state.detailSelected || []).length ? '' : 'disabled'}>加入</button>
              <button class="song-queue-brush-btn is-danger" data-action="detail-select-remove" ${(state.detailSelected || []).length ? '' : 'disabled'}>从我的队列移除</button>
              <button class="song-queue-brush-btn" data-action="detail-select-mode">取消</button>
            </div>`
          : `<p class="kr-detail-hint">点任意一首就直接开播，后面按歌单顺序接着往下放；「批量选择」可以勾选多首加进我的队列。</p>`
      }
      <div class="playlist-songs kr-detail-songs">
        ${visible
          .map((song, index) => {
            const playing = sameSongKey(song, current);
            return `
          <div class="kr-detail-row${(state.detailSelected || []).includes(index) ? ' is-brush-selected' : ''}">
            <button class="song-chart-song kr-detail-song${playing ? ' is-current' : ''}" data-action="my-playlist-song" data-platform="${esc(platform)}" data-index="${index}" title="${playing ? '正在播放这一首' : '播放这首，后面按歌单顺序接着放'}">
              <span class="song-chart-index">${playing ? '♪' : index + 1}</span>
              <span class="song-chart-cover">${song.cover ? `<img src="${esc(song.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : icon('music')}</span>
              <span class="song-chart-copy">
                <strong>${esc(song.title)}</strong>
                <small>${esc(song.artist || '未知歌手')}</small>
              </span>
              ${icon('play', 'xs')}
            </button>
            <button class="kr-detail-add" data-action="my-playlist-song-add" data-platform="${esc(platform)}" data-index="${index}" title="加入我的队列" aria-label="加入我的队列">${icon('plus', 'xs')}</button>
            <button class="kr-detail-del" data-action="my-playlist-song-remove" data-platform="${esc(platform)}" data-index="${index}" title="从我的队列移除（不影响账号歌单）" aria-label="从我的队列移除">${icon('x', 'xs')}</button>
          </div>`;
          })
          .join('')}
      </div>
      ${
        songs.length > visible.length
          ? `<button class="kr-detail-more" data-action="my-playlist-show-all" data-platform="${esc(platform)}" data-id="${esc(detail.id || '')}">显示全部 ${songs.length} 首（还有 ${songs.length - visible.length} 首）</button>`
          : ''
      }
    </div>`;
}

/** 单个平台分区。 */
function myPlaylistGroupMarkup(group) {
  const { platform, list = [], error = '', loading = false } = group;
  const label = group.label || musicPlatformLabel(platform);
  // 只有这个平台自己在同步时才转圈；别的平台同步不影响这一行
  const syncing = playlistSyncing(platform) || loading;
  const when = playlistSyncWhen(group, { withCost: true });
  const showError = Boolean(error);
  const meta = syncing
    ? '同步中…'
    : showError
      ? group.stale
        ? '读取失败 · 显示上次结果'
        : group.expired
          ? '登录失效'
          : '读取失败'
      : `${list.length} 个歌单${when ? ` · ${when.replace('上次同步：', '')}` : ''}`;

  const head = `<div class="playlists-group-head">
      <span class="playlists-group-name"><span class="mp-dot" data-platform="${esc(platform)}"></span>${esc(label)}</span>
      <span class="playlists-group-tail">
        <span class="playlists-group-meta">${meta}</span>
        <button class="kr-group-sync" data-action="music-sync-one" data-platform="${esc(platform)}"
          title="${syncing ? `正在同步 ${esc(label)}…` : `只同步 ${esc(label)}，其它平台不动`}" ${syncing ? 'disabled' : ''}>${icon('refresh', 'xs')}</button>
      </span>
    </div>`;

  if (loading && !list.length) {
    return `<section class="playlists-group">${head}<p class="playlists-group-note">正在读取 ${esc(label)} 账号里的歌单…</p></section>`;
  }
  if (error && !list.length) {
    /*
     * 分类处理：登录态过期（QQ 音乐 500003）时，
     * 用户真正要做的是重新登录，不是「再读一次」。
     * 所以这种情况直接把登录按钮递到手上，别让他反复刷新对着报错看。
     */
    const expired = Boolean(group.expired);
    const reloginAction = platform === 'netease' ? 'netease-login' : 'music-account-login';
    return `<section class="playlists-group is-expired">${head}
      <p class="playlists-group-note">${expired ? `${esc(label)} 的登录已经失效了，重新登录一次就能读歌单。` : esc(error)}</p>
      ${
        expired
          ? `<div class="playlists-group-actions">
              <button class="btn btn-primary btn-sm" data-action="${reloginAction}" data-platform="${esc(platform)}">${icon('login')}重新登录</button>
              <button class="playlists-chip" data-action="music-sync-one" data-platform="${esc(platform)}">${icon('refresh', 'xs')}再试一次</button>
            </div>`
          : `<button class="playlists-chip" data-action="music-sync-one" data-platform="${esc(platform)}">${icon('refresh', 'xs')}重新读取</button>`
      }
      ${expired ? `<details class="playlists-group-detail"><summary>看看具体原因</summary><p>${esc(error)}</p></details>` : ''}
    </section>`;
  }
  if (!list.length) {
    return `<section class="playlists-group">${head}<p class="playlists-group-note">这个账号下还没有歌单。</p></section>`;
  }

  return `<section class="playlists-group">${head}
    ${
      // 这次读失败但留着上次的卡片时，把原因挂在卡片上方，别让人以为是最新的
      showError ? `<p class="playlists-group-note is-stale">${esc(error)}</p>` : ''
    }
    <div class="playlist-cards">
      ${list.map((item) => playlistCardMarkup(item, platform, false)).join('')}
    </div>
  </section>`;
}

/**
 * 「我的歌单」总面板：所有已登录平台的歌单一起列。
 *
 * 登录入口只在右上角「账号」这一处（和「音乐账号」弹窗是同一个），
 * 不再在每个平台旁边各放一套「扫码登录」，避免和账号面板重复。
 */
function allPlaylistsMarkup() {
  const groups = state.myPlaylists.groups || [];
  // 酷狗已整条移除；酷我的账号歌单入口也早已下线（只保留链接导入的歌单），
  // 所以这里只剩网易云和 QQ 两家需要「登录态」。
  const ACCOUNT_PLATFORMS = ['netease', 'qq'];
  const logged = ACCOUNT_PLATFORMS.filter(musicLoggedIn);

  /*
   * 钻取态：点开某张歌单后整块主区只显示这张歌单的曲目。
   * 放在最前面判断，未登录时点开的广场歌单也走这里。
   */
  const detail = state.myPlaylists.detail;
  if (detail) return playlistDetailMarkup(detail, detail.platform);

  if (!logged.length) {
    /*
     * 没登录时只提示登录，歌单广场已经独立成一个导航项，不再拼在这一页底部。
     */
    return `<div class="playlists-panel">
      <div class="playlists-error">${icon('login', 'xs')}<span>登录后这里会列出你账号里的歌单。</span>
        <button class="link-btn" data-action="music-accounts">去登录</button>
      </div>
      <div class="playlists-empty-hint">
        <p>还没登录任何音乐账号。</p>
        <p>想先听歌？左栏「<b>歌单广场</b>」里的热门公开歌单不用登录，点开就能看、能整张播放。</p>
      </div>
    </div>`;
  }

  /*
   * 账号歌单同步可能失败或未登录，导入的歌单会落在未登录（或没同步成功）的分组里。
   * 已登录平台照常显示；没登录但分组里有歌单（只可能是链接导入的）也要画出来，
   * 不然导入完一刷新歌单就「消失」，用户会以为导入失败了。
   */
  const extra = groups.filter(
    (group) =>
      group.platform &&
      // 酷我已从歌单入口移除：账号同步的分组不再显示，
      // 但「链接导入」的酷我歌单还是用户的资产，得让它看得见
      (group.platform !== 'kuwo' || (group.list || []).some((pl) => pl.imported)) &&
      !logged.includes(group.platform) &&
      (group.list || []).length
  );
  const shown = [...logged, ...extra.map((group) => group.platform)]
    // 只按登录态显示，不再吃音源开关：音源开关管的是「解析地址时用不用这个平台的直链」，
    // 和「账号里同步到的歌单要不要显示」是两回事。以前挂在同一张表上，
    // QQ 音源默认停用就会把已登录的 QQ 歌单整组藏掉（表现为「QQ音乐 已同步 10 个歌单」但列表里没有）。
    .filter(Boolean)
    .map((key) => {
      const found = groups.find((group) => group.platform === key);
      if (found) return found;
      return { platform: key, label: musicPlatformLabel(key), list: [], error: '', loading: true };
    });
  const total = shown.reduce((sum, group) => sum + (group.list || []).length, 0);
  const syncing = Boolean(state.myPlaylists.loadingAll) || shown.some((group) => playlistSyncing(group.platform) || group.loading);
  // 未登录平台的「去登录」提示：同样不再吃音源开关，按平台能力决定
  const idle = ACCOUNT_PLATFORMS.filter((key) => !logged.includes(key));

  /*
   * 平台 tab：登录的平台多了以后，四组卡片纵向堆叠要把页面滚很久。
   * 改成一次只看一个平台（和下面歌单广场同一套 tab 交互），
   * 默认停在有歌单的第一个平台上，切过的选择记在会话里。
   */
  const activeTab = shown.some((group) => group.platform === state.myPlaylists.activeTab)
    ? state.myPlaylists.activeTab
    : (shown.find((group) => (group.list || []).length)?.platform || shown[0]?.platform || '');
  const activeGroup = shown.find((group) => group.platform === activeTab);
  const tabCounts = new Map(shown.map((group) => [group.platform, (group.list || []).length]));

  return `<div class="playlists-panel">
    <div class="playlists-bar">
      <div class="playlists-bar-title">
        <strong>我的歌单</strong>
        <span>${shown.length} 个平台 · ${syncing ? '同步中…' : `${total} 个歌单`}</span>
      </div>
      <div class="playlists-bar-actions">
        <button class="playlists-chip" data-action="music-sync-all" ${state.myPlaylists.loadingAll ? 'disabled' : ''}>${icon('refresh', 'xs')}${state.myPlaylists.loadingAll ? '同步中' : '同步全部'}</button>
        <button class="playlists-chip" data-action="music-accounts">${icon('settings', 'xs')}账号</button>
      </div>
    </div>
    ${
      state.myPlaylists.error
        ? `<div class="playlists-error">${icon('alert', 'xs')}<span>${esc(state.myPlaylists.error)}</span>
            <button class="link-btn" data-action="music-sync-all">重试</button>
          </div>`
        : ''
    }
    <div class="song-chart-tabs playlists-platform-tabs">
      ${shown
        .map(
          (group) =>
            `<button class="song-chart-tab ${group.platform === activeTab ? 'active' : ''}" data-action="my-playlist-tab" data-value="${esc(group.platform)}">${esc(group.label || musicPlatformLabel(group.platform))}${tabCounts.get(group.platform) ? `<small>${tabCounts.get(group.platform)}</small>` : ''}</button>`
        )
        .join('')}
      ${
        idle.length
          ? idle
              .map(
                (key) =>
                  `<button class="song-chart-tab is-idle" data-action="music-accounts" title="去音乐账号里登录">${esc(musicPlatformLabel(key))}＋</button>`
              )
              .join('')
          : ''
      }
    </div>
    ${activeGroup ? myPlaylistGroupMarkup(activeGroup) : ''}
  </div>`;
}

/**
 * 歌单广场独立面板（2026-11-18）。
 *
 * 以前它被拼在「我的歌单」页面最底部，歌单一多就得往下滚很久，用户原话
 * 「歌单广场难看到」。现在它是左栏「发现」里独立的一项，进来就是它本身。
 * 点开广场里的某张歌单同样走钻取态（playlistDetailMarkup）。
 */
function plazaPanelMarkup() {
  const detail = state.myPlaylists.detail;
  if (detail) return playlistDetailMarkup(detail, detail.platform);
  return `<div class="playlists-panel">${plazaSectionMarkup()}</div>`;
}

function chartPanelMarkup() {
  const c = state.charts;
  // 酷狗已整条移除：榜单 tab 和合并计数都只保留网易云与 QQ。
  const platforms = [
    ['all', '全部榜单'],
    ['netease', '网易云'],
    ['qq', 'QQ 音乐'],
  ];
  const chartList = c.list || [];
  const counts = c.counts || {};
  // 老会话里可能还存着已下线平台的 tab 值，落到「全部榜单」上，别让按钮一个都不高亮
  const activePlatform = platforms.some(([key]) => key === c.platform) ? c.platform : 'all';
  /*
   * 单平台 tab 也带着 { [platform]: 0, merged: 0 } 回来，照直显示就是「QQ 0 · 网易云 0，
   * 去重后 0」——纯噪音。只有同时有两家以上计数时才认为是真的合并结果才显示。
   */
  const countedPlatforms = ['netease', 'qq'].filter((key) => Number.isFinite(counts[key]));
  const countLine =
    Number.isFinite(counts.merged) && countedPlatforms.length > 1
      ? `QQ ${counts.qq || 0} · 网易云 ${counts.netease || 0}，去重后 ${counts.merged}`
      : '';
  return `
    <section class="song-charts">
      <div class="song-panel-head">
        <span>${icon('star')}榜单 <em>${chartList.length}</em>${
          countLine ? `<small>${countLine}</small>` : ''
        }</span>
        <span class="song-chart-tabs">
          ${platforms
            .map(
              ([key, label]) =>
                `<button class="song-chart-tab ${activePlatform === key ? 'active' : ''}" data-action="chart-platform" data-value="${key}">${label}</button>`
            )
            .join('')}
        </span>
      </div>
      ${
        c.error
          ? `<div class="notice-error">${icon('info', 'xs')} ${esc(c.error)}</div>`
          : ''
      }
      ${
        c.loading
          ? `<p class="gacha-empty-line">正在读取榜单…</p>`
          : chartList.length
            ? `<div class="song-chart-list">
                ${chartList
                  .map(
                    (chart) => `
                  <button class="song-chart-row ${c.detail && c.detail.id === chart.id ? 'active' : ''}"
                    data-action="chart-open" data-platform="${esc(c.platform)}" data-id="${esc(chart.id)}"
                    title="${esc(chart.sourceLabel || '')}">
                    <span class="song-chart-name">${esc(chart.name)}</span>
                    ${
                      chart.sourceLabel
                        ? `<span class="song-chart-source">${esc(chart.sourceLabel)}</span>`
                        : ''
                    }
                    <span class="song-chart-meta">${esc(chart.updateKey || '')}</span>
                    ${icon('chevron-right', 'xs')}
                  </button>`
                  )
                  .join('')}
              </div>`
            : `<p class="gacha-empty-line">选一个平台读取榜单</p>`
      }
      ${
        c.detail && c.detail.songs && c.detail.songs.length
          ? `<div class="song-chart-detail">
              <div class="song-chart-detail-head">
                <strong>${esc(c.detail.name)}</strong>
                <button class="link-btn" data-action="chart-import" data-platform="${esc(c.platform)}">
                  ${icon('plus', 'xs')}全部转到网易云
                </button>
              </div>
              ${c.detail.songs
                .slice(0, 20)
                .map(
                  (song, index) => `
                <button class="song-chart-song" data-action="chart-to-netease" data-platform="${esc(c.platform)}" data-index="${index}">
                  <span class="song-chart-index">${index + 1}</span>
                  <span class="song-chart-cover">${song.cover ? `<img src="${esc(song.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : icon('music')}</span>
                  <span class="song-chart-copy">
                    <strong>${esc(song.title)}</strong>
                    <small>${esc(song.artist || '未知歌手')}</small>
                  </span>
                  ${icon('search', 'xs')}
                </button>`
                )
                .join('')}
            </div>`
          : ''
      }
      <p class="song-chart-note">榜单是公开数据，不用登录也能看。要读自己账号里的歌单，去右上角「账号」里的音乐账号面板登录一次就够了，登录后会一直记着。</p>
    </section>`;
}
