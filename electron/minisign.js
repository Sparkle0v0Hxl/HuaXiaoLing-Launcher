'use strict';

/**
 * 更新清单签名校验（Ed25519）。
 *
 * 为什么需要这一层：清单里本来就带 sha256，客户端下完包也会校验——但 sha256 和
 * 清单是同一条通道发下来的，能改清单的人顺手就能把 sha256 一起改掉。哈希只能
 * 防「传输损坏」，防不了「源被换掉」。签名不一样：私钥只在发包的机器上，攻击者
 * 拿不到就伪造不出合法签名，改了任何一个受保护字段都会在客户端当场露馅。
 *
 * 签哪些字段
 *   version / sha256 / size / mandatory / deltas(from,to,sha256,size)
 * 刻意不签哪些
 *   url —— Gitee 镜像同步会把下载地址改写成国内加速前缀（见 scripts/release/
 *   gitee-sync.js），把 url 纳入签名会让镜像那份清单永远验签失败。安全性不受
 *   影响：地址被换掉也没用，下回来的文件照样要过签名里锁定的 sha256。
 *   notes / title / date —— 纯展示，改了顶多显示错字。
 *
 * 规范化方式
 *   不用 JSON.stringify 整个对象：字段顺序、缩进、数字格式任何一点差异都会让
 *   签名对不上。这里拼成固定顺序的多行文本，两端（发布脚本、客户端）用同一个
 *   函数，字节必然一致。
 */

const crypto = require('node:crypto');

/**
 * 内置公钥。换成自己的密钥时改这两行即可（脚本：scripts/release/sign-manifest.js）。
 * 私钥不在这里、也不在仓库里——它只存在于打包机的 H:\HXL-pack\keys\。
 */
const PUBLIC_KEY_B64 = '7fJAF5ITWXRu8oVpr3YCr6v9W7UmdtWOAZ2MhdGjNAI=';
const KEY_ID = 'dff6dc4c71f12733';

/** 清单里的版本号统一成 2.9.0 这种裸格式，避免 v 前缀差异破坏签名 */
function normVersion(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '');
}

function normSha(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

/**
 * 生成待签名文本。
 *
 * 换行符固定 \n：Windows 上写文件如果用 \r\n，签名就对不上了。签名只针对
 * 这段文本，不针对磁盘上的清单文件字节，所以文件本身用 CRLF 还是 LF 都无所谓。
 */
function signingPayload(manifest) {
  const data = manifest && typeof manifest === 'object' ? manifest : {};
  const parts = [
    'hxl-update-manifest/1',
    `version=${normVersion(data.version)}`,
    `sha256=${normSha(data.sha256)}`,
    `size=${Number(data.size) || 0}`,
    `mandatory=${data.mandatory ? 1 : 0}`,
  ];
  const deltas = (Array.isArray(data.deltas) ? data.deltas : [])
    .map((item) => ({
      from: normVersion(item && item.from),
      to: normVersion(item && item.to),
      sha256: normSha(item && item.sha256),
      size: Number(item && item.size) || 0,
    }))
    // 顺序由内容决定，清单里调换 deltas 的排列不影响验签
    .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
  for (const item of deltas) {
    parts.push(`delta=${item.from}>${item.to}:${item.sha256}:${item.size}`);
  }
  return Buffer.from(parts.join('\n'), 'utf8');
}

/** 公钥对象：SPKI DER 的前 12 字节是固定头，Ed25519 原始公钥是最后 32 字节。 */
function publicKeyObject(base64 = PUBLIC_KEY_B64) {
  const raw = Buffer.from(String(base64 || '').trim(), 'base64');
  if (raw.length !== 32) throw new Error('更新签名公钥格式不对');
  const der = Buffer.concat([
    // SEQUENCE(42) + SEQUENCE(5) + OID 1.3.101.112 + BIT STRING(33) + 0x00
    Buffer.from('302a300506032b6570032100', 'hex'),
    raw,
  ]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * 验一份清单。
 *
 * @returns {{state:'ok'|'invalid'|'none', reason:string, keyId:string}}
 *   ok      —— 有签名且验过
 *   none    —— 这份清单本来就没带签名（过渡期老清单）
 *   invalid —— 带了签名但对不上，绝不能拿来用
 */
function verifyManifest(manifest) {
  const sig = manifest && manifest.sig;
  if (!sig || typeof sig !== 'object' || !sig.value) {
    return { state: 'none', reason: '清单没有签名', keyId: '' };
  }
  const keyId = String(sig.keyId || '').trim();
  if (keyId && keyId !== KEY_ID) {
    // 公钥换了但客户端还是旧的：提示等待更新，别当成篡改
    return { state: 'invalid', reason: `签名密钥不匹配（清单 ${keyId}，预期 ${KEY_ID}）`, keyId };
  }
  let signature;
  try {
    signature = Buffer.from(String(sig.value || '').trim(), 'base64');
  } catch {
    return { state: 'invalid', reason: '签名不是合法的 base64', keyId };
  }
  if (signature.length !== 64) {
    return { state: 'invalid', reason: '签名长度不对', keyId };
  }
  try {
    const ok = crypto.verify(null, signingPayload(manifest), publicKeyObject(), signature);
    return ok
      ? { state: 'ok', reason: '', keyId }
      : { state: 'invalid', reason: '签名与清单内容不匹配', keyId };
  } catch (error) {
    return { state: 'invalid', reason: `验签出错：${error.message}`, keyId };
  }
}

module.exports = {
  PUBLIC_KEY_B64,
  KEY_ID,
  signingPayload,
  publicKeyObject,
  verifyManifest,
  normVersion,
  normSha,
};
