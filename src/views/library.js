'use strict';

/**
 * 视图层：游戏库页（library）。
 *
 * 2026-10-31 从 app.js 拆出 —— 「前后端分离」第 6 批。
 *
 * 内容：
 *   · librarySectionMarkup  —— 筛选条 + 排序条 + 结果区骨架
 *   · gameCard              —— 游戏库卡片（封面、状态角标、悬浮操作）
 *   · libraryResultsMarkup  —— 筛选/排序后的卡片墙
 *   · libraryView           —— 整页装配
 *   · renderQuickPanel      —— 快捷面板（命名容易误会：它跟游戏库同段，
 *                              但 render() 每帧都会调它，属全局刷新的一环）
 *
 * 加载约定：普通 script，共享全局词法作用域，必须排在 app.js 之前。
 * 依赖 state / dom / icon / esc 等，均在调用时解析；顶层无立即求值。
 */

/* ------------------------------------------------------------------ */
/* library                                                             */
/* ------------------------------------------------------------------ */

function librarySectionMarkup() {
  const filters = [
    ['all', '全部'],
    ['favorite', '收藏'],
    ['installed', '已安装'],
  ];
  return `
    <section class="home-library" id="home-library">
      <div class="section-head home-library-head">
        <div><h3>游戏库</h3></div>
        <div class="home-library-actions">
          <button class="btn btn-ghost btn-icon" data-action="sync-official" title="同步官网版本与封面">${icon('sparkle')}</button>
          <button class="btn btn-ghost btn-icon" data-action="detect-all" title="自动检测已安装游戏">${icon('refresh')}</button>
          <button class="btn btn-primary" data-action="add-game">${icon('plus')}添加游戏</button>
        </div>
      </div>
      <div class="library-toolbar">
        <label class="search-box">
          ${icon('search')}
          <input id="game-search" type="text" placeholder="搜索游戏、标签或简介…" value="${esc(state.search)}" autocomplete="off" spellcheck="false" />
          <button class="search-clear" data-action="clear-search" title="清除搜索" style="${state.search ? '' : 'display:none'}">${icon('x')}</button>
        </label>
        <div class="chips">
          ${filters
            .map(
              ([key, label]) =>
                `<button class="chip ${state.filter === key ? 'active' : ''}" data-action="set-filter" data-value="${key}">${label}</button>`
            )
            .join('')}
        </div>
        <div class="toolbar-right">
          <select class="select" id="sort-select" aria-label="排序方式">
            <option value="recent" ${state.sort === 'recent' ? 'selected' : ''}>最近游玩</option>
            <option value="added" ${state.sort === 'added' ? 'selected' : ''}>最近添加</option>
            <option value="name" ${state.sort === 'name' ? 'selected' : ''}>名称排序</option>
          </select>
        </div>
      </div>
      <div id="library-results">${libraryResultsMarkup()}</div>
    </section>`;
}

function gameCard(game) {
  const running = game.running;
  const action = running
    ? 'stop-game'
    : game.installed
      ? 'launch-game'
      : game.builtin
        ? 'detect-game'
        : 'edit-game';
  const actionLabel = running ? '停止' : game.installed ? '启动' : game.builtin ? '检测' : '配置';
  const actionIcon = running ? 'stop' : game.installed ? 'play' : game.builtin ? 'refresh' : 'wrench';
  const tags = (game.tags || []).slice(0, 2);
  const activeServer = (game.servers || []).find((server) => server.id === game.activeServerId);
  return `
    <article class="game-card" data-id="${esc(game.id)}">
      <div class="game-cover ${game.coverUrl ? '' : 'no-img'}" data-initial="${esc(initial(game.name))}" style="--accent:${esc(/^#[0-9a-f]{6}$/i.test(game.accent || '') ? game.accent : '#f08ba6')}">
        ${game.coverUrl ? `<img src="${esc(game.coverUrl)}" alt="${esc(game.name)} 封面" loading="lazy" decoding="async" draggable="false" referrerpolicy="no-referrer" data-cover />` : ''}
        <div class="cover-top">
          <span style="display:flex;gap:5px;flex-wrap:wrap">
            ${game.demo ? '<span class="badge demo">示例</span>' : ''}
            ${game.builtin && !game.installed ? '<span class="badge">待检测</span>' : ''}
            ${running ? '<span class="badge running"><span class="dot"></span>运行中</span>' : ''}
          </span>
          <button class="fav-btn ${game.favorite ? 'on' : ''}" data-action="toggle-fav" data-id="${esc(game.id)}" title="${game.favorite ? '取消收藏' : '加入收藏'}" aria-label="${game.favorite ? '取消收藏' : '加入收藏'}">
            ${icon('star', game.favorite ? 'fill' : '')}
          </button>
        </div>
        <div class="cover-actions">
          <button class="card-play ${game.installed || running ? '' : 'configure'}" data-action="${action}" data-id="${esc(game.id)}">
            ${icon(actionIcon)}${actionLabel}
          </button>
          <button class="card-tool" data-action="change-cover" data-id="${esc(game.id)}" title="更换封面">${icon('image')}</button>
          <button class="card-tool" data-action="edit-game" data-id="${esc(game.id)}" title="编辑游戏">${icon('edit')}</button>
          ${cardPredownloadEntry(game)}
          ${game.builtin ? '' : `<button class="card-tool danger" data-action="delete-game" data-id="${esc(game.id)}" title="从游戏库移除">${icon('trash')}</button>`}
        </div>
      </div>
      <div class="game-info">
        <div class="game-title">${esc(game.name)}</div>
        <div class="game-sub">${esc(game.subtitle || game.description || '等待补充一点介绍')}</div>
        <div class="game-meta">
          ${activeServer ? `<span>${esc(activeServer.name)}</span><span class="sep"></span>` : ''}
          ${game.version ? `<span>v${esc(game.version)}</span><span class="sep"></span>` : game.versionName ? `<span>${esc(game.versionName)}</span><span class="sep"></span>` : ''}
          ${tags.length ? `<span>${esc(tags.join(' · '))}</span>` : `<span>${game.installed ? '已安装' : '未配置'}</span>`}
          <span class="sep"></span>
          <span>${running ? '<span class="running-text">正在运行</span>' : game.builtin && !game.installed ? '未检测到安装' : esc(relativeDate(game.lastPlayed))}</span>
        </div>
      </div>
    </article>`;
}

