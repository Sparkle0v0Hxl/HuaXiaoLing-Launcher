'use strict';

/**
 * 画质配置的「词典」：把游戏写进注册表的原始键名翻译成中文，
 * 并说明每一档数值代表什么。
 *
 * 结构：
 *   FIELD_SCHEMA      字段名 -> { label, note, type, min, max, help }
 *   QUALITY_LEVELS    质量等级枚举文字
 *   FPS_PRESETS       帧率预设
 *   REGISTRY_MAP      游戏 key -> 注册表路径
 *   describeEntry()   把一条 { name, raw, json } 变成可展示的字段列表
 */

const FIELD_SCHEMA = {
  // ── 分辨率 / 窗口 ────────────────────────────────
  width: { label: '分辨率宽', unit: 'px', type: 'number', min: 640, max: 7680, help: '渲染画面宽度，改完需要重新启动游戏才生效。' },
  height: { label: '分辨率高', unit: 'px', type: 'number', min: 360, max: 4320, help: '渲染画面高度，和宽度一起决定分辨率。' },
  isFullScreen: { label: '全屏', type: 'bool', help: '开启后游戏占满整个屏幕；关闭则以窗口运行。' },

  // ── 星穹铁道 GraphicsSettings_Model ─────────────
  FPS: {
    label: '帧率上限',
    unit: 'fps',
    type: 'enum',
    options: [30, 60, 90, 120, 144, 165, 240],
    help: '游戏内允许的最高帧率。设备跑不满时实际帧率会更低。',
  },
  RenderScale: {
    label: '渲染倍率',
    type: 'enum',
    options: [0.6, 0.8, 1, 1.2, 1.5, 2],
    help: '内部渲染分辨率相对窗口的倍数。低于 1 更流畅但更糊，高于 1 是超采样，更清晰也更吃显卡。',
  },
  GraphicsQuality: { label: '总体画质', type: 'enum', options: [0, 1, 2, 3, 4], help: '一键档位，改动会影响下面多数选项。' },

  BloomQuality: { label: '泛光质量', type: 'enum', options: [0, 1, 2, 3, 4], help: '高光溢出的柔和光晕强度与精度。' },
  CharacterQuality: { label: '角色质量', type: 'enum', options: [0, 1, 2, 3, 4], help: '角色模型精度、布料与描边细节。' },
  LightQuality: { label: '光照质量', type: 'enum', options: [0, 1, 2, 3, 4, 5], help: '场景光照计算精度，越高越接近真实但越吃显卡。' },
  ShadowQuality: { label: '阴影质量', type: 'enum', options: [0, 1, 2, 3, 4], help: '阴影分辨率与软化程度。' },
  ReflectionQuality: { label: '反射质量', type: 'enum', options: [0, 1, 2, 3, 4, 5], help: '水面与地面的镜面反射精度。' },
  EnvDetailQuality: { label: '环境细节', type: 'enum', options: [0, 1, 2, 3, 4, 5], help: '植被、远景物件等环境素材的精细度。' },
  SFXQuality: { label: '特效质量', type: 'enum', options: [0, 1, 2, 3, 4], help: '技能与场景粒子特效的精度。' },
  ResolutionQuality: { label: '分辨率质量', type: 'enum', options: [0, 1, 2, 3, 4], help: '贴图与渲染分辨率的质量档。' },
  DlssQuality: {
    label: 'DLSS 档位',
    type: 'enum',
    options: [0, 1, 2, 3, 4, 5],
    help: 'NVIDIA 深度学习超采样。数值越大档位越高（画质更好、帧率更低）；0 表示关闭。',
  },
  AAMode: { label: '抗锯齿', type: 'enum', options: [0, 1, 2, 3], help: '0 关闭；1 FXAA；2 TAA；3 更高档 TAA。' },
  EnableVSync: { label: '垂直同步', type: 'bool', help: '开启后画面撕裂更少，但可能锁死在显示器刷新率。' },
  EnableSelfShadow: { label: '角色自阴影', type: 'bool', help: '角色自身投射阴影，关闭可小幅提升帧率。' },
  EnableHalfResTransparent: { label: '半分辨率透明', type: 'bool', help: '透明特效以半分辨率渲染，开启更流畅。' },
  EnableMetalFXSU: { label: 'MetalFX 超分', type: 'bool', help: 'Apple 平台专用，Windows 上无效。' },
  ParticleTrailSmoothness: { label: '粒子拖尾平滑', type: 'enum', options: [0, 1, 2, 3, 4, 5], help: '技能拖尾的平滑程度，越高越细腻。' },

  // ── 原神 Unity 旧格式 ───────────────────────────
  'Screenmanager Resolution Width': { label: '分辨率宽', unit: 'px', type: 'number', min: 640, max: 7680, help: 'Unity 引擎记录的画面宽度。' },
  'Screenmanager Resolution Height': { label: '分辨率高', unit: 'px', type: 'number', min: 360, max: 4320, help: 'Unity 引擎记录的画面高度。' },
  'Screenmanager Is Fullscreen mode': { label: '全屏', type: 'bool', help: '1 为全屏，0 为窗口。' },
  UnityGraphicsQuality: { label: '画质档位', type: 'number', min: 0, max: 5, help: 'Unity 的画质等级索引，越高越精细。' },
  ShaderQualityStr: { label: '着色器质量', type: 'string', help: '游戏内部使用的着色器档位标记。' },
  UnitySelectMonitor: { label: '显示器编号', type: 'number', min: 0, max: 8, help: '多显示器时选择在第几块屏幕上全屏（从 0 开始）。' },
  WINDOWS_HDR_ON: { label: 'Windows HDR', type: 'bool', help: '是否启用 HDR 输出，需要显示器支持。' },

  // ── 崩坏3 ──────────────────────────────────────
  'GENERAL_DATA_V2_GraphicsGrade': { label: '画质等级', type: 'number', min: 0, max: 6, help: '崩坏3 的画质档位编号，越高越精细。' },

  // ── 星铁 / 绝区零的 Unity 整体画质索引 ────────────
  'GraphicsSettings_GraphicsQuality': { label: 'Unity 画质索引', type: 'number', min: 0, max: 6, help: 'Unity 引擎记录的画质等级索引，游戏内切档位时会更新。' },
  'Graphics Settings Graphics Quality': { label: 'Unity 画质索引', type: 'number', min: 0, max: 6, help: 'Unity 引擎记录的画质等级索引，游戏内切档位时会更新。' },

  // ── 崩坏3 个人画质 V2 ──────────────────────────
  ShadowLevel: { label: '阴影等级', type: 'string' },
  LightingQuality: { label: '光照质量', type: 'string' },
  PostFXQuality: { label: '后处理质量', type: 'string' },
  AAType: { label: '抗锯齿方式', type: 'string' },
  WeatherQuality: { label: '天气质量', type: 'string' },
  GlobalIllumination: { label: '全局光照', type: 'string' },
  AmbientOcclusion: { label: '环境光遮蔽', type: 'string' },
  VolumetricLight: { label: '体积光', type: 'string' },
  PostFXGrade: { label: '后处理档位', type: 'string' },
  LodGrade: { label: 'LOD 等级', type: 'number', min: 0, max: 5 },
  ParticleEmitLevel: { label: '粒子发射等级', type: 'string' },
  TargetFrameRateForInLevel: { label: '战斗内帧率上限', type: 'number', unit: 'fps', help: '关卡内锁定的帧率，300 表示不锁。' },
  TargetFrameRateForOthers: { label: '界面帧率上限', type: 'number', unit: 'fps', help: '主界面等非战斗场景的帧率上限。' },
  UseFXAA: { label: 'FXAA', type: 'bool' },
  UsePostFX: { label: '后处理', type: 'bool' },
  UseHDR: { label: 'HDR', type: 'bool' },
  UseDistortion: { label: '画面扭曲', type: 'bool' },
  VSync: { label: '垂直同步', type: 'bool', help: '开启后画面撕裂更少，但可能锁死在显示器刷新率。' },
};

