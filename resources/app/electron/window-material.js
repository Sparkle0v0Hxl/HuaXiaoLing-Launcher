'use strict';

/**
 * 窗口材质：亚克力 / 云母 / 模糊 等系统合成效果。
 *
 * 原理和取舍：
 *   1. Electron 在 Windows 上通过 `win.setBackgroundMaterial()` 调用 DWM 的
 *      SYSTEMBACKDROP 接口，支持 acrylic / mica / micaAlt / tabbed。
 *   2. 云母（mica）要求窗口**不透明**——一旦窗口有 alpha，DWM 会直接忽略云母。
 *      所以选云母时不能让 CSS 把 body 背景设成半透明，只能在 body 上**不加背景**，
 *      让窗口层的云母透出来；这类「透出」是靠 `backgroundColor: '#00000000'` 实现的。
 *   3. 亚克力的做法相反：需要窗口透明，DWM 才给窗口背后加磨砂。
 *
 * 这两点互相冲突，所以一次只能生效一种，且必须由主进程来决定窗口透明度和材质，
 * 渲染层只能事后「补背景」，不能自己决定窗口是不是透明的——那是 BrowserWindow 的属性。
 */

const { BrowserWindow } = require('electron');

/**
 * 支持的材质；`none` 表示「不使用系统材质」。
 */
const MATERIALS = ['acrylic', 'mica', 'micaTabbed', 'auto', 'none'];

/** Electron 的取值与 UI 命名不完全一致，做一层映射。 */
const ELECTRON_VALUE = {
  acrylic: 'acrylic',
  mica: 'mica',
  micaTabbed: 'tabbed',
  auto: 'auto',
  none: undefined,
};

/**
 * 应用材质。返回 { ok, applied, reason }。
 *
 * 注意：**必须**先设置 backgroundColor 再调用 setBackgroundMaterial，
 * 否则 DWM 会沿用窗口创建时的 #0b060b 不透明底色，材质的半透明层看不见。
 */
function applyMaterial(target, material) {
  if (!target || typeof target.isDestroyed !== 'function' || target.isDestroyed()) {
    return { ok: false, reason: '窗口不存在' };
  }
  const win = target;
  if (process.platform !== 'win32') return { ok: false, reason: '只有 Windows 支持系统材质' };
  if (typeof win.setBackgroundMaterial !== 'function') {
    return { ok: false, reason: '当前 Electron 版本不支持 setBackgroundMaterial' };
  }
  if (!MATERIALS.includes(material)) material = 'none';

  try {
    if (material === 'none') {
      win.setBackgroundMaterial('none');
      win.setBackgroundColor('#0b060b');
      return { ok: true, applied: 'none' };
    }
    // 有材质时窗口底色必须全透明，否则材质被盖住
    win.setBackgroundColor('#00000000');
    win.setBackgroundMaterial(ELECTRON_VALUE[material]);
    return { ok: true, applied: material };
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  }
}

/**
 * 读取注册表确认「透明效果」开关真的开着。
 * 关掉之后 DWM 会静默忽略所有材质，界面上要能提示，否则会被当成 bug。
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize
 *   EnableTransparency = 0 表示关闭。
 */
function transparencyEnabled() {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'EnableTransparency'],
      { encoding: 'buffer', windowsHide: true, timeout: 4000 }
    );
    const match = out.toString('latin1').match(/EnableTransparency\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (!match) return true;
    return parseInt(match[1], 16) !== 0;
  } catch {
    return true;
  }
}

module.exports = { MATERIALS, applyMaterial, transparencyEnabled };
