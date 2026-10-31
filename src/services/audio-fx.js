'use strict';

/**
 * 音效服务：界面音效合成、Web Audio 音效链、音量 / 静音、音效预设。
 *
 * 2026-10-31 从 app.js 拆出 —— 「前后端分离」第一阶段（渲染层内部分层）：
 * 数据 / 状态 / 业务逻辑归 services，界面模板归 views，都经 window.launcher
 * 桥与主进程通信，渲染层零直连。
 *
 * 加载约定（重要）：本项目用普通 script（非 module），顶层函数声明与
 * let / const 进同一份全局词法作用域，跨文件互相可见。因此：
 *   - index.html 里本文件必须排在 app.js 之前 —— app.js 的 state 初始化
 *     会读 AUDIO_FX_STORAGE，排错就是 TDZ ReferenceError、直接白屏；
 *   - 反向引用（updateSongChrome 等留在 app.js 的函数）在调用时才解析，
 *     不依赖加载顺序；
 *   - Web Audio / DOM 操作只能活在渲染进程，这部分逻辑不搬去主进程。
 */

const AUDIO_FX_PRESETS = [
  { key: 'off', label: '原声', desc: '不做任何处理，保持原始音色。', group: '基础' },
  { key: 'wide', label: '宽阔声场', desc: '拉开左右声道，声场更开阔。', group: '空间' },
  { key: 'hall', label: '音乐厅', desc: '加入混响尾音，像在小演出厅。', group: '空间' },
  { key: 'headphone', label: '耳机 3D', desc: 'HRTF 环绕，戴耳机时定位更明显。', group: '空间' },
  { key: 'room', label: '小房间', desc: '短混响，像在卧室或书房里听。', group: '空间' },
  { key: 'cave', label: '洞穴', desc: '长尾混响 + 低频堆积，空旷回响。', group: '空间' },
  { key: 'stadium', label: '体育场', desc: '超长混响，像在大型场馆。', group: '空间' },
  { key: 'bass', label: '低音增强', desc: '加强低频，适合电子与摇滚。', group: '频段' },
  { key: 'vocal', label: '人声清晰', desc: '抬高中高频，咬字更清楚。', group: '频段' },
  { key: 'treble', label: '高音明亮', desc: '提亮高频，器乐与女声更透。', group: '频段' },
  { key: 'warm', label: '温暖模拟', desc: '柔化高频、略微加厚中低频。', group: '频段' },
  { key: 'lofi', label: '复古电话', desc: '砍掉高低频，像老收音机。', group: '频段' },
  { key: 'night', label: '深夜低扰', desc: '压缩动态并轻微降噪，适合戴耳机小声听。', group: '场景' },
  { key: 'live', label: '现场感', desc: '轻微混响 + 高频空气感，像 live 录音。', group: '场景' },
];
const AUDIO_FX_KEYS = AUDIO_FX_PRESETS.map((item) => item.key);
const AUDIO_FX_STORAGE = 'vela:audio-fx';

/* 界面音效的私有状态（uiSoundContext / uiNoiseBuffer / uiSoundStamp /
 * uiSoundAnyStamp）已随第 2 批搬到 services/ui-sound.js。 */

function saveSoundSettings() {
  try {
    localStorage.setItem('vela:sound-settings', JSON.stringify(state.sound));
  } catch {
    /* optional local preference */
  }
}

function saveAudioFx() {
  try {
    localStorage.setItem(AUDIO_FX_STORAGE, JSON.stringify(state.audioFx));
  } catch {
    /* optional local preference */
  }
}

function audioFxLabel() {
  const preset = AUDIO_FX_PRESETS.find((item) => item.key === state.audioFx.preset);
  return state.audioFx.preset === 'off' ? '原声' : preset ? preset.label : '原声';
}

/* ---------- Web Audio 音效链 ---------- */

let audioFxGraph = null;
let audioFxOrbit = null;
let audioFxFallback = false;

function applySongVolume() {
  const audio = document.querySelector('#song-audio');
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, state.songVolume / 100));
  audio.muted = Boolean(state.songMuted);
  syncVolumeUi();
}