function renderQuickPanel() {
  const panel = document.querySelector('#quick-panel');
  const list = document.querySelector('#quick-list');
  if (!panel || !list) return;
  const pinned = state.settings.quickPanelPinned === true;
  if (pinned) quickOpen = true;
  panel.hidden = !quickOpen;
  const pin = panel.querySelector('.quick-pin');
  if (pin) pin.classList.toggle('on', pinned);
  const games = state.games
    .map((game) => ({
      game,
      servers: (game.servers || []).filter((server) => server.exists),
    }))
    .filter((item) => item.servers.length);
  if (!games.length) {
    list.innerHTML = '<div class="quick-empty">还没有已配置的服务器。<br />先在服务器页配置一个客户端。</div>';
    return;
  }
  list.innerHTML = games
    .map(
      ({ game, servers }) => `
      <div class="quick-game">
        <div class="quick-game-name">${esc(game.name)}</div>
        ${servers
          .map(
            (server) => `
          <button class="quick-server ${server.active ? 'active' : ''}" data-action="quick-launch" data-game="${esc(
            game.id
          )}" data-server="${esc(server.id)}" title="启动 ${esc(server.name)}">
            <span class="dot"></span>
            <span>${esc(server.name)}</span>
            ${icon('play')}
          </button>`
          )
          .join('')}
      </div>`
    )
    .join('');
}

function libraryResultsMarkup() {
  const games = filteredGames();
  if (!games.length) {
    if (!state.games.length) {
      return `<div class="empty">
        <div class="empty-icon">${icon('library')}</div>
        <h3>游戏库还是空的</h3>
        <p>添加已安装的游戏，封面、标签、版本和启动参数都可以慢慢补。每次启动的时长也会被记下来。</p>
        <button class="btn btn-primary" data-action="add-game">${icon('plus')}添加游戏</button>
      </div>`;
    }
    return `<div class="empty">
      <div class="empty-icon">${icon('search')}</div>
      <h3>没有找到匹配的游戏</h3>
      <p>换一个关键词，或者清除筛选条件再看看。</p>
      <button class="btn btn-ghost" data-action="clear-filters">清除筛选</button>
    </div>`;
  }
  return `<div class="game-grid">${games.map(gameCard).join('')}</div>`;
}

function libraryView() {
  const games = filteredGames();
  const filters = [
    ['all', '全部'],
    ['favorite', '收藏'],
    ['installed', '已安装'],
  ];
  return `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">${PAGE_META.library.eyebrow}</div>
          <h1>游戏库 <span class="count">${state.games.length} 款</span></h1>
          <p class="sub">管理本地游戏、封面和启动路径。内置游戏会自动检测，其他游戏可以手动添加。</p>
        </div>
        <div class="page-head-actions">
          <button class="btn btn-ghost btn-icon" data-action="sync-official" title="同步官网版本与封面">${icon('sparkle')}</button>
          <button class="btn btn-ghost btn-icon" data-action="detect-all" title="自动检测已安装游戏">${icon('refresh')}</button>
          <button class="btn btn-primary" data-action="add-game">${icon('plus')}添加游戏</button>
        </div>
      </div>
      <div class="library-toolbar">
        <label class="search-box">
          ${icon('search')}
          <input id="game-search" type="text" placeholder="搜索游戏、标签或简介…" value="${esc(state.search)}" autocomplete="off" spellcheck="false" />
          <button class="search-clear" data-action="clear-search" title="清除搜索" style="${state.search ? '' : 'display:none'}">${icon('x')}</button>
        </label>
        <div class="chips">
          ${filters
            .map(
              ([key, label]) =>
                `<button class="chip ${state.filter === key ? 'active' : ''}" data-action="set-filter" data-value="${key}">${label}</button>`
            )
            .join('')}
        </div>
        <div class="toolbar-right">
          <select class="select" id="sort-select" aria-label="排序方式">
            <option value="recent" ${state.sort === 'recent' ? 'selected' : ''}>最近游玩</option>
            <option value="added" ${state.sort === 'added' ? 'selected' : ''}>最近添加</option>
            <option value="name" ${state.sort === 'name' ? 'selected' : ''}>名称排序</option>
          </select>
        </div>
      </div>
      <div id="library-results">${libraryResultsMarkup()}</div>
      <div class="panel-sub" style="margin-top:18px">${games.length} 个结果</div>
    </div>`;
}
