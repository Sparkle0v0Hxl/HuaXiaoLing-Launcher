'use strict';

/**
 * 异环（Neverness to Everness，builtinKey = neverness）官服 / B服 渠道切换。
 *
 * ⚠️ 这套东西**不能**照搬米哈游那套（sophon.js 的 CHANNELS / prepareBilibiliRuntime）：
 *   - 异环是 Hotta Studio（完美世界）自研的 UE5 客户端，走自己家的 NTELauncher.exe，
 *     没有 Hyp 体系、没有 Sophon 清单。切渠道**不动游戏文件**，只改启动器配置。
 *
 * 切换方式（2026-10 从社区「异环双服切换器」逆向确认，此前"PC 不支持 B服"的判断是错的）：
 *   文件：<游戏安装目录>/NTELauncher/Config/Config.ini
 *   官服：Branch=publish_ob     serialNumber=1（或空）  + 版本清单 URL 指 publish_ob CDN
 *   B服 ：Branch=publish_ob_B   serialNumber=2  Partner=123 + 版本清单 URL 指 publish_ob_B CDN
 *   官方启动器重启后按清单 URL 自动下载对应渠道资源（切 B服首次有几 GB 下载），PC 端 B服可正常登录。
 *
 * 必须让用户知道的三件事（写进返回值的 notice，界面要显示）：
 *   1. 两个服账号体系完全独立：官服 = 完美世界账号，B服 = B站账号，数据/好友/联机全不互通。
 *   2. 切换前必须完全退出官方启动器（含托盘薄荷图标）——启动器退出时会用内存里的旧配置回写，
 *      这就是"切了没效果/又被改回去"的根因。
 *   3. 切 B服后首次打开官方启动器会自动下载 B服资源，等下载完再进游戏。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const NEVERNESS_CHANNELS = [
  ['official', '官服'],
  ['bilibili', 'B服'],
];

/**
 * 渠道配置（2026-10 逆向自社区的「异环双服切换器」，不再是纯配置层猜测）：
 *   官服特征：serialNumber 为空或 1，Branch 不含 _B
 *   B服特征：serialNumber=2，Branch 含 _B，Partner=123
 * 除 Branch/serialNumber/Partner 外，还要把启动器的版本清单 URL 指到对应渠道的 CDN：
 *   官服 publish_ob / B服 publish_ob_B——启动器重启后按这个清单自动下载该渠道的资源
 *   （首次切 B服会触发一次几 GB 的下载，属于正常流程，不是切坏了）。
 */
const CHANNEL_CONFIG = {
  official: {
    Branch: 'publish_ob',
    serialNumber: '1',
    VersionInfoFileURL: 'https://yhcdn1.wmupd.com/hd/publish_ob/launcher/Version.ini',
    BackupVersionURL: 'https://yhcdn2.wmupd.com/hd/publish_ob/launcher/Version.ini',
  },
  bilibili: {
    Branch: 'publish_ob_B',
    serialNumber: '2',
    Partner: '123',
    VersionInfoFileURL: 'https://yhcdn1.wmupd.com/hd/publish_ob_B/launcher/Version.ini',
    BackupVersionURL: 'https://yhcdn2.wmupd.com/hd/publish_ob_B/launcher/Version.ini',
  },
};

/** 相对游戏安装目录的启动器配置文件。 */
const CONFIG_RELATIVE = ['NTELauncher', 'Config', 'Config.ini'];

const NOTICE =
  '官服与 B服账号体系完全独立（完美世界账号 / B站账号），数据、好友、联机都不互通。' +
  '切到 B服后，官方启动器会自动下载 B服资源（首次切换有一次几 GB 的下载），下载完用 B站账号登录即可。' +
  '切换前必须完全退出异环官方启动器（含右下角托盘的薄荷图标），否则启动器退出时会把配置改回去。';

/** 官方启动器在运行时不能切换：它退出时会用内存里的旧配置覆盖 Config.ini。 */
async function assertLauncherClosed() {
  const names = ['NTELauncher.exe', 'NTEGame.exe', 'HTGame.exe'];
  const running = [];
  for (const name of names) {
    try {
      const stdout = await new Promise((resolve, reject) => {
        require('node:child_process').execFile(
          'tasklist.exe',
          ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'],
          { windowsHide: true, timeout: 5000 },
          (error, output, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(output))
        );
      });
      if (new RegExp(`^"${name}"`, 'im').test(String(stdout))) running.push(name);
    } catch {
      /* tasklist 挂了就不拦，让切换继续（和以前行为一致） */
    }
  }
  if (running.length) {
    throw new Error(
      `检测到异环还在运行（${running.join('、')}）。请先完全退出游戏和官方启动器——` +
        '右下角托盘的薄荷图标也要右键退出，否则启动器关闭时会把服务器配置改回去。'
    );
  }
}

