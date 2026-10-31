'use strict';

/*
 * settings —— 第 14 批从 app.js 搬出（原 app.js 711–1343 行，633 行逐行原样，逻辑零改动）。
 *
 * 按原顺序分五块：
 *   · 开关组件：switchMarkup / soundSwitchMarkup / paintSwitch / paintSwitches
 *     （就地切 class 与 aria-checked，不走整页重绘，滑块过渡才跑得起来）
 *   · 设置回显：settingsSignature / expectSettingsEcho / consumeSettingsEcho
 *     （主进程回推 state 时判断「这次回推是不是我自己刚点的」，避免打架）
 *   · 界面缩放：setUiScale / stepUiScale（写设置 + 通知主进程 + 提示条）
 *   · 候选值表：THEME_OPTIONS / ACCENT_OPTIONS / SETTINGS_TABS / AUDIO_LANGUAGE_LABELS
 *   · 设置页：platformText / settingsTab / audioLanguagesOf / settingsView
 *     （左侧导航 + 右侧只渲染当前分组，避免一长条往下翻）
 *
 * 跨文件：本文件在 index.html 里排在 app.js 之前。顶层只有一组纯字面量常量表
 * 和 settingsEcho（初值 null），没有任何 DOM 读取或立即执行的副作用；
 * 函数体内读的 state / dom / api / render / toast 都在 app.js，调用时才解析名字。
 */

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function switchMarkup(key, value) {
  return `<button class="switch ${value ? 'on' : ''}" role="switch" aria-checked="${Boolean(value)}" data-action="toggle-setting" data-key="${key}" title="${value ? '关闭' : '开启'}"></button>`;
}

function soundSwitchMarkup(key, value) {
  return `<button class="switch ${value ? 'on' : ''}" role="switch" aria-checked="${Boolean(value)}" data-action="toggle-sound" data-key="${key}" title="${value ? '关闭' : '开启'}"></button>`;
}

/**
 * 就地刷新一个开关的视觉和语义状态。
 *
 * 以前点开关走的是「改状态 → 等主进程回推 state → onState 整页 innerHTML 重绘」：
 * 重绘出来的按钮从出生起就是新状态，CSS transition 没有起点，滑块只会瞬移，
 * 用户看着就是「点了没反应」。这里改成直接在原节点上切 on / aria-checked，
 * 位移过渡才真的跑得起来。
 */
function paintSwitch(element, on) {
  if (!element) return;
  const next = Boolean(on);
  element.classList.toggle('on', next);
  element.setAttribute('aria-checked', next ? 'true' : 'false');
  element.title = next ? '关闭' : '开启';
}

/** 同一个开关可能在界面上出现两处（设置页 / 点歌台），一起就地刷新。 */
function paintSwitches(action, on) {
  document.querySelectorAll(`[data-action="${action}"]`).forEach((node) => paintSwitch(node, on));
}

/** 设置对象的内容指纹：键名排序后再比，免得两边插入顺序不同就对不上。 */
function settingsSignature(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return JSON.stringify(Object.keys(source).sort().map((key) => [key, source[key]]));
}

/*
 * 开关就地改完之后，主进程会回推一份内容相同的设置。那份回推如果触发整页
 * 重绘，刚跑起来的滑块动画会被掐断（新节点一出生就是终态），所以这里先记下
 * 「这份设置是我自己改的」，onState 收到就用不着重绘了。
 */
let settingsEcho = null;

function expectSettingsEcho(settings) {
  settingsEcho = { signature: settingsSignature(settings), at: Date.now() };
}

function consumeSettingsEcho(settings) {
  if (!settingsEcho) return false;
  // 过期了就丢掉，别让一次登记长期压着重绘
  if (Date.now() - settingsEcho.at >= 4000) {
    settingsEcho = null;
    return false;
  }
  // 不是这次的回推（例如下载进度的例行推送）：指纹留着，等真正那份回来
  if (settingsEcho.signature !== settingsSignature(settings)) return false;
  settingsEcho = null;
  return true;
}

/** 真正落地一个缩放比例：写设置、写本地记忆、通知主进程。 */
async function setUiScale(value, options = {}) {
  const scale = normalizeUiScale(value);
  state.settings.uiScale = scale;
  try {
    localStorage.setItem('vela:ui-scale', String(scale));
  } catch {
    /* 可选本地记忆 */
  }
  applyUiScaleClass(scale);
  if (typeof api.setUiScale === 'function') {
    await api.setUiScale(scale).catch(() => {});
  }
  if (options.render !== false) render({ preserveScroll: true });
  if (options.toast !== false) toast(`界面已缩放到 ${scale}%`, 'success');
  return scale;
}

