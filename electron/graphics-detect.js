'use strict';

/**
 * 通用的画质配置探测。
 *
 * 为什么要「通用」：以前画质页只认 game-features.js 里写死的四个米哈游游戏
 * （`graphics: { kind: 'registry', key: 'HKCU\\Software\\miHoYo\\原神' }`）。
 * 用户装了终末地、明日方舟这些之后，画质页上根本没有它们 —— 因为没人手写注册表路径。
 *
 * 现在的做法：
 *   1. 先用游戏自己的可执行文件名 / 安装目录名，在 HKCU\Software 下定向搜注册表项；
 *   2. 找不到再按发行商目录（miHoYo / Hypergryph / Gryphline…）逐个试已知的子项；
 *   3. 对读出来的项做「这是不是画质配置」的打分：带 Unity 的 Screenmanager 一组值、
 *      或者带 Quality / Resolution / Fullscreen 这类值名，达到阈值才算；
 *   4. 结果按注册表项的**最后写入时间**优先 —— 同一款游戏常常同时留着
 *      `Hypergryph\Endfield`（当前）和 `Hypergryph\Arknights`（老的），选错就改到别人身上了。
 *
 * 全流程只读 HKCU\Software 下的两层目录来建立候选，不会递归扫整棵注册表
 * （那样一次要几分钟，实测过）。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------------------------------------------ */
/* 读注册表                                                            */
/* ------------------------------------------------------------------ */

function decodeBuffer(buf) {
  if (!buf || !buf.length) return '';
  // reg.exe 在中文 Windows 上按 OEM 代码页（GBK）输出
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * 跑一次 reg.exe。
 *
 * 两点必须留神：
 * - 中文值名的项偶尔会让 reg.exe 卡住十几秒，超时后 execFileSync 直接抛，
 *   以前这里把所有异常静默吞成空串，表现成「这一项 0 个值」，探测结果时有时无。
 *   现在超时就重试一次（超时放宽到 60 秒），并且把失败原因记下来，方便排查。
 * - 只有 reg.exe 明确失败（不存在 / 拒绝访问）才返回 null；超时返回 null 并标记
 *   `timedOut`，调用方据此决定要不要把这轮结果写进缓存（避免把超时缓存成「没有」）。
 */
let lastRegFailed = false;
let lastRegTimedOut = false;

function reg(args, timeout = 60000) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const buf = execFileSync('reg.exe', args, {
        encoding: 'buffer',
        windowsHide: true,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
      });
      lastRegFailed = false;
      lastRegTimedOut = false;
      return decodeBuffer(buf);
    } catch (error) {
      const timedOut = error && (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM');
      lastRegFailed = true;
      lastRegTimedOut = Boolean(timedOut);
      if (!timedOut) return ''; // 项不存在 / 拒绝访问：真的没有
      // 超时才重试
    }
  }
  return '';
}

function subKeys(key) {
  const out = reg(['query', key]);
  const kids = [];
  const upper = key.toUpperCase();
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!/^HKEY_/i.test(t)) continue;
    if (t.toUpperCase() === upper) continue;
    kids.push(t);
  }
  return kids;
}

/** 读一项的所有值名（值名可以带空格）。 */
function valueNames(key) {
  const out = reg(['query', key]);
  const names = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s{2,}(.+?)\s+(REG_(?:SZ|DWORD|QWORD|BINARY|EXPAND_SZ|MULTI_SZ|NONE))(?:\s|$)/);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || name === '(默认)') continue;
    names.push(name);
  }
  return names;
}

/* ------------------------------------------------------------------ */
/* 候选与打分                                                          */
/* ------------------------------------------------------------------ */

/** 这些值名说明「这一项是游戏的画质配置」。 */
const QUALITY_SIGNAL = /Screenmanager|Resolution|Quality|Fullscreen|VSync|FPS|FrameRate|Render|AntiAlias|Shadow|Bloom|HDR|Dlss|Aspect|Graphic/i;

/** Unity 默认项（Default / Version / 备份）不算证据。 */
const IGNORE_VALUE = /Default_h|_Version_h|ClearVersion|IsConvertedFrom|IsUserSave|ShaderWarmUp|shaderLabSubVersion|Stereo 3D|Window Position/i;

