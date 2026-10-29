'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const AES_KEY = Buffer.from([
  192, 243, 14, 28, 231, 99, 187, 194, 28, 195, 85, 163, 67, 3, 172, 80, 57, 148, 68,
  191, 246, 140, 74, 34, 175, 57, 140, 10, 22, 110, 225, 67,
]);
const AES_IV = Buffer.from([
  51, 70, 120, 97, 25, 39, 80, 100, 149, 1, 147, 114, 100, 96, 132, 0,
]);

const COMMON_ROOT = ['U8CoreUI.dll', 'U8SDK.dll', 'u8_channel.dll'];
const COMMON_DIRS = ['sdkdata/', 'U8Data/config/'];

const PROFILES = [
  {
    iconName: 'Endfield',
    directory: 'EndOfficial',
    api: 'https://launcher.hypergryph.com/api/proxy/batch_proxy',
    appcode: '6LL0KJuqHBVz33WK',
    launcherAppcode: 'abYeZZ16BPluCFyT',
    channel: '1',
    subChannel: '1',
    seq: '5',
    rootFiles: [...COMMON_ROOT, 'eld_Endfield.db', 'hgsdk.dll', 'OneChannelLC.dll', 'HGP.dll'],
    dirs: COMMON_DIRS,
  },
  {
    iconName: 'BiliEndfield',
    directory: 'EndBilibili',
    api: 'https://launcher.hypergryph.com/api/proxy/batch_proxy',
    appcode: '6LL0KJuqHBVz33WK',
    launcherAppcode: 'abYeZZ16BPluCFyT',
    channel: '2',
    subChannel: '2',
    seq: '5',
    rootFiles: [...COMMON_ROOT, 'eld_Endfield.db', 'PCGameSDK.dll', 'OneChannelLC.dll', 'HGP.dll'],
    dirs: ['BLPlatform64/', 'U8Data/config/'],
  },
  {
    iconName: 'GlobalEndfield',
    directory: 'EndGlobal',
    api: 'https://launcher.gryphline.com/api/proxy/batch_proxy',
    appcode: 'YDUTE5gscDZ229CW',
    launcherAppcode: 'YDUTE5gscDZ229CW',
    channel: '6',
    subChannel: '6',
    seq: '3',
    rootFiles: [...COMMON_ROOT, 'gfsdk.dll', 'glfoundation.dll', 'OneChannelLC.dll', 'HGP.dll'],
    dirs: COMMON_DIRS,
  },
  {
    iconName: 'PlayEndfield',
    directory: 'EndPlay',
    api: 'https://launcher.gryphline.com/api/proxy/batch_proxy',
    appcode: 'YDUTE5gscDZ229CW',
    launcherAppcode: 'YDUTE5gscDZ229CW',
    channel: '6',
    subChannel: '802',
    seq: '3',
    rootFiles: [
      ...COMMON_ROOT,
      'gfsdk.dll',
      'glextra.dll',
      'glfoundation.dll',
      'manifest.xml',
      'play_pc_sdk.dll',
      'OneChannelLC.dll',
      'HGP.dll',
    ],
    dirs: COMMON_DIRS,
  },
  {
    iconName: 'SteamEndfield',
    directory: 'EndSteam',
    api: 'https://launcher.gryphline.com/api/proxy/batch_proxy',
    appcode: 'YDUTE5gscDZ229CW',
    launcherAppcode: 'YDUTE5gscDZ229CW',
    channel: '6',
    subChannel: '803',
    seq: '3',
    rootFiles: [
      ...COMMON_ROOT,
      'gfsdk.dll',
      'glextra.dll',
      'glfoundation.dll',
      'HGP.dll',
      'steam_api64.dll',
      'steam_appid.txt',
    ],
    dirs: COMMON_DIRS,
  },
  {
    /*
     * 明日方舟 PC 端（2026-02-10 技术测试，2026-09-14 正式上线）。
     *
     * appcode 不是公开常量，是从鹰角启动器日志里读出来的：
     *   %USERPROFILE%\AppData\LocalLow\Hypergryph\<hash>\logs\games.log
     *   → strAppCode:GzD1CpaWgmSq1wew, strGameVersion:78.0.0, 入口 lights.exe
     *
     * 和终末地同构：base 下的加密逐文件清单（GET <base>/game_files）能读到，
     * 实测 13749 个文件 / 25.4GB，所以走同一套增量更新逻辑。
     * 接口另外还会给 20 个分卷 ZIP（43.7GB），那是整包重装用的，这里不用。
     */
    iconName: 'Arknights',
    directory: 'Arknights',
    api: 'https://launcher.hypergryph.com/api/proxy/batch_proxy',
    appcode: 'GzD1CpaWgmSq1wew',
    launcherAppcode: 'abYeZZ16BPluCFyT',
    channel: '1',
    subChannel: '1',
    seq: '5',
    rootFiles: [...COMMON_ROOT, 'eld_Arknights.db', 'hgsdk.dll', 'OneChannelLC.dll'],
    dirs: COMMON_DIRS,
    entry: 'Arknights.exe',
  },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function decryptManifest(encrypted) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, AES_IV);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** 与 decryptManifest 配对：鹰角本地的 config.ini 也是同一套 AES 加密。 */
