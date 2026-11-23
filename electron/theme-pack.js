'use strict';

const fs = require('node:fs');
const path = require('node:path');

/*
 * 主题包（2026-11-20）
 *
 * 以前 art-pack 只能平铺放 13 张固定文件名的 png，换一套图就得覆盖上一套，
 * 也没法带配色 —— 用户要「做更多主题包，每个包按角色配整体配色」。
 *
 * 现在一个主题包 = userData/art-pack/<包 id>/ 一个目录：
 *   <包 id>/
 *     theme.json        清单（名字/作者/皮肤/强调色/自定义配色）
 *     character.png     以下 18 张全是可选的，缺哪张就回落内置图
 *     character-face.png
 *     sparkle-hero.png
 *     ...（见 ART_NAMES）
 *     char-cool.png     角色立绘（2026-11-20 新增三个位）
 *     char-sweet.png
 *     char-book.png
 *
 * 老的平铺布局（userData/art-pack/character.png）继续认，优先级排在选定主题包之后、
 * 内置图之前 —— 老用户升级上来不会突然掉回内置图。
 *
 * 安全边界：
 *   1. 只认 ART_NAMES 里的 18 个名字，其余一律不读（不能变成任意文件读取）
 *   2. 包 id 走白名单式校验（只允许字母数字下划线横线点），禁绝 .. 与分隔符
 *   3. theme.json 里的 colors 只接受 #rgb / #rrggbb / rgb() / rgba()，绝不透传任意字符串
 */

/** 这 18 个名字是 hxl-art:// 的合法资源名，也是主题包允许覆盖的全部文件名。 */
const ART_NAMES = [
  'character.png',
  'character-face.png',
  'sparkle-hero.png',
  'sparkle-fullbody.png',
  'sparxie-fullbody.png',
  'sparkle-mask.png',
  'sparkle.png',
  'sparxie.png',
  'sparkle-figure.png',
  'sparxie-charm.png',
  'charm-fireworks.png',
  'charm-flame.png',
  'charm-stars.png',
  // 角色立绘/挂饰（2026-11-20 三张 + 2026-11-22 两张）
  'char-cool.png',
  'charm-dock.png',
  'char-sweet.png',
  'char-book.png',
  'char-portrait.png',
];

const ART_NAME_SET = new Set(ART_NAMES);

/** 内置包（源码 src/assets 里的那套）在设置里用的保留 id。 */
const BUILTIN_ID = 'builtin';

const PACK_DIR = 'art-pack';
const MANIFEST = 'theme.json';
/*
 * 包 id 允许中文：用户会把「幻梦-花火-sparkle-幻梦剧场」这样的文件夹直接丢进 art-pack。
 * 仍然禁止：路径分隔符、以点开头（挡住 . / ..）、Windows 保留名、超过 64 字符。
 */
const ID_RE = /^[\p{L}\p{N}_-][\p{L}\p{N}._-]{0,63}$/u;

/** 主题包可以调的配色键 → 落到渲染层的 CSS 变量（键名用短名，渲染层负责展开）。 */
const COLOR_KEYS = ['accent', 'accent2', 'bg', 'surface', 'text', 'muted', 'gold'];

const COLOR_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;

/** 设置里可选的内置皮肤 / 强调色，和渲染层 SKIN_OPTIONS / ACCENT_OPTIONS 对齐。 */
const SKIN_IDS = [
  'classic', 'midnight', 'sakura', 'frost', 'amber', 'ocean', 'sunset',
  'forest', 'mono', 'golden', 'arctic', 'rose', 'tech', 'garden', 'galaxy',
];
const ACCENT_IDS = ['spark', 'gold', 'sakura', 'cyan', 'rose', 'jade', 'violet', 'amber'];

function packRoot(userData) {
  return path.join(String(userData || ''), PACK_DIR);
}

/** 包 id 合法性。除了字形，还要挡掉 Windows 保留名（CON / NUL 之类）。 */
function validId(id) {
  const text = String(id || '');
  if (!ID_RE.test(text)) return false;
  if (text === '.' || text === '..') return false;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(text)) return false;
  return true;
}

function safeColor(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > 40) return '';
  return COLOR_RE.test(text) ? text : '';
}

function pickId(value, allowed, fallback) {
  const text = String(value == null ? '' : value).trim();
  return allowed.includes(text) ? text : fallback;
}

/**
 * 用户替换的图单独放在包目录的 _custom 子目录里，绝不覆盖包自带原图。
 * 这样「还原」只需删掉 _custom 里那张，就能回到当前主题包自己的图。
 */
const CUSTOM_DIR = '_custom';

