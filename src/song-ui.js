'use strict';

/**
 * 点歌台的视图层。
 *
 * 拆出来是为了两件事：
 *   1. 四个平台的登录（网易云扫码 / QQ 音乐 / 酷狗 / 酷我）统一到一个「音乐账号」面板；
 *   2. 点歌台重排成「左侧曲库导航 + 主区（搜索 / 队列 / 榜单 / 我的歌单）+ 右侧栏」。
 *
 * 左栏的存在理由：「我的歌单」原来挂在主区最底下，网易云账号歌单一多，
 * 要一路滚到页面底部才点得到。挪进常驻左栏后一眼可见，一次点击就进。
 *
 * 依赖 app.js 里的全局：state / icon / esc / songCover / parseLrc / musicLoggedIn /
 * musicPlatformLabel / playlistSyncSummary / playModeOptions / audioFxLabel /
 * AUDIO_FX_PRESETS / chartPanelMarkup / allPlaylistsMarkup / ensureAllPlaylistsLoaded /
 * invalidateAllPlaylists / syncPlaylistsAfterLogin / refreshNeteaseLogin /
 * toast / openModal / closeModal / api。
 */

const SONG_TABS = [
  /*
   * 2026-11-18：去掉「我的歌单」分页。
   * 左栏已经把歌单逐条列出来了，主区再摆一面歌单卡片墙属于同一件事做两遍，
   * 用户原话「中间留那大块地方放歌单吗？作用重复了吧」。
   * 现在主区只负责「队列 / 当前歌单曲目 / 歌单广场 / 榜单 / 搜索」。
   */
  ['queue', '队列'],
  ['plaza', '歌单广场'],
  ['charts', '榜单'],
  ['search', '搜索'],
];
const TAB_LABELS = new Map(SONG_TABS);
/* 左栏两项最容易混：队列是「你点过的歌」，我的歌单是「平台上收藏的整张歌单」。
 * 名字下面挂一行小字，比任何 tooltip 都直接。 */
const NAV_SUBTITLES = {
  queue: '点过的歌都在这',
  mine: '各平台收藏的歌单',
  plaza: '热门公开歌单，免登录',
};

/* ── 搜索 ─────────────────────────────────────────────────── */

/**
 * 搜索栏：关键字输入 + 平台选择 + 搜索按钮。
 * 放在标签页那一行的右侧，切哪个分页都在。
 */
