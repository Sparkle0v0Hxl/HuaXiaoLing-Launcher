'use strict';

/**
 * 通用 UI 工具：HTML 转义与内联 SVG 图标。
 *
 * 2026-10-31 从 app.js 拆出 —— 「前后端分离」第 3 批。
 * 这两个函数被几百处模板字符串调用，是最早需要就位的依赖：
 * index.html 里必须排在所有其他 script 之前（app.js / update.js 顶层
 * 都会立刻用到 icon）。
 *
 * icon() 只拼 <use href="#i-xxx">，图标本体是 index.html 里的 <symbol>，
 * 所以这里没有任何资源依赖，纯字符串函数。
 */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}
