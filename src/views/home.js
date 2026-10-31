'use strict';

/**
 * 视图层：首页（home）与启动页（start）。
 *
 * 2026-10-31 从 app.js 拆出 —— 「前后端分离」第 5 批。
 * 原本批次表把「服务器面板 + 切换引导」单列第 6 批，但它们在代码里本来就在
 * home 段内（startServerPanel / openServerSetupDialog / showServerSwitchGuideOnce
 * 全是启动页的一部分），硬切两段只会制造假边界，所以整段一起搬。
 *
 * 内容分布：
 *   · 首页卡片与动态：stageHero / recentRow / newsCard / homeNewsRow /
 *     loadGameNotices / homePlaytimeMarkup / launchedLabel / homeView
 *   · 启动页背景：bgCandidatesFor / pinnedBgMap / currentBgPick / closeBgPanel
 *   · 启动页主体：startView（服务器卡片墙 + 开始游戏 + 抽屉）
 *   · 启动页服务器面板：closeStartServerMenu / groupServersForDisplay /
 *     startDockDownloadActions / startServerPanel / openStartServerManager /
 *     openServerSetupDialog
 *   · 切服引导：serverSwitchGuideSeen / markServerSwitchGuideSeen /
 *     openServerSwitchGuide / showServerSwitchGuideOnce（+ 三个常量）
 *   · 启动页运行计时：syncStartRunningTimer / startStartRunningTimer / stopStartRunningTimer
 *   · 启动页视频状态记忆：restoreStartVideoState / updateStartVideoToggle /
 *     rememberStartVideoPaused / wasStartVideoPaused
 *   · 角色双人图：characterDuoMarkup
 *
 * 加载约定：普通 script，共享全局词法作用域，必须排在 app.js 之前。
 * 反向依赖（render / navigate / openModal / state / dom / api 等）在调用时解析。
 * 顶层只有函数声明与常量数据，无 DOM 立即求值。
 */

/* ------------------------------------------------------------------ */
/* home                                                                */
/* ------------------------------------------------------------------ */

function stageHero(latest, mood) {
  let action = 'add-game';
  let actionLabel = '添加游戏';
  let actionIcon = 'plus';
  let actionId = '';
  if (latest) {
    action = latest.running
      ? 'stop-game'
      : latest.installed
        ? 'launch-game'
        : latest.builtin
          ? 'detect-game'
          : 'edit-game';
    actionLabel = latest.running
      ? '结束当前剧目'
      : latest.installed
        ? '继续上一幕'
        : latest.builtin
          ? '检测已安装的游戏'
          : '配置上一幕';
    actionIcon = latest.running ? 'stop' : latest.installed ? 'play' : latest.builtin ? 'refresh' : 'wrench';
    actionId = ` data-id="${esc(latest.id)}"`;
  }
  return `
    <section class="hero">
      <div class="hero-bg" style="background-image:${esc(cssUrl('assets/character.png'))}"></div>
      <div class="hero-shade"></div>
      <div class="hero-sparxie" aria-hidden="true"><img src="assets/sparkle-hero.png" alt="" draggable="false" /></div>
      <div class="hero-sparks" aria-hidden="true">
        <svg viewBox="0 0 260 260">
          <g fill="none" stroke="currentColor">
            <circle cx="130" cy="130" r="52" opacity=".5" />
            <circle cx="130" cy="130" r="88" opacity=".22" />
            <circle cx="130" cy="130" r="126" opacity=".1" />
            <path d="M130 6v248M6 130h248M42 42l176 176M218 42 42 218" opacity=".12" />
            <path d="M130 46c7 45 29 67 74 74-45 7-67 29-74 74-7-45-29-67-74-74 45-7 67-29 74-74Z" opacity=".32" />
          </g>
          <g fill="currentColor">
            <circle cx="130" cy="18" r="2.2" opacity=".8" />
            <circle cx="244" cy="130" r="1.6" opacity=".55" />
            <circle cx="130" cy="244" r="1.4" opacity=".4" />
            <circle cx="16" cy="130" r="1.8" opacity=".5" />
            <circle cx="198" cy="58" r="2.6" opacity=".7" />
            <circle cx="66" cy="198" r="1.8" opacity=".45" />
          </g>
        </svg>
      </div>
      <div class="hero-index">花</div>
      <div class="hero-content">
        <div class="hero-kicker">
          <span class="pill">${mood.kicker}</span>
          <span class="line"></span>
          <span>${latest ? '上一幕已就绪' : '第一幕'}</span>
        </div>
        <h2>${mood.title}</h2>
        <div class="hero-sub">
          <span>花筱灵的私人游戏舞台</span>
          <span class="dot"></span>
          <span>${state.games.length} 个剧目</span>
          ${latest && latest.running ? `<span class="hero-running"><span class="pulse"></span>演出中</span>` : ''}
        </div>
        <p class="hero-desc">${mood.desc}</p>
        <div class="hero-actions">
          <button class="btn btn-primary" data-action="${action}"${actionId}>
            ${icon(actionIcon)}${esc(actionLabel)}
          </button>
          ${
            /* 2.4.x：有游戏时直达该游戏的启动页（侧栏直达后主页转「快速通道」定位）；
               没有游戏时退回普通启动页入口。 */
            latest
              ? `<button class="btn btn-glass hero-start-btn" data-action="continue-game" data-id="${esc(latest.id)}">
            ${icon('play')}进入启动页
          </button>`
              : `<button class="btn btn-glass hero-start-btn" data-nav="start">
            ${icon('play')}启动页
          </button>`
          }
          <button class="btn btn-glass" data-action="scroll-library">${icon('library')}查看游戏库</button>
        </div>
      </div>
      <div class="hero-portrait" aria-hidden="true">
        <img src="assets/character.png" alt="" draggable="false" />
      </div>
    </section>`;
}

