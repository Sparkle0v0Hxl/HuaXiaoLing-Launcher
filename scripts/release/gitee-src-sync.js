'use strict';
/*
 * 把源码工作区的源码同步到 Gitee 发行版仓库（SparkleHxl/HuaXiaoLing-Launcher, main）。
 *
 * 背景（2026-11-18 实测）：
 *   · Gitee 发行版仓库是当初从 GitHub 导入的独立仓库（fork=false, parent=null），
 *     不是自动镜像，不会自己跟着 GitHub 变；
 *   · gh-push.js 只推 GitHub，gitee-docs-sync.js 只推 README/更新说明，
 *     所以 Gitee 的源码（electron/ src/ 等）长期停在旧版本（当时是 2.12.1）；
 *   · Gitee 没有 Git Data API（GET /git/commits → 405，POST /git/blobs → 404），
 *     不能照搬 gh-push 的字节级提交，只能走 git CLI。
 *
 * 做法：把源码工作区的源码文件覆盖进 _gitee-repo 克隆，git commit + push。
 *   ★排除 latest.json —— Gitee 用的是带 ghfast.top 镜像前缀的版本，
 *     由 gitee-sync.js / gitee-release.js / gitee-dist-release.js 维护，不能被 GitHub 版覆盖。
 *   .gitattributes 会把源码里的 CRLF 规范化成 LF（Gitee 仓库自己的约定），功能不变。
 *
 * 用法：GITEE_TOKEN=<令牌> node scripts/release/gitee-src-sync.js [DRY=1]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT = 'H:\\deepseek-harness\\default-workspace\\_portablegit\\cmd\\git.exe';
const CLONE = 'H:\\deepseek-harness\\default-workspace\\_gitee-repo';
const WS = 'H:\\花筱灵启动器-源码';
const REPO_URL = 'https://gitee.com/SparkleHxl/HuaXiaoLing-Launcher.git';
const USER = 'SparkleHxl';
const BRANCH = 'main';
const TOKEN = (process.env.GITEE_TOKEN || '').trim();
const DRY = process.env.DRY === '1';

// 要同步的顶层项：源码 + 说明文档；★排除 latest.json（Gitee 镜像版由别的脚本维护）
// PRIVACY.md 与 docs/（README 里引用的截图）必须一起推，否则线上 404。
const TOPS = ['electron', 'src', 'build', 'scripts', 'package.json', 'LICENSE', 'README.md', 'PRIVACY.md', 'AUTHORS.md', 'docs', '启动-安全模式.bat', '更新说明.md'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp', 'shots', '.cache', '.build-tools']);
const SKIP_EXT = /\.(log|lnk)$/i;
const SKIP_NAME = /(^|\.)(bak|old)(\.|$|-)|\.bak-/i;

// 令牌只进 Node 进程的 argv/spawn env，不进 PowerShell 会话记录
const authUrl = `https://${USER}:${TOKEN}@gitee.com/SparkleHxl/HuaXiaoLing-Launcher.git`;

function git(args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(GIT, args, {
        cwd: CLONE,
        encoding: opts.encoding || 'utf8',
        maxBuffer: 1 << 28,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
      }),
    };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}
function safe(s) { return TOKEN ? String(s).split(TOKEN).join('***') : s; }

function walk(dir, relBase, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    const rel = path.join(relBase, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, rel, out);
    } else if (e.isFile() && !SKIP_EXT.test(e.name) && !SKIP_NAME.test(e.name)) {
      out.push({ full, rel: rel.replace(/\\/g, '/') });
    }
  }
}

(async () => {
  if (!TOKEN) { console.error('缺少 GITEE_TOKEN'); process.exit(1); }
  const pkg = JSON.parse(fs.readFileSync(path.join(WS, 'package.json'), 'utf8'));
  const VER = pkg.version;
  console.log(`源码工作区版本: ${VER}`);

  // 1. fetch 远端最新 + reset 掉本地（EOL 脏文件），拿到干净基线
  console.log('\n[1/6] fetch origin/main');
  let r = git(['fetch', 'origin', BRANCH], { env: {} });
  // fetch 不带鉴权 URL 时若失败，改用带令牌 URL
  if (!r.ok) r = git(['fetch', authUrl, BRANCH]);
  if (!r.ok) { console.error('fetch 失败:', safe(r.out).slice(0, 500)); process.exit(1); }
  console.log('  ok');

  console.log('[2/6] reset --hard FETCH_HEAD（清 EOL 脏文件，拿远端基线）');
  r = git(['reset', '--hard', 'FETCH_HEAD']);
  if (!r.ok) { console.error('reset 失败:', safe(r.out).slice(0, 500)); process.exit(1); }
  const headBefore = git(['rev-parse', 'HEAD']).out.trim();
  console.log('  HEAD =', headBefore.slice(0, 10));

  // 2. 收集源码文件
  const files = [];
  for (const top of TOPS) {
    const full = path.join(WS, top);
    if (!fs.existsSync(full)) { console.log('  跳过不存在的:', top); continue; }
    if (fs.statSync(full).isDirectory()) walk(full, top, files);
    else files.push({ full, rel: top });
  }
  let copied = 0;
  for (const { full, rel } of files) {
    const dest = path.join(CLONE, rel);
    const buf = fs.readFileSync(full);
    if (!fs.existsSync(dest) || !buf.equals(fs.readFileSync(dest))) {
      // 总是 copy：DRY 模式也要真实预览 git add 后的差异，最后再 reset 恢复
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      copied++;
    }
  }
  console.log(`[3/6] 源码文件 ${files.length} 个，其中 ${copied} 个字节不同（需 git 判断）`);

  // 3. git add + 检查差异（.gitattributes 会把 CRLF 规范化成 LF，真正差异以 git 为准）
  // ★前面已 reset --hard 到远端基线，工作区此刻只有我们覆盖进去的源码文件有差异，
  //   所以直接 git add -A 即可（不能用路径清单：build 被 .gitignore 忽略，显式列出会报错）。
  r = git(['add', '-A']);
  if (!r.ok) { console.error('git add 失败:', safe(r.out).slice(0, 500)); process.exit(1); }
  const diffStat = git(['diff', '--cached', '--stat']).out.trim();
  const staged = git(['diff', '--cached', '--name-only']).out.trim().split(/\r?\n/).filter(Boolean);
  console.log('[4/6] 待提交差异:', staged.length, '个文件');
  if (staged.length) console.log(diffStat.split(/\r?\n/).slice(0, 25).map((l) => '  ' + l).join('\n'));

  if (DRY) {
    console.log('\nDRY，不提交不推送；恢复工作区到原状态…');
    git(['reset', '--hard', headBefore]);
    console.log('已恢复，HEAD =', git(['rev-parse', 'HEAD']).out.trim().slice(0, 10));
    return;
  }
  if (!staged.length) { console.log('\n源码已与 Gitee 一致，无需提交'); return; }

  // 4. commit + push
  const msg = `v${VER}: 源码同步（对齐 GitHub main）`;
  r = git(['commit', '-m', msg]);
  if (!r.ok) { console.error('commit 失败:', safe(r.out).slice(0, 500)); process.exit(1); }
  const localHead = git(['rev-parse', 'HEAD']).out.trim();
  console.log('[5/6] commit', msg, '→', localHead.slice(0, 10));

  r = git(['push', authUrl, `HEAD:refs/heads/${BRANCH}`]);
  if (!r.ok) { console.error('push 失败:', safe(r.out).slice(0, 800)); process.exit(1); }
  console.log('[6/6] push 完成');

  // 5. 回读校验：远端 HEAD == 本地 HEAD，且远端 package.json 版本正确
  const remote = git(['ls-remote', authUrl, `refs/heads/${BRANCH}`]);
  const remoteSha = (remote.out.match(/^([0-9a-f]+)/) || [])[1] || '';
  console.log('回读远端 HEAD:', remoteSha.slice(0, 10), remoteSha === localHead ? '✓ 与本地一致' : '✗ 不一致');
  const remotePkg = git(['show', `FETCH_HEAD:package.json`]);
  // 再 fetch 一次确认远端真内容
  git(['fetch', authUrl, BRANCH]);
  const fetched = git(['show', `FETCH_HEAD:package.json`]);
  let rver = '';
  try { rver = JSON.parse(fetched.out).version; } catch {}
  console.log('回读远端 package.json version:', rver, rver === VER ? '✓' : '✗');
  if (remoteSha !== localHead || rver !== VER) process.exit(1);
  console.log('\nDONE');
})();
