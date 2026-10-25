'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const SEED_VERSION = 5;

const GENSHIN = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#0a2b31"/><stop offset=".48" stop-color="#15525a"/><stop offset="1" stop-color="#07181d"/>
    </linearGradient>
    <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#fff4cf"/><stop offset=".55" stop-color="#f4d99a"/><stop offset="1" stop-color="#d8a95d"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#07181d" stop-opacity="0"/><stop offset=".7" stop-color="#07181d" stop-opacity=".86"/><stop offset="1" stop-color="#07181d"/>
    </linearGradient>
    <filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="24"/></filter>
  </defs>
  <rect width="600" height="800" fill="url(#sky)"/>
  <circle cx="300" cy="270" r="150" fill="#8fe6d5" opacity=".13" filter="url(#blur)"/>
  <circle cx="300" cy="270" r="78" fill="url(#sun)" opacity=".9"/>
  <circle cx="300" cy="270" r="118" fill="none" stroke="#d8f4e8" stroke-width="1" opacity=".3"/>
  <g opacity=".85">
    <path d="M-40 545 C 80 455, 150 505, 245 440 L 330 510 L 430 455 C 510 500, 570 480, 650 540 L 650 640 L -40 640 Z" fill="#0b3037"/>
    <path d="M20 600 C 120 520, 220 570, 310 505 L 420 585 L 520 520 C 570 550, 610 545, 650 570 L 650 700 L 20 700 Z" fill="#081f24"/>
  </g>
  <g fill="none" stroke="#d6fff1" stroke-linecap="round">
    <path d="M96 360 C 170 300, 208 380, 285 330" stroke-width="1.6" opacity=".5"/>
    <path d="M320 410 C 390 360, 430 430, 510 372" stroke-width="1.2" opacity=".35"/>
    <path d="M150 248 C 210 208, 240 260, 296 228" stroke-width="1" opacity=".3"/>
  </g>
  <g fill="#eafff8">
    <circle cx="120" cy="150" r="1.6" opacity=".6"/><circle cx="480" cy="130" r="1.2" opacity=".45"/>
    <circle cx="520" cy="250" r="1.5" opacity=".55"/><circle cx="100" cy="300" r="1" opacity=".35"/>
  </g>
  <g transform="translate(414 150) rotate(18)" fill="#f8e7b0">
    <path d="M0-26c5 14 10 20 26 26C10 7 5 13 0 28-5 13-10 7-26 0-10-6-5-12 0-26Z" opacity=".9"/>
  </g>
  <path d="M0 600 H600 V800 H0 Z" fill="url(#fade)"/>
  <path d="M60 676 H190" stroke="#8fe6d5" stroke-width="2" opacity=".75"/>
</svg>`;

const STARRAIL = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#0a0a18"/><stop offset=".5" stop-color="#161334"/><stop offset="1" stop-color="#080812"/>
    </linearGradient>
    <linearGradient id="trail" x1="0" y1="0" x2="1" y2=".4">
      <stop stop-color="#b8a4ff" stop-opacity="0"/><stop offset=".4" stop-color="#d8ccff" stop-opacity=".9"/>
      <stop offset=".72" stop-color="#7f6bff" stop-opacity=".6"/><stop offset="1" stop-color="#7f6bff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#080812" stop-opacity="0"/><stop offset=".72" stop-color="#080812" stop-opacity=".86"/><stop offset="1" stop-color="#080812"/>
    </linearGradient>
    <filter id="blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="26"/></filter>
  </defs>
  <rect width="600" height="800" fill="url(#bg)"/>
  <circle cx="390" cy="250" r="170" fill="#7f6bff" opacity=".14" filter="url(#blur)"/>
  <circle cx="390" cy="250" r="96" fill="#14102b" stroke="#b9a7ff" stroke-width="1.2" opacity=".85"/>
  <ellipse cx="390" cy="250" rx="160" ry="42" fill="none" stroke="#c9bbff" stroke-width="1" opacity=".38" transform="rotate(-18 390 250)"/>
  <path d="M-80 620 C 110 520, 200 620, 380 500 S 620 430, 700 460" fill="none" stroke="url(#trail)" stroke-width="3" opacity=".9"/>
  <path d="M-80 650 C 110 550, 200 650, 380 530 S 620 460, 700 490" fill="none" stroke="url(#trail)" stroke-width="1" opacity=".4"/>
  <g fill="#efe9ff">
    <circle cx="110" cy="130" r="1.6" opacity=".8"/><circle cx="180" cy="230" r="1" opacity=".5"/>
    <circle cx="500" cy="130" r="1.3" opacity=".6"/><circle cx="540" cy="330" r="1.7" opacity=".7"/>
    <circle cx="80" cy="390" r="1.2" opacity=".45"/><circle cx="250" cy="100" r="1" opacity=".35"/>
    <circle cx="450" cy="430" r="1.1" opacity=".4"/>
  </g>
  <g stroke="#d8ccff" stroke-width=".8" opacity=".28">
    <path d="M390 154v192M294 250h192"/>
    <path d="M322 182l136 136M458 182L322 318"/>
  </g>
  <g transform="translate(150 520) rotate(-12)" fill="#b9a7ff" opacity=".65">
    <rect x="0" y="0" width="58" height="26" rx="5" opacity=".4"/>
    <rect x="72" y="0" width="26" height="26" rx="5" opacity=".25"/>
    <rect x="20" y="36" width="86" height="3" rx="1.5" opacity=".7"/>
  </g>
  <path d="M0 600 H600 V800 H0 Z" fill="url(#fade)"/>
  <path d="M60 676 H190" stroke="#b9a7ff" stroke-width="2" opacity=".8"/>
</svg>`;

