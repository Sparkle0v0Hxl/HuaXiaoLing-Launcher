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

/**
 * 各游戏在注册表里用的「文本档位」枚举。
 *
 * 米哈游的原子画质项有两套写法：
 *   - 星铁的 GraphicsSettings_Model 用数字（0/1/2/3…）
 *   - 崩坏3 的 GENERAL_DATA_V2_PersonalGraphicsSettingV2 用字符串（"OFF"/"Low"/"Middle"/"High"/"Ultra"）
 * 字符串这套游戏内是分档的，所以这里按「低 → 高」把枚举值钉死，
 * 界面才能给下拉选项，而不是把 "Ultra" 原样丢给用户看。
 */
const TEXT_GRADE = ['OFF', 'Low', 'Middle', 'High', 'Ultra'];

const TEXT_CHOICES = {
  // 崩坏3 个人画质
  ShadowLevel: TEXT_GRADE,
  LightingQuality: TEXT_GRADE,
  PostFXQuality: TEXT_GRADE,
  WeatherQuality: TEXT_GRADE,
  GlobalIllumination: TEXT_GRADE,
  AmbientOcclusion: TEXT_GRADE,
  VolumetricLight: TEXT_GRADE,
  PostFXGrade: TEXT_GRADE,
  ParticleEmitLevel: TEXT_GRADE,
  AAType: ['OFF', 'FXAA', 'SMAA', 'TAA'],
  // 崩坏3 / 其它 Unity 单值项
  ShaderQualityStr: ['0', '18', '27', '36', '45'],
};

/** 文本档位 → 中文说法，用于 display 与下拉选项的文字。 */
const TEXT_LEVELS = {
  ShadowLevel: ['关闭', '低', '中', '高', '极高'],
  LightingQuality: ['关闭', '低', '中', '高', '极高'],
  PostFXQuality: ['关闭', '低', '中', '高', '极高'],
  WeatherQuality: ['关闭', '低', '中', '高', '极高'],
  GlobalIllumination: ['关闭', '低', '中', '高', '极高'],
  AmbientOcclusion: ['关闭', '低', '中', '高', '极高'],
  VolumetricLight: ['关闭', '低', '中', '高', '极高'],
  PostFXGrade: ['关闭', '低', '中', '高', '极高'],
  ParticleEmitLevel: ['关闭', '低', '中', '高', '极高'],
  AAType: ['关闭', 'FXAA', 'SMAA', 'TAA'],
  ShaderQualityStr: ['最低', '低', '中', '高', '极高'],
  // 没有专门定义的文本档位字段用这一套兜底（与 TEXT_GRADE 一一对应）
  Generic: ['关闭', '低', '中', '高', '极高'],
};

/** 帧率常见档位（崩坏3 允许 300 表示不锁）。 */
const FRAME_RATES = [30, 60, 90, 120, 144, 165, 240, 300];

/** 显示器编号：单选一份，避免两处各写一遍。 */
const MONITOR_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7];

