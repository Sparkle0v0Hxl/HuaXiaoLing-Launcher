const fs = require('fs');
const p = require('path');
const ws = 'H:\\花筱灵启动器-源码';

const css = fs.readFileSync(p.join(ws, 'src', 'styles.css'), 'utf8');
console.log('CSS 大括号', (css.match(/{/g) || []).length, '/', (css.match(/}/g) || []).length);

const html = fs.readFileSync(p.join(ws, 'src', 'index.html'), 'utf8');
const syms = [...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
const dup = syms.filter((s, i) => syms.indexOf(s) !== i);
console.log('symbols', syms.length, '| 重名', dup.length ? dup : '无');

const main = fs.readFileSync(p.join(ws, 'electron', 'main.js'), 'utf8');
const lines = main.split('\n');
const a = lines.findIndex((x) => x.includes('async function runLayoutProbe'));
const b = lines.findIndex((x) => x.includes('async function runCapture'));
console.log('runLayoutProbe 起始行', a + 1, '| runCapture 起始行', b + 1, '| 两者间距', b - a, '行');

const news = JSON.parse(fs.readFileSync(p.join(ws, 'src', 'data', 'news.json'), 'utf8'));
console.log('news 条数', news.length, '| 首条版本', news[0].version);

const readme = fs.readFileSync(p.join(ws, 'README.md'), 'utf8');
console.log('README <details> 数', (readme.match(/<details>/g) || []).length, '| 含 2.1.9', readme.includes('2.1.9'));

const hand = fs.readFileSync(p.join(ws, '交接文档-2.1.9.md'), 'utf8');
console.log('交接文档字符数', hand.length, '| 行数', hand.split('\n').length);