const ZZZ = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#0d0d10"/><stop offset=".55" stop-color="#1b1712"/><stop offset="1" stop-color="#0a0908"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#ffd166"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#0a0908" stop-opacity="0"/><stop offset=".7" stop-color="#0a0908" stop-opacity=".88"/><stop offset="1" stop-color="#0a0908"/>
    </linearGradient>
    <filter id="blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="24"/></filter>
  </defs>
  <rect width="600" height="800" fill="url(#bg)"/>
  <circle cx="310" cy="330" r="170" fill="#ff8a1f" opacity=".18" filter="url(#blur)"/>
  <g transform="rotate(-18 300 330)">
    <rect x="118" y="202" width="364" height="250" rx="14" fill="#111014" stroke="#ffb23e" stroke-width="1.4" opacity=".95"/>
    <rect x="140" y="224" width="320" height="186" rx="7" fill="#1b1712" stroke="#ff9d2e" stroke-width="1" opacity=".7"/>
    <path d="M140 410 L460 224" stroke="#ff7a1a" stroke-width="1" opacity=".32"/>
    <path d="M140 380 L400 224" stroke="#ffd166" stroke-width=".7" opacity=".22"/>
    <circle cx="300" cy="316" r="45" fill="none" stroke="#ffcf5c" stroke-width="2" opacity=".8"/>
    <path d="M272 316h56M300 288v56" stroke="#ffcf5c" stroke-width="1.3" opacity=".55"/>
  </g>
  <g opacity=".5">
    <path d="M0 660 L600 520 L600 548 L0 688 Z" fill="#ff7a1a" opacity=".24"/>
    <path d="M0 705 L600 565 L600 578 L0 718 Z" fill="#ffd166" opacity=".15"/>
  </g>
  <g fill="none" stroke="#ffd166" opacity=".25">
    <path d="M80 0v800M160 0v800M240 0v800M320 0v800M400 0v800M480 0v800M560 0v800" stroke-width=".6"/>
  </g>
  <g fill="#ffe9c4">
    <circle cx="92" cy="150" r="1.4" opacity=".6"/><circle cx="500" cy="120" r="1" opacity=".4"/>
    <circle cx="520" cy="250" r="1.5" opacity=".5"/>
  </g>
  <g fill="#ffcf5c" opacity=".6">
    <rect x="80" y="470" width="7" height="7" transform="rotate(45 83 473)"/>
    <rect x="500" y="420" width="5" height="5" transform="rotate(45 502 422)"/>
    <rect x="460" y="640" width="8" height="8" transform="rotate(45 464 644)"/>
  </g>
  <path d="M0 604 H600 V800 H0 Z" fill="url(#fade)"/>
  <path d="M60 676 H190" stroke="#ffb23e" stroke-width="2" opacity=".85"/>
