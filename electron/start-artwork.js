'use strict';

/**
 * 启动页动态背景的取用策略。
 *
 * 实测各家官方渠道能拿到的内容：
 *   - 原神（hk4e_cn / hk4e_global）：4 张静态宣传图，**没有视频**；
 *   - 星铁（hkrpg）：1 张图 + 1 个 webm 视频；
 *   - 绝区零（nap）：1 张图 + 1 个 webm 视频；
 *   - 终末地：官网首屏 mp4；
 *   - 异环：本机官方启动器的 bg.mp4。
 *
 * 所以「全都能动」的可行做法是：
 *   1. 有官方视频的直接用（星铁 / 绝区零 / 终末地 / 异环）；
 *   2. 原神没有官方视频，用官方的静态宣传图 + 极缓的镜头位移（Ken Burns）
 *     模拟动态，这样看起来也不呆板，而且不会像卡池图那样压着字。
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HOYO_BASIC_BASE = 'https://hyp-api.mihoyo.com/hyp/hyp-connect/api';
const HOYO_OS_BASE = 'https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api';
const CN_LAUNCHER = 'jGHBHlcOq1';
const OS_LAUNCHER = 'VYTpXlbWo8';

/** 游戏 key -> 官方 category。 */
const CATEGORY_BY_GAME = {
  genshin: ['hk4e_cn', 'hk4e_global'],
  starrail: ['hkrpg_cn', 'hkrpg_global'],
  zzz: ['nap_cn', 'nap_global'],
};

async function getJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * 取某款游戏官方的背景素材。
 * 返回 { videos: [{id,url,time}], images: [{id,url,time}] }，按时间倒序。
 */
async function officialBackgrounds(gameKey) {
  const categories = CATEGORY_BY_GAME[gameKey];
  if (!categories) return { videos: [], images: [] };

  for (const [base, launcher] of [
    [HOYO_BASIC_BASE, CN_LAUNCHER],
    [HOYO_OS_BASE, OS_LAUNCHER],
  ]) {
    try {
      const json = await getJson(`${base}/getAllGameBasicInfo?launcher_id=${launcher}&language=zh-cn`);
      const list = json.data?.game_info_list || [];
      for (const category of categories) {
        const game = list.find((item) => item.game?.biz === category);
        if (!game) continue;
        const backgrounds = game.backgrounds || [];
        const videos = [];
        const images = [];
        for (const item of backgrounds) {
          if (item.video?.url) {
            videos.push({ id: item.id, url: item.video.url, time: String(item.video.time || '') });
          }
          if (item.background?.url) {
            images.push({ id: item.id, url: item.background.url, time: String(item.background.time || '') });
          }
        }
        if (videos.length || images.length) {
          videos.sort((a, b) => String(b.time).localeCompare(String(a.time)));
          images.sort((a, b) => String(b.time).localeCompare(String(a.time)));
          return { videos, images };
        }
      }
    } catch {
      /* 换下一个渠道 */
    }
  }
  return { videos: [], images: [] };
}

module.exports = { officialBackgrounds, CATEGORY_BY_GAME };
