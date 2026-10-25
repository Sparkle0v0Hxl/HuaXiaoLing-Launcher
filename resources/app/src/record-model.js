'use strict';

/**
 * 战绩数据归一化 —— 把四个游戏十几个接口的返回，整理成渲染层能直接吃的形状。
 *
 * 为什么单独一个文件
 * ------------------
 * 1. 这些接口的字段全是米哈游内部命名（accepted_epedition_num 这种拼错的都有），
 *    散在 app.js 里会把 9000 行的渲染文件再撑大一截，并且没法单测；
 * 2. 它是纯函数：只吃 JSON、只吐数据结构，不碰 DOM、不碰 electron。
 *    所以可以直接 `node -e "require('./record-model.js')"` 拿构造样例跑回归；
 * 3. 字段缺失必须降级而不是抛错 —— 米哈游经常给老账号返回半截数据，
 *    一个字段没有就整页白屏是不可接受的。
 *
 * 输出形状（所有 parser 统一）
 * ---------------------------
 * {
 *   game, feature, title, gameName,
 *   headline: { label, value, note } | null,
 *   metrics: [{ key, label, value, unit, tone }],
 *   bars:    [{ key, label, value, max, note, tone }],
 *   sections:[{ key, title, hint, layout: 'rows'|'avatars', items: [Item] }],
 *   empty: '' | '说明文字',
 *   raw
 * }
 * Item = { key, title, subtitle, stars, starsMax, meta: [], avatars: [], tone }
 * Avatar = { name, icon, value, rarity, element }
 */

