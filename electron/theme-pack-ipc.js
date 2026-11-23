'use strict';

const { ipcMain, shell, app, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const themePack = require('./theme-pack');

/*
 * 主题包 IPC（2026-11-20）
 *
 * 渲染层只需要四件事：
 *   theme:list      列出所有能用的包（内置包永远第一）
 *   theme:apply     切到某个包（顺带把它的皮肤/强调色/配色写进 settings）
 *   theme:refresh   用户刚往目录里丢了新包，重新扫一遍
 *   theme:open      打开 art-pack 目录，方便用户把包拖进去
 *
 * 配色注入不走这里：theme:apply 会把 colors 落到 settings.themePackColors，
 * 渲染层 applySettings() 统一从快照里读并 setProperty —— 重启后不用再拉一次。
 */

/** 当前包的自定义配色。内置包或没有配色就是空对象（渲染层据此不覆盖主题变量）。 */
function activeColors(store) {
  const settings = store && store.data ? store.data.settings : null;
  const colors = settings && settings.themePackColors;
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return {};
  const out = {};
  for (const key of themePack.COLOR_KEYS) {
    const value = themePack.safeColor(colors[key]);
    if (value) out[key] = value;
  }
  return out;
}

/** 当前选中的用户主题包 id；内置包返回空串（内置素材不允许被覆盖）。 */
function activePackId(store) {
  const settings = store && store.data ? store.data.settings : null;
  const id = String((settings && settings.themePack) || themePack.BUILTIN_ID);
  return id === themePack.BUILTIN_ID ? '' : id;
}

/** 老平铺布局 userData/art-pack/<名字>.png 里已经存在的图（用来覆盖内置图，不动安装包）。 */
function flatAssets(userData) {
  const root = themePack.packRoot(userData);
  const out = [];
  for (const name of themePack.ART_NAMES) {
    try {
      if (fs.statSync(path.join(root, name)).isFile()) out.push(name);
    } catch {
      /* 没有这张 */
    }
  }
  return out;
}

/**
 * 启动时把磁盘上那个包的清单重新读一遍，纠正 settings 里可能过期的配色。
 * 用户手改 theme.json（或直接换掉整个目录）之后不用额外操作就能生效。
 */
function syncActive(store, userData) {
  const settings = store && store.data ? store.data.settings : null;
  if (!settings) return { changed: false };
  const id = String(settings.themePack || themePack.BUILTIN_ID);
  if (id === themePack.BUILTIN_ID) {
    if (settings.themePackColors && Object.keys(settings.themePackColors).length) {
      settings.themePackColors = {};
      return { changed: true };
    }
    return { changed: false };
  }
  const pack = themePack.findPack(userData, id);
  if (!pack) {
    // 包被删了：静默回落内置，不弹错（用户自己的目录他随时能删）
    settings.themePack = themePack.BUILTIN_ID;
    settings.themePackColors = {};
    return { changed: true, dropped: id };
  }
  const next = { ...pack.colors };
  const prev = activeColors(store);
  const same = JSON.stringify(next) === JSON.stringify(prev);
  if (same) return { changed: false, pack };
  settings.themePackColors = next;
  return { changed: true, pack };
}

function installThemePackIpc(ctx) {
  const { pushState, getStore } = ctx;
  const userData = () => (typeof ctx.userData === 'function' ? ctx.userData() : app.getPath('userData'));
  const store = () => (typeof getStore === 'function' ? getStore() : null);

  ipcMain.handle('theme:list', async () => {
    try {
      const s = store();
      const settings = s && s.data ? s.data.settings : {};
      const packs = themePack.listPacks(userData()).map(themePack.publicPack);
      return {
        ok: true,
        packs,
        active: String(settings.themePack || themePack.BUILTIN_ID),
        colors: activeColors(s),
        flat: flatAssets(userData()),
        dir: themePack.packRoot(userData()),
      };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('theme:refresh', async () => {
    try {
      const s = store();
      const result = syncActive(s, userData());
      if (result.changed) pushState(true);
      const settings = s && s.data ? s.data.settings : {};
      return {
        ok: true,
        packs: themePack.listPacks(userData()).map(themePack.publicPack),
        active: String(settings.themePack || themePack.BUILTIN_ID),
        colors: activeColors(s),
        flat: flatAssets(userData()),
        changed: result.changed === true,
      };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('theme:apply', async (_event, input) => {
    try {
      const s = store();
      if (!s || !s.data || !s.data.settings) return { ok: false, error: '设置还没加载' };
      const id = String((input && input.id) || '').trim();
      if (!id) return { ok: false, error: '缺少主题包 id' };

      const settings = s.data.settings;
      if (id === themePack.BUILTIN_ID) {
        settings.themePack = themePack.BUILTIN_ID;
        settings.themePackColors = {};
      } else {
        const pack = themePack.findPack(userData(), id);
        if (!pack) return { ok: false, error: '没找到这个主题包（目录可能已被删除）' };
        settings.themePack = pack.id;
        settings.themePackColors = { ...pack.colors };
        // 包里指定了皮肤/强调色就跟着走；没指定就保持用户当前选择
        if (pack.skin && themePack.SKIN_IDS.includes(pack.skin)) settings.skin = pack.skin;
        if (pack.accent && themePack.ACCENT_IDS.includes(pack.accent)) settings.accent = pack.accent;
      }
      // JsonStore 的 save() 是 400ms 防抖、返回 undefined；这里要「切完立刻落盘」
      if (typeof s.saveNow === 'function') await s.saveNow();
      else if (typeof s.save === 'function') s.save();
      pushState(true);
      return {
        ok: true,
        active: settings.themePack,
        skin: settings.skin,
        accent: settings.accent,
        colors: activeColors(s),
      };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  /*
   * 素材编辑（2026-11-22）：让用户自己在设置页换图，不用每次改文件重打包。
   *   theme:asset-pick   选一张 PNG 覆盖到当前包的某个槽位
   *   theme:asset-clear  删掉当前包某个槽位的图，回落内置
   *   theme:pack-create  新建主题包（可复制当前包，也可空白）
   */
  ipcMain.handle('theme:asset-pick', async (event, input) => {
    try {
      const name = String((input && input.name) || '');
      if (!themePack.ART_NAME_SET.has(name)) return { ok: false, error: '这个文件名不在主题包白名单里' };
      const id = activePackId(store());
      /*
       * 内置包也能改：写到老平铺布局 userData/art-pack/<name>.png，
       * 协议解析顺序里它排在「选定主题包之后、内置图之前」，所以覆盖生效但不破坏安装包。
       * 品牌头像（character-face.png）任何情况下都只能走平铺（包里那张会被忽略）。
       */
      const useFlat = !id || name === 'character-face.png';

      const win = BrowserWindow.fromWebContents(event.sender);
      const picked = await dialog.showOpenDialog(win, {
        title: '选择「' + name + '」的新图',
        properties: ['openFile'],
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return { ok: false, canceled: true };
      const src = picked.filePaths[0];
      const stat = fs.statSync(src);
      if (!stat.isFile()) return { ok: false, error: '选中的不是文件' };
      if (stat.size > 12 * 1024 * 1024) return { ok: false, error: '图片超过 12MB，换小一点的' };

      const root = themePack.packRoot(userData());
      // 包里改图写进 _custom，包自带原图保持不动，「还原」删掉这层就回到包自己的图
      const dir = useFlat ? root : path.join(root, id, themePack.CUSTOM_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(src, path.join(dir, name));
      return { ok: true, name, bytes: stat.size, mode: useFlat ? 'flat' : 'pack' };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('theme:asset-clear', async (_event, input) => {
    try {
      const name = String((input && input.name) || '');
      if (!themePack.ART_NAME_SET.has(name)) return { ok: false, error: '这个文件名不在主题包白名单里' };
      const id = activePackId(store());
      const useFlat = !id || name === 'character-face.png';
      const file = useFlat
        ? path.join(themePack.packRoot(userData()), name)
        : path.join(themePack.packRoot(userData()), id, themePack.CUSTOM_DIR, name);
      let removed = false;
      try {
        fs.unlinkSync(file);
        removed = true;
      } catch (error) {
        // 本来就没有这张（ENOENT / 路径里某段不是目录）视作已还原；
        // 其它错误（文件被占用、权限不足）必须暴露，不能吞掉骗 UI 说成功了。
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
          removed = false;
        } else {
          return { ok: false, error: '还原失败：' + String(error && error.message ? error.message : error) };
        }
      }
      return { ok: true, name, removed };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('theme:pack-create', async (_event, input) => {
    try {
      const s = store();
      const settings = s && s.data ? s.data.settings : {};
      const name = String((input && input.name) || '').trim().slice(0, 40) || '我的主题包';
      const from = String((input && input.copyFrom) || '');
      const root = themePack.packRoot(userData());
      const id = 'pack-' + Date.now().toString(36) + Math.floor(Math.random() * 90 + 10);
      const dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });

      let colors = {};
      if (from && themePack.validId(from) && from !== themePack.BUILTIN_ID) {
        const srcPack = themePack.findPack(userData(), from);
        if (srcPack) colors = { ...srcPack.colors };
        for (const file of themePack.ART_NAMES) {
          try {
            fs.copyFileSync(path.join(root, from, file), path.join(dir, file));
          } catch {
            /* 源包没有这张就跳过 */
          }
        }
      }

      const manifest = {
        name,
        author: '',
        description: '自建主题包',
        version: '1.0',
        skin: themePack.SKIN_IDS.includes(settings.skin) ? settings.skin : 'classic',
        accent: themePack.ACCENT_IDS.includes(settings.accent) ? settings.accent : 'spark',
        colors,
      };
      fs.writeFileSync(path.join(dir, themePack.MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
      return { ok: true, id, name };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('theme:open', async () => {
    try {
      const dir = themePack.packRoot(userData());
      const fs = require('node:fs');
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* 目录已在就算了 */
      }
      const err = await shell.openPath(dir);
      return err ? { ok: false, error: path.basename(String(err)) } : { ok: true, dir };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });
}

module.exports = { installThemePackIpc, syncActive, activeColors };
