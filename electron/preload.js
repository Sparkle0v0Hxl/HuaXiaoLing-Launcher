'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('launcher', {
  getState: () => ipcRenderer.invoke('state:get'),
  getInfo: () => ipcRenderer.invoke('app:info'),
  gameNotices: (gameId) => ipcRenderer.invoke('game:notices', gameId),
  allGameNotices: (force = false) => ipcRenderer.invoke('games:notices', force),
  // 更新弹窗的配图（米游社同人图，取不到时前端退回官网美术图）
  postArt: (force = false) => ipcRenderer.invoke('postart:list', force),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  pickUpdateSource: () => ipcRenderer.invoke('update:pick-source'),
  updateBackup: () => ipcRenderer.invoke('update:backup'),
  rollbackUpdate: () => ipcRenderer.invoke('update:rollback'),
  endfieldLogin: () => ipcRenderer.invoke('endfield:login-token'),

  // 游戏能力注册表：前端据此决定显示哪些入口，不必硬编码游戏名
  features: {
    all: () => ipcRenderer.invoke('features:all'),
    describe: (gameKey) => ipcRenderer.invoke('features:describe', gameKey),
    byCategory: () => ipcRenderer.invoke('features:by-category'),
  },

  // 米游社 / HoYoLAB 登录与战绩
  hoyolab: {
    login: (input) => ipcRenderer.invoke('hoyolab:login', input),
    status: (input) => ipcRenderer.invoke('hoyolab:status', input),
    switchAccount: (input) => ipcRenderer.invoke('hoyolab:switch', input),
    logout: (input) => ipcRenderer.invoke('hoyolab:logout', input),
    record: (input) => ipcRenderer.invoke('hoyolab:record', input),
  },

  // 通用通行证（鹰角 / 完美世界 / 库街区）
  passport: {
    login: (input) => ipcRenderer.invoke('passport:login', input),
    status: (input) => ipcRenderer.invoke('passport:status', input),
    logout: (input) => ipcRenderer.invoke('passport:logout', input),
  },

  // 截图管理
  screenshots: {
    list: () => ipcRenderer.invoke('screenshots:list'),
    checkDir: (dir) => ipcRenderer.invoke('screenshots:check-dir', dir),
    thumb: (filePath) => ipcRenderer.invoke('screenshots:thumb', filePath),
    open: (filePath) => ipcRenderer.invoke('screenshots:open', filePath),
    reveal: (filePath) => ipcRenderer.invoke('screenshots:reveal', filePath),
  },

  // 画质配置
  graphics: {
    read: (gameKey) => ipcRenderer.invoke('graphics:read', gameKey),
    write: (input) => ipcRenderer.invoke('graphics:write', input),
    // 开机预读完成的通知：画质页收到后不需要做什么，只是方便界面知道自己已被预热
    onPrimed: (callback) => subscribe('graphics:primed', callback),
  },

  // 用户自定义插件：清单、导入导出、插件自己的配置
  plugins: {
    list: () => ipcRenderer.invoke('plugin:list'),
    read: (id) => ipcRenderer.invoke('plugin:read', id),
    importFile: () => ipcRenderer.invoke('plugin:import'),
    remove: (id) => ipcRenderer.invoke('plugin:remove', id),
    storageGet: (id) => ipcRenderer.invoke('plugin:storage-get', id),
    storageSet: (input) => ipcRenderer.invoke('plugin:storage-set', input),
    openDoc: () => ipcRenderer.invoke('plugin:open-doc'),
  },

  // 安装与更新
  install: {
    list: () => ipcRenderer.invoke('install:list'),
    checkRemote: (input) => ipcRenderer.invoke('install:check-remote', input),
    open: (input) => ipcRenderer.invoke('install:open', input),
  },

  // 窗口材质（亚克力 / 云母）
  windowMaterial: {
    apply: (material) => ipcRenderer.invoke('window:material', { material }),
    state: () => ipcRenderer.invoke('window:material-state'),
  },

  // 自定义背景图
  importBackground: (path) => ipcRenderer.invoke('background:import', path),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  moveWindowBy: (dx, dy) => ipcRenderer.invoke('window:move-by', { dx, dy }),

  /*
   * 启动页侧栏的「往外推」：窗口向左外扩一块放侧栏，画面原地不动。
   * room 先问空间（渲染层据此同步决定用外扩还是往里推），
   * expand / collapse 是真正改窗口（渲染层不等返回值，才能和画面补偿同帧生效）。
   */
  startNavRoom: () => ipcRenderer.invoke('window:start-nav-room'),
  // 单向 send：补间期间每帧都调，不需要回值，也不该为它排一条请求-响应往返
  startNavResize: (delta) => ipcRenderer.send('window:start-nav-resize', { delta }),
  startNavCollapse: () => ipcRenderer.invoke('window:start-nav-collapse'),

  onState: (callback) => subscribe('state:changed', callback),
  onToast: (callback) => subscribe('toast', callback),
  onUpdateAvailable: (callback) => subscribe('update:available', callback),
  onUpdateProgress: (callback) => subscribe('update:progress', callback),
  onGachaUpdated: (callback) => subscribe('gacha:updated', callback),
  onGameExited: (callback) => subscribe('game:exited', callback),
  onLinkProgress: (callback) => subscribe('link:progress', callback),
  onLinkDone: (callback) => subscribe('link:done', callback),
  onLinkPreviewProgress: (callback) => subscribe('link:preview-progress', callback),
  onLinkPreviewDone: (callback) => subscribe('link:preview-done', callback),
  onSophonProgress: (callback) => subscribe('sophon:progress', callback),
  onPredownloadProgress: (callback) => subscribe('predownload:progress', callback),
  // 终末地切非官服渠道时要现做链接运行时（几十秒），进度必须能看到，
  // 否则「点切换」和「卡死」在界面上是同一件事。
  onEndfieldProgress: (callback) => subscribe('endfield:progress', callback),

  // 窗口全屏状态（Electron 原生全屏不会触发 CSS :fullscreen，只能由主进程告知）
  onFullscreenChange: (callback) => subscribe('window:fullscreen', callback),

  // 预下载：新版本上线前先把内容拉到本地，上线后再应用
  predownload: {
    check: (input) => ipcRenderer.invoke('predownload:check', input),
    start: (input) => ipcRenderer.invoke('predownload:start', input),
    apply: (input) => ipcRenderer.invoke('predownload:apply', input),
    clear: (input) => ipcRenderer.invoke('predownload:clear', input),
    cancel: (jobId) => ipcRenderer.invoke('predownload:cancel', jobId),
    pause: (input) => ipcRenderer.invoke('predownload:pause', input),
    // 单个服务器覆盖「剧情等分类资源包」开关；传 null 表示跟随全局设置
    setStoryResources: (input) => ipcRenderer.invoke('predownload:set-story-resources', input),
  },

  // 异环官服 / B服：改启动器配置里的 Branch / serialNumber / Partner，不动游戏文件
  neverness: {
    channel: (input) => ipcRenderer.invoke('neverness:channel', input),
    setChannel: (input) => ipcRenderer.invoke('neverness:set-channel', input),
    // 切到 B服后一键拉起官方启动器下载 B服资源（只有首次需要）
    openLauncher: () => ipcRenderer.invoke('neverness:open-launcher'),
    // 花筱灵自己按官方清单预下载渠道资源（可取消），进度走 onPredownload
    predownload: (input) => ipcRenderer.invoke('neverness:predownload', input),
    predownloadCancel: () => ipcRenderer.invoke('neverness:predownload-cancel'),
    onPredownload: (callback) => subscribe('nte-predownload', callback),
  },
  onNteCapture: (callback) => subscribe('nte-capture', callback),

  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),

  endfield: {
    importPacks: () => ipcRenderer.invoke('endfield:import-packs'),
    syncPacks: () => ipcRenderer.invoke('endfield:sync-packs'),
    updateOfficial: () => ipcRenderer.invoke('endfield:update-official-packs'),
    updateGame: () => ipcRenderer.invoke('endfield:update-game'),
  },

  games: {
    add: (input) => ipcRenderer.invoke('games:add', input),
    update: (id, input) => ipcRenderer.invoke('games:update', id, input),
    setCover: (id, cover) => ipcRenderer.invoke('games:update-cover', id, cover),
    remove: (id) => ipcRenderer.invoke('games:remove', id),
    clearDemo: () => ipcRenderer.invoke('games:clear-demo'),
    detect: (id) => ipcRenderer.invoke('games:detect', id),
    // 按渠道扫：只认这个服自己的客户端，不会把官服 exe 记到 B服 那一行
    detectServer: (id, serverId) => ipcRenderer.invoke('games:detect-server', id, serverId),
    syncOfficial: () => ipcRenderer.invoke('games:sync-official'),
    launch: (id) => ipcRenderer.invoke('games:launch', id),
    stop: (id) => ipcRenderer.invoke('games:stop', id),
    reveal: (id) => ipcRenderer.invoke('games:reveal', id),
  },

  servers: {
    add: (input) => ipcRenderer.invoke('servers:add', input),
    update: (input) => ipcRenderer.invoke('servers:update', input),
    remove: (input) => ipcRenderer.invoke('servers:remove', input),
    clearPath: (input) => ipcRenderer.invoke('servers:clear-path', input),
    activate: (input) => ipcRenderer.invoke('servers:activate', input),
    link: (input) => ipcRenderer.invoke('servers:link', input),
    linkPreview: (input) => ipcRenderer.invoke('servers:link-preview', input),
    prepareEndfield: (input) => ipcRenderer.invoke('servers:prepare-endfield', input),
    prepareSophon: (input) => ipcRenderer.invoke('servers:prepare-sophon', input),
    updateSophon: (input) => ipcRenderer.invoke('servers:update-sophon', input),
    // 一键下载：未安装游戏的全新安装（进度仍走 sophon:progress 通道）
    downloadEstimate: (input) => ipcRenderer.invoke('servers:download-estimate', input),
    downloadGame: (input) => ipcRenderer.invoke('servers:download-game', input),
    cancelSophon: (jobId) => ipcRenderer.invoke('servers:cancel-sophon', jobId),
    pauseSophon: (input) => ipcRenderer.invoke('servers:pause-sophon', input),
    cancelLink: (jobId) => ipcRenderer.invoke('servers:cancel-link', jobId),
    openFolder: (input) => ipcRenderer.invoke('servers:open-folder', input),
    // 卸载这个渠道的客户端：先问能不能删（共用目录 / 盘符根目录会被拒），再真删
    uninstallPlan: (input) => ipcRenderer.invoke('servers:uninstall-plan', input),
    uninstall: (input) => ipcRenderer.invoke('servers:uninstall', input),
  },

  pick: {
    executable: () => ipcRenderer.invoke('dialog:pick-executable'),
    image: () => ipcRenderer.invoke('dialog:pick-image'),
    audio: () => ipcRenderer.invoke('dialog:pick-audio'),
    directory: () => ipcRenderer.invoke('dialog:pick-directory'),
  },
  mediaUrl: (source) => ipcRenderer.invoke('media:url', source),
  neteasePlaylist: (input) => ipcRenderer.invoke('media:netease-playlist', input),
  musicCharts: (platform) => ipcRenderer.invoke('music:charts', platform),
  musicLogin: (platform) => ipcRenderer.invoke('music:login', platform),
  musicLoginConfirm: () => ipcRenderer.invoke('music:login-confirm'),
  musicLoginDebug: () => ipcRenderer.invoke('music:login-debug'),
  musicStatus: () => ipcRenderer.invoke('music:status'),
  // 第三方音源导入：传 { text }（本地文件内容）或 { url }（订阅地址）
  musicImportSources: (input) => ipcRenderer.invoke('music:sources-import', input),
  musicLogout: (platform) => ipcRenderer.invoke('music:logout', platform),
  musicVerify: (platform) => ipcRenderer.invoke('music:verify', platform),
  musicMyPlaylists: (platform) => ipcRenderer.invoke('music:my-playlists', platform),
  /*
   * 可以只同步指定的平台：musicAllPlaylists({ platforms: ['kugou'] })。
   * 老代码 musicAllPlaylists() 不传参照旧 —— 主进程那边把「没传」当「全部」。
   */
  musicAllPlaylists: (payload) => ipcRenderer.invoke('music:all-playlists', payload || {}),
  /*
   * 我的歌单本地缓存。「我的歌单」原来只存在内存里，关掉启动器再开就要重新拉一遍，
   * 这组接口让卡片墙在冷启动时先按上次的结果画出来，再决定要不要后台刷新。
   */
  musicPlaylistsCache: () => ipcRenderer.invoke('music:playlists-cache'),
  musicSavePlaylistsCache: (payload) => ipcRenderer.invoke('music:playlists-cache-save', payload || {}),
  musicDropPlaylistsCache: (payload) => ipcRenderer.invoke('music:playlists-cache-drop', payload || {}),
  musicResolve: (input) => ipcRenderer.invoke('music:resolve', input),
  musicLyric: (input) => ipcRenderer.invoke('music:lyric', input),
  musicPlaylistSongs: (input) => ipcRenderer.invoke('music:playlist-songs', input),
  musicParsePlaylistLink: (url) => ipcRenderer.invoke('music:parse-playlist-link', { url }),
  musicPlaza: (platform, page) => ipcRenderer.invoke('music:plaza', { platform, page }),
  musicChartSongs: (input) => ipcRenderer.invoke('music:chart-songs', input),
  musicSearch: (input) => ipcRenderer.invoke('music:search', input),
  netease: {
    startService: (apiBase) => ipcRenderer.invoke('netease:service-start', apiBase),
    songMeta: (input) => ipcRenderer.invoke('netease:song-meta', input),
    searchSong: (input) => ipcRenderer.invoke('netease:search-song', input),
    songUrl: (input) => ipcRenderer.invoke('netease:song-url', input),
    qrCreate: (input) => ipcRenderer.invoke('netease:qr-create', input),
    qrCheck: (input) => ipcRenderer.invoke('netease:qr-check', input),
    status: () => ipcRenderer.invoke('netease:status'),
    logout: () => ipcRenderer.invoke('netease:logout'),
  },
  starrail: {
    getFps: () => ipcRenderer.invoke('starrail:fps:get'),
    setFps: (fps) => ipcRenderer.invoke('starrail:fps:set', fps),
  },
  live: {
    biliRoom: (input) => ipcRenderer.invoke('live:bili-room', input),
    room: (input) => ipcRenderer.invoke('live:bili-room', input),
    danmakuStart: (input) => ipcRenderer.invoke('live:danmaku-start', input),
    danmakuPoll: (id) => ipcRenderer.invoke('live:danmaku-poll', id),
    danmakuStop: (id) => ipcRenderer.invoke('live:danmaku-stop', id),
    danmuInfo: (roomId) => ipcRenderer.invoke('live:danmu-info', roomId),
    biliLogin: () => ipcRenderer.invoke('bili:login'),
    // 弹幕长连接已迁到主进程：渲染层只发 connect/disconnect（send，不等回值），
    // 再用 onDanmuEvent 订阅主进程转发过来的 open/pushing/danmu/status/closed/reconnecting 事件。
    danmuConnect: (payload) => ipcRenderer.send('live:danmu-connect', payload),
    danmuDisconnect: (roomId) => ipcRenderer.send('live:danmu-disconnect', roomId),
    onDanmuEvent: (callback) => ipcRenderer.on('live:danmu-event', (_event, payload) => callback(payload)),
  },

  importCover: (path) => ipcRenderer.invoke('cover:import', path),
  importAvatar: (path) => ipcRenderer.invoke('avatar:import', path),
  openPath: (path) => ipcRenderer.invoke('shell:open-path', path),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  openDownloadFolder: () => ipcRenderer.invoke('app:open-download-folder'),
  openUpdateLog: () => ipcRenderer.invoke('app:open-update-log'),
  readUpdateLog: () => ipcRenderer.invoke('app:read-update-log'),
  createDesktopShortcut: () => ipcRenderer.invoke('app:create-desktop-shortcut'),
  setUiScale: (value) => ipcRenderer.invoke('app:ui-scale', value),
  exportStartVideo: (gameId) => ipcRenderer.invoke('start:export-video', gameId),
  relaunchAdmin: () => ipcRenderer.invoke('app:relaunch-admin'),
  quit: () => ipcRenderer.invoke('app:quit'),

  news: {
    list: () => ipcRenderer.invoke('news:list'),
  },

  gacha: {
    load: (force = false) => ipcRenderer.invoke('gacha:load', force),
    pickDatabase: () => ipcRenderer.invoke('gacha:pick-db'),
    import: (game = '') => ipcRenderer.invoke('gacha:import', { game }),
    sync: (gameId, auth) => ipcRenderer.invoke('gacha:sync', { gameId, auth }),
    nteFolder: () => ipcRenderer.invoke('gacha:nte-folder'),
    nteRefresh: () => ipcRenderer.invoke('gacha:nte-refresh'),
    nteCaptureInfo: () => ipcRenderer.invoke('gacha:nte-capture-info'),
    nteCaptureStart: (autoPage = true) =>
      ipcRenderer.invoke('gacha:nte-capture-start', { autoPage }),
    nteCaptureStop: () => ipcRenderer.invoke('gacha:nte-capture-stop'),
    // 异环导出工具一键获取（下载+解压到下载目录），进度走 onNteTool
    nteToolDownload: () => ipcRenderer.invoke('gacha:nte-tool'),
    nteToolCancel: () => ipcRenderer.invoke('gacha:nte-tool-cancel'),
    onNteTool: (callback) => subscribe('nte-tool', callback),
    refreshMeta: () => ipcRenderer.invoke('gacha:refresh-meta'),
  },

  downloads: {
    add: (input) => ipcRenderer.invoke('downloads:add', input),
    pause: (id) => ipcRenderer.invoke('downloads:pause', id),
    resume: (id) => ipcRenderer.invoke('downloads:resume', id),
    cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
    remove: (id) => ipcRenderer.invoke('downloads:remove', id),
    open: (id) => ipcRenderer.invoke('downloads:open', id),
    openFolder: (id) => ipcRenderer.invoke('downloads:open-folder', id),
  },
});
