'use strict';

/**
 * 视图层：服务器与更新面板（servers）。
 *
 * 2026-10-31 从 app.js 拆出 —— 「前后端分离」第 7 批。
 *
 * 内容（四块，共用同一批服务器数据）：
 *   · 服务器状态与卡片：serverState / serverChannelTag / serverIconId /
 *     serverBlockHint / sharedRootWith / serverRow
 *   · 切服与启动：switchServerProfile / launchGameOrExplain
 *   · 进度承载：beginBusyToast / beginServerModalProgress（修游戏与预下载共用）
 *   · 预下载：PREDOWNLOAD_* 常量 / predownload* 系列 / openPredownloadModal /
 *     runPredownloadCheck / autoCheckPredownload / repaintServerRows
 *   · 终末地通道：nteChannel* 系列（含 refreshNtePanel）
 *   · 修游戏：repairGameFlow / repairProgressText
 *
 * 加载约定：普通 script，共享全局词法作用域，必须排在 app.js 之前。
 * 依赖 state / dom / icon / esc / api 等，均在调用时解析；顶层无立即求值。
 * 注意 serverRow 被 views/home.js 的启动页服务器面板复用，跨文件调用靠全局。
 */

/* ------------------------------------------------------------------ */
/* servers                                                             */
/* ------------------------------------------------------------------ */

function serverState(server) {
  if (server.incomplete) return { label: '需要重建', cls: 'missing' };
  if (server.active && server.exists) return { label: '当前服务器', cls: 'active' };
  // 「已经就绪」是正常态，不用再写三个字：左边的点已经是绿的，
  // 状态徽标只留给「要用户动手」的那几种（需要重建 / 目录丢失 / 未配置）。
  if (server.exists) return { label: '', cls: 'ready' };
  // 目录本身都没了：和「从没配过路径」是两回事，状态文案得分开
  if (server.root && server.rootExists === false) return { label: '目录丢失', cls: 'missing' };
  return { label: '未配置', cls: 'missing' };
}

/**
 * 渠道短名（官服 / B服 / 国际服 …）。
 *
 * 内置渠道的服务器名本身就叫「官服」「B服」，再贴一个同名标签只是噪音，
 * 所以名字已经写着渠道时返回空串；只有玩家自己加的行才需要标出来。
 */
function serverChannelTag(game, server) {
  if (!server || !server.channel) return '';
  const tags = {
    // 终末地官方口径叫「国服」，和原神那套「官服」不是一回事
    official: '官服',
    bilibili: 'B服',
    global: '国际服',
    play: 'Play',
    steam: 'Steam',
    custom: '自建',
  };
  const tag = tags[server.channel] || '';
  return tag && tag !== server.name ? tag : '';
}

/**
 * 服务器行左侧的图标。
 *
 * 参考图里每个服务器是一枚「图标 + 粗体字」的大按钮，图标是识别第一眼，
 * 所以按渠道分：官方=盾牌、B服=火花（渠道）、国际服=月/地球感、Play=播放、
 * Steam=下载、自建=服务器。认不出来就退回通用服务器图标。
 */
function serverIconId(server) {
  const channel = server && server.channel ? String(server.channel) : '';
  const name = server && server.name ? String(server.name) : '';
  const pick = (...keys) => keys.some((key) => name.includes(key) || channel.includes(key));
  if (channel === 'official' || pick('官方', '官服', 'official')) return 'shield';
  if (channel === 'bilibili' || pick('bilibili', 'B服')) return 'sparkle';
  if (channel === 'global' || pick('国际', 'global')) return 'moon';
  if (channel === 'play' || pick('play')) return 'play';
  if (channel === 'steam' || pick('steam')) return 'download';
  if (channel === 'custom' || pick('自建', 'custom')) return 'server';
  return 'server';
}

/**
 * 这一行为什么用不了、下一步该点哪。
 *
 * 只说「未配置」玩家分不清是没装游戏、没选 exe，还是上次生成到一半，
 * 于是只能在几个菜单之间乱点 —— 这里把原因和去处分两行写清楚。
 */
function serverBlockHint(server) {
  if (!server) return null;
  /*
   * text 是「说清楚发生了什么」，short 是「塞得进行内的四五个字」。
   * 下拉列表里一行只留 short，长句只留给 toast —— 之前每行下面挂一整块
   * 「点这一行 → 服务器管理 → 编辑 → 选 exe」，三行服务器就堆出六行字，
   * 整个列表看着像说明书。
   */
  if (server.incomplete) {
    return {
      text: '客户端不完整（文件缺失），现在启动会失败',
      short: '客户端不完整',
      next: '点这一行 → 服务器管理 → 重建',
    };
  }
  if (!server.exists) {
    /*
     * 「exe 不在」有两种原因，以前都说成「还没选择启动程序」。
     * 用户删了共用目录之后看到这句话完全对不上号 —— 他明明选过路径，
     * 只是那个目录被删/挪走了。所以这里按 root 还在不在分两句说。
     */
    if (server.root && server.rootExists === false) {
      return {
        text: '客户端目录已经不见了（被删除或移动过）',
        short: '目录已不在',
        next: '点「编辑」重新指定目录；文件真没了就点「重建」用其它渠道客户端生成',
      };
    }
    return {
      text: '还没选择启动程序（.exe）',
      short: '未选 exe',
      next: '点这一行 → 服务器管理 → 编辑 → 选 exe',
    };
  }
  return null;
}

/**
 * 这个服务器和同一游戏里的谁共用同一个安装目录。
 *
 * 官服 / B服 在米家三件套里经常指向同一个文件夹（只是启动程序不同）。
 * 用户以为「删 B服」只影响 B服，去资源管理器把那个目录删了，
 * 结果官服一起失效 —— 卡片上必须先把这个共用关系说出来。
 */
function sharedRootWith(game, server) {
  if (!game || !server || !server.root) return null;
  return (
    (game.servers || []).find((item) => item.id !== server.id && item.path && sameRoot(item, server)) ||
    null
  );
}

/* ------------------------------------------------------------------ */
/* 切换服务器：所有入口共用同一套操作                                    */
/* ------------------------------------------------------------------ */

/* 切换中标记：终末地生成运行时可能要几十秒，这期间再点同一行只会叠出第二条提示 */
let switchingKey = '';

/**
 * 一条不会自己消失的提示，给「切换服务器」这种要等一会儿的操作报进度。
 * 返回 { update, done }：update 只换文案，done 换成最终结果并自动消失。
 */
function beginBusyToast(message) {
  if (!dom.toastRoot) return { update() {}, done() {} };
  const node = document.createElement('div');
  node.className = 'toast info is-busy';
  node.innerHTML = `${icon('refresh')}<span>${esc(message)}</span>`;
  dom.toastRoot.appendChild(node);
  let closed = false;
  const drop = () => {
    node.classList.add('leaving');
    window.setTimeout(() => node.remove(), 240);
  };
  return {
    update(next) {
      const label = node.querySelector('span');
      if (label && next) label.textContent = next;
    },
    done(text, type) {
      if (closed) return;
      closed = true;
      if (!text) {
        drop();
        return;
      }
      node.className = `toast ${type || 'info'}`;
      node.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info')}<span>${esc(text)}</span>`;
      playUiSound(type === 'error' ? 'error' : 'notify');
      window.setTimeout(drop, 2800);
    },
  };
}

/**
 * 服务器管理弹窗开着时的进度显示：直接渲染在弹窗内部的进度槽里，
 * 避免右下角任务框（z-index 高于弹窗）盖住服务器列表、挡住点击。
 * 弹窗中途被关掉就自动退回右下角 busy toast，进度不中断。
 */
function beginServerModalProgress(message) {
  const slot = () => document.querySelector('.modal-servers #server-progress-slot');
  let fallback = null;
  let closed = false;
  const draw = (html) => {
    const host = slot();
    if (!host) return false;
    if (fallback) {
      fallback.done();
      fallback = null;
    }
    host.hidden = false;
    host.innerHTML = html;
    return true;
  };
  const clearSlot = () => {
    const host = slot();
    if (host) {
      host.hidden = true;
      host.innerHTML = '';
    }
  };
  return {
    update(next) {
      if (closed || !next) return;
      if (!draw(`<span class="sps-line is-busy">${icon('refresh')}<span>${esc(next)}</span></span>`)) {
        if (!fallback) fallback = beginBusyToast(next);
        else fallback.update(next);
      }
    },
    done(text, type) {
      if (closed) return;
      closed = true;
      if (fallback) {
        fallback.done(text, type);
        return;
      }
      if (!text) {
        clearSlot();
        return;
      }
      const ok = type !== 'error';
      playUiSound(ok ? 'notify' : 'error');
      const drawn = draw(
        `<span class="sps-line ${ok ? 'is-ok' : 'is-err'}">${icon(ok ? 'check' : 'alert')}<span>${esc(text)}</span></span>`
      );
      if (!drawn) toast(text, type || 'info');
      else window.setTimeout(clearSlot, 3400);
    },
  };
}

