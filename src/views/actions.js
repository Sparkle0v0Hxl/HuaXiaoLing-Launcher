'use strict';

/*
 * actions —— 第 15 批从 app.js 搬出（原 app.js 978–3757 行，2780 行逐行原样，逻辑零改动）。
 *
 * 内容只有两个函数：
 *   · toggleFavorite(id)：切换收藏（整份游戏字段回写一遍再翻转 favorite）；
 *   · handleAction(action, id, element, event = null)：全站 data-action 的唯一分发入口，
 *     一个巨型 switch（约 2700 行 case）—— 音乐 / 歌单 / 抽卡 / 工具 / 插件 / 设置 /
 *     窗口控制 / 更新 / 截图 / 直播间都从这里进。
 *
 * 跨文件：顶层只有函数声明，零顶层常量、零立即执行副作用；case 里调用的
 * openXxxModal / xxxView / 各 api.* 都在 app.js 与 views/* 里，运行时才解析。
 */

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

async function toggleFavorite(id) {
  const game = state.games.find((g) => g.id === id);
  if (!game) return;
  await api.games.update(id, {
    name: game.name,
    subtitle: game.subtitle,
    description: game.description,
    version: game.version,
    tags: game.tags,
    target: game.target,
    args: game.args,
    workDir: game.workDir,
    cover: game.cover,
    accent: game.accent,
    favorite: !game.favorite,
  });
  toast(game.favorite ? '已取消收藏' : '已加入收藏', 'success');
}

/**
 * 释放渠道包空间，按游戏分开做。
 *
 * 两个分区各走自己的 scope，互不误删 —— 以前只有一个「释放渠道包空间」按钮、
 * scope 写死 'all'，为了省终末地的空间会把方舟那个 194 MB 的 B服包一起删掉。
 *
 * @param {'endfield'|'arknights'|'all'} scope 只删这一边、或两边一起删
 */
async function releaseChannelPacks(scope) {
  const isAll = scope === 'all';
  const isArknights = scope === 'arknights';
  const gameName = isArknights ? '明日方舟' : '终末地';
  let usage = null;
  try {
    usage = await api.endfield.packUsage();
  } catch (error) {
    toast(`读不到渠道包占用：${error.message}`, 'error');
    return;
  }
  // 两个游戏分开记体积：合并成一个「释放」按钮之后，确认框里要让用户看清各删多少
  const bytesOf = (key) =>
    (usage.builtin?.[key]?.bytes || 0) + (usage.writable?.[key]?.bytes || 0);
  const endBytes = bytesOf('endfield');
  const arkBytes = bytesOf('arknights');
  const bytes = isAll ? endBytes + arkBytes : isArknights ? arkBytes : endBytes;
  if (!bytes) {
    toast(isAll ? '本机现在没有渠道包可释放' : `本机现在没有${gameName}渠道包可释放`, 'info');
    return;
  }
  const detail = isAll
    ? `终末地 ${packBytesText(endBytes)}（官服 / B服 / 国际服 / Play / Steam 五个渠道包）、\n` +
      `明日方舟 ${packBytesText(arkBytes)}（官服与 B服 两个渠道包）。\n` +
      '之后切到哪个服都会重新问你要不要下，下过一次就一直在；\n' +
      'Steam 渠道的清单接口取不到，删了只能从 XelLauncher 导入或手动放回。'
    : isArknights
      ? '官服与 B服 两个渠道包。之后切到另一个服时会重新问你要不要下（官服约 9 MB、B服约 194 MB）；\n' +
        '国际服 / 台服 是各自独立的完整客户端，不用渠道包，不受影响。'
      : '官服 / B服 / 国际服 / Play / Steam 五个渠道包。之后切到某个服时会重新问你要不要下；\n' +
        'Steam 渠道的清单接口取不到，删了只能从 XelLauncher 导入或手动放回。';
  const ok = await confirmDialog({
    title: isAll ? '释放全部渠道包空间' : `释放${gameName}渠道包空间`,
    message: `将删除${detail}\n\n合计约 ${packBytesText(bytes)}。`,
    confirmText: '释放空间',
  });
  if (!ok) return;
  try {
    const result = await api.endfield.deletePacks({ scope });
    toast(`已释放 ${packBytesText(result.freed)}，切服时会重新问你要不要下`, 'success');
  } catch (error) {
    toast(`释放失败：${error.message}`, 'error');
  }
}