function recentRow(game) {
  const action = game.running
    ? 'stop-game'
    : game.installed
      ? 'launch-game'
      : game.builtin
        ? 'detect-game'
        : 'edit-game';
  const actionIcon = game.running ? 'stop' : game.installed ? 'play' : game.builtin ? 'refresh' : 'wrench';
  const actionText = game.running ? '停止' : game.installed ? '启动' : game.builtin ? '检测安装' : '配置';
  return `
    <button class="recent-row" data-action="${action}" data-id="${esc(game.id)}" title="${actionText} ${esc(game.name)}">
      ${
        game.coverUrl
          ? `<img class="recent-cover" decoding="async" src="${esc(game.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover />`
          : `<span class="recent-cover" style="display:grid;place-items:center;color:var(--accent);font-weight:700">${esc(initial(game.name))}</span>`
      }
      <span class="recent-info">
        <span class="recent-name">${esc(game.name)}</span>
        <span class="recent-meta">
          ${game.running ? '<span class="pulse"></span>正在运行' : esc(relativeDate(game.lastPlayed))}
          ${game.builtin ? '<span>·</span><span>内置</span>' : game.demo ? '<span>·</span><span>示例</span>' : ''}
        </span>
      </span>
      <span class="recent-play">${icon(actionIcon)}</span>
    </button>`;
}

function newsCard(post) {
  return `
    <button class="news-card" data-action="open-news" data-id="${esc(post.id)}">
      <span class="news-top">
        <span class="news-tag">${esc(post.tag)}</span>
        <span>${esc(post.readTime || '')}</span>
      </span>
      <h4>${esc(post.title)}</h4>
      <p>${esc(post.excerpt)}</p>
      <span class="news-more">阅读全文 ${icon('chevron-right')}</span>
    </button>`;
}

/* 主页专用的一行动态条：标题 + 日期 + 箭头，点击行为与 news-card 一致（open-news），
   只是把三张大卡换成单行列表，让主页不用为动态区滚一大屏。 */
function homeNewsRow(post) {
  return `
    <button class="home-news-row" data-action="open-news" data-id="${esc(post.id)}">
      <span class="home-news-tag">${esc(post.tag)}</span>
      <span class="home-news-title">${esc(post.title)}</span>
      <span class="home-news-date">${esc(post.date || '')}</span>
      ${icon('chevron-right')}
    </button>`;
}


async function loadGameNotices(gameId) {
  if (!gameId) return;
  state.noticesGameId = gameId;
  state.notices = [];
  state.noticesLoading = true;
  if (state.route === 'start') render({ preserveScroll: false });
  try {
    const notices = await api.gameNotices(gameId);
    if (state.noticesGameId !== gameId) return;
    state.notices = Array.isArray(notices) ? notices : [];
  } catch {
    if (state.noticesGameId !== gameId) return;
    state.notices = [];
  } finally {
    if (state.noticesGameId === gameId) {
      state.noticesLoading = false;
      if (state.route === 'start') render({ preserveScroll: false });
    }
  }
}

/* ---------- 启动页背景：多背景轮换 + 固定 ---------- */
/* 可用背景 = 静态封面图(cover) / 官方动态视频(video)。固定值存 localStorage，跨会话记住；不点就不换。 */
function bgCandidatesFor(game) {
  if (!game) return [];
  const list = [];
  if (game.startCoverUrl || game.coverUrl) list.push('cover');
  if (game.backgroundVideo) list.push('video');
  return list;
}
function pinnedBgMap() {
  try {
    return JSON.parse(localStorage.getItem('vela:pinned-bg') || '{}') || {};
  } catch {
    return {};
  }
}
/** 收起背景面板：点到工具区外、或再点一次触发键时用。 */
function closeBgPanel() {
  state.bgPanelOpen = false;
  const panel = document.querySelector('#start-bg-panel');
  if (panel) panel.hidden = true;
  document.querySelector('.start-video-tools')?.classList.remove('is-open');
  document.querySelector('.start-bg-trigger')?.setAttribute('aria-expanded', 'false');
}
function currentBgPick(game) {
  const cands = bgCandidatesFor(game);
  if (!cands.length) return 'cover';
  let pick = pinnedBgMap()[game.id] || (state.bgPick && state.bgPick[game.id]);
  if (!cands.includes(pick)) pick = cands.includes('video') ? 'video' : cands[0];
  return pick;
}

function startView() {
  if (!state.games.length) return homeView();
  const ordered = [...state.games].sort(
    (a, b) =>
      new Date(b.lastPlayed || b.createdAt || 0) - new Date(a.lastPlayed || a.createdAt || 0)
  );
  const selected =
    state.games.find((game) => game.id === state.startGameId) ||
    ordered.find((game) => game.installed) ||
    ordered[0];
  const activeServer = (selected.servers || []).find((server) => server.id === selected.activeServerId);
  // 优先用「去文字」版本作为背景，避免官方图上的标题和我们的游戏名打架
  const cover = selected.startCoverUrl || selected.coverUrl || cssUrl('assets/character.png');
  const coverSrc = cover.replace(/^url\("|"\)$/g, '');
  // 背景候选：静态封面 / 官方动态视频。右上角可切换并固定（vela:pinned-bg）。
  const bgCands = bgCandidatesFor(selected);
  const bgPick = currentBgPick(selected);
  // 画面指纹：切服务器 / 开合面板时画面没变，就能复用同一层 DOM，
  // 视频既不重载也不跳进度，从根上消掉「先闪静态图」
  const artKey = [selected.id, coverSrc, bgPick === 'video' ? selected.backgroundVideo || '' : ''].join('|');

  // 有背景视频时，视频里也可能烧录了文字，叠加一层文字遮罩带
  const hasVideo = bgPick === 'video' && Boolean(selected.backgroundVideo);
  return `
    <div class="start-screen${selected.builtinKey === 'endfield' ? ' start-screen-endfield' : ''}" style="--start-cover:${cover}">
      <div class="start-art${selected.builtinKey === 'endfield' ? ' start-art-cinema' : ''}${selected.backgroundVideo ? '' : ' start-art-pan'}" data-art-key="${esc(artKey)}" style="background-image:${esc(cssUrl(coverSrc))}">
        <img src="${esc(coverSrc)}" alt="" referrerpolicy="no-referrer" loading="eager" data-cover />
        ${
          hasVideo
            ? `<video src="${esc(selected.backgroundVideo)}" poster="${esc(coverSrc)}" autoplay muted loop playsinline preload="auto" data-start-video></video>`
            : ''
        }
      </div>
      <div class="start-shade"></div>
      ${hasVideo ? '<div class="start-text-veil" aria-hidden="true"></div>' : ''}
      <header class="start-top">
        <!-- 2.4.x：返回键换成「打开导航」——侧栏浮层直接去任何页面，
             回主页走浮层第一项或 Esc，不再单独占一个键 -->
        <button class="chrome-btn chrome-menu" data-action="toggle-start-nav" title="打开侧栏（Esc 返回主界面）" aria-label="打开侧栏">${icon('menu')}</button>
        <div class="start-brand">
          <img class="start-brand-mark" src="assets/character-face.png" alt="" aria-hidden="true" />
          <div class="start-brand-copy">
            <strong>花筱灵</strong>
            <small>HANABI STAGE</small>
          </div>
        </div>
        ${
          bgCands.length > 1 || hasVideo
            ? `${(() => {
                const pinnedNow = pinnedBgMap()[selected.id] === bgPick;
                const bgIndex = Math.max(0, bgCands.indexOf(bgPick));
                return `<div class="start-video-tools${state.bgPanelOpen ? ' is-open' : ''}">
          <button class="start-video-toggle start-bg-trigger${pinnedNow ? ' is-pinned' : ''}" data-action="toggle-bg-panel" title="${pinnedNow ? '背景已固定 · 点开调整' : '背景设置'}" aria-label="背景设置" aria-expanded="${state.bgPanelOpen ? 'true' : 'false'}">${pinnedNow ? icon('pin-fill') : icon('image')}</button>
          <div class="start-bg-panel" id="start-bg-panel" ${state.bgPanelOpen ? '' : 'hidden'}>
            ${
              bgCands.length > 1
                ? `<div class="start-bg-switch">
              <button class="start-bg-step" data-action="bg-cycle" data-dir="-1" title="上一个背景" aria-label="上一个背景">${icon('chevron-left')}</button>
              <span class="start-bg-name">背景 ${bgIndex + 1}/${bgCands.length}${pinnedNow ? ' · 已固定' : ''}</span>
              <button class="start-bg-step" data-action="bg-cycle" data-dir="1" title="下一个背景" aria-label="下一个背景">${icon('chevron-right')}</button>
            </div>
            <button class="start-bg-action${pinnedNow ? ' is-pinned' : ''}" data-action="bg-pin">${pinnedNow ? icon('pin-fill') : icon('pin')}<span>${pinnedNow ? '已固定，点击取消' : '固定这个背景'}</span></button>`
                : ''
            }
            ${
              hasVideo
                ? `<button class="start-bg-action" data-action="toggle-start-video" title="暂停或播放动态背景">
              <svg class="icon" aria-hidden="true"><use id="start-video-use" href="#i-pause"></use></svg>
              <span>暂停 / 播放动态背景</span>
            </button>
            <button class="start-bg-action" data-action="export-start-video" title="把这个动态背景另存为视频文件">${icon('download')}<span>保存为视频</span></button>`
                : ''
            }
          </div>
        </div>`;
              })()}`
            : ''
        }
        <div class="start-window-controls">
          <button class="chrome-btn" data-action="window-minimize" title="最小化" aria-label="最小化">${icon('minus')}</button>
          <button class="chrome-btn" data-action="window-maximize" title="最大化 / 还原" aria-label="最大化">${icon('maximize')}</button>
          <button class="chrome-btn chrome-close" data-action="window-close" title="关闭" aria-label="关闭">${icon('x')}</button>
        </div>
      </header>
      <div class="start-main">
        <div class="start-sparks" aria-hidden="true">
          <svg viewBox="0 0 260 260">
            <g fill="none" stroke="currentColor">
              <circle cx="130" cy="130" r="52" opacity=".5" />
              <circle cx="130" cy="130" r="88" opacity=".22" />
              <circle cx="130" cy="130" r="126" opacity=".1" />
              <path d="M130 6v248M6 130h248M42 42l176 176M218 42 42 218" opacity=".12" />
              <path d="M130 46c7 45 29 67 74 74-45 7-67 29-74 74-7-45-29-67-74-74 45-7 67-29 74-74Z" opacity=".32" />
            </g>
            <g fill="currentColor">
              <circle cx="130" cy="18" r="2.2" opacity=".8" />
              <circle cx="244" cy="130" r="1.6" opacity=".55" />
              <circle cx="130" cy="244" r="1.4" opacity=".4" />
              <circle cx="16" cy="130" r="1.8" opacity=".5" />
              <circle cx="198" cy="58" r="2.6" opacity=".7" />
              <circle cx="66" cy="198" r="1.8" opacity=".45" />
            </g>
          </svg>
        </div>
        <div class="start-kicker"><span class="line"></span>${esc(activeServer?.name || '未配置服务器')}</div>
        <div class="start-titlebox"><h1>${esc(selected.name)}</h1></div>
        <p class="start-sub">${esc(selected.subtitle || selected.description || '准备好继续了吗？')}</p>
        <div class="start-meta">
          ${selected.version ? `<span>v${esc(selected.version)}</span>` : ''}
          ${activeServer?.path ? `<span>${esc(activeServer.path.split(/[\\/]/).pop())}</span>` : '<span>等待配置客户端</span>'}
        </div>
        <details class="start-notices" open>
          <summary>
            <span>${icon('news')}游戏公告</span>
            <small>${state.noticesGameId === selected.id && state.notices.length ? `${state.notices.length} 条` : state.noticesLoading && state.noticesGameId === selected.id ? '加载中…' : '展开'}</small>
            ${icon('chevron-down', 'start-notices-chevron')}
          </summary>
          <div class="start-notice-list">
            ${
              state.noticesGameId === selected.id && state.notices.length
                ? state.notices
                    .slice(0, 4)
                    .map(
                      (notice) => `
                      <button class="start-notice" data-action="open-external" data-url="${esc(notice.link)}">
                        <span>${esc(notice.title)}</span>
                        <small>${esc(noticeMeta(notice))}</small>
                      </button>`
                    )
                    .join('')
                : state.noticesLoading && state.noticesGameId === selected.id
                  ? '<p class="start-notice-empty">正在读取官方公告…</p>'
                  : '<p class="start-notice-empty">暂无公告，或这个渠道没有开放公告接口。</p>'
            }
          </div>
        </details>
      </div>
      <div class="start-games">
        <div class="start-games-head">
          <strong>${icon('chevron-down', 'start-games-chevron')}选择游戏</strong>
          <span class="start-games-mini-slot" id="start-mini-slot" aria-hidden="true"></span>
          <span>${state.games.length} 款 · 悬停展开</span>
        </div>
        <div class="start-game-rail">
          <button class="start-game-nav is-prev" type="button" tabindex="-1" aria-label="往前翻游戏">${icon('chevron-down', 'start-games-nav-icon')}</button>
          <div class="start-game-list">
          ${ordered
            .map((game) => {
              /*
               * 状态点必须三种状态都给全：老代码只在「运行中 / 已安装」时挂 class，
               * 新加进来还没配客户端的游戏就是一颗没样式的裸元素，看着像没画出来。
               * 现在 运行中 / 已就绪 / 未配置 各有一档，鼠标悬停也能读到文字。
               */
              const dot = game.running
                ? { cls: 'is-running', text: '运行中' }
                : game.installed
                  ? { cls: 'is-ready', text: '已就绪' }
                  : { cls: 'is-missing', text: game.builtin ? '未检测到安装' : '未配置启动程序' };
              return `
              <button class="start-game-thumb ${game.id === selected.id ? 'active' : ''}" data-action="start-select" data-id="${esc(game.id)}" title="${esc(`${game.name} · ${dot.text}`)}">
                <span class="start-game-media">
                  ${(game.startCoverUrl || game.coverUrl) ? `<img src="${esc(game.startCoverUrl || game.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover />` : `<span class="start-game-initial">${esc(initial(game.name))}</span>`}
                </span>
                <span class="start-game-copy">
                  <strong>${esc(game.name)}</strong>
                  ${game.running ? '<small>运行中</small>' : ''}
                </span>
                <span class="start-game-state ${dot.cls}" aria-label="${esc(dot.text)}"></span>
              </button>`;
            })
            .join('')}
          </div>
          <button class="start-game-nav is-next" type="button" tabindex="-1" aria-label="往后翻游戏">${icon('chevron-down', 'start-games-nav-icon')}</button>
        </div>
      </div>
      <button class="start-menu-scrim" data-action="start-server-menu" aria-label="关闭服务器选择"></button>
      ${startServerPanel(selected)}
    </div>`;
}

/**
 * 启动页的服务器选择器：只保留「当前服务器」一行，点开才展开完整列表。
 * 列表里点某个服 = 只切换（不启动游戏）；要进游戏用 dock 底部的「开始游戏」。
 * 切换、检测、硬链接、管理都在弹层里完成。
 */
/* 服务器面板是纯 DOM 开合，离开/切换时要主动把类名摘掉，否则下次进来是展开态。 */
function closeStartServerMenu() {
  state.startServerMenu = false;
  document.querySelector('.start-dock')?.classList.remove('is-menu-open');
  document.querySelector('.start-screen')?.classList.remove('dock-open');
}

/**
 * 服务器列表按 group 分组渲染（2.4.0 合并自对方分支）。
 * 明日方舟的国际服是 Yostar 发行的一组区域服（EN / JP / KR），
 * 它们平铺在一起会和「官服 / B服」混成六个平级条目，看不出层级关系。
 * 这里把同组的收进一个小标题下面，其余条目照原样平铺。
 */
function groupServersForDisplay(servers) {
  const GROUP_LABELS = { global: '国际服 · 选择区域' };
  const groups = [];
  const seen = new Map();
  for (const server of servers) {
    const key = server.group || '';
    if (!key) {
      groups.push({ key: 'solo-' + server.id, label: '', items: [server] });
      continue;
    }
    if (!seen.has(key)) {
      const entry = { key, label: GROUP_LABELS[key] || key, items: [] };
      seen.set(key, entry);
      groups.push(entry);
    }
    seen.get(key).items.push(server);
  }
  return groups;
}

/**
 * 启动页 dock 的主按钮区。
 * 已安装：单个「开始游戏」，行为一字不变。
 * 未安装的内置游戏：换成【下载游戏】+【自动检测】+【路径选择】三个动作 ——
 *   - 下载游戏：米哈游三游 / 崩坏3官服 / 终末地 / 明日方舟官服走官方渠道一键下载；
 *     异环没有公开下载接口，点开弹窗会如实说明并附官网入口；
 *   - 自动检测：复用 games:detect，扫注册表和常见目录找已装好的客户端；
 *   - 路径选择：手动指定启动程序（复用服务器编辑弹窗）。
 * 非内置游戏保持原来的「配置游戏」。
 */
function startDockDownloadActions(game) {
  if (game.installed) {
    // 有官方更新时主按钮让位给「更新游戏」，更新完自动变回「开始游戏」。
    // 状态来自 server.predownload（后台自动检测落盘），update = 本地落后正式版。
    const updating = state.gameUpdate && state.gameUpdate.gameId === game.id;
    if (updating) {
      return `<button class="start-dock-play is-updating" disabled title="正在更新，完成后自动变回开始游戏">
          ${icon('refresh', 'sm')}
          <span class="start-dock-update-label">${esc(state.gameUpdate.label || '正在更新…')}</span>
        </button>`;
    }
    const servers = game.servers || [];
    const server = servers.find((item) => item.active) || servers[0];
    const info = predownloadInfo(server);
    if (info && info.state === 'update') {
      const target = String(info.latestVersion || info.targetVersion || '');
      return `<button class="start-dock-play is-update" data-action="start-update-game" data-id="${esc(game.id)}" title="${target ? `下载并更新到 ${esc(target)}` : '下载并应用官方更新'}">
          ${icon('download')}
          <span class="start-dock-update-label">更新游戏</span>
        </button>`;
    }
    return `<button class="start-dock-play" data-action="start-selected" data-id="${esc(game.id)}">
        ${icon('play')}
        <span>开始游戏</span>
      </button>`;
  }
  if (!game.builtin) {
    return `<button class="start-dock-play" data-action="edit-game" data-id="${esc(game.id)}">
        ${icon('wrench')}
        <span>配置游戏</span>
      </button>`;
  }
  return `<div class="start-dock-dl-row">
      <button class="start-dock-play" data-action="download-game" data-id="${esc(game.id)}" title="从官方渠道下载并安装">
        ${icon('download')}
        <span>下载游戏</span>
      </button>
      <button class="start-dock-secondary" data-action="detect-game" data-id="${esc(game.id)}" title="扫描注册表和常见安装目录，找已经装好的客户端">
        ${icon('refresh')}
        <span>自动检测</span>
      </button>
      <button class="start-dock-secondary" data-action="start-pick-path" data-id="${esc(game.id)}" title="手动指定客户端启动程序">
        ${icon('folder')}
        <span>路径选择</span>
      </button>
    </div>`;
}

function startServerPanel(game) {
  const servers = game.servers || [];
  const active =
    servers.find((server) => server.id === game.activeServerId) || servers[0] || null;
  const status = active ? serverState(active) : null;
  const fileName = active && active.path ? active.path.split(/[\\/]/).pop() : '';
  const activeBlock = active ? serverBlockHint(active) : null;
  const ready = servers.filter((server) => server.exists && !server.incomplete).length;
  const open = Boolean(state.startServerMenu);

  const itemMarkup = (server) => {
    const state_ = serverState(server);
    const file = server.path ? server.path.split(/[\\/]/).pop() : '';
    const tag = serverChannelTag(game, server);
    const block = serverBlockHint(server);
    // 右边这枚小标签是「一眼看出状态」的那一眼；就绪态不写字（点已经是绿的），
    // 留白比「已就绪」三个字更干净，也能把宽度让给渠道和文件名
    const badge = server.active ? '当前' : state_.label;
    // 2.4.5：下拉行不再显示 exe 文件名——只有「没有文件」时才写短状态
    // （未选 exe / 告警块），有文件的行只留 渠道 tag，行高更矮
    const sub = file ? '' : (block ? block.short : '') || '';
    // 没装好的行点下去不是「切过去」，而是问「怎么把它补上」（硬链接 / 选路径 / 扫描）
    const usable = server.exists && !server.incomplete;
    return `
        <button class="start-server-item ${server.active ? 'is-active' : ''} ${
          usable ? '' : 'is-unavailable'
        } ${block ? 'is-broken sw-srv-unusable' : ''}"
          role="option" aria-selected="${server.active ? 'true' : 'false'}"
          data-action="${usable ? 'start-server-pick' : 'start-server-setup'}" data-game="${esc(game.id)}" data-server="${esc(server.id)}"
          title="${esc(block ? `${server.name} · ${block.text}` : server.path || server.packPath || server.name)}">
          <span class="start-server-item-dot ${state_.cls}"></span>
          <span class="start-server-item-copy">
            <strong>${esc(server.name)}${
              // 渠道跟在名字后面同一行：文件名会被截断，渠道不能跟着一起消失
              tag ? `<em class="sw-srv-tag">${esc(tag)}</em>` : ''
            }</strong>
            ${sub ? `<small>${esc(sub)}</small>` : ''}
          </span>
          ${badge ? `<em class="sw-srv-state ${state_.cls}">${esc(badge)}</em>` : ''}
          ${server.active ? `<span class="start-server-item-tick">${icon('check')}</span>` : ''}
          <span class="start-server-item-go" aria-hidden="true">${icon('chevron-right', 'xs')}</span>
        </button>`;
  };

  /*
   * 2.4.0 合并自对方分支：服务器列表按 group 分组渲染。
   * 明日方舟的国际服是 Yostar 发行的一组区域服（EN / JP / KR），
   * 它们平铺在一起会和「官服 / B服」混成六个平级条目，看不出层级关系。
   * 这里把同组的收进一个小标题下面，其余条目照原样平铺。
   */
  const items = groupServersForDisplay(servers)
    .map((group) => {
      const body = group.items.map(itemMarkup).join('');
      if (!group.label) return body;
      return `<div class="start-server-group">
          <div class="start-server-group-label">${esc(group.label)}</div>
          ${body}
        </div>`;
    })
    .join('');

  /*
   * 下拉里的「服务器列表」和「动作区」必须是两个兄弟节点。
   * 之前动作区用 position:sticky;bottom:0 钉在滚动区底部，实测直接把服务器行盖住了
   * （官服那行带告警块、比较高，B服/国际服被压在动作区下面，既看不见也点不到）。
   * 现在列表自己滚（.sw-srv-list），动作区在文档流里占固定高度。
   */
  return `
    <div class="start-dock${open ? ' is-menu-open' : ''}">
      <span class="start-dock-crest" aria-hidden="true"><img src="assets/sparxie.png" alt="" draggable="false" /></span>
      <span class="start-dock-charm" aria-hidden="true"><img src="assets/sparkle-mask.png" alt="" draggable="false" /></span>
      <span class="start-dock-sparks" aria-hidden="true"><i></i><i></i><i></i></span>
      <div class="start-server-anchor">
        <div class="start-dock-server-head">
          <span class="start-dock-label">服务器 <em>${ready} / ${servers.length} 可用</em></span>
        </div>
        <button class="start-server-pick" data-action="start-server-menu" aria-expanded="${open ? 'true' : 'false'}" title="展开服务器列表">
          <span class="start-server-pick-dot ${status ? status.cls : 'missing'}"></span>
          <span class="start-server-pick-copy">
            <strong>${esc(active ? active.name : '未配置服务器')}</strong>
            <small>${
              activeBlock
                ? `<span class="sw-srv-pick-bad">${esc(activeBlock.short)}</span>`
                : `${
                    active && serverChannelTag(game, active)
                      ? `<em class="sw-srv-tag">${esc(serverChannelTag(game, active))}</em>`
                      : ''
                  }${fileName ? '' : esc(status ? status.label : '还没有可用客户端')}`
            }</small>
          </span>
          <span class="start-server-pick-caret">${icon('chevron-down')}</span>
        </button>
        <div class="start-server-menu" role="listbox" aria-label="服务器列表">
              <div class="sw-srv-actions">
                ${
                  // 全都认出来了就没必要再「重新扫描」——那个按钮只在还没找全的时候才有用
                  ready < servers.length
                    ? `<button class="sw-srv-action" data-action="start-detect" data-game="${esc(game.id)}" title="刚装完游戏或挪过文件夹时，让启动器重新找一遍">
                  <span class="sw-srv-action-icon">${icon('refresh')}</span>
                  <span class="sw-srv-action-copy"><strong>重新扫描</strong></span>
                </button>`
                    : ''
                }
                <button class="sw-srv-action" data-action="start-server-manage" data-game="${esc(game.id)}" title="切换、重建、编辑 exe 路径、硬链接去重都在这里">
                  <span class="sw-srv-action-icon">${icon('settings')}</span>
                  <span class="sw-srv-action-copy"><strong>服务器管理</strong></span>
                </button>
              </div>
              <div class="sw-srv-list">${items || '<p class="start-server-empty">还没有服务器</p>'}</div>
        </div>
      </div>
      ${
        game.running
          ? `<div class="start-dock-running">
              <span class="start-dock-running-dot"></span>
              <span class="start-dock-running-copy">
                <strong>正在运行</strong>
                <small id="start-run-timer" data-since="${esc(String(game.runningSince || 0))}">00:00</small>
              </span>
              <button class="start-dock-stop" data-action="stop-game" data-id="${esc(game.id)}" title="结束游戏进程" aria-label="结束游戏进程">${icon('stop')}</button>
            </div>`
          : `${startDockPredownload(game)}${startDockDownloadActions(game)}`
      }
    </div>`;
}

/** 完整的服务器管理面板：复用 servers 页的每一行操作。 */
function openStartServerManager(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;
  const servers = game.servers || [];
  openModal(`
    <div class="modal-backdrop" data-backdrop>
      <div class="modal modal-servers" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div class="ms-head">
            <h2>服务器 · ${esc(game.name)}</h2>
            <span class="ms-count"><strong>${servers.filter((server) => server.exists && !server.incomplete).length}</strong> 可用 · <strong>${servers.filter((server) => !server.exists || server.incomplete).length}</strong> 待处理</span>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          ${
            game.builtinKey === 'neverness'
              ? nteChannelMarkup(game, servers.find((item) => item.active) || servers[0])
              : ''
          }
          <div class="server-list" id="server-manager-list" data-game="${esc(game.id)}">${servers.map((server) => serverRow(game, server)).join('') || '<p class="gacha-empty-line">还没有服务器</p>'}</div>
          <div class="server-progress-slot" id="server-progress-slot" hidden></div>
        </div>
        <div class="modal-foot ms-foot">
          <div class="ms-actions">
            <button class="btn btn-ghost btn-sm" data-action="start-detect" data-game="${esc(game.id)}" title="重新扫描安装目录，找已经装好的客户端">${icon('refresh')}重新扫描</button>
            <button class="btn btn-ghost btn-sm" data-action="start-link" data-game="${esc(game.id)}" title="两个客户端里完全相同的文件只留一份，省下重复占的空间">${icon('link')}硬链接去重</button>
            <button class="btn btn-ghost btn-sm" data-action="start-server-guide" data-game="${esc(game.id)}" title="切换服务器会做什么、需要你准备什么">${icon('alert')}切换说明</button>
            ${game.builtin ? '' : `<button class="btn btn-ghost btn-sm" data-action="add-server" data-game="${esc(game.id)}">${icon('plus')}添加服务器</button>`}
          </div>
          <button class="btn btn-primary btn-sm" data-action="start-server-done" data-game="${esc(game.id)}">完成</button>
        </div>
      </div>
    </div>
  `);
  // 渠道和预下载状态都是外部读来的，弹窗建好后再补，不阻塞打开
  if (game.builtinKey === 'neverness') refreshNtePanel();
  autoCheckPredownload(game);
}

/* ------------------------------------------------------------------ */
/* 切换服务器的第一次引导                                              */
/* ------------------------------------------------------------------ */

/**
 * 没装过的那个服，点它先问一句「怎么补上这份客户端」。
 *
 * 原来的行为是一步到位：官方渠道直接进硬链接安装，其它渠道直接开「选路径」。
 * 问题是用户手里到底是「已经装了、只是没告诉启动器」还是「根本还没下」，
 * 启动器猜不出来 —— 猜错就是白等一个几十分钟的安装，或者对着文件选择框发愣。
 *
 * 三条路摊开写清楚代价：硬链接最省空间（但要有源）、选路径最快（已经装好了）、
 * 自动扫描不用记路径。选完才真正进各自动作，弹窗自己先关掉。
 */
function openServerSetupDialog(gameId, serverId) {
  const game = state.games.find((item) => item.id === gameId);
  const server = game && (game.servers || []).find((item) => item.id === serverId);
  if (!game || !server) return;
  // 能当硬链接源的：别的渠道、文件真的还在
  const bases = (game.servers || []).filter(
    (item) =>
      item.id !== server.id && item.exists && !item.incomplete && item.channel !== server.channel
  );
  const canLink = bases.length > 0;
  const baseNames = bases.map((item) => item.name).join(' / ');
  openModal(
    `<div class="modal-backdrop" data-backdrop>
      <div class="modal narrow modal-setup" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>${esc(server.name)}</h2>
            <p>${esc(game.name)} · 这个服还没有能启动的客户端</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <ul class="setup-pick">
            <li>
              <button class="setup-opt" data-setup="link" ${canLink ? '' : 'disabled'}>
                <span class="setup-opt-icon">${icon('link')}</span>
                <span class="setup-opt-copy">
                  <strong>硬链接生成一份</strong>
                  <small>${
                    canLink
                      ? `以「${esc(baseNames)}」为源，一样的文件直接复用，只下差异部分`
                      : '本机还没有别的渠道客户端可以当源'
                  }</small>
                </span>
                <span class="setup-opt-go">${icon('chevron-right')}</span>
              </button>
            </li>
            <li>
              <button class="setup-opt" data-setup="path">
                <span class="setup-opt-icon">${icon('folder-open')}</span>
                <span class="setup-opt-copy">
                  <strong>选择已经装好的客户端</strong>
                  <small>${esc(server.name)} 其实装过了，手动指到它的 exe</small>
                </span>
                <span class="setup-opt-go">${icon('chevron-right')}</span>
              </button>
            </li>
            <li>
              <button class="setup-opt" data-setup="scan">
                <span class="setup-opt-icon">${icon('refresh')}</span>
                <span class="setup-opt-copy">
                  <strong>自动扫描一遍</strong>
                  <small>在常见安装目录里找 ${esc(server.name)} 的客户端</small>
                </span>
                <span class="setup-opt-go">${icon('chevron-right')}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>`
  );
  dom.modalRoot.querySelectorAll('[data-setup]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const choice = btn.dataset.setup;
      closeModal();
      if (choice === 'link') {
        openSophonModal(gameId, serverId, 'prepare');
        return;
      }
      if (choice === 'path') {
        openServerModal(gameId, serverId);
        return;
      }
      const result =
        typeof api.games?.detectServer === 'function'
          ? await api.games.detectServer(gameId, serverId)
          : await api.games.detect(gameId);
      if (result && result.ok) {
        toast(`${server.name} 已找到，路径已填好`, 'success');
      } else {
        toast((result && result.error) || '没找到这个服的客户端，可以手动选路径', 'info');
      }
    });
  });
}