</svg>`;

const ENDFIELD = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#0b0e09"/><stop offset=".52" stop-color="#1a2011"/><stop offset="1" stop-color="#090b07"/>
    </linearGradient>
    <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#eef7a6"/><stop offset=".6" stop-color="#d7e36b"/><stop offset="1" stop-color="#97a93d"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#090b07" stop-opacity="0"/><stop offset=".7" stop-color="#090b07" stop-opacity=".86"/><stop offset="1" stop-color="#090b07"/>
    </linearGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="28"/></filter>
  </defs>
  <rect width="600" height="800" fill="url(#bg)"/>
  <circle cx="390" cy="260" r="150" fill="#d7e36b" opacity=".12" filter="url(#glow)"/>
  <circle cx="390" cy="260" r="82" fill="url(#sun)" opacity=".92"/>
  <circle cx="390" cy="260" r="120" fill="none" stroke="#e9f3a2" stroke-width="1" opacity=".3"/>
  <ellipse cx="390" cy="260" rx="190" ry="48" fill="none" stroke="#d7e36b" stroke-width=".9" opacity=".34" transform="rotate(-20 390 260)"/>
  <g opacity=".9">
    <path d="M-30 610 L170 470 L290 560 L450 430 L630 570 L630 700 L-30 700 Z" fill="#080a06"/>
    <path d="M-30 650 L140 540 L280 620 L430 500 L630 620 L630 760 L-30 760 Z" fill="#0d1108"/>
  </g>
  <g fill="none" stroke="#d7e36b" opacity=".42">
    <path d="M88 300v250M88 300h80M168 300v150M168 450h54M222 450v-90h46M268 360h70" stroke-width="2"/>
    <path d="M88 550h150M238 550v-44h64M302 506h54" stroke-width="1.2" opacity=".65"/>
    <circle cx="386" cy="360" r="10" stroke-width="1.5"/>
    <circle cx="386" cy="360" r="22" stroke-width="1" opacity=".5"/>
  </g>
  <g fill="#d7e36b" opacity=".8">
    <rect x="80" y="232" width="46" height="3" rx="1.5"/>
    <rect x="80" y="242" width="24" height="3" rx="1.5" opacity=".55"/>
  </g>
  <g opacity=".28" stroke="#eef7a6">
    <path d="M0 720 L600 540" stroke-width="1"/>
    <path d="M0 748 L600 568" stroke-width=".8"/>
    <path d="M0 692 L600 512" stroke-width=".6"/>
  </g>
  <g fill="#eef7a6">
    <circle cx="110" cy="140" r="1.7" opacity=".65"/><circle cx="500" cy="120" r="1.2" opacity=".4"/>
    <circle cx="530" cy="360" r="1.4" opacity=".5"/><circle cx="70" cy="400" r="1" opacity=".35"/>
  </g>
  <path d="M0 600 H600 V800 H0 Z" fill="url(#fade)"/>
  <path d="M60 676 H190" stroke="#d7e36b" stroke-width="2" opacity=".85"/>
</svg>`;

