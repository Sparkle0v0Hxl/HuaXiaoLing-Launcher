'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeDefaults(defaults, loaded) {
  if (!isPlainObject(defaults)) return loaded === undefined ? defaults : loaded;
  const result = { ...defaults };
  if (!isPlainObject(loaded)) return result;
  for (const [key, value] of Object.entries(loaded)) {
    if (isPlainObject(value) && isPlainObject(defaults[key])) {
      result[key] = mergeDefaults(defaults[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this.timer = null;
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = mergeDefaults(this.defaults, parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('读取数据失败，使用默认数据：', error.message);
        try {
          const backup = `${this.file}.broken-${Date.now()}`;
          await fsp.copyFile(this.file, backup);
        } catch {
          /* ignore */
        }
      }
      this.data = structuredClone(this.defaults);
      await this.saveNow();
    }
    return this.data;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow().catch((error) => console.warn('保存数据失败：', error.message));
    }, 400);
  }

  saveNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const payload = JSON.stringify(this.data, null, 2);
    const file = this.file;
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await fsp.writeFile(tmp, payload, 'utf8');
        await fsp.rename(tmp, file);
      });
    return this.writeChain;
  }

  flushSync() {
    try {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      console.warn('退出时保存失败：', error.message);
    }
  }
}

module.exports = { JsonStore };