const ENDFIELD_PACK_LABEL = {
  official: '官服',
  bilibili: 'B服',
  global: '国际服',
  play: 'Play',
  steam: 'Steam',
};

/**
 * 终末地渠道包这一行的说明。
 *
 * 渠道包不随安装包分发（五个加起来几百 MB），所以「一个都没有」是全新安装的
 * 正常状态，不是没被识别 —— 要说清缺的那个会怎么补，而不是让用户去猜。
 */
function endfieldPackSummary(settings) {
  const have = (settings.endfieldPackChannels || []).map((key) => ENDFIELD_PACK_LABEL[key] || key);
  const missing = Object.keys(ENDFIELD_PACK_LABEL)
    .filter((key) => !have.includes(ENDFIELD_PACK_LABEL[key]))
    .map((key) => ENDFIELD_PACK_LABEL[key]);
  if (!have.length) {
    return '还没准备。切到哪个服会先问你要不要下那个渠道包（官服 9 MB、B服 194 MB、国际服 / Play 约 940 MB），下过一次就一直在。';
  }
  if (!missing.length) return '五个渠道都已就绪，切服即用，官方更新时会自动同步。';
  return `已有 ${have.join('、')}；缺 ${missing.join('、')}，切到那个服时会先问你要不要下。`;
}

const ARKNIGHTS_PACK_LABEL = { official: '官服', bilibili: 'B服' };

/**
 * 明日方舟渠道包这一行的说明。
 *
 * 方舟官服和 B服 共用同一个安装目录，切换要换的是渠道 SDK 那几样（B服 那份含
 * B站内嵌浏览器，约 195MB）。以前这一条完全没有，切方舟的人无从知道要下什么。
 */
function arknightsPackSummary(settings) {
  const have = (settings.arknightsPackChannels || []).map((key) => ARKNIGHTS_PACK_LABEL[key] || key);
  const missing = Object.keys(ARKNIGHTS_PACK_LABEL)
    .filter((key) => !have.includes(ARKNIGHTS_PACK_LABEL[key]))
    .map((key) => ARKNIGHTS_PACK_LABEL[key]);
  if (!have.length) return '还没准备。官服 / B服 共用一套安装目录，切到另一个服时会先问你要不要下对应渠道包（官服 9 MB、B服 194 MB）。';
  if (!missing.length) return '官服与 B服 都已就绪，切服即用。';
  return `已有 ${have.join('、')}；缺 ${missing.join('、')}，切到那个服时会先问你要不要下。`;
}

/**
 * 设置页合并成一行之后的标语（2.6.0）。
 *
 * 两个游戏的渠道包走的是同一套下载 / 释放机制、同一个管理窗口、同一个自动更新
 * 开关，分成两行只会让「管理」「释放」各出现一次，用户还得先判断点哪一边。
 * 这里只给「已就绪几个 / 一共几个」，细节仍由两个 Summary 各占一行说清。
 */
function channelPackCount(settings) {
  const end = (settings.endfieldPackChannels || []).length;
  const ark = (settings.arknightsPackChannels || []).length;
  return { ready: end + ark, total: 7, end, ark };
}

/** 渠道包是几百 MB 量级，超过 1GB 时 MB 读起来太累。 */
function packBytesText(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return formatBytes(size);
}

/** 终末地生成运行时期间的进度文案（主进程发 phase / processed / total / current）。 */
function endfieldProgressText(progress) {
  const name = progress.serverName || '渠道';
  const total = Number(progress.total) || 0;
  const done = Number(progress.processed) || 0;
  if (total > 0) {
    const pct = Math.min(100, Math.round((done / total) * 100));
    return `正在为${name}生成运行时 ${pct}%（${done} / ${total} 个文件）`;
  }
  return progress.current || `正在为${name}生成运行时…`;
}

/* ── 渠道包按需下载（2.5.0） ──────────────────────────────────────
 *
 * 以前终末地 5 个渠道 + 明日方舟 2 个渠道的渠道包（共 632 MB）整个打进安装包，
 * 用户往往只用得上其中一个。现在改成第一次切到某个服时按需下载：
 *
 *   点「切换」→ 主进程答「这个服要不要包、要下多大」→ 弹窗写清体积 →
 *   用户点「下载并切换」才下（带百分比 / 已下载量 / 速度）→ 下完自动继续切服。
 *
 * 三条约束：
 *   · 判断「要不要」在主进程里做（channelPackNeededFor），因为官服直启、
 *     方舟基础目录本来就是目标渠道这两种情况根本用不上包 —— 前端只看
 *     「本机有没有这个目录」会白问一次 194 MB。
 *   · 弹窗关掉就等于取消下载，不能让它在后台默默下完再占一份空间。
 *   · 下完再切，不并行：切服流程要读渠道包目录，边下边切会读到半截文件。
 */