function syncVolumeUi() {
  const muted = Boolean(state.songMuted);
  const value = String(Math.round(state.songVolume));

  const miniRange = document.querySelector('#mini-volume');
  if (miniRange && document.activeElement !== miniRange) miniRange.value = value;
  const miniValue = document.querySelector('#mini-volume-value');
  if (miniValue) miniValue.textContent = muted ? '静音' : value;

  const mainRange = document.querySelector('#song-volume-main');
  if (mainRange && document.activeElement !== mainRange) mainRange.value = value;
  const mainValue = document.querySelector('#song-volume-main-value');
  if (mainValue) mainValue.textContent = muted ? '静音' : `${value}%`;

  const settingsRange = document.querySelector('#song-volume');
  if (settingsRange && document.activeElement !== settingsRange) settingsRange.value = value;
  const settingsValue = document.querySelector('#song-volume-value');
  if (settingsValue) settingsValue.textContent = `${value}%`;

  const iconHref = muted || state.songVolume === 0 ? '#i-volume-x' : '#i-volume';
  document
    .querySelectorAll('#mini-volume-use, #song-mute-use, #dock-volume-use')
    .forEach((use) => {
      use.setAttribute('href', iconHref);
    });

  const fxOn = state.audioFx.preset !== 'off';
  const fxLabel = audioFxLabel();
  document.querySelectorAll('.song-fx-btn').forEach((button) => {
    button.classList.toggle('active', fxOn);
    const span = button.querySelector('span');
    // 按钮上就是当前音效的名字：关着写「音效」，开着写预设名（宽阔声场 / 低音增强…）
    if (span) span.textContent = fxOn ? fxLabel : '音效';
  });
  document.querySelectorAll('[data-action="open-audio-fx"].mini-btn').forEach((button) => {
    button.classList.toggle('active', state.audioFx.preset !== 'off');
  });
  document.querySelectorAll('[data-action="mini-mute"], [data-action="song-mute"]').forEach((button) => {
    button.classList.toggle('is-muted', muted);
    button.title = muted ? '取消静音' : '静音';
  });
}

function setSongVolume(value) {
  const next = Math.max(0, Math.min(100, Number(value) || 0));
  state.songVolume = next;
  if (next > 0) state.songMuted = false;
  try {
    localStorage.setItem('vela:song-volume', String(next));
    localStorage.setItem('vela:song-muted', state.songMuted ? '1' : '0');
  } catch {
    /* optional local preference */
  }
  applySongVolume();
}

function toggleSongMute() {
  state.songMuted = !state.songMuted;
  try {
    localStorage.setItem('vela:song-muted', state.songMuted ? '1' : '0');
  } catch {
    /* optional local preference */
  }
  applySongVolume();
  return state.songMuted;
}

function makeReverbImpulse(context, seconds = 2.2, decay = 2.8) {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const impulse = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, decay);
    }
  }
  return impulse;
}

function ensureAudioFxGraph(audio) {
  if (audioFxGraph && audioFxGraph.audio === audio) return audioFxGraph;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    const context = new AudioCtor();
    const source = context.createMediaElementSource(audio);
    const input = context.createGain();
    const output = context.createGain();
    input.connect(output);
    output.connect(context.destination);
    source.connect(input);
    audioFxGraph = { audio, context, source, input, output, chain: [] };
    return audioFxGraph;
  } catch {
    return null;
  }
}

function clearAudioFxChain(graph) {
  if (audioFxOrbit) {
    clearInterval(audioFxOrbit);
    audioFxOrbit = null;
  }
  for (const node of graph.chain) {
    try {
      node.disconnect();
    } catch {
      /* already detached */
    }
  }
  graph.chain = [];
  try {
    graph.input.disconnect();
  } catch {
    /* ignore */
  }
}

