'use strict';

/**
 * 给更新清单加签名（发布侧专用，需要私钥）。
 *
 * 用法：
 *   node scripts/release/sign-manifest.js latest.json
 *   node scripts/release/sign-manifest.js latest.json --key H:\HXL-pack\keys\update-signing.pem
 *   node scripts/release/sign-manifest.js latest.json --check      # 只校验，不改文件
 *
 * 私钥默认取 H:\HXL-pack\keys\update-signing.pem（不在仓库里），也可以用环境变量
 * HXL_UPDATE_KEY 指定路径。没有私钥的机器只能 --check，签不了名。
 *
 * 签名写在清单的 sig 字段里：{ alg, keyId, value }。签的是「版本号 / 整包 sha256 /
 * 大小 / 是否强制 / deltas 的 from-to-sha256-size」，不含 url（镜像改写地址后签名
 * 仍然有效）。规则细节见 electron/minisign.js。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const minisign = require('../../electron/minisign');

const DEFAULT_KEY = 'H:\\HXL-pack\\keys\\update-signing.pem';

function parseArgs(argv) {
  const out = { manifest: '', key: process.env.HXL_UPDATE_KEY || DEFAULT_KEY, check: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--key') {
      i += 1;
      out.key = argv[i] || '';
    } else if (arg === '--manifest') {
      i += 1;
      out.manifest = argv[i] || '';
    } else if (!arg.startsWith('--')) rest.push(arg);
  }
  if (!out.manifest && rest.length) out.manifest = rest[0];
  return out;
}

function readManifest(file) {
  const text = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('清单不是 JSON 对象');
  return data;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    console.error('用法：node scripts/release/sign-manifest.js <latest.json> [--key <私钥.pem>] [--check]');
    process.exit(2);
  }
  const file = path.resolve(args.manifest);
  if (!fs.existsSync(file)) {
    console.error(`找不到清单：${file}`);
    process.exit(2);
  }
  const manifest = readManifest(file);

  if (args.check) {
    const result = minisign.verifyManifest(manifest);
    console.log(`版本 ${manifest.version}  签名状态 ${result.state}${result.reason ? '（' + result.reason + '）' : ''}`);
    process.exit(result.state === 'ok' ? 0 : 1);
  }

  if (!fs.existsSync(args.key)) {
    console.error(`找不到签名私钥：${args.key}`);
    console.error('私钥只放在发包机上，不随源码分发。换机器发版时把 update-signing.pem 一起带过去。');
    process.exit(2);
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(args.key));
  const payload = minisign.signingPayload(manifest);
  const signature = crypto.sign(null, payload, privateKey);

  // sig 放在最后：签名本身只覆盖固定字段，所以先签内容、再挂签名是安全的
  const signed = { ...manifest, sig: {
    alg: 'ed25519',
    keyId: minisign.KEY_ID,
    value: signature.toString('base64'),
  } };
  fs.writeFileSync(file, `${JSON.stringify(signed, null, 2)}\n`, 'utf8');

  const verify = minisign.verifyManifest(signed);
  if (verify.state !== 'ok') {
    console.error(`签名后自检失败：${verify.reason}`);
    process.exit(1);
  }
  console.log(`已签名 ${path.basename(file)}  v${signed.version}  keyId ${minisign.KEY_ID}  签名 ${signature.length} 字节`);
}

if (require.main === module) main();

module.exports = { main };