/** 分辨率常见档位：给「先选一个常见分辨率，再手动微调」用。 */
const COMMON_RESOLUTIONS = [
  [1280, 720],
  [1366, 768],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
  [3440, 1440],
  [3840, 2160],
];

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
    // 游戏内实际最高只支持 120 帧，144/165/240 属于无效选项（用户要求移除）
    options: [30, 60, 90, 120],
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
  'Screenmanager Resolution Width': { label: '分辨率宽', unit: 'px', type: 'number', min: 640, max: 7680, help: 'Unity 引擎记录的画面宽度。下面的常见分辨率可以直接选。' },
  'Screenmanager Resolution Height': { label: '分辨率高', unit: 'px', type: 'number', min: 360, max: 4320, help: 'Unity 引擎记录的画面高度。下面的常见分辨率可以直接选。' },
  'Screenmanager Is Fullscreen mode': { label: '全屏', type: 'bool', help: '1 为全屏，0 为窗口。' },
  UnityGraphicsQuality: { label: '画质档位', type: 'enum', options: [0, 1, 2, 3, 4, 5], levels: ['最低', '低', '中', '高', '极高', '极致'], help: 'Unity 的画质等级索引，越高越精细。' },
  ShaderQualityStr: { label: '着色器质量', type: 'choice', help: '游戏内部使用的着色器档位标记。' },
  UnitySelectMonitor: { label: '显示器编号', type: 'enum', options: MONITOR_CHOICES, levels: MONITOR_CHOICES.map((n) => `第 ${n + 1} 块屏`), help: '多显示器时选择在第几块屏幕上全屏（从 0 开始，界面上按第 1/2/3… 块屏显示）。' },
  WINDOWS_HDR_ON: { label: 'Windows HDR', type: 'bool', help: '是否启用 HDR 输出，需要显示器支持。' },

  // ── 崩坏3 ──────────────────────────────────────
  'GENERAL_DATA_V2_GraphicsGrade': { label: '画质等级', type: 'enum', options: [0, 1, 2, 3, 4, 5, 6], levels: ['最低', '低', '中', '高', '极高', '极致', '自定义'], help: '崩坏3 的画质档位编号，越高越精细。' },
  // 崩坏3 另存的一份 JSON：{"height":1080,"width":1920,"isfullScreen":false}
  'GENERAL_DATA_V2_ScreenSettingData': { label: '屏幕设置', type: 'bool', help: '崩坏3 单独记录的屏幕设置（分辨率与是否全屏），和下面的分辨率项含义相同。' },

  // ── 星铁 / 绝区零的 Unity 整体画质索引 ────────────
  'GraphicsSettings_GraphicsQuality': { label: '画质档位索引', type: 'enum', options: [0, 1, 2, 3, 4, 5, 6], levels: ['自定义', '最低', '低', '中', '高', '极高', '极致'], help: 'Unity 引擎记录的画质等级索引。0 表示自定义（单独调下面的细节项），其余是游戏内的一键档位。' },
  'Graphics Settings Graphics Quality': { label: '画质档位索引', type: 'enum', options: [0, 1, 2, 3, 4, 5, 6], levels: ['自定义', '最低', '低', '中', '高', '极高', '极致'], help: 'Unity 引擎记录的画质等级索引。0 表示自定义，其余是游戏内的一键档位。' },

  // ── 崩坏3 个人画质 V2 ──────────────────────────
  ShadowLevel: { label: '阴影等级', type: 'choice' },
  LightingQuality: { label: '光照质量', type: 'choice' },
  PostFXQuality: { label: '后处理质量', type: 'choice' },
  AAType: { label: '抗锯齿方式', type: 'choice', help: 'OFF 关闭；FXAA 最轻；SMAA 居中；TAA 最稳但会略微发糊。' },
  WeatherQuality: { label: '天气质量', type: 'choice' },
  GlobalIllumination: { label: '全局光照', type: 'choice', help: '让环境光在物件之间互相反弹，越高越柔和。' },
  AmbientOcclusion: { label: '环境光遮蔽', type: 'choice', help: '墙角、缝隙这些凹处的接触阴影，开启更有层次。' },
  VolumetricLight: { label: '体积光', type: 'choice', help: '光线穿过雾气的可见光柱，比较吃显卡。' },
  PostFXGrade: { label: '后处理档位', type: 'choice', help: '泛光、暗角一类后处理的整体档位。' },
  LodGrade: { label: 'LOD 等级', type: 'enum', options: [0, 1, 2, 3, 4, 5], help: '远处物件的模型精度：数值越大保留的细节越多。' },
  ParticleEmitLevel: { label: '粒子发射等级', type: 'choice', help: '粒子特效的生成量与精细度。' },
  TargetFrameRateForInLevel: { label: '战斗内帧率上限', type: 'enum', options: FRAME_RATES, unit: 'fps', help: '关卡内锁定的帧率，300 表示不锁。' },
  TargetFrameRateForOthers: { label: '界面帧率上限', type: 'enum', options: FRAME_RATES, unit: 'fps', help: '主界面等非战斗场景的帧率上限，300 表示不锁。' },
  UseFXAA: { label: 'FXAA', type: 'bool' },
  UsePostFX: { label: '后处理', type: 'bool' },
  UseHDR: { label: 'HDR', type: 'bool' },
  UseDistortion: { label: '画面扭曲', type: 'bool' },
  VSync: { label: '垂直同步', type: 'bool', help: '开启后画面撕裂更少，但可能锁死在显示器刷新率。' },

  // ── JSON 型设置里的字段名 ───────────────────────
  // 崩坏3 的 ScreenSettingData 用小写的 height / width / isfullScreen，
  // 和 Unity 的 Screenmanager 写法（带空格）不同，需要单独收一份。
  height: { label: '分辨率高', type: 'number', unit: 'px', min: 360, max: 4320, help: '画面高度，下面的常见分辨率可以直接选。' },
  width: { label: '分辨率宽', type: 'number', unit: 'px', min: 640, max: 7680, help: '画面宽度，下面的常见分辨率可以直接选。' },
  isfullScreen: { label: '全屏', type: 'bool', help: 'true 为全屏，false 为窗口。' },
  isFullScreen: { label: '全屏', type: 'bool', help: 'true 为全屏，false 为窗口。' },
};

/** 星铁数字档位的中文名：数值越大画质越高。 */
const NUMERIC_QUALITY_LEVELS = ['关闭', '最低', '低', '中', '高', '极高', '极致'];

/** 质量等级 0-N 的通用中文说法，供没有专门定义的字段兜底。 */
const QUALITY_LEVELS = ['关闭', '最低', '低', '中', '高', '极高', '极致'];

/**
 * 单值项里数值档位的专门说法。
 *
 * 「Unity 画质索引」和「画质等级」都是 0..N，但意思完全不同：
 * 前者 0 是「自定义」，后者 0 是「最低」。所以不能都套 NUMERIC_QUALITY_LEVELS。
 */
const NUMERIC_OVERLAY = {
  'UnityGraphicsQuality': ['自定义', '最低', '低', '中', '高', '极高'],
  'GENERAL_DATA_V2_GraphicsGrade': ['最低', '低', '中', '高', '极致', '自定义', '极致'],
};

/** 给文本档位字段补上 options / levels。 */
for (const [field, schema] of Object.entries(FIELD_SCHEMA)) {
  if (schema.type === 'choice') {
    schema.options = TEXT_CHOICES[field] || TEXT_GRADE;
    schema.levels = TEXT_LEVELS[field] || TEXT_GRADE.map((v) => v);
    continue;
  }
  // 数字档位（0..N）统一按「关闭 / 最低 / 低 / 中 / 高 / 极高 / 极致」解释
  if (Array.isArray(schema.options) && schema.options.every((v) => typeof v === 'number')) {
    const increasing = schema.options.every((v, i, arr) => i === 0 || v > arr[i - 1]);
    if (!schema.levels && increasing && schema.unit !== 'px' && schema.options.length <= 7) {
      const offset = NUMERIC_QUALITY_LEVELS.length - schema.options.length;
      schema.levels = schema.options.map((_, i) => NUMERIC_QUALITY_LEVELS[Math.max(0, i + offset)]);
    }
  }
}

const TYPE_LABEL = { bool: '开关', number: '数值', enum: '选项', string: '文本' };