async function handleAction(action, id, element, event = null) {
  switch (action) {
    case 'music-accounts':
      openMusicAccountsModal(element.dataset.platform || '');
      break;
    case 'song-pop-toggle': {
      const id = element.dataset.pop || '';
      const wrap = element.closest('.song-pop');
      const wasOpen = wrap ? wrap.classList.contains('is-open') : false;
      closeSongPops();
      if (wrap && !wasOpen) wrap.classList.add('is-open');
      break;
    }
    case 'song-pop-pick': {
      const id = element.dataset.pop || '';
      const value = element.dataset.value || '';
      closeSongPops();
      if (id.indexOf('mode') >= 0) setPlayMode(value);
      else changeSongQuality(value);
      break;
    }
    case 'song-tab': {
      const next = element.dataset.value || 'queue';
      state.songTab = next;
      localStorage.setItem('vela:song-tab', next);
      // 离开「我的歌单」时退出钻取态：再切回来应该看到卡片墙，而不是上次那张歌单
      if (next !== 'mine') state.myPlaylists.detail = null;
      render({ preserveScroll: true });
      if (next === 'charts' && !(state.charts.list || []).length && !state.charts.loading) {
        handleAction('chart-platform', { dataset: { value: state.charts.platform || 'all' } });
      }
      if (next === 'mine') {
        // 「我的歌单」按平台分区显示所有已登录平台的歌单，不再只挑一个平台。
        // 已经有缓存就别重新拉：切走再切回还触发一次全量读取，卡顿又浪费。
        // 登录成功或手动点「同步全部」会自己重拉（见 syncPlaylistsAfterLogin / syncAllPlaylists）。
        if (!state.myPlaylists.groups?.length) {
          /*
           * 内存空有两种情况：第一次用（盘上也没缓存），或者 refreshMusicLogin 还没跑完
           * 把磁盘缓存灌进来。先问一次缓存，真没有才去拉四家平台。
           */
          hydratePlaylistsFromCache().then((filled) => {
            if (!filled) loadAllPlaylists();
          });
        }
      }
      break;
    }
    case 'music-account-login': {
      const platform = element.dataset.platform || 'qq';
      const label = platform === 'qq' ? 'QQ 音乐' : platform === 'kuwo' ? '酷我' : '酷狗';
      closeModal();
      toast(`${label} 登录窗口已打开，扫码后会自动保存`, 'info');
      try {
        const result = await api.musicLogin(platform);
        if (!result || result.cancelled) break;
        if (!result.ok) {
          toast(
            result.error ? `${label} 登录没有完成：${result.error}` : `${label} 登录没有完成`,
            result.error ? 'error' : 'info'
          );
          break;
        }
        await refreshMusicLogin();
        toast(`${label} 登录成功`, 'success');
        if (state.route === 'song') render({ preserveScroll: true });
        await syncPlaylistsAfterLogin(platform);
      } catch (error) {
        toast(`${label} 登录失败：${humanError(error)}`, 'error');
      }
      break;
    }
    case 'music-account-logout': {
      const platform = element.dataset.platform || 'qq';
      const label = platform === 'netease' ? '网易云' : platform === 'qq' ? 'QQ 音乐' : platform === 'kuwo' ? '酷我' : '酷狗';
      try {
        await api.musicLogout(platform);
        await refreshMusicLogin();
        invalidateAllPlaylists();
        toast(`已退出 ${label}`, 'success');
        if (state.route === 'song') render({ preserveScroll: true });
        // 账号弹窗还开着的话，把它刷回最新状态（否则那一行还写着「已登录」）
        refreshMusicAccountsModal();
      } catch (error) {
        toast(humanError(error), 'error');
      }
      break;
    }
    case 'netease-login':
      openMusicAccountsModal('netease');
      break;
    case 'import-playlist-link': {
      // 从别的弹窗（比如酷狗登录面板那条兜底说明）点进来时，先把那层收掉，别叠两个
      if (document.body.classList.contains('modal-open')) closeModal();
      openImportPlaylistModal();
      break;
    }
    case 'add-song-file': {
      // 从「添加歌曲」弹窗里点进来的，先把弹窗收掉，别让选文件对话框和弹窗叠在一起
      if (document.body.classList.contains('modal-open')) closeModal();
      const source = await api.pick.audio();
      if (!source) break;
      const url = await api.mediaUrl(source);
      state.songs.push({ title: source.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''), url });
      state.songIndex = state.songs.length - 1;
      saveSongs();
      render({ preserveScroll: true });
      playCurrentSong();
      break;
    }
    case 'add-song-link': {
      openAddSongLinkModal();
      break;
    }
    case 'my-playlist-open': {
      await openMyPlaylist(element.dataset.platform || '', element.dataset.id || '');
      break;
    }
    case 'my-playlist-tab': {
      state.myPlaylists.activeTab = element.dataset.value || '';
      render({ preserveScroll: true });
      break;
    }
    case 'my-playlist-play': {
      await playPlaylist(element.dataset.platform || '', element.dataset.id || '');
      break;
    }
    case 'my-playlist-close': {
      state.myPlaylists.detail = null;
      render({ preserveScroll: true });
      break;
    }
    case 'my-playlist-remove': {
      /*
       * 移除链接导入的歌单。二次确认是必须的：按钮就在封面上，
       * 鼠标划过去时和「播放」挨得很近，误点一下歌单就没了。
       */
      const removePlatform = element.dataset.platform || '';
      const removeId = element.dataset.id || '';
      if (!removePlatform || !removeId) break;
      const removeName = element.dataset.name || '这张歌单';
      const confirmed = await confirmDialog({
        title: '移除歌单',
        message: `「${removeName}」会从我的歌单里移除，本地记录也一起删掉。以后想要的话，重新粘贴一次歌单链接就能导入回来。`,
        confirmText: '移除',
        danger: true,
      });
      if (!confirmed) break;
      const removed = await removeImportedPlaylist(removePlatform, removeId);
      if (removed) toast('已从我的歌单移除', 'success');
      break;
    }
    case 'my-playlist-song': {
      // 点一行 = 点歌：这首立刻开播，后面按歌单顺序接着放（以前只入队、不出声）
      const index = Number(element.dataset.index) || 0;
      const detail = state.myPlaylists.detail;
      const song = (detail?.songs || [])[index];
      if (!song || !detail) break;
      await playPlaylistFromIndex(element.dataset.platform || detail.platform || '', detail.id, index);
      break;
    }
    case 'my-playlist-import': {
      const groupPlatform = element.dataset.platform || '';
      const songs = state.myPlaylists.detail?.songs || [];
      if (!songs.length) break;
      const added = await addSongsToQueue(songs, {
        platform: groupPlatform,
        label: '加入点歌队列',
        origin: 'playlist',
        from: state.myPlaylists.detail?.name || '歌单',
      });
      toast(
        added ? `已加入 ${added} 首（其余在网易云没有可播版本）` : '这些曲目在网易云没有可播版本',
        added ? 'success' : 'info'
      );
      break;
    }
    /* 语音包语言：多选，但至少留一种 —— 一种都不下游戏里就是哑的 */
    case 'toggle-audio-language': {
      const lang = String(element?.dataset?.value || '').toLowerCase();
      if (!lang) break;
      const on = audioLanguagesOf();
      let next;
      if (on.includes(lang)) {
        if (on.length === 1) {
          toast('至少要留一种语音包', 'info');
          break;
        }
        next = on.filter((item) => item !== lang);
      } else {
        // 按固定顺序排回去，免得数组顺序随点击变、界面上按钮跳来跳去
        next = AUDIO_LANGUAGE_LABELS.map(([key]) => key).filter((key) => key === lang || on.includes(key));
      }
      state.settings.audioLanguages = next;
      await api.updateSettings({ audioLanguages: next });
      if (state.route === 'settings') render({ preserveScroll: true });
      break;
    }
    /* 点歌台音源：内置音源开关 / 第三方音源启停与删除
     * 点击委托只把 data-action 和 data-id 解出来传进来，所以这里一律用 data-id。 */
    case 'toggle-music-source': {
      const sourceKey = String(id || '');
      const next = Object.assign({}, musicSourceFlags());
      next[sourceKey] = !next[sourceKey];
      await applySettingLocally({ musicSources: next });
      if (state.route === 'song') render({ preserveScroll: true });
      const label = (MUSIC_SOURCE_LABELS.find((item) => item[0] === sourceKey) || [sourceKey, sourceKey])[1];
      toast(next[sourceKey] ? `已启用 ${label} 音源` : `已停用 ${label} 音源`, 'success');
      break;
    }
    case 'toggle-music-custom': {
      const customId = String(id || '');
      const list = musicCustomSources().map((def) =>
        def.id === customId ? { ...def, enabled: def.enabled === false } : def
      );
      await applySettingLocally({ musicCustomSources: list });
      if (state.route === 'song') render({ preserveScroll: true });
      break;
    }
    case 'music-source-remove': {
      const removeId = String(id || '');
      const list = musicCustomSources().filter((def) => def.id !== removeId);
      await applySettingLocally({ musicCustomSources: list });
      if (state.route === 'song') render({ preserveScroll: true });
      toast('已删除这个音源', 'success');
      break;
    }
    case 'music-source-pick': {
      const picker = document.querySelector('#music-source-file');
      if (picker) picker.click();
      else toast('找不到文件选择框，刷新一下音乐页', 'error');
      break;
    }
    case 'music-source-subscribe': {
      const row = document.querySelector('#song-source-url-row');
      if (!row) break;
      row.hidden = false;
      const field = row.querySelector('#music-source-url');
      if (field) field.focus();
      break;
    }
    case 'music-source-url-go': {
      const field = document.querySelector('#music-source-url');
      const url = String(field?.value || '').trim();
      if (!url) {
        toast('先填订阅地址', 'info');
        break;
      }
      await importMusicSource({ url });
      break;
    }
    case 'toggle-auto-resume': {
      state.autoResumeSong = !state.autoResumeSong;
      try {
        localStorage.setItem('vela:auto-resume-song', state.autoResumeSong ? '1' : '0');
      } catch {
        /* 可选记忆 */
      }
      // 就地切状态：整页重绘会让滑块直接从终点出现，看不到位移过程
      paintSwitches('toggle-auto-resume', state.autoResumeSong);
      toast(
        state.autoResumeSong
          ? '已开启：打开启动器会自动继续上次的音乐'
          : '已关闭：需要手动点播放才会继续',
        'success'
      );
      break;
    }
    case 'my-playlists-reload': {
      // 老按钮走同一条路：一次请求拉全部平台，不再只刷某一个
      await syncAllPlaylists();
      break;
    }
    case 'music-sync-one': {
      // 只同步按钮所在的那一个平台，其它平台的数据一动不动
      await syncOnePlaylist(element.dataset.platform || '');
      break;
    }
    case 'music-sync-all': {
      await syncAllPlaylists();
      break;
    }
    case 'plaza-platform': {
      state.myPlaylists.plazaPlatform = element.dataset.value || 'netease';
      await ensurePlaza(state.myPlaylists.plazaPlatform);
      break;
    }
    case 'plaza-more': {
      await plazaMore(element.dataset.platform || state.myPlaylists.plazaPlatform || 'netease');
      break;
    }
    case 'plaza-retry': {
      await ensurePlaza(element.dataset.platform || state.myPlaylists.plazaPlatform || 'netease', true);
      break;
    }
    case 'chart-platform': {
      const platform = element.dataset.value || 'all';
      const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
      state.charts = { platform, loading: true, list: [], detail: null, error: '', counts: null };
      render({ preserveScroll: true });
      try {
        await api.netease.startService(apiBase).catch(() => {});
        const payload = await api.musicCharts({ platform, apiBase });
        // 合并模式返回 { charts, counts }；单平台是数组
        if (Array.isArray(payload)) {
          state.charts.list = payload;
        } else if (payload && Array.isArray(payload.charts)) {
          state.charts.list = payload.charts;
          state.charts.counts = payload.counts || null;
        } else {
          state.charts.list = [];
        }
        if (!state.charts.list.length) state.charts.error = '没有读取到榜单';
      } catch (error) {
        state.charts.error = humanError(error);
      } finally {
        state.charts.loading = false;
        if (state.route === 'song') render({ preserveScroll: true });
      }
      break;
    }
    case 'chart-open': {
      const chartId = element.dataset.id || '';
      if (!chartId) break;
      const chart = (state.charts.list || []).find((item) => item.id === chartId);
      if (!chart) break;
      const apiBase = localStorage.getItem('vela:netease-api') || 'http://127.0.0.1:3100';
      state.charts.loading = true;
      state.charts.error = '';
      render({ preserveScroll: true });
      try {
        const detail = await api.musicChartSongs({ chart, apiBase, limit: 20 });
        state.charts.detail = { id: chartId, ...detail };
      } catch (error) {
        // 不要把整片列表清空，只在弹窗里提示这一条读不到
        state.charts.error = humanError(error);
      } finally {
        state.charts.loading = false;
        if (state.route === 'song') render({ preserveScroll: true });
      }
      break;
    }
    case 'chart-to-netease': {
      const chartPlatform = state.charts.platform && state.charts.platform !== 'all' ? state.charts.platform : (state.charts.detail?.platform || element.dataset.platform || '');
      const index = Number(element.dataset.index) || 0;
      const chartSongs = state.charts.detail?.songs || [];
      const song = chartSongs[index];
      if (!song) break;
      // 点榜单里的一首 = 从这首开始，把榜单剩下的歌一起排进队列：
      // 这样播完一首会自动接下一首（原来只加被点的那一首，播完就停）。
      const rest = chartSongs.slice(index);
      const base = state.songs.length;
      let added = 0;
      for (const item of rest) {
        if (await addChartSongToQueue(item, { silent: true, platform: item.platform || chartPlatform })) added += 1;
      }
      if (added) {
        state.songIndex = base;
        render({ preserveScroll: true });
        playCurrentSong();
        toast(
          added > 1
            ? `已从「${song.title || '这首'}」开始连播 ${added} 首`
            : `已加入：${song.title || '这首'}`,
          'success'
        );
      } else {
        toast(`「${song.title || '这首'}」暂时找不到可播放版本`, 'info');
      }
      break;
    }
    case 'chart-import': {
      const songs = state.charts.detail?.songs || [];
      if (!songs.length) break;
      const added = await addSongsToQueue(songs, { label: '转成网易云曲目' });
      toast(added ? `已加入 ${added} 首（其余在网易云没有可播版本）` : '这些曲目在网易云没有可播版本', added ? 'success' : 'info');
      break;
    }
    case 'live-connect': {
      // 历史芯片自带 data-url（点击直接重连）；普通「连接」按钮读输入框
      const url = element.dataset.url || document.querySelector('#live-room-input')?.value?.trim() || '';
      if (!url) {
        toast('先粘贴直播间链接或房间号（B站 / 斗鱼 / 虎牙 / 抖音 / 快手等）', 'info');
        break;
      }
      await connectLiveRoom(url);
      break;
    }
    case 'live-disconnect':
      // 卡片上的「断开」：只关这一路（房间 id 放在 data-id 上）
      disconnectLiveRoom(id);
      break;
    case 'bili-login': {
      // B站登录窗口：登录 cookie 落在主会话里，弹幕鉴权马上能用；成功后重连即可
      const loginResult = await api.live.biliLogin().catch((error) => ({ ok: false, reason: humanError(error) }));
      if (loginResult?.ok) {
        toast('B站账号已登录，重新连接直播间即可', 'success');
      } else if (loginResult?.reason && loginResult.reason !== '窗口已关闭') {
        toast(loginResult.reason, 'info');
      }
      if (state.route === 'song') render({ preserveScroll: true });
      break;
    }
    case 'live-disconnect-all':
      disconnectBiliLive();
      break;
    case 'live-song-mode':
      localStorage.setItem('vela:live-song-mode', id === 'now' ? 'now' : 'next');
      toast(`观众点歌将${id === 'now' ? '立即切过去播放' : '排在当前歌曲后面当下一个放'}`, 'info');
      render({ preserveScroll: true });
      break;
    case 'mini-expand':
      setMiniExpanded(true);
      break;
    case 'mini-collapse':
      setMiniExpanded(false);
      break;
    case 'mini-open':
      navigate('song');
      break;
    case 'mini-toggle':
      playCurrentSong(true);
      break;
    case 'mini-mute':
    case 'song-search-run': {
      await runSongSearch();
      break;
    }
    case 'song-search-add': {
      const item = state.songSearch.list?.[Number(element.dataset.index)];
      if (!item) break;
      element.disabled = true;
      const ok = await addChartSongToQueue(item, { silent: true });
      element.disabled = false;
      toast(ok ? `已加入：${item.title}` : `「${item.title}」暂时找不到可播放版本`, ok ? 'success' : 'info');
      break;
    }
    case 'song-mute':
      toggleSongMute();
      break;
    case 'open-audio-fx':
      openAudioFxModal();
      break;
    case 'music-settings':
      openMusicSettingsModal();
      break;
    case 'plaza-scroll': {
      // 「我的歌单」底部的引导条：把歌单广场滚进视野，不用自己一路滑
      document.querySelector('.song-app-scroll .plaza-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'fx-preset': {
      const next = setAudioFxPreset(element.dataset.value || 'off');
      // 小窗口里只换胶囊的选中态，窗口不关（方便连着试几个）
      document.querySelectorAll('#fx-pop .fx-chip').forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.value === next);
      });
      const headLabel = document.querySelector('#fx-pop .fx-pop-head small');
      if (headLabel) headLabel.textContent = audioFxLabel();
      // 播放条上的音效按钮文字跟着变（弹窗开着时主界面不重绘，手动同步）
      syncAudioFxUi();
      if (state.route === 'settings') render({ preserveScroll: true });
      break;
    }
    case 'close-fx-pop':
      closeFxPop();
      break;
    case 'mini-close': {
      const audio = document.querySelector('#song-audio');
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio.dataset.songKey = '';
        updateSongChrome();
      }
      // 关掉就等于关掉总开关：不然切一趟点歌台再回来，它又会自己冒出来
      setMiniEnabled(false);
      // 总开关被关了，界面上的小播放器开关也要跟着回到关位
      paintSwitches('toggle-mini-player', false);
      toast('小播放器已关闭，可在「设置 → 声音」或音乐页重新打开', 'info');
      break;
    }
    case 'toggle-mini-player': {
      const next = !isMiniEnabled();
      setMiniEnabled(next);
      // 就地切状态：整页重绘会让滑块直接从终点出现，看不到位移过程
      paintSwitches('toggle-mini-player', next);
      toast(next ? '小播放器已打开' : '小播放器已关闭', next ? 'success' : 'info');
      break;
    }
    case 'mini-list':
      navigate('song');
      setTimeout(() => {
        document.querySelector('#song-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
      break;
    case 'dock-open-list':
      if ((state.songTab || 'queue') !== 'queue') {
        state.songTab = 'queue';
        localStorage.setItem('vela:song-tab', 'queue');
        render({ preserveScroll: true });
      }
      setTimeout(() => {
        document.querySelector('#song-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
      break;
    case 'song-select': {
      state.songIndex = Number(element.dataset.index) || 0;
      await hydrateSong(state.songs[state.songIndex]);
      await ensureSongQuality(state.songs[state.songIndex]);
      render({ preserveScroll: true });
      playCurrentSong();
      break;
    }
    /* queue-seg-toggle 已删：队列段的展开/收起砍掉了，列表平铺 */
    case 'queue-filter-clear': {
      state.queueFilter = '';
      render({ preserveScroll: true });
      break;
    }
    case 'song-play': {
      playCurrentSong(true);
      break;
    }
    case 'mini-next':
    case 'mini-prev':
    case 'song-next':
    case 'song-prev': {
      if (!state.songs.length) break;
      const forward = action === 'song-next' || action === 'mini-next';
      const options = { skipRender: state.route !== 'song' };
      if (forward && state.playMode === 'shuffle') {
        await playSongAt(randomSongIndex(), options);
        break;
      }
      const step = forward ? 1 : -1;
      const next = (state.songIndex + step + state.songs.length) % state.songs.length;
      await playSongAt(next, options);
      break;
    }
    case 'cycle-play-mode':
      cyclePlayMode();
      break;
    case 'song-remove': {
      const index = Number(element.dataset.index) || 0;
      state.songs.splice(index, 1);
      state.songIndex = Math.max(0, Math.min(state.songIndex, state.songs.length - 1));
      saveSongs();
      render({ preserveScroll: true });
      break;
    }
    case 'song-clear': {
      state.songs = [];
      state.songIndex = 0;
      saveSongs();
      render({ preserveScroll: true });
      break;
    }
    case 'start-select': {
      state.startGameId = id;
      localStorage.setItem('vela:start-game', id);
      render({ preserveScroll: false });
      loadGameNotices(id);
      break;
    }
    case 'start-selected': {
      let game = state.games.find((item) => item.id === id);
      if (!game) break;
      if (!game.installed) {
        // 渲染层的状态可能比主进程旧（比如刚切过服务器 / 盘符刚接上）：
        // 先跟主进程核对一次，别动不动就把好好的游戏当成「没装」。
        try {
          const fresh = await api.getState();
          if (fresh) {
            state.games = fresh.games || state.games;
            state.settings = fresh.settings || state.settings;
            state.stats = fresh.stats || state.stats;
            applySettings();
            updateChrome();
            render({ preserveScroll: true });
            game = state.games.find((item) => item.id === id);
          }
        } catch {
          /* 取不到就按原来的判断走 */
        }
        if (!game) break;
      }
      if (!game.installed) {
        if (game.builtin) await handleAction('detect-game', id, element);
        else openGameModal(id);
        break;
      }
      const result = await api.games.launch(id);
      if (!result.ok) toast(result.error, 'error');
      else playUiSound('launch');
      break;
    }
    case 'start-server':
      // 服务器胶囊：切换 + 直接启动（快速进游戏，和下拉里的「只切换」区分开）
      await switchServerProfile(element.dataset.game, element.dataset.server, { launch: true });
      break;
    case 'start-update-game': {
      // dock 主按钮的「更新游戏」：直接应用官方更新，完成/失败后按钮都会变回去。
      // 进度显示靠全局 onPredownloadProgress 订阅直接改按钮文字，不整页重绘。
      const game = state.games.find((item) => item.id === id);
      if (!game) break;
      if (state.gameUpdate) {
        toast('已经有更新在进行中了', 'info');
        break;
      }
      const server = (game.servers || []).find((item) => item.active) || (game.servers || [])[0];
      if (!server) break;
      const jobId = `dock-update-${game.id}-${Date.now()}`;
      state.gameUpdate = { gameId: game.id, jobId, label: '正在准备更新…' };
      render({ preserveScroll: true });
      try {
        const result =
          game.builtinKey === 'arknights'
            ? await api.endfield.updateArknightsGame()
            : await api.predownload.apply({ gameId: game.id, serverId: server.id, jobId });
        if (result && result.cancelled) toast('更新已取消', 'info');
        else if (result && result.ok === false) toast('更新没有完成，部分文件校验失败', 'error');
        else {
          const version = String(result?.tag || result?.version || '');
          toast(version ? `已更新到 ${version}，可以开始游戏了` : '更新完成，可以开始游戏了', 'success');
          if (game.builtinKey === 'neverness' && version) {
            toast(`启动器资源已更新到 ${version}；游戏本体如有新版本，打开异环启动器时会自动补`, 'info');
          }
        }
      } catch (error) {
        toast(`更新失败：${humanError(error)}`, 'error');
      } finally {
        state.gameUpdate = null;
        render({ preserveScroll: true });
      }
      break;
    }
    case 'bg-cycle':
    case 'bg-pin': {
      const game =
        state.games.find((item) => item.id === state.startGameId) ||
        state.games.find((item) => item.installed) ||
        state.games[0];
      if (!game) break;
      const cands = bgCandidatesFor(game);
      if (cands.length < 2) break;
      let notice = '';
      let noticeType = 'success';
      if (action === 'bg-pin') {
        const map = pinnedBgMap();
        const cur = currentBgPick(game);
        const willPin = map[game.id] !== cur;
        if (willPin) map[game.id] = cur;
        else delete map[game.id];
        try {
          localStorage.setItem('vela:pinned-bg', JSON.stringify(map));
        } catch {
          /* 本地存储不可用就只在本次会话生效 */
        }
        notice = willPin ? '已固定当前背景，之后就用这张' : '已取消固定，下次自动换背景';
        noticeType = willPin ? 'success' : 'info';
      } else {
        const dirSource = element && element.dataset ? element.dataset.dir : '1';
        const dir = Number(dirSource) >= 0 ? 1 : -1;
        const cur = currentBgPick(game);
        let idx = cands.indexOf(cur);
        if (idx < 0) idx = 0;
        idx = (idx + dir + cands.length) % cands.length;
        state.bgPick = state.bgPick || {};
        state.bgPick[game.id] = cands[idx];
      }
      // 从面板里操作的，重绘后保持面板打开，方便连续切换 / 取消固定
      state.bgPanelOpen = true;
      render({ preserveScroll: true });
      if (notice) toast(notice, noticeType);
      break;
    }
    case 'toggle-bg-panel': {
      // 只切 DOM、不重绘：重绘会重建 <video>，会先闪一下静态图
      const panel = document.querySelector('#start-bg-panel');
      if (!panel) break;
      const open = panel.hidden;
      panel.hidden = !open;
      state.bgPanelOpen = open;
      document.querySelector('.start-video-tools')?.classList.toggle('is-open', open);
      element?.setAttribute('aria-expanded', open ? 'true' : 'false');
      break;
    }
    case 'start-server-menu': {
      /*
       * 面板开合只切 DOM 类名，不再整页重绘：
       * 之前每展开一次就重建 .start-art，<video> 从零加载，
       * 于是先闪一下静态版本图，看起来像重新打开启动页。
       */
      const dock = document.querySelector('.start-dock');
      if (!dock) break;
      const screen = document.querySelector('.start-screen');
      const next = !dock.classList.contains('is-menu-open');
      state.startServerMenu = next;
      dock.classList.toggle('is-menu-open', next);
      screen?.classList.toggle('dock-open', next);
      dock
        .querySelector('.start-server-pick')
        ?.setAttribute('aria-expanded', next ? 'true' : 'false');
      break;
    }
    case 'start-server-pick':
      // 下拉里点服务器 = 只切换（启动交给「开始游戏」，比「切完顺手把游戏拉起来」清楚）
      await switchServerProfile(element.dataset.game, element.dataset.server, { launch: false });
      break;
    case 'start-server-setup':
      // 这个服还没装好：先问「怎么补上」，别直接把人扔进一个几十分钟的安装
      closeStartServerMenu();
      openServerSetupDialog(element.dataset.game, element.dataset.server);
      break;
    case 'start-server-guide':
      // 从管理面板进来的：关掉说明卡后回到管理面板
      openServerSwitchGuide({ returnToManager: element.dataset.game || '' });
      break;
    case 'start-server-manage':
      closeStartServerMenu();
      openStartServerManager(element.dataset.game);
      break;
    case 'export-start-video': {
      const game = state.games.find((item) => item.id === (state.startGameId || ''));
      const target = game || state.games.find((item) => item.backgroundVideo);
      if (!target) {
        toast('这个游戏还没有动态背景', 'info');
        break;
      }
      const label = element.querySelector('span');
      const originalLabel = label ? label.textContent : '';
      if (label) label.textContent = '保存中…';
      element.disabled = true;
      try {
        const result = await api.exportStartVideo(target.id);
        if (!result || result.cancelled) break;
        toast(`动图已保存（${fmtBytes(result.bytes || 0)}）`, 'success');
      } catch (error) {
        toast(humanError(error), 'error');
      } finally {
        if (label) label.textContent = originalLabel || '保存动图';
        element.disabled = false;
      }
      break;
    }
    case 'toggle-start-video': {
      const video = liveStartVideo();
      if (!video) break;
      if (video.paused) {
        // 用户主动恢复播放
        video.dataset.userPaused = '0';
        video.play().catch(() => {});
      } else {
        // 用户主动暂停：打标记，才允许被记住
        video.dataset.userPaused = '1';
        video.pause();
      }
      updateStartVideoToggle(video.paused);
      rememberStartVideoPaused(state.startGameId || '', video.paused);
      break;
    }
    case 'start-server-done':
      closeModal();
      break;
    case 'start-detect': {
      // 从启动页进来时先收起菜单：检测完页面会重绘，菜单留着会挡住新的服务器列表
      closeStartServerMenu();
      const result = await api.games.detect(element.dataset.game || undefined);
      if (result.ok) toast('检测完成，服务器路径已更新', 'success');
      else toast(result.error || '没有检测到新的客户端', 'info');
      break;
    }
    case 'start-link': {
      const gameId = element.dataset.game;
      if (!gameId) break;
      closeStartServerMenu();
      openLinkModal(gameId);
      break;
    }
    case 'back-home':
      navigate('home');
      break;
    /* 启动页唤出原生侧栏：窗口态把窗口向左外扩一块放它，扩不出去就浮在上面 */
    case 'toggle-start-nav':
      setStartNavOpen(!state.startNavOpen).catch(() => {});
      break;
    case 'close-start-nav':
      setStartNavOpen(false).catch(() => {});
      break;
    /* 主页 hero「启动页」按钮升级：直接回到该游戏的启动页 */
    case 'continue-game':
      state.startGameId = id;
      navigate('start');
      break;
    case 'minimize-window':
      await api.minimizeWindow();
      break;
    case 'window-minimize':
      await api.minimizeWindow();
      break;
    case 'window-maximize':
      // 侧栏外扩着时最大化：先把窗口收回原宽，否则还原窗口会多留一条侧栏的宽度
      if (state.startNavExpanded) await setStartNavOpen(false, { instant: true }).catch(() => {});
      await api.toggleMaximize();
      break;
    case 'window-close':
      await api.closeWindow();
      break;
    case 'scroll-library': {
      const scroll = () => {
        const section = document.querySelector('#home-library');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      if (state.route !== 'home') {
        navigate('home', { silent: true });
        window.setTimeout(scroll, 80);
      } else {
        scroll();
      }
      break;
    }
    case 'add-game':
      openGameModal();
      break;
    case 'create-desktop-shortcut': {
      try {
        const result = await api.createDesktopShortcut();
        toast(result.existed ? '桌面快捷方式已更新' : '桌面快捷方式已创建', 'success');
      } catch (error) {
        toast(`创建快捷方式失败：${error.message}`, 'error');
      }
      break;
    }
    case 'edit-game':
      openGameModal(id);
      break;
    case 'detect-game': {
      const game = state.games.find((g) => g.id === id);
      const result = await api.games.detect(id);
      if (result.ok) {
        toast(`已找到 ${game ? game.name : '游戏'} 的安装位置`, 'success');
      } else {
        toast(`${result.error || '没有自动检测到'}，可以手动选择启动程序`, 'info');
        if (game) openGameModal(id);
      }
      break;
    }
    // 启动页「下载游戏」：打开一键下载弹窗（渠道 / 目录 / 空间预估 / 进度）
    case 'download-game':
      closeStartServerMenu();
      openGameDownloadModal(id);
      break;
    // 启动页「路径选择」：复用服务器编辑弹窗，给当前（或第一个）服务器指启动程序
    case 'start-pick-path': {
      const game = state.games.find((item) => item.id === id);
      const servers = (game && game.servers) || [];
      const server = servers.find((item) => item.id === game.activeServerId) || servers[0];
      if (!game || !server) break;
      closeStartServerMenu();
      openServerModal(game.id, server.id);
      break;
    }
    case 'detect-all': {
      const result = await api.games.detect();
      if (result.ok) {
        toast(`检测完成，${result.updated.length} 个游戏已就绪`, 'success');
      } else {
        toast(result.error, 'info');
      }
      break;
    }
    case 'sync-official': {
      toast('正在从官网同步版本与封面…', 'info');
      const results = await api.games.syncOfficial();
      const ok = results.filter((item) => item.ok);
      if (ok.length) {
        const versions = ok
          .filter((item) => item.version || item.versionName)
          .map((item) => `${item.name} ${item.version || item.versionName}`)
          .join(' · ');
        toast(`官网同步完成${versions ? `：${versions}` : ''}`, 'success');
      } else {
        toast('暂时没有获取到新的版本信息，请检查网络后重试', 'error');
      }
      break;
    }
    case 'gacha-source': {
      const source = element.dataset.value;
      if (source === 'endfield') {
        state.gachaGameKey = 'endfield';
        openGachaSyncModal();
      } else if (source && source !== 'all') {
        // 从具体游戏的「+」芯片进来，直接预选该游戏，导入教程立即可见
        state.gachaGameKey = source;
        openGachaImportModal(source);
      } else {
        openGachaImportModal();
      }
      break;
    }
    case 'sync-gacha':
      openGachaSyncModal();
      break;
    case 'import-gacha':
      openGachaImportModal();
      break;
    case 'nte-folder': {
      try {
        const dir = await api.gacha.nteFolder();
        toast(`导出目录：${dir}`, 'info');
      } catch (error) {
        toast(error.message || '打不开导出目录', 'error');
      }
      break;
    }
    case 'nte-refresh': {
      try {
        const result = await api.gacha.nteRefresh();
        if (result?.account) {
          state.nteAccount = result.account;
        }
        await loadGacha(true);
        toast(result?.imported ? `已导入 ${result.imported} 条异环记录` : '已检查，没有新的导出文件', 'info');
      } catch (error) {
        toast(error.message || '检查失败', 'error');
      }
      break;
    }
    case 'nte-capture': {
      if (state.nteCapture?.running) {
        toast('正在抓取中，请先在游戏里打开抽卡记录', 'info');
        break;
      }
      try {
        state.nteCapture = { running: true, phase: 'progress', message: '正在准备抓取组件…' };
        renderNteCapture();
        const result = await api.gacha.nteCaptureStart(state.nteAutoPage !== false);
        state.nteCapture = {
          running: true,
          phase: 'capturing',
          message: state.nteAutoPage !== false
            ? '请在游戏里按 F3 打开抽卡记录，工具会自动翻页'
            : '请在游戏里按 F3 打开抽卡记录',
          jsonPath: result?.jsonPath || '',
        };
        renderNteCapture();
      } catch (error) {
        state.nteCapture = { running: false, phase: 'error', message: error.message || '抓取启动失败' };
        renderNteCapture();
        toast(error.message || '抓取启动失败', 'error');
      }
      break;
    }
    case 'nte-capture-stop': {
      try {
        const result = await api.gacha.nteCaptureStop();
        state.nteCapture = { running: false, phase: 'stopped', message: result?.message || '' };
        renderNteCapture();
        toast(result?.stopped ? '已结束抓取' : result?.message || '抓取已结束', 'info');
      } catch (error) {
        toast(error.message || '结束抓取失败', 'error');
      }
      break;
    }
    case 'nte-capture-auto-page': {
      state.nteAutoPage = !(state.nteAutoPage !== false);
      try {
        localStorage.setItem('vela:nte-auto-page', state.nteAutoPage ? '1' : '0');
      } catch {
        /* ignore */
      }
      render();
      break;
    }
    case 'refresh-gacha':
      await loadGacha(true);
      break;
    case 'refresh-gacha-meta': {
      toast('正在从官网拉取最新角色与武器图鉴…', 'info');
      try {
        await api.gacha.refreshMeta();
        await loadGacha(true);
        toast('图鉴已更新，新版本角色会自动出现在列表里', 'success');
      } catch (error) {
        toast(`图鉴更新失败：${error.message}`, 'error');
      }
      break;
    }
    case 'gacha-game':
      state.gachaGameKey = element.dataset.value;
      state.gachaUid = '';
      state.gachaScope = 'all';
      gachaEnsureSelection();
      render({ preserveScroll: true });
      break;
    case 'gacha-scope':
      state.gachaScope = element.dataset.value || 'all';
      render({ preserveScroll: true });
      break;
    case 'gacha-pool-tab': {
      // 池子卡片里的 5★/4★ 切换是纯本地显隐，不动全局状态、不重渲染
      const card = element.closest('.gacha-pool-card');
      if (card) {
        const tier = element.dataset.tier;
        card.querySelectorAll('.gacha-pool-tab').forEach((tab) => tab.classList.toggle('active', tab === element));
        card.querySelectorAll('.gacha-pool-rows').forEach((list) => list.classList.toggle('is-on', list.dataset.tier === tier));
      }
      break;
    }
    case 'choose-gacha-db': {
      const dbPath = await api.gacha.pickDatabase();
      if (dbPath) {
        state.gacha = null;
        await loadGacha(true);
      }
      break;
    }
    case 'add-server':
      openServerModal(element.dataset.game);
      break;
    case 'edit-server':
      openServerModal(element.dataset.game, element.dataset.server);
      break;
    case 'rebuild-server': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server = game && (game.servers || []).find((item) => item.id === element.dataset.server);
      if (!game || !server) break;
      if (game.builtinKey === 'endfield' && server.channel !== 'official') {
        // 终末地：只有非官服渠道才「生成」运行时（官服直接指定官服客户端即可，见下）
        await handleAction('prepare-endfield', element.dataset.server, element);
      } else {
        /*
         * 其余情况统一先问一句「怎么补上这份客户端」（硬链接 / 选路径 / 扫描）。
         * 以前这里替用户猜：有别的渠道就直接开硬链接安装，没有就开文件选择框 ——
         * 猜错的代价是白等一场安装，或者对着文件框不知道要选什么。
         */
        openServerSetupDialog(game.id, server.id);
      }
      break;
    }
    /**
     * 同一游戏里，除了自己之外，还有没有别的渠道客户端（文件真的还在）可当硬链接基础。
     *
     * 这里必须用 exists 而不是「path 字符串非空」：B服 的目录被删掉之后
     * path 还留在配置里，按老写法会以为还有个可用基础，于是官服点「重建」
     * 直接进硬链接生成 —— 用户看到的就是「我明明有官服，怎么还让我重建」。
     */
    function hasOtherInstalledServer(game, server) {
      return (game.servers || []).some(
        (item) => item.id !== server.id && item.exists && item.channel !== server.channel
      );
    }
    case 'activate-server':
      // 服务器行上的「切换」= 只换服（切完按钮会变成「启动」）。以前这里点一下
      // 游戏自己就起来了，而启动页下拉里点同一行只切换，两处手感对不上。
      await switchServerProfile(element.dataset.game, element.dataset.server, { launch: false });
      break;
    case 'prepare-endfield': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server = game && (game.servers || []).find((item) => item.id === element.dataset.server);
      // 和「切换服务器」用同一条提示：进度可见，别让人对着一条不会动的 toast 等几十秒
      const busy = beginBusyToast(`正在为 ${server ? server.name : '渠道'}生成运行时…`);
      const offProgress =
        typeof api.onEndfieldProgress === 'function'
          ? api.onEndfieldProgress((progress) => {
              if (!progress) return;
              busy.update(endfieldProgressText({ ...progress, serverName: progress.serverName || server?.name }));
            })
          : null;
      try {
        const result = await api.servers.prepareEndfield({
          gameId: element.dataset.game,
          serverId: element.dataset.server,
        });
        busy.done(
          `「${server ? server.name : '新服务器'}」运行时已就绪：链接 ${result.linked} 个文件，覆盖 ${result.overlay} 个差异文件`,
          'success'
        );
      } catch (error) {
        busy.done(humanError(error), 'error');
      } finally {
        if (offProgress) offProgress();
      }
      break;
    }
    case 'prepare-sophon':
      openSophonModal(element.dataset.game, element.dataset.server, 'prepare');
      break;
    case 'update-sophon':
      openSophonModal(element.dataset.game, element.dataset.server, 'update');
      break;
    /* ── 预下载 ───────────────────────────────────────────────── */
    case 'open-predownload': {
      const game = state.games.find((item) => item.id === id);
      const server = game && (game.servers || []).find((item) => item.id === game.activeServerId);
      if (!game || !server) {
        toast('这个游戏还没有可用的服务器', 'info');
        break;
      }
      openPredownloadModal(game.id, server.id);
      break;
    }
    case 'predownload-open':
      openPredownloadModal(element.dataset.game, element.dataset.server);
      break;
    case 'predownload-check':
      await runPredownloadCheck(element.dataset.game, element.dataset.server);
      break;
    case 'predownload-clear': {
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const game = state.games.find((item) => item.id === gameId);
      const server = game && (game.servers || []).find((item) => item.id === serverId);
      if (!game || !server) break;
      const ok = await confirmDialog({
        title: '清除预下载内容',
        message: `会删掉「${server.name}」已经下好的预下载内容（${predownloadSizeText(predownloadInfo(server)) || '预下载目录'}），游戏文件不受影响。清掉后要重新下载。`,
        confirmText: '清除',
        danger: true,
      });
      if (!ok) break;
      try {
        await predownloadApi().clear({ gameId, serverId });
        toast('预下载内容已清除', 'success');
      } catch (error) {
        toast(humanError(error), 'error');
      }
      // 清完立刻重查：不然状态停在「未查询」，用户还得再点一次才知道现在能不能下
      await runPredownloadCheck(gameId, serverId);
      repaintServerRows();
      if (pdModalRepaint) pdModalRepaint();
      break;
    }
    /*
     * 单个服务器覆盖「剧情分类资源包」。
     * 就地切开关（paintSwitch）而不是整页重绘：重绘出的按钮一出生就是终态，
     * 滑块没有起点，看着就像点了没反应。
     */
    case 'toggle-pd-story': {
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const game = state.games.find((item) => item.id === gameId);
      const server = game && (game.servers || []).find((item) => item.id === serverId);
      if (!game || !server) break;
      const override = storyOverride(server);
      const on = override === null ? state.settings.includeStoryResources === true : override;
      const next = !on;
      paintSwitch(element, next);
      try {
        await predownloadApi().setStoryResources({ gameId, serverId, enabled: next });
      } catch (error) {
        paintSwitch(element, on);
        toast(humanError(error), 'error');
        break;
      }
      // 标签和「跟随全局」按钮就地显隐，不重建开关节点
      const story = element.closest('.pd-story');
      const tag = story ? story.querySelector('.pd-story-tag') : null;
      if (tag) {
        tag.textContent = '已单独设置';
        tag.classList.add('is-over');
      }
      const reset = story ? story.querySelector('[data-action="reset-pd-story"]') : null;
      if (reset) reset.hidden = false;
      if (pdModalRepaint) pdModalRepaint();
      break;
    }
    case 'reset-pd-story': {
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      try {
        await predownloadApi().setStoryResources({ gameId, serverId, enabled: null });
        toast('已改回跟随全局设置', 'info');
      } catch (error) {
        toast(humanError(error), 'error');
        break;
      }
      // 点的是按钮不是开关，这里整块重建没问题；重建后开关落在终态，下次点仍有动画
      if (pdModalStoryRepaint) pdModalStoryRepaint();
      if (pdModalRepaint) pdModalRepaint();
      break;
    }
    /*
     * 异环官服 / B服：切到 B服之前必须弹一次确认，把流程四步原样摆出来，不默默切。
     */
    case 'nte-set-channel': {
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const channel = element.dataset.channel || 'official';
      const game = state.games.find((item) => item.id === gameId);
      const server = game && (game.servers || []).find((item) => item.id === serverId);
      if (!server) break;
      /*
       * 异环的「渠道卡片」和「服务器行的切换」是同一件事：改 Config.ini 之后还要把
       * activeServerId 指过去、路径跟着走。以前这里只调 set-channel，于是点完卡片
       * 渠道变了、当前服务器还停在原来那行，和点服务器行切换的结果不一样。
       * 现在统一交给 switchServerProfile。
       */
      const target = (game.servers || []).find((item) => item.channel === channel);
      if (target) await switchServerProfile(gameId, target.id, { launch: false });
      else await switchNteChannel(game, server, channel);
      refreshNtePanel();
      break;
    }
    case 'focus-sophon': {
      const jobId = element.dataset.id;
      const job = sophonJobs.find((item) => item.id === jobId);
      if (!job) break;
      if (job.status === 'queued') {
        toast(`「${job.serverName}」还在排队，前面的任务结束后会自动开始`, 'info');
        break;
      }
      if (job.status === 'starting' || job.status === 'running') {
        // 收起来过：原样挂回去（进度条、阶段条、监听都还在）
        if (restoreTaskModal()) break;
        // 没收起说明弹窗就在眼前；真找不到 DOM 才提示一句
        if (!document.querySelector('#sophon-progress, #dl-stages')) {
          toast('任务正在后台进行，先看任务条上的进度', 'info');
        }
        break;
      }
      // 结束态：重新打开这个界面，让用户还能回来看结果或再操作一次
      if (sophonJobs.some((item) => ['starting', 'running'].includes(item.status))) {
        toast('还有任务在跑，等它结束再打开这个界面', 'info');
        break;
      }
      // 下载任务走下载界面，硬链接 / 更新走硬链接界面，别把两种界面串了
      if (job.mode === 'download') openGameDownloadModal(job.gameId);
      else openSophonModal(job.gameId, job.serverId, job.mode);
      break;
    }
    case 'dismiss-sophon-job': {
      const jobId = element.dataset.id;
      sophonJobs = sophonJobs.filter((item) => item.id !== jobId);
      renderTaskDock();
      break;
    }
    case 'restore-sophon':
      if (!restoreTaskModal() && sophonUi) sophonUi.restore();
      break;
    case 'cancel-sophon-dock': {
      if (sophonUi) {
        sophonUi.cancel();
        break;
      }
      /*
       * 弹窗还开在前台时 sophonUi 是空的，以前点任务条上的 ✕ 完全没反应。
       * 这里兜底：直接按 jobId 取消，并把这一条收进「已停止」。
       */
      const jobId = element.dataset.id;
      const job = sophonJobs.find((item) => item.id === jobId);
      if (!job) break;
      api.servers.cancelSophon(jobId).catch(() => {});
      job.status = 'cancelled';
      pruneSophonHistory();
      renderTaskDock();
      toast('已停止任务', 'info');
      break;
    }
    case 'remove-sophon-queue': {
      const queueId = element.dataset.id;
      sophonJobs = sophonJobs.filter((job) => job.id !== queueId);
      renderTaskDock();
      toast('已移出硬链接队列', 'info');
      break;
    }
    case 'clear-server-path': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server = game && (game.servers || []).find((item) => item.id === element.dataset.server);
      if (!game || !server) break;
      /*
       * 用户点这个垃圾桶，多半是想「把 B服 删掉」。
       * 但官服和 B服 常常共用同一个安装目录 —— 他转头去资源管理器删文件夹，
       * 官服就一起没了。所以只要存在共用关系，就先把这层说破。
       */
      const shared = sharedRootWith(game, server);
      const message = shared
        ? `只会清除「${server.name}」的路径记录，不会删除任何文件，也不会移除这张服务器卡片。\n\n注意：「${shared.name}」用的是同一个安装目录（${server.root}）。如果你想彻底卸载这个渠道，删掉这个文件夹会连「${shared.name}」一起失效 —— 要删文件请先确认另一个渠道换到了别的目录。`
        : `只会清除「${server.name}」的路径记录，不会删除客户端文件，也不会移除这张服务器卡片。`;
      const ok = await confirmDialog({
        title: '清除服务器路径',
        message,
        confirmText: '清除路径',
        danger: true,
      });
      if (ok) {
        await api.servers.clearPath({
          gameId: element.dataset.game,
          serverId: element.dataset.server,
        });
        toast('路径已清除，服务器卡片保留', 'success');
      }
      break;
    }
    case 'remove-server': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server = game && (game.servers || []).find((item) => item.id === element.dataset.server);
      if (!server) break;
      const ok = await confirmDialog({
        title: '移除服务器配置',
        message: `确定要移除「${server.name}」吗？只会删除启动器中的路径记录，不会删除客户端文件。`,
        confirmText: '移除配置',
        danger: true,
      });
      if (ok) {
        await api.servers.remove({ gameId: element.dataset.game, serverId: element.dataset.server });
        toast('服务器配置已移除', 'success');
      }
      break;
    }
    case 'uninstall-server': {
      const game = state.games.find((item) => item.id === element.dataset.game);
      const server =
        game && (game.servers || []).find((item) => item.id === element.dataset.server);
      if (!game || !server) break;
      // 老版本主进程没有这两个方法：这里先拦住，别让它变成一句看不懂的英文报错
      if (typeof api.servers?.uninstall !== 'function') {
        toast('启动器本体和界面版本不一致，重启一次启动器再试', 'error');
        break;
      }
      // 游戏开着的时候文件被占着，问了也白问：先给一句能照着做的话
      if (game.running) {
        toast('游戏正在运行，先关掉游戏再卸载客户端', 'error');
        break;
      }
      /*
       * 卸载 = 真删文件，和「清除路径」是两件事，所以先问主进程能不能删：
       * 共用同一目录的（官服 / B服 常见）、盘符根目录、游戏正开着，都会被挡回来。
       */
      let plan;
      try {
        plan = await api.servers.uninstallPlan({ gameId: game.id, serverId: server.id });
      } catch (error) {
        toast(error?.message || '读不到这个服务器的安装目录', 'error');
        break;
      }
      if (!plan?.ok) {
        /*
         * 共用目录是最常见的拦路虎：官服/B服、异环官服/B服 很多时候压根就是同一个
         * 文件夹，删谁都是两边一起没。不能硬来，但也不能只丢一句「删不了」就完事 ——
         * 用户真实的诉求往往是「让这个服从列表里消失」，那就把这条路给出来。
         */
        if (plan?.shared?.length) {
          const removeOnly = await confirmDialog({
            title: '这个目录和别的服共用',
            message: `「${server.name}」和「${plan.shared.join(
              '」「'
            )}」用的是同一个文件夹：\n\n${plan.root}\n\n删掉它，这几边会一起失效，所以卸载被拦下来了。\n\n可以只把「${server.name}」从列表里去掉（客户端文件一个都不动）；想让两边都能删，得先去服务器管理里给它们各指一个独立目录。`,
            confirmText: '只移出列表',
          });
          if (removeOnly) {
            await api.servers.remove({ gameId: game.id, serverId: server.id });
            toast(`「${server.name}」已移出列表，客户端文件没有动`, 'success');
            repaintServerRows();
          }
          break;
        }
        toast(plan?.reason || '这个服务器暂时不能卸载', 'error');
        break;
      }
      if (plan.running) {
        toast('游戏还开着，先关掉游戏再卸载', 'error');
        break;
      }
      const choice = await uninstallDialog({
        title: `卸载「${server.name}」`,
        message: plan.exists
          ? `会把下面这个文件夹整个删掉，只动这一个目录，其它服务器的客户端不受影响。启动器里的「${server.name}」卡片会留着，之后可以重新下载。`
          : `「${server.name}」记录的目录已经不在了，这一步只会清掉启动器里的路径记录。`,
        root: plan.exists ? plan.root : '',
        exists: Boolean(plan.exists),
      });
      if (!choice) break;
      /*
       * 主进程现在返回结果对象而不是抛异常：失败原因分得清（占用 / 回收站不可用 /
       * 其它），文案也是中文的。选了回收站但系统不给用，再问一次要不要改成永久删除。
       */
      const runUninstall = async (force) => {
        try {
          return await api.servers.uninstall({
            gameId: game.id,
            serverId: server.id,
            force: force === true,
          });
        } catch (error) {
          return { ok: false, code: 'OTHER', reason: humanError(error) };
        }
      };
      let result = await runUninstall(choice === 'force');
      if (!result?.ok && result?.code === 'TRASH') {
        const forceIt = await confirmDialog({
          title: '回收站用不了',
          message: `系统不让把文件挪进回收站：${result.reason || ''}\n\n改成「永久删除」吗？这一步删掉就找不回来了。`,
          confirmText: '永久删除',
          danger: true,
        });
        if (!forceIt) {
          toast('已取消，文件没有动', 'info');
          break;
        }
        result = await runUninstall(true);
      }
      if (!result?.ok) {
        toast(result?.reason || '卸载没成功', 'error');
        break;
      }
      toast(
        plan.exists
          ? result.forced || choice === 'force'
            ? '客户端已永久删除'
            : '客户端已移到回收站'
          : '路径记录已清除',
        'success'
      );
      repaintServerRows();
      break;
    }
    case 'open-server-folder':
      await api.servers.openFolder({
        gameId: element.dataset.game,
        serverId: element.dataset.server,
      });
      break;
    case 'link-servers':
      openLinkModal(element.dataset.game);
      break;
    case 'toggle-fav':
      await toggleFavorite(id);
      break;
    case 'duo-game': {
      // 花火卡：直接开「最近在玩」那一场
      const target = state.games.find((item) => item.id === element.dataset.game);
      if (!target) {
        toast('还没有开场记录，先在游戏库里挑一个吧', 'info');
        navigate('home');
        break;
      }
      const started = await api.games.launch(target.id);
      if (started.ok) {
        playUiSound('launch');
        if (!target.demo) toast(`正在启动 ${target.name}`, 'info');
      } else if (started.elevationRequired) {
        toast('需要管理员权限，请到游戏卡片上用启动按钮', 'error');
      } else {
        toast(started.error, 'error');
      }
      break;
    }
    case 'duo-song':
      // 火花卡：去点歌台
      navigate('song');
      break;
    case 'duo-toggle':
      // 火花卡上的播放/暂停键：点击落在键上，不会再冒泡去开点歌台
      playCurrentSong(true);
      break;
    case 'duo-next':
    case 'duo-prev': {
      // 火花卡上的上一首/下一首：复用点歌台的切歌逻辑，但不整页重绘
      if (!state.songs.length) break;
      const forward = action === 'duo-next';
      const options = { skipRender: state.route !== 'song' };
      if (forward && state.playMode === 'shuffle') {
        await playSongAt(randomSongIndex(), options);
        break;
      }
      const step = forward ? 1 : -1;
      const next = (state.songIndex + step + state.songs.length) % state.songs.length;
      await playSongAt(next, options);
      break;
    }
    case 'launch-game': {
      const game = state.games.find((g) => g.id === id);
      const result = await api.games.launch(id);
      if (result.ok) playUiSound('launch');
      if (!result.ok) {
        if (result.elevationRequired) {
          /*
           * 终末地的 740 是官方客户端的硬限制（实测：非提权创建进程直接
           * failed to create game process 740），绕不过去。能省掉的只有「每次
           * 都问」：让启动器自己以管理员运行，提权一次、整场免问。
           * 这里只问一次，选哪边都记住（elevationAsked），别每次开都再问一遍。
           */
          const useAdmin = await confirmDialog({
            title: '以后开游戏不再每次问权限',
            message: `${result.error}\n\n点「以管理员重启」：现在弹一次 Windows 确认，启动器以管理员重开并自动把游戏打开，之后这一场都不再弹。\n点「取消」：就按现在的样子，每开一次游戏弹一次。`,
            confirmText: '以管理员重启',
          });
          await api.updateSettings({ elevationAsked: true, alwaysAdmin: useAdmin === true });
          if (useAdmin) {
            const relaunched = await api.relaunchAdmin({ launchGameId: id });
            if (!relaunched.ok) toast(relaunched.error, 'error');
          }
        } else {
          toast(result.error, 'error');
        }
      } else if (game && !game.demo) {
        toast(`正在启动 ${game.name}`, 'info');
      }
      break;
    }
    case 'stop-game': {
      const game = state.games.find((g) => g.id === id);
      const ok = await confirmDialog({
        title: '结束游戏进程',
        message: `确定要结束「${game ? game.name : '这个游戏'}」吗？未保存的进度可能会丢失。`,
        confirmText: '结束进程',
        danger: true,
      });
      if (ok) {
        const result = await api.games.stop(id);
        if (!result.ok) toast(result.error, 'error');
        else toast('已结束游戏进程', 'info');
      }
      break;
    }
    case 'delete-game': {
      const game = state.games.find((g) => g.id === id);
      if (!game) break;
      const ok = await confirmDialog({
        title: '从库中移除',
        message: `确定要移除「${game.name}」吗？这只会删除启动器中的条目，不会删除游戏文件。`,
        confirmText: '移除',
        danger: true,
      });
      if (ok) {
        const removed = await api.games.remove(id);
        if (!removed) {
          toast('这个条目已经不在游戏库里了', 'info');
          return;
        }
        state.games = state.games.filter((item) => item.id !== id);
        closeModal();
        render({ preserveScroll: true });
        toast('已从游戏库移除', 'success');
      } else if (editingId) {
        openGameModal(id);
      }
      break;
    }
    case 'clear-demo': {
      const count = state.games.filter((g) => g.demo).length;
      const ok = await confirmDialog({
        title: '清空示例条目',
        message: `将移除 ${count} 个示例条目。你添加的游戏不会受影响。`,
        confirmText: '清空示例',
        danger: true,
      });
      if (ok) {
        await api.games.clearDemo();
        toast('示例条目已清空', 'success');
      }
      break;
    }
    case 'set-filter':
      state.filter = element.dataset.value || 'all';
      render({ preserveScroll: true });
      break;
    case 'clear-search':
      state.search = '';
      render({ preserveScroll: true });
      break;
    case 'clear-filters':
      state.filter = 'all';
      state.search = '';
      state.sort = 'recent';
      render({ preserveScroll: true });
      break;
    case 'add-download':
      openDownloadModal();
      break;
    case 'pause-download':
      await api.downloads.pause(id);
      break;
    case 'pause-all-downloads':
      await Promise.all(
        state.downloads
          .filter((item) => item.status === 'downloading' || item.status === 'queued')
          .map((item) => api.downloads.pause(item.id))
      );
      toast('已暂停当前下载', 'info');
      break;
    case 'resume-all-downloads':
      await Promise.all(
        state.downloads
          .filter((item) => item.status === 'paused' || item.status === 'error')
          .map((item) => api.downloads.resume(item.id))
      );
      toast('已继续暂停的下载', 'info');
      break;
    case 'resume-download':
      await api.downloads.resume(id);
      break;
    case 'cancel-download': {
      const ok = await confirmDialog({
        title: '取消下载',
        message: '已经下载的片段会被清理，确定要取消吗？',
        confirmText: '取消下载',
        danger: true,
      });
      if (ok) await api.downloads.cancel(id);
      break;
    }
    case 'remove-download':
      await api.downloads.remove(id);
      break;
    case 'open-download':
      await api.downloads.open(id);
      break;
    case 'open-download-folder':
      if (id) await api.downloads.openFolder(id);
      else await api.openDownloadFolder();
      break;
    case 'toggle-quick':
      quickOpen = !quickOpen;
      if (!quickOpen && state.settings.quickPanelPinned) {
        await api.updateSettings({ quickPanelPinned: false });
      }
      renderQuickPanel();
      break;
    case 'toggle-quick-pin': {
      const pinned = !(state.settings.quickPanelPinned === true);
      state.settings.quickPanelPinned = pinned;
      quickOpen = pinned ? true : quickOpen;
      await api.updateSettings({ quickPanelPinned: pinned });
      renderQuickPanel();
      break;
    }
    case 'quick-launch': {
      // 快捷面板的语义是「一键进游戏」：切换 + 启动，走和别处同一条切换流程
      const gameId = element.dataset.game;
      const serverId = element.dataset.server;
      const switched = await switchServerProfile(gameId, serverId, { launch: true });
      // 用户在确认框里点了取消：面板留着，让他接着选
      if (!switched.cancelled && !state.settings.quickPanelPinned) quickOpen = false;
      renderQuickPanel();
      break;
    }
    case 'toggle-sidebar': {
      /*
       * 启动页抽屉开着的时候，侧栏底下那颗「收起侧栏」= 把抽屉收回去。
       *
       * 以前这里不分场合，直接走全局的「侧栏收成 72px 图标条」：抽屉是露出一条
       * 238px 的面板，缩成 72 之后窗口还停在展开后的宽度，左边空出一大条 —— 看着
       * 就像侧栏被搞掉了。抽屉里的收起，语义本来就该是收抽屉。
       */
      if (state.startNavOpen) {
        setStartNavOpen(false).catch(() => {});
        break;
      }
      /*
       * 启动页、抽屉关着：这颗 chevron 的含义是「展开大侧栏」。
       * 之前这里直接落到下面的全局分支，变成把小侧栏再收一格 ——
       * 大侧栏永远出不来。启动页没有「收成 72px 图标条」这个语义，
       * 开关都归抽屉管。
       */
      if (state.route === 'start') {
        setStartNavOpen(true).catch(() => {});
        break;
      }
      const collapsed = !(state.settings.sidebarCollapsed === true);
      state.settings.sidebarCollapsed = collapsed;
      applySettings();
      updateChrome();
      repositionDockedMini();
      await api.updateSettings({ sidebarCollapsed: collapsed });
      break;
    }
    case 'open-data-folder':
      await api.openDataFolder();
      break;
    /*
     * 「查看日志 / 打开文件」这两个按钮以前完全没有处理分支——
     * markup 里写了 data-action，switch 里没有 case，点下去一点反应都没有，
     * 而设置项文案还写着「把这里的日志发回来就能定位」，等于承诺了一个不存在的功能。
     * 主进程侧 app:open-update-log / app:read-update-log 早就写好了，缺的只是这一层接线。
     */
    case 'open-update-log':
      await api.openUpdateLog();
      break;
    case 'view-update-log': {
      let payload = null;
      try {
        payload = await api.readUpdateLog();
      } catch (error) {
        toast(`读取更新日志失败：${humanError(error)}`, 'error');
        break;
      }
      const sections = [
        ['update-log.txt', payload?.log],
        ['self-heal.log', payload?.selfHeal],
        ['update-error.json', payload?.error],
      ].filter(([, text]) => String(text || '').trim());
      const logBody = sections.length
        ? sections
            .map(
              ([name, text]) =>
                `<section class="ulog-block"><h3>${esc(name)}</h3><pre class="ulog-pre">${esc(String(text).trim())}</pre></section>`
            )
            .join('')
        : '<p class="ulog-empty">还没有日志。只有真正跑过一次自更新（检查到新版本并覆盖过程序文件）才会有内容。</p>';
      openModal(`
        <div class="modal-backdrop" data-backdrop>
          <div class="modal ulog-modal" role="dialog" aria-modal="true">
            <div class="modal-head">
              <div>
                <h2>更新日志</h2>
                <p class="ulog-path" title="${esc(payload?.dir || '')}">${esc(payload?.dir || '')}</p>
              </div>
              <button class="modal-close" data-close title="关闭">${icon('x')}</button>
            </div>
            <div class="modal-body ulog-body">${logBody}</div>
            <div class="modal-foot">
              <button class="btn btn-ghost" data-action="open-update-log">${icon('folder')}打开所在文件夹</button>
              <button class="btn btn-primary" data-close>关闭</button>
            </div>
          </div>
        </div>`);
      break;
    }
    case 'check-update': {
      try {
        toast('正在检查更新…', 'info');
        const result = await api.checkUpdate();
        if (result && result.hasUpdate) {
          openUpdateModal(result);
        } else if (result && result.ok) {
          toast('已经是最新版本', 'success');
        } else {
          toast(result && result.error ? `检查失败：${result.error}` : '检查失败', 'error');
        }
      } catch (error) {
        toast(`检查失败：${humanError(error)}`, 'error');
      }
      break;
    }
    case 'apply-update': {
      const info = state.update || {};
      const ok = await confirmDialog({
        title: `更新到 v${info.latest || ''}`,
        message: '会关闭启动器、用更新包覆盖程序文件，然后自动重新打开。\n\n游戏、账号、抽卡记录、歌单和设置都在数据目录里，不会被覆盖。',
        confirmText: '开始更新',
      });
      if (!ok) break;
      try {
        toast('开始下载更新包…', 'info');
        const result = await api.applyUpdate();
        if (result && result.ok) {
          closeModal();
          toast('正在覆盖更新，启动器即将重新打开…', 'success');
        } else if (result && result.message) {
          toast(result.message, 'info');
        }
      } catch (error) {
        toast(`更新失败：${humanError(error)}`, 'error');
      }
      break;
    }
    case 'save-update-source': {
      const input = document.querySelector('#update-manifest');
      const value = (input ? input.value : '').trim();
      await api.updateSettings({ updateManifest: value });
      toast(value ? '更新源已保存，正在检查…' : '已改回内置的官方源', 'success');
      if (value) {
        try {
          const result = await api.checkUpdate();
          if (result && result.hasUpdate) openUpdateModal(result);
        } catch (error) {
          toast(`检查失败：${humanError(error)}`, 'error');
        }
      } else {
        try {
          const result = await api.checkUpdate();
          if (result && result.hasUpdate) openUpdateModal(result);
        } catch {
          /* 内置源读不到时不打扰用户 */
        }
      }
      state.settings.updateManifest = value;
      render();
      break;
    }
    case 'fill-mirror-source': {
      const input = document.querySelector('#update-manifest');
      if (input) input.value = GITEE_MANIFEST_URL;
      await api.updateSettings({ updateManifest: GITEE_MANIFEST_URL });
      toast('已换成国内镜像源，正在检查…', 'success');
      try {
        const result = await api.checkUpdate();
        if (result && result.hasUpdate) openUpdateModal(result);
        else if (result && result.ok) toast('已经是最新版本', 'success');
        else toast((result && result.error) || '检查失败', 'error');
      } catch (error) {
        toast(`检查失败：${humanError(error)}`, 'error');
      }
      render();
      break;
    }
    case 'rollback-update': {
      const backup = state.update && state.update.backup;
      const target = backup && backup.version ? `v${backup.version}` : '上一个版本';
      const ok = await confirmDialog({
        title: '回到上一个版本',
        message: `会把程序文件还原到升级前的 ${target}，游戏、账号、抽卡记录和设置都不受影响。还原完成后自动重启。`,
        confirmText: '还原并重启',
      });
      if (!ok) break;
      try {
        const result = await api.rollbackUpdate();
        if (result && result.ok) toast('正在还原并重启…', 'success');
        else toast((result && result.message) || '没有找到可回滚的备份', 'error');
      } catch (error) {
        toast(`回滚失败：${humanError(error)}`, 'error');
      }
      break;
    }
    case 'open-changelog': {
      navigate('news');
      break;
    }
    case 'pick-update-source': {
      try {
        const result = await api.pickUpdateSource();
        if (!result || result.cancelled) break;
        const status = result.status || {};
        toast(status.hasUpdate ? `发现新版本 v${status.latest}` : '更新源已设置', 'success');
        if (status.hasUpdate) openUpdateModal(status);
        render();
      } catch (error) {
        toast(`选择失败：${humanError(error)}`, 'error');
      }
      break;
    }
    case 'install-update': {
      const ok = await confirmDialog({
        title: '导入启动器更新包',
        message:
          '会关闭启动器，用 ZIP 中的文件覆盖程序目录，然后重新打开。\n\n游戏、账号、设置和封面数据保存在独立的数据目录，不会被覆盖。',
        confirmText: '覆盖并重启',
      });
      if (!ok) break;
      try {
        const result = await api.installUpdate();
        if (result?.ok) toast('正在覆盖更新，启动器即将重新打开…', 'success');
      } catch (error) {
        toast(`更新失败：${error.message}`, 'error');
      }
      break;
    }
    case 'relaunch-admin': {
      const ok = await confirmDialog({
        title: '以管理员身份重启',
        message: 'Windows 会弹出 UAC 确认。重启后当前页面会关闭，请重新打开启动器。',
        confirmText: '重启',
      });
      if (ok) {
        const result = await api.relaunchAdmin();
        if (!result.ok) toast(result.error, 'error');
      }
      break;
    }
    case 'change-download-dir': {
      const dir = await api.pick.directory();
      if (dir) {
        await api.updateSettings({ downloadDir: dir });
        toast('下载文件夹已更新', 'success');
      }
      break;
    }
    case 'update-endfield-packs': {
      toast('正在检查终末地官方渠道包…', 'info');
      try {
        const result = await api.endfield.updateOfficial();
        const updated = (result.results || []).filter((item) => !item.skipped && item.updated);
        const failed = (result.results || []).filter((item) => item.error);
        if (failed.length) {
          toast(`渠道包下载失败：${failed.map((item) => item.iconName).join('、')}`, 'error');
        } else if (updated.length) {
          toast(`渠道包已备齐：${updated.map((item) => item.iconName).join('、')}`, 'success');
        } else {
          toast('官方渠道包已是最新版本', 'success');
        }
      } catch (error) {
        toast(`官方渠道包更新失败：${error.message}`, 'error');
      }
      break;
    }
    case 'update-endfield-packs-all': {
      toast('正在下载全部终末地渠道包（约 400MB）…', 'info');
      try {
        const result = await api.endfield.updateOfficial({ all: true });
        const updated = (result.results || []).filter((item) => !item.skipped && item.updated);
        toast(
          updated.length ? `已备齐 ${updated.length} 个渠道包` : '官方渠道包已是最新版本',
          'success'
        );
      } catch (error) {
        toast(`下载失败：${error.message}`, 'error');
      }
      break;
    }
    case 'update-arknights-packs': {
      toast('正在获取明日方舟渠道包…', 'info');
      try {
        const result = await api.endfield.updateArknights();
        const updated = (result.results || []).filter((item) => item.updated);
        const failed = (result.results || []).filter((item) => item.error);
        if (failed.length) {
          toast(
            `没取到：${failed.map((item) => item.error).join('；')}`,
            'error'
          );
        } else {
          toast(`明日方舟渠道包已备齐：${updated.map((item) => item.iconName).join('、')}`, 'success');
        }
      } catch (error) {
        toast(`明日方舟渠道包下载失败：${error.message}`, 'error');
      }
      break;
    }
    case 'update-arknights-game': {
      const game = (state.games || []).find((item) => item.builtinKey === 'arknights');
      const server = game?.servers.find((item) => item.active);
      if (!game || !server?.exists) {
        toast('先配置明日方舟客户端路径', 'error');
        break;
      }
      const ok = await confirmDialog({
        title: '更新明日方舟游戏本体',
        message: `将从官方接口对比完整游戏清单，只下载有差异的文件。\n\n当前客户端：${server.root || server.path}\n\n首次对比可能读取大量文件，更新期间请勿启动游戏。`,
        confirmText: '开始更新',
      });
      if (!ok) break;
      toast('正在检查明日方舟游戏版本…', 'info');
      try {
        const result = await api.endfield.updateArknightsGame();
        toast(
          result.skipped
            ? `明日方舟已是最新版本（${result.version}）`
            : `明日方舟已更新到 ${result.version}：${result.updated} 个文件`,
          'success'
        );
        await api.getState().then(onState);
      } catch (error) {
        toast(`明日方舟本体更新失败：${error.message}`, 'error');
      }
      break;
    }
    case 'nte-open-launcher': {
      try {
        await api.neverness.openLauncher();
        toast('官方启动器已打开，游戏本体更新交给它处理', 'success');
      } catch (error) {
        toast(humanError(error), 'error');
      }
      break;
    }
    case 'repair-endfield-game': {
      const game = (state.games || []).find((item) => item.builtinKey === 'endfield');
      await repairGameFlow(game);
      break;
    }
    case 'repair-arknights-game': {
      const game = (state.games || []).find((item) => item.builtinKey === 'arknights');
      await repairGameFlow(game);
      break;
    }
    case 'repair-game': {
      const game = (state.games || []).find((item) => item.id === (element?.dataset?.game || id));
      await repairGameFlow(game, element?.dataset?.server);
      break;
    }
    case 'release-endfield-packs':
      await releaseChannelPacks('endfield');
      break;
    case 'release-arknights-packs':
      await releaseChannelPacks('arknights');
      break;
    /* 设置页把两行合并成一行之后，一个「释放」按钮管两个游戏 */
    case 'release-channel-packs':
      await releaseChannelPacks('all');
      break;
    /* ── 渠道包管理窗口里的单渠道动作 ──────────────────────────────── */
    case 'channel-pack-download': {
      const game = element?.dataset?.game || '';
      const channel = element?.dataset?.channel || '';
      try {
        await api.endfield.packDownload({ game, channel });
        toast('渠道包已就绪', 'success');
      } catch (error) {
        toast(`渠道包下载失败：${error.message}`, 'error');
      }
      await refreshChannelPackManager();
      break;
    }
    case 'channel-pack-release': {
      const directory = element?.dataset?.directory || '';
      const label = element?.dataset?.label || directory;
      const ok = await confirmDialog({
        title: `释放${label}渠道包`,
        message:
          '只删这一个渠道包，其他渠道不受影响。\n\n' +
          '之后切到这个服时会重新问你要不要下；直接点「启动」不会问，所以释放后第一次还是走切服补回来。',
        confirmText: '释放',
      });
      if (!ok) break;
      try {
        const result = await api.endfield.deletePacks({ directories: [directory] });
        toast(`已释放 ${packBytesText(result.freed)}`, 'success');
      } catch (error) {
        toast(`释放失败：${error.message}`, 'error');
      }
      await refreshChannelPackManager();
      break;
    }
    case 'channel-pack-download-all': {
      toast('正在下载全部渠道包…', 'info');
      try {
        await api.endfield.updateOfficial({ all: true });
        await api.endfield.updateArknights();
        toast('渠道包已备齐', 'success');
      } catch (error) {
        toast(`下载失败：${error.message}`, 'error');
      }
      await refreshChannelPackManager();
      break;
    }
    case 'manage-endfield-packs':
      openEndfieldPackModal();
      break;
    case 'update-endfield-game': {
      const game = (state.games || []).find((item) => item.builtinKey === 'endfield');
      const server = game?.servers.find((item) => item.active);
      if (!game || !server?.exists) {
        toast('先配置终末地客户端路径', 'error');
        break;
      }
      const ok = await confirmDialog({
        title: '更新终末地游戏本体',
        message: `将从官方接口对比完整游戏清单，只下载有差异的文件。\n\n当前客户端：${server.root || server.path}\n\n首次对比可能读取大量文件，更新期间请勿启动游戏。`,
        confirmText: '开始更新',
      });
      if (!ok) break;
      toast('正在检查终末地游戏版本…', 'info');
      try {
        const result = await api.endfield.updateGame();
        toast(
          result.skipped
            ? `终末地已是最新版本（${result.version}）`
            : `终末地已更新到 ${result.version}：${result.updated} 个文件`,
          'success'
        );
        await api.getState().then(onState);
      } catch (error) {
        toast(`终末地本体更新失败：${error.message}`, 'error');
      }
      break;
    }
    case 'sync-endfield-packs': {
      const result = await api.endfield.syncPacks();
      if (result?.ok) {
        toast(
          result.updated.length
            ? `渠道包已更新：${result.updated.join('、')}`
            : '渠道包已是最新版本',
          'success'
        );
      }
      break;
    }
    case 'import-endfield-packs': {
      const result = await api.endfield.importPacks();
      if (result?.ok) {
        toast(`已导入 ${result.imported.length} 个渠道包，之后不再需要 XelLauncher`, 'success');
      }
      break;
    }
    case 'change-endfield-pack-root': {
      const dir = await api.pick.directory();
      if (dir) {
        await api.updateSettings({ endfieldPackRoot: dir });
        toast('终末地渠道包目录已更新', 'success');
      }
      break;
    }
    case 'change-runtime-root': {
      const dir = await api.pick.directory();
      if (dir) {
        await api.updateSettings({ runtimeRoot: dir });
        toast('运行时目录已更新', 'success');
      }
      break;
    }
    case 'settings-tab': {
      const key = element.dataset.value;
      if (!key || !SETTINGS_TABS.some(([id]) => id === key)) break;
      if (key === settingsTab()) break;
      state.settingsTab = key;
      try {
        localStorage.setItem('vela:settings-tab', key);
      } catch (error) {
        /* 本地存储不可用时只在本次会话生效 */
      }
      render();
      break;
    }
    case 'set-theme': {
      const theme = element.dataset.value;
      if (!theme || !THEME_OPTIONS.some(([key]) => key === theme)) break;
      await applySettingLocally({ theme });
      render({ preserveScroll: true });
      break;
    }
    case 'set-accent': {
      const accent = element.dataset.value;
      if (!accent || !ACCENT_OPTIONS.some(([key]) => key === accent)) break;
      await applySettingLocally({ accent });
      render({ preserveScroll: true });
      break;
    }
    case 'set-material': {
      const material = element.dataset.value || 'none';
      if (!MATERIAL_OPTIONS.includes(material)) break;
      // 先动窗口（主进程控制透明度 + DWM 材质），再存设置。
      const applied = await window.launcher.windowMaterial.apply(material);
      if (!applied?.ok) {
        // 系统不支持这个材质时不要在界面上假装生效，否则用户会以为点了有效
        toast(applied?.reason || '这个材质在当前系统上不可用', 'error');
        break;
      }

      // 关键：必须在 applySettings 之前写好本地 settings。
      // updateSettings 会经 state:patch → applySettings 重跑一遍，那时如果
      // state.settings.material 还是旧值，就会把 data-material 覆盖回 none，
      // 表现为「点了按钮没反应」。
      await applySettingLocally({ material });
      render({ preserveScroll: true });

      if (material !== 'none' && applied.transparency === false) {
        toast('系统的「透明效果」是关闭的，材质不会显示。在 设置 → 个性化 → 颜色 里打开它。', 'info');
      } else if (material !== 'none') {
        toast(`已切换到${MATERIAL_LABEL[material] || material}材质`, 'success');
      }
      break;
    }
    case 'pick-background': {
      const source = await api.pick.image();
      if (!source) break;
      try {
        const imported = await window.launcher.importBackground(source);
        await api.updateSettings({ customBackground: imported });
        toast('背景已更新', 'success');
      } catch (error) {
        toast(humanError(error), 'error');
      }
      break;
    }
    case 'reset-background':
      await api.updateSettings({ customBackground: '' });
      toast('已恢复纯色背景', 'success');
      break;
    case 'set-ui-scale': {
      const scale = normalizeUiScale(element.dataset.value);
      if (scale === currentUiScale()) break;
      await setUiScale(scale);
      break;
    }
    case 'toggle-sound': {
      const key = element.dataset.key;
      if (!key || !(key in state.sound)) break;
      state.sound[key] = !state.sound[key];
      saveSoundSettings();
      // 就地切状态：整页重绘出来的按钮一出生就是终态，滑块看不到位移过程
      paintSwitch(element, state.sound[key]);
      // 总开关关掉后「试听」三个按钮要一起置灰，同样只改这几个节点
      if (key === 'enabled') {
        document.querySelectorAll('[data-action="preview-sound"]').forEach((button) => {
          button.disabled = !state.sound.enabled;
        });
      }
      if (key === 'enabled' && state.sound.enabled) {
        // 总开关是在「音效还关着」的状态下按下的，按下那一刻没有声音，这里补一声
        playUiSound('toggle', true);
      }
      // 其余开关：pointerdown 已经出过 toggle 音，这里不再补第二声
      break;
    }
    case 'preview-sound': {
      if (!state.sound.enabled) {
        toast('先开启界面音效再试听', 'info');
        break;
      }
      playUiSound(element.dataset.value || 'click', true);
      break;
    }
    case 'set-salutation':
      await api.updateSettings({ profileName: element.dataset.value });
      toast(`称呼已改为「${element.dataset.value}」`, 'success');
      break;
    case 'set-starrail-fps': {
      const fps = Number(element.dataset.value) || 60;
      try {
        const result = await api.starrail.setFps(fps);
        state.starrailFps = result.fps;
        render({ preserveScroll: true });
        toast(`星穹铁道帧率已设为 ${result.fps} FPS，启动游戏后生效`, 'success');
      } catch (error) {
        toast(`写入星铁帧率失败：${error.message}`, 'error');
      }
      break;
    }
    case 'change-cover': {
      const source = await api.pick.image();
      if (!source) break;
      const imported = await api.importCover(source);
      await api.games.setCover(id, imported);
      toast('游戏封面已更新', 'success');
      break;
    }
    case 'change-avatar': {
      const source = await api.pick.image();
      if (!source) break;
      const imported = await api.importAvatar(source);
      await api.updateSettings({ avatar: imported });
      toast('头像已更新', 'success');
      break;
    }
    case 'reset-avatar':
      await api.updateSettings({ avatar: '' });
      toast('已恢复默认头像', 'success');
      break;
    case 'toggle-setting': {
      const key = element.dataset.key;
      if (!key) break;
      const next = !state.settings[key];
      /*
       * 关闭按钮的行为要两个键一起写：closeToTray 只负责设置页开关的显示，
       * closeAction 才是主进程真正执行的那个值。只写一个的话，
       * 开关看着变了、点 ✕ 还是老行为（也见过反过来：行为变了，开关弹回去）。
       */
      if (key === 'closeToTray') {
        const patch = { closeToTray: next, closeAction: next ? 'tray' : 'quit' };
        state.settings = { ...state.settings, ...patch };
        paintSwitch(element, next);
        expectSettingsEcho(state.settings);
        await api.updateSettings(patch);
        toast(next ? '关闭按钮：收进托盘' : '关闭按钮：直接退出启动器', 'info');
        break;
      }
      state.settings = { ...state.settings, [key]: next };
      /*
       * 先就地切状态，再记下这份设置的指纹。主进程随后回推的同内容设置
       * 就不整页重绘了——重绘会把刚跑起来的滑块动画掐断（新节点一出生就是终态）。
       */
      paintSwitch(element, next);
      expectSettingsEcho(state.settings);
      await api.updateSettings({ [key]: next });
      if (key === 'autoUpdateEndfieldPacks' && !next) {
        toast('已关闭终末地渠道包的后台自动更新；手动更新、切换服务器和启动游戏仍然可用', 'info');
      }
      if (key === 'autoUpdateArknightsPacks' && !next) {
        toast('已关闭明日方舟渠道包的后台自动更新；手动更新、切换服务器和启动游戏仍然可用', 'info');
      }
      break;
    }
    case 'toggle-charms': {
      const next = !(state.settings.charms !== false);
      paintSwitch(element, next);
      expectSettingsEcho({ ...state.settings, charms: next });
      await applySettingLocally({ charms: next });
      toast(next ? '装饰挂饰已开启' : '装饰挂饰已关闭', next ? 'success' : 'info');
      break;
    }
    case 'toggle-charbg': {
      const next = !(state.settings.charBg !== false);
      paintSwitch(element, next);
      expectSettingsEcho({ ...state.settings, charBg: next });
      await applySettingLocally({ charBg: next });
      toast(next ? '角色背景水印已开启' : '角色背景水印已关闭', next ? 'success' : 'info');
      break;
    }
    case 'toggle-sidebar-char': {
      const next = !(state.settings.sidebarChar !== false);
      paintSwitch(element, next);
      expectSettingsEcho({ ...state.settings, sidebarChar: next });
      await applySettingLocally({ sidebarChar: next });
      toast(next ? '侧栏立绘已开启' : '侧栏立绘已关闭', next ? 'success' : 'info');
      break;
    }
    case 'news-tab': {
      const next = element.dataset.value || 'all';
      if (next !== state.newsFilter) {
        state.newsFilter = next;
        render({ preserveScroll: false });
      }
      break;
    }
    case 'news-feature-prev':
    case 'news-feature-next': {
      // 循环翻页：到尾再点回到第一条，按钮永远有响应
      const total = noticeFeaturePool(noticeEntries()).length;
      if (total < 2) break;
      const cur = Math.min(Math.max(state.newsFeatureIndex || 0, 0), total - 1);
      const delta = element.dataset.action === 'news-feature-next' ? 1 : -1;
      state.newsFeatureIndex = (cur + delta + total) % total;
      render({ preserveScroll: true });
      break;
    }
    case 'news-toggle-releases': {
      state.newsReleasesExpanded = !state.newsReleasesExpanded;
      render({ preserveScroll: true });
      break;
    }
    case 'open-news':
      openNewsModal(id);
      break;
    case 'open-external':
      if (element.dataset.url) await api.openExternal(element.dataset.url);
      break;
    case 'refresh-notices':
      await loadNoticeBoard(true);
      break;
    case 'record-refresh':
      await reloadRecord();
      break;
    case 'record-game': {
      const next = element.dataset.value || '';
      if (!next || next === state.record.game) break;
      state.record.game = next;
      // 换游戏时回本期：上期切换只对深渊类功能有意义，换了游戏容易迷路
      state.record.schedule = 1;
      /*
       * 换到的游戏不一定有当前这个功能（星铁没有深境螺旋、崩3没有忘却之庭），
       * 停在一个不存在的组合上只会看到空页，落到它自己的第一个战绩功能。
       */
      const supported = recordFeaturesOf(next);
      if (supported.length && !supported.includes(state.record.feature)) {
        state.record.feature = supported[0];
      }
      await reloadRecord();
      break;
    }
    case 'record-feature': {
      const next = element.dataset.value || '';
      // 只有 13 个战绩功能能进这里；别的键一律忽略
      if (!next || next === state.record.feature || !RECORD_FEATURE_SET.has(next)) break;
      state.record.feature = next;
      state.record.schedule = 1;
      await reloadRecord();
      break;
    }
    case 'record-schedule': {
      const next = Number(element.dataset.value) === 2 ? 2 : 1;
      if (next === state.record.schedule) break;
      state.record.schedule = next;
      await reloadRecord();
      break;
    }
    /*
     * 同一款游戏里换角色（uid）。
     * 崩3 一个账号经常挂着三台服务器，原神也有人一个通行证两个号 ——
     * 换 uid 等于换一整套数据，缓存必须一起作废。
     */
    case 'record-role': {
      const uid = element.dataset.value || '';
      if (!uid) break;
      const game = state.record.game;
      const role = recordRolesOf(game).find((item) => String(item.uid) === String(uid));
      if (!role) break;
      state.record.role[game] = {
        game,
        uid: role.uid,
        region: role.region,
        nickname: role.nickname,
        level: role.level,
        regionName: role.regionName,
      };
      state.record.cache = {};
      await reloadRecord();
      break;
    }
    /* 换通行证账号：交给 doHoyolabSwitch，它会同时刷新登录态和战绩。 */
    case 'record-account':
      await doHoyolabSwitch('miyoushe', element.dataset.value || '');
      break;
    /*
     * 接口一直报 1034/5003 时，官方网页往往还能打开 —— 让用户在网页里
     * 完成一次人机验证（米游社的风控是跟着账号走的），回来刷新就通了。
     */
    case 'record-open-web':
      if (!window.launcher?.openExternal) {
        toast('当前版本不能打开外部链接', 'error');
        break;
      }
      await window.launcher.openExternal(RECORD_WEB_URL);
      break;
    case 'tools-refresh':
      await loadFeatures(true);
      if (!state.features?.error) toast('功能列表已刷新');
      break;
    /* 2.4.0 合并自对方分支：游戏 Wiki 卡片点击，https 校验后走外部浏览器 */
    case 'tools-wiki': {
      const url = String(element.dataset.url || '');
      if (!/^https:\/\//i.test(url)) {
        toast('这个 Wiki 地址不可用', 'error');
        break;
      }
      if (!window.launcher?.openExternal) {
        toast('当前环境打不开外部浏览器', 'error');
        break;
      }
      await window.launcher.openExternal(url);
      break;
    }
    case 'tools-open': {
      const key = element.dataset.feature || '';
      /*
       * 功能 → 现有页面的映射统一放在 TOOLS_NAV_TARGET（侧栏也用同一张表），
       * 避免出现「侧栏能跳、工具页点不动」这种两处不一致。
       */
      const target = TOOLS_NAV_TARGET[key];
      if (!target) {
        toast('这个能力需要在游戏里或官方平台查看', 'info');
        break;
      }
      /*
       * 所有跳转都带上 fromTools：目标二级页的 page-head 之前会渲染
       * 「返回工具页」条，用户不用再回侧栏找「工具」。
       */
      if (target === 'record') {
        /*
         * 战绩页要知道具体看哪个功能；看哪款游戏由 navigate 里按登录态自动挑。
         * 工具页「按游戏查看」点进来时带了 data-game，就按那个游戏开，
         * 否则按游戏分别收起的分组点了也没用，还是会跳回上次的游戏。
         */
        const picked = element?.dataset?.game || '';
        navigate('record', picked ? { feature: key, game: picked, fromTools: true } : { feature: key, fromTools: true });
        break;
      }
      navigate(target, { fromTools: true });
      if (target === 'screenshots') loadScreenshots(false);
      if (target === 'graphics') loadGraphics(state.graphicsGame);
      break;
    }
    /* 二级页顶部「返回工具页」条的入口 */
    case 'nav-tools':
      navigate('tools');
      break;
    case 'install-open-miyoushe': {
      const result = await window.launcher.install.open({ what: 'miyoushe' });
      if (!result?.ok) toast(result?.reason || '打开失败');
      break;
    }
    case 'shots-refresh':
      await loadScreenshots(true);
      break;
    case 'hoyolab-login':
      await doHoyolabLogin(
        element.dataset.value || 'miyoushe',
        'genshin',
        element.dataset.mode === 'add'
      );
      break;
    case 'hoyolab-switch':
      await doHoyolabSwitch('miyoushe', element.dataset.value || '');
      break;
    case 'hoyolab-remove':
      await doHoyolabLogout('miyoushe', element.dataset.value || '');
      break;
    case 'hoyolab-logout':
      await doHoyolabLogout(element.dataset.value || 'miyoushe');
      break;
    case 'passport-login':
      await doPassportLogin(element.dataset.value || '');
      break;
    case 'passport-logout':
      await doPassportLogout(element.dataset.value || '');
      break;
    case 'shots-game':
      state.shotsGame = element.dataset.value || '';
      render({ preserveScroll: true });
      break;
    case 'shots-open': {
      const target = element.dataset.path || '';
      if (target) await api.screenshots.open(target);
      break;
    }
    case 'shots-reveal': {
      // 缩略图本身也带 data-action，点「显示在文件夹」时不要连带打开图片
      if (event) event.stopPropagation();
      const target = element.dataset.path || '';
      if (target) await api.screenshots.reveal(target);
      break;
    }
    /*
     * 画质页改一项设置。
     *
     * 数据全在 data-* 里：data-entry 是注册表值名，data-field 是 JSON 里的字段名
     * （单值项时两者相同），data-value 是要写入的新值。
     * 布尔项是按钮（data-value="true"），下拉在 change 时触发，
     * 数字输入框先在本地记下（data-manual），按回车或离开输入框才写。
     */
    case 'graphics-set': {
      const game = element.dataset.game || state.graphicsGame;
      const entry = element.dataset.entry || '';
      const field = element.dataset.field || '';
      // 下拉框选完新值后，DOM 上的 value 变了但 data-value 还是渲染时的旧值，
      // 所以 SELECT 必须读 element.value，其余控件才读 data-value。
      const raw = element.tagName === 'SELECT' ? element.value : element.dataset.value;
      if (!entry || !field) break;
      /*
       * 兜底：按钮是上一款游戏渲染出来的，而页面已经切到别的游戏了。
       * 这条路径曾经把原神的注册表项名写进终末地的注册表项里 —— 卡片还留在 DOM 上
       * （比如异步刷新回来晚了一拍），用户点下去就会跨游戏误写，必须直接拦掉。
       */
      if (element.dataset.game && element.dataset.game !== state.graphicsGame) {
        toast('页面已切换，请重新点击', 'info');
        break;
      }
      if (raw === undefined || raw === null || raw === '') {
        toast('没有读到要写入的值，请重试', 'error');
        break;
      }

      let value = raw;
      if (element.tagName === 'SELECT') {
        // 下拉的 option.value 是字符串，按字段原本的类型还原成数字 / 布尔
        value = raw;
        if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
        else if (raw === 'true') value = true;
        else if (raw === 'false') value = false;
      } else if (element.type === 'number') {
        const typed = Number(element.value);
        if (!Number.isFinite(typed)) {
          toast('这一项要填数字', 'error');
          break;
        }
        value = typed;
      } else if (raw === 'true') {
        value = true;
      } else if (raw === 'false') {
        value = false;
      }

      // 给人看的名字：单值项时 field 就是注册表值名，JSON 项要翻成中文
      const hit = (() => {
        const groups = state.graphics && Array.isArray(state.graphics.fields) ? state.graphics.fields : [];
        const group = groups.find((item) => item.name === entry);
        return (group?.fields || []).find((item) => item.key === field) || null;
      })();
      const shown = hit?.label || field;
      // 提示里说中文档位名，不说注册表原始数字（「超分方式 已设为 DLSS」而不是「已设为 3000」）
      const spoken = hit ? gfxOptionLabel(hit, value) : String(value);

      /*
       * 下拉框不能在这里立刻 render。
       *
       * change 事件是在用户点完选项、原生下拉刚要收起的瞬间触发的，
       * 此时同步 render 会把整个 DOM 换掉，下拉被销毁 → 看起来「一点开就关掉」；
       * 更糟的是写入的 await 回来后状态已被重绘覆盖。
       * 所以先把「正在写入」的标记记下来，写入与重读都完成后再统一重画一次。
       */
      state.graphicsPending = { name: field, value };
      // 只给当前这一行挂个「写入中」的样式，不重建 DOM（重建会把下拉/焦点全弄没）
      const pendingRow = element.closest('.gfx-row');
      if (pendingRow) pendingRow.classList.add('is-pending');
      try {
        // 与读取同源：把游戏对象一起传过去，主进程才知道该往哪个注册表项写
        // （trait 里没写 key 的游戏要靠 path 自动探测；探测不到主进程会拒绝写）
        const target = graphicsGameEntry(game);
        const result = await api.graphics.write({
          gameKey: target.gameKey,
          name: target.name,
          path: target.path,
          exe: target.exe,
          entry,
          field,
          value,
        });
        if (!result || result.ok === false) throw new Error(result?.reason || '写入失败');
        if (result.unchanged) {
          toast(`${shown} 已经是「${spoken}」了`, 'info');
        } else {
          toast(`${shown} 已设为 ${spoken}，启动游戏后生效`, 'success');
        }
      } catch (error) {
        toast(`写入失败：${error.message}`, 'error');
      } finally {
        state.graphicsPending = null;
        if (pendingRow) pendingRow.classList.remove('is-pending');
        /*
         * 重新读一遍注册表，界面上显示的就是游戏里真实的当前值。
         *
         * 必须 force：写入成功后缓存里的那份就是旧值，而它在 60 秒新鲜期内
         * 会被 loadGraphics 直接复用 —— 用户会看到「刚点完的开关自己弹回去了」。
         * force 路径在 loadGraphics 里走的是「保留旧画面、不置 loading、读完再按
         * 签名比对决定要不要重画」，所以这里既拿得到新值，也不会闪「正在读取注册表」。
         */
        if (state.route === 'graphics') await loadGraphics(game, { force: true });
      }
      break;
    }

    /*
     * 插件页。
     *
     * 导入是个两步流程：主进程先弹系统选择框、把文件拷进插件目录，
     * 然后这里再弹一次权限确认；用户取消的话要把刚落盘的文件删掉，
     * 不能留下一份「已安装但从没被允许运行」的孤儿文件。
     */
    case 'plugin-refresh':
      await loadPlugins(true);
      if (!state.plugins.error) toast('插件列表已刷新');
      break;
    case 'plugin-open-dir':
      // 只读一层：没有 reveal(dir) 接口，先开数据目录，插件都在它的 plugins 子目录里
      await api.openDataFolder();
      break;
    case 'plugin-doc': {
      const result = await api.plugins.openDoc();
      // 系统里没关联 .md 的打开方式时会失败，这时退回打开插件目录，别让用户卡住
      if (!result || !result.ok) {
        toast('系统没有关联 .md 文件，已帮你打开插件目录', 'info');
        await api.openDataFolder();
      }
      break;
    }
    case 'plugin-select': {
      const target = element?.dataset?.id || '';
      if (!target) break;
      state.plugins.active = target;
      delete state.plugins.errors[target];
      render({ preserveScroll: true });
      await startPlugin(pluginById(target) || { id: target, permissions: [] });
      break;
    }
    case 'plugin-reload': {
      const target = element?.dataset?.id || state.plugins.active;
      const plugin = pluginById(target);
      if (!plugin) break;
      const runtime = pluginRuntime();
      if (runtime) runtime.Host.stop(target);
      delete state.plugins.errors[target];
      delete state.plugins.views[target];
      state.plugins.running[target] = false;
      render({ preserveScroll: true });
      await startPlugin(plugin);
      break;
    }
    case 'plugin-import': {
      let result;
      try {
        result = await window.launcher.plugins.importFile();
      } catch (error) {
        toast(humanError(error) || '导入失败', 'error');
        break;
      }
      // 用户自己点了取消，不算出错，也不用提示
      if (!result || (result.ok === false && result.cancelled)) break;
      if (!result.ok) {
        toast(result.error || '导入失败', 'error');
        break;
      }
      state.plugins.pending = result.id || result.file || '';
      await loadPlugins(true);
      const imported =
        pluginById(result.id) ||
        (state.plugins.list?.plugins || []).find((plugin) => plugin.file === result.file) ||
        { id: '', file: result.file, name: result.name, permissions: [] };
      openPluginPermissionDialog(imported);
      break;
    }
    case 'plugin-confirm-install': {
      state.plugins.pending = '';
      closeModal();
      const activeNow = state.plugins.active;
      await loadPlugins(true);
      state.plugins.active = activeNow;
      const plugin = pluginById(activeNow) || pluginById(pickPluginId());
      if (plugin) {
        state.plugins.active = plugin.id;
        await startPlugin(plugin);
        toast(`「${plugin.name || plugin.id}」已启用`, 'success');
      }
      if (state.route === 'plugins') render({ preserveScroll: true });
      break;
    }
    case 'plugin-cancel-install': {
      // 取消 = 撤销这次导入：文件刚写进插件目录，还没被允许运行，删掉最干净
      const target = state.plugins.pending || '';
      state.plugins.pending = '';
      closeModal();
      if (!target) break;
      const plugin = (state.plugins.list?.plugins || []).find(
        (item) => item.id === target || item.file === target
      );
      try {
        if (plugin?.id) {
          await window.launcher.plugins.remove(plugin.id);
        } else if (plugin?.file) {
          await window.launcher.plugins.remove(plugin.file);
        }
        toast('已撤销导入');
      } catch (error) {
        toast(humanError(error) || '撤销导入失败', 'error');
      }
      await loadPlugins(true);
      break;
    }
    case 'plugin-remove': {
      const pluginId = element?.dataset?.id || '';
      const fileName = element?.dataset?.file || '';
      const target = pluginId || fileName;
      if (!target) break;
      const ok = await confirmDialog({
        title: '删除这个插件？',
        message: '插件文件会从插件目录里删掉，它保存的配置也会一起清空，这一步不能撤销。',
        confirmText: '删除',
        danger: true,
      });
      if (!ok) break;
      try {
        const result = await window.launcher.plugins.remove(target);
        if (!result || result.ok === false) throw new Error(result?.error || '删除失败');
        const runtime = pluginRuntime();
        if (runtime) runtime.Host.stop(pluginId || target);
        delete state.plugins.running[pluginId];
        delete state.plugins.views[pluginId];
        delete state.plugins.errors[pluginId];
        if (state.plugins.active === pluginId) state.plugins.active = '';
        toast('插件已删除');
      } catch (error) {
        toast(humanError(error) || '删除失败', 'error');
      }
      await loadPlugins(true);
      break;
    }

    case 'tools-tab': {
      const key = element.dataset.value || '';
      if (!key || key === state.toolsTab) break;
      state.toolsTab = key;
      render({ preserveScroll: true });
      break;
    }
    /* 工具页右上角：账号登录弹窗（米游社 + 其它发行方通行证） */
    case 'tools-accounts':
      openToolsAccountsModal();
      break;
    /* 工具页里的「自定义插件」是独立页面，直接跳过去 */
    case 'nav-plugins':
      navigate('plugins');
      break;
    /*
     * 「按游戏查看」里点游戏名：默认全部收起，点谁展开谁，再点一次收回去。
     * 不用 <details> 是因为卡片结构里还有「其它已接入」列表，收起来时要连它一起收，
     * 状态放在 state 里才能在 render 后保留。
     */
    case 'tools-game-pick':
    case 'tools-game-toggle': {
      // tools-game-toggle 是旧卡片墙的 action 名，留着兼容没重载的旧 DOM
      const key = element.dataset.value || '';
      if (!key) break;
      state.toolsGame = key;
      render({ preserveScroll: true });
      break;
    }

    case 'graphics-refresh':
      await loadGraphics(state.graphicsGame);
      break;
    case 'graphics-game':
      state.graphicsGame = element.dataset.value || 'starrail';
      await loadGraphics(state.graphicsGame);
      break;
    case 'quit-app':
      await api.quit();
      break;
    case 'close-modal':
      closeModal();
      break;
    default:
      break;
  }
}