const NTE = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
  <defs>
    <linearGradient id="nte-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#08111f"/>
      <stop offset=".55" stop-color="#10283d"/>
      <stop offset="1" stop-color="#061018"/>
    </linearGradient>
    <linearGradient id="nte-glow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#67d7ff" stop-opacity="0"/>
      <stop offset=".5" stop-color="#67d7ff" stop-opacity=".85"/>
      <stop offset="1" stop-color="#f4b8ff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="nte-fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#061018" stop-opacity="0"/>
      <stop offset="1" stop-color="#061018" stop-opacity=".85"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#nte-sky)"/>
  <circle cx="885" cy="150" r="62" fill="#dff8ff" opacity=".14"/>
  <circle cx="885" cy="150" r="32" fill="#eafcff" opacity=".72"/>
  <g fill="#0b1a29" stroke="#67d7ff" stroke-opacity=".18">
    <path d="M0 470h90v205H0zM110 430h58v245h-58zM180 500h74v175h-74zM270 390h52v285h-52zM335 460h96v215h-96zM445 420h44v255h-44zM505 360h70v315h-70zM590 450h84v225h-84zM690 330h58v345h-58zM760 470h105v205H760zM880 400h72v275h-72zM965 450h88v225h-88zM1065 380h72v295h-72zM1150 460h50v215h-50z"/>
  </g>
  <g fill="#67d7ff" opacity=".55">
    <rect x="125" y="455" width="24" height="4"/><rect x="125" y="470" width="36" height="3"/>
    <rect x="292" y="420" width="20" height="3"/><rect x="292" y="434" width="30" height="3"/>
    <rect x="525" y="392" width="28" height="3"/><rect x="525" y="407" width="18" height="3"/>
    <rect x="706" y="360" width="22" height="3"/><rect x="706" y="376" width="34" height="3"/>
    <rect x="985" y="480" width="28" height="3"/><rect x="985" y="496" width="18" height="3"/>
  </g>
  <path d="M0 520 C240 470 420 560 650 515 S980 430 1200 492" fill="none" stroke="url(#nte-glow)" stroke-width="2"/>
  <path d="M0 548 C300 500 520 590 760 540 S1030 470 1200 522" fill="none" stroke="url(#nte-glow)" stroke-width="1" opacity=".6"/>
  <g fill="#f4b8ff" opacity=".5">
    <circle cx="210" cy="150" r="1.6"/><circle cx="580" cy="90" r="1.2"/><circle cx="1050" cy="190" r="1.4"/>
    <circle cx="760" cy="220" r="1"/><circle cx="340" cy="250" r="1.2"/>
  </g>
  <path d="M0 540 H1200 V675 H0 Z" fill="url(#nte-fade)"/>
  <path d="M78 604 H236" stroke="#67d7ff" stroke-width="2" opacity=".8"/>
  <path d="M78 618 H176" stroke="#f4b8ff" stroke-width="1" opacity=".55"/>