const SERVER_SWITCH_GUIDE_KEY = 'vela:server-switch-guide';

/** 切换说明的每一条：都是「换之前要知道的」，一句一件事。 */
/* 三步讲清「怎么换」：顺序就是用户真正要做的顺序，别的都算补充说明 */
const SERVER_SWITCH_GUIDE_STEPS = [
  {
    title: '先把游戏关掉',
    text: '开着的时候切换会被拦下来：客户端文件正被占用，切过去也起不来。',
  },
  {
    title: '点一下要换到的服务器',
    text: '只列已经装好的。灰掉的那些点进去是去做准备，不会开始下载。',
  },
  {
    title: '看到「当前」跳过去就好了',
    text: '再点开始游戏，启动的就是它的客户端。第一次进游戏要重新登录。',
  },
];

/* 容易误会的事：三条，一条一句，扫一眼能看完。
   渠道包原本分「要不要下」和「删了怎么办」两条，两个游戏都一样，合成一条讲完。 */
const SERVER_SWITCH_GUIDE_POINTS = [
  '各渠道的账号、存档、更新包互不相通，换过去要重新登录。',
  '同一个客户端文件夹别被两行同时占：删掉它，两边一起失效。',
  '终末地、明日方舟（官服 / B服）要渠道包：第一次切到那个服会先问你要下多少，点了才下（能取消、下次接着下）；删了也能玩，但更新本体前要先切一次服把包补回来——直接点「开始游戏」不会问你要包。',
  '终末地国际服 / Play / Steam 是海外发行版，连游戏本体二进制都和国服不同，第一次切过去要下约 940 MB 的整个差异包（官服 9 MB、B服 194 MB 那些只是渠道 SDK）。',
];

