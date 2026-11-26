'use strict';

/**
 * 蓝色星原：B服（C001）渠道文件自愈。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 硬链接把官服整棵树镜像到 B服 运行时后，游戏目录里的渠道身份文件仍是官服：
 *   · <root>/mj_sdk/res/app_config.dat        （游戏进程读它判断渠道，官服 1984B / B服 1392B）
 *   · <root>/AzurPromilia_Data/Plugins/mj_sdk/*（SDK、CEF、B站登录器）
 * 结果是「B服 启动器拉起来了，进游戏却是官服」，sdkbrowser 里也能看到
 *   ver: "...+C000-..."、sdk-cache \Game_35_C000_SC010。
 *
 * 之前那版替换用的是 mj_sdk/xxx 这种相对根目录的路径，但真实清单里 DLL 全在
 * AzurPromilia_Data/Plugins/mj_sdk/ 下，所以一个都没换到（用户实测复现）。
 *
 * ── 数据来源 ────────────────────────────────────────────────────
 * 下面这份清单是官服清单与 B服清单逐文件比对的结果（40527 个文件）：
 *   内容不同 11 个 + 仅 B服 75 个（含 3 个目录）。共 86 条。
 * 每条的 size / md5 来自 B服官方清单（_index/1.0.0.30 解密）。
 *
 * 写入原则：先 unlink 再写（目标多半是硬链接，直接写会穿透到官服本体），
 * 下载后校验 size + md5。
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const CDN_BASE = 'https://syncstation.manjuu.com/';
const CDN_PREFIX = {
  C001: 'azurpromilia/pg_item_v2/target/sc010_20261106131610_b3AtMTExMDUw/',
};

/* B服相对官服多出来的、或内容不同的渠道文件（86 条） */
const CHANNEL_FILES = [
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/CefView/dxcompiler.dll",
    "size": 25863784,
    "md5": "47f5ee2c0b0b29e530062437eeeba161",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/CefView/libEGL.dll",
    "size": 515688,
    "md5": "4b0d90aa532c6c9932bc33b5e56d6253",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/CefView/libcef.dll",
    "size": 239205992,
    "md5": "88b4398ec8f694b3cc6d8b33689f371c",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/CefView/vulkan-1.dll",
    "size": 914024,
    "md5": "ae6e154ef2b88a0633ea22d2eeb44b81",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/CefView/vk_swiftshader.dll",
    "size": 5361256,
    "md5": "a255d3fe5aebf97487743f63c28e36a7",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/CefView/CefViewWing.exe",
    "size": 1067624,
    "md5": "3ae5b4ec2dc783b7be4a744a8d3d5795",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/CefView/libGLESv2.dll",
    "size": 7908968,
    "md5": "5e44df51da2f81a72abc475e1434126b",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/CefView/chrome_elf.dll",
    "size": 1786984,
    "md5": "46a959ff4e8c2afd7d3b5b855c4df9e3",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/union_pcsdk.dll",
    "size": 16683112,
    "md5": "3ede4f042c92fcc47ef1d769cb153dca",
    "dir": false
  },
  {
    "rel": "mj_sdk/res/app_config.dat",
    "size": 1392,
    "md5": "753e5eac9ae85c4e028b8b9a90cf3e28",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/manjuu_sdk_browser.exe",
    "size": 6570600,
    "md5": "d45ace57d58b4084ed30496b5c9659a1",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64",
    "size": 0,
    "md5": "00000000000000000000000000000000",
    "dir": true
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser",
    "size": 0,
    "md5": "00000000000000000000000000000000",
    "dir": true
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales",
    "size": 0,
    "md5": "00000000000000000000000000000000",
    "dir": true
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/swiftshader",
    "size": 0,
    "md5": "00000000000000000000000000000000",
    "dir": true
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/cs.pak",
    "size": 254040,
    "md5": "f81c31042b53272493f74467ac0183cc",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/swiftshader/libGLESv2.dll",
    "size": 3804224,
    "md5": "66fc758cbe6d0cd09e410fec970975d1",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/it.pak",
    "size": 241201,
    "md5": "461ecba1b9662a1ddd66a250cab0e19a",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/tr.pak",
    "size": 241433,
    "md5": "253cad3bdadceead42b636a02492d688",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/PCGamePlatform.exe",
    "size": 7780424,
    "md5": "0cd8a8943d8d4bf5bb341b352a390c3d",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/icudtl.dat",
    "size": 10505952,
    "md5": "3f019441588332ac8b79a3a3901a5449",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/sv.pak",
    "size": 227131,
    "md5": "cd214c9dd8db601a2d6d9b9d17a64abb",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/hr.pak",
    "size": 241834,
    "md5": "29e4e897f011d164de3de74822c57ce7",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/sk.pak",
    "size": 257057,
    "md5": "68dfcb3031d2776139299ef37c59840d",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/ta.pak",
    "size": 587585,
    "md5": "50756cd65217f75b85fc0d62e7418c4f",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/snapshot_blob.bin",
    "size": 240472,
    "md5": "b71d6944f1885b3820b9d4393c04f3f7",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/pt-BR.pak",
    "size": 242019,
    "md5": "c3ec8b8cdc71cae025877417a375684a",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/ja.pak",
    "size": 299857,
    "md5": "09d4cfe9a7d19b658a64d3a845c99f3e",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/cef_100_percent.pak",
    "size": 654037,
    "md5": "32c248d14d8acb62c6de0d471deab83e",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/lv.pak",
    "size": 257465,
    "md5": "e2496f07b4cfb26a80cf5e501a35592e",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/hu.pak",
    "size": 263428,
    "md5": "ea176e7da225560bce3eaaa54d3df90a",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/nl.pak",
    "size": 235024,
    "md5": "db88301848f94643a75591cec429f048",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/mr.pak",
    "size": 492853,
    "md5": "d1347d4d166d9562b775b5799a05ea9e",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/fr.pak",
    "size": 267633,
    "md5": "7ec953c160191665df9f79001d01d78a",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/cef_200_percent.pak",
    "size": 808292,
    "md5": "ca84d542e92abe33918382855169c9bc",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/d3dcompiler_47.dll",
    "size": 4370760,
    "md5": "551e87ecb51ce4b6e6a7f7b64c942ab0",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/et.pak",
    "size": 222610,
    "md5": "63e2740fed19aed4df933e3675c38a4b",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/pt-PT.pak",
    "size": 245314,
    "md5": "55ecfa6334fe88a4e73f9ba4161f2ea2",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/swiftshader/libEGL.dll",
    "size": 446032,
    "md5": "b624f12ccd55cd6a1567b79a72f066af",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/lt.pak",
    "size": 258878,
    "md5": "36e047214bce34ec98718647441ed9cf",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/fil.pak",
    "size": 252933,
    "md5": "530b1fac843758b1db800cd40921ce02",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/libEGL.dll",
    "size": 399432,
    "md5": "410c9124cb390bae9acd2aaddc0ea366",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/PCGameSDK.dll",
    "size": 6279752,
    "md5": "23c64511075e651bfd2d9cb66609f4c8",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/sw.pak",
    "size": 232318,
    "md5": "31533b362bee2c5c01711545eab0db48",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/el.pak",
    "size": 442205,
    "md5": "8ff6337efb4b83dbf3d1f9876c5f2f2c",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/en-US.pak",
    "size": 206531,
    "md5": "ca71b35dd44d9949f8d7f1f47f6e274b",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/zh-CN.pak",
    "size": 208989,
    "md5": "3ca88393df40abb58bc4f85cc458166e",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/ru.pak",
    "size": 392556,
    "md5": "f68e430fcb17c3b007771966e3d782ca",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/es-419.pak",
    "size": 245809,
    "md5": "e335cd6f2eb68a4d8e3eb5ce83a868fd",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/sl.pak",
    "size": 243557,
    "md5": "5244b1ad235b3d8418bc52a181bd324f",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/gu.pak",
    "size": 497075,
    "md5": "30c8924625ea7d5d9791bb9be823849d",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/ro.pak",
    "size": 250362,
    "md5": "1041b67d289db48a67dad59323979958",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/en-GB.pak",
    "size": 204836,
    "md5": "7ec5fa5bd1b0b237e1cb28a42430aebe",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/id.pak",
    "size": 221326,
    "md5": "e4baaeed3c5b53b5d1b78474ad3cbbf3",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/te.pak",
    "size": 555475,
    "md5": "978c8e66f0648062d3aa8fefa90d1fcb",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/bg.pak",
    "size": 401521,
    "md5": "c2b161b1dc618e4ce6cb6c5283e1715d",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/he.pak",
    "size": 301333,
    "md5": "1ad6c8086b3fdec1c335d62fa9185a87",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/kn.pak",
    "size": 578424,
    "md5": "8b357267e57492e8461814dbec9820e1",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/chrome_elf.dll",
    "size": 993352,
    "md5": "422945ed8c01f63ad49ac834f6da1a15",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/da.pak",
    "size": 228312,
    "md5": "33df6b400cf08935c50fd302c3540f42",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/de.pak",
    "size": 248889,
    "md5": "1a9b417970d87dacdd693c178d09d615",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/libcef.dll",
    "size": 118150728,
    "md5": "a96cd70e869b8151bbdbc555bfb97487",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/vi.pak",
    "size": 279590,
    "md5": "51070ba57791bf068c50d77dcff37f76",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/th.pak",
    "size": 471760,
    "md5": "3092ca6c04dc417b2e100e58c1c9b6aa",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/pl.pak",
    "size": 251100,
    "md5": "961d968b1a60a94cfeaf644ea4234142",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/ml.pak",
    "size": 617634,
    "md5": "4ea6d13a759001cb6cc61e9fc090e485",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/bn.pak",
    "size": 516903,
    "md5": "3ea49ba7ec3485ecc0ae7a03ec99143d",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/devtools_resources.pak",
    "size": 7015266,
    "md5": "d5ac411b408c4b450e430ae3b0079bc8",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/ar.pak",
    "size": 355088,
    "md5": "54d40241b1c3864057abf172f56401fe",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/am.pak",
    "size": 352926,
    "md5": "f12d040adcafbb4522293b43c90e2616",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/es.pak",
    "size": 249919,
    "md5": "457b6945f8c6f3ca4b1f6957335384b0",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/cef.pak",
    "size": 2133001,
    "md5": "fc3a9b3b5860b4ee5166291f2cad54f2",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/libGLESv2.dll",
    "size": 7970888,
    "md5": "e5375c6fe5dd718faba4d67532bbed38",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/nb.pak",
    "size": 225090,
    "md5": "47e2570b53237158c36b3f92ed3ebf16",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/cef_extensions.pak",
    "size": 1772827,
    "md5": "aedf0d732ffb8d15fad2dc44bf16d7f6",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/ms.pak",
    "size": 229260,
    "md5": "1bfcfb7e00ae3387eac5cc8e4219035d",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/ko.pak",
    "size": 252196,
    "md5": "13fc0a0d46f9d930f3e14a43b95de0cf",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/hi.pak",
    "size": 510101,
    "md5": "91d247c43e57c22f2a78caee0d0fac18",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/fa.pak",
    "size": 353040,
    "md5": "cac6aedcbc49b770c78e3ab1be926557",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/game_security_protection.exe",
    "size": 5660232,
    "md5": "5e7e09fcc5c014d24b2465a8269dca1e",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/uk.pak",
    "size": 394688,
    "md5": "a75db4a89a5ea61c1e972c6fcc3f7769",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/zh-TW.pak",
    "size": 209140,
    "md5": "c86628554cbe29de450b4ea04b42d9c3",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/fi.pak",
    "size": 229769,
    "md5": "0a4b34e8b6bb784fc9122d260b0bdb62",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/sr.pak",
    "size": 377367,
    "md5": "3ef7c98b345f5477fc39588d6c46e183",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/locales/ca.pak",
    "size": 250093,
    "md5": "39e469f1f3f2c211fe333df1fdf6c07a",
    "dir": false
  },
  {
    "rel": "AzurPromilia_Data/Plugins/mj_sdk/BLPlatform64/BLWebbrowser/v8_context_snapshot.bin",
    "size": 559000,
    "md5": "7b66594958015fd4ce8e40b52ac9a06b",
    "dir": false
  }
];

