const fs = require('fs');
const zip = 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\HuaXiaoLing-1.6.1-Portable.zip';
const buf = fs.readFileSync(zip);
console.log('zip bytes:', buf.length);
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.log('no eocd'); process.exit(1); }
const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const names = [];
for (let n = 0; n < count; n++) {
  if (buf.readUInt32LE(off) !== 0x02014b50) break;
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
  off += 46 + nameLen + extraLen + commentLen;
}
console.log('entries:', names.length);
const has = (p) => names.some((n) => n.toLowerCase().includes(p.toLowerCase()));
console.log('root exe:', names.filter((n) => n.endsWith('.exe') && n.split('/').length === 2));
console.log('HXL.exe:', has('HXL.exe'));
console.log('shots dir:', has('/shots/'));
console.log('netease-api:', has('resources/netease-api/'));
console.log('endfield-packs:', has('resources/endfield-packs/'));
console.log('app root files:', names.filter((n) => /resources\/app\/[^/]+$/.test(n)));
console.log('stray app.js:', names.filter((n) => /resources\/app\/app\.js$/.test(n)).length);
console.log('nte-capture:', has('electron/nte-capture.js'));
console.log('song-ui:', has('src/song-ui.js'));
console.log('hb patcher:', has('vendor/hpatchz.exe'));