function buildAudioFxChain(graph, preset, intensity) {
  const { context, input, output } = graph;
  clearAudioFxChain(graph);
  const amount = Math.max(0, Math.min(1, intensity / 100));
  if (preset === 'off' || amount <= 0) {
    input.connect(output);
    return;
  }

  if (preset === 'wide') {
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    const left = context.createGain();
    const right = context.createGain();
    const delay = context.createDelay(0.2);
    const bleed = context.createGain();
    left.gain.value = 1 + 0.3 * amount;
    right.gain.value = 1 + 0.3 * amount;
    delay.delayTime.value = 0.008 + 0.014 * amount;
    bleed.gain.value = 0.18 * amount;
    input.connect(splitter);
    splitter.connect(left, 0);
    left.connect(merger, 0, 0);
    splitter.connect(delay, 1);
    delay.connect(right);
    right.connect(merger, 0, 1);
    splitter.connect(bleed, 1);
    bleed.connect(merger, 0, 0);
    merger.connect(output);
    graph.chain.push(splitter, left, right, delay, bleed, merger);
    return;
  }

  if (preset === 'hall') {
    const dry = context.createGain();
    const wet = context.createGain();
    const convolver = context.createConvolver();
    dry.gain.value = 1 - 0.25 * amount;
    wet.gain.value = 0.35 + 0.65 * amount;
    convolver.buffer = makeReverbImpulse(context);
    input.connect(dry);
    dry.connect(output);
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(output);
    graph.chain.push(dry, wet, convolver);
    return;
  }

  if (preset === 'headphone') {
    const dry = context.createGain();
    const panner = context.createPanner();
    dry.gain.value = 1 - 0.18 * amount;
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 6;
    panner.rolloffFactor = 0.6;
    input.connect(dry);
    dry.connect(output);
    input.connect(panner);
    panner.connect(output);
    graph.chain.push(dry, panner);
    const radius = 0.55 + 0.9 * amount;
    let angle = 0;
    const orbit = () => {
      angle += 0.05;
      const x = Math.sin(angle) * radius;
      const z = Math.cos(angle) * radius - 0.6;
      try {
        panner.positionX.setTargetAtTime(x, context.currentTime, 0.12);
        panner.positionZ.setTargetAtTime(z, context.currentTime, 0.12);
      } catch {
        panner.setPosition(x, 0, z);
      }
    };
    orbit();
    audioFxOrbit = setInterval(orbit, 90);
    return;
  }

  if (preset === 'bass') {
    const shelf = context.createBiquadFilter();
    const compressor = context.createDynamicsCompressor();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 150;
    shelf.gain.value = 3 + 9 * amount;
    compressor.threshold.value = -12;
    compressor.ratio.value = 4;
    input.connect(shelf);
    shelf.connect(compressor);
    compressor.connect(output);
    graph.chain.push(shelf, compressor);
    return;
  }

  if (preset === 'room') {
    // 短混响：卧室 / 书房感
    const dry = context.createGain();
    const wet = context.createGain();
    const convolver = context.createConvolver();
    dry.gain.value = 1 - 0.15 * amount;
    wet.gain.value = 0.18 + 0.3 * amount;
    convolver.buffer = makeReverbImpulse(context, 0.6, 4.5);
    input.connect(dry);
    dry.connect(output);
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(output);
    graph.chain.push(dry, wet, convolver);
    return;
  }

  if (preset === 'cave') {
    // 长尾 + 低频堆积
    const dry = context.createGain();
    const wet = context.createGain();
    const convolver = context.createConvolver();
    const low = context.createBiquadFilter();
    dry.gain.value = 1 - 0.3 * amount;
    wet.gain.value = 0.4 + 0.55 * amount;
    low.type = 'lowshelf';
    low.frequency.value = 220;
    low.gain.value = 2 + 5 * amount;
    convolver.buffer = makeReverbImpulse(context, 4.5, 1.6);
    input.connect(dry);
    dry.connect(output);
    input.connect(convolver);
    convolver.connect(low);
    low.connect(wet);
    wet.connect(output);
    graph.chain.push(dry, wet, convolver, low);
    return;
  }

  if (preset === 'stadium') {
    // 超长混响，大场馆
    const dry = context.createGain();
    const wet = context.createGain();
    const convolver = context.createConvolver();
    const pre = context.createDelay(0.3);
    dry.gain.value = 1 - 0.35 * amount;
    wet.gain.value = 0.35 + 0.6 * amount;
    pre.delayTime.value = 0.03 + 0.05 * amount;
    convolver.buffer = makeReverbImpulse(context, 6, 1.1);
    input.connect(dry);
    dry.connect(output);
    input.connect(pre);
    pre.connect(convolver);
    convolver.connect(wet);
    wet.connect(output);
    graph.chain.push(dry, wet, convolver, pre);
    return;
  }

  if (preset === 'treble') {
    // 高音提亮
    const shelf = context.createBiquadFilter();
    const air = context.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 6000;
    shelf.gain.value = 2 + 8 * amount;
    air.type = 'highshelf';
    air.frequency.value = 12000;
    air.gain.value = 1 + 4 * amount;
    input.connect(shelf);
    shelf.connect(air);
    air.connect(output);
    graph.chain.push(shelf, air);
    return;
  }

  if (preset === 'warm') {
    // 温暖：削一点刺耳高频，加厚中低频
    const low = context.createBiquadFilter();
    const cut = context.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 180;
    low.gain.value = 1 + 4 * amount;
    cut.type = 'highshelf';
    cut.frequency.value = 7000;
    cut.gain.value = -(1 + 5 * amount);
    input.connect(low);
    low.connect(cut);
    cut.connect(output);
    graph.chain.push(low, cut);
    return;
  }

  if (preset === 'lofi') {
    // 复古电话：带通 + 轻微失真
    const hp = context.createBiquadFilter();
    const lp = context.createBiquadFilter();
    const shaper = context.createWaveShaper();
    hp.type = 'highpass';
    hp.frequency.value = 380;
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const curve = new Float32Array(1024);
    const drive = 1 + 6 * amount;
    for (let i = 0; i < curve.length; i += 1) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = ((1 + drive) * x) / (1 + drive * Math.abs(x));
    }
    shaper.curve = curve;
    input.connect(hp);
    hp.connect(lp);
    lp.connect(shaper);
    shaper.connect(output);
    graph.chain.push(hp, lp, shaper);
    return;
  }

  if (preset === 'night') {
    // 深夜：压缩动态 + 轻微降噪（高通去嗡声）
    const hp = context.createBiquadFilter();
    const compressor = context.createDynamicsCompressor();
    const gain = context.createGain();
    hp.type = 'highpass';
    hp.frequency.value = 60;
    compressor.threshold.value = -28 - 12 * amount;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.22;
    gain.gain.value = 1 + 0.35 * amount;
    input.connect(hp);
    hp.connect(compressor);
    compressor.connect(gain);
    gain.connect(output);
    graph.chain.push(hp, compressor, gain);
    return;
  }

  if (preset === 'live') {
    // 现场：短混响 + 空气感
    const dry = context.createGain();
    const wet = context.createGain();
    const air = context.createBiquadFilter();
    const convolver = context.createConvolver();
    dry.gain.value = 1 - 0.18 * amount;
    wet.gain.value = 0.2 + 0.35 * amount;
    air.type = 'highshelf';
    air.frequency.value = 8000;
    air.gain.value = 1 + 3 * amount;
    convolver.buffer = makeReverbImpulse(context, 1.6, 3);
    input.connect(dry);
    dry.connect(air);
    air.connect(output);
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(output);
    graph.chain.push(dry, wet, air, convolver);
    return;
  }

  if (preset === 'vocal') {
    const highpass = context.createBiquadFilter();
    const peak = context.createBiquadFilter();
    const air = context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 85;
    peak.type = 'peaking';
    peak.frequency.value = 2600;
    peak.Q.value = 1.1;
    peak.gain.value = 2 + 7 * amount;
    air.type = 'highshelf';
    air.frequency.value = 9000;
    air.gain.value = 1 + 4 * amount;
    input.connect(highpass);
    highpass.connect(peak);
    peak.connect(air);
    air.connect(output);
    graph.chain.push(highpass, peak, air);
    return;
  }

  input.connect(output);
}