function serverSwitchGuideSeen() {
  try {
    return localStorage.getItem(SERVER_SWITCH_GUIDE_KEY) === '1';
  } catch {
    // 隐私模式读不到存储，就当没看过——多弹一次比一次不弹好
    return false;
  }
}

function markServerSwitchGuideSeen() {
  try {
    localStorage.setItem(SERVER_SWITCH_GUIDE_KEY, '1');
  } catch {
    /* 写不进去就算了，大不了下次再弹一遍 */
  }
}

/**
 * 「切换服务器是怎么回事」的说明卡。
 * 第一次在启动页切换成功后自动弹一次；以后想看，从「服务器管理」里的
 * 「切换说明」进，关掉后回到管理面板，不把人晾在原地。
 */
function openServerSwitchGuide({ returnToManager = '' } = {}) {
  openModal(
    `<div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="server-guide-title">
        <div class="modal-head">
          <div>
            <h2 id="server-guide-title">怎么换服务器</h2>
            <p>以后想再看，在「服务器管理」里点「切换说明」。</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <ol class="switch-guide-steps">
            ${SERVER_SWITCH_GUIDE_STEPS.map(
              (step, index) => `
              <li class="switch-guide-step">
                <span class="switch-guide-num">${index + 1}</span>
                <div class="switch-guide-copy">
                  <strong>${esc(step.title)}</strong>
                  <p>${esc(step.text)}</p>
                </div>
              </li>`
            ).join('')}
          </ol>
          <ul class="switch-guide-notes">
            ${SERVER_SWITCH_GUIDE_POINTS.map((text) => `<li>${esc(text)}</li>`).join('')}
          </ul>
        </div>
        <div class="modal-foot">
          <button class="btn btn-primary" data-close>知道了</button>
        </div>
      </div>
    </div>`,
    {
      onClose: () => {
        if (returnToManager) openStartServerManager(returnToManager);
      },
    }
  );
}