(function (global) {
  const GAME_LABEL = {
    genshin: '原神',
    starrail: '崩坏：星穹铁道',
    zzz: '绝区零',
    bh3: '崩坏3',
  };

  const FEATURE_LABEL = {
    'daily-note': '每日便笺',
    abyss: '深境螺旋',
    theater: '幻想真境剧诗',
    stygian: '幽境危战',
    'ultra-endless': '超弦空间',
    'battle-field': '记忆战场',
    'forgotten-hall': '忘却之庭',
    'pure-fiction': '虚构叙事',
    'apocalyptic-shadow': '末日幻影',
    'simulated-universe': '模拟宇宙',
    'shiyu-defense': '式舆防卫战',
    'deadly-assault': '危局强袭战',
  };

  /**
   * daily_task.task_rewards[].status 的枚举值。
   * 这个字段没有配套的可读名字，不翻译就会在页面上显示成
   * 「TaskRewardStatusUnfinished」这种原始枚举串（实测过一次）。
   */
  const TASK_REWARD_STATUS = {
    TaskRewardStatusTakenAward: '已领取',
    TaskRewardStatusFinished: '可领取',
    TaskRewardStatusUnfinished: '未完成',
    TaskRewardStatusInvalid: '',
  };

  /* ---------------------------------------------------------------- */
  /* 取值工具                                                          */
  /* ---------------------------------------------------------------- */

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback === undefined ? 0 : fallback;
  }

  function text(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  function dict(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  /** 米哈游的布尔字段有时是 'true'/'false' 字符串，有时是真布尔。 */
  function bool(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
  }

  /**
   * 绝区零的 buff 文本是官方富文本：
   *   · 代理人的<color=#FF5521>火属性伤害</color>提升15%\n· ...
   * 直接扔到页面上会看到一堆 <color=#FFFFFF> 和字面量 \n（实测截图上就是这样）。
   * 这里把标签剥掉、\n 换成空格、压掉多余空白。
   */
  function plain(value) {
    return text(value)
      .replace(/<color=[^>]*>/gi, '')
      .replace(/<\/color>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 截断长文本，留个省略号；短文本原样返回。 */
  function clip(value, limit) {
    const raw = text(value);
    const max = num(limit, 40) || 40;
    return raw.length > max ? `${raw.slice(0, max)}…` : raw;
  }

  /** 秒数 → 「2天3小时」「1小时20分」；0 或负数返回空串（调用方自己决定显示什么）。 */
  function fmtSeconds(seconds) {
    let s = Math.floor(num(seconds));
    if (!(s > 0)) return '';
    const day = Math.floor(s / 86400);
    s -= day * 86400;
    const hour = Math.floor(s / 3600);
    s -= hour * 3600;
    const minute = Math.floor(s / 60);
    const parts = [];
    if (day) parts.push(`${day}天`);
    if (hour) parts.push(`${hour}小时`);
    if (minute && !day) parts.push(`${minute}分`);
    return parts.join('') || '不到1分钟';
  }

  /** 秒级时间戳 → 「10-25 18:00」；毫秒级的也认。 */
  /**
   * 时间格式化。三种形态都要吃：
   *   - 秒/毫秒时间戳（原神、崩3 用这种字符串）
   *   - 米哈游的 {year,month,day,hour,minute} 对象（星铁的战绩接口全用这种）
   *   - "0" / "" / null（没结算、没开放，一律返回空串让调用方显示「—」）
   */
  function fmtTime(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = dict(value);
      const year = num(obj.year);
      if (!year) return '';
      const pad = (n) => String(n).padStart(2, '0');
      const now = new Date();
      const date = `${pad(num(obj.month) || 1)}-${pad(num(obj.day) || 1)}`;
      return `${year === now.getFullYear() ? date : `${year}-${date}`} ${pad(num(obj.hour))}:${pad(num(obj.minute))}`;
    }
    const raw = num(value);
    if (!raw) return '';
    const ms = raw > 1e12 ? raw : raw * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${sameYear ? date : `${d.getFullYear()}-${date}`} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 剩余时间：优先用现成的秒数字段，其次用结束时间戳算。 */
  function remainText(seconds, endTs) {
    const bySeconds = fmtSeconds(seconds);
    if (bySeconds) return bySeconds;
    const end = num(endTs);
    if (!end) return '';
    const endMs = end > 1e12 ? end : end * 1000;
    return fmtSeconds(Math.floor((endMs - Date.now()) / 1000));
  }

  function avatarFrom(raw) {
    const item = dict(raw);
    const name = text(item.name || item.nickname || item.avatar_name);
    const icon = text(item.image || item.icon || item.avatar_icon || item.side_icon || item.avatar_side_icon);
    return {
      name,
      icon,
      value: text(item.value || item.dps || item.level),
      rarity: num(item.rarity, 0) || null,
      element: text(item.element),
    };
  }

  /** 排行的 value 经常是「伤害数字」，给个千分位，别让 12345678 糊满一行。 */
  function fmtValue(value) {
    const raw = text(value);
    if (!raw) return '';
    if (!/^\d+$/.test(raw)) return raw;
    return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * 绝区零的 rank_percent 是「以 0.01% 为单位」的整数：
   * 3720 表示前 37.20%，不是前 3720%。
   * Starward 的 RankPercentText 就是这么除的（ShiyuDefensePage.xaml.cs:189），
   * 直接按整数显示会写成「前 3720%」这种离谱数字。
   */
  function rankText(value) {
    const n = num(value);
    if (!(n > 0)) return '';
    const whole = Math.floor(n / 100);
    const rest = String(n % 100).padStart(2, '0');
    return `${whole}.${rest}%`;
  }

  function rankAvatars(rows, valueLabel) {
    return list(rows).slice(0, 8).map((row) => {
      const item = dict(row);
      return {
        name: text(item.avatar_name || item.name),
        icon: text(item.avatar_icon || item.icon),
        value: fmtValue(item.value),
        rarity: num(item.rarity, 0) || null,
        element: '',
        label: valueLabel,
      };
    });
  }

  function emptyResult(game, feature, message) {
    return {
      game,
      feature,
      gameName: GAME_LABEL[game] || game,
      title: FEATURE_LABEL[feature] || feature,
      headline: null,
      metrics: [],
      bars: [],
      sections: [],
      empty: message || '这个账号还没有这项战绩数据。',
      raw: null,
    };
  }

  /**
   * groups[] 里找「当前这期」的元信息（期数名、起止时间、BOSS 名单）。
   *
   * 踩过的坑：星铁挑战类接口顶层**没有 schedule_id**（实测 pure-fiction /
   * apocalyptic-shadow 都没有），只有 max_floor_id（如 20274 / 20264），
   * 而 groups[].schedule_id 是四位（2027 / 2026）。
   * 所以按 max_floor_id 去掉最后一位去匹配，20274 → 2027 命中当期、
   * 20264 → 2026 命中上期；不这么换算的话请求「上期」会显示成当期的期数名。
   */
  function groupForSchedule(d) {
    const data = dict(d);
    const groups = list(data.groups);
    const id = num(data.schedule_id);
    if (id) {
      const exact = groups.find((row) => num(dict(row).schedule_id) === id);
      if (exact) return exact;
    }
    const floorId = num(data.max_floor_id);
    if (floorId) {
      const guess = floorId >= 1000 ? Math.floor(floorId / 10) : floorId;
      const hit = groups.find((row) => num(dict(row).schedule_id) === guess);
      if (hit) return hit;
      const direct = groups.find((row) => num(dict(row).schedule_id) === floorId);
      if (direct) return direct;
    }
    return groups[0] || {};
  }

  function baseResult(game, feature) {
    return {
      game,
      feature,
      gameName: GAME_LABEL[game] || game,
      title: FEATURE_LABEL[feature] || feature,
      headline: null,
      metrics: [],
      bars: [],
      sections: [],
      empty: '',
      raw: null,
    };
  }

  /* ---------------------------------------------------------------- */
  /* 一、每日便笺（四个游戏各一套字段）                                  */
  /* ---------------------------------------------------------------- */

  function parseGenshinNote(data) {
    const d = dict(data);
    const view = baseResult('genshin', 'daily-note');
    view.raw = d;

    const resin = num(d.current_resin);
    const resinMax = num(d.max_resin, 160);
    const resinBack = remainText(d.resin_recovery_time);
    view.headline = {
      label: '原粹树脂',
      value: `${resin}/${resinMax}`,
      note: resinBack ? `${resinBack}后回满` : resin >= resinMax ? '已回满' : '',
    };
    view.bars.push({
      key: 'resin',
      label: '原粹树脂',
      value: resin,
      max: resinMax,
      note: resinBack ? `回满还需 ${resinBack}` : '',
      tone: resin >= resinMax ? 'warn' : '',
    });

    view.metrics.push(
      {
        key: 'task',
        label: '每日委托',
        value: `${num(d.finished_task_num)}/${num(d.total_task_num, 4)}`,
        unit: '',
        tone: bool(d.is_extra_task_reward_received) ? 'ok' : '',
      },
      {
        key: 'dispatch',
        label: '探索派遣',
        value: `${num(d.current_expedition_num)}/${num(d.max_expedition_num, 5)}`,
      },
      {
        key: 'home-coin',
        label: '洞天宝钱',
        value: `${num(d.current_home_coin)}/${num(d.max_home_coin)}`,
        note: remainText(d.home_coin_recovery_time),
      },
      {
        key: 'discount',
        label: '本周树脂折扣',
        value: `${num(d.remain_resin_discount_num)}/${num(d.resin_discount_num_limit, 3)}`,
      }
    );

    const quest = dict(d.archon_quest_progress);
    if (Object.keys(quest).length) {
      view.metrics.push({
        key: 'archon',
        label: '魔神任务',
        value: bool(quest.is_finish_all_mainline) ? '全部完成' : '进行中',
        tone: bool(quest.is_finish_all_mainline) ? 'ok' : '',
      });
    }

    const transformer = dict(d.transformer);
    if (Object.keys(transformer).length) {
      const recovery = dict(transformer.recovery_time);
      const ready = bool(recovery.Reached) || bool(transformer.obtained) === false ? '' : '';
      view.metrics.push({
        key: 'transformer',
        label: '参量质变仪',
        value: bool(recovery.Reached) ? '可用' : recovery.Day ? `${num(recovery.Day)}天后` : '冷却中',
        tone: ready || bool(recovery.Reached) ? 'ok' : '',
      });
    }

    const expeditions = list(d.expeditions);
    if (expeditions.length) {
      view.sections.push({
        key: 'expeditions',
        title: '探索派遣',
        hint: `${expeditions.length} 支队伍`,
        layout: 'avatars',
        items: expeditions.map((row, index) => {
          const item = dict(row);
          const finished = text(item.status) === 'Finished';
          return {
            key: `exp-${index}`,
            title: finished ? '已完成' : `${remainText(item.remained_time)}后完成`,
            subtitle: '',
            stars: null,
            starsMax: null,
            meta: [],
            tone: finished ? 'ok' : '',
            avatars: [{ name: '', icon: text(item.avatar_side_icon), value: '', rarity: null, element: '' }],
          };
        }),
      });
    }

    const task = dict(d.daily_task);
    if (Object.keys(task).length) {
      const finished = num(task.finished_num);
      const total = num(task.total_num);
      view.sections.push({
        key: 'daily-task',
        title: '每日委托奖励',
        hint:
          finished !== null && total !== null
            ? `${finished}/${total} 已完成${bool(task.is_extra_task_reward_received) ? ' · 额外奖励已领' : ''}`
            : bool(task.is_extra_task_reward_received)
              ? '额外奖励已领'
              : '',
        layout: 'rows',
        items: list(task.task_rewards).map((row, index) => {
          const item = dict(row);
          /*
           * task_rewards 里只有 status 枚举、没有可读名字，直接显示原文
           * 会得到一串 TaskRewardStatusUnfinished —— 这里翻译成人话。
           */
          const status = text(item.status);
          const label = TASK_REWARD_STATUS[status] ?? '';
          const done = status === 'TaskRewardStatusTakenAward' || status === 'TaskRewardStatusFinished';
          return {
            key: `task-${index}`,
            title: `奖励 ${index + 1}`,
            subtitle: label,
            stars: null,
            starsMax: null,
            meta: [],
            tone: done ? 'ok' : '',
            avatars: [],
          };
        }),
      });
    }

    return view;
  }

  function parseStarrailNote(data) {
    const d = dict(data);
    const view = baseResult('starrail', 'daily-note');
    view.raw = d;

    const stamina = num(d.current_stamina);
    const staminaMax = num(d.max_stamina, 240);
    const staminaBack = remainText(d.stamina_recover_time);
    view.headline = {
      label: '开拓力',
      value: `${stamina}/${staminaMax}`,
      note: staminaBack ? `${staminaBack}后回满` : stamina >= staminaMax ? '已回满' : '',
    };
    view.bars.push({
      key: 'stamina',
      label: '开拓力',
      value: stamina,
      max: staminaMax,
      note: staminaBack ? `回满还需 ${staminaBack}` : '',
      tone: stamina >= staminaMax ? 'warn' : '',
    });

    view.metrics.push(
      {
        key: 'reserve',
        label: '后备开拓力',
        value: `${num(d.current_reserve_stamina)}/2400`,
        tone: bool(d.is_reserve_stamina_full) ? 'warn' : '',
      },
      {
        key: 'weekly',
        label: '历战余响',
        value: `${num(d.weekly_cocoon_cnt)}/${num(d.weekly_cocoon_limit, 3)}`,
      },
      {
        key: 'rogue',
        label: '模拟宇宙积分',
        value: `${num(d.current_rogue_score)}/${num(d.max_rogue_score)}`,
      },
      {
        key: 'train',
        label: '开拓等级经验',
        value: `${num(d.current_train_score)}/${num(d.max_train_score)}`,
      }
    );

    // 每周任务类字段在不同版本叫法不一样，有就显示
    const tournCur = num(d.rogue_tourn_weekly_cur);
    const tournMax = num(d.rogue_tourn_weekly_max);
    if (tournMax) {
      view.metrics.push({ key: 'tourn', label: '差分宇宙周常', value: `${tournCur}/${tournMax}` });
    }
    const gridMax = num(d.grid_fight_weekly_max);
    if (gridMax) {
      view.metrics.push({ key: 'grid', label: '虚构叙事周常', value: `${num(d.grid_fight_weekly_cur)}/${gridMax}` });
    }

    const expeditions = list(d.expeditions);
    if (expeditions.length) {
      view.sections.push({
        key: 'expeditions',
        title: '派遣委托',
        hint: `${num(d.accepted_epedition_num) || expeditions.length}/${num(d.total_expedition_num) || expeditions.length}`,
        layout: 'avatars',
        items: expeditions.map((row, index) => {
          const item = dict(row);
          const finished = text(item.status) === 'Finished';
          return {
            key: `exp-${index}`,
            title: text(item.name) || (finished ? '已完成' : '进行中'),
            subtitle: finished ? '已完成' : `${remainText(item.remaining_time, item.finish_ts)}后完成`,
            stars: null,
            starsMax: null,
            meta: [],
            tone: finished ? 'ok' : '',
            avatars: list(item.avatars).map(avatarFrom),
          };
        }),
      });
    }

    return view;
  }

  function parseZzzNote(data) {
    const d = dict(data);
    const view = baseResult('zzz', 'daily-note');
    view.raw = d;

    const energy = dict(d.energy);
    const energyProgress = dict(energy.progress);
    const current = num(energyProgress.current, num(energy.current));
    const max = num(energyProgress.max, num(energy.max, 240));
    const back = remainText(energy.restore);
    view.headline = {
      label: '电量',
      value: `${current}/${max}`,
      note: back ? `${back}后回满` : current >= max ? '已回满' : '',
    };
    view.bars.push({
      key: 'energy',
      label: '电量',
      value: current,
      max,
      note: back ? `回满还需 ${back}` : '',
      tone: current >= max ? 'warn' : '',
    });

    const vitality = dict(d.vitality);
    if (Object.keys(vitality).length) {
      view.metrics.push({
        key: 'vitality',
        label: '体力',
        value: `${num(vitality.current)}/${num(vitality.max)}`,
      });
    }

    const weekly = dict(d.weekly_task);
    if (Object.keys(weekly).length) {
      view.metrics.push({
        key: 'weekly',
        label: '周常任务',
        value: `${num(weekly.cur_point)}/${num(weekly.max_point)}`,
        note: remainText(weekly.refresh_time),
      });
    }

    const bounty = dict(d.bounty_commission);
    if (Object.keys(bounty).length) {
      view.metrics.push({
        key: 'bounty',
        label: '悬赏委托',
        value: `${num(bounty.num)}/${num(bounty.total)}`,
        note: remainText(bounty.refresh_time),
      });
    }

    if (d.card_sign) {
      view.metrics.push({ key: 'card', label: '刮刮卡', value: text(d.card_sign) });
    }

    const vhs = dict(d.vhs_sale);
    if (vhs.sale_state) {
      view.metrics.push({ key: 'vhs', label: '录像店', value: text(vhs.sale_state) });
    }

    const member = dict(d.member_card);
    if (Object.keys(member).length) {
      view.metrics.push({
        key: 'member',
        label: '会员卡',
        value: bool(member.is_open) ? '已开通' : '未开通',
        note: bool(member.is_open) ? remainText(0, member.exp_time) : '',
      });
    }

    if (remainText(d.abyss_refresh)) {
      view.metrics.push({ key: 'abyss', label: '式舆刷新', value: remainText(d.abyss_refresh) });
    }

    return view;
  }

  function parseBh3Note(data) {
    const d = dict(data);
    const view = baseResult('bh3', 'daily-note');
    view.raw = d;

    const stamina = num(d.current_stamina);
    const staminaMax = num(d.max_stamina, 180);
    const back = remainText(d.stamina_recover_time);
    view.headline = {
      label: '体力',
      value: `${stamina}/${staminaMax}`,
      note: back ? `${back}后回满` : stamina >= staminaMax ? '已回满' : '',
    };
    view.bars.push({
      key: 'stamina',
      label: '体力',
      value: stamina,
      max: staminaMax,
      note: back ? `回满还需 ${back}` : '',
      tone: stamina >= staminaMax ? 'warn' : '',
    });

    view.metrics.push({
      key: 'train',
      label: '训练点数',
      value: `${num(d.current_train_score)}/${num(d.max_train_score)}`,
    });

    // 三个周期玩法顺手给一行总览，点进各自卡片能看到细节
    const cycles = [
      { key: 'ultra_endless', label: '超弦空间' },
      { key: 'battle_field', label: '记忆战场' },
      { key: 'greedy_endless', label: '往世乐土' },
      { key: 'god_war', label: '神之键' },
    ];
    for (const { key, label } of cycles) {
      const item = dict(d[key]);
      if (!Object.keys(item).length) continue;
      view.metrics.push({
        key,
        label,
        value: bool(item.is_open) ? '开放中' : '未开放',
        note: bool(item.is_open) ? remainText(0, item.schedule_end) : '',
        tone: bool(item.is_open) ? 'ok' : '',
      });
    }

    return view;
  }

  function parseNote(game, data) {
    if (game === 'genshin') return parseGenshinNote(data);
    if (game === 'starrail') return parseStarrailNote(data);
    if (game === 'zzz') return parseZzzNote(data);
    if (game === 'bh3') return parseBh3Note(data);
    return emptyResult(game, 'daily-note', '这个游戏的便笺还没接入。');
  }

  /* ---------------------------------------------------------------- */
  /* 二、原神 · 深境螺旋                                                */
  /* ---------------------------------------------------------------- */

  function parseGenshinAbyss(data) {
    const d = dict(data);
    const view = baseResult('genshin', 'abyss');
    view.raw = d;

    const floors = list(d.floors);
    /* max_floor 是 "12-3" 这种字符串，不是数字 —— 用 num() 会得到 0。 */
    const maxFloor = text(d.max_floor);
    const totalStar = num(d.total_star, floors.reduce((sum, row) => sum + num(dict(row).star), 0));
    const floorStarMax = floors.reduce((sum, row) => sum + num(dict(row).max_star), 0);

    if (!floors.length && !maxFloor) {
      return { ...view, empty: '本期还没有深境螺旋记录，可能是还没打或者数据未同步。' };
    }

    view.headline = {
      label: '本期星数',
      value: `${totalStar}${floorStarMax && totalStar <= floorStarMax ? `/${floorStarMax}` : ''}`,
      note: maxFloor ? `最深 ${maxFloor}` : '',
    };

    view.metrics.push(
      { key: 'battles', label: '战斗次数', value: String(num(d.total_battle_times)) },
      { key: 'wins', label: '获胜次数', value: String(num(d.total_win_times)) },
      { key: 'floor', label: '最深楼层', value: maxFloor || '—' },
      /*
       * 这两个接口的顶层没有 end_time（实测 pure-fiction / apocalyptic-shadow 的返回里都没有），
       * 期数的时间在 groups[] 里，所以按 schedule_id 找到当期再取。
       */
      {
        key: 'period',
        label: '结束时间',
        value: fmtTime(d.end_time) || fmtTime(dict(groupForSchedule(d)).end_time) || '—',
      }
    );

    if (floors.length) {
      view.sections.push({
        key: 'floors',
        title: '楼层进度',
        hint: `共 ${floors.length} 层`,
        layout: 'rows',
        items: floors.map((row, index) => {
          const item = dict(row);
          const star = num(item.star);
          const starMax = num(item.max_star, 3);
          const unlocked = bool(item.is_unlock);
          /* settle_time 没结算时是 "0" —— 字符串形式 truthy，必须交给 fmtTime 判断。 */
          const settle = fmtTime(item.settle_time);
          return {
            key: `floor-${num(item.index, index)}`,
            title: `第 ${num(item.index, index + 1)} 层`,
            subtitle: unlocked ? (settle ? `结算 ${settle}` : '') : '未解锁',
            stars: star,
            starsMax: starMax,
            meta: list(item.ley_line_disorder).length ? [`地脉异常 ${list(item.ley_line_disorder).length} 条`] : [],
            tone: !unlocked ? 'muted' : star >= starMax ? 'ok' : '',
            avatars: [],
          };
        }),
      });
    }

    const ranks = [
      { key: 'reveal', label: '出场最多', rows: d.reveal_rank },
      { key: 'defeat', label: '击败最多', rows: d.defeat_rank },
      { key: 'damage', label: '伤害最高', rows: d.damage_rank },
      { key: 'take', label: '承受伤害', rows: d.take_damage_rank },
    ];
    for (const { key, label, rows } of ranks) {
      const avatars = rankAvatars(rows, label);
      if (!avatars.length) continue;
      view.sections.push({
        key,
        title: `角色排行 · ${label}`,
        hint: '',
        layout: 'avatars',
        items: [
          {
            key,
            title: label,
            subtitle: '',
            stars: null,
            starsMax: null,
            meta: [],
            tone: '',
            avatars,
          },
        ],
      });
    }

    return view;
  }

  /* ---------------------------------------------------------------- */
  /* 三、原神 · 幻想真境剧诗 / 幽境危战（这两个是 wrapper）              */
  /* ---------------------------------------------------------------- */

  /** 这两个接口返回 { data: [Info], is_unlock }，取第一个 Info。 */
  function unwrapWrapper(data) {
    const d = dict(data);
    if (Array.isArray(d.data)) return arrayFirst(d.data);
    return d;
  }

  function arrayFirst(value) {
    return Array.isArray(value) && value.length ? value[0] : null;
  }

  function parseGenshinTheater(data) {
    const wrapper = dict(data);
    const info = unwrapWrapper(wrapper);
    const view = baseResult('genshin', 'theater');
    view.raw = dict(data);

    if (!info || !Object.keys(dict(info)).length) {
      const locked = wrapper.is_unlock !== undefined && !bool(wrapper.is_unlock);
      return {
        ...view,
        empty: locked ? '这个账号还没解锁幻想真境剧诗。' : '本期还没有幻想真境剧诗记录。',
      };
    }

    const d = dict(info);
    const stat = dict(d.stat);
    const schedule = dict(d.schedule);
    const rounds = list(dict(d.detail).rounds_data);
    const medal = num(d.medal_num, num(stat.medal_num));

    view.headline = {
      label: '获得徽章',
      value: String(medal),
      note: d.difficulty_id ? `难度 ${num(d.difficulty_id)}` : '',
    };

    view.metrics.push(
      { key: 'round', label: '最高轮次', value: String(num(d.max_round_id, num(stat.max_round_id)) || '—') },
      { key: 'coin', label: '获得幻剧之花', value: String(num(stat.coin_num)) },
      { key: 'bonus', label: '加成角色', value: String(num(stat.avatar_bonus_num)) },
      { key: 'tarot', label: '塔罗牌完成', value: String(num(stat.tarot_finished_cnt)) }
    );

    if (schedule.start_time || schedule.end_time) {
      view.metrics.push({
        key: 'period',
        label: '本期期间',
        value: `${fmtTime(schedule.start_time) || '?'} ~ ${fmtTime(schedule.end_time) || '?'}`,
      });
    }

    if (rounds.length) {
      view.sections.push({
        key: 'rounds',
        title: '轮次详情',
        hint: `共 ${rounds.length} 轮`,
        layout: 'rows',
        items: rounds.map((row, index) => {
          const item = dict(row);
          const buffs = list(item.buffs).map((buff) => text(dict(buff).name)).filter(Boolean);
          return {
            key: `round-${num(item.round_id, index)}`,
            title: `第 ${num(item.round_id, index + 1)} 轮`,
            subtitle: list(item.choice_cards).map((card) => text(dict(card).name)).filter(Boolean).join(' / '),
            stars: null,
            starsMax: null,
            meta: [
              bool(item.is_get_medal) ? '已获徽章' : '未获徽章',
              bool(item.is_tarot) ? '塔罗牌' : '',
              ...buffs.slice(0, 3),
            ].filter(Boolean),
            tone: bool(item.is_get_medal) ? 'ok' : '',
            avatars: list(item.avatars).map(avatarFrom),
          };
        }),
      });
    }

    const backup = list(dict(d.detail).backup_avatars).map(avatarFrom);
    if (backup.length) {
      view.sections.push({
        key: 'backup',
        title: '备用角色',
        hint: `${backup.length} 位`,
        layout: 'avatars',
        items: [{ key: 'backup', title: '备用角色', subtitle: '', stars: null, starsMax: null, meta: [], tone: '', avatars: backup }],
      });
    }

    return view;
  }

  function parseGenshinStygian(data) {
    const wrapper = dict(data);
    const info = unwrapWrapper(wrapper);
    const view = baseResult('genshin', 'stygian');
    view.raw = dict(data);

    if (!info || !Object.keys(dict(info)).length) {
      const locked = wrapper.is_unlock !== undefined && !bool(wrapper.is_unlock);
      return {
        ...view,
        empty: locked ? '这个账号还没解锁幽境危战。' : '本期还没有幽境危战记录。',
      };
    }

    const d = dict(info);
    const schedule = dict(d.schedule);
    const single = dict(d.single);
    const multi = dict(d.mp);

    /**
     * single / mp 的结构一样：{ best, challenge[], has_data }。
     * best.second 是最快通关秒数，challenge 是每个讨伐目标的成绩。
     */
    const bestSeconds = (side) => {
      const best = dict(dict(side).best);
      const sec = num(best.second);
      return sec ? `${sec} 秒` : '';
    };

    const bestSingle = bestSeconds(single);
    const bestMulti = bestSeconds(multi);
    view.headline = {
      label: '最快通关',
      value: bestSingle || bestMulti || '—',
      note: bestSingle ? '单人挑战' : bestMulti ? '多人挑战' : '',
    };

    view.metrics.push(
      { key: 'single', label: '单人最快', value: bestSingle || '—' },
      { key: 'multi', label: '多人最快', value: bestMulti || '—' },
      { key: 'bling', label: '闪光角色', value: String(list(d.blings).length) },
      { key: 'period', label: '结束时间', value: fmtTime(schedule.end_time) || '—' }
    );

    const buildTargets = (side, sideLabel) => {
      const rows = list(dict(side).challenge);
      if (!rows.length) return null;
      return {
        key: `targets-${sideLabel}`,
        title: `${sideLabel} · 讨伐目标`,
        hint: `${rows.length} 个目标`,
        layout: 'rows',
        items: rows.map((row, index) => {
          const item = dict(row);
          const monster = dict(item.monster);
          const seconds = num(item.second);
          const best = list(item.best_avatar).map((avatar) => {
            const av = dict(avatar);
            return {
              name: text(av.avatar_id),
              icon: text(av.side_icon),
              value: av.dps ? fmtValue(av.dps) : '',
              rarity: null,
              element: '',
            };
          });
          return {
            key: `target-${sideLabel}-${index}`,
            title: text(item.name) || text(monster.name) || `目标 ${index + 1}`,
            subtitle: seconds ? `${seconds} 秒` : '',
            stars: null,
            starsMax: null,
            meta: [text(monster.name), text(monster.level) ? `Lv.${text(monster.level)}` : ''].filter(Boolean),
            tone: seconds ? 'ok' : '',
            avatars: list(item.teams).map(avatarFrom).concat(best.slice(0, 2)),
          };
        }),
      };
    };

    const singleSection = buildTargets(single, '单人');
    if (singleSection) view.sections.push(singleSection);
    const multiSection = buildTargets(multi, '多人');
    if (multiSection) view.sections.push(multiSection);

    const blings = list(d.blings).map(avatarFrom);
    if (blings.length) {
      view.sections.push({
        key: 'blings',
        title: '闪光角色',
        hint: `${blings.length} 位`,
        layout: 'avatars',
        items: [{ key: 'blings', title: '闪光角色', subtitle: '', stars: null, starsMax: null, meta: [], tone: '', avatars: blings }],
      });
    }

    return view;
  }

  /* ---------------------------------------------------------------- */
  /* 四、崩坏3 · 超弦空间 / 记忆战场（数据都在便笺里）                    */
  /* ---------------------------------------------------------------- */

  function parseBh3Cycle(data, feature) {
    const d = dict(data);
    const view = baseResult('bh3', feature);
    view.raw = d;

    const cycleKey = feature === 'ultra-endless' ? 'ultra_endless' : 'battle_field';
    const cycle = dict(d[cycleKey]);
    if (!Object.keys(cycle).length) {
      /*
       * 这两个模式共用 note 这一个端点，某一期没打时对应的子对象直接是 null
       * （实测 battle_field 就是 null），不是缺字段。
       */
      return { ...view, empty: `${FEATURE_LABEL[feature] || '这个模式'}本赛季还没有成绩。` };
    }

    const open = bool(cycle.is_open);
    const remain = remainText(0, cycle.schedule_end);

    if (feature === 'ultra-endless') {
      const score = num(cycle.challenge_score);
      const group = num(cycle.group_level);
      /*
       * 没打的时候 challenge_score / group_level 都是 0，把「挑战积分 0」
       * 摆在最显眼的位置像是出错了 —— 这种时候改成显示开放状态。
       */
      view.headline =
        score > 0 || group > 0
          ? { label: '挑战积分', value: String(score), note: remain ? `本期剩余 ${remain}` : '' }
          : { label: '本期状态', value: open ? '开放中' : '未开放', note: remain ? `剩余 ${remain}` : '这期还没打' };
      view.metrics.push(
        { key: 'group', label: '分组等级', value: group > 0 ? String(group) : '—' },
        { key: 'score', label: '挑战积分', value: score > 0 ? String(score) : '—' },
        { key: 'open', label: '状态', value: open ? '开放中' : '未开放', tone: open ? 'ok' : 'muted' },
        { key: 'remain', label: '剩余时间', value: remain || '—' }
      );
    } else {
      const cur = num(cycle.cur_reward);
      const max = num(cycle.max_reward);
      view.headline = {
        label: '本期奖励',
        value: max ? `${cur}/${max}` : String(cur),
        note: remain ? `本期剩余 ${remain}` : '',
      };
      if (max) {
        view.bars.push({
          key: 'reward',
          label: '本期奖励进度',
          value: cur,
          max,
          note: '',
          tone: cur >= max ? 'ok' : '',
        });
      }
      view.metrics.push(
        { key: 'reward', label: '本期奖励', value: max ? `${cur}/${max}` : String(cur) },
        {
          key: 'sss',
          label: 'SSS 奖励',
          value: num(cycle.max_sss_reward) ? `${num(cycle.cur_sss_reward)}/${num(cycle.max_sss_reward)}` : '—',
        },
        { key: 'open', label: '状态', value: open ? '开放中' : '未开放', tone: open ? 'ok' : 'muted' },
        { key: 'remain', label: '剩余时间', value: remain || '—' }
      );
    }

    return view;
  }

  /* ---------------------------------------------------------------- */
  /* 五、星铁 · 忘却之庭                                                */
  /* ---------------------------------------------------------------- */

  function parseStarrailChallenge(data) {
    const d = dict(data);
    const view = baseResult('starrail', 'forgotten-hall');
    view.raw = d;

    const floors = list(d.all_floor_detail);
    const star = num(d.star_num);
    const extra = num(d.extra_star_num);
    /* 星铁的 max_floor 是楼层名（"来生泅渡其十二"），不是层数。 */
    const maxFloor = text(d.max_floor);

    if (!bool(d.has_data) && !floors.length) {
      return { ...view, empty: '本期还没有忘却之庭记录。' };
    }

    view.headline = {
      label: '本期星数',
      value: String(star + extra),
      note: maxFloor ? `最高 ${maxFloor}` : '',
    };

    const currentGroup = groupForSchedule(d);

    view.metrics.push(
      { key: 'star', label: '星数', value: String(star) },
      { key: 'extra', label: '额外星数', value: String(extra) },
      { key: 'floor', label: '最高层数', value: maxFloor || '—' },
      { key: 'battles', label: '战斗次数', value: String(num(d.battle_num)) },
      /*
       * 这两个接口的顶层没有 end_time（实测 pure-fiction / apocalyptic-shadow 的返回里都没有），
       * 期数的时间在 groups[] 里，所以按 schedule_id 找到当期再取。
       */
      {
        key: 'period',
        label: '结束时间',
        value: fmtTime(d.end_time) || fmtTime(dict(groupForSchedule(d)).end_time) || '—',
      }
    );
    if (currentGroup) {
      view.metrics.push({
        key: 'group',
        label: '期数',
        value: text(dict(currentGroup).name_mi18n) || `#${num(dict(currentGroup).schedule_id)}`,
      });
    }

    if (floors.length) {
      view.sections.push({
        key: 'floors',
        title: '全层详情',
        hint: `${floors.length} 层`,
        layout: 'rows',
        items: floors.map((row, index) => {
          const item = dict(row);
          const nodes = ['node_1', 'node_2', 'node_3'].map((key) => dict(item[key])).filter((node) => Object.keys(node).length);
          const avatars = nodes.flatMap((node) => list(node.avatars).map(avatarFrom));
          return {
            key: `floor-${index}`,
            title: text(item.name) || `第 ${index + 1} 层`,
            subtitle: nodes.length
              ? `${nodes.length} 节点${num(item.round_num) ? ` · ${num(item.round_num)} 轮` : ''}`
              : '',
            stars: num(item.star_num),
            starsMax: nodes.length ? nodes.length * 3 : 3,
            meta: [
              text(item.maze_id) ? `式舆 #${text(item.maze_id)}` : '',
              bool(item.is_chaos) ? '混沌回忆' : '',
              ...nodes.map((node) => fmtTime(node.challenge_time)).filter(Boolean).slice(0, 1),
            ].filter(Boolean),
            tone: '',
            avatars,
          };
        }),
      });
    }

    return view;
  }

  /* ---------------------------------------------------------------- */
  /* 六、星铁 · 虚构叙事                                                */
  /* ---------------------------------------------------------------- */

  /**
   * challenge_story 的返回和忘却之庭几乎是同一个壳子：
   * 同样的 all_floor_detail / groups / max_floor，只是每个 node 多带一档
   * buff 和本节点得分，楼层还多一个 is_fast（快速通关）。
   * 所以单独写而不是复用，是因为要展示的「看点」不同：虚构叙事的重点是
   * 每层的得分和那档 buff，忘却之庭没有分。
   */
  function parseStarrailPureFiction(data) {
    const d = dict(data);
    const view = baseResult('starrail', 'pure-fiction');
    view.raw = d;

    const floors = list(d.all_floor_detail);
    const star = num(d.star_num);
    const extra = num(d.extra_star_num);
    const maxFloor = text(d.max_floor);

    if (!bool(d.has_data) && !floors.length) {
      return { ...view, empty: '本期还没有虚构叙事记录。' };
    }

    const totalScore = floors.reduce((sum, row) => {
      const nodes = ['node_1', 'node_2', 'node_3'].map((key) => dict(dict(row)[key]));
      return sum + nodes.reduce((acc, node) => acc + num(node.score), 0);
    }, 0);

    view.headline = {
      label: '本期星数',
      value: String(star + extra),
      note: totalScore ? `总得分 ${fmtValue(totalScore)}` : maxFloor ? `最高 ${maxFloor}` : '',
    };

    view.metrics.push(
      { key: 'star', label: '星数', value: String(star) },
      { key: 'extra', label: '额外星数', value: String(extra) },
      { key: 'floor', label: '最高层数', value: maxFloor || '—' },
      { key: 'score', label: '总得分', value: totalScore ? fmtValue(totalScore) : '—' },
      { key: 'battles', label: '战斗次数', value: String(num(d.battle_num)) },
      /*
       * 这两个接口的顶层没有 end_time（实测 pure-fiction / apocalyptic-shadow 的返回里都没有），
       * 期数的时间在 groups[] 里，所以按 schedule_id 找到当期再取。
       */
      {
        key: 'period',
        label: '结束时间',
        value: fmtTime(d.end_time) || fmtTime(dict(groupForSchedule(d)).end_time) || '—',
      }
    );

    const currentGroup = groupForSchedule(d);
    if (currentGroup) {
      view.metrics.push({
        key: 'group',
        label: '期数',
        value: text(dict(currentGroup).name_mi18n) || `#${num(dict(currentGroup).schedule_id)}`,
      });
    }

    if (floors.length) {
      view.sections.push({
        key: 'floors',
        title: '全层详情',
        hint: `${floors.length} 层`,
        layout: 'rows',
        items: floors.map((row, index) => {
          const item = dict(row);
          const nodes = ['node_1', 'node_2', 'node_3']
            .map((key) => dict(item[key]))
            .filter((node) => Object.keys(node).length);
          const avatars = nodes.flatMap((node) => list(node.avatars).map(avatarFrom));
          const buffs = nodes.map((node) => text(dict(node.buff).name_mi18n)).filter(Boolean);
          const score = nodes.reduce((sum, node) => sum + num(node.score), 0);
          return {
            key: `floor-${index}`,
            title: text(item.name) || `第 ${index + 1} 层`,
            subtitle: [
              score ? `得分 ${fmtValue(score)}` : '',
              buffs.length ? buffs[0] : '',
              num(item.round_num) ? `${num(item.round_num)} 轮` : '',
            ]
              .filter(Boolean)
              .join(' · '),
            stars: num(item.star_num),
            starsMax: nodes.length ? nodes.length * 3 : 3,
            meta: [
              bool(item.is_fast) ? '快速通关' : '',
              ...nodes.map((node) => fmtTime(node.challenge_time)).filter(Boolean).slice(0, 1),
            ].filter(Boolean),
            tone: '',
            avatars,
          };
        }),
      });
    }

    return view;
  }

  /* ---------------------------------------------------------------- */
  /* 七、星铁 · 末日幻影                                                */
  /* ---------------------------------------------------------------- */

  /**
   * challenge_boss 的坑有两处：
   * 1. 楼层的 star_num 是**字符串**（Starward 里就叫 StarNumStr），不是数字；
   * 2. 顶层多了 upper_boss_icon / lower_boss_icon / tierce_boss_icon，
   *    groups 里也带着 BOSS 的 id / name_mi18n / icon，可以直接列出来当看点。
   */
  function parseStarrailApocalypticShadow(data) {
    const d = dict(data);
    const view = baseResult('starrail', 'apocalyptic-shadow');
    view.raw = d;

    const floors = list(d.all_floor_detail);
    const star = num(d.star_num);
    const extra = num(d.extra_star_num);
    const maxFloor = text(d.max_floor);

    if (!bool(d.has_data) && !floors.length) {
      return { ...view, empty: '本期还没有末日幻影记录。' };
    }

    const totalScore = floors.reduce((sum, row) => {
      const nodes = ['node_1', 'node_2', 'node_3'].map((key) => dict(dict(row)[key]));
      return sum + nodes.reduce((acc, node) => acc + num(node.score), 0);
    }, 0);

    view.headline = {
      label: '本期星数',
      value: String(star + extra),
      note: totalScore ? `总得分 ${fmtValue(totalScore)}` : maxFloor ? `最高 ${maxFloor}` : '',
    };

    view.metrics.push(
      { key: 'star', label: '星数', value: String(star) },
      { key: 'extra', label: '额外星数', value: String(extra) },
      { key: 'floor', label: '最高层数', value: maxFloor || '—' },
      { key: 'score', label: '总得分', value: totalScore ? fmtValue(totalScore) : '—' },
      { key: 'battles', label: '战斗次数', value: String(num(d.battle_num)) },
      /*
       * 这两个接口的顶层没有 end_time（实测 pure-fiction / apocalyptic-shadow 的返回里都没有），
       * 期数的时间在 groups[] 里，所以按 schedule_id 找到当期再取。
       */
      {
        key: 'period',
        label: '结束时间',
        value: fmtTime(d.end_time) || fmtTime(dict(groupForSchedule(d)).end_time) || '—',
      }
    );

    const currentGroup = groupForSchedule(d);

    /* BOSS 名单：优先用当前期 groups 里的 meta，没有就退回顶层的三个 icon。 */
    const bossItems = [];
    if (currentGroup) {
      const meta = dict(currentGroup);
      const bosses = [meta.upper_boss, meta.lower_boss, meta.tierce_boss].map(dict).filter((b) => Object.keys(b).length);
      bosses.forEach((boss, index) => {
        bossItems.push({
          key: `boss-${index}`,
          title: text(boss.name_mi18n) || `BOSS ${index + 1}`,
          subtitle: '',
          stars: null,
          starsMax: null,
          meta: [],
          tone: '',
          avatars: [{ name: '', icon: text(boss.icon), value: '', rarity: null, element: '' }],
        });
      });
      view.metrics.push({
        key: 'group',
        label: '期数',
        value: text(meta.name_mi18n) || `#${num(meta.schedule_id)}`,
      });
    }
    if (bossItems.length) {
      view.sections.push({
        key: 'bosses',
        title: '本期首领',
        hint: `${bossItems.length} 个`,
        layout: 'avatars',
        items: bossItems,
      });
    }

    if (floors.length) {
      view.sections.push({
        key: 'floors',
        title: '全层详情',
        hint: `${floors.length} 层`,
        layout: 'rows',
        items: floors.map((row, index) => {
          const item = dict(row);
          const nodes = ['node_1', 'node_2', 'node_3']
            .map((key) => dict(item[key]))
            .filter((node) => Object.keys(node).length);
          const avatars = nodes.flatMap((node) => list(node.avatars).map(avatarFrom));
          const score = nodes.reduce((sum, node) => sum + num(node.score), 0);
          const defeated = nodes.filter((node) => bool(node.boss_defeated)).length;
          return {
            key: `floor-${index}`,
            title: text(item.name) || `第 ${index + 1} 层`,
            subtitle: [
              score ? `得分 ${fmtValue(score)}` : '',
              nodes.length ? `${defeated}/${nodes.length} 首领击破` : '',
            ]
              .filter(Boolean)
              .join(' · '),
            /* star_num 是字符串，num() 会把 "★" 之类的东西变成 0，先用 text 判断是否纯数字 */
            stars: /^\d+$/.test(text(item.star_num).trim()) ? num(item.star_num) : null,
            starsMax: nodes.length ? nodes.length * 3 : 3,
            meta: [
              bool(item.is_fast) ? '快速通关' : '',
              fmtTime(item.last_update_time),
              ...nodes.map((node) => fmtTime(node.challenge_time)).filter(Boolean).slice(0, 1),
            ].filter(Boolean),
            tone: '',
            avatars,
          };
        }),
      });
    }

    return view;
  }

  /* ---------------------------------------------------------------- */
  /* 八、星铁 · 模拟宇宙                                                */
  /* ---------------------------------------------------------------- */

  /**
   * rogue 的返回不是「一期一层」，而是把本期和上期两次记录一起给你：
   * { role, basic_info:{解锁祝福/奇物/技能点}, current_record, last_record }，
   * 每条 record 里有 { basic:{id,finish_cnt,schedule_begin,end}, records:[...], has_data }。
   * 所以界面按「本次记录」和「上次记录」两块排，单条记录里展示难度、进度、命途、
   * 通关阵容和那局的祝福/奇物。
   */
  function parseStarrailRogue(data) {
    const d = dict(data);
    const view = baseResult('starrail', 'simulated-universe');
    view.raw = d;

    const basic = dict(d.basic_info);
    const current = dict(d.current_record);
    const last = dict(d.last_record);
    const currentRecords = list(current.records);
    const lastRecords = list(last.records);
    const role = dict(d.role);

    const currentBasic = dict(current.basic);
    const bestScore = currentRecords.reduce((max, row) => Math.max(max, num(dict(row).score)), 0);
    const finishCount = num(currentBasic.finish_cnt);
    /* 接口在 basic 里多给了本周积分（Starward 的 Basic 类里没有这两个字段，实测才有）。 */
    const curScore = num(currentBasic.current_rogue_score);
    const curMax = num(currentBasic.max_rogue_score);

    if (!Object.keys(basic).length && !currentRecords.length && !lastRecords.length) {
      return { ...view, empty: '这个账号还没有模拟宇宙记录。' };
    }

    view.headline = {
      label: '本期通关次数',
      value: String(finishCount),
      note: [
        bestScore ? `最高记录 ${fmtValue(bestScore)}` : '',
        curMax ? `积分 ${fmtValue(curScore)}/${fmtValue(curMax)}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    };

    if (curMax) {
      view.bars.push({
        key: 'rogue-score',
        label: '本期积分',
        value: curScore,
        max: curMax,
        note: curScore >= curMax ? '已满' : '',
        tone: curScore >= curMax ? 'ok' : '',
      });
    }

    view.metrics.push(
      { key: 'finish', label: '本期通关', value: String(finishCount) },
      { key: 'score', label: '最高记录', value: bestScore ? fmtValue(bestScore) : '—' },
      { key: 'buff', label: '解锁祝福', value: String(num(basic.unlocked_buff_num)) },
      { key: 'miracle', label: '解锁奇物', value: String(num(basic.unlocked_miracle_num)) },
      { key: 'point', label: '技能点', value: String(num(basic.unlocked_skill_points)) }
    );

    if (text(role.nickname)) {
      view.metrics.push({
        key: 'role',
        label: '角色',
        value: text(role.nickname),
        note: [num(role.level) ? `Lv.${num(role.level)}` : '', text(role.server)].filter(Boolean).join(' · '),
      });
    }

    const scheduleRange = [fmtTime(currentBasic.schedule_begin), fmtTime(currentBasic.schedule_end)]
      .filter(Boolean)
      .join(' ~ ');
    if (scheduleRange) {
      view.metrics.push({ key: 'schedule', label: '本期时间', value: scheduleRange });
    }

    function recordSection(key, title, records, hintPrefix) {
      if (!records.length) return null;
      return {
        key,
        title,
        hint: `${records.length} 条记录${hintPrefix ? ` · ${hintPrefix}` : ''}`,
        layout: 'rows',
        items: records.map((row, index) => {
          const item = dict(row);
          const lineup = list(item.final_lineup).map(avatarFrom);
          const miracles = list(item.miracles).map((m) => text(dict(m).name)).filter(Boolean);
          const buffTypes = list(item.base_type_list)
            .map((b) => {
              const type = dict(b);
              return text(type.name) ? `${text(type.name)} ${num(type.cnt)}` : '';
            })
            .filter(Boolean);
          return {
            key: `${key}-${index}`,
            title: text(item.name) || `记录 ${index + 1}`,
            subtitle: [
              num(item.difficulty) ? `难度 ${num(item.difficulty)}` : '',
              num(item.progress) ? `进度 ${num(item.progress)}%` : '',
              buffTypes.length ? buffTypes.join(' / ') : '',
            ]
              .filter(Boolean)
              .join(' · '),
            stars: null,
            starsMax: null,
            meta: [
              fmtTime(item.finish_time),
              num(item.score) ? `积分 ${fmtValue(item.score)}` : '',
              miracles.length ? `奇物 ${miracles.slice(0, 3).join('、')}` : '',
            ].filter(Boolean),
            tone: '',
            avatars: lineup,
          };
        }),
      };
    }

    const currentSection = recordSection('current', '本次记录', currentRecords, '');
    if (currentSection) view.sections.push(currentSection);
    const lastSection = recordSection('last', '上次记录', lastRecords, '');
    if (lastSection) view.sections.push(lastSection);

    return view;
  }

  /* ---------------------------------------------------------------- */
  /* 九、绝区零 · 式舆防卫战                                            */
  /* ---------------------------------------------------------------- */

  /**
   * hadal_info_v2 外面还套了一层 wrapper：
   * { hadal_ver, hadal_info_v2:{...}, nick_name, icon }。
   * v2 结构跟 v1（ShiyuDefenseInfo）完全不同，评分/排名/前三层简讯在 brief 里，
   * 第四层和第五层的细节分别放在 fourth/fifth_layer_detail。
   */
  function parseZzzShiyuDefense(data) {
    const d = dict(data);
    const view = baseResult('zzz', 'shiyu-defense');
    view.raw = d;

    const info = dict(d.hadal_info_v2);
    if (!Object.keys(info).length) {
      return { ...view, empty: '本期还没有式舆防卫战记录。' };
    }

    const brief = dict(info.brief);
    /* Starward 里这个字段是拼错的 fitfh_layer_detail，接口也照抄了这个拼写，两种都认。 */
    const fifth = dict(info.fifth_layer_detail || info.fitfh_layer_detail);
    const fifthList = list(fifth.layer_challenge_info_list);
    const fourth = dict(info.fourth_layer_detail);
    const fourthList = list(fourth.layer_challenge_info_list);

    if (!bool(info.has_data) && !Object.keys(brief).length && !fifthList.length) {
      return { ...view, empty: '本期还没有式舆防卫战记录。' };
    }

    const score = num(brief.score);
    const maxScore = num(brief.max_score);
    const layers = num(brief.cur_period_zone_layer_count);

    view.headline = {
      label: '本期评分',
      value: score ? fmtValue(score) : '—',
      note: [
        maxScore ? `满分 ${fmtValue(maxScore)}` : '',
        bool(info.pass_fifth_floor) ? '已通关第五层' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    };

    view.metrics.push(
      { key: 'score', label: '评分', value: score ? fmtValue(score) : '—', note: maxScore ? `满分 ${fmtValue(maxScore)}` : '' },
      { key: 'layers', label: '通关层数', value: layers ? String(layers) : '—' },
      { key: 'rating', label: '评级', value: text(brief.rating) || '—' },
      { key: 'rank', label: '排名', value: rankText(brief.rank_percent) ? `前 ${rankText(brief.rank_percent)}` : '—' },
      { key: 'period', label: '结束时间', value: fmtTime(info.end_time) || fmtTime(info.hadal_end_time) || '—' }
    );
    /* brief 里没有 battle_time（Starward 的 ShiyuDefenseV2Brief 有这个字段，实测返回没有），不硬凑。 */

    if (num(brief.challenge_time) || fmtTime(brief.challenge_time)) {
      view.metrics.push({ key: 'challenge', label: '挑战时间', value: fmtTime(brief.challenge_time) || '—' });
    }

    if (fifthList.length) {
      view.sections.push({
        key: 'fifth',
        title: '第五层',
        hint: `${fifthList.length} 个节点`,
        layout: 'rows',
        items: fifthList.map((row, index) => {
          const item = dict(row);
          const buff = dict(item.buffer);
          return {
            key: `fifth-${index}`,
            title: plain(buff.title) || `节点 ${index + 1}`,
            subtitle: [
              text(item.rating) ? `评级 ${text(item.rating)}` : '',
              num(item.max_score) ? `得分 ${fmtValue(item.score)}/${fmtValue(item.max_score)}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
            stars: null,
            starsMax: null,
            /*
             * buff.text 是官方富文本（带 <color=#> 和前导项目符号），整段塞进 meta 会把
             * 一行撑成十几行。剥完标签留一句短的当注解，够看出这层是什么增益就行。
             */
            meta: [fmtTime(item.challenge_time), clip(plain(buff.text), 46)].filter(Boolean),
            tone: '',
            avatars: text(item.monster_pic)
              ? [{ name: '', icon: text(item.monster_pic), value: '', rarity: null, element: '' }]
              : [],
          };
        }),
      });
    }

    if (fourthList.length) {
      view.sections.push({
        key: 'fourth',
        title: '第四层',
        hint: `${fourthList.length} 个节点`,
        layout: 'rows',
        items: fourthList.map((row, index) => {
          const item = dict(row);
          return {
            key: `fourth-${index}`,
            title: `节点 ${index + 1}`,
            subtitle: [
              /* layer_id 是地区编号（62059041）不是层数，显示成「第 62059041 层」是错的。 */
              num(item.battle_time) ? `用时 ${fmtSeconds(item.battle_time)}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
            stars: null,
            starsMax: null,
            meta: [text(dict(fourth.buff).title), text(fourth.rating) ? `评级 ${text(fourth.rating)}` : ''].filter(Boolean),
            tone: '',
            avatars: list(item.avatar_list).map(avatarFrom),
          };
        }),
      });
    }

    return view;
  }

  /* ---------------------------------------------------------------- */
  /* 十、绝区零 · 危局强袭战                                            */
  /* ---------------------------------------------------------------- */

  /**
   * hadal_mem_detail_v2：{ zone_id, start_time, end_time, rank_percent,
   * list:[节点], has_data, total_score, total_star, has_hard, hard_list }。
   * 每个节点的 star 是「这次拿了几颗星」，total_star 是满星数；
   * boss 和 buffer 都是数组，一个节点可能有多个 BOSS 多档 buff。
   */
  function parseZzzDeadlyAssault(data) {
    const d = dict(data);
    const view = baseResult('zzz', 'deadly-assault');
    view.raw = d;

    const nodes = list(d.list);
    const hardNodes = list(d.hard_list);
    if (!bool(d.has_data) && !nodes.length && !hardNodes.length) {
      return { ...view, empty: '本期还没有危局强袭战记录。' };
    }

    const totalScore = num(d.total_score);
    const totalStar = num(d.total_star);

    view.headline = {
      label: '本期总得分',
      value: totalScore ? fmtValue(totalScore) : '—',
      note: [totalStar ? `共 ${totalStar} 星` : '', rankText(d.rank_percent) ? `前 ${rankText(d.rank_percent)}` : '']
        .filter(Boolean)
        .join(' · '),
    };

    view.metrics.push(
      { key: 'score', label: '总得分', value: totalScore ? fmtValue(totalScore) : '—' },
      { key: 'star', label: '总星数', value: totalStar ? String(totalStar) : '—' },
      { key: 'rank', label: '排名', value: rankText(d.rank_percent) ? `前 ${rankText(d.rank_percent)}` : '—' },
      { key: 'nodes', label: '节点数', value: String(nodes.length) },
      /*
       * 这两个接口的顶层没有 end_time（实测 pure-fiction / apocalyptic-shadow 的返回里都没有），
       * 期数的时间在 groups[] 里，所以按 schedule_id 找到当期再取。
       */
      {
        key: 'period',
        label: '结束时间',
        value: fmtTime(d.end_time) || fmtTime(dict(groupForSchedule(d)).end_time) || '—',
      }
    );
    if (bool(d.has_hard)) {
      view.metrics.push({
        key: 'hard',
        label: '困难模式',
        value: num(d.hard_total_score) ? fmtValue(d.hard_total_score) : '已解锁',
        note: rankText(d.hard_rank_percent) ? `前 ${rankText(d.hard_rank_percent)}` : '',
      });
    }

    function nodeSection(key, title, rows, hintExtra) {
      if (!rows.length) return null;
      return {
        key,
        title,
        hint: `${rows.length} 个节点${hintExtra ? ` · ${hintExtra}` : ''}`,
        layout: 'rows',
        items: rows.map((row, index) => {
          const item = dict(row);
          const bosses = list(item.boss).map((b) => text(dict(b).name)).filter(Boolean);
          const buffs = list(item.buffer).map((b) => text(dict(b).name)).filter(Boolean);
          return {
            key: `${key}-${index}`,
            title: bosses.length ? bosses.join(' / ') : `节点 ${index + 1}`,
            subtitle: [
              num(item.score) ? `得分 ${fmtValue(item.score)}` : '',
              num(item.star) && num(item.total_star) ? `${num(item.star)}/${num(item.total_star)} 星` : '',
              buffs.length ? buffs[0] : '',
            ]
              .filter(Boolean)
              .join(' · '),
            stars: num(item.star) || null,
            starsMax: num(item.total_star) || 3,
            meta: [fmtTime(item.challenge_time)].filter(Boolean),
            tone: '',
            avatars: list(item.avatar_list).map(avatarFrom),
          };
        }),
      };
    }

    const normalSection = nodeSection('nodes', '节点详情', nodes, '');
    if (normalSection) view.sections.push(normalSection);
    const hardSection = nodeSection('hard-nodes', '困难模式节点', hardNodes, '');
    if (hardSection) view.sections.push(hardSection);

    return view;
  }

  /* ---------------------------------------------------------------- */
  /* 调度                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 把 (游戏, 功能, 接口原始返回) 转成统一的视图模型。
   * 任何解析异常都降级成 emptyResult，不让一个坏字段把整页拖垮。
   */
  function parse(game, feature, data) {
    const g = String(game || '').toLowerCase();
    const f = String(feature || '');
    if (data === null || data === undefined) {
      return emptyResult(g, f, '这个账号还没有这项战绩数据。');
    }
    try {
      if (f === 'daily-note') return parseNote(g, data);
      if (g === 'genshin' && f === 'abyss') return parseGenshinAbyss(data);
      if (g === 'genshin' && f === 'theater') return parseGenshinTheater(data);
      if (g === 'genshin' && f === 'stygian') return parseGenshinStygian(data);
      if (g === 'bh3' && (f === 'ultra-endless' || f === 'battle-field')) return parseBh3Cycle(data, f);
      if (g === 'starrail' && f === 'forgotten-hall') return parseStarrailChallenge(data);
      if (g === 'starrail' && f === 'pure-fiction') return parseStarrailPureFiction(data);
      if (g === 'starrail' && f === 'apocalyptic-shadow') return parseStarrailApocalypticShadow(data);
      if (g === 'starrail' && f === 'simulated-universe') return parseStarrailRogue(data);
      if (g === 'zzz' && f === 'shiyu-defense') return parseZzzShiyuDefense(data);
      if (g === 'zzz' && f === 'deadly-assault') return parseZzzDeadlyAssault(data);
      return emptyResult(g, f, '这个功能的界面还没做好。');
    } catch (error) {
      const fallback = emptyResult(g, f, `数据解析失败：${String((error && error.message) || error)}`);
      fallback.raw = data;
      return fallback;
    }
  }

  const API = {
    parse,
    labels: { game: GAME_LABEL, feature: FEATURE_LABEL },
    helpers: { num, text, list, dict, bool, fmtSeconds, fmtTime, remainText, fmtValue, rankText },
  };

  if (typeof module === 'object' && module.exports) module.exports = API;
  if (global) global.HXLRecord = API;
})(typeof window !== 'undefined' ? window : null);
