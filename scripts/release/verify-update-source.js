const fs = require('fs');
const ws = 'H:\\花筱灵启动器-源码';
const main = fs.readFileSync(ws + '\\electron\\main.js', 'utf8');

// 更新源常量
const idx = main.indexOf('OFFICIAL_UPDATE_MANIFEST');
console.log('=== 更新源定义 ===');
console.log(main.slice(idx - 200, idx + 600).split('\n').slice(0, 24).join('\n'));

// HX_* 现存钩子
const vars = [...new Set((main.match(/process\.env\.([A-Z0-9_]+)/g) || []).map((s) => s.slice(12)))];
console.log('\n=== 现存 env 变量 ===');
console.log(vars.join(', '));

// 交接文档里列出的探针函数是否还在
for (const k of ['runLayoutProbe', 'runCapture']) {
  console.log(k, '存在:', main.includes(k));
}
