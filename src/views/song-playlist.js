'use strict';
/*
 * 音乐 · 歌单广场与歌单数据层（第 10 批从 app.js 搬出，2026-10-31）
 *
 * 内容：歌单广场（公开热门，免登录）/ 我的歌单同步与合并 / 歌单缓存（内存 TTL +
 *      落盘恢复 + 静默刷新）/ 歌单详情缓存 / 打开与播放歌单 / 队列填充与去重 /
 *      音乐登录状态刷新 / 榜单曲目入队 / 歌单搜索 / 直播间弹幕点歌 / 音质档位。
 *
 * 逐字搬运，逻辑一行没改。依赖的 state / dom / api / render / toast / icon 都在
 * app.js 与 services 里定义，classic script 共享全局作用域；本文件排在 app.js
 * 之前，函数在调用时才解析名字，所以逆向依赖安全。
 *
 * 与第 9 批 views/song.js 的分工：那边是播放器核心（队列存档 → 播放 → 进度与歌词），
 * 这边是「歌单从哪来」（广场 / 账号同步 / 缓存 / 详情），播放仍调 song.js 的 playSong。
 * 下一批（导入/添加弹窗、音乐设置、点歌台与音乐页视图渲染）还留在 app.js。
 */
/* ------------------------------------------------------------------ */
/* 音乐 · 歌单广场与歌单数据层                                          */
/* ------------------------------------------------------------------ */
/**
 * 登录成功后统一同步歌单。
 *
 * 以前登录完只拉「当前选中平台」那一个列表，而且写的是 state.myPlaylists.list，
 * 把分组结构 groups 整个冲掉，切到「我的歌单」还是空的，得手动点一次刷新。
 * 现在改成：清缓存 → 三个平台一起读 → 用 toast 报一下各自读到多少。
 */
async function syncPlaylistsAfterLogin(platform) {
  invalidateAllPlaylists();
  if (state.route === 'song') render({ preserveScroll: true });
  await loadAllPlaylists(true);
  if (!platform) return;
  const label = platform === 'netease' ? '网易云' : platform === 'qq' ? 'QQ 音乐' : platform === 'kuwo' ? '酷我' : '酷狗';
  const group = (state.myPlaylists.groups || []).find((item) => item.platform === platform);
  const count = (group?.list || []).length;
  if (group?.error) {
    toast(`${label} 已登录，歌单没读到：${group.error}`, 'info');
  } else {
    toast(count ? `${label} 歌单已同步 · ${count} 个` : `${label} 账号下还没有歌单`, count ? 'success' : 'info');
  }
}

/**
 * 某个平台是不是已登录。
 *
 * 网易云有两处状态（本地 API 的 neteaseLogin 和 musicStatus 里的 netease），
 * 哪边先读到都算登录，不然「我的歌单」会因为读错那一处而漏掉网易云。
 */
function musicLoggedIn(platform) {
  if (platform === 'netease') {
    return Boolean(state.musicLogin?.netease?.loggedIn || state.neteaseLogin?.loggedIn);
  }
  return Boolean(state.musicLogin?.[platform]?.loggedIn);
}

/* ---------- 歌单广场（公开热门歌单，免登录） ---------- */

/** 广场单个平台的缓存：{ loading, list, page, error, done }。 */
function plazaState(platform) {
  const plaza = state.myPlaylists.plaza || (state.myPlaylists.plaza = {});
  return plaza[platform] || (plaza[platform] = { loading: false, list: [], page: 0, error: '', done: false });
}