/**
 * 不能当成游戏的项：启动器 / SDK / 账号数据。
 *
 * 注意这里**不放 `MIHOYO`**：正则不分大小写，`MIHOYO` 会把厂商目录 `HKCU\Software\miHoYo`
 * 本身排除掉，导致原神 / 绝区零 / 崩坏3 的厂商兜底永远进不去（踩过）。
 * 米游社 SDK 的噪音靠 `SDK_` 和具体值名过滤就够了。
 */
const IGNORE_KEY = /Launcher|sdk_data|SDK_|QR_CODE|USER_|App_|CnLive|Uninstall|Electron|CrashReport|Update|BeyondAssist/i;

/**
 * 给一个注册表项打分。
 * 返回 { score, values, signals, unities } —— score 小于阈值直接丢掉。
 */
function scoreKey(key, names) {
  const real = names.filter((n) => !IGNORE_VALUE.test(n));
  const signals = real.filter((n) => QUALITY_SIGNAL.test(n));
  const unity = real.filter((n) => /^Screenmanager|^UnitySelectMonitor/i.test(n));
  // Unity 的 Screenmanager 五件套是最硬的证据；纯 Quality 名字权重低一些
  const score = unity.length * 3 + Math.min(signals.length, 12) + (names.length > 40 ? 2 : 0);
  return { score, values: names.length, signals: signals.length, unities: unity.length };
}

/** 目录名 → 可搜索的词。 */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[：:·—\-_]/g, ' ')
    .split(/[\s\\/]+/)
    .filter((t) => t && t.length >= 2);
}

/**
 * 这些词在路径里到处都是（几乎所有游戏都装在 `Games\` 下），
 * 拿它们匹配注册表项会把「Dazed Games\How to Fish」这种完全不相干的项也算进来。
 */
const GENERIC_TOKENS = new Set([
  'games',
  'game',
  'binaries',
  'win64',
  'win32',
  'client',
  'app',
  'data',
  'program',
  'programs',
  'programfiles',
  'programfilesx86',
  'steamapps',
  'common',
  'x64',
  'windowsnoeditor',
  'bin',
  'src',
  'release',
  'shipping',
  'contents',
]);

/**
 * 从启动器里的一个游戏条目，猜出它可能落在哪些注册表项。
 *
 * game 是渲染层 state.games 里的对象：{ name, path, exe, ... }
 * 只用文件名和路径，不读磁盘内容。
 */
function guessKeys(game) {
  const exe = String(game?.exe || '').replace(/\.exe$/i, '');
  const exeDirs = [];
  const full = String(game?.path || game?.exePath || '');
  if (full) {
    const parts = full.split(/[\\/]+/).filter(Boolean);
    for (const part of parts.slice(Math.max(0, parts.length - 4))) {
      const clean = part.replace(/\.exe$/i, '').trim();
      if (clean.length >= 3) exeDirs.push(clean);
    }
  }
  const raw = [...tokenize(exe), ...exeDirs.flatMap(tokenize), ...tokenize(game?.name)];
  /*
   * 中文名还要整段留着：「原神」「绝区零」这类名字没有分隔符，
   * tokenize 之后是完整词，但「明日方舟：终末地」会被切成两段，
   * 别名表里登记的整名（明日方舟终末地）就永远匹配不到，所以两个都放进去。
   */
  const wholeName = String(game?.name || '')
    .replace(/[：:·—\-_\s]/g, '')
    .toLowerCase();
  if (wholeName.length >= 2 && /[\u4e00-\u9fa5]/.test(wholeName)) raw.push(wholeName);
  // 去掉路径里的通用词和纯数字，否则 `Games\` 会让所有游戏匹配到同一批项
  return [...new Set(raw.filter((t) => !GENERIC_TOKENS.has(t) && !/^\d+$/.test(t)))];
}

/**
 * 中文游戏名在注册表里通常写成英文目录，所以这些词要建立映射。
 * 只放「已在真实注册表里确认过」的对应关系，猜错就会改到别人的配置上。
 */
