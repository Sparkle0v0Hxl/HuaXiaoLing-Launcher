'use strict';

/**
 * 界面音效服务：按钮 / 导航 / 开关的现场合成音（不加载任何音频文件）。
 *
 * 2026-10-31 从 app.js 拆出 —— 「前后端分离」第 2 批。
 *
 * 两层结构，缺一层就会「电子味」或者「没手感」：
 *   · 噪声瞬态 tick（8~26ms、带通）提供「哒」的接触感，纯正弦永远做不出这个质感；
 *   · 音体 tone（正弦 / 三角、短滑音）提供音高与方向，区分「轻点」「确认」「警告」。
 * 音量走 pow(x,1.4) 感知曲线：线性映射时 35% 听感不足 20%，用户会以为音效坏了。
 *
 * 加载约定：普通 script（非 module），与 audio-fx.js / app.js 共享同一全局词法
 * 作用域。index.html 里必须排在 app.js 之前（app.js 启动时会调用 playUiSound）。
 * 依赖全局 state.sound（开关 / 音量），在调用时解析。
 */

/* ---- 私有状态：AudioContext 单例、噪声缓冲、连点节流时间戳 ---- */

let uiSoundContext = null;
let uiNoiseBuffer = null;
/* 连点节流：同一种音色 45ms 内只响一次，任意两种音色间隔不足 26ms 时压掉后者，
 * 否则快速点列表会叠成一片电流声。 */
const uiSoundStamp = Object.create(null);
let uiSoundAnyStamp = 0;

/* ---------- 合成层 ---------- */

function uiSoundNoise(context) {
  if (uiNoiseBuffer && uiNoiseBuffer.sampleRate === context.sampleRate) return uiNoiseBuffer;
  const length = Math.max(1, Math.floor(context.sampleRate * 0.12));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  // 固定种子的伪随机：每次启动噪声频谱一致，不会「这次脆、下次闷」
  let seed = 22695477;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed / 0x3fffffff - 1;
  }
  uiNoiseBuffer = buffer;
  return buffer;
}

function playUiSound(kind = 'click', force = false) {
  const settings = state.sound;
  if (!settings.enabled) return;
  // 三个开关管四类音：tap / primary / toggle 归「点击音」，error 归「通知音」
  const gate = kind === 'notify' || kind === 'error' ? 'notify' : kind === 'launch' ? 'launch' : 'click';
  if (!settings[gate] && !force) return;
  if (force) {
    // 预览按钮连点也别叠成电流声
    const stamp = performance.now();
    if (stamp - (uiSoundStamp[kind] || 0) < 140) return;
    uiSoundStamp[kind] = stamp;
  }
  const volume = Math.max(0, Math.min(100, Number(settings.volume) || 0)) / 100;
  if (volume <= 0) return;
  if (!force && !uiSoundBudget(kind)) return;
  const amp = Math.pow(volume, 1.4);
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    if (!uiSoundContext) uiSoundContext = new AudioCtor();
    if (uiSoundContext.state === 'suspended') uiSoundContext.resume().catch(() => {});
    const context = uiSoundContext;
    const now = context.currentTime + 0.004;

    const tone = (frequency, delay, duration, endFrequency, gain, type = 'sine', attack = 0.006) => {
      const start = now + delay;
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (endFrequency && endFrequency !== frequency) {
        oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
      }
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * amp), start + Math.min(attack, duration * 0.4));
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(envelope);
      envelope.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    };

    const tick = (frequency, delay, duration, gain, q = 1.6) => {
      const start = now + delay;
      const source = context.createBufferSource();
      source.buffer = uiSoundNoise(context);
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(frequency, start);
      filter.Q.setValueAtTime(q, start);
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * amp), start + Math.min(0.004, duration * 0.35));
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      source.connect(filter);
      filter.connect(envelope);
      envelope.connect(context.destination);
      source.start(start);
      source.stop(start + duration + 0.01);
    };

    switch (kind) {
      case 'tap':
        // 导航 / 图标按钮：只留一点点接触感，点多了不烦
        tick(3200, 0, 0.014, 0.075);
        tone(1560, 0, 0.04, 1320, 0.03);
        break;
      case 'primary':
        // 主行动（开始游戏 / 下载 / 确认）：更厚，带一点下沉
        tick(1500, 0, 0.026, 0.12);
        tone(520, 0, 0.12, 300, 0.055, 'triangle');
        tone(1040, 0.018, 0.05, 1180, 0.026);
        break;
      case 'toggle':
        // 开关：短促上扬，闭眼也能听出是「拨过去」而不是「按一下」
        tick(3600, 0, 0.012, 0.085);
        tone(980, 0.004, 0.05, 1420, 0.035);
        break;
      case 'error':
        tick(520, 0, 0.03, 0.1);
        tone(300, 0, 0.17, 186, 0.05, 'triangle');
        break;
      case 'notify':
        tone(659.25, 0, 0.2, 783.99, 0.06, 'sine', 0.012);
        tone(987.77, 0.1, 0.24, 880, 0.042, 'sine', 0.012);
        break;
      case 'launch':
        tone(261.63, 0, 0.3, 659.25, 0.055, 'triangle', 0.02);
        tone(523.25, 0.1, 0.36, 1046.5, 0.036, 'sine', 0.016);
        tone(130.81, 0, 0.32, 196, 0.03, 'sine', 0.03);
        break;
      default:
        // click：普通按钮，短、干、带明确接触点
        tick(2600, 0, 0.022, 0.095);
        tone(1120, 0, 0.055, 760, 0.045);
    }
  } catch {
    /* audio feedback is optional */
  }
}

/* 连点节流：正常点击走 45ms 同音色 / 26ms 全音色两道闸 */
function uiSoundBudget(kind) {
  const stamp = performance.now();
  if (stamp - (uiSoundStamp[kind] || 0) < 45) return false;
  if (stamp - uiSoundAnyStamp < 26) return false;
  uiSoundStamp[kind] = stamp;
  uiSoundAnyStamp = stamp;
  return true;
}

/* 按控件角色挑音色：主按钮、导航、开关不该是同一个「哒」 */
function uiSoundKindFor(element) {
  if (!element) return 'click';
  if (element.closest('.switch')) return 'toggle';
  if (element.matches('.btn-primary, .btn-danger')) return 'primary';
  if (element.closest('.nav-item, [data-nav], .mini-btn, .chrome-btn, .segmented, .chip')) return 'tap';
  return 'click';
}
