'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const crypto = require('node:crypto');

class DownloadManager {
  constructor({ store, onChange, onToast }) {
    this.store = store;
    this.onChange = onChange || (() => {});
    this.onToast = onToast || (() => {});
    this.items = store.data.downloads;
    this.requests = new Map();
    this.lastEmit = 0;
  }

  list() {
    return this.items.map((item) => ({ ...item }));
  }

  find(id) {
    return this.items.find((item) => item.id === id);
  }

  emit(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 350) return;
    this.lastEmit = now;
    this.onChange();
  }

  persist() {
    this.store.save();
  }

  restore() {
    let changed = false;
    for (const item of this.items) {
      if (item.status === 'downloading' || item.status === 'queued') {
        item.status = 'paused';
        item.speed = 0;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  add(meta) {
    const item = {
      id: crypto.randomUUID(),
      ...meta,
      status: 'queued',
      speed: 0,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
    };
    this.items.unshift(item);
    this.persist();
    this.emit(true);
    return item;
  }

  start(id) {
    const item = this.find(id);
    if (!item) return false;
    if (item.status === 'downloading' || item.status === 'completed') return false;

    item.status = 'downloading';
    item.error = null;
    item.speed = 0;

    const part = `${item.filePath}.part`;
    let existing = 0;
    try {
      existing = fs.statSync(part).size;
    } catch {
      existing = 0;
    }
    if (existing > 0) {
      item.received = existing;
    } else {
      item.received = 0;
    }

    this.emit(true);
    const headers = {
      'User-Agent': 'HuaXiaoLingLauncher/1.0 (Windows)',
      Accept: '*/*',
    };
    if (existing > 0) headers.Range = `bytes=${existing}-`;
    this.fetch(item, item.url, headers, 0, existing);
    return true;
  }

  fetch(item, rawUrl, headers, redirects, existing) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      this.fail(item, '下载链接无效');
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(
      parsed,
      {
        headers,
        timeout: 45000,
      },
      (res) => {
        const status = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects < 6) {
          res.resume();
          const next = new URL(res.headers.location, parsed).href;
          this.fetch(item, next, headers, redirects + 1, existing);
          return;
        }

        if (status === 416 && existing > 0) {
          res.resume();
          const total = this.parseTotal(res.headers['content-range']);
          item.total = total || existing;
          this.finalize(item);
          return;
        }

        if (status !== 200 && status !== 206) {
          res.resume();
          this.fail(item, `服务器返回 HTTP ${status}`);
          return;
        }

        const resumed = status === 206 && existing > 0;
        if (!resumed) {
          item.received = 0;
          existing = 0;
        }

        const totalFromRange = this.parseTotal(res.headers['content-range']);
        const length = Number(res.headers['content-length'] || 0);
        if (totalFromRange) item.total = totalFromRange;
        else if (length > 0) item.total = length + (resumed ? existing : 0);
        else item.total = 0;

        item.status = 'downloading';
        item.received = resumed ? existing : 0;
        item.error = null;
        this.emit(true);

        const part = `${item.filePath}.part`;
        let stream;
        try {
          stream = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
        } catch (error) {
          res.resume();
          this.fail(item, `无法写入文件：${error.message}`);
          return;
        }

        let lastTick = Date.now();
        let lastBytes = item.received;

        res.on('data', (chunk) => {
          item.received += chunk.length;
          const now = Date.now();
          if (now - lastTick >= 700) {
            item.speed = Math.max(0, (item.received - lastBytes) / ((now - lastTick) / 1000));
            lastTick = now;
            lastBytes = item.received;
            this.emit();
          }
        });

        res.on('error', (error) => {
          if (item.status === 'paused' || item.status === 'cancelled') return;
          this.fail(item, `下载中断：${error.message}`);
        });

        res.pipe(stream);

        stream.on('error', (error) => {
          if (item.status === 'paused' || item.status === 'cancelled') return;
          this.fail(item, `写入失败：${error.message}`);
        });

        stream.on('finish', async () => {
          if (item.status === 'paused' || item.status === 'cancelled') return;
          this.requests.delete(item.id);
          await this.finalize(item);
        });
      }
    );

    req.on('error', (error) => {
      this.requests.delete(item.id);
      if (item.status === 'paused' || item.status === 'cancelled') return;
      this.fail(item, `无法连接：${error.message}`);
    });

    req.on('timeout', () => {
      req.destroy(new Error('连接超时'));
    });

    this.requests.set(item.id, req);
  }

  parseTotal(contentRange) {
    if (!contentRange) return 0;
    const match = /\/(\d+)$/.exec(contentRange);
    if (!match) return 0;
    return Number(match[1]) || 0;
  }

  async finalize(item) {
    if (item.status === 'cancelled') return;
    const part = `${item.filePath}.part`;
    try {
      await fsp.mkdir(require('node:path').dirname(item.filePath), { recursive: true });
      await fsp.rename(part, item.filePath);
      const stat = await fsp.stat(item.filePath);
      item.received = stat.size;
      if (!item.total) item.total = stat.size;
      item.status = 'completed';
      item.completedAt = Date.now();
      item.speed = 0;
      item.error = null;
      this.persist();
      this.emit(true);
      this.onToast({ type: 'success', message: `下载完成：${item.fileName}` });
    } catch (error) {
      this.fail(item, `保存文件失败：${error.message}`);
    }
  }

  fail(item, message) {
    if (item.status === 'paused' || item.status === 'cancelled') return;
    item.status = 'error';
    item.speed = 0;
    item.error = message;
    this.persist();
    this.emit(true);
    this.onToast({ type: 'error', message });
  }

  pause(id) {
    const item = this.find(id);
    if (!item || item.status !== 'downloading') return false;
    item.status = 'paused';
    item.speed = 0;
    const req = this.requests.get(id);
    if (req) {
      req.destroy();
      this.requests.delete(id);
    }
    this.persist();
    this.emit(true);
    return true;
  }

  resume(id) {
    const item = this.find(id);
    if (!item) return false;
    if (item.status === 'completed') return false;
    if (item.status === 'error' || item.status === 'cancelled') {
      try {
        if (item.status === 'cancelled') fs.unlinkSync(`${item.filePath}.part`);
      } catch {
        /* ignore */
      }
      item.error = null;
    }
    return this.start(id);
  }

  cancel(id) {
    const item = this.find(id);
    if (!item) return false;
    const req = this.requests.get(id);
    if (req) {
      item.status = 'cancelled';
      req.destroy();
      this.requests.delete(id);
    }
    item.status = 'cancelled';
    item.speed = 0;
    try {
      fs.unlinkSync(`${item.filePath}.part`);
    } catch {
      /* ignore */
    }
    this.persist();
    this.emit(true);
    return true;
  }

  remove(id) {
    const item = this.find(id);
    if (!item) return false;
    if (item.status === 'downloading') this.cancel(id);
    this.items = this.items.filter((d) => d.id !== id);
    this.store.data.downloads = this.items;
    this.persist();
    this.emit(true);
    return true;
  }

  async open(id) {
    const item = this.find(id);
    if (!item) return false;
    try {
      if (fs.existsSync(item.filePath)) {
        const { shell } = require('electron');
        await shell.openPath(item.filePath);
        return true;
      }
    } catch {
      /* ignore */
    }
    return this.openFolder(id);
  }

  async openFolder(id) {
    const item = this.find(id);
    if (!item) return false;
    const { shell } = require('electron');
    try {
      if (fs.existsSync(item.filePath)) {
        shell.showItemInFolder(item.filePath);
      } else {
        await fsp.mkdir(item.dir, { recursive: true });
        await shell.openPath(item.dir);
      }
      return true;
    } catch {
      return false;
    }
  }

  shutdown() {
    for (const [id, req] of this.requests) {
      const item = this.find(id);
      if (item && item.status === 'downloading') {
        item.status = 'paused';
        item.speed = 0;
      }
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
    }
    this.requests.clear();
    this.persist();
  }
}

module.exports = { DownloadManager };
