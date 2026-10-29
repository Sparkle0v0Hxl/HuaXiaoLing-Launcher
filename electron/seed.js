'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

// 2.4.0 合并：新增明日方舟 / 崩坏3 两个内置游戏，种子版本随之升到 7，
// 老存档会在下一次 ensureSeedData 时补齐这两个条目和它们的渠道行。
const SEED_VERSION = 7;

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

/*
 * 明日方舟：黑底 + 银白三角标识 + 红蓝双色细线。
 * 用罗德岛式的几何切割感代替原画，和其余内置封面保持同一套视觉语言。
 * （2.4.0 合并自对方开发分支的 seed.js）
 */
const ARKNIGHTS = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs>
    <linearGradient id="ak-bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#0b0d12"/><stop offset=".52" stop-color="#15181f"/><stop offset="1" stop-color="#07080b"/>
    </linearGradient>
    <linearGradient id="ak-fade" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#07080b" stop-opacity="0"/><stop offset=".72" stop-color="#07080b" stop-opacity=".88"/><stop offset="1" stop-color="#07080b"/>
    </linearGradient>
    <linearGradient id="ak-steel" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#f4f7fb"/><stop offset="1" stop-color="#9fb0c6"/>
    </linearGradient>
    <linearGradient id="ak-red" x1="0" y1="0" x2="1" y2="0">
      <stop stop-color="#ff4d5a" stop-opacity="0"/><stop offset=".5" stop-color="#ff4d5a" stop-opacity=".9"/><stop offset="1" stop-color="#ff4d5a" stop-opacity="0"/>
    </linearGradient>
    <filter id="ak-blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="26"/></filter>
  </defs>
  <rect width="600" height="800" fill="url(#ak-bg)"/>
  <circle cx="300" cy="300" r="185" fill="#9fb0c6" opacity=".1" filter="url(#ak-blur)"/>
  <g stroke="#c9d1d9" stroke-width=".6" opacity=".12">
    <path d="M0 120h600M0 200h600M0 280h600M0 360h600M0 440h600M0 520h600"/>
    <path d="M120 0v560M240 0v560M360 0v560M480 0v560"/>
  </g>
  <g transform="translate(300 300)">
    <path d="M0-150 L130 75 L0 25 L-130 75 Z" fill="url(#ak-steel)" opacity=".92"/>
    <path d="M0-96 L84 48 L0 16 L-84 48 Z" fill="#15181f"/>
    <path d="M0-150 L130 75 L0 25 Z" fill="#0b0d12" opacity=".28"/>
  </g>
  <path d="M-20 470 H620" stroke="url(#ak-red)" stroke-width="2"/>
  <path d="M-20 486 H620" stroke="#4d8bff" stroke-width="1" opacity=".45"/>
  <g fill="#e8eef7">
    <circle cx="96" cy="128" r="1.6" opacity=".6"/><circle cx="512" cy="112" r="1.2" opacity=".45"/>
    <circle cx="540" cy="392" r="1.5" opacity=".5"/><circle cx="82" cy="420" r="1" opacity=".35"/>
  </g>
  <g fill="#c9d1d9" opacity=".5">
    <rect x="468" y="196" width="6" height="6" transform="rotate(45 471 199)"/>
    <rect x="120" y="520" width="5" height="5" transform="rotate(45 122 522)"/>
  </g>
  <path d="M0 600 H600 V800 H0 Z" fill="url(#ak-fade)"/>
  <path d="M60 676 H190" stroke="#c9d1d9" stroke-width="2" opacity=".8"/>
