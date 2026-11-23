'use strict';

const { ipcMain, app, dialog } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');
// 主题包的 id 规则与配色白名单只有一份（theme-pack.js），这里直接复用，避免两边漂移
const themePack = require('./theme-pack');


/**
 * 设置读写与导入导出。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installSettingsIpc(ctx) {
  const { snapshot, normalizeUiScale, clearMusicResolveCache, validateCustomSource, normalizeProxyRules, normalizeAudioLanguages, applyNativeTheme, applyLoginItem, applyTitlebar, applyUiScale, pushState, applyProxySettings, applyDownloadLimit, dataFile, win, getStore } = ctx;

    ipcMain.handle('settings:update', async (_event, patch) => {
      if (!patch || typeof patch !== 'object') return snapshot();
      const settings = getStore().data.settings;
      const allowed = [
        'profileName',
        'avatar',
        'theme',
        'accent',
        'sidebarCollapsed',
        'quickPanelPinned',
        'uiScale',
        'alwaysAdmin',
        // 「开游戏要管理员」这件事问过一次没有：界面点过「以管理员重启」或
        // 「每次弹一次」之后置 true，免得每次启动都重新问
        'elevationAsked',
        'elevationDeclined',
        'nevernessUseOfficialLauncher',
        'closeToTray',
        // 关闭按钮的真实行为（tray / quit）。和 closeToTray 由同一处逻辑同时写，
        // 不放进白名单的话设置页改完会被快照回推抹掉。
        'closeAction',
        'launchAtLogin',
        'minimizeOnLaunch',
        'autoSyncOfficial',
        'autoUpdateEndfieldPacks',
        'autoUpdateArknightsPacks',
        'autoGacha',
        'audioLanguages',
        'includeStoryResources',
        // ldiff 增量加速开关：不留退路的话，介意「就地改写游戏文件」的用户没有别的选择。
        'enableLdiff',
        // 下载限速：全局带宽上限（KB/s，0 = 不限速）
        'downloadLimitKBps',
        // 装饰挂饰 / 角色背景水印：这两个以前不在白名单里，快照永远不带这两个键，
        // 状态回推时会把刚点下去的值抹掉，开关表现为「点了直接弹回原状」。
        'charms',
        'charBg',
        // 侧栏底部那张火花立绘：展开侧栏时会占掉一截高度，用户要能自己关掉
        'sidebarChar',
        'updateManifest',
        // 更新源模式：不放进白名单的话，设置页写下去会被快照回推抹掉，
        // 表现为「选了模式一刷新又变回自动」。
        'updateSourceMode',
        'autoCheckUpdate',
        'proxyRules',
        'notesSeenVersion',
        // 「稍后再说」的推迟状态：不在白名单里的话，界面写下去会被快照回推抹掉，等于没记
        'updateSnoozeVersion',
        'updateSnoozeUntil',
        'endfieldPackRoot',
        // 终末地官方启动器（Games.exe）手填路径：自动发现找不到时的兜底（2026-11-23）
        'endfieldOfficialGamesExe',
        'starwardDbPath',
        'runtimeRoot',
        'downloadDir',
        'lastPage',
        'material',
        'customBackground',
        'backgroundOpacity',
        // 界面不透明度（40–100，2026-11-18）
        'uiOpacity',
        'backgroundBlur',
        'backgroundMotion',
        'backgroundRotate',
        // 点歌台音源：内置音源的开关 + 用户自己导入的第三方音源
        'musicSources',
        'musicCustomSources',
        // 音乐缓存：播放过的音频字节落盘，同一首歌再播直接读本机
        'musicCache',
        'musicCacheLimitMB',
        // 界面皮肤（2026-11-18）：不在白名单里会被快照回推抹掉
        'skin',
        // 主题包（2026-11-20）：id + 这个包自带的配色（由 theme-pack-ipc 写入）
        'themePack',
        'themePackColors',
      ];
      for (const key of allowed) {
        if (!(key in patch)) continue;
        if (key === 'profileName') {
          settings.profileName = String(patch.profileName || '').slice(0, 24) || '大小姐';
        } else if (key === 'avatar') {
          settings.avatar = String(patch.avatar || '').slice(0, 500);
        } else if (key === 'theme') {
          if (['dark', 'light', 'system'].includes(patch.theme)) settings.theme = patch.theme;
          // 纯白已下线：老配置里的 white 落回浅色
          else if (patch.theme === 'white') settings.theme = 'light';
        } else if (key === 'skin') {
          if (['classic', 'midnight', 'sakura', 'frost', 'amber', 'ocean', 'sunset', 'forest', 'mono', 'golden', 'arctic', 'rose', 'tech', 'garden', 'galaxy'].includes(patch.skin)) {
            settings.skin = patch.skin;
          }
        } else if (key === 'themePack') {
          // 只做形状校验（合法 id / builtin），「包到底存不存在」由 theme-pack-ipc 判定：
          // 这里如果把不存在的包写进去，用户删了目录就会看到一片白图。
          const id = String(patch.themePack || '').trim();
          if (themePack.validId(id) || id === themePack.BUILTIN_ID) settings.themePack = id;
        } else if (key === 'themePackColors') {
          const raw = patch.themePackColors;
          const next = {};
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const colorKey of themePack.COLOR_KEYS) {
              const value = themePack.safeColor(raw[colorKey]);
              if (value) next[colorKey] = value;
            }
          }
          settings.themePackColors = next;
        } else if (key === 'accent') {
          if (['spark', 'gold', 'sakura', 'cyan', 'rose', 'jade', 'violet', 'amber'].includes(patch.accent)) {
            settings.accent = patch.accent;
          }
        } else if (key === 'sidebarCollapsed') {
          settings.sidebarCollapsed = patch.sidebarCollapsed === true;
        } else if (key === 'uiScale') {
          settings.uiScale = normalizeUiScale(patch.uiScale);
        } else if (key === 'quickPanelPinned') {
          settings.quickPanelPinned = patch.quickPanelPinned === true;
        } else if (key === 'alwaysAdmin') {
          settings.alwaysAdmin = patch.alwaysAdmin === true;
          // 重新打开这个开关＝用户愿意再看到授权窗口
          if (settings.alwaysAdmin) settings.elevationDeclined = false;
        } else if (key === 'elevationDeclined') {
          settings.elevationDeclined = patch.elevationDeclined === true;
        } else if (key === 'nevernessUseOfficialLauncher') {
          settings.nevernessUseOfficialLauncher = patch.nevernessUseOfficialLauncher !== false;
        } else if (key === 'closeAction') {
          /*
           * 关闭按钮的行为。字符串不能走下面那个 Boolean() 兜底（会被压成 true）。
           * null 是「还没选过」，允许清空，下次点关闭会重新问一遍。
           */
          if (patch.closeAction === 'tray' || patch.closeAction === 'quit') {
            settings.closeAction = patch.closeAction;
            settings.closeToTray = patch.closeAction === 'tray';
          } else if (patch.closeAction === null) {
            settings.closeAction = null;
          }
        } else if (key === 'endfieldPackRoot') {
          const dir = String(patch.endfieldPackRoot || '').trim();
          if (dir && fs.existsSync(dir)) settings.endfieldPackRoot = dir;
          if (!dir) settings.endfieldPackRoot = '';
        } else if (key === 'endfieldOfficialGamesExe') {
          // 官方启动器路径：必须是真实存在的 Games.exe，或留空恢复自动发现
          const exe = String(patch.endfieldOfficialGamesExe || '').trim();
          if (exe && fs.existsSync(exe) && /Games\.exe$/i.test(exe)) settings.endfieldOfficialGamesExe = exe;
          if (!exe) settings.endfieldOfficialGamesExe = '';
        } else if (key === 'starwardDbPath') {
          const dbPath = String(patch.starwardDbPath || '').trim();
          if (dbPath && fs.existsSync(dbPath)) settings.starwardDbPath = dbPath;
          if (!dbPath) settings.starwardDbPath = '';
        } else if (key === 'runtimeRoot') {
          const dir = String(patch.runtimeRoot || '').trim();
          settings.runtimeRoot = dir;
        } else if (key === 'material') {
          const value = String(patch.material || 'none');
          if (['none', 'acrylic', 'mica', 'micaTabbed', 'auto'].includes(value)) {
            settings.material = value;
          }
        } else if (key === 'customBackground') {
          // 只接受 <userData>/backgrounds/ 下的文件名，避免被写成任意路径
          const raw = String(patch.customBackground || '').trim();
          if (!raw) {
            settings.customBackground = '';
          } else {
            const base = path.basename(raw);
            // ef- 前缀是官方背景同步下来的（backgrounds/official/），custom- 是本地导入的
            if (
              /^(ef-[a-z]+[a-f0-9]{6}\.(png|jpe?g|webp)|custom-[0-9a-f-]{36}\.(png|jpe?g|webp|gif))$/i.test(base)
            ) {
              settings.customBackground = `backgrounds/${base}`;
            }
          }
        } else if (key === 'uiOpacity') {
          const value = Number(patch.uiOpacity);
          if (Number.isFinite(value)) settings.uiOpacity = Math.max(40, Math.min(100, Math.round(value)));
        } else if (key === 'backgroundOpacity') {
          const value = Number(patch.backgroundOpacity);
          if (Number.isFinite(value)) settings.backgroundOpacity = Math.max(0, Math.min(100, Math.round(value)));
        } else if (key === 'backgroundBlur') {
          const value = Number(patch.backgroundBlur);
          if (Number.isFinite(value)) settings.backgroundBlur = Math.max(0, Math.min(60, Math.round(value)));
        } else if (key === 'backgroundMotion') {
          settings.backgroundMotion = patch.backgroundMotion !== false;
        } else if (key === 'backgroundRotate') {
          settings.backgroundRotate = patch.backgroundRotate !== false;
        } else if (key === 'musicSources') {
          // 内置音源开关：只认下面这几个已知键，值只认布尔。
          // 2026-11-21 起第三方音源不再内置，不再接收第三方音源开关；
          // 酷狗已整条移除，老设置里遗留的 kugou 键在这里被丢掉，不再写回。
          const incoming = patch.musicSources;
          const next = {};
          if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
            for (const name of ['netease', 'migu', 'kuwo', 'qq', 'swap']) {
              if (typeof incoming[name] === 'boolean') next[name] = incoming[name];
            }
          }
          settings.musicSources = next;
          // 开关变了必须清换源缓存：否则某平台开着时赢下的地址还会缓存 20 分钟，
          // 关掉后同一首歌"仍然识别到那个音源"，用户以为停用没生效
          clearMusicResolveCache();
        } else if (key === 'musicCustomSources') {
          const list = Array.isArray(patch.musicCustomSources) ? patch.musicCustomSources : [];
          settings.musicCustomSources = list
            .filter((def) => validateCustomSource(def).ok)
            .slice(0, 20)
            .map((def) => ({
              id: String(def.id || def.name || '').slice(0, 60),
              name: String(def.name || def.id || '').slice(0, 60),
              search: def.search,
              url: def.url,
              headers: def.headers && typeof def.headers === 'object' ? def.headers : undefined,
              enabled: def.enabled !== false,
            }));
          // 启停第三方音源同理（导入那条路已经清了，这里补启停/删除）
          clearMusicResolveCache();
        } else if (key === 'updateManifest') {
          settings.updateManifest = String(patch.updateManifest || '').trim().slice(0, 500);
        } else if (key === 'updateSourceMode') {
          // 只认这几种，别的值一律回到「自动」——多一个拼错的值就会让更新链变哑巴。
          const mode = String(patch.updateSourceMode || '').trim();
          settings.updateSourceMode = ['auto', 'gitee', 'gitcode', 'jsdelivr', 'github', 'custom'].includes(mode)
            ? mode
            : 'auto';
        } else if (key === 'proxyRules') {
          settings.proxyRules = normalizeProxyRules(patch.proxyRules);
        } else if (key === 'autoCheckUpdate') {
          settings.autoCheckUpdate = patch.autoCheckUpdate !== false;
        } else if (key === 'notesSeenVersion') {
          // 更新公告弹窗「看过了」的版本号：存到 settings 里，跟着 launcher-data.json 走，
          // 所以升级覆盖 resources/app 之后这个标记不会丢，同一个版本只弹一次。
          settings.notesSeenVersion = String(patch.notesSeenVersion || '').trim().replace(/^v/i, '').slice(0, 32);
        } else if (key === 'updateSnoozeVersion') {
          settings.updateSnoozeVersion = String(patch.updateSnoozeVersion || '').trim().replace(/^v/i, '').slice(0, 32);
        } else if (key === 'updateSnoozeUntil') {
          settings.updateSnoozeUntil = Number(patch.updateSnoozeUntil) || 0;
        } else if (key === 'downloadLimitKBps') {
          /*
           * 下载限速。上限按 100 MB/s 截：再高已经超过家用宽带上限，
           * 而填个天文数字只会让「限速开着」变成摆设。0 = 不限速。
           */
          const value = Number(patch.downloadLimitKBps);
          settings.downloadLimitKBps = Number.isFinite(value)
            ? Math.max(0, Math.min(102400, Math.round(value)))
            : 0;
        } else if (key === 'musicCacheLimitMB') {
          // 音乐缓存上限（MB）：0 = 不缓存，51200 = 50 GB 封顶
          const value = Number(patch.musicCacheLimitMB);
          settings.musicCacheLimitMB = Number.isFinite(value)
            ? Math.max(0, Math.min(51200, Math.round(value)))
            : 2048;
        } else if (key === 'downloadDir') {
          const dir = String(patch.downloadDir || '').trim();
          if (dir) {
            await fsp.mkdir(dir, { recursive: true });
            settings.downloadDir = dir;
          }
        } else if (key === 'lastPage') {
          if (
            [
              'home',
              'start',
              'library',
              'servers',
              'gacha',
              'song',
              'downloads',
              'news',
              'announcements',
              'settings',
            ].includes(patch.lastPage)
          ) {
            settings.lastPage = patch.lastPage;
          }
        } else if (key === 'audioLanguages') {
          // 必须是数组：兜底分支走的是 Boolean()，数组会被压成 true
          settings.audioLanguages = normalizeAudioLanguages(patch.audioLanguages);
        } else {
          settings[key] = Boolean(patch[key]);
        }
      }
      applyNativeTheme(settings.theme);
      applyLoginItem(settings);
      applyTitlebar();
      applyUiScale(settings.uiScale);
      // 先推状态再写盘：渲染进程要的是设置本身，没必要等磁盘 IO。
      // 原来顺序反了，机械盘上点一次主题要等几十毫秒才有反应。
      pushState(true);
      await getStore().saveNow();
      // 代理改完立刻生效，不用重启：用户点保存就能看到联网行为变化
      if ('proxyRules' in patch) await applyProxySettings();
      // 限速同理：立刻生效，正在跑的下载下一块就按新上限走（不用等下次下载）
      if ('downloadLimitKBps' in patch) applyDownloadLimit();
      return snapshot();
    });

    ipcMain.handle('settings:export', async () => {
      try {
        const source = dataFile();
        if (!fs.existsSync(source)) throw new Error('还没生成设置文件，先改个设置再导出');
        const result = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : undefined, {
          title: '导出启动器设置',
          defaultPath: path.join(app.getPath('downloads') || app.getPath('userData'), '花筱灵设置.json'),
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
        await fsp.copyFile(source, result.filePath);
        const stat = await fsp.stat(result.filePath);
        return { ok: true, path: result.filePath, bytes: stat.size };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });

    ipcMain.handle('settings:import', async () => {
      try {
        const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
          title: '导入启动器设置',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePaths || !result.filePaths.length) {
          return { ok: false, cancelled: true };
        }
        const file = result.filePaths[0];
        const raw = await fsp.readFile(file, 'utf8');
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return { ok: false, error: '文件不是合法的 JSON' };
        }
        if (!parsed || typeof parsed !== 'object') return { ok: false, error: '文件内容不是设置数据' };
        // 只认可顶层带 settings 的启动器数据文件，避免误导入别的东西把配置冲了
        if (!parsed.settings || typeof parsed.settings !== 'object') {
          return { ok: false, error: '这份文件不是启动器设置备份（缺少 settings 字段）' };
        }
        const merged = { ...getStore().data, settings: { ...getStore().data.settings, ...parsed.settings } };
        getStore().data = merged;
        await getStore().saveNow();
        pushState(true);
        return { ok: true, path: file };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
}

module.exports = { installSettingsIpc };