/** 体积文案：194 MB / 1.24 GB。 */
function packSizeText(bytes) {
  const num = Number(bytes) || 0;
  if (!num) return '大小未知';
  if (num >= 1024 * 1024 * 1024) return `${(num / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (num >= 1024 * 1024) return `${Math.round(num / 1024 / 1024)} MB`;
  return `${Math.max(1, Math.round(num / 1024))} KB`;
}

/**
 * 缺渠道包时的确认 + 下载进度弹窗。
 *
 * @param {object} plan servers:channel-pack-plan 的返回值
 * @returns {Promise<boolean>} true = 已下好、可以继续切服；false = 用户取消
 */
function channelPackDialog(plan) {
  return new Promise((resolve) => {
    const label = plan.label || '渠道';
    const sizeText = packSizeText(plan.bytes);
    const jobId = `pack-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let unsub = null;
    let done = false;
    let running = false;
    /* 收进过任务坞没有：收起来后收尾要先把界面挂回前台，否则节点留在隐藏槽里 */
    let stashed = false;
    /* 这一次关窗是不是被我自己的守卫收成了最小化（是的话 onClose 不能当取消） */
    let guardFired = false;

    /*
     * 任务坞里那一条：渠道包下载也塞进 sophonJobs，和本体下载共用左下角任务面板。
     * 194 MB 的 B服包在旧实现里只能盯着弹窗看，关掉就等于取消；现在最小化后
     * 坞里有进度条和停止键，点条目能把这一屏原样挂回来（进度、监听都还在）。
     */
    const job = {
      id: jobId,
      gameId: plan.gameId || '',
      serverId: plan.serverId || '',
      gameName: plan.game === 'arknights' ? '明日方舟' : '终末地',
      serverName: plan.serverName || label,
      mode: 'pack',
      status: 'starting',
      percent: 0,
      phase: '准备下载…',
      stats: '',
    };
    const backdrop = () => document.querySelector('.modal-backdrop');

    /** 收尾：撤掉坞里那条 → 界面若被收起来过就挂回前台 → 成功时清空弹窗。 */
    const finish = (value) => {
      if (done) return;
      done = true;
      if (unsub) {
        unsub();
        unsub = null;
      }
      endJob();
      if (stashed) {
        stashed = false;
        restoreTaskModal();
      }
      if (value) {
        // 成功时直接清空：不再走 closeModal，避免它的回调把这次结果当成「取消」
        modalOnClose = null;
        dom.modalRoot.innerHTML = '';
        document.body.classList.remove('modal-open');
      }
      resolve(value);
    };

    /*
     * 关窗的语义：下载中关掉 = 收进任务坞继续下（守卫做的），不是取消。
     * 取消只有两条路：底部「取消下载」按钮，和任务坞里那条上的 ✕。
     */
    function onClose() {
      if (guardFired) {
        guardFired = false;
        return;
      }
      if (running) api.endfield?.packCancel?.({ game: plan.game, channel: plan.channel });
      finish(false);
    }

    openModal(
      `<div class="modal-backdrop" data-backdrop>
        <div class="modal narrow" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div><h2>需要先下载${esc(label)}差异包</h2></div>
            <div class="modal-head-actions">
              <button class="modal-close" id="pack-minimize" style="display:none" title="最小化到任务面板">−</button>
              <button class="modal-close" data-close title="关闭">${icon('x')}</button>
            </div>
          </div>
          <div class="modal-body">
            <p class="confirm-copy">切到「${esc(plan.serverName || label)}」要用到${esc(label)}的渠道文件，本机还没有。
只下一次，下完之后切这个服不会再问。</p>
            <div class="pack-facts">
              <div><span>下载大小</span><strong>${esc(sizeText)}</strong></div>
              <div><span>文件数</span><strong>${
                plan.fileCount ? `${plan.fileCount} 个` : '—'
              }</strong></div>
            </div>
            <div class="link-progress" id="pack-progress" hidden>
              <div class="link-progress-head">
                <strong id="pack-phase">正在下载${esc(label)}差异包…</strong>
                <span id="pack-pct">0%</span>
              </div>
              <div class="progress-bar"><span id="pack-bar" style="width:0%"></span></div>
              <div class="link-progress-meta">
                <span id="pack-stats"></span>
                <span id="pack-current"></span>
              </div>
            </div>
            <p class="hint">${
              ['global', 'play', 'steam'].includes(String(plan.channel || ''))
                ? '国际服 / Play / Steam 是 Gryphline 独立发行的版本，连游戏本体二进制都和国服不是同一份（约 940 MB，含 Endfield.exe、GameAssembly.dll、反作弊等），所以整个差异包要下完才能切。'
                : '下载的是官方接口给的渠道 SDK 文件，放到本机渠道包目录，和以前随安装包分发的是同一份。'
            }下完会自动继续切换。</p>
            <div class="field-error" id="pack-error"></div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" id="pack-cancel">取消</button>
            <button class="btn btn-primary" id="pack-start"${
              plan.canDownload === false ? ' disabled' : ''
            }>${icon('download')}下载并切换</button>
          </div>
        </div>
      </div>`,
      { onClose }
    );

    const startBtn = document.querySelector('#pack-start');
    const cancelBtn = document.querySelector('#pack-cancel');
    const minimizeBtn = document.querySelector('#pack-minimize');
    const progressBox = document.querySelector('#pack-progress');
    const phase = document.querySelector('#pack-phase');
    const bar = document.querySelector('#pack-bar');
    const pct = document.querySelector('#pack-pct');
    const stats = document.querySelector('#pack-stats');
    const current = document.querySelector('#pack-current');
    const errorBox = document.querySelector('#pack-error');

    /** 从任务坞里撤掉这一条（完成、失败、取消都走它）。 */
    const endJob = () => {
      if (activeSophonJob === job) activeSophonJob = null;
      sophonUi = null;
      taskModalGuard = null;
      sophonJobs = sophonJobs.filter((item) => item.id !== jobId);
      document.body.classList.remove('sophon-minimized');
      renderTaskDock();
    };

    /*
     * 最小化到任务面板：整块界面从 #modal-root 拔下来存着（进度条、监听、滚动位置
     * 都还在），坞里挂一条能看进度、能停的任务。下载本身在主进程跑，不受影响。
     */
    const minimized = () => {
      if (!running) return;
      const node = backdrop();
      if (!node) return;
      stashed = true;
      hiddenTaskModalClose = onClose;
      stashTaskModal(node);
      document.body.classList.add('sophon-minimized');
      job.status = 'running';
      activeSophonJob = job;
      if (!sophonJobs.some((item) => item.id === jobId)) sophonJobs.push(job);
      renderTaskDock();
      sophonUi = {
        restore: () => {
          if (restoreTaskModal()) stashed = false;
        },
        cancel: () => {
          api.endfield?.packCancel?.({ game: plan.game, channel: plan.channel });
          running = false;
          stashed = false;
          dropStashedTaskModal();
          finish(false);
          dom.modalRoot.innerHTML = '';
          document.body.classList.remove('modal-open');
          toast('已取消下载，服务器没有切换', 'info');
        },
      };
    };

    if (minimizeBtn) minimizeBtn.addEventListener('click', minimized);

    /* 下载中被关窗（✕ / Esc / 点遮罩）不是取消：收进任务坞接着下。 */
    taskModalGuard = () => {
      if (!running) return false;
      guardFired = true;
      minimized();
      return true;
    };

    const render = (progress) => {
      const totalBytes = Number(progress.totalBytes) || 0;
      const bytes = Number(progress.bytes) || 0;
      const total = Number(progress.total) || 0;
      const processed = Number(progress.processed) || 0;
      const ratio = totalBytes > 0 ? bytes / totalBytes : total > 0 ? processed / total : 0;
      const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
      if (bar) bar.style.width = `${percent}%`;
      if (pct) pct.textContent = `${percent}%`;
      if (stats) {
        const speed = Number(progress.speed) || 0;
        stats.textContent =
          totalBytes > 0
            ? `${packSizeText(bytes)} / ${packSizeText(totalBytes)}${
                speed ? ` · ${packSizeText(speed)}/s` : ''
              }`
            : `${processed} / ${total} 个文件`;
      }
      if (current) current.textContent = String(progress.current || '');
      // 坞里那一条跟着走：最小化之后这是唯一的进度入口
      job.percent = percent;
      job.phase = `正在下载${label}差异包…`;
      job.stats = stats ? stats.textContent : '';
      if (activeSophonJob === job) renderTaskDock();
    };

    if (startBtn) {
      startBtn.addEventListener('click', async () => {
        if (running) return;
        running = true;
        startBtn.disabled = true;
        startBtn.textContent = '正在下载…';
        if (minimizeBtn) minimizeBtn.style.display = '';
        if (cancelBtn) cancelBtn.textContent = '取消下载';
        if (progressBox) progressBox.hidden = false;
        if (errorBox) errorBox.textContent = '';
        if (phase) phase.textContent = `正在下载${label}差异包…`;
        // 体积已经知道了就先画个 0%：等第一块数据之前界面不能是空白
        if (plan.bytes) render({ bytes: 0, totalBytes: plan.bytes });
        // 订阅必须在 invoke 之前：第一块数据可能比 await 返回得还早
        unsub =
          api.endfield?.onPackProgress?.((progress) => {
            if (!progress || progress.directory !== plan.directory) return;
            if (phase && progress.current) phase.textContent = `正在下载 ${label} 差异包…`;
            render(progress);
          }) || null;
        try {
          await api.endfield.packDownload({ game: plan.game, channel: plan.channel });
          finish(true);
        } catch (error) {
          running = false;
          if (unsub) {
            unsub();
            unsub = null;
          }
          // 最小化后失败的：先把界面挂回来，错误信息才有地方显示
          if (stashed) {
            stashed = false;
            restoreTaskModal();
          }
          endJob();
          if (minimizeBtn) minimizeBtn.style.display = 'none';
          if (startBtn) {
            startBtn.disabled = false;
            startBtn.textContent = '重试下载';
          }
          if (cancelBtn) cancelBtn.textContent = '取消';
          if (errorBox) errorBox.textContent = humanError(error);
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (!running) {
          closeModal();
          return;
        }
        // 先让主进程停，再关窗：反过来的话 abort 信号可能落在已经清空的界面上
        api.endfield?.packCancel?.({ game: plan.game, channel: plan.channel });
        running = false;
        finish(false);
        closeModal();
      });
    }
  });
}

/**
 * 切服前把渠道包准备好。
 *
 * @returns {Promise<boolean>} false = 用户取消 / 装不了，切服流程应该到此为止
 */
async function ensureChannelPackReady(game, server) {
  if (!['endfield', 'arknights'].includes(game.builtinKey)) return true;
  let plan = null;
  try {
    plan = await api.servers.channelPackPlan({ gameId: game.id, serverId: server.id });
  } catch {
    // 查状态失败不该把切服堵死：主进程里还有一层「缺就下」的兜底
    return true;
  }
  if (!plan || !plan.needed) return true;
  if (plan.canDownload === false) {
    toast(plan.reason || `${plan.label}渠道包需要先手动装一次`, 'info');
    return false;
  }
  return channelPackDialog(plan);
}

/** 启动游戏；需要提权时弹确认框，其余失败直接提示。返回是否真的起来了。 */
async function launchGameOrExplain(game) {
  const result = await api.games.launch(game.id);
  if (result.ok) {
    playUiSound('launch');
    return true;
  }
  if (result.elevationRequired) {
    const restart = await confirmDialog({
      title: '需要管理员权限',
      message: result.error,
      confirmText: '以管理员身份重启',
    });
    if (restart) await api.relaunchAdmin();
    return false;
  }
  toast(result.error, 'error');
  return false;
}

/**
 * 切换服务器的唯一实现 —— 启动页下拉、服务器管理弹窗、快捷面板、服务器胶囊全走这里。
 *
 * 以前这几个入口各写一套，于是同一件事在不同地方点出不同结果：
 *   · 启动页下拉：会先改异环的 Config.ini，但切完不启动、也没有成功提示
 *   · 服务器管理弹窗：直接 activate 再启动，异环的渠道根本没改，切完进游戏还是原服
 *   · 快捷面板 / 服务器胶囊：同上，渠道也没改
 *   · 终末地要现场生成链接运行时（几十秒），四套里没有任何进行中反馈，
 *     只有一句一闪而过的 toast —— 看起来就是「点切换没反应」
 * 现在统一成一条路：运行中先拦 → 不可用转去管理面板 → 异环先改渠道 →
 * activate（终末地 / 原神国际服 / 明日方舟的运行时都由主进程在里面处理）→
 * 统一的「进行中 / 已切换」提示。要不要顺带启动由入口显式传 launch。
 */
