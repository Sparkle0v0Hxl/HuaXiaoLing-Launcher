// 把发版脚本里「包里指针指向哪」的默认值改成仓库里的清单
const fs = require('fs');

const p = process.argv[2];
const NEW = 'https://raw.githubusercontent.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher/main/latest.json';
let t = fs.readFileSync(p, 'utf8');
const before = t;

t = t.replace(/(\[string\]\$ManifestUrl\s*=\s*')[^']*(')/, `$1${NEW}$2`);
fs.writeFileSync(p, t, 'utf8');

console.log('changed:', before !== t);
const i = t.indexOf('$ManifestUrl');
console.log(t.slice(Math.max(0, i - 260), i + 200));
