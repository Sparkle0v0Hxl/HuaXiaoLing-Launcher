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
const fs = require('node:fs');

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
 * 归一 URL：只把协议和主机小写，路径/查询/片段原样保留。
 *
 * 为什么不整体 toLowerCase —— 对象存储与 CDN 的 key 是大小写敏感的，
 * GitHub 的 release 文件名也是。整体小写会让同一个真实地址算出两种载荷，
 * 反而把好好的签名弄成验不过。
 */
function normUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/i.exec(raw);
  if (!m) return raw; // 不是绝对 URL（比如相对路径）就原样，不做猜测
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3]}`;
}

/**
 * 生成待签名文本。
 *
 * 换行符固定 \n：Windows 上写文件如果用 \r\n，签名就对不上了。签名只针对
 * 这段文本，不针对磁盘上的清单文件字节，所以文件本身用 CRLF 还是 LF 都无所谓。
 */
function signingPayload(manifest) {
  return signingPayloadFor(manifest, { includeDeltaUrl: true });
}

/**
 * 生成待签名文本（指定规格）。
 *
 * 为什么要有两个规格（2026-11-17 审查 rev-release 后加的）：
 *   · 老规格（v1）不含 deltas[].url —— 2.12.1 及之前所有已发布清单都是这么签的；
 *   · 新规格（v2）含 url —— 堵住「悄悄改下载地址」这个面（虽然 sha256 仍会兜住
 *     内容篡改，但能让客户端去敲任意域名本身就不该成立）。
 *
 * ★把 url 加进载荷是**改变签名格式**的破坏性变更：如果验签只认新规格，
 *   所有已发布版本（2.12.1 及之前）的清单会立刻全部「签名不匹配」，客户端
 *   拒绝该清单 = 老用户再也收不到更新。所以约定：
 *     - 签名：sign-manifest.js 用新规格（v2）；
 *     - 验签：verifyManifest 先按 v2 试，不行再按 v1 试，任一通过即 ok。
 *   这样老清单继续可用（v1），新清单拿到更强的保护（v2）。
 */
function signingPayloadFor(manifest, options = {}) {
  const includeDeltaUrl = options.includeDeltaUrl === true;
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
      // 归一：去掉首尾空白、协议与主机小写、路径原样（path 大小写敏感，不能 toLowerCase）。
      // 老规格下这个字段不参与载荷，但照样算出来不影响什么。
      url: normUrl(item && item.url),
    }))
    // 顺序由内容决定，清单里调换 deltas 的排列不影响验签
    .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
  for (const item of deltas) {
    parts.push(
      includeDeltaUrl
        ? `delta=${item.from}>${item.to}:${item.sha256}:${item.size}:${item.url}`
        : `delta=${item.from}>${item.to}:${item.sha256}:${item.size}`
    );
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
    /*
     * 两种规格都试：先 v2（含 deltas[].url，新清单用），再 v1（不含 url，老清单用）。
     * 任一通过即 ok —— 这样 2.12.1 及之前已发布的清单继续能验过，
     * 而新发的清单拿到「连下载地址一起签」的更强保护。
     * 顺序不能反：v1 的载荷更短，理论上存在「改了 url 后恰好撞上某个 v1 签名」的
     * 可能性（概率可忽略，但让 v2 优先是最小惊讶的写法）。
     */
    const key = publicKeyObject();
    const okV2 = crypto.verify(null, signingPayloadFor(manifest, { includeDeltaUrl: true }), key, signature);
    if (okV2) return { state: 'ok', reason: '', keyId };
    const okV1 = crypto.verify(null, signingPayloadFor(manifest, { includeDeltaUrl: false }), key, signature);
    if (okV1) return { state: 'ok', reason: '', keyId };
    return { state: 'invalid', reason: '签名与清单内容不匹配', keyId };
  } catch (error) {
    return { state: 'invalid', reason: `验签出错：${error.message}`, keyId };
  }
}

/**
 * 给一份清单加上签名（发布侧专用，需要私钥）。
 *
 * 为什么放在这里而不是只在 scripts/release/sign-manifest.js 里：
 *   镜像改写脚本（gitee-sync / gitcode-sync）会把 deltas[].url 换成 ghfast.top 前缀，
 *   而 url 现在**在签名载荷内** —— 改写后不重新签名，那份清单的 sig 必然失配，
 *   客户端（updater.js:266-269 「有签名就必须验过」）会直接拒绝该清单，
 *   国内用户全都收不到更新。所以改写脚本必须能就地重签。
 *
 * @param {object} manifest 清单（里面的旧 sig 会被覆盖）
 * @param {string|Buffer|import('node:crypto').KeyObject} privateKey PEM 文本 / Buffer / KeyObject
 * @returns {object} 带新 sig 的新对象（不修改入参）
 */
function signManifest(manifest, privateKey) {
  if (!privateKey) throw new Error('签名需要私钥');
  const key = privateKey && privateKey.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  const bare = manifest && typeof manifest === 'object' ? { ...manifest } : {};
  delete bare.sig;
  const signature = crypto.sign(null, signingPayload(bare), key);
  return {
    ...bare,
    sig: { alg: 'ed25519', keyId: KEY_ID, value: signature.toString('base64') },
  };
}

/** 从文件读私钥并签名；文件不存在返回 null（发布链里「没有私钥就保持原样」的语义）。 */
function signManifestWithKeyFile(manifest, keyFile) {
  const file = String(keyFile || '').trim();
  if (!file || !fs.existsSync(file)) return null;
  return signManifest(manifest, fs.readFileSync(file));
}

module.exports = {
  PUBLIC_KEY_B64,
  KEY_ID,
  signingPayload,
  signingPayloadFor,
  signManifest,
  signManifestWithKeyFile,
  publicKeyObject,
  verifyManifest,
  normVersion,
  normSha,
};
