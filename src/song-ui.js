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
  // 队列原来的标签是「歌单」，放在左栏里跟「我的歌单」并排时容易看错，统一叫「队列」
  ['queue', '队列'],
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

/** 四个平台，顺序固定：左栏、账号列表、登录面板都用这一份，别再各写一份漏掉酷我。 */
const MUSIC_ACCOUNTS = [
  ['netease', '网易云音乐'],
  ['qq', 'QQ 音乐'],
  ['kugou', '酷狗音乐'],
  ['kuwo', '酷我音乐'],
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
        <p>四个平台各登各的，想登哪个点进去。</p>
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
      stop();
      status.textContent = '登录检查失败';
      hint.textContent = qrErrorText(error);
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
const KR_NAV_ICONS = { queue: 'order', charts: 'star', mine: 'music', search: 'search' };

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
    const ready = group && !group.error && (group.list || []).length;
    const kugouSync = syncing
      ? sync
      : ready
        ? { tone: 'ready', text: `${group.list.length} 个` }
        : { tone: 'idle', text: '' };
    return `
    <div class="kr-sync-row is-${kugouSync.tone}">
      <span class="mp-dot" data-platform="${esc(platform)}"></span>
      <span class="kr-sync-name">${esc(label)}</span>
      <span class="kr-sync-state">${esc(kugouSync.text)}</span>
      <span class="kr-sync-when">${esc(when)}</span>
      <button class="kr-sync-btn is-import" data-action="import-playlist-link"
        title="用歌单链接导入，导入的歌单会进「我的歌单」"
        style="width:auto;gap:3px;padding:0 7px;font-size:10.5px;">
        ${icon('download', 'xs')}链接导入
      </button>
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
  // 酷狗排到最后：账号同步已被官方关掉，它在四家里最不重要，
  // 留在中间只会把能用的平台隔开。顺序固定：网易云 / QQ / 酷我 / 酷狗。
  const PLATFORM_ORDER = ['netease', 'qq', 'kuwo', 'kugou'];
  const logged = PLATFORM_ORDER.filter((key) => musicLoggedIn(key));
  const syncingAll = Boolean(state.myPlaylists.loadingAll);
  const myCount = logged.reduce((sum, key) => sum + (krPlaylistGroupOf(key)?.list || []).length, 0);
  const counts = { queue: state.songs.length, charts: (state.charts.list || []).length, mine: myCount };
  // 后端返回的 syncedAt / durationMs：同步慢的时候用户得知道上次是什么时候、花了多久
  const syncMeta = playlistSyncSummary();

  const items = SONG_TABS.map(([key, label]) => {
    const count = counts[key] || 0;
    return `
      <button class="kr-nav-item ${tab === key ? 'is-active' : ''}" data-action="song-tab" data-value="${key}">
        <span class="kr-nav-icon">${icon(KR_NAV_ICONS[key] || 'music', 'xs')}</span>
        <span class="kr-nav-text">${label}</span>
        ${count ? `<span class="kr-nav-count">${count}</span>` : ''}
      </button>`;
  }).join('');

  const syncBody = logged.length
    ? `<div class="kr-sync-list">${logged.map(krSyncRow).join('')}</div>`
    : `<p class="kr-nav-hint">还没有登录音乐账号，登录后这里会列出每个平台的歌单数。</p>
       <button class="kr-nav-login" data-action="music-accounts">${icon('login', 'xs')}去登录</button>`;

  return `
    <nav class="kr-nav" aria-label="点歌台导航">
      <div class="kr-nav-block">
        <p class="kr-nav-label">浏览</p>
        ${items}
      </div>
      <div class="kr-nav-block kr-nav-sync">
        <p class="kr-nav-label"><span>平台歌单</span><span class="kr-nav-label-hint">点 ↻ 只同步这一个</span></p>
        <button class="kr-sync-all" data-action="music-sync-all" ${syncingAll ? 'disabled' : ''}>
          ${icon('refresh', 'xs')}${syncingAll ? '同步中…' : '同步全部'}
        </button>
        ${syncBody}
        ${syncMeta && !syncingAll ? `<p class="kr-sync-meta">${esc(syncMeta)}</p>` : ''}
      </div>
      <p class="kr-nav-hint">点歌单封面进去看曲目，卡片右下角的播放键直接整张开播。</p>
    </nav>`;
}

/** 主区顶部条：当前分页的名字 + 一句话说明（替代原来那排分页按钮）。 */
function krSectionHeadMarkup() {
  const tab = state.songTab || 'queue';
  const title = (SONG_TABS.find(([key]) => key === tab) || ['queue', '队列'])[1];
  const meta =
    tab === 'queue'
      ? state.songs.length
        ? `${state.songs.length} 首待播`
        : '还没有歌'
      : tab === 'charts'
        ? '公开榜单，免登录'
        : tab === 'mine'
          ? '点歌单进曲目，可整张播放'
          : '四个平台一起搜';
  return `
    <div class="kr-main-head">
      <strong class="kr-main-title">${esc(title)}</strong>
      <span class="kr-main-meta">${esc(meta)}</span>
      ${tab === 'queue' && state.songs.length ? `<button class="kr-main-clear" data-action="song-clear">清空</button>` : ''}
    </div>`;
}

/**
 * 队列分段折叠：每段默认只渲染前这么多行，剩下的收进「展开其余 N 首」。
 * 之前几百首的队列一次 innerHTML 全量画出来（几千个节点），点进队列页就卡；
 * 折叠后首屏节点数恒定，展开仍然全量渲染（用户主动要的，慢一点没关系）。
 */
const QUEUE_SEGMENT_PREVIEW = 30;

/**
 * 队列分段：连续且同来源的歌归一段。
 *
 * 导入歌单是整张 append，天然连续；手动点的歌穿插在中间会切开段落。
 * 段头写清来源（整张导入的歌单显示歌单名，手动加的归「自选」），
 * 播放顺序不动，纯粹是给人看的分组。
 */
function songQueueSegments() {
  const segments = [];
  const keyOf = (song) =>
    song.origin === 'playlist' ? `pl:${song.from || '歌单'}` : 'pick';
  for (const song of state.songs) {
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

/** 队列的过滤词：会话内状态，切页 / 重启都不保留。 */
function queueFilterActive() {
  return Boolean(String(state.queueFilter || '').trim());
}

/**
 * 队列行渲染主体（不含外壳）。
 *
 * 行号映射规则（最要紧的一处）：
 * data-index 永远是 state.songs 里的全局真实下标 —— flat 从 0 起、
 * 遍历每个段的每一首（含被过滤掉的）逐个 +1 得到。折叠和过滤都只是
 * 「少画几行」，不改变任何行的 index，song-select / song-remove
 * 拿到的下标和没折叠时完全一致。
 */
function songQueueRowsMarkup() {
  const segments = songQueueSegments();
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
    if (!visible.length) continue;
    const hasCurrent = visible.some(({ index }) => index === state.songIndex);
    /*
     * 展开状态：用户点过按钮的按记忆来；没点过的段里含当前播放的默认展开，
     * 其余默认折叠。搜索过滤时一律全展开（搜都搜了，就该看到全部命中）。
     */
    const expanded = filter
      ? true
      : state.queueExpanded[segIdx] !== undefined
        ? state.queueExpanded[segIdx]
        : hasCurrent;
    rows.push(
      `<div class="song-queue-seg-head"><span>${esc(seg.label)}</span><small>${visible.length} 首</small>
        <button class="song-queue-seg-toggle" data-action="queue-seg-toggle" data-seg="${segIdx}" title="${expanded ? '收起这一段' : '展开这一段'}">${expanded ? '收起' : `展开全部 ${visible.length} 首`}</button>
      </div>`
    );
    const shown = expanded ? visible : visible.slice(0, QUEUE_SEGMENT_PREVIEW);
    for (const { song, index } of shown) {
      rows.push(`
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
              </div>`);
    }
    if (!expanded && visible.length > QUEUE_SEGMENT_PREVIEW) {
      const more = visible.length - QUEUE_SEGMENT_PREVIEW;
      rows.push(
        `<button class="song-queue-seg-more" data-action="queue-seg-toggle" data-seg="${segIdx}">展开其余 ${more} 首（共 ${visible.length} 首）</button>`
      );
    }
  }
  return rows.join('');
}

function songQueueList() {
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
  return `
    <div class="song-queue-wrap" id="song-queue">
      ${filterBar}
      <div class="song-list">
        ${
          !state.songs.length
            ? `<div class="song-empty">${icon('music')}<strong>歌单还是空的</strong><span>添加本地音频，或者导入一个网易云歌单。</span></div>`
            : songQueueRowsMarkup() ||
              `<div class="song-empty">${icon('search')}<strong>没有匹配的队列歌曲</strong><span>换个关键字，或者点右侧的 × 清空过滤。</span></div>`
        }
      </div>
    </div>`;
}

function songMineMarkup() {
  // 「我的歌单」按平台分区，所有已登录平台的歌单一起列出来。
  // 登录入口只有页头那排账号按钮（打开统一的「音乐账号」面板），这里不再放登录按钮。
  // 未登录也不再直接给空态：歌单广场不依赖登录，先让用户有东西可看。
  const anyLogged = ['netease', 'qq', 'kugou', 'kuwo'].some((key) => musicAccountLoggedIn(key));
  if (anyLogged) ensureAllPlaylistsLoaded();
  /*
   * 点开某张歌单后主区换成曲目页，广场被钻取页盖住了。
   * 这时候还去拉广场第一页等于白发一次请求，所以只在浏览态预取。
   */
  if (!state.myPlaylists.detail) ensurePlaza(state.myPlaylists.plazaPlatform || 'netease');
  return allPlaylistsMarkup();
}