/** 列出某个包里被用户替换过的素材名。 */
function customAssets(dir) {
  return ART_NAMES.filter((name) => {
    try {
      return fs.statSync(path.join(dir, CUSTOM_DIR, name)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * 读一个主题包目录的清单。目录不存在 / 清单坏了都返回 null（调用方当作「没有这个包」）。
 * 清单缺 skin/accent 时给 classic / spark，不因为一份手写 json 少两个字段就整包作废。
 */
function readManifest(dir, id) {
  const file = path.join(dir, MANIFEST);
  let raw;
  try {
    const stat = fs.statSync(file);
    // 清单只可能是小文件，超过 64KB 基本就是放错了，不去读
    if (!stat.isFile() || stat.size > 65536) return null;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const colors = {};
  const src = data.colors && typeof data.colors === 'object' ? data.colors : {};
  for (const key of COLOR_KEYS) {
    const value = safeColor(src[key]);
    if (value) colors[key] = value;
  }

  return {
    id,
    name: String(data.name || id).trim().slice(0, 40) || id,
    author: String(data.author || '').trim().slice(0, 40),
    description: String(data.description || '').trim().slice(0, 200),
    version: String(data.version || '').trim().slice(0, 20),
    skin: pickId(data.skin, SKIN_IDS, 'classic'),
    accent: pickId(data.accent, ACCENT_IDS, colors.accent ? 'custom' : 'spark'),
    colors,
    // 只记「这个包里真的有哪几张」，界面据此提示会缺失哪些
    assets: ART_NAMES.filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isFile();
      } catch {
        return false;
      }
    }),
    customs: customAssets(dir),
  };
}

/**
 * 枚举所有可用主题包。返回数组第一项永远是内置包。
 * 目录里没有 theme.json 但有图的，也当包收进来（名字用目录名）—— 用户可能只是丢了一套图。
 */
function listPacks(userData) {
  const root = packRoot(userData);
  const out = [
    {
      id: BUILTIN_ID,
      name: '内置（花筱灵 · 玫瑰夜）',
      author: '',
      description: '启动器自带的原创装饰图，跟着皮肤与强调色走。',
      version: '',
      skin: '',
      accent: '',
      colors: {},
      assets: [],
      customs: [],
      builtin: true,
    },
  ];

  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // 目录还没有，就是只有内置包
  }

  const dirs = ents
    .filter((e) => e.isDirectory() && validId(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));

  for (const id of dirs) {
    const dir = path.join(root, id);
    const manifest = readManifest(dir, id);
    if (manifest) {
      manifest.builtin = false;
      out.push(manifest);
      continue;
    }
    // 没清单：只有真的放了图才收
    const assets = ART_NAMES.filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
    if (!assets.length) continue;
    out.push({
      id,
      name: id,
      author: '',
      description: '（没有 theme.json，按目录名显示，配色走当前皮肤）',
      version: '',
      skin: 'classic',
      accent: 'spark',
      colors: {},
      assets,
      customs: customAssets(dir),
      builtin: false,
    });
  }

  return out;
}

/** 按 id 找包；找不到返回 null。内置包不在这里返回（它没有目录）。 */
function findPack(userData, id) {
  if (!validId(id)) return null;
  const dir = path.join(packRoot(userData), id);
  const manifest = readManifest(dir, id);
  if (manifest) {
    manifest.builtin = false;
    return manifest;
  }
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const assets = names.filter((n) => ART_NAME_SET.has(n));
  if (!assets.length) return null;
  return { id, name: id, author: '', description: '', version: '', skin: 'classic', accent: 'spark', colors: {}, assets, builtin: false };
}

/**
 * 把 hxl-art://<名字> 解析成磁盘路径。查找顺序：
 *   1. 当前选中包的 _custom 替换层 + 包自带图
 *   2. 老的平铺布局 userData/art-pack/<名字>（仅内置包 / 品牌头像，见下）
 *   3. 内置 src/assets/<名字>
 * 返回 null 表示这个名字不合法（调用方给 403）。
 */
function resolveAsset(userData, packId, name, bundledRoot) {
  const file = String(name || '');
  if (!ART_NAME_SET.has(file)) return null;

  const root = packRoot(userData);
  const chosen = validId(packId) && packId !== BUILTIN_ID ? packId : '';
  /*
   * 品牌 logo（character-face.png）不跟主题包走（2026-11-22 用户反馈）：
   * 这是启动器自己的标识，换立绘可以，脸不能跟着换。
   * 用户自己在老平铺布局里放的 logo 仍然优先，其次才是内置图；
   * 选中的主题包目录里那张 character-face.png 直接跳过。
   */
  const isBrandLogo = file === 'character-face.png';
  const candidates = [];
  if (chosen && !isBrandLogo) {
    // 自定义包：用户替换层优先，其次包自带原图，再到老平铺层，最后内置。
    // 平铺层 root/file 只由「内置包状态下 pick」或品牌头像写入，不会由自定义包写，
    // 因此不存在跨包串图；保留它让老用户在内置包放的自定义图切换主题包后仍生效。
    candidates.push(path.join(root, chosen, CUSTOM_DIR, file));
    candidates.push(path.join(root, chosen, file));
    candidates.push(path.join(root, file));
  } else {
    // 内置包（chosen 为空）或品牌头像：走平铺层，再回落内置。
    candidates.push(path.join(root, file));
  }
  candidates.push(path.join(String(bundledRoot || ''), file));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** 渲染层拿到的东西：去掉 assets 明细之外的一切路径细节，免得把本机目录漏给页面。 */
function publicPack(pack) {
  return {
    id: pack.id,
    name: pack.name,
    author: pack.author || '',
    description: pack.description || '',
    version: pack.version || '',
    skin: pack.skin || '',
    accent: pack.accent || '',
    colors: { ...(pack.colors || {}) },
    builtin: pack.builtin === true,
    count: Array.isArray(pack.assets) ? pack.assets.length : 0,
    assets: Array.isArray(pack.assets) ? [...pack.assets] : [],
    customs: Array.isArray(pack.customs) ? [...pack.customs] : [],
  };
}

module.exports = {
  ART_NAMES,
  ART_NAME_SET,
  BUILTIN_ID,
  PACK_DIR,
  MANIFEST,
  CUSTOM_DIR,
  COLOR_KEYS,
  SKIN_IDS,
  ACCENT_IDS,
  packRoot,
  validId,
  safeColor,
  readManifest,
  listPacks,
  findPack,
  resolveAsset,
  publicPack,
};
