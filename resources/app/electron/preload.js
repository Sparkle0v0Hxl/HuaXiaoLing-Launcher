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

  onState: (callback) => subscribe('state:changed', callback),
  onToast: (callback) => subscribe('toast', callback),
  onUpdateAvailable: (callback) => subscribe('update:available', callback),
  onUpdateProgress: (callback) => subscribe('update:progress', callback),
  onGachaUpdated: (callback) => subscribe('gacha:updated', callback),
  onGameExited: (callback) => subscribe('game:exited', callback),
  onLinkProgress: (callback) => subscribe('link:progress', callback),
  onLinkDone: (callback) => subscribe('link:done', callback),
  onSophonProgress: (callback) => subscribe('sophon:progress', callback),
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
    prepareEndfield: (input) => ipcRenderer.invoke('servers:prepare-endfield', input),
    prepareSophon: (input) => ipcRenderer.invoke('servers:prepare-sophon', input),
    updateSophon: (input) => ipcRenderer.invoke('servers:update-sophon', input),
    cancelSophon: (jobId) => ipcRenderer.invoke('servers:cancel-sophon', jobId),
    pauseSophon: (input) => ipcRenderer.invoke('servers:pause-sophon', input),
    cancelLink: (jobId) => ipcRenderer.invoke('servers:cancel-link', jobId),
    openFolder: (input) => ipcRenderer.invoke('servers:open-folder', input),
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
  musicLogout: (platform) => ipcRenderer.invoke('music:logout', platform),
  musicVerify: (platform) => ipcRenderer.invoke('music:verify', platform),
  musicMyPlaylists: (platform) => ipcRenderer.invoke('music:my-playlists', platform),
  musicAllPlaylists: () => ipcRenderer.invoke('music:all-playlists'),
  musicResolve: (input) => ipcRenderer.invoke('music:resolve', input),
  musicPlaylistSongs: (input) => ipcRenderer.invoke('music:playlist-songs', input),
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
  },

  importCover: (path) => ipcRenderer.invoke('cover:import', path),
  importAvatar: (path) => ipcRenderer.invoke('avatar:import', path),
  openPath: (path) => ipcRenderer.invoke('shell:open-path', path),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  openDownloadFolder: () => ipcRenderer.invoke('app:open-download-folder'),
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