async function switchServerProfile(gameId, serverId, options = {}) {
  const { launch = false } = options;
  const game = state.games.find((item) => item.id === gameId);
  const server = game && (game.servers || []).find((item) => item.id === serverId);
  if (!game || !server) return { ok: false };
  // 先把下拉收起来：无论后面是早退还是真去切换，菜单都不该留在屏幕上
  closeStartServerMenu();

  // 已经停在这个服上：不必重跑渠道 / 运行时流程，要启动就直接启动
  if (server.active) {
    if (!launch) return { ok: true, unchanged: true };
    // 已经起来了就别再拉一个进程出来（重复点「启动」很常见）
    if (game.running) {
      toast(`${game.name} 正在运行`, 'info');
      return { ok: true, unchanged: true };
    }
    await launchGameOrExplain(game);
    return { ok: true };
  }
  if (switchingKey) {
    toast('上一次切换还没完成，等它跑完再点', 'info');
    return { ok: false };
  }
  if (game.running) {
    toast(`${game.name} 正在运行，先结束进程再切换服务器`, 'info');
    return { ok: false };
  }
  if (!server.exists || server.incomplete) {
    // 不可用不是错误，是「还没准备好」：直接带用户去管理面板，别让人对着「切换失败」猜
    const hint = serverBlockHint(server);
    openStartServerManager(gameId);
    toast(
      hint
        ? `「${server.name}」还不能切换：${hint.text}`
        : `「${server.name}」还不能切换，先把客户端路径补齐`,
      'info'
    );
    return { ok: false };
  }
  /*
   * 渠道包不随安装包分发、也不依赖预置目录：第一次切到某个服时先问
   * 一句「要下 194 MB，下不下」，点了才下。放在 busy toast 之前 —— 下载确认
   * 有自己的弹窗和进度条，两套进度叠在一起会互相抢文案。
   */
  const packReady = await ensureChannelPackReady(game, server);
  if (!packReady) return { ok: false, cancelled: true };

  const busy = beginBusyToast(`正在切换到 ${server.name}…`);
  switchingKey = `${gameId}:${serverId}`;
  const offProgress =
    typeof api.onEndfieldProgress === 'function'
      ? api.onEndfieldProgress((progress) => {
          if (!progress || progress.serverName !== server.name) return;
          busy.update(endfieldProgressText(progress));
        })
      : null;
  try {
    /*
     * 异环的「服务器」是同一个客户端的渠道，真正生效的是 Config.ini。
     * 这段以前只写在启动页下拉里，另外三个入口都没有，所以那几处切完、
     * 游戏里还是原渠道 —— 也是「操作不一样」最明显的一处。
     */
    if (
      game.builtinKey === 'neverness' &&
      ['official', 'bilibili'].includes(String(server.channel || ''))
    ) {
      const switched = await switchNteChannel(game, server, server.channel);
      if (!switched) {
        busy.done();
        return { ok: false, cancelled: true };
      }
    }
    await api.servers.activate({ gameId, serverId });
    busy.done(`已切换到 ${server.name}`, 'success');
    showServerSwitchGuideOnce();
  } catch (error) {
    busy.done(humanError(error), 'error');
    return { ok: false, error };
  } finally {
    if (offProgress) offProgress();
    switchingKey = '';
  }

  if (!launch) return { ok: true };
  await launchGameOrExplain(game);
  return { ok: true };
}

