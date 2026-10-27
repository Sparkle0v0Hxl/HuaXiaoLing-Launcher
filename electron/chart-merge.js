'use strict';

/**
 * 三家榜单合并。
 *
 * 用户想在一个列表里看到 QQ 音乐、酷狗、网易云的榜单，
 * 重复的（同名榜）只留一条。
 *
 * 去重规则：
 *   1. 先按「归一化名称」去重：去掉空格、标点、括号里的补充说明；
 *   2. 同名时优先保留顺序靠前的来源（QQ → 酷狗 → 网易云）；
 *   3. 保留每个榜单的 sources 数组，界面上可以标注它来自哪些平台。
 */

const QQ = 'qq';
const KUGOU = 'kugou';
const NETEASE = 'netease';

const SOURCE_LABELS = {
  [QQ]: 'QQ音乐',
  [KUGOU]: '酷狗',
  [NETEASE]: '网易云',
};

/** 归一化榜单名：去掉括号补充、空格和标点，便于判重。 */
function normalizeChartName(name) {
  return String(name || '')
    .replace(/[（(【\[][^)）】\]]*[)）】\]]/g, '')
    .replace(/[\s·・\-—_、,，.。:：'"“”‘’!！?？]/g, '')
    .toLowerCase();
}

/**
 * 合并多个来源的榜单列表。
 * 入参：{ qq: [...], kugou: [...], netease: [...] }
 * 返回统一结构：[{ id, name, cover, updateKey, sources: ['qq','kugou'], sourceIds: { qq: '62' } }]
 */
function mergeChartsBySource(payload) {
  const order = [QQ, KUGOU, NETEASE];
  const merged = new Map();

  for (const source of order) {
    const list = Array.isArray(payload?.[source]) ? payload[source] : [];
    for (const chart of list) {
      if (!chart?.id || !chart?.name) continue;
      const key = normalizeChartName(chart.name);
      if (!key) continue;

      if (!merged.has(key)) {
        merged.set(key, {
          id: `${source}:${chart.id}`,
          name: String(chart.name),
          cover: chart.cover || '',
          updateKey: chart.updateKey || '',
          sources: [source],
          sourceIds: { [source]: String(chart.id) },
        });
        continue;
      }

      // 已存在：只补来源，不重复展示
      const existing = merged.get(key);
      if (!existing.sources.includes(source)) {
        existing.sources.push(source);
        existing.sourceIds[source] = String(chart.id);
      }
      if (!existing.cover && chart.cover) existing.cover = chart.cover;
      if (!existing.updateKey && chart.updateKey) existing.updateKey = chart.updateKey;
    }
  }

  return [...merged.values()];
}

/** 给界面用的来源标签，如 "QQ音乐 / 酷狗"。 */
function chartSourceLabel(chart) {
  return (chart?.sources || []).map((s) => SOURCE_LABELS[s] || s).join(' / ');
}

/**
 * 合并曲目并去重。
 * 同一个歌在不同榜里出现时，按「归一化歌名 + 歌手」判重。
 */
function normalizeSongKey(song) {
  const title = String(song?.title || '')
    .replace(/[（(【\[][^)）】\]]*[)）】\]]/g, '')
    .replace(/[\s·・\-—_、,，.。:：'"“”‘’!！?？]/g, '')
    .toLowerCase();
  const artist = String(song?.artist || '')
    .split(/[\/、,&]/)[0]
    .replace(/[\s·・\-—_]/g, '')
    .toLowerCase();
  return `${title}|${artist}`;
}

function mergeSongs(list) {
  const seen = new Set();
  const out = [];
  for (const song of list || []) {
    if (!song?.title) continue;
    const key = normalizeSongKey(song);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(song);
  }
  return out;
}

module.exports = {
  mergeChartsBySource,
  chartSourceLabel,
  normalizeChartName,
  normalizeSongKey,
  mergeSongs,
  SOURCE_LABELS,
};