/**
 * 分档枚举的档位名必须和 options 一一对应，不能一律套 QUALITY_LEVELS。
 * （曾经把 FPS=120 解释成「中」、RenderScale=1 解释成「低」，都是错位的锅。）
 */
FIELD_SCHEMA.FPS.levels = ['30 帧', '60 帧', '90 帧', '120 帧'];
FIELD_SCHEMA.RenderScale.levels = ['0.6 倍', '0.8 倍', '1.0 倍', '1.2 倍', '1.5 倍', '2.0 倍'];
FIELD_SCHEMA.DlssQuality.levels = ['关闭', '性能', '平衡', '质量', '超级质量', 'DLAA'];
FIELD_SCHEMA.AAMode.levels = ['关闭', 'FXAA', 'TAA', 'SMAA'];
FIELD_SCHEMA.GraphicsQuality.levels = ['最低', '低', '中', '高', '极高'];

/**
 * 第三方游戏的画质档位（非米哈游）。
 *
 * 实测终末地**两套档位混用**：
 *   - `video_quality_main` 存小整数 0..5；
 *   - 各细分项 `video_quality_effect` 之类存 0/1000/2000/…5000 的千分位；
 *   - 开关项的「开」也是 1000 起步（`video_quality_reflex_1` = 0x7d0 = 2000）。
 * 所以这里不写死 options，而是用 `scale` 声明：
 *   scale='tier'  —— 值域自动判（<= 5 当小整数档，>= 1000 当千分位档）
 *   scale='flag'  —— 0 = 关，非 0 = 开
 *   scale='fps'   —— 1000 = 60fps，2000 = 120fps（实测只存这两档）
 * 游戏版本换了档位算法，界面上会原样显示数字而不是乱翻译，写入仍然只落到确认过的项上。
 */
const TIER_WORDS = ['关闭', '低', '中', '高', '极高', '极致'];
const tierSchema = (label, help, levels = TIER_WORDS) => ({ label, type: 'scale', scale: 'tier', levels, help });
const flagSchema = (label, help) => ({ label, type: 'scale', scale: 'flag', levels: ['关闭', '开启'], help });
/*
 * 注意：「开」在终末地存的不是 1 而是 0x7d0 = 2000（1000 是旧版 / 普通档）。
 * 所以开关项不能一律套 flagSchema / tierSchema —— 那样 2000 会被解释成「第二档」，
 * 于是冒出一堆「开启（高）」这种不存在的措辞。带枚举语义的字段下面都显式写 options + levels。
 */

const GENERIC_FIELD_SCHEMA = {
  // ── 终末地：窗口 / 分辨率（Unity 的 Screenmanager 一组）────────────
  'Screenmanager Resolution Width': { label: '分辨率宽', unit: 'px', type: 'number', min: 640, max: 7680, help: 'Unity 记录的渲染宽度。下面的常见分辨率可以直接选。' },
  'Screenmanager Resolution Height': { label: '分辨率高', unit: 'px', type: 'number', min: 360, max: 4320, help: 'Unity 记录的渲染高度。' },
  'Screenmanager Resolution Window Width': { label: '窗口宽度', unit: 'px', type: 'number', min: 640, max: 7680, help: '窗口模式下的窗口宽度。' },
  'Screenmanager Resolution Window Height': { label: '窗口高度', unit: 'px', type: 'number', min: 360, max: 4320, help: '窗口模式下的窗口高度。' },
  'Screenmanager Fullscreen mode': { label: '全屏模式', type: 'enum', options: [0, 1, 3], levels: ['独占全屏', '全屏窗口', '窗口'], help: '0 独占全屏；1 全屏窗口；3 普通窗口。' },
  'Screenmanager Resolution Use Native': { label: '使用原生分辨率', type: 'bool', help: '1 表示跟随显示器原生分辨率。' },
  'Screenmanager Stereo 3D': { label: '立体 3D', type: 'enum', options: [0, 1], levels: ['关闭', '开启'], help: 'Unity 的立体 3D 模式，0 为关闭。' },

  // ── 终末地：画面 ────────────────────────────────────────────────
  video_resolution_width: { label: '渲染宽度', unit: 'px', type: 'number', min: 640, max: 7680, help: '游戏自己记录的画面宽度。' },
  video_resolution_height: { label: '渲染高度', unit: 'px', type: 'number', min: 360, max: 4320, help: '游戏自己记录的画面高度。' },
  video_full_screen: flagSchema('全屏', '0 窗口运行，1 全屏运行。'),
  video_frame_rate_8: { label: '帧率上限', unit: 'fps', type: 'scale', scale: 'fps', levels: ['60 fps', '120 fps'], help: '游戏内允许的最高帧率。实测只有 60 / 120 两档。' },
  video_custom_quality: flagSchema('自定义画质', '开表示当前画质是逐项自定义的，下面各项单独生效。'),
  video_quality_main: tierSchema('总体画质', '一键档位，改动会影响下面多数选项。'),
  video_quality_effect: tierSchema('特效质量', '技能与场景粒子特效的精度。'),
  video_quality_shadowmap: tierSchema('阴影质量', '阴影贴图分辨率与软化程度。'),
  video_quality_volumetricfog: tierSchema('体积雾', '光线穿过雾气的可见光柱，比较吃显卡。'),
  video_quality_ao: tierSchema('环境光遮蔽', '墙角、缝隙这些凹处的接触阴影。'),
  video_quality_contactshadow: tierSchema('接触阴影', '角色与物件贴着地面那圈细阴影。'),
  video_quality_screenspacereflection: tierSchema('屏幕空间反射', '水面与地面的镜面反射精度。'),
  video_quality_scene_detail: tierSchema('场景细节', '植被、远景物件等场景素材的精细度。'),
  video_quality_environment_renderfeature: tierSchema('环境渲染特性', '环境光、天气等场景渲染特性的总档位。'),
  video_texture_quality: tierSchema('纹理质量', '贴图分辨率，越高越清晰也越占显存。'),
  video_quality_grass_sparsity: tierSchema('植被密度', '草地与小植被的生成密度。', ['稀疏', '较低', '中', '较高', '茂密']),
  video_quality_sharpness: tierSchema('锐化强度', '后处理锐化，能抵消一部分超分带来的糊感。', ['关闭', '低', '中', '高']),
  video_quality_anisoLevel: tierSchema('各向异性过滤', '斜视地面时贴图的清晰度，档位越高越清晰。', ['关闭', '2x', '4x', '8x', '16x']),
  video_quality_dlss_mode: tierSchema('DLSS 档位', 'NVIDIA 深度学习超采样。档位越高画质越好、帧率越低。', ['关闭', '性能', '平衡', '质量', 'DLAA']),
  /*
   * 下面这几个不是「千分位档位」，而是各自的枚举值，必须显式写 options。
   *
   * 用 tier（0/1000/2000…按 n/1000-1 取 levels 下标）来硬套会错位：
   *   DLSS 帧生成的真实值是 0 / 1000 / 2000 / 3000 / 4000，
   *   对应 关闭 / 开启 / 2 倍 / 3 倍 / 4 倍（DLSS 4 多帧生成）。
   *   写成四档的话 4000 就落不进表里，界面只能显示「游戏当前值（4000）」。
   */
  video_quality_dlssg_mode: {
    label: 'DLSS 帧生成',
    type: 'enum',
    // 1000 是旧版的「开启」（= 2 倍），单独列出来免得落在预设之外
    options: [0, 1000, 2000, 3000, 4000],
    levels: ['关闭', '开启', '2 倍', '3 倍', '4 倍'],
    help: 'DLSS 4 多帧生成：2 倍 / 3 倍 / 4 倍，每帧最多多插 1~3 帧。需要 RTX 40 系以上显卡。',
  },
  video_quality_framegen: {
    label: '帧生成',
    type: 'enum',
    options: [0, 1000, 2000],
    levels: ['关闭', '开启', '开启（增强）'],
    help: '用插帧方式提升显示帧率，会牺牲一点延迟。',
  },
  video_quality_reflex: {
    label: 'Reflex 低延迟',
    type: 'enum',
    options: [0, 1000, 2000],
    levels: ['关闭', '开启', '开启（增强）'],
    help: 'NVIDIA Reflex，降低输入延迟。增强档会额外限制帧率以进一步降延迟。',
  },
  video_quality_upscaler: {
    label: '超分方式',
    type: 'enum',
    options: [0, 1000, 2000, 3000],
    levels: ['关闭', '自动', 'FSR', 'DLSS'],
    help: '用低分辨率渲染再放大，换取帧率。',
  },
};