function serverRow(game, server) {
  const status = serverState(server);
  const usable = server.exists && !server.incomplete;
  const shared = sharedRootWith(game, server);
  const block = serverBlockHint(server);
  const canPrepare =
    game.builtinKey === 'endfield' &&
    server.channel !== 'official' &&
    usable &&
    server.legacyRuntime;
  const canUpdateSophon =
    ['genshin', 'starrail', 'zzz', 'bh3'].includes(game.builtinKey) && usable;
  // 修复入口统一挂到服务器卡片上：米哈游走 Sophon 逐 chunk 校验，终末地 / 方舟走官方逐文件清单。
  // 异环没有常态修复（本体修复交给官方启动器，只在拉不到更新时才提示），所以不在列表里。
  const canRepairGame =
    ['genshin', 'starrail', 'zzz', 'bh3', 'endfield', 'arknights'].includes(game.builtinKey) &&
    usable;
  const fileName = server.path ? server.path.split(/[\\/]/).pop() : '';
  const primaryAction = usable
    ? server.active
      ? 'launch-game'
      : 'activate-server'
    : 'rebuild-server';
  const primaryLabel = usable ? (server.active ? '启动' : '切换') : '重建';
  // 一行只留一句能读的话：有 exe 就写文件名，没有才用「未选 exe」这种四字状态。
  // 以前这里叠着 状态胶囊 + 三个徽标 + 一句长提示，四行字挤在 250px 里。
  const sub = fileName || (block ? block.short : '') || '未选择客户端';
  return `
    <article class="server-tile ${server.active ? 'is-active' : ''} ${
      usable ? '' : 'is-broken'
    }" data-state="${status.cls}">
      <span class="st-dot ${status.cls}" aria-hidden="true"></span>
      <div class="st-main">
        <div class="st-title">
          <strong>${esc(server.name)}</strong>
          ${server.active ? '<span class="st-flag">当前</span>' : ''}
          ${!usable && status.label ? `<span class="st-chip is-warn">${status.label}</span>` : ''}
          ${server.runtimeLinked ? '<span class="st-chip">差异运行时</span>' : ''}
          ${
            shared
              ? `<span class="st-chip is-shared" title="${esc(
                  `${esc(server.name)} 和「${shared.name}」用的是同一个安装目录：删掉这个文件夹，两边都会失效`
                )}">与${esc(shared.name)}共用目录</span>`
              : ''
          }
        </div>
        <div class="st-sub" title="${esc(server.path || server.packPath || '')}">${esc(sub)}</div>
      </div>
      <div class="st-tools">
        ${
          canUpdateSophon
            ? `<button class="st-tool" data-action="update-sophon" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="检查官方更新">${icon('refresh')}</button>`
            : '',
          canRepairGame
            ? `<button class="st-tool" data-action="repair-game" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="修复游戏（校验并重新下载损坏/缺失文件）">${icon('wrench')}</button>`
            : ''
        }
        ${
          canPrepare
            ? `<button class="st-tool" data-action="prepare-endfield" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="重新生成运行时">${icon('link')}</button>`
            : ''
        }
        <button class="st-tool" data-action="edit-server" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="编辑服务器">${icon('edit')}</button>
        ${
          usable
            ? `<button class="st-tool" data-action="open-server-folder" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="打开安装目录">${icon('folder-open')}</button>`
            : ''
        }
        ${
          server.builtinServer || (game.builtin && server.channel)
            ? `<button class="st-tool is-danger" data-action="clear-server-path" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="清除路径记录（不删文件）">${icon('x')}</button>`
            : (game.servers || []).length > 1
              ? `<button class="st-tool is-danger" data-action="remove-server" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="移除这个服务器（不删文件）">${icon('x')}</button>`
              : ''
        }
        ${
          server.root
            ? `<button class="st-tool is-text is-danger ${game.running ? 'is-locked' : ''}" data-action="uninstall-server" data-game="${esc(game.id)}" data-server="${esc(server.id)}" title="${
                game.running
                  ? '游戏正在运行，先关掉游戏再卸载'
                  : '把这一份客户端删到回收站，不影响别的服务器'
              }">${icon('trash')}<span>卸载</span></button>`
            : ''
        }
      </div>
      <button class="btn ${server.active ? 'btn-primary' : 'btn-ghost'} btn-sm st-go" data-action="${primaryAction}" data-id="${esc(game.id)}" data-game="${esc(game.id)}" data-server="${esc(server.id)}">
        ${icon(usable ? (server.active ? 'play' : 'swap') : 'refresh')}${primaryLabel}
      </button>
    </article>`;
}

/* ------------------------------------------------------------------ */
/* 预下载                                                              */
/* ------------------------------------------------------------------ */

/*
 * 预下载的全部结论都由主进程算好，存在 server.predownload 里（结构见
 * electron/predownload.js 顶部注释），界面只负责呈现：拿到什么显示什么，
 * 没拿过就显示「未查询」并给一个「检查」按钮。
 *
 * 异环和终末地 Steam 是明确不支持的，但后端给的 reason 必须显示出来 ——
 * 藏起来只会让用户以为功能坏了。
 */
const PREDOWNLOAD_GAMES = ['genshin', 'starrail', 'zzz', 'bh3', 'endfield', 'neverness'];

/** state → 徽标文案与配色。没有查过就是 unknown，界面给「检查」按钮。 */
const PREDOWNLOAD_STATES = {
  available: { label: '可以预下载', cls: 'is-ready' },
  done: { label: '预下载已完成', cls: 'is-done' },
  update: { label: '正式版已上线', cls: 'is-update' },
  none: { label: '官方暂未开放', cls: 'is-idle' },
  'not-installed': { label: '没读到客户端版本', cls: 'is-idle' },
  unsupported: { label: '不支持预下载', cls: 'is-block' },
  error: { label: '状态读取失败', cls: 'is-block' },
};

/** 进度事件里 phase 的人话翻译。 */
const PREDOWNLOAD_PHASES = {
  start: '准备中',
  version: '版本信息',
  manifest: '读取官方清单',
  download: '下载预下载内容',
  install: '写入游戏文件',
  extract: '解压预下载包',
  stage: '整理更新内容',
  patch: '应用补丁',
  // 终末地的 apply 阶段会发 commit（把暂存内容真正写进游戏目录），
  // 漏了这一条会退化成「处理中…」，用户看不出到哪一步了。
  commit: '写入游戏目录',
  done: '完成',
  error: '出错',
};

/** 正在向官方查询的服务器，界面上显示「查询中」而不是假装没事。 */
const pdBusy = new Set();

/** 预下载面板打开时登记的重绘函数，查完状态时顺手把面板也刷一遍。 */
let pdModalRepaint = null;
let pdModalStoryRepaint = null;

/** 异环渠道是读启动器配置来的，缓存一份，免得每次重绘都去读文件。 */
const nteChannelCache = new Map();

function predownloadApi() {
  return api.predownload && typeof api.predownload.check === 'function' ? api.predownload : null;
}

/** 只有这几个内置游戏才有预下载这条链路；自建游戏没有清单可查。 */
function predownloadWired(game) {
  return Boolean(game && PREDOWNLOAD_GAMES.includes(game.builtinKey));
}

/**
 * 崩坏3 只有官服在 HoYoPlay 分发体系里：B服走 B 站自有启动器，国际服在
 * sg-hyp-api 里有多条 bh3_global 无法唯一定位（见 sophon.js 的 CHANNELS）。
 * 别的渠道给了入口只会点开报「没有对应的官方渠道参数」，所以直接不渲染。
 */
function predownloadChannelOk(game, server) {
  if (!game || !server) return false;
  if (game.builtinKey === 'bh3') return String(server.channel || '') === 'official';
  return true;
}

function predownloadInfo(server) {
  const info = server && server.predownload;
  return info && typeof info === 'object' ? info : null;
}

function predownloadMeta(info) {
  return PREDOWNLOAD_STATES[String(info && info.state ? info.state : '')] || null;
}

/** 游戏卡上那个预下载入口：只在接入了预下载的游戏上出现，点击直达面板。 */
function cardPredownloadEntry(game) {
  if (!predownloadWired(game)) return '';
  const servers = game.servers || [];
  const server = servers.find((item) => item.active) || servers[0];
  // 没有客户端目录就查不了（后端连 config.ini 都读不到），别给一个点了只会报错的入口
  if (!server || !server.root) return '';
  if (!predownloadChannelOk(game, server)) return '';
  const info = predownloadInfo(server);
  const pdState = String((info && info.state) || '');
  const known = {
    available: { cls: 'is-ready', title: '预下载新版本' },
    done: { cls: 'is-done', title: '应用预下载更新' },
    update: { cls: 'is-update', title: '应用官方更新' },
    unsupported: { cls: 'is-block', title: '这个服务器不支持预下载，点开看原因' },
    none: { cls: 'is-idle', title: '查看预下载状态' },
  };
  const view = known[pdState] || { cls: 'is-idle', title: '查看预下载状态' };
  return `<button class="card-tool pd-card-entry ${view.cls}" data-action="open-predownload" data-id="${esc(game.id)}" title="${view.title}" aria-label="${view.title}">${icon('download')}</button>`;
}

/**
 * 启动页「开始游戏」上方那条预下载入口。
 *
 * 只在真的有事可做时出现：
 *   - available：官方放出了新版本，可以预下载 → 「预下载新版本」；
 *   - done：已经下好了，等着装进游戏目录 → 「安装预下载的版本」。
 *
 * 其它情况一个字都不显示，这是用户明确要求的（2026-10-31）：
 *   平时没有预下载就别占位置；正式版上线后（update）也直接让位 ——
 *   那时候「开始游戏」本身已经变成「更新游戏」，点它就把新版本装上，
 *   再挂一条预下载入口只会让人不知道该点哪个。
 *
 * 位置照 Starward：预下载不是「工具」，是「比开始游戏更早一步的事」，
 * 所以它待在开始游戏正上方，而不是藏进服务器卡片或设置里。
 */
function startDockPredownload(game) {
  if (!predownloadWired(game)) return '';
  const servers = game.servers || [];
  const server = servers.find((item) => item.active) || servers[0];
  // 没有客户端目录就查不了（后端连 config.ini 都读不到），别给一个点了只会报错的入口
  if (!server || !server.root) return '';
  if (!predownloadChannelOk(game, server)) return '';
  const info = predownloadInfo(server);
  const pdState = String((info && info.state) || '');
  if (pdState !== 'available' && pdState !== 'done') return '';

  const done = pdState === 'done';
  /*
   * 下了一半也要能在这个按钮上说清楚。partial 是后端数 chunk/ 得出的
   * 「同一个范围下已经下了一部分」，这时按钮该说「继续」而不是「开始」——
   * 不然用户会以为上次的几十 G 白下了。
   */
  const partial = !done && info.partial === true && Number(info.storedBytes) > 0;
  const version = String(info.targetVersion || info.latestVersion || '');
  const bytes =
    Number(info.bytesTotal) ||
    Number(info.bytesGame || 0) + Number(info.bytesAudio || 0) + Number(info.bytesCategory || 0);
  const bits = [];
  if (version) bits.push(version);
  if (done && Number(info.storedBytes)) bits.push(`已下 ${fmtBytes(info.storedBytes)}`);
  else if (partial) {
    bits.push(`已下 ${fmtBytes(info.storedBytes)}`);
    if (bytes > Number(info.storedBytes)) bits.push(`还差约 ${fmtBytes(bytes - Number(info.storedBytes))}`);
  } else if (bytes) bits.push(`约 ${fmtBytes(bytes)}`);
  const label = done ? '安装预下载的版本' : partial ? '继续预下载' : '预下载新版本';
  const title = done
    ? '预下载内容已经下好了，点开安装到游戏目录'
    : partial
      ? '上次没下完，已经下的分块还在，点开接着下'
      : '官方放出了新版本，现在可以先下载';
  return `<button class="start-dock-pd" data-action="open-predownload" data-id="${esc(game.id)}" title="${title}">
      ${icon('download', 'xs')}
      <span class="start-dock-pd-label">${label}</span>
      ${bits.length ? `<span class="start-dock-pd-meta">${esc(bits.join(' · '))}</span>` : ''}
    </button>`;
}

/** 体积拆解只列后端真算出来的那几段，凑不出「0 GB」这种没意义的行。 */function predownloadSizeText(info) {
  if (!info) return '';
  const parts = [];
  if (Number(info.bytesGame)) parts.push(`本体 ${fmtBytes(info.bytesGame)}`);
  if (Number(info.bytesAudio)) parts.push(`语音 ${fmtBytes(info.bytesAudio)}`);
  if (Number(info.bytesCategory)) parts.push(`剧情 ${fmtBytes(info.bytesCategory)}`);
  return parts.join(' + ');
}

function predownloadDetail(info, busy) {
  if (busy) return '正在向官方查询…';
  if (!info) return '还没查过，点「检查」问一次官方有没有开放预下载';
  const state = String(info.state || '');
  if (state === 'unsupported') return info.reason || '这个游戏 / 渠道不支持预下载';
  if (state === 'error') {
    // 后端会把「用户点停止」也记成 error，别让用户看到一条像是坏掉的红字
    if (String(info.error || '').includes('已取消')) return '上次预下载被你停掉了，已经下好的分块还在，接着下就行';
    return info.error || '读取预下载状态失败';
  }
  const bits = [];
  if (info.localVersion) bits.push(`本地 ${info.localVersion}`);
  if (info.targetVersion) bits.push(`预下载目标 ${info.targetVersion}`);
  // 正式版只有在「已经比本地新」时才值得说；否则和本地版本是同一个，说了是废话
  if (info.latestVersion && info.latestVersion !== info.localVersion) {
    bits.push(`正式版 ${info.latestVersion}`);
  }
  const size = predownloadSizeText(info);
  if (size) bits.push(`约 ${size}`);
  if (state === 'done') {
    if (info.storedFiles) bits.push(`已存 ${info.storedFiles} 个分块 · ${fmtBytes(info.storedBytes)}`);
    if (info.categoryCount) bits.push(`含 ${info.categoryCount} 份剧情分类包`);
  }
  /*
   * 「下了一半」要能自己说出来。以前这里只有一句「可以预下载」，用户停掉之后
   * 完全看不出已经下了多少、接着来会不会白下。后端现在会数 chunk/ 里的体积，
   * 这里就把话说清楚：partial 是同一套范围下的半成品，能接上；scopeChanged 是
   * 语音或剧情开关改过，旧分块有一批用不上，只能重新核对。
   */
  if (state === 'available' && info.partial) {
    bits.push(`上次下到 ${fmtBytes(info.storedBytes)}（${Number(info.storedFiles) || 0} 个分块），点是接着下，不会重来`);
  } else if (state === 'available' && info.scopeChanged) {
    bits.push(
      `上次下的 ${fmtBytes(info.storedBytes)} 因为语音 / 剧情开关改过，只能重新核对；能对上的分块依旧会复用`
    );
  }
  if (state === 'update') {
    // 正式版上线后，已经下好的预下载分块照样能用，只是入口换成了「更新游戏」
    if (Number(info.storedBytes)) {
      bits.push(`已下的 ${fmtBytes(info.storedBytes)} 分块会直接复用，不用重下`);
    }
    bits.push('预下载按钮让位，直接用「应用更新」把新版本装上');
  }
  if (state === 'none' && Number(info.storedBytes)) {
    bits.push(`还剩 ${fmtBytes(info.storedBytes)} 预下载内容占着盘，不想要可以清除`);
  }
  return bits.join(' · ');
}

/** 预下载面板里的状态行。 */
function predownloadStatusMarkup(server) {
  const info = predownloadInfo(server);
  const meta = predownloadMeta(info);
  return `
    <div class="pd-status-row">
      <span class="pd-badge ${meta ? meta.cls : 'is-idle'}">${meta ? meta.label : '未查询'}</span>
      <span class="pd-status-note">${esc(predownloadDetail(info, false))}</span>
    </div>`;
}

/**
 * 单个服务器覆盖「剧情分类资源包」：true / false 是覆盖，null 是跟随全局。
 * 继承链在后端是 server → game → settings（见 main.js 的 storyResourcesEnabled）。
 */
function storyOverride(server) {
  return typeof (server && server.includeStoryResources) === 'boolean'
    ? server.includeStoryResources
    : null;
}

function storyResourcesMarkup(game, server) {
  if (game.builtinKey !== 'zzz') {
    return `<p class="pd-note">${icon('info', 'xs')}<span>这款游戏的官方清单里没有单独的剧情分类包（原神 / 星穹铁道实测为 0 份），剧情资源开关对它不起作用。</span></p>`;
  }
  const override = storyOverride(server);
  const on = override === null ? state.settings.includeStoryResources === true : override;
  const attrs = `data-game="${esc(game.id)}" data-server="${esc(server.id)}"`;
  return `
    <div class="pd-story">
      <div class="pd-story-copy">
        <strong>剧情资源</strong>
        <span>把主线剧情、个人线、影像档案这些分类包一起预下载。不勾只是缺剧情动画，不影响进游戏；勾上多占近 20GB。</span>
        <em class="pd-story-tag${override === null ? '' : ' is-over'}">${override === null ? '跟随全局设置' : '已单独设置'}</em>
      </div>
      <div class="pd-story-control">
        <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-action="toggle-pd-story" ${attrs} title="${on ? '关闭' : '开启'}"></button>
        <button class="btn btn-quiet" data-action="reset-pd-story" ${attrs} title="不覆盖，跟随全局设置" ${override === null ? 'hidden' : ''}>跟随全局</button>
      </div>
    </div>`;
}

/** 预下载面板：状态 + 剧情资源开关 + 进度 + 开始 / 应用 / 清除。 */
function openPredownloadModal(gameId, serverId) {
  if (!predownloadApi()) {
    toast('当前版本还没有接入预下载', 'info');
    return;
  }
  const game = state.games.find((item) => item.id === gameId);
  const server = game && (game.servers || []).find((item) => item.id === serverId);
  if (!game || !server) {
    toast('没有找到这个服务器', 'error');
    return;
  }
  if (!predownloadChannelOk(game, server)) {
    toast('崩坏3 只有官服支持预下载，B服 / 国际服由官方启动器负责', 'info');
    return;
  }
  const jobId = `pd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const openedInfo = predownloadInfo(server);
  const openedStored = Number(openedInfo && openedInfo.storedBytes) || 0;
  const openedPartial = Boolean(openedInfo && openedInfo.partial) && openedStored > 0;

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal pd-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>预下载</h2>
            <p>${esc(game.name)} · ${esc(server.name)} · 新版本上线前先把内容拉到本地，上线后再应用</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="pd-status" id="pd-status">${predownloadStatusMarkup(server)}</div>
          <div class="pd-story-host" id="pd-story">${storyResourcesMarkup(game, server)}</div>
          <div class="link-progress" id="pd-progress" style="display:none">
            <div class="link-progress-head">
              <strong id="pd-phase">准备中…</strong>
              <span id="pd-count"></span>
            </div>
            <div class="progress-bar"><span id="pd-bar" style="width:0%"></span></div>
            <div class="link-progress-meta">
              <span id="pd-stats"></span>
              <span id="pd-current"></span>
            </div>
          </div>
          <div class="field-error" id="pd-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
          <button class="btn btn-ghost" id="pd-pause" style="display:none">暂停</button>
          <button class="btn btn-ghost" id="pd-cancel" style="display:none">停止</button>
          <button class="btn btn-ghost" id="pd-clear"${openedStored ? '' : ' style="display:none"'} data-game="${esc(
            game.id
          )}" data-server="${esc(server.id)}" title="删掉已经下好的预下载内容，游戏文件不受影响">清除${
            openedStored ? ` ${fmtBytes(openedStored)}` : ''
          }</button>
          <button class="btn btn-ghost" id="pd-refresh">${icon('refresh')}重新检查</button>
          <button class="btn btn-primary" id="pd-apply" style="display:none">${icon('download')}应用更新</button>
          <button class="btn btn-primary" id="pd-start">${icon('download')}${
            openedPartial ? '继续预下载' : '开始预下载'
          }</button>
        </div>
      </div>
    </div>`;

  openModal(html, {
    onClose: () => {
      // 关窗即视为停止：先记下，免得后端抛回「已取消」时又弹一条错误提示
      if (running) {
        cancelled = true;
        api.predownload.cancel(jobId).catch(() => {});
      }
      if (unsubscribe) unsubscribe();
      pdModalRepaint = null;
      pdModalStoryRepaint = null;
    },
  });

  const phase = document.querySelector('#pd-phase');
  const count = document.querySelector('#pd-count');
  const stats = document.querySelector('#pd-stats');
  const current = document.querySelector('#pd-current');
  const bar = document.querySelector('#pd-bar');
  const progress = document.querySelector('#pd-progress');
  const errorBox = document.querySelector('#pd-error');
  const start = document.querySelector('#pd-start');
  const apply = document.querySelector('#pd-apply');
  const clearBtn = document.querySelector('#pd-clear');
  const cancel = document.querySelector('#pd-cancel');
  const pause = document.querySelector('#pd-pause');
  let running = false;
  let cancelled = false;
  let paused = false;
  let unsubscribe = null;

  const currentServer = () => {
    const live = state.games.find((item) => item.id === gameId);
    return live && (live.servers || []).find((item) => item.id === serverId);
  };

  /** 只重绘状态行和两个按钮的可见性，不动整页，也不重建开关节点。 */
  const repaint = () => {
    const target = currentServer();
    if (!target) return;
    const statusHost = document.querySelector('#pd-status');
    if (statusHost) statusHost.innerHTML = predownloadStatusMarkup(target);
    const info = predownloadInfo(target);
    const pdState = String((info && info.state) || '');
    const stored = Number(info && info.storedBytes) || 0;
    if (start) {
      start.style.display = pdState === 'available' ? '' : 'none';
      // 下了一半就别再写「开始预下载」——按钮文字得承认上次的进度
      start.innerHTML = `${icon('download')}${
        pdState === 'available' && info && info.partial && stored ? '继续预下载' : '开始预下载'
      }`;
    }
    if (apply) apply.style.display = pdState === 'done' || pdState === 'update' ? '' : 'none';
    // 有东西占着盘就给「清除」，体积跟着走；下完 / 下一半 / 官方撤了都算
    if (clearBtn) {
      clearBtn.style.display = stored ? '' : 'none';
      clearBtn.textContent = stored ? `清除 ${fmtBytes(stored)}` : '清除';
    }
  };
  /** 剧情资源那块单独重绘：只有「跟随全局」这种非开关点击才需要重建。 */
  const repaintStory = () => {
    const target = currentServer();
    const storyHost = document.querySelector('#pd-story');
    if (target && storyHost) storyHost.innerHTML = storyResourcesMarkup(game, target);
  };
  pdModalRepaint = repaint;
  pdModalStoryRepaint = repaintStory;

  const onProgress = (event) => {
    if (!event || event.jobId !== jobId) return;
    const total = Number(event.total) || 0;
    const processed = Number(event.processed) || 0;
    const percent = total ? Math.min(100, (processed / total) * 100) : 0;
    const base = PREDOWNLOAD_PHASES[event.phase] || '处理中…';
    const counted = ['download', 'install', 'patch'].includes(event.phase);
    const tip = counted ? '' : String(event.current || '');
    if (phase) phase.textContent = tip ? `${base} · ${tip}` : base;
    /*
     * 只有带计数的阶段才改写分块计数与进度条。
     * version / manifest / extract / stage / commit 这些阶段事件里没有 total，
     * 照旧写法会把已经走到的进度清零 —— 终末地预下载就会先到 100%、
     * 进入「解压/整理/写盘」时跳回 0%，看起来像重头开始。
     */
    if (count && total) count.textContent = `${processed} / ${total}`;
    if (bar) {
      if (event.phase === 'done') bar.style.width = '100%';
      else if (total) bar.style.width = `${percent}%`;
    }
    if (stats) {
      const parts = [];
      if (Number(event.totalBytes)) {
        parts.push(`${fmtBytes(event.bytesDone)} / ${fmtBytes(event.totalBytes)}`);
      } else if (Number(event.bytesDone)) {
        parts.push(fmtBytes(event.bytesDone));
      }
      if (Number(event.skipped)) parts.push(`复用 ${event.skipped}`);
      if (Number(event.reusedChunks)) parts.push(`命中缓存 ${event.reusedChunks} 块`);
      // 没算出体积的阶段保留上一次的数字，别把统计行刷成空白
      if (parts.length) stats.textContent = parts.join(' · ');
    }
    if (current) current.textContent = String(event.current || '');
  };

  const resetFoot = () => {
    running = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    start.disabled = false;
    cancel.style.display = 'none';
    pause.style.display = 'none';
    pause.textContent = '暂停';
    paused = false;
  };

  const run = async (kind) => {
    cancelled = false;
    running = true;
    progress.style.display = 'block';
    errorBox.textContent = '';
    start.disabled = true;
    apply.disabled = true;
    cancel.style.display = '';
    pause.style.display = '';
    unsubscribe = typeof api.onPredownloadProgress === 'function' ? api.onPredownloadProgress(onProgress) : null;
    const bridge = predownloadApi();
    try {
      const result = await (kind === 'apply'
        ? bridge.apply({ gameId, serverId, jobId })
        : bridge.start({ gameId, serverId, jobId }));
      if (cancelled || (result && result.cancelled)) {
        toast('已停止，下次可以从头再来或继续', 'info');
      } else if (kind === 'apply') {
        toast(`更新已应用到 ${result.tag || '新版本'}`, 'success');
      } else {
        toast(`预下载完成，目标版本 ${result.targetVersion || ''}`, 'success');
      }
    } catch (error) {
      const text = humanError(error);
      if (!cancelled) {
        errorBox.textContent = text;
        toast(text, 'error');
      }
    } finally {
      resetFoot();
      apply.disabled = false;
      // 后端会把「点停止」也记成 error 状态，重新查一次才能把「开始预下载」还回来
      if (cancelled) await runPredownloadCheck(gameId, serverId);
      repaint();
      repaintServerRows();
    }
  };

  start.addEventListener('click', () => run('start'));
  apply.addEventListener('click', () => run('apply'));
  cancel.addEventListener('click', () => {
    cancelled = true;
    cancel.disabled = true;
    api.predownload.cancel(jobId).catch(() => {});
  });
  pause.addEventListener('click', () => {
    paused = !paused;
    api.predownload.pause({ jobId, paused }).catch(() => {});
    pause.textContent = paused ? '继续' : '暂停';
    if (phase) phase.textContent = paused ? '已暂停（点继续恢复）' : '恢复中…';
  });

  /*
   * 清除预下载内容：原地二次确认，不弹通用确认框。
   *
   * 通用 confirmDialog 用的是同一个 #modal-root，一弹就把这个面板整个换掉，
   * 确认后 modalRoot 被清空 —— 面板没了、进度事件还挂着、正在跑的任务也失联。
   * 所以这里改成「点一次变文案，4 秒内再点才真删」，面板始终留在原地。
   */
  let clearArmed = false;
  let clearTimer = null;
  const disarmClear = () => {
    clearArmed = false;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    if (clearBtn) clearBtn.textContent = '清除';
    repaint();
  };
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (running) {
        toast('正在预下载，先点「停止」再清除', 'info');
        return;
      }
      if (!clearArmed) {
        clearArmed = true;
        clearBtn.textContent = '再点一次确认清除';
        clearTimer = setTimeout(disarmClear, 4000);
        return;
      }
      clearTimeout(clearTimer);
      clearTimer = null;
      clearArmed = false;
      clearBtn.disabled = true;
      try {
        await predownloadApi().clear({ gameId, serverId });
        toast('预下载内容已清除', 'success');
        // 清完立刻重查，别让状态停在上一次的「已下 x GB」
        await runPredownloadCheck(gameId, serverId);
      } catch (error) {
        toast(humanError(error), 'error');
      } finally {
        clearBtn.disabled = false;
        repaint();
        repaintServerRows();
      }
    });
  }
  document.querySelector('#pd-refresh').addEventListener('click', () => {
    runPredownloadCheck(gameId, serverId);
  });

  /*
   * 打开时问一次官方，别让用户对着「未查询」发呆。
   * 状态太旧（超过 10 分钟）也重查 —— 昨天查的结论不该今天还挂在面板上，
   * 这正是「明明有预下载却显示官方暂未开放」的来源之一。
   */
  const opened = predownloadInfo(server);
  const openedAt = Date.parse((opened && opened.updatedAt) || '') || 0;
  if (!opened || Date.now() - openedAt > 10 * 60 * 1000) runPredownloadCheck(gameId, serverId);
}

/**
 * 向官方查一次预下载状态。
 * 弹窗开着时主进程的回推不会重绘页面（onState 会跳过），所以这里自己重绘
 * 受影响的那两小块，而不是整页 render()。
 */
async function runPredownloadCheck(gameId, serverId) {
  const bridge = predownloadApi();
  if (!bridge) return;
  const key = `${gameId}:${serverId}`;
  if (pdBusy.has(key)) return;
  pdBusy.add(key);
  repaintServerRows();
  try {
    await bridge.check({ gameId, serverId });
  } catch (error) {
    toast(humanError(error), 'error');
  } finally {
    pdBusy.delete(key);
    repaintServerRows();
    if (pdModalRepaint) pdModalRepaint();
  }
}

/** 服务器管理弹窗里整片列表的就地重绘。 */
function repaintServerRows() {
  const host = document.querySelector('#server-manager-list');
  if (!host) return;
  const game = state.games.find((item) => item.id === host.dataset.game);
  if (!game) return;
  const servers = game.servers || [];
  host.innerHTML =
    servers.map((server) => serverRow(game, server)).join('') ||
    '<p class="gacha-empty-line">还没有服务器</p>';
}

/** 打开服务器管理时自动查一次当前服务器，省得每次都要手点。 */
async function autoCheckPredownload(game) {
  if (!predownloadWired(game)) return;
  const servers = game.servers || [];
  const server =
    servers.find((item) => item.active) || servers.find((item) => item.exists) || servers[0];
  if (!server || !server.exists || predownloadInfo(server)) return;
  await runPredownloadCheck(game.id, server.id);
}

/* ------------------------------------------------------------------ */
/* 异环官服 / B服                                                      */
/* ------------------------------------------------------------------ */

/*
 * 异环的渠道写在 <安装目录>/NTELauncher/Config/Config.ini 里，切渠道只改三行
 * 配置，不动游戏文件。后端把「两服账号独立、官方口径 PC 只支持官服、切完要重启」
 * 放在返回的 notice 里，界面必须原样呈现给用户 —— 尤其是切到 B服之前，
 * 不能默默就切了。
 */
function nteChannelLabel(channel) {
  if (channel === 'bilibili') return 'B服';
  if (channel === 'official') return '官服';
  return '未读取';
}

function nteChannelMarkup(game, server) {
  const cached = server ? nteChannelCache.get(server.id) : null;
  const channel = cached ? String(cached.channel || '') : '';
  const serverId = server ? server.id : '';
  const attrs = `data-game="${esc(game.id)}" data-server="${esc(serverId)}"`;
  const notice = cached ? String(cached.notice || '') : '';
  const reason = cached ? String(cached.reason || cached.error || '') : '';
  const broken = Boolean(cached && cached.state !== 'ok');
  // 只有「花筱灵自己拉不到异环更新信息」时才提示改用官方启动器；正常能自更就不打扰用户。
  const officialOnly = Boolean(cached && cached.state === 'error');
  // 渠道做成两张可点卡片：点了就是切过去，当前渠道亮着带「当前」角标
  const card = (key, label, desc) => {
    const active = channel === key;
    return `
      <button class="nte-channel-card${active ? ' is-active' : ''}" data-action="nte-set-channel" data-channel="${key}" ${attrs} ${active || broken ? 'disabled' : ''}>
        <strong>${label}</strong>
        <small>${desc}</small>
        ${active ? '<em>当前</em>' : ''}
      </button>`;
  };
  return `
    <section class="nte-panel" id="nte-channel-panel" data-game="${esc(game.id)}" data-server="${esc(serverId)}">
      <div class="nte-panel-head">
        <strong>异环渠道</strong>
        <span class="nte-current ${channel === 'bilibili' ? 'is-bili' : ''}">${cached ? nteChannelLabel(channel) : '读取中…'}</span>
      </div>
      <div class="nte-channel-cards">
        ${card('official', '官服', '完美世界账号 · 官方完整链路')}
        ${card('bilibili', 'B服', 'B站账号 · 与官服数据不互通')}
      </div>
      <p class="nte-notice">${icon('alert', 'xs')}<span>${esc(notice || '正在读取 NTELauncher 配置…')}</span></p>
      ${reason ? `<p class="nte-notice is-reason">${icon('info', 'xs')}<span>${esc(reason)}</span></p>` : ''}
      ${officialOnly ? `
      <p class="nte-notice is-reason"><span>花筱灵暂时拉不到异环的更新信息（官方接口可能不可达），游戏本体更新请改用官方启动器处理。</span></p>
      <div class="nte-panel-actions">
        <button class="btn btn-ghost" data-action="nte-open-launcher">${icon('external')}打开官方启动器（更新游戏本体）</button>
      </div>` : ''}
    </section>`;
}

/**
 * 异环渠道切换完整流程（服务器管理面板和主界面 dock 的服务器下拉共用）：
 * B服先弹四步确认 → 改 Config.ini → 切换成功后两个渠道都询问「花筱灵直接下载」（官方链路切服后都可能要补渠道资源）。
 * 返回是否成功（用户取消/失败都算 false，调用方据此决定要不要继续 activate）。
 */
async function switchNteChannel(game, server, channel) {
  if (channel === 'bilibili') {
    const ok = await confirmDialog({
      title: '切换到异环 B服',
      message:
        '切换流程（很简单，不用慌）：\n' +
        '1. 点「切到 B服」改的是启动器配置，游戏文件一个不动；\n' +
        '2. 首次切 B服，花筱灵可以按官方清单直接下载 B服资源（只此一次，之后互相切换都是秒切）；\n' +
        '3. 下载完从花筱灵点「启动」就能进 B服，用 B站账号登录；\n' +
        '4. 切换前记得完全退出异环官方启动器（右下角薄荷托盘图标也要退）。\n\n' +
        '注意：官服（完美世界账号）和 B服（B站账号）数据完全不互通。',
      confirmText: '切到 B服',
      danger: true,
    });
    if (!ok) return false;
  }
  try {
    const result = await api.neverness.setChannel({
      gameId: game.id,
      serverId: server.id,
      channel,
    });
    if (result && result.changed) {
      // 成功提示交给调用方（dock 说「已切换到 xx」，面板刷新后自己显示当前渠道），
      // 避免 dock 场景下「已切回官服」+「已切换到 国服」弹两个框。
      // 两个渠道对称：切换后官方链路都可能要补几十 M 渠道资源，问一次要不要花筱灵直接下。
      const isB = channel === 'bilibili';
      const direct = await confirmDialog({
        title: isB ? '下载 B服资源' : '下载官服资源',
        message: isB
          ? '花筱灵可以直接按官方清单把 B服资源下载好，全程不用打开官方启动器。\n' +
            '只下载本机缺的文件，已存在的自动跳过；下载完从花筱灵点「启动」就能进 B服。'
          : '切回官服后，官方链路可能还要补几十 M 的官服资源。\n' +
            '花筱灵可以直接按官方清单提前下载好，全程不用打开官方启动器；\n' +
            '只下载本机缺的文件，已存在的自动跳过，之后切回官服就不用再下了。',
        confirmText: '花筱灵直接下载',
      });
      if (direct) {
        openNtePredownloadModal(server.id, channel);
      } else {
        try {
          await api.neverness.openLauncher();
          toast(`官方启动器已打开，等下载完就能从花筱灵启动${isB ? ' B服' : ''}`, 'success');
        } catch (err) {
          toast(humanError(err), 'error');
        }
      }
    } else {
      toast('渠道没有变化', 'info');
    }
    return true;
  } catch (error) {
    toast(humanError(error), 'error');
    return false;
  }
}

/**
 * 修复进度文案：终末地 / 方舟是逐文件清单（processed/total），米哈游是 Sophon chunk
 * （phase + processed/total），字段不完全一样，这里统一成一句能读的话。
 */
function repairProgressText(progress) {
  if (!progress) return '';
  const processed = Number(progress.processed) || 0;
  const total = Number(progress.total) || 0;
  const name = progress.current ? String(progress.current).split(/[\\/]/).pop() : '';
  if (total > 0) {
    const percent = Math.min(100, Math.round((processed / total) * 100));
    return `正在校验 ${processed}/${total}（${percent}%）${name ? ` · ${name}` : ''}`;
  }
  if (name) return `正在校验 · ${name}`;
  return '正在校验游戏文件…';
}

/**
 * 统一修复流程：确认 → 调 games:repair-game → 结果提示。所有修复入口共用。
 * serverId 必须带上：服务器卡片上点哪张就修哪张。只按「当前激活」修的话，
 * 切完服 / 想修非激活服都会修到别的目录去。
 */
async function repairGameFlow(game, serverId) {
  if (!game) {
    toast('没有找到对应的游戏', 'error');
    return;
  }
  const server =
    game.servers.find((item) => item.id === serverId) ||
    game.servers.find((item) => item.active) ||
    game.servers[0];
  if (!server?.exists) {
    toast('先配置客户端路径再修复', 'error');
    return;
  }
  const serverLabel = server.name ? `「${server.name}」` : '这个服务器';
  const ok = await confirmDialog({
    title: `修复 ${game.name || game.builtinKey} · ${serverLabel}`,
    message:
      `将按官方清单校验${serverLabel}的客户端文件，重新下载损坏或缺失的部分。\n` +
      '官方清单以外的文件不会被删除，修复期间请先退出游戏。',
    confirmText: '开始修复',
  });
  if (!ok) return;
  const busy = beginServerModalProgress('正在校验游戏文件…');
  const offProgress =
    typeof api.onRepairProgress === 'function'
      ? api.onRepairProgress((progress) => {
          const text = repairProgressText(progress);
          if (text) busy.update(text);
        })
      : null;
  try {
    const result = await api.games.repair({ gameId: game.id, serverId: server.id });
    if (result?.official) {
      busy.done('已打开官方启动器，游戏本体修复请在里面完成', 'success');
    } else {
      busy.done(
        `修复完成，已处理 ${result?.updated ?? 0} 个文件（当前版本 ${result?.version || ''}）`,
        'success'
      );
    }
    await api.getState().then(onState);
  } catch (error) {
    busy.done(`修复失败：${humanError(error)}`, 'error');
  } finally {
    if (offProgress) offProgress();
  }
}

/** 读一次渠道配置并就地替换整块面板。 */
async function refreshNtePanel() {
  const host = document.querySelector('#nte-channel-panel');
  if (!host) return;
  const game = state.games.find((item) => item.id === host.dataset.game);
  const serverId = host.dataset.server;
  if (!game) return;
  try {
    const result = await api.neverness.channel({ serverId });
    nteChannelCache.set(serverId, result);
  } catch (error) {
    nteChannelCache.set(serverId, { channel: '', notice: humanError(error), state: 'error' });
  }
  const server = (game.servers || []).find((item) => item.id === serverId);
  const next = document.querySelector('#nte-channel-panel');
  if (next) next.outerHTML = nteChannelMarkup(game, server);
}