/** 往上一个 / 下一个档位走。 */
function stepUiScale(direction) {
  const current = currentUiScale();
  const up = direction > 0;
  const next = up
    ? UI_SCALE_STEPS.find((step) => step > current)
    : [...UI_SCALE_STEPS].reverse().find((step) => step < current);
  if (!next) return;
  setUiScale(next);
}

/* 主题 / 强调色的候选值：界面渲染和点击校验共用同一份，
 * 免得两边列表不一致时出现「点得动但存不进去」。 */
const THEME_OPTIONS = [
  ['dark', '深色'],
  ['light', '浅色'],
  ['system', '跟随系统'],
];
const ACCENT_OPTIONS = [
  ['spark', '花火', '#e8435a'],
  ['gold', '金箔', '#f0c674'],
  ['sakura', '夜樱', '#f29ab2'],
  ['cyan', '青焰', '#6fe0d2'],
  ['rose', '玫瑰', '#f08ba6'],
  ['jade', '翡翠', '#5fd3a4'],
  ['violet', '紫罗兰', '#a98bf5'],
  ['amber', '琥珀', '#f5a35c'],
];

/* 设置页分组：左侧导航 + 右侧只渲染当前分组，避免一长条往下翻 */
const SETTINGS_TABS = [
  ['appearance', '外观', 'sparkle', '主题、强调色、称呼、头像和界面缩放'],
  ['window', '窗口', 'image', '窗口材质、自定义背景与透明度'],
  ['sound', '音效', 'volume', '界面反馈音、试听与音乐行为'],
  ['behavior', '行为', 'settings', '托盘、开机自启与自动同步'],
  ['storage', '存储', 'folder-open', '下载目录、运行时与终末地渠道包'],
  ['update', '更新', 'download', '更新源、自动检查与手动更新'],
  ['community', '社区', 'link', '项目主页、发布页与问题反馈'],
  ['about', '关于', 'info', '版本信息与相关链接'],
];

/** 把 process.platform 翻成人看的名字，写进反馈用的那段环境信息里。 */
function platformText() {
  const key = String((state.app && state.app.platform) || '').toLowerCase();
  const map = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  return map[key] || key || '未知';
}

function settingsTab() {
  let key = state.settingsTab;
  if (!key) {
    try {
      key = localStorage.getItem('vela:settings-tab') || '';
    } catch (error) {
      key = '';
    }
  }
  return SETTINGS_TABS.some((tab) => tab[0] === key) ? key : 'appearance';
}

/*
 * 米哈游系游戏（原神 / 星穹铁道 / 绝区零 / 崩坏3）的语音包语言，顺序固定
 * （和 electron/sophon.js 的 AUDIO_LANGUAGES 一致）。每种配音都要好几个 GB，
 * 默认只要中文，想听其它配音再勾。
 * 注意：终末地不适用这项设置——它的语音在 Unity bundle 里，官方清单没给可裁剪
 * 粒度（实测 EndOfficial 清单 1688 个文件 / 63.58GB 全是 VFS .chk），只能整包下载。
 */
const AUDIO_LANGUAGE_LABELS = [
  ['zh-cn', '中文'],
  ['en-us', '英语'],
  ['ja-jp', '日语'],
  ['ko-kr', '韩语'],
];

function audioLanguagesOf() {
  const raw = state.settings?.audioLanguages;
  const list = Array.isArray(raw) ? raw.map((item) => String(item || '').toLowerCase()) : [];
  const picked = AUDIO_LANGUAGE_LABELS.map(([key]) => key).filter((key) => list.includes(key));
  // 没勾过或勾了不认识的，退回只要中文
  return picked.length ? picked : ['zh-cn'];
}

