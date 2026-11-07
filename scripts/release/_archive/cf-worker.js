/**
 * 花筱灵启动器更新镜像 —— Cloudflare Worker 反代（方案 C）
 *
 * 用途：给国内裸连 GitHub 的用户提供一个稳定的下载镜像。部署后把地址
 * 填进发布清单 build/latest.json 的 mirrors 数组（支持 {url} 占位符），
 * 例如：
 *   "mirrors": [
 *     "https://hxl-mirror.你的子域.workers.dev/{url}",
 *     "https://ghfast.top/"
 *   ]
 * 客户端不用升级：清单是热更的，下次检查更新就带上了。
 *
 * 部署步骤（一次性，约 3 分钟）：
 *   1. 注册/登录 https://dash.cloudflare.com（免费计划够用，每天 10 万请求）
 *   2. Workers & Pages → Create → Create Worker → 随便起名（如 hxl-mirror）→ Deploy
 *   3. Edit code → 全文替换为本文件内容 → Deploy
 *   4. 回到 Worker 页面拿到地址（https://hxl-mirror.<子域>.workers.dev）
 *   5. 测试：浏览器打开 https://<地址>/https://raw.githubusercontent.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher/main/latest.json
 *      能看到 2.4.x 的 JSON 就通了
 *   6. 把 "https://<地址>/{url}" 填进 build/latest.json 的 mirrors 首位，
 *      随下次发版（或直接改仓库根 latest.json）生效
 *
 * 可选：Worker → Settings → Domains & Routes → 绑自己的域名，
 * workers.dev 域名在国内的可达性一般，绑了自定义域名会更稳。
 *
 * 白名单只放行 GitHub / jsDelivr，防止这个 Worker 被人当公共代理滥用。
 */

const ALLOW_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'cdn.jsdelivr.net',
]);

export default {
  async fetch(request) {
    // 前缀式反代：https://<worker>/https://github.com/...
    const prefix = 'https://' + request.headers.get('host') + '/';
    const target = request.url.slice(prefix.length).trim();
    if (!target) return new Response('用法：https://<worker>/https://github.com/...\n', { status: 400 });

    let url;
    try {
      url = new URL(target);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    if (url.protocol !== 'https:' || !ALLOW_HOSTS.has(url.hostname)) {
      return new Response('host not allowed', { status: 403 });
    }

    const headers = new Headers();
    for (const name of ['user-agent', 'accept', 'range']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const upstream = await fetch(url, { headers, redirect: 'follow' });
    const responseHeaders = new Headers();
    for (const name of ['content-length', 'content-type', 'etag', 'last-modified', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set('x-mirror-by', 'hxl-mirror');
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};