/** 真切换成功之后才调：没看过就弹一次，顺手记下已经看过。 */
function showServerSwitchGuideOnce() {
  if (serverSwitchGuideSeen()) return;
  markServerSwitchGuideSeen();
  openServerSwitchGuide();
}

/** 让暂停按钮的图标和文案跟着视频状态走。 */
/**
 * 开始页的运行计时：游戏跑起来后，开始按钮的位置改显示「已运行 时:分:秒」，
 * 跟 Starward 一样让人一眼看到这局跑了多久。
 */
function syncStartRunningTimer() {
  const el = document.querySelector('#start-run-timer');
  if (!el) return false;
  const since = Number(el.dataset.since || 0);
  if (!since) return false;
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  el.textContent = hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
  return true;
}

let startRunTimerId = null;

function stopStartRunningTimer() {
  if (startRunTimerId) clearInterval(startRunTimerId);
  startRunTimerId = null;
}

function startStartRunningTimer() {
  stopStartRunningTimer();
  if (!syncStartRunningTimer()) return;
  startRunTimerId = setInterval(() => {
    if (!syncStartRunningTimer()) stopStartRunningTimer();
  }, 1000);
}

function restoreStartVideoState() {
  const video = liveStartVideo();
  if (!video) return;
  const gameId = state.startGameId || (state.games[0] && state.games[0].id) || '';
  const paused = wasStartVideoPaused(gameId);

  // 只有用户主动暂停过才保持暂停；
  // 因为离开启动页（DOM 重建 / 页面切走）浏览器也会触发 pause，
  // 那种情况不算「用户暂停」，回来时要继续播放。
  if (paused) {
    video.pause();
    updateStartVideoToggle(true);
  } else {
    video.play().catch(() => {});
    updateStartVideoToggle(false);
  }

  if (video.dataset.pauseBound !== '1') {
    video.dataset.pauseBound = '1';
    video.addEventListener('pause', () => {
      updateStartVideoToggle(true);
      // 只有用户点击过暂停按钮，才记为「手动暂停」
      if (video.dataset.userPaused === '1') {
        rememberStartVideoPaused(state.startGameId || '', true);
      }
    });
    video.addEventListener('play', () => {
      video.dataset.userPaused = '0';
      updateStartVideoToggle(false);
      rememberStartVideoPaused(state.startGameId || '', false);
    });
  }
}

