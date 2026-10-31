'use strict';
/*
 * 渠道包按需下载（2.6.0）：安装包不再内置 632 MB 的渠道包，第一次切到某个服时
 * 先问「要下多少」，点了才下。
 *
 * 验四类东西：
 *   1) channelPackSpec：渠道 → 目录映射。方舟和终末地都有 official/bilibili，
 *      靠 gameKey 区分 —— 这里错一个，用户就会下到另一个游戏的包。
 *   2) channelPackReady：什么算「已经齐了」。终末地看 U8Data，方舟看 5 个渠道件。
 *   3) channelPackNeededFor：什么情况根本不用包（官服直启 / 方舟基础目录就是目标渠道）——
 *      这条错了就是白问用户一次 194 MB。
 *   4) packSizeText：弹窗里那句话的体积文案。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "H:/花筱灵启动器/花筱灵启动器.exe" scripts/dev/test-channel-pack.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const results = [];
const ok = (name, pass, detail) =>
  results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });

/** 从源码里按大括号配平抽出整个函数声明（含 async 前缀）。 */
function extractFunction(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) return null;
  const start = match.index;
  const open = source.indexOf('{', start + match[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

const mainSource = read('electron/main.js');
const preloadSource = read('electron/preload.js');
const serverSource = read('src/views/servers.js');
const packSource = read('electron/endfield-packs.js');

/* ── 抽出三个判定函数，在假依赖上真跑 ─────────────────────────── */
const specSrc = extractFunction(mainSource, 'channelPackSpec');
const readySrc = extractFunction(mainSource, 'channelPackReady');
const neededSrc = extractFunction(mainSource, 'channelPackNeededFor');
ok('抽到 channelPackSpec', Boolean(specSrc));
ok('抽到 channelPackReady', Boolean(readySrc));
ok('抽到 channelPackNeededFor', Boolean(neededSrc));

const ARKNIGHTS_OFFICIAL_PROFILE = { directory: 'ArkOfficial', iconName: 'ArkOfficial' };
const ARKNIGHTS_BILIBILI_PROFILE = { directory: 'ArkBilibili', iconName: 'ArkBilibili' };
const ARKNIGHTS_OFFICIAL_READY = [
  'hgsdk.dll',
  'U8CoreUI.dll',
  'U8SDK.dll',
  'u8_channel.dll',
  'U8Data/config/config.bin',
];
const ARKNIGHTS_BILIBILI_READY = [
  'PCGameSDK.dll',
  'U8CoreUI.dll',
  'U8SDK.dll',
  'u8_channel.dll',
  'U8Data/config/config.bin',
];
const ARKNIGHTS_PACK_CHANNELS = {
  official: {
    directory: 'ArkOfficial',
    profile: ARKNIGHTS_OFFICIAL_PROFILE,
    ready: ARKNIGHTS_OFFICIAL_READY,
    label: '官服',
  },
  bilibili: {
    directory: 'ArkBilibili',
    profile: ARKNIGHTS_BILIBILI_PROFILE,
    ready: ARKNIGHTS_BILIBILI_READY,
    label: 'B服',
  },
};
const ENDFIELD_PACK_NAMES = {
  official: 'EndOfficial',
  bilibili: 'EndBilibili',
  global: 'EndGlobal',
  play: 'EndPlay',
  steam: 'EndSteam',
};
const ENDFIELD_CHANNEL_LABEL = {
  official: '官服',
  bilibili: 'B服',
  global: '国际服',
  play: 'Play',
  steam: 'Steam',
};
const PROFILES = [
  { directory: 'EndOfficial' },
  { directory: 'EndBilibili' },
  { directory: 'EndGlobal', deltaOf: 'EndOfficial' },
  { directory: 'EndPlay', deltaOf: 'EndOfficial' },
  { directory: 'EndSteam', deltaOf: 'EndOfficial' },
];

let baseRootAnswer = '';
let arknightsChannelAnswer = 'official';
const factory = new Function(
  'ENDFIELD_PACK_NAMES',
  'ENDFIELD_CHANNEL_LABEL',
  'ARKNIGHTS_PACK_CHANNELS',
  'ARKNIGHTS_OFFICIAL_PROFILE',
  'ARKNIGHTS_BILIBILI_PROFILE',
  'ARKNIGHTS_OFFICIAL_READY',
  'ARKNIGHTS_BILIBILI_READY',
  'profileByDirectory',
  'endfieldBaseRoot',
  'channelFromArknightsRoot',
  'channelPackFilesReady',
  'fs',
  'path',
  `
  ${specSrc}
  ${readySrc}
  ${neededSrc}
  return { channelPackSpec, channelPackReady, channelPackNeededFor };
`
);

const api = factory(
  ENDFIELD_PACK_NAMES,
  ENDFIELD_CHANNEL_LABEL,
  ARKNIGHTS_PACK_CHANNELS,
  ARKNIGHTS_OFFICIAL_PROFILE,
  ARKNIGHTS_BILIBILI_PROFILE,
  ARKNIGHTS_OFFICIAL_READY,
  ARKNIGHTS_BILIBILI_READY,
  (directory) =>
    [...PROFILES, ARKNIGHTS_OFFICIAL_PROFILE, ARKNIGHTS_BILIBILI_PROFILE].find(
      (item) => item.directory === directory
    ) || null,
  () => baseRootAnswer,
  () => arknightsChannelAnswer,
  require('../../electron/endfield-packs').channelPackFilesReady,
  fs,
  path
);

/* ── 1. 渠道 → 目录映射 ───────────────────────────────────────── */
const endfieldCases = [
  ['official', 'EndOfficial', '官服'],
  ['bilibili', 'EndBilibili', 'B服'],
  ['global', 'EndGlobal', '国际服'],
  ['play', 'EndPlay', 'Play'],
  ['steam', 'EndSteam', 'Steam'],
];
for (const [channel, directory, label] of endfieldCases) {
  const spec = api.channelPackSpec('endfield', channel);
  ok(
    `终末地 ${channel} → ${directory}`,
    spec && spec.directory === directory && spec.game === 'endfield',
    spec ? `${spec.directory}/${spec.game}` : 'null'
  );
  ok(`终末地 ${channel} 的界面名是「${label}」`, spec && spec.label === label, spec && spec.label);
}
for (const [channel, directory, label] of [
  ['official', 'ArkOfficial', '官服'],
  ['bilibili', 'ArkBilibili', 'B服'],
]) {
  const spec = api.channelPackSpec('arknights', channel);
  ok(
    `方舟 ${channel} → ${directory}`,
    spec && spec.directory === directory && spec.game === 'arknights',
    spec ? `${spec.directory}/${spec.game}` : 'null'
  );
  ok(`方舟 ${channel} 的界面名是「${label}」`, spec && spec.label === label, spec && spec.label);
}
ok(
  '两个游戏的 official 不会串（同名不同目录）',
  api.channelPackSpec('endfield', 'official').directory === 'EndOfficial' &&
    api.channelPackSpec('arknights', 'official').directory === 'ArkOfficial'
);
ok('方舟国际服三区域没有渠道包', api.channelPackSpec('arknights', 'global-en') === null);
ok('方舟台服没有渠道包', api.channelPackSpec('arknights', 'taiwan') === null);
ok('不认识的渠道返回 null', api.channelPackSpec('endfield', 'switch2') === null);

/* ── 2. 「已经齐了」的判定 ──────────────────────────────────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hxl-pack-'));
const makeFile = (rel) => {
  const full = path.join(tmp, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
};

ok(
  '终末地：只有 U8Data 才算齐',
  (() => {
    const dir = path.join(tmp, 'EndOfficial');
    fs.mkdirSync(dir, { recursive: true });
    const before = api.channelPackReady(api.channelPackSpec('endfield', 'official'), tmp);
    fs.mkdirSync(path.join(dir, 'U8Data'), { recursive: true });
    const after = api.channelPackReady(api.channelPackSpec('endfield', 'official'), tmp);
    return before === false && after === true;
  })()
);

for (const rel of ARKNIGHTS_BILIBILI_READY) makeFile(`ArkBilibili/${rel}`);
ok(
  '方舟 B服：5 个渠道件齐了才算齐',
  api.channelPackReady(api.channelPackSpec('arknights', 'bilibili'), tmp) === true
);
fs.rmSync(path.join(tmp, 'ArkBilibili', 'PCGameSDK.dll'), { force: true });
ok(
  '方舟 B服：缺 PCGameSDK.dll 就不算齐',
  api.channelPackReady(api.channelPackSpec('arknights', 'bilibili'), tmp) === false
);
ok(
  '方舟官服：目录还不存在时不算齐',
  api.channelPackReady(api.channelPackSpec('arknights', 'official'), tmp) === false
);

/* ── 3. 什么时候根本不用包 ─────────────────────────────────────── */
const endfieldServer = (channel, root = 'D:\\Games\\Endfield') => ({
  channel,
  root,
  path: path.join(root, 'Endfield.exe'),
});

// 官服自己装了客户端 → 直启，不用包
baseRootAnswer = tmp;
makeFile('Endfield.exe');
ok(
  '终末地官服自己有客户端时不问下载',
  api.channelPackNeededFor({ builtinKey: 'endfield' }, endfieldServer('official')) === null
);
// 官服没装客户端（靠别的渠道当基础）→ 需要包
baseRootAnswer = path.join(tmp, 'not-exist');
const officialNeeded = api.channelPackNeededFor({ builtinKey: 'endfield' }, endfieldServer('official'));
ok(
  '终末地官服没客户端时需要包',
  officialNeeded && officialNeeded.channel === 'official',
  JSON.stringify(officialNeeded)
);
const biliNeeded = api.channelPackNeededFor({ builtinKey: 'endfield' }, endfieldServer('bilibili'));
ok(
  '终末地 B服永远需要包判断',
  biliNeeded && biliNeeded.game === 'endfield' && biliNeeded.channel === 'bilibili'
);
ok(
  '终末地 Play / Steam 也算渠道包渠道',
  ['play', 'steam'].every((channel) => {
    const need = api.channelPackNeededFor({ builtinKey: 'endfield' }, endfieldServer(channel));
    return need && need.channel === channel;
  })
);

// 方舟：基础目录本来就是 B服 → 切 B服不用包；切官服才要
arknightsChannelAnswer = 'bilibili';
ok(
  '方舟：装的就是 B服，切 B服不问下载',
  api.channelPackNeededFor(
    { builtinKey: 'arknights' },
    { channel: 'bilibili', root: 'D:\\Arknights', path: 'D:\\Arknights\\Arknights.exe' }
  ) === null
);
const arkOfficialNeeded = api.channelPackNeededFor(
  { builtinKey: 'arknights' },
  { channel: 'official', root: 'D:\\Arknights', path: 'D:\\Arknights\\Arknights.exe' }
);
ok(
  '方舟：装的是 B服，切官服要包',
  arkOfficialNeeded && arkOfficialNeeded.channel === 'official',
  JSON.stringify(arkOfficialNeeded)
);
ok(
  '方舟：已经生成过独立运行时的不再问',
  api.channelPackNeededFor(
    { builtinKey: 'arknights' },
    { channel: 'bilibili', root: 'D:\\VelaRuntimes\\arknights\\bilibili' }
  ) === null
);
ok(
  '方舟国际服 / 台服不进下载判定',
  ['global-en', 'global-jp', 'global-kr', 'taiwan'].every(
    (channel) =>
      api.channelPackNeededFor({ builtinKey: 'arknights' }, { channel, root: 'D:\\Arknights' }) ===
      null
  )
);
ok(
  '米哈游 / 异环这类没有渠道包的走原路',
  api.channelPackNeededFor({ builtinKey: 'genshin' }, { channel: 'bilibili', root: 'D:\\Genshin' }) ===
    null
);

/* ── 4. 体积文案 ───────────────────────────────────────────────── */
const sizeFn = extractFunction(serverSource, 'packSizeText');
ok('抽到 packSizeText', Boolean(sizeFn));
if (sizeFn) {
  // eslint-disable-next-line no-new-func
  const packSizeText = new Function(`${sizeFn}; return packSizeText;`)();
  ok('0 字节说「大小未知」', packSizeText(0) === '大小未知', packSizeText(0));
  ok('194 MB 写法', packSizeText(203423744) === '194 MB', packSizeText(203423744));
  ok('9.3 MB 取整', packSizeText(9751757) === '9 MB', packSizeText(9751757));
  ok('超过 1GB 换单位', packSizeText(1610612736) === '1.50 GB', packSizeText(1610612736));
  ok('小文件用 KB 且不显示 0', packSizeText(300) === '1 KB', packSizeText(300));
}

/* ── 5. 后端下载链路的关键契约（静态） ─────────────────────────── */
ok('有流式下载函数 downloadToFile', /async function downloadToFile\(/.test(packSource));
ok(
  'downloadToFile 支持取消信号',
  /async function downloadToFile\(url, destination, options = \{\}\)[\s\S]{0,400}options\.signal/.test(
    packSource
  )
);
ok('有统一取消错误 abortedError', /function abortedError\(\)/.test(packSource));
ok(
  '进度里带字节数（进度条要用）',
  /bytes: processedBytes/.test(packSource) && /totalBytes,/.test(packSource)
);
ok('进度里带速度', /speed: bytesPerSecond\(downloadedBytes, startedAt\)/.test(packSource));
ok(
  '单个大文件下载时也推进度',
  /onChunk: \(chunkBytes\) => \{/.test(packSource)
);
ok('取消后不清 staging（断点续传）', /sameVersionAsLastTime/.test(packSource));
ok('体积预问有缓存', /const measureCache = new Map\(\)/.test(packSource));
ok('导出 measureChannelPack', /measureChannelPack,/.test(packSource));
ok('导出 profileByDirectory', /profileByDirectory,/.test(packSource));

/* ── 6. IPC 与界面接线（静态） ─────────────────────────────────── */
for (const channel of [
  'endfield:channel-pack-status',
  'endfield:channel-pack-download',
  'endfield:channel-pack-cancel',
  'servers:channel-pack-plan',
]) {
  ok(`主进程注册了 ${channel}`, mainSource.includes(`'${channel}'`));
}
for (const api of ['packStatus', 'packDownload', 'packCancel', 'onPackProgress', 'channelPackPlan']) {
  ok(`preload 暴露了 ${api}`, new RegExp(`\\b${api}:`).test(preloadSource));
}
ok(
  'Steam 渠道明确标成不能自动补',
  /canDownload: spec\.directory !== 'EndSteam'/.test(mainSource)
);
ok(
  '下载前校验方舟清单确实是方舟的',
  /const valid = await verifyArknightsSource\(spec\.profile\)/.test(mainSource)
);
ok('切服前会问渠道包', /const packReady = await ensureChannelPackReady\(game, server\)/.test(serverSource));
ok(
  '下载确认在 busy toast 之前（两套进度不打架）',
  (() => {
    const packAt = serverSource.indexOf('await ensureChannelPackReady(game, server)');
    const busyAt = serverSource.indexOf('const busy = beginBusyToast(`正在切换到 ${server.name}…`)');
    return packAt > 0 && busyAt > 0 && packAt < busyAt;
  })()
);
ok('弹窗关掉等于取消下载', /if \(running\) api\.endfield\?\.packCancel\?\./.test(serverSource));
ok('取消按钮先停主进程再关窗', /packCancel\?\.\(\{ game: plan\.game, channel: plan\.channel \}\);\s*\n\s*running = false;/.test(serverSource));

/* ── 7. 打包不再带内置渠道包 ───────────────────────────────────── */
const pkgJson = JSON.parse(read('package.json'));
const extra = (pkgJson.build?.extraResources || []).map((item) => String(item?.from || ''));
ok('extraResources 不再包含渠道包', !extra.some((item) => item.includes('endfield-packs')), extra.join(','));
ok('resources/updater 仍在 extraResources', extra.some((item) => item.includes('resources/updater')));
const packScript = fs.readFileSync('H:/HXL-pack/pack.js', 'utf8');
ok('打包脚本不再强制要求内置渠道包目录', !/缺少内置渠道包目录/.test(packScript));
ok('打包脚本对「又加回去」有防呆', /extraResources 里又包含 resources\/endfield-packs/.test(packScript));

/* ── 8. 释放渠道包按游戏分开 ───────────────────────────────────── */
const actionsSource = read('src/views/actions.js');
const settingsSource = read('src/views/settings.js');
const downloadsSource = read('src/views/downloads.js');

ok('释放逻辑集中在一个函数里', /async function releaseChannelPacks\(scope\)/.test(actionsSource));
ok('终末地释放只删终末地', /case 'release-endfield-packs':\s*\n\s*await releaseChannelPacks\('endfield'\);/.test(actionsSource));
ok('方舟释放只删方舟', /case 'release-arknights-packs':\s*\n\s*await releaseChannelPacks\('arknights'\);/.test(actionsSource));
ok(
  '合并行的「释放」走 scope=all，但确认框分开写两边各占多少',
  /case 'release-channel-packs':\s*\n\s*await releaseChannelPacks\('all'\);/.test(actionsSource) &&
    /终末地 \$\{packBytesText\(endBytes\)\}/.test(actionsSource) &&
    /明日方舟 \$\{packBytesText\(arkBytes\)\}/.test(actionsSource)
);
ok('方舟释放用的是 deletePacks 的 arknights 范围', /deletePacks\(\{ scope \}\)/.test(actionsSource));
ok(
  '设置页合并成一行渠道包（一个管理、一个释放管两个游戏）',
  /data-action="release-channel-packs"/.test(settingsSource) &&
    !/data-action="release-endfield-packs"/.test(settingsSource) &&
    !/data-action="release-arknights-packs"/.test(settingsSource)
);
ok('明日方舟本体的更新 / 修复按钮还在', /data-action="update-arknights-game"/.test(settingsSource) && /data-action="repair-arknights-game"/.test(settingsSource));
ok('方舟释放说明点明国际服/台服不受影响', /国际服 \/ 台服[\s\S]{0,40}不受影响/.test(actionsSource));
ok('终末地释放说明点明 Steam 只能导入或手动放回', /Steam 渠道的清单接口取不到，删了只能从 XelLauncher 导入或手动放回/.test(actionsSource));
ok('方舟释放说明写清重下体积', /官服约 9 MB、B服约 194 MB/.test(actionsSource));
ok('释放按游戏各取各的体积', /const bytesOf = \(key\) =>/.test(actionsSource) && /bytesOf\('endfield'\)/.test(actionsSource) && /bytesOf\('arknights'\)/.test(actionsSource));
ok('管理窗口按渠道逐行列状态', /id="pack-manager-list"/.test(downloadsSource) && /data-pack-row="\$\{key\}"/.test(downloadsSource));
ok('管理窗口给已就绪渠道「更新 / 释放」两个动作', /channel-pack-download/.test(downloadsSource) && /channel-pack-release/.test(downloadsSource));
ok('Steam 行不给下载按钮、写明只能手动提供', /需手动提供/.test(downloadsSource) && /官方接口取不到/.test(downloadsSource));
ok('窗口关掉就取消进度订阅', /onClose: stopPackManagerWatching/.test(downloadsSource));
ok('进度按 game+channel 精确落到某一行', /data-pack-row="\$\{key\}"/.test(downloadsSource) && /progress\.downloadedBytes/.test(downloadsSource));
ok('单渠道释放走 directories 参数', /directories: \[directory\]/.test(actionsSource));
ok('主进程按白名单过滤目录名（防路径穿越）', /allDirs\.has\(String\(name\)\)/.test(mainSource));
ok('管理窗口有「下载全部」入口', /channel-pack-download-all/.test(downloadsSource) && /case 'channel-pack-download-all'/.test(actionsSource));

/* ── 9. 自动更新：切过服才默认开 ────────────────────────────────── */
const homeSource = read('src/views/home.js');
ok('自动更新默认是「未决定」而不是开着', /autoUpdateEndfieldPacks: null,/.test(mainSource));
ok('明日方舟也有自己那条「未决定」的自动更新', /autoUpdateArknightsPacks: null,/.test(mainSource));
ok('自动更新只在明确开启时才跑', /store\.data\.settings\[flagKey\] !== true\) return;/.test(mainSource));
ok('两个游戏的自动更新各跑各的（不共用一个键）', /autoUpdateChannelPacksFor\('endfield'\)[\s\S]{0,120}autoUpdateChannelPacksFor\('arknights'\)/.test(mainSource));
ok('不再用「不等于 false」当开着', !/autoUpdate(Endfield|Arknights)Packs === false\) return;/.test(mainSource));
ok('切服成功记下用过切服', /store\.data\.settings\.hasSwitchedServer = true;/.test(mainSource));
ok('切服成功把未决定的自动更新打开', /autoUpdateEndfieldPacks == null\) \{[\s\S]{0,80}autoUpdateEndfieldPacks = true;/.test(mainSource));
ok('切方舟的服只打开方舟那条自动更新', /builtinKey === 'arknights'\) \{[\s\S]{0,120}autoUpdateArknightsPacks = true;/.test(mainSource));
ok('手动关掉的不被切服改回开', !/autoUpdateEndfieldPacks === false[\s\S]{0,80}autoUpdateEndfieldPacks = true/.test(mainSource));
ok('老数据有一次迁移（没切过服的 true 归零）', /channelPackAutoMigrated/.test(mainSource) && /hasSwitchedServer[\s\S]{0,120}autoUpdateEndfieldPacks = null;/.test(mainSource));
ok('设置页开关只在明确 true 时显示开启', /switchMarkup\('autoUpdateEndfieldPacks', settings\.autoUpdateEndfieldPacks === true\)/.test(settingsSource) && /switchMarkup\('autoUpdateArknightsPacks', settings\.autoUpdateArknightsPacks === true\)/.test(settingsSource));
ok('开关说明写清「切过服之后默认开启」', /切过终末地的服之后默认开启/.test(settingsSource) && /切过明日方舟的服之后默认开启/.test(settingsSource));
ok('切换说明里渠道包只占一条（要包 + 删包后果写在一起）', /要渠道包：第一次切到那个服会先问你要下多少/.test(homeSource) && /直接点「开始游戏」不会问你要包/.test(homeSource));
ok('切换说明不再把渠道包拆成两条', !/^\s*'删过渠道包也能玩/m.test(homeSource));
ok('管理窗口用窄窗（modal-pack），不再套无定义的 wide', /class="modal modal-pack"/.test(downloadsSource) && !/class="modal wide"/.test(downloadsSource));

/* ── 10. 渠道 SDK 互斥（2026-10-31 国际服启动崩溃）───────────────── */
ok('国际服运行时会清掉国服的 hgsdk.dll', /global: \['hgsdk\.dll'/.test(mainSource));
ok('官服运行时会清掉 Gryphline 那套 gfsdk', /official: \['gfsdk\.dll'/.test(mainSource));
ok('B服保留 hgsdk（走鹰角账号），只清 Gryphline', /bilibili: \['gfsdk\.dll', 'glfoundation\.dll'\]/.test(mainSource) && !/bilibili: \[[^\]]*hgsdk/.test(mainSource));
ok('hgsdk.dll 只给国服/B服 补回，不补给别人', /if \(channel === 'official' \|\| channel === 'bilibili'\) refill\.push\('hgsdk\.dll'\)/.test(mainSource));
ok('补缺之后按渠道再清一次外渠道 SDK', /const purged = await purgeForeignChannelFiles\(runtimeRoot, channel\)/.test(mainSource));
ok('外渠道件清理清单挂进 reconcile 的已知件表', /ENDFIELD_FOREIGN_FILES\[channel\][\s\S]{0,40}KNOWN\.add/.test(mainSource));

/* ── 11. Gryphline 三个渠道要整包差异（2026-10-31 国际服仍然崩）─────── */
/*
 * 实测 1.6.4 官方清单：国际服与国服官服有 126 个文件、936 MB 不同 ——
 * Endfield.exe / GameAssembly.dll / UnityPlayer.dll / CefView / Qt / ACE 全是另一份。
 * 只盖 SDK 拼出来的运行时启动 3 秒就 0xc0000005。这三条必须按「与国服清单的差异」打包。
 */
ok('国际服按「与官服清单的差异」打包', /directory: 'EndGlobal'[\s\S]{0,900}deltaOf: 'EndOfficial'/.test(packSource));
ok('Play 也按整包差异', /directory: 'EndPlay'[\s\S]{0,900}deltaOf: 'EndOfficial'/.test(packSource));
ok('Steam 也按整包差异', /directory: 'EndSteam'[\s\S]{0,900}deltaOf: 'EndOfficial'/.test(packSource));
ok('官服 / B服 不做整包差异（它们和国服二进制一致）', !/directory: 'EndOfficial'[\s\S]{0,600}deltaOf/.test(packSource) && !/directory: 'EndBilibili'[\s\S]{0,600}deltaOf/.test(packSource));
ok('差异包与渠道件白名单取并集（基础客户端是 B服时 SDK 也要换）', /const merged = new Map\(files\.map/.test(packSource) && /if \(!known \|\| known !== file\.md5\) merged\.set/.test(packSource));
ok('国服清单当基线时有 10 分钟缓存', /const rawManifestCache = new Map\(\)/.test(packSource));
ok('运行时标记存的是渠道包签名（包变了就重建）', /const packSignature = packSignatureOf\(packDir\)/.test(mainSource) && /markerText !== packSignature/.test(mainSource));
ok('包签名 = 文件数:总字节，不看 mtime', /return `\$\{count\}:\$\{bytes\}`/.test(mainSource));

/*
 * 老机器升级上来的坑（2.6.0 收尾）：随安装包分发的那份 EndGlobal 只有 10 个 SDK
 * 文件，「U8Data 在不在」会把这份残缺包判成已就绪 → 不下载、直接拼运行时 → 崩。
 * 差异渠道必须靠状态文件证明「按整套差异完整下过一遍」。
 */
ok('差异渠道的就绪看状态文件，不看 U8Data', /if \(profile && profile\.deltaOf\) return packDownloadedState/.test(packSource));
ok('官服 / B服 仍按 U8Data 判（不逼老机器重下 235 MB）', /return fs\.existsSync\(path\.join\(dir, 'U8Data'\)\);/.test(packSource));
ok('切服弹窗 / 设置页徽章 / 现下都共用这一个判定', /function channelPackReady\(spec, root\)[\s\S]{0,260}channelPackFilesReady\(spec\.profile, dir\)/.test(mainSource) && /roots\.some\(\(root\) => channelPackFilesReady\(profile, path\.join\(root, packName\)\)\)/.test(mainSource) && /if \(channelPackFilesReady\(profile, dir\)\) return \{ packDir: dir/.test(mainSource));
ok('导入渠道包时把状态文件一起带过来', /path\.join\(source, '\.state', `\$\{name\}\.json`\)/.test(mainSource));
ok('状态里记下这份包是不是整包差异', /Delta: Boolean\(profile\.deltaOf\)/.test(packSource));

/* ── 输出 ──────────────────────────────────────────────────────── */
fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((item) => !item.pass);
for (const item of results) {
  if (!item.pass) console.log(`  FAIL ${item.name}${item.detail ? ` → ${item.detail}` : ''}`);
}
console.log(`\n渠道包按需下载：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