/** 质量等级 0-N 的通用中文说法，供没有专门定义的字段兜底。 */
const QUALITY_LEVELS = ['关闭', '最低', '低', '中', '高', '极高', '极致'];

const TYPE_LABEL = { bool: '开关', number: '数值', enum: '选项', string: '文本' };

/**
 * 分档枚举的档位名必须和 options 一一对应，不能一律套 QUALITY_LEVELS。
 * （曾经把 FPS=120 解释成「中」、RenderScale=1 解释成「低」，都是错位的锅。）
 */
FIELD_SCHEMA.FPS.levels = ['30 帧', '60 帧', '90 帧', '120 帧', '144 帧', '165 帧', '240 帧'];
FIELD_SCHEMA.RenderScale.levels = ['0.6 倍', '0.8 倍', '1.0 倍', '1.2 倍', '1.5 倍', '2.0 倍'];
FIELD_SCHEMA.DlssQuality.levels = ['关闭', '性能', '平衡', '质量', '超级质量', 'DLAA'];
FIELD_SCHEMA.AAMode.levels = ['关闭', 'FXAA', 'TAA', 'SMAA'];
FIELD_SCHEMA.GraphicsQuality.levels = ['最低', '低', '中', '高', '极高'];

/** 这些字段在同一份配置里多个位置出现时，优先采用更「当前」的那条。 */
const PREFERRED_NAMES = [
  'GraphicsSettings_Model_h2986158309',
  'GraphicsSettings_PCResolution_h431323223',
  'GENERAL_DATA_V2_PersonalGraphicsSettingV2_h3480068519',
  // Unity 的「当前值」优先于「Default（默认）」备份
  'Screenmanager Resolution Width_h182942802',
  'Screenmanager Resolution Height_h2627697771',
  'Screenmanager Fullscreen mode_h3630240806',
  'Screenmanager Is Fullscreen mode_h3981298716',
  'Screenmanager Resolution Use Native_h1405027254',
];