/** 播放量格式化：过万就折算成「x.x万」。 */
function formatPlaycount(n) {
  const num = Number(n) || 0;
  if (num >= 100000000) return (num / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(num);
}

/** 确保某个平台的广场第一页已经加载。 */
async function ensurePlaza(platform, force = false) {
  const plaza = plazaState(platform);
  if (plaza.loading) return;
  if (!force && (plaza.list.length || plaza.done)) return;
  plaza.loading = true;
  plaza.error = '';
  if (state.route === 'song') render({ preserveScroll: true });
  try {
    const result = await api.musicPlaza(platform, 1);
    if (result?.ok && Array.isArray(result.lists)) {
      plaza.list = result.lists;
      plaza.page = 1;
      plaza.done = result.lists.length < 10;
    } else {
      plaza.error = result?.reason || '读取歌单广场失败';
    }
  } catch (error) {
    plaza.error = humanError(error);
  } finally {
    plaza.loading = false;
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

/** 广场翻页：下一页追加，按 id 去重。 */
async function plazaMore(platform) {
  const plaza = plazaState(platform);
  if (plaza.loading || plaza.done) return;
  const next = (plaza.page || 1) + 1;
  plaza.loading = true;
  if (state.route === 'song') render({ preserveScroll: true });
  try {
    const result = await api.musicPlaza(platform, next);
    if (result?.ok && Array.isArray(result.lists)) {
      const seen = new Set(plaza.list.map((item) => item.id));
      const fresh = result.lists.filter((item) => !seen.has(item.id));
      plaza.list.push(...fresh);
      plaza.page = next;
      plaza.done = fresh.length === 0;
    } else {
      plaza.error = result?.reason || plaza.error;
      plaza.done = true;
    }
  } catch (error) {
    plaza.error = humanError(error);
    plaza.done = true;
  } finally {
    plaza.loading = false;
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

/** 广场分区：平台切换 + 卡片网格 + 加载更多。 */
function plazaSectionMarkup() {
  const platforms = [
    ['netease', '网易云'],
    ['qq', 'QQ 音乐'],
    ['kugou', '酷狗'],
  ];
  const active = platforms.some(([key]) => key === state.myPlaylists.plazaPlatform)
    ? state.myPlaylists.plazaPlatform
    : 'netease';
  if (state.myPlaylists.plazaPlatform !== active) state.myPlaylists.plazaPlatform = active;
  const plaza = plazaState(active);
  const tabs = platforms
    .map(([key, label]) =>
      `<button class="song-chart-tab ${active === key ? 'active' : ''}" data-action="plaza-platform" data-value="${key}">${label}</button>`
    )
    .join('');
  let body = '';
  if (plaza.error && !plaza.list.length) {
    body = `<div class="playlists-error">${icon('alert', 'xs')}<span>${esc(plaza.error)}</span>
      <button class="link-btn" data-action="plaza-retry" data-platform="${esc(active)}">重试</button></div>`;
  } else if (!plaza.list.length) {
    body = `<p class="playlists-group-note">${plaza.loading ? '正在读取广场歌单…' : '广场暂时没有内容。'}</p>`;
  } else {
    const detail = state.myPlaylists.detail;
    body = `<div class="playlist-cards">
      ${plaza.list.map((item) => playlistCardMarkup(item, active, Boolean(detail && detail.id === item.id && detail.platform === active))).join('')}
    </div>
    ${plaza.loading ? '<p class="playlists-group-note">正在加载更多…</p>' : plaza.done ? '' : `<div class="plaza-more-wrap"><button class="playlists-chip" data-action="plaza-more" data-platform="${esc(active)}">${icon('plus', 'xs')}加载更多</button></div>`}`;
  }
  return `<section class="plaza-section">
    <div class="playlists-bar">
      <div class="playlists-bar-title"><strong>歌单广场</strong><span>热门公开歌单 · 点开看曲目，免登录</span></div>
      <div class="playlists-bar-actions"><span class="song-chart-tabs">${tabs}</span></div>
    </div>
    ${body}
  </section>`;
}

/**
 * 把一次全平台同步的结果并进现有分组。
 *
 * 为什么要合并而不是直接替换：某个平台这次读失败（登录过期、接口抽风）时，
 * 上次读到的歌单其实还能用，直接替换会把它连卡片一起抹掉。
 * 这里保留旧列表并打上 stale 标记，只把失败原因标在那一个平台上，别的平台照常。
 *
 * 顺序以后端返回的为准（主进程已经按 netease / qq / kugou / kuwo 固定排好），
 * 只有后端没返回的已登录平台才补到末尾，不在渲染层再排一次。
 */
function mergeAllPlaylistGroups(logged, incoming) {
  const prev = state.myPlaylists.groups || [];
  const list = Array.isArray(incoming) ? incoming : [];
  const keys = list.map((group) => group.platform).filter((key) => logged.includes(key));
  logged.forEach((key) => {
    if (!keys.includes(key)) keys.push(key);
  });

  return keys.map((key) => {
    const fresh = list.find((group) => group.platform === key);
    const old = prev.find((group) => group.platform === key);
    if (!fresh) {
      // 后端这次没返回这个平台（多半是登录态刚变），别把它永远停在「同步中」
      if (old) return old;
      return {
        platform: key,
        label: musicPlatformLabel(key),
        ok: false,
        list: [],
        error: '这次同步没有返回这个平台，稍后再试一次',
      };
    }
    if (fresh.ok) return fresh;
    if (old && (old.list || []).length) return { ...fresh, list: old.list, stale: true };
    return fresh;
  });
}

/**
 * 「上次同步：3 分钟前 · 耗时 1.2s」。
 *
 * 主进程返回 syncedAt / durationMs 就是给这个用的：
 * 歌单同步慢起来要几十秒，没有时间戳用户没法判断该不该再点一次。
 */
function playlistSyncSummary() {
  const at = Number(state.myPlaylists.syncedAt) || 0;
  if (!at) return '';
  const diff = Date.now() - at;
  const when = diff < 60 * 1000 ? '刚刚' : relativeDate(at);
  const ms = Number(state.myPlaylists.syncDurationMs) || 0;
  const cost = ms ? ` · 耗时 ${(ms / 1000).toFixed(1)}s` : '';
  return `上次同步：${when}${cost}`;
}

/**
 * 这个平台是不是正在同步。
 *
 * 三处地方共用：左栏平台行、主区平台分区、「同步全部」按钮的禁用态。
 * 全量同步的时候四个平台都在转，所以 loadingAll 为真一律算同步中。
 */
function playlistSyncing(platform) {
  if (state.myPlaylists.loadingAll) return true;
  const map = state.myPlaylists.syncing || (state.myPlaylists.syncing = {});
  return Boolean(map[platform]);
}

/** 某个平台自己的「上次同步」文案；没同步过就返回空串（不显示）。 */
function playlistSyncWhen(group, { withCost = false } = {}) {
  const at = Number(group?.syncedAt) || 0;
  if (!at) return '';
  const diff = Date.now() - at;
  const when = diff < 60 * 1000 ? '刚刚' : relativeDate(at);
  const ms = Number(group?.durationMs) || 0;
  return withCost && ms ? `上次同步：${when} · 耗时 ${(ms / 1000).toFixed(1)}s` : `上次同步：${when}`;
}

/**
 * 只把「一个平台」的结果并回分组，其它平台原样不动。
 *
 * 这是单平台同步的关键：库里另外三个平台的对象引用一个都不换，
 * 所以不会出现「点了酷狗，网易云的卡片闪一下重新加载」。
 * 失败时保留上次读到的列表（打 stale 标记），把原因挂在这一个平台上。
 */
function applyPlaylistGroup(platform, fresh, meta = {}) {
  const prev = state.myPlaylists.groups || [];
  const index = prev.findIndex((group) => group.platform === platform);
  const old = index >= 0 ? prev[index] : null;
  const syncedAt = Number(meta.syncedAt) || Date.now();
  const durationMs = Number(meta.durationMs) || 0;

  let next;
  if (!fresh) {
    /*
     * 后端没返回这个平台：多半是登录态在服务端已经失效（本地还留着「已登录」）。
     * 旧数据留着别抹掉，但要挂上原因，否则用户点完同步看不出任何变化，
     * 还会以为歌单没更新。
     */
    const reason = '这次没取到这个平台的歌单，可能登录已经失效了，重新登录一次试试';
    next = old
      ? { ...old, ok: false, error: reason, stale: true, syncedAt, durationMs }
      : {
          platform,
          label: musicPlatformLabel(platform),
          ok: false,
          list: [],
          error: reason,
          syncedAt,
          durationMs,
        };
  } else if (fresh.ok) {
    next = { ...fresh, syncedAt, durationMs };
  } else if (old && (old.list || []).length) {
    next = { ...fresh, list: old.list, stale: true, syncedAt, durationMs };
  } else {
    next = { ...fresh, syncedAt, durationMs };
  }

  const groups = prev.slice();
  if (index >= 0) groups[index] = next;
  else groups.push(next);
  state.myPlaylists.groups = groups;
  // 有结果就排一次落盘：下次冷启动能直接画出这面卡片墙。
  // skipCache 是「刚从磁盘读回来的」，没必要马上又写一遍。
  if (!meta.skipCache) schedulePlaylistsCacheSave();
  return next;
}

/**
 * 把「链接导入」的歌单并进「我的歌单」对应平台分组。
 *
 * 酷狗等平台的账号歌单同步已被官方关掉，链接导入是往「我的歌单」里添歌单的唯一入口，
 * 所以导入成功后要主动并进来，不然导入完在「我的歌单」里永远看不到。
 * 分组不存在就新建一个；同 id 已存在就原地覆盖（刷新名字/封面/曲目数）。
 * 歌单打上 imported 标记：缓存恢复时未登录的平台只捞回导入的歌单，
 * 账号同步出来的私有歌单不该在没登录时出现。
 */
function mergeImportedPlaylist(platform, entry) {
  const key = String(platform || '');
  const id = String(entry?.id || '');
  if (!key || !id) return null;
  const item = {
    id,
    name: String(entry?.name || '').trim() || '导入的歌单',
    cover: String(entry?.cover || ''),
    count: Number(entry?.count) || 0,
    creator: String(entry?.creator || ''),
    playcount: Number(entry?.playcount) || 0,
    imported: true,
  };
  const groups = (state.myPlaylists.groups || []).slice();
  const index = groups.findIndex((group) => group.platform === key);
  if (index < 0) {
    // 新分组不带 syncedAt：导入不是同步，「上次同步」不该显示一个假时间
    groups.push({ platform: key, label: musicPlatformLabel(key), ok: true, list: [item] });
  } else {
    const group = groups[index];
    const list = (group.list || []).slice();
    const at = list.findIndex((old) => String(old?.id) === id);
    if (at >= 0) list[at] = { ...list[at], ...item };
    else list.push(item);
    // 导入成功说明这张歌单是好的，把之前同步失败挂着的红字清掉，别让卡片墙顶着报错显示
    groups[index] = { ...group, list, ok: true, error: '', stale: false };
  }
  state.myPlaylists.groups = groups;
  // 跟账号同步一样排一次落盘，冷启动才能把导入的歌单画回来
  schedulePlaylistsCacheSave();
  return item;
}

/**
 * 从「我的歌单」里移除一张链接导入的歌单。
 *
 * 只管 imported 的：账号同步出来的歌单属于平台账号，本地删了下一次同步就回来，
 * 删了等于没删，那种得去平台自己删。链接导入的不在账号里，删了就是删了。
 *
 * 内存和磁盘必须一起动，少一处都会「删完重启又回来」：
 *   1. 内存：从 groups 里摘掉，同时清掉它的详情缓存 —— 不清的话重新导入同一张时，
 *      TTL 内会先显示上次的曲目，看着像没更新。
 *   2. 磁盘：调 music:playlist-remove 按 id 精确剔除。不能只靠 schedulePlaylistsCacheSave，
 *      它和主进程缓存写入都是「空列表跳过」，删到某平台最后一张时两边都不会覆盖旧记录。
 */
async function removeImportedPlaylist(platform, playlistId) {
  const key = String(platform || '');
  const id = String(playlistId || '');
  if (!key || !id) return false;
  const groups = (state.myPlaylists.groups || []).slice();
  const index = groups.findIndex((group) => group.platform === key);
  if (index < 0) return false;
  const group = groups[index];
  const list = (group.list || []).slice();
  const at = list.findIndex((item) => String(item?.id || '') === id);
  // 不是链接导入的不许从这里删
  if (at < 0 || !list[at]?.imported) return false;

  list.splice(at, 1);
  groups[index] = { ...group, list };
  state.myPlaylists.groups = groups;
  delete state.myPlaylists.detailCache?.[playlistDetailCacheKey(key, id)];
  const detail = state.myPlaylists.detail;
  if (detail && String(detail.id || '') === id && String(detail.platform || '') === key) {
    state.myPlaylists.detail = null;
  }
  if (state.route === 'song') render({ preserveScroll: true });

  try {
    const result = await api.musicRemovePlaylist?.({ platform: key, id });
    // 还有别的歌单：补写一次完整列表，免得磁盘上留着这张已删项的旧快照
    if (result?.ok !== false) schedulePlaylistsCacheSave();
  } catch {
    /*
     * 磁盘没删掉不算「删失败」：内存里已经没了，用户看着是删掉的。
     * 但不能静默 —— 冷启动可能又冒出来一次，得说清楚。
     */
    toast('歌单已从列表移除，但本地缓存没写成功，重启后可能还会出现一次', 'info');
  }
  return true;
}


/**
 * 一次性拉取所有已登录平台的歌单。
 * 用 loadingAll 防重入，避免每帧 render 都触发请求。
 *
 * 这是「同步全部」的入口。单个平台的同步走 loadPlaylistsFor：一次只问后端要一个平台，
 * 其它平台的歌单对象一个都不换，这样点酷狗不会连带把网易云重新拉一遍。
 * 主进程 music:all-playlists 不带参数时仍然是四家并发、按固定平台顺序返回整包。
 */
async function loadAllPlaylists(force = false) {
  const logged = ['netease', 'qq', 'kugou'].filter(musicLoggedIn);
  if (!logged.length) return;
  if (state.myPlaylists.loadingAll) return;
  if (!force && state.myPlaylists.groups?.length) return;

  state.myPlaylists.loadingAll = true;
  if (state.route === 'song') render({ preserveScroll: true });
  /*
   * 兜底：主进程那边每一步都有超时，但万一整条 IPC 卡死（比如内置窗口
   * 被系统挂起），界面就会一直停在「正在读取」。这里放一个上限，
   * 到点自己收尾，至少让用户看到「读取超时」而不是无限转圈。
   * 已经读到过的平台不受影响 —— 不能因为一次超时把好好的卡片也清掉。
   */
  const guard = setTimeout(() => {
    if (!state.myPlaylists.loadingAll) return;
    state.myPlaylists.loadingAll = false;
    state.myPlaylists.groups = logged.map((key) => {
      const old = (state.myPlaylists.groups || []).find((group) => group.platform === key);
      if (old && (old.list || []).length) return old;
      return {
        platform: key,
        label: musicPlatformLabel(key),
        ok: false,
        list: [],
        error: '读取超时了，稍后再点一次同步',
      };
    });
    if (state.route === 'song') render({ preserveScroll: true });
  }, 75000);
  try {
    const result = await api.musicAllPlaylists();
    state.myPlaylists.groups = mergeAllPlaylistGroups(logged, Array.isArray(result?.groups) ? result.groups : []);
    /*
     * syncedAt / durationMs 由主进程给：四家现在全并发，一次同步的耗时和完成时刻
     * 只有后端最清楚。界面拿它显示「上次同步：x 分钟前 · 耗时 1.2s」。
     */
    state.myPlaylists.syncedAt = Number(result?.syncedAt) || Date.now();
    state.myPlaylists.syncDurationMs = Number(result?.durationMs) || 0;
    state.myPlaylists.error = '';
    // 每个平台也各记一份，左栏平台行才有自己的「x 分钟前」
    stampPlaylistGroups(logged, state.myPlaylists.syncedAt, state.myPlaylists.syncDurationMs);
    schedulePlaylistsCacheSave();
  } catch (error) {
    // 整体失败（IPC 层就挂了）时，失败原因摊到每个平台，但已经成功拿到歌单的平台保持原样
    const message = humanError(error);
    state.myPlaylists.groups = logged.map((key) => {
      const old = (state.myPlaylists.groups || []).find((group) => group.platform === key);
      if (old && old.ok && (old.list || []).length) return old;
      return {
        platform: key,
        label: musicPlatformLabel(key),
        ok: false,
        list: [],
        error: message,
      };
    });
  } finally {
    clearTimeout(guard);
    state.myPlaylists.loadingAll = false;
    if (state.route === 'song') render({ preserveScroll: true });
  }
}

/** 给一批平台的分组统一盖上同步时间戳（全量同步共用同一个时刻）。 */
function stampPlaylistGroups(platforms, syncedAt, durationMs) {
  const at = Number(syncedAt) || Date.now();
  const ms = Number(durationMs) || 0;
  state.myPlaylists.groups = (state.myPlaylists.groups || []).map((group) =>
    platforms.includes(group.platform) ? { ...group, syncedAt: at, durationMs: ms } : group
  );
}

/**
 * 只同步一个平台。
 *
 * 后端契约：musicAllPlaylists({ platforms: ['kugou'] }) 只回这一个平台的分组。
 * 前端也只把这个平台并回去，别写成整包替换 —— 那等于又把四家重拉了一遍，
 * 正是用户抱怨的「点一次同步，全部平台都重新转」。
 *
 * 老版本 preload 会忽略参数、照旧回全部平台；这种情况我们仍然只取要的那个平台，
 * 界面行为是一致的，只是白跑了后端，不影响正确性。
 */
async function loadPlaylistsFor(platform) {
  const key = String(platform || '');
  if (!key) return null;
  if (!musicLoggedIn(key)) return null;
  if (state.myPlaylists.loadingAll) return null;
  if (playlistSyncing(key)) return null;

  const map = state.myPlaylists.syncing || (state.myPlaylists.syncing = {});
  map[key] = true;
  if (state.route === 'song') render({ preserveScroll: true });

  // 单个平台也有超时兜底，卡住时只影响它自己，别的平台的数据不动
  const guard = setTimeout(() => {
    if (!map[key]) return;
    map[key] = false;
    applyPlaylistGroup(
      key,
      { platform: key, label: musicPlatformLabel(key), ok: false, list: [], error: '读取超时了，稍后再点一次同步' },
      {}
    );
    if (state.route === 'song') render({ preserveScroll: true });
  }, 60000);

  try {
    const result = await api.musicAllPlaylists({ platforms: [key] });
    const incoming = Array.isArray(result?.groups) ? result.groups : [];
    const fresh = incoming.find((group) => group && group.platform === key) || null;
    applyPlaylistGroup(key, fresh, {
      syncedAt: Number(result?.syncedAt) || Date.now(),
      durationMs: Number(result?.durationMs) || 0,
    });
  } catch (error) {
    applyPlaylistGroup(
      key,
      { platform: key, label: musicPlatformLabel(key), ok: false, list: [], error: humanError(error) },
      {}
    );
  } finally {
    clearTimeout(guard);
    map[key] = false;
    if (state.route === 'song') render({ preserveScroll: true });
  }
  return (state.myPlaylists.groups || []).find((group) => group.platform === key) || null;
}

/**
 * 「只同步这个平台」按钮的入口：结果说清楚，失败也只在它自己身上。
 */
async function syncOnePlaylist(platform) {
  const key = String(platform || '');
  if (!key) return;
  const label = musicPlatformLabel(key);
  if (!musicLoggedIn(key)) {
    toast(`${label} 还没登录，先登录再同步`, 'info');
    openMusicAccountsModal(key);
    return;
  }
  if (state.myPlaylists.loadingAll) {
    toast('正在同步全部平台，等这一轮跑完再单独同步', 'info');
    return;
  }
  if (playlistSyncing(key)) return;

  const group = await loadPlaylistsFor(key);
  if (!group) return;
  const count = (group.list || []).length;
  if (group.ok) {
    toast(count ? `${label} 已同步，${count} 个歌单` : `${label} 已同步，这个账号下还没有歌单`, 'success');
    return;
  }
  const reason = group.error || '没读到歌单';
  toast(
    group.stale ? `${label} 这次没读到，先显示上次的结果：${reason}` : `${label} 同步失败：${reason}`,
    group.stale ? 'info' : 'error'
  );
}

/**
 * 「同步全部」：一次请求把所有已登录平台的歌单拉齐，并把结果说清楚。
 *
 * 左栏顶部的「同步全部」走这一条；各平台行里的刷新按钮走 syncOnePlaylist。
 * 两条路各管各的范围，界面上也各自标「同步中」。
 */
async function syncAllPlaylists() {
  const logged = ['netease', 'qq', 'kugou'].filter(musicLoggedIn);
  if (!logged.length) {
    toast('还没有登录音乐账号，先登录一个再同步', 'info');
    openMusicAccountsModal();
    return;
  }
  if (state.myPlaylists.loadingAll) return;
  await loadAllPlaylists(true);
  const groups = state.myPlaylists.groups || [];
  const failed = groups.filter((group) => !group.ok);
  if (!failed.length) {
    toast(`已同步 ${groups.length} 个平台的歌单`, 'success');
    return;
  }
  // 失败要指名道姓：只说「同步失败」用户不知道是哪个平台出了问题
  const names = failed.map((group) => group.label || musicPlatformLabel(group.platform)).join('、');
  toast(
    failed.length === groups.length
      ? `同步失败：${names} 都没读到`
      : `${groups.length - failed.length} 个平台已同步，${names} 没读到`,
    failed.length === groups.length ? 'error' : 'info'
  );
}

/**
 * 渲染期间确保所有平台的歌单已经有着落。
 */
function ensureAllPlaylistsLoaded() {
  const logged = ['netease', 'qq', 'kugou'].filter(musicLoggedIn);
  if (!logged.length) return;
  if (state.myPlaylists.loadingAll) return;
  // 正在单独同步某个平台时别再插一次全量请求，两边同时写 groups 只会互相盖
  if (Object.values(state.myPlaylists.syncing || {}).some(Boolean)) return;
  if (state.myPlaylists.groups?.length) return;
  loadAllPlaylists();
}

/**
 * 切账号 / 退出登录后，已有的歌单缓存就过期了，清掉重新拉。
 */
function invalidateAllPlaylists() {
  state.myPlaylists.groups = [];
  state.myPlaylists.loadingAll = false;
  // 各平台的同步开关也要一起复位，否则退登录后那行会一直停在「同步中」
  state.myPlaylists.syncing = { netease: false, qq: false, kugou: false, kuwo: false };
  /*
   * 歌单详情缓存一并清掉：登录状态一变（换号 / 退登录），
   * 缓存里的曲目就是上一个账号的视图了，不能再用。
   */
  state.myPlaylists.detailCache = {};
  state.myPlaylists.detailRefreshing = {};
}

/* ── 我的歌单：本地缓存（冷启动先画上次的结果，再悄悄补新的） ───────── */

/*
 * 缓存落在主进程的 userData/playlists-cache.json（见 electron/main.js 的 playlistCache）。
 * 这里只管三件事：读回来灌进 state、同步完写回去、账号对不上就丢掉。
 *
 * 三条约定：
 *  1. 已登录平台照常灌回；未登录平台只灌「链接导入」的歌单（带 imported 标记），
 *     账号同步的私有歌单没登录就不该出现。
 *  2. 缓存里的账号标识和当前登录账号不一致 = 换过号，这一组作废（顺手把盘上那份删掉）。
 *  3. 缓存超过 TTL 就先给用户看旧数据，再后台静默补一次新的，不转圈、不禁用按钮。
 */
const PLAYLIST_CACHE_TTL = 30 * 60 * 1000;
const PLAYLIST_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

/** 当前登录账号的标识；拿不到就返回空串（网易云走本地 API，没有 uin/userid）。 */
function musicAccountKey(platform) {
  if (!musicLoggedIn(platform)) return '';
  const info = state.musicLogin?.[platform] || {};
  return String(info.uin || info.userid || '');
}

let playlistsHydrating = false;

/** 把磁盘缓存灌回内存。返回是否真的灌到了东西。 */
async function hydratePlaylistsFromCache() {
  if (playlistsHydrating) return false;
  if (typeof api.musicPlaylistsCache !== 'function') return false;
  playlistsHydrating = true;
  try {
    const cache = await api.musicPlaylistsCache();
    const savedAt = Number(cache?.savedAt) || 0;
    if (!savedAt) return false;
    // 太旧的缓存不如不显示：卡片墙上挂着「上次同步 40 天前」只会让用户更困惑
    if (Date.now() - savedAt > PLAYLIST_CACHE_MAX_AGE) {
      api.musicDropPlaylistsCache({}).catch(() => {});
      return false;
    }
    const drop = [];
    let filled = 0;
    // 酷我也参与恢复：链接导入的酷我歌单不依赖登录，重启后还得能画回来
    // （账号同步的酷我分组在展示层被 extra 过滤，这里只管数据）
    for (const key of ['netease', 'qq', 'kugou', 'kuwo']) {
      const cached = cache.groups?.[key];
      if (!cached || !Array.isArray(cached.list) || !cached.list.length) continue;
      /*
       * 未登录的平台只捞回「链接导入」的歌单（带 imported 标记）：
       * 账号同步出来的歌单是账号私有的，没登录就不该出现；
       * 而酷狗链接导入的歌单不依赖登录，重启后也得能画回来。
       */
      const list = musicLoggedIn(key) ? cached.list : cached.list.filter((item) => item && item.imported);
      if (!list.length) continue;
      const cachedAccount = String(cache.accounts?.[key] || '');
      const nowAccount = musicAccountKey(key);
      // 两边都有值还不同 = 换过号，这份歌单不是这个人的
      if (cachedAccount && nowAccount && cachedAccount !== nowAccount) {
        drop.push(key);
        continue;
      }
      // 已经有在线数据（比如刚手动同步过）就别拿旧的盖掉
      const exists = (state.myPlaylists.groups || []).some(
        (group) => group.platform === key && (group.list || []).length
      );
      if (exists) continue;
      /*
       * 酷狗的账号同步本来就被官方关了，缓存里挂着的「登录失效 / 读取失败」
       * 全是历史同步留下的死标记，对酷狗毫无意义，恢复时直接剥掉，
       * 别让「我的歌单」一直顶着一条清不掉的红字。
       */
      const clean = key === 'kugou'
        ? { error: '', stale: false, expired: false }
        : {};
      applyPlaylistGroup(
        key,
        { ...cached, ...clean, list, platform: key, label: cached.label || musicPlatformLabel(key) },
        { syncedAt: cached.syncedAt, durationMs: cached.durationMs, skipCache: true }
      );
      filled += 1;
    }
    if (drop.length) api.musicDropPlaylistsCache({ platforms: drop }).catch(() => {});
    if (!filled) return false;
    if (state.route === 'song') render({ preserveScroll: true });
    // 缓存有点旧了：后台补一次新的，界面上不转圈
    if (Date.now() - savedAt > PLAYLIST_CACHE_TTL) refreshPlaylistsSilently();
    return true;
  } catch {
    return false;
  } finally {
    playlistsHydrating = false;
  }
}

let playlistsSaveTimer = null;

/** 把当前分组写回磁盘。合并写：只传这次真有数据的平台，空列表不写。 */
function schedulePlaylistsCacheSave(delay = 800) {
  if (typeof api.musicSavePlaylistsCache !== 'function') return;
  if (playlistsSaveTimer) clearTimeout(playlistsSaveTimer);
  playlistsSaveTimer = setTimeout(() => {
    playlistsSaveTimer = null;
    const groups = (state.myPlaylists.groups || []).filter((g) => Array.isArray(g.list) && g.list.length);
    if (!groups.length) return;
    const accounts = {};
    for (const key of ['netease', 'qq', 'kugou', 'kuwo']) accounts[key] = musicAccountKey(key);
    api.musicSavePlaylistsCache({ groups, accounts }).catch(() => {});
  }, delay);
}

/**
 * 静默补一次最新数据：不动 loadingAll，所以界面不转圈、按钮不禁用。
 * 只在「缓存已经把卡片墙画出来」之后由 hydrate 触发。
 */
async function refreshPlaylistsSilently() {
  if (state.myPlaylists.bgRefreshing) return;
  if (state.myPlaylists.loadingAll) return;
  if (Object.values(state.myPlaylists.syncing || {}).some(Boolean)) return;
  if (!['netease', 'qq', 'kugou'].some(musicLoggedIn)) return;
  if (typeof api.musicAllPlaylists !== 'function') return;
  state.myPlaylists.bgRefreshing = true;
  try {
    const result = await api.musicAllPlaylists();
    const groups = Array.isArray(result?.groups) ? result.groups : [];
    const syncedAt = Number(result?.syncedAt) || Date.now();
    const durationMs = Number(result?.durationMs) || 0;
    for (const group of groups) {
      if (!group || !group.platform) continue;
      applyPlaylistGroup(group.platform, group, { syncedAt, durationMs });
    }
    state.myPlaylists.syncedAt = syncedAt;
    state.myPlaylists.syncDurationMs = durationMs;
    if (state.route === 'song') render({ preserveScroll: true });
  } catch {
    // 静默刷新失败就算了：卡片墙上还留着旧数据，用户点「同步」会看到真正的报错
  } finally {
    state.myPlaylists.bgRefreshing = false;
  }
}

/** 歌单详情缓存的 TTL：10 分钟内来回点同一张歌单不重新拉取。 */
const PLAYLIST_DETAIL_TTL = 10 * 60 * 1000;

function playlistDetailCacheKey(platform, playlistId) {
  return `${platform}:${playlistId}`;
}

/**
 * 从分组（我的歌单）和广场里找出这张歌单登记的曲目数。
 * 只用来给「正在读取曲目」的占位提示估个规模，找不到就返回 0。
 */
function findPlaylistCount(platform, playlistId) {
  for (const group of state.myPlaylists.groups || []) {
    if (group.platform !== platform) continue;
    const hit = (group.list || []).find((item) => item.id === playlistId);
    if (hit) return Number(hit.count) || 0;
  }
  const plaza = (state.myPlaylists.plaza || {})[platform];
  const hit = (plaza?.list || []).find((item) => item.id === playlistId);
  return hit ? Number(hit.count) || 0 : 0;
}

/**
 * 取歌单详情（带会话缓存）。
 *
 * 命中且未过 TTL 直接回缓存；否则现取并写回缓存。
 * openMyPlaylist / playPlaylist 共用这一条路，保证两边看到的数据一致，
 * 也避免「点开看了一遍，整张播放又重新拉一遍」的重复等待。
 */
async function fetchPlaylistDetail(platform, playlistId) {
  const key = playlistDetailCacheKey(platform, playlistId);
  const cached = state.myPlaylists.detailCache[key];
  if (cached && Date.now() - cached.at < PLAYLIST_DETAIL_TTL) {
    return { ok: true, detail: cached.detail };
  }
  const result = await api.musicPlaylistSongs({ platform, playlistId });
  if (result?.ok && result.detail) {
    // platform 放在展开之后，保证分区高亮一定认得出来是哪个平台的歌单
    const detail = { ...result.detail, id: playlistId, platform };
    state.myPlaylists.detailCache[key] = { detail, at: Date.now() };
    result.detail = detail;
  }
  return result;
}

/** 缓存过期后只补数据不抢界面：先显示旧的，取到了再悄悄换上。 */
async function refreshPlaylistDetailSilently(platform, playlistId) {
  const key = playlistDetailCacheKey(platform, playlistId);
  if (state.myPlaylists.detailRefreshing[key]) return;
  state.myPlaylists.detailRefreshing[key] = true;
  try {
    const result = await api.musicPlaylistSongs({ platform, playlistId });
    if (result?.ok && result.detail) {
      const detail = { ...result.detail, id: playlistId, platform };
      state.myPlaylists.detailCache[key] = { detail, at: Date.now() };
      // 用户还停在这张歌单的详情页上时才换内容，别把别处正在看的给顶掉
      const current = state.myPlaylists.detail;
      if (current && current.id === playlistId && current.platform === platform) {
        state.myPlaylists.detail = detail;
        if (state.route === 'song') render({ preserveScroll: true });
      }
    }
  } catch {
    // 静默刷新失败就算了：界面还留着旧数据，重新点一次会走真正的报错
  } finally {
    delete state.myPlaylists.detailRefreshing[key];
  }
}

/** 打开某个自建歌单的曲目。 */
async function openMyPlaylist(platform, playlistId) {
  if (!platform || !playlistId) return;
  const key = playlistDetailCacheKey(platform, playlistId);
  const cached = state.myPlaylists.detailCache[key];
  if (cached) {
    // 命中缓存：无论新旧先把上次的详情摆出来，不转圈、不白屏。
    state.myPlaylists.detail = cached.detail;
    state.myPlaylists.error = '';
    render({ preserveScroll: true });
    // 过了 TTL 的后台悄悄补一次新的；没过期就直接用
    if (Date.now() - cached.at >= PLAYLIST_DETAIL_TTL) {
      refreshPlaylistDetailSilently(platform, playlistId);
    }
    return;
  }
  // 首次点开：loading 态先画出来（占位带上曲目数估算），取完写进缓存
  state.myPlaylists.loading = true;
  state.myPlaylists.detail = { id: playlistId, platform, loading: true };
  render({ preserveScroll: true });
  try {
    const result = await fetchPlaylistDetail(platform, playlistId);
    if (result?.ok && result.detail) {
      state.myPlaylists.detail = result.detail;
      state.myPlaylists.error = '';
    } else {
      state.myPlaylists.detail = null;
      state.myPlaylists.error = result?.reason || '读取歌单失败';
    }
  } catch (error) {
    // 读失败必须退出钻取态：否则主区会永远停在「正在读取曲目…」上
    state.myPlaylists.detail = null;
    state.myPlaylists.error = humanError(error);
  } finally {
    state.myPlaylists.loading = false;
    if (state.route === 'song') render({ preserveScroll: true });
    /*
     * 失败要让人看见。
     * 之前这个 reason 只写进 state.myPlaylists.error，没有任何地方读它，
     * 于是「点歌单没反应」变成了完全静默的失败。
     */
    if (state.myPlaylists.error) {
      toast(state.myPlaylists.error, 'error');
    }
  }
}

/**
 * 串行把一批曲目加进点歌队列，边加边报进度。
 *
 * 曲源是逐首解析的（每首都可能要走一次网易云同名曲兜底），
 * 八百首的歌单跑下来要几分钟。不报数的话，界面停在那儿跟卡死没区别，
 * 所以这里每 20 首喊一次进度，并且先告诉用户总共多少首。
 */
async function addSongsToQueue(songs, options = {}) {
  const list = Array.isArray(songs) ? songs.filter(Boolean) : [];
  if (!list.length) return 0;
  const platform = options.platform || '';
  const label = options.label || '加入点歌队列';
  // 来源标记跟着整批走：整张导入的歌单标 playlist + 歌单名，队列页按它分段
  const origin = options.origin || '';
  const from = options.from || '';
  if (list.length > 1) {
    toast(`正在${label}：共 ${list.length} 首，逐首解析需要一点时间…`, 'info');
  }
  let added = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (await addChartSongToQueue(list[i], { silent: true, platform: platform || list[i].platform || '', origin, from })) added += 1;
    const done = i + 1;
    // 最后一条不用报，紧接着就是总结的 toast
    if (done % 20 === 0 && done < list.length) {
      toast(`正在${label}… ${done}/${list.length}（已可播 ${added} 首）`, 'info');
    }
  }
  return added;
}

/**
 * 整张歌单直接开播：读取曲目 → 装进点歌队列（替换当前队列）→ 从第 1 首开始播放。
 * 这是「我的歌单点击播放」的核心：歌单卡片上的播放按钮直接走这里，
 * 不用先展开再一首首「加入点歌队列」。
 */
async function playPlaylist(platform, playlistId) {
  if (!platform || !playlistId) return;
  toast('正在准备歌单…', 'info');
  try {
    // 和「点开详情」共用同一条缓存路：刚看过的歌单直接开播，不再重拉一遍
    const result = await fetchPlaylistDetail(platform, playlistId);
    const songs = result?.detail?.songs || [];
    if (!result?.ok || !songs.length) {
      toast('这个歌单里没有可播放的曲目', 'info');
      return;
    }
    // 先清空队列再逐首解析可播版本，避免和上一首歌单的残留混在一起
    state.songs = [];
    // 整张歌单全都要：不再截 200 首，progress 由 addSongsToQueue 报
    const added = await addSongsToQueue(songs, { platform, label: '解析歌单', origin: 'playlist', from: result?.detail?.name || '歌单' });
    if (!added) {
      toast('这些曲目暂时都找不到可播放版本', 'info');
      return;
    }
    state.songIndex = 0;
    state.songTab = 'queue';
    // 开播后退出歌单钻取态：否则下次点左栏「我的歌单」还会停在这张歌单上，回不到卡片墙
    state.myPlaylists.detail = null;
    await playSongAt(0, { preserveScroll: true });
    toast(`正在播放歌单 · 已载入 ${added} 首`, 'success');
  } catch (error) {
    toast(humanError(error), 'error');
  }
}

/** 两首歌是不是同一首：先认 neteaseId，认不出来再退回「歌名 + 歌手有交集」。 */
function sameSongKey(a, b) {
  if (!a || !b) return false;
  const idA = a.neteaseId ? String(a.neteaseId) : '';
  const idB = b.neteaseId ? String(b.neteaseId) : '';
  if (idA && idB && idA === idB) return true;
  const nameA = songCoreName(a.title);
  if (!nameA || nameA !== songCoreName(b.title)) return false;
  const artA = artistNameList(a.artist);
  const artB = artistNameList(b.artist);
  if (!artA.length || !artB.length) return true;
  return artA.some((name) => artB.includes(name));
}

/**
 * 队列的「已有哪些歌」索引：一趟建好，之后每首 O(1) 查。
 * 几百首的歌单要是每首都去扫一遍队列（还带正则归一化），主线程会直接卡住。
 */
function buildQueuedKeySet() {
  const set = new Set();
  for (const entry of state.songs) rememberQueuedKey(set, entry);
  return set;
}

function rememberQueuedKey(set, song) {
  if (!set || !song) return;
  if (song.neteaseId) set.add(`id:${song.neteaseId}`);
  const name = songCoreName(song.title);
  if (!name) return;
  set.add(`n:${name}`);
  for (const artist of artistNameList(song.artist)) set.add(`na:${name}|${artist}`);
}

function songAlreadyQueued(set, song) {
  if (!set || !song) return false;
  if (song.neteaseId && set.has(`id:${song.neteaseId}`)) return true;
  const name = songCoreName(song.title);
  if (!name) return false;
  const artists = artistNameList(song.artist);
  if (!artists.length) return set.has(`n:${name}`);
  return artists.some((artist) => set.has(`na:${name}|${artist}`));
}

/**
 * 歌单续播任务：一次只留一个，新点一首会把旧的顶掉。
 * 播放到队列末尾、而它还在往后排歌时，要用它挡住「歌单已经播放完毕」。
 */
let playlistFill = null;
let playlistFillToken = 0;

/**
 * 把歌单剩下的曲目在后台一首首插进队列（插在 cursor 这个位置，保持顺序）。
 * token 变了就立刻收手 —— 用户已经点了别的歌，这条续播作废。
 */
async function fillPlaylistQueueFrom({ songs, start, platform, fromName, cursor, token }) {
  let at = cursor;
  const total = Math.max(0, songs.length - start);
  const seen = buildQueuedKeySet();
  for (let i = start; i < songs.length; i += 1) {
    if (token !== playlistFillToken) return;
    const song = songs[i];
    if (!song) continue;
    // 队列里已经有同一首就别排第二遍：宁可少一首重复，也不要一首歌播两次
    if (songAlreadyQueued(seen, song)) continue;
    const ok = await addChartSongToQueue(song, {
      silent: true,
      platform: platform || song.platform || '',
      origin: 'playlist',
      from: fromName,
      insertAt: at,
    });
    if (ok) {
      at += 1;
      rememberQueuedKey(seen, song);
    }
    const done = i - start + 1;
    if (done % 20 === 0 && done < total) {
      toast(`正在按歌单顺序排后面… ${done}/${total}`, 'info');
    }
  }
}

/** 等续播任务把下一首补上来（最多等 ms 毫秒）。队列变长了就返回真。 */
async function waitForMoreSongs(ms) {
  const before = state.songs.length;
  const deadline = Date.now() + ms;
  while (playlistFill && Date.now() < deadline) {
    if (state.songs.length > before) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return state.songs.length > before;
}

/**
 * 这张歌单在队列里的那一段（连续块）的起止；没有就是 `{ start: -1, end: -1 }`。
 *
 * 队列里每首歌都带 origin / from：整张歌单排进来的那批 `origin='playlist'`
 * 且 `from` 是歌单名，单点或本地的是 `origin='pick'`。所以「同一张歌单的曲目
 * 是否已经排过」用这两个字段就能认出来，不必靠歌名去猜。
 */
function playlistBlockRange(fromName) {
  const name = fromName || '歌单';
  let start = -1;
  let end = -1;
  for (let i = 0; i < state.songs.length; i += 1) {
    const entry = state.songs[i];
    const mine = Boolean(entry) && entry.origin === 'playlist' && (entry.from || '歌单') === name;
    if (mine) {
      if (start < 0) start = i;
      end = i + 1;
    } else if (start >= 0) {
      break;
    }
  }
  return { start, end };
}

/**
 * 同一张歌单的曲目在队列里是连着的一段。从 after 往后跳过这一段，
 * 返回新曲目该插的位置 —— 再点同一张歌单里的另一首时，
 * 新的一批要排在已经排好的那批后面，不能插到前面把顺序顶乱。
 */
function playlistBlockEnd(after, fromName) {
  let at = Math.max(0, Math.min(Number(after) || 0, state.songs.length));
  while (at < state.songs.length) {
    const entry = state.songs[at];
    if (!entry || entry.origin !== 'playlist' || (entry.from || '歌单') !== fromName) break;
    at += 1;
  }
  return at;
}

/**
 * 歌单里点某一首：这一首立刻开播，后面按歌单顺序接着往下放。
 *
 * 以前点一行只是「加入队列」，不出声，用户还得跑去队列页再点一次，
 * 这就是「点了不给放」最直接的体感问题。现在：
 *   1. 先把这一首解析出来插进队列并切过去播（点下去一两秒就出声）；
 *   2. 后面的曲目在后台一首首紧跟着插进来 ——
 *      几百首的歌单不用先全部解析完才播第一首。
 *
 * 不动队列里已有的歌：点歌队列是主播的活儿，点一首歌不该把观众点的都清掉。
 */
async function playPlaylistFromIndex(platform, playlistId, index) {
  if (!platform || !playlistId) return;
  const cached = state.myPlaylists.detail;
  let detail =
    cached && cached.platform === platform && cached.id === playlistId && !cached.loading && (cached.songs || []).length
      ? cached
      : null;
  if (!detail) {
    try {
      const result = await fetchPlaylistDetail(platform, playlistId);
      if (!result?.ok || !result.detail?.songs?.length) {
        toast('这个歌单里没有可播放的曲目', 'info');
        return;
      }
      detail = result.detail;
    } catch (error) {
      toast(humanError(error), 'error');
      return;
    }
  }
  const songs = detail.songs || [];
  const start = Math.max(0, Math.min(Number(index) || 0, songs.length - 1));
  const song = songs[start];
  if (!song) return;
  const fromName = detail.name || '歌单';

  // 上一次的续播先作废并等它收手：否则两批歌会插到同一个位置上
  playlistFillToken += 1;
  const token = playlistFillToken;
  if (playlistFill) await playlistFill.promise.catch(() => {});

  /*
   * 先在「这张歌单自己那一段」里找这首歌。
   *
   * 以前是扫整个队列做模糊匹配（歌名+歌手），结果同一首歌如果早先被别的歌单
   * 解析过一次（比如先用网易云歌单播过），就会命中旧队列里那一条 ——
   * 播放位置和后面的续播顺序全落回旧队列，听起来就是
   * 「点酷狗歌单的歌，下一首又跳回网易云的」。
   * 所以匹配范围只限这张歌单那一段。
   */
  const block = playlistBlockRange(fromName);
  let target = -1;
  for (let i = block.start; i >= 0 && i < block.end; i += 1) {
    if (sameSongKey(song, state.songs[i])) {
      target = i;
      break;
    }
  }
  if (target < 0) {
    /*
     * 段里没有就**插进队列**，不是甩到队尾。
     * 已经有这一段（连续点同一张歌单）就接在段末，保持一段连着；
     * 还没有就插在「当前正在播的这首之后」—— 用户点了这张歌单的歌，
     * 下一首理应是这张歌单的下一首，而不是队列里之前剩下的歌。
     * 前面已经排好的（观众点的歌）一首都不动，只是被排到这轮歌单后面。
     */
    const insertAt =
      block.start >= 0
        ? block.end
        : Math.min(state.songs.length, (Number(state.songIndex) || 0) + 1);
    const ok = await addChartSongToQueue(song, {
      silent: true,
      platform: platform || song.platform || '',
      origin: 'playlist',
      from: fromName,
      insertAt,
    });
    if (!ok) {
      toast(`「${song.title || '这首'}」暂时找不到可播放版本`, 'info');
      return;
    }
    target = insertAt;
  }
  state.songIndex = target;
  // 随机模式下「接着往下放」会变成随便挑一首；点歌单里的歌就是要按顺序听
  if (state.playMode === 'shuffle') setPlayMode('order');
  await playSongAt(target, { preserveScroll: true });
  const rest = songs.length - start - 1;
  toast(
    rest > 0 ? `正在播放：${song.title} · 后面 ${rest} 首按歌单顺序接着放` : `正在播放：${song.title}`,
    'success'
  );

  if (!rest) return;
  const promise = fillPlaylistQueueFrom({
    songs,
    start: start + 1,
    platform,
    fromName,
    // 排在这张歌单已有那段之后：连续点几首时，后点的歌接在后面而不是插到前面
    cursor: playlistBlockEnd(target + 1, fromName),
    token,
  });
  playlistFill = { token, promise };
  promise
    .catch(() => {})
    .then(() => {
      if (playlistFill && playlistFill.token === token) playlistFill = null;
    });
}

/** 读取各平台登录状态，渲染到榜单面板。 */
async function refreshNeteaseLogin() {
  try {
    const status = await api.netease.status();
    state.neteaseLogin = { loggedIn: Boolean(status?.loggedIn), apiBase: status?.apiBase || '' };
  } catch {
    state.neteaseLogin = { loggedIn: false, apiBase: '' };
  }
  return state.neteaseLogin;
}

async function refreshMusicLogin() {
  try {
    const status = await api.musicStatus();
    // 网易云也一起收进来：它的会话来自本地 API，但状态同样要参与「我的歌单」
    state.musicLogin = {
      netease: status?.netease || null,
      qq: status?.qq || null,
      kugou: status?.kugou || null,
      kuwo: status?.kuwo || null,
      loading: false,
    };
  } catch {
    state.musicLogin = { netease: null, qq: null, kugou: null, kuwo: null, loading: false };
  }
  /**
   * 登录状态一变，「我的歌单」的缓存就可能不对了：
   * 换了账号要重拉，新登录一个平台要补上这个平台。
   * 这里统一清内存里的分组，再按磁盘缓存重新摆回来（账号对不上的平台会被丢掉），
   * 剩下的平台由 ensureAllPlaylistsLoaded / 静默刷新补新。
   */
  invalidateAllPlaylists();
  /*
   * 清完立刻把上次的歌单墙摆回来：冷启动时用户点进点歌台就能看到卡片，
   * 不用干等四家平台重新拉一遍（酷狗那边常常要等到超时）。
   */
  await hydratePlaylistsFromCache();
  if (state.route === 'song') render({ preserveScroll: true });
}

/**
 * 把榜单 / 歌单里的曲目变成点歌台可播放的条目。
 *
 * 走主进程的 music:resolve：它会用网易云找同名曲，
 * 内置 API 的 unblock 会自动补上免费音源，
 * 所以 QQ / 酷狗的曲目不需要会员也能听。
 */
async function addChartSongToQueue(song, options = {}) {
  if (!song) return false;
  const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
  try {
    await api.netease.startService(apiBase).catch(() => {});
    /*
     * platform 一定要带上：解析器靠它判断能不能走原生直链。
     * 不带 platform 时只能老老实实去网易云找同名曲（会员曲目多半扑空）。
     */
    const platform = song.platform || options.platform || '';
    const result = await api.musicResolve({
      song: {
        title: song.title,
        artist: song.artist,
        cover: song.cover,
        album: song.album,
        platform,
        mid: song.mid,
        hash: song.hash,
        neteaseId: song.neteaseId,
      },
      apiBase,
      level: state.songQuality,
    });
    if (!result?.ok || !result.url) {
      if (!options.silent) {
        const why = result?.reason ? `（${result.reason}）` : '';
        toast(`「${song.title || '这首'}」暂时找不到可播放版本${why}`, 'info');
      }
      return false;
    }
    const entry = {
      title: result.title || song.title,
      artist: result.artist || song.artist,
      cover: result.cover || song.cover || '',
      album: result.album || song.album || '',
      neteaseId: result.neteaseId || song.neteaseId,
      source: result.source || platform || '',
      quality: result.level || state.songQuality,
      url: result.url,
    };
    // 换源成功时来源和点的那首不同，把原生 key 一起留着，下次还能直连
    if (result.matched) entry.matched = result.matched;
    if (song.hash) entry.hash = song.hash;
    if (song.mid) entry.mid = song.mid;
    // 队列分组标记：整张导入的歌单带歌单名，其余（单点/本地/直链）都是自选
    if (options.origin === 'playlist') {
      entry.origin = 'playlist';
      entry.from = options.from || '歌单';
    } else {
      entry.origin = 'pick';
    }
    /*
     * insertAt：歌单里点某一首时，后面的曲目必须紧挨着它排队，
     * 甩到队尾的话「接着往下放」就变成了「先放完别人的歌」。
     */
    const at = Number.isFinite(options.insertAt)
      ? Math.max(0, Math.min(Number(options.insertAt), state.songs.length))
      : state.songs.length;
    state.songs.splice(at, 0, entry);
    saveSongs();
    if (!options.silent) {
      state.songIndex = state.songs.length - 1;
      render({ preserveScroll: true });
      playCurrentSong();
      toast(`已加入：${result.title || song.title}`, 'success');
    }
    return true;
  } catch (error) {
    if (!options.silent) toast(`转换失败：${humanError(error)}`, 'error');
    return false;
  }
}

/**
 * 执行一次点歌台搜索。
 * 三平台并发，任一平台失败只记进 errors，不影响其它平台的结果。
 */
async function runSongSearch() {
  const keyword = String(state.songSearch.keyword || '').trim();
  if (!keyword) {
    toast('先输入歌名或歌手', 'info');
    return;
  }
  const platform = state.songSearch.platform || 'all';
  const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
  state.songSearch = { ...state.songSearch, keyword, platform, loading: true, done: false, list: [], errors: [] };
  if (state.songTab !== 'search') state.songTab = 'search';
  render({ preserveScroll: true });
  try {
    // 网易云那一路要求本地 API 服务在跑，先尝试拉起；失败也没关系，另外两家照样能搜
    await api.netease.startService(apiBase).catch(() => {});
    const result = await api.musicSearch({ platform, keyword, apiBase, limit: 30 });
    state.songSearch = {
      keyword,
      platform,
      loading: false,
      done: true,
      list: result?.songs || [],
      errors: result?.errors || [],
    };
  } catch (error) {
    state.songSearch = { keyword, platform, loading: false, done: true, list: [], errors: [humanError(error)] };
  }
  render({ preserveScroll: true });
}

/**
 * 观众点歌的入队方式：'next'（默认）插到当前歌曲后面当"下一首"，
 * 'now' 立即切过去播放。在点歌台的弹幕点歌卡片里切换。
 */
function liveSongMode() {
  return localStorage.getItem("vela:live-song-mode") === "now" ? "now" : "next";
}

/**
 * 从弹幕文本里解析点歌关键词。
 *
 * 观众的实际写法很杂：「点歌 晴天」「点歌：晴天」「点歌，晴天」「点播 晴天」都常见。
 * 以前只吃掉空白，冒号会被算进歌名（搜「：晴天」必然搜不到），
 * 于是一堆点歌看起来「没生效」。这里把前缀标点一起剥掉。
 */
function parseSongRequest(message) {
  const match = String(message || '').match(/^\s*(?:点歌|点播)\s*[:：,，、.。\-—]?\s*(.+)$/);
  if (!match) return '';
  return match[1]
    .replace(/^[\s:：,，、.。\-—]+/, '')
    .replace(/[\s。!！~～]+$/, '')
    .trim()
    .slice(0, 60);
}

async function handleLiveDanmaku(message, user) {
  const keyword = parseSongRequest(message);
  if (!keyword || liveRequestBusy) return;
  if (!keyword) return;
  liveRequestBusy = true;
  console.log('[点歌] 收到弹幕点歌：', keyword, 'by', user || '观众');
  try {
    const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
    await api.netease.startService(apiBase).catch(() => {});
    let song = null;
    try {
      // 主通道：网易云独占搜索（直接带可播放地址）
      song = await api.netease.searchSong({ apiBase, keyword, level: state.songQuality });
    } catch (neteaseErr) {
      // 网易云通道失败（服务没起 / 没结果 / 会员曲扑空）：退回多平台搜索 + 解析，
      // 避免弹幕点歌整条静默失败。手动点歌也是走这条多平台路，已经验证可靠。
      console.warn('[点歌] 网易云搜索失败，退回多平台：', neteaseErr && neteaseErr.message);
      try {
        const res = await api.musicSearch({ platform: 'all', keyword, apiBase, limit: 8 });
        const first = (res && res.songs && res.songs[0]) || null;
        if (first) {
          const r = await api.musicResolve({
            song: {
              title: first.title,
              artist: first.artist,
              cover: first.cover,
              album: first.album,
              platform: first.platform,
              mid: first.mid,
              hash: first.hash,
              neteaseId: first.neteaseId,
            },
            apiBase,
            level: state.songQuality,
          });
          if (r && r.ok && r.url) {
            song = {
              title: r.title || first.title,
              artist: r.artist || first.artist,
              cover: r.cover || first.cover || '',
              neteaseId: r.neteaseId || first.neteaseId,
              quality: r.level || state.songQuality,
              url: r.url,
              source: r.source || first.platform || '',
            };
          }
        }
      } catch (fallbackErr) {
        console.error('[点歌] 多平台兜底也失败：', fallbackErr && fallbackErr.message);
      }
    }
    if (!song) {
      toast(`「${keyword}」暂时找不到可播放版本`, 'info');
      return;
    }
    const mode = liveSongMode();
    if (!state.songs.length) {
      // 队列是空的：无论什么模式都直接播这首
      state.songs.push(song);
      saveSongs();
      await playSongAt(0, {});
      toast(`${user || "观众"} 点歌：${song.title}`, "success");
    } else if (mode === "now") {
      const at = Math.min(state.songIndex + 1, state.songs.length);
      state.songs.splice(at, 0, song);
      saveSongs();
      await playSongAt(at, {});
      toast(`${user || "观众"} 点歌（立即播放）：${song.title}`, "success");
    } else {
      // 下一首播放：插在当前歌曲后面，不打断正在听的
      const at = Math.min(state.songIndex + 1, state.songs.length);
      state.songs.splice(at, 0, song);
      saveSongs();
      toast(`${user || "观众"} 点歌（下一首）：${song.title}`, "success");
      if (state.route === "song") render({ preserveScroll: true });
    }
  } catch (error) {
    console.error('[点歌] 失败：', error);
    toast(`弹幕点歌失败：${error.message}`, 'error');
  } finally {
    liveRequestBusy = false;
  }
}

async function changeSongQuality(level) {
  state.songQuality = level;
  localStorage.setItem('vela:song-quality', level);
  document.querySelectorAll('#song-quality, #dock-quality').forEach((select) => {
    select.value = level;
  });
  refreshSongPops();
  const song = currentSongEntry();
  if (!song?.neteaseId) {
    toast('本地歌曲和直链没有可切换的网易云音质', 'info');
    return;
  }
  try {
    const info = await api.netease.songUrl({
      apiBase: localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100',
      id: song.neteaseId,
      level,
      title: song.title,
      artist: song.artist,
    });
    const audio = document.querySelector('#song-audio');
    const time = audio?.currentTime || 0;
    const wasPlaying = Boolean(audio && !audio.paused);
    song.url = info.url;
    song.quality = info.level;
    saveSongs();
    if (audio) {
      audio.src = info.url;
      audio.dataset.songKey = `${state.songIndex}:${info.url}`;
      audio.load();
      audio.currentTime = time;
      if (wasPlaying) audio.play().catch(() => {});
    }
    toast(`音质已切换：${info.level}${info.br ? ` · ${Math.round(info.br / 1000)} kbps` : ''}`, 'success');
  } catch (error) {
    toast(`切换音质失败：${error.message}`, 'error');
  }
}

async function ensureSongQuality(song) {
  if (!song?.neteaseId || song.quality === state.songQuality) return;
  try {
    const info = await api.netease.songUrl({
      apiBase: localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100',
      id: song.neteaseId,
      level: state.songQuality,
      title: song.title,
      artist: song.artist,
    });
    song.url = info.url;
    song.quality = info.level;
    saveSongs();
  } catch {
    /* keep the existing playable URL */
  }
}
