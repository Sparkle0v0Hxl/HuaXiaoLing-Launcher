const R = 'Sparkle0v0Hxl/HuaXiaoLing-Launcher';
const H = { 'user-agent': 'hx-check', accept: 'application/vnd.github+json', authorization: 'Bearer ' + process.env.GH_TOKEN };

async function g(u, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch('https://api.github.com' + u, { headers: H });
      const t = await r.text();
      return t ? JSON.parse(t) : null;
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(s => setTimeout(s, 1200 * (i + 1)));
    }
  }
}

(async () => {
  const r = await g('/repos/' + R + '/git/ref/heads/main');
  console.log('main head:', r.object.sha.slice(0, 10));
  const c = await g('/repos/' + R + '/git/commits/' + r.object.sha);
  console.log('msg:', c.message.split('\n')[0]);
  console.log('date:', c.author.date);
  for (const p of ['resources/app/src/record-model.js', 'scripts/prune-before-release.ps1', 'resources/app/src/data/news.json', 'resources/app/src/app.js']) {
    const f = await g('/repos/' + R + '/contents/' + p + '?ref=main');
    console.log(p, f && f.sha ? ('OK ' + f.size) : 'MISSING');
  }
  const rel = await g('/repos/' + R + '/releases');
  console.log('releases:', (rel || []).map(x => x.tag_name + '(' + (x.assets || []).length + ' assets)').join(', '));
})();