/** 纯元数据 / 备份项，配置卡片里不展示。 */
function isMetaEntry(name) {
  return /_Version_h|ClearVersion|IsConvertedFrom|IsUserSave|Use Native Default|Width Default|Height Default|Fullscreen mode Default|ShaderWarmUp|shaderLabSubVersion/i.test(
    String(name || '')
  );
}

const REGISTRY_MAP = {
  genshin: 'HKCU\\Software\\miHoYo\\原神',
  starrail: 'HKCU\\Software\\miHoYo\\崩坏：星穹铁道',
  zzz: 'HKCU\\Software\\miHoYo\\绝区零',
  bh3: 'HKCU\\Software\\miHoYo\\崩坏3',
};

/** 注册表值名带 Unity 的哈希后缀（`Resolution Width_h182942802`），查词典前要剥掉。 */
function baseKey(name) {
  return String(name || '').replace(/_h\d+$/, '');
}

/** 词典查不到时，给个能看懂的中文兜底。 */
function humanizeKey(key) {
  const table = {
    'Screenmanager Resolution Width': '分辨率宽',
    'Screenmanager Resolution Height': '分辨率高',
    'Screenmanager Fullscreen mode': '全屏模式',
    'Screenmanager Is Fullscreen mode': '全屏',
    'Screenmanager Resolution Use Native': '使用原生分辨率',
    'Screenmanager Resolution Use Native Default': '默认使用原生分辨率',
    'Screenmanager Resolution Width Default': '默认分辨率宽',
    'Screenmanager Resolution Height Default': '默认分辨率高',
    'Screenmanager Fullscreen mode Default': '默认全屏模式',
    'Screenmanager Stereo 3D': '立体 3D',
  };
  if (table[key]) return table[key];
  return key
    .replace(/_h\d+$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** 判断一条注册表项是不是画质配置（而不是账号 / SDK 之类的噪音）。 */
function isGraphicsEntry(name) {
  if (!name) return false;
  const key = baseKey(name);
  if (/^MIHOYO|^SDK_|^HOYO_|^QR_CODE|^USER_|^App_|^User_|^CnLive|^Curvy_|^GENERAL_DATA_V2_PersonalAudio/i.test(key)) {
    return false;
  }
  return /Graphics|Quality|Resolution|FPS|Fullscreen|Screenmanager|VSync|Render|AntiAlias|Shadow|Bloom|Shader|HDR|UnitySelectMonitor|Dlss|Reflection|Light|Character|EnvDetail|SFX|ParticleTrail|AAMode/i.test(
    key
  );
}

function decodeQuality(field, value) {
  const schema = FIELD_SCHEMA[baseKey(field)] || FIELD_SCHEMA[field];
  if (schema && schema.options && schema.options.includes(value)) {
    const index = schema.options.indexOf(value);
    if (schema.levels && schema.levels[index]) return schema.levels[index];
    return QUALITY_LEVELS[index] || `档位 ${index}`;
  }
  return '';
}

/**
 * 把一条注册表项翻译成字段列表。
 * 返回 { name, title, subtitle, fields: [{ name, key, label, value, display, type, options, help, unit }] }
 */
function describeEntry(entry) {
  const name = entry.name || '';
  const key = baseKey(name);
  const json = entry.json && typeof entry.json === 'object' ? entry.json : null;

  if (json) {
    const fields = Object.entries(json).map(([field, value]) => {
      const schema = FIELD_SCHEMA[field] || {};
      const type = schema.type || (typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'number' : 'string');
      const qualityWord = typeof value === 'number' ? decodeQuality(field, value) : '';
      return {
        name: `${name}.${field}`,
        key: field,
        label: schema.label || humanizeKey(field),
        value,
        display: qualityWord ? `${value} · ${qualityWord}` : String(value),
        type,
        options: schema.options || null,
        min: schema.min,
        max: schema.max,
        unit: schema.unit || '',
        help: schema.help || '',
      };
    });
    const title = /PCResolution/.test(name) ? '分辨率与窗口' : /Model/.test(name) ? '画质细节' : humanizeKey(key);
    return { name, title, subtitle: name, fields };
  }

  // 单值项
  const schema = FIELD_SCHEMA[key] || {};
  const rawText = String(entry.raw ?? '').trim();
  let value = rawText;
  if (/^0x[0-9a-f]+$/i.test(rawText)) value = Number.parseInt(rawText, 16);
  else if (/^-?\d+(\.\d+)?$/.test(rawText)) value = Number(rawText);
  else if (rawText === 'True' || rawText === 'true') value = true;
  else if (rawText === 'False' || rawText === 'false') value = false;

  const type = schema.type || (typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'number' : 'string');
  const qualityWord = typeof value === 'number' ? decodeQuality(key, value) : '';
  const label = schema.label || humanizeKey(key);
  return {
    name,
    title: label,
    subtitle: name,
    fields: [
      {
        name,
        key,
        label,
        value,
        // 带单位的数值（分辨率 px）不要再叠档位名字
        display: schema.unit ? `${value} ${schema.unit}` : qualityWord ? `${value} · ${qualityWord}` : String(value),
        type,
        options: schema.options || null,
        min: schema.min,
        max: schema.max,
        unit: schema.unit || '',
        help: schema.help || '',
      },
    ],
  };
}

module.exports = {
  FIELD_SCHEMA,
  QUALITY_LEVELS,
  TYPE_LABEL,
  REGISTRY_MAP,
  PREFERRED_NAMES,
  baseKey,
  humanizeKey,
  isGraphicsEntry,
  isMetaEntry,
  describeEntry,
};