/**
 * 从游戏路径往上找 NTELauncher/Config/Config.ini。
 * server.path 一般是 ...\Client\WindowsNoEditor\HT\Binaries\Win64\HTGame.exe，
 * 启动器配置在安装根目录（有 NTELauncher 文件夹的那层）。
 */
function findConfigRoot(startPath, levels = 8) {
  let dir = startPath;
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  } catch {
    /* keep going */
  }
  for (let level = 0; level < levels && dir; level += 1) {
    const candidate = path.join(dir, ...CONFIG_RELATIVE);
    if (fs.existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

function configPathOf(root) {
  return path.join(root, ...CONFIG_RELATIVE);
}

/** 极简 ini 解析：只关心 key=value，注释和分区头原样保留。 */
function parseIni(text) {
  const values = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    values.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim());
  }
  return values;
}

/** 改 key=value，键存在就替换，不存在就追加；其他行一律不动。 */
function applyIniValues(text, patch) {
  const lines = String(text || '').split(/\r?\n/);
  const seen = new Set();
  const next = lines.map((line) => {
    const trimmed = line.trim();
    const index = trimmed.indexOf('=');
    if (index <= 0 || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('[')) return line;
    const key = trimmed.slice(0, index).trim();
    if (!(key in patch)) return line;
    seen.add(key);
    return `${key}=${patch[key]}`;
  });
  for (const [key, value] of Object.entries(patch)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  return next.join('\n');
}

function channelFromValues(values) {
  const branch = String(values.get('Branch') || '');
  if (/^publish_ob[_-]?b$/i.test(branch) || /_b$/i.test(branch)) return 'bilibili';
  if (branch) return 'official';
  // 没有 Branch 时退回 serialNumber 判断
  return String(values.get('serialNumber') || '') === '2' ? 'bilibili' : 'official';
}

/**
 * 读当前渠道。
 * @returns {{supported:boolean, channel:string, root:string, file:string, values:Object, notice:string, error?:string}}
 */
async function readNevernessChannel({ installRoot, gamePath }) {
  const root = findConfigRoot(installRoot || gamePath || '');
  if (!root) {
    return {
      supported: true,
      state: 'not-found',
      channel: '',
      root: '',
      file: '',
      reason: '没有找到异环启动器配置（NTELauncher/Config/Config.ini），请先在启动器里指好异环的安装目录',
      notice: NOTICE,
    };
  }
  const file = configPathOf(root);
  try {
    const text = await fsp.readFile(file, 'utf8');
    const values = parseIni(text);
    return {
      supported: true,
      state: 'ok',
      channel: channelFromValues(values),
      root,
      file,
      branch: String(values.get('Branch') || ''),
      serialNumber: String(values.get('serialNumber') || ''),
      partner: String(values.get('Partner') || ''),
      notice: NOTICE,
    };
  } catch (error) {
    return { supported: true, state: 'error', channel: '', root, file, error: error.message, notice: NOTICE };
  }
}

/**
 * 切换渠道。写 Branch / serialNumber / Partner / VersionInfoFileURL / BackupVersionURL，
 * 其余配置原样保留；切回官服时把 Partner 清掉，避免残留。
 * 切换前检查官方启动器是否在运行——在运行时切换会被启动器退出时的回写覆盖掉。
 */
async function setNevernessChannel({ installRoot, gamePath, channel }) {
  const target = CHANNEL_CONFIG[channel];
  if (!target) throw new Error(`异环没有这个渠道：${channel || '(空)'}`);
  await assertLauncherClosed();
  const found = await readNevernessChannel({ installRoot, gamePath });
  if (found.state === 'not-found') throw new Error(found.reason);
  if (found.channel === channel) {
    return { ok: true, changed: false, channel, root: found.root, file: found.file, notice: NOTICE };
  }
  const file = found.file;
  const text = await fsp.readFile(file, 'utf8');
  const patch = { ...target };
  if (channel !== 'bilibili') patch.Partner = '';
  const next = applyIniValues(text, patch);
  await fsp.rm(file, { force: true });
  await fsp.writeFile(file, next, 'utf8');
  const after = await readNevernessChannel({ installRoot, gamePath });
  const extra =
    channel === 'bilibili'
      ? '已切到 B服：重新打开异环启动器，它会自动下载 B服资源（首次有几 GB，耐心等下载完）。'
      : '已切回官服：重新打开异环启动器即可。';
  return {
    ok: true,
    changed: true,
    channel: after.channel,
    root: found.root,
    file,
    branch: after.branch,
    serialNumber: after.serialNumber,
    partner: after.partner,
    notice: `${NOTICE} ${extra}`,
  };
}

module.exports = {
  NEVERNESS_CHANNELS,
  CHANNEL_CONFIG,
  NOTICE,
  assertLauncherClosed,
  findConfigRoot,
  readNevernessChannel,
  setNevernessChannel,
};