function songSearchMarkup() {
  const s = state.songSearch;
  const platforms = [
    ['all', '四平台'],
    ['qq', 'QQ 音乐'],
    ['kugou', '酷狗'],
    ['netease', '网易云'],
    ['kuwo', '酷我'],
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
    return `<div class="song-empty">${icon('search')}<strong>正在搜索…</strong><span>同时查四个平台的公开接口。</span></div>`;
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

/** 三个平台，顺序固定：左栏、账号列表、登录面板都用这一份。酷我已从歌单/账号入口移除。 */
const MUSIC_ACCOUNTS = [
  ['netease', '网易云音乐'],
  ['qq', 'QQ 音乐'],
  ['kugou', '酷狗音乐'],
];

function musicAccountLoggedIn(platform) {
  if (platform === 'netease') return Boolean(state.neteaseLogin?.loggedIn);
  return Boolean(state.musicLogin?.[platform]?.loggedIn);
}

/**
 * 账号状态：只回答「登没登录、是哪个号」。
 * on 决定徽标文字（已登录 / 未登录），detail 是能拿到的账号信息，没有就留空不占行。
 */
function musicAccountStatus(platform) {
  if (!musicAccountLoggedIn(platform)) return { on: false, detail: '' };
  if (platform === 'netease') return { on: true, detail: state.neteaseLogin?.apiBase ? '已连接本地服务' : '' };
  const info = state.musicLogin?.[platform] || {};
  const id = info.uin || info.userid || '';
  return { on: true, detail: id ? `ID ${id}` : '' };
}

/** 面板顶部那行小字：说清「登没登录、是哪个号」，别写成操作提示。 */
function musicAccountHeadText(platform) {
  const status = musicAccountStatus(platform);
  if (!status.on) return '未登录';
  return status.detail ? `已登录 · ${status.detail}` : '已登录';
}

/**
 * 点歌台右上角唯一的账号入口。
 *
 * 以前这里平铺三个平台胶囊（酷我压根没排进去），四个平台就占掉半行；
 * 现在只留一个按钮，点开再去选平台。
 */
function musicAccountEntryMarkup() {
  const total = MUSIC_ACCOUNTS.length;
  const on = MUSIC_ACCOUNTS.filter(([key]) => musicAccountLoggedIn(key)).length;
  return `
    <button class="kr-acct-entry ${on ? 'is-on' : ''}" data-action="music-accounts"
      title="${on ? `${on} 个平台已登录，点开管理或退出` : '登录音乐账号'}">
      ${icon(on ? 'check' : 'login', 'xs')}
      <span>${on ? `账号 · 已登录 ${on}/${total}` : '登录'}</span>
    </button>`;
}

/* ── 音乐账号面板（两步：选平台 → 单平台登录） ──────────────── */

/**
 * 打开音乐账号弹窗。
 *
 * 不传 platform：第一步，四个平台一行一个，点进去看详情。
 * 传 platform：第二步，只显示那一个平台的登录面板。
 *
 * 以前是四张大卡片全堆在一个框里，网易云那张还带二维码 + API 输入框 + 启动服务按钮，
 * 一打开就是半个屏幕的空白和一堆技术字段 —— 用户的原话是「那么大个框，完全不好看」。
 */
function openMusicAccountsModal(focus = '') {
  const platform = MUSIC_ACCOUNTS.some(([key]) => key === focus) ? focus : '';
  const body = platform ? krAccountPanelMarkup(platform) : krAccountListMarkup();
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal kr-login-modal" role="dialog" aria-modal="true" data-platform="${platform}" tabindex="-1" autofocus>
        ${body}
      </div>
    </div>
  `);
  bindMusicAccountsModal(platform);
}

/** 第一步：平台列表。 */
function krAccountListMarkup() {
  const rows = MUSIC_ACCOUNTS.map(([key, label]) => {
    const status = musicAccountStatus(key);
    return `
      <div class="kr-acct-row ${status.on ? 'is-on' : ''}">
        <button class="kr-acct-main" data-action="music-accounts" data-platform="${esc(key)}"
          title="${status.on ? `${esc(label)} 已登录，点进去管理` : `登录 ${esc(label)}`}">
          <span class="mp-dot" data-platform="${esc(key)}"></span>
          <span class="kr-acct-copy">
            <strong>${esc(label)}</strong>
            ${status.detail ? `<small>${esc(status.detail)}</small>` : ''}
          </span>
          <span class="kr-acct-tag">${status.on ? '已登录' : '未登录'}</span>
        </button>
        ${
          status.on
            ? key === 'netease'
              ? // 网易云的退出走它自己的接口：music:logout 只认 QQ / 酷狗 / 酷我
                `<button class="kr-acct-out" id="kr-acct-out-netease">退出</button>`
              : `<button class="kr-acct-out" data-action="music-account-logout" data-platform="${esc(key)}">退出</button>`
            : ''
        }
      </div>`;
  }).join('');

  return `
    <div class="modal-head kr-login-head">
      <div class="kr-login-title">
        <h2>音乐账号</h2>
        <p>三个平台各登各的，想登哪个点进去。</p>
      </div>
      <button class="icon-btn" data-close>${icon('x')}</button>
    </div>
    <div class="modal-body kr-login-body">
      <div class="kr-acct-list">${rows}</div>
      <p class="kr-acct-note">凭证只加密保存在这台电脑上，不会上传。登录后「我的歌单」「榜单」会按平台分开显示。</p>
    </div>`;
}

/** 第二步：单平台登录面板。 */
function krAccountPanelMarkup(platform) {
  const label = (MUSIC_ACCOUNTS.find(([key]) => key === platform) || ['', ''])[1];
  const stateId = platform === 'netease' ? 'net-acc-state' : platform === 'qq' ? 'qq-acc-state' : platform === 'kugou' ? 'kg-acc-state' : 'kw-acc-state';
  const head = `
    <div class="modal-head kr-login-head">
      <button class="kr-login-back" id="kr-acct-back" title="返回平台列表">${icon('chevron-left', 'xs')}<span>返回</span></button>
      <div class="kr-login-title">
        <h2>${esc(label)}</h2>
        <p id="${stateId}">${esc(musicAccountHeadText(platform))}</p>
      </div>
      <button class="icon-btn" data-close>${icon('x')}</button>
    </div>`;

  if (platform === 'netease') {
    const apiDefault = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
    /*
     * 二维码这里只是 160px 的小图 + 右边一段状态文字，不再套一层大卡片。
     * 下面这些 id 是和 app.js / bindNeteaseQr 的契约（二维码出图、状态刷新、退出都靠它们），
     * 换结构可以，名字不能动。
     */
    return `${head}
      <div class="modal-body kr-login-body">
        <div class="kr-login-qr">
          <div class="netease-qr-image" id="netease-qr-image">${icon('music')}</div>
          <div class="kr-login-qr-copy">
            <strong id="netease-login-status">等待获取二维码</strong>
            <span id="netease-login-hint">用网易云音乐 App 扫一下，扫完在手机上确认。</span>
            <div class="kr-login-qr-actions">
              <button class="btn btn-ghost btn-sm" id="net-qr-refresh">${icon('refresh')}刷新二维码</button>
              <button class="kr-login-link" id="net-acc-logout">退出登录</button>
            </div>
          </div>
        </div>
        <div class="kr-login-adv">
          <button class="kr-login-adv-toggle" id="kr-login-adv-toggle" aria-expanded="false">
            ${icon('chevron-down', 'xs')}<span>高级：本地服务地址</span>
          </button>
          <div class="kr-login-adv-body" id="kr-login-adv-body" hidden>
            <span>扫码要连本机的 NeteaseCloudMusicApi，不确定就保持默认。</span>
            <div class="kr-login-adv-row">
              <input class="text-input" id="netease-login-api" value="${esc(apiDefault)}" placeholder="http://127.0.0.1:3100" spellcheck="false" />
              <button class="btn btn-ghost btn-sm" id="netease-service-start">${icon('play')}启动服务</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  const notes = {
    qq: '弹出的官方登录页里，扫码 / QQ / 微信 / 手机验证码都行，登完窗口会自己关掉，歌单跟着同步过来。',
    kugou: '同样走官方登录页，Cookie 按域内判断，不会莫名其妙掉登录。登录之后能用的是榜单和搜索。',
    kuwo: '弹出来的是酷我官网，点右上角「登录」，扫码或手机号都行；登完「我的歌单」会读出默认列表和「我喜欢听」。',
  };

  /*
   * 酷狗 / 酷我的兜底说明。
   *
   * 酷狗网页端「我的歌单」接口官方已经关了，登录成功也读不到账号里的歌单，
   * 但歌单链接（t1.kugou.com 短链、/plist/list/数字、share.html?chain=…）是通的。
   * 这段就是把用户往「导入歌单链接」那边引，按钮直接复用点歌台现成的 action。
   */
  const tips = {
    kugou: `
      <div class="kr-login-tip is-warn">
        <div class="kr-login-tip-head">${icon('alert', 'sm')}<strong>账号里的歌单读不出来</strong></div>
        <p>酷狗官方把网页端「我的歌单」接口关了，登进去也拿不到你自己账号里的歌单 —— 登录只对榜单、搜索有用。</p>
        <p>想听自己的歌单，用「导入歌单链接」把分享链接粘进来就行，<code>t1.kugou.com/xxxx</code> 这种短链也认。</p>
        <button class="btn btn-ghost btn-sm kr-login-tip-btn" data-action="import-playlist-link">${icon('download')}去导入歌单链接</button>
      </div>`,
    kuwo: `
      <div class="kr-login-tip">
        <div class="kr-login-tip-head">${icon('info', 'sm')}<strong>歌单读不全，就用链接导入</strong></div>
        <p>酷我的账号歌单接口不太稳，有时候只给默认那几张。拿不准就用「导入歌单链接」贴一张歌单分享链接，一样能听。</p>
        <button class="btn btn-ghost btn-sm kr-login-tip-btn" data-action="import-playlist-link">${icon('download')}去导入歌单链接</button>
      </div>`,
  };

  return `${head}
    <div class="modal-body kr-login-body">
      <p class="kr-login-note">${esc(notes[platform] || '')}</p>
      ${tips[platform] || ''}
      <div class="kr-login-actions">
        <button class="btn btn-primary" data-action="music-account-login" data-platform="${esc(platform)}">${icon('login')}打开登录窗口</button>
        <button class="kr-login-link" data-action="music-account-logout" data-platform="${esc(platform)}">退出登录</button>
      </div>
    </div>`;
}

/**
 * 登录/退出之后，如果账号弹窗还开着，把它刷成最新状态。
 *
 * 网易云面板跳过：那边有自己的二维码轮询，重开等于把正在扫的码换掉。
 */
function refreshMusicAccountsModal() {
  const modal = document.querySelector('.kr-login-modal');
  if (!modal) return;
  const current = modal.dataset.platform || '';
  if (current === 'netease') return;
  openMusicAccountsModal(current);
}

/** 绑第一步的返回 / 网易云列表退出 / 高级折叠；第二步的二维码流程还是原来的 bindNeteaseQr。 */
function bindMusicAccountsModal(platform) {
  document.querySelector('#kr-acct-back')?.addEventListener('click', () => openMusicAccountsModal());

  document.querySelector('#kr-acct-out-netease')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api.netease.logout();
      await refreshNeteaseLogin();
      invalidateAllPlaylists();
      toast('已退出 网易云', 'success');
      if (state.route === 'song') render({ preserveScroll: true });
      refreshMusicAccountsModal();
    } catch (error) {
      toast(error.message || '退出失败', 'error');
      button.disabled = false;
    }
  });

  const advToggle = document.querySelector('#kr-login-adv-toggle');
  const advBody = document.querySelector('#kr-login-adv-body');
  advToggle?.addEventListener('click', () => {
    const open = advToggle.getAttribute('aria-expanded') === 'true';
    advToggle.setAttribute('aria-expanded', String(!open));
    advToggle.classList.toggle('is-open', !open);
    advBody.hidden = open;
  });

  if (platform === 'netease') bindNeteaseQr();
}