function updateStartVideoToggle(paused) {
  const use = document.querySelector('#start-video-use');
  if (use) use.setAttribute('href', paused ? '#i-play' : '#i-pause');
  const button = document.querySelector('[data-action="toggle-start-video"]');
  if (button) {
    button.classList.toggle('is-paused', Boolean(paused));
    button.title = paused ? '继续播放动态背景' : '暂停动态背景';
  }
}

/** 启动页背景视频的暂停状态记忆（每个游戏独立）。 */
const START_VIDEO_PAUSED_KEY = 'vela:start-video-paused';

function rememberStartVideoPaused(gameId, paused) {
  try {
    const raw = JSON.parse(localStorage.getItem(START_VIDEO_PAUSED_KEY) || '{}');
    const map = raw && typeof raw === 'object' ? raw : {};
    map[gameId] = Boolean(paused);
    localStorage.setItem(START_VIDEO_PAUSED_KEY, JSON.stringify(map));
  } catch {
    /* 可选记忆 */
  }
}

function wasStartVideoPaused(gameId) {
  try {
    const map = JSON.parse(localStorage.getItem(START_VIDEO_PAUSED_KEY) || '{}');
    return Boolean(map && map[gameId]);
  } catch {
    return false;
  }
}

/**
 * 花火 / 火花：官方透明立绘（1306 / 1501），摆在主页当后台双人卡。
 *
 * 这两张卡不是纯摆设：
 *   花火 = 游戏快启：显示最近游玩的封面和名字，点一下直接开那个游戏；
 *   火花 = 音乐遥控：显示正在播的歌，卡上自带 上一首/播放暂停/下一首 三个键，
 *          连了直播点歌还会亮牌子；点卡身其它位置进点歌台。
 * 数据都取自本机现有状态，播放键图标由 updateSongChrome() 在 play/pause 事件里同步。
 */