const STAMP = '.hxl-azur-channel.json';

function channelCodeOf(channel) {
  const v = String(channel || '').toLowerCase();
  if (v === 'bilibili' || v === 'b服') return 'C001';
  if (v === 'official' || v === '官服') return 'C000';
  return '';
}

function readStamp(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, STAMP), 'utf8'));
  } catch {
    return null;
  }
}

function writeStamp(root, data) {
  try {
    fs.writeFileSync(path.join(root, STAMP), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* 标记写不进去不影响功能，只是下次会重新校验 */
  }
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function humanize(error, what) {
  const code = String((error && error.code) || '');
  const msg = String((error && error.message) || error || '');
  if (/EPERM|EACCES|EBUSY/.test(code) || /EPERM|EACCES|EBUSY|占用|permission/i.test(msg)) {
    return `${what}：文件被其它进程占用或权限不足。请先完全退出蓝色星原（含官方启动器），必要时以管理员身份运行启动器后重试。`;
  }
  return `${what}：${msg}`;
}

/** 快速判断：三个关键文件的尺寸对上，且标记文件存在，就算已就绪。 */
function quickReady(root, code) {
  if (code !== 'C001') return true;
  const checks = [
    ['mj_sdk/res/app_config.dat', 1392],
    ['AzurPromilia_Data/Plugins/mj_sdk/union_pcsdk.dll', 16683112],
    ['AzurPromilia_Data/Plugins/mj_sdk/PCGameSDK.dll', 6279752],
  ];
  for (const [rel, size] of checks) {
    try {
      if (fs.statSync(path.join(root, rel)).size !== size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function downloadOne(url, expected, signal) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0' },
    signal: signal || AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expected.size && buf.length !== expected.size) {
    throw new Error(`大小 ${buf.length} != ${expected.size}`);
  }
  if (expected.md5) {
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    if (hash !== expected.md5) throw new Error(`md5 ${hash.slice(0, 8)} != ${expected.md5.slice(0, 8)}`);
  }
  return buf;
}

/**
 * 确保指定渠道的运行时刻文件正确（目前只实现 B服 C001）。
 *
 * @param {object} options
 * @param {string} options.root     运行时根目录
 * @param {string} options.channel  渠道 key（bilibili / official / global）
 * @param {(msg:string)=>void} [options.onLog]
 * @param {(p:object)=>void} [options.onProgress]
 * @param {object} [options.signal]
 * @returns {Promise<{ok:boolean, skipped?:boolean, replaced?:number, downloaded?:number, errors?:string[], total?:number}>}
 */
async function ensureChannelRuntime({ root, channel, onLog = () => {}, onProgress = () => {}, signal }) {
  const dir = path.resolve(String(root || ''));
  const code = channelCodeOf(channel);
  if (!dir || !code) return { ok: true, skipped: true, note: '渠道无需自愈' };
  if (code !== 'C001') {
    /* 官服：源就是官服，硬链接后身份本来就是 C000，不需要动 */
    return { ok: true, skipped: true, note: '官服无需替换渠道文件' };
  }
  if (!fs.existsSync(dir)) return { ok: false, errors: [`目录不存在：${dir}`], replaced: 0, downloaded: 0 };

  const stamp = readStamp(dir);
  if (stamp && stamp.channel === code && quickReady(dir, code)) {
    return { ok: true, skipped: true, note: '渠道文件已就绪' };
  }

  const prefix = CDN_PREFIX[code];
  if (!prefix) return { ok: false, errors: [`没有 ${code} 的 CDN 前缀`], replaced: 0, downloaded: 0 };

  let replaced = 0;
  let downloaded = 0;
  let skipped = 0;
  const errors = [];
  const total = CHANNEL_FILES.length;

  /* 目录先建 */
  for (const item of CHANNEL_FILES) {
    if (!item.dir) continue;
    try {
      await fsp.mkdir(path.join(dir, item.rel), { recursive: true });
    } catch (error) {
      errors.push(`${item.rel}: ${humanize(error, '创建目录失败')}`);
    }
  }

  let index = 0;
  for (const item of CHANNEL_FILES) {
    if (item.dir) continue;
    index += 1;
    if (signal && signal.cancelled) return { ok: false, cancelled: true, replaced, downloaded, errors };
    const target = path.join(dir, item.rel);
    onProgress({ phase: 'channel', processed: index, total, current: item.rel });

    /* 已存在且大小正确：没标记时核一次 md5，有标记直接信 */
    let ok = false;
    try {
      const st = await fsp.stat(target);
      if (st.size === item.size) {
        if (stamp && stamp.channel === code) ok = true;
        else ok = (await md5File(target)) === item.md5;
      }
    } catch {
      ok = false;
    }
    if (ok) {
      skipped += 1;
      continue;
    }

    /* 下载 → 校验 → 断链 → 原子落位 */
    try {
      const url = `${CDN_BASE}${prefix}${item.rel}`;
      onLog(`[azur] 补渠道文件 ${item.rel}（${Math.round(item.size / 1024)} KB）`);
      const buf = await downloadOne(url, item, signal);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.hxl-dl-${Date.now()}`;
      await fsp.writeFile(tmp, buf);
      try {
        await fsp.unlink(target);
      } catch {
        /* 不存在就算了 */
      }
      await fsp.rename(tmp, target);
      replaced += 1;
      downloaded += 1;
    } catch (error) {
      errors.push(`${item.rel}: ${humanize(error, '下载/写入失败')}`);
    }
  }

  /* B服 不带 taptap 渠道件；留着可能让 SDK 走错分支 */
  try {
    const tap = path.join(dir, 'AzurPromilia_Data', 'Plugins', 'mj_sdk', 'taptap_api.dll');
    if (fs.existsSync(tap)) {
      await fsp.unlink(tap);
      onLog('[azur] 已移除官服专用的 taptap_api.dll');
    }
  } catch {
    /* 删不掉不影响启动 */
  }

  if (!errors.length) {
    writeStamp(dir, { channel: code, at: new Date().toISOString(), total, replaced });
  }
  onLog(`[azur] 渠道文件自愈完成：替换 ${replaced} / 已就绪 ${skipped} / 失败 ${errors.length}`);
  return { ok: errors.length === 0, replaced, downloaded, skipped, errors, total };
}

module.exports = {
  CHANNEL_FILES,
  ensureChannelRuntime,
  MD5_HELPER: md5File,
};