function settingsView() {
  const settings = state.settings;
  const demos = state.games.filter((g) => g.demo).length;
  // 渠道包合并成一行之后，「就绪几个 / 一共几个」由这里一次算清（终末地 5 + 方舟 2）
  const packCount = channelPackCount(settings);
  const themeOptions = THEME_OPTIONS;
  const accents = ACCENT_OPTIONS;
  const tab = settingsTab();
  const group = (key, span) =>
    `settings-panel${key === tab ? ' is-active' : ''}${span ? ' settings-span' : ''}`;
  const groupAttr = (key) => `data-settings-group="${key}"`;
  const activeMeta = SETTINGS_TABS.find((item) => item[0] === tab) || SETTINGS_TABS[0];
  return `
    <div class="page page-settings">
      <div class="page-head">
        <div>
          <div class="eyebrow">${PAGE_META.settings.eyebrow}</div>
          <h1>设置</h1>
          <p class="sub">常用设置集中在这里，修改后立即保存。</p>
        </div>
      </div>
      <div class="settings-shell">
        <nav class="settings-nav" aria-label="设置分组">
          ${SETTINGS_TABS.map(
            ([key, label, ico]) =>
              `<button class="settings-nav-item ${key === tab ? 'active' : ''}" data-action="settings-tab" data-value="${key}" title="${label}">
                 ${icon(ico)}<span>${label}</span>
               </button>`
          ).join('')}
          <p class="settings-nav-hint">${activeMeta[3]}</p>
        </nav>
        <div class="settings-grid">
        <section class="${group('appearance')}" ${groupAttr('appearance')}>
          <h2>${icon('sparkle')}外观</h2>
          <p class="desc">主题、强调色和个人称呼。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>界面主题</strong><span>深色适合夜晚，浅色更适合白天。</span></div>
            <div class="setting-control">
              <div class="segmented">
                ${themeOptions
                  .map(
                    ([key, label]) =>
                      `<button class="${settings.theme === key ? 'active' : ''}" data-action="set-theme" data-value="${key}">${label}</button>`
                  )
                  .join('')}
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>强调色</strong><span>只出现在按钮、进度和少量细节上。</span></div>
            <div class="setting-control">
              <div class="swatches">
                ${accents
                  .map(
                    ([key, label, color]) =>
                      `<button class="swatch ${settings.accent === key ? 'active' : ''}" style="--swatch:${color}" data-action="set-accent" data-value="${key}" title="${label}" aria-label="${label}"></button>`
                  )
                  .join('')}
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>你的称呼</strong><span>显示在主页问候和左下角的个人资料中，也可以直接输入自定义称呼。</span></div>
            <div class="setting-control" style="flex-direction:column;align-items:flex-end;gap:6px">
              <input class="text-input" id="profile-name-input" maxlength="24" value="${esc(settings.profileName || '大小姐')}" style="width:150px" spellcheck="false" />
              <div class="salutation-chips">
                <button class="mini-chip ${settings.profileName === '大小姐' ? 'active' : ''}" data-action="set-salutation" data-value="大小姐">大小姐</button>
                <button class="mini-chip ${settings.profileName === '主人' ? 'active' : ''}" data-action="set-salutation" data-value="主人">主人</button>
                <button class="mini-chip ${settings.profileName === '大少爷' ? 'active' : ''}" data-action="set-salutation" data-value="大少爷">大少爷</button>
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>头像</strong><span>显示在左下角的个人资料中。支持 PNG、JPG、WebP、GIF 和 SVG。</span></div>
            <div class="setting-control">
              <span class="avatar avatar-preview">${avatarContent(settings)}</span>
              <button class="btn btn-ghost" data-action="change-avatar">${icon('image')}更换</button>
              ${settings.avatar ? `<button class="btn btn-quiet" data-action="reset-avatar">恢复默认</button>` : ''}
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>页面装饰挂饰</strong><span>在启动页以外的页面，角落悬挂花火狐面、火花礼帽，并漂浮烟花 / 火焰 / 星空小精灵。</span></div>
            <div class="setting-control">
              <button class="switch ${state.settings.charms !== false ? 'on' : ''}" role="switch" aria-checked="${state.settings.charms !== false}" data-action="toggle-charms" title="${state.settings.charms !== false ? '关闭' : '开启'}"></button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>角色背景水印</strong><span>在页面右下角铺一层淡淡的火花角色立绘水印，很淡、不挡阅读；可单独关闭。</span></div>
            <div class="setting-control">
              <button class="switch ${state.settings.charBg !== false ? 'on' : ''}" role="switch" aria-checked="${state.settings.charBg !== false}" data-action="toggle-charbg" title="${state.settings.charBg !== false ? '关闭' : '开启'}"></button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>侧栏立绘</strong><span>展开侧栏时，底部显示火花立绘。关掉后这一块不占高度，导航能一次显示更多项，不用滚。</span></div>
            <div class="setting-control">
              <button class="switch ${state.settings.sidebarChar !== false ? 'on' : ''}" role="switch" aria-checked="${state.settings.sidebarChar !== false}" data-action="toggle-sidebar-char" title="${state.settings.sidebarChar !== false ? '关闭' : '开启'}"></button>
            </div>
          </div>
        </section>

        <section class="${group('window', true)} material-panel" ${groupAttr('window')}>
          <h2>${icon('sparkle')}窗口材质与背景</h2>
          <p class="desc">复用系统合成层，或铺一张自己的背景图。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>窗口材质</strong><span>亚克力 / 云母需要 Windows 11 并开启「透明效果」；云母会自动关掉半透明底色。</span></div>
            <div class="setting-control">
              <div class="segmented">
                ${MATERIAL_OPTIONS.map(
                  (key) =>
                    `<button class="${(settings.material || 'none') === key ? 'active' : ''}" data-action="set-material" data-value="${key}">${MATERIAL_LABEL[key]}</button>`
                ).join('')}
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自定义背景</strong><span>PNG / JPG / WebP / GIF，最大 40 MB，铺在内容下面。</span></div>
            <div class="setting-control">
              ${
                settings.customBackground
                  ? `<span class="bg-preview" style="background-image:url('${esc(toFileUrl(settings.customBackground) || '')}')"></span>`
                  : ''
              }
              <button class="btn btn-ghost" data-action="pick-background">${icon('image')}${settings.customBackground ? '更换' : '选择图片'}</button>
              ${settings.customBackground ? `<button class="btn btn-quiet" data-action="reset-background">移除</button>` : ''}
            </div>
          </div>
          <div class="setting-row-pair">
            <div class="setting-row">
              <div class="setting-copy"><strong>背景不透明度</strong><span>调低后背景变淡，能看见更多窗口材质。</span></div>
              <div class="setting-control volume-control">
                <input class="volume-range" id="bg-opacity" type="range" min="0" max="100" step="1" value="${Number(settings.backgroundOpacity ?? 100)}" aria-label="背景不透明度" ${settings.customBackground ? '' : 'disabled'} />
                <span class="volume-value" id="bg-opacity-value">${Number(settings.backgroundOpacity ?? 100)}%</span>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-copy"><strong>背景清晰度</strong><span>往左越模糊，画面花的时候文字更好读。</span></div>
              <div class="setting-control volume-control">
                <input class="volume-range" id="bg-blur" type="range" min="0" max="60" step="1" value="${100 - Number(settings.backgroundBlur ?? 0)}" aria-label="背景清晰度" ${settings.customBackground ? '' : 'disabled'} />
                <span class="volume-value" id="bg-blur-value">${Number(settings.backgroundBlur ?? 0) ? `模糊 ${Number(settings.backgroundBlur)}` : '原图'}</span>
              </div>
            </div>
          </div>
          <p class="material-note">${icon('alert', 'xs')}「透明效果」在 设置 → 个性化 → 颜色；关掉后所有材质失效。</p>
        </section>

        <section class="${group('appearance')} ui-scale-panel" ${groupAttr('appearance')}>
          <h2>${icon('type')}界面缩放</h2>
          <p class="desc">调整整个启动器的字号和布局大小，适配不同分辨率的屏幕。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>缩放比例</strong><span>100% 是默认大小。放大后所有文字、按钮和图标一起等比变化，不会错位。</span></div>
            <div class="setting-control ui-scale-control">
              <div class="segmented ui-scale-steps">
                ${UI_SCALE_STEPS.map(
                  (step) =>
                    `<button class="${currentUiScale() === step ? 'active' : ''}" data-action="set-ui-scale" data-value="${step}">${step}%</button>`
                ).join('')}
              </div>
              <span class="volume-value" id="ui-scale-value">${currentUiScale()}%</span>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>预览</strong><span>下面这段文字会跟着缩放一起变化，方便确认大小是否合适。</span></div>
            <div class="setting-control ui-scale-preview">
              <span class="ui-scale-sample">Aaa 大小姐 1234</span>
            </div>
          </div>
        </section>

        <section class="${group('sound')} sound-settings-panel" ${groupAttr('sound')}>
          <h2>${icon('volume')}界面音效</h2>
          <p class="desc">按钮、导航和通知的反馈音，独立于歌曲音量；歌曲音量与 3D 音效在音乐页里调整。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>界面音效</strong><span>按钮、导航和开关操作时播放轻量反馈音；关闭后完全静音。</span></div>
            <div class="setting-control">${soundSwitchMarkup('enabled', state.sound.enabled)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>界面音量</strong><span>只影响点击、通知和启动提示音，不会改变歌曲音量。</span></div>
            <div class="setting-control volume-control">
              <input class="volume-range" id="sound-volume" type="range" min="0" max="100" step="1" value="${state.sound.volume}" aria-label="界面音效音量" />
              <span class="volume-value" id="sound-volume-value">${state.sound.volume}%</span>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>点击音效</strong><span>打开页面、按钮和切换开关时发出的短音。</span></div>
            <div class="setting-control">${soundSwitchMarkup('click', state.sound.click)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>通知音效</strong><span>成功、失败和系统消息弹出时播放的双音提示。</span></div>
            <div class="setting-control">${soundSwitchMarkup('notify', state.sound.notify)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>启动游戏音效</strong><span>游戏真正开始启动时播放的上升音；启动失败不会播放。</span></div>
            <div class="setting-control">${soundSwitchMarkup('launch', state.sound.launch)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>试听</strong><span>用当前音量预览三种音效。</span></div>
            <div class="setting-control sound-preview">
              <button class="btn btn-quiet" data-action="preview-sound" data-value="click" data-no-sound ${state.sound.enabled ? '' : 'disabled'}>点击</button>
              <button class="btn btn-quiet" data-action="preview-sound" data-value="notify" data-no-sound ${state.sound.enabled ? '' : 'disabled'}>通知</button>
              <button class="btn btn-quiet" data-action="preview-sound" data-value="launch" data-no-sound ${state.sound.enabled ? '' : 'disabled'}>启动</button>
            </div>
          </div>
        </section>

        <section class="${group('sound')}" ${groupAttr('sound')}>
          <h2>${icon('music')}音乐</h2>
          <p class="desc">决定启动器打开后音乐的行为。</p>
          <div class="setting-row setting-row-split">
            <div class="setting-pair">
              <strong>打开时继续上次的音乐</strong>
              <button class="switch ${state.autoResumeSong ? 'on' : ''}" role="switch" aria-checked="${Boolean(state.autoResumeSong)}" data-action="toggle-auto-resume" title="${state.autoResumeSong ? '关闭' : '开启'}"></button>
            </div>
            <div class="setting-pair">
              <strong>显示小播放器</strong>
              <button class="switch ${isMiniEnabled() ? 'on' : ''}" role="switch" aria-checked="${Boolean(isMiniEnabled())}" data-action="toggle-mini-player" title="${isMiniEnabled() ? '关闭' : '开启'}"></button>
            </div>
          </div>
          <p class="setting-hint">继续播放：启动器一打开就自动播放上次听到的那首歌，关掉后要手动点播放键。小播放器：放歌时在侧栏旁挂一个可拖动的小窗，关掉后即使还在放歌、来回切界面也不再出现。</p>
        </section>

        <section class="${group('behavior', true)}" ${groupAttr('behavior')}>
          <h2>${icon('settings')}行为</h2>
          <p class="desc">托盘、开机自启、自动同步等。游戏帧率请到「工具 → 对应游戏 → 画质配置」调整。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>关闭时收进托盘</strong><span>开启：点右上角 ✕ 只是收进托盘，画面还在后台跑，双击托盘图标可以回来。关闭：点 ✕ 直接退出启动器。第一次点 ✕ 时问过一次，之后都以这里为准。</span></div>
            <div class="setting-control">${switchMarkup('closeToTray', settings.closeToTray)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>开机时启动</strong><span>登录 Windows 后自动打开启动器。</span></div>
            <div class="setting-control">${switchMarkup('launchAtLogin', settings.launchAtLogin)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>启动游戏后最小化</strong><span>把舞台让给游戏，启动器安静地退到后面。</span></div>
            <div class="setting-control">${switchMarkup('minimizeOnLaunch', settings.minimizeOnLaunch)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>异环通过官方启动器启动</strong><span>默认点击后打开 NTELauncher.exe，由官方处理版本更新和登录；关闭后直接启动 HTGame.exe。</span></div>
            <div class="setting-control">${switchMarkup('nevernessUseOfficialLauncher', settings.nevernessUseOfficialLauncher !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>检测已安装的游戏</strong><span>重新扫描注册表和常见安装目录，自动填入原神、崩坏3、星穹铁道、绝区零、异环、终末地的启动程序。</span></div>
            <div class="setting-control"><button class="btn btn-ghost" data-action="detect-all">${icon('refresh')}立即检测</button></div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动同步官网版本与封面</strong><span>启动时检查内置游戏的官网；发现新版本时自动更新版本号和封面，6 小时内只检查一次。</span></div>
            <div class="setting-control">${switchMarkup('autoSyncOfficial', settings.autoSyncOfficial !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动获取终末地抽卡记录</strong><span>打开游戏内抽卡记录后，自动读取 HGWebview 日志并同步；异环仍需其导出工具生成 JSON。</span></div>
            <div class="setting-control">${switchMarkup('autoGacha', settings.autoGacha !== false)}</div>
          </div>
        </section>

        <section class="${group('storage', true)}" ${groupAttr('storage')}>
          <h2>${icon('folder-open')}存储</h2>
          <p class="desc">下载、运行时、终末地渠道包与管理员权限。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>语音包语言</strong><span>只下载勾中的配音，默认只要中文；改完下次更新或安装时生效，已经下好的不会立刻删。仅对原神 / 星穹铁道 / 绝区零 / 崩坏3 生效——终末地的语音藏在 Unity 资源包里，官方没有拆分粒度，只能跟着整包一起下。</span></div>
            <div class="setting-control">
              <div class="segmented">
                ${(() => {
                  const on = audioLanguagesOf();
                  return AUDIO_LANGUAGE_LABELS
                    .map(([key, label]) => `<button class="${on.includes(key) ? 'active' : ''}" data-action="toggle-audio-language" data-value="${key}">${label}</button>`)
                    .join('');
                })()}
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>剧情资源 / 主线动画（绝区零约 19.7GB）</strong>
              <span>预下载和安装时把主线剧情、个人线、影像档案这些分类包一起下。<strong>不勾只是缺剧情动画，不影响进游戏</strong>；勾上要多占近 20GB。只对绝区零有意义——原神和星穹铁道的官方清单里实测分类包数为 0，这个开关对它们没有作用。</span>
            </div>
            <div class="setting-control">${switchMarkup('includeStoryResources', settings.includeStoryResources === true)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>更新时用本地补丁省流（LDIFF）</strong>
              <span>原神 / 星穹铁道更新时，官方会额外给一份「从你当前版本到新版本」的差分补丁。开启后先用补丁就地修补本地文件，剩下的才走分块下载——实测原神 7.0.0 → 7.1.0 能省约 75% 流量。代价是它会在更新过程中直接改写游戏文件，如果中途断网会留下「补了一半」的状态，重新更新一次能自动接上，也可以用「检查完整资源」修复。绝区零官方没开这个能力，对它无效。</span>
            </div>
            <div class="setting-control">${switchMarkup('enableLdiff', settings.enableLdiff !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>下载文件夹</strong><span class="path-text" title="${esc(settings.downloadDir || '')}">${esc(settings.downloadDir || '')}</span></div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="change-download-dir">更改</button>
              <button class="btn btn-icon btn-ghost" data-action="open-download-folder" title="打开下载文件夹">${icon('external')}</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>始终以管理员身份启动</strong><span>终末地 / 明日方舟创建游戏进程时必须提权（官方客户端的限制，实测非提权直接 740）。开启后启动器自己以管理员运行，再开游戏就不会额外弹 UAC；第一次点「开始游戏」时会问你一次，选过就不再问。UAC 被拒绝或新实例没起来时会自动退回普通权限，不会出现双击打不开的情况。</span></div>
            <div class="setting-control">${switchMarkup('alwaysAdmin', settings.alwaysAdmin)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>管理员权限</strong><span>终末地启动必须提权。启动器不是管理员时会单独弹 UAC；已经是管理员（比如开了上一项）就不会再弹，这是正常的。</span></div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="relaunch-admin">以管理员身份重启</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>应用数据</strong>
              <span class="path-text" title="${esc(state.app.userData || '')}">${esc(state.app.userData || '')}</span>
              <span class="hint">${state.app.portable ? '便携模式：数据、缓存与下载都在启动器文件夹内，不占 C 盘用户目录；整个文件夹拷走即可搬家。' : '当前使用系统 AppData 目录。'}</span>
            </div>
            <div class="setting-control">
              <button class="btn btn-icon btn-ghost" data-action="open-data-folder" title="打开数据目录">${icon('external')}</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>运行时目录</strong><span>B服 / 国际服的硬链接目录。留空时使用「游戏盘:\\VelaRuntimes」，必须和游戏同盘。</span></div>
            <div class="setting-control">
              <span class="path-text" title="${esc(settings.runtimeRoot || '')}">${esc(settings.runtimeRoot || '自动：游戏盘:\\VelaRuntimes')}</span>
              <button class="btn btn-ghost" data-action="change-runtime-root">更改</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动更新终末地渠道包</strong><span>切过终末地的服之后默认开启：启动时检查官方渠道 SDK，有新版本就替换本机已有的终末地渠道包。没切过服时保持关闭——那台机器上本来就没有包可更新，开了只会白跑一趟官方接口。</span></div>
            <div class="setting-control">${switchMarkup('autoUpdateEndfieldPacks', settings.autoUpdateEndfieldPacks === true)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动更新明日方舟渠道包</strong><span>切过明日方舟的服之后默认开启。和上面那条各管各的：只玩终末地时这边保持关闭，启动时不会去拉方舟的清单。</span></div>
            <div class="setting-control">${switchMarkup('autoUpdateArknightsPacks', settings.autoUpdateArknightsPacks === true)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>渠道包</strong>
              <span>${esc(endfieldPackSummary(settings))}</span>
              <span>${esc(arknightsPackSummary(settings))}</span>
            </div>
            <div class="setting-control">
              <span class="auto-badge ${packCount.ready ? 'is-ready' : 'is-pending'}">${packCount.ready ? `${packCount.ready} / ${packCount.total}` : '按需下载'}</span>
              <button class="btn btn-ghost" data-action="manage-endfield-packs">${icon('settings')}管理</button>
              <button class="btn btn-ghost" data-action="release-channel-packs">${icon('trash')}释放</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>明日方舟游戏本体</strong>
              <span>更新 / 修复只动游戏本体，不碰渠道包。</span>
            </div>
            <div class="setting-control">
              <button class="btn btn-ghost" data-action="update-arknights-game">${icon('download')}更新游戏本体</button>
              <button class="btn btn-ghost" data-action="repair-arknights-game">${icon('refresh')}修复游戏</button>
            </div>
          </div>

          ${
            demos
              ? `<div class="setting-row">
                  <div class="setting-copy"><strong>示例条目</strong><span>库中还有 ${demos} 个示例，只用于展示界面。</span></div>
                  <div class="setting-control"><button class="btn btn-ghost" data-action="clear-demo">清空示例</button></div>
                </div>`
              : ''
          }
        </section>

        <section class="${group('update', true)}" ${groupAttr('update')}>
          <h2>${icon('download')}软件更新</h2>
          <p class="desc">更新源已经内置：先看启动器目录里那份 <code>latest.json</code>，没有就去官方 Release 取，装完就能自己升级。下载失败会自动换国内镜像重试并做 sha256 校验，裸连也能装；开着 Steam++ 这类加速器也不会再因为证书检查失败。</p>
          <div class="setting-row">
            <div class="setting-copy"><strong>更新源</strong><span>留空就用内置的官方源；也可以填自己的 https 地址、局域网共享（\\NAS\share\latest.json）或本地路径。ZIP 地址写在清单里，相对路径以清单所在目录为准。一直卡在「检查更新」或下载不动时，点右边「用国内镜像源」换成 Gitee 上的清单试一次。</span></div>
            <div class="setting-control update-source-control">
              <input class="text-input" id="update-manifest" value="${esc(settings.updateManifest || '')}" placeholder="留空 = 内置官方源" spellcheck="false" />
              <button class="btn btn-ghost" data-action="save-update-source">保存</button>
              <button class="btn btn-ghost" data-action="fill-mirror-source" title="${GITEE_MANIFEST_URL}">${icon('server')}用国内镜像源</button>
              <button class="btn btn-ghost" data-action="pick-update-source">${icon('folder')}选择文件</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>自动检查更新</strong><span>启动 15 秒后检查一次，之后每 6 小时一次；发现新版本会弹提示。</span></div>
            <div class="setting-control">${switchMarkup('autoCheckUpdate', settings.autoCheckUpdate !== false)}</div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>立即检查</strong><span>${esc(updateStatusText())}</span></div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="check-update" ${state.update && state.update.downloading ? 'disabled' : ''}>${icon('refresh')}检查更新</button>
              ${state.update && state.update.hasUpdate ? `<button class="btn btn-primary" data-action="apply-update" ${state.update.downloading ? 'disabled' : ''}>${icon('download')}更新到 v${esc(state.update.latest)}</button>` : ''}
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>覆盖安装日志</strong>
              <span>覆盖脚本在后台单独运行，界面看不到它的输出。更新卡住或没重启时，把这里的日志发回来就能定位是哪一步出的问题（这不是版本更新日志，版本更新内容在「动态」页）。</span>
            </div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="view-update-log">${icon('file-text')}查看日志</button>
              <button class="btn btn-ghost" data-action="open-update-log">${icon('folder')}打开文件</button>
            </div>
          </div>
          ${
            state.update && state.update.backup && state.update.backup.ok
              ? `<div class="setting-row">
                  <div class="setting-copy"><strong>回到上一个版本</strong><span>上一次升级前的程序文件还留着备份（v${esc(state.update.backup.version || '?')} → v${esc(state.update.backup.target || '?')}）。新版本有问题时，可以一键还原回去。</span></div>
                  <div class="setting-control update-action-control">
                    <button class="btn btn-ghost" data-action="rollback-update">${icon('refresh')}回滚到 v${esc(state.update.backup.version || '?')}</button>
                  </div>
                </div>`
              : ''
          }
          <div class="setting-row">
            <div class="setting-copy">
              <strong>手动更新</strong>
              <span>不想等弹窗时，可以到 GitHub 自己下新版 ZIP。解压后覆盖程序文件即可，<code>data</code> 文件夹里的游戏、账号、抽卡记录和设置都不会被覆盖。</span>
            </div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_RELEASES_URL}">${icon('external')}打开发布页</button>
              <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_URL}">${icon('external')}仓库</button>
            </div>
          </div>
          ${state.update && state.update.downloading ? `<div class="update-progress"><div class="update-progress-bar"><span style="width:${Number(state.update.percent) || 0}%"></span></div><small>${updateProgressText(Number(state.update.percent) || 0, '')}</small></div>` : ''}
        </section>

        <section class="${group('community')}" ${groupAttr('community')}>
          <h2>${icon('link')}项目主页与反馈</h2>
          <p class="desc">源码、版本说明、已知问题都放在项目仓库里；有 bug 或者想要新功能，从下面的「问题反馈」进去写，会直接带上你现在用的版本号。</p>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>项目主页</strong>
              <span>GitHub 仓库，README 里有上手说明，发版页能翻到每一个版本的更新内容。</span>
            </div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_URL}" title="${REPO_URL}">${icon('external')}打开项目主页</button>
              <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_RELEASES_URL}" title="${REPO_RELEASES_URL}">${icon('external')}打开发布页</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy">
              <strong>问题反馈</strong>
              <span>写一个 issue：说清楚哪一步出的问题、期望是什么、实际是什么。带上启动器的版本和系统版本，定位会快很多。</span>
            </div>
            <div class="setting-control update-action-control">
              <button class="btn btn-ghost" data-action="open-external" data-url="${REPO_FEEDBACK_URL()}" title="${REPO_NEW_ISSUE_URL}">${icon('external')}提交问题</button>
            </div>
          </div>
          <div class="setting-row" style="border-bottom:0">
            <div class="setting-copy">
              <strong>反馈时附上这些信息</strong>
              <span>启动器版本 <code>${esc((state.app && state.app.version) || '未知')}</code> · Electron <code>${esc((state.app && state.app.electron) || '未知')}</code> · 系统 <code>${esc(platformText())}</code>。上面那段可以直接复制进 issue 里。</span>
            </div>
          </div>
        </section>

        <section class="${group('about', true)}" ${groupAttr('about')}>
          <h2>${icon('info')}关于</h2>
          <p class="desc">一个本地优先的桌面游戏书架，会自己管更新，外加一台能放歌的音乐台。</p>
          <div class="setting-row" style="border-bottom:0;padding-bottom:0">
            <div class="about-block">
              <div class="about-name">花筱灵启动器</div>
              <div class="about-version">VERSION ${esc(state.app.version || '1.0.0')} · ELECTRON ${esc(state.app.electron || '')}</div>
              <div class="about-note">
                内置原神、崩坏：星穹铁道、绝区零、崩坏3、明日方舟、异环、明日方舟：终末地的启动入口，也支持添加任意本地游戏；装在哪、切哪个服、缺不缺资源，启动器都会自己认，游戏有官方更新时「开始游戏」会直接变成「更新游戏」，点了就下、下完自动就位。
                切服不用重下：多渠道游戏（官服 / B服 / 国际服）共用一份客户端，运行时按渠道自动组装，更新一次全服通用。
                终末地 / 明日方舟的渠道包不随安装包装：第一次切到某个服时会写清要下多少（官服 9 MB、B服 194 MB、国际服 / Play 约 940 MB），点了才下，带百分比与速度、可取消续传，下过一次就一直在。
                渠道包有单独的管理窗口：每个渠道一行，写清状态和占用，能单独下载、更新、释放；后台自动更新两个游戏各一个开关，只在你切过那个游戏的服之后才默认开启。
                抽卡记录三池一页看完：条形图带真头像、红条 = 吃到保底，自动算平均出金和当前垫数。
                另带一台音乐台：网易云 / QQ / 酷狗 / 酷我多平台搜歌、歌单链接导入、队列分组与过滤、音效与歌词，直播间连上后还能听观众弹幕点歌。
                界面与代码为原创实现；启动页与部分界面使用了《崩坏：星穹铁道》花火、火花等官方立绘素材，仅作爱好者桌面美化用途，版权归米哈游及各游戏官方所有。
                游戏版本号与封面会在联网时从官网同步并缓存，版权归各游戏官方所有。
                功能设计参考了 Starward（MIT）等开源启动器，不包含它们的代码或素材。
                游戏列表、设置、歌单和时长都保存在本地，不会上传。
              </div>
              <div class="about-links">
                <button class="link-btn" data-action="open-changelog">${icon('file-text')}版本更新日志</button>
                <button class="link-btn" data-action="install-update">${icon('download')}导入更新包</button>
                <button class="link-btn" data-action="open-external" data-url="https://github.com/Scighost/Starward">Starward · MIT ${icon('external')}</button>
                <button class="link-btn" data-action="quit-app">退出启动器</button>
              </div>
            </div>
          </div>
        </section>
        </div>
      </div>
    </div>`;
}
