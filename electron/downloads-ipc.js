'use strict';

const { ipcMain, app, shell } = require('electron');
const path = require('node:path');
const gameFeatures = require('./game-features');
const pluginHost = require('./plugin-host');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');


/**
 * 下载队列。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 *
 * ⚠ 下载队列实例（DownloadManager 的实例）在 main.js 里是 `let downloads`，
 * 要等 store 就绪、在启动流程后段才 new 出来，而 installIpc() 更早跑。
 * 所以这里**不能**在模块顶层 `require('./downloads')` 然后直接调 .add() ——
 * 那样拿到的是模块对象（只有 { DownloadManager } 这个类），
 * 一调 .add() 就 TypeError。必须通过 ctx.getDownloads() 每次现取实例。
 */

function installDownloadsIpc(ctx) {
  const { ensureDownloadsDir, safeFileName, uniquePath, pushState } = ctx;
  const getDownloads = () => {
    const dm = typeof ctx.getDownloads === 'function' ? ctx.getDownloads() : null;
    if (!dm) throw new Error('下载队列还没准备好，请稍后再试');
    return dm;
  };

    ipcMain.handle('downloads:add', async (_event, input) => {
      const downloads = getDownloads();
      const dir = await ensureDownloadsDir();
      const rawUrl = String(input && input.url ? input.url : '').trim();
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        throw new Error('请输入有效的下载链接');
      }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http 或 https 链接');

      let fileName = String(input && input.fileName ? input.fileName : '').trim();
      if (!fileName) {
        try {
          fileName = decodeURIComponent(path.basename(parsed.pathname)) || 'download';
        } catch {
          fileName = 'download';
        }
      }
      fileName = safeFileName(fileName);
      const finalPath = uniquePath(dir, fileName);

      const item = downloads.add({
        url: parsed.href,
        fileName: path.basename(finalPath),
        filePath: finalPath,
        dir,
        total: 0,
        received: 0,
        status: 'queued',
        speed: 0,
        error: null,
        createdAt: Date.now(),
      });
      downloads.start(item.id);
      pushState(true);
      return item;
    });

    ipcMain.handle('downloads:pause', (_event, id) => getDownloads().pause(id));
    ipcMain.handle('downloads:resume', (_event, id) => getDownloads().resume(id));
    ipcMain.handle('downloads:cancel', async (_event, id) => getDownloads().cancel(id));
    ipcMain.handle('downloads:remove', async (_event, id) => getDownloads().remove(id));
    ipcMain.handle('downloads:open', async (_event, id) => getDownloads().open(id));
    ipcMain.handle('downloads:open-folder', async (_event, id) => getDownloads().openFolder(id));

    /* ---------------- 游戏能力注册表 ---------------- */
    /*
     * 渲染层通过这三个通道拿到「哪些游戏支持哪些功能」，
     * 从而不必在 app.js 里散落 if (game === 'genshin') 之类的判断。
     * 以后加游戏只改 electron/game-features.js，前端自动跟随。
     */
    ipcMain.handle('features:all', async () => gameFeatures.describeAll());
    ipcMain.handle('features:describe', async (_event, gameKey) => gameFeatures.describe(gameKey));
    ipcMain.handle('features:by-category', async () => gameFeatures.featuresByCategory());

    /* ---------------- 用户自定义插件 ---------------- */
    /*
     * 打开插件开发说明。
     *
     * 用户目录里那份是给「写插件的人」看的随包文档；它可能被用户删掉或者
     * 从没装过（比如只装了示例插件没要说明），所以找不到就退回打开插件目录，
     * 至少让用户看见 .hxl 文件长什么样，别弹一个「文件不存在」的死路。
     */
    ipcMain.handle('plugin:open-doc', async () => {
      const dir = pluginHost.pluginsDir(app.getPath('userData'));
      await fsp.mkdir(dir, { recursive: true });
      const doc = path.join(dir, 'README.md');
      const exists = await fsp
        .access(doc)
        .then(() => true)
        .catch(() => false);
      const target = exists ? doc : dir;
      const reason = await shell.openPath(target);
      return { ok: !reason, path: target, error: reason || '' };
    });
}

module.exports = { installDownloadsIpc };