/** 网易云的二维码流程（内嵌在账号面板里，也兼容独立调用）。 */
function bindNeteaseQr() {
  const apiInput = document.querySelector('#netease-login-api');
  const status = document.querySelector('#netease-login-status');
  const hint = document.querySelector('#netease-login-hint');
  const image = document.querySelector('#netease-qr-image');
  const refresh = document.querySelector('#net-qr-refresh');
  if (!apiInput || !refresh) return;

  /*
   * 本地服务没起来时，后端给的是一整串 "Error invoking remote method … fetch failed"。
   * 这里只把这句话翻译成人话，流程一行没动 —— 提示里直接告诉用户去哪儿点「启动服务」。
   */
  const qrErrorText = (error) => {
    const raw = String(error?.message || error || '');
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|net::|Failed to fetch/i.test(raw)) {
      return '连不上本机的网易云服务：展开下面的「高级」点「启动服务」，或者自己先把 NeteaseCloudMusicApi 跑起来。';
    }
    return humanError(error);
  };

  let timer = null;
  let qrKey = '';
  let checking = false;
  let checkFailures = 0;
  const MAX_CHECK_FAILURES = 5;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  /*
   * 扫码轮询是每 2 秒一次的高频外网请求，网络抖动、内置服务转发卡住
   * 都可能让单次 qrCheck 抛 TimeoutError。以前 catch 里直接 stop()，
   * 一次超时就把整个登录流程判死（用户看到「登录检查失败」后二维码再也不动）。
   * 现在：瞬时网络错误容错重试，连续失败到上限才真正停；checking 锁
   * 避免 2 秒间隔里堆叠出多个并发请求，把本地服务越压越慢。
   */
  const isTransientCheckError = (error) =>
    /timeout|aborted|fetch failed|ECONNREFUSED|ENOTFOUND|net::|Failed to fetch|HTTP 5\d\d/i.test(
      String(error?.message || error || '')
    );

  const check = async () => {
    if (!qrKey || checking) return;
    checking = true;
    try {
      const result = await api.netease.qrCheck({ apiBase: apiInput.value.trim(), key: qrKey });
      checkFailures = 0;
      if (result.loggedIn) {
        stop();
        status.textContent = '登录成功';
        hint.textContent = '歌单会自己同步过来，可以直接去「我的歌单」看。';
        toast('网易云登录成功', 'success');
        await refreshNeteaseLogin();
        await refreshMusicLogin();
        const chip = document.querySelector('#net-acc-state');
        if (chip) chip.textContent = '已登录';
        if (state.route === 'song') render({ preserveScroll: true });
        // 三个平台的歌单统一在这一处刷新，登录完不用再手动点一次
        await syncPlaylistsAfterLogin('netease');
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
      checkFailures += 1;
      if (isTransientCheckError(error) && checkFailures < MAX_CHECK_FAILURES) {
        status.textContent = '网络有点慢，正在重试…';
        hint.textContent = `检查登录状态暂时没连上（${checkFailures}/${MAX_CHECK_FAILURES}），会自动继续。`;
        return;
      }
      stop();
      status.textContent = '登录检查失败';
      hint.textContent = qrErrorText(error);
    } finally {
      checking = false;
    }
  };

  refresh.addEventListener('click', async () => {
    stop();
    qrKey = '';
    checking = false;
    checkFailures = 0;
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
      hint.textContent = qrErrorText(error);
      // 拿码失败就把上一张码擦掉，免得用户对着一个已经死不掉的二维码扫
      image.innerHTML = icon('music');
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
      hint.textContent = qrErrorText(error);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector('#net-acc-logout')?.addEventListener('click', async () => {
    try {
      await api.netease.logout();
      await refreshNeteaseLogin();
      invalidateAllPlaylists();
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

/* ── 左侧曲库导航栏 ───────────────────────────────────────── */

/** 左栏每一项的图标，跟 SONG_TABS 的键一一对应。 */
const KR_NAV_ICONS = { queue: 'order', charts: 'star', mine: 'music', plaza: 'library', search: 'search' };

/** 某个平台的歌单分组（没有就是 null，用来区分「没同步过」和「同步后为空」）。 */
function krPlaylistGroupOf(platform) {
  return (state.myPlaylists.groups || []).find((group) => group.platform === platform) || null;
}

/**
 * 一个平台当前的同步状态。
 *
 * 左栏和主区都读这一处，免得两边各写一套判断，出现「左栏说同步中、主区说失败」。
 * 「同步中」是按平台判断的：只同步酷狗时，另外三行该老实显示自己的歌单数。
 */
function krSyncState(platform) {
  const group = krPlaylistGroupOf(platform);
  if (playlistSyncing(platform)) return { tone: 'syncing', text: '同步中…' };
  /*
   * 没有分组不等于在同步：可能是刚登录、还没拉过这个平台。
   * 这种情况下一直显示「同步中…」会骗人，直接提示去点一次同步更诚实。
   */
  if (!group) return { tone: 'idle', text: '待同步' };
  if (group.error) return { tone: 'failed', text: group.stale ? '读取失败' : group.expired ? '登录失效' : '读取失败' };
  return { tone: 'ready', text: `${(group.list || []).length} 个` };
}

/** 这个平台上一次同步是多久以前（没有就返回空串，不给假时间）。 */
function krSyncWhen(platform) {
  const group = krPlaylistGroupOf(platform);
  const at = Number(group?.syncedAt) || 0;
  if (!at) return '';
  const diff = Date.now() - at;
  // 左栏一行只有 190px 宽，去掉空格压成「3分钟前」才塞得下
  return (diff < 60 * 1000 ? '刚刚' : relativeDate(at)).replace(/\s+/g, '');
}

/** 左栏里的一个平台行：平台名 + 该平台的状态 + 只同步该平台的按钮。 */
function krSyncRow(platform) {
  const label = musicPlatformLabel(platform);
  const sync = krSyncState(platform);
  const syncing = playlistSyncing(platform);
  const when = krSyncWhen(platform);
  const group = krPlaylistGroupOf(platform);
  const cost = Number(group?.durationMs) || 0;
  const tip = syncing
    ? `正在同步 ${label}…`
    : `只同步 ${label}${when ? `（上次 ${when}${cost ? ` · 耗时 ${(cost / 1000).toFixed(1)}s` : ''}）` : ''}`;
  /*
   * 酷狗网页端的「账号歌单」接口被官方关了，点 ↻ 永远同步不回来。
   * 这一行不再放同步按钮，换成「链接导入」：导入的歌单同样会进「我的歌单」。
   * 状态位不再写「官方已关」之类的说明字——用户已经知道要导入了，
   * 行里只留平台名和入口，有导入的歌单就显示个数。
   */
  if (platform === 'kugou') {
    // 酷狗不再放同步/导入按钮：这一行只留一句说明，入口统一在头顶那一排图标里。
    const count = (group?.list || []).length;
    return `
    <div class="kr-sync-row is-import-only"
      title="酷狗的账号歌单接口官方已经关掉了，歌单只能通过链接导入：在酷狗里分享歌单 → 复制链接 → 点右上角的下载图标粘贴进来">
      <span class="mp-dot" data-platform="${esc(platform)}"></span>
      <span class="kr-sync-name">${esc(label)}</span>
      <span class="kr-sync-note">需链接导入</span>
      ${count ? `<span class="kr-sync-state">${count} 个</span>` : ''}
    </div>`;
  }
  return `
    <div class="kr-sync-row is-${sync.tone}">
      <span class="mp-dot" data-platform="${esc(platform)}"></span>
      <span class="kr-sync-name">${esc(label)}</span>
      <span class="kr-sync-state">${esc(sync.text)}</span>
      <span class="kr-sync-when">${esc(when)}</span>
      <button class="kr-sync-btn" data-action="music-sync-one" data-platform="${esc(platform)}"
        title="${esc(tip)}" ${syncing ? 'disabled' : ''}>
        ${icon('refresh', 'xs')}
      </button>
    </div>`;
}

/**
 * 左侧导航栏。
 *
 * 分两块：上面是浏览用的分页（队列 / 榜单 / 我的歌单 / 搜索），
 * 下面是「我的歌单」的同步区 —— 每个平台一行，按钮只同步它自己那一行。
 * 需要一次性对齐全部平台时才点顶部那个「同步全部」。
 */
function krNavMarkup() {
  const tab = state.songTab || 'queue';
  // 酷狗排到最后：账号同步已被官方关掉，它在剩下的几家里最不重要。
  // 酷我已从歌单入口移除（用户要求），这里不再列它。
  const PLATFORM_ORDER = ['netease', 'qq', 'kugou'];
  const logged = PLATFORM_ORDER.filter((key) => musicLoggedIn(key));
  const syncingAll = Boolean(state.myPlaylists.loadingAll);
  const myCount = logged.reduce((sum, key) => sum + (krPlaylistGroupOf(key)?.list || []).length, 0);
  const counts = { queue: (state.pickedSongs || []).length, charts: (state.charts.list || []).length, mine: myCount };
  // 后端返回的 syncedAt / durationMs：同步慢的时候用户得知道上次是什么时候、花了多久
  const syncMeta = playlistSyncSummary();

  /*
   * 左栏分两组，不再是一排平铺：
   *   · 音乐库 = 你手里有的（队列里的歌、各平台收藏的歌单）
   *   · 发现   = 找新歌的（榜单、搜索）
   * 原来四项混在「浏览」下，用户反馈「分不清我的歌在哪」——
   * 队列和我的歌单被榜单/搜索夹在中间，看名字也分不出哪个是本地、哪个是云端。
   * 顺带给这两项挂一行小字，把「这是什么」写在名字下面。
   */
  const tabItem = (key) => {
    const label = TAB_LABELS.get(key) || key;
    const count = counts[key] || 0;
    const sub = NAV_SUBTITLES[key];
    return `
      <button class="kr-nav-item ${tab === key ? 'is-active' : ''}" data-action="song-tab" data-value="${key}" title="${esc(sub || label)}">
        <span class="kr-nav-icon">${icon(KR_NAV_ICONS[key] || 'music', 'xs')}</span>
        <span class="kr-nav-text">${label}${sub ? `<small>${sub}</small>` : ''}</span>
        ${count ? `<span class="kr-nav-count">${count}</span>` : ''}
      </button>`;
  };
  /*
   * 2026-11-18：左栏回归「导航」本职。
   *
   * 以前底下常驻一整块「平台歌单 + 同步全部 + 每个平台一行 ↻」，占掉将近一半高度，
   * 而同步是低频操作 —— 用户原话「作用不多，还占个位置」。
   * 现在同步入口收进「我的歌单」页头部（那里本来就有「同步全部 / 账号」），
   * 单平台的 ↻ 也留在了各自分组头上，左栏只保留导航和设置。
   * 同时把「歌单广场」独立成一项：原来它被塞在「我的歌单」页面底部，
   * 歌单一多要滚很久才看得到，等于藏起来了。
   */
  const navGroups = [
    ['音乐库', ['queue']],
    ['发现', ['plaza', 'charts', 'search']],
  ]
    .map(
      ([label, keys]) => `
      <div class="kr-nav-block">
        <p class="kr-nav-label">${label}</p>
        ${keys.filter((key) => TAB_LABELS.has(key)).map(tabItem).join('')}
      </div>`
    )
    .join('');

  /*
   * 左栏「我的歌单」直接列表（2026-11-18）。
   *
   * 参考 QQ 音乐 / 网易云：左栏不是只放几个导航项，而是把账号里的歌单直接铺出来，
   * 点一下就进曲目。之前歌单只在主区的卡片墙里，左栏下半截空着一大片，
   * 用户原话「左边空的那么多」。
   * 顶部给平台切换（全部 / 网易云 / QQ / 酷狗），歌单多的账号也不会一条长龙滚到底。
   */
  const groups = state.myPlaylists.groups || [];
  /*
   * 2026-11-18：只认「有 platform 且有歌单」的分组。
   * 之前不过滤，某个 platform 为空的分组会把 musicPlatformLabel 的兜底「音乐」
   * 渲染成一个真实标签，看起来像多出一个莫名其妙的平台。
   */
  const platformsWithList = groups
    .filter((group) => group.platform && (group.list || []).length)
    .map((group) => group.platform);
  const sidePlatform = state.myPlaylists.sidePlatform || 'all';
  const focusLocal = sidePlatform === 'local';
  const filteredGroups = focusLocal
    ? []
    : sidePlatform === 'all'
      ? groups.filter((group) => group.platform)
      : groups.filter((group) => group.platform === sidePlatform);
  const allPlaylists = filteredGroups.flatMap((group) =>
    (group.list || []).map((pl) => ({ ...pl, platform: group.platform }))
  );
  const showAllSide = Boolean(state.myPlaylists.sideShowAll);
  const sidePlaylists = showAllSide ? allPlaylists : allPlaylists.slice(0, 14);
  const platformTabs = `<div class="kr-nav-pl-tabs">
      <button class="kr-nav-pl-tab ${sidePlatform === 'all' ? 'is-active' : ''}" data-action="side-pl-platform" data-value="all">全部</button>
      ${platformsWithList
        .map(
          (key) =>
            `<button class="kr-nav-pl-tab ${sidePlatform === key ? 'is-active' : ''}" data-action="side-pl-platform" data-value="${esc(key)}">${esc(
              musicPlatformLabel(key)
            )}</button>`
        )
        .join('')}
      <button class="kr-nav-pl-tab ${focusLocal ? 'is-active' : ''}" data-action="side-pl-platform" data-value="local">本地</button>
    </div>`;
  /*
   * 2026-11-18：这一块改成**始终渲染**。
   * 之前用 sidePlaylists.length 作为开关，切到「本地」时远程歌单被清空、
   * sidePlaylists 变成 0，整块（连「新建歌单」按钮）一起消失了 ——
   * 正是用户说的「本地那里没新建歌单」。
   */
  const totalSideCount = allPlaylists.length + (state.localPlaylists || []).length;
  const playlistBlock = `<div class="kr-nav-block kr-nav-pl-block">
        <p class="kr-nav-label"><span>我的歌单</span><span class="kr-nav-label-hint">${totalSideCount}</span></p>
        ${platformTabs}
        ${sidePlaylists
          .map(
            (pl) => `
          <button class="kr-nav-pl" data-action="my-playlist-open" data-platform="${esc(pl.platform)}" data-id="${esc(pl.id)}" title="${esc(pl.name)}">
            <span class="kr-nav-pl-cover">${
              pl.cover ? `<img src="${esc(pl.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : icon('music', 'xs')
            }</span>
            <span class="kr-nav-pl-copy">
              <strong>${esc(pl.name)}</strong>
              <small>${pl.count ? `${pl.count} 首` : esc(musicPlatformLabel(pl.platform))}</small>
            </span>
          </button>`
          )
          .join('')}
        ${
          allPlaylists.length > 14
            ? showAllSide
              ? `<button class="kr-nav-pl-more" data-action="side-pl-more">收起</button>`
              : `<button class="kr-nav-pl-more" data-action="side-pl-more">查看全部 ${allPlaylists.length} 个</button>`
            : ''
        }
        ${(focusLocal || sidePlatform === 'all') && (state.localPlaylists || []).length
          ? (state.localPlaylists || [])
          .map(
            (pl) => `
          <button class="kr-nav-pl kr-nav-pl-local" data-action="local-playlist-open" data-id="${esc(pl.id)}" title="${esc(pl.name)}">
            <span class="kr-nav-pl-cover">${icon('library', 'xs')}</span>
            <span class="kr-nav-pl-copy">
              <strong>${esc(pl.name)}</strong>
              <small>${(pl.songs || []).length} 首 · 本地</small>
            </span>
          </button>`
          )
          .join('')
          : ''}
        <button class="kr-nav-pl-new" data-action="local-playlist-new">${icon('plus', 'xs')}新建歌单</button>
      </div>`;

  /*
   * 最近播放（2026-11-18）：左栏把同步区拿掉之后下半截空了一大片，
   * 主流播放器这里放的就是「最近播放」。只显示最近 6 首，点一下直接接着听。
   */
  const recent = (state.recentSongs || []).slice(0, 6);
  const recentBlock = recent.length
    ? `<div class="kr-nav-block kr-nav-recent">
        <p class="kr-nav-label">最近播放</p>
        ${recent
          .map(
            (song, index) => `
          <button class="kr-nav-recent-item" data-action="recent-play" data-index="${index}" title="${esc(
            `${song.title || ''}${song.artist ? ' · ' + song.artist : ''}`
          )}">
            <span class="kr-nav-recent-cover">${
              song.cover ? `<img src="${esc(song.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : icon('music', 'xs')
            }</span>
            <span class="kr-nav-recent-copy">
              <strong>${esc(song.title || '')}</strong>
              <small>${esc(song.artist || '')}</small>
            </span>
          </button>`
          )
          .join('')}
      </div>`
    : '';

  return `
    <nav class="kr-nav" aria-label="音乐导航">
      ${navGroups}
      ${playlistBlock}
      ${recentBlock}
    </nav>`;
}

/**
 * 本地歌单详情（2026-11-18）。
 *
 * 用户自己新建的歌单：可整张播放、从我的队列导入、单首移除、删歌单。
 * 这些歌只存在本地，不涉及任何音乐账号。
 */
function localPlaylistMarkup() {
  const list = state.localPlaylists || [];
  const pl = list.find((item) => item.id === state.localDetailId);
  if (!pl) {
    state.localDetailId = '';
    return '';
  }
  const songs = pl.songs || [];
  return `
    <div class="kr-detail">
      <div class="kr-detail-bar">
        <button class="kr-detail-back" data-action="local-playlist-close">${icon('chevron-left', 'xs')}返回</button>
        <div class="kr-detail-title">
          <strong>${esc(pl.name)}</strong>
          <small>${songs.length} 首 · 本地歌单</small>
        </div>
        <div class="kr-detail-actions">
          <button class="kr-detail-play" data-action="local-playlist-play" data-id="${esc(pl.id)}" ${songs.length ? '' : 'disabled'}>${icon('play', 'xs')}整张播放</button>
          <button class="playlists-chip" data-action="local-playlist-import" data-id="${esc(pl.id)}" title="把我的队列里所有歌加进来">${icon('download', 'xs')}导入我的队列</button>
          <button class="playlists-chip is-danger" data-action="local-playlist-remove" data-id="${esc(pl.id)}" data-name="${esc(pl.name)}" title="删除这个本地歌单">${icon('trash', 'xs')}删除歌单</button>
        </div>
      </div>
      ${
        songs.length
          ? `<div class="playlist-songs kr-detail-songs">
              ${songs
                .map(
                  (song, index) => `
                <div class="kr-detail-row">
                  <button class="song-chart-song kr-detail-song" data-action="local-playlist-song" data-id="${esc(pl.id)}" data-index="${index}" title="播放这首">
                    <span class="song-chart-index">${index + 1}</span>
                    <span class="song-chart-cover">${song.cover ? `<img src="${esc(song.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : icon('music')}</span>
                    <span class="song-chart-copy"><strong>${esc(song.title || '未知曲目')}</strong><small>${esc(song.artist || '')}</small></span>
                  </button>
                  <button class="kr-detail-del" data-action="local-playlist-song-remove" data-id="${esc(pl.id)}" data-index="${index}" title="从歌单移除">${icon('x', 'xs')}</button>
                </div>`
                )
                .join('')}
            </div>`
          : `<div class="song-empty">${icon('library')}<strong>这个歌单还是空的</strong><span>点右上角「导入我的队列」把队列里的歌搬进来；或在别的歌单里批量选择后选这个歌单。</span></div>`
      }
    </div>`;
}

/** 主区顶部条：当前分页的名字 + 一句话说明（替代原来那排分页按钮）。 */
function krSectionHeadMarkup() {
  const tab = state.songTab || 'queue';
  const title = (SONG_TABS.find(([key]) => key === tab) || ['queue', '队列'])[1];
  const meta =
    tab === 'queue'
      ? (state.pickedSongs || []).length
        ? `${(state.pickedSongs || []).length} 首`
        : '还没有歌'
      : tab === 'charts'
        ? '公开榜单，免登录'
        : tab === 'plaza'
            ? '热门公开歌单，免登录，点开就能看'
            : '四个平台一起搜';
  return `
    <div class="kr-main-head">
      <strong class="kr-main-title">${esc(title)}</strong>
      <span class="kr-main-meta">${esc(meta)}</span>
      ${
        tab === 'queue'
          ? `<div class="kr-main-actions">
              <button class="kr-main-clear" data-action="queue-select-mode">${state.queueSelectMode ? '退出选择' : '批量选择'}</button>
              ${
                (state.pickedSongs || []).length && !state.queueSelectMode
                  ? `<button class="kr-main-clear is-quiet" data-action="song-clear">清空</button>`
                  : ''
              }
            </div>`
          : ''
      }
    </div>`;
}

/**
 * 队列分段折叠：每段默认只渲染前这么多行，剩下的收进「展开其余 N 首」。
 * 之前几百首的队列一次 innerHTML 全量画出来（几千个节点），点进队列页就卡；
 * 折叠后首屏节点数恒定，展开仍然全量渲染（用户主动要的，慢一点没关系）。
 */
/*
 * 2026-11-18：30 → 8。
 * 队列里经常叠着好几张歌单（2163 首 = 十几段），每段露 30 行的话，
 * 后面的歌单要滚很久才看得到。改成 8 行后，一屏能扫过好几个段头，
 * 想看某段再点「展开其余 N 首」。
 */
const QUEUE_SEGMENT_PREVIEW = 8;

/**
 * 队列分段：连续且同来源的歌归一段。
 *
 * 导入歌单是整张 append，天然连续；手动点的歌穿插在中间会切开段落。
 * 段头写清来源（整张导入的歌单显示歌单名，手动加的归「自选」），
 * 播放顺序不动，纯粹是给人看的分组。
 */
function songQueueSegments(list = state.songs) {
  const segments = [];
  const keyOf = (song) =>
    song.origin === 'playlist' ? `pl:${song.from || '歌单'}` : 'pick';
  for (const song of list) {
    const key = keyOf(song);
    const last = segments[segments.length - 1];
    if (last && last.key === key) last.items.push(song);
    else segments.push({ key, items: [song] });
  }
  return segments.map((seg) => ({
    ...seg,
    label: seg.key === 'pick' ? '自选歌曲' : seg.key.slice(3),
  }));
}

/**
 * 队列行渲染主体（不含外壳）。
 *
 * 行号映射规则（最要紧的一处）：
 * data-index 永远是 state.songs 里的全局真实下标 —— flat 从 0 起、
 * 遍历每个段的每一首（含被过滤掉的）逐个 +1 得到。
 * 2.4.5：段头「展开/收起」整段砍掉 —— 段条点不动还占地方，列表直接
 * 平铺所有歌；段的先后顺序与下标映射保持不变，song-select /
 * song-remove 拿到的下标和旧版完全一致。
 */
function songQueueRowsMarkup(list = state.songs) {
  const segments = songQueueSegments(list);
  const filter = String(state.queueFilter || '').trim().toLowerCase();
  const rows = [];
  let flat = 0;
  for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
    const seg = segments[segIdx];
    // 先给整段编好全局下标，再按过滤词挑出可见的行
    const all = seg.items.map((song) => {
      const index = flat;
      flat += 1;
      return { song, index };
    });
    const visible = filter
      ? all.filter(({ song }) => `${song.title || ''} ${song.artist || ''}`.toLowerCase().includes(filter))
      : all;

    /*
     * 2026-11-18：恢复「按来源折叠」。
     *
     * 整张 1944 首的歌单铺进队列后，列表变成几千行，用户说「一堆歌很乱」。
     * 主流音乐软件（QQ 音乐 / 网易云「当前播放」）都是按来源分段、只展开当前段，
     * 这里照做：
     *   · 段长 ≤ 30 的照常平铺；
     *   · 长段显示段头（歌单名 + 总数），默认只露出当前播放项附近几首；
     *   · 点段头或「展开其余 N 首」才全量渲染（状态存 state.queueExpanded）。
     * 下标映射不变（data-index 仍是 state.songs 全局下标）。
     */
    const segKey = seg.key;
    const isPlaylistSeg = seg.key !== 'pick';
    const expanded = Boolean(state.queueExpanded?.[segKey]) || Boolean(filter);
    const collapsible = isPlaylistSeg && visible.length > QUEUE_SEGMENT_PREVIEW;

    if (collapsible) {
      rows.push(`<div class="song-queue-seg">
        <span class="song-queue-seg-name">${icon('music', 'xs')}《${esc(seg.label)}》</span>
        <span class="song-queue-seg-count">${visible.length} 首</span>
        <button class="song-queue-seg-toggle" data-action="queue-seg-toggle" data-seg="${esc(segKey)}">${expanded ? '收起' : '展开'}</button>
      </div>`);
    }

    let shown = visible;
    let headHidden = 0;
    if (collapsible && !expanded) {
      const activeAt = visible.findIndex(({ index }) => index === state.songIndex);
      if (activeAt >= 0) {
        // 当前正在播放的那首在段里：只露前后几首，其他收起来
        const from = Math.max(0, activeAt - 2);
        const to = Math.min(visible.length, activeAt + 6);
        shown = visible.slice(from, to);
        headHidden = from;
      } else {
        shown = visible.slice(0, QUEUE_SEGMENT_PREVIEW);
      }
    }

    if (headHidden > 0) {
      rows.push(`<button class="song-queue-more" data-action="queue-seg-toggle" data-seg="${esc(segKey)}">… 前面还有 ${headHidden} 首</button>`);
    }

    for (const { song, index } of shown) {
      rows.push(`
              <div class="song-row ${sameSongKey(song, state.songs[state.songIndex]) ? 'active' : ''}${song.unavailable ? ' is-unavailable' : ''}${(state.queueSelected || []).includes(index) ? ' is-brush-selected' : ''}" draggable="true" data-index="${index}">
                <button class="song-row-main" data-action="song-select" data-queue="picked" data-index="${index}" title="${song.unavailable ? esc(song.unavailableReason || '暂时无法播放') : ''}">
                  <span class="song-index">${sameSongKey(song, state.songs[state.songIndex]) ? icon('play') : index + 1}</span>
                  <span class="song-row-cover">${songCover(song) ? `<img src="${esc(songCover(song))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover />` : icon('music')}</span>
                  <span class="song-row-copy">
                    <strong>${esc(song.title)}</strong>
                    <small>${esc(
                      song.unavailable
                        ? `暂时无法播放${song.unavailableReason ? ' · ' + song.unavailableReason : ''}`
                        : song.artist || (String(song.url || '').startsWith('file:') ? '本地文件' : '网络直链')
                    )}</small>
                  </span>
                </button>
                <button class="song-row-remove" data-action="song-remove" data-queue="picked" data-index="${index}" title="从队列移除">${icon('x')}</button>
              </div>`);
    }

    if (collapsible && !expanded && shown.length < visible.length) {
      const restCount = visible.length - shown.length;
      rows.push(`<button class="song-queue-more" data-action="queue-seg-toggle" data-seg="${esc(segKey)}">展开其余 ${restCount} 首</button>`);
    }
  }
  return rows.join('');
}

function songQueueList(list = state.songs) {
  const filter = String(state.queueFilter || '').trim();
  /*
   * 轻量过滤框：只在队列多于一段预览量时出现（几十首以内没必要）。
   * 输入事件在 app.js 的 bindEvents 里监听，只重绘 .song-list，不碰输入框本身，
   * 这样打字不会丢焦点。
   */
  const filterBar =
    state.songs.length > QUEUE_SEGMENT_PREVIEW
      ? `<div class="song-queue-filterbar">
        <span class="song-queue-filter-icon">${icon('search', 'xs')}</span>
        <input id="song-queue-filter" class="song-queue-filter" type="search" autocomplete="off"
          placeholder="在队列里找歌名 / 歌手" value="${esc(filter)}" />
        <button class="song-queue-filter-clear" data-action="queue-filter-clear" title="清空过滤" ${filter ? '' : 'hidden'}>${icon('x', 'xs')}</button>
      </div>`
      : '';
  /*
   * 「正在播放」上下文条（2026-11-18）。
   *
   * 队列里混着整张歌单 + 观众点歌时，光看几千行分不清「我现在听的是哪张歌单里的第几首」。
   * 主流音乐软件的「当前播放」顶部都会钉一条这个，照做：封面 + 歌名 + 来源 + 位置。
   */
  const current = state.songs[state.songIndex] || null;
  const nowBar = current
    ? `<div class="song-queue-now">
        <span class="song-queue-now-cover">${
          songCover(current)
            ? `<img src="${esc(songCover(current))}" alt="" referrerpolicy="no-referrer" />`
            : icon('music')
        }</span>
        <span class="song-queue-now-copy">
          <strong>${esc(current.title || '未知曲目')}</strong>
          <small>${esc(current.artist || '未知歌手')}${current.origin === 'playlist' && current.from ? ` · 来自《${esc(current.from)}》` : ' · 自选'}</small>
        </span>
        <span class="song-queue-now-pos">${sameSongKey(current, list[state.songIndex]) && list === state.songs ? `${state.songIndex + 1} / ${state.songs.length}` : '播放中'}</span>
      </div>`
    : '';
  /*
   * 「恢复上一个队列」（2026-11-18）。
   * 整张播放会替换队列，误点卡片上的播放键时靠这条把攒了很久的队列找回来。
   */
  const backup = state.queueBackup;
  const backupBar = backup && backup.songs?.length
    ? `<button class="song-queue-restore" data-action="queue-restore" title="把刚才被替换掉的队列装回来">
        ${icon('refresh', 'xs')}
        <span>恢复上一个队列 · <b>${backup.songs.length}</b> 首</span>
      </button>`
    : '';
  const selectedCount = (state.queueSelected || []).length;
  const selectBar = state.queueSelectMode
    ? `<div class="song-queue-brush">
        <span>已选 <b>${selectedCount}</b> 首${selectedCount ? '' : ' · 点歌曲勾选，或 Shift 拖动连选'}</span>
        <button class="song-queue-brush-btn" data-action="queue-select-play" ${selectedCount ? '' : 'disabled'}>加入播放</button>
        <button class="song-queue-brush-btn is-danger" data-action="queue-select-remove" ${selectedCount ? '' : 'disabled'}>删除</button>
        <button class="song-queue-brush-btn" data-action="queue-select-mode">取消</button>
      </div>`
    : (state.pickedSongs || []).length
      ? `<p class="song-queue-brush-hint">按住 Shift 拖动可以直接划选多首</p>`
      : '';
  return `
    <div class="song-queue-wrap" id="song-queue">
      ${selectBar}
      ${backupBar}
      ${nowBar}
      ${filterBar}
      <div class="song-list">
        ${
          !list.length
            ? `<div class="song-empty">${icon('music')}<strong>队列还是空的</strong><span>把你喜欢的歌一首首加进来：歌单详情右侧的 ＋、直链、本地文件都算。</span></div>`
            : songQueueRowsMarkup(list) ||
              `<div class="song-empty">${icon('search')}<strong>没有匹配的队列歌曲</strong><span>换个关键字，或者点右侧的 × 清空过滤。</span></div>`
        }
      </div>
    </div>`;
}

function songMineMarkup() {
  /*
   * 「我的歌单」只负责账号里的歌单（2026-11-18）。
   *
   * 歌单广场已经拆成独立的导航项，这里不再顺手 ensurePlaza ——
   * 否则进「我的歌单」会白拉一次广场数据，而且广场被压在页面底部看不见。
   */
  const anyLogged = ['netease', 'qq', 'kugou'].some((key) => musicAccountLoggedIn(key));
  if (anyLogged) ensureAllPlaylistsLoaded();
  return allPlaylistsMarkup();
}

/** 歌单广场入口：独立 tab，进来就拉第一页热门公开歌单（免登录）。 */
function songPlazaMarkup() {
  if (!['netease', 'qq', 'kugou'].includes(state.myPlaylists.plazaPlatform)) {
    state.myPlaylists.plazaPlatform = 'netease';
  }
  /*
   * 2026-11-19 修「点进歌单没反应 / 切到广场还是旧页面」：
   *
   * 广场和「我的歌单」共用一个 state.myPlaylists.detail（钻取态），
   * 但进广场这条路径以前既不判断也不清理它 ——
   * 用户先在「我的歌单」点开过一张歌单，之后切到广场，
   * plazaPanelMarkup() 看到 detail 还在就直接画那张歌单的详情，
   * 广场列表根本不出现；再点广场里的卡片也是把 detail 覆盖成新的一张，
   * 视觉上像「点了没反应」。
   *
   * 广场是独立入口，进来就该是广场本身：只要 detail 是别的平台的、
   * 或压根不是从广场点开的，这里一律退回列表态。
   * 从广场自己点开的（detail.fromPlaza === true）保留钻取态，
   * 用户从详情返回列表仍走 my-playlist-close。
   */
  if (state.myPlaylists.detail && !state.myPlaylists.detail.fromPlaza) {
    state.myPlaylists.detail = null;
  }
  if (!state.myPlaylists.detail) ensurePlaza(state.myPlaylists.plazaPlatform);
  return plazaPanelMarkup();
}