let audioFxWatchdog = null;

function clearFxWatchdog() {
  if (audioFxWatchdog) {
    clearTimeout(audioFxWatchdog);
    audioFxWatchdog = null;
  }
}

/**
 * Web Audio 对跨域音源会「静音但不报错」，所以用播放进度做一个看门狗：
 * 打开音效后如果 1.8 秒内进度完全不动，就自动回退到原声。
 */
function armFxWatchdog(audio) {
  clearFxWatchdog();
  if (state.audioFx.preset === 'off') return;
  const startTime = audio.currentTime;
  audioFxWatchdog = setTimeout(() => {
    audioFxWatchdog = null;
    if (state.audioFx.preset === 'off') return;
    if (audio.paused) return;
    if (Math.abs(audio.currentTime - startTime) > 0.05) return;
    disableAudioFxOnError();
  }, 1800);
}

function applyAudioFx() {
  const audio = document.querySelector('#song-audio');
  if (!audio) return;
  const fx = state.audioFx;
  if (fx.preset === 'off' || !fx.enabled) {
    clearFxWatchdog();
    if (audioFxGraph) buildAudioFxChain(audioFxGraph, 'off', 0);
    document.body.dataset.audioFx = 'off';
    return;
  }
  if (audioFxFallback) {
    document.body.dataset.audioFx = 'off';
    return;
  }
  const graph = ensureAudioFxGraph(audio);
  if (!graph) return;
  if (graph.context.state === 'suspended') graph.context.resume().catch(() => {});
  buildAudioFxChain(graph, fx.preset, fx.intensity);
  document.body.dataset.audioFx = fx.preset;
  if (!audio.paused) armFxWatchdog(audio);
}

