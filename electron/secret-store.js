'use strict';

/**
 * 把「加密凭据存取」抽成独立模块 electron/secret-store.js。
 *
 * 动机：loadSecret / saveSecret 被 main.js 和多个拆出去的 ipc 模块共用
 * （森空岛、米游社、鹰角、网易云、音乐登录……）。以前它们定义在 main.js 里，
 * 每拆一块都要通过 ctx 传一次，容易漏。
 *
 * 现在是独立模块，谁要谁 require，不再依赖 ctx。
 *
 * 存储位置与格式保持完全不变（userData/sessions.enc.json，safeStorage 加密，
 * base64 存在一个扁平对象里），老数据直接兼容。
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const fsp = fs.promises;

function secretFile() {
  return path.join(app.getPath('userData'), 'sessions.enc.json');
}

async function readSecrets() {
  try {
    return JSON.parse(await fsp.readFile(secretFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function loadSecret(name) {
  if (!safeStorage.isEncryptionAvailable()) return '';
  const secrets = await readSecrets();
  const encoded = secrets[name];
  if (!encoded) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return '';
  }
}

async function saveSecret(name, value) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const secrets = await readSecrets();
  if (value) secrets[name] = safeStorage.encryptString(String(value)).toString('base64');
  else delete secrets[name];
  await fsp.mkdir(path.dirname(secretFile()), { recursive: true });
  await fsp.writeFile(secretFile(), JSON.stringify(secrets), 'utf8');
  return true;
}

module.exports = { loadSecret, saveSecret, secretFile };