function characterDuoMarkup() {
  const recent =
    [...state.games]
      .filter((game) => game.lastPlayed)
      .sort((a, b) => new Date(b.lastPlayed || 0) - new Date(a.lastPlayed || 0))[0] ||
    state.games[0] ||
    null;
  const totalSeconds = state.games.reduce((sum, game) => sum + (game.playSeconds || 0), 0);
  const song = currentSongEntry();
  const songTitle = song ? String(song.title || song.name || '') : '';
  const songArtist = song ? String(song.artist || song.singer || '') : '';
  // 这里必须自己取一次 audio：它只是别处函数里的局部变量，
  // 直接写 audio.src 会在渲染主页时抛 "audio is not defined"，整个主页都切不过去。
  const audio = document.querySelector('#song-audio');
  const playing = Boolean(song) && Boolean(audio && audio.src) && Boolean(audio && !audio.paused);
  const queue = state.songs.length;
  const liveCount = Array.isArray(state.liveRooms) ? state.liveRooms.length : 0;

  const gameSub = recent
    ? `累计 ${formatPlaytime(totalSeconds)} · 点一下接着演`
    : '在游戏库里挑一个开场吧';
  const songSub = song
    ? `${playing ? '正在播放' : '已暂停'}${songArtist ? ' · ' + songArtist : ''} · 队列 ${queue} 首`
    : `队列 ${queue} 首 · 点一下去点歌`;

  const gameBody = recent
    ? `<span class="duo-game">
        ${
          recent.coverUrl
            ? `<img class="duo-game-cover" src="${esc(recent.coverUrl)}" alt="" referrerpolicy="no-referrer" />`
            : `<span class="duo-game-cover is-initial">${esc(initial(recent.name))}</span>`
        }
        <span class="duo-game-name">${esc(recent.name)}</span>
        ${recent.running ? '<span class="duo-live is-running">运行中</span>' : ''}
      </span>
      <small class="duo-note">累计 ${formatPlaytime(totalSeconds)} · 点击直接启动</small>`
    : '<small class="duo-note">先去游戏库添加一款游戏</small>';

  const songBody = `
    <span class="duo-song-line" id="duo-song-title">${esc(song ? songTitle || '未知曲目' : '队列空着，去点歌')}</span>
    <span class="duo-controls">
      <span class="duo-ctrl" data-action="duo-prev" title="上一首">${icon('chevron-left', 'xs')}</span>
      <span class="duo-ctrl is-main" data-action="duo-toggle" title="${playing ? '暂停' : '播放'}">
        <span class="duo-ic" data-when="play"${playing ? ' hidden' : ''}>${icon('play')}</span>
        <span class="duo-ic" data-when="pause"${playing ? '' : ' hidden'}>${icon('pause')}</span>
      </span>
      <span class="duo-ctrl" data-action="duo-next" title="下一首">${icon('chevron-right', 'xs')}</span>
      ${liveCount ? `<span class="duo-live">${icon('mic', 'xs')}直播点歌 × ${liveCount}</span>` : ''}
    </span>
    <small class="duo-note">${songArtist ? esc(songArtist) + ' · ' : ''}队列 ${queue} 首</small>`;

  return `
    <div class="char-duo">
      <button type="button" class="char-duo-card is-sparkle" data-action="duo-game" title="${esc(gameSub)}"${
        recent ? ` data-game="${esc(recent.id)}"` : ''
      }>
        <img src="assets/sparkle-fullbody.png" alt="花火" />
        <span class="char-duo-copy">
          <strong>花火 <i class="duo-tag">游戏快启</i></strong>
          <span class="char-duo-stat">${gameBody}</span>
        </span>
      </button>
      <button type="button" class="char-duo-card is-sparxie" data-action="duo-song" title="${esc(songSub)}">
        <img src="assets/sparxie-fullbody.png" alt="火花" />
        <span class="char-duo-copy">
          <strong>火花 <i class="duo-tag">音乐遥控</i></strong>
          <span class="char-duo-stat">${songBody}</span>
        </span>
      </button>
    </div>
  `;
}