/**
 * 同一个键名在不同游戏里含义不同的情况（第三方游戏统一按含义取字典）。
 * 例如鹰角两家的帧率键叫 `video_frame_rate_8`，末尾的 8 是它们的内部序号，不是档位值。
 */
const GAME_FIELD_OVERRIDES = {
  endfield: {},
  arknights: {},
};

/**
 * 这些字段在同一份配置里多个位置出现时，优先采用更「当前」的那条。
 *
 * 注意 `Stereo 3D` / `Window Position` 这类项：终末地的 `Stereo 3D` 是 Unity 的立体 3D 模式，
 * 属于真画质项，不能当元数据删；只有 `Window Position`（窗口坐标）这种和画质无关的才过滤。
 */
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
  return /_Version_h|ClearVersion|IsConvertedFrom|IsUserSave|Use Native Default|Width Default|Height Default|Fullscreen mode Default|Window Position|ShaderWarmUp|shaderLabSubVersion|warm_?up|zstd|il2cpp|sessionid|session_count/i.test(
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

/** 词典查不到时，给个能看懂的中文兜底；键名一律翻成中文，不留英文原串。 */
const KEY_LABELS = {
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
  BloomQuality: '泛光质量',
  CharacterQuality: '角色质量',
  LightQuality: '光照质量',
  ShadowQuality: '阴影质量',
  ReflectionQuality: '反射质量',
  EnvDetailQuality: '环境细节',
  SFXQuality: '特效质量',
  ResolutionQuality: '分辨率质量',
  DlssQuality: 'DLSS 档位',
  AAMode: '抗锯齿',
  EnableVSync: '垂直同步',
  EnableSelfShadow: '角色自阴影',
  EnableHalfResTransparent: '半分辨率透明',
  EnableMetalFXSU: 'MetalFX 超分',
  ParticleTrailSmoothness: '粒子拖尾平滑',
  RenderScale: '渲染倍率',
  GraphicsQuality: '总体画质',
  FPS: '帧率上限',
  isFullScreen: '全屏',
  width: '分辨率宽',
  height: '分辨率高',
};

/**
 * 词根表：给词典没登记、但由已知词根拼出来的键兜底（`video_quality_grass_sparsity`
 * 这种）。只放「翻译后放在画质上下文里一定说得通」的词，拿不准的宁可留占位，
 * 也不要把错的中文贴到可以直接写入的配置项上。
 */
const WORD_LABELS = {
  resolution: '分辨率',
  width: '宽',
  height: '高',
  window: '窗口',
  fullscreen: '全屏',
  full: '全',
  screen: '屏',
  mode: '模式',
  stereo3d: '立体 3D',
  monit: '显示器',
  monitor: '显示器',
  quality: '质量',
  main: '总体',
  effect: '特效',
  shadowmap: '阴影',
  volumetricfog: '体积雾',
  ao: '环境光遮蔽',
  contactshadow: '接触阴影',
  screenspacereflection: '屏幕空间反射',
  anisolevel: '各向异性过滤',
  scene: '场景',
  detail: '细节',
  environment: '环境',
  renderfeature: '渲染特性',
  grass: '植被',
  sparsity: '密度',
  sharpness: '锐化强度',
  dlss: 'DLSS',
  dlssg: 'DLSS 帧生成',
  framegen: '帧生成',
  reflex: 'Reflex 低延迟',
  upscaler: '超分方式',
  texture: '纹理',
  frame: '帧',
  rate: '率',
  custom: '自定义',
  video: '画面',
  graphics: '画面',
  render: '渲染',
  display: '显示',
  vsync: '垂直同步',
  antialias: '抗锯齿',
  antialiasing: '抗锯齿',
  shadow: '阴影',
  bloom: '泛光',
  hdr: 'HDR',
  reflection: '反射',
  reflections: '反射',
  aniso: '各向异性过滤',
};

function humanizeKey(key) {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  const base = String(key || '').replace(/_h\d+$/, '');
  if (KEY_LABELS[base]) return KEY_LABELS[base];
  if (GENERIC_FIELD_SCHEMA[base] && GENERIC_FIELD_SCHEMA[base].label) return GENERIC_FIELD_SCHEMA[base].label;
  // 第三方游戏常见 `video_quality_xxx_1` / `video_texture_quality_1` 这类带序号后缀的键：
  // 去掉末尾序号再查一遍，仍然命中同一套画质词库。
  const trimmed = base.replace(/_\d+$/, '');
  if (KEY_LABELS[trimmed]) return KEY_LABELS[trimmed];
  if (GENERIC_FIELD_SCHEMA[trimmed] && GENERIC_FIELD_SCHEMA[trimmed].label) return GENERIC_FIELD_SCHEMA[trimmed].label;
  // 逐词兜底：把 `screenspacereflection`、`volumetricfog` 这类连写词拆开查词根表
  const tokens = trimmed
    .replace(/^Screenmanager\s+/i, '')
    .replace(/^GENERAL_DATA_V2_/, '')
    .split(/[_\s]+|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean);
  const words = tokens.map((token) => WORD_LABELS[token.toLowerCase()] || WORD_LABELS[token] || '');
  if (words.length && words.every(Boolean)) return words.join('');
  // 部分能翻、部分不能翻时，把能翻的拼起来并注明原文，避免整行变成「其它设置」
  const known = words.filter(Boolean);
  if (known.length) return `${known.join('')}（${trimmed}）`;
  // 最后兜底：标题里带英文字母说明词典还没覆盖，直接给中文占位而不是把英文丢给用户
  const spaced = trimmed
    .replace(/^Screenmanager\s+/i, '')
    .replace(/^GENERAL_DATA_V2_/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return spaced && /[一-龥]/.test(spaced) ? spaced : `其它设置（${base}）`;
}

/**
 * 判断一条注册表项是不是画质配置（而不是账号 / SDK / 存档之类的噪音）。
 *
 * 为什么要「先删业务数据、再按形状匹配」：
 * 终末地把 250 个值（大量存档、资源下载记录、蓝图、掉落统计）和那几十个画面项
 * 塞在同一个注册表项里。早期用宽泛的 `/Graphics|Quality|Character|Light/` 去匹配，
 * 结果 `character_gender`、`hg_warm_up_graphics`、`PLDK_resourceSize_Video`
 * 这些全被当成画质项，界面上一堆「其它设置（原始键名）」。
 *
 * 现在分两步：
 *   1. 先按前缀/词根剔掉业务数据（存档、资源包、账号、音视频语言、新手引导…）；
 *   2. 再只认「画质类键的典型形状」：Unity 的 Screenmanager/UnityXxx 一组、
 *      `video_quality_*` 这类业务前缀 + 画质词，或米哈游直白的 Graphics/Quality 命名。
 *
 * 新增游戏时如果它的画质键名是别的风格，往 GRAPHICS_SHAPE 里补一条即可，
 * 不要为了「多读到几个值」去放宽 FINAL 前面那些删除规则 —— 读进来的每一行都是可以直接写的。
 */
const BUSINESS_NOISE =
  /^(MIHOYO|SDK_|HOYO_|QR_CODE|USER_|App_|User_|CnLive|Curvy_|u8sdk|hg(?:_|$)|PLDK_|unity\.|KEY_|key_|Key_|hotfix|LAST_|il2cpp|shader-|common_setting|ManualCraft|GENERAL_DATA_V2_PersonalAudio|GENERAL_DATA_V2_SettingsInfo|GENERAL_DATA_V2_SDK)|cached|character_|char_|player_|account|login|uid|role|quest|inventory|battle|stage|mission|annouce|announce|voice|audio|language|Gacha|Shop|Mail|Team|Friend|Daily|score|rank/i;

/** 画质类键名的典型形状（改前先确认命中的每一条都真是画质项）。 */
const GRAPHICS_SHAPE = new RegExp(
  [
    '^Screenmanager\\s+(Resolution|Fullscreen|Is\\s+Fullscreen|Stereo|Window)',
    '^UnitySelectMonitor',
    '^UnityGraphicsQuality',
    '^GraphicsSettings',
    '^Graphics Settings',
    '^GENERAL_DATA_V2_PersonalGraphics',
    '^GENERAL_DATA_V2_GraphicsGrade',
    // 崩坏3 把分辨率与全屏另存一份 JSON：{"height":1080,"width":1920,"isfullScreen":false}
    // 注意这里是 `GraphicsSetting`，漏掉会让崩坏3 的分辨率/全屏整组不见了（它和
    // PersonalGraphicsSettingV2 里那几项是同一份数据的两种写法，展示时会被去重）。
    '^GENERAL_DATA_V2_ScreenSetting',
    '^(video|graphics|render|display)_(quality|resolution|frame|frame_rate|full_?screen|custom_quality|texture)',
    '^(video_quality|video_texture|video_resolution|video_frame|video_full)',
    '(^|_)(quality|resolution|fullscreen|frame_?rate|vsync|antialias|antialiasing|shadow|shadowmap|bloom|hdr|dlss|dlssg|upscaler|framegen|reflex|sharpness|aniso|reflection|reflections|texture)(?:_|$)',
  ].join('|'),
  'i'
);

function isGraphicsEntry(name) {
  if (!name) return false;
  const key = baseKey(name);
  if (!key) return false;
  if (BUSINESS_NOISE.test(key)) return false;
  if (GRAPHICS_SHAPE.test(key)) return true;
  // 米哈游 / Unity 常见的零散单值项：只在没有明显业务前缀时按整词认
  return /^(UseFXAA|UsePostFX|UseHDR|UseDistortion|VSync|TargetFrameRateForInLevel|TargetFrameRateForOthers|LodGrade|ParticleEmitLevel|ShadowLevel|LightingQuality|PostFXQuality|PostFXGrade|WeatherQuality|GlobalIllumination|AmbientOcclusion|VolumetricLight|AAType|ShaderQualityStr|WINDOWS_HDR_ON|GraphicsQuality|BloomQuality|CharacterQuality|LightQuality|ShadowQuality|ReflectionQuality|EnvDetailQuality|SFXQuality|ResolutionQuality|DlssQuality|RenderScale|FPS|AAMode)$/.test(
    key
  );
}

/**
 * 第三方游戏的「缩放档位」取值：值不是下标，而是 0 / 1000 / 2000… 这样的量级数。
 *
 *   scale='tier' —— <=5 的按小整数下标（终末地 `video_quality_main` 存 0..5），
 *                   >=1000 的按千分位（`video_quality_effect` 存 3000 = 第 3 档）
 *   scale='flag' —— 0 = 关，非 0 = 开
 *   scale='fps'  —— 1000 = 60fps，2000 = 120fps
 *
 * 返回 { text, kind }。认不出来的值原样显示，不瞎猜。
 */
function describeScaled(schema, value) {
  const levels = Array.isArray(schema.levels) ? schema.levels : [];
  const n = Number(value);
  if (!Number.isFinite(n)) return { text: String(value ?? ''), kind: 'other' };
  const out = (index, prefix = '') => {
    const word = levels[index];
    if (!word) return { text: `${prefix}${n}`, kind: 'other' };
    return { text: `${prefix}${n} · ${word}`, kind: 'option' };
  };

  if (schema.scale === 'flag') {
    return n !== 0 ? { text: `${n} · 开启`, kind: 'bool' } : { text: '0 · 关闭', kind: 'bool' };
  }
  if (schema.scale === 'fps') {
    const index = n >= 1000 ? Math.round(n / 1000) - 1 : n;
    return out(index);
  }
  // tier：小整数和千分位两套都认
  const index = n >= 1000 ? Math.round(n / 1000) - 1 : n;
  if (index < 0 || index >= levels.length) return { text: String(n), kind: 'other' };
  return out(index);
}

/**
 * 把一个字段的取值翻成中文。
 *
 * 返回 { text, kind }：
 *   text —— 给人看的文字（数值字段带单位）
 *   kind —— option / bool / number / unsupported
 */
function describeValue(schema, value) {
  if (schema && schema.type === 'scale' && !Array.isArray(schema.options)) {
    return describeScaled(schema, value);
  }
  const isText = typeof value === 'string';
  const options = Array.isArray(schema.options) ? schema.options : null;

  if (isText) {
    const text = String(value);
    /*
     * 崩坏3 在没启用对应画质档时，会把这些字段写成字面量字符串 "undefined" / "null"。
     * 这是游戏自己写进去的坏值，不是我们读错；照实显示会变成「undefined（undefined）」，
     * 直接标成「未设置」，下拉里就能让用户正常选一个档位覆盖掉。
     */
    if (text === 'undefined' || text === 'null') return { text: '未设置', kind: 'option' };
    const table = options && options.length ? options : TEXT_GRADE;
    // 档位中文表必须与候选表一一对应，对不上就退回英文原串显示，
    // 不能拿长度不一致的表去按下标取词 —— 那会取到 undefined。
    const levels = schema.levels && schema.levels.length === table.length
      ? schema.levels
      : (TEXT_LEVELS.Generic.length === table.length ? TEXT_LEVELS.Generic : null);
    // 先按候选表精确匹配，再按大小写不敏感匹配（游戏存 HIGH、表里写 High）
    let index = table.indexOf(text);
    if (index < 0) index = table.findIndex((item) => String(item).toLowerCase() === text.toLowerCase());
    if (index < 0) return { text, kind: 'other' };
    const word = levels ? levels[index] || '' : '';
    if (!word) return { text, kind: 'option' };
    if (word === text) return { text, kind: 'option' };
    // 中文之外还留着原始枚举，方便和游戏内截图对照
    return { text: `${word}（${text}）`, kind: 'option' };
  }

  if (options) {
    const index = options.indexOf(value);
    const word = index >= 0 ? (schema.levels && schema.levels[index]) || '' : '';
    const unitText = schema.unit ? ` ${schema.unit}` : '';
    if (index >= 0) {
      return { text: word ? `${value}${unitText} · ${word}` : `${value}${unitText}`, kind: 'option' };
    }
    // 不在预设范围内：可能是游戏版本更新加了新档位。
    // 原样显示，但不要吓唬用户「不在预设里」——第三方游戏的档位本来就可能随时变。
    return { text: `${value}${unitText}`, kind: 'other' };
  }

  if (schema.type === 'bool' || typeof value === 'boolean') {
    return { text: value ? '开启' : '关闭', kind: 'bool' };
  }
  if (typeof value === 'number') {
    return { text: schema.unit ? `${value} ${schema.unit}` : String(value), kind: 'number' };
  }
  return { text: String(value ?? ''), kind: 'number' };
}

/**
 * 取一个字段的词典项。同一个键在不同游戏里类型不同：
 *   星铁的 CharacterQuality 是 0-4 的数字，崩3 的 CharacterQuality 是 "High" 这样的字符串。
 * 所以这里按**值的实际类型**分流：字符串值一律用文本档位表，数字值用原始词典。
 *
 * 第三方游戏的键常带序号后缀（`video_quality_main_1`、`video_quality_dlss_mode_1`），
 * 去掉末尾序号再查一遍，让同一套词库覆盖「第一档 / 第二档」这种多实例配置。
 */
function lookupSchema(field) {
  const key = String(field || '');
  const direct = FIELD_SCHEMA[key] || GENERIC_FIELD_SCHEMA[key];
  if (direct) return direct;
  const trimmed = key.replace(/_\d+$/, '');
  if (trimmed !== key) return FIELD_SCHEMA[trimmed] || GENERIC_FIELD_SCHEMA[trimmed] || null;
  return null;
}

function fieldSchema(field, value) {
  // 老词典优先；新游戏的键只在老词典没有时才查，避免两边定义打架
  const base = lookupSchema(field) || {};
  if (typeof value !== 'string') return base;
  const options = TEXT_CHOICES[field] || TEXT_CHOICES[baseKey(field)] || TEXT_GRADE;
  const levels = TEXT_LEVELS[field] || TEXT_LEVELS[baseKey(field)] || TEXT_LEVELS.Generic;
  return { ...base, type: 'choice', options, levels };
}

/**
 * 一个字段本质上是不是「开 / 关」两态。
 *
 * 满足任意一条就算：
 *   - 词典标了 type:'bool'
 *   - 词典是 scale:'flag'（终末地存 0 / 1000 表示关 / 开）
 *   - 值是 boolean
 *   - 候选值恰好是 [0, 1] 且档位文字就是「关闭 / 开启」
 *     （`Screenmanager Stereo 3D`、`Screenmanager Resolution Use Native` 这类 Unity 原生布尔）
 *
 * 这些一律做成开关按钮，不做下拉 —— 只有两项的下拉点开就等于直接写入，
 * 中间没有任何「选择」的过程，用户会以为是点一下就被改了。
 */
function isBinaryField(schema, value, options, levels) {
  if (schema && schema.type === 'bool') return true;
  if (schema && schema.type === 'scale' && schema.scale === 'flag') return true;
  if (typeof value === 'boolean') return true;
  if (!Array.isArray(options) || options.length !== 2) return false;
  // 候选必须是 0 / 1（顺序不限）
  const set = options.map((item) => Number(item)).sort((a, b) => a - b);
  if (set[0] !== 0 || set[1] !== 1) return false;
  // 档位文字要明确是开/关，否则可能只是恰好有 0、1 两个档别的含义（比如难度）
  const words = (Array.isArray(levels) ? levels : []).map((item) => String(item));
  if (!words.length) return true;
  return words.some((word) => /开启|关闭|开$|关$|启用|禁用|是|否/.test(word));
}

/** 一个字段在界面上能不能改：有预设选项、是开关、或是有限范围的数值。 */
function editType(schema, value, options, levels) {
  const opts = Array.isArray(schema.options) ? schema.options : options;
  const words = Array.isArray(schema.levels) ? schema.levels : levels;
  if (typeof value === 'string') return 'option';
  /*
   * 开 / 关两态优先判定，做成按钮而不是下拉。
   * 以前 `scale` 统一被当成 option，而 Unity 的 `Screenmanager Stereo 3D`
   * 是 options:[0,1] + levels:['关闭','开启']，结果变成了只有两项的下拉。
   */
  if (isBinaryField(schema, value, opts, words)) return 'bool';
  const list = Array.isArray(opts) ? opts : null;
  if (list && list.length && list.length <= 12) return 'option';
  // scale 不是固定枚举，但候选值有限（0 / 1000 / 2000…），当选项处理
  if (schema.type === 'scale') return 'option';
  if (typeof value === 'number' || schema.type === 'number') return 'number';
  return 'number';
}

/** scale 字段的可选值：tier 给千分位档位（终末地细分项就是这么存的），档位数以 levels 为准。 */
function scaleChoices(schema) {
  const levels = Array.isArray(schema.levels) ? schema.levels : [];
  if (schema.scale === 'flag') return [0, 1000];
  if (schema.scale === 'fps') return [1000, 2000];
  return levels.map((_, index) => index * 1000);
}

/** 数值类字段的候选档位：分辨率给常见分辨率，其它给一个由当前值扩出来的范围。 */
function valueChoices(name, schema, value) {
  const key = baseKey(name);
  if (schema && schema.type === 'scale') return scaleChoices(schema);
  if (/Resolution Width/.test(key) || key === 'width' || /ResolutionWidth/.test(key)) {
    // 去重：2560×1440 与 3440×1440 的高度相同，按列取值会出现两个一样的档位
    return [...new Set(COMMON_RESOLUTIONS.map(([w]) => w))];
  }
  if (/Resolution Height/.test(key) || key === 'height' || /ResolutionHeight/.test(key)) {
    return [...new Set(COMMON_RESOLUTIONS.map(([, h]) => h))];
  }
  const min = Number.isFinite(schema.min) ? schema.min : 0;
  const max = Number.isFinite(schema.max) ? schema.max : 8;
  const out = [];
  for (let v = min; v <= max; v += 1) out.push(v);
  const current = Number(value);
  if (Number.isFinite(current) && !out.includes(current)) out.push(current);
  return out;
}

/**
 * 把一条注册表项翻译成字段列表。
 * 返回 { name, title, subtitle, fields: [{
 *   name, key, label, value, display, type, options, choices, levels, min, max, unit, help
 * }] }
 *
 * type 取值：
 *   option —— 有预设档位，用下拉/分段选
 *   bool   —— 开关
 *   number —— 数值（分辨率这类），给了常见候选 + 可手填
 */
/**
 * 一个字段在界面上要暴露给渲染层的选项信息。
 *
 * `scale` 类字段没有固定 options，但候选值有限（0/1000/2000…），
 * 这里补成和普通枚举一样的形状，前端不用为它写特例。
 */
function renderOptions(schema) {
  if (schema && schema.type === 'scale' && !Array.isArray(schema.options)) {
    const choices = scaleChoices(schema);
    const levels = Array.isArray(schema.levels) ? schema.levels : [];
    return {
      options: choices,
      levels: choices.map((_, index) => levels[index] || String(index)),
    };
  }
  return {
    options: Array.isArray(schema.options) ? schema.options : null,
    levels: schema.levels || null,
  };
}

/**
 * 有些值在注册表里是 REG_BINARY 的十六进制串，解出来其实是一段 JSON
 * （典型的是崩坏3 的 `GENERAL_DATA_V2_ScreenSettingData`）。
 *
 * 调用方未必会提前解析成 `entry.json`（`graphics-detect.js` 就只给原始串），
 * 所以这里自己解一次，解析不出来就返回 null，让上层按单值项处理。
 */
function decodeHexJson(raw) {
  const text = String(raw ?? '').trim();
  // 已经是 JSON 文本
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
    return null;
  }
  // 十六进制串：偶数长度、纯 hex，长度够长才可能是 JSON
  if (!/^(?:[0-9a-f]{2})+$/i.test(text) || text.length < 4) return null;
  let decoded;
  try {
    decoded = Buffer.from(text, 'hex').toString('utf8');
  } catch {
    return null;
  }
  decoded = decoded.replace(/\u0000+$/g, '').trim();
  if (!decoded.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}

function describeEntry(entry) {
  const name = entry.name || '';
  const key = baseKey(name);
  const json = entry.json && typeof entry.json === 'object' && !Array.isArray(entry.json)
    ? entry.json
    : decodeHexJson(entry.raw);
  if (json) {
    const fields = Object.entries(json).map(([field, value]) => {
      const schema = fieldSchema(field, value);
      const { text } = describeValue(schema, value);
      const { options, levels: shownLevels } = renderOptions(schema);
      const type = editType(schema, value, options, shownLevels);
      return {
        name: `${name}.${field}`,
        key: field,
        label: schema.label || humanizeKey(field),
        value,
        display: text,
        type,
        options,
        levels: shownLevels,
        choices: type === 'number' ? valueChoices(field, schema, value) : null,
        min: schema.min,
        max: schema.max,
        unit: schema.unit || '',
        help: schema.help || '',
      };
    });
    const title = /PCResolution/.test(name)
      ? '分辨率与窗口'
      : /Model/.test(name)
        ? '画质细节'
        : /PersonalGraphicsSettingV2/.test(name)
          ? '个人画质设置'
          : /ScreenSetting/.test(name)
            ? '屏幕设置'
            : humanizeKey(key);
    return { name, title, subtitle: name, fields };
  }

  // 单值项
  const schema = fieldSchema(key, null);
  const rawText = String(entry.raw ?? '').trim();
  let value = rawText;
  if (/^0x[0-9a-f]+$/i.test(rawText)) value = Number.parseInt(rawText, 16);
  else if (/^-?\d+(\.\d+)?$/.test(rawText)) value = Number(rawText);
  else if (rawText === 'True' || rawText === 'true') value = true;
  else if (rawText === 'False' || rawText === 'false') value = false;

  // 数值档位的专门说法（「Unity 画质索引」0 是自定义，「画质等级」0 是最低）
  let levels = schema.levels || null;
  if (Array.isArray(schema.options) && NUMERIC_OVERLAY[key] && NUMERIC_OVERLAY[key].length === schema.options.length) {
    levels = NUMERIC_OVERLAY[key];
  }

  const { text } = describeValue(levels ? { ...schema, levels } : schema, value);
  const shown = renderOptions(schema);
  // 把候选和档位文字一起传进去：「候选正好是 0/1 且写的是关闭/开启」也要认成开关
  const type = editType(schema, value, shown.options, shown.levels || levels);
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
        display: text,
        type,
        options: shown.options,
        levels: shown.levels || levels,
        choices: type === 'number' ? valueChoices(name, schema, value) : null,
        min: schema.min,
        max: schema.max,
        unit: schema.unit || '',
        help: schema.help || '',
      },
    ],
  };
}

module.exports = {
  TEXT_CHOICES,
  TEXT_LEVELS,
  COMMON_RESOLUTIONS,
  FRAME_RATES,
  describeValue,
  editType,
  valueChoices,
  FIELD_SCHEMA,
  GENERIC_FIELD_SCHEMA,
  GAME_FIELD_OVERRIDES,
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