const CHINESE_ALIAS = {
  原神: ['原神', 'genshin', 'yuanshen'],
  崩坏3: ['崩坏3', 'bh3', 'honkai3rd'],
  崩坏星穹铁道: ['星穹铁道', 'starrail', 'hkrpg'],
  星穹铁道: ['星穹铁道', 'starrail'],
  崩坏: ['星穹铁道', 'starrail'],
  绝区零: ['绝区零', 'zenless', 'zzz'],
  明日方舟终末地: ['endfield'],
  终末地: ['endfield'],
  明日方舟: ['arknights'],
  异环: ['neverness', 'nte'],
};

function aliasesOf(token) {
  return CHINESE_ALIAS[token] || null;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/*
 * 目录与探测结果的缓存时长，统一延长到 30 分钟。
 *
 * 用户的原话是「第一次读取完成后如果没有变动就不二次读取了」：
 * 装了什么游戏、注册表项落在哪，半小时内基本不会变，而一轮完整探测
 * （HKCU\Software 下 74 个厂商目录逐个 reg query 再打分）实测要 1.2~3.3 秒。
 * 以前 60 秒一过期，用户来回点两下画质页就要重新等一遍。
 */
const CACHE_TTL = 30 * 60 * 1000;

/** 缓存一层目录，避免每次都 reg query 一遍。 */
let vendorCache = null;
let vendorCacheAt = 0;
const VENDOR_TTL = CACHE_TTL;

/**
 * 子项列表 + 项有无值的缓存（reg query 一次几十毫秒，74 个厂商就是一两秒）。
 * 导出给 main.js 的「固定注册表项」兜底校验用：判断记下来的项还在不在，
 * 用这里的缓存就不用再起子进程。
 */
const kidsCache = new Map();
const KIDS_TTL = CACHE_TTL;

function cachedSubKeys(key) {
  const now = Date.now();
  const hit = kidsCache.get(key);
  if (hit && now - hit.at < KIDS_TTL) return hit.list;
  const list = subKeys(key);
  kidsCache.set(key, { at: now, list });
  return list;
}

/**
 * 探测结果缓存：同一款游戏反复进画质页时不用再扫一遍注册表。
 * 30 分钟内连 detect() 都不扫，直接复用上一次的结论。
 */
const detectCache = new Map();
const DETECT_TTL = CACHE_TTL;

function cacheKeyOf(game) {
  return [game?.key, game?.name, game?.path, game?.exe].map((v) => String(v || '')).join('|');
}

/** 丢掉某款游戏的探测结果缓存（main.js 发现固定项失效时用，逼下一次重新探测）。 */
function invalidate(game) {
  if (!game) {
    detectCache.clear();
    return;
  }
  detectCache.delete(cacheKeyOf(game));
}

/**
 * 刚探测出来的结论值得长期记住的，同步塞进缓存。
 * main.js 会把结论落到 userData\graphics-detect.json 固定下来，但那个文件在
 * 下一次启动后才生效；这里顺手写内存缓存，本次会话里就不用再扫。
 */
function remember(game, result) {
  if (!game || !result) return;
  detectCache.set(cacheKeyOf(game), { at: Date.now(), result });
}

/**
 * 只读一次「某一层目录下有哪些子项」，不扫全表、不打分。
 *
 * 给 main.js 校验「记住的注册表项还在不在」用：记住的项本身就带父目录
 * （`HKCU\Software\Hypergryph\Endfield` 的父目录是 `...\Hypergryph`），
 * 只要父目录的子项列表里还有它，就不用重新探测。
 * 读这一层走 kidsCache，同一款游戏第二次进入时连子进程都不起。
 *
 * 返回 true / false；拿不到父目录时返回 null（由调用方决定怎么处理）。
 */
function stillExists(registryKey) {
  const key = String(registryKey || '').trim();
  if (!key) return null;
  const cut = key.replace(/\\+$/, '').lastIndexOf('\\');
  if (cut <= 0) return null;
  const parent = key.slice(0, cut);
  // 顶层容器的子项名就是第二段，`HKCU\Software` 这种自己不带父目录的不要碰
  const parentDepth = parent.split('\\').filter(Boolean).length;
  if (parentDepth < 2) return null;
  const leaf = key.slice(cut + 1);
  // reg.exe 的输出大小写不保证，按不区分大小写比
  const upperLeaf = leaf.toUpperCase();
  return cachedSubKeys(parent).some((kid) => {
    const bang = kid.lastIndexOf('\\');
    return (bang >= 0 ? kid.slice(bang + 1) : kid).toUpperCase() === upperLeaf;
  });
}

function softwareVendors(force) {
  const now = Date.now();
  if (!force && vendorCache && now - vendorCacheAt < VENDOR_TTL) return vendorCache;
  const list = subKeys('HKCU\\Software');
  vendorCache = list;
  vendorCacheAt = now;
  return list;
}

/** 同款游戏的并发探测只跑一次（见下面的 probe）。 */
const pendingProbes = new Map();

/**
 * 探测一款游戏的画质注册表项。
 *
 * 返回 { ok, key, score, values, reason } 或 { ok:false, reason }
 */
function detect(game) {
  if (process.platform !== 'win32') return { ok: false, reason: '只有 Windows 能读注册表' };
  const cacheKey = cacheKeyOf(game);
  const cached = detectCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DETECT_TTL) return cached.result;
  const result = detectUncached(game);
  detectCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/**
 * 按游戏对象缓存一层「探测到 / 探测失败」的结论，外加一个进行中的 Promise。
 *
 * 为什么 main.js 还要这个：画质页每次读取都会发一次 IPC，用户在标签之间来回点
 * 很容易连发两次；两次都赶在 detectCache 还没写回时进来，就会各自扫一遍注册表，
 * 表现为「点了没反应，过 3 秒才出来」。这里把同款游戏的并发请求合成一次。
 * 注意只缓存成功结论 —— 失败一般是「游戏还没启动过」，下次进来要能重新试。
 */
function probe(game) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, reason: '只有 Windows 能读注册表' });
  const cacheKey = cacheKeyOf(game);
  const cached = detectCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DETECT_TTL && cached.result && cached.result.ok) {
    return Promise.resolve(cached.result);
  }
  const running = pendingProbes.get(cacheKey);
  if (running) return running;
  const task = (async () => {
    try {
      return detect(game);
    } finally {
      pendingProbes.delete(cacheKey);
    }
  })();
  pendingProbes.set(cacheKey, task);
  return task;
}