function homePlaytimeMarkup() {
  const ordered = [...state.games].sort(
    (a, b) =>
      (b.playSeconds || 0) - (a.playSeconds || 0) ||
      new Date(b.lastPlayed || b.createdAt || 0) - new Date(a.lastPlayed || a.createdAt || 0)
  );
  const total = ordered.reduce((sum, game) => sum + (game.playSeconds || 0), 0);
  const launches = ordered.reduce((sum, game) => sum + (game.launchCount || 0), 0);
  const playedCount = ordered.filter((game) => (game.playSeconds || 0) > 0).length;
  const maxSeconds = Math.max(1, ...ordered.map((game) => game.playSeconds || 0));
  /*
   * 主页紧凑化：整个统计区改成 <details> 折叠条，默认收起只留一行摘要，
   * 数字全部内联在摘要里；展开后仍是原来的 KPI 卡和逐款明细，数据一点不丢。
   */
  return `
    <details class="home-stats" id="home-stats">
      <summary class="home-stats-summary">
        <span class="home-stats-title">游玩统计</span>
        <span class="home-stats-brief">累计 <strong>${formatPlaytime(total)}</strong> · ${launchedLabel(launches)} · ${ordered.length} 款游戏${total ? ` · 已游玩 ${playedCount} 款` : ''}</span>
        <span class="home-stats-hint">点开看明细</span>
      </summary>
      <div class="playtime-summary">
        <div class="playtime-total">
          <span>累计游玩</span>
          <strong>${formatPlaytime(total)}</strong>
          <small>${launchedLabel(launches)} · ${ordered.length} 款游戏</small>
        </div>
        <div class="playtime-kpi"><strong>${launches}</strong><span>总启动次数</span></div>
        <div class="playtime-kpi"><strong>${playedCount}</strong><span>已游玩游戏</span></div>
      </div>
      <div class="playtime-list">
        ${ordered
          .map((game) => {
            const seconds = game.playSeconds || 0;
            const percent = Math.max(0, Math.min(100, (seconds / maxSeconds) * 100));
            return `
              <article class="playtime-row ${game.running ? 'is-running' : ''}">
                <span class="playtime-cover" data-initial="${esc(initial(game.name))}">
                  ${game.coverUrl ? `<img src="${esc(game.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-cover />` : esc(initial(game.name))}
                </span>
                <div class="playtime-main">
                  <div class="playtime-name"><strong>${esc(game.name)}</strong>${game.running ? '<span class="playtime-running"><i></i>运行中</span>' : ''}</div>
                  <small>${esc(relativeDate(game.lastPlayed))} · ${game.launchCount || 0} 次启动</small>
                  <span class="playtime-bar"><i style="width:${percent}%"></i></span>
                </div>
                <div class="playtime-value">
                  <strong>${formatPlaytime(seconds)}</strong>
                  <small>${seconds ? `占比 ${Math.round((seconds / total) * 100)}%` : '未游玩'}</small>
                </div>
              </article>`;
          })
          .join('')}
      </div>
    </details>`;
}

function launchedLabel(count) {
  return count ? `${count} 次启动` : '还没有启动记录';
}

function homeView() {
  const name = state.settings.profileName || '大小姐';
  const mood = homeMood();
  const recent = [...state.games]
    .sort((a, b) => new Date(b.lastPlayed || b.createdAt || 0) - new Date(a.lastPlayed || a.createdAt || 0))
    .slice(0, 3);
  const demoCount = state.games.filter((game) => game.demo).length;
  const installedCount = state.games.filter((game) => game.installed).length;
  const favoriteCount = state.games.filter((game) => game.favorite).length;
  const playSeconds = state.games.reduce((sum, game) => sum + (game.playSeconds || 0), 0);
  const ratio = state.games.length ? Math.round((installedCount / state.games.length) * 100) : 0;

  const head = `
    <div class="page-head">
      <div>
        <div class="eyebrow">${PAGE_META.home.eyebrow}</div>
        <h1>${mood.greeting}，${esc(name)}</h1>
        <p class="sub">${mood.sub}</p>
      </div>
      <div class="page-head-actions">
        <button class="btn btn-ghost" data-action="create-desktop-shortcut" title="在桌面创建花筱灵启动器快捷方式">${icon('monitor')}创建桌面快捷</button>
        <button class="btn btn-primary" data-action="add-game">${icon('plus')}添加游戏</button>
      </div>
    </div>`;

  if (!state.games.length) {
    return `
      <div class="page home-page">
        ${head}
        <div class="empty">
          <div class="empty-char" aria-hidden="true"><img src="assets/character-face.png" alt="" /></div>
          <div class="empty-icon">${icon('gamepad')}</div>
          <h3>把第一款游戏放进来</h3>
          <p>选择游戏的启动程序，挑一张封面，剩下的交给花筱灵。游戏资料、游玩时长和设置都只保存在这台电脑上。</p>
          <button class="btn btn-primary" data-action="add-game">${icon('plus')}添加我的第一款游戏</button>
        </div>
        ${
          state.news.length
            ? `<div class="section-head"><div><h3>最新动态</h3><p>使用指南与更新记录</p></div><button class="link-btn" data-nav="news">全部动态 ${icon('chevron-right')}</button></div>
               <div class="news-grid">${state.news.slice(0, 3).map(newsCard).join('')}</div>`
            : ''
        }
      </div>`;
  }

  return `
    <div class="page home-page">
      ${head}
      ${stageHero(recent[0], mood)}
      ${
        demoCount
          ? `<div class="notice">
              ${icon('sparkle')}
              <span>库中还有 <strong>${demoCount}</strong> 个示例条目，它们不会真的启动。添加你自己的游戏，或者清空示例重新开始。</span>
              <span class="notice-actions">
                <button class="link-btn" data-action="clear-demo">清空示例</button>
                <button class="link-btn" data-action="add-game" style="color:var(--accent)">添加游戏 ${icon('chevron-right')}</button>
              </span>
            </div>`
          : ''
      }
      ${librarySectionMarkup()}
      ${homePlaytimeMarkup()}
      <div class="section-head home-news-head">
        <div><h3>最新动态</h3></div>
        <button class="link-btn" data-nav="news">全部动态 ${icon('chevron-right')}</button>
      </div>
      <div class="home-news-list">${state.news.slice(0, 3).map(homeNewsRow).join('')}</div>
      ${characterDuoMarkup()}
    </div>`;
}