</svg>`;

/*
 * 崩坏3：深海蓝紫底 + 银蓝「崩坏结晶」棱面 + 赤色裂隙细线。
 * 和其余内置封面同一套几何语言：用晶体切割感代替原画。
 * （2.4.0 合并自对方开发分支的 seed.js）
 */
const BH3 = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs>
    <linearGradient id="bh-bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#080b18"/><stop offset=".5" stop-color="#111a33"/><stop offset="1" stop-color="#05070f"/>
    </linearGradient>
    <linearGradient id="bh-fade" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#05070f" stop-opacity="0"/><stop offset=".72" stop-color="#05070f" stop-opacity=".88"/><stop offset="1" stop-color="#05070f"/>
    </linearGradient>
    <linearGradient id="bh-crystal" x1="0" y1="0" x2=".4" y2="1">
      <stop stop-color="#eaf3ff"/><stop offset=".55" stop-color="#8fb8ff"/><stop offset="1" stop-color="#3d6fd6"/>
    </linearGradient>
    <linearGradient id="bh-crack" x1="0" y1="0" x2="1" y2="0">
      <stop stop-color="#ff4d5a" stop-opacity="0"/><stop offset=".5" stop-color="#ff4d5a" stop-opacity=".92"/><stop offset="1" stop-color="#ff4d5a" stop-opacity="0"/>
    </linearGradient>
    <filter id="bh-blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="28"/></filter>
  </defs>
  <rect width="600" height="800" fill="url(#bh-bg)"/>
  <ellipse cx="300" cy="320" rx="200" ry="190" fill="#6f9dff" opacity=".16" filter="url(#bh-blur)"/>
  <ellipse cx="300" cy="320" rx="120" ry="120" fill="#ff4d5a" opacity=".07" filter="url(#bh-blur)"/>
  <g stroke="#9cc0ff" stroke-width=".6" opacity=".1">
    <path d="M0 140h600M0 230h600M0 320h600M0 410h600M0 500h600"/>
    <path d="M110 0v600M220 0v600M330 0v600M440 0v600M550 0v600"/>
  </g>
  <!-- 崩坏结晶：八面体棱面 -->
  <g transform="translate(300 310)">
    <path d="M0-190 L118-38 L0 128 L-118-38 Z" fill="url(#bh-crystal)" opacity=".9"/>
    <path d="M0-190 L118-38 L0 128 Z" fill="#ffffff" opacity=".14"/>
    <path d="M0-190 L-118-38 L0 128 Z" fill="#2a4a99" opacity=".3"/>
    <path d="M0-190 L0 128" stroke="#dbe9ff" stroke-width="1.2" opacity=".55"/>
    <path d="M-118-38 L118-38" stroke="#dbe9ff" stroke-width="1.2" opacity=".4"/>
    <path d="M0-190 L0 360" stroke="#9cc0ff" stroke-width="1" opacity=".22"/>
  </g>
  <!-- 赤色裂隙 -->
  <path d="M-20 250 L150 330 L118 372 L300 430 L268 470 L560 520" fill="none" stroke="url(#bh-crack)" stroke-width="2.4"/>
  <path d="M-20 292 L120 366 L92 404 L250 458 L222 496 L540 556" fill="none" stroke="url(#bh-crack)" stroke-width="1" opacity=".55"/>
  <g fill="#eaf3ff" opacity=".5">
    <circle cx="150" cy="132" r="1.7"/><circle cx="452" cy="196" r="1.3"/><circle cx="392" cy="96" r="1"/>
    <circle cx="228" cy="486" r="1.2"/><circle cx="500" cy="386" r="1.1"/>
  </g>
</svg>`;

const COVERS = {
  'builtin-genshin.svg': GENSHIN,
  'builtin-starrail.svg': STARRAIL,
  'builtin-zzz.svg': ZZZ,
  'builtin-endfield.svg': ENDFIELD,
  'builtin-neverness.svg': NTE,
  // 2.4.0 合并：明日方舟 / 崩坏3 的内置封面（对方分支同样用 SVG 种子封面）
  'builtin-arknights.svg': ARKNIGHTS,
  'builtin-bh3.svg': BH3,
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
  {
    /*
     * 明日方舟 PC 端（2.4.0 合并自对方分支）：和终末地共用鹰角启动器（GRYPHLINK），
     * 但游戏本体独立安装，默认在 <盘>\Arknights，入口 Arknights.exe。
     * 渠道比米哈游多一个 B服（bilibili 渠道的鹰角启动器）和国际服三区域 / 台服，
     * 见 channelsFor() 与 ARKNIGHTS_CHANNELS。
     * 适配说明：对方条目 cover 写的是 builtin-arknights.jpg，但对方分支里并不存在
     * 该 jpg 资产（对方 COVERS 注册的也是 SVG），这里按我方种子封面机制改成 .svg。
     */
    id: 'builtin-arknights',
    builtinKey: 'arknights',
    builtin: true,
    name: '明日方舟',
    subtitle: 'Arknights',
    description: '罗德岛的干员部署在泰拉的每一处战场，守住这条通往明天的防线。启动器会自动寻找已经安装的游戏。',
    version: '',
    tags: ['策略', '塔防', '剧情'],
    target: '',
    args: '',
    workDir: '',
    cover: 'covers/builtin-arknights.svg',
    accent: '#c9d1d9',
    favorite: false,
    demo: false,
    siteUrl: 'https://ak.hypergryph.com/',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 8).toISOString(),
    lastPlayed: null,
    launchCount: 0,
    playSeconds: 0,
  },
  {
    /*
     * 崩坏3（2.4.0 合并自对方分支）：米家同构渠道（官服 / B服 / 国际服），
     * 无公开公告接口，启动页显示「暂无公告」是预期行为。
     * cover 同上适配为 .svg。
     */
    id: 'builtin-bh3',
    builtinKey: 'bh3',
    builtin: true,
    name: '崩坏3',
    subtitle: 'Honkai Impact 3rd',
    description: '为世界上所有的美好而战。女武神在崩坏的阴影下守卫人类的明天。启动器会自动寻找已经安装的游戏。',
    version: '',
    tags: ['动作', '科幻', '剧情'],
    target: '',
    args: '',
    workDir: '',
    cover: 'covers/builtin-bh3.svg',
    accent: '#7fb2ff',
    favorite: false,
    demo: false,
    siteUrl: 'https://bh3.mihoyo.com/',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
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
  ['official', '官服'],
  ['bilibili', 'B服'],
  ['global', '国际服'],
];