function encryptManifest(text) {
  const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, AES_IV);
  return Buffer.concat([cipher.update(Buffer.from(String(text), 'utf8')), cipher.final()]);
}

function parseManifest(text) {
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let node;
    try {
      node = JSON.parse(line);
    } catch {
      continue;
    }
    if (!node?.path || !node?.md5) continue;
    const normalized = String(node.path).replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.includes('..')) continue;
    files.push({
      path: normalized,
      urlPath: normalized,
      md5: String(node.md5).toLowerCase(),
      size: Number(node.size) || 0,
    });
  }
  return files;
}

function isAllowed(profile, relative) {
  if (profile.rootFiles.some((name) => name.toLowerCase() === relative.toLowerCase())) {
    return true;
  }
  return profile.dirs.some((prefix) => relative.toLowerCase().startsWith(prefix.toLowerCase()));
}

async function fetchLatest(profile) {
  const body = {
    seq: profile.seq,
    proxy_reqs: [
      {
        kind: 'get_latest_game',
        get_latest_game_req: {
          appcode: profile.appcode,
          launcher_appcode: profile.launcherAppcode,
          channel: profile.channel,
          sub_channel: profile.subChannel,
          version: '',
        },
      },
    ],
  };
  const response = await fetch(profile.api, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${profile.iconName} 版本接口 HTTP ${response.status}`);
  const json = await response.json();
  const latest = (json.proxy_rsps || []).find(
    (item) => item.kind === 'get_latest_game' && item.get_latest_game_rsp
  )?.get_latest_game_rsp;
  const base = latest?.pkg?.file_path;
  const version = latest?.version;
  if (!base || !version) throw new Error(`${profile.iconName} 接口没有返回文件清单地址`);
  const packs = Array.isArray(latest?.pkg?.packs) ? latest.pkg.packs : [];
  return {
    version: String(version),
    clientVersion: latest?.client_version ? String(latest.client_version) : '',
    base: String(base).replace(/\/$/, ''),
    totalSize: Number(latest?.pkg?.total_size) || 0,
    packs: packs.map((pack) => ({
      url: String(pack.url || ''),
      md5: String(pack.md5 || '').toLowerCase(),
      size: Number(pack.package_size) || 0,
    })),
  };
}

async function loadRemoteManifest(profile, allFiles = false) {
  const latest = await fetchLatest(profile);
  const response = await fetch(`${latest.base}/game_files`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`${profile.iconName} 清单 HTTP ${response.status}`);
  const encrypted = Buffer.from(await response.arrayBuffer());
  const parsed = parseManifest(decryptManifest(encrypted));
  const files = allFiles ? parsed : parsed.filter((file) => isAllowed(profile, file.path));
  if (!files.length) throw new Error(`${profile.iconName} 清单里没有渠道文件`);
  return {
    version: latest.version,
    base: latest.base,
    manifestSha256: crypto.createHash('sha256').update(encrypted).digest('hex').toUpperCase(),
    files,
  };
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, buffer);
  return buffer;
}

async function downloadToFile(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const file = fs.createWriteStream(destination);
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  await pipeline(Readable.fromWeb(response.body), file);
  return destination;
}

/**
 * 分卷 ZIP 整包下载（「全新安装 / 文件全坏」时兜底）。
 *
 * 常规增量更新走加密逐文件清单（loadRemoteManifest），比整包省得多：
 * 明日方舟整包 43.7GB / 20 卷，逐文件清单只有 25.4GB 且能按 md5 跳过已有文件。
 * 注意清单地址是 `file_path + '/game_files'`，单独请求 `file_path` 会 404。
 *
 * 解压需要 7-Zip；优先用鹰角启动器自带的 7zg.exe。
 */
function findSevenZip(launcherRoot = 'C:\\Program Files\\Hypergryph Launcher') {
  const candidates = [
    path.join(launcherRoot, '1.6.0', '7zg.exe'),
    path.join(launcherRoot, '7zg.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 无权限就当没有 */
    }
  }
  return '';
}

async function downloadAndExtractSplit({ profile, root, stagingRoot, onProgress }) {
  const latest = await fetchLatest(profile);
  if (!latest.packs.length) throw new Error(`${profile.iconName} 接口没有返回分卷列表`);
  const zip = findSevenZip();
  if (!zip) throw new Error('没找到 7-Zip，无法解压分卷包（装一个 7-Zip 或装官方鹰角启动器）');

  const staging = stagingRoot || path.join(path.dirname(root), '_packs', latest.version);
  await fsp.mkdir(staging, { recursive: true });

  const total = latest.packs.length;
  const report = (index, phase) => {
    if (typeof onProgress === 'function') {
      onProgress({
        game: profile.iconName,
        version: latest.version,
        phase,
        index,
        total,
        percent: Math.round((index / total) * 100),
      });
    }
  };

  // ① 逐卷下载 + md5 校验
  for (let index = 0; index < latest.packs.length; index += 1) {
    const pack = latest.packs[index];
    const name = path.basename(new URL(pack.url).pathname);
    const target = path.join(staging, name);
    report(index, 'download');
    let reused = false;
    try {
      const stat = await fsp.stat(target);
      if (stat.size === pack.size && pack.md5) {
        reused = (await md5File(target)) === pack.md5;
      }
    } catch {
      reused = false;
    }
    if (reused) continue;
    await downloadToFile(pack.url, target);
    if (pack.md5) {
      const actual = await md5File(target);
      if (actual !== pack.md5) throw new Error(`${name} 校验失败（md5 不符）`);
    }
  }
  report(total, 'download');

  // ② 7z 解压第一分卷，它会自动连读 .002 / .003 …
  report(total, 'extract');
  await fsp.mkdir(root, { recursive: true });
  const first = path.basename(new URL(latest.packs[0].url).pathname);
  const { execFile } = require('node:child_process');
  await new Promise((resolve, reject) => {
    execFile(
      zip,
      ['x', path.join(staging, first), `-o${root}`, '-y'],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`解压失败：${(stderr || stdout || error.message).slice(0, 400)}`));
        else resolve();
      }
    );
  });
  report(total, 'done');

  return {
    iconName: profile.iconName,
    version: latest.version,
    clientVersion: latest.clientVersion,
    totalBytes: latest.totalSize,
    packs: total,
    root,
    staging,
    entry: profile.entry || '',
  };
}

function profileForChannel(channel) {
  if (channel === 'arknights') return PROFILES.find((item) => item.directory === 'Arknights');
  if (channel === 'bilibili') return PROFILES.find((item) => item.directory === 'EndBilibili');
  if (channel === 'global') return PROFILES.find((item) => item.directory === 'EndGlobal');
  if (channel === 'play') return PROFILES.find((item) => item.directory === 'EndPlay');
  if (channel === 'steam') return PROFILES.find((item) => item.directory === 'EndSteam');
  return PROFILES.find((item) => item.directory === 'EndOfficial');
}

async function checkEndfieldGame({ root, channel }) {
  const profile = profileForChannel(channel);
  if (!profile) throw new Error('没有对应的终末地渠道');
  const remote = await loadRemoteManifest(profile, true);
  return {
    version: remote.version,
    base: remote.base,
    fileCount: remote.files.length,
    totalBytes: remote.files.reduce((sum, file) => sum + file.size, 0),
    manifestSha256: remote.manifestSha256,
    root,
  };
}

async function updateEndfieldGame({ root, channel, onProgress }) {
  const profile = profileForChannel(channel);
  if (!profile) throw new Error('没有对应的终末地渠道');
  const remote = await loadRemoteManifest(profile, true);
  const statePath = path.join(root, '.vela-game-state.json');
  let state = null;
  try {
    state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  } catch {
    state = null;
  }
  if (
    state &&
    state.version === remote.version &&
    state.manifestSha256 === remote.manifestSha256
  ) {
    return { ok: true, version: remote.version, updated: 0, skipped: true, root };
  }
  let updated = 0;
  let downloadedBytes = 0;
  for (let index = 0; index < remote.files.length; index += 1) {
    const file = remote.files[index];
    const target = path.resolve(root, file.path);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('游戏清单路径非法');
    let current = false;
    try {
      const stat = await fsp.stat(target);
      if (stat.size === file.size) current = (await md5File(target)) === file.md5;
    } catch {
      current = false;
    }
    if (current) {
      onProgress?.({
        current: file.path,
        processed: index + 1,
        total: remote.files.length,
        downloadedBytes,
        totalBytes: remote.files.reduce((sum, item) => sum + item.size, 0),
      });
      continue;
    }
    const temporary = `${target}.vela-download`;
    await downloadToFile(`${remote.base}/${file.urlPath}`, temporary);
    const actual = await md5File(temporary);
    if (actual !== file.md5) {
      await fsp.rm(temporary, { force: true });
      throw new Error(`文件校验失败：${file.path}`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rm(target, { force: true });
    await fsp.rename(temporary, target);
    updated += 1;
    downloadedBytes += file.size;
    onProgress?.({
      current: file.path,
      processed: index + 1,
      total: remote.files.length,
      downloadedBytes,
      totalBytes: remote.files.reduce((sum, item) => sum + item.size, 0),
    });
  }
  await fsp.writeFile(
    statePath,
    JSON.stringify(
      {
        version: remote.version,
        manifestSha256: remote.manifestSha256,
        updatedAt: new Date().toISOString(),
        fileCount: remote.files.length,
      },
      null,
      2
    ),
    'utf8'
  );
  return { ok: true, version: remote.version, updated, skipped: false, root };
}

async function updateProfile(profile, root, onProgress) {
  if (profile.iconName === 'SteamEndfield') {
    return { iconName: profile.iconName, skipped: true, reason: 'Steam 渠道暂不自动更新' };
  }
  const remote = await loadRemoteManifest(profile);
  const target = path.join(root, profile.directory);
  const stateFile = path.join(root, '.state', `${profile.directory}.json`);
  let oldState = null;
  try {
    oldState = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  } catch {
    oldState = null;
  }
  const current =
    oldState &&
    oldState.Version === remote.version &&
    oldState.ManifestSha256 === remote.manifestSha256 &&
    remote.files.every((file) => fs.existsSync(path.join(target, file.path)));
  if (current) {
    return { iconName: profile.iconName, version: remote.version, updated: 0, skipped: true };
  }

  const staging = path.join(root, `.staging-${profile.directory}`);
  await fsp.rm(staging, { recursive: true, force: true });
  let downloaded = 0;
  for (let index = 0; index < remote.files.length; index += 1) {
    const file = remote.files[index];
    onProgress?.({
      profile: profile.iconName,
      current: file.path,
      processed: index + 1,
      total: remote.files.length,
    });
    const temporary = path.join(staging, file.path);
    let data = null;
    const existing = path.join(target, file.path);
    try {
      if ((await md5File(existing)) === file.md5) {
        data = await fsp.readFile(existing);
      }
    } catch {
      data = null;
    }
    if (!data) {
      data = await downloadFile(`${remote.base}/${file.urlPath}`, temporary);
      downloaded += 1;
      if (md5(data) !== file.md5) throw new Error(`${file.path} MD5 校验失败`);
    }
    await fsp.mkdir(path.dirname(temporary), { recursive: true });
    if (!fs.existsSync(temporary)) await fsp.writeFile(temporary, data);
  }

  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rename(staging, target);
  const state = {
    IconName: profile.iconName,
    Version: remote.version,
    ManifestSha256: remote.manifestSha256,
    UpdatedAtUtc: new Date().toISOString(),
    FileCount: remote.files.length,
    TotalBytes: remote.files.reduce((sum, file) => sum + file.size, 0),
  };
  await fsp.mkdir(path.dirname(stateFile), { recursive: true });
  await fsp.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
  return { iconName: profile.iconName, version: remote.version, updated: downloaded, skipped: false };
}

async function updateEndfieldPacks({ root, onProgress }) {
  await fsp.mkdir(root, { recursive: true });
  const results = [];
  for (const profile of PROFILES) {
    try {
      results.push(await updateProfile(profile, root, onProgress));
    } catch (error) {
      results.push({
        iconName: profile.iconName,
        skipped: false,
        error: error.message,
      });
    }
  }
  return { ok: true, root, results };
}

module.exports = {
  updateEndfieldPacks,
  updateEndfieldGame,
  checkEndfieldGame,
  fetchLatest,
  downloadAndExtractSplit,
  findSevenZip,
  decryptManifest,
  encryptManifest,
  profileForChannel,
  PROFILES,
};