</svg>`;

const COVERS = {
  'builtin-genshin.svg': GENSHIN,
  'builtin-starrail.svg': STARRAIL,
  'builtin-zzz.svg': ZZZ,
  'builtin-endfield.svg': ENDFIELD,
  'builtin-neverness.svg': NTE,
};

const BUILTIN_GAMES = [
  {
    id: 'builtin-genshin',
    builtinKey: 'genshin',
    builtin: true,
    name: '原神',
    subtitle: 'Genshin Impact',
    description: '在提瓦特大陆上旅行，遇见不同的风景与人。启动器会自动寻找已经安装的游戏。',
    version: '',
    tags: ['开放世界', '冒险'],
    target: '',
    args: '',
    workDir: '',
    cover: 'covers/builtin-genshin.svg',
    accent: '#7dd3c7',
    favorite: true,
    demo: false,
    siteUrl: 'https://ys.mihoyo.com/',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 12).toISOString(),
    lastPlayed: null,
    launchCount: 0,
    playSeconds: 0,
  },
  {
    id: 'builtin-starrail',
    builtinKey: 'starrail',
    builtin: true,
    name: '崩坏：星穹铁道',
    subtitle: 'Honkai: Star Rail',
    description: '登上星穹列车，沿着银河的轨迹前往下一站。启动器会自动寻找已经安装的游戏。',
    version: '',
    tags: ['回合制', '银河'],
    target: '',
    args: '',
    workDir: '',
    cover: 'covers/builtin-starrail.svg',
    accent: '#b49bff',
    favorite: false,
    demo: false,
    siteUrl: 'https://sr.mihoyo.com/',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 11).toISOString(),
    lastPlayed: null,
    launchCount: 0,
    playSeconds: 0,
  },
  {
    id: 'builtin-zzz',
    builtinKey: 'zzz',
    builtin: true,
    name: '绝区零',
    subtitle: 'Zenless Zone Zero',
    description: '在新艾利都的街头，用一次干脆的连携解决空洞里的麻烦。启动器会自动寻找已经安装的游戏。',
    version: '',
    tags: ['动作', '都市'],
    target: '',
    args: '',
    workDir: '',
    cover: 'covers/builtin-zzz.svg',
    accent: '#ffb347',
    favorite: false,
    demo: false,
    siteUrl: 'https://zzz.mihoyo.com/',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    lastPlayed: null,
    launchCount: 0,
    playSeconds: 0,
  },
  {
    id: 'builtin-neverness',
    builtinKey: 'neverness',
    builtin: true,
    name: '异环',
    subtitle: 'Neverness to Everness',
    description: '在海特洛市的霓虹与异象之间穿梭，和伙伴一起处理这座城市里的超自然麻烦。',
    version: '1.4',
    versionName: '1.4',
    tags: ['都市', '超自然', '开放世界'],
    target: '',
    args: '',
    workDir: '',
    cover: 'covers/builtin-neverness.svg',
    coverUrl: 'https://nte.perfectworld.com/en/images/cover260930/slide2.jpg',
    accent: '#67d7ff',
    favorite: false,
    demo: false,
    siteUrl: 'https://yh.wanmei.com/',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 9).toISOString(),
    lastPlayed: null,
    launchCount: 0,
    playSeconds: 0,
  },
  {
    id: 'builtin-endfield',
    builtinKey: 'endfield',
    builtin: true,
    name: '明日方舟：终末地',
    subtitle: 'Arknights: Endfield',
    description: '在塔卫二的荒原上建立基地、调度干员，把工业产线一路铺向未知的边界。',
    version: '',
    tags: ['策略', '工业', '探索'],
    target: '',
    args: '',
    workDir: '',
    cover: 'covers/builtin-endfield.svg',
    accent: '#d7e36b',
    favorite: false,
    demo: false,
    siteUrl: 'https://endfield.hypergryph.com/',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 9).toISOString(),
    lastPlayed: null,
    launchCount: 0,
    playSeconds: 0,
  },
];

const SERVER_CHANNELS = [
  ['official', '官服'],
  ['bilibili', 'B服'],
  ['global', '国际服'],
];

const ENDFIELD_CHANNELS = [
  ['official', '官服'],
  ['bilibili', 'B服'],
  ['global', '国际服'],
  ['play', 'Play'],
  ['steam', 'Steam'],
];

const NTE_CHANNELS = [
  ['official', '国服'],
  ['global', '国际服'],
];

function channelsFor(game) {
  if (game.builtinKey === 'endfield') return ENDFIELD_CHANNELS;
  if (game.builtinKey === 'neverness') return NTE_CHANNELS;
  return SERVER_CHANNELS;
}

for (const game of BUILTIN_GAMES) {
  game.servers = channelsFor(game).map(([channel, name]) => ({
    id: `${game.id}-${channel}`,
    name,
    channel,
    path: '',
    root: '',
    addedAt: new Date().toISOString(),
  }));
  game.activeServerId = game.servers[0].id;
}

async function ensureSeedData(store, userData) {
  const coversDir = path.join(userData, 'covers');
  await fsp.mkdir(coversDir, { recursive: true });

  for (const [fileName, content] of Object.entries(COVERS)) {
    const target = path.join(coversDir, fileName);
    try {
      await fsp.access(target);
    } catch {
      await fsp.writeFile(target, content, 'utf8');
    }
  }

  if ((store.data.seedVersion || 0) >= SEED_VERSION) return;

  const existing = Array.isArray(store.data.games) ? store.data.games : [];
  const custom = existing.filter((game) => !game.demo && !String(game.id || '').startsWith('demo-'));
  const builtinKeys = new Set(custom.filter((game) => game.builtinKey).map((game) => game.builtinKey));
  const hiddenBuiltins = new Set(store.data.hiddenBuiltins || []);
  const missing = BUILTIN_GAMES.filter(
    (game) => !builtinKeys.has(game.builtinKey) && !hiddenBuiltins.has(game.builtinKey)
  ).map((game) => ({
    ...game,
    createdAt: new Date().toISOString(),
  }));

  store.data.games = [...missing, ...custom];
  for (const game of store.data.games) {
    if (!game.builtin || (Array.isArray(game.servers) && game.servers.length)) continue;
    game.servers = channelsFor(game).map(([channel, name]) => ({
      id: `${game.id}-${channel}`,
      name,
      channel,
      path: '',
      root: '',
      addedAt: new Date().toISOString(),
    }));
    game.activeServerId = game.servers[0].id;
  }
  store.data.seedVersion = SEED_VERSION;
  store.data.seeded = true;
  await store.saveNow();
}

module.exports = { ensureSeedData, BUILTIN_GAMES };
