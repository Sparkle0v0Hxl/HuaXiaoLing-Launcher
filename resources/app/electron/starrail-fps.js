'use strict';

const { execFile } = require('node:child_process');

const CN_KEY = 'HKCU\\Software\\miHoYo\\崩坏：星穹铁道';
const GLOBAL_KEY = 'HKCU\\Software\\Cognosphere\\Star Rail';
const MODEL_VALUE = 'GraphicsSettings_Model_h2986158309';
const QUALITY_VALUE = 'GraphicsSettings_GraphicsQuality_h523255858';

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'reg.exe',
      args,
      { encoding: 'buffer', windowsHide: true, timeout: 5000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

function decode(buffer) {
  if (!buffer || !buffer.length) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return buffer.toString('latin1');
    }
  }
}

function registryPaths(channel) {
  if (channel === 'global') return [GLOBAL_KEY];
  return [CN_KEY, GLOBAL_KEY];
}

async function readModel(key) {
  const output = decode(await run(['query', key, '/v', MODEL_VALUE]));
  const match = output.match(new RegExp(`${MODEL_VALUE}\\s+REG_BINARY\\s+([0-9A-Fa-f]+)`));
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'hex');
  let text = bytes.toString('utf8').replace(/\0+$/g, '').trim();
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getStarRailFps(channel = '') {
  for (const key of registryPaths(channel)) {
    try {
      const model = await readModel(key);
      if (!model) continue;
      return {
        fps: [30, 60, 120].includes(Number(model.FPS)) ? Number(model.FPS) : 60,
        key,
      };
    } catch {
      /* try next channel */
    }
  }
  return { fps: 60, key: registryPaths(channel)[0] };
}

async function setStarRailFps(fps, channel = '') {
  const value = [30, 60, 120].includes(Number(fps)) ? Number(fps) : 60;
  const key = registryPaths(channel)[0];
  let model = null;
  try {
    model = await readModel(key);
  } catch {
    model = null;
  }
  if (!model) {
    model = {
      FPS: value,
      EnableVSync: false,
      RenderScale: 1.0,
      ResolutionQuality: 3,
      ShadowQuality: 3,
      LightQuality: 3,
      CharacterQuality: 3,
      EnvDetailQuality: 3,
      ReflectionQuality: 3,
      SFXQuality: 3,
      BloomQuality: 3,
      AAMode: 1,
      EnableMetalFXSU: false,
      EnableHalfResTransparent: false,
      EnableSelfShadow: 1,
      DlssQuality: 0,
    };
  } else {
    model.FPS = value;
  }
  const text = JSON.stringify(model);
  const hex = Buffer.from(`${text}\0`, 'utf8').toString('hex').toUpperCase();
  await run(['add', key, '/v', MODEL_VALUE, '/t', 'REG_BINARY', '/d', hex, '/f']);
  // Starward does the same: the FPS value only takes effect with a custom quality preset.
  await run(['add', key, '/v', QUALITY_VALUE, '/t', 'REG_DWORD', '/d', '0', '/f']);
  return { fps: value, key };
}

module.exports = { getStarRailFps, setStarRailFps };