/**
 * 明日方舟的服务器谱系（2.4.0 合并自对方分支）：
 *   - 国服：官服（鹰角）/ B服（B站）
 *   - 国际服（Yostar 发行）：EN / JP / KR 三个区域服，数据互不相通
 *   - 台服（TW）：独立发行，与上面都不互通
 * group 用于界面分组：同属国际服的三个区域服归到一组，选中组后再挑区域。
 */
const ARKNIGHTS_CHANNELS = [
  ['official', '官服'],
  ['bilibili', 'B服'],
  ['global-en', '国际服 · 英文', 'global'],
  ['global-jp', '国际服 · 日文', 'global'],
  ['global-kr', '国际服 · 韩文', 'global'],
  ['taiwan', '台服'],
];

function channelsFor(game) {
  if (game.builtinKey === 'endfield') return ENDFIELD_CHANNELS;
  if (game.builtinKey === 'arknights') return ARKNIGHTS_CHANNELS;
  if (game.builtinKey === 'neverness') return NTE_CHANNELS;
  return SERVER_CHANNELS;
}

for (const game of BUILTIN_GAMES) {
  // 2.4.0 合并：渠道行支持可选的 group 字段（明日方舟国际服三区域分组用）
  game.servers = channelsFor(game).map(([channel, name, group]) => ({
    id: `${game.id}-${channel}`,
    name,
    channel,
    path: '',
    root: '',
    ...(group ? { group } : {}),
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

  // 异环官服行在老存档里叫「国服」，统一规范成「官服」（与其他游戏口径一致）。
  // 必须放在 seedVersion 提前 return 之前，否则存量存档永远走不到；幂等，每次启动跑一遍。
  let renamed = false;
  for (const game of Array.isArray(store.data.games) ? store.data.games : []) {
    if (game.builtinKey !== 'neverness') continue;
    for (const item of game.servers || []) {
      if (item.channel === 'official' && item.name === '国服') {
        item.name = '官服';
        renamed = true;
      }
    }
  }
  if (renamed) await store.saveNow();

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
    if (!game.builtin) continue;
    const list = Array.isArray(game.servers) ? game.servers : [];
    if (!list.length) {
      // 2.4.0 合并：渠道行支持可选的 group 字段（明日方舟国际服三区域分组用）
      game.servers = channelsFor(game).map(([channel, name, group]) => ({
        id: `${game.id}-${channel}`,
        name,
        channel,
        path: '',
        root: '',
        ...(group ? { group } : {}),
        addedAt: new Date().toISOString(),
      }));
      game.activeServerId = game.servers[0].id;
      continue;
    }
    /*
     * 老存档里的游戏已经有服务器行了，但后来新增的渠道（比如异环的 B服）不会自己冒出来。
     * 这里把缺失的渠道补上；用户之后手动删掉的不会再被复活（seedVersion 已经记过了）。
     */
    const known = new Set(list.map((item) => item.channel));
    for (const entry of channelsFor(game)) {
      if (known.has(entry[0])) continue;
      // 补的渠道行同样带上 group（明日方舟国际服三区域）
      const [channel, name, group] = entry;
      list.push({
        id: `${game.id}-${channel}`,
        name,
        channel,
        path: '',
        root: '',
        ...(group ? { group } : {}),
        addedAt: new Date().toISOString(),
      });
    }
    game.servers = list;
    if (!game.activeServerId) game.activeServerId = list[0].id;
  }
  store.data.seedVersion = SEED_VERSION;
  store.data.seeded = true;
  await store.saveNow();
}

module.exports = { ensureSeedData, BUILTIN_GAMES };