function reloadSongForFx() {
  const audio = document.querySelector('#song-audio');
  const song = currentSongEntry();
  if (!audio || !song?.url) return;
  const time = audio.currentTime || 0;
  const wasPlaying = Boolean(audio.src) && !audio.paused;
  audio.dataset.songKey = `${state.songIndex}:${song.url}`;
  audio.src = song.url;
  audio.load();
  audio.addEventListener(
    'loadedmetadata',
    () => {
      if (time > 0) audio.currentTime = time;
      if (wasPlaying) audio.play().catch(() => {});
    },
    { once: true }
  );
}

function setAudioFxPreset(preset) {
  const next = AUDIO_FX_KEYS.includes(preset) ? preset : 'off';
  state.audioFx.preset = next;
  state.audioFx.enabled = next !== 'off';
  if (next !== 'off') audioFxFallback = false;
  saveAudioFx();

  const audio = document.querySelector('#song-audio');
  const needsCors = next !== 'off' && !audioFxFallback;
  if (audio) {
    const hasCors = audio.getAttribute('crossorigin');
    if (needsCors && hasCors !== 'anonymous') {
      audio.setAttribute('crossorigin', 'anonymous');
      reloadSongForFx();
    } else if (!needsCors && hasCors !== null) {
      audio.removeAttribute('crossorigin');
      reloadSongForFx();
    }
  }
  applyAudioFx();
  updateSongChrome();
  return next;
}

function setAudioFxIntensity(value) {
  const next = Math.max(0, Math.min(100, Number(value) || 0));
  state.audioFx.intensity = next;
  saveAudioFx();
  applyAudioFx();
  return next;
}

function disableAudioFxOnError() {
  if (audioFxFallback) return;
  if (state.audioFx.preset === 'off') return;
  audioFxFallback = true;
  state.audioFx.preset = 'off';
  state.audioFx.enabled = false;
  saveAudioFx();
  const audio = document.querySelector('#song-audio');
  if (audio) audio.removeAttribute('crossorigin');
  if (audioFxGraph) buildAudioFxChain(audioFxGraph, 'off', 0);
  document.body.dataset.audioFx = 'off';
  reloadSongForFx();
  /*
   * 不弹提示：这是「这次播放的地址读不了跨域」，属于自动处理的内部决定，
   * 用户听到的就是原声，没有需要他做判断的事。留在控制台里方便排查。
   */
  console.info('[音效] 当前音源不支持跨域读取，已自动切回原声');
}