function detectUncached(game) {
  const tokens = guessKeys(game);
  if (!tokens.length) return { ok: false, reason: '这个游戏没有可执行的路径信息，没法定位配置' };

  /*
   * 主词（exe 名、安装目录名）+ 中文名映射出来的英文词。
   * Chinese 别名只在显式登记过时才算主词，不然「异环」这种音译名永远对不上 NTE。
   */
  const primary = new Set(tokens.filter((t) => !/^[\u4e00-\u9fa5]+$/.test(t)));
  for (const t of tokens) {
    const alias = aliasesOf(t);
    if (alias) for (const a of alias) primary.add(a);
  }
  if (!primary.size) {
    // 一个英文词都没有（比如只配了中文名），退回用全部词匹配
    for (const t of tokens) primary.add(t);
  }

  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const chinese = [...primary].filter((t) => /[\u4e00-\u9fa5]/.test(t));
  const latin = [...primary].filter((t) => !/[\u4e00-\u9fa5]/.test(t));

  /*
   * 强匹配只认「exe 名 / 安装目录名」（拉丁词）。
   * 中文名不能当强匹配：`miHoYo\绝区零` 里的「绝区零」无法和 `ZenlessZoneZero` 对上，
   * 而 `Cognosphere\Star Rail` 这种英文目录才是真正该命中的。
   * 异环那种只有中文名的，靠下面的别名表补英文相当于手写映射，补不到就不猜。
   */
  const strongPattern = latin.length ? new RegExp(latin.map(escape).join('|'), 'i') : null;
  const anyPattern = new RegExp([...primary, ...chinese].map(escape).join('|'), 'i');

  const vendors = softwareVendors();
  const seen = new Set();
  const candidates = [];
  for (const vendor of vendors) {
    if (IGNORE_KEY.test(vendor)) continue;
    for (const kid of cachedSubKeys(vendor)) {
      if (IGNORE_KEY.test(kid) || seen.has(kid)) continue;
      const strong = Boolean(strongPattern && strongPattern.test(kid));
      if (strong || anyPattern.test(kid)) {
        candidates.push({ key: kid, strong });
        seen.add(kid);
      }
    }
  }

  /*
   * 厂商兜底：注册表里的项名常常是中文（`miHoYo\原神`），
   * 而启动器里拿到的是 `GenshinImpact.exe` / `YuanShen.exe`，两边的词永远对不上。
   * 这时改成「按厂商收」，把这个厂商下所有看起来像画质配置的项都收进来，
   * 再用 CHINESE_ALIAS 把游戏跟项名对上。对不上的宁可报「没找到」，也不乱猜 ——
   * 原神和星铁同属 miHoYo，猜错就是把别人的画质改了。
   */
  if (!candidates.length) {
    const aliasWords = [];
    for (const t of tokens) {
      const alias = aliasesOf(t);
      if (alias) aliasWords.push(...alias);
    }
    const vendorHint = {
      genshin: /miHoYo|mihoyo/i,
      starrail: /miHoYo|Cognosphere/i,
      zzz: /miHoYo/i,
      bh3: /miHoYo/i,
      endfield: /Hypergryph|Gryphline/i,
      arknights: /Hypergryph|Gryphline/i,
      neverness: /PerfectWorld|Perfect World/i,
    }[game?.key];
    if (vendorHint && aliasWords.length) {
      const aliasPattern = new RegExp(aliasWords.map(escape).join('|'), 'i');
      for (const vendor of vendors) {
        if (!vendorHint.test(vendor)) continue;
        for (const kid of cachedSubKeys(vendor)) {
          if (IGNORE_KEY.test(kid) || seen.has(kid)) continue;
          if (aliasPattern.test(kid)) {
            candidates.push({ key: kid, strong: true, viaAlias: true });
            seen.add(kid);
          }
        }
      }
    }
  }
  if (!candidates.length) {
    return { ok: false, reason: `没有找到 ${game?.name || ''} 的画质配置`, tokens };
  }

  /*
   * 排队：强匹配优先，同强度里短名字优先。
   * 真游戏项一般很短（`miHoYo\原神`、`Cognosphere\Star Rail`、`Hypergryph\Endfield`），
   * SDK / 启动器那种项名又长又杂。排好序以后第一个够格的通常就是答案，
   * 靠上面的早停就能把「原神要 20 秒」压下去。
   */
  candidates.sort((a, b) => {
    if (a.strong !== b.strong) return a.strong ? -1 : 1;
    return a.key.length - b.key.length;
  });

  let best = null;
  for (const candidate of candidates) {
    /*
     * 只给「像画质项」的候选读值名。valueNames 每次都是一次 reg query，
     * 每个候选都读的话，原神要 20 秒（它匹配到几十个 miHoYo* 项）。
     * 所以先按「命中强度 + 名字长度」排队，强匹配的排前面、短名字靠前
     * （真游戏项通常很短：`原神`、`Star Rail`；SDK 那种又长又杂），
     * 读到第一个够格的候选就停 —— 宁可少读几个，也不要让用户等 20 秒。
     */
    const nameList = valueNames(candidate.key);
    if (!nameList.length) continue;
    const scored = scoreKey(candidate.key, nameList);
    if (scored.score < 4) continue;
    const entry = {
      key: candidate.key,
      ...scored,
      strong: candidate.strong,
    };
    /* 强匹配（exe 名直接出现在项名里）压过弱匹配，然后再比画质证据的多少 */
    const better =
      !best ||
      (entry.strong && !best.strong) ||
      (entry.strong === best.strong && entry.score > best.score) ||
      (entry.strong === best.strong && entry.score === best.score && entry.values > best.values);
    if (better) best = entry;
    /*
     * 早停：强匹配且画质证据已经够硬（有 Screenmanager 一组值 + 至少 4 个画质信号）
     * 就没必要再往后读了，后面只会是更弱的候选。
     */
    if (best && best.strong && best.unities >= 4 && best.signals >= 4) break;
  }

  if (!best) return { ok: false, reason: `找到了 ${game?.name || ''} 的注册表项，但里面没有画质配置`, tokens };
  return { ok: true, key: best.key, score: best.score, values: best.values, strong: best.strong, tokens };
}

module.exports = {
  detect,
  probe,
  invalidate,
  remember,
  stillExists,
  guessKeys,
  scoreKey,
  valueNames,
  subKeys,
  softwareVendors,
};
